import { describe, expect, test } from "bun:test";
import { Decrypter, Encrypter, armor, generateIdentity, identityToRecipient } from "age-encryption";
import { eq } from "drizzle-orm";
import { groupInvites, groupMembers, groups, handles, rateCounters } from "../src/db/schema";
import { call, makeTestApp, signup } from "./helpers";
import { sha256Hex } from "../src/lib/tokens";

describe("groups", () => {
  test("single ciphertext fans out and decrypts for every keyed member", async () => {
    const { app } = await makeTestApp();
    const aliceIdentity = await generateIdentity();
    const bobIdentity = await generateIdentity();
    const carolIdentity = await generateIdentity();
    const aliceKey = await identityToRecipient(aliceIdentity);
    const bobKey = await identityToRecipient(bobIdentity);
    const carolKey = await identityToRecipient(carolIdentity);
    const alice = await signup(app, "alice-bot", { public_key: aliceKey });
    const bob = await signup(app, "bob-bot", { public_key: bobKey });
    const carol = await signup(app, "carol-bot", { public_key: carolKey });

    const created = await call(app, "POST", "/api/groups", {
      token: alice.token,
      body: { name: "Dinner" },
    });
    expect(created.status).toBe(201);
    expect(created.json.invite.single_use).toBe(false);
    expect(created.json.invite.token).toMatch(/^hngi_[A-Za-z0-9_-]{22}$/);
    const groupId = created.json.id;
    expect((await call(app, "POST", `/api/group-invites/${created.json.invite.token}/redeem`, { token: bob.token })).status).toBe(200);
    expect((await call(app, "POST", `/api/group-invites/${created.json.invite.token}/redeem`, { token: carol.token })).status).toBe(200);

    const roster = await call(app, "GET", `/api/groups/${groupId}`, { token: alice.token });
    expect(roster.json.e2e_ready).toBe(true);
    expect(roster.json.members.map((member: any) => member.name)).toEqual(["alice-bot", "bob-bot", "carol-bot"]);

    const encrypter = new Encrypter();
    encrypter.addRecipient(bobKey);
    encrypter.addRecipient(carolKey);
    const secret = "Dinner moved to 8";
    const ciphertext = armor.encode(await encrypter.encrypt(secret));
    const sent = await call(app, "POST", `/api/groups/${groupId}/messages`, {
      token: alice.token,
      body: { body: ciphertext, enc: "age" },
    });
    expect(sent.status).toBe(201);
    expect(sent.json.delivered).toBe(2);

    for (const [member, identity] of [[bob, bobIdentity], [carol, carolIdentity]] as const) {
      const inbox = await call(app, "GET", "/api/inbox", { token: member.token });
      const envelope = inbox.json.messages.find((message: any) => message.tag === "group");
      expect(envelope.group).toEqual({ id: groupId, name: "Dinner" });
      const decrypter = new Decrypter();
      decrypter.addIdentity(identity);
      expect(await decrypter.decrypt(armor.decode(envelope.body), "text")).toBe(secret);
    }
  });

  test("plaintext groups stay easy, while keyed members require encryption", async () => {
    const { app } = await makeTestApp();
    const owner = await signup(app, "owner-bot");
    const member = await signup(app, "member-bot");
    const stranger = await signup(app, "stranger-bot");
    const created = await call(app, "POST", "/api/groups", { token: owner.token, body: { name: "Plain group" } });
    await call(app, "POST", `/api/group-invites/${created.json.invite.token}/redeem`, { token: member.token });
    const sent = await call(app, "POST", `/api/groups/${created.json.id}/messages`, {
      token: owner.token,
      body: { body: "hello everyone", enc: "none" },
    });
    expect(sent.status).toBe(201);
    expect((await call(app, "GET", `/api/groups/${created.json.id}`, { token: stranger.token })).status).toBe(403);

    const keyed = await call(app, "PATCH", "/api/handles/me", {
      token: member.token,
      body: { public_key: "age1membermembermember" },
    });
    expect(keyed.status).toBe(200);
    const blocked = await call(app, "POST", `/api/groups/${created.json.id}/messages`, {
      token: owner.token,
      body: { body: "now private", enc: "none" },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toBe("member_key_changed");
    expect(blocked.json.members).toEqual(["member-bot"]);
    const roster = await call(app, "GET", `/api/groups/${created.json.id}`, { token: owner.token });
    expect(roster.json.members.find((entry: any) => entry.name === member.name)).toMatchObject({ public_key: null, key_changed: true });
    expect((await call(app, "PUT", `/api/groups/${created.json.id}/members/${member.name}/key`, {
      token: member.token, body: { public_key: "age1membermembermember" },
    })).status).toBe(403);
    expect((await call(app, "PUT", `/api/groups/${created.json.id}/members/${member.name}/key`, {
      token: owner.token, body: { public_key: "age1membermembermember" },
    })).status).toBe(200);
    expect((await call(app, "POST", `/api/groups/${created.json.id}/messages`, {
      token: owner.token, body: { body: "plaintext remains prohibited", enc: "none" },
    })).status).toBe(400);
  });

  test("owner controls membership and members can leave", async () => {
    const { app } = await makeTestApp();
    const owner = await signup(app, "owner-bot");
    const member = await signup(app, "member-bot");
    const created = await call(app, "POST", "/api/groups", {
      token: owner.token,
      body: { name: "Controls" },
    });
    const groupId = created.json.id;
    await call(app, "POST", `/api/group-invites/${created.json.invite.token}/redeem`, {
      token: member.token,
    });

    expect(
      (await call(app, "POST", `/api/groups/${groupId}/invites`, { token: member.token })).status,
    ).toBe(403);
    expect(
      (await call(app, "DELETE", `/api/groups/${groupId}/members/me`, { token: owner.token }))
        .status,
    ).toBe(409);
    expect(
      (await call(app, "DELETE", `/api/groups/${groupId}/members/me`, { token: member.token }))
        .status,
    ).toBe(200);
    expect((await call(app, "GET", `/api/groups/${groupId}`, { token: member.token })).status).toBe(
      403,
    );
    expect((await call(app, "DELETE", `/api/groups/${groupId}`, { token: owner.token })).status).toBe(
      200,
    );
  });

  test("a reusable group invite admits concurrent members", async () => {
    const { app } = await makeTestApp();
    const owner = await signup(app, "owner-bot");
    const bob = await signup(app, "bob-bot");
    const carol = await signup(app, "carol-bot");
    const created = await call(app, "POST", "/api/groups", {
      token: owner.token,
      body: { name: "One seat" },
    });

    const attempts = await Promise.all([
      call(app, "POST", `/api/group-invites/${created.json.invite.token}/redeem`, {
        token: bob.token,
      }),
      call(app, "POST", `/api/group-invites/${created.json.invite.token}/redeem`, {
        token: carol.token,
      }),
    ]);
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual([200, 200]);

    const roster = await call(app, "GET", `/api/groups/${created.json.id}`, {
      token: owner.token,
    });
    expect(roster.json.members).toHaveLength(3);
    const inbox = await call(app, "GET", "/api/inbox", { token: owner.token });
    expect(inbox.json.messages.filter((message: any) => message.tag === "invite")).toHaveLength(2);
  });

  test("replacing a group invite invalidates the previous reusable link", async () => {
    const { app } = await makeTestApp();
    const owner = await signup(app, "owner-bot");
    const bob = await signup(app, "bob-bot");
    const carol = await signup(app, "carol-bot");
    const created = await call(app, "POST", "/api/groups", {
      token: owner.token,
      body: { name: "Rotating link" },
    });
    const replacement = await call(app, "POST", `/api/groups/${created.json.id}/invites`, {
      token: owner.token,
    });

    expect(replacement.status).toBe(201);
    expect(replacement.json.invite.single_use).toBe(false);
    expect(replacement.json.invite.token).not.toBe(created.json.invite.token);
    expect(
      (await call(app, "POST", `/api/group-invites/${created.json.invite.token}/redeem`, {
        token: bob.token,
      })).status,
    ).toBe(410);
    expect(
      (await call(app, "POST", `/api/group-invites/${replacement.json.invite.token}/redeem`, {
        token: bob.token,
      })).status,
    ).toBe(200);
    expect(
      (await call(app, "POST", `/api/group-invites/${replacement.json.invite.token}/redeem`, {
        token: carol.token,
      })).status,
    ).toBe(200);
  });

  test("validates messages and enforces membership at every group boundary", async () => {
    const { app, db } = await makeTestApp();
    const owner = await signup(app, "owner-bot");
    const member = await signup(app, "member-bot");
    const stranger = await signup(app, "stranger-bot");

    for (const name of ["", "\u0007", "x".repeat(65)]) {
      expect(
        (await call(app, "POST", "/api/groups", { token: owner.token, body: { name } })).status,
      ).toBe(400);
    }
    const created = await call(app, "POST", "/api/groups", {
      token: owner.token,
      body: { name: "Boundaries" },
    });
    const path = `/api/groups/${created.json.id}/messages`;
    expect(
      (await call(app, "POST", path, {
        token: owner.token,
        body: { body: "alone", enc: "none" },
      })).status,
    ).toBe(409);
    expect(
      (await call(app, "POST", path, {
        token: stranger.token,
        body: { body: "intrusion", enc: "none" },
      })).status,
    ).toBe(403);
    await call(app, "POST", `/api/group-invites/${created.json.invite.token}/redeem`, {
      token: member.token,
    });

    for (const body of [
      { body: "", enc: "none" },
      { body: "hello", enc: "rot13" },
    ]) {
      expect((await call(app, "POST", path, { token: owner.token, body })).status).toBe(400);
    }
    expect(
      (await call(app, "POST", path, {
        token: owner.token,
        body: { body: "é".repeat(32 * 1024 + 1), enc: "none" },
      })).status,
    ).toBe(413);
    const missingKey = await call(app, "POST", path, {
      token: owner.token,
      body: { body: "ciphertext", enc: "age" },
    });
    expect(missingKey.status).toBe(409);
    expect(missingKey.json.members).toEqual(["member-bot"]);

    const [sender] = await db.select().from(handles).where(eq(handles.name, "owner-bot"));
    await db.insert(rateCounters).values({
      handleId: sender!.id,
      kind: "group_dm",
      windowStart: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000),
      count: 100,
    });
    const limited = await call(app, "POST", path, {
      token: owner.token,
      body: { body: "one too many", enc: "none" },
    });
    expect(limited.status).toBe(429);
    expect(limited.json.error).toBe("rate_limited");
  });

  test("removal stops future delivery and deleting a group erases queued group envelopes", async () => {
    const { app } = await makeTestApp();
    const owner = await signup(app, "owner-bot");
    const bob = await signup(app, "bob-bot");
    const carol = await signup(app, "carol-bot");
    const created = await call(app, "POST", "/api/groups", {
      token: owner.token,
      body: { name: "Lifecycle" },
    });
    await call(app, "POST", `/api/group-invites/${created.json.invite.token}/redeem`, {
      token: bob.token,
    });
    const carolInvite = await call(app, "POST", `/api/groups/${created.json.id}/invites`, {
      token: owner.token,
    });
    await call(app, "POST", `/api/group-invites/${carolInvite.json.invite.token}/redeem`, {
      token: carol.token,
    });
    const messagePath = `/api/groups/${created.json.id}/messages`;
    await call(app, "POST", messagePath, {
      token: owner.token,
      body: { body: "before", enc: "none" },
    });
    expect(
      (await call(app, "DELETE", `/api/groups/${created.json.id}/members/bob-bot`, {
        token: owner.token,
      })).status,
    ).toBe(200);
    await call(app, "POST", messagePath, {
      token: owner.token,
      body: { body: "after", enc: "none" },
    });

    const bobInbox = await call(app, "GET", "/api/inbox", { token: bob.token });
    expect(
      bobInbox.json.messages.filter((message: any) => message.tag === "group").map((message: any) => message.body),
    ).toEqual(["before"]);
    const carolInbox = await call(app, "GET", "/api/inbox", { token: carol.token });
    expect(
      carolInbox.json.messages.filter((message: any) => message.tag === "group").map((message: any) => message.body),
    ).toEqual(["before", "after"]);

    expect(
      (await call(app, "DELETE", `/api/groups/${created.json.id}`, { token: owner.token })).status,
    ).toBe(200);
    for (const participant of [bob, carol]) {
      const inbox = await call(app, "GET", "/api/inbox", { token: participant.token });
      expect(inbox.json.messages.filter((message: any) => message.tag === "group")).toHaveLength(0);
    }
    const audit = await call(app, "GET", "/api/messages/activity", { token: bob.token });
    const retained = audit.json.messages.find((message: any) => message.tag === "group");
    expect(retained.status).toBe("expired");
    expect(retained.group).toEqual({ id: created.json.id, name: "Lifecycle" });
    expect((await call(app, "GET", "/api/groups", { token: carol.token })).json.groups).toHaveLength(0);
  });

  test("the 32-member cap does not consume an invite when the group is full", async () => {
    const { app, db } = await makeTestApp();
    const owner = await signup(app, "owner-bot");
    const candidate = await signup(app, "candidate-bot");
    const created = await call(app, "POST", "/api/groups", {
      token: owner.token,
      body: { name: "Full" },
    });
    const [group] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.publicId, created.json.id));
    const fillers = await db
      .insert(handles)
      .values(
        Array.from({ length: 31 }, (_, index) => ({
          name: `filler-${index.toString().padStart(2, "0")}`,
          bearerHash: `filler-hash-${index}`,
        })),
      )
      .returning({ id: handles.id });
    await db.insert(groupMembers).values(
      fillers.map((filler) => ({ groupId: group!.id, handleId: filler.id, role: "member" as const })),
    );

    const full = await call(app, "POST", `/api/group-invites/${created.json.invite.token}/redeem`, {
      token: candidate.token,
    });
    expect(full.status).toBe(409);
    expect(full.json.error).toBe("group_full");
    await db.delete(groupMembers).where(eq(groupMembers.handleId, fillers[0]!.id));
    expect(
      (await call(app, "POST", `/api/group-invites/${created.json.invite.token}/redeem`, {
        token: candidate.token,
      })).status,
    ).toBe(200);

    const expiredInvite = await call(app, "POST", `/api/groups/${created.json.id}/invites`, {
      token: owner.token,
    });
    await db
      .update(groupInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(groupInvites.token, await sha256Hex(expiredInvite.json.invite.token)));
    expect(
      (await call(app, "POST", `/api/group-invites/${expiredInvite.json.invite.token}/redeem`, {
        token: owner.token,
      })).status,
    ).toBe(410);
  });
});

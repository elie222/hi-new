import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { handles, invites, rateCounters } from "../src/db/schema";
import { call, connect, makeTestApp, signup, peers, realMail } from "./helpers";

describe("invites and grants", () => {
  test("invite page exposes self-contained Markdown instructions", async () => {
    const { app } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const bob = await signup(app, "bob-bot");
    const invite = await call(app, "POST", "/api/invites", { token: alice.token });
    const token = invite.json.token;

    const htmlResponse = await app.request(`http://hi.test/i/${token}`);
    const html = await htmlResponse.text();
    expect(htmlResponse.headers.get("link")).toContain(`/i/${token}.md`);
    expect(htmlResponse.headers.get("link")).toContain("rel=\"describedby\"");
    expect(html).toContain(`rel="alternate" type="text/markdown" href="http://hi.test/i/${token}.md"`);
    expect(html).toContain(`class="sr-only" href="http://hi.test/i/${token}.md">Agent instructions for this invite</a>`);

    const markdownResponse = await app.request(`http://hi.test/i/${token}.md`);
    const markdown = await markdownResponse.text();
    expect(markdownResponse.headers.get("content-type")).toContain("text/markdown");
    expect(markdownResponse.headers.get("cache-control")).toBe("no-store");
    expect(markdown).toContain("From: hi.new/alice-bot");
    expect(markdown).toContain(`POST http://hi.test/api/invites/${token}/redeem`);
    expect(markdown).toContain("Authorization: Bearer hn_...");
    expect(markdown).toContain("http://hi.test/skill.md");
    expect(markdown).toContain(`HI_NEW_ORIGIN=http://hi.test npx -y @hi-new/cli redeem http://hi.test/i/${token}`);
    expect(markdown).toContain(`npx -y @hi-new/cli claim NAME --redeem http://hi.test/i/${token}`);

    await call(app, "POST", `/api/invites/${token}/redeem`, { token: bob.token });
    const spent = await app.request(`http://hi.test/i/${token}.md`);
    expect(await spent.text()).toContain("Unavailable. Ask the sender for a fresh invite.");
  });

  test("no grant means 403 on dm", async () => {
    const { app } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    await signup(app, "victor-bot");
    const res = await call(app, "POST", "/api/dm/victor-bot", {
      token: alice.token,
      body: { body: "hi", enc: "none" },
    });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("no_grant");
  });

  test("invite redeem creates mutual grant, notifies both bots, and is single-use", async () => {
    const { app } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const victor = await signup(app, "victor-bot", {
      public_key: "age1victorvictorvictor",
    });

    const invite = await call(app, "POST", "/api/invites", { token: alice.token });
    expect(invite.status).toBe(201);
    expect(invite.json.url).toContain("/i/hni_");

    const redeem = await call(app, "POST", `/api/invites/${invite.json.token}/redeem`, {
      token: victor.token,
    });
    expect(redeem.status).toBe(200);
    expect(redeem.json.granted).toBe(true);
    expect(redeem.json.peer.name).toBe("alice-bot");

    // Creator's inbox has the invite-tagged notification with the redeemer's key.
    const inbox = await call(app, "GET", "/api/inbox", { token: alice.token });
    const mail = realMail(inbox.json.messages);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.tag).toBe("invite");
    const event = JSON.parse(mail[0]!.body);
    expect(event.name).toBe("victor-bot");
    expect(event.public_key).toBe("age1victorvictorvictor");

    const redeemerInbox = await call(app, "GET", "/api/inbox", { token: victor.token });
    expect(redeemerInbox.json.count).toBe(1);
    expect(redeemerInbox.json.messages[0].tag).toBe("invite");
    expect(JSON.parse(redeemerInbox.json.messages[0].body)).toMatchObject({
      event: "invite.connected",
      name: "alice-bot",
    });

    const a2v = await call(app, "POST", "/api/dm/victor-bot", {
      token: alice.token,
      body: { body: "armored ciphertext", enc: "age" },
    });
    expect(a2v.status).toBe(201);
    const v2a = await call(app, "POST", "/api/dm/alice-bot", {
      token: victor.token,
      body: { body: "hello back", enc: "none" },
    });
    expect(v2a.status).toBe(201);

    const third = await signup(app, "third-bot");
    const again = await call(app, "POST", `/api/invites/${invite.json.token}/redeem`, {
      token: third.token,
    });
    expect(again.status).toBe(410);
  });

  test("cannot redeem own invite", async () => {
    const { app } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const invite = await call(app, "POST", "/api/invites", { token: alice.token });
    const res = await call(app, "POST", `/api/invites/${invite.json.token}/redeem`, {
      token: alice.token,
    });
    expect(res.status).toBe(400);
  });

  test("a single-use invite has exactly one winner under concurrent redemption", async () => {
    const { app } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const bob = await signup(app, "bob-bot");
    const carol = await signup(app, "carol-bot");
    const invite = await call(app, "POST", "/api/invites", { token: alice.token });

    const attempts = await Promise.all([
      call(app, "POST", `/api/invites/${invite.json.token}/redeem`, { token: bob.token }),
      call(app, "POST", `/api/invites/${invite.json.token}/redeem`, { token: carol.token }),
    ]);
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual([200, 410]);

    const grants = await call(app, "GET", "/api/grants", { token: alice.token });
    expect(peers(grants.json.grants)).toHaveLength(1);
    const inbox = await call(app, "GET", "/api/inbox", { token: alice.token });
    expect(inbox.json.messages.filter((message: any) => message.tag === "invite")).toHaveLength(1);
  });

  test("expired invites cannot create grants", async () => {
    const { app, db } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const bob = await signup(app, "bob-bot");
    const invite = await call(app, "POST", "/api/invites", { token: alice.token });
    await db
      .update(invites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invites.token, invite.json.token));

    const expired = await call(app, "POST", `/api/invites/${invite.json.token}/redeem`, {
      token: bob.token,
    });
    expect(expired.status).toBe(410);
    expect(expired.json.error).toBe("invite_expired");
    expect(peers((await call(app, "GET", "/api/grants", { token: alice.token })).json.grants)).toHaveLength(0);
  });

  test("the invite creation route enforces its daily limit", async () => {
    const { app, db } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const [creator] = await db.select().from(handles).where(eq(handles.name, "alice-bot"));
    const dayMs = 86_400_000;
    await db.insert(rateCounters).values({
      handleId: creator!.id,
      kind: "invite",
      windowStart: new Date(Math.floor(Date.now() / dayMs) * dayMs),
      count: 20,
    });

    const limited = await call(app, "POST", "/api/invites", { token: alice.token });
    expect(limited.status).toBe(429);
    expect(limited.json.error).toBe("rate_limited");
    expect(await db.select().from(invites)).toHaveLength(0);
  });

  test("grants list shows key_changed after rotation; revoke kills both directions", async () => {
    const { app } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const victor = await signup(app, "victor-bot", { public_key: "age1originalkey" });
    await connect(app, alice, victor);

    let grantsRes = await call(app, "GET", "/api/grants", { token: alice.token });
    expect(peers(grantsRes.json.grants)[0].key_changed).toBe(false);

    await call(app, "PATCH", "/api/handles/me", {
      token: victor.token,
      body: { public_key: "age1rotatedkey" },
    });
    grantsRes = await call(app, "GET", "/api/grants", { token: alice.token });
    expect(peers(grantsRes.json.grants)[0].key_changed).toBe(true);
    expect(peers(grantsRes.json.grants)[0].pinned_key).toBe("age1originalkey");

    const revoke = await call(app, "DELETE", "/api/grants/victor-bot", { token: alice.token });
    expect(revoke.status).toBe(200);
    const blocked = await call(app, "POST", "/api/dm/alice-bot", {
      token: victor.token,
      body: { body: "still there?", enc: "none" },
    });
    expect(blocked.status).toBe(403);
  });
});

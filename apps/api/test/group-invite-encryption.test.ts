import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { groupInvites, handles, invites } from "../src/db/schema";
import { createGroup, createGroupInvite } from "../src/lib/groups";
import { openSecret } from "../src/lib/secret-box";
import { sha256Hex } from "../src/lib/tokens";
import { call, makeTestApp, makeTestDb, signup } from "./helpers";

test("legacy raw invite links remain usable while stored hashes are not bearer credentials", async () => {
  const { app, db } = await makeTestApp();
  const owner = await signup(app, "legacy-owner");
  const member = await signup(app, "legacy-member");
  const direct = await call(app, "POST", "/api/invites", { token: owner.token });
  const directHash = await sha256Hex(direct.json.token);
  expect((await call(app, "POST", `/api/invites/${directHash}/redeem`, { token: member.token })).status).toBe(404);
  await db.update(invites).set({ token: direct.json.token }).where(eq(invites.token, directHash));
  expect((await call(app, "POST", `/api/invites/${direct.json.token}/redeem`, { token: member.token })).status).toBe(200);

  const group = await call(app, "POST", "/api/groups", { token: owner.token, body: { name: "Legacy" } });
  const groupHash = await sha256Hex(group.json.invite.token);
  expect((await call(app, "POST", `/api/group-invites/${groupHash}/redeem`, { token: member.token })).status).toBe(404);
  await db.update(groupInvites).set({ token: group.json.invite.token }).where(eq(groupInvites.token, groupHash));
  expect((await call(app, "POST", `/api/group-invites/${group.json.invite.token}/redeem`, { token: member.token })).status).toBe(200);
});

test("group invite stores a hash and purpose-bound encrypted copy for resharing", async () => {
  const db = await makeTestDb();
  const [owner] = await db
    .insert(handles)
    .values({ name: "group-owner", bearerHash: "owner" })
    .returning();
  const encryptionKey = "test-group-invite-encryption-key";
  const group = await createGroup(db, owner!.id, "Friends", null, encryptionKey);
  const [stored] = await db.select().from(groupInvites).where(eq(groupInvites.groupId, group.id));
  expect(stored!.token).toBe(await sha256Hex(group.invite.token));
  expect(stored!.tokenEnc).toBeString();
  expect(stored!.tokenEnc).not.toContain(group.invite.token);
  expect(await openSecret(encryptionKey, `group-invite:${group.id}`, stored!.tokenEnc!)).toBe(
    group.invite.token,
  );
  expect(await openSecret("wrong-key", `group-invite:${group.id}`, stored!.tokenEnc!)).toBeNull();
  expect(
    await openSecret(encryptionKey, `group-invite:${group.id + 1}`, stored!.tokenEnc!),
  ).toBeNull();

  const replacement = await createGroupInvite(db, group.id, owner!.id, null, encryptionKey);
  const [replaced] = await db
    .select()
    .from(groupInvites)
    .where(eq(groupInvites.token, await sha256Hex(replacement.token)));
  expect(await openSecret(encryptionKey, `group-invite:${group.id}`, replaced!.tokenEnc!)).toBe(
    replacement.token,
  );
});

test("without an encryption key group creation keeps only the hashed capability", async () => {
  const db = await makeTestDb();
  const [owner] = await db
    .insert(handles)
    .values({ name: "group-owner", bearerHash: "owner" })
    .returning();
  const group = await createGroup(db, owner!.id, "Friends");
  const [stored] = await db.select().from(groupInvites).where(eq(groupInvites.groupId, group.id));
  expect(stored!.token).toBe(await sha256Hex(group.invite.token));
  expect(stored!.tokenEnc).toBeNull();
});

test("bot group creation and replacement thread the server encryption key", async () => {
  const encryptionKey = "test-route-group-encryption-key";
  const { app, db } = await makeTestApp({ notificationEncryptionKey: encryptionKey });
  const owner = await signup(app, "group-owner");
  const created = await call(app, "POST", "/api/groups", {
    token: owner.token,
    body: { name: "Friends" },
  });
  const replacement = await call(app, "POST", `/api/groups/${created.json.id}/invites`, {
    token: owner.token,
  });
  for (const token of [created.json.invite.token, replacement.json.invite.token]) {
    const [stored] = await db
      .select()
      .from(groupInvites)
      .where(eq(groupInvites.token, await sha256Hex(token)));
    expect(
      await openSecret(encryptionKey, `group-invite:${stored!.groupId}`, stored!.tokenEnc!),
    ).toBe(token);
  }
});

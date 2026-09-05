import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { grants, groupMembers, groups, invites } from "../src/db/schema";
import { createGroup } from "../src/lib/groups";
import { sha256Hex } from "../src/lib/tokens";
import { call, makeTestApp, signup } from "./helpers";

test("failed receipt insertion rolls back a direct invite and grants, permitting retry", async () => {
  const { app, db } = await makeTestApp();
  const owner = await signup(app, "atomic-owner");
  const member = await signup(app, "atomic-member");
  const invite = await call(app, "POST", "/api/invites", { token: owner.token });
  await db.execute(
    sql`CREATE FUNCTION fail_payload() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test payload failure'; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER fail_payload BEFORE INSERT ON message_payloads FOR EACH ROW EXECUTE FUNCTION fail_payload()`,
  );
  expect(
    (await call(app, "POST", `/api/invites/${invite.json.token}/redeem`, { token: member.token }))
      .status,
  ).toBe(500);
  const [stored] = await db
    .select()
    .from(invites)
    .where(eq(invites.token, await sha256Hex(invite.json.token)));
  expect(stored!.redeemedAt).toBeNull();
  expect(await db.select().from(grants).where(eq(grants.inviteId, stored!.id))).toHaveLength(0);
  await db.execute(sql`DROP TRIGGER fail_payload ON message_payloads`);
  expect(
    (await call(app, "POST", `/api/invites/${invite.json.token}/redeem`, { token: member.token }))
      .status,
  ).toBe(200);
});

test("failed group invite creation rolls back group and owner membership", async () => {
  const { app, db } = await makeTestApp();
  const owner = await signup(app, "atomic-owner");
  const me = await call(app, "GET", "/api/handles/me", { token: owner.token });
  const { handles } = await import("../src/db/schema");
  const [row] = await db.select().from(handles).where(eq(handles.name, me.json.name));
  await db.execute(
    sql`CREATE FUNCTION fail_invite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test invite failure'; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER fail_invite BEFORE INSERT ON group_invites FOR EACH ROW EXECUTE FUNCTION fail_invite()`,
  );
  await expect(createGroup(db, row!.id, "Atomic group")).rejects.toThrow();
  expect(await db.select().from(groups)).toHaveLength(0);
  expect(await db.select().from(groupMembers)).toHaveLength(0);
});

test("failed group join receipt rolls back membership, permitting retry", async () => {
  const { app, db } = await makeTestApp();
  const owner = await signup(app, "atomic-owner");
  const member = await signup(app, "atomic-member");
  const group = await call(app, "POST", "/api/groups", {
    token: owner.token,
    body: { name: "Atomic group" },
  });
  await db.execute(
    sql`CREATE FUNCTION fail_payload() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test payload failure'; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER fail_payload BEFORE INSERT ON message_payloads FOR EACH ROW EXECUTE FUNCTION fail_payload()`,
  );
  const path = `/api/group-invites/${group.json.invite.token}/redeem`;
  expect((await call(app, "POST", path, { token: member.token })).status).toBe(500);
  expect(await db.select().from(groupMembers)).toHaveLength(1);
  await db.execute(sql`DROP TRIGGER fail_payload ON message_payloads`);
  expect((await call(app, "POST", path, { token: member.token })).status).toBe(200);
});

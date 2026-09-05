import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { handles, messages } from "../src/db/schema";
import { queueMessage, RecipientKeyChanged } from "../src/lib/messages";
import { call, connect, makeTestApp, signup } from "./helpers";

test("DM rejects a stale checked key and plaintext downgrade after rotation", async () => {
  const { app } = await makeTestApp();
  const original = await identityToRecipient(await generateIdentity());
  const replacement = await identityToRecipient(await generateIdentity());
  const sender = await signup(app, "key-sender");
  const recipient = await signup(app, "key-recipient", { public_key: original });
  await connect(app, sender, recipient);
  await call(app, "PATCH", "/api/handles/me", { token: recipient.token, body: { public_key: replacement } });
  const response = await call(app, "POST", `/api/dm/${recipient.name}`, {
    token: sender.token, body: { body: "ciphertext for old key", enc: "age", recipient_public_key: original },
  });
  expect(response.status).toBe(409);
  expect(response.json.error).toBe("recipient_key_changed");
  const downgraded = await call(app, "POST", `/api/dm/${recipient.name}`, {
    token: sender.token, body: { body: "plaintext", enc: "none", recipient_public_key: null },
  });
  expect(downgraded.status).toBe(409);
});

test("queue rechecks the encryption key inside its transaction before inserting", async () => {
  const { db } = await makeTestApp();
  const [sender, recipient] = await db.insert(handles).values([
    { name: "key-sender", bearerHash: "sender" },
    { name: "key-recipient", bearerHash: "recipient", publicKey: "original" },
  ]).returning();
  const expectedRecipientKey = recipient!.publicKey;
  await db.update(handles).set({ publicKey: "replacement" }).where(eq(handles.id, recipient!.id));
  await expect(queueMessage(db, {
    fromId: sender!.id, toId: recipient!.id, body: "ciphertext", enc: "age", expectedRecipientKey,
    expiresAt: new Date(Date.now() + 60000),
  })).rejects.toBeInstanceOf(RecipientKeyChanged);
  expect(await db.select().from(messages)).toHaveLength(0);
});

// The week-one acceptance test: two bots, one invite link, an encrypted "hi",
// the server never holds plaintext, and the payload is gone after ack.
import { describe, expect, test } from "bun:test";
import { Decrypter, Encrypter, armor, generateIdentity, identityToRecipient } from "age-encryption";
import { eq } from "drizzle-orm";
import { messagePayloads, messages } from "../src/db/schema";
import { call, makeTestApp, signup } from "./helpers";

describe("two bots, end to end", () => {
  test("encrypted hi: server sees only ciphertext, ack deletes content but retains audit", async () => {
    const { app, db } = await makeTestApp();

    const aliceIdentity = await generateIdentity();
    const aliceRecipient = await identityToRecipient(aliceIdentity);
    const alice = await signup(app, "alice-bot", { public_key: aliceRecipient });
    const bob = await signup(app, "bob-bot");

    const invite = await call(app, "POST", "/api/invites", { token: alice.token });
    const redeem = await call(app, "POST", `/api/invites/${invite.json.token}/redeem`, {
      token: bob.token,
    });
    expect(redeem.status).toBe(200);
    expect(redeem.json.peer.public_key).toBe(aliceRecipient);

    // Bob encrypts to Alice's published key — armored, like the age CLI's -a flag.
    const secret = "the venue changed, 6pm — tell no one";
    const enc = new Encrypter();
    enc.addRecipient(redeem.json.peer.public_key);
    const ciphertext = armor.encode(await enc.encrypt(secret));

    const send = await call(app, "POST", "/api/dm/alice-bot", {
      token: bob.token,
      body: { body: ciphertext, enc: "age" },
    });
    expect(send.status).toBe(201);

    // The server's own storage holds ciphertext, not the message.
    const stored = await db
      .select({ body: messagePayloads.body })
      .from(messagePayloads)
      .where(eq(messagePayloads.messageId, send.json.id));
    expect(stored[0]!.body).toContain("AGE ENCRYPTED FILE");
    expect(stored[0]!.body).not.toContain("venue");

    const inbox = await call(app, "GET", "/api/inbox", { token: alice.token });
    const envelope = inbox.json.messages.find((m: any) => m.enc === "age" && m.from === "bob-bot");
    expect(envelope.from).toBe("bob-bot");
    const dec = new Decrypter();
    dec.addIdentity(aliceIdentity);
    expect(await dec.decrypt(armor.decode(envelope.body), "text")).toBe(secret);

    // Ack: content is physically gone, while body-free delivery metadata remains.
    await call(app, "POST", "/api/inbox/ack", { token: alice.token, body: { ids: [envelope.id] } });
    const remainingPayload = await db
      .select()
      .from(messagePayloads)
      .where(eq(messagePayloads.messageId, envelope.id));
    expect(remainingPayload.length).toBe(0);
    const [audit] = await db.select().from(messages).where(eq(messages.id, envelope.id));
    expect(audit!.acknowledgedAt).not.toBeNull();

    const plain = await call(app, "POST", "/api/dm/bob-bot", {
      token: alice.token,
      body: { body: "got it. ack'd and deleted.", enc: "none" },
    });
    expect(plain.status).toBe(201);
    const bobInbox = await call(app, "GET", "/api/inbox", { token: bob.token });
    expect(bobInbox.json.messages.at(-1).body).toBe("got it. ack'd and deleted.");
  });
});

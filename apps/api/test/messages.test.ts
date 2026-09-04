import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { MESSAGE_TTL_MS } from "../src/context";
import { handles, rateCounters } from "../src/db/schema";
import { queueMessages } from "../src/lib/messages";
import { call, connect, makeTestApp, signup } from "./helpers";

async function drainInbox(app: Awaited<ReturnType<typeof makeTestApp>>["app"], token: string) {
  const inbox = await call(app, "GET", "/api/inbox", { token });
  if (inbox.json.count > 0) {
    await call(app, "POST", "/api/inbox/ack", {
      token,
      body: { ids: inbox.json.messages.map((message: any) => message.id) },
    });
  }
}

describe("dm and inbox", () => {
  test("validation: enc values, empty body, oversized body, enc age without key", async () => {
    const { app } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const victor = await signup(app, "victor-bot"); // no key
    await connect(app, alice, victor);

    const badEnc = await call(app, "POST", "/api/dm/victor-bot", {
      token: alice.token,
      body: { body: "x", enc: "rot13" },
    });
    expect(badEnc.status).toBe(400);

    const empty = await call(app, "POST", "/api/dm/victor-bot", {
      token: alice.token,
      body: { body: "", enc: "none" },
    });
    expect(empty.status).toBe(400);

    const huge = await call(app, "POST", "/api/dm/victor-bot", {
      token: alice.token,
      body: { body: "x".repeat(64 * 1024 + 1), enc: "none" },
    });
    expect(huge.status).toBe(413);

    const noKey = await call(app, "POST", "/api/dm/victor-bot", {
      token: alice.token,
      body: { body: "ciphertext", enc: "age" },
    });
    expect(noKey.status).toBe(400);
    expect(noKey.json.error).toBe("recipient_has_no_key");
    expect(
      (await call(app, "POST", "/api/dm/not-a-bot", {
        token: alice.token,
        body: { body: "hello", enc: "none" },
      })).status,
    ).toBe(404);
  });

  test("inbox is oldest-first and ack permanently deletes payload content", async () => {
    const { app } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const victor = await signup(app, "victor-bot");
    await connect(app, alice, victor);

    await drainInbox(app, alice.token);
    await drainInbox(app, victor.token);

    await call(app, "POST", "/api/dm/victor-bot", { token: alice.token, body: { body: "one", enc: "none" } });
    await call(app, "POST", "/api/dm/victor-bot", { token: alice.token, body: { body: "two", enc: "none" } });

    const inbox = await call(app, "GET", "/api/inbox", { token: victor.token });
    expect(inbox.json.count).toBe(2);
    expect(inbox.json.messages.map((m: any) => m.body)).toEqual(["one", "two"]);
    expect(inbox.json.messages.map((m: any) => m.bytes)).toEqual([3, 3]);
    expect(inbox.json.notice).toContain("untrusted");

    const ack = await call(app, "POST", "/api/inbox/ack", {
      token: victor.token,
      body: { ids: [inbox.json.messages[0].id] },
    });
    expect(ack.json.deleted).toBe(1);

    const alreadyAcked = await call(app, "GET", `/api/inbox/${inbox.json.messages[0].id}`, {
      token: victor.token,
    });
    expect(alreadyAcked.status).toBe(410);
    expect(alreadyAcked.json).toMatchObject({
      error: "content_deleted",
      status: "acknowledged",
    });

    const after = await call(app, "GET", "/api/inbox", { token: victor.token });
    expect(after.json.count).toBe(1);
    expect(after.json.messages[0].body).toBe("two");
  });

  test("cannot ack someone else's messages", async () => {
    const { app } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const victor = await signup(app, "victor-bot");
    const mallory = await signup(app, "mallory-bot");
    await connect(app, alice, victor);

    await call(app, "POST", "/api/dm/victor-bot", { token: alice.token, body: { body: "secret", enc: "none" } });
    const inbox = await call(app, "GET", "/api/inbox", { token: victor.token });
    const id = inbox.json.messages.find((m: any) => m.tag === "granted").id;

    const steal = await call(app, "POST", "/api/inbox/ack", { token: mallory.token, body: { ids: [id] } });
    expect(steal.json.deleted).toBe(0);
    const still = await call(app, "GET", "/api/inbox", { token: victor.token });
    expect(still.json.messages.some((m: any) => m.id === id)).toBe(true);
  });

  test("keyed recipients reject plaintext and expose the key needed to encrypt", async () => {
    const { app } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const victor = await signup(app, "victor-bot", {
      public_key: "age1victorvictorvictor",
    });
    await connect(app, alice, victor);

    const plaintext = await call(app, "POST", "/api/dm/victor-bot", {
      token: alice.token,
      body: { body: "secret", enc: "none" },
    });
    expect(plaintext.status).toBe(400);
    expect(plaintext.json.error).toBe("encryption_required");
    expect(plaintext.json.public_key).toBe("age1victorvictorvictor");

    const encrypted = await call(app, "POST", "/api/dm/victor-bot", {
      token: alice.token,
      body: { body: "armored ciphertext", enc: "age" },
    });
    expect(encrypted.status).toBe(201);
  });

  test("headers stay body-free, one-message reads are recipient-only, and ack ids are strict", async () => {
    const { app } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const victor = await signup(app, "victor-bot");
    const mallory = await signup(app, "mallory-bot");
    await connect(app, alice, victor);
    await drainInbox(app, victor.token);
    await call(app, "POST", "/api/dm/victor-bot", {
      token: alice.token,
      body: { body: "é🙂", enc: "none" },
    });

    const headers = await call(app, "GET", "/api/inbox/headers", { token: victor.token });
    expect(headers.json.messages).toHaveLength(1);
    expect(headers.json.messages[0].body).toBeUndefined();
    expect(headers.json.messages[0].bytes).toBe(6);
    const id = headers.json.messages[0].id;

    const opened = await call(app, "GET", `/api/inbox/${id}`, { token: victor.token });
    expect(opened.status).toBe(200);
    expect(opened.json.body).toBe("é🙂");
    expect(opened.json.notice).toContain("untrusted");
    expect((await call(app, "GET", `/api/inbox/${id}`, { token: alice.token })).status).toBe(404);
    expect((await call(app, "GET", `/api/inbox/${id}`, { token: mallory.token })).status).toBe(404);
    expect((await call(app, "GET", "/api/inbox/nope", { token: victor.token })).status).toBe(400);

    for (const ids of [[], ["1"], [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1]]) {
      const invalid = await call(app, "POST", "/api/inbox/ack", {
        token: victor.token,
        body: { ids },
      });
      expect(invalid.status).toBe(400);
    }
    expect((await call(app, "GET", `/api/inbox/${id}`, { token: victor.token })).status).toBe(200);
  });

  test("inbox views are bounded to 100 oldest envelopes", async () => {
    const { app, db } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const victor = await signup(app, "victor-bot");
    await connect(app, alice, victor);
    await drainInbox(app, victor.token);
    const [from] = await db.select().from(handles).where(eq(handles.name, "alice-bot"));
    const [to] = await db.select().from(handles).where(eq(handles.name, "victor-bot"));
    await queueMessages(
      db,
      Array.from({ length: 105 }, (_, index) => ({
        fromId: from!.id,
        toId: to!.id,
        body: `message-${index.toString().padStart(3, "0")}`,
        enc: "none" as const,
        expiresAt: new Date(Date.now() + MESSAGE_TTL_MS),
      })),
    );

    const headers = await call(app, "GET", "/api/inbox/headers", { token: victor.token });
    expect(headers.json.count).toBe(100);
    expect(headers.json.messages.every((message: any) => message.body === undefined)).toBe(true);
    const inbox = await call(app, "GET", "/api/inbox", { token: victor.token });
    expect(inbox.json.count).toBe(100);
    expect(inbox.json.messages[0].body).toBe("message-000");
    expect(inbox.json.messages[99].body).toBe("message-099");

    await call(app, "POST", "/api/inbox/ack", {
      token: victor.token,
      body: { ids: inbox.json.messages.map((message: any) => message.id) },
    });
    const remaining = await call(app, "GET", "/api/inbox", { token: victor.token });
    expect(remaining.json.messages.map((message: any) => message.body)).toEqual([
      "message-100",
      "message-101",
      "message-102",
      "message-103",
      "message-104",
    ]);
  });

  test("the DM route enforces its hourly sender limit", async () => {
    const { app, db } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const victor = await signup(app, "victor-bot");
    await connect(app, alice, victor);
    await drainInbox(app, victor.token);
    const [sender] = await db.select().from(handles).where(eq(handles.name, "alice-bot"));
    const windowStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    await db.insert(rateCounters).values({
      handleId: sender!.id,
      kind: "dm",
      windowStart,
      count: 100,
    });

    const limited = await call(app, "POST", "/api/dm/victor-bot", {
      token: alice.token,
      body: { body: "one too many", enc: "none" },
    });
    expect(limited.status).toBe(429);
    expect(limited.json.error).toBe("rate_limited");
    expect((await call(app, "GET", "/api/inbox", { token: victor.token })).json.count).toBe(0);
  });

  test("an idempotency key makes DM retries return the original envelope", async () => {
    const { app } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const victor = await signup(app, "victor-bot");
    await connect(app, alice, victor);
    await drainInbox(app, victor.token);

    const request = {
      token: alice.token,
      headers: { "idempotency-key": "calendar-reply-42" },
      body: { body: "Thursday at 7", enc: "none" },
    };
    const first = await call(app, "POST", "/api/dm/victor-bot", request);
    const replay = await call(app, "POST", "/api/dm/victor-bot", request);
    expect(first.status).toBe(201);
    expect(first.json.replayed).toBe(false);
    expect(replay.status).toBe(201);
    expect(replay.json.replayed).toBe(true);
    expect(replay.json.id).toBe(first.json.id);

    const inbox = await call(app, "GET", "/api/inbox", { token: victor.token });
    expect(inbox.json.messages.filter((message: any) => message.tag === "granted")).toHaveLength(1);

    const reused = await call(app, "POST", "/api/dm/victor-bot", {
      ...request,
      body: { body: "Friday at 8", enc: "none" },
    });
    expect(reused.status).toBe(409);
    expect(reused.json.error).toBe("idempotency_key_reused");
  });
});

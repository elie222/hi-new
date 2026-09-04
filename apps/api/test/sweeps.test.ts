import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { groupInvites, handles, integrationTokens, invites, messagePayloads, messages } from "../src/db/schema";
import { takeRate } from "../src/lib/ratelimit";
import { isSafeWebhookUrl, pingWebhook } from "../src/lib/webhook";
import { dailySweep, hourlySweep } from "../src/sweeps";
import { call, connect, makeTestApp, signup, peers } from "./helpers";

const DAY = 24 * 3600 * 1000;

describe("sweeps", () => {
  test("hourly: unread messages die at TTL, unpaid short names release after 24h", async () => {
    const { app, db } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const victor = await signup(app, "victor-bot");
    await connect(app, alice, victor);
    await call(app, "POST", "/api/dm/victor-bot", { token: alice.token, body: { body: "hi", enc: "none" } });
    await call(app, "POST", "/api/handles", { body: { name: "vlad", email: "vlad@owners.example" } }); // pending, unpaid

    await hourlySweep(db, new Date(Date.now() + 8 * DAY));

    expect((await db.select().from(messagePayloads)).length).toBe(0);
    const audit = await db.select().from(messages);
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((message) => message.expiredAt !== null)).toBe(true);
    expect((await db.select().from(handles).where(eq(handles.name, "vlad"))).length).toBe(0);
    expect((await db.select().from(handles)).length).toBe(3);
  });

  test("daily: free idle handles reclaimed after 90d, cascade clears grants", async () => {
    const { app, db } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const victor = await signup(app, "victor-bot");
    await connect(app, alice, victor);

    await db
      .update(handles)
      .set({ lastActiveAt: new Date(Date.now() - 91 * DAY) })
      .where(eq(handles.name, "alice-bot"));

    await dailySweep(db);

    expect((await db.select().from(handles).where(eq(handles.name, "alice-bot"))).length).toBe(0);
    const grantsLeft = await call(app, "GET", "/api/grants", { token: victor.token });
    expect(peers(grantsLeft.json.grants).length).toBe(0);
    const reclaim = await call(app, "POST", "/api/handles", { body: { name: "alice-bot", email: "a2@owners.example" } });
    expect(reclaim.status).toBe(201);
  });

  test("hourly removes expired direct/group invites and expiring integration tokens", async () => {
    const { app, db } = await makeTestApp();
    const owner = await signup(app, "owner-bot");
    await call(app, "POST", "/api/invites", { token: owner.token });
    await call(app, "POST", "/api/groups", {
      token: owner.token,
      body: { name: "Sweep me" },
    });
    await call(app, "POST", "/api/tokens", {
      token: owner.token,
      body: { name: "expiring", scopes: ["profile:read"], expires_in_days: 1 },
    });
    await call(app, "POST", "/api/tokens", {
      token: owner.token,
      body: { name: "permanent", scopes: ["profile:read"] },
    });

    await hourlySweep(db, new Date(Date.now() + 31 * DAY));

    expect(await db.select().from(invites)).toHaveLength(0);
    expect(await db.select().from(groupInvites)).toHaveLength(0);
    const credentials = await db.select().from(integrationTokens);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]!.name).toBe("permanent");
  });
});

describe("rate limiting", () => {
  test("fixed window counts and blocks over the limit", async () => {
    const { db } = await makeTestApp();
    const [h] = await db
      .insert(handles)
      .values({ name: "ratey", bearerHash: "x" })
      .returning();
    expect(await takeRate(db, h!.id, "t", 3, 3600)).toBe(true);
    expect(await takeRate(db, h!.id, "t", 3, 3600)).toBe(true);
    expect(await takeRate(db, h!.id, "t", 3, 3600)).toBe(true);
    expect(await takeRate(db, h!.id, "t", 3, 3600)).toBe(false);
  });
});

describe("webhook SSRF guard", () => {
  test("blocks internal targets, allows public ones", async () => {
    for (const bad of [
      "http://localhost:8080/x",
      "http://127.0.0.1/x",
      "http://10.0.0.5/x",
      "http://192.168.1.1/x",
      "http://172.16.0.1/x",
      "http://169.254.169.254/latest/meta-data",
      "http://100.100.1.1/x",
      "http://[::1]/x",
      "http://foo.internal/x",
      "http://foo.local/x",
      "ftp://example.com/x",
      "not a url",
    ]) {
      expect(isSafeWebhookUrl(bad)).toBe(false);
    }
    for (const good of ["https://example.com/hook", "https://hooks.zapier.com/a/b", "http://93.184.216.34/x"]) {
      expect(isSafeWebhookUrl(good)).toBe(true);
    }
  });

  test("new-mail pings contain no sender or message content", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedBody = "";
    let pending: Promise<unknown> | undefined;
    globalThis.fetch = (async (input, init) => {
      capturedUrl = String(input);
      capturedBody = String(init?.body ?? "");
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      pingWebhook("https://example.com/hook", "victor-bot", 3, (promise) => {
        pending = promise;
      });
      await pending;
      expect(capturedUrl).toBe("https://example.com/hook");
      expect(JSON.parse(capturedBody)).toEqual({
        event: "inbox.new",
        to: "victor-bot",
        unread: 3,
      });
      expect(capturedBody).not.toContain("sender");
      expect(capturedBody).not.toContain("message body");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { integrationTokens } from "../src/db/schema";
import { call, connect, makeTestApp, signup } from "./helpers";

describe("integration tokens", () => {
  test("are scoped, listed without secrets, and revocable", async () => {
    const { app } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const bob = await signup(app, "bob-bot");
    await connect(app, alice, bob);
    await call(app, "POST", "/api/dm/alice-bot", {
      token: bob.token,
      body: { body: "hello", enc: "none" },
    });

    const created = await call(app, "POST", "/api/tokens", {
      token: alice.token,
      body: { name: "approval reader", scopes: ["messages:list"] },
    });
    expect(created.status).toBe(201);
    expect(created.json.token).toStartWith("hnt_");

    const headers = await call(app, "GET", "/api/inbox/headers", { token: created.json.token });
    expect(headers.status).toBe(200);
    const bobMessage = headers.json.messages.find(
      (message: any) => message.from === "bob-bot" && message.tag === "granted",
    );
    expect(bobMessage).toBeDefined();
    expect(bobMessage.body).toBeUndefined();
    expect(bobMessage.bytes).toBe(5);

    const full = await call(app, "GET", "/api/inbox", { token: created.json.token });
    expect(full.status).toBe(403);
    expect(full.json.required).toBe("messages:read");
    const send = await call(app, "POST", "/api/dm/bob-bot", {
      token: created.json.token,
      body: { body: "no", enc: "none" },
    });
    expect(send.status).toBe(403);

    const listed = await call(app, "GET", "/api/tokens", { token: alice.token });
    expect(listed.json.tokens).toHaveLength(1);
    expect(listed.json.tokens[0].token).toBeUndefined();
    expect((await call(app, "GET", "/api/tokens", { token: created.json.token })).status).toBe(403);

    const revoked = await call(app, "DELETE", `/api/tokens/${created.json.id}`, { token: alice.token });
    expect(revoked.status).toBe(200);
    expect((await call(app, "GET", "/api/inbox/headers", { token: created.json.token })).status).toBe(401);
  });

  test("read and write scopes stay separate across every route family", async () => {
    const { app } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const bob = await signup(app, "bob-bot");
    await connect(app, alice, bob);
    await call(app, "POST", "/api/dm/alice-bot", {
      token: bob.token,
      body: { body: "for alice", enc: "none" },
    });

    const reader = await call(app, "POST", "/api/tokens", {
      token: alice.token,
      body: {
        name: "reader",
        scopes: ["profile:read", "contacts:read", "messages:list", "groups:read"],
      },
    });
    for (const path of ["/api/handles/me", "/api/grants", "/api/inbox/headers", "/api/groups"]) {
      expect((await call(app, "GET", path, { token: reader.json.token })).status).toBe(200);
    }
    expect(
      (await call(app, "PATCH", "/api/handles/me", { token: reader.json.token, body: { webhook_url: null } })).status,
    ).toBe(403);
    expect((await call(app, "POST", "/api/invites", { token: reader.json.token })).status).toBe(403);
    expect(
      (await call(app, "POST", "/api/dm/bob-bot", {
        token: reader.json.token,
        body: { body: "blocked", enc: "none" },
      })).status,
    ).toBe(403);
    expect(
      (await call(app, "POST", "/api/groups", {
        token: reader.json.token,
        body: { name: "Blocked" },
      })).status,
    ).toBe(403);
    expect((await call(app, "GET", "/api/inbox", { token: reader.json.token })).status).toBe(403);

    const writer = await call(app, "POST", "/api/tokens", {
      token: alice.token,
      body: {
        name: "writer",
        scopes: ["profile:write", "contacts:write", "messages:send", "groups:write"],
      },
    });
    expect(
      (await call(app, "PATCH", "/api/handles/me", {
        token: writer.json.token,
        body: { webhook_url: null },
      })).status,
    ).toBe(200);
    expect((await call(app, "POST", "/api/invites", { token: writer.json.token })).status).toBe(201);
    expect(
      (await call(app, "POST", "/api/dm/bob-bot", {
        token: writer.json.token,
        body: { body: "allowed", enc: "none" },
      })).status,
    ).toBe(201);
    expect(
      (await call(app, "POST", "/api/groups", {
        token: writer.json.token,
        body: { name: "Allowed" },
      })).status,
    ).toBe(201);
    for (const path of ["/api/handles/me", "/api/grants", "/api/inbox/headers", "/api/groups"]) {
      expect((await call(app, "GET", path, { token: writer.json.token })).status).toBe(403);
    }
    expect(
      (await call(app, "POST", "/api/tokens", {
        token: writer.json.token,
        body: { name: "nested", scopes: ["profile:read"] },
      })).status,
    ).toBe(403);

    const bodyReader = await call(app, "POST", "/api/tokens", {
      token: alice.token,
      body: { name: "body reader", scopes: ["messages:read"] },
    });
    const inbox = await call(app, "GET", "/api/inbox", { token: bodyReader.json.token });
    expect(inbox.status).toBe(200);
    expect((await call(app, "GET", "/api/inbox/headers", { token: bodyReader.json.token })).status).toBe(403);
    const id = inbox.json.messages[0].id;
    expect((await call(app, "GET", `/api/inbox/${id}`, { token: bodyReader.json.token })).status).toBe(200);
    expect(
      (await call(app, "POST", "/api/inbox/ack", {
        token: bodyReader.json.token,
        body: { ids: [id] },
      })).status,
    ).toBe(200);
  });

  test("validates creation, isolates owners, and rejects expired credentials", async () => {
    const { app, db } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const bob = await signup(app, "bob-bot");

    for (const body of [
      { name: "", scopes: ["profile:read"] },
      { name: "x".repeat(65), scopes: ["profile:read"] },
      { name: "bad", scopes: [] },
      { name: "bad", scopes: ["unknown"] },
      { name: "bad", scopes: ["profile:read"], expires_in_days: 0 },
      { name: "bad", scopes: ["profile:read"], expires_in_days: 366 },
      { name: "bad", scopes: ["profile:read"], expires_in_days: 1.5 },
    ]) {
      expect((await call(app, "POST", "/api/tokens", { token: alice.token, body })).status).toBe(400);
    }

    const created = await call(app, "POST", "/api/tokens", {
      token: alice.token,
      body: {
        name: "expiring",
        scopes: ["profile:read", "profile:read"],
        expires_in_days: 1,
      },
    });
    expect(created.status).toBe(201);
    expect(created.json.scopes).toEqual(["profile:read"]);
    expect(
      (await call(app, "DELETE", `/api/tokens/${created.json.id}`, { token: bob.token })).status,
    ).toBe(404);
    expect((await call(app, "GET", "/api/handles/me", { token: created.json.token })).status).toBe(200);

    await db
      .update(integrationTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(integrationTokens.id, created.json.id));
    const expired = await app.request("http://hi.test/api/handles/me", {
      headers: { authorization: `Bearer ${created.json.token}` },
    });
    expect(expired.status).toBe(401);
    expect(expired.headers.get("www-authenticate")).toContain("invalid_token");
  });
});

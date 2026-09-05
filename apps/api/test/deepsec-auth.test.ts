import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { checkName } from "@hi-new/domain";
import { emailTokens, handles, user, verification } from "../src/db/schema";
import { createApp } from "../src/app";
import { createOwnerAuth } from "../src/lib/owner-auth";
import { resendSender } from "../src/lib/email";
import { randomToken, sha256Hex } from "../src/lib/tokens";
import { call, makeTestApp, signup } from "./helpers";

describe("credential boundaries", () => {
  test("a lost claim response can be retried with the pre-persisted credential", async () => {
    const { app } = await makeTestApp();
    const token = randomToken("hn", 32);
    const request = { body: { name: "durable-claim" }, headers: { "x-hi-new-claim-token": token } };
    const first = await call(app, "POST", "/api/handles", request);
    expect(first.status).toBe(201);
    expect(first.json.token).toBe(token);
    const retry = await call(app, "POST", "/api/handles", request);
    expect(retry.status).toBe(201);
    expect(retry.json.token).toBe(token);
    expect((await call(app, "POST", "/api/handles", { ...request, headers: {} })).status).toBe(409);
  });

  test("concurrent setup exchanges return the credential at most once", async () => {
    const { app } = await makeTestApp();
    const bot = await signup(app, "atomic-setup");
    const code = await call(app, "POST", "/api/handles/me/setup-code", { token: bot.token });
    const results = await Promise.all(Array.from({ length: 3 }, () => call(app, "POST", "/api/setup", { body: { code: code.json.code } })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 410)).toHaveLength(2);
  });

  test("a setup code cannot retrieve a rotated bearer", async () => {
    const { app, db } = await makeTestApp();
    const bot = await signup(app, "rotated-setup");
    const code = await call(app, "POST", "/api/handles/me/setup-code", { token: bot.token });
    await db.update(handles).set({ bearerHash: await sha256Hex(randomToken("hn")) }).where(eq(handles.name, bot.name));
    expect((await call(app, "POST", "/api/setup", { body: { code: code.json.code } })).status).toBe(410);
  });

  test("profile-scoped integration credentials cannot attach recovery ownership", async () => {
    const { app } = await makeTestApp();
    const bot = await signup(app, "scoped-owner", { email: null });
    const integration = await call(app, "POST", "/api/tokens", { token: bot.token, body: { name: "Profile", scopes: ["profile:write"] } });
    expect(integration.status).toBe(201);
    const result = await call(app, "PATCH", "/api/handles/me", { token: integration.json.token, body: { email: "attacker@example.com" } });
    expect(result.status).toBe(403);
    expect((await call(app, "GET", "/api/handles/me", { token: bot.token })).json.email).toBeNull();
  });

  test("verification capability is hashed in the database and still works", async () => {
    const { app, db, sent } = await makeTestApp();
    await signup(app, "hashed-owner");
    const raw = sent[0]!.text.match(/\/v\/(hnv_[\w-]+)/)![1]!;
    const [row] = await db.select().from(emailTokens);
    expect(row!.token).toBe(await sha256Hex(raw));
    expect((await app.request(`http://hi.test/v/${row!.token}`)).status).toBe(410);
    expect((await app.request(`http://hi.test/v/${raw}`)).status).toBe(200);
  });

  test("legacy email links survive rollout without accepting stored digests", async () => {
    const { app, db, sent } = await makeTestApp();
    await signup(app, "legacy-owner");
    const raw = sent[0]!.text.match(/\/v\/(hnv_[\w-]+)/)![1]!;
    const [row] = await db.select().from(emailTokens);
    await db.update(emailTokens).set({ token: raw }).where(eq(emailTokens.id, row!.id));
    expect((await app.request(`http://hi.test/v/${raw}`)).status).toBe(200);
    const recovery = randomToken("hnr");
    await db.insert(emailTokens).values({ handleId: row!.handleId, kind: "recover", token: await sha256Hex(recovery), expiresAt: new Date(Date.now() + 60000) });
    expect((await app.request(`http://hi.test/r/${await sha256Hex(recovery)}`)).status).toBe(410);
    expect((await app.request(`http://hi.test/r/${recovery}`)).status).toBe(200);
  });

  test("mail fails closed when no provider is configured", async () => {
    await expect(resendSender(undefined)({ to: "owner@example.com", subject: "Sign in", text: "https://hi.new/owner/l/secret" })).rejects.toThrow();
  });

  test("static application routes cannot be sold as handles", () => {
    for (const name of ["setup", "connect", "og"]) expect(checkName(name).ok).toBe(false);
  });

  test("unverified sessions cannot read the owner's dashboard", async () => {
    const { app, db, sent } = await makeTestApp();
    await signup(app, "private-owner");
    await app.request("http://hi.test/owner/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "email=private-owner%40owners.example" });
    const raw = sent.at(-1)!.text.match(/\/owner\/l\/([\w-]+)/)![1]!;
    const [stored] = await db.select().from(verification).where(eq(verification.identifier, await sha256Hex(raw)));
    expect(stored).toBeDefined();
    expect((await app.request(`http://hi.test/owner/l/${stored!.identifier}`)).status).toBe(410);
    const forged = await app.request(`http://hi.test/owner/auth/magic-link/verify?token=${stored!.identifier}&callbackURL=/owner`);
    expect(forged.headers.get("location")).toContain("error");
    // A link created by the previous Worker remains usable before backfill.
    await db.update(verification).set({ identifier: raw }).where(eq(verification.id, stored!.id));
    expect((await app.request(`http://hi.test/owner/l/${raw}`)).status).toBe(200);
    const verified = await app.request(`http://hi.test/owner/auth/magic-link/verify?token=${raw}&callbackURL=/owner`);
    const cookie = verified.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c?.includes("session_token="))!;
    expect(cookie).toBeDefined();
    await db.update(user).set({ emailVerified: false }).where(eq(user.email, "private-owner@owners.example"));
    const response = await app.request("http://hi.test/owner", { headers: { cookie } });
    expect(await response.text()).not.toContain("private-owner</");
    expect(response.status).not.toBe(500);
  });

  test("OAuth account persistence drops provider bearer credentials", async () => {
    const { db } = await makeTestApp();
    const auth = createOwnerAuth({ db, origin: "http://hi.test", env: {}, sendEmail: async () => {} });
    const context = await auth.$context;
    const owner = await context.internalAdapter.createUser({ email: "oauth@example.com", name: "Owner", emailVerified: true }, { method: "magic-link" });
    const account = await context.internalAdapter.createAccount({ userId: owner.id, providerId: "google", issuer: "https://accounts.google.com", accountId: "provider-account", accessToken: "secret-access", refreshToken: "secret-refresh", idToken: "secret-id" });
    expect(account).toMatchObject({ accessToken: null, refreshToken: null, idToken: null });
    const updated = await context.internalAdapter.updateAccount(account.id, { accessToken: "new-secret-access", refreshToken: "new-secret-refresh", idToken: "new-secret-id" });
    expect(updated).toMatchObject({ accessToken: null, refreshToken: null, idToken: null });
  });

  test("MCP forwards Worker bindings and rejects undeclared profile arguments", async () => {
    const { db } = await makeTestApp();
    const app = createApp({ db, sendEmail: async () => {} });
    const bot = await signup(app, "binding-owner");
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const protocol = "2026-07-28";
      const response = await app.request("http://hi.test/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bot.token}`, "mcp-protocol-version": protocol, "mcp-method": "tools/call", "mcp-name": name }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": protocol, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) }, { NOTIFICATION_ENCRYPTION_KEY: "bound-only-on-request" });
      return await response.json() as any;
    };
    const result = await invoke("create_notification", { kind: "webhook", endpoint: { url: "https://example.com/hook" } });
    expect(result.result.isError).toBe(false);
    const rejected = await invoke("update_profile", { email: "attacker@example.com" });
    expect(rejected.result.isError).toBe(true);
    expect(JSON.parse(rejected.result.content[0].text).error).toBe("unknown_argument");
  });
});

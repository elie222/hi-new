import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { handles } from "../src/db/schema";
import { createOwnerAuth } from "../src/lib/owner-auth";
import { call, makeTestApp, makeTestDb, signup, type TestApp } from "./helpers";

function limiter(limit: number) {
  const hits = new Map<string, number>();
  return {
    async limit({ key }: { key: string }) {
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      return { success: n <= limit };
    },
  };
}

type Env = Record<string, unknown>;

async function request(
  app: TestApp,
  method: string,
  path: string,
  env: Env,
  opts: { body?: unknown; token?: string; ip?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cf-connecting-ip": opts.ip ?? "203.0.113.7",
  };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await app.request(
    `http://hi.test${path}`,
    { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) },
    env,
  );
  const json: any = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, json };
}

describe("unauthenticated rate limits", () => {
  test("claims are throttled per caller address", async () => {
    const { app, db } = await makeTestApp();
    const env = { SIGNUP_LIMIT: limiter(2) };
    expect((await request(app, "POST", "/api/handles", env, { body: { name: "first-bot" } })).status).toBe(201);
    expect((await request(app, "POST", "/api/handles", env, { body: { name: "second-bot" } })).status).toBe(201);
    const third = await request(app, "POST", "/api/handles", env, { body: { name: "third-bot" } });
    expect(third.status).toBe(429);
    expect(third.json.error).toBe("rate_limited");
    expect(third.headers.get("retry-after")).toBe("60");
    expect(await db.select().from(handles).where(eq(handles.name, "third-bot"))).toHaveLength(0);
    expect((await request(app, "POST", "/api/handles", env, { body: { name: "third-bot" }, ip: "198.51.100.9" })).status).toBe(201);
  });

  test("verification and recovery mail is capped per address and per mailbox", async () => {
    const { app, db, sent } = await makeTestApp();
    const env = { EMAIL_LIMIT: limiter(2) };
    const shared = "shared@owners.example";
    expect((await request(app, "POST", "/api/handles", env, { body: { name: "alpha-bot", email: shared } })).status).toBe(201);
    expect((await request(app, "POST", "/api/handles", env, { body: { name: "bravo-bot", email: shared } })).status).toBe(201);
    expect(sent).toHaveLength(2);
    const capped = await request(app, "POST", "/api/handles", env, { body: { name: "charlie-bot", email: shared } });
    expect(capped.status).toBe(429);
    expect(sent).toHaveLength(2);
    expect(await db.select().from(handles).where(eq(handles.name, "charlie-bot"))).toHaveLength(0);
    const c = await request(app, "POST", "/api/handles", env, { body: { name: "charlie-bot" } });
    expect(c.status).toBe(201);

    const patch = (email: string) =>
      request(app, "PATCH", "/api/handles/me", env, { token: c.json.token, body: { email }, ip: "198.51.100.9" });
    expect((await patch("one@owners.example")).status).toBe(200);
    expect((await patch("two@owners.example")).status).toBe(200);
    expect((await patch("three@owners.example")).status).toBe(429);
    expect(sent).toHaveLength(4);
    const [me] = await db.select().from(handles).where(eq(handles.name, "charlie-bot"));
    expect(me!.email).toBe("two@owners.example");

    const d = await request(app, "POST", "/api/handles", env, { body: { name: "delta-bot", email: "d@owners.example" }, ip: "192.0.2.1" });
    expect(d.status).toBe(201);
    const recover = (ip: string) =>
      request(app, "POST", "/api/recover", env, { body: { name: "delta-bot", email: "d@owners.example" }, ip });
    expect((await recover("192.0.2.2")).status).toBe(200);
    expect(sent.at(-1)!.subject).toBe("Recover hi.new/delta-bot");
    const before = sent.length;
    expect((await recover("192.0.2.3")).status).toBe(200);
    expect(sent).toHaveLength(before);
  });

  test("profile lookups are throttled per caller address", async () => {
    const { app } = await makeTestApp();
    await signup(app, "alice-bot");
    const env = { LOOKUP_LIMIT: limiter(1) };
    expect((await request(app, "GET", "/api/handles/alice-bot", env)).status).toBe(200);
    expect((await request(app, "GET", "/api/handles/alice-bot", env)).status).toBe(429);
    expect((await request(app, "GET", "/api/handles/alice-bot", env, { ip: "198.51.100.9" })).status).toBe(200);
  });

  test("without the binding nothing is throttled", async () => {
    const { app } = await makeTestApp();
    for (let i = 0; i < 12; i++) {
      expect((await request(app, "POST", "/api/handles", {}, { body: { name: `bot-${i}-many` } })).status).toBe(201);
    }
  });
});

describe("owner sign-in secret", () => {
  test("production refuses to run on the placeholder secret", async () => {
    const db = await makeTestDb();
    const sendEmail = async () => {};
    expect(() => createOwnerAuth({ db, origin: "https://hi.new", env: {}, sendEmail })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => createOwnerAuth({ db, origin: "https://hi.new", env: { BETTER_AUTH_SECRET: "x".repeat(32) }, sendEmail })).not.toThrow();
    expect(() => createOwnerAuth({ db, origin: "http://localhost:8787", env: {}, sendEmail })).not.toThrow();
  });

  test("a missing secret only affects owner sign-in, not the bot API", async () => {
    const { app } = await makeTestApp();
    const env = { APP_ORIGIN: "https://hi.test" };
    const alice = await signup(app, "alice-bot");
    expect((await request(app, "GET", "/api/handles/me", env, { token: alice.token })).status).toBe(200);
    expect((await request(app, "GET", "/owner", env)).status).toBe(500);
  });
});

describe("framing", () => {
  test("html pages refuse to be framed; json does not carry the headers", async () => {
    const { app } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    for (const path of ["/alice-bot", "/owner", "/recover"]) {
      const res = await app.request(`http://hi.test${path}`);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    }
    const res = await app.request("http://hi.test/api/handles/me", { headers: { authorization: `Bearer ${alice.token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect((await call(app, "GET", "/api/handles/alice-bot")).status).toBe(200);
  });
});

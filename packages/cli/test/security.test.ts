import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { Store } from "../src/store";
import { newIdentity } from "../src/crypto";

const origin = "https://hi.test";
const credentials = { name: "alice", token: "hn_secret", identity: null, publicKey: null, origin };
const message = { id: 1, from: "bob", enc: "none", body: "keep me", created_at: "2026-01-01", tag: null, group: null };

test("origin overrides never send another deployment's credentials", async () => {
  const home = mkdtempSync(join(tmpdir(), "hi-new-security-"));
  new Store(home).save(credentials);
  let fetched = false;
  const result = await run(["me", "--origin", "https://evil.test"], {
    env: { HI_NEW_HOME: home },
    fetch: async () => { fetched = true; return Response.json({}); },
    io: { stdout() {}, stderr() {}, readStdin: async () => "" },
  });
  expect(result).toBe(2);
  expect(fetched).toBe(false);
});

test("inbox does not acknowledge until asynchronous output succeeds", async () => {
  const home = mkdtempSync(join(tmpdir(), "hi-new-security-"));
  new Store(home).save(credentials);
  let acked = false;
  const result = await run(["inbox", "--ack", "--json"], {
    env: { HI_NEW_HOME: home },
    fetch: async (url) => {
      if (url.endsWith("/ack")) { acked = true; return Response.json({ acknowledged: 1 }); }
      return Response.json({ messages: [message] });
    },
    io: { stdout: async () => { await Promise.resolve(); throw new Error("EPIPE"); }, stderr() {}, readStdin: async () => "" },
  });
  expect(result).toBe(1);
  expect(acked).toBe(false);
});

test("API errors do not serialize credential fields", async () => {
  const home = mkdtempSync(join(tmpdir(), "hi-new-security-"));
  const errors: string[] = [];
  await run(["setup", "hns_code", "--json"], {
    env: { HI_NEW_HOME: home },
    fetch: async () => Response.json({ error: "invalid", token: "hn_secret", credentials: { token: "secret" } }, { status: 400 }),
    io: { stdout() {}, stderr: (line) => { errors.push(line); }, readStdin: async () => "" },
  });
  expect(errors.join()).not.toContain("hn_secret");
  expect(errors.join()).not.toContain("credentials");
});

test("paid claims save token and private key before exposing payment instructions", async () => {
  const home = mkdtempSync(join(tmpdir(), "hi-new-security-"));
  const output: string[] = [];
  const result = await run(["claim", "alice", "--json"], {
    env: { HI_NEW_HOME: home, HI_NEW_ORIGIN: origin },
    fetch: async (_url, init) => {
      const saved = new Store(home).load("alice", origin)!;
      expect(saved.token).toMatch(/^hn_[\w-]{43}$/);
      expect(saved.identity).toMatch(/^AGE-SECRET-KEY/);
      expect(new Headers(init.headers).get("x-hi-new-claim-token")).toBe(saved.token);
      expect(JSON.parse(String(init.body)).public_key).toBe(saved.publicKey);
      return Response.json({ name: "alice", token: saved.token, checkout_url: "https://hi.test/buy/alice", price_usd_per_year: 50 }, { status: 402 });
    },
    io: { stdout: (line) => { output.push(line); }, stderr: (line) => { throw new Error(line); }, readStdin: async () => "" },
  });
  expect(result).toBe(0);
  expect(JSON.parse(output.join()).reserved).toBe(true);
  expect(output.join()).not.toContain(new Store(home).load("alice", origin)!.token);
});

test("a lost claim response can be retried with the same persisted capability and key", async () => {
  const home = mkdtempSync(join(tmpdir(), "hi-new-security-"));
  const tokens: string[] = [];
  const keys: string[] = [];
  const opts = {
    env: { HI_NEW_HOME: home, HI_NEW_ORIGIN: origin },
    fetch: async (_url: string, init: RequestInit): Promise<Response> => {
      tokens.push(new Headers(init.headers).get("x-hi-new-claim-token")!);
      keys.push(JSON.parse(String(init.body)).public_key);
      throw new Error("connection lost after commit");
    },
    io: { stdout() {}, stderr() {}, readStdin: async () => "" },
  };
  expect(await run(["claim", "alice"], opts)).toBe(1);
  expect(await run(["claim", "alice"], opts)).toBe(1);
  expect(tokens[0]).toBe(tokens[1]);
  expect(keys[0]).toBe(keys[1]);
});

test("key registration saves its private half before remote commit and reconciles a lost response", async () => {
  const home = mkdtempSync(join(tmpdir(), "hi-new-security-"));
  let serverKey: string | null = null;
  const result = await run(["setup", "hn_secret", "--no-hi"], {
    env: { HI_NEW_HOME: home, HI_NEW_ORIGIN: origin },
    fetch: async (url, init) => {
      if (init.method === "PATCH") {
        serverKey = JSON.parse(String(init.body)).public_key;
        expect(new Store(home).load("alice", origin)!.publicKey).toBe(serverKey);
        throw new Error("response lost");
      }
      return Response.json(url.endsWith("/inbox") ? { messages: [] } : { name: "alice", public_key: serverKey });
    },
    io: { stdout() {}, stderr() {}, readStdin: async () => "" },
  });
  expect(result).toBe(0);
  expect(new Store(home).load("alice", origin)!.publicKey).toBe(serverKey);
});

test("unreadable encrypted messages remain queued even with inbox --ack", async () => {
  const home = mkdtempSync(join(tmpdir(), "hi-new-security-"));
  new Store(home).save(credentials);
  let acked = false;
  expect(await run(["inbox", "--ack"], {
    env: { HI_NEW_HOME: home },
    fetch: async (url) => {
      if (url.endsWith("/ack")) acked = true;
      return Response.json({ messages: [{ ...message, enc: "age" }] });
    },
    io: { stdout() {}, stderr() {}, readStdin: async () => "" },
  })).toBe(0);
  expect(acked).toBe(false);
});

test("message submission includes the recipient key used for encryption", async () => {
  const home = mkdtempSync(join(tmpdir(), "hi-new-security-"));
  new Store(home).save(credentials);
  const { publicKey } = await newIdentity();
  let checked = false;
  expect(await run(["send", "bob", "hello"], {
    env: { HI_NEW_HOME: home },
    fetch: async (url, init) => {
      if (url.endsWith("/grants")) return Response.json({ grants: [{ name: "bob", public_key: publicKey, key_changed: false }] });
      const body = JSON.parse(String(init.body));
      expect(body.recipient_public_key).toBe(publicKey);
      expect(body.enc).toBe("age");
      checked = true;
      return Response.json({ id: 1 });
    },
    io: { stdout() {}, stderr() {}, readStdin: async () => "" },
  })).toBe(0);
  expect(checked).toBe(true);
});

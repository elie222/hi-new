import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { Db } from "../src/db/client";
import * as schema from "../src/db/schema";

export async function makeTestDb(): Promise<Db> {
  const pg = new PGlite();
  const dir = join(import.meta.dir, "../drizzle");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    await pg.exec(readFileSync(join(dir, file), "utf8"));
  }
  return drizzle(pg, { schema }) as unknown as Db;
}

export type TestApp = ReturnType<typeof createApp>;
export type SentMail = { to: string; subject: string; text: string };

export async function makeTestApp(overrides?: {
  notificationEncryptionKey?: string;
  waitUntil?: (promise: Promise<unknown>) => void;
}): Promise<{ app: TestApp; db: Db; sent: SentMail[] }> {
  const db = await makeTestDb();
  const sent: SentMail[] = [];
  const app = createApp({
    db,
    notificationEncryptionKey:
      overrides?.notificationEncryptionKey ?? "test-notification-encryption-key",
    waitUntil: overrides?.waitUntil,
    sendEmail: async (msg) => {
      sent.push(msg);
    },
  });
  return { app, db, sent };
}

export async function call(
  app: TestApp,
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await app.request(`http://hi.test${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json };
}

export async function signup(
  app: TestApp,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<{ name: string; token: string }> {
  const res = await call(app, "POST", "/api/handles", {
    body: { name, email: `${name}@owners.example`, ...extra },
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.json)}`);
  return { name: res.json.name, token: res.json.token };
}

// Grants to real peers: every bot also holds a grant to the house bot (hi).
export function peers(grants: any[]): any[] {
  return grants.filter((g) => g.name !== "hi");
}

// Inbox minus the house bot's welcome.
export function realMail(messages: any[]): any[] {
  return messages.filter((m) => m.from !== "hi");
}

export async function connect(
  app: TestApp,
  inviter: { token: string },
  redeemer: { token: string },
): Promise<void> {
  const invite = await call(app, "POST", "/api/invites", { token: inviter.token });
  if (invite.status !== 201) throw new Error(`invite failed: ${invite.status}`);
  const redeem = await call(app, "POST", `/api/invites/${invite.json.token}/redeem`, {
    token: redeemer.token,
  });
  if (redeem.status !== 200) throw new Error(`redeem failed: ${redeem.status} ${JSON.stringify(redeem.json)}`);
}

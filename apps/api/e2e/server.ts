// The whole site in one process for end-to-end tests: the Hono app on an
// in-memory Postgres (pglite), outgoing mail captured instead of sent, and
// the built landing served the way wrangler's assets binding does (static
// file first, worker for everything else). No Postgres, no Resend, no wrangler.
//
//   bun run --cwd apps/api e2e/server.ts            → http://127.0.0.1:4777
//   GET  /__e2e/mail             → captured emails, newest first
//   GET  /__e2e/requests         → every bot-facing page, doc, and API call so far
//   POST /__e2e/mail/clear
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import { handles, invites } from "../src/db/schema";
import { makeTestDb, type SentMail } from "../test/helpers";

const PORT = Number(process.env.E2E_PORT ?? 4777);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DIST = join(import.meta.dir, "../../landing/dist");
if (!existsSync(join(DIST, "index.html"))) {
  console.error("apps/landing/dist is missing — run: bun run --cwd apps/landing build");
  process.exit(1);
}

const sent: SentMail[] = [];
const db = await makeTestDb();
const app = createApp({
  db,
  sendEmail: async (msg) => {
    sent.unshift(msg);
  },
});
const env = {
  APP_ORIGIN: ORIGIN,
  BETTER_AUTH_SECRET: "e2e-only-secret-0123456789abcdefghijklmnopqrstuvwxyz",
  NOTIFICATION_ENCRYPTION_KEY: "e2e-only-encryption-0123456789abcdefghijklmnopqrstuvwxyz",
  // E2E_FAKE_OAUTH=1 makes the provider buttons render (sign-in itself is not exercised).
  ...(process.env.E2E_FAKE_OAUTH
    ? { GITHUB_CLIENT_ID: "fake", GITHUB_CLIENT_SECRET: "fake", GOOGLE_CLIENT_ID: "fake", GOOGLE_CLIENT_SECRET: "fake" }
    : {}),
  // Minimal stand-in for wrangler's assets binding: routes like /:name/setup
  // serve a static page through it.
  ASSETS: {
    fetch: async (req: Request) => {
      const file = staticFile(new URL(req.url).pathname);
      return file ? new Response(Bun.file(file)) : new Response("not found", { status: 404 });
    },
  },
};

function staticFile(pathname: string): string | null {
  if (pathname.includes("..")) return null;
  const candidates = pathname.endsWith("/")
    ? [`${pathname}index.html`]
    : [pathname, `${pathname}/index.html`];
  for (const rel of candidates) {
    const file = join(DIST, rel);
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

type RequestLog = {
  method: string;
  path: string;
  status: number | null;
  userAgent: string;
  body?: unknown;
};

const requests: RequestLog[] = [];

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/__e2e/mail") return Response.json(sent);
    // Every route an agent may use, so evals can distinguish page, docs, CLI, and raw HTTP paths.
    if (url.pathname === "/__e2e/requests") return Response.json(requests);
    let requestLog: RequestLog | null = null;
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/i/") ||
      url.pathname === "/skill.md" ||
      url.pathname === "/api.md"
    ) {
      requestLog = {
        method: req.method,
        path: url.pathname,
        status: null,
        userAgent: req.headers.get("user-agent") ?? "",
        ...(req.method === "POST" && url.pathname === "/api/dm/hi"
          ? { body: await req.clone().json().catch(() => null) }
          : {}),
      };
      requests.push(requestLog);
    }
    if (url.pathname === "/__e2e/mail/clear") {
      sent.length = 0;
      return Response.json({ ok: true });
    }
    // What exists right now, for graders: handles and invite counts.
    if (url.pathname === "/__e2e/state") {
      const rows = await db.select({ name: handles.name, email: handles.email, publicKey: handles.publicKey, createdAt: handles.createdAt }).from(handles);
      const inviteRows = await db.select({ token: invites.token, creatorId: invites.creatorId, message: invites.message, redeemedAt: invites.redeemedAt }).from(invites);
      const byId = new Map((await db.select({ id: handles.id, name: handles.name }).from(handles)).map((h) => [h.id, h.name]));
      return Response.json({
        handles: rows,
        invites: inviteRows.map((i) => ({ token: i.token, creator: byId.get(i.creatorId) ?? null, message: i.message, redeemed: i.redeemedAt !== null })),
      });
    }
    let response: Response;
    if (req.method === "GET") {
      const file = staticFile(url.pathname);
      if (file) response = new Response(Bun.file(file));
      else response = await app.fetch(req, env);
    } else {
      response = await app.fetch(req, env);
    }
    if (requestLog) requestLog.status = response.status;
    return response;
  },
});
console.log(`e2e server on ${ORIGIN}`);

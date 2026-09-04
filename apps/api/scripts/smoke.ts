// The week-one test against a LIVE server: two bots, one invite link, an
// encrypted "hi", ack, gone. Run: BASE_URL=http://localhost:8787 bun scripts/smoke.ts
// Uses throwaway names and revokes/acks everything it creates.
import { Decrypter, Encrypter, armor, generateIdentity, identityToRecipient } from "age-encryption";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const run = Math.random().toString(36).slice(2, 8);
const A = `smoke-a-${run}`;
const B = `smoke-b-${run}`;

async function req(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, json };
}

function assert(cond: unknown, label: string) {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`  ok: ${label}`);
}

console.log(`smoke test against ${BASE} as ${A} / ${B}`);

const identity = await generateIdentity();
const recipient = await identityToRecipient(identity);

// Signup: A with a key, B plaintext-only. delivered@resend.dev is Resend's
// accept-everything test inbox, so smoke runs never bounce real mail.
const EMAIL = process.env.SMOKE_EMAIL ?? "delivered@resend.dev";
const a = await req("POST", "/api/handles", { name: A, email: EMAIL, public_key: recipient });
assert(a.status === 201 && a.json.token, "signup with age key → 201 + token");
const b = await req("POST", "/api/handles", { name: B, email: EMAIL });
assert(b.status === 201, "curl-only signup → 201");
const noEmail = await req("POST", "/api/handles", { name: "smoke-x-" + run });
assert(noEmail.status === 201, "signup without email → 201 (attach later)");
const attach = await req(
  "PATCH",
  "/api/handles/me",
  { email: EMAIL },
  noEmail.json.token,
);
assert(attach.status === 200 && attach.json.verify?.includes("verification"), "attach email via PATCH → verify sent");

// Profile advertises E2E.
const profile = await req("GET", `/api/handles/${A}`);
assert(profile.json.e2e === true && profile.json.public_key === recipient, "profile shows key");

// Keyed recipients refuse plaintext outright; strangers with ciphertext still
// hit the grant wall.
const plainToKeyed = await req("POST", `/api/dm/${A}`, { body: "spam", enc: "none" }, b.json.token);
assert(plainToKeyed.status === 400 && plainToKeyed.json.error === "encryption_required", "plaintext to keyed handle → 400");
const stranger = await req("POST", `/api/dm/${A}`, { body: "sealed-spam", enc: "age" }, b.json.token);
assert(stranger.status === 403, "no grant → 403");

// Invite → redeem → mutual grant.
const invite = await req("POST", "/api/invites", undefined, a.json.token);
assert(invite.status === 201 && invite.json.url.includes("/i/"), "invite link created");
const redeem = await req("POST", `/api/invites/${invite.json.token}/redeem`, undefined, b.json.token);
assert(redeem.status === 200 && redeem.json.peer.public_key === recipient, "redeem pins peer key");

// B encrypts to A's published key and sends.
const secret = `the venue changed, 6pm (${run})`;
const enc = new Encrypter();
enc.addRecipient(recipient);
const sent = await req(
  "POST",
  `/api/dm/${A}`,
  { body: armor.encode(await enc.encrypt(secret)), enc: "age" },
  b.json.token,
);
assert(sent.status === 201, "encrypted dm accepted");

// A polls, decrypts, acks.
const inbox = await req("GET", "/api/inbox", undefined, a.json.token);
const envelope = inbox.json.messages.find((m: any) => m.enc === "age");
assert(envelope?.from === B, "envelope arrived, correct sender");
const dec = new Decrypter();
dec.addIdentity(identity);
assert((await dec.decrypt(armor.decode(envelope.body), "text")) === secret, "decrypts to exact message");
const ids = inbox.json.messages.map((m: any) => m.id);
const ack = await req("POST", "/api/inbox/ack", { ids }, a.json.token);
assert(ack.json.deleted === ids.length, "ack deletes");
const empty = await req("GET", "/api/inbox", undefined, a.json.token);
assert(empty.json.count === 0, "inbox empty after ack — payload gone");

// Plaintext direction (B has no key).
const plain = await req("POST", `/api/dm/${B}`, { body: "got it", enc: "none" }, a.json.token);
assert(plain.status === 201, "plaintext dm accepted");
const bInbox = await req("GET", "/api/inbox", undefined, b.json.token);
assert(bInbox.json.messages.some((m: any) => m.body === "got it"), "plaintext round-trips");
await req("POST", "/api/inbox/ack", { ids: bInbox.json.messages.map((m: any) => m.id) }, b.json.token);

console.log("\nall good — server held only ciphertext, and only until ack.");

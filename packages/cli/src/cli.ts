import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Api, ApiError, type FetchLike, type Json, type Message } from "./api.js";
import { parseArgs, UsageError, type Flags } from "./args.js";
import { decryptWith, encryptTo, idempotencyKey, newIdentity, recipientOf } from "./crypto.js";
import { DEFAULT_ORIGIN, normalizeOrigin, resolveHome, Store, type Credentials } from "./store.js";

export const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();

export const HOUSE_BOT = "hi";

export type Io = {
  stdout: (line: string) => void | Promise<void>;
  stderr: (line: string) => void | Promise<void>;
  readStdin: () => Promise<string>;
};

export type RunOptions = {
  fetch?: FetchLike;
  env?: Record<string, string | undefined>;
  io?: Io;
};

export const USAGE = `hi-new <command> [options]

Commands
  setup <hns_code | hn_token> [--email addr] [--no-key] [--no-hi] [--redeem url]
                          Trade a setup code for the token, register an age key, store credentials,
                          read the inbox and do the "hi" round trip.
                          --redeem also redeems an invite and shows what arrived
  claim <name> [--email addr] [--no-key] [--no-hi] [--redeem url]
                          Claim a name your human chose (no setup code), then the same as setup
  me                      Your profile
  inbox [--ack]           List messages, decrypted. --ack acknowledges them after printing
  ack <ids...>            Acknowledge messages (deletes their payload)
  send <name> [text]      Send a message. Reads stdin when text is omitted. Encrypts when the peer has a key
  hi                      Send "hi" to hi.new/hi, the round-trip test
  invite [--message text] Create a single-use invite link
  redeem <token-or-url>   Redeem an invite and show the peer's opening message
  grants                  Peers you can message
  whoami                  Stored names and which is the default

Options
  --name <name>     Use this stored name (default: the last one used)
  --origin <url>    API origin (default: $HI_NEW_ORIGIN or ${DEFAULT_ORIGIN})
  --json            Machine-readable output
  --help, --version

Credentials: $HI_NEW_HOME or ~/.hi-new/<origin-hash>/<name>.json (mode 600).`;

type Ctx = {
  flags: Flags;
  positionals: string[];
  store: Store;
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  io: Io;
  json: boolean;
};

type Decrypted = Message & { text: string; decrypted: boolean };

const userAgent = `hi-new-cli/${VERSION}`;

function originFor(ctx: Ctx, stored?: string | null): string {
  return normalizeOrigin(ctx.flags.origin || ctx.env.HI_NEW_ORIGIN || stored || DEFAULT_ORIGIN);
}

function anonApi(ctx: Ctx): Api {
  return new Api({ origin: originFor(ctx), fetch: ctx.fetch, userAgent });
}

// The stored name plus a client authenticated as it.
function loadCreds(ctx: Ctx): { creds: Credentials; api: Api } {
  const selection = ctx.store.defaultSelection();
  const name = ctx.flags.name ?? selection?.name;
  if (!name) {
    throw new UsageError(`no credentials in ${ctx.store.dir}. Run: hi-new setup <hns_code>`);
  }
  const creds = ctx.store.load(name, originFor(ctx, selection?.origin));
  if (!creds) throw new UsageError(`no credentials for ${name} in ${ctx.store.dir}`);
  const api = new Api({ origin: originFor(ctx, creds.origin), fetch: ctx.fetch, userAgent, token: creds.token });
  return { creds, api };
}

async function decryptAll(messages: Message[], identity: string | null): Promise<Decrypted[]> {
  const out: Decrypted[] = [];
  for (const m of messages) {
    if (m.enc !== "age") {
      out.push({ ...m, text: m.body, decrypted: false });
      continue;
    }
    if (!identity) {
      out.push({ ...m, text: "[encrypted; no identity stored for this name]", decrypted: false });
      continue;
    }
    try {
      out.push({ ...m, text: await decryptWith(identity, m.body), decrypted: true });
    } catch (err) {
      out.push({ ...m, text: `[could not decrypt: ${(err as Error).message}]`, decrypted: false });
    }
  }
  return out;
}

async function printMessages(ctx: Ctx, messages: Decrypted[]): Promise<void> {
  if (messages.length === 0) {
    await ctx.io.stdout("Inbox empty.");
    return;
  }
  await ctx.io.stdout(`${messages.length} message${messages.length === 1 ? "" : "s"}`);
  for (const m of messages) {
    const bits = [`#${m.id}`, `from ${m.from}`, m.created_at];
    if (m.tag) bits.push(`tag=${m.tag}`);
    if (m.group) bits.push(`group=${m.group.name}`);
    bits.push(m.enc === "age" ? (m.decrypted ? "e2e" : "e2e, unreadable") : "plaintext");
    await ctx.io.stdout("");
    await ctx.io.stdout(bits.join("  "));
    await ctx.io.stdout(m.text);
  }
}

function inviteToken(input: string): string {
  const match = input.match(/hni_[A-Za-z0-9_-]+/);
  if (!match) throw new UsageError("expected an invite token (hni_...) or invite URL");
  return match[0];
}

// Fetch a peer's current key, refusing when the pinned grant says it changed.
async function peerKey(api: Api, name: string): Promise<string | null> {
  const { grants } = await api.grants();
  const grant = grants.find((g) => g.name === name);
  if (grant) {
    if (grant.key_changed) {
      throw new UsageError(`${name}'s key changed since the grant was made. Re-verify out of band, then send.`);
    }
    return typeof grant.public_key === "string" ? grant.public_key : null;
  }
  const profile = await api.handle(name);
  return typeof profile.public_key === "string" ? profile.public_key : null;
}

async function sendTo(ctx: Ctx, name: string, text: string): Promise<Json> {
  const { api } = loadCreds(ctx);
  const key = await peerKey(api, name);
  const body = key ? await encryptTo(key, text) : text;
  let res: Json;
  try {
    res = await api.dm(name, body, key ? "age" : "none", idempotencyKey(name, text), key);
  } catch (err) {
    // The key is a hash of recipient and text, so a reused-key conflict means
    // this exact message already went. Fresh ciphertext never matches the
    // server's body hash, so encrypted retries land here instead of replaying.
    if (!(err instanceof ApiError) || err.body.error !== "idempotency_key_reused") throw err;
    res = { to: name, replayed: true, note: "Already sent. Not queued again." };
  }
  if (ctx.json) {
    await ctx.io.stdout(JSON.stringify(res, null, 2));
    return res;
  }
  if (res.id === undefined) await ctx.io.stdout(`already sent to ${name}. Not queued again.`);
  else await ctx.io.stdout(`sent #${res.id} to ${name} (${key ? "e2e" : "plaintext"}${res.replayed ? ", replayed" : ""})`);
  if (res.reply_queued) await ctx.io.stdout(`hi.new/${name} replied. Run: hi-new inbox`);
  return res;
}

// The setup finale: send "hi" to the house bot and read its reply.
// Setup should not fail on this; the human still gets a working inbox either way.
async function roundTrip(api: Api, identity: string | null): Promise<{ sent: boolean; messages: Decrypted[]; acked: number; error: string | null }> {
  let sent = false;
  let error: string | null = null;
  try {
    const key = await peerKey(api, HOUSE_BOT);
    const body = key ? await encryptTo(key, "hi") : "hi";
    await api.dm(HOUSE_BOT, body, key ? "age" : "none", idempotencyKey(HOUSE_BOT, "hi"), key);
    sent = true;
  } catch (err) {
    if (err instanceof ApiError && err.body.error === "idempotency_key_reused") sent = true;
    else error = err instanceof Error ? err.message : String(err);
  }
  const inbox = await api.inbox();
  const messages = await decryptAll(inbox.messages, identity);
  return { sent, messages, acked: 0, error };
}

// Redeem an invite, then show what it brought: the peer, their opening message, and the
// connection receipt. The receipt is server-written and gets acked here; the peer's
// message stays until the agent has relayed it (persist before ack).
async function redeemAndShow(ctx: Ctx, api: Api, identity: string | null, input: string): Promise<Json> {
  const res = await api.redeem(inviteToken(input));
  const inbox = await api.inbox();
  const messages = await decryptAll(inbox.messages, identity);
  const receipts = messages.filter((m) => m.tag === "invite" && (m.enc !== "age" || m.decrypted)).map((m) => m.id);
  const arrived = messages.filter((m) => m.tag !== "invite");
  if (ctx.json) {
    await ctx.io.stdout(JSON.stringify({ ...res, inbox: messages }, null, 2));
    if (receipts.length > 0) await api.ack(receipts);
    return res;
  }
  await ctx.io.stdout(`granted: ${res.peer.name} (${res.peer.public_key ? "e2e" : "plaintext, they have no key yet"})`);
  if (messages.length > 0) {
    await ctx.io.stdout("");
    await printMessages(ctx, messages);
    await ctx.io.stdout("");
    await ctx.io.stdout(`ack with: hi-new ack ${arrived.map((m) => m.id).join(" ")}`);
  }
  await ctx.io.stdout(`send with: hi-new send ${res.peer.name} <text>`);
  if (receipts.length > 0) await api.ack(receipts);
  return res;
}

// Everything after a token exists: keys, credentials on disk, the inbox, the round trip.
// `preset` is an identity whose public key the server already holds (a fresh claim).
async function finishSetup(ctx: Ctx, anon: Api, profile: Json, token: string, preset: { identity: string; publicKey: string } | null): Promise<void> {
    const name: string = profile.name;
    const api = anon.withToken(token);
    const notes: string[] = [];

    // Save the token before anything else can fail.
    const existing = ctx.store.load(name, anon.origin);
    let creds: Credentials = {
      name,
      token,
      identity: preset?.identity ?? existing?.identity ?? null,
      publicKey: preset?.publicKey ?? existing?.publicKey ?? null,
      origin: anon.origin,
      ...(existing?.claimEmail ? { claimEmail: existing.claimEmail } : {}),
    };
    let path = ctx.store.save(creds);

    const serverKey: string | null = typeof profile.public_key === "string" ? profile.public_key : null;
    const holdsServerKey =
      creds.identity !== null && serverKey !== null && (await recipientOf(creds.identity)) === serverKey;
    if (!holdsServerKey) creds = { ...creds, identity: null, publicKey: null };

    const patch: { public_key?: string; email?: string } = {};
    if (!ctx.flags["no-key"] && !holdsServerKey) {
      const fresh = await newIdentity();
      creds = { ...creds, identity: fresh.identity, publicKey: fresh.publicKey };
      patch.public_key = fresh.publicKey;
      if (serverKey) notes.push("Replaced the key on the server. Messages sealed to the old key are unreadable.");
    }
    if (ctx.flags.email && profile.email !== ctx.flags.email) patch.email = ctx.flags.email;

    let failed: ApiError | null = null;
    let verify: string | null = typeof profile.verify === "string" ? profile.verify : null;
    if (Object.keys(patch).length > 0) {
      // Save the private half before the server can publish its public key.
      path = ctx.store.save(creds);
      try {
        const res = await api.patchMe(patch);
        if (typeof res.verify === "string") verify = res.verify;
      } catch (err) {
        // A lost response can follow a committed registration. Retain the key
        // and reconcile through the authenticated profile before reporting failure.
        const current = await api.me().catch(() => null);
        if (current?.public_key !== creds.publicKey || (patch.email && current?.email !== patch.email)) {
          if (!(err instanceof ApiError)) throw err;
          failed = err;
        }
      }
    }
    path = ctx.store.save(creds);

    const me = failed ? profile : await api.me();
    const inbox = await api.inbox();
    let messages = await decryptAll(inbox.messages, creds.identity);
    let trip: Awaited<ReturnType<typeof roundTrip>> | null = null;
    if (!failed && !ctx.flags["no-hi"]) {
      trip = await roundTrip(api, creds.identity);
      messages = trip.messages;
    }

    if (ctx.json) {
      await ctx.io.stdout(
        JSON.stringify(
          {
            name,
            profile_url: me.profile_url ?? `${anon.origin}/${name}`,
            credentials: path,
            public_key: creds.publicKey,
            e2e: creds.publicKey !== null,
            email: me.email ?? null,
            email_verified: me.email_verified ?? false,
            verify: verify ?? me.verify ?? me.warning ?? null,
            error: failed ? { status: failed.status, error: failed.message } : null,
            notes,
            inbox: messages,
            round_trip: trip ? { sent: trip.sent, replied: trip.messages.some((m) => m.from === HOUSE_BOT && m.tag === "granted" && trip!.sent), acked: trip.acked, error: trip.error } : null,
            next_steps: profile.next_steps ?? [],
          },
          null,
          2,
        ),
      );
    } else {
      await printMessages(ctx, messages);
      await ctx.io.stdout("");
      await ctx.io.stdout(`${anon.origin.replace(/^https?:\/\//, "")}/${name} is set up.`);
      await ctx.io.stdout(`credentials  ${path}`);
      await ctx.io.stdout(`e2e          ${creds.publicKey ? `on (${creds.publicKey})` : "off"}`);
      const email = typeof me.email === "string" ? me.email : null;
      await ctx.io.stdout(
        `email        ${email ? `${email} (${me.email_verified ? "verified" : "not verified yet"})` : "none. Attach one within 7 days: hi-new setup <hn_token> --email addr"}`,
      );
      if (verify) await ctx.io.stdout(`             ${verify}`);
      for (const note of notes) await ctx.io.stdout(`note         ${note}`);
      if (failed) await ctx.io.stdout(`error        ${failed.message}${failed.hint ? `. ${failed.hint}` : ""}`);
      if (trip) {
        await ctx.io.stdout(
          `round trip   ${trip.sent ? `done. "hi" sent to ${HOUSE_BOT}, reply above` : "not sent"}${trip.acked > 0 ? `, ${trip.acked} message${trip.acked === 1 ? "" : "s"} acked` : ""}`,
        );
        if (trip.error) await ctx.io.stdout(`             ${trip.error}`);
        if (!ctx.flags.redeem) await ctx.io.stdout("next         tell your human what arrived, then ask who to invite: hi-new invite");
      } else {
        await ctx.io.stdout("next         hi-new hi (round trip), then hi-new inbox --ack");
      }
    }
    if (failed) throw failed;
    if (ctx.flags.redeem) {
      if (!ctx.json) await ctx.io.stdout("");
      await redeemAndShow(ctx, api, creds.identity, ctx.flags.redeem);
      if (!ctx.json) await ctx.io.stdout("next         tell your human who connected and what they said, then send when asked");
    }
}

const commands: Record<string, (ctx: Ctx) => Promise<void>> = {
  async setup(ctx) {
    const secret = ctx.positionals[0];
    if (!secret) throw new UsageError("usage: hi-new setup <hns_code | hn_token> [--email addr] [--no-key] [--no-hi]");
    const anon = anonApi(ctx);
    let profile: Json;
    let token: string;
    if (secret.startsWith("hns_")) {
      profile = await anon.setup(secret);
      token = profile.token;
    } else if (secret.startsWith("hn_")) {
      token = secret;
      profile = await anon.withToken(token).me();
    } else {
      throw new UsageError("expected a setup code (hns_...) or a token (hn_...)");
    }
    await finishSetup(ctx, anon, profile, token, null);
  },

  // A name the human chose, with no setup code: one request claims it with a fresh key.
  async claim(ctx) {
    const name = ctx.positionals[0];
    if (!name) throw new UsageError("usage: hi-new claim <name> [--email addr] [--no-key] [--no-hi]");
    const anon = anonApi(ctx);
    const existing = ctx.store.load(name, anon.origin);
    const fresh = existing?.identity && existing.publicKey
      ? { identity: existing.identity, publicKey: existing.publicKey }
      : ctx.flags["no-key"] ? null : await newIdentity();
    const token = existing?.token ?? "hn_" + randomBytes(32).toString("base64url");
    const email = ctx.flags.email ?? existing?.claimEmail;
    const creds = { name, token, origin: anon.origin, identity: fresh?.identity ?? null, publicKey: fresh?.publicKey ?? null, ...(email ? { claimEmail: email } : {}) };
    const path = ctx.store.save(creds);
    let profile: Json;
    try {
      profile = await anon.claim({ name, public_key: fresh?.publicKey, email }, token);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 402 || typeof err.body.token !== "string") throw err;
      profile = err.body;
      ctx.store.save({ ...creds, token: profile.token });
      const result = { name, reserved: true, credentials: path, checkout_url: profile.checkout_url, price_usd_per_year: profile.price_usd_per_year };
      await ctx.io.stdout(ctx.json ? JSON.stringify(result, null, 2) : `Reserved ${name}. Credentials saved to ${path}.\nPay: ${profile.checkout_url}\nResume: hi-new claim ${name}`);
      return;
    }
    await finishSetup(ctx, anon, profile, profile.token, fresh);
  },

  async me(ctx) {
    const { api, creds } = loadCreds(ctx);
    const me = await api.me();
    if (ctx.json) return await ctx.io.stdout(JSON.stringify({ ...me, credentials: ctx.store.path(creds.name, creds.origin) }, null, 2));
    await ctx.io.stdout(`name      ${me.name}`);
    await ctx.io.stdout(`profile   ${me.profile_url}`);
    await ctx.io.stdout(`e2e       ${me.public_key ? `on (${me.public_key}, fingerprint ${me.fingerprint})` : "off"}`);
    if (me.public_key && creds.publicKey !== me.public_key) {
      await ctx.io.stdout("          stored identity does not match the server key");
    }
    await ctx.io.stdout(`email     ${me.email ? `${me.email} (${me.email_verified ? "verified" : "not verified"})` : "none"}`);
    await ctx.io.stdout(`tier      ${me.tier}${me.paid_until ? ` until ${me.paid_until}` : ""}`);
    if (me.warning) await ctx.io.stdout(`warning   ${me.warning}`);
    if (me.renewal?.warning) await ctx.io.stdout(`renewal   ${me.renewal.warning}`);
  },

  async inbox(ctx) {
    const { api, creds } = loadCreds(ctx);
    const inbox = await api.inbox();
    const messages = await decryptAll(inbox.messages, creds.identity);
    if (ctx.json) {
      await ctx.io.stdout(JSON.stringify({ ...inbox, messages }, null, 2));
    } else {
      await printMessages(ctx, messages);
    }
    // The output callback must resolve only after the consumer accepted the data.
    // Failed decryption is not delivery and must never delete the ciphertext.
    const ids = messages.filter((m) => m.enc !== "age" || m.decrypted).map((m) => m.id);
    if (ctx.flags.ack && ids.length > 0) {
      const acked = await api.ack(ids);
      if (!ctx.json) await ctx.io.stdout(`acked ${acked.acknowledged}`);
    } else if (!ctx.json && messages.length > 0) {
      await ctx.io.stdout(`ack with: hi-new ack ${ids.join(" ")}`);
    }
  },

  async ack(ctx) {
    const ids = ctx.positionals.map(Number);
    if (ids.length === 0 || ids.some((n) => !Number.isSafeInteger(n) || n < 1)) {
      throw new UsageError("usage: hi-new ack <id> [id...]");
    }
    const { api } = loadCreds(ctx);
    const res = await api.ack(ids);
    if (ctx.json) return await ctx.io.stdout(JSON.stringify(res, null, 2));
    await ctx.io.stdout(`acked ${res.acknowledged}`);
  },

  async send(ctx) {
    const [name, ...rest] = ctx.positionals;
    if (!name) throw new UsageError("usage: hi-new send <name> [text]  (reads stdin when text is omitted)");
    const text = rest.length > 0 ? rest.join(" ") : (await ctx.io.readStdin()).replace(/\n$/, "");
    if (!text) throw new UsageError("nothing to send");
    await sendTo(ctx, name.toLowerCase(), text);
  },

  async hi(ctx) {
    await sendTo(ctx, HOUSE_BOT, "hi");
  },

  async invite(ctx) {
    const { api } = loadCreds(ctx);
    const res = await api.invite(ctx.flags.message);
    if (ctx.json) return await ctx.io.stdout(JSON.stringify(res, null, 2));
    await ctx.io.stdout(res.url);
    await ctx.io.stdout(`single use, expires ${res.expires_at}`);
  },

  async redeem(ctx) {
    const input = ctx.positionals[0];
    if (!input) throw new UsageError("usage: hi-new redeem <hni_token | invite url>");
    const { api, creds } = loadCreds(ctx);
    await redeemAndShow(ctx, api, creds.identity, input);
  },

  async grants(ctx) {
    const { api } = loadCreds(ctx);
    const res = await api.grants();
    if (ctx.json) return await ctx.io.stdout(JSON.stringify(res, null, 2));
    if (res.grants.length === 0) return await ctx.io.stdout("No grants. Create an invite: hi-new invite");
    for (const g of res.grants) {
      const bits = [g.name, g.public_key ? "e2e" : "plaintext"];
      if (g.key_changed) bits.push("KEY CHANGED, re-verify before sending");
      await ctx.io.stdout(bits.join("  "));
    }
  },

  async whoami(ctx) {
    const selection = ctx.store.defaultSelection();
    const origin = originFor(ctx, selection?.origin);
    const names = ctx.store.list(origin);
    const def = selection?.origin === origin ? selection.name : null;
    if (ctx.json) return await ctx.io.stdout(JSON.stringify({ dir: ctx.store.dir, default: def, names }, null, 2));
    if (names.length === 0) return await ctx.io.stdout(`No credentials in ${ctx.store.dir}. Run: hi-new setup <hns_code>`);
    for (const n of names) await ctx.io.stdout(`${n}${n === def ? "  (default)" : ""}`);
  },
};

export function writeOutput(stream: NodeJS.WritableStream, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    stream.once("error", onError);
    stream.write(line + "\n", (error?: Error | null) => {
      if (error) {
        // Keep the listener through the stream's corresponding error event.
        setImmediate(() => stream.removeListener("error", onError));
        reject(error);
      } else {
        stream.removeListener("error", onError);
        resolve();
      }
    });
  });
}

export async function run(argv: string[], opts: RunOptions = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const io: Io = opts.io ?? {
    stdout: (line) => writeOutput(process.stdout, line),
    stderr: (line) => writeOutput(process.stderr, line),
    readStdin: () => Promise.resolve(""),
  };
  let json = false;
  try {
    const parsed = parseArgs(argv);
    json = parsed.flags.json === true;
    if (parsed.flags.version) {
      await io.stdout(VERSION);
      return 0;
    }
    if (parsed.flags.help || !parsed.command || parsed.command === "help") {
      await io.stdout(USAGE);
      return parsed.command || parsed.flags.help ? 0 : 2;
    }
    const command = commands[parsed.command];
    if (!command) throw new UsageError(`unknown command: ${parsed.command}\n\n${USAGE}`);
    const ctx: Ctx = {
      flags: parsed.flags,
      positionals: parsed.positionals,
      store: new Store(resolveHome(env)),
      env,
      fetch: opts.fetch ?? ((url, init) => fetch(url, init)),
      io,
      json,
    };
    await command(ctx);
    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      if (json) await io.stderr(JSON.stringify({ status: err.status, error: err.message, hint: err.hint }));
      else await io.stderr(`error: ${err.message} (HTTP ${err.status})${err.hint ? `\n${err.hint}` : ""}`);
      return 1;
    }
    if (err instanceof UsageError) {
      await io.stderr(json ? JSON.stringify({ error: "usage", hint: err.message }) : `error: ${err.message}`);
      return 2;
    }
    const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
    const message = (err instanceof Error ? err.message : String(err)) + cause;
    await io.stderr(json ? JSON.stringify({ error: "failed", hint: message }) : `error: ${message}`);
    return 1;
  }
}

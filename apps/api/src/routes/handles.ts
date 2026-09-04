import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { MAX_FREE_HANDLES_PER_EMAIL, SETUP_CODE_TTL_MS, VERIFY_WINDOW_MS, type AppEnv } from "../context";
import { emailTokens, handles } from "../db/schema";
import { requireAuth, requireOwner, requireScope } from "../lib/auth";
import { BOT_COLORS, effectiveColor, isBotColor, type BotColor } from "@hi-new/ui/bot-colors";
import { isEmail, verifyEmailText } from "../lib/email";
import {
  chargePaidHandle,
  hasMppCredential,
  mppCredentialMatchesClaim,
} from "../lib/mpp";
import { checkName, priceCentsFor } from "@hi-new/domain";
import { isAgePublicKey } from "../lib/keys";
import { newSetupCode, openToken, sealToken, setupCodeHash } from "../lib/setup-code";
import { recordPayment } from "../lib/payments";
import { clientIp, rateLimited, takeEdgeRate, takeEmailRate } from "../lib/ratelimit";
import { renewalView } from "../lib/renewal";
import { fingerprint, randomToken, sha256Hex } from "../lib/tokens";
import { isSafeWebhookUrl } from "../lib/webhook";
import { ensureHouseBot, HOUSE_BOT_NAME, welcomeNewHandle } from "../lib/house-bot";
import { warmOgCard } from "./og";

export const handleRoutes = new Hono<AppEnv>();

type SignupBody = {
  name?: unknown;
  email?: unknown;
  public_key?: unknown;
  webhook_url?: unknown;
  color?: unknown;
  ref?: unknown;
};

function validateOptionalKey(value: unknown): { publicKey: string | null } | { error: string } {
  if (value == null) return { publicKey: null };
  if (typeof value !== "string" || !isAgePublicKey(value)) {
    return { error: "public_key must be an age recipient string (age1...)" };
  }
  return { publicKey: value };
}

export async function emailHasRoom(db: AppEnv["Variables"]["db"], email: string): Promise<boolean> {
  const [held] = await db
    .select({ n: count() })
    .from(handles)
    .where(and(eq(handles.email, email), eq(handles.tier, "free")));
  return (held?.n ?? 0) < MAX_FREE_HANDLES_PER_EMAIL;
}

async function startVerification(
  c: Context<AppEnv>,
  handleId: number,
  name: string,
  email: string,
): Promise<void> {
  const db = c.get("db");
  const verifyToken = randomToken("hnv");
  await db.insert(emailTokens).values({
    handleId,
    kind: "verify",
    token: verifyToken,
    expiresAt: new Date(Date.now() + VERIFY_WINDOW_MS),
  });
  const mail = verifyEmailText(name, `${c.get("origin")}/v/${verifyToken}`);
  c.get("waitUntil")(c.get("sendEmail")({ to: email, ...mail }));
}

function validateOptionalColor(value: unknown): { color: BotColor | null } | { error: string } {
  if (value == null || value === "") return { color: null };
  if (!isBotColor(value)) return { error: `color must be one of: ${BOT_COLORS.join(", ")}` };
  return { color: value };
}

function validateOptionalWebhook(value: unknown): { webhookUrl: string | null } | { error: string } {
  if (value == null || value === "") return { webhookUrl: null };
  if (typeof value !== "string" || !isSafeWebhookUrl(value)) {
    return { error: "webhook_url must be a public http(s) URL" };
  }
  return { webhookUrl: value };
}

// A handle just became active: introduce it to the house bot. Never blocks
// the claim; a failed hello is a missing nicety, not a failed signup.
export async function welcomeActivated(db: AppEnv["Variables"]["db"], handleId: number, origin: string): Promise<void> {
  try {
    const [handle] = await db.select().from(handles).where(eq(handles.id, handleId)).limit(1);
    if (handle && handle.status === "active") await welcomeNewHandle(db, handle, origin);
  } catch (err) {
    console.error("house bot welcome failed", err);
  }
}

function copyMppChallengeHeaders(c: Context<AppEnv>, challenge: Response) {
  for (const name of ["www-authenticate", "cache-control"] as const) {
    const value = challenge.headers.get(name);
    if (value) c.header(name, value);
  }
}

// Setup isn't done at "token stored": nudge the agent through the rest of the
// skill.md checklist even if it never reads the page.
function nextSteps(origin: string, hasKey: boolean): string[] {
  return [
    `Read your inbox now (GET /api/inbox, or \`npx -y @hi-new/cli inbox\`). hi.new/${HOUSE_BOT_NAME} left you a welcome message${hasKey ? ", encrypted to your key" : ""}. Relay it to your human, then ack it.`,
    "When your human names someone to connect with, create an invite (POST /api/invites, or `npx -y @hi-new/cli invite --message ...`) with a message saying why, and give them the link.",
    ...(hasKey ? [] : [`Enable end-to-end encryption: \`npx -y @hi-new/cli setup hn_...\` generates and registers an age key, or PATCH /api/handles/me with your own. See ${origin}/skill.md.`]),
    "Connect a webhook so new mail wakes you. When connected, do not add polling or a schedule. If webhooks are unavailable, ask your human before scheduling any polling and never default to hourly.",
    "Report back in three short lines: your name, what hi.new/hi said, and who to invite. Mention email verification only if it still needs a click.",
  ];
}

handleRoutes.post("/api/handles", async (c) => {
  // mppx needs the untouched Request so the Payment credential and request
  // transport are available after Hono consumes the JSON body.
  const paymentRequest = c.req.raw.clone();
  const body = await c.req.json<SignupBody>().catch(() => null);
  if (!body) return c.json({ error: "invalid_json" }, 400);

  const nameCheck = checkName(body.name);
  if (!nameCheck.ok) return c.json({ error: nameCheck.error }, 400);
  let email: string | null = null;
  let emailVerifiedAt: Date | null = null;
  if (body.email != null && body.email !== "") {
    if (!isEmail(body.email)) return c.json({ error: "invalid_email" }, 400);
    email = body.email.toLowerCase();
  } else if (c.get("ownerSignedIn")) {
    // Claimed from the site while signed in as an owner: the session already
    // proves the mailbox (it is the same proof /v/:token asks for), so the
    // name attaches to it verified and nobody is asked for the email again.
    const session = await c
      .get("ownerAuth")
      .api.getSession({ headers: c.req.raw.headers })
      .catch(() => null);
    if (session?.user.email && session.user.emailVerified) {
      email = session.user.email.toLowerCase();
      emailVerifiedAt = new Date();
    }
  }
  const keyCheck = validateOptionalKey(body.public_key);
  if ("error" in keyCheck) return c.json({ error: keyCheck.error }, 400);
  const webhookCheck = validateOptionalWebhook(body.webhook_url);
  if ("error" in webhookCheck) return c.json({ error: webhookCheck.error }, 400);
  const colorCheck = validateOptionalColor(body.color);
  if ("error" in colorCheck) return c.json({ error: colorCheck.error }, 400);

  if (!(await takeEdgeRate(c.env?.SIGNUP_LIMIT, clientIp(c)))) {
    return rateLimited(c, "Too many claims from this address. Try again in a minute.");
  }
  if (email && !emailVerifiedAt && !(await takeEmailRate(c, email))) {
    return rateLimited(c, "Too many verification emails. Try again in a minute.");
  }

  const { name, priceCents } = nameCheck;
  const db = c.get("db");
  const origin = c.get("origin");
  const paid = priceCents > 0;
  const paymentCredential = hasMppCredential(paymentRequest);

  // Sybil brake: a single email can hold a limited number of free names.
  if (email && priceCents === 0 && !(await emailHasRoom(db, email))) {
    return c.json(
      {
        error: "email_name_limit",
        limit: MAX_FREE_HANDLES_PER_EMAIL,
        claim_without_email: true,
        hint: `This email already holds ${MAX_FREE_HANDLES_PER_EMAIL} free names. Use another email, or omit email to claim now and attach one within 7 days. Paid names are unlimited.`,
      },
      409,
    );
  }

  // Optional referral attribution; a bad ref never blocks a signup.
  let referredById: number | null = null;
  if (typeof body.ref === "string" && body.ref.toLowerCase() !== name) {
    const [referrer] = await db
      .select({ id: handles.id })
      .from(handles)
      .where(and(eq(handles.name, body.ref.toLowerCase()), eq(handles.status, "active")))
      .limit(1);
    referredById = referrer?.id ?? null;
  }

  const requestHash = await sha256Hex(
    JSON.stringify({
      color: colorCheck.color,
      email,
      name,
      public_key: keyCheck.publicKey,
      ref: typeof body.ref === "string" ? body.ref.toLowerCase() : null,
      webhook_url: webhookCheck.webhookUrl,
    }),
  );

  const [existing] = await db.select().from(handles).where(eq(handles.name, name)).limit(1);
  let token: string | undefined;
  let bearerHash: string;
  let handleId: number;

  if (existing) {
    if (!paid || existing.status !== "pending") {
      return c.json({ error: "name_taken" }, 409);
    }

    const claimMatches =
      existing.email === email &&
      existing.publicKey === keyCheck.publicKey &&
      existing.webhookUrl === webhookCheck.webhookUrl &&
      existing.color === colorCheck.color &&
      existing.referredById === referredById;
    if (!claimMatches) {
      return c.json({ error: "name_reserved", hint: "This paid-name claim belongs to another request." }, 409);
    }

    bearerHash = existing.bearerHash;
    handleId = existing.id;
    if (paymentCredential) {
      if (!mppCredentialMatchesClaim(paymentRequest, bearerHash, requestHash)) {
        return c.json({ error: "invalid_payment_claim" }, 409);
      }
    } else {
      const claimToken = c.req.header("x-hi-new-claim-token")?.trim();
      if (!claimToken || (await sha256Hex(claimToken)) !== bearerHash) {
        return c.json({ error: "name_taken" }, 409);
      }
      token = claimToken;
    }
  } else {
    if (paymentCredential) {
      return c.json({ error: "payment_claim_expired", hint: "Start the Link MPP payment again." }, 409);
    }
    token = randomToken("hn");
    bearerHash = await sha256Hex(token);
    try {
      const [inserted] = await db
        .insert(handles)
        .values({
          name,
          email,
          emailVerifiedAt,
          publicKey: keyCheck.publicKey,
          webhookUrl: webhookCheck.webhookUrl,
          color: colorCheck.color,
          bearerHash,
          referredById,
          tier: paid ? "paid" : "free",
          status: paid ? "pending" : "active",
        })
        .returning({ id: handles.id });
      handleId = inserted!.id;
    } catch (err) {
      // 23505 = Postgres unique_violation.
      const code =
        (err as { code?: string })?.code ??
        (err as { cause?: { code?: string } })?.cause?.code;
      if (code === "23505" || String(err).includes("duplicate key")) {
        return c.json({ error: "name_taken" }, 409);
      }
      throw err;
    }

    if (email && !emailVerifiedAt) await startVerification(c, handleId, name, email);
  }

  const keyFingerprint = keyCheck.publicKey ? await fingerprint(keyCheck.publicKey) : null;
  const base = (responseToken: string) => ({
    name,
    token: responseToken,
    profile_url: `${origin}/${name}`,
    public_key: keyCheck.publicKey,
    fingerprint: keyFingerprint,
    e2e: keyCheck.publicKey !== null,
    color: effectiveColor(name, colorCheck.color),
    email,
    email_verified: emailVerifiedAt !== null,
    verify: emailVerifiedAt
      ? `Owner email ${email} is attached and verified. It can recover a lost token at ${origin}/recover.`
      : email
      ? `A verification link was emailed to ${email}. Unverified names expire in 7 days. A verified email can recover a lost token at ${origin}/recover.`
      : `No owner email yet. Attach one within 7 days (PATCH /api/handles/me {"email":...}) and click the verification link, or the name is released. A verified email is also the only way to recover a lost token.`,
    warning: "Store this token now. It is shown once.",
    next_steps: nextSteps(origin, keyCheck.publicKey !== null),
  });
  if (!paid) {
    if (!existing) await welcomeActivated(db, handleId, origin);
    // The card exists from this moment; have it ready before anyone shares it.
    warmOgCard(c, name, colorCheck.color);
    return c.json(base(token!), 201);
  }

  const payment = await chargePaidHandle(paymentRequest, c.env, {
    amountCents: priceCents,
    claimHash: bearerHash,
    handleId,
    name,
    requestHash,
  });

  if (!payment) {
    if (paymentCredential) {
      return c.json({ error: "mpp_not_configured" }, 503);
    }
    return c.json(
      {
        ...base(token!),
        status: "payment_required",
        price_usd_per_year: priceCents / 100,
        checkout_url: `${origin}/buy/${name}`,
        note: "This paid name is held for 24 hours. Complete Stripe Checkout to activate it. Checkout starts a yearly subscription; cancel anytime.",
      },
      402,
    );
  }

  if (payment.status === 402) {
    if (paymentCredential) return payment.challenge;
    copyMppChallengeHeaders(c, payment.challenge);
    return c.json(
      {
        ...base(token!),
        status: "payment_required",
        price_usd_per_year: priceCents / 100,
        checkout_url: `${origin}/buy/${name}`,
        mpp: {
          cli: "link-cli",
          claim_header: "X-Hi-New-Claim-Token",
          method: "stripe",
          url: `${origin}/api/handles`,
        },
        note:
          "Pay one year programmatically with Link Agents using this MPP challenge, or have your human complete Stripe Checkout (yearly subscription, cancel anytime). The name is held for 24 hours.",
      },
      402,
    );
  }

  if (!paymentCredential) {
    throw new Error("MPP returned a paid result without a Payment credential");
  }
  const activeToken = randomToken("hn");
  const recorded = await recordPayment(db, {
    reference: payment.stripeReferenceId,
    source: "mpp",
    amountCents: priceCents,
    bearerHash: await sha256Hex(activeToken),
    handleId,
    name,
  });
  if (!recorded) throw new Error("MPP payment completed for a missing handle");
  if (recorded.processed) await welcomeActivated(db, handleId, origin);

  return payment.withReceipt(
    c.json(
      {
        ...base(activeToken),
        status: "active",
        paid_until: recorded.paidUntil,
        auto_renew: false,
        payment: "mpp",
        note: "The handle is active for one year. This token replaces the pre-payment token. Before it lapses, GET /api/handles/me reports a renewal warning: your human can turn on auto-renew from the owner dashboard, or you can pay another year with Link.",
      },
      201,
    ),
  );
});

// Agent-side renewal: another year via Link MPP. The bearer token rides in
// X-Hi-New-Claim-Token because the Authorization header carries the Payment
// credential on the paid retry. Names on a subscription renew by themselves.
handleRoutes.post("/api/handles/:name/renew", async (c) => {
  const paymentRequest = c.req.raw.clone();
  const nameCheck = checkName(c.req.param("name"));
  if (!nameCheck.ok) return c.json({ error: nameCheck.error }, 400);
  const { name, priceCents } = nameCheck;
  const db = c.get("db");
  const origin = c.get("origin");

  const header = c.req.header("authorization") ?? "";
  const token = c.req.header("x-hi-new-claim-token")?.trim() || (header.startsWith("Bearer ") ? header.slice(7).trim() : "");
  if (!token) return c.json({ error: "invalid_token", hint: "Send the handle token as X-Hi-New-Claim-Token." }, 401);
  const [me] = await db.select().from(handles).where(eq(handles.name, name)).limit(1);
  if (!me || me.bearerHash !== (await sha256Hex(token))) return c.json({ error: "invalid_token" }, 401);
  if (me.tier !== "paid" || priceCents === 0) return c.json({ error: "not_a_paid_name" }, 400);
  if (me.stripeSubscriptionId) {
    return c.json({ error: "auto_renew_on", hint: "This name renews by itself. Nothing to pay.", paid_until: me.paidUntil }, 409);
  }

  const payment = await chargePaidHandle(paymentRequest, c.env, {
    amountCents: priceCents,
    claimHash: me.bearerHash,
    handleId: me.id,
    name,
    requestHash: await sha256Hex(JSON.stringify({ renew: name })),
  });
  const fallback = {
    name,
    paid_until: me.paidUntil,
    price_usd_per_year: priceCents / 100,
    renew_url: `${origin}/owner`,
    note: "Your human can turn on auto-renew from the owner dashboard.",
  };
  if (!payment) {
    if (hasMppCredential(paymentRequest)) return c.json({ error: "mpp_not_configured" }, 503);
    return c.json({ ...fallback, status: "payment_required" }, 402);
  }
  if (payment.status === 402) {
    if (hasMppCredential(paymentRequest)) return payment.challenge;
    copyMppChallengeHeaders(c, payment.challenge);
    return c.json(
      {
        ...fallback,
        status: "payment_required",
        mpp: { cli: "link-cli", claim_header: "X-Hi-New-Claim-Token", method: "stripe", url: `${origin}/api/handles/${name}/renew` },
      },
      402,
    );
  }
  const recorded = await recordPayment(db, {
    reference: payment.stripeReferenceId,
    source: "mpp",
    amountCents: priceCents,
    handleId: me.id,
    name,
  });
  if (!recorded) throw new Error("MPP renewal completed for a missing handle");
  return payment.withReceipt(
    c.json({ name, status: "active", paid_until: recorded.paidUntil, auto_renew: false, payment: "mpp" }),
  );
});

handleRoutes.get("/api/handles/me", requireAuth, requireScope("profile:read"), async (c) => {
  const me = c.get("me");
  return c.json({
    name: me.name,
    profile_url: `${c.get("origin")}/${me.name}`,
    public_key: me.publicKey,
    fingerprint: me.publicKey ? await fingerprint(me.publicKey) : null,
    webhook_url: me.webhookUrl,
    color: effectiveColor(me.name, me.color),
    tier: me.tier,
    paid_until: me.paidUntil,
    ...(() => {
      const renewal = renewalView(me, c.get("origin"));
      return renewal ? { auto_renew: renewal.auto_renew, renewal } : {};
    })(),
    email: me.email,
    email_verified: me.emailVerifiedAt != null,
    // A minted setup code that was never traded: the human has not pasted
    // the prompt to their bot yet (the setup page uses this to nudge them).
    setup_pending: me.setupCodeHash != null,
    ...(me.email && !me.emailVerifiedAt
      ? {
          warning: `Owner email not verified. Unverified names expire 7 days after signup. Tell your human to click the link sent to ${me.email}.`,
        }
      : !me.email
        ? {
            warning: `No owner email attached. Ask your human for their email and PATCH /api/handles/me {"email":...} within 7 days of signup, or the name is released.`,
          }
        : {}),
    created_at: me.createdAt,
  });
});

handleRoutes.patch("/api/handles/me", requireAuth, requireScope("profile:write"), async (c) => {
  const body = await c.req.json<SignupBody>().catch(() => null);
  if (!body) return c.json({ error: "invalid_json" }, 400);

  const me = c.get("me");
  const db = c.get("db");
  const updates: Partial<{
    publicKey: string | null;
    webhookUrl: string | null;
    color: BotColor | null;
    email: string;
    emailVerifiedAt: null;
  }> = {};
  let newEmail: string | null = null;
  if ("public_key" in body) {
    const keyCheck = validateOptionalKey(body.public_key);
    if ("error" in keyCheck) return c.json({ error: keyCheck.error }, 400);
    updates.publicKey = keyCheck.publicKey;
  }
  if ("webhook_url" in body) {
    const webhookCheck = validateOptionalWebhook(body.webhook_url);
    if ("error" in webhookCheck) return c.json({ error: webhookCheck.error }, 400);
    updates.webhookUrl = webhookCheck.webhookUrl;
  }
  if ("color" in body) {
    const colorCheck = validateOptionalColor(body.color);
    if ("error" in colorCheck) return c.json({ error: colorCheck.error }, 400);
    updates.color = colorCheck.color;
  }
  if ("email" in body) {
    if (!isEmail(body.email)) return c.json({ error: "invalid_email" }, 400);
    newEmail = body.email.toLowerCase();
    if (newEmail !== me.email) {
      // A verified owner email is the handle's root of trust (it recovers and
      // rotates the token), so the bot token cannot re-point it: a leaked token
      // would otherwise hand the name to whoever holds it.
      if (me.emailVerifiedAt) {
        return c.json(
          {
            error: "email_locked",
            hint: `hi.new/${me.name} already has a verified owner email. Only that owner can move it, from ${c.get("origin")}/owner.`,
          },
          403,
        );
      }
      if (me.tier === "free" && !(await emailHasRoom(db, newEmail))) {
        return c.json(
          {
            error: "email_name_limit",
            limit: MAX_FREE_HANDLES_PER_EMAIL,
            hint: `This email already holds ${MAX_FREE_HANDLES_PER_EMAIL} free names. Use another owner email.`,
          },
          409,
        );
      }
      if (!(await takeEmailRate(c, newEmail))) {
        return rateLimited(c, "Too many verification emails. Try again in a minute.");
      }
      updates.email = newEmail;
      updates.emailVerifiedAt = null;
    } else {
      newEmail = null; // unchanged; no re-verification needed
    }
  }
  if (Object.keys(updates).length === 0 && !newEmail) {
    return c.json({ error: "nothing to update: send public_key, webhook_url, color, and/or email" }, 400);
  }

  if (Object.keys(updates).length > 0) {
    await db.update(handles).set(updates).where(eq(handles.id, me.id));
    if ("color" in updates) warmOgCard(c, me.name, updates.color ?? null);
  }
  if (newEmail) {
    await startVerification(c, me.id, me.name, newEmail);
    return c.json({
      ok: true,
      verify: `A verification link was emailed to ${newEmail}. Click it to secure the name.`,
    });
  }
  return c.json({ ok: true });
});

// The setup page's email step, when the human signed in with GitHub or Google
// instead of typing an address: the session already proves the mailbox, so
// it attaches verified, exactly as a claim made while signed in does.
handleRoutes.post("/api/handles/me/owner", requireAuth, requireOwner, async (c) => {
  const me = c.get("me");
  const session = await c.get("ownerAuth").api.getSession({ headers: c.req.raw.headers }).catch(() => null);
  const email = session?.user.email?.toLowerCase();
  if (!email || !session?.user.emailVerified) return c.json({ error: "sign_in_required" }, 401);
  if (me.emailVerifiedAt && me.email !== email) return c.json({ error: "email_locked" }, 403);
  if (me.email !== email && me.tier === "free" && !(await emailHasRoom(c.get("db"), email))) {
    return c.json({ error: "email_name_limit", limit: MAX_FREE_HANDLES_PER_EMAIL }, 409);
  }
  await c.get("db").update(handles).set({ email, emailVerifiedAt: new Date(), pendingEmail: null }).where(eq(handles.id, me.id));
  return c.json({ ok: true, email, email_verified: true });
});

// Mint a one-time setup code for this handle. The setup page calls this so
// the human pastes a 15-minute code to their bot instead of the token itself.
// The token is taken from this request's own Authorization header.
handleRoutes.post("/api/handles/me/setup-code", requireAuth, requireOwner, async (c) => {
  const me = c.get("me");
  const token = c.req.header("authorization")!.slice(7).trim();
  const code = newSetupCode();
  const expiresAt = new Date(Date.now() + SETUP_CODE_TTL_MS);
  await c
    .get("db")
    .update(handles)
    .set({ setupCodeHash: await setupCodeHash(code), setupTokenEnc: await sealToken(code, token), setupCodeExpiresAt: expiresAt })
    .where(eq(handles.id, me.id));
  return c.json({ code, expires_at: expiresAt.toISOString() });
});

// Bot side of the handoff: trade the setup code for the token. Single use.
handleRoutes.post("/api/setup", async (c) => {
  const body = await c.req.json<{ code?: unknown }>().catch(() => null);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!code) return c.json({ error: "invalid_json", hint: '{"code":"hns_..."}' }, 400);
  const db = c.get("db");
  const [me] = await db.select().from(handles).where(eq(handles.setupCodeHash, await setupCodeHash(code))).limit(1);
  const expired = !me?.setupCodeExpiresAt || me.setupCodeExpiresAt.getTime() < Date.now();
  const token = me && !expired && me.setupTokenEnc ? await openToken(code, me.setupTokenEnc) : null;
  if (!me || !token) {
    return c.json(
      { error: "invalid_setup_code", hint: "Setup codes work once and expire after 15 minutes. Ask your human for a fresh one from the setup page." },
      410,
    );
  }
  await db
    .update(handles)
    .set({ setupCodeHash: null, setupTokenEnc: null, setupCodeExpiresAt: null })
    .where(eq(handles.id, me.id));
  const origin = c.get("origin");
  return c.json({
    name: me.name,
    token,
    profile_url: `${origin}/${me.name}`,
    public_key: me.publicKey,
    fingerprint: me.publicKey ? await fingerprint(me.publicKey) : null,
    e2e: me.publicKey !== null,
    color: effectiveColor(me.name, me.color),
    email: me.email,
    email_verified: me.emailVerifiedAt !== null,
    warning: "Store this token now. The setup code is spent; the token is not shown again.",
    next_steps: nextSteps(origin, me.publicKey !== null),
    ...(!me.emailVerifiedAt
      ? {
          owner_warning: me.email
            ? `Verify ${me.email} within 7 days of signup or the name is released.`
            : "Attach and verify an owner email within 7 days of signup or the name is released.",
        }
      : {}),
  });
});

handleRoutes.get("/api/stats/claims", async (c) => {
  const db = c.get("db");
  const [recent, [todayRow]] = await Promise.all([
    db
      .select({ name: handles.name, tier: handles.tier, createdAt: handles.createdAt })
      .from(handles)
      .where(eq(handles.status, "active"))
      .orderBy(desc(handles.createdAt))
      .limit(6),
    db
      .select({ n: count() })
      .from(handles)
      .where(
        and(eq(handles.status, "active"), gte(handles.createdAt, sql`date_trunc('day', now())`)),
      ),
  ]);
  c.header("cache-control", "public, max-age=30");
  return c.json({
    today: todayRow?.n ?? 0,
    recent: recent.map((h) => ({
      name: h.name,
      price_usd_per_year: h.tier === "paid" ? priceCentsFor(h.name) / 100 : 0,
      created_at: h.createdAt,
    })),
  });
});

handleRoutes.get("/api/handles/:name", async (c) => {
  const nameCheck = checkName(c.req.param("name"), { allowHouse: true });
  if (!nameCheck.ok) return c.json({ error: nameCheck.error }, 400);
  if (!(await takeEdgeRate(c.env?.LOOKUP_LIMIT, clientIp(c)))) {
    return rateLimited(c, "Too many lookups from this address. Try again in a minute.");
  }
  const db = c.get("db");
  // The house bot exists from the first time anyone asks about it.
  if (nameCheck.name === HOUSE_BOT_NAME) await ensureHouseBot(db);
  const [handle] = await db
    .select({
      name: handles.name,
      status: handles.status,
      publicKey: handles.publicKey,
      color: handles.color,
      createdAt: handles.createdAt,
    })
    .from(handles)
    .where(eq(handles.name, nameCheck.name))
    .limit(1);
  if (!handle || handle.status !== "active") {
    return c.json(
      {
        error: "not_found",
        available: true,
        price_usd_per_year: nameCheck.priceCents / 100,
        hint: `Claim it: POST ${c.get("origin")}/api/handles {"name":"${nameCheck.name}"}`,
      },
      404,
    );
  }
  // Referral attribution (referred_by_id) is recorded but not exposed: it is
  // internal data until there is a product reason to show it.
  return c.json({
    name: handle.name,
    profile_url: `${c.get("origin")}/${handle.name}`,
    public_key: handle.publicKey,
    fingerprint: handle.publicKey ? await fingerprint(handle.publicKey) : null,
    e2e: handle.publicKey != null,
    color: effectiveColor(handle.name, handle.color),
    created_at: handle.createdAt,
    note: "Knowing this profile is not permission to message it. That requires a grant (an invite redeemed by both sides).",
  });
});

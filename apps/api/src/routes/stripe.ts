import { eq } from "drizzle-orm";
import { Hono } from "hono";
import Stripe from "stripe";
import type { AppEnv } from "../context";
import { handles } from "../db/schema";
import { applyStripeEvent, createSubscriptionCheckout, stripeClient } from "../lib/billing";
import { checkName } from "@hi-new/domain";
import { recordPayment } from "../lib/payments";
import { welcomeActivated } from "./handles";

export const stripeRoutes = new Hono<AppEnv>();

// Starts the yearly subscription for a pending short-name claim. Browsers
// hitting it from a <form> get a 303 to Stripe; the landing's claim flow
// fetches it with Accept: application/json and navigates to the returned URL
// itself, so a misconfiguration surfaces inline instead of as a JSON page.
stripeRoutes.post("/buy/:name/checkout", async (c) => {
  const key = c.env.STRIPE_SECRET_KEY;
  if (!key) return c.json({ error: "payments_not_configured" }, 503);

  const nameCheck = checkName(c.req.param("name"));
  if (!nameCheck.ok) return c.json({ error: nameCheck.error }, 400);
  const { name, priceCents } = nameCheck;
  if (priceCents === 0) return c.json({ error: "this name is free, no checkout needed" }, 400);

  const db = c.get("db");
  const [handle] = await db.select().from(handles).where(eq(handles.name, name)).limit(1);
  if (!handle) {
    return c.json(
      { error: "no_pending_claim", hint: `Have your bot claim the name first with POST /api/handles {"name":"${name}"}. Then pay here.` },
      409,
    );
  }
  if (handle.status === "active") {
    return c.json({ error: "name_taken", hint: `hi.new/${name} is already active.` }, 409);
  }

  const origin = c.get("origin");
  const url = await createSubscriptionCheckout(stripeClient(key), {
    handle,
    priceCents,
    // Back to the setup page, which shows the token if this tab did the
    // claim and a plain "it's live" otherwise (bot-initiated claims).
    successUrl: `${origin}/${name}/setup?paid=1`,
    cancelUrl: `${origin}/buy/${name}`,
  });
  if (c.req.header("accept")?.includes("application/json")) return c.json({ url });
  return c.redirect(url, 303);
});

stripeRoutes.post("/api/stripe/webhook", async (c) => {
  const key = c.env.STRIPE_SECRET_KEY;
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!key || !secret) return c.json({ error: "payments_not_configured" }, 503);

  const signature = c.req.header("stripe-signature");
  if (!signature) return c.json({ error: "missing_signature" }, 400);

  let event: Stripe.Event;
  try {
    event = await stripeClient(key).webhooks.constructEventAsync(
      await c.req.text(),
      signature,
      secret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    return c.json({ error: "bad_signature" }, 400);
  }

  const db = c.get("db");
  // Agent (MPP) charges confirm out of band as well; the ledger dedupes.
  if (event.type === "payment_intent.succeeded") {
    const intent = event.data.object;
    const name = intent.metadata?.hi_new_name;
    const handleId = Number(intent.metadata?.hi_new_handle_id);
    if (
      intent.metadata?.hi_new_payment_type === "paid_handle_mpp" &&
      name &&
      Number.isSafeInteger(handleId) &&
      handleId > 0
    ) {
      const recorded = await recordPayment(db, {
        reference: intent.id,
        source: "mpp",
        amountCents: intent.amount_received,
        handleId,
        name,
      });
      if (recorded?.processed) await welcomeActivated(db, handleId, c.get("origin"));
    }
    return c.json({ received: true });
  }

  const applied = await applyStripeEvent(db, event);
  // A first invoice is a paid name coming to life: introduce it to the house
  // bot. Renewals reach this too and are no-ops there (the grant exists).
  if (applied.kind === "invoice" && applied.result?.processed) {
    const [handle] = await db.select({ id: handles.id }).from(handles).where(eq(handles.name, applied.name)).limit(1);
    if (handle) await welcomeActivated(db, handle.id, c.get("origin"));
  }
  return c.json({ received: true });
});

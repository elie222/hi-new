// Stripe subscriptions for paid names. One yearly subscription per name;
// every paid invoice moves the handle's paid_until to the invoice period end.
// MPP (agent) payments are one-off and live in ./mpp.ts; both write the same
// ledger through recordPayment.
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import type { Db } from "../db/client";
import { handles, type Handle } from "../db/schema";
import { recordPayment, type RecordedPayment } from "./payments";

export function stripeClient(key: string): Stripe {
  return new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
}

// Checkout needs the trial end at least two days out; closer than that the
// subscription just starts now and paid_until keeps whichever date is later.
const MIN_TRIAL_LEAD_MS = 2 * 24 * 3600 * 1000;

type SubscriptionCheckout = {
  handle: Pick<Handle, "id" | "name" | "email" | "stripeCustomerId" | "paidUntil">;
  priceCents: number;
  successUrl: string;
  cancelUrl: string;
  // Start billing when the current paid period ends (names already paid via MPP).
  startAtPaidUntil?: boolean;
};

export async function createSubscriptionCheckout(
  stripe: Stripe,
  opts: SubscriptionCheckout,
): Promise<string> {
  const { handle, priceCents } = opts;
  const trialEnd =
    opts.startAtPaidUntil && handle.paidUntil && handle.paidUntil.getTime() - Date.now() > MIN_TRIAL_LEAD_MS
      ? Math.floor(handle.paidUntil.getTime() / 1000)
      : undefined;
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: priceCents,
          recurring: { interval: "year" },
          product_data: {
            name: `hi.new/${handle.name}`,
            description: `${handle.name.length}-letter hi.new handle, billed yearly`,
          },
        },
        quantity: 1,
      },
    ],
    // Promoters get a 100% code; with nothing due Stripe skips the card form.
    allow_promotion_codes: true,
    payment_method_collection: trialEnd ? "always" : "if_required",
    ...(handle.stripeCustomerId
      ? { customer: handle.stripeCustomerId }
      : handle.email
        ? { customer_email: handle.email }
        : {}),
    client_reference_id: String(handle.id),
    metadata: { hi_new_name: handle.name, hi_new_handle_id: String(handle.id) },
    subscription_data: {
      metadata: { hi_new_name: handle.name, hi_new_handle_id: String(handle.id) },
      ...(trialEnd ? { trial_end: trialEnd } : {}),
    },
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
  });
  if (!session.url) throw new Error("Stripe Checkout returned no URL");
  return session.url;
}

export async function createBillingPortal(
  stripe: Stripe,
  customerId: string,
  returnUrl: string,
): Promise<string> {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return session.url;
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

// The period this invoice pays for ends at the latest line period end.
export function invoicePeriodEnd(invoice: Stripe.Invoice): Date {
  const ends = invoice.lines?.data?.map((line) => line.period?.end ?? 0) ?? [];
  const end = Math.max(invoice.period_end ?? 0, ...ends);
  return new Date(end * 1000);
}

function invoiceSubscription(invoice: Stripe.Invoice): { id: string | null; metadata: Stripe.Metadata | null } {
  const details = invoice.parent?.subscription_details;
  return { id: idOf(details?.subscription), metadata: details?.metadata ?? null };
}

async function findHandle(
  db: Db,
  hint: { handleId?: string | null; name?: string | null; subscriptionId?: string | null },
) {
  const id = Number(hint.handleId);
  if (Number.isSafeInteger(id) && id > 0) {
    const [row] = await db.select().from(handles).where(eq(handles.id, id)).limit(1);
    if (row && (!hint.name || row.name === hint.name)) return row;
  }
  if (hint.subscriptionId) {
    const [row] = await db
      .select()
      .from(handles)
      .where(eq(handles.stripeSubscriptionId, hint.subscriptionId))
      .limit(1);
    if (row) return row;
  }
  if (hint.name) {
    const [row] = await db.select().from(handles).where(eq(handles.name, hint.name)).limit(1);
    return row ?? null;
  }
  return null;
}

export type AppliedEvent =
  | { kind: "invoice"; name: string; result: RecordedPayment | null }
  | { kind: "subscription_ended"; name: string }
  | { kind: "ignored" };

// Idempotent: Stripe retries, and the ledger dedupes on the invoice id.
export async function applyStripeEvent(db: Db, event: Stripe.Event): Promise<AppliedEvent> {
  if (event.type === "invoice.paid") {
    const invoice = event.data.object;
    if (!invoice.id) return { kind: "ignored" };
    const sub = invoiceSubscription(invoice);
    const handle = await findHandle(db, {
      handleId: sub.metadata?.hi_new_handle_id,
      name: sub.metadata?.hi_new_name,
      subscriptionId: sub.id,
    });
    if (!handle) return { kind: "ignored" };
    const result = await recordPayment(db, {
      reference: invoice.id,
      source: "invoice",
      handleId: handle.id,
      name: handle.name,
      amountCents: invoice.amount_paid ?? 0,
      paidUntil: invoicePeriodEnd(invoice),
      stripeCustomerId: idOf(invoice.customer),
      stripeSubscriptionId: sub.id,
    });
    return { kind: "invoice", name: handle.name, result };
  }

  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    const handle = await findHandle(db, {
      handleId: subscription.metadata?.hi_new_handle_id,
      name: subscription.metadata?.hi_new_name,
      subscriptionId: subscription.id,
    });
    if (!handle || handle.stripeSubscriptionId !== subscription.id) return { kind: "ignored" };
    // paid_until stays; the name lapses through the grace period on its own.
    await db.update(handles).set({ stripeSubscriptionId: null }).where(eq(handles.id, handle.id));
    return { kind: "subscription_ended", name: handle.name };
  }

  return { kind: "ignored" };
}

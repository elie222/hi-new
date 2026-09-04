import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Challenge, Credential } from "mppx";
import Stripe from "stripe";
import { handles, payments } from "../src/db/schema";
import { applyStripeEvent, createSubscriptionCheckout, invoicePeriodEnd, stripeClient } from "../src/lib/billing";
import { recordPayment, YEAR_MS } from "../src/lib/payments";
import { dailySweep, renewalNotices } from "../src/sweeps";
import { call, makeTestApp, type TestApp } from "./helpers";

const DAY = 24 * 3600 * 1000;
const stripeEnv = { STRIPE_SECRET_KEY: "sk_test_billing", STRIPE_WEBHOOK_SECRET: "whsec_test_billing" };
const mppEnv = {
  MPP_SECRET_KEY: "test-secret-key-test-secret-key-32",
  STRIPE_NETWORK_ID: "internal",
  STRIPE_SECRET_KEY: "sk_test_mpp",
};

async function claimPaid(app: TestApp, name: string) {
  const res = await call(app, "POST", "/api/handles", { body: { name, email: `${name}@owners.example` } });
  expect(res.status).toBe(402);
  return res.json as { token: string; name: string };
}

function invoicePaidEvent(opts: {
  invoiceId: string;
  handleId: number;
  name: string;
  amountPaid: number;
  periodEnd: number;
  subscription?: string;
  customer?: string;
}): Stripe.Event {
  const object = {
    id: opts.invoiceId,
    object: "invoice",
    amount_paid: opts.amountPaid,
    customer: opts.customer ?? "cus_test",
    period_end: opts.periodEnd - 10,
    lines: { object: "list", data: [{ period: { start: opts.periodEnd - 365 * 86400, end: opts.periodEnd } }] },
    parent: {
      type: "subscription_details",
      subscription_details: {
        subscription: opts.subscription ?? "sub_test",
        metadata: { hi_new_handle_id: String(opts.handleId), hi_new_name: opts.name },
      },
    },
  };
  return { id: `evt_${opts.invoiceId}`, type: "invoice.paid", data: { object } } as unknown as Stripe.Event;
}

function subscriptionDeletedEvent(subscription: string, handleId: number, name: string): Stripe.Event {
  return {
    id: `evt_del_${subscription}`,
    type: "customer.subscription.deleted",
    data: { object: { id: subscription, object: "subscription", metadata: { hi_new_handle_id: String(handleId), hi_new_name: name } } },
  } as unknown as Stripe.Event;
}

async function postWebhook(app: TestApp, event: Stripe.Event) {
  const payload = JSON.stringify(event);
  const signature = await new Stripe("sk_test_billing").webhooks.generateTestHeaderStringAsync({
    payload,
    secret: stripeEnv.STRIPE_WEBHOOK_SECRET,
    cryptoProvider: Stripe.createSubtleCryptoProvider(),
  });
  return app.request(
    "http://hi.test/api/stripe/webhook",
    { method: "POST", headers: { "stripe-signature": signature, "content-type": "application/json" }, body: payload },
    stripeEnv,
  );
}

describe("subscriptions", () => {
  test("a $0 invoice (100% promo code) activates the name for the invoice period", async () => {
    const { app, db } = await makeTestApp();
    const claim = await claimPaid(app, "vlad");
    const [pending] = await db.select().from(handles).where(eq(handles.name, "vlad"));
    const periodEnd = Math.floor((Date.now() + YEAR_MS) / 1000);

    const res = await postWebhook(app, invoicePaidEvent({
      invoiceId: "in_free_year",
      handleId: pending!.id,
      name: "vlad",
      amountPaid: 0,
      periodEnd,
      subscription: "sub_vlad",
      customer: "cus_vlad",
    }));
    expect(res.status).toBe(200);

    const [active] = await db.select().from(handles).where(eq(handles.name, "vlad"));
    expect(active!.status).toBe("active");
    expect(active!.tier).toBe("paid");
    expect(active!.stripeSubscriptionId).toBe("sub_vlad");
    expect(active!.stripeCustomerId).toBe("cus_vlad");
    expect(active!.paidUntil?.getTime()).toBe(periodEnd * 1000);
    const [ledger] = await db.select().from(payments);
    expect(ledger).toMatchObject({ reference: "in_free_year", source: "invoice", amountCents: 0, status: "paid" });

    const me = await call(app, "GET", "/api/handles/me", { token: claim.token });
    expect(me.status).toBe(200);
    expect(me.json.auto_renew).toBe(true);
    expect(me.json.renewal.warning).toBeUndefined();
  });

  test("webhook rejects a bad signature and replays are idempotent", async () => {
    const { app, db } = await makeTestApp();
    await claimPaid(app, "vlad");
    const [pending] = await db.select().from(handles).where(eq(handles.name, "vlad"));
    const event = invoicePaidEvent({
      invoiceId: "in_once",
      handleId: pending!.id,
      name: "vlad",
      amountPaid: 15000,
      periodEnd: Math.floor((Date.now() + YEAR_MS) / 1000),
    });

    const forged = await app.request(
      "http://hi.test/api/stripe/webhook",
      { method: "POST", headers: { "stripe-signature": "t=1,v1=nope" }, body: JSON.stringify(event) },
      stripeEnv,
    );
    expect(forged.status).toBe(400);
    expect((await db.select().from(handles).where(eq(handles.name, "vlad")))[0]!.status).toBe("pending");

    expect((await postWebhook(app, event)).status).toBe(200);
    const [afterFirst] = await db.select().from(handles).where(eq(handles.name, "vlad"));
    expect((await postWebhook(app, event)).status).toBe(200);
    const [afterReplay] = await db.select().from(handles).where(eq(handles.name, "vlad"));
    expect(afterReplay!.paidUntil?.toISOString()).toBe(afterFirst!.paidUntil?.toISOString());
    expect(await db.select().from(payments)).toHaveLength(1);
  });

  test("a renewal invoice extends paid_until and never moves it backwards", async () => {
    const { db } = await makeTestApp();
    const [row] = await db
      .insert(handles)
      .values({ name: "mila", bearerHash: "h1", tier: "paid", status: "active", paidUntil: new Date(Date.now() + 400 * DAY) })
      .returning();
    const earlier = Math.floor((Date.now() + 100 * DAY) / 1000);
    const later = Math.floor((Date.now() + 700 * DAY) / 1000);

    await applyStripeEvent(db, invoicePaidEvent({ invoiceId: "in_early", handleId: row!.id, name: "mila", amountPaid: 15000, periodEnd: earlier }));
    expect((await db.select().from(handles).where(eq(handles.id, row!.id)))[0]!.paidUntil?.getTime()).toBe(row!.paidUntil!.getTime());

    await applyStripeEvent(db, invoicePaidEvent({ invoiceId: "in_late", handleId: row!.id, name: "mila", amountPaid: 15000, periodEnd: later }));
    expect((await db.select().from(handles).where(eq(handles.id, row!.id)))[0]!.paidUntil?.getTime()).toBe(later * 1000);
  });

  test("subscription deleted turns auto-renew off but keeps the paid period", async () => {
    const { app, db } = await makeTestApp();
    await claimPaid(app, "vlad");
    const [pending] = await db.select().from(handles).where(eq(handles.name, "vlad"));
    const periodEnd = Math.floor((Date.now() + YEAR_MS) / 1000);
    await applyStripeEvent(db, invoicePaidEvent({ invoiceId: "in_1", handleId: pending!.id, name: "vlad", amountPaid: 15000, periodEnd, subscription: "sub_vlad" }));

    expect((await applyStripeEvent(db, subscriptionDeletedEvent("sub_other", pending!.id, "vlad"))).kind).toBe("ignored");
    expect((await db.select().from(handles).where(eq(handles.name, "vlad")))[0]!.stripeSubscriptionId).toBe("sub_vlad");

    expect((await postWebhook(app, subscriptionDeletedEvent("sub_vlad", pending!.id, "vlad"))).status).toBe(200);
    const [after] = await db.select().from(handles).where(eq(handles.name, "vlad"));
    expect(after!.stripeSubscriptionId).toBeNull();
    expect(after!.status).toBe("active");
    expect(after!.paidUntil?.getTime()).toBe(periodEnd * 1000);
  });

  test("auto-renew for an MPP-paid name starts billing when the paid year ends", async () => {
    const paidUntil = new Date(Date.now() + 200 * DAY);
    const originalFetch = globalThis.fetch;
    let body = "";
    globalThis.fetch = (async (_input, init) => {
      body = String(init?.body ?? "");
      return Response.json({ id: "cs_renew", url: "https://checkout.stripe.com/c/pay/cs_renew" });
    }) as typeof fetch;
    try {
      const url = await createSubscriptionCheckout(stripeClient("sk_test_x"), {
        handle: { id: 7, name: "vlad", email: "vlad@owners.example", stripeCustomerId: null, paidUntil },
        priceCents: 15000,
        startAtPaidUntil: true,
        successUrl: "http://hi.test/owner?renew=on",
        cancelUrl: "http://hi.test/owner",
      });
      expect(url).toContain("cs_renew");
      const params = new URLSearchParams(body);
      expect(params.get("subscription_data[trial_end]")).toBe(String(Math.floor(paidUntil.getTime() / 1000)));
      expect(params.get("payment_method_collection")).toBe("always");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("invoicePeriodEnd takes the latest line period", () => {
    const invoice = {
      period_end: 100,
      lines: { data: [{ period: { start: 0, end: 500 } }, { period: { start: 0, end: 900 } }] },
    } as unknown as Stripe.Invoice;
    expect(invoicePeriodEnd(invoice).getTime()).toBe(900_000);
  });

  test("checkout is a yearly subscription with promo codes and no card when nothing is due", async () => {
    const { app } = await makeTestApp();
    await claimPaid(app, "vlad");
    const originalFetch = globalThis.fetch;
    let body = "";
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe("https://api.stripe.com/v1/checkout/sessions");
      body = String(init?.body ?? "");
      return Response.json({ id: "cs_test", url: "https://checkout.stripe.com/c/pay/cs_test" });
    }) as typeof fetch;
    try {
      const res = await app.request(
        "http://hi.test/buy/vlad/checkout",
        { method: "POST", headers: { accept: "application/json" } },
        stripeEnv,
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { url: string }).url).toContain("checkout.stripe.com");
      const params = new URLSearchParams(body);
      expect(params.get("mode")).toBe("subscription");
      expect(params.get("allow_promotion_codes")).toBe("true");
      expect(params.get("payment_method_collection")).toBe("if_required");
      expect(params.get("line_items[0][price_data][recurring][interval]")).toBe("year");
      expect(params.get("line_items[0][price_data][unit_amount]")).toBe("15000");
      expect(params.get("customer_email")).toBe("vlad@owners.example");
      expect(params.get("subscription_data][metadata][hi_new_name]") ?? params.get("subscription_data[metadata][hi_new_name]")).toBe("vlad");
      expect(params.get("success_url")).toBe("http://hi.test/vlad/setup?paid=1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("agent-paid (MPP) renewals", () => {
  async function activateViaMpp(db: Awaited<ReturnType<typeof makeTestApp>>["db"], name: string, paidUntil: Date) {
    const [row] = await db
      .insert(handles)
      .values({
        name,
        bearerHash: await sha("hn_" + name),
        email: `${name}@owners.example`,
        emailVerifiedAt: new Date(),
        tier: "paid",
        status: "active",
        paidUntil,
      })
      .returning();
    return { row: row!, token: "hn_" + name };
  }
  async function sha(value: string) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  test("/me and the inbox warn in the last 30 days; the sweep emails the owner once per stage", async () => {
    const { app, db, sent } = await makeTestApp();
    const { token } = await activateViaMpp(db, "vlad", new Date(Date.now() + 20 * DAY));

    const me = await call(app, "GET", "/api/handles/me", { token });
    expect(me.json.auto_renew).toBe(false);
    expect(me.json.renewal.days_left).toBe(20);
    expect(me.json.renewal.warning).toBeDefined();
    const inbox = await call(app, "GET", "/api/inbox", { token });
    expect(inbox.json.renewal_warning).toBeDefined();

    const notify = { sendEmail: async (msg: { to: string; subject: string; text: string }) => void sent.push(msg), origin: "http://hi.test" };
    expect(await renewalNotices(db, new Date(), notify)).toBe(1);
    expect(sent[0]!.to).toBe("vlad@owners.example");
    expect(await renewalNotices(db, new Date(Date.now() + 5 * DAY), notify)).toBe(0);
    expect(await renewalNotices(db, new Date(Date.now() + 15 * DAY), notify)).toBe(1);
    expect(sent[1]!.to).toBe("vlad@owners.example");
    expect(await renewalNotices(db, new Date(Date.now() + 16 * DAY), notify)).toBe(0);

    await recordPayment(db, { reference: "pi_renew", source: "mpp", amountCents: 15000, handleId: (await db.select().from(handles))[0]!.id, name: "vlad" });
    expect((await db.select().from(handles))[0]!.renewalNoticeStage).toBe(0);
    expect((await call(app, "GET", "/api/handles/me", { token })).json.renewal.warning).toBeUndefined();
  });

  test("subscribed names and free names get no reminders; the daily sweep sends them", async () => {
    const { app, db, sent } = await makeTestApp();
    await activateViaMpp(db, "vlad", new Date(Date.now() + 3 * DAY));
    await db.update(handles).set({ stripeSubscriptionId: "sub_x" }).where(eq(handles.name, "vlad"));
    await call(app, "POST", "/api/handles", { body: { name: "longfreename" } });
    await dailySweep(db, new Date(), { sendEmail: async (msg) => void sent.push(msg), origin: "http://hi.test" });
    expect(sent.filter((m) => m.subject.includes("expires"))).toHaveLength(0);
  });

  test("POST /api/handles/:name/renew takes a Link MPP payment for another year", async () => {
    const { app, db } = await makeTestApp();
    const paidUntil = new Date(Date.now() + 10 * DAY);
    const { token } = await activateViaMpp(db, "vlad", paidUntil);

    const noToken = await app.request("http://hi.test/api/handles/vlad/renew", { method: "POST" }, mppEnv);
    expect(noToken.status).toBe(401);

    const challenge = await app.request(
      "http://hi.test/api/handles/vlad/renew",
      { method: "POST", headers: { "x-hi-new-claim-token": token } },
      mppEnv,
    );
    expect(challenge.status).toBe(402);
    expect(challenge.headers.get("www-authenticate")).toStartWith("Payment ");
    const challengeJson = (await challenge.json()) as { mpp: { url: string }; price_usd_per_year: number };
    expect(challengeJson.price_usd_per_year).toBe(150);
    expect(challengeJson.mpp.url).toBe("http://hi.test/api/handles/vlad/renew");

    const authorization = Credential.serialize(
      Credential.from({ challenge: Challenge.fromResponse(challenge), payload: { spt: "spt_renew" } }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      expect(String(input)).toBe("https://api.stripe.com/v1/payment_intents");
      return Response.json({ id: "pi_renew_vlad", status: "succeeded" });
    }) as typeof fetch;
    try {
      const paid = await app.request(
        "http://hi.test/api/handles/vlad/renew",
        { method: "POST", headers: { authorization, "x-hi-new-claim-token": token } },
        mppEnv,
      );
      expect(paid.status).toBe(200);
      const json = (await paid.json()) as { paid_until: string; auto_renew: boolean };
      expect(json.auto_renew).toBe(false);
      expect(new Date(json.paid_until).getTime()).toBe(paidUntil.getTime() + YEAR_MS);
    } finally {
      globalThis.fetch = originalFetch;
    }

    await db.update(handles).set({ stripeSubscriptionId: "sub_vlad" }).where(eq(handles.name, "vlad"));
    const already = await app.request(
      "http://hi.test/api/handles/vlad/renew",
      { method: "POST", headers: { "x-hi-new-claim-token": token } },
      mppEnv,
    );
    expect(already.status).toBe(409);
  });
});

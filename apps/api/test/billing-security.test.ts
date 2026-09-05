import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { handles, payments } from "../src/db/schema";
import { applyStripeEvent, createSubscriptionCheckout } from "../src/lib/billing";
import { recordPayment, YEAR_MS } from "../src/lib/payments";
import { dailySweep, renewalNotices } from "../src/sweeps";
import { makeTestDb } from "./helpers";

function event(type: string, object: object): Stripe.Event {
  return { id: crypto.randomUUID(), type, data: { object } } as Stripe.Event;
}

test("distinct concurrent MPP payments credit every purchased year", async () => {
  const db = await makeTestDb();
  const paidUntil = new Date(Date.now() + YEAR_MS);
  const [handle] = await db
    .insert(handles)
    .values({ name: "paid", bearerHash: "paid", paidUntil })
    .returning();
  await Promise.all(
    ["pi_one", "pi_two"].map((reference) =>
      recordPayment(db, {
        reference,
        source: "mpp",
        handleId: handle!.id,
        name: "paid",
        amountCents: 15000,
      }),
    ),
  );
  expect((await db.select().from(handles))[0]!.paidUntil!.getTime()).toBe(
    paidUntil.getTime() + 2 * YEAR_MS,
  );
  expect(await db.select().from(payments)).toHaveLength(2);
});

test("checkout retry after an ambiguous failure reuses the key and subsequent requests reuse the session", async () => {
  const db = await makeTestDb();
  const [handle] = await db
    .insert(handles)
    .values({ name: "paid", bearerHash: "paid", tier: "paid", status: "pending" })
    .returning();
  const keys: string[] = [];
  const stripe = {
    checkout: {
      sessions: {
        create: async (_params: unknown, options: { idempotencyKey: string }) => {
          keys.push(options.idempotencyKey);
          if (keys.length === 1) throw new Error("Response lost after Stripe created checkout");
          return { id: "cs_one", url: "https://checkout.stripe.com/c/one" };
        },
        retrieve: async () => ({
          id: "cs_one",
          status: "open",
          url: "https://checkout.stripe.com/c/one",
        }),
      },
    },
  } as unknown as Stripe;
  const opts = {
    handle: handle!,
    priceCents: 100,
    successUrl: "https://hi.test/paid",
    cancelUrl: "https://hi.test",
  };
  await expect(createSubscriptionCheckout(db, stripe, opts)).rejects.toThrow();
  const urls = await Promise.all([
    createSubscriptionCheckout(db, stripe, opts),
    createSubscriptionCheckout(db, stripe, opts),
  ]);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(urls[0]).toBe(urls[1]);
});

test("deleted subscription is not resurrected by a delayed paid invoice", async () => {
  const db = await makeTestDb();
  const [handle] = await db
    .insert(handles)
    .values({ name: "paid", bearerHash: "paid", stripeSubscriptionId: "sub_old" })
    .returning();
  const metadata = { hi_new_handle_id: String(handle!.id), hi_new_name: "paid" };
  await applyStripeEvent(db, event("customer.subscription.deleted", { id: "sub_old", metadata }));
  await applyStripeEvent(
    db,
    event("invoice.paid", {
      id: "in_delayed",
      amount_paid: 100,
      customer: "cus_old",
      period_end: Math.floor((Date.now() + YEAR_MS) / 1000),
      parent: { subscription_details: { subscription: "sub_old", metadata } },
    }),
  );
  const [after] = await db.select().from(handles);
  expect(after!.stripeSubscriptionId).toBeNull();
  expect(after!.paidUntil).not.toBeNull();
});

test("invoice for a deleted stable handle ID cannot bind a reclaimed name", async () => {
  const db = await makeTestDb();
  const [old] = await db.insert(handles).values({ name: "paid", bearerHash: "old" }).returning();
  await db.delete(handles).where(eq(handles.id, old!.id));
  await db.insert(handles).values({ name: "paid", bearerHash: "new" });
  await applyStripeEvent(
    db,
    event("invoice.paid", {
      id: "in_old",
      amount_paid: 100,
      customer: "cus_old",
      period_end: Math.floor((Date.now() + YEAR_MS) / 1000),
      parent: {
        subscription_details: {
          subscription: "sub_old",
          metadata: { hi_new_handle_id: String(old!.id), hi_new_name: "paid" },
        },
      },
    }),
  );
  const [after] = await db.select().from(handles);
  expect(after!.stripeCustomerId).toBeNull();
  expect(await db.select().from(payments)).toHaveLength(0);
});

test("sweep retains a subscribed handle and failed notices remain retryable", async () => {
  const db = await makeTestDb();
  const now = new Date("2030-01-01");
  await db.insert(handles).values([
    {
      name: "subscriber",
      bearerHash: "sub",
      tier: "paid",
      stripeSubscriptionId: "sub_keep",
      createdAt: new Date("2029-01-01"),
      paidUntil: new Date("2029-01-01"),
    },
    {
      name: "reminder",
      bearerHash: "notice",
      tier: "paid",
      email: "owner@example.com",
      emailVerifiedAt: now,
      paidUntil: new Date(now.getTime() + 86400000),
    },
  ]);
  const deliveryKeys: (string | undefined)[] = [];
  const failed = {
    sendEmail: async (mail: { idempotencyKey?: string }) => {
      deliveryKeys.push(mail.idempotencyKey);
      throw new Error("mail unavailable");
    },
    origin: "https://hi.test",
  };
  await dailySweep(db, now, failed);
  expect(await db.select().from(handles).where(eq(handles.name, "subscriber"))).toHaveLength(1);
  expect(
    (await db.select().from(handles).where(eq(handles.name, "reminder")))[0]!.renewalNoticeStage,
  ).toBe(0);
  expect(
    await renewalNotices(db, now, { sendEmail: async (mail) => { deliveryKeys.push(mail.idempotencyKey); }, origin: "https://hi.test" }),
  ).toBe(1);
  expect(deliveryKeys[0]).toBeTruthy();
  expect(deliveryKeys[0]).toBe(deliveryKeys[1]);
});

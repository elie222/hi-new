import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { handles, payments } from "../db/schema";

export const YEAR_MS = 365 * 24 * 3600 * 1000;

export type PaymentRecord = {
  // Unique Stripe reference: in_... for invoices, pi_... for MPP charges.
  reference: string;
  source: "invoice" | "mpp";
  handleId: number;
  name: string;
  // Zero is valid: a fully discounted or trial invoice still covers a period.
  amountCents: number;
  // The period end this payment covers. Defaults to a year from the later of
  // now and the current paid_until.
  paidUntil?: Date;
  bearerHash?: string;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
};

export type RecordedPayment = { paidUntil: Date; processed: boolean };

// Applies a payment to a handle exactly once. paid_until never moves backwards.
export async function recordPayment(db: Db, payment: PaymentRecord): Promise<RecordedPayment | null> {
  return db.transaction(async (tx) => {
    const [handle] = await tx
      .select({ id: handles.id, name: handles.name, paidUntil: handles.paidUntil })
      .from(handles)
      .where(eq(handles.id, payment.handleId))
      .limit(1);
    if (
      !handle ||
      handle.name !== payment.name ||
      !Number.isSafeInteger(payment.amountCents) ||
      payment.amountCents < 0
    ) {
      return null;
    }

    const current = handle.paidUntil?.getTime() ?? 0;
    const paidUntil = new Date(
      Math.max(current, payment.paidUntil?.getTime() ?? Math.max(Date.now(), current) + YEAR_MS),
    );
    const [created] = await tx
      .insert(payments)
      .values({
        reference: payment.reference,
        source: payment.source,
        handleId: handle.id,
        name: payment.name,
        amountCents: payment.amountCents,
        status: "paid",
        paidUntil,
      })
      .onConflictDoNothing()
      .returning({ id: payments.id });

    if (!created) {
      const [existingPayment] = await tx
        .select({ handleId: payments.handleId })
        .from(payments)
        .where(eq(payments.reference, payment.reference))
        .limit(1);
      if (existingPayment?.handleId !== handle.id) return null;
      if (payment.bearerHash) {
        await tx
          .update(handles)
          .set({ bearerHash: payment.bearerHash })
          .where(eq(handles.id, handle.id));
      }
      return { paidUntil: handle.paidUntil ?? paidUntil, processed: false };
    }

    await tx
      .update(handles)
      .set({
        status: "active",
        tier: "paid",
        paidUntil,
        ...(paidUntil.getTime() > current ? { renewalNoticeStage: 0 } : {}),
        ...(payment.bearerHash ? { bearerHash: payment.bearerHash } : {}),
        ...(payment.stripeCustomerId ? { stripeCustomerId: payment.stripeCustomerId } : {}),
        ...(payment.stripeSubscriptionId !== undefined
          ? { stripeSubscriptionId: payment.stripeSubscriptionId }
          : {}),
      })
      .where(eq(handles.id, handle.id));
    return { paidUntil, processed: true };
  });
}

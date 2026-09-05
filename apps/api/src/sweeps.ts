import { and, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "./db/client";
import { renewalEmailText, type SendEmail } from "./lib/email";
import { daysLeft, RENEWAL_NOTICE_DAYS, shortDate } from "./lib/renewal";
import { sha256Hex } from "./lib/tokens";
import {
  EMAIL_ERA,
  FREE_IDLE_MS,
  MESSAGE_AUDIT_TTL_MS,
  PAID_GRACE_MS,
  PENDING_HANDLE_TTL_MS,
  VERIFY_WINDOW_MS,
} from "./context";
import {
  emailTokens,
  groupInvites,
  handles,
  integrationTokens,
  invites,
  messagePayloads,
  messages,
  messageTranscripts,
  session as ownerSessions,
  verification as ownerVerifications,
  rateCounters,
} from "./db/schema";

// Hourly: payloads die at their TTL, while a body-free audit record remains.
export async function hourlySweep(db: Db, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const expiredMessages = tx
      .select({ id: messages.id })
      .from(messages)
      .where(lt(messages.expiresAt, now));
    await tx.delete(messagePayloads).where(inArray(messagePayloads.messageId, expiredMessages));
    await tx
      .update(messages)
      .set({ expiredAt: now })
      .where(
        and(
          lt(messages.expiresAt, now),
          isNull(messages.acknowledgedAt),
          isNull(messages.expiredAt),
        ),
      );
  });
  const auditCutoff = new Date(now.getTime() - MESSAGE_AUDIT_TTL_MS);
  await db
    .delete(messages)
    .where(or(lt(messages.acknowledgedAt, auditCutoff), lt(messages.expiredAt, auditCutoff)));
  await db.delete(messageTranscripts).where(lt(messageTranscripts.expiresAt, now));
  await db.delete(ownerSessions).where(lt(ownerSessions.expiresAt, now));
  await db.delete(ownerVerifications).where(lt(ownerVerifications.expiresAt, now));
  // Unpaid short-name claims release after 24h.
  await db
    .delete(handles)
    .where(
      and(
        eq(handles.status, "pending"),
        isNull(handles.stripeSubscriptionId),
        isNull(handles.stripeCheckoutSessionId),
        isNull(handles.stripeCheckoutKey),
        lt(handles.createdAt, new Date(now.getTime() - PENDING_HANDLE_TTL_MS)),
      ),
    );
  // Stale rate windows (nothing references windows older than a day).
  await db
    .delete(rateCounters)
    .where(lt(rateCounters.windowStart, new Date(now.getTime() - 2 * 86400 * 1000)));
  // Spent or expired magic links.
  await db.delete(emailTokens).where(lt(emailTokens.expiresAt, now));
  await db.delete(groupInvites).where(lt(groupInvites.expiresAt, now));
  await db.delete(invites).where(lt(invites.expiresAt, now));
  await db.delete(integrationTokens).where(lt(integrationTokens.expiresAt, now));
}

export type SweepNotify = { sendEmail: SendEmail; origin: string };

// Paid names without a subscription lapse unless someone acts. Stripe emails
// subscribers itself; these reminders cover the agent-paid (MPP) names.
export async function renewalNotices(db: Db, now: Date, notify: SweepNotify): Promise<number> {
  const horizon = new Date(now.getTime() + RENEWAL_NOTICE_DAYS[0] * 24 * 3600 * 1000);
  const due = await db
    .select({
      id: handles.id,
      name: handles.name,
      email: handles.email,
      emailVerifiedAt: handles.emailVerifiedAt,
      paidUntil: handles.paidUntil,
      stage: handles.renewalNoticeStage,
    })
    .from(handles)
    .where(
      and(
        eq(handles.tier, "paid"),
        eq(handles.status, "active"),
        isNull(handles.stripeSubscriptionId),
        isNotNull(handles.paidUntil),
        lt(handles.paidUntil, horizon),
      ),
    );
  let sent = 0;
  for (const handle of due) {
    try {
      sent += await db.transaction(async (tx) => {
        const [current] = await tx.select().from(handles).where(eq(handles.id, handle.id)).for("update");
        if (!current?.paidUntil || !current.email || !current.emailVerifiedAt || current.stripeSubscriptionId) return 0;
        const left = daysLeft(current.paidUntil, now.getTime());
        const stage = [...RENEWAL_NOTICE_DAYS].sort((a, b) => a - b).find((days) => left <= days);
        if (!stage || (current.renewalNoticeStage !== 0 && current.renewalNoticeStage <= stage)) return 0;
        const mail = {
          to: current.email,
          ...renewalEmailText(current.name, Math.max(left, 0), shortDate(current.paidUntil), `${notify.origin}/owner`),
        };
        await notify.sendEmail({
          ...mail,
          idempotencyKey: `renewal:${current.id}:${stage}:${await sha256Hex(JSON.stringify(mail))}`,
        });
        await tx.update(handles).set({ renewalNoticeStage: stage }).where(eq(handles.id, current.id));
        return 1;
      });
    } catch {
      // Failed delivery remains eligible, and cannot abort other notices or cleanup.
      console.error("renewal email delivery failed", handle.id);
    }
  }
  return sent;
}

// Daily: use-it-or-lose-it for free names; lapsed paid names get a grace period.
// Handle deletion cascades to grants, invites, and messages.
export async function dailySweep(db: Db, now = new Date(), notify?: SweepNotify): Promise<void> {
  if (notify) await renewalNotices(db, now, notify);
  // Owner email never attached-and-verified within the window: the name
  // releases. Handles that predate the email era are grandfathered.
  await db
    .delete(handles)
    .where(
      and(
        sql`${handles.emailVerifiedAt} is null`,
        isNull(handles.stripeSubscriptionId),
        isNull(handles.stripeCheckoutSessionId),
        isNull(handles.stripeCheckoutKey),
        gt(handles.createdAt, EMAIL_ERA),
        lt(handles.createdAt, new Date(now.getTime() - VERIFY_WINDOW_MS)),
      ),
    );
  await db
    .delete(handles)
    .where(
      and(
        eq(handles.tier, "free"),
        isNull(handles.stripeSubscriptionId),
        isNull(handles.stripeCheckoutSessionId),
        isNull(handles.stripeCheckoutKey),
        lt(handles.lastActiveAt, new Date(now.getTime() - FREE_IDLE_MS)),
      ),
    );
  await db
    .delete(handles)
    .where(
      and(
        eq(handles.tier, "paid"),
        eq(handles.status, "active"),
        isNull(handles.stripeSubscriptionId),
        isNull(handles.stripeCheckoutSessionId),
        isNull(handles.stripeCheckoutKey),
        sql`${handles.paidUntil} is not null`,
        lt(handles.paidUntil, new Date(now.getTime() - PAID_GRACE_MS)),
      ),
    );
}

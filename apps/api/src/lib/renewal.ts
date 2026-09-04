import type { Handle } from "../db/schema";

export const RENEWAL_NOTICE_DAYS = [30, 7] as const;
const DAY_MS = 24 * 3600 * 1000;

type RenewalHandle = Pick<Handle, "name" | "tier" | "paidUntil" | "stripeSubscriptionId">;

export function daysLeft(paidUntil: Date, now = Date.now()): number {
  return Math.ceil((paidUntil.getTime() - now) / DAY_MS);
}

export function shortDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// What an agent sees about its own plan on authenticated calls. The warning
// only appears when the name will lapse without someone acting.
export function renewalView(handle: RenewalHandle, origin: string, now = Date.now()) {
  if (handle.tier !== "paid" || !handle.paidUntil) return null;
  const autoRenew = handle.stripeSubscriptionId !== null;
  const left = daysLeft(handle.paidUntil, now);
  const view: {
    paid_until: Date;
    auto_renew: boolean;
    days_left: number;
    warning?: string;
    renew_url?: string;
    renew_api?: string;
  } = { paid_until: handle.paidUntil, auto_renew: autoRenew, days_left: left };
  if (!autoRenew && left <= RENEWAL_NOTICE_DAYS[0]) {
    view.warning =
      left > 0
        ? `hi.new/${handle.name} lapses in ${left} day${left === 1 ? "" : "s"} (${shortDate(handle.paidUntil)}). Tell your human: turn on auto-renew at ${origin}/owner, or pay for another year with Link via POST /api/handles/${handle.name}/renew.`
        : `hi.new/${handle.name} lapsed on ${shortDate(handle.paidUntil)} and will be released after a 30 day grace period. Tell your human: turn on auto-renew at ${origin}/owner, or pay for another year with Link via POST /api/handles/${handle.name}/renew.`;
    view.renew_url = `${origin}/owner`;
    view.renew_api = `POST ${origin}/api/handles/${handle.name}/renew`;
  }
  return view;
}

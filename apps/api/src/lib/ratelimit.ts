import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { rateCounters } from "../db/schema";

// Fixed-window counter in Postgres. Good enough at v1 traffic; Redis can
// replace this without touching call sites.
export async function takeRate(
  db: Db,
  handleId: number,
  kind: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const windowStart = new Date(
    Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000,
  );
  const [row] = await db
    .insert(rateCounters)
    .values({ handleId, kind, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateCounters.handleId, rateCounters.kind, rateCounters.windowStart],
      set: { count: sql`${rateCounters.count} + 1` },
    })
    .returning({ count: rateCounters.count });
  return (row?.count ?? Infinity) <= limit;
}

export const RATE = {
  dmPerHour: { kind: "dm", limit: 100, windowSeconds: 3600 },
  invitesPerDay: { kind: "invite", limit: 20, windowSeconds: 86400 },
  signupPerHourPerIp: { kind: "signup", limit: 20, windowSeconds: 3600 },
} as const;

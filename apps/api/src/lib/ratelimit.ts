import { sql } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv } from "../context";
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
} as const;

export async function takeEdgeRate(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch (err) {
    console.error("rate limit binding failed", err);
    return true;
  }
}

export async function takeEmailRate(c: Context<AppEnv>, to: string): Promise<boolean> {
  const limiter = c.env?.EMAIL_LIMIT;
  const [byIp, byTo] = await Promise.all([
    takeEdgeRate(limiter, `ip:${clientIp(c)}`),
    takeEdgeRate(limiter, `to:${to.toLowerCase()}`),
  ]);
  return byIp && byTo;
}

export function clientIp(c: Context<AppEnv>): string {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export function rateLimited(c: Context<AppEnv>, hint: string) {
  c.header("Retry-After", "60");
  return c.json({ error: "rate_limited", hint }, 429);
}

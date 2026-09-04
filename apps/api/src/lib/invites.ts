import { INVITE_TTL_MS } from "../context";
import type { Db } from "../db/client";
import { invites } from "../db/schema";
import { RATE, takeRate } from "./ratelimit";
import { randomToken } from "./tokens";

export type CreatedInvite = { url: string; token: string; expiresAt: Date };

export const INVITE_MESSAGE_MAX = 2000;

export function inviteMessageOf(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim().slice(0, INVITE_MESSAGE_MAX) : "";
  return text || null;
}

// One single-use invite link for a handle. Used by the bot API and by the
// owner's own buttons (dashboard, profile) so a human never needs to ask
// their bot for a link. Null when the handle is over its daily allowance.
// The message says why: it is shown on the link page and delivered as the
// first message when the invite is redeemed.
export async function createInvite(
  db: Db,
  handleId: number,
  origin: string,
  message: string | null = null,
  label: string | null = null,
): Promise<CreatedInvite | null> {
  const { kind, limit, windowSeconds } = RATE.invitesPerDay;
  if (!(await takeRate(db, handleId, kind, limit, windowSeconds))) return null;
  const token = randomToken("hni");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await db.insert(invites).values({ token, creatorId: handleId, expiresAt, message, label });
  return { url: `${origin}/i/${token}`, token, expiresAt };
}

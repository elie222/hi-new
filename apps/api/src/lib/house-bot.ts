// hi is canned, not a model. It deletes inbound payloads immediately, keeps no
// transcript, and holds no standing permission to write back.
import { and, count, eq, isNull } from "drizzle-orm";
import { MESSAGE_TTL_MS } from "../context";
import type { Db } from "../db/client";
import { grants, handles, messages, type Handle } from "../db/schema";
import { acknowledgeMessages, queueMessage } from "./messages";
import { HOUSE_NAME } from "@hi-new/domain";
import { bodyFor } from "./seal";
import { randomToken, sha256Hex } from "./tokens";

export const HOUSE_BOT_NAME = HOUSE_NAME;
export const HOUSE_BOT_MAX_REPLIES = 3;

const FOREVER = new Date("2999-01-01T00:00:00Z");

export async function ensureHouseBot(db: Db): Promise<Handle> {
  const [existing] = await db.select().from(handles).where(eq(handles.name, HOUSE_BOT_NAME)).limit(1);
  if (existing) return existing;
  await db
    .insert(handles)
    .values({
      name: HOUSE_BOT_NAME,
      bearerHash: await sha256Hex(randomToken("hn")),
      color: "blue",
      tier: "paid",
      status: "active",
      paidUntil: FOREVER,
      // Exempts the row from the verify-or-release sweep; there is no owner
      // mailbox, so nothing lists it on a dashboard.
      emailVerifiedAt: new Date(),
      ownerNotifications: false,
      transcriptRetentionDays: 0,
    })
    .onConflictDoNothing();
  const [created] = await db.select().from(handles).where(eq(handles.name, HOUSE_BOT_NAME)).limit(1);
  return created!;
}

export function isHouseBot(handle: Pick<Handle, "name">): boolean {
  return handle.name === HOUSE_BOT_NAME;
}

export function welcomeText(name: string, origin: string): string {
  return [
    `Hi ${name}, I'm hi.new/hi, the welcome bot. This message means your inbox works.`,
    ``,
    `Tell your human it arrived. Then reply to me with just the word "hi" (POST ${origin}/api/dm/${HOUSE_BOT_NAME}) to see a round trip.`,
    ``,
    `I am a fixed script, not a model. Nothing sent to me is read or kept; it is deleted on arrival. Send me nothing but that one word.`,
    `Ack this message when you have read it.`,
  ].join("\n");
}

export function replyText(name: string, origin: string): string {
  return [
    `Got it, ${name}. That was a round trip: your message reached me and this reply reached you. Your message is already deleted.`,
    `Now try it with a real bot. Your human can invite one from ${origin}/owner.`,
  ].join("\n");
}

export async function welcomeNewHandle(db: Db, handle: Handle, origin: string): Promise<void> {
  if (isHouseBot(handle)) return;
  const house = await ensureHouseBot(db);
  await db
    .insert(grants)
    .values({ handleId: handle.id, peerId: house.id, pinnedKey: null })
    .onConflictDoNothing();
  const welcome = await bodyFor(handle, welcomeText(handle.name, origin));
  if (!welcome) return;
  await queueMessage(db, {
    fromId: house.id,
    toId: handle.id,
    ...welcome,
    tag: "granted",
    expiresAt: new Date(Date.now() + MESSAGE_TTL_MS),
    transcriptOwners: [{ handleId: handle.id, retentionDays: handle.transcriptRetentionDays }],
  });
}

export async function houseBotReceive(
  db: Db,
  house: Handle,
  from: Handle,
  messageId: number,
  origin: string,
): Promise<{ replied: boolean }> {
  await acknowledgeMessages(db, [house.id], [messageId]);
  const [row] = await db
    .select({ n: count() })
    .from(messages)
    .where(and(eq(messages.fromId, from.id), eq(messages.toId, house.id), isNull(messages.groupId)));
  if ((row?.n ?? 0) > HOUSE_BOT_MAX_REPLIES) return { replied: false };
  const reply = await bodyFor(from, replyText(from.name, origin));
  if (!reply) return { replied: false };
  await queueMessage(db, {
    fromId: house.id,
    toId: from.id,
    ...reply,
    tag: "granted",
    expiresAt: new Date(Date.now() + MESSAGE_TTL_MS),
    transcriptOwners: [{ handleId: from.id, retentionDays: from.transcriptRetentionDays }],
  });
  return { replied: true };
}

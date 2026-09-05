import type { Db } from "../db/client";
import { handles, messagePayloads, messageTranscripts, messages } from "../db/schema";
import { and, asc, count, eq, gt, inArray, ne } from "drizzle-orm";
import type { SelectResultFields } from "drizzle-orm/query-builders/select.types";
import { HOUSE_NAME } from "@hi-new/domain";

export type TranscriptOwner = {
  handleId: number;
  retentionDays: number;
};

export type QueuedMessage = {
  fromId: number;
  toId: number;
  body: string;
  enc: "age" | "none";
  tag?: "granted" | "invite" | "group";
  groupId?: number | null;
  groupPublicId?: string | null;
  groupName?: string | null;
  dispatchId?: string | null;
  expectedRecipientKey?: string | null;
  expiresAt: Date;
  transcriptOwners?: readonly TranscriptOwner[];
  bodyBytes?: number;
  reportUnread?: boolean;
  idempotencyKey?: string | null;
  idempotencyHash?: string | null;
};

export function messageByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export type MessageStatus = "queued" | "opened" | "acknowledged" | "expired";

export function messageStatus(
  message: {
    expiresAt: Date;
    openedAt: Date | null;
    acknowledgedAt: Date | null;
    expiredAt: Date | null;
  },
  now = Date.now(),
): MessageStatus {
  if (message.acknowledgedAt) return "acknowledged";
  if (message.expiredAt || message.expiresAt.getTime() <= now) return "expired";
  if (message.openedAt) return "opened";
  return "queued";
}

const inboxFields = {
  id: messages.id,
  from: handles.name,
  enc: messages.enc,
  tag: messages.tag,
  createdAt: messages.createdAt,
  expiresAt: messages.expiresAt,
  groupId: messages.groupPublicId,
  groupName: messages.groupName,
};

const fullInboxFields = {
  ...inboxFields,
  bytes: messages.bodyBytes,
  body: messagePayloads.body,
  openedAt: messages.openedAt,
};

const inboxHeaderFields = { ...inboxFields, bytes: messages.bodyBytes };
const singleInboxFields = {
  ...inboxFields,
  body: messagePayloads.body,
  openedAt: messages.openedAt,
};

type InboxSelection =
  | typeof fullInboxFields
  | typeof inboxHeaderFields
  | typeof singleInboxFields;

function selectLiveInbox<TSelection extends InboxSelection>(
  db: Db,
  recipientId: number,
  fields: TSelection,
  messageId?: number,
): Promise<SelectResultFields<TSelection>[]>;
async function selectLiveInbox(
  db: Db,
  recipientId: number,
  fields: typeof fullInboxFields | typeof inboxHeaderFields | typeof singleInboxFields,
  messageId?: number,
) {
  return db
    .select(fields)
    .from(messages)
    .innerJoin(messagePayloads, eq(messagePayloads.messageId, messages.id))
    .innerJoin(handles, eq(messages.fromId, handles.id))
    .where(
      and(
        eq(messages.toId, recipientId),
        gt(messages.expiresAt, new Date()),
        ...(messageId === undefined ? [] : [eq(messages.id, messageId)]),
      ),
    )
    .orderBy(asc(messages.id))
    .limit(messageId === undefined ? 100 : 1);
}

export function listLiveInbox(db: Db, recipientId: number) {
  return selectLiveInbox(db, recipientId, fullInboxFields);
}

export function listLiveInboxHeaders(db: Db, recipientId: number) {
  return selectLiveInbox(db, recipientId, inboxHeaderFields);
}

export async function getLiveInboxMessage(db: Db, recipientId: number, messageId: number) {
  const [row] = await selectLiveInbox(db, recipientId, singleInboxFields, messageId);
  return row;
}

type InboxWireRow = SelectResultFields<typeof inboxFields> & {
  bytes?: number;
  body?: string;
};

export function inboxMessageJson(row: InboxWireRow) {
  return {
    id: row.id,
    from: row.from,
    tag: row.tag,
    enc: row.enc,
    ...(row.bytes === undefined ? {} : { bytes: row.bytes }),
    ...(row.body === undefined ? {} : { body: row.body }),
    created_at: row.createdAt,
    expires_at: row.expiresAt,
    group: row.groupId ? { id: row.groupId, name: row.groupName } : null,
  };
}

// The audit row and ephemeral payload are created atomically. Plaintext is
// copied into an owner archive only for handles that explicitly opted in.
export async function queueMessages(db: Db, pending: readonly QueuedMessage[]) {
  if (pending.length === 0) return [];
  return db.transaction(async (tx) => {
    const boundRecipients = pending.filter((message) => message.expectedRecipientKey !== undefined);
    if (boundRecipients.length) {
      const locked = await tx.select({ id: handles.id, publicKey: handles.publicKey }).from(handles)
        .where(inArray(handles.id, [...new Set(boundRecipients.map(message => message.toId))]))
        .orderBy(asc(handles.id)).for("update");
      const keys = new Map(locked.map(handle => [handle.id, handle.publicKey]));
      if (boundRecipients.some(message => keys.get(message.toId) !== message.expectedRecipientKey)) {
        throw new RecipientKeyChanged();
      }
    }
    const trackedRecipients = [
      ...new Set(
        pending
          .filter((message) => message.reportUnread)
          .map((message) => message.toId),
      ),
    ].sort((a, b) => a - b);
    const unreadBefore = new Map<number, number>();
    if (trackedRecipients.length > 0) {
      // Lock recipient rows in stable order so concurrent first deliveries
      // cannot both observe an empty inbox (or both miss the transition).
      await tx
        .select({ id: handles.id })
        .from(handles)
        .where(inArray(handles.id, trackedRecipients))
        .orderBy(asc(handles.id))
        .for("update");
      // The house bot's welcome sits unread until the bot first polls; it must
      // not mask the "inbox became non-empty" moment for a real message.
      const [house] = await tx.select({ id: handles.id }).from(handles).where(eq(handles.name, HOUSE_NAME)).limit(1);
      const counts = await tx
        .select({ toId: messages.toId, n: count() })
        .from(messagePayloads)
        .innerJoin(messages, eq(messagePayloads.messageId, messages.id))
        .where(
          and(
            inArray(messages.toId, trackedRecipients),
            gt(messages.expiresAt, new Date()),
            ...(house ? [ne(messages.fromId, house.id)] : []),
          ),
        )
        .groupBy(messages.toId);
      for (const row of counts) unreadBefore.set(row.toId, row.n);
    }

    const inserted = await tx
      .insert(messages)
      .values(
        pending.map((message) => ({
          fromId: message.fromId,
          toId: message.toId,
          enc: message.enc,
          bodyBytes: message.bodyBytes ?? messageByteLength(message.body),
          tag: message.tag ?? "granted",
          groupId: message.groupId ?? null,
          groupPublicId: message.groupPublicId ?? null,
          groupName: message.groupName ?? null,
          dispatchId: message.dispatchId ?? null,
          expiresAt: message.expiresAt,
          idempotencyKey: message.idempotencyKey ?? null,
          idempotencyHash: message.idempotencyHash ?? null,
        })),
      )
      .returning({ id: messages.id });

    await tx.insert(messagePayloads).values(
      inserted.map((row, index) => ({
        messageId: row.id,
        body: pending[index]!.body,
      })),
    );

    const now = Date.now();
    const transcripts = inserted.flatMap((row, index) => {
      const message = pending[index]!;
      if (message.enc !== "none") return [];
      const owners = new Map<number, number>();
      for (const owner of message.transcriptOwners ?? []) {
        if (owner.retentionDays > 0) owners.set(owner.handleId, owner.retentionDays);
      }
      return [...owners].map(([handleId, retentionDays]) => ({
        messageId: row.id,
        handleId,
        body: message.body,
        expiresAt: new Date(now + retentionDays * 24 * 3600 * 1000),
      }));
    });
    if (transcripts.length > 0) await tx.insert(messageTranscripts).values(transcripts);

    const queuedPerRecipient = new Map<number, number>();
    for (const message of pending) {
      queuedPerRecipient.set(message.toId, (queuedPerRecipient.get(message.toId) ?? 0) + 1);
    }
    return inserted.map((row, index) => {
      const message = pending[index]!;
      const before = unreadBefore.get(message.toId) ?? 0;
      return {
        id: row.id,
        toId: message.toId,
        unread: message.reportUnread
          ? before + (queuedPerRecipient.get(message.toId) ?? 1)
          : null,
        becameUnread: Boolean(message.reportUnread && before === 0),
      };
    });
  });
}

export class RecipientKeyChanged extends Error {
  constructor() { super("recipient_key_changed"); }
}

export async function queueMessage(db: Db, pending: QueuedMessage) {
  const [inserted] = await queueMessages(db, [pending]);
  return inserted!;
}

export async function acknowledgeMessages(
  db: Db,
  recipientIds: readonly number[],
  messageIds: readonly number[],
) {
  if (recipientIds.length === 0 || messageIds.length === 0) return [];
  return db.transaction(async (tx) => {
    const ownedMessages = tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          inArray(messages.toId, [...recipientIds]),
          inArray(messages.id, [...messageIds]),
        ),
      );
    const deleted = await tx
      .delete(messagePayloads)
      .where(inArray(messagePayloads.messageId, ownedMessages))
      .returning({ id: messagePayloads.messageId });
    if (deleted.length > 0) {
      await tx
        .update(messages)
        .set({ acknowledgedAt: new Date() })
        .where(inArray(messages.id, deleted.map((row) => row.id)));
    }
    return deleted;
  });
}

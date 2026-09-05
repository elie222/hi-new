// Accepting an invite (1:1) or joining a group, as a given handle. Shared by
// the bot API (the bot redeems with its token) and the owner's one-click
// Approve/Join buttons (the session picks the handle). Same rules either way.
import { and, count, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { MAX_GROUP_MEMBERS, MESSAGE_TTL_MS, type AppEnv } from "../context";
import type { Db } from "../db/client";
import { grants, groupInvites, groupMembers, groups, handles, invites } from "../db/schema";
import { queueMessage } from "./messages";
import { prepareInboxNotifications } from "./owner-notifications";
import { bodyFor } from "./seal";
import { sha256Hex } from "./tokens";

type Handle = typeof handles.$inferSelect;
export type Failure = { error: string; status: 400 | 403 | 404 | 409 | 410 };

export async function acceptInvite(
  c: Context<AppEnv>,
  db: Db,
  me: Handle,
  token: string,
): Promise<{ creator: Handle; firstMessageDelivered: boolean } | Failure> {
  if (!/^hni_[A-Za-z0-9_-]+$/.test(token)) return { error: "invite_not_found", status: 404 };
  const [invite] = await db
    .select()
    .from(invites)
    .where(or(eq(invites.token, await sha256Hex(token)), eq(invites.token, token)))
    .limit(1);
  if (!invite) return { error: "invite_not_found", status: 404 };
  if (invite.redeemedAt) return { error: "invite_already_used", status: 410 };
  if (invite.expiresAt.getTime() < Date.now()) return { error: "invite_expired", status: 410 };
  if (invite.creatorId === me.id) return { error: "cannot_redeem_own_invite", status: 400 };

  const [creator] = await db
    .select()
    .from(handles)
    .where(eq(handles.id, invite.creatorId))
    .limit(1);
  if (!creator || creator.status !== "active") return { error: "invite_creator_gone", status: 410 };

  const notifications = await prepareInboxNotifications(c, [creator, me]);
  const openerBody = invite.message ? await bodyFor(me, invite.message) : null;
  const dispatch: (() => void)[] = [];
  const result = await db.transaction(async (tx) => {
    const transaction = tx as unknown as Db;
    const [claimed] = await tx
      .update(invites)
      .set({ redeemedAt: new Date(), redeemedById: me.id })
      .where(
        and(
          eq(invites.id, invite.id),
          isNull(invites.redeemedAt),
          gt(invites.expiresAt, new Date()),
        ),
      )
      .returning({ id: invites.id });
    if (!claimed) return { error: "invite_already_used", status: 410 } as Failure;

    // Mutual grant, keys pinned as they are right now (TOFU).
    await tx
      .insert(grants)
      .values([
        { handleId: me.id, peerId: creator.id, pinnedKey: creator.publicKey, inviteId: invite.id },
        { handleId: creator.id, peerId: me.id, pinnedKey: me.publicKey, inviteId: invite.id },
      ])
      .onConflictDoNothing();

    // Tell both bots the grant is ready. The HTTP response confirms redemption
    // immediately, while inbox receipts make the state visible to later pollers.
    const creatorReceipt = await queueMessage(transaction, {
      fromId: me.id,
      toId: creator.id,
      body: JSON.stringify({
        event: "invite.redeemed",
        name: me.name,
        public_key: me.publicKey,
        message: invite.message,
      }),
      enc: "none",
      tag: "invite",
      expiresAt: new Date(Date.now() + MESSAGE_TTL_MS),
      reportUnread: notifications.tracks(creator.id),
      transcriptOwners: [
        { handleId: me.id, retentionDays: me.transcriptRetentionDays },
        { handleId: creator.id, retentionDays: creator.transcriptRetentionDays },
      ],
    });
    dispatch.push(() => notifications.dispatch(new Map([[creator.id, creatorReceipt]])));
    const redeemerReceipt = await queueMessage(transaction, {
      fromId: creator.id,
      toId: me.id,
      body: JSON.stringify({
        event: "invite.connected",
        name: creator.name,
        public_key: creator.publicKey,
      }),
      enc: "none",
      tag: "invite",
      expiresAt: new Date(Date.now() + MESSAGE_TTL_MS),
      reportUnread: notifications.tracks(me.id),
      transcriptOwners: [
        { handleId: creator.id, retentionDays: creator.transcriptRetentionDays },
        { handleId: me.id, retentionDays: me.transcriptRetentionDays },
      ],
    });
    dispatch.push(() => notifications.dispatch(new Map([[me.id, redeemerReceipt]])));

    // The opener the creator's human wrote, as the first DM. Sealed to the
    // redeemer's key when it has one: a keyed handle never receives plaintext.
    let firstMessageDelivered = false;
    if (openerBody) {
      const opener = await queueMessage(transaction, {
        fromId: creator.id,
        toId: me.id,
        ...openerBody,
        tag: "granted",
        // Marks the row as the server-sent opener (activity exposes it), so the
        // setup page can wait for the first message the bots exchange themselves.
        idempotencyKey: `opener:${invite.id}`,
        expiresAt: new Date(Date.now() + MESSAGE_TTL_MS),
        reportUnread: notifications.tracks(me.id),
        transcriptOwners: [
          { handleId: creator.id, retentionDays: creator.transcriptRetentionDays },
          { handleId: me.id, retentionDays: me.transcriptRetentionDays },
        ],
      });
      dispatch.push(() => notifications.dispatch(new Map([[me.id, opener]])));
      firstMessageDelivered = true;
    }
    return { creator, firstMessageDelivered };
  });
  for (const send of dispatch) send();
  return result;
}

export async function joinGroup(
  c: Context<AppEnv>,
  db: Db,
  me: Handle,
  token: string,
): Promise<{ group: typeof groups.$inferSelect } | Failure> {
  if (!/^hngi_[A-Za-z0-9_-]+$/.test(token)) return { error: "invite_not_found", status: 404 };
  const [invite] = await db
    .select()
    .from(groupInvites)
    .where(or(eq(groupInvites.token, await sha256Hex(token)), eq(groupInvites.token, token)))
    .limit(1);
  if (!invite) return { error: "invite_not_found", status: 404 };
  const [invitedGroup] = await db.select().from(groups).where(eq(groups.id, invite.groupId));
  if (!invitedGroup) return { error: "group_gone", status: 410 };
  const [owner] = await db.select().from(handles).where(eq(handles.id, invitedGroup.ownerId));
  const notifications = await prepareInboxNotifications(c, owner ? [owner] : []);
  const dispatch: (() => void)[] = [];
  const joined = await db.transaction(async (tx) => {
    // Reusable links allow concurrent joins. Serializing on the group keeps
    // replacement and the 32-member cap exact.
    await tx.execute(
      sql`select ${groups.id} from ${groups} where ${groups.id} = ${invite.groupId} for update`,
    );
    const [current] = await tx
      .select()
      .from(groupInvites)
      .where(eq(groupInvites.id, invite.id))
      .limit(1);
    if (!current) return { error: "invite_not_found", status: 404 } as Failure;
    // Invites redeemed before reusable links shipped stay spent.
    if (current.redeemedAt) return { error: "invite_already_used", status: 410 } as Failure;
    if (current.expiresAt.getTime() <= Date.now())
      return { error: "invite_expired", status: 410 } as Failure;
    const [already] = await tx
      .select({ id: groupMembers.id })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, current.groupId), eq(groupMembers.handleId, me.id)))
      .limit(1);
    if (already) return { error: "already_a_member", status: 409 } as Failure;
    const [size] = await tx
      .select({ n: count() })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, current.groupId));
    if ((size?.n ?? 0) >= MAX_GROUP_MEMBERS) return { error: "group_full", status: 409 } as Failure;
    const [group] = await tx.select().from(groups).where(eq(groups.id, current.groupId)).limit(1);
    if (!group) return { error: "group_gone", status: 410 } as Failure;
    await tx
      .insert(groupMembers)
      .values({
        groupId: current.groupId,
        handleId: me.id,
        role: "member",
        pinnedKey: me.publicKey,
      });
    if (group.ownerId !== me.id) {
      const queued = await queueMessage(tx as unknown as Db, {
        fromId: me.id,
        toId: group.ownerId,
        body: JSON.stringify({
          event: "group.member_joined",
          group: group.publicId,
          name: me.name,
        }),
        enc: "none",
        tag: "invite",
        groupId: group.id,
        groupPublicId: group.publicId,
        groupName: group.name,
        expiresAt: new Date(Date.now() + MESSAGE_TTL_MS),
        reportUnread: Boolean(owner && notifications.tracks(owner.id)),
        transcriptOwners: [
          { handleId: me.id, retentionDays: me.transcriptRetentionDays },
          ...(owner ? [{ handleId: owner.id, retentionDays: owner.transcriptRetentionDays }] : []),
        ],
      });
      if (owner) dispatch.push(() => notifications.dispatch(new Map([[owner.id, queued]])));
    }
    return { group };
  });
  for (const send of dispatch) send();
  return joined;
}

export function isFailure<T extends object>(r: T | Failure): r is Failure {
  return "error" in r && "status" in r;
}

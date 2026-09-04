import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { MAX_BODY_BYTES, MESSAGE_TTL_MS, type AppEnv } from "../context";
import { groupMembers, groups, handles, messagePayloads, messages } from "../db/schema";
import { requireAuth, requireScope } from "../lib/auth";
import { isFailure, joinGroup } from "../lib/connections";
import { createGroup, createGroupInvite, groupName } from "../lib/groups";
import { messageByteLength, queueMessages } from "../lib/messages";
import { prepareInboxNotifications } from "../lib/owner-notifications";
import { RATE, takeRate } from "../lib/ratelimit";
import { fingerprint } from "../lib/tokens";

export const groupRoutes = new Hono<AppEnv>();

async function membership(c: Context<AppEnv>, publicId: string) {
  const [row] = await c
    .get("db")
    .select({ group: groups, role: groupMembers.role })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .where(and(eq(groups.publicId, publicId), eq(groupMembers.handleId, c.get("me").id)))
    .limit(1);
  return row ?? null;
}

groupRoutes.post("/api/groups", requireAuth, requireScope("groups:write"), async (c) => {
  const body = await c.req.json<{ name?: unknown }>().catch(() => null);
  const name = groupName(body?.name);
  if (!name) return c.json({ error: "name must be 1-64 printable characters" }, 400);
  const created = await createGroup(c.get("db"), c.get("me").id, name);
  return c.json(
    {
      id: created.publicId,
      name,
      role: "owner",
      created_at: created.createdAt,
      invite: {
        url: `${c.get("origin")}/g/${created.invite.token}`,
        token: created.invite.token,
        expires_at: created.invite.expiresAt,
        single_use: false,
      },
      hint: "Share this link with everyone you want to invite. It works until it expires or you replace it.",
    },
    201,
  );
});

groupRoutes.get("/api/groups", requireAuth, requireScope("groups:read"), async (c) => {
  const rows = await c
    .get("db")
    .select({ id: groups.publicId, name: groups.name, role: groupMembers.role, createdAt: groups.createdAt })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .where(eq(groupMembers.handleId, c.get("me").id))
    .orderBy(asc(groupMembers.id));
  return c.json({
    groups: rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      created_at: row.createdAt,
    })),
  });
});

groupRoutes.get("/api/groups/:id", requireAuth, requireScope("groups:read"), async (c) => {
  const joined = await membership(c, c.req.param("id"));
  if (!joined) return c.json({ error: "not_a_group_member" }, 403);
  const rows = await c
    .get("db")
    .select({
      name: handles.name,
      publicKey: handles.publicKey,
      role: groupMembers.role,
      joinedAt: groupMembers.joinedAt,
    })
    .from(groupMembers)
    .innerJoin(handles, eq(groupMembers.handleId, handles.id))
    .where(eq(groupMembers.groupId, joined.group.id))
    .orderBy(asc(groupMembers.id));
  const members = await Promise.all(
    rows.map(async (row) => ({
      name: row.name,
      role: row.role,
      public_key: row.publicKey,
      fingerprint: row.publicKey ? await fingerprint(row.publicKey) : null,
      joined_at: row.joinedAt,
    })),
  );
  return c.json({
    id: joined.group.publicId,
    name: joined.group.name,
    role: joined.role,
    e2e_ready: members.every((member) => member.public_key !== null),
    members,
    note: "For E2E group mail, encrypt one age ciphertext to every other member's public key.",
  });
});

groupRoutes.post(
  "/api/groups/:id/invites",
  requireAuth,
  requireScope("groups:write"),
  async (c) => {
    const joined = await membership(c, c.req.param("id"));
    if (!joined) return c.json({ error: "not_a_group_member" }, 403);
    if (joined.role !== "owner") return c.json({ error: "group_owner_required" }, 403);
    const invite = await createGroupInvite(c.get("db"), joined.group.id, c.get("me").id);
    return c.json(
      {
        invite: {
          url: `${c.get("origin")}/g/${invite.token}`,
          token: invite.token,
          expires_at: invite.expiresAt,
          single_use: false,
        },
      },
      201,
    );
  },
);

groupRoutes.post(
  "/api/group-invites/:token/redeem",
  requireAuth,
  requireScope("groups:write"),
  async (c) => {
    const result = await joinGroup(c, c.get("db"), c.get("me"), c.req.param("token"));
    if (isFailure(result)) return c.json({ error: result.error }, result.status);
    return c.json({ joined: true, group: { id: result.group.publicId, name: result.group.name } });
  },
);

groupRoutes.post(
  "/api/groups/:id/messages",
  requireAuth,
  requireScope("messages:send"),
  async (c) => {
    const joined = await membership(c, c.req.param("id"));
    if (!joined) return c.json({ error: "not_a_group_member" }, 403);
    const body = await c.req.json<{ body?: unknown; enc?: unknown }>().catch(() => null);
    if (!body || typeof body.body !== "string" || body.body.length === 0) {
      return c.json({ error: "body must be a non-empty string" }, 400);
    }
    if (body.enc !== "age" && body.enc !== "none") {
      return c.json({ error: 'enc must be "age" or "none"' }, 400);
    }
    const messageBody = body.body;
    const messageEnc = body.enc;
    const bodyBytes = messageByteLength(messageBody);
    if (bodyBytes > MAX_BODY_BYTES) {
      return c.json({ error: "body_too_large", max_bytes: MAX_BODY_BYTES }, 413);
    }
    const recipients = await c
      .get("db")
      .select({
        id: handles.id,
        name: handles.name,
        publicKey: handles.publicKey,
        webhookUrl: handles.webhookUrl,
        email: handles.email,
        emailVerifiedAt: handles.emailVerifiedAt,
        ownerNotifications: handles.ownerNotifications,
        transcriptRetentionDays: handles.transcriptRetentionDays,
      })
      .from(groupMembers)
      .innerJoin(handles, eq(groupMembers.handleId, handles.id))
      .where(and(eq(groupMembers.groupId, joined.group.id), ne(groupMembers.handleId, c.get("me").id)));
    if (recipients.length === 0) return c.json({ error: "no_other_members" }, 409);
    const missingKeys = recipients.filter((recipient) => !recipient.publicKey).map((recipient) => recipient.name);
    const keyed = recipients.filter((recipient) => recipient.publicKey).map((recipient) => recipient.name);
    if (messageEnc === "age" && missingKeys.length > 0) {
      return c.json({ error: "members_missing_keys", members: missingKeys }, 409);
    }
    if (messageEnc === "none" && keyed.length > 0) {
      return c.json({ error: "encryption_required", members: keyed }, 400);
    }
    const { kind, limit, windowSeconds } = RATE.dmPerHour;
    if (!(await takeRate(c.get("db"), c.get("me").id, `group_${kind}`, limit, windowSeconds))) {
      return c.json({ error: "rate_limited", hint: `${limit} group messages per hour` }, 429);
    }
    const expiresAt = new Date(Date.now() + MESSAGE_TTL_MS);
    const notifications = await prepareInboxNotifications(c, recipients);
    const inserted = await queueMessages(
      c.get("db"),
      recipients.map((recipient) => ({
          fromId: c.get("me").id,
          toId: recipient.id,
          body: messageBody,
          enc: messageEnc,
          bodyBytes,
          tag: "group" as const,
          groupId: joined.group.id,
          groupPublicId: joined.group.publicId,
          groupName: joined.group.name,
          expiresAt,
          reportUnread: notifications.tracks(recipient.id),
          transcriptOwners: [
            {
              handleId: c.get("me").id,
              retentionDays: c.get("me").transcriptRetentionDays,
            },
            {
              handleId: recipient.id,
              retentionDays: recipient.transcriptRetentionDays,
            },
          ],
        })),
    );
    notifications.dispatch(
      new Map(inserted.map((state) => [state.toId, state])),
    );
    return c.json(
      {
        group: { id: joined.group.publicId, name: joined.group.name },
        delivered: inserted.length,
        ids: inserted.map((row) => row.id),
        enc: messageEnc,
        expires_at: expiresAt,
      },
      201,
    );
  },
);

groupRoutes.delete(
  "/api/groups/:id/members/:name",
  requireAuth,
  requireScope("groups:write"),
  async (c) => {
    const joined = await membership(c, c.req.param("id"));
    if (!joined) return c.json({ error: "not_a_group_member" }, 403);
    const requested = c.req.param("name").toLowerCase();
    const targetName = requested === "me" ? c.get("me").name : requested;
    if (targetName !== c.get("me").name && joined.role !== "owner") {
      return c.json({ error: "group_owner_required" }, 403);
    }
    const [target] = await c.get("db").select().from(handles).where(eq(handles.name, targetName)).limit(1);
    if (!target) return c.json({ error: "not_found" }, 404);
    if (target.id === joined.group.ownerId) {
      return c.json({ error: "owner_cannot_leave", hint: "Delete the group instead." }, 409);
    }
    const removed = await c
      .get("db")
      .delete(groupMembers)
      .where(and(eq(groupMembers.groupId, joined.group.id), eq(groupMembers.handleId, target.id)))
      .returning({ id: groupMembers.id });
    return removed.length > 0 ? c.json({ removed: target.name }) : c.json({ error: "not_found" }, 404);
  },
);

groupRoutes.delete("/api/groups/:id", requireAuth, requireScope("groups:write"), async (c) => {
  const joined = await membership(c, c.req.param("id"));
  if (!joined) return c.json({ error: "not_a_group_member" }, 403);
  if (joined.role !== "owner") return c.json({ error: "group_owner_required" }, 403);
  await c.get("db").transaction(async (tx) => {
    const groupMessages = tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.groupId, joined.group.id));
    await tx.delete(messagePayloads).where(inArray(messagePayloads.messageId, groupMessages));
    await tx
      .update(messages)
      .set({ expiredAt: new Date() })
      .where(
        and(
          eq(messages.groupId, joined.group.id),
          isNull(messages.acknowledgedAt),
          isNull(messages.expiredAt),
        ),
      );
    await tx.delete(groups).where(eq(groups.id, joined.group.id));
  });
  return c.json({ deleted: joined.group.publicId });
});

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { grants, handles } from "../db/schema";
import { requireAuth, requireScope } from "../lib/auth";
import { acceptInvite, isFailure } from "../lib/connections";
import { effectiveColor } from "@hi-new/ui/bot-colors";
import { createInvite, INVITE_MESSAGE_MAX, inviteMessageOf } from "../lib/invites";
import { RATE } from "../lib/ratelimit";
import { fingerprint } from "../lib/tokens";

export const inviteRoutes = new Hono<AppEnv>();

type InviteBody = { message?: unknown; label?: unknown };

// A single-use link for your human to hand to someone. The optional message
// says why: shown on the link page, delivered as the first message on approval.
inviteRoutes.post("/api/invites", requireAuth, requireScope("contacts:write"), async (c) => {
  const me = c.get("me");
  const body: InviteBody = (await c.req.json<InviteBody>().catch(() => null)) ?? {};
  if (body.message != null && typeof body.message !== "string") {
    return c.json({ error: "message must be a string" }, 400);
  }
  if (typeof body.message === "string" && body.message.length > INVITE_MESSAGE_MAX) {
    return c.json({ error: "message_too_long", max_chars: INVITE_MESSAGE_MAX }, 400);
  }
  const message = inviteMessageOf(body.message);
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 60) || null : null;
  const invite = await createInvite(c.get("db"), me.id, c.get("origin"), message, label);
  if (!invite) {
    return c.json({ error: "rate_limited", hint: `${RATE.invitesPerDay.limit} invites per day` }, 429);
  }
  return c.json(
    {
      url: invite.url,
      token: invite.token,
      expires_at: invite.expiresAt,
      single_use: true,
      message,
      hint: "Give this URL to the other bot's human on a channel you already trust (WhatsApp, Slack, in person). Whoever redeems it gets a mutual message grant with you.",
    },
    201,
  );
});

inviteRoutes.post("/api/invites/:token/redeem", requireAuth, requireScope("contacts:write"), async (c) => {
  const result = await acceptInvite(c, c.get("db"), c.get("me"), c.req.param("token"));
  if (isFailure(result)) return c.json({ error: result.error }, result.status);
  const { creator } = result;
  return c.json({
    granted: true,
    peer: {
      name: creator.name,
      public_key: creator.publicKey,
      fingerprint: creator.publicKey ? await fingerprint(creator.publicKey) : null,
    },
    receipt_queued: true,
    hint: creator.publicKey
      ? `You can now message each other: POST /api/dm/${creator.name}. Encrypt to their key (enc:"age").`
      : `You can now message each other: POST /api/dm/${creator.name}. They have no public key, so your messages to them are plaintext and appear on their owner's dashboard transcript.`,
  });
});

export const grantRoutes = new Hono<AppEnv>();

grantRoutes.get("/api/grants", requireAuth, requireScope("contacts:read"), async (c) => {
  const me = c.get("me");
  const db = c.get("db");
  const rows = await db
    .select({
      name: handles.name,
      color: handles.color,
      currentKey: handles.publicKey,
      pinnedKey: grants.pinnedKey,
      createdAt: grants.createdAt,
    })
    .from(grants)
    .innerJoin(handles, eq(grants.peerId, handles.id))
    .where(eq(grants.handleId, me.id));
  return c.json({
    grants: rows.map((r) => ({
      name: r.name,
      color: effectiveColor(r.name, r.color),
      public_key: r.currentKey,
      pinned_key: r.pinnedKey,
      // A changed key means the peer rotated it — or someone else holds the
      // handle now. Re-verify out of band before trusting it.
      key_changed: r.pinnedKey !== r.currentKey,
      created_at: r.createdAt,
    })),
  });
});

grantRoutes.delete("/api/grants/:name", requireAuth, requireScope("contacts:write"), async (c) => {
  const me = c.get("me");
  const db = c.get("db");
  const [peer] = await db
    .select()
    .from(handles)
    .where(eq(handles.name, c.req.param("name").toLowerCase()))
    .limit(1);
  if (!peer) return c.json({ error: "not_found" }, 404);
  // Grants are mutual; revoking removes both directions.
  await db
    .delete(grants)
    .where(and(eq(grants.handleId, me.id), eq(grants.peerId, peer.id)));
  await db
    .delete(grants)
    .where(and(eq(grants.handleId, peer.id), eq(grants.peerId, me.id)));
  return c.json({ revoked: peer.name });
});

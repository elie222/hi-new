import { and, count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { handles, notificationDestinations } from "../db/schema";
import { requireAuth, requireScope } from "../lib/auth";
import {
  publicNotificationDestination,
  sealNotificationDestination,
  type CreateNotificationInput,
} from "../lib/notification-destinations";

const MAX_DESTINATIONS = 10;

export const notificationRoutes = new Hono<AppEnv>();

function destinationId(raw: string): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

notificationRoutes.get(
  "/api/notifications",
  requireAuth,
  requireScope("profile:read"),
  async (c) => {
    const me = c.get("me");
    const destinations = await c
      .get("db")
      .select()
      .from(notificationDestinations)
      .where(eq(notificationDestinations.handleId, me.id))
      .orderBy(desc(notificationDestinations.id));
    return c.json({
      destinations: destinations.map(publicNotificationDestination),
      built_in: {
        email: {
          active: Boolean(
            me.ownerNotifications && me.email && me.emailVerifiedAt,
          ),
          verified: me.emailVerifiedAt !== null,
        },
        legacy_webhook: {
          active: me.webhookUrl !== null,
        },
      },
      max_destinations: MAX_DESTINATIONS,
    });
  },
);

notificationRoutes.post(
  "/api/notifications",
  requireAuth,
  requireScope("profile:write"),
  async (c) => {
    const encryptionKey = c.get("notificationEncryptionKey");
    if (!encryptionKey) {
      return c.json(
        {
          error: "notification_storage_unavailable",
          hint: "The service is missing NOTIFICATION_ENCRYPTION_KEY.",
        },
        503,
      );
    }
    const body = await c.req.json<CreateNotificationInput>().catch(() => null);
    if (!body) return c.json({ error: "invalid_json" }, 400);
    const sealed = await sealNotificationDestination(encryptionKey, body);
    if ("error" in sealed) return c.json({ error: sealed.error }, 400);

    const db = c.get("db");
    const me = c.get("me");
    const created = await db.transaction(async (tx) => {
      await tx
        .select({ id: handles.id })
        .from(handles)
        .where(eq(handles.id, me.id))
        .for("update");
      const [existing] = await tx
        .select({ n: count() })
        .from(notificationDestinations)
        .where(eq(notificationDestinations.handleId, me.id));
      if ((existing?.n ?? 0) >= MAX_DESTINATIONS) return null;
      const [inserted] = await tx
        .insert(notificationDestinations)
        .values({ handleId: me.id, ...sealed.value })
        .returning();
      return inserted!;
    });
    if (!created) {
      return c.json(
        { error: "notification_limit", limit: MAX_DESTINATIONS },
        409,
      );
    }
    return c.json(
      {
        destination: publicNotificationDestination(created),
        note: "The endpoint is encrypted and never returned.",
      },
      201,
    );
  },
);

notificationRoutes.patch(
  "/api/notifications/:id",
  requireAuth,
  requireScope("profile:write"),
  async (c) => {
    const id = destinationId(c.req.param("id"));
    if (!id) return c.json({ error: "invalid_notification_id" }, 400);
    const body = await c.req
      .json<{ name?: unknown; active?: unknown }>()
      .catch(() => null);
    if (!body) return c.json({ error: "invalid_json" }, 400);
    const updates: { name?: string; active?: boolean; updatedAt?: Date } = {};
    if ("name" in body) {
      if (
        typeof body.name !== "string" ||
        body.name.trim().length === 0 ||
        body.name.trim().length > 80
      ) {
        return c.json({ error: "name must be 1-80 characters" }, 400);
      }
      updates.name = body.name.trim();
    }
    if ("active" in body) {
      if (typeof body.active !== "boolean")
        return c.json({ error: "active must be a boolean" }, 400);
      updates.active = body.active;
    }
    if (Object.keys(updates).length === 0) {
      return c.json(
        { error: "nothing to update: send name and/or active" },
        400,
      );
    }
    updates.updatedAt = new Date();
    const [updated] = await c
      .get("db")
      .update(notificationDestinations)
      .set(updates)
      .where(
        and(
          eq(notificationDestinations.id, id),
          eq(notificationDestinations.handleId, c.get("me").id),
        ),
      )
      .returning();
    if (!updated) return c.json({ error: "notification_not_found" }, 404);
    return c.json({ destination: publicNotificationDestination(updated) });
  },
);

notificationRoutes.delete(
  "/api/notifications/:id",
  requireAuth,
  requireScope("profile:write"),
  async (c) => {
    const id = destinationId(c.req.param("id"));
    if (!id) return c.json({ error: "invalid_notification_id" }, 400);
    const [deleted] = await c
      .get("db")
      .delete(notificationDestinations)
      .where(
        and(
          eq(notificationDestinations.id, id),
          eq(notificationDestinations.handleId, c.get("me").id),
        ),
      )
      .returning({ id: notificationDestinations.id });
    if (!deleted) return c.json({ error: "notification_not_found" }, 404);
    return c.json({ deleted: true, id: deleted.id });
  },
);

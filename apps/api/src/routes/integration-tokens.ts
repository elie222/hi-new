import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { integrationTokens } from "../db/schema";
import { requireAuth, requireOwner, TOKEN_SCOPES, type TokenScope } from "../lib/auth";
import { randomToken, sha256Hex } from "../lib/tokens";

export const integrationTokenRoutes = new Hono<AppEnv>();

function validScopes(value: unknown): TokenScope[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const allowed = new Set<string>(TOKEN_SCOPES);
  const scopes = [...new Set(value.filter((scope): scope is string => typeof scope === "string"))];
  return scopes.length > 0 && scopes.every((scope) => allowed.has(scope))
    ? (scopes as TokenScope[])
    : null;
}

integrationTokenRoutes.post("/api/tokens", requireAuth, requireOwner, async (c) => {
  const body = await c.req
    .json<{ name?: unknown; scopes?: unknown; expires_in_days?: unknown }>()
    .catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const scopes = validScopes(body?.scopes);
  if (name.length < 1 || name.length > 64) {
    return c.json({ error: "name must be 1-64 characters" }, 400);
  }
  if (!scopes) {
    return c.json({ error: "invalid_scopes", allowed: TOKEN_SCOPES }, 400);
  }
  const days = body?.expires_in_days;
  if (days !== undefined && (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 365)) {
    return c.json({ error: "expires_in_days must be an integer from 1 to 365" }, 400);
  }
  const token = randomToken("hnt");
  const [created] = await c
    .get("db")
    .insert(integrationTokens)
    .values({
      handleId: c.get("me").id,
      name,
      tokenHash: await sha256Hex(token),
      scopes: JSON.stringify(scopes),
      expiresAt:
        typeof days === "number" ? new Date(Date.now() + days * 24 * 3600 * 1000) : null,
    })
    .returning({ id: integrationTokens.id, expiresAt: integrationTokens.expiresAt });
  return c.json(
    {
      id: created!.id,
      name,
      token,
      scopes,
      expires_at: created!.expiresAt,
      warning: "Shown once. Store it in the integration's secret storage.",
    },
    201,
  );
});

integrationTokenRoutes.get("/api/tokens", requireAuth, requireOwner, async (c) => {
  const rows = await c
    .get("db")
    .select({
      id: integrationTokens.id,
      name: integrationTokens.name,
      scopes: integrationTokens.scopes,
      expiresAt: integrationTokens.expiresAt,
      lastUsedAt: integrationTokens.lastUsedAt,
      createdAt: integrationTokens.createdAt,
    })
    .from(integrationTokens)
    .where(eq(integrationTokens.handleId, c.get("me").id))
    .orderBy(desc(integrationTokens.id));
  return c.json({
    tokens: rows.map((row) => ({
      id: row.id,
      name: row.name,
      scopes: JSON.parse(row.scopes),
      expires_at: row.expiresAt,
      last_used_at: row.lastUsedAt,
      created_at: row.createdAt,
    })),
  });
});

integrationTokenRoutes.delete("/api/tokens/:id", requireAuth, requireOwner, async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id < 1) return c.json({ error: "invalid_token_id" }, 400);
  const removed = await c
    .get("db")
    .delete(integrationTokens)
    .where(and(eq(integrationTokens.id, id), eq(integrationTokens.handleId, c.get("me").id)))
    .returning({ id: integrationTokens.id });
  return removed.length > 0 ? c.json({ revoked: id }) : c.json({ error: "not_found" }, 404);
});

import { and, eq, isNull, or, gt } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../context";
import { handles, integrationTokens } from "../db/schema";
import { sha256Hex } from "./tokens";

const TOUCH_AFTER_MS = 3600 * 1000;

export const TOKEN_SCOPES = [
  "profile:read",
  "profile:write",
  "contacts:read",
  "contacts:write",
  "messages:list",
  "messages:read",
  "messages:send",
  "groups:read",
  "groups:write",
] as const;

export type TokenScope = (typeof TOKEN_SCOPES)[number];

function parseScopes(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((scope): scope is string => typeof scope === "string") : [];
  } catch {
    return [];
  }
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    c.header("WWW-Authenticate", 'Bearer realm="hi.new"');
    return c.json({ error: "missing_bearer", hint: "Authorization: Bearer <token>" }, 401);
  }
  const hash = await sha256Hex(header.slice(7).trim());
  const db = c.get("db");
  let [me] = await db.select().from(handles).where(eq(handles.bearerHash, hash)).limit(1);
  let kind: "owner" | "integration" = "owner";
  let scopes: readonly string[] = TOKEN_SCOPES;
  if (!me) {
    const [credential] = await db
      .select()
      .from(integrationTokens)
      .where(
        and(
          eq(integrationTokens.tokenHash, hash),
          or(isNull(integrationTokens.expiresAt), gt(integrationTokens.expiresAt, new Date())),
        ),
      )
      .limit(1);
    if (credential) {
      [me] = await db.select().from(handles).where(eq(handles.id, credential.handleId)).limit(1);
      kind = "integration";
      scopes = parseScopes(credential.scopes);
      if (!credential.lastUsedAt || Date.now() - credential.lastUsedAt.getTime() > TOUCH_AFTER_MS) {
        await db
          .update(integrationTokens)
          .set({ lastUsedAt: new Date() })
          .where(eq(integrationTokens.id, credential.id));
      }
    }
  }
  if (!me) {
    c.header("WWW-Authenticate", 'Bearer realm="hi.new", error="invalid_token"');
    return c.json({ error: "invalid_token" }, 401);
  }
  if (me.status !== "active") {
    return c.json(
      {
        error: "payment_required",
        hint: `This name is reserved for you but unpaid. A human can pay at ${c.get("origin")}/buy/${me.name}`,
      },
      402,
    );
  }
  c.set("me", me);
  c.set("auth", { kind, scopes });
  // Keep last_active_at fresh for the idle-reclaim sweep, without a write per request.
  if (Date.now() - me.lastActiveAt.getTime() > TOUCH_AFTER_MS) {
    await db.update(handles).set({ lastActiveAt: new Date() }).where(eq(handles.id, me.id));
  }
  await next();
});

export function requireScope(scope: TokenScope) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const auth = c.get("auth");
    if (auth.kind !== "owner" && !auth.scopes.includes(scope)) {
      return c.json({ error: "insufficient_scope", required: scope }, 403);
    }
    await next();
  });
}

export const requireOwner = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("auth").kind !== "owner") {
    return c.json({ error: "owner_token_required" }, 403);
  }
  await next();
});

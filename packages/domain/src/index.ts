// Handle names: lowercase, 2-32 chars, a-z 0-9, single hyphens inside.
import { PAID_FIRST_NAMES } from "./first-names";

const NAME_RE = /^[a-z0-9](?:-?[a-z0-9]){1,31}$/;

const RESERVED = new Set([
  "api", "www", "i", "buy", "admin", "skill", "inbox", "help", "about",
  "blog", "mail", "hi", "new", "root", "support", "docs", "status", "app",
  "dashboard", "settings", "login", "signup", "auth", "stripe", "webhook",
  "assets", "static", "favicon", "robots", "sitemap", "terms", "privacy",
  "security", "abuse", "contact", "team", "pricing", "invite", "invites",
  "dm", "rooms", "room", "me", "you", "everyone", "welcome", "claimed",
  "recover", "verify", "mcp", "owner",
]);

// Yearly founding price in cents. 0 = free.
export function priceCentsFor(name: string): number {
  switch (name.length) {
    case 3: return 30_000;
    case 4: return 15_000;
    case 5: return 5_000;
  }
  // Common first names (6+ letters) are scarce like short names: paid at any length.
  return PAID_FIRST_NAMES.has(name) ? 15_000 : 0;
}

type NameCheck =
  | { ok: true; name: string; priceCents: number }
  | { ok: false; error: string };

// The house bot lives at a name nobody can claim. Public read paths (profile,
// lookups, the share card) resolve it; signup never does.
export const HOUSE_NAME = "hi";

export function checkName(raw: unknown, opts: { allowHouse?: boolean } = {}): NameCheck {
  if (typeof raw !== "string") return { ok: false, error: "name is required" };
  const name = raw.trim().toLowerCase();
  if (opts.allowHouse && name === HOUSE_NAME) return { ok: true, name, priceCents: 0 };
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      error: "invalid name: 2-32 chars, a-z 0-9, single hyphens inside (no leading/trailing/double hyphen)",
    };
  }
  if (name.length === 2 || RESERVED.has(name)) {
    return { ok: false, error: "this name is reserved" };
  }
  return { ok: true, name, priceCents: priceCentsFor(name) };
}

import type { Db } from "./db/client";
import type { Handle } from "./db/schema";
import type { SendEmail } from "./lib/email";
import type { OwnerAuth } from "./lib/owner-auth";

export type Bindings = {
  DATABASE_URL: string;
  APP_ORIGIN?: string;
  // "staging" marks non-production deployments (noindex, robots disallow).
  STAGE?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  // Stripe Shared Payment Token / Machine Payments Protocol support.
  STRIPE_NETWORK_ID?: string;
  MPP_SECRET_KEY?: string;
  RESEND_API_KEY?: string;
  // Owner sign-in (Better Auth). Social providers are optional; buttons appear when set.
  BETTER_AUTH_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MCP_ALLOWED_ORIGINS?: string;
  // Encrypts notification endpoints at rest.
  NOTIFICATION_ENCRYPTION_KEY?: string;
  ASSETS?: Fetcher;
  // Workers rate-limit bindings (wrangler.jsonc "ratelimits"): in-memory
  // per-colo counters for unauthenticated paths. Absent outside Workers.
  SIGNUP_LIMIT?: RateLimit;
  EMAIL_LIMIT?: RateLimit;
  LOOKUP_LIMIT?: RateLimit;
};

export type Variables = {
  db: Db;
  me: Handle;
  auth: {
    kind: "owner" | "integration";
    scopes: readonly string[];
  };
  origin: string;
  waitUntil: (p: Promise<unknown>) => void;
  sendEmail: SendEmail;
  notificationEncryptionKey?: string;
  ownerAuth: OwnerAuth;
  // Cheap cookie hint for the page header; /owner does the real session check.
  ownerSignedIn: boolean;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };

export const MAX_BODY_BYTES = 64 * 1024;
export const MESSAGE_TTL_MS = 7 * 24 * 3600 * 1000;
export const MESSAGE_AUDIT_TTL_MS = 90 * 24 * 3600 * 1000;
export const INVITE_TTL_MS = 30 * 24 * 3600 * 1000;
export const PENDING_HANDLE_TTL_MS = 24 * 3600 * 1000;
export const FREE_IDLE_MS = 90 * 24 * 3600 * 1000;
export const PAID_GRACE_MS = 30 * 24 * 3600 * 1000;
export const VERIFY_WINDOW_MS = 7 * 24 * 3600 * 1000;
// Handles created before the email-ownership launch are grandfathered out of
// the verify-or-release rule.
export const EMAIL_ERA = new Date("2026-08-26T23:00:00Z");
export const RECOVER_TTL_MS = 15 * 60 * 1000;
export const SETUP_CODE_TTL_MS = 15 * 60 * 1000;
export const MAX_FREE_HANDLES_PER_EMAIL = 25;
export const MAX_GROUP_MEMBERS = 32;

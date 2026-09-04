// Owner sign-in: Better Auth (magic link + GitHub/Google) on top of the
// email-keyed model — an owner is an email; the dashboard lists the handles
// attached to it. Built per request because Workers hand us env per request.
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import type { Db } from "../db/client";
import * as authSchema from "../db/auth-schema";
import { ownerLoginEmailText, type SendEmail } from "./email";

export const OWNER_AUTH_PATH = "/owner/auth";
export const OWNER_LOGIN_TTL_S = 15 * 60;
export const OWNER_SESSION_TTL_S = 30 * 24 * 3600;
const COOKIE_PREFIX = "hi";
// Session cookie names Better Auth uses for us (secure prefix on https).
export const OWNER_SESSION_COOKIES = [`${COOKIE_PREFIX}.session_token`, `__Secure-${COOKIE_PREFIX}.session_token`];

export type OwnerAuthEnv = {
  BETTER_AUTH_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};

export type OwnerProviders = { github: boolean; google: boolean };

export function ownerProviders(env: OwnerAuthEnv): OwnerProviders {
  return {
    github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  };
}

export function createOwnerAuth(opts: { db: Db; origin: string; env: OwnerAuthEnv; sendEmail: SendEmail }) {
  const { db, origin, env, sendEmail } = opts;
  const providers = ownerProviders(env);
  const production = origin.startsWith("https://");
  // A known placeholder secret would let anyone forge owner sessions, so a
  // deployment without the real one refuses owner sign-in instead.
  if (!env.BETTER_AUTH_SECRET && production) {
    throw new Error("BETTER_AUTH_SECRET is unset; owner sign-in is disabled until it is configured");
  }
  return betterAuth({
    appName: "hi.new",
    baseURL: origin,
    basePath: OWNER_AUTH_PATH,
    secret: env.BETTER_AUTH_SECRET || "hi-new-dev-secret-not-for-production",
    trustedOrigins: [origin],
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    emailAndPassword: { enabled: false },
    session: { expiresIn: OWNER_SESSION_TTL_S, updateAge: 24 * 3600 },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      // Cloudflare puts the real client IP here; rate limits key on it.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"] },
    },
    account: { accountLinking: { enabled: true, trustedProviders: ["github", "google"] } },
    socialProviders: {
      ...(providers.github
        ? { github: { clientId: env.GITHUB_CLIENT_ID!, clientSecret: env.GITHUB_CLIENT_SECRET! } }
        : {}),
      ...(providers.google
        ? { google: { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET! } }
        : {}),
    },
    rateLimit: {
      enabled: production,
      storage: "database",
      customRules: { "/sign-in/magic-link": { window: OWNER_LOGIN_TTL_S, max: 3 } },
    },
    plugins: [
      magicLink({
        expiresIn: OWNER_LOGIN_TTL_S,
        // The email links to our confirm page, not straight to the verify
        // endpoint, so a mail scanner following links can't consume the token.
        sendMagicLink: async ({ email, token, url }) => {
          // Where the sign-in should land afterwards rides along to the
          // confirm page (only a profile path or the dashboard is honoured).
          const next = safeNext(new URL(url).searchParams.get("callbackURL"));
          const confirm = `${origin}/owner/l/${token}${next ? `?next=${encodeURIComponent(next)}` : ""}`;
          await sendEmail({ to: email, ...ownerLoginEmailText(confirm) });
        },
      }),
    ],
  });
}

export type OwnerAuth = ReturnType<typeof createOwnerAuth>;

// A post-sign-in destination other than the dashboard: a profile, or the
// setup page's email step.
export function safeNext(value: unknown): string | null {
  return typeof value === "string" && /^\/(?:[a-z0-9][a-z0-9-]{1,31}(?:\/setup\?step=email)?|i\/hni_[\w-]+)$/.test(value) ? value : null;
}

export function magicLinkVerifyUrl(token: string, next: string | null = null): string {
  return `${OWNER_AUTH_PATH}/magic-link/verify?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent(next ?? "/owner")}&errorCallbackURL=${encodeURIComponent("/owner?error=link")}`;
}

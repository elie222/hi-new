// Only consumed by `@better-auth/cli generate` (schema generation). The real
// instance is built per request in src/lib/owner-auth.ts.
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export const auth = betterAuth({
  database: drizzleAdapter(drizzle(postgres("postgres://localhost:5432/unused")), { provider: "pg" }),
  plugins: [magicLink({ sendMagicLink: async () => {} })],
  socialProviders: { github: { clientId: "x", clientSecret: "x" }, google: { clientId: "x", clientSecret: "x" } },
  rateLimit: { storage: "database" },
});

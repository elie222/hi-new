import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

// Any Postgres — where DATABASE_URL points is a deployment concern, not a code
// concern. Created per request: Workers forbid reusing sockets across requests.
// In production, front the DB with a pooler (e.g. Cloudflare Hyperdrive, works
// with any Postgres host); prepare:false keeps transaction-mode poolers happy.
export function getDb(databaseUrl: string): Db {
  return drizzle(postgres(databaseUrl, { prepare: false, max: 1 }), { schema });
}

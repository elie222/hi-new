import { readFileSync } from "node:fs";
import postgres from "postgres";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required for the capability backfill.");
  process.exit(1);
}

let sql: ReturnType<typeof postgres> | undefined;
try {
  sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10, onnotice: () => {} });
  const statements = readFileSync(new URL("./hash-capabilities.sql", import.meta.url), "utf8")
    .split("--> statement-breakpoint")
    .filter((statement) => statement.trim());
  await sql.begin(async (transaction) => {
    for (const statement of statements) await transaction.unsafe(statement);
  });
  console.log("Capability backfill complete.");
} catch {
  // Database errors can contain connection details or credential values.
  console.error("Capability backfill failed. Check database connectivity and schema, then retry.");
  process.exitCode = 1;
} finally {
  await sql?.end({ timeout: 5 }).catch(() => {
    console.error("Could not close the backfill database connection.");
    process.exitCode = 1;
  });
}

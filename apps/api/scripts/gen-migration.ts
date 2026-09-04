// Non-interactive `drizzle-kit generate`: the CLI prompts on ambiguous
// renames (which needs a TTY); this treats every change as create/drop.
// Usage: bun run db:generate:auto <tag>   e.g. bun run db:generate:auto add_color
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import * as schema from "../src/db/schema";

const name = process.argv[2];
if (!name || !/^[a-z0-9_]+$/.test(name)) {
  console.error("usage: bun run db:generate:auto <snake_case_tag>");
  process.exit(1);
}
const dir = join(import.meta.dir, "../drizzle");
const journalPath = join(dir, "meta/_journal.json");
const journal = JSON.parse(readFileSync(journalPath, "utf8"));
const last = journal.entries.at(-1);
const idx = last ? last.idx + 1 : 0;
const num = String(idx).padStart(4, "0");
const tag = `${num}_${name}`;
if (readdirSync(dir).some((f) => f.startsWith(`${num}_`))) throw new Error(`${num}_* already exists`);

// Data-only migrations may be added without a schema snapshot. Compare with
// the newest snapshot that actually exists instead of assuming every journal
// entry has one.
const snapshotFiles = readdirSync(join(dir, "meta"))
  .filter((file) => /^\d{4}_snapshot\.json$/.test(file))
  .sort();
const previousSnapshot = snapshotFiles
  .filter((file) => Number(file.slice(0, 4)) <= (last?.idx ?? -1))
  .at(-1);
const prev = previousSnapshot
  ? JSON.parse(readFileSync(join(dir, "meta", previousSnapshot), "utf8"))
  : undefined;
const cur = generateDrizzleJson(schema as Record<string, unknown>, prev?.id);
const statements = await generateMigration(prev ?? generateDrizzleJson({}), cur);
if (statements.length === 0) {
  console.log("schema matches the latest snapshot; nothing to generate");
  process.exit(0);
}
writeFileSync(join(dir, `${tag}.sql`), statements.join("\n--> statement-breakpoint\n") + "\n");
writeFileSync(join(dir, `meta/${num}_snapshot.json`), JSON.stringify(cur, null, 2) + "\n");
journal.entries.push({ idx, version: "7", when: Date.now(), tag, breakpoints: true });
writeFileSync(journalPath, JSON.stringify(journal, null, 2) + "\n");
console.log(`wrote drizzle/${tag}.sql (${statements.length} statements)`);

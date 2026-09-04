import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { join } from "node:path";

const migrationsFolder = join(import.meta.dir, "../drizzle");
// Match the final pre-baseline migration so deployed databases skip 0000_baseline.
const baselineCreatedAt = 1788352830999;

describe("database migrations", () => {
  test("bootstraps a fresh database", async () => {
    const pg = new PGlite();
    try {
      await migrate(drizzle(pg), { migrationsFolder });

      await pg.query(
        `insert into handles (name, bearer_hash) values ('fresh', 'fresh-hash')`,
      );
      const handles = await pg.query<{ name: string }>(`select name from handles`);
      const migrations = await pg.query<{ created_at: number }>(
        `select created_at from drizzle.__drizzle_migrations`,
      );

      expect(handles.rows).toEqual([{ name: "fresh" }]);
      expect(Number(migrations.rows[0]!.created_at)).toBe(baselineCreatedAt);
    } finally {
      await pg.close();
    }
  });

  test("skips the baseline on a database already at the cutoff", async () => {
    const pg = new PGlite();
    try {
      const db = drizzle(pg);
      await migrate(db, { migrationsFolder });
      await pg.query(
        `insert into handles (name, bearer_hash) values ('existing', 'existing-hash')`,
      );
      await pg.query(
        `update drizzle.__drizzle_migrations
         set hash = 'legacy-0016'
         where created_at = $1`,
        [baselineCreatedAt],
      );

      await migrate(db, { migrationsFolder });

      const handles = await pg.query<{ name: string; bearer_hash: string }>(
        `select name, bearer_hash from handles`,
      );
      const migrationCount = await pg.query<{ count: number }>(
        `select count(*)::int as count from drizzle.__drizzle_migrations`,
      );
      expect(handles.rows).toEqual([{ name: "existing", bearer_hash: "existing-hash" }]);
      expect(migrationCount.rows[0]!.count).toBe(1);
    } finally {
      await pg.close();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { sha256Hex } from "../src/lib/tokens";
import { createOwnerAuth } from "../src/lib/owner-auth";
import type { Db } from "../src/db/client";

const migrationsFolder = join(import.meta.dir, "../drizzle");
const capabilityBackfill = readFileSync(join(import.meta.dir, "../scripts/hash-capabilities.sql"), "utf8");
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
      expect(migrationCount.rows[0]!.count).toBe(2);
    } finally {
      await pg.close();
    }
  });

  test("hashes legacy capabilities without invalidating links or owner sessions", async () => {
    const pg = new PGlite();
    try {
      await pg.exec(readFileSync(join(migrationsFolder, "0000_baseline.sql"), "utf8"));
      await pg.exec(`
        CREATE SCHEMA drizzle;
        CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('legacy-baseline', ${baselineCreatedAt});
        INSERT INTO handles (id, name, bearer_hash, email) VALUES (1, 'legacy-owner', 'owner-bearer-hash', 'owner@example.com');
        INSERT INTO groups (id, public_id, name, owner_id) VALUES (1, 'legacy-group', 'Legacy group', 1);
        INSERT INTO invites (token, creator_id, expires_at) VALUES ('hni_legacy_link', 1, now() + interval '1 day');
        INSERT INTO group_invites (token, group_id, creator_id, expires_at) VALUES ('hng_legacy_link', 1, 1, now() + interval '1 day');
        INSERT INTO email_tokens (token, handle_id, kind, expires_at) VALUES ('hnv_legacy_link', 1, 'verify', now() + interval '1 day');
        INSERT INTO "user" (id, name, email, email_verified) VALUES ('owner', 'Owner', 'owner@example.com', true);
        INSERT INTO account (id, issuer, account_id, provider_id, user_id, access_token, refresh_token, id_token, updated_at)
          VALUES ('oauth', 'https://github.com', 'github-owner', 'github', 'owner', 'old-access', 'old-refresh', 'old-id', now());
        INSERT INTO session (id, token, user_id, expires_at, updated_at)
          VALUES ('session', 'existing-session', 'owner', now() + interval '1 day', now());
        INSERT INTO verification (id, identifier, value, expires_at) VALUES
          ('magic', 'abcdefghijklmnopqrstuvwxyzABCDEF', '{"email":"owner@example.com","name":"Owner"}', now() + interval '1 day'),
          ('older-magic', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef', '{"email":"other@example.com","attempts":0}', now() + interval '1 day'),
          ('oauth-state', 'OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO', '{"state":"oauth-value"}', now() + interval '1 day'),
          ('non-json', 'NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN', 'not JSON', now() + interval '1 day');
      `);

      const db = drizzle(pg);
      await migrate(db, { migrationsFolder });

      // Additive migrations do not rewrite capabilities while the old Worker runs.
      expect((await pg.query<{ token: string }>(`select token from invites`)).rows[0]!.token)
        .toBe("hni_legacy_link");
      await pg.exec(capabilityBackfill);

      for (const [table, token] of [
        ["invites", "hni_legacy_link"],
        ["group_invites", "hng_legacy_link"],
        ["email_tokens", "hnv_legacy_link"],
      ]) {
        const stored = await pg.query<{ token: string }>(`select token from ${table} where token = $1`, [await sha256Hex(token!)]);
        expect(stored.rows).toEqual([{ token: await sha256Hex(token!) }]);
        expect((await pg.query(`select token from ${table} where token = $1`, [token])).rows).toHaveLength(0);
      }
      expect((await pg.query<{ identifier: string }>(`select identifier from verification where id = 'magic'`)).rows[0]!.identifier)
        .toBe(await sha256Hex("abcdefghijklmnopqrstuvwxyzABCDEF"));
      // Legacy links still work, but cannot be re-shared until a replacement is created.
      expect((await pg.query(`select token_enc from group_invites`)).rows)
        .toEqual([{ token_enc: null }]);
      expect((await pg.query<{ identifier: string }>(`select identifier from verification where id = 'older-magic'`)).rows[0]!.identifier)
        .toBe(await sha256Hex("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"));
      expect((await pg.query(`select identifier, value from verification where id = 'non-json'`)).rows)
        .toEqual([{ identifier: "NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN", value: "not JSON" }]);
      expect((await pg.query(`select identifier, value from verification where id = 'oauth-state'`)).rows)
        .toEqual([{ identifier: "OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO", value: '{"state":"oauth-value"}' }]);
      expect((await pg.query(`select account_id, provider_id, user_id, access_token, refresh_token, id_token from account`)).rows)
        .toEqual([{ account_id: "github-owner", provider_id: "github", user_id: "owner", access_token: null, refresh_token: null, id_token: null }]);
      expect((await pg.query(`select token, user_id from session where id = 'session'`)).rows)
        .toEqual([{ token: "existing-session", user_id: "owner" }]);

      // The raw token already emailed before deployment still signs the owner in.
      const auth = createOwnerAuth({ db: db as unknown as Db, origin: "http://hi.test", env: {}, sendEmail: async () => {} });
      const verified = await auth.handler(new Request("http://hi.test/owner/auth/magic-link/verify?token=abcdefghijklmnopqrstuvwxyzABCDEF&callbackURL=%2Fowner"));
      expect(verified.status).toBe(302);
      expect(verified.headers.get("location")).toBe("http://hi.test/owner");
      expect(verified.headers.get("set-cookie")).toContain("hi.session_token=");

      // A second deployment/backfill must not hash already migrated rows again.
      await migrate(db, { migrationsFolder });
      await pg.query(`insert into invites (token, creator_id, expires_at) values ('hni_late_legacy_link', 1, now() + interval '1 day')`);
      await pg.exec(capabilityBackfill);
      const inviteHashes = (await pg.query<{ token: string }>(`select token from invites`)).rows.map((row) => row.token);
      expect(inviteHashes).toContain(await sha256Hex("hni_legacy_link"));
      expect(inviteHashes).toContain(await sha256Hex("hni_late_legacy_link"));
    } finally {
      await pg.close();
    }
  });
});

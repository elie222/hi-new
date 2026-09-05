-- Capability links keep their external token; only the database stores a digest.
-- Run after deploying the Worker that accepts both legacy tokens and hashes.
-- This backfill is deliberately separate from additive pre-deployment migrations.
-- sha256(bytea) is built into PostgreSQL, so no pgcrypto extension is required.
UPDATE email_tokens SET token = encode(sha256(convert_to(token, 'UTF8')), 'hex')
WHERE token !~ '^[0-9a-f]{64}$';
--> statement-breakpoint
UPDATE invites SET token = encode(sha256(convert_to(token, 'UTF8')), 'hex')
WHERE token !~ '^[0-9a-f]{64}$';
--> statement-breakpoint
UPDATE group_invites SET token = encode(sha256(convert_to(token, 'UTF8')), 'hex')
WHERE token !~ '^[0-9a-f]{64}$';
--> statement-breakpoint
-- Better Auth magic links use 32 alphabetic characters and a JSON email value.
-- Both the current {email,name} and older {email,attempts} payloads are supported.
-- Other verification records (including OAuth state) retain their identifiers.
DO $$
DECLARE
  link record;
  payload jsonb;
BEGIN
  FOR link IN SELECT id, identifier, value FROM verification WHERE identifier ~ '^[a-zA-Z]{32}$' LOOP
    BEGIN
      payload := link.value::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN
      CONTINUE;
    END;
    IF jsonb_typeof(payload -> 'email') = 'string' THEN
      UPDATE verification
      SET identifier = encode(sha256(convert_to(link.identifier, 'UTF8')), 'hex')
      WHERE id = link.id;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
-- Provider OAuth grants are only used at sign-in; retain the account mapping.
UPDATE account SET access_token = NULL, refresh_token = NULL, id_token = NULL;

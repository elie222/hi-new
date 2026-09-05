ALTER TABLE handles ADD COLUMN stripe_checkout_session_id text;
--> statement-breakpoint
ALTER TABLE handles ADD COLUMN stripe_checkout_key text;
--> statement-breakpoint
ALTER TABLE group_members ADD COLUMN pinned_key text;
--> statement-breakpoint
UPDATE group_members SET pinned_key = handles.public_key FROM handles WHERE handles.id = group_members.handle_id;
--> statement-breakpoint
ALTER TABLE messages ADD COLUMN dispatch_id text;
--> statement-breakpoint
CREATE TABLE stripe_subscription_states (
  id text PRIMARY KEY,
  handle_id bigint NOT NULL,
  ended_at timestamptz
);
--> statement-breakpoint
ALTER TABLE group_invites ADD COLUMN token_enc text;

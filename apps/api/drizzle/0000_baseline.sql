CREATE TABLE "email_tokens" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"handle_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"handle_id" bigint NOT NULL,
	"peer_id" bigint NOT NULL,
	"pinned_key" text,
	"invite_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_invites" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"group_id" bigint NOT NULL,
	"creator_id" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_by_id" bigint,
	"redeemed_at" timestamp with time zone,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_invites_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"group_id" bigint NOT NULL,
	"handle_id" bigint NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"name" text NOT NULL,
	"owner_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "handles" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"public_key" text,
	"bearer_hash" text NOT NULL,
	"webhook_url" text,
	"color" text,
	"tier" text DEFAULT 'free' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"paid_until" timestamp with time zone,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"renewal_notice_stage" integer DEFAULT 0 NOT NULL,
	"email" text,
	"email_verified_at" timestamp with time zone,
	"pending_email" text,
	"setup_code_hash" text,
	"setup_token_enc" text,
	"setup_code_expires_at" timestamp with time zone,
	"owner_notifications" boolean DEFAULT true NOT NULL,
	"transcript_retention_days" integer DEFAULT 90 NOT NULL,
	"referred_by_id" bigint,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handles_name_unique" UNIQUE("name"),
	CONSTRAINT "handles_bearer_hash_unique" UNIQUE("bearer_hash")
);
--> statement-breakpoint
CREATE TABLE "integration_tokens" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"handle_id" bigint NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"message" text,
	"label" text,
	"creator_id" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_by_id" bigint,
	"redeemed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "message_payloads" (
	"message_id" bigint PRIMARY KEY NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_transcripts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"message_id" bigint NOT NULL,
	"handle_id" bigint NOT NULL,
	"body" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"from_id" bigint NOT NULL,
	"to_id" bigint NOT NULL,
	"enc" text NOT NULL,
	"body_bytes" integer NOT NULL,
	"tag" text DEFAULT 'granted' NOT NULL,
	"group_id" bigint,
	"group_public_id" text,
	"group_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"idempotency_key" text,
	"idempotency_hash" text
);
--> statement-breakpoint
CREATE TABLE "notification_destinations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"handle_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"endpoint_enc" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"source" text NOT NULL,
	"handle_id" bigint,
	"name" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text NOT NULL,
	"paid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "rate_counters" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"handle_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_tokens" ADD CONSTRAINT "email_tokens_handle_id_handles_id_fk" FOREIGN KEY ("handle_id") REFERENCES "public"."handles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_handle_id_handles_id_fk" FOREIGN KEY ("handle_id") REFERENCES "public"."handles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_peer_id_handles_id_fk" FOREIGN KEY ("peer_id") REFERENCES "public"."handles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_invite_id_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_invites" ADD CONSTRAINT "group_invites_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_invites" ADD CONSTRAINT "group_invites_creator_id_handles_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."handles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_invites" ADD CONSTRAINT "group_invites_redeemed_by_id_handles_id_fk" FOREIGN KEY ("redeemed_by_id") REFERENCES "public"."handles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_handle_id_handles_id_fk" FOREIGN KEY ("handle_id") REFERENCES "public"."handles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_owner_id_handles_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."handles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handles" ADD CONSTRAINT "handles_referred_by_id_handles_id_fk" FOREIGN KEY ("referred_by_id") REFERENCES "public"."handles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_tokens" ADD CONSTRAINT "integration_tokens_handle_id_handles_id_fk" FOREIGN KEY ("handle_id") REFERENCES "public"."handles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_creator_id_handles_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."handles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_redeemed_by_id_handles_id_fk" FOREIGN KEY ("redeemed_by_id") REFERENCES "public"."handles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_payloads" ADD CONSTRAINT "message_payloads_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_transcripts" ADD CONSTRAINT "message_transcripts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_transcripts" ADD CONSTRAINT "message_transcripts_handle_id_handles_id_fk" FOREIGN KEY ("handle_id") REFERENCES "public"."handles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_from_id_handles_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."handles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_to_id_handles_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."handles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_destinations" ADD CONSTRAINT "notification_destinations_handle_id_handles_id_fk" FOREIGN KEY ("handle_id") REFERENCES "public"."handles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_handle_id_handles_id_fk" FOREIGN KEY ("handle_id") REFERENCES "public"."handles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_counters" ADD CONSTRAINT "rate_counters_handle_id_handles_id_fk" FOREIGN KEY ("handle_id") REFERENCES "public"."handles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_tokens_handle_idx" ON "email_tokens" USING btree ("handle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grants_pair_idx" ON "grants" USING btree ("handle_id","peer_id");--> statement-breakpoint
CREATE INDEX "group_invites_group_idx" ON "group_invites" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_members_pair_idx" ON "group_members" USING btree ("group_id","handle_id");--> statement-breakpoint
CREATE INDEX "group_members_handle_idx" ON "group_members" USING btree ("handle_id");--> statement-breakpoint
CREATE INDEX "integration_tokens_handle_idx" ON "integration_tokens" USING btree ("handle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_transcripts_message_handle_idx" ON "message_transcripts" USING btree ("message_id","handle_id");--> statement-breakpoint
CREATE INDEX "message_transcripts_handle_idx" ON "message_transcripts" USING btree ("handle_id");--> statement-breakpoint
CREATE INDEX "message_transcripts_expires_idx" ON "message_transcripts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "messages_to_idx" ON "messages" USING btree ("to_id");--> statement-breakpoint
CREATE INDEX "messages_to_expires_idx" ON "messages" USING btree ("to_id","expires_at");--> statement-breakpoint
CREATE INDEX "messages_from_idx" ON "messages" USING btree ("from_id");--> statement-breakpoint
CREATE INDEX "messages_expires_idx" ON "messages" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_sender_idempotency_idx" ON "messages" USING btree ("from_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "notification_destinations_handle_idx" ON "notification_destinations" USING btree ("handle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_window_idx" ON "rate_counters" USING btree ("handle_id","kind","window_start");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_accountId_idx" ON "account" USING btree ("issuer","account_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");
import {
  bigserial,
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { BOT_COLORS } from "@hi-new/ui/bot-colors";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const handles = pgTable("handles", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  name: text("name").notNull().unique(),
  // Optional age recipient ("age1..."). Handles without one receive plaintext only.
  publicKey: text("public_key"),
  bearerHash: text("bearer_hash").notNull().unique(),
  webhookUrl: text("webhook_url"),
  // Mascot palette key picked at claim time; null falls back to a name hash.
  color: text("color", { enum: BOT_COLORS }),
  tier: text("tier", { enum: ["free", "paid"] }).notNull().default("free"),
  // pending = short name claimed but not yet paid; authed calls are rejected until active.
  status: text("status", { enum: ["pending", "active"] }).notNull().default("active"),
  paidUntil: ts("paid_until"),
  // Stripe billing for paid names. A subscription means the name auto-renews;
  // MPP-paid names have neither and lapse unless paid again.
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  stripeCheckoutKey: text("stripe_checkout_key"),
  // Renewal reminders already sent for the current paid period (0, 30, 7).
  // Reset whenever paid_until moves forward.
  renewalNoticeStage: integer("renewal_notice_stage").notNull().default(0),
  // Owner email is optional at claim time. It must be verified within 7 days
  // for a new handle to remain active and can later rotate a lost token.
  email: text("email"),
  emailVerifiedAt: ts("email_verified_at"),
  // Owner-requested move to another address; applied when that address clicks
  // its link. The current email stays in charge until then.
  pendingEmail: text("pending_email"),
  // One-time setup code for handing the token to a bot via chat: the code is
  // what gets pasted, and the token sits here encrypted under it until the
  // bot exchanges it (or the code expires).
  setupCodeHash: text("setup_code_hash"),
  setupTokenEnc: text("setup_token_enc"),
  setupCodeExpiresAt: ts("setup_code_expires_at"),
  ownerNotifications: boolean("owner_notifications").notNull().default(true),
  // Human-owner transcript archive for plaintext only. Zero keeps content
  // ephemeral; positive values retain an owner-scoped copy for that many days.
  transcriptRetentionDays: integer("transcript_retention_days").notNull().default(90),
  // The handle whose shared link brought this signup in (?ref= on the landing).
  referredById: bigint("referred_by_id", { mode: "number" }).references(
    (): AnyPgColumn => handles.id,
    { onDelete: "set null" },
  ),
  lastActiveAt: ts("last_active_at").notNull().defaultNow(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// Extensible outbound notifications. Adapter-owned endpoints are encrypted so
// a database read cannot recover private URLs or credentials.
export const notificationDestinations = pgTable(
  "notification_destinations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    handleId: bigint("handle_id", { mode: "number" })
      .notNull()
      .references(() => handles.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["webhook", "slack"] }).notNull(),
    name: text("name").notNull(),
    endpointEnc: text("endpoint_enc").notNull(),
    active: boolean("active").notNull().default(true),
    failureCount: integer("failure_count").notNull().default(0),
    lastAttemptAt: ts("last_attempt_at"),
    lastSuccessAt: ts("last_success_at"),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [index("notification_destinations_handle_idx").on(table.handleId)],
);

// Revocable credentials for plugins and other integrations. The original
// handle token remains the simple, full-access credential; integrations can
// be restricted without changing that path.
export const integrationTokens = pgTable(
  "integration_tokens",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    handleId: bigint("handle_id", { mode: "number" })
      .notNull()
      .references(() => handles.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    // JSON-encoded string array. Keeping this as text makes scope additions a
    // protocol change rather than a database enum migration.
    scopes: text("scopes").notNull(),
    expiresAt: ts("expires_at"),
    lastUsedAt: ts("last_used_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("integration_tokens_handle_idx").on(t.handleId)],
);

export const invites = pgTable("invites", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  token: text("token").notNull().unique(),
  // Optional opener written by the creator's human; shown on the link page
  // and delivered as the first DM when the invite is accepted.
  message: text("message"),
  // Owner-private note of who the link was made for ("John"). Never shown
  // to the recipient.
  label: text("label"),
  creatorId: bigint("creator_id", { mode: "number" })
    .notNull()
    .references(() => handles.id, { onDelete: "cascade" }),
  expiresAt: ts("expires_at").notNull(),
  redeemedById: bigint("redeemed_by_id", { mode: "number" }).references(() => handles.id, {
    onDelete: "set null",
  }),
  redeemedAt: ts("redeemed_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const grants = pgTable(
  "grants",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    handleId: bigint("handle_id", { mode: "number" })
      .notNull()
      .references(() => handles.id, { onDelete: "cascade" }),
    peerId: bigint("peer_id", { mode: "number" })
      .notNull()
      .references(() => handles.id, { onDelete: "cascade" }),
    // Peer's public key at grant time (TOFU pin). Null if peer had no key then.
    pinnedKey: text("pinned_key"),
    inviteId: bigint("invite_id", { mode: "number" }).references(() => invites.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("grants_pair_idx").on(t.handleId, t.peerId)],
);

// Kept after handle deletion so delayed billing events cannot revive a subscription.
export const stripeSubscriptionStates = pgTable("stripe_subscription_states", {
  id: text("id").primaryKey(),
  handleId: bigint("handle_id", { mode: "number" }).notNull(),
  endedAt: ts("ended_at"),
});

export const groups = pgTable("groups", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  publicId: text("public_id").notNull().unique(),
  name: text("name").notNull(),
  ownerId: bigint("owner_id", { mode: "number" })
    .notNull()
    .references(() => handles.id, { onDelete: "cascade" }),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const groupMembers = pgTable(
  "group_members",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    groupId: bigint("group_id", { mode: "number" })
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    handleId: bigint("handle_id", { mode: "number" })
      .notNull()
      .references(() => handles.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "member"] }).notNull().default("member"),
    pinnedKey: text("pinned_key"),
    joinedAt: ts("joined_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("group_members_pair_idx").on(t.groupId, t.handleId),
    index("group_members_handle_idx").on(t.handleId),
  ],
);

export const groupInvites = pgTable(
  "group_invites",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    token: text("token").notNull().unique(),
    // Optional server-encrypted copy lets the owner reshare the reusable link.
    tokenEnc: text("token_enc"),
    groupId: bigint("group_id", { mode: "number" })
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    creatorId: bigint("creator_id", { mode: "number" })
      .notNull()
      .references(() => handles.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at").notNull(),
    redeemedById: bigint("redeemed_by_id", { mode: "number" }).references(() => handles.id, {
      onDelete: "set null",
    }),
    redeemedAt: ts("redeemed_at"),
    label: text("label"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("group_invites_group_idx").on(t.groupId)],
);

export const messages = pgTable(
  "messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    fromId: bigint("from_id", { mode: "number" })
      .notNull()
      .references(() => handles.id, { onDelete: "cascade" }),
    toId: bigint("to_id", { mode: "number" })
      .notNull()
      .references(() => handles.id, { onDelete: "cascade" }),
    enc: text("enc", { enum: ["age", "none"] }).notNull(),
    bodyBytes: integer("body_bytes").notNull(),
    tag: text("tag", { enum: ["granted", "invite", "group"] }).notNull().default("granted"),
    groupId: bigint("group_id", { mode: "number" }).references(() => groups.id, {
      onDelete: "set null",
    }),
    groupPublicId: text("group_public_id"),
    groupName: text("group_name"),
    dispatchId: text("dispatch_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    openedAt: ts("opened_at"),
    acknowledgedAt: ts("acknowledged_at"),
    expiredAt: ts("expired_at"),
    // A sender-provided replay key prevents retries from creating another
    // envelope. The request hash rejects accidental key reuse for new content.
    idempotencyKey: text("idempotency_key"),
    idempotencyHash: text("idempotency_hash"),
  },
  (t) => [
    index("messages_to_idx").on(t.toId),
    index("messages_to_expires_idx").on(t.toId, t.expiresAt),
    index("messages_from_idx").on(t.fromId),
    index("messages_expires_idx").on(t.expiresAt),
    uniqueIndex("messages_sender_idempotency_idx").on(t.fromId, t.idempotencyKey),
  ],
);

// Payloads live separately so acknowledgement can physically delete content
// while leaving the delivery/audit record above intact.
export const messagePayloads = pgTable("message_payloads", {
  messageId: bigint("message_id", { mode: "number" })
    .primaryKey()
    .references(() => messages.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// Optional, owner-scoped plaintext archives. Encrypted messages are never
// copied here because the relay does not possess their plaintext.
export const messageTranscripts = pgTable(
  "message_transcripts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    messageId: bigint("message_id", { mode: "number" })
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    handleId: bigint("handle_id", { mode: "number" })
      .notNull()
      .references(() => handles.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("message_transcripts_message_handle_idx").on(t.messageId, t.handleId),
    index("message_transcripts_handle_idx").on(t.handleId),
    index("message_transcripts_expires_idx").on(t.expiresAt),
  ],
);

// Magic-link tokens for email verification and token recovery.
export const emailTokens = pgTable(
  "email_tokens",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    handleId: bigint("handle_id", { mode: "number" })
      .notNull()
      .references(() => handles.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["verify", "recover", "move"] }).notNull(),
    token: text("token").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("email_tokens_handle_idx").on(t.handleId)],
);

export const rateCounters = pgTable(
  "rate_counters",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    handleId: bigint("handle_id", { mode: "number" })
      .notNull()
      .references(() => handles.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    windowStart: ts("window_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [uniqueIndex("rate_window_idx").on(t.handleId, t.kind, t.windowStart)],
);

// Ledger of everything that moved paid_until: Stripe invoices (in_...),
// MPP payment intents (pi_...). The reference is the idempotency key.
export const payments = pgTable("payments", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  reference: text("reference").notNull().unique(),
  source: text("source", { enum: ["invoice", "mpp"] }).notNull(),
  handleId: bigint("handle_id", { mode: "number" }).references(() => handles.id, {
    onDelete: "set null",
  }),
  name: text("name").notNull(),
  amountCents: integer("amount_cents").notNull(),
  status: text("status").notNull(),
  paidUntil: ts("paid_until"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export type Handle = typeof handles.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type MessagePayload = typeof messagePayloads.$inferSelect;
export type MessageTranscript = typeof messageTranscripts.$inferSelect;
export type Invite = typeof invites.$inferSelect;
export type Grant = typeof grants.$inferSelect;
export type IntegrationToken = typeof integrationTokens.$inferSelect;
export type NotificationDestination = typeof notificationDestinations.$inferSelect;
export type Group = typeof groups.$inferSelect;
export type GroupMember = typeof groupMembers.$inferSelect;

// Owner sign-in (Better Auth): user, session, account, verification, rateLimit.
export * from "./auth-schema";

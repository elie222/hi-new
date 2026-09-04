import { and, count, desc, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context";
import { VERIFY_WINDOW_MS } from "../context";
import {
  emailTokens,
  grants,
  groupInvites,
  groupMembers,
  groups,
  handles,
  invites,
  messagePayloads,
  messages,
  messageTranscripts,
  verification,
} from "../db/schema";
import { isEmail, moveEmailText } from "../lib/email";
import { acknowledgeMessages, messageStatus } from "../lib/messages";
import { magicLinkVerifyUrl, OWNER_AUTH_PATH, ownerProviders, safeNext } from "../lib/owner-auth";
import { randomToken } from "../lib/tokens";
import { acceptInvite, isFailure, joinGroup } from "../lib/connections";
import { createGroup, createGroupInvite, groupName } from "../lib/groups";
import { createInvite, inviteMessageOf } from "../lib/invites";
import { createBillingPortal, createSubscriptionCheckout, stripeClient } from "../lib/billing";
import { priceCentsFor } from "@hi-new/domain";
import { daysLeft } from "../lib/renewal";
import { emailHasRoom } from "./handles";
import {
  OwnerCheckEmailPage,
  OwnerConfirmPage,
  OwnerDashboardPage,
  OwnerLoginPage,
  type OwnerContactView,
  type OwnerDirectInviteView,
  type OwnerMessageView,
} from "../pages/owner";
import { renderPage } from "../pages/render";

export const ownerRoutes = new Hono<AppEnv>();

function privatePage(c: Context<AppEnv>): void {
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex, nofollow");
}

// Better Auth checks Origin on its own endpoints; our form posts get the same
// treatment. SameSite=Lax on the cookie already blocks cross-site posts in
// modern browsers — this is belt and braces.
function sameOrigin(c: Context<AppEnv>): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site === "same-origin" || site === "none") return true;
  if (site) return false;
  const origin = c.req.header("origin");
  return !origin || origin === c.get("origin") || origin === new URL(c.req.url).origin;
}

function forwardCookies(c: Context<AppEnv>, headers: Headers | undefined): void {
  const cookies = (headers as unknown as { getSetCookie?: () => string[] } | undefined)?.getSetCookie?.() ?? [];
  for (const value of cookies) c.header("set-cookie", value, { append: true });
}

async function ownerEmail(c: Context<AppEnv>): Promise<{ email: string; verified: boolean } | null> {
  const session = await c.get("ownerAuth").api.getSession({ headers: c.req.raw.headers });
  if (!session?.user.email) return null;
  return { email: session.user.email.toLowerCase(), verified: session.user.emailVerified };
}

// A just-created invite link rides back to the page in the query string (it
// is a shareable link, not a secret; the page is private/no-store anyway).
export function inviteFromQuery(c: Context<AppEnv>): { handleId: number; url: string } | null {
  const token = c.req.query("invite");
  const handleId = Number(c.req.query("for"));
  if (!token || !/^hni_[\w-]+$/.test(token) || !Number.isSafeInteger(handleId)) return null;
  return { handleId, url: `${c.get("origin")}/i/${token}` };
}

export async function viewerHandles(c: Context<AppEnv>): Promise<{ id: number; name: string; color: string | null }[]> {
  if (!c.get("ownerSignedIn")) return [];
  const owner = await ownerEmail(c);
  if (!owner) return [];
  const owned = await ownedHandles(c, owner.email);
  return owned.map((h) => ({ id: h.id, name: h.name, color: h.color }));
}

export function groupLinkFromQuery(c: Context<AppEnv>): { token: string; url: string; publicId: string } | null {
  const token = c.req.query("glink");
  const publicId = c.req.query("group");
  if (!token || !/^hngi_[\w-]+$/.test(token) || !publicId || !/^hng_[\w-]+$/.test(publicId)) return null;
  return { token, url: `${c.get("origin")}/g/${token}`, publicId };
}

export type OwnedGroupView = {
  publicId: string;
  name: string;
  members: number;
  inviteId: number | null;
  inviteUrl: string | null;
  inviteExpiresAt: Date | null;
};

function appendToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

export async function ownedGroups(c: Context<AppEnv>, ownerIds: number[]): Promise<Map<number, OwnedGroupView[]>> {
  const out = new Map<number, OwnedGroupView[]>();
  if (ownerIds.length === 0) return out;
  const rows = await c
    .get("db")
    .select({ id: groups.id, ownerId: groups.ownerId, publicId: groups.publicId, name: groups.name, members: count(groupMembers.id) })
    .from(groups)
    .leftJoin(groupMembers, eq(groupMembers.groupId, groups.id))
    .where(inArray(groups.ownerId, ownerIds))
    .groupBy(groups.id)
    .orderBy(desc(groups.id));
  if (rows.length === 0) return out;
  const activeInvites = await c
    .get("db")
    .select({ id: groupInvites.id, groupId: groupInvites.groupId, token: groupInvites.token, expiresAt: groupInvites.expiresAt })
    .from(groupInvites)
    .where(
      and(
        inArray(groupInvites.groupId, rows.map((row) => row.id)),
        isNull(groupInvites.redeemedAt),
        gt(groupInvites.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(groupInvites.id));
  const inviteByGroup = new Map<number, { id: number; url: string; expiresAt: Date }>();
  for (const invite of activeInvites) {
    if (!inviteByGroup.has(invite.groupId)) {
      inviteByGroup.set(invite.groupId, {
        id: invite.id,
        url: `${c.get("origin")}/g/${invite.token}`,
        expiresAt: invite.expiresAt,
      });
    }
  }
  for (const row of rows) {
    const invite = inviteByGroup.get(row.id);
    appendToMap(out, row.ownerId, {
      publicId: row.publicId,
      name: row.name,
      members: Number(row.members),
      inviteId: invite?.id ?? null,
      inviteUrl: invite?.url ?? null,
      inviteExpiresAt: invite?.expiresAt ?? null,
    });
  }
  return out;
}

// Active direct links belong in the explicit link-management dialog, never in
// the conversation list.
export async function activeDirectInvites(c: Context<AppEnv>, ownerIds: number[]): Promise<Map<number, OwnerDirectInviteView[]>> {
  const out = new Map<number, OwnerDirectInviteView[]>();
  if (ownerIds.length === 0) return out;
  const rows = await c
    .get("db")
    .select({ id: invites.id, creatorId: invites.creatorId, label: invites.label, expiresAt: invites.expiresAt })
    .from(invites)
    .where(
      and(
        inArray(invites.creatorId, ownerIds),
        isNull(invites.redeemedAt),
        gt(invites.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(invites.id));
  for (const row of rows) {
    appendToMap(out, row.creatorId, { id: row.id, label: row.label, expiresAt: row.expiresAt });
  }
  return out;
}

export async function contactsByHandle(c: Context<AppEnv>, ownerIds: number[]): Promise<Map<number, OwnerContactView[]>> {
  const out = new Map<number, OwnerContactView[]>();
  if (ownerIds.length === 0) return out;
  const rows = await c
    .get("db")
    .select({ handleId: grants.handleId, name: handles.name, color: handles.color })
    .from(grants)
    .innerJoin(handles, eq(handles.id, grants.peerId))
    .where(inArray(grants.handleId, ownerIds))
    .orderBy(desc(grants.id));
  for (const row of rows) appendToMap(out, row.handleId, { name: row.name, color: row.color });
  return out;
}

export function labelOf(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim().slice(0, 60) : "";
  return text || null;
}

export async function ownedHandles(c: Context<AppEnv>, email: string) {
  return c
    .get("db")
    .select()
    .from(handles)
    .where(
      and(
        eq(handles.email, email),
        isNotNull(handles.emailVerifiedAt),
        eq(handles.status, "active"),
      ),
    );
}

ownerRoutes.on(["GET", "POST"], `${OWNER_AUTH_PATH}/*`, (c) => c.get("ownerAuth").handler(c.req.raw));

// Lets static pages label the nav link from a cheap cookie hint. Profiles can
// also ask for one handle-specific ownership check, which validates the session.
ownerRoutes.get("/api/owner/session", async (c) => {
  privatePage(c);
  const signedIn = c.get("ownerSignedIn");
  const handle = c.req.query("handle")?.toLowerCase();
  const providers = ownerProviders(c.env ?? {});
  if (!signedIn) return c.json({ signed_in: false, bots: [], providers });
  const owned = await viewerHandles(c);
  const owner = await ownerEmail(c);
  return c.json({
    signed_in: signedIn,
    bots: owned,
    providers,
    email: owner?.verified ? owner.email : null,
    ...(handle ? { owns_handle: owned.some((item) => item.name === handle) } : {}),
  });
});

ownerRoutes.get("/owner", async (c) => {
  privatePage(c);
  const owner = await ownerEmail(c);
  const next = safeNext(c.req.query("next"));
  if (!owner) {
    return renderPage(
      c,
      <OwnerLoginPage providers={ownerProviders(c.env ?? {})} error={c.req.query("error") ?? null} next={next} />,
    );
  }
  if (next) return c.redirect(next, 303);
  const { email } = owner;
  // Signing in proves control of the mailbox — the same proof /v/:token asks
  // for — so handles that attached this email but never clicked verify are
  // verified now (and stop counting down to release).
  if (owner.verified) {
    await c
      .get("db")
      .update(handles)
      .set({ emailVerifiedAt: new Date() })
      .where(and(eq(handles.email, email), isNull(handles.emailVerifiedAt)));
  }
  const owned = await ownedHandles(c, email);
  const ownedIds = owned.map((handle) => handle.id);
  if (ownedIds.length === 0) {
    return renderPage(c, <OwnerDashboardPage email={email} emailVerified={owner.verified} handles={[]} messages={[]} />);
  }

  // Independent of the message rows: run them alongside instead of after.
  const side = Promise.all([ownedGroups(c, ownedIds), contactsByHandle(c, ownedIds), activeDirectInvites(c, ownedIds)]);
  const rows = await c
    .get("db")
    .select({
      id: messages.id,
      fromId: messages.fromId,
      toId: messages.toId,
      enc: messages.enc,
      createdAt: messages.createdAt,
      expiresAt: messages.expiresAt,
      openedAt: messages.openedAt,
      acknowledgedAt: messages.acknowledgedAt,
      expiredAt: messages.expiredAt,
      payload: messagePayloads.body,
      groupName: messages.groupName,
      tag: messages.tag,
    })
    .from(messages)
    .leftJoin(messagePayloads, eq(messagePayloads.messageId, messages.id))
    .where(or(inArray(messages.fromId, ownedIds), inArray(messages.toId, ownedIds)))
    .orderBy(desc(messages.id))
    .limit(100);

  const participantIds = [...new Set(rows.flatMap((row) => [row.fromId, row.toId]))];
  const messageIds = rows.map((row) => row.id);
  const [participants, transcripts] = await Promise.all([
    participantIds.length
      ? c.get("db").select({ id: handles.id, name: handles.name, color: handles.color }).from(handles).where(inArray(handles.id, participantIds))
      : Promise.resolve([]),
    messageIds.length
      ? c
          .get("db")
          .select()
          .from(messageTranscripts)
          .where(
            and(
              inArray(messageTranscripts.messageId, messageIds),
              inArray(messageTranscripts.handleId, ownedIds),
              gt(messageTranscripts.expiresAt, new Date()),
            ),
          )
      : Promise.resolve([]),
  ]);
  const names = new Map(participants.map((participant) => [participant.id, participant.name]));
  const colors = new Map(participants.map((participant) => [participant.id, participant.color]));
  const transcriptByOwner = new Map(
    transcripts.map((entry) => [`${entry.messageId}:${entry.handleId}`, entry.body]),
  );
  const ownedIdSet = new Set(ownedIds);
  const now = Date.now();
  const openedIds: number[] = [];
  const makeView = (row: (typeof rows)[number], outgoing: boolean): OwnerMessageView => {
    const handleId = outgoing ? row.fromId : row.toId;
    const peerId = outgoing ? row.toId : row.fromId;
    const live =
      row.enc === "none" &&
      row.payload !== null &&
      !row.acknowledgedAt &&
      !row.expiredAt &&
      row.expiresAt.getTime() > now
        ? row.payload
        : null;
    if (!outgoing && live !== null && !row.openedAt) openedIds.push(row.id);
    const archived = transcriptByOwner.get(`${row.id}:${handleId}`) ?? null;
    const openedAt = row.openedAt ?? (!outgoing && live !== null ? new Date(now) : null);
    return {
      id: row.id,
      handle: names.get(handleId) ?? "deleted-handle",
      handleColor: colors.get(handleId) ?? null,
      direction: outgoing ? "outgoing" : "incoming",
      peer: names.get(peerId) ?? "deleted-handle",
      peerColor: colors.get(peerId) ?? null,
      group: row.groupName,
      enc: row.enc,
      tag: row.tag,
      status: messageStatus({ ...row, openedAt }, now),
      createdAt: row.createdAt,
      openedAt,
      acknowledgedAt: row.acknowledgedAt,
      body: live ?? archived,
      archived: live === null && archived !== null,
      canAcknowledge: !outgoing && live !== null,
    };
  };
  const activity: OwnerMessageView[] = rows.flatMap((row) => {
    const fromOwned = ownedIdSet.has(row.fromId);
    // A group message between two of your own bots belongs in both bots'
    // conversations: the sender's copy and the recipient's.
    if (fromOwned && ownedIdSet.has(row.toId) && row.groupName) return [makeView(row, true), makeView(row, false)];
    return [makeView(row, fromOwned)];
  });
  const sideResults = await side;
  if (openedIds.length > 0) {
    await c
      .get("db")
      .update(messages)
      .set({ openedAt: new Date() })
      .where(and(inArray(messages.id, openedIds), isNull(messages.openedAt)));
  }

  return renderPage(
    c,
    <OwnerDashboardPage
      email={email}
      emailVerified={owner.verified}
      error={c.req.query("error") ?? null}
      invite={inviteFromQuery(c)}
      groupLink={groupLinkFromQuery(c)}
      groups={sideResults[0]}
      contacts={sideResults[1]}
      directInvites={sideResults[2]}
      linksOpenFor={Number(c.req.query("links")) || null}
      handles={owned.map((handle) => ({
        id: handle.id,
        name: handle.name,
        color: handle.color,
        pendingEmail: handle.pendingEmail,
        encrypted: handle.publicKey !== null,
        ownerNotifications: handle.ownerNotifications,
        transcriptRetentionDays: handle.transcriptRetentionDays,
        plan: planOf(handle),
      }))}
      messages={activity}
    />,
  );
});

ownerRoutes.post("/owner/login", async (c) => {
  privatePage(c);
  if (!sameOrigin(c)) return c.text("forbidden", 403);
  const form = await c.req.parseBody();
  const typed = typeof form.email === "string" ? form.email.trim().toLowerCase() : "";
  const next = safeNext(form.next);
  if (!isEmail(typed)) return c.redirect(`/owner?error=email${next ? `&next=${encodeURIComponent(next)}` : ""}`, 303);
  try {
    // Any address gets a link; the dashboard says "no bots yet" if none are
    // attached. Same page either way — no way to probe who owns what.
    await c.get("ownerAuth").api.signInMagicLink({
      body: { email: typed, callbackURL: next ?? "/owner" },
      headers: c.req.raw.headers,
    });
  } catch (err) {
    // Rate limited or provider hiccup: still the same page, so the flow is
    // indistinguishable from the outside. Logged for the operator.
    console.warn("owner sign-in: magic link not sent", (err as Error)?.message ?? err);
  }
  return renderPage(c, <OwnerCheckEmailPage email={typed} />);
});

ownerRoutes.post("/owner/login/:provider", async (c) => {
  privatePage(c);
  if (!sameOrigin(c)) return c.text("forbidden", 403);
  const provider = c.req.param("provider");
  const enabled = ownerProviders(c.env ?? {});
  if ((provider !== "github" && provider !== "google") || !enabled[provider]) return c.notFound();
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const next = safeNext(form.next);
  const { headers, response } = await c.get("ownerAuth").api.signInSocial({
    body: { provider, callbackURL: next ?? "/owner", errorCallbackURL: "/owner?error=oauth" },
    headers: c.req.raw.headers,
    returnHeaders: true,
  });
  forwardCookies(c, headers);
  if (!response.url) return c.redirect("/owner?error=oauth", 303);
  return c.redirect(response.url, 303);
});

// Landing page for the emailed link: shows a button, consumes nothing. The
// button is a plain link to Better Auth's verify endpoint.
ownerRoutes.get("/owner/l/:token", async (c) => {
  privatePage(c);
  const token = c.req.param("token");
  const [pending] = await c
    .get("db")
    .select({ id: verification.id })
    .from(verification)
    .where(and(eq(verification.identifier, token), gt(verification.expiresAt, new Date())))
    .limit(1);
  return renderPage(c, <OwnerConfirmPage verifyUrl={pending ? magicLinkVerifyUrl(token, safeNext(c.req.query("next"))) : null} />, pending ? 200 : 410);
});

ownerRoutes.post("/owner/logout", async (c) => {
  if (!sameOrigin(c)) return c.text("forbidden", 403);
  try {
    const { headers } = await c.get("ownerAuth").api.signOut({ headers: c.req.raw.headers, returnHeaders: true });
    forwardCookies(c, headers);
  } catch {
  }
  return c.redirect("/owner", 303);
});

ownerRoutes.post("/owner/messages/:id/ack", async (c) => {
  if (!sameOrigin(c)) return c.text("forbidden", 403);
  const email = (await ownerEmail(c))?.email;
  if (!email) return c.redirect("/owner", 303);
  const id = Number(c.req.param("id"));
  if (Number.isSafeInteger(id) && id > 0) {
    const owned = await ownedHandles(c, email);
    await acknowledgeMessages(c.get("db"), owned.map((handle) => handle.id), [id]);
  }
  return c.redirect("/owner", 303);
});

ownerRoutes.post("/owner/handles/:id/transcripts", async (c) => {
  if (!sameOrigin(c)) return c.text("forbidden", 403);
  const email = (await ownerEmail(c))?.email;
  if (!email) return c.redirect("/owner", 303);
  const id = Number(c.req.param("id"));
  const form = await c.req.parseBody();
  const [handle] = Number.isSafeInteger(id) && id > 0
    ? await c
        .get("db")
        .select()
        .from(handles)
        .where(and(eq(handles.id, id), eq(handles.email, email), isNotNull(handles.emailVerifiedAt)))
        .limit(1)
    : [];
  if (handle) {
    const enabled = form.enabled === "true";
    await c
      .get("db")
      .update(handles)
      .set({ transcriptRetentionDays: enabled ? 90 : 0 })
      .where(eq(handles.id, handle.id));
    if (!enabled) {
      await c.get("db").delete(messageTranscripts).where(eq(messageTranscripts.handleId, handle.id));
    }
  }
  return c.redirect("/owner", 303);
});

ownerRoutes.post("/owner/handles/:id/notifications", async (c) => {
  if (!sameOrigin(c)) return c.text("forbidden", 403);
  const email = (await ownerEmail(c))?.email;
  if (!email) return c.redirect("/owner", 303);
  const id = Number(c.req.param("id"));
  const form = await c.req.parseBody();
  if (Number.isSafeInteger(id) && id > 0) {
    await c
      .get("db")
      .update(handles)
      .set({ ownerNotifications: form.enabled === "true" })
      .where(and(eq(handles.id, id), eq(handles.email, email), isNotNull(handles.emailVerifiedAt)));
  }
  return c.redirect("/owner", 303);
});

// Move a handle to another owner email. The current owner (this session) asks;
// the new address confirms by clicking its link. Until then nothing changes,
// so the handle never sits unverified (which the sweep would release).
ownerRoutes.post("/owner/handles/:id/email", async (c) => {
  if (!sameOrigin(c)) return c.text("forbidden", 403);
  const email = (await ownerEmail(c))?.email;
  if (!email) return c.redirect("/owner", 303);
  const id = Number(c.req.param("id"));
  const form = await c.req.parseBody();
  const [handle] = Number.isSafeInteger(id) && id > 0
    ? await c
        .get("db")
        .select()
        .from(handles)
        .where(and(eq(handles.id, id), eq(handles.email, email), isNotNull(handles.emailVerifiedAt)))
        .limit(1)
    : [];
  if (!handle) return c.redirect("/owner", 303);
  const db = c.get("db");
  const retirePriorMoves = () =>
    db
      .update(emailTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(emailTokens.handleId, handle.id), eq(emailTokens.kind, "move"), isNull(emailTokens.usedAt)));
  if (form.cancel === "true") {
    await db.update(handles).set({ pendingEmail: null }).where(eq(handles.id, handle.id));
    await retirePriorMoves();
    return c.redirect("/owner", 303);
  }
  const target = typeof form.email === "string" ? form.email.trim().toLowerCase() : "";
  if (!isEmail(target)) return c.redirect("/owner?error=move_email", 303);
  if (target === email) return c.redirect("/owner", 303);
  if (handle.tier === "free" && !(await emailHasRoom(db, target))) return c.redirect("/owner?error=move_limit", 303);
  await db.update(handles).set({ pendingEmail: target }).where(eq(handles.id, handle.id));
  await retirePriorMoves();
  const token = randomToken("hnm");
  await db.insert(emailTokens).values({
    handleId: handle.id,
    kind: "move",
    token,
    expiresAt: new Date(Date.now() + VERIFY_WINDOW_MS),
  });
  c.get("waitUntil")(c.get("sendEmail")({ to: target, ...moveEmailText(handle.name, `${c.get("origin")}/v/${token}`) }));
  return c.redirect("/owner", 303);
});

ownerRoutes.post("/owner/handles/:id/invite", async (c) => {
  if (!sameOrigin(c)) return c.text("forbidden", 403);
  const email = (await ownerEmail(c))?.email;
  if (!email) return c.redirect("/owner", 303);
  const id = Number(c.req.param("id"));
  const form = await c.req.parseBody();
  const [handle] = Number.isSafeInteger(id) && id > 0
    ? await c
        .get("db")
        .select()
        .from(handles)
        .where(and(eq(handles.id, id), eq(handles.email, email), isNotNull(handles.emailVerifiedAt), eq(handles.status, "active")))
        .limit(1)
    : [];
  if (!handle) return c.redirect("/owner", 303);
  const base = form.back === "profile" ? `/${handle.name}` : "/owner";
  const invite = await createInvite(c.get("db"), handle.id, c.get("origin"), null, labelOf(form.label));
  if (!invite) return c.redirect(`${base}?error=invite_limit`, 303);
  return c.redirect(`${base}?invite=${invite.token}&for=${handle.id}`, 303);
});

function planOf(handle: { tier: "free" | "paid"; paidUntil: Date | null; stripeSubscriptionId: string | null }) {
  if (handle.tier !== "paid" || !handle.paidUntil) return { kind: "free" as const };
  return {
    kind: "paid" as const,
    paidUntil: handle.paidUntil,
    daysLeft: daysLeft(handle.paidUntil),
    autoRenew: handle.stripeSubscriptionId !== null,
  };
}

ownerRoutes.post("/owner/handles/:id/billing", async (c) => {
  if (!sameOrigin(c)) return c.text("forbidden", 403);
  const handle = await ownedHandle(c, Number(c.req.param("id")));
  if (!handle) return c.redirect("/owner", 303);
  const key = c.env?.STRIPE_SECRET_KEY;
  if (!key || !handle.stripeCustomerId) return c.redirect("/owner?error=billing", 303);
  try {
    const url = await createBillingPortal(stripeClient(key), handle.stripeCustomerId, `${c.get("origin")}/owner`);
    return c.redirect(url, 303);
  } catch (err) {
    console.error("billing portal", err);
    return c.redirect("/owner?error=billing", 303);
  }
});

// Auto-renew for a name paid one year at a time (MPP). The subscription's
// first charge lands when the current paid period ends.
ownerRoutes.post("/owner/handles/:id/auto-renew", async (c) => {
  if (!sameOrigin(c)) return c.text("forbidden", 403);
  const handle = await ownedHandle(c, Number(c.req.param("id")));
  if (!handle) return c.redirect("/owner", 303);
  const key = c.env?.STRIPE_SECRET_KEY;
  const priceCents = priceCentsFor(handle.name);
  if (!key || handle.tier !== "paid" || priceCents === 0) return c.redirect("/owner?error=billing", 303);
  if (handle.stripeSubscriptionId) return c.redirect("/owner", 303);
  const origin = c.get("origin");
  try {
    const url = await createSubscriptionCheckout(stripeClient(key), {
      handle,
      priceCents,
      startAtPaidUntil: true,
      successUrl: `${origin}/owner?renew=on`,
      cancelUrl: `${origin}/owner`,
    });
    return c.redirect(url, 303);
  } catch (err) {
    console.error("auto-renew checkout", err);
    return c.redirect("/owner?error=billing", 303);
  }
});

function backTo(value: unknown): string {
  return typeof value === "string" && /^\/[a-z0-9][a-z0-9-]{1,31}$/.test(value) ? value : "/owner";
}

async function ownedHandle(c: Context<AppEnv>, id: number) {
  const email = (await ownerEmail(c))?.email;
  if (!email || !Number.isSafeInteger(id) || id <= 0) return null;
  const [handle] = await c
    .get("db")
    .select()
    .from(handles)
    .where(and(eq(handles.id, id), eq(handles.email, email), isNotNull(handles.emailVerifiedAt), eq(handles.status, "active")))
    .limit(1);
  return handle ?? null;
}

// "Message me" on someone else's profile: make a link from one of my bots
// to theirs — a 1:1 invite, or a new group with the first invite in it.
ownerRoutes.post("/owner/message-link", async (c) => {
  if (!sameOrigin(c)) return c.text("forbidden", 403);
  const form = await c.req.parseBody();
  const to = typeof form.to === "string" ? form.to.trim().toLowerCase() : "";
  const back = backTo(`/${to}`);
  const from = await ownedHandle(c, Number(form.from));
  if (!from) return c.redirect("/owner", 303);
  if (from.name === to) return c.redirect(back, 303);
  const db = c.get("db");
  const origin = c.get("origin");
  if (form.kind === "group") {
    const name = groupName(form.group_name) ?? `${from.name} & ${to}`;
    const created = await createGroup(db, from.id, name, to);
    return c.redirect(`${back}?glink=${created.invite.token}&group=${created.publicId}`, 303);
  }
  const message = inviteMessageOf(form.message);
  const invite = await createInvite(db, from.id, origin, message, to);
  if (!invite) return c.redirect(`${back}?error=invite_limit`, 303);
  return c.redirect(`${back}?link=${invite.token}&for=${from.id}`, 303);
});

ownerRoutes.post("/owner/groups/:publicId/invite", async (c) => {
  if (!sameOrigin(c)) return c.text("forbidden", 403);
  const email = (await ownerEmail(c))?.email;
  if (!email) return c.redirect("/owner", 303);
  const form = await c.req.parseBody();
  const back = backTo(form.back);
  const [row] = await c
    .get("db")
    .select({ id: groups.id, publicId: groups.publicId, ownerId: groups.ownerId })
    .from(groups)
    .innerJoin(handles, eq(handles.id, groups.ownerId))
    .where(and(eq(groups.publicId, c.req.param("publicId")), eq(handles.email, email), isNotNull(handles.emailVerifiedAt)))
    .limit(1);
  if (!row) return c.redirect(back, 303);
  const invite = await createGroupInvite(c.get("db"), row.id, row.ownerId, labelOf(form.label));
  return c.redirect(`${back}?glink=${invite.token}&group=${row.publicId}`, 303);
});

ownerRoutes.post("/owner/handles/:id/groups", async (c) => {
  if (!sameOrigin(c)) return c.text("forbidden", 403);
  const handle = await ownedHandle(c, Number(c.req.param("id")));
  if (!handle) return c.redirect("/owner", 303);
  const form = await c.req.parseBody();
  const name = groupName(form.name);
  if (!name) return c.redirect("/owner?error=group_name", 303);
  const created = await createGroup(c.get("db"), handle.id, name);
  return c.redirect(`/owner?glink=${created.invite.token}&group=${created.publicId}`, 303);
});

ownerRoutes.post("/owner/invites/:id/revoke", async (c) => {
  if (!sameOrigin(c)) return c.text("forbidden", 403);
  const email = (await ownerEmail(c))?.email;
  if (!email) return c.redirect("/owner", 303);
  const id = Number(c.req.param("id"));
  const [row] = Number.isSafeInteger(id) && id > 0
    ? await c
        .get("db")
        .select({ id: invites.id, handleId: invites.creatorId })
        .from(invites)
        .innerJoin(handles, eq(handles.id, invites.creatorId))
        .where(and(eq(invites.id, id), eq(handles.email, email), isNotNull(handles.emailVerifiedAt)))
        .limit(1)
    : [];
  if (!row) return c.redirect("/owner", 303);
  await c
    .get("db")
    .update(invites)
    .set({ expiresAt: new Date() })
    .where(and(eq(invites.id, row.id), isNull(invites.redeemedAt), gt(invites.expiresAt, new Date())));
  return c.redirect(`/owner?links=${row.handleId}`, 303);
});

// Revoking a reusable group link leaves the group intact. The next
// "Invite to group" click creates a fresh link directly.
ownerRoutes.post("/owner/group-invites/:id/revoke", async (c) => {
  if (!sameOrigin(c)) return c.text("forbidden", 403);
  const email = (await ownerEmail(c))?.email;
  if (!email) return c.redirect("/owner", 303);
  const id = Number(c.req.param("id"));
  const [row] = Number.isSafeInteger(id) && id > 0
    ? await c
        .get("db")
        .select({ id: groupInvites.id, handleId: groups.ownerId })
        .from(groupInvites)
        .innerJoin(groups, eq(groups.id, groupInvites.groupId))
        .innerJoin(handles, eq(handles.id, groups.ownerId))
        .where(and(eq(groupInvites.id, id), eq(handles.email, email), isNotNull(handles.emailVerifiedAt)))
        .limit(1)
    : [];
  if (!row) return c.redirect("/owner", 303);
  await c
    .get("db")
    .update(groupInvites)
    .set({ expiresAt: new Date() })
    .where(and(eq(groupInvites.id, row.id), isNull(groupInvites.redeemedAt), gt(groupInvites.expiresAt, new Date())));
  return c.redirect(`/owner?links=${row.handleId}`, 303);
});

ownerRoutes.post("/owner/invites/:token/accept", async (c) => {
  if (!sameOrigin(c)) return c.text("forbidden", 403);
  const token = c.req.param("token");
  const form = await c.req.parseBody();
  const me = await ownedHandle(c, Number(form.handle_id));
  if (!me) return c.redirect(`/i/${token}`, 303);
  const result = await acceptInvite(c, c.get("db"), me, token);
  if (isFailure(result)) return c.redirect(`/i/${token}?error=${result.error}`, 303);
  return c.redirect(`/i/${token}?accepted=${me.name}`, 303);
});

ownerRoutes.post("/owner/group-invites/:token/join", async (c) => {
  if (!sameOrigin(c)) return c.text("forbidden", 403);
  const token = c.req.param("token");
  const form = await c.req.parseBody();
  const me = await ownedHandle(c, Number(form.handle_id));
  if (!me) return c.redirect(`/g/${token}`, 303);
  const result = await joinGroup(c, c.get("db"), me, token);
  if (isFailure(result)) return c.redirect(`/g/${token}?error=${result.error}`, 303);
  return c.redirect(`/g/${token}?joined=${me.name}`, 303);
});

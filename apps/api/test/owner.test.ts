import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { groupInvites, handles, invites, messagePayloads, messages, messageTranscripts } from "../src/db/schema";
import { call, connect, makeTestApp, signup, type TestApp } from "./helpers";

function linkFrom(text: string, prefix: string): string {
  const match = text.match(new RegExp(`https?://[^/]+(${prefix}[\\w-]+)`));
  if (!match) throw new Error(`no ${prefix} link in: ${text}`);
  return match[1]!;
}

async function verifyLatest(app: TestApp, text: string): Promise<void> {
  const response = await app.request(`http://hi.test${linkFrom(text, "/v/")}`);
  expect(response.status).toBe(200);
}

const form = (body: string) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body,
});

// Request a magic link, follow it through the confirm page, return the session cookie.
async function signIn(app: TestApp, sent: { text: string }[], email: string): Promise<string> {
  sent.length = 0;
  const request = await app.request("http://hi.test/owner/login", form("email=" + encodeURIComponent(email)));
  expect(request.status).toBe(200);
  expect(sent).toHaveLength(1);
  const confirmPath = linkFrom(sent[0]!.text, "/owner/l/");
  const landing = await app.request(`http://hi.test${confirmPath}`);
  expect(landing.status).toBe(200);
  expect(landing.headers.get("set-cookie")).toBeNull();
  const html = await landing.text();
  expect(html).toContain("Open your dashboard?");
  const verify = html.match(/href="([^"]*magic-link\/verify[^"]*)"/)![1]!.replace(/&amp;/g, "&");
  const verified = await app.request(`http://hi.test${verify}`, { redirect: "manual" });
  expect(verified.status).toBe(302);
  const setCookie = verified.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(",").map((c) => c.split(";", 1)[0]!.trim()).find((c) => c.includes("session_token=") && !c.endsWith("="));
  expect(cookie).toBeDefined();
  // Second use of the same link is refused.
  const again = await app.request(`http://hi.test${verify}`, { redirect: "manual" });
  expect(again.headers.get("location") ?? "").toContain("error");
  return cookie!;
}

describe("owner dashboard", () => {
  const post = (cookie: string, body: string) => ({
    ...form(body),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    redirect: "manual" as const,
  });
  const page = async (app: TestApp, path: string, cookie?: string) =>
    (await app.request(`http://hi.test${path}`, cookie ? { headers: { cookie } } : undefined)).text();

  test("Message me: a link from my bot, approved by the other owner in one click, opener delivered", async () => {
    const { app, db, sent } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    await verifyLatest(app, sent.at(-1)!.text);
    await signup(app, "alice-sidekick", { email: "alice-bot@owners.example" });
    await verifyLatest(app, sent.at(-1)!.text);
    const bob = await signup(app, "bob-bot");
    await verifyLatest(app, sent.at(-1)!.text);
    const [aliceRow] = await db.select({ id: handles.id }).from(handles).where(eq(handles.name, "alice-bot"));
    const [sidekickRow] = await db.select({ id: handles.id }).from(handles).where(eq(handles.name, "alice-sidekick"));
    const [bobRow] = await db.select({ id: handles.id }).from(handles).where(eq(handles.name, "bob-bot"));

    const bobCookie = await signIn(app, sent, "bob-bot@owners.example");
    const visitor = await page(app, "/alice-bot", bobCookie);
    expect(visitor).toContain("Message me");
    expect(visitor).toContain('name="from" value="' + bobRow!.id + '"');
    const made = await app.request(
      "http://hi.test/owner/message-link",
      post(bobCookie, `from=${bobRow!.id}&to=alice-bot&kind=dm&message=${encodeURIComponent("hey, Friday?")}`),
    );
    expect(made.status).toBe(303);
    const location = made.headers.get("location")!;
    expect(location).toMatch(/^\/alice-bot\?link=hni_[\w-]+&for=\d+$/);
    const token = location.match(/link=(hni_[\w-]+)/)![1]!;
    const ready = await page(app, location, bobCookie);
    expect(ready).toContain(`http://hi.test/i/${token}`);

    const anonLink = await page(app, `/i/${token}`);
    expect(anonLink).toContain("Connect these bots?");
    expect(anonLink).toContain("no name yet");
    expect(anonLink).toContain(`href="/?link=${token}&amp;from=bob-bot"`);
    expect(anonLink).toContain("Get your bot a name");
    expect(anonLink).toContain(`href="/owner?next=${encodeURIComponent(`/i/${token}`)}"`);
    expect(anonLink).toContain("Already have a bot? Sign in");
    expect(anonLink).not.toContain("Sign in to continue");
    expect(anonLink).toContain("Copy for your bot");
    expect(anonLink).toContain("data-prompt-toggle");
    expect(anonLink).toContain("Connect me to hi.new/bob-bot:");
    expect(anonLink).toContain(`http://hi.test/i/${token}.md`);
    expect(anonLink).toContain("bob-bot");
    expect(anonLink).toContain("hey, Friday?");
    expect(anonLink).not.toContain("Need a name? POST");
    expect(anonLink).not.toContain('action="/owner/invites');

    // The bot that made the invite cannot accept it. Its owner gets the share action instead.
    const ownLink = await page(app, `/i/${token}`, bobCookie);
    expect(ownLink).toContain("Send this invite to someone else");
    expect(ownLink).toContain("Copy invite link");
    expect(ownLink).not.toContain('action="/owner/invites');

    const aliceCookie = await signIn(app, sent, "alice-bot@owners.example");
    const linkPage = await page(app, `/i/${token}`, aliceCookie);
    expect(linkPage).toContain("Approve");
    expect(linkPage).toContain('select name="handle_id"');
    expect(linkPage).toContain(`<option value="${aliceRow!.id}"`);
    expect(linkPage).toContain(">alice-bot</option>");
    expect(linkPage).toContain(`<option value="${sidekickRow!.id}"`);
    expect(linkPage).toContain(">alice-sidekick</option>");
    const approved = await app.request(`http://hi.test/owner/invites/${token}/accept`, post(aliceCookie, `handle_id=${aliceRow!.id}`));
    expect(approved.headers.get("location")).toBe(`/i/${token}?accepted=alice-bot`);
    expect(await page(app, `/i/${token}?accepted=alice-bot`, aliceCookie)).toContain("can message each other");

    // Grant exists both ways; the opener landed in alice's inbox; bob's bot was told.
    const dm = await call(app, "POST", "/api/dm/bob-bot", { token: alice.token, body: { body: "yes", enc: "none" } });
    expect(dm.status).toBe(201);
    const aliceInbox = await call(app, "GET", "/api/inbox", { token: alice.token });
    expect(JSON.stringify(aliceInbox.json)).toContain("hey, Friday?");
    const bobInbox = await call(app, "GET", "/api/inbox", { token: bob.token });
    expect(JSON.stringify(bobInbox.json)).toContain("invite.redeemed");

    const again = await app.request(`http://hi.test/owner/invites/${token}/accept`, post(aliceCookie, `handle_id=${aliceRow!.id}`));
    expect(again.headers.get("location")).toBe(`/i/${token}?error=invite_already_used`);
    // A bot can't accept its own link, and a stranger's session can't act for alice.
    const carolCookie = await signIn(app, sent, "carol@owners.example");
    const notMine = await app.request(`http://hi.test/owner/invites/${token}/accept`, post(carolCookie, `handle_id=${aliceRow!.id}`));
    expect(notMine.headers.get("location")).toBe(`/i/${token}`);
  });

  test("Start a group from a profile; multiple owners join through the same link", async () => {
    const { app, db, sent } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    await verifyLatest(app, sent.at(-1)!.text);
    await signup(app, "bob-bot");
    await verifyLatest(app, sent.at(-1)!.text);
    const carol = await signup(app, "carol-bot");
    await verifyLatest(app, sent.at(-1)!.text);
    const [aliceRow] = await db.select({ id: handles.id }).from(handles).where(eq(handles.name, "alice-bot"));
    const [bobRow] = await db.select({ id: handles.id }).from(handles).where(eq(handles.name, "bob-bot"));
    const [carolRow] = await db.select({ id: handles.id }).from(handles).where(eq(handles.name, "carol-bot"));
    const bobCookie = await signIn(app, sent, "bob-bot@owners.example");

    const made = await app.request(
      "http://hi.test/owner/message-link",
      post(bobCookie, `from=${bobRow!.id}&to=alice-bot&kind=group&group_name=${encodeURIComponent("Dinner plans")}`),
    );
    const location = made.headers.get("location")!;
    expect(location).toMatch(/^\/alice-bot\?glink=hngi_[\w-]+&group=hng_[\w-]+$/);
    const token = location.match(/glink=(hngi_[\w-]+)/)![1]!;
    const publicId = location.match(/group=(hng_[\w-]+)/)![1]!;
    const ready = await page(app, location, bobCookie);
    expect(ready).not.toContain("Link for another bot");

    const anonGroup = await page(app, `/g/${token}`);
    expect(anonGroup).toContain("Need a name? POST http://hi.test/api/handles");
    const aliceCookie = await signIn(app, sent, "alice-bot@owners.example");
    expect(await page(app, `/g/${token}`, aliceCookie)).toContain("invited your bot to “Dinner plans”");
    const joined = await app.request(`http://hi.test/owner/group-invites/${token}/join`, post(aliceCookie, `handle_id=${aliceRow!.id}`));
    expect(joined.headers.get("location")).toBe(`/g/${token}?joined=alice-bot`);
    expect(await page(app, `/g/${token}?joined=alice-bot`, aliceCookie)).toContain("alice-bot is in “Dinner plans”");
    const groupsForAlice = await call(app, "GET", "/api/groups", { token: alice.token });
    expect(JSON.stringify(groupsForAlice.json)).toContain("Dinner plans");
    const carolCookie = await signIn(app, sent, "carol-bot@owners.example");
    expect(await page(app, `/g/${token}`, carolCookie)).toContain("invited your bot to “Dinner plans”");
    const carolJoined = await app.request(`http://hi.test/owner/group-invites/${token}/join`, post(carolCookie, `handle_id=${carolRow!.id}`));
    expect(carolJoined.headers.get("location")).toBe(`/g/${token}?joined=carol-bot`);
    expect(JSON.stringify((await call(app, "GET", "/api/groups", { token: carol.token })).json)).toContain("Dinner plans");

    const more = await app.request(`http://hi.test/owner/groups/${publicId}/invite`, post(bobCookie, "back=/alice-bot"));
    expect(more.headers.get("location")).toMatch(/^\/alice-bot\?glink=hngi_[\w-]+&group=hng_/);
    const notOwner = await app.request(`http://hi.test/owner/groups/${publicId}/invite`, post(aliceCookie, "back=/alice-bot"));
    expect(notOwner.headers.get("location")).toBe("/alice-bot");

    const dash = await page(app, "/owner", bobCookie);
    expect(dash).toContain("Dinner plans");
    expect(dash).toContain("3 members");
    expect(dash).not.toContain("Not opened yet");
    const fresh = await app.request(`http://hi.test/owner/handles/${bobRow!.id}/groups`, post(bobCookie, "name=Book+club"));
    expect(fresh.headers.get("location")).toMatch(/^\/owner\?glink=hngi_/);
    const groupMessage = await page(app, fresh.headers.get("location")!, bobCookie);
    expect(groupMessage).toContain("Send this to them");
    expect(groupMessage).toContain("Group: Book club");
    expect(groupMessage).toContain("Hey, I’d like your bot to join “Book club”.");
    expect(groupMessage).toContain("Active invite links");
    expect(groupMessage).toContain("Revoke");
    expect(groupMessage).not.toContain("Replace link");
    expect(groupMessage).not.toContain("Invite another bot");
    expect(groupMessage).not.toContain("Make another message");
    expect(groupMessage).not.toContain("1 member, no messages yet");
    expect(groupMessage).not.toContain(">1 member<");
    expect(groupMessage).not.toContain("Not opened yet");

    // Revocation lives in link management. Afterward the row creates its
    // replacement directly, with no intermediate modal.
    const freshLocation = fresh.headers.get("location")!;
    const bookToken = freshLocation.match(/glink=(hngi_[\w-]+)/)![1]!;
    const bookPublicId = freshLocation.match(/group=(hng_[\w-]+)/)![1]!;
    const [bookInvite] = await db.select({ id: groupInvites.id }).from(groupInvites).where(eq(groupInvites.token, bookToken));
    const revoked = await app.request(`http://hi.test/owner/group-invites/${bookInvite!.id}/revoke`, post(bobCookie, ""));
    expect(revoked.headers.get("location")).toBe(`/owner?links=${bobRow!.id}`);
    expect(await page(app, `/g/${bookToken}`)).toContain("Link unavailable");
    const revokedDashboard = await page(app, "/owner", bobCookie);
    expect(revokedDashboard).toContain(`form="create-glink-${bookPublicId}"`);
    expect(revokedDashboard).not.toContain("Create an invite link to share.");
  });

  test("the owner makes invite links from the dashboard and their own profile, without the bot", async () => {
    const { app, db, sent } = await makeTestApp();
    await signup(app, "alice-bot");
    await verifyLatest(app, sent.at(-1)!.text);
    const bob = await signup(app, "bob-bot", { color: "coral" });
    const cookie = await signIn(app, sent, "alice-bot@owners.example");
    const [row] = await db.select({ id: handles.id }).from(handles).where(eq(handles.name, "alice-bot"));

    const made = await app.request(`http://hi.test/owner/handles/${row!.id}/invite`, {
      ...form(""),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      redirect: "manual",
    });
    expect(made.status).toBe(303);
    const location = made.headers.get("location")!;
    expect(location).toMatch(/^\/owner\?invite=hni_[\w-]+&for=\d+$/);
    const dashboard = await (await app.request(`http://hi.test${location}`, { headers: { cookie } })).text();
    const url = dashboard.match(/http:\/\/hi\.test\/i\/(hni_[\w-]+)/)!;
    expect(url).toBeTruthy();
    expect(dashboard).toContain("Send this to them");
    expect(dashboard).toContain("Hey, I’d like our bots to chat.");
    expect(dashboard).toContain('data-copy="');
    expect(dashboard).toContain("Active invite links");
    expect(dashboard).toContain("Bot invite");
    expect(dashboard).toContain("Revoke");
    expect(dashboard).not.toContain("Not opened yet");

    const redeem = await call(app, "POST", `/api/invites/${url[1]}/redeem`, { token: bob.token });
    expect(redeem.status).toBe(200);
    expect(redeem.json.granted).toBe(true);
    expect(redeem.json.peer.name).toBe("alice-bot");

    const connectedDashboard = await page(app, "/owner", cookie);
    expect(connectedDashboard).toContain('<span class="convo-name mono">bob-bot</span>');
    expect(connectedDashboard).toContain('<a href="/bob-bot">hi.new/bob-bot</a>');
    expect(connectedDashboard).toContain('/img/p962491.png');

    const ownProfile = await (await app.request("http://hi.test/alice-bot", { headers: { cookie } })).text();
    expect(ownProfile).toContain("Invite a bot");
    expect(ownProfile).not.toContain("Message me");
    const fromProfile = await app.request(`http://hi.test/owner/handles/${row!.id}/invite`, {
      ...form("back=profile"),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      redirect: "manual",
    });
    expect(fromProfile.headers.get("location")).toMatch(/^\/alice-bot\?invite=hni_/);
    const profileToken = fromProfile.headers.get("location")!.match(/invite=(hni_[\w-]+)/)![1]!;
    const [profileInvite] = await db.select({ id: invites.id }).from(invites).where(eq(invites.token, profileToken));
    const revoked = await app.request(`http://hi.test/owner/invites/${profileInvite!.id}/revoke`, post(cookie, ""));
    expect(revoked.headers.get("location")).toBe(`/owner?links=${row!.id}`);
    expect(await page(app, `/i/${profileToken}`)).toContain("Link unavailable");
    const anon = await (await app.request("http://hi.test/alice-bot")).text();
    expect(anon).toContain("Message me");
    expect(anon).not.toContain("Invite a bot");

    const [bobRow] = await db.select({ id: handles.id }).from(handles).where(eq(handles.name, "bob-bot"));
    const notMine = await app.request(`http://hi.test/owner/handles/${bobRow!.id}/invite`, {
      ...form(""),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      redirect: "manual",
    });
    expect(notMine.headers.get("location")).toBe("/owner");
  });

  test("a verified owner email is locked to the bot token; the owner moves it from the dashboard", async () => {
    const { app, db, sent } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    await verifyLatest(app, sent.at(-1)!.text);

    // The bot's token cannot re-point the owner email once it is verified.
    const hijack = await call(app, "PATCH", "/api/handles/me", { token: alice.token, body: { email: "mallory@owners.example" } });
    expect(hijack.status).toBe(403);
    expect(hijack.json.error).toBe("email_locked");
    const me = await call(app, "GET", "/api/handles/me", { token: alice.token });
    expect(me.json.email).toBe("alice-bot@owners.example");
    expect(me.json.email_verified).toBe(true);

    // Before verification the bot may still fix a typo.
    const bob = await signup(app, "bob-bot");
    const fix = await call(app, "PATCH", "/api/handles/me", { token: bob.token, body: { email: "bob-fixed@owners.example" } });
    expect(fix.status).toBe(200);

    // The owner asks to move the handle; nothing changes until the new address clicks.
    const cookie = await signIn(app, sent, "alice-bot@owners.example");
    const [row] = await db.select({ id: handles.id }).from(handles).where(eq(handles.name, "alice-bot"));
    sent.length = 0;
    const move = await app.request(`http://hi.test/owner/handles/${row!.id}/email`, {
      ...form("email=" + encodeURIComponent("Carol@owners.example")),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      redirect: "manual",
    });
    expect(move.status).toBe(303);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("carol@owners.example");
    expect(sent[0]!.subject).toContain("Take over hi.new/alice-bot");
    let dashboard = await (await app.request("http://hi.test/owner", { headers: { cookie } })).text();
    expect(dashboard).toContain('href="/alice-bot"');
    expect(dashboard).toContain("Moving to");
    expect(dashboard).toContain("carol@owners.example");
    const firstLink = linkFrom(sent[0]!.text, "/v/");

    const cancel = await app.request(`http://hi.test/owner/handles/${row!.id}/email`, {
      ...form("cancel=true"),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      redirect: "manual",
    });
    expect(cancel.status).toBe(303);
    expect((await app.request(`http://hi.test${firstLink}`)).status).toBe(410);
    dashboard = await (await app.request("http://hi.test/owner", { headers: { cookie } })).text();
    expect(dashboard).not.toContain("Moving to");

    sent.length = 0;
    await app.request(`http://hi.test/owner/handles/${row!.id}/email`, {
      ...form("email=" + encodeURIComponent("carol@owners.example")),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      redirect: "manual",
    });
    const secondLink = linkFrom(sent[0]!.text, "/v/");
    const done = await app.request(`http://hi.test${secondLink}`);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("hi.new/alice-bot is yours");
    const after = await call(app, "GET", "/api/handles/me", { token: alice.token });
    expect(after.json.email).toBe("carol@owners.example");
    expect(after.json.email_verified).toBe(true);
    dashboard = await (await app.request("http://hi.test/owner", { headers: { cookie } })).text();
    expect(dashboard).not.toContain('href="/alice-bot"');
    const carol = await signIn(app, sent, "carol@owners.example");
    expect(await (await app.request("http://hi.test/owner", { headers: { cookie: carol } })).text()).toContain('href="/alice-bot"');
    expect((await app.request(`http://hi.test${secondLink}`)).status).toBe(410);
  });

  test("static pages can ask whether an owner is signed in", async () => {
    const { app, sent } = await makeTestApp();
    await signup(app, "alice-bot");
    await verifyLatest(app, sent.at(-1)!.text);
    const anon = await app.request("http://hi.test/api/owner/session");
    expect(anon.headers.get("cache-control")).toBe("private, no-store");
    expect((await anon.json()) as { signed_in: boolean; bots: unknown[] }).toMatchObject({ signed_in: false, bots: [] });
    const cookie = await signIn(app, sent, "alice-bot@owners.example");
    const signedIn = await app.request("http://hi.test/api/owner/session", { headers: { cookie } });
    expect((await signedIn.json()) as { signed_in: boolean; bots: unknown[] }).toMatchObject({ signed_in: true, bots: [{ name: "alice-bot" }] });
    const ownProfile = await app.request("http://hi.test/api/owner/session?handle=alice-bot", { headers: { cookie } });
    expect((await ownProfile.json()) as { signed_in: boolean; owns_handle: boolean }).toMatchObject({ signed_in: true, owns_handle: true });
    const otherProfile = await app.request("http://hi.test/api/owner/session?handle=other-bot", { headers: { cookie } });
    expect((await otherProfile.json()) as { signed_in: boolean; owns_handle: boolean }).toMatchObject({ signed_in: true, owns_handle: false });
  });

  test("claiming while signed in attaches the session email, already verified", async () => {
    const { app, sent } = await makeTestApp();
    await signup(app, "alice-bot", { email: "alice-bot@owners.example" });
    const cookie = await signIn(app, sent, "alice-bot@owners.example");
    sent.length = 0;

    const claim = await app.request("http://hi.test/api/handles", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "alice-third" }),
    });
    expect(claim.status).toBe(201);
    const body = (await claim.json()) as { email: string; email_verified: boolean; token: string };
    expect(body.email).toBe("alice-bot@owners.example");
    expect(body.email_verified).toBe(true);
    expect(sent).toHaveLength(0);

    const me = await app.request("http://hi.test/api/handles/me", { headers: { authorization: `Bearer ${body.token}` } });
    expect(((await me.json()) as { email_verified: boolean }).email_verified).toBe(true);
    const dashboard = await app.request("http://hi.test/owner", { headers: { cookie } });
    expect(await dashboard.text()).toContain('href="/alice-third"');

    // An explicit email in the body still wins over the session.
    const other = await app.request("http://hi.test/api/handles", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "alice-fourth", email: "someone-else@owners.example" }),
    });
    const otherBody = (await other.json()) as { email: string; email_verified: boolean };
    expect(otherBody.email).toBe("someone-else@owners.example");
    expect(otherBody.email_verified).toBe(false);
    expect(sent).toHaveLength(1);
  });

  test("magic link sign-in is scanner-safe, verifies the email, and lists every handle on it", async () => {
    const { app, sent } = await makeTestApp();
    await signup(app, "alice-bot");
    await signup(app, "alice-sidekick", { email: "alice-bot@owners.example" });
    // Neither handle clicked its verify link. Signing in as the owner proves
    // the mailbox, which verifies both.
    const cookie = await signIn(app, sent, "alice-bot@owners.example");

    const dashboard = await app.request("http://hi.test/owner", { headers: { cookie } });
    const html = await dashboard.text();
    expect(dashboard.headers.get("cache-control")).toBe("private, no-store");
    expect(html).toContain('href="/alice-bot"');
    expect(html).toContain('href="/alice-sidekick"');
    expect(html).toContain('href="/owner" data-owner-link="">Dashboard</a>');
  });

  test("any email can sign in; with no bots attached it gets the empty state", async () => {
    const { app, sent } = await makeTestApp();
    const cookie = await signIn(app, sent, "nobody@owners.example");
    const dashboard = await app.request("http://hi.test/owner", { headers: { cookie } });
    const html = await dashboard.text();
    expect(html).toContain("No bots here yet");
    expect(html).toContain("Add nobody@owners.example as my owner email on hi.new.");

    const out = await app.request("http://hi.test/owner/logout", { method: "POST", headers: { cookie } });
    expect(out.status).toBe(303);
    const after = await app.request("http://hi.test/owner", { headers: { cookie } });
    expect(await after.text()).toContain("Email me a sign-in link");
  });

  test("login page: no provider buttons without credentials; bad email and expired links explain themselves", async () => {
    const { app } = await makeTestApp();
    const page = await (await app.request("http://hi.test/owner")).text();
    expect(page).not.toContain("Continue with GitHub");
    expect(page).toContain("Email me a sign-in link");
    const bad = await app.request("http://hi.test/owner/login", form("email=nope"));
    expect(bad.status).toBe(303);
    expect(bad.headers.get("location")).toBe("/owner?error=email");
    const gone = await app.request("http://hi.test/owner/l/not-a-real-token");
    expect(gone.status).toBe(410);
    expect(await gone.text()).toContain("Link unavailable");
    // Cross-site form posts are refused.
    const csrf = await app.request("http://hi.test/owner/login", {
      ...form("email=a%40b.co"),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
    });
    expect(csrf.status).toBe(403);

    // Wrangler rewrites the request/Origin host to the custom domain in local
    // dev, while APP_ORIGIN stays on localhost for OAuth callbacks.
    const proxied = await app.request(
      "http://hi.test/owner/login",
      {
        ...form("email=a%40b.co"),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://hi.test" },
      },
      { APP_ORIGIN: "http://localhost:8787" },
    );
    expect(proxied.status).toBe(200);

    // Browser privacy features may redact Origin to `null`; Fetch Metadata is
    // the authoritative same-origin signal when the browser supplies it.
    const opaqueOrigin = await app.request(
      "http://hi.test/owner/login",
      {
        ...form("email=a%40b.co"),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "null",
          "sec-fetch-site": "same-origin",
        },
      },
      { APP_ORIGIN: "http://localhost:8787" },
    );
    expect(opaqueOrigin.status).toBe(200);
  });

  test("deletes payloads but retains audit, with configurable plaintext transcripts", async () => {
    const { app, db, sent } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const bob = await signup(app, "bob-bot");
    await verifyLatest(app, sent[0]!.text);
    const cookie = await signIn(app, sent, "alice-bot@owners.example");
    await connect(app, alice, bob);

    const [aliceRow] = await db.select().from(handles).where(eq(handles.name, "alice-bot"));
    expect(aliceRow!.transcriptRetentionDays).toBe(90);
    await app.request(`http://hi.test/owner/handles/${aliceRow!.id}/transcripts`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: "enabled=false",
    });

    const first = await call(app, "POST", "/api/dm/alice-bot", {
      token: bob.token,
      body: { body: "visible while queued", enc: "none" },
    });
    let dashboard = await app.request("http://hi.test/owner", { headers: { cookie } });
    expect(await dashboard.text()).toContain("visible while queued");
    const ack = await app.request(`http://hi.test/owner/messages/${first.json.id}/ack`, {
      method: "POST",
      headers: { cookie },
    });
    expect(ack.status).toBe(303);
    expect(
      await db.select().from(messagePayloads).where(eq(messagePayloads.messageId, first.json.id)),
    ).toHaveLength(0);
    const [audit] = await db.select().from(messages).where(eq(messages.id, first.json.id));
    expect(audit!.acknowledgedAt).not.toBeNull();
    dashboard = await app.request("http://hi.test/owner", { headers: { cookie } });
    const afterAck = await dashboard.text();
    expect(afterAck).not.toContain("visible while queued");
    expect(afterAck).toContain("read and deleted");

    await app.request(`http://hi.test/owner/handles/${aliceRow!.id}/transcripts`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: "enabled=true",
    });
    const second = await call(app, "POST", "/api/dm/alice-bot", {
      token: bob.token,
      body: { body: "retained for the owner", enc: "none" },
    });
    await call(app, "POST", "/api/inbox/ack", {
      token: alice.token,
      body: { ids: [second.json.id] },
    });
    dashboard = await app.request("http://hi.test/owner", { headers: { cookie } });
    const retained = await dashboard.text();
    expect(retained).toContain("retained for the owner");

    await app.request(`http://hi.test/owner/handles/${aliceRow!.id}/transcripts`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: "enabled=false",
    });
    expect(
      await db.select().from(messageTranscripts).where(eq(messageTranscripts.handleId, aliceRow!.id)),
    ).toHaveLength(0);
    dashboard = await app.request("http://hi.test/owner", { headers: { cookie } });
    expect(await dashboard.text()).not.toContain("retained for the owner");
  });

  test("never exposes encrypted payload text to the owner dashboard", async () => {
    const { app, sent } = await makeTestApp();
    const alice = await signup(app, "alice-bot", { public_key: "age1alicealicealice" });
    const bob = await signup(app, "bob-bot");
    const cookie = await signIn(app, sent, "alice-bot@owners.example");
    await connect(app, alice, bob);
    await call(app, "POST", "/api/dm/alice-bot", {
      token: bob.token,
      body: { body: "armored-secret-ciphertext", enc: "age" },
    });

    const dashboard = await app.request("http://hi.test/owner", { headers: { cookie } });
    const html = await dashboard.text();
    expect(html).not.toContain("armored-secret-ciphertext");
    expect(html).toContain("Encrypted end to end");
  });
});

describe("sign-in destinations", () => {
  test("sign-in can return to a profile", async () => {
    const { app, sent } = await makeTestApp();
    await signup(app, "alice-bot");
    const login = await (await app.request("http://hi.test/owner?next=%2Falice-bot")).text();
    expect(login).toContain('name="next" value="/alice-bot"');
    expect(await (await app.request("http://hi.test/owner?next=https%3A%2F%2Fevil.example")).text()).not.toContain('name="next"');
    sent.length = 0;
    const request = await app.request("http://hi.test/owner/login", form("email=" + encodeURIComponent("v@owners.example") + "&next=%2Falice-bot"));
    expect(request.status).toBe(200);
    const confirmPath = sent[0]!.text.match(/https?:\/\/[^\s]+(\/owner\/l\/[\w-]+\?next=%2Falice-bot)/)![1]!;
    const confirm = await (await app.request(`http://hi.test${confirmPath}`)).text();
    expect(confirm).toContain("callbackURL=%2Falice-bot");
  });
});

describe("owner email moves", () => {
  test("a superseded move link cannot confirm the newer target", async () => {
    const { app, db, sent } = await makeTestApp();
    await signup(app, "alice-bot");
    await verifyLatest(app, sent.at(-1)!.text);
    const cookie = await signIn(app, sent, "alice-bot@owners.example");
    const [row] = await db.select({ id: handles.id }).from(handles).where(eq(handles.name, "alice-bot"));
    const move = (email: string) =>
      app.request(`http://hi.test/owner/handles/${row!.id}/email`, {
        ...form("email=" + encodeURIComponent(email)),
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        redirect: "manual",
      });

    sent.length = 0;
    expect((await move("carol@owners.example")).status).toBe(303);
    const carolLink = linkFrom(sent[0]!.text, "/v/");
    sent.length = 0;
    expect((await move("dave@owners.example")).status).toBe(303);
    const daveLink = linkFrom(sent[0]!.text, "/v/");

    expect((await app.request(`http://hi.test${carolLink}`)).status).toBe(410);
    let [handle] = await db.select().from(handles).where(eq(handles.id, row!.id));
    expect(handle!.email).toBe("alice-bot@owners.example");
    expect(handle!.pendingEmail).toBe("dave@owners.example");

    expect((await app.request(`http://hi.test${daveLink}`)).status).toBe(200);
    [handle] = await db.select().from(handles).where(eq(handles.id, row!.id));
    expect(handle!.email).toBe("dave@owners.example");
    expect(handle!.pendingEmail).toBeNull();
  });
});

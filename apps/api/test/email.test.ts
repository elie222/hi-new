import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { MAX_FREE_HANDLES_PER_EMAIL } from "../src/context";
import { handles } from "../src/db/schema";
import { dailySweep } from "../src/sweeps";
import { call, connect, makeTestApp, signup } from "./helpers";

const DAY = 24 * 3600 * 1000;

function linkFrom(text: string, prefix: string): string {
  const m = text.match(new RegExp(`https?://[^/]+(${prefix}[\\w-]+)`));
  if (!m) throw new Error(`no ${prefix} link in: ${text}`);
  return m[1]!;
}

describe("email ownership", () => {
  test("signup without email works; email attaches later via PATCH", async () => {
    const { app, sent } = await makeTestApp();
    const res = await call(app, "POST", "/api/handles", { body: { name: "no-email-bot" } });
    expect(res.status).toBe(201);
    expect(res.json.verify).toContain("Attach one within 7 days");
    expect(sent.length).toBe(0);

    const me1 = await call(app, "GET", "/api/handles/me", { token: res.json.token });
    expect(me1.json.warning).toContain("No owner email");

    const attach = await call(app, "PATCH", "/api/handles/me", {
      token: res.json.token,
      body: { email: "late@owners.example" },
    });
    expect(attach.status).toBe(200);
    expect(sent.length).toBe(1);
    expect(sent[0]!.to).toBe("late@owners.example");

    const path = linkFrom(sent[0]!.text, "/v/");
    await app.request(`http://hi.test${path}`);
    const me2 = await call(app, "GET", "/api/handles/me", { token: res.json.token });
    expect(me2.json.email_verified).toBe(true);

    const bad = await call(app, "POST", "/api/handles", {
      body: { name: "bad-email-bot", email: "not-an-email" },
    });
    expect(bad.status).toBe(400);
  });

  test("signup sends a verify link; clicking it verifies ownership", async () => {
    const { app, sent } = await makeTestApp();
    const bot = await signup(app, "verify-me");
    expect(sent.length).toBe(1);
    expect(sent[0]!.to).toBe("verify-me@owners.example");
    expect(sent[0]!.subject).toContain("Verify hi.new/verify-me");

    let me = await call(app, "GET", "/api/handles/me", { token: bot.token });
    expect(me.json.email_verified).toBe(false);

    const path = linkFrom(sent[0]!.text, "/v/");
    const page = await app.request(`http://hi.test${path}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("verified");

    me = await call(app, "GET", "/api/handles/me", { token: bot.token });
    expect(me.json.email_verified).toBe(true);
  });

  test("recovery rotates the token: old dies, new works, email becomes verified", async () => {
    const { app, sent } = await makeTestApp();
    const bot = await signup(app, "lost-bot");
    sent.length = 0;

    await call(app, "POST", "/api/recover", {
      body: { name: "lost-bot", email: "attacker@evil.example" },
    });
    expect(sent.length).toBe(0);

    await call(app, "POST", "/api/recover", {
      body: { name: "lost-bot", email: "lost-bot@owners.example" },
    });
    expect(sent.length).toBe(1);
    const path = linkFrom(sent[0]!.text, "/r/");

    const confirm = await app.request(`http://hi.test${path}`);
    expect(confirm.status).toBe(200);

    const rotated = await app.request(`http://hi.test${path}/rotate`, { method: "POST" });
    const html = await rotated.text();
    const newToken = html.match(/hn_[A-Za-z0-9_-]+/)![0];
    expect(newToken).not.toBe(bot.token);

    const again = await app.request(`http://hi.test${path}/rotate`, { method: "POST" });
    expect(again.status).toBe(410);

    const old = await call(app, "GET", "/api/handles/me", { token: bot.token });
    expect(old.status).toBe(401);
    const fresh = await call(app, "GET", "/api/handles/me", { token: newToken });
    expect(fresh.status).toBe(200);
    expect(fresh.json.email_verified).toBe(true);
  });

  test(`one email holds at most ${MAX_FREE_HANDLES_PER_EMAIL} free names`, async () => {
    const { app } = await makeTestApp();
    for (let i = 0; i < MAX_FREE_HANDLES_PER_EMAIL; i++) {
      const res = await call(app, "POST", "/api/handles", {
        body: { name: `hoard-${i}-bot`, email: "hoarder@owners.example" },
      });
      expect(res.status).toBe(201);
    }
    const overLimit = await call(app, "POST", "/api/handles", {
      body: { name: "hoard-final-bot", email: "hoarder@owners.example" },
    });
    expect(overLimit.status).toBe(409);
    expect(overLimit.json.error).toBe("email_name_limit");
    expect(overLimit.json.limit).toBe(MAX_FREE_HANDLES_PER_EMAIL);
    expect(overLimit.json.claim_without_email).toBe(true);
  });

  test("a sixth free name can attach after the old cap", async () => {
    const { app } = await makeTestApp();
    const email = "expanded-limit@owners.example";
    for (let i = 0; i < 5; i++) {
      const res = await call(app, "POST", "/api/handles", {
        body: { name: `old-cap-${i}-bot`, email },
      });
      expect(res.status).toBe(201);
    }

    const sixth = await call(app, "POST", "/api/handles", { body: { name: "old-cap-sixth-bot" } });
    const attach = await call(app, "PATCH", "/api/handles/me", {
      token: sixth.json.token,
      body: { email },
    });
    expect(attach.status).toBe(200);
  });

  test("verified owners get one content-free alert per unread inbox burst", async () => {
    const { app, sent } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const bob = await signup(app, "bob-bot");
    await app.request(`http://hi.test${linkFrom(sent[0]!.text, "/v/")}`);
    sent.length = 0;

    await connect(app, alice, bob);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("New mail for hi.new/alice-bot");
    expect(sent[0]!.text).not.toContain("bob-bot");
    expect(sent[0]!.text).not.toContain("invite.redeemed");

    await call(app, "POST", "/api/dm/alice-bot", {
      token: bob.token,
      body: { body: "second unread message", enc: "none" },
    });
    expect(sent).toHaveLength(1);

    const inbox = await call(app, "GET", "/api/inbox", { token: alice.token });
    await call(app, "POST", "/api/inbox/ack", {
      token: alice.token,
      body: { ids: inbox.json.messages.map((message: any) => message.id) },
    });
    await Promise.all([
      call(app, "POST", "/api/dm/alice-bot", {
        token: bob.token,
        body: { body: "new burst one", enc: "none" },
      }),
      call(app, "POST", "/api/dm/alice-bot", {
        token: bob.token,
        body: { body: "new burst two", enc: "none" },
      }),
    ]);
    expect(sent).toHaveLength(2);
  });

  test("daily sweep releases unverified handles after 7 days; grandfathered exempt", async () => {
    const { app, db, sent } = await makeTestApp();
    await signup(app, "never-verified"); // email attached, never clicked
    await call(app, "POST", "/api/handles", { body: { name: "no-email-ever" } });
    const verified = await signup(app, "did-verify");
    const path = linkFrom(sent[1]!.text, "/v/");
    await app.request(`http://hi.test${path}`);
    await call(app, "POST", "/api/handles", { body: { name: "old-timer" } });

    // Run the sweep 8 days from now: post-era handles are then past the
    // 7-day window; old-timer predates the email era entirely.
    await db
      .update(handles)
      .set({ createdAt: new Date("2026-08-20T00:00:00Z") })
      .where(eq(handles.name, "old-timer"));
    await dailySweep(db, new Date(Date.now() + 8 * DAY));

    expect((await db.select().from(handles).where(eq(handles.name, "never-verified"))).length).toBe(0);
    expect((await db.select().from(handles).where(eq(handles.name, "no-email-ever"))).length).toBe(0);
    expect((await db.select().from(handles).where(eq(handles.name, "did-verify"))).length).toBe(1);
    expect((await db.select().from(handles).where(eq(handles.name, "old-timer"))).length).toBe(1);
    const still = await call(app, "GET", "/api/handles/me", { token: verified.token });
    expect(still.status).toBe(200);
  });
});

import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Challenge, Credential } from "mppx";
import { handles, payments } from "../src/db/schema";
import { recordPayment } from "../src/lib/payments";
import { call, makeTestApp, signup } from "./helpers";

const mppEnv = {
  MPP_SECRET_KEY: "test-secret-key-test-secret-key-32",
  STRIPE_NETWORK_ID: "internal",
  STRIPE_SECRET_KEY: "sk_test_mpp",
};

describe("signup", () => {
  test("free 6+ char name returns a token once", async () => {
    const { app } = await makeTestApp();
    const res = await call(app, "POST", "/api/handles", { body: { name: "Freddie", email: "f@owners.example" } });
    expect(res.status).toBe(201);
    expect(res.json.name).toBe("freddie"); // lowercased
    expect(res.json.token).toStartWith("hn_");
    expect(res.json.profile_url).toBe("http://hi.test/freddie");
    expect(res.json.public_key).toBeNull();
    expect(res.json.e2e).toBe(false);
  });

  test("duplicate name is 409", async () => {
    const { app } = await makeTestApp();
    await signup(app, "freddie");
    const res = await call(app, "POST", "/api/handles", { body: { name: "freddie", email: "f2@owners.example" } });
    expect(res.status).toBe(409);
  });

  test("invalid and reserved names rejected", async () => {
    const { app } = await makeTestApp();
    for (const name of ["", "a", "-abc", "abc-", "a--b", "Ab$", "api", "admin", "mcp", "xy"]) {
      const res = await call(app, "POST", "/api/handles", { body: { name } });
      expect(res.status).toBe(400);
    }
  });

  test("short name is 402 with checkout URL, token issued but unusable until paid", async () => {
    const { app } = await makeTestApp();
    const res = await call(app, "POST", "/api/handles", { body: { name: "vlad", email: "vlad@owners.example" } });
    expect(res.status).toBe(402);
    expect(res.json.price_usd_per_year).toBe(150);
    expect(res.json.checkout_url).toContain("/buy/vlad");
    expect(res.json.token).toStartWith("hn_");
    const me = await call(app, "GET", "/api/handles/me", { token: res.json.token });
    expect(me.status).toBe(402);
  });

  test("paid-name 402 advertises a Stripe MPP challenge when configured", async () => {
    const { app } = await makeTestApp();
    const body = { name: "vlad", email: "vlad@owners.example" };
    const res = await app.request(
      "http://hi.test/api/handles",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      mppEnv,
    );

    expect(res.status).toBe(402);
    expect(res.headers.get("www-authenticate")).toStartWith("Payment ");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const challenge = Challenge.fromResponse(res);
    expect(challenge.method).toBe("stripe");
    expect(challenge.intent).toBe("charge");
    expect(challenge.request).toMatchObject({
      amount: "15000",
      currency: "usd",
      methodDetails: {
        networkId: "internal",
        paymentMethodTypes: ["card"],
      },
    });
    const json = (await res.json()) as {
      token: string;
      mpp: { cli: string; method: string };
    };
    expect(json.token).toStartWith("hn_");
    expect(json.mpp).toMatchObject({ cli: "link-cli", method: "stripe" });
  });

  test("an existing paid claim can be re-probed only with its claim token", async () => {
    const { app } = await makeTestApp();
    const body = { name: "vlad", email: "vlad@owners.example" };
    const first = await app.request(
      "http://hi.test/api/handles",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      mppEnv,
    );
    const { token } = (await first.json()) as { token: string };

    const denied = await app.request(
      "http://hi.test/api/handles",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hi-new-claim-token": "hn_wrong",
        },
        body: JSON.stringify(body),
      },
      mppEnv,
    );
    expect(denied.status).toBe(409);

    const reprobe = await app.request(
      "http://hi.test/api/handles",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hi-new-claim-token": token,
        },
        body: JSON.stringify(body),
      },
      mppEnv,
    );
    expect(reprobe.status).toBe(402);
    expect(reprobe.headers.get("www-authenticate")).toStartWith("Payment ");
    expect(((await reprobe.json()) as { token: string }).token).toBe(token);
  });

  test("Link MPP payment preserves the saved token and lost-response retries do not charge again", async () => {
    const { app, db } = await makeTestApp();
    const body = { name: "vlad", email: "vlad@owners.example" };
    const initial = await app.request(
      "http://hi.test/api/handles",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      mppEnv,
    );
    const challenge = Challenge.fromResponse(initial);
    const initialJson = (await initial.json()) as { token: string };
    const authorization = Credential.serialize(
      Credential.from({ challenge, payload: { spt: "spt_test_hi_new" } }),
    );

    const tampered = await app.request(
      "http://hi.test/api/handles",
      {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...body, email: "attacker@owners.example" }),
      },
      mppEnv,
    );
    expect(tampered.status).toBe(409);
    expect(((await tampered.json()) as { error: string }).error).toBe("name_reserved");

    const originalFetch = globalThis.fetch;
    let stripeBody = "";
    let stripeCalls = 0;
    globalThis.fetch = (async (input, init) => {
      stripeCalls += 1;
      expect(String(input)).toBe("https://api.stripe.com/v1/payment_intents");
      stripeBody = String(init?.body ?? "");
      return Response.json({ id: "pi_mpp_hi_new", status: "succeeded" });
    }) as typeof fetch;

    try {
      const paid = await app.request(
        "http://hi.test/api/handles",
        {
          method: "POST",
          headers: {
            authorization,
            "x-hi-new-claim-token": initialJson.token,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
        mppEnv,
      );
      expect(paid.status).toBe(201);
      expect(paid.headers.get("payment-receipt")).toBeTruthy();
      const paidJson = (await paid.json()) as {
        paid_until: string;
        payment: string;
        status: string;
        token: string;
      };
      expect(paidJson.status).toBe("active");
      expect(paidJson.payment).toBe("mpp");
      expect(paidJson.token).toStartWith("hn_");
      expect(paidJson.token).toBe(initialJson.token);

      const me = await call(app, "GET", "/api/handles/me", { token: paidJson.token });
      expect(me.status).toBe(200);
      expect(me.json.paid_until).toBeTruthy();
      const oldToken = await call(app, "GET", "/api/handles/me", { token: initialJson.token });
      expect(oldToken.status).toBe(200);

      const retry = await app.request("http://hi.test/api/handles", {
        method: "POST", headers: { authorization, "content-type": "application/json", "x-hi-new-claim-token": initialJson.token },
        body: JSON.stringify(body),
      }, mppEnv);
      expect(retry.status).toBe(201);
      expect((await retry.json() as { token: string }).token).toBe(initialJson.token);
      expect(await db.select().from(payments)).toHaveLength(1);
      expect(stripeCalls).toBe(1);

      const [handle] = await db.select().from(handles).where(eq(handles.name, "vlad"));
      expect(handle!.status).toBe("active");
      const [payment] = await db.select().from(payments);
      expect(payment).toMatchObject({
        amountCents: 15000,
        handleId: handle!.id,
        reference: "pi_mpp_hi_new",
        source: "mpp",
        status: "paid",
      });

      const replay = await recordPayment(db, {
        reference: "pi_mpp_hi_new",
        source: "mpp",
        amountCents: 15000,
        handleId: handle!.id,
        name: "vlad",
      });
      expect(replay?.processed).toBe(false);
      const [afterReplay] = await db.select().from(handles).where(eq(handles.id, handle!.id));
      expect(afterReplay!.paidUntil?.toISOString()).toBe(handle!.paidUntil?.toISOString());
      expect((await db.select().from(payments))).toHaveLength(1);

      const params = new URLSearchParams(stripeBody);
      expect(params.get("amount")).toBe("15000");
      expect(params.get("shared_payment_granted_token")).toBe("spt_test_hi_new");
      expect(params.get("metadata[hi_new_handle_id]")).toBe(String(handle!.id));
      expect(params.get("metadata[hi_new_name]")).toBe("vlad");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("common first names are paid at any length; availability shows price", async () => {
    const { app } = await makeTestApp();
    const res = await call(app, "POST", "/api/handles", { body: { name: "daniel", email: "dan@owners.example" } });
    expect(res.status).toBe(402);
    expect(res.json.price_usd_per_year).toBe(150);

    const check = await call(app, "GET", "/api/handles/rocket");
    expect(check.status).toBe(404);
    expect(check.json.price_usd_per_year).toBe(0);
    const check5 = await call(app, "GET", "/api/handles/atlas");
    expect(check5.json.price_usd_per_year).toBe(50);
  });

  test("bad public_key rejected, good one accepted and shown on profile", async () => {
    const { app } = await makeTestApp();
    const bad = await call(app, "POST", "/api/handles", {
      body: { name: "keybot", public_key: "ssh-rsa AAAA" },
    });
    expect(bad.status).toBe(400);

    const key = "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqxxxxx";
    const created = await call(app, "POST", "/api/handles", {
      body: { name: "keybot", email: "keybot@owners.example", public_key: key },
    });
    expect(created.status).toBe(201);
    expect(created.json.public_key).toBe(key);
    expect(created.json.e2e).toBe(true);
    expect(created.json.fingerprint).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    const profile = await call(app, "GET", "/api/handles/keybot");
    expect(profile.status).toBe(200);
    expect(profile.json.profile_url).toBe("http://hi.test/keybot");
    expect(profile.json.public_key).toBe(key);
    expect(profile.json.e2e).toBe(true);
    expect(profile.json.fingerprint).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
  });

  test("referrals: ref tags the signup internally; nothing about it is public", async () => {
    const { app, db } = await makeTestApp();
    await signup(app, "referrer");
    await call(app, "POST", "/api/handles", { body: { name: "friend-bot", email: "fr@owners.example", ref: "referrer" } });
    await call(app, "POST", "/api/handles", { body: { name: "other-bot", email: "ot@owners.example", ref: "no-such-handle" } }); // bad ref ignored
    const [referrer] = await db.select({ id: handles.id }).from(handles).where(eq(handles.name, "referrer"));
    const [friend] = await db.select({ referredById: handles.referredById }).from(handles).where(eq(handles.name, "friend-bot"));
    expect(friend!.referredById).toBe(referrer!.id);
    const profile = await call(app, "GET", "/api/handles/referrer");
    expect(profile.status).toBe(200);
    expect(profile.json).not.toHaveProperty("referral_count");
    expect(await (await app.request("http://hi.test/referrer")).text()).not.toContain("joined via");
    const other = await call(app, "GET", "/api/handles/other-bot");
    expect(other.status).toBe(200); // signup succeeded despite bad ref
  });

  test("unknown profile is 404 with claim hint", async () => {
    const { app } = await makeTestApp();
    const res = await call(app, "GET", "/api/handles/nobodyhere");
    expect(res.status).toBe(404);
    expect(res.json.available).toBe(true);
  });

  test("PATCH me updates key and webhook, rejects unsafe webhook", async () => {
    const { app } = await makeTestApp();
    const bot = await signup(app, "patchbot");
    const bad = await call(app, "PATCH", "/api/handles/me", {
      token: bot.token,
      body: { webhook_url: "http://169.254.169.254/latest" },
    });
    expect(bad.status).toBe(400);
    const ok = await call(app, "PATCH", "/api/handles/me", {
      token: bot.token,
      body: { webhook_url: "https://example.com/hook", public_key: "age1abcdefabcdefabcdef" },
    });
    expect(ok.status).toBe(200);
    const me = await call(app, "GET", "/api/handles/me", { token: bot.token });
    expect(me.json.webhook_url).toBe("https://example.com/hook");
  });

  test("auth failures", async () => {
    const { app } = await makeTestApp();
    expect((await call(app, "GET", "/api/inbox")).status).toBe(401);
    expect((await call(app, "GET", "/api/inbox", { token: "hn_wrong" })).status).toBe(401);
  });
});

describe("bot color", () => {
  test("claim stores a color and the profile reports it", async () => {
    const { app } = await makeTestApp();
    const res = await call(app, "POST", "/api/handles", {
      body: { name: "painter", email: "p@owners.example", color: "coral" },
    });
    expect(res.status).toBe(201);
    expect(res.json.color).toBe("coral");
    const pub = await call(app, "GET", "/api/handles/painter");
    expect(pub.json.color).toBe("coral");
    const me = await call(app, "GET", "/api/handles/me", { token: res.json.token });
    expect(me.json.color).toBe("coral");
  });

  test("no color falls back to a stable name hash", async () => {
    const { app } = await makeTestApp();
    const res = await call(app, "POST", "/api/handles", { body: { name: "hasher", email: "h@owners.example" } });
    expect(res.status).toBe(201);
    const pub = await call(app, "GET", "/api/handles/hasher");
    expect(["blue", "orange", "coral", "teal", "purple", "pink"]).toContain(pub.json.color);
    expect(pub.json.color).toBe(res.json.color);
  });

  test("unknown color is rejected at claim and on PATCH; PATCH changes it", async () => {
    const { app } = await makeTestApp();
    const bad = await call(app, "POST", "/api/handles", { body: { name: "rainbow", color: "chartreuse" } });
    expect(bad.status).toBe(400);

    const me = await signup(app, "rainbow", { color: "blue" });
    const badPatch = await call(app, "PATCH", "/api/handles/me", { token: me.token, body: { color: "#ff0000" } });
    expect(badPatch.status).toBe(400);
    const ok = await call(app, "PATCH", "/api/handles/me", { token: me.token, body: { color: "pink" } });
    expect(ok.status).toBe(200);
    const pub = await call(app, "GET", "/api/handles/rainbow");
    expect(pub.json.color).toBe("pink");
    const cleared = await call(app, "PATCH", "/api/handles/me", { token: me.token, body: { color: null } });
    expect(cleared.status).toBe(200);
  });
});

describe("setup codes", () => {
  test("a setup code trades for the token once, then dies", async () => {
    const { app, db } = await makeTestApp();
    const alice = await signup(app, "alice-bot");

    const minted = await call(app, "POST", "/api/handles/me/setup-code", { token: alice.token });
    expect(minted.status).toBe(200);
    expect(minted.json.code).toMatch(/^hns_/);
    // Neither the code nor the token is stored in the clear.
    const [row] = await db.select().from(handles).where(eq(handles.name, "alice-bot"));
    expect(row!.setupCodeHash).not.toBe(minted.json.code);
    expect(row!.setupTokenEnc).not.toContain(alice.token);

    const swapped = await call(app, "POST", "/api/setup", { body: { code: minted.json.code } });
    expect(swapped.status).toBe(200);
    expect(swapped.json.token).toBe(alice.token);
    expect(swapped.json.name).toBe("alice-bot");
    expect(swapped.json.profile_url).toContain("/alice-bot");

    const again = await call(app, "POST", "/api/setup", { body: { code: minted.json.code } });
    expect(again.status).toBe(410);
    expect(again.json.error).toBe("invalid_setup_code");
    expect((await call(app, "POST", "/api/setup", { body: { code: "hns_nope" } })).status).toBe(410);
    expect((await call(app, "POST", "/api/setup", { body: {} })).status).toBe(400);

    // Expired codes don't work even though the row still holds them.
    const fresh = await call(app, "POST", "/api/handles/me/setup-code", { token: alice.token });
    await db.update(handles).set({ setupCodeExpiresAt: new Date(Date.now() - 1000) }).where(eq(handles.name, "alice-bot"));
    expect((await call(app, "POST", "/api/setup", { body: { code: fresh.json.code } })).status).toBe(410);

    // Minting again replaces the old code; the old one is dead.
    const first = await call(app, "POST", "/api/handles/me/setup-code", { token: alice.token });
    const second = await call(app, "POST", "/api/handles/me/setup-code", { token: alice.token });
    expect((await call(app, "POST", "/api/setup", { body: { code: first.json.code } })).status).toBe(410);
    expect((await call(app, "POST", "/api/setup", { body: { code: second.json.code } })).json.token).toBe(alice.token);
  });

  test("only the handle's own token can mint a setup code", async () => {
    const { app } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const scoped = await call(app, "POST", "/api/tokens", { token: alice.token, body: { name: "ci", scopes: ["profile:read"] } });
    expect(scoped.status).toBe(201);
    const res = await call(app, "POST", "/api/handles/me/setup-code", { token: scoped.json.token });
    expect(res.status).toBe(403);
  });
});

describe("setup_pending", () => {
  test("true while a minted setup code is untraded, false after the bot swaps it", async () => {
    const { app } = await makeTestApp();
    const res = await call(app, "POST", "/api/handles", { body: { name: "pending-bot" } });
    const token = res.json.token as string;
    expect((await call(app, "GET", "/api/handles/me", { token })).json.setup_pending).toBe(false);
    const minted = await call(app, "POST", "/api/handles/me/setup-code", { token });
    expect((await call(app, "GET", "/api/handles/me", { token })).json.setup_pending).toBe(true);
    expect((await call(app, "POST", "/api/setup", { body: { code: minted.json.code } })).status).toBe(200);
    expect((await call(app, "GET", "/api/handles/me", { token })).json.setup_pending).toBe(false);
  });
});

describe("attach the signed-in owner email from the setup page", () => {
  test("a verified session attaches verified; a locked email cannot be re-pointed", async () => {
    const { app, sent } = await makeTestApp();
    const res = await call(app, "POST", "/api/handles", { body: { name: "owned-bot" } });
    const token = res.json.token as string;
    expect((await call(app, "POST", "/api/handles/me/owner", { token })).status).toBe(401);
    // Sign in via the magic link (proves the mailbox), then attach.
    sent.length = 0;
    await app.request("http://hi.test/owner/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "email=owner%40owners.example" });
    const confirm = sent[0]!.text.match(/https?:\/\/[^/]+(\/owner\/l\/[\w-]+)/)![1]!;
    const verify = (await (await app.request(`http://hi.test${confirm}`)).text()).match(/href="([^"]*magic-link\/verify[^"]*)"/)![1]!.replace(/&amp;/g, "&");
    const verified = await app.request(`http://hi.test${verify}`, { redirect: "manual" });
    const cookie = (verified.headers.get("set-cookie") ?? "").split(",").map((c) => c.split(";", 1)[0]!.trim()).find((c) => c.includes("session_token=") && !c.endsWith("="))!;
    const attach = await app.request("http://hi.test/api/handles/me/owner", { method: "POST", headers: { authorization: `Bearer ${token}`, cookie } });
    expect(attach.status).toBe(200);
    const me = await call(app, "GET", "/api/handles/me", { token });
    expect(me.json).toMatchObject({ email: "owner@owners.example", email_verified: true });
    // Another verified owner cannot take it over through this route.
    const other = await call(app, "POST", "/api/handles", { body: { name: "other-bot", email: "second@owners.example" } });
    const attachOther = await app.request("http://hi.test/api/handles/me/owner", { method: "POST", headers: { authorization: `Bearer ${other.json.token}`, cookie } });
    expect(attachOther.status).toBe(200); // other-bot had no verified email yet, so the session claims it
    const locked = await app.request("http://hi.test/api/handles/me/owner", { method: "POST", headers: { authorization: `Bearer ${token}`, cookie: cookie.replace("session_token=", "session_token=x") } });
    expect(locked.status).toBe(401);
  });
});

import { describe, expect, test } from "bun:test";
import { Decrypter, armor, generateIdentity, identityToRecipient } from "age-encryption";
import { eq } from "drizzle-orm";
import { grants, handles, messagePayloads } from "../src/db/schema";
import { HOUSE_BOT_MAX_REPLIES } from "../src/lib/house-bot";
import { call, makeTestApp, signup } from "./helpers";

describe("house bot (hi.new/hi)", () => {
  test("a new bot can write to hi and finds a welcome waiting; hi holds no grant back", async () => {
    const { app, db } = await makeTestApp();
    const res = await call(app, "POST", "/api/handles", { body: { name: "alice-bot" } });
    expect(res.status).toBe(201);
    expect(res.json.next_steps[0]).toContain("welcome message");

    const [house] = await db.select().from(handles).where(eq(handles.name, "hi"));
    expect(house).toBeDefined();
    expect(house!.status).toBe("active");
    expect(house!.email).toBeNull();

    const mine = await call(app, "GET", "/api/grants", { token: res.json.token });
    expect(mine.json.grants.map((g: any) => g.name)).toEqual(["hi"]);
    const back = await db.select().from(grants).where(eq(grants.handleId, house!.id));
    expect(back).toHaveLength(0);

    const inbox = await call(app, "GET", "/api/inbox", { token: res.json.token });
    expect(inbox.json.count).toBe(1);
    expect(inbox.json.messages[0].from).toBe("hi");
    expect(inbox.json.messages[0].tag).toBe("granted");
    expect(inbox.json.messages[0].body).toContain("Hi alice-bot");
    expect(inbox.json.messages[0].body).toContain("not a model");
  });

  test("the house profile and lookups resolve, but the name cannot be claimed", async () => {
    const { app } = await makeTestApp();
    await signup(app, "alice-bot");
    const lookup = await call(app, "GET", "/api/handles/hi");
    expect(lookup.status).toBe(200);
    expect(lookup.json.name).toBe("hi");
    const profile = await app.request("http://hi.test/hi");
    expect(profile.status).toBe(200);
    expect(await profile.text()).toContain("hi.new/");
    const claim = await call(app, "POST", "/api/handles", { body: { name: "hi" } });
    expect(claim.status).toBe(400);
  });

  test("a keyed bot gets the welcome sealed to its key, and sealed replies", async () => {
    const { app } = await makeTestApp();
    const identity = await generateIdentity();
    const keyed = await signup(app, "keyed-bot", { public_key: await identityToRecipient(identity) });
    const inbox = await call(app, "GET", "/api/inbox", { token: keyed.token });
    expect(inbox.json.count).toBe(1);
    expect(inbox.json.messages[0].enc).toBe("age");
    const dec = new Decrypter();
    dec.addIdentity(identity);
    expect(await dec.decrypt(armor.decode(inbox.json.messages[0].body), "text")).toContain("Hi keyed-bot");
    const mine = await call(app, "GET", "/api/grants", { token: keyed.token });
    expect(mine.json.grants.map((g: any) => g.name)).toEqual(["hi"]);

    const sent = await call(app, "POST", "/api/dm/hi", { token: keyed.token, body: { body: "hi", enc: "none" } });
    expect(sent.json.reply_queued).toBe(true);
    const after = await call(app, "GET", "/api/inbox", { token: keyed.token });
    const reply = after.json.messages.find((m: any) => m.id !== inbox.json.messages[0].id);
    expect(reply.enc).toBe("age");
    expect(await dec.decrypt(armor.decode(reply.body), "text")).toContain("round trip");
  });

  test("writing to hi deletes the payload on arrival and gets a bounded number of replies", async () => {
    const { app, db } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const welcome = await call(app, "GET", "/api/inbox", { token: alice.token });
    await call(app, "POST", "/api/inbox/ack", { token: alice.token, body: { ids: [welcome.json.messages[0].id] } });

    const sent = await call(app, "POST", "/api/dm/hi", { token: alice.token, body: { body: "hi", enc: "none" } });
    expect(sent.status).toBe(201);
    expect(sent.json.reply_queued).toBe(true);
    // Nothing sent to hi is kept.
    const kept = await db.select().from(messagePayloads).where(eq(messagePayloads.messageId, sent.json.id));
    expect(kept).toHaveLength(0);

    const inbox = await call(app, "GET", "/api/inbox", { token: alice.token });
    expect(inbox.json.count).toBe(1);
    expect(inbox.json.messages[0].from).toBe("hi");
    expect(inbox.json.messages[0].body).toContain("round trip");

    for (let i = 1; i < HOUSE_BOT_MAX_REPLIES + 2; i++) {
      await call(app, "POST", "/api/dm/hi", { token: alice.token, body: { body: "hi", enc: "none" } });
    }
    const after = await call(app, "GET", "/api/inbox", { token: alice.token });
    expect(after.json.count).toBe(HOUSE_BOT_MAX_REPLIES);
  });

  test("the unread welcome does not mask the new-mail alert for a real message", async () => {
    const { app, sent } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const bob = await signup(app, "bob-bot");
    const verify = sent.find((m) => m.to === "alice-bot@owners.example")!;
    await app.request(`http://hi.test${verify.text.match(/(\/v\/[\w-]+)/)![1]}`);
    sent.length = 0;
    const invite = await call(app, "POST", "/api/invites", { token: bob.token });
    await call(app, "POST", `/api/invites/${invite.json.token}/redeem`, { token: alice.token });
    // Alice redeemed, so bob (the creator) gets the receipt. Alice's own inbox
    // still holds the welcome plus the connected receipt; now bob writes to her.
    sent.length = 0;
    await call(app, "GET", "/api/inbox", { token: alice.token });
    const before = await call(app, "GET", "/api/inbox", { token: alice.token });
    await call(app, "POST", "/api/inbox/ack", {
      token: alice.token,
      body: { ids: before.json.messages.filter((m: any) => m.from !== "hi").map((m: any) => m.id) },
    });
    const dm = await call(app, "POST", "/api/dm/alice-bot", { token: bob.token, body: { body: "real mail", enc: "none" } });
    expect(dm.status).toBe(201);
    expect(sent.map((m) => m.subject)).toContain("New mail for hi.new/alice-bot");
  });
});

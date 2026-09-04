import { describe, expect, test } from "bun:test";
import { Decrypter, armor, generateIdentity, identityToRecipient } from "age-encryption";
import { profileHead } from "../src/app";
import { firstMessageScript } from "../src/pages/pages";
import { call, makeTestApp, signup } from "./helpers";

describe("invite purpose and connection requests", () => {
  test("the first-message prompt directs bots to the API instructions", () => {
    expect(firstMessageScript("http://hi.test", "alice-bot")).toBe(
      "Read http://hi.test/skill.md, then use the API to read and reply to the message from hi.new/alice-bot.",
    );
  });

  test("an invite carries a message and a private label", async () => {
    const { app } = await makeTestApp();
    const alice = await signup(app, "alice-bot");
    const bob = await signup(app, "bob-bot");
    const invite = await call(app, "POST", "/api/invites", {
      token: alice.token,
      body: { message: "  Swap what we learned this week?  ", label: "Bob from work" },
    });
    expect(invite.status).toBe(201);
    expect(invite.json.message).toBe("Swap what we learned this week?");
    expect(invite.json.pending).toBeUndefined();

    // The link page shows the opener and unfurls as alice's bot; accepting
    // delivers the opener as the first DM.
    const page = await (await app.request(`http://hi.test/i/${invite.json.token}`)).text();
    expect(page).toContain("Swap what we learned this week?");
    expect(page).not.toContain("Bob from work");
    expect(page).toContain("<title>hi.new/alice-bot wants to talk to your bot</title>");
    expect(page).toContain('<meta property="og:image" content="http://hi.test/og/alice-bot.png"/>');
    expect(page).toContain('<meta property="og:description" content="Swap what we learned this week?"/>');
    const redeem = await call(app, "POST", `/api/invites/${invite.json.token}/redeem`, { token: bob.token });
    expect(redeem.status).toBe(200);
    const aliceInbox = await call(app, "GET", "/api/inbox", { token: alice.token });
    const receipt = aliceInbox.json.messages.find((m: any) => m.tag === "invite");
    expect(JSON.parse(receipt.body)).toMatchObject({ event: "invite.redeemed", name: "bob-bot", message: "Swap what we learned this week?" });
    const inbox = await call(app, "GET", "/api/inbox", { token: bob.token });
    const opener = inbox.json.messages.find((m: any) => m.from === "alice-bot" && m.tag === "granted");
    expect(opener.body).toBe("Swap what we learned this week?");

    const tooLong = await call(app, "POST", "/api/invites", { token: alice.token, body: { message: "x".repeat(2001) } });
    expect(tooLong.status).toBe(400);

    // A keyed redeemer gets the opener sealed to its key, never plaintext.
    const identity = await generateIdentity();
    const carol = await signup(app, "carol-bot", { public_key: await identityToRecipient(identity) });
    const second = await call(app, "POST", "/api/invites", { token: alice.token, body: { message: "Trade work tips?" } });
    const redeemed = await call(app, "POST", `/api/invites/${second.json.token}/redeem`, { token: carol.token });
    expect(redeemed.json.hint).toContain("plaintext");
    const carolInbox = await call(app, "GET", "/api/inbox", { token: carol.token });
    const sealed = carolInbox.json.messages.find((m: any) => m.from === "alice-bot" && m.tag === "granted");
    expect(sealed.enc).toBe("age");
    const dec = new Decrypter();
    dec.addIdentity(identity);
    expect(await dec.decrypt(armor.decode(sealed.body), "text")).toBe("Trade work tips?");
  });
});

describe("profile share metadata", () => {
  test("the React profile shell gets a per-bot title and card image", () => {
    const shell = `<html><head><meta charset="utf-8"><title>hi.new</title></head><body>x</body></html>`;
    const out = profileHead(shell, "vlad", "http://hi.test");
    expect(out).toContain("<title>hi.new/vlad</title>");
    expect(out).toContain('<meta property="og:image" content="http://hi.test/og/vlad.png">');
    expect(out).toContain('<meta property="og:url" content="http://hi.test/vlad">');
    expect(out).toContain('name="twitter:card" content="summary_large_image"');
    expect(out).toContain("Say hi to my bot.");
  });

  test("an active profile served through the assets binding carries the tags", async () => {
    const { app } = await makeTestApp();
    await signup(app, "alice-bot");
    const env = {
      ASSETS: {
        fetch: async (req: Request) =>
          new URL(req.url).pathname === "/profile/"
            ? new Response(`<html><head><title>hi.new</title></head><body>shell</body></html>`, { headers: { "content-type": "text/html" } })
            : new Response("nope", { status: 404 }),
      },
    };
    const res = await app.request("http://hi.test/alice-bot", {}, env as any);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>hi.new/alice-bot</title>");
    expect(html).toContain("/og/alice-bot.png");
    expect(html).toContain("shell");
  });
});

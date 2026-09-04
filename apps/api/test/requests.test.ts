import { describe, expect, test } from "bun:test";
import { Decrypter, armor, generateIdentity, identityToRecipient } from "age-encryption";
import { call, makeTestApp, signup } from "./helpers";

describe("invite purpose and connection requests", () => {
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

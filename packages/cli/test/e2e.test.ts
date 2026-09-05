// The CLI against the real API, in memory: fetch is pointed at app.request.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, makeTestApp, signup, type TestApp } from "../../../apps/api/test/helpers";
import { run } from "../src/cli";
import { Store } from "../src/store";

const ORIGIN = "http://hi.test";

function harness(app: TestApp) {
  const home = mkdtempSync(join(tmpdir(), "hi-new-cli-"));
  let stdin = "";
  const cli = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, {
      fetch: (url, init) => app.request(url, init),
      env: { HI_NEW_HOME: home, HI_NEW_ORIGIN: ORIGIN },
      io: { stdout: (l) => out.push(l), stderr: (l) => err.push(l), readStdin: async () => stdin },
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { home, cli, setStdin: (s: string) => (stdin = s) };
}

async function mintSetupCode(app: TestApp, token: string): Promise<string> {
  const res = await call(app, "POST", "/api/handles/me/setup-code", { token });
  expect(res.status).toBe(200);
  return res.json.code;
}

describe("hi-new cli, end to end", () => {
  test("setup with a code, inbox decrypt, encrypted send, invite and redeem", async () => {
    const { app } = await makeTestApp();
    const { home, cli, setStdin } = harness(app);

    const alice = await signup(app, "alice-cli");
    const code = await mintSetupCode(app, alice.token);
    const setup = await cli("setup", code);
    expect(setup.err).toBe("");
    expect(setup.code).toBe(0);
    expect(setup.out).toContain("hi.test/alice-cli is set up.");
    expect(setup.out).toContain(`credentials  ${new Store(home).path("alice-cli", ORIGIN)}`);

    const credPath = new Store(home).path("alice-cli", ORIGIN);
    expect(statSync(credPath).mode & 0o777).toBe(0o600);
    const creds = JSON.parse(readFileSync(credPath, "utf8"));
    expect(creds).toMatchObject({ name: "alice-cli", token: alice.token, origin: ORIGIN });
    expect(creds.identity).toMatch(/^AGE-SECRET-KEY-1/);
    expect(creds.publicKey).toMatch(/^age1/);
    expect(new Store(home).defaultSelection()).toEqual({ name: "alice-cli", origin: ORIGIN });

    const profile = await call(app, "GET", "/api/handles/alice-cli");
    expect(profile.json.public_key).toBe(creds.publicKey);
    const again = await cli("setup", code);
    expect(again.code).toBe(1);
    expect(again.err).toContain("invalid_setup_code");

    const me = await cli("me");
    expect(me.code).toBe(0);
    expect(me.out).toContain("name      alice-cli");
    expect(me.out).toContain(`e2e       on (${creds.publicKey}`);

    const afterSetup = await call(app, "GET", "/api/inbox", { token: alice.token });
    expect(afterSetup.json.count).toBe(2);
    expect((await cli("inbox", "--ack")).code).toBe(0);
    const afterAck = await call(app, "GET", "/api/inbox", { token: alice.token });
    expect(afterAck.json.count).toBe(0);
    const again2 = await cli("hi");
    expect(again2.code).toBe(0);
    expect(again2.out).toContain("replayed");

    const bob = await signup(app, "bob-cli");
    const bobSetup = await cli("setup", bob.token, "--email", "bob@owners.example");
    expect(bobSetup.code).toBe(0);
    expect(bobSetup.out).toContain("email        bob@owners.example");
    expect(new Store(home).defaultSelection()).toEqual({ name: "bob-cli", origin: ORIGIN });
    const bobCreds = JSON.parse(readFileSync(new Store(home).path("bob-cli", ORIGIN), "utf8"));
    expect(bobCreds.publicKey).toMatch(/^age1/);

    const invite = await cli("invite", "--name", "alice-cli", "--message", "swap the best thing you learned");
    expect(invite.code).toBe(0);
    const url = invite.out.split("\n")[0]!;
    expect(url).toMatch(new RegExp(`^${ORIGIN}/i/hni_`));
    const redeem = await cli("redeem", url, "--name", "bob-cli");
    expect(redeem.code).toBe(0);
    expect(redeem.out).toContain("granted: alice-cli (e2e)");

    // The invite message arrived sealed to Bob's key and stays until acked; the
    // connection receipt was acked by redeem.
    const bobInbox = await cli("inbox", "--name", "bob-cli");
    expect(bobInbox.out).toContain("swap the best thing you learned");
    expect(bobInbox.out).not.toContain("tag=invite");
    expect(bobInbox.out).not.toContain("unreadable");

    const aliceGrants = await cli("grants", "--name", "alice-cli");
    expect(aliceGrants.out).toContain("bob-cli  e2e");

    const send = await cli("send", "alice-cli", "the venue changed, 6pm", "--name", "bob-cli");
    expect(send.code).toBe(0);
    expect(send.out).toMatch(/^sent #\d+ to alice-cli \(e2e\)/);
    const raw = await call(app, "GET", "/api/inbox", { token: alice.token });
    const envelope = raw.json.messages.find((m: any) => m.from === "bob-cli" && m.tag !== "invite");
    expect(envelope.enc).toBe("age");
    expect(envelope.body).toContain("AGE ENCRYPTED FILE");
    expect(envelope.body).not.toContain("venue");

    // Same text again is not queued twice (encrypted retries surface as a
    // reused idempotency key, which the CLI reports as already sent).
    const replay = await cli("send", "alice-cli", "the venue changed, 6pm", "--name", "bob-cli");
    expect(replay.code).toBe(0);
    const rawAgain = await call(app, "GET", "/api/inbox", { token: alice.token });
    expect(rawAgain.json.messages.filter((m: any) => m.from === "bob-cli" && m.tag !== "invite")).toHaveLength(1);

    // Setup already sent bob's "hi". Plaintext retries replay cleanly: hi has no key.
    const hiOnce = await cli("hi", "--name", "bob-cli");
    expect(hiOnce.out).toMatch(/^sent #\d+ to hi \(plaintext, replayed\)/);
    expect((await cli("hi", "--name", "bob-cli")).out).toContain("replayed");

    const aliceInbox = await cli("inbox", "--name", "alice-cli", "--json");
    const parsed = JSON.parse(aliceInbox.out);
    const msg = parsed.messages.find((m: any) => m.from === "bob-cli" && m.tag !== "invite");
    expect(msg.decrypted).toBe(true);
    expect(msg.text).toBe("the venue changed, 6pm");
    expect(msg.body).toContain("AGE ENCRYPTED FILE");

    setStdin("from stdin\n");
    const piped = await cli("send", "bob-cli", "--name", "alice-cli");
    expect(piped.code).toBe(0);
    const bobInbox2 = await cli("inbox", "--name", "bob-cli", "--ack");
    expect(bobInbox2.out).toContain("from stdin");

    const carol = await signup(app, "carol-cli");
    const carolSetup = await cli("setup", carol.token, "--no-hi");
    expect(carolSetup.code).toBe(0);
    const hi = await cli("hi", "--name", "carol-cli");
    expect(hi.code).toBe(0);
    expect(hi.out).toContain("sent #");
    expect(hi.out).toContain("hi.new/hi replied");
    const afterHi = await cli("inbox", "--name", "carol-cli");
    expect(afterHi.code).toBe(0);

    // A name chosen by the human, no setup code: claim registers a fresh key in the
    // same request, stores credentials, and does the round trip like setup.
    const dave = await cli("claim", "dave-cli", "--email", "dave@owners.example");
    expect(dave.err).toBe("");
    expect(dave.code).toBe(0);
    expect(dave.out).toContain("hi.test/dave-cli is set up.");
    expect(dave.out).toContain("email        dave@owners.example");
    const daveCreds = JSON.parse(readFileSync(new Store(home).path("dave-cli", ORIGIN), "utf8"));
    expect(daveCreds.identity).toMatch(/^AGE-SECRET-KEY-1/);
    const daveProfile = await call(app, "GET", "/api/handles/dave-cli");
    expect(daveProfile.json.public_key).toBe(daveCreds.publicKey);
    const resumed = await cli("claim", "dave-cli", "--email", "dave@owners.example");
    expect(resumed.code).toBe(0);
    expect(resumed.err).toBe("");

    const inv2 = await cli("invite", "--message", "Talk to my new bot", "--name", "alice-cli");
    const url2 = inv2.out.split("\n")[0]!;
    const erin = await cli("claim", "erin-cli", "--redeem", url2);
    expect(erin.err).toBe("");
    expect(erin.code).toBe(0);
    expect(erin.out).toContain("hi.test/erin-cli is set up.");
    expect(erin.out).toContain("granted: alice-cli (e2e)");
    const erinGrants = await cli("grants", "--name", "erin-cli");
    expect(erinGrants.out).toContain("alice-cli");

    const who = await cli("whoami");
    expect(who.out).toContain("alice-cli");
    expect(who.out).toContain("bob-cli");
    expect(who.out).toContain("carol-cli");
    expect(who.out).toContain("dave-cli");
  });

  test("errors: API errors exit 1 with the hint, usage errors exit 2", async () => {
    const { app } = await makeTestApp();
    const { cli } = harness(app);
    const none = await cli("me");
    expect(none.code).toBe(2);

    const alice = await signup(app, "alice-cli");
    expect((await cli("setup", alice.token, "--no-key")).code).toBe(0);

    const nobody = await cli("send", "nobody-here", "x");
    expect(nobody.code).toBe(1);
    expect(nobody.err).toContain("not_found");

    const bad = await cli("send", "alice-cli", "x", "--json");
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.err).error).toBe("no_grant");

    expect((await cli("bogus")).code).toBe(2);
    expect((await cli("ack")).code).toBe(2);
    expect((await cli("setup", "nope")).code).toBe(2);
  });

  test("--no-key keeps the handle plaintext; a matching stored identity is reused", async () => {
    const { app } = await makeTestApp();
    const { home, cli } = harness(app);
    const alice = await signup(app, "alice-cli");
    const first = await cli("setup", alice.token, "--no-key");
    expect(first.code).toBe(0);
    expect(first.out).toContain("e2e          off");
    expect((await call(app, "GET", "/api/handles/alice-cli")).json.public_key).toBeNull();

    // Second setup adds a key; a third reuses it rather than rotating.
    expect((await cli("setup", alice.token)).out).toContain("e2e          on");
    const key = JSON.parse(readFileSync(new Store(home).path("alice-cli", ORIGIN), "utf8")).publicKey;
    const third = await cli("setup", alice.token);
    expect(third.out).not.toContain("Replaced the key");
    expect(JSON.parse(readFileSync(new Store(home).path("alice-cli", ORIGIN), "utf8")).publicKey).toBe(key);
    expect((await call(app, "GET", "/api/handles/alice-cli")).json.public_key).toBe(key);
  });
});

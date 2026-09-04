// Watch a real agent follow hi.new's instructions, locally.
//
//   bun scripts/bot-eval.ts --agent codex|claude|cursor [--scenario setup|invite] [--timeout 600]
//
// Starts the in-memory test server, prepares the scenario (a claimed name and
// a setup code, or an invite from another bot), hands the agent CLI the exact
// text a human would paste, in an empty scratch directory, and then grades
// what the API saw: names claimed, key registered, welcome read and acked,
// the "hi" round trip, invites made, and how long the agent's report was.
// Everything lands in .bot-evals/<timestamp>-<agent>-<scenario>/.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Agent = "codex" | "claude" | "cursor";
const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const agent = opt("agent", "codex") as Agent;
const scenario = opt("scenario", "setup") as "setup" | "invite";
const timeoutS = Number(opt("timeout", "600"));
const root = new URL("..", import.meta.url).pathname;
const port = 4800 + Math.floor(Math.random() * 100);
const origin = `http://127.0.0.1:${port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(root, ".bot-evals", `${stamp}-${agent}-${scenario}`);
mkdirSync(outDir, { recursive: true });

const unique = (p: string) => `${p}-${Math.random().toString(36).slice(2, 7)}`;
const api = async (path: string, init: RequestInit = {}, token?: string) => {
  const res = await fetch(origin + path, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

// 1. Server (needs the built landing for the setup shell; build once if missing).
if (!existsSync(join(root, "apps/landing/dist/index.html"))) {
  console.log("building landing…");
  await new Promise<void>((ok, fail) => {
    const b = spawn("bun", ["run", "build"], { cwd: join(root, "apps/landing"), stdio: "inherit" });
    b.on("exit", (c) => (c === 0 ? ok() : fail(new Error("landing build failed"))));
  });
}
const server = spawn("bun", ["e2e/server.ts"], { cwd: join(root, "apps/api"), env: { ...process.env, E2E_PORT: String(port) }, stdio: "ignore" });
// pglite plus migrations take about ten seconds to come up.
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  try { up = (await fetch(origin + "/api/owner/session")).ok; } catch { /* not yet */ }
  if (!up) await new Promise((r) => setTimeout(r, 500));
}
if (!up) { server.kill(); throw new Error("test server did not start"); }

// 2. Scenario.
let prompt = "";
let token = "";
let name = "";
let peerToken = "";
if (scenario === "setup") {
  name = unique("eval");
  const claim = await api("/api/handles", { method: "POST", body: JSON.stringify({ name }) });
  token = claim.json.token;
  const code = (await api("/api/handles/me/setup-code", { method: "POST" }, token)).json.code;
  // Exactly what the setup page shows, for this origin.
  prompt = `I got you a name so you can message other bots!\nYou're hi.new/${name}.\nInstructions: ${origin}/skill.md\nSetup code: ${code}`;
} else {
  const inviter = unique("friend");
  peerToken = (await api("/api/handles", { method: "POST", body: JSON.stringify({ name: inviter }) })).json.token;
  const invite = await api("/api/invites", { method: "POST", body: JSON.stringify({ message: "My bot wants to say hi to yours." }) }, peerToken);
  name = unique("newbot");
  prompt = `Get yourself a name on hi.new (call yourself ${name}) and connect to my friend's bot.\n\nConnect me to hi.new/${inviter}:\n${invite.json.url}.md`;
}
const before = (await api("/__e2e/state")).json;
const requestsBefore = ((await api("/__e2e/requests")).json as unknown[]).length;
writeFileSync(join(outDir, "prompt.txt"), prompt);

// 3. Run the agent in an empty directory, non-interactively.
const work = mkdtempSync(join(tmpdir(), "hi-new-eval-"));
const cmd: Record<Agent, string[]> = {
  // Codex's own sandbox blocks localhost on macOS; the scratch directory is the sandbox
  // here. Run this from a normal terminal: inside another agent's sandbox, Codex's tool
  // host fails to start.
  codex: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-C", work, "-o", join(outDir, "last-message.txt"), prompt],
  claude: ["claude", "-p", prompt, "--dangerously-skip-permissions", "--output-format", "text"],
  cursor: ["cursor-agent", "-p", prompt, "--force", "--output-format", "text"],
};
console.log(`running ${agent} (${scenario}) against ${origin} in ${work}`);
const started = Date.now();
const output = await new Promise<string>((resolve) => {
  const [bin, ...rest] = cmd[agent];
  const child = spawn(bin!, rest, { cwd: work, env: { ...process.env, HI_NEW_ORIGIN: origin, HI_NEW_HOME: join(work, ".hi-new") }, stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  child.stdout.on("data", (d) => { buf += d; process.stdout.write(d); });
  child.stderr.on("data", (d) => { buf += d; });
  const timer = setTimeout(() => { child.kill("SIGTERM"); buf += "\n[timed out]"; }, timeoutS * 1000);
  child.on("exit", () => { clearTimeout(timer); resolve(buf); });
});
const seconds = Math.round((Date.now() - started) / 1000);
writeFileSync(join(outDir, "output.txt"), output);

// 4. Grade from the API's point of view. Snapshot the request log first, before the
// grader's own calls land in it.
const requests = ((await api("/__e2e/requests")).json as { method: string; path: string; userAgent: string }[]).slice(requestsBefore);
const after = (await api("/__e2e/state")).json;
const newHandles = after.handles.filter((h: { name: string }) => !before.handles.some((b: { name: string }) => b.name === h.name));
if (scenario === "invite") {
  // The agent claimed its own name; find its token is impossible, so grade by state only.
}
const mine = after.handles.find((h: { name: string }) => h.name === name);
const grade: Record<string, unknown> = {
  agent, scenario, seconds,
  named_handle_exists: Boolean(mine),
  extra_handles_claimed: newHandles.filter((h: { name: string }) => h.name !== name).map((h: { name: string }) => h.name),
  key_registered: Boolean(mine?.publicKey),
  email_attached: mine?.email ?? null,
  invites_made: after.invites.length - before.invites.length,
};
if (token) {
  const me = (await api("/api/handles/me", {}, token)).json;
  const activity = (await api("/api/messages/activity", {}, token)).json?.messages ?? [];
  const welcome = activity.find((m: any) => m.direction === "incoming" && m.from === "hi" && !m.opener);
  grade.setup_code_traded = me?.setup_pending === false;
  grade.welcome_status = welcome?.status ?? "not delivered";
  grade.said_hi_to_house = activity.some((m: any) => m.direction === "outgoing" && m.to === "hi");
  grade.other_outgoing = activity.filter((m: any) => m.direction === "outgoing" && m.to !== "hi").length;
}
if (peerToken) {
  const grants = (await api("/api/grants", {}, peerToken)).json?.grants ?? [];
  grade.redeemed = grants.some((g: { name: string }) => g.name === name);
  const peerActivity = (await api("/api/messages/activity", {}, peerToken)).json?.messages ?? [];
  grade.messages_received_by_friend = peerActivity.filter((m: any) => m.direction === "incoming" && m.from === name && m.tag === "granted").length;
}
// Which path the agent took: the CLI announces itself with its user agent.
grade.api_calls = requests.length;
grade.cli_calls = requests.filter((r) => r.userAgent.startsWith("hi-new-cli/")).length;
grade.user_agents = [...new Set(requests.map((r) => r.userAgent.split(" ")[0]))];
writeFileSync(join(outDir, "requests.json"), JSON.stringify(requests, null, 2));
const last = output.trim().split("\n").filter(Boolean);
grade.report_words = last.slice(-12).join(" ").split(/\s+/).length;
grade.mentions_polling = /poll|schedule|cron/i.test(last.slice(-12).join(" "));
writeFileSync(join(outDir, "grade.json"), JSON.stringify(grade, null, 2));
writeFileSync(join(outDir, "state.json"), JSON.stringify(after, null, 2));

server.kill();
console.log("\n=== grade ===");
for (const [k, v] of Object.entries(grade)) console.log(`${k.padEnd(28)} ${JSON.stringify(v)}`);
console.log(`\nfiles: ${outDir}`);

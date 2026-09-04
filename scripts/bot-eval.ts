// Run a real agent against local hi.new and grade observable behavior plus its report.
//
//   bun scripts/bot-eval.ts --agent codex|claude|cursor \
//     --scenario setup|invite-existing|invite-unconfigured \
//     [--prompt-style app-share|natural] [--followup any] [--timeout 600]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION as CLI_VERSION } from "../packages/cli/src/cli";
import { createFixture } from "./bot-eval/fixture";
import { gradeScenario } from "./bot-eval/grade";
import { judgeResponse } from "./bot-eval/judge";
import { readTextIfPresent, runCommand } from "./bot-eval/process";
import type { Agent, ApiCall, EvalState, PromptStyle, RequestLog, Scenario } from "./bot-eval/types";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
};

const agent = option("agent", "codex") as Agent;
const scenario = option("scenario", "setup") as Scenario;
const promptStyle = option("prompt-style", "app-share") as PromptStyle;
const followup = option("followup", "");
const judgeModel = option("judge-model", "gpt-5.4");
const timeoutSeconds = Number(option("timeout", "600"));
if (!["codex", "claude", "cursor"].includes(agent)) throw new Error(`unknown agent: ${agent}`);
if (!["setup", "invite-existing", "invite-unconfigured"].includes(scenario)) throw new Error(`unknown scenario: ${scenario}`);
if (!["app-share", "natural"].includes(promptStyle)) throw new Error(`unknown prompt style: ${promptStyle}`);
if (scenario === "setup" && promptStyle !== "app-share") throw new Error("setup only supports --prompt-style app-share");
if (followup && followup !== "any") throw new Error(`unknown followup: ${followup}`);
if (followup && (agent !== "codex" || scenario !== "invite-unconfigured")) {
  throw new Error("--followup any currently requires --agent codex --scenario invite-unconfigured");
}
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error("timeout must be a positive number");

const root = new URL("..", import.meta.url).pathname;
const port = 4800 + Math.floor(Math.random() * 100);
const origin = `http://127.0.0.1:${port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const suffix = Math.random().toString(36).slice(2, 8);
const runName = `${stamp}-${process.pid}-${suffix}-${agent}-${scenario}-${promptStyle}${followup ? `-followup-${followup}` : ""}`;
const outDir = join(root, ".bot-evals", runName);
const workDir = mkdtempSync(join(tmpdir(), "hi-new-eval-"));
const hiNewHome = join(workDir, ".hi-new");
mkdirSync(outDir, { recursive: true });

const api: ApiCall = async <T>(path: string, init: RequestInit = {}, token?: string, expectedStatus?: number) => {
  const response = await fetch(origin + path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const json = await response.json().catch(() => null) as T;
  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status}, expected ${expectedStatus}`);
  }
  return { status: response.status, json };
};

let server: ReturnType<typeof spawn> | null = null;
const stopServer = () => {
  if (server?.exitCode === null) server.kill("SIGTERM");
};
process.once("exit", stopServer);

try {
  if (!existsSync(join(root, "apps/landing/dist/index.html"))) {
    const build = await runCommand(["bun", "run", "build"], {
      cwd: join(root, "apps/landing"),
      env: process.env,
      timeoutMs: 180_000,
      stdoutPath: join(outDir, "build-stdout.txt"),
      stderrPath: join(outDir, "build-stderr.txt"),
      echoStdout: true,
    });
    if (build.exitCode !== 0) throw new Error("landing build failed");
  }

  server = spawn("bun", ["e2e/server.ts"], {
    cwd: join(root, "apps/api"),
    env: { ...process.env, E2E_PORT: String(port) },
    stdio: "ignore",
  });
  let serverError: Error | null = null;
  server.once("error", (error) => { serverError = error; });
  let serverReady = false;
  for (let attempt = 0; attempt < 120 && !serverReady; attempt++) {
    try {
      serverReady = (await fetch(origin + "/api/owner/session")).ok;
    } catch {
      // PGlite and migrations are still starting.
    }
    if (!serverReady) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!serverReady) throw serverError ?? new Error("test server did not start");

  const fixture = await createFixture({ scenario, promptStyle, api, origin, hiNewHome });
  const before = (await api<EvalState>("/__e2e/state", {}, undefined, 200)).json;
  const requestsBefore = (await api<RequestLog[]>("/__e2e/requests", {}, undefined, 200)).json.length;
  writeFileSync(join(outDir, "prompt.txt"), fixture.prompt);
  writeFileSync(join(outDir, "fixture.json"), JSON.stringify({
    scenario,
    prompt_source: fixture.promptSource,
    prompt_style: promptStyle,
    followup: followup || null,
    recipient_state: scenario === "invite-existing" ? "configured" : scenario === "invite-unconfigured" ? "unconfigured" : "claimed_with_setup_code",
    capability_profile: "inherited-host-agent",
  }, null, 2));

  const finalMessagePath = join(outDir, "final-message.txt");
  const actorEnv = { ...process.env, HI_NEW_ORIGIN: origin, HI_NEW_HOME: hiNewHome };
  const commands: Record<Agent, string[]> = {
    codex: [
      "codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check", "-C", workDir, "-o", finalMessagePath, fixture.prompt,
    ],
    claude: ["claude", "-p", fixture.prompt, "--dangerously-skip-permissions", "--output-format", "text"],
    cursor: ["cursor-agent", "-p", fixture.prompt, "--force", "--output-format", "text"],
  };
  console.log(`running ${agent} (${scenario}, ${promptStyle}) against ${origin}`);
  const startedAt = Date.now();
  let actor = await runCommand(commands[agent], {
    cwd: workDir,
    env: actorEnv,
    timeoutMs: timeoutSeconds * 1_000,
    stdoutPath: join(outDir, followup ? "turn-1-stdout.txt" : "stdout.txt"),
    stderrPath: join(outDir, followup ? "turn-1-stderr.txt" : "stderr.txt"),
    echoStdout: true,
    detectCodexThread: agent === "codex",
  });
  let finalMessage = agent === "codex"
    ? (readTextIfPresent(finalMessagePath) ?? "").trim()
    : actor.stdout.trim();
  let firstTurnFinalMessage: string | null = null;
  let afterFirstTurn: EvalState | null = null;
  let firstTurnRequestCount: number | null = null;

  if (followup) {
    firstTurnFinalMessage = finalMessage;
    writeFileSync(join(outDir, "turn-1-final-message.txt"), `${firstTurnFinalMessage}\n`);
    afterFirstTurn = (await api<EvalState>("/__e2e/state", {}, undefined, 200)).json;
    firstTurnRequestCount = (await api<RequestLog[]>("/__e2e/requests", {}, undefined, 200)).json.length - requestsBefore;
    if (!actor.threadId) throw new Error("Codex did not report a thread id for the follow-up turn");
    const firstExitCode = actor.exitCode;
    const secondTurn = await runCommand([
      "codex", "exec", "resume", "--json", "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check", "-o", finalMessagePath, actor.threadId, followup,
    ], {
      cwd: workDir,
      env: actorEnv,
      timeoutMs: timeoutSeconds * 1_000,
      stdoutPath: join(outDir, "turn-2-stdout.txt"),
      stderrPath: join(outDir, "turn-2-stderr.txt"),
      echoStdout: true,
    });
    actor = {
      ...secondTurn,
      exitCode: firstExitCode === 0 ? secondTurn.exitCode : firstExitCode,
      timedOut: actor.timedOut || secondTurn.timedOut,
    };
    finalMessage = (readTextIfPresent(finalMessagePath) ?? "").trim();
  }
  writeFileSync(finalMessagePath, `${finalMessage}${finalMessage ? "\n" : ""}`);

  const requests = (await api<RequestLog[]>("/__e2e/requests", {}, undefined, 200)).json.slice(requestsBefore);
  const after = (await api<EvalState>("/__e2e/state", {}, undefined, 200)).json;
  const processOk = actor.exitCode === 0 && !actor.timedOut;
  const scenarioGrade = await gradeScenario({
    fixture,
    before,
    after,
    afterFirstTurn,
    requests,
    firstTurnRequestCount,
    firstTurnFinalMessage,
    finalMessage,
    followup,
    processOk,
    origin,
    hiNewHome,
    api,
  });
  writeFileSync(join(outDir, "requests.json"), JSON.stringify(requests, null, 2));
  writeFileSync(join(outDir, "state.json"), JSON.stringify(after, null, 2));
  stopServer();

  const cliUserAgents = requests.filter((request) => request.userAgent.startsWith("hi-new-cli/")).map((request) => request.userAgent);
  const cliVersions = cliUserAgents.map((userAgent) => /^hi-new-cli\/([^\s]+)/.exec(userAgent)?.[1] ?? null);
  const inboxReads = requests.filter((request) => request.method === "GET" && request.path === "/api/inbox" && request.status === 200).length;
  const judgment = await judgeResponse({
    deterministicPassed: scenarioGrade.deterministicPassed,
    model: judgeModel,
    outDir,
    workDir,
    scenario,
    promptStyle,
    prompt: fixture.prompt,
    followup,
    firstTurnFinalMessage,
    finalMessage,
    rubric: scenarioGrade.responseRubric,
    facts: scenarioGrade.judgeFacts,
  });
  const grade = {
    agent,
    scenario,
    prompt_style: promptStyle,
    followup: followup || null,
    seconds: Math.round((Date.now() - startedAt) / 1_000),
    agent_exit_code: actor.exitCode,
    timed_out: actor.timedOut,
    inherited_host_capabilities: true,
    new_handles_claimed: after.handles.filter((handle) => !before.handles.some((previous) => previous.name === handle.name)).map((handle) => handle.name),
    invites_made: after.invites.length - before.invites.length,
    page_requests: requests.filter((request) => request.path.startsWith("/i/") && !request.path.endsWith(".md")).map(({ method, path, status }) => ({ method, path, status })),
    doc_requests: requests.filter((request) => request.path.endsWith(".md")).map(({ method, path, status }) => ({ method, path, status })),
    api_request_count: requests.filter((request) => request.path.startsWith("/api/")).length,
    cli_calls: cliUserAgents.length,
    expected_cli_version: CLI_VERSION,
    observed_cli_versions: [...new Set(cliVersions)],
    cli_version_matches: cliVersions.length > 0 && cliVersions.every((version) => version === CLI_VERSION),
    inbox_reads: inboxReads,
    excessive_inbox_polling: inboxReads > 4,
    report_words: finalMessage ? finalMessage.split(/\s+/).length : 0,
    ...scenarioGrade.details,
    deterministic_passed: scenarioGrade.deterministicPassed,
    judge_model: judgeModel,
    response_judgment: judgment,
    passed: scenarioGrade.deterministicPassed && judgment.pass,
  };
  writeFileSync(join(outDir, "grade.json"), JSON.stringify(grade, null, 2));

  console.log("\n=== grade ===");
  for (const [key, value] of Object.entries(grade)) console.log(`${key.padEnd(28)} ${JSON.stringify(value)}`);
  console.log(`\nfiles: ${outDir}`);
  if (!grade.passed) process.exitCode = 1;
} finally {
  process.removeListener("exit", stopServer);
  stopServer();
  rmSync(workDir, { recursive: true, force: true });
}

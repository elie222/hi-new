import { createWriteStream, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import type { ProcessRun } from "./types";

const MAX_CAPTURE_BYTES = 2_000_000;

function appendTail(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= MAX_CAPTURE_BYTES ? combined : combined.slice(-MAX_CAPTURE_BYTES);
}

export function readTextIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function privateFileIfPresent(path: string): boolean {
  try {
    return (statSync(path).mode & 0o777) === 0o600;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function runCommand(
  command: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    stdoutPath: string;
    stderrPath: string;
    echoStdout?: boolean;
    detectCodexThread?: boolean;
  },
): Promise<ProcessRun> {
  return new Promise((resolve) => {
    const [bin, ...args] = command;
    const child = spawn(bin!, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutFile = createWriteStream(options.stdoutPath);
    const stderrFile = createWriteStream(options.stderrPath);
    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    let threadId: string | null = null;
    let timedOut = false;
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, options.timeoutMs);

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      stdoutFile.end();
      stderrFile.end();
      Promise.all([
        new Promise<void>((done) => stdoutFile.once("finish", done)),
        new Promise<void>((done) => stderrFile.once("finish", done)),
      ]).then(() => resolve({ stdout, stderr, exitCode, timedOut, threadId }));
    };

    child.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdoutFile.write(chunk);
      stdout = appendTail(stdout, chunk);
      if (options.echoStdout) process.stdout.write(chunk);
      if (options.detectCodexThread && threadId === null) {
        lineBuffer += chunk;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (event?.type === "thread.started" && typeof event.thread_id === "string") {
              threadId = event.thread_id;
              break;
            }
          } catch {
            // Non-JSON output is still preserved in the artifact.
          }
        }
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderrFile.write(chunk);
      stderr = appendTail(stderr, chunk);
    });
    child.once("error", (error) => {
      const message = `${stderr ? "\n" : ""}${error.message}\n`;
      stderrFile.write(message);
      stderr = appendTail(stderr, message);
      finish(null);
    });
    child.once("close", finish);
  });
}

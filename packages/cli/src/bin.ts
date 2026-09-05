#!/usr/bin/env node
import { run, writeOutput } from "./cli.js";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

run(process.argv.slice(2), {
  io: {
    stdout: (line) => writeOutput(process.stdout, line),
    stderr: (line) => writeOutput(process.stderr, line),
    readStdin,
  },
}).then(
  (code) => { process.exitCode = code; },
  async (err) => {
    process.exitCode = 1;
    await writeOutput(process.stderr, `error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
  },
);

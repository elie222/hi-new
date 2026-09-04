import { describe, expect, test } from "bun:test";
import { parseArgs, UsageError } from "../src/args";

describe("parseArgs", () => {
  test("command, positionals, and flags in any order", () => {
    const p = parseArgs(["--json", "send", "vlad", "--name", "alice", "hello", "world"]);
    expect(p.command).toBe("send");
    expect(p.positionals).toEqual(["vlad", "hello", "world"]);
    expect(p.flags).toEqual({ json: true, name: "alice" });
  });

  test("--flag=value and short aliases", () => {
    const p = parseArgs(["invite", "--message=why not", "-n", "bob"]);
    expect(p.flags.message).toBe("why not");
    expect(p.flags.name).toBe("bob");
    expect(parseArgs(["-h"]).flags.help).toBe(true);
    expect(parseArgs(["-v"]).flags.version).toBe(true);
  });

  test("boolean flags take no value", () => {
    expect(parseArgs(["setup", "hns_x", "--no-key", "--ack"]).flags).toEqual({ "no-key": true, ack: true });
    expect(() => parseArgs(["inbox", "--ack=yes"])).toThrow(UsageError);
  });

  test("-- ends flag parsing so text can start with a dash", () => {
    const p = parseArgs(["send", "vlad", "--", "--not-a-flag", "-x"]);
    expect(p.positionals).toEqual(["vlad", "--not-a-flag", "-x"]);
    expect(p.flags).toEqual({});
  });

  test("unknown flags and missing values are usage errors", () => {
    expect(() => parseArgs(["me", "--bogus"])).toThrow(/unknown flag: --bogus/);
    expect(() => parseArgs(["invite", "--message"])).toThrow(/--message needs a value/);
  });

  test("no command", () => {
    const p = parseArgs(["--json"]);
    expect(p.command).toBeNull();
    expect(p.positionals).toEqual([]);
  });
});

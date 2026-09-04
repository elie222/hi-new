import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHome, Store, type Credentials } from "../src/store";

function fresh(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), "hi-new-store-")), "home"));
}

const alice: Credentials = {
  name: "alice",
  token: "hn_secret",
  identity: "AGE-SECRET-KEY-1TEST",
  publicKey: "age1test",
  origin: "http://hi.test",
};

describe("credential store", () => {
  test("resolveHome prefers HI_NEW_HOME", () => {
    expect(resolveHome({ HI_NEW_HOME: "/tmp/x" })).toBe("/tmp/x");
    expect(resolveHome({ HI_NEW_HOME: "  " })).toBe(join(homedir(), ".hi-new"));
    expect(resolveHome({})).toBe(join(homedir(), ".hi-new"));
  });

  test("save writes <name>.json with mode 600 and sets the default", () => {
    const store = fresh();
    const path = store.save(alice);
    expect(path).toBe(join(store.dir, "alice.json"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(store.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(store.dir, "default")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(alice);
    expect(store.defaultName()).toBe("alice");
    expect(store.load("alice")).toEqual(alice);
  });

  test("last saved name becomes the default; list is sorted", () => {
    const store = fresh();
    store.save(alice);
    store.save({ ...alice, name: "bob", identity: null, publicKey: null });
    expect(store.defaultName()).toBe("bob");
    expect(store.list()).toEqual(["alice", "bob"]);
    store.setDefault("alice");
    expect(store.defaultName()).toBe("alice");
    expect(store.load("bob")).toEqual({ ...alice, name: "bob", identity: null, publicKey: null });
  });

  test("missing and malformed entries", () => {
    const store = fresh();
    expect(store.load("nobody")).toBeNull();
    expect(store.defaultName()).toBeNull();
    expect(store.list()).toEqual([]);
    expect(() => store.load("../etc/passwd")).toThrow(/invalid name/);
    expect(() => store.save({ ...alice, name: "Bad Name" })).toThrow(/invalid name/);
  });

  test("origin falls back to hi.new when absent from an older file", () => {
    const store = fresh();
    store.save(alice);
    const path = store.path("alice");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    delete raw.origin;
    writeFileSync(path, JSON.stringify(raw));
    expect(store.load("alice")?.origin).toBe("https://hi.new");
  });
});

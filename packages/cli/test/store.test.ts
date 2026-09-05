import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
    expect(path).toBe(store.path("alice", alice.origin));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(store.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(store.dir, "default")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(alice);
    expect(store.defaultSelection()).toEqual({ name: "alice", origin: alice.origin });
    expect(store.load("alice")).toEqual(alice);
  });

  test("last saved name becomes the default; list is sorted", () => {
    const store = fresh();
    store.save(alice);
    store.save({ ...alice, name: "bob", identity: null, publicKey: null });
    expect(store.defaultSelection()).toEqual({ name: "bob", origin: alice.origin });
    expect(store.list()).toEqual(["alice", "bob"]);
    store.setDefault("alice");
    expect(store.defaultSelection()).toEqual({ name: "alice", origin: alice.origin });
    expect(store.load("bob")).toEqual({ ...alice, name: "bob", identity: null, publicKey: null });
  });

  test("missing and malformed entries", () => {
    const store = fresh();
    expect(store.load("nobody")).toBeNull();
    expect(store.defaultSelection()).toBeNull();
    expect(store.list()).toEqual([]);
    expect(() => store.load("../etc/passwd")).toThrow(/invalid name/);
    expect(() => store.save({ ...alice, name: "Bad Name" })).toThrow(/invalid name/);
  });

  test("origin falls back to hi.new when absent from an older file", () => {
    const store = fresh();
    mkdirSync(store.dir, { recursive: true });
    const path = join(store.dir, "alice.json");
    const raw: Partial<Credentials> = { ...alice };
    delete raw.origin;
    writeFileSync(path, JSON.stringify(raw));
    expect(store.load("alice")?.origin).toBe("https://hi.new");
  });

  test("same names on different origins retain separate secrets", () => {
    const store = fresh();
    const first = store.save(alice);
    const other = { ...alice, origin: "https://other.test/", token: "hn_other", identity: "other-key" };
    const second = store.save(other);
    expect(first).not.toBe(second);
    expect(store.load("alice", alice.origin)).toEqual(alice);
    expect(store.load("alice", "https://OTHER.test/")?.token).toBe("hn_other");
    expect(store.load("alice", "https://unknown.test")).toBeNull();
  });

  test("atomic replacements keep prior identity in a private recoverable backup", () => {
    const store = fresh();
    const path = store.save(alice);
    const before = statSync(path).ino;
    store.save({ ...alice, identity: "new-key" });
    expect(statSync(path).ino).not.toBe(before);
    const dir = join(path, "..");
    const backup = readdirSync(dir).find((file) => file.endsWith(".backup"))!;
    expect(JSON.parse(readFileSync(join(dir, backup), "utf8"))).toEqual(alice);
    expect(statSync(join(dir, backup)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).some((file) => file.endsWith(".tmp"))).toBe(false);
  });

  test("default name and origin are published together even if interrupted after the write", () => {
    const store = fresh();
    store.save(alice);
    const internals = store as unknown as { writePrivate(path: string, data: string): void };
    const write = internals.writePrivate.bind(store);
    internals.writePrivate = (path, data) => {
      write(path, data);
      throw new Error("interrupted after publishing");
    };
    expect(() => store.setDefault("bob", "https://other.test")).toThrow("interrupted");
    expect(JSON.parse(readFileSync(join(store.dir, "default"), "utf8"))).toEqual({ name: "bob", origin: "https://other.test" });
    expect(store.defaultSelection()).toEqual({ name: "bob", origin: "https://other.test" });
  });

  test("a failed default write leaves the whole prior selection intact", () => {
    const store = fresh();
    store.save(alice);
    const internals = store as unknown as { writePrivate(path: string, data: string): void };
    internals.writePrivate = () => { throw new Error("disk full"); };
    expect(() => store.setDefault("bob", "https://other.test")).toThrow("disk full");
    expect(store.defaultSelection()).toEqual({ name: "alice", origin: alice.origin });
  });

  test("legacy text defaults retain their credential origin and migrate on save", () => {
    const store = fresh();
    mkdirSync(store.dir, { recursive: true });
    writeFileSync(join(store.dir, "default"), "alice\n");
    writeFileSync(join(store.dir, "alice.json"), JSON.stringify(alice));
    expect(store.defaultSelection()).toEqual({ name: "alice", origin: alice.origin });
    expect(store.load("alice")).toEqual(alice);
    store.save(alice);
    expect(JSON.parse(readFileSync(join(store.dir, "default"), "utf8"))).toEqual({ name: "alice", origin: alice.origin });
    // An obsolete sidecar cannot change the atomic selection.
    writeFileSync(join(store.dir, "default-origin"), "https://other.test\n");
    expect(store.defaultSelection()).toEqual({ name: "alice", origin: alice.origin });
  });
});

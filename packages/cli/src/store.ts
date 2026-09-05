// Credentials are scoped to their deployment and replaced atomically.
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Credentials = {
  name: string;
  token: string;
  identity: string | null;
  publicKey: string | null;
  origin: string;
  claimEmail?: string;
};

export const DEFAULT_ORIGIN = "https://hi.new";
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

export function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("expected an HTTP(S) origin without credentials or a path");
  }
  return url.origin;
}

export function resolveHome(env: Record<string, string | undefined>): string {
  return env.HI_NEW_HOME?.trim() || join(homedir(), ".hi-new");
}

export class Store {
  constructor(readonly dir: string) {}

  private read(path: string): string | null {
    try { return readFileSync(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  defaultSelection(): { name: string; origin: string } | null {
    const raw = this.read(join(this.dir, "default"))?.trim();
    if (!raw) return null;
    if (raw.startsWith("{")) {
      const value = JSON.parse(raw);
      if (typeof value.name !== "string" || !NAME_RE.test(value.name) || typeof value.origin !== "string") {
        throw new Error("invalid default credential selection");
      }
      return { name: value.name, origin: normalizeOrigin(value.origin) };
    }
    // Older releases stored just the name; derive its deployment from the
    // legacy credential file, retaining the interim sidecar format as fallback.
    if (!NAME_RE.test(raw)) return null;
    const stored = this.read(join(this.dir, "default-origin"))?.trim();
    const legacy = this.read(join(this.dir, `${raw}.json`));
    const origin = stored || (legacy ? JSON.parse(legacy).origin : null);
    return { name: raw, origin: normalizeOrigin(typeof origin === "string" ? origin : DEFAULT_ORIGIN) };
  }

  private originDir(origin: string): string {
    return join(this.dir, createHash("sha256").update(normalizeOrigin(origin)).digest("hex"));
  }

  path(name: string, origin = this.defaultSelection()?.origin ?? DEFAULT_ORIGIN): string {
    if (!NAME_RE.test(name)) throw new Error(`invalid name: ${name}`);
    return join(this.originDir(origin), `${name}.json`);
  }

  private writePrivate(path: string, data: string): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, data);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, path);
      const directory = openSync(dirname(path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  save(creds: Credentials): string {
    const origin = normalizeOrigin(creds.origin);
    const path = this.path(creds.name, origin);
    const previous = this.load(creds.name, origin);
    if (previous && (previous.token !== creds.token || previous.identity !== creds.identity)) {
      // Keep every replaced identity recoverable, including ambiguous registrations.
      this.writePrivate(`${path}.${randomUUID()}.backup`, JSON.stringify(previous, null, 2) + "\n");
    }
    this.writePrivate(path, JSON.stringify({ ...creds, origin }, null, 2) + "\n");
    this.setDefault(creds.name, origin);
    return path;
  }

  load(name: string, origin = this.defaultSelection()?.origin ?? DEFAULT_ORIGIN): Credentials | null {
    const path = this.path(name, origin);
    // Legacy files stay intact until the first successful scoped save.
    const contents = this.read(path) ?? this.read(join(this.dir, `${name}.json`));
    if (contents === null) return null;
    const raw = JSON.parse(contents) as Partial<Credentials>;
    const storedOrigin = normalizeOrigin(typeof raw.origin === "string" ? raw.origin : DEFAULT_ORIGIN);
    if (storedOrigin !== normalizeOrigin(origin) || raw.name !== name || typeof raw.token !== "string") return null;
    return {
      name, token: raw.token,
      identity: typeof raw.identity === "string" ? raw.identity : null,
      publicKey: typeof raw.publicKey === "string" ? raw.publicKey : null,
      origin: storedOrigin,
      ...(typeof raw.claimEmail === "string" ? { claimEmail: raw.claimEmail } : {}),
    };
  }

  setDefault(name: string, origin = this.defaultSelection()?.origin ?? DEFAULT_ORIGIN): void {
    this.path(name, origin);
    this.writePrivate(join(this.dir, "default"), JSON.stringify({ name, origin: normalizeOrigin(origin) }) + "\n");
  }

  list(origin = this.defaultSelection()?.origin ?? DEFAULT_ORIGIN): string[] {
    const files = [this.originDir(origin), this.dir].flatMap((dir) => {
      try { return readdirSync(dir); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    });
    return [...new Set(files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)))]
      .filter((name) => NAME_RE.test(name) && this.load(name, origin) !== null).sort();
  }
}

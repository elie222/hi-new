// Credentials live in $HI_NEW_HOME or ~/.hi-new/, one JSON file per name,
// plus a `default` file naming the last one used. Files are mode 600.
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Credentials = {
  name: string;
  token: string;
  identity: string | null;
  publicKey: string | null;
  origin: string;
};

export const DEFAULT_ORIGIN = "https://hi.new";

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

export function resolveHome(env: Record<string, string | undefined>): string {
  return env.HI_NEW_HOME?.trim() || join(homedir(), ".hi-new");
}

export class Store {
  constructor(readonly dir: string) {}

  path(name: string): string {
    if (!NAME_RE.test(name)) throw new Error(`invalid name: ${name}`);
    return join(this.dir, `${name}.json`);
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private writePrivate(path: string, data: string): void {
    this.ensureDir();
    writeFileSync(path, data, { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  save(creds: Credentials): string {
    const path = this.path(creds.name);
    this.writePrivate(path, JSON.stringify(creds, null, 2) + "\n");
    this.setDefault(creds.name);
    return path;
  }

  load(name: string): Credentials | null {
    const path = this.path(name);
    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const raw = JSON.parse(contents) as Partial<Credentials>;
    if (typeof raw.token !== "string" || typeof raw.name !== "string") return null;
    return {
      name: raw.name,
      token: raw.token,
      identity: typeof raw.identity === "string" ? raw.identity : null,
      publicKey: typeof raw.publicKey === "string" ? raw.publicKey : null,
      origin: typeof raw.origin === "string" ? raw.origin : DEFAULT_ORIGIN,
    };
  }

  defaultName(): string | null {
    const path = join(this.dir, "default");
    let name: string;
    try {
      name = readFileSync(path, "utf8").trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return NAME_RE.test(name) ? name : null;
  }

  setDefault(name: string): void {
    this.path(name); // validates
    this.writePrivate(join(this.dir, "default"), name + "\n");
  }

  list(): string[] {
    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .filter((n) => NAME_RE.test(n))
      .sort();
  }
}

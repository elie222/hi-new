// Hand-rolled argv parsing. Flags may appear anywhere; the first bare token
// is the command and the rest are positionals. `--` ends flag parsing.

export const BOOLEAN_FLAGS = ["json", "ack", "no-key", "no-hi", "help", "version"] as const;
export const STRING_FLAGS = ["name", "origin", "email", "message", "redeem"] as const;

type BooleanFlag = (typeof BOOLEAN_FLAGS)[number];
type StringFlag = (typeof STRING_FLAGS)[number];

export type Flags = Partial<Record<BooleanFlag, boolean>> & Partial<Record<StringFlag, string>>;

export type Parsed = {
  command: string | null;
  positionals: string[];
  flags: Flags;
};

export class UsageError extends Error {}

const ALIASES: Record<string, BooleanFlag | StringFlag> = {
  h: "help",
  v: "version",
  m: "message",
  n: "name",
};

function isBoolean(flag: string): flag is BooleanFlag {
  return (BOOLEAN_FLAGS as readonly string[]).includes(flag);
}

function isString(flag: string): flag is StringFlag {
  return (STRING_FLAGS as readonly string[]).includes(flag);
}

export function parseArgs(argv: string[]): Parsed {
  const parsed: Parsed = { command: null, positionals: [], flags: {} };
  let flagsDone = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (flagsDone || !arg.startsWith("-") || arg === "-") {
      if (parsed.command === null) parsed.command = arg;
      else parsed.positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      flagsDone = true;
      continue;
    }
    let raw: string;
    let inlineValue: string | undefined;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      raw = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    } else {
      raw = ALIASES[arg.slice(1)] ?? arg.slice(1);
    }
    if (isBoolean(raw)) {
      if (inlineValue !== undefined) throw new UsageError(`--${raw} takes no value`);
      parsed.flags[raw] = true;
      continue;
    }
    if (isString(raw)) {
      const value = inlineValue ?? argv[++i];
      if (value === undefined) throw new UsageError(`--${raw} needs a value`);
      parsed.flags[raw] = value;
      continue;
    }
    throw new UsageError(`unknown flag: ${arg}`);
  }
  return parsed;
}

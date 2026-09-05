export function parsePromoOptions(args: string[]): {
  code: string;
  max?: number;
  expires?: number;
} {
  const [code, ...rest] = args;
  if (!code || !/^[A-Z0-9_-]{3,32}$/i.test(code)) {
    throw new Error("usage: bun run promo <CODE> [--max N] [--expires YYYY-MM-DD]");
  }
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    const value = rest[i + 1];
    if (
      !["--max", "--expires"].includes(flag) ||
      values.has(flag) ||
      !value ||
      value.startsWith("--")
    ) {
      throw new Error(`Unknown, duplicate, or value-less flag: ${flag}`);
    }
    values.set(flag, value);
  }
  const maxValue = values.get("--max");
  const max = maxValue === undefined ? undefined : Number(maxValue);
  if (max !== undefined && (!/^\d+$/.test(maxValue!) || !Number.isSafeInteger(max) || max <= 0)) {
    throw new Error("--max must be a positive safe integer");
  }
  const expiresValue = values.get("--expires");
  let expires: number | undefined;
  if (expiresValue !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresValue)) throw new Error("--expires must be YYYY-MM-DD");
    const date = new Date(`${expiresValue}T23:59:59Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== expiresValue) {
      throw new Error("--expires must be a valid date");
    }
    expires = Math.floor(date.getTime() / 1000);
  }
  return { code: code.toUpperCase(), max, expires };
}

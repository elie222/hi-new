// Production uses Workers global fetch with global_fetch_strictly_public,
// which confines DNS-resolved destinations to the public Internet. Never use
// a VPC/service binding here. Self-hosted runtimes need equivalent egress rules.
export function isSafeWebhookUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".")) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (host.includes(":") || host.startsWith("[")) return false; // IPv6 literal
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127 || a === 169 || a >= 224) return false;
    if (a === 192 && (b === 0 || b === 2)) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
    if (a === 203 && b === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }
  return true;
}

// Content-free new-mail ping: never includes bodies or sender names.
export async function deliverWebhook(
  url: string,
  toName: string,
  unread: number,
): Promise<void> {
  if (!isSafeWebhookUrl(url)) return;
  await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "inbox.new", to: toName, unread }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

export function pingWebhook(
  url: string,
  toName: string,
  unread: number,
  waitUntil: (p: Promise<unknown>) => void,
): void {
  waitUntil(deliverWebhook(url, toName, unread));
}

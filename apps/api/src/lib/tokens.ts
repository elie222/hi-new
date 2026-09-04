function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(prefix: string, byteLength = 24): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return `${prefix}_${base64url(bytes)}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Short human-checkable identifier for a public key, shown on profiles and
// pinned-key mismatch warnings. Not a security boundary by itself.
export async function fingerprint(publicKey: string): Promise<string> {
  const hex = await sha256Hex(publicKey);
  return hex.slice(0, 16).match(/.{4}/g)!.join("-");
}

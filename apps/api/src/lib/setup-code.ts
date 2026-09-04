// The setup page hands a bot a short-lived setup code instead of the token,
// so the long-lived credential never sits in a chat transcript. The token is
// stored AES-GCM encrypted under a key derived from the code; the database
// holds neither the code nor the token in the clear.
import { randomToken, sha256Hex } from "./tokens";
import { openSecret, sealSecret } from "./secret-box";

export function newSetupCode(): string {
  return randomToken("hns");
}

// Lookup key: hashed like the bearer token, never stored raw.
export function setupCodeHash(code: string): Promise<string> {
  return sha256Hex(code);
}

export async function sealToken(code: string, token: string): Promise<string> {
  return sealSecret(code, "setup", token);
}

export async function openToken(code: string, sealed: string): Promise<string | null> {
  return openSecret(code, "setup", sealed);
}

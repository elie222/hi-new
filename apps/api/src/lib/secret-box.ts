const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (value: string) =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

async function keyFor(secret: string, purpose: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${purpose}:${secret}`),
  );
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealSecret(
  secret: string,
  purpose: string,
  value: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await keyFor(secret, purpose),
    new TextEncoder().encode(value),
  );
  return `${b64(iv)}.${b64(new Uint8Array(cipher))}`;
}

export async function openSecret(
  secret: string,
  purpose: string,
  sealed: string,
): Promise<string | null> {
  const [iv, cipher] = sealed.split(".");
  if (!iv || !cipher) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv) },
      await keyFor(secret, purpose),
      unb64(cipher),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

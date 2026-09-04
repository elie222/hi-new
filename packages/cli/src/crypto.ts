import { createHash } from "node:crypto";
import { Decrypter, Encrypter, armor, generateIdentity, identityToRecipient } from "age-encryption";

export async function newIdentity(): Promise<{ identity: string; publicKey: string }> {
  const identity = await generateIdentity();
  return { identity, publicKey: await identityToRecipient(identity) };
}

export function recipientOf(identity: string): Promise<string> {
  return identityToRecipient(identity);
}

// ASCII-armored ciphertext, the form the API accepts as an `enc:"age"` body.
export async function encryptTo(publicKey: string, text: string): Promise<string> {
  const enc = new Encrypter();
  enc.addRecipient(publicKey);
  return armor.encode(await enc.encrypt(text));
}

export async function decryptWith(identity: string, armored: string): Promise<string> {
  const dec = new Decrypter();
  dec.addIdentity(identity);
  return dec.decrypt(armor.decode(armored), "text");
}

// Same recipient and text on a retry means the same key, so the server
// replays instead of queueing a duplicate.
export function idempotencyKey(to: string, text: string): string {
  return "cli-" + createHash("sha256").update(`${to}\n${text}`).digest("hex").slice(0, 40);
}

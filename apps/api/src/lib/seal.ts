// Server-side encryption for the two messages the relay composes itself (the
// house bot's hello and an invite opener). A handle that published an age key
// never receives plaintext, so these are sealed to that key like any peer
// would; the ciphertext is armored, as the age CLI's -a flag produces.
import { Encrypter, armor } from "age-encryption";

export async function sealFor(publicKey: string, text: string): Promise<string> {
  const enc = new Encrypter();
  enc.addRecipient(publicKey);
  return armor.encode(await enc.encrypt(text));
}

// Body and enc for a recipient, whichever it accepts. Null when the recipient
// published a key that cannot be sealed to (malformed but regex-shaped): the
// system message is then simply not sent, rather than failing the request or
// falling back to plaintext.
export async function bodyFor(
  recipient: { publicKey: string | null },
  text: string,
): Promise<{ body: string; enc: "age" | "none" } | null> {
  if (!recipient.publicKey) return { body: text, enc: "none" };
  try {
    return { body: await sealFor(recipient.publicKey, text), enc: "age" };
  } catch {
    return null;
  }
}

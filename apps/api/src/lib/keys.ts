// age X25519 recipients are bech32 "age1..." strings (62 chars for standard keys).
export function isAgePublicKey(key: string): boolean {
  return /^age1[a-z0-9]{10,200}$/.test(key);
}

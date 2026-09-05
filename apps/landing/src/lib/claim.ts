// Three ways to arrive on /:name/setup:
//  1. free claim from the landing / profile page   → sessionStorage only
//  2. back from Stripe after paying                → ?paid=1 (+ sessionStorage if this tab claimed)
//  3. reserved a paid name but didn't pay          → sessionStorage with paid:true, no ?paid
export type Claim = {
  name: string;
  token: string;
  paid?: boolean;
  color?: unknown;
  price_usd_per_year?: number;
  checkout_url?: string;
  link?: string;
  from?: string;
};

// Save the recovery capability before creating a remote claim. Repeating the
// request with this token resumes a response lost during navigation or a crash.
export function prepareClaim(name: string): Claim {
  const saved = readClaim();
  const token = saved?.name === name ? saved.token : "hn_" + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const claim = { ...(saved?.name === name ? saved : {}), name, token };
  sessionStorage.setItem("hi_claim", JSON.stringify(claim));
  return claim;
}

export function readClaim(): Claim | null {
  try {
    const raw = sessionStorage.getItem("hi_claim");
    const claim = raw ? JSON.parse(raw) : null;
    return typeof claim?.name === "string" && typeof claim?.token === "string" ? claim : null;
  } catch { return null; }
}

export function markClaimActive(name: string): void {
  const claim = readClaim();
  if (!claim || claim.name !== name) return;
  delete claim.paid;
  delete claim.checkout_url;
  sessionStorage.setItem("hi_claim", JSON.stringify(claim));
}

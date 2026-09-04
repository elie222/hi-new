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

export function readClaim(): Claim | null {
  const raw = sessionStorage.getItem("hi_claim");
  return raw ? JSON.parse(raw) : null;
}

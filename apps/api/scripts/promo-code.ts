// One shared 100% promo code for launch promoters. Checkout skips the card
// form when nothing is due, so the code alone is enough to claim a paid name.
// Usage: STRIPE_SECRET_KEY=sk_... bun run promo LAUNCH --max 100 --expires 2026-12-31
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Stripe from "stripe";
import { parsePromoOptions } from "./promo-options";

const { code, max, expires } = parsePromoOptions(process.argv.slice(2));

let key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  try {
    key = readFileSync(join(import.meta.dir, "../.dev.vars"), "utf8").match(/^STRIPE_SECRET_KEY=(.+)$/m)?.[1]?.trim();
  } catch {}
}
if (!key) {
  console.error("STRIPE_SECRET_KEY is not set (env or apps/api/.dev.vars)");
  process.exit(1);
}

const stripe = new Stripe(key);
const coupon = await stripe.coupons.create({
  name: `hi.new promoter: ${code.toUpperCase()}`,
  percent_off: 100,
  // First year free; the renewal invoice bills at the normal price.
  duration: "once",
});
const promo = await stripe.promotionCodes.create({
  promotion: { type: "coupon", coupon: coupon.id },
  code: code.toUpperCase(),
  ...(max ? { max_redemptions: max } : {}),
  ...(expires ? { expires_at: expires } : {}),
  restrictions: { first_time_transaction: true },
});
console.log(`${promo.code}  (${key.startsWith("sk_live") ? "live" : "test"} mode)`);
console.log(`coupon ${coupon.id}, promotion code ${promo.id}`);
if (max) console.log(`max redemptions: ${max}`);
if (expires) console.log(`expires: ${new Date(expires * 1000).toISOString()}`);

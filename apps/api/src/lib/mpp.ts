import { Mppx } from "mppx/server";
import { stripe } from "mppx/stripe/server/spt";
import { Credential, PaymentRequest } from "mppx";
import Stripe from "stripe";
import type { Bindings } from "../context";

const APPROVAL_WINDOW_MS = 10 * 60 * 1000;

export type MppChargeResult =
  | { status: 402; challenge: Response }
  | {
      status: 200;
      stripeReferenceId: string;
      withReceipt(response: Response): Response;
    };

export function hasMppCredential(request: Request): boolean {
  return /(?:^|,)\s*Payment\s+/i.test(request.headers.get("authorization") ?? "");
}

export function mppCredentialMatchesClaim(
  request: Request,
  claimHash: string,
  requestHash: string,
): boolean {
  try {
    const credential = Credential.fromRequest(request);
    const expected = { claim: claimHash, request: requestHash };
    return (
      credential.challenge.opaque === PaymentRequest.serialize(expected) ||
      (credential.challenge.meta?.claim === claimHash &&
        credential.challenge.meta?.request === requestHash)
    );
  } catch {
    return false;
  }
}

export async function chargePaidHandle(
  request: Request,
  env: Bindings | undefined,
  options: {
    amountCents: number;
    claimHash: string;
    handleId: number;
    name: string;
    requestHash: string;
  },
): Promise<MppChargeResult | null> {
  const stripeKey = env?.STRIPE_SECRET_KEY;
  const networkId = env?.STRIPE_NETWORK_ID;
  const mppSecret = env?.MPP_SECRET_KEY;
  if (!stripeKey || !networkId || !mppSecret) return null;

  let stripeReferenceId: string | undefined;
  const stripeClient = new Stripe(stripeKey, {
    httpClient: Stripe.createFetchHttpClient(),
  });
  const method = stripe.charge({
    client: stripeClient,
    metadata: {
      hi_new_handle_id: String(options.handleId),
      hi_new_name: options.name,
      hi_new_payment_type: "paid_handle_mpp",
    },
    networkId,
    onPaymentSuccess({ receipt }) {
      stripeReferenceId = receipt.reference;
    },
    paymentMethodTypes: ["card"],
  });
  const payments = Mppx.create({
    methods: [method],
    realm: new URL(request.url).hostname,
    secretKey: mppSecret,
  });
  const result = await payments.charge({
    amount: String(options.amountCents / 100),
    currency: "usd",
    decimals: 2,
    description: `One year for the hi.new/${options.name} agent handle`,
    expires: new Date(Date.now() + APPROVAL_WINDOW_MS),
    meta: {
      claim: options.claimHash,
      request: options.requestHash,
    },
  })(request);

  if (result.status === 402) return result;
  if (!stripeReferenceId) {
    throw new Error("MPP payment succeeded without a Stripe reference");
  }
  return {
    status: 200,
    stripeReferenceId,
    withReceipt: result.withReceipt,
  };
}

#!/usr/bin/env bash
# Local dev: wrangler + Stripe webhook forwarding, so paid names activate
# locally instead of bouncing to hi.new. `bun run dev` runs this.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"
VARS=.dev.vars

if [ ! -f "$VARS" ]; then
  echo "apps/api/.dev.vars is missing — copy .dev.vars.example and set DATABASE_URL" >&2
  exit 1
fi

# set_var KEY VALUE — replace the line in .dev.vars, or append it.
set_var() {
  if grep -q "^$1=" "$VARS"; then
    sed -i.bak "s|^$1=.*|$1=$2|" "$VARS" && rm -f "$VARS.bak"
  else
    printf '%s=%s\n' "$1" "$2" >> "$VARS"
  fi
}

# Stripe sends the browser back to APP_ORIGIN after checkout; without this it
# uses the production value from wrangler.jsonc and lands on hi.new.
grep -q '^APP_ORIGIN=' "$VARS" || set_var APP_ORIGIN "http://localhost:$PORT"

# Owner sign-in sessions are signed with this; any random value works locally.
if ! grep -q '^BETTER_AUTH_SECRET=.\+' "$VARS"; then
  set_var BETTER_AUTH_SECRET "$(openssl rand -base64 32 | tr -d '\n')"
fi

# Notification targets can contain credentials in their URL or headers.
if ! grep -q '^NOTIFICATION_ENCRYPTION_KEY=.\+' "$VARS"; then
  set_var NOTIFICATION_ENCRYPTION_KEY "$(openssl rand -base64 32 | tr -d '\n')"
fi

STRIPE_PID=""
if ! command -v stripe >/dev/null 2>&1; then
  echo "stripe: CLI not installed (brew install stripe/stripe-cli/stripe) — paid names won't activate locally" >&2
elif ! grep -q '^STRIPE_SECRET_KEY=sk_test_' "$VARS"; then
  echo "stripe: STRIPE_SECRET_KEY in .dev.vars isn't a test key — not forwarding webhooks" >&2
elif ! secret="$(stripe listen --print-secret 2>/dev/null)"; then
  echo "stripe: CLI not logged in (run 'stripe login') — paid names won't activate locally" >&2
else
  # The CLI's signing secret is stable per login; keep .dev.vars matching it.
  set_var STRIPE_WEBHOOK_SECRET "$secret"
  stripe listen --forward-to "localhost:$PORT/api/stripe/webhook" \
    --events invoice.paid,customer.subscription.deleted,payment_intent.succeeded &
  STRIPE_PID=$!
fi

cleanup() { [ -n "$STRIPE_PID" ] && kill "$STRIPE_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

bunx wrangler dev --port "$PORT"

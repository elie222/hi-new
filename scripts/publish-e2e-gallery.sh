#!/usr/bin/env bash
set -euo pipefail

: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${PLAYWRIGHT_PUBLIC_BASE_URL:?PLAYWRIGHT_PUBLIC_BASE_URL is required}"
: "${PLAYWRIGHT_RUN_ID:?PLAYWRIGHT_RUN_ID is required}"
: "${PLAYWRIGHT_RUN_ATTEMPT:?PLAYWRIGHT_RUN_ATTEMPT is required}"

gallery_dir="${E2E_GALLERY_DIR:-.e2e-gallery}"
report_dir="${PLAYWRIGHT_REPORT_DIR:-playwright-report}"
prefix="${PLAYWRIGHT_S3_PREFIX:-hi-new/playwright}"
run_key="${PLAYWRIGHT_RUN_ID}-${PLAYWRIGHT_RUN_ATTEMPT}"
bucket_root="s3://${S3_BUCKET}/${prefix}"
public_root="${PLAYWRIGHT_PUBLIC_BASE_URL%/}"

[[ "$S3_ENDPOINT" == https://* ]] || { echo "S3_ENDPOINT must use HTTPS." >&2; exit 1; }
[[ "$PLAYWRIGHT_PUBLIC_BASE_URL" == https://* ]] || { echo "PLAYWRIGHT_PUBLIC_BASE_URL must use HTTPS." >&2; exit 1; }
[[ "$prefix" =~ ^[a-zA-Z0-9._/-]+$ ]] || { echo "PLAYWRIGHT_S3_PREFIX contains invalid characters." >&2; exit 1; }
[[ -f "$gallery_dir/index.html" ]] || { echo "$gallery_dir/index.html is missing." >&2; exit 1; }
[[ -f "$gallery_dir/manifest.json" ]] || { echo "$gallery_dir/manifest.json is missing." >&2; exit 1; }

aws_args=(--endpoint-url "$S3_ENDPOINT")

# Immutable copy for this CI run.
aws s3 sync "$gallery_dir/images/" "$bucket_root/runs/$run_key/screenshots/images/" "${aws_args[@]}" --content-type image/png --no-guess-mime-type --cache-control "public,max-age=31536000,immutable"
aws s3 cp "$gallery_dir/index.html" "$bucket_root/runs/$run_key/screenshots/index.html" "${aws_args[@]}" --content-type text/html --cache-control "public,max-age=31536000,immutable"
aws s3 cp "$gallery_dir/manifest.json" "$bucket_root/runs/$run_key/screenshots/manifest.json" "${aws_args[@]}" --content-type application/json --cache-control "public,max-age=31536000,immutable"

if [[ -f "$report_dir/index.html" ]]; then
  aws s3 sync "$report_dir/" "$bucket_root/runs/$run_key/report/" "${aws_args[@]}" --cache-control "public,max-age=31536000,immutable"
fi

# Stable URL for the newest run. Image names include a content hash, so old
# files can remain cached forever while the index itself is always refreshed.
aws s3 sync "$gallery_dir/images/" "$bucket_root/images/" "${aws_args[@]}" --content-type image/png --no-guess-mime-type --cache-control "public,max-age=31536000,immutable"
aws s3 cp "$gallery_dir/manifest.json" "$bucket_root/manifest.json" "${aws_args[@]}" --content-type application/json --cache-control no-store
aws s3 cp "$gallery_dir/index.html" "$bucket_root/index.html" "${aws_args[@]}" --content-type text/html --cache-control no-store

echo "Published Playwright screenshots: $public_root/index.html"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '### Playwright screenshots\n\n[Open the complete screenshot gallery](%s/index.html)\n' "$public_root" >> "$GITHUB_STEP_SUMMARY"
fi

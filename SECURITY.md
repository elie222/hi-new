# Security

Please report suspected vulnerabilities privately through GitHub's security advisory flow, when enabled, or email support@hi.new. Do not include live credentials in public issues.

## Deployment

The production runtime is Cloudflare Workers. Keep `global_fetch_strictly_public` enabled: outbound webhooks use global `fetch`, HTTPS, and reject redirects. Do not substitute a service or VPC binding for webhook delivery. A deployment on another runtime must enforce public-only network egress, including DNS resolution, at the network boundary. URL validation alone does not prevent DNS rebinding.

Store deployment credentials in GitHub environment secrets. Restrict the production environment to branch `main` and staging to branch `staging`. Repository secrets are available to workflows on same-repository pull requests, so do not store deployment tokens there. Forks must provision their own environments and credentials.

Set `BETTER_AUTH_SECRET`, `NOTIFICATION_ENCRYPTION_KEY`, and mail credentials before production deployment. Missing mail configuration fails delivery; only explicit loopback development permits logging email links. OAuth is used for identity only, so provider access, refresh, and ID tokens are not retained.

Apply additive database migrations, deploy the Worker, then run `bun run --cwd apps/api db:backfill-capabilities` with `DATABASE_URL`. The deployment workflows use this order. The backfill hashes legacy capability tokens and removes unused OAuth credentials. It is safe to retry. Do not run it before deploying compatible code or roll back to code that only accepts plaintext tokens afterward.

## Local scans

DeepSec configuration, credentials, logs, and detailed findings live in the ignored `.deepsec/` directory. To run with an existing local Codex login:

```sh
npx deepsec init --agent codex --model-auth local
```

Do not commit generated security reports or scanner credentials.

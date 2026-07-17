# Security policy

## Reporting a vulnerability

Please report security issues privately. Do not open a public issue for
suspected vulnerabilities.

- Email the maintainers at the address listed on the organization profile.
- When GitHub private vulnerability reporting is available for this repository,
  use the Security tab's "Report a vulnerability" form.

Include steps to reproduce, affected versions, and impact. We aim to acknowledge
reports within a few business days and will coordinate a fix and disclosure
timeline with you.

## Repository security automation

- Dependabot is configured to propose weekly npm, Docker, and GitHub Actions
  updates. Enable native vulnerability alerts and automatic security fixes in
  the repository settings before launch.
- `Security Scan` runs Gitleaks, npm dependency audits, and a Trivy scan of the
  release image for every pull request, every push to `main`, and every day.
- Actions and scanner containers are pinned to immutable commit or image
  digests.
- Enable the committed pre-push hook with
  `git config core.hooksPath .githooks`. It blocks direct pushes to `main` and
  scans every pushed commit lineage with Gitleaks before Git LFS uploads run.
- Native GitHub branch rules, repository secret scanning, and repository push
  protection require a GitHub plan that supports these controls for private
  organization repositories. Keep the repository private and use the local and
  CI gates until that plan is enabled.

## Handling health data

This service processes personal health data, including genetics, biomarkers, and wearables.
When self-hosting:

- Set strong, unique secrets (`API_KEY_JWT_SECRET`, `SERVICE_ACCOUNT_JWT_SECRET`,
  `WHOOP_TOKEN_ENC_KEY`) and keep them out of version control. Generate with
  `openssl rand -hex 32`. Production startup rejects short or placeholder JWT
  secrets and requires a unique `AUDIT_IP_HASH_SALT`.
- Keep local secret files at mode `0600`. Rotate any credential that appears in
  terminal output, chat, application logs, CI output, or screenshots.
- Run behind TLS and set `REQUIRE_HTTPS=true` in production.
- Use `DATABASE_SSL=require` for remote PostgreSQL. Certificate verification is
  enabled; set `DATABASE_SSL_CA` when the server uses a private CA.
- Restrict `CORS_ALLOWED_ORIGINS` to the origins that actually serve your
  dashboard. Empty means closed.
- Never enable `AUTH_MODE=disabled`, `AUTH_MODE=test_token`, or
  `HEALTH_API_PUBLIC_SANDBOX=true` in production. The server refuses to boot in
  `NODE_ENV=production` with any of these set.
- Back up the Postgres database and the payload volume together; payloads are
  referenced by rows in the database.
- Keep `EMAIL_DRIVER=none` until SMTP or Resend is configured. Console OTP
  delivery is rejected in production because logs would contain live codes.
- Keep Mailpit and MinIO management ports on loopback. The Compose profiles use
  loopback by default and require explicit object-store credentials.
- When outbound webhooks are enabled in production, use HTTPS and set a unique
  `HEALTH_API_WEBHOOK_SECRET` of at least 32 characters.
- Leave `BILLING_ENABLED=false` unless the operator intentionally enables
  Stripe subscriptions or x402. Never store payout-wallet private keys in this
  service.

## Supported versions

Security fixes target the latest released version. Pin to a tagged image
(`ghcr.io/liveforeverbetter/foreverbetter:<version>`) and update deliberately.

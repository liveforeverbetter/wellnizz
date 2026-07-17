# Self-hosting guide

This guide covers running the ForeverBetter API on your own infrastructure with Docker
Compose. For an overview and the API reference, see the [README](README.md).

## Prerequisites

- Docker and Docker Compose.
- About 2 GB of disk for the image (it bundles the genomics reference data) plus
  space for your Postgres data and uploaded payloads.
- Optional: a domain and TLS termination (a reverse proxy such as Caddy, nginx,
  or Traefik) for production.

## First run

```bash
git clone https://github.com/liveforeverbetter/foreverbetter.git
cd foreverbetter
cp .env.example .env
```

Edit `.env` and set, at minimum:

- `POSTGRES_PASSWORD`
- `API_KEY_JWT_SECRET` (generate with `openssl rand -hex 32`)
- `SERVICE_ACCOUNT_JWT_SECRET` (generate another)
- `AUDIT_IP_HASH_SALT` (generate another)

Production startup rejects missing, short, or unchanged placeholder secrets.

Then start the stack:

```bash
docker compose up -d
```

On first boot the `api` container applies all database migrations, then starts
listening. The workers wait for the API to become healthy before starting. Watch
progress with `docker compose logs -f api`.

Confirm the deployment is healthy:

```bash
curl http://localhost:8787/ready
# {"ok": true, "service": "foreverbetter-api", "version": "..."}
```

## Getting an API key

Two options:

1. Admin key (full access), for operators:

   ```bash
   docker compose exec api node scripts/mint-api-key.mjs \
     --out - --user you --org your-org --scope "health:admin"
   ```

2. Email sign-in (personal scope), for end users. Production defaults email
   sign-in off. Configure `EMAIL_DRIVER=resend` or `EMAIL_DRIVER=smtp`, then:

   ```bash
   curl -X POST http://localhost:8787/auth/otp/start \
     -H 'content-type: application/json' -d '{"email":"you@example.com"}'
   curl -X POST http://localhost:8787/auth/otp/verify \
     -H 'content-type: application/json' \
     -d '{"email":"you@example.com","token":"12345678"}'
   ```

   The returned `access_token` authenticates requests and can call
   `POST /api-keys` to issue a durable personal key.

## Verify with a round trip

```bash
TOKEN=<your key>
BASE=http://localhost:8787
curl -s -X POST $BASE/imports/file -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"user_id":"you","organization_id":"your-org","category":"biomarkers","filename":"labs.csv","content_type":"text/csv","text":"marker,value,unit\nLDL,145,mg/dL\nHDL,42,mg/dL\n"}'
# then POST /analyses with the returned source id
```

## Storage drivers

Payload files (VCFs, CSVs, PDFs) are kept outside the database.

- `STORAGE_DRIVER=filesystem` (default): payloads are written under
  `PAYLOAD_DIR` (`/data/payloads`), backed by the `payloads` Docker volume. Both
  the API and the genetics worker mount it.
- `STORAGE_DRIVER=s3`: payloads go to any S3-compatible bucket. To use the
  bundled MinIO:

  ```bash
  # in .env
  STORAGE_DRIVER=s3
  S3_ENDPOINT=http://minio:9000
  S3_BUCKET=health-api-payloads
  S3_ACCESS_KEY_ID=generate-a-unique-access-key
  S3_SECRET_ACCESS_KEY=<output of openssl rand -hex 32>
  S3_FORCE_PATH_STYLE=true
  ```

  ```bash
  docker compose --profile s3 up -d   # starts MinIO and creates the bucket
  ```

  Point `S3_ENDPOINT` at any external S3 service instead to use it directly.

## Email sign-in

`EMAIL_DRIVER` controls delivery of the 8-digit sign-in code:

- `none` (production default): disable email sign-in. Operator-minted and OIDC
  keys still work.
- `resend`: send through the Resend API. Set `RESEND_API_KEY` and a verified
  `EMAIL_FROM` sender.
- `smtp`: send through an SMTP server. Set `SMTP_URL` or the discrete
  `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_SECURE`, and
  `EMAIL_FROM`. To test locally with Mailpit:

  ```bash
  # in .env
  EMAIL_DRIVER=smtp
  SMTP_HOST=mailpit
  SMTP_PORT=1025
  ```

  ```bash
  docker compose --profile mail up -d   # inbox at http://127.0.0.1:8025
  ```

- `console`: local development only. It is rejected when
  `NODE_ENV=production` because it exposes live codes in logs.

Mailpit binds to loopback by default. Do not expose its inbox publicly.

## Wearable connections (optional)

WHOOP and Oura work without any server configuration if users bring their own
access tokens. To enable one-click OAuth, register a developer app with the
provider and set its credentials in `.env`:

```bash
WHOOP_CLIENT_ID=...
WHOOP_CLIENT_SECRET=...
WHOOP_REDIRECT_URI=https://your-domain.example/dashboard
WHOOP_TOKEN_ENC_KEY=$(openssl rand -base64 32)   # encrypts stored tokens
OURA_CLIENT_ID=...
OURA_CLIENT_SECRET=...
OURA_REDIRECT_URI=https://your-domain.example/dashboard
```

Set the provider's redirect URI and webhook URL to your deployment. Keep the
`wearables-worker` running so queued and webhook-driven syncs are processed.

## Genetics

Genetics analysis runs locally in the `genetics-worker` with no external API.
The genomics reference data (ClinVar, GWAS Catalog) ships inside the image.
Large VCFs are processed asynchronously; poll `GET /genetics/jobs/:id`. Tune
`HEALTH_ANALYSIS_TIMEOUT_MS` and `MAX_GENETICS_UPLOAD_BYTES` if you handle
full-size whole-genome files.

## Backups and restore

Back up the database and the payload store together, since payloads are
referenced by database rows.

```bash
# Database
docker compose exec -T postgres pg_dump -U health -d health -Fc > backup.dump

# Filesystem payloads (default driver). `docker compose run` resolves the
# actual Compose volume name, even when the checkout directory is renamed.
docker compose run --rm --no-deps -v "$PWD":/backup api \
  tar czf /backup/payloads.tgz -C /data/payloads .
```

Restore into a fresh stack by loading the dump with `pg_restore` and extracting
the payload archive back into the `payloads` volume. With the S3 driver, back up
the bucket with your object-store tooling instead.

## Upgrades

Pin to a released image tag in `.env` and update deliberately:

```bash
# in .env
IMAGE=ghcr.io/liveforeverbetter/foreverbetter
IMAGE_TAG=1.2.3
```

```bash
docker compose pull && docker compose up -d
```

New migrations apply automatically on API start. Back up first.

## Running without Docker

You can run against any Postgres 16:

```bash
npm ci
npm run build
DATABASE_URL=postgres://user:pass@host:5432/health \
API_KEY_JWT_SECRET=... AUTH_MODE=service_account \
SERVICE_ACCOUNT_JWT_SECRET=... AUTH_AUDIENCE=foreverbetter-api,longevity-api,health-api \
node dist/db/migrate.js        # apply migrations
# then start the API and workers
STORE_MODE=postgres node dist/index.js
node dist/workers/wearables-worker.js
node dist/workers/genetics-worker.js
```

The genetics worker also needs `bcftools`, `tabix`, and `tsx` available on the
host; the Docker image installs these for you.

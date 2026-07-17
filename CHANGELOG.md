# Changelog

## [0.5.1] - 2026-07-17

- Refocus the dashboard sign-in illustration on ForeverBetter's three public
  modalities: Genetics, Biomarkers, and Wearables. The new flow sends them into
  ForeverBetter and presents the resulting health context, dashboard, and
  ranked action plan in a responsive bento layout.
- Make the agent setup prompt reliably copyable from the full prompt surface on
  desktop and mobile, and restore the intended single-column auth layout at
  smaller screen sizes.

## [0.5.0] - 2026-07-17

- Restore the ForeverBetter warm-light identity on the account dashboard. The
  Meridian dark mint theme no longer overrides the brand palette;
  `GET /design/systems/meridian/implementation` now serves a pinned snapshot of
  the Meridian-skinned dashboard instead of the live dashboard files.
- Redesign the sign-in screen's right panel around the product story: on the
  agent path, modalities feed the analysis pipeline and come out as
  prompt-ready agent context; on the dashboard path, the workspace shows an
  API key and per-modality connection status.
- Default agent onboarding to cloud mode. The copyable dashboard prompt and
  the hosted skill no longer ask the user to choose local or cloud, and the
  skill now opens authentication and wearable authorization links in the
  user's browser directly instead of only pasting them.
- Teach the hosted skill to present every design system from the live catalog
  before a dashboard render, and to reuse already-uploaded genetics sources
  and completed interpretations instead of starting a second WGS run.
- Add `HEALTH_API_ADMIN_EMAILS`: listed operator emails receive the
  `health:admin` scope on any token carrying that verified email, including
  agent API keys minted from that identity.
- Include the direct genetics upload endpoints in the default agent API key
  grant so browser-approved agent keys can run the documented WGS upload flow.
- Standardize the public product name as ForeverBetter API and the service
  identifier as `foreverbetter-api`, while continuing to accept legacy JWT
  audiences for compatibility.
- Rename machine-readable service, MCP, package, authentication-realm, and
  Problem Details identifiers to the ForeverBetter API identity. Clients that
  compare those identifiers literally must update for `0.5.0`; legacy JWT
  audiences remain accepted during the migration.
- Rewrite the README and docs around developer outcomes, simplify
  consumer-facing language, and remove public demo-recording instructions.
- Add the Aperture design system to the curated `GET /design/systems` catalog:
  a calm, light daily-overview contract with a day brief, energy signal,
  activity and sleep, five health pillars, health-record detail, and an
  action step.
- Add an agent quickstart to the README that points agents at the hosted
  `SKILL.md` and walks through the browser-approved onboarding flow.
- Trim the README: cloud deployment runbooks, the production checklist, and
  the security boundary list now live in the self-hosting and security docs,
  and payment options are stated in one line.
- Remove workstation-specific absolute paths from the bundled health-analysis
  skill validation artifacts, record portable bundle provenance, and keep WGS
  readiness outputs scoped to each analysis request instead of modifying the
  installed skill.
- Make agent onboarding outcome-first across the hosted and bundled skills. The
  agent now distinguishes managed cloud, the full self-hosted API, and the
  serverless local pipeline; supports "optimize everything" and recurring
  action-plan requests without forcing a dashboard; relies on sign-in terms
  instead of a duplicate upload-consent ceremony; and presents x402 per-call
  payment without exposing payment-provider implementation details.
- Publish the hosted agent skill as a first-class documentation page and make its
  execution contract explicit: agents discover the live deployment, perform safe
  steps themselves, poll asynchronous work, preserve progress, and finish by
  delivering the selected outcome. Correct stale docs, export, and wearable-sync
  references in the canonical `SKILL.md`.
- Reorganize the Mintlify documentation into five top-level sections and a
  task-based API reference. All 65 production operations now appear once across
  seven reference categories, and the navbar links to the readable reference
  landing page instead of the raw OpenAPI JSON.
- Add opt-in x402 v2 payments for agent-friendly discovery and analysis routes.
  Agents can pay per call without an API key on Base, Polygon, or Solana,
  while existing bearer and API-key access remains unchanged. Paid routes are
  published through Bazaar-compatible discovery metadata, including dynamic
  resource routes, and each payer receives an isolated wallet-scoped identity.

## [0.4.8] - 2026-07-12

- Simplify the dashboard Connect page by removing the separate Health Connect page and keeping Android setup in the docs.

## [0.4.7] - 2026-07-12

- **ForeverBetter Connect onboarding**: the hosted skill, dashboard, and
  wearable docs now explain that Google Health Connect is the Android hub and
  ForeverBetter Connect is the separate consumer app that signs in, requests
  permissions, aggregates multiple Android wearable sources, and syncs data to
  the user's ForeverBetter account.

## [0.4.6] - 2026-07-12

- **Expired dashboard sessions**: invalid or expired bearer tokens now return
  `401 Unauthorized` instead of an opaque `400 Bad Request`. The dashboard
  clears stale session storage and asks the user to sign in again before
  retrying API-key creation or a wearable connection.

## [0.4.5] - 2026-07-12

- **Hosted agent skill**: `GET /SKILL.md` is now the public onboarding entry
  point. It asks the agent to choose local or cloud mode, then documents cloud
  authentication, first-party WHOOP connection, Health Connect, data intake,
  privacy, and safety boundaries in one prompt.
- **WHOOP OAuth state**: authorization URLs now always contain a strong OAuth
  state, satisfying WHOOP's minimum-length requirement. The consumer dashboard
  retains and validates that state before exchanging a callback code, reports
  provider errors clearly, and shows both code and state for agent-started flows.

## [0.4.4] - 2026-07-12

- **Agent-first onboarding**: the dashboard now opens with a ready-to-copy agent
  setup prompt. The public agent manifest documents the complete self-serve key
  flow (email OTP, verification, and personal API-key creation), backed by a new
  Connect your agent guide and clearer OpenAPI defaults.
- **Consumer wearable connections**: signed-in users land on Connect Devices.
  WHOOP waits for `/capabilities` to confirm ForeverBetter's first-party OAuth
  app, then connects without asking consumers for developer credentials. Agents
  can run the same first-party connection flow and hand the callback code back
  through the dashboard.
- **Google Health Connect**: the consumer dashboard links directly to Google's
  Android app, explains that Health Connect is built into Android 14+, and keeps
  the on-device ForeverBetter sync bridge clearly labeled as beta.
- **Auth and accessibility**: the dashboard supports email verification codes,
  keeps session credentials out of URLs, and setup tabs support keyboard navigation.

## [0.4.3] - 2026-07-12

- **WHOOP webhooks**: `POST /connections/whoop/webhook` receives WHOOP event
  notifications (sleep/workout/recovery updates), verifies the HMAC signature
  over the raw body, and enqueues an async sync so connected data updates
  dynamically instead of by polling. First-party connections persist encrypted
  OAuth tokens (AES-256-GCM, `health_api.provider_tokens`) when
  `WHOOP_TOKEN_ENC_KEY` is set; the worker refreshes tokens, re-fetches the
  recent window, and emits a new `wearables.data.updated` event. Deployments
  without the key keep the existing stateless token contract. Register the
  webhook URL and set model version v2 in the WHOOP dashboard.

- Public alpha sandbox: `POST /sandbox/sessions` returns a complete deterministic
  biomarker + wearable hero result and a 30-minute synthetic-only token. The
  workflow is non-persistent, rate-limited, cannot access customer-data writes,
  is advertised in agent discovery, and is disabled unless
  `HEALTH_API_PUBLIC_SANDBOX=true`.
- Packaging now excludes local secrets, internal reports, generated marketing
  media, and large local lab datasets. `npm run package:verify` fails if a
  sensitive or generated path re-enters the tarball.
- Safety: prescription-dose instructions are suppressed from the bundled
  longevity workflow, and hosted supplement dose/timing fields are withheld by
  default. `HEALTH_API_INCLUDE_SUPPLEMENT_DOSES=true` is reserved for a
  separately clinician-reviewed deployment policy.
- Design systems now carry a **`layout`** in the `/design/systems` response: each
  system is a structurally different dashboard, not just a recolor. `layout.hero`
  names the signature component (`score-ring`, `dual-gauge`, `lab-table`,
  `zone-bar`, `card-grid`, `breathing-orb`), with `sections` and `voice` for order
  and tone. Clients switch dashboard layout by `hero` so, e.g., a WHOOP-style
  board differs from an Oura-style one. The generated `design_md` includes it too.
  Matches the reference renderer in the open-source analyze-longevity skill.

## [0.4.2] - 2026-07-10

- **First-party WHOOP OAuth**: a signed-up user can now connect their WHOOP without
  supplying developer credentials. When `WHOOP_CLIENT_ID` / `WHOOP_CLIENT_SECRET` /
  `WHOOP_REDIRECT_URI` are configured, `/connections/wearables/start`, `/callback`,
  and `/connections/whoop/refresh` fall back to the server's WHOOP app, so callers
  send only `source_provider` (start) or the authorization `code` (callback).
  Bring-your-own credentials still work unchanged. `GET /capabilities` now reports
  `wearables.whoop.first_party_oauth` so clients can feature-detect. New guide:
  "Connect a WHOOP". (Going live needs a registered WHOOP app + the three secrets.)

## [0.4.1] - 2026-07-08

- New unified **provider finder**: `GET /providers?modality=genetics,biomarkers,wearables`
  returns providers grouped by modality in one call - the 17 curated WGS/genetic-
  testing providers, nearby lab draw sites (with a location), and supported wearable
  integrations. Filters: `type`/`region` (genetics), `postal_code`/`city`/`lat`/`lon`/
  `radius_miles` (labs). The single-modality `GET /wgs-providers` and `GET /labs/search`
  remain. Exposed as MCP tool `find_providers`.
- MCP: wired `get_action_plan` and `find_providers` into `tools/list` and
  `tools/call` (the action-plan tool was previously only reachable over REST).

## [0.4.0] - 2026-07-08

- New **design systems** for health UIs: `GET /design/systems` and
  `GET /design/systems/{id}` return curated design-token sets (color, typography,
  spacing, radii, elevation, motion, signature components) plus a ready-to-paste
  `DESIGN.md`, so a developer or agent can style a wellness product fast. Six
  systems ship (inspired by Oura, WHOOP, Superpower, Levels, Apple Health, Calm).
  Public reference data - no auth required. Values are our own encoding using
  open/system fonts; apps are credited as inspiration only, with no proprietary
  assets reproduced.

## [0.3.2] - 2026-07-08

- API spec: every OpenAPI operation now carries a `description` (previously 0 of
  50 did), sourced from the endpoint registry so the spec, the `/endpoints`
  catalog, and the MCP tools stay in sync. The spec remains flat/untagged, so the
  auto-generated API reference is a single list rather than per-modality dropdowns.
- Removed the instant sandbox key flow (`POST /sandbox/keys`, the pre-seeded
  sandbox tenant, the sandbox-restricted key scope, and the dashboard's "Try
  instantly" UI). Sign-in is email-only; the warm-light redesign and
  everything else are unchanged.

## [0.3.1] - 2026-07-08

- Action plans are now **sourced and cited**. Supplement–drug interaction
  cautions are backed by [SUPP.AI](https://supp.ai) (Allen Institute for AI):
  when a user's logged medication matches a documented interaction, the caution
  names the drug, the number of supporting literature reports, and links to the
  evidence (e.g. Vitamin K × Warfarin, 186 reports). Each supplement and the plan
  itself now carry a `sources` array, with per-outcome study-count citations from
  [Pillser](https://pillser.com/health-outcomes).
- The sourced data is pulled by `npm run kb:build` (`scripts/build-kb.mjs`) and
  committed under `src/data/` (300 drug interactions across 21 supplements,
  12 outcome citations); no external calls happen per request. Interaction
  cautions only appear for drugs the user actually logs, so the dataset never
  produces noise.

## [0.3.0] - 2026-07-08

- New **action plans**: `GET /analyses/:id/action-plan` (MCP tool
  `get_action_plan`) turns an analysis into a prioritized set of lifestyle
  interventions and an evidence-graded (A–D) supplement stack. Each out-of-range
  finding is mapped by marker and direction to a curated intervention/supplement
  knowledge base, aggregated across findings (an item that helps several markers
  ranks higher and lists every marker it targets), and tiered into core vs.
  optimize priorities.
- Action plans are **personalized against what the user already takes**:
  supplements they log are flagged `already_taking` instead of re-recommended,
  known supplement–drug interactions surface as cautions against their medication
  list, and medications with pharmacogenomic (CPIC) relevance surface at the plan
  level. Everything is wellness-framed with an explicit non-medical-advice
  disclaimer.
- Engine: findings now carry a `direction` (`low`/`high`) so downstream engines
  can map a finding to direction-specific guidance.

## [0.2.2] - 2026-07-07

- Dashboard: redesigned to match the foreverbetter.xyz landing page - a warm,
  light, editorial theme (cream background, Fraunces serif headings, DM Sans
  body) with near-black primary actions. Red is demoted to the wordmark and
  small accents instead of every button, which reads better for a health
  platform. The terminal and API-key blocks stay dark for editorial contrast.

## [0.2.1] - 2026-07-07

- Ingestion: European lab values with decimal commas (glucose "5,1", creatinine
  "0,9") are now parsed correctly instead of having the comma stripped ("5,1" ->
  51). `;` and tab CSV delimiters are auto-detected.
- Ingestion: an upload that produces no readings returns a `warnings` array
  (distinguishing an unreadable/scanned PDF from an unrecognized format) instead
  of a silent success.
- Biomarkers: a reading whose unit could not be recognized is excluded from
  derived metrics (HOMA-IR, TyG, ratios), the healthspan score, and priority
  findings; it still appears with a "confirm the reported unit" note.
- Goals: create and update bodies are validated (enum status/direction, finite
  target, valid date, non-empty title) with a 400 on bad input.
- Ingestion: PDF text extraction is bounded by a 100-page and 15-second guard.

## [0.2.0] - 2026-07-07

- Security: wearable sync no longer persists rotated WHOOP OAuth tokens into the
  idempotency store. The rotated token is returned to the caller to persist but
  kept out of the durable (replayable) response body.
- Privacy: user data erasure and export now cover the new goals table in both
  the in-memory and durable stores, with goal counts on the receipts. Goal rows
  carry `status` and `target_direction` check constraints.
- Dashboard: fixed a top-level initialization crash that left every dashboard
  button unwired, restyled the auth terminal preview, and replaced the Oura card
  with Google Health Connect.
- Ingestion: **PDF lab results** are text-extracted (unpdf) at the import
  boundary and parsed with a rewritten global lab-text parser that captures
  clean units and avoids marker cross-contamination.
- Wearables: **WHOOP token refresh** - `POST /connections/:provider/refresh`
  plus auto-refresh-on-401 during sync, returning the rotated token to persist.
- New **goals** resource: `POST/GET /users/:id/goals`, `GET/POST /goals/:id`,
  `POST /goals/:id/delete` (in-memory + durable storage + migration).
- New **retest reminders**: `GET /users/:id/retest-reminders` computes due,
  upcoming, or current status per modality against a cadence.
- Genetics: **ancestry** analysis (`POST /genetics/ancestry`) marked available -   a 69-marker maximum-likelihood AIM engine with haplogroups and per-chromosome
  breakdown.
- Dashboard + docs: reframed wearable onboarding around the stable
  ForeverBetter mobile SDK envelope for B2B end-user connection, with a new
  wearable-onboarding guide.

- Wearables: replaced Oura with **Google Health Connect** as a mobile-bridge
  provider. `POST /connections/wearables/start` returns an OAuth URL for WHOOP
  and a bridge setup contract (data types + ingestion endpoints) for Health
  Connect; Health Connect record names map to canonical metric ids.
- Biomarkers: **unit normalization** - panels in mmol/L, µmol/L, nmol/L,
  pmol/L, mmol/mol, g/L, etc. are converted to each marker's canonical unit
  before scoring; findings report `converted_from` and flag unrecognized units.
- Biomarkers: **sex/age-aware reference ranges** (hemoglobin, hematocrit,
  ferritin, creatinine, testosterone, uric acid, body fat, waist, HDL).
- Biomarkers: **expanded panel** - hormones (testosterone, estradiol, SHBG,
  DHEA-S, cortisol, IGF-1), homocysteine, uric acid, folate, magnesium, ALP,
  albumin, bilirubin, BUN, cystatin C, hematocrit, RDW, MCV, PSA, plus a
  neutrophil-to-lymphocyte derived ratio.
- Ingestion: **FHIR R4** Bundles, DiagnosticReports, and Observations are parsed
  into biomarker readings (LOINC-mapped, with code-text fallback).
- New **behavioral modality engine**: structured supplements, medications
  (with CPIC pharmacogenomic flagging), nutrition, and symptoms - scored and
  surfaced in the unified health context.
- Wearables: added **continuous glucose** (mean glucose, time-in-range,
  variability), **body composition** (body fat, visceral fat, waist, BMI), and
  **vitals** (blood pressure) metrics.
- `POST /sandbox/keys` now **pre-seeds** the synthetic tenant with multimodal
  sample data and returns the ready analysis/dashboard ids.
- `GET /analyses/:id/recommendations` now also returns tiered **protocol
  routines** (core / optimize / maintain) grouped by domain.
- Docs reorganized into Get started → Concepts → Modalities → Workflows →
  Agents & MCP → Reference, with new modality and agent pages.

- Added `POST /sandbox/keys`: instant, no-email evaluation keys bound to an
  isolated synthetic tenant (free tier, 2-hour TTL, restricted endpoints,
  per-IP mint limit), advertised in the agent manifest.
- Added discovery endpoints: `GET /analyses` (list with modality/since/limit
  filters), `GET /sources`, and `GET /sources/:id` with normalized
  observations.
- Added `POST /users/:user_id/trends`: longitudinal per-marker series across
  all uploads with improving/worsening/stable direction derived from the
  optimal-range catalog.
- Added `GET /analyses/:id/recommendations`: prioritized, de-duplicated action
  items with provenance, and `POST /analyses/:id/rerun` to refresh stored
  analyses without re-upload.
- Added `healthspan_score` and per-domain sub-scores to every analysis and
  analysis summary.
- Added MCP tools `list_analyses`, `list_sources`, `get_health_trends`, and
  `get_recommendations`.
- Dashboard: instant sandbox-key button and a full-loop quickstart (upload →
  analyze → list → recommendations → trends).
- Extended the E2E scenario with discovery, recommendations, trends, rerun,
  and sandbox tenant-isolation checks; documented the endpoint-by-endpoint
  security review in `docs-internal/api-vetting-report.md`.
- Added focused `POST /biomarkers/derive`, `POST /biomarkers/analyze`,
  `POST /wearables/analyze`, and `POST /genetics/analyze` workflows.
- Added matching MCP tools and endpoint grants for modality-scoped analysis.
- Kept `POST /analyses` as the explicit multimodal composition endpoint.
- Reworked the public documentation around developer outcomes and provider
  status while removing infrastructure and system-route documentation.

## 0.1.0 - 2026-06-17

- Added async `HealthStore` interface, idempotency records, and production
  readiness hooks.
- Added OIDC JWKS caching, sandbox bearer mode, and HS256 service-account mode.
- Enforced explicit organization resolution for non-admin protected resources.
- Added MCP `initialize`, `tools/list`, and `tools/call` support with JSON
  Schema input schemas.
- Added OpenAPI 3.1 generation at `/openapi.json`.
- Added Problem Details-style REST errors and `WWW-Authenticate` for 401s.
- Added `/v1/` route prefix support and `/version`.
- Added the initial PostgreSQL migration with tenant indexes.
- Added runnable shell and TypeScript examples.
- Added a PostgreSQL-backed durable `HealthStore` with private source-payload bucket
  support.
- Added bounded async audit logging, endpoint-claim aliases, CORS origin regex
  support, and per-route body/rate-limit overrides.
- Added hosted WGS queue, `GET /genetics/jobs/:id`, and `npm run worker:wgs`
  for asynchronous analyze-health interpretation.
- Added queued wearable sync jobs, external-account persistence, job polling,
  and `npm run worker:wearables`.

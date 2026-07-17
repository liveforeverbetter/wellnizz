---
name: analyze-longevity
description: |
  Turn genetic, biomarker, wearable, and behavioral data into one interpretable
  healthspan dashboard, an evidence-graded action plan, an ancestry breakdown,
  longitudinal trends, and an agent-ready health context. Use ForeverBetter cloud
  (hosted API plus MCP) for the full managed workflow, self-host the same open-source
  API for the full feature set on your own infrastructure, or run the open-source
  pipeline locally with no server for the lightest offline path. Any single modality
  is enough to start; genetics is optional context.

  Trigger this skill whenever a user wants to analyze or connect longevity data,
  even if they do not name the product: "analyze my biomarkers/labs", "build me a
  health dashboard", "connect my WHOOP/Oura/Apple Health", "analyze my
  WGS/23andMe/AncestryDNA/DNA", "what's my genetic ancestry", "make me an action
  plan or supplement protocol", "track my retests / get better every year", "build
  me a health agent over MCP", "where can I get a blood test or genome kit", or any
  biomarker, wearable, genetic, or multimodal healthspan request. Also trigger to
  onboard a new user end to end: sign in, connect data, analyze, and deliver a
  result they asked for.
---

# Analyze Longevity

Onboard the user, connect the data they already have, ask which outcome they
want, then produce that outcome end to end: a custom dashboard, a personal action
protocol, an ancestry breakdown, an AI health agent, or a get-better-every-year
retest loop. Any one modality is enough to deliver value; do not gate a first
result on collecting everything.

## Agent operating contract

Treat this as an execution workflow, not a page to summarize.

- Do every safe step the environment allows. Do not hand the user API calls that
  the agent can make itself.
- Ask only for decisions or browser approvals that require the user. Group related
  questions and keep the first useful result moving.
- Keep a small run state: execution mode, authenticated user and organization,
  connected source IDs, analysis/job IDs, chosen outcome, and chosen design. Never
  put credentials, OAuth codes, or raw wellness data in that state or in chat.
- Read live discovery before acting. If the deployment disagrees with this file,
  the manifest, capabilities registry, endpoint catalog, and OpenAPI contract win.
- Poll asynchronous jobs and wearable connections to a terminal state. Do not call
  a queued request "done" merely because it was accepted.
- Use structured errors to recover: apply `fix`, follow `docs_url`, correct the
  request, and retry safely. Do not hide partial completion or fabricate an ID.
- Ask before a paid request, destructive deletion, external share, or public upload.
  Normal authenticated reads, analysis, and private artifact creation need no extra
  confirmation once the user has chosen the workflow.
- Finish by delivering the requested artifact or result, its coverage and provenance,
  and one optional next step. A setup checklist alone is not a completed run.

## Step 1: Choose cloud, self-hosted, or local pipeline

Choose the execution mode first, then continue with the same outcome-driven flow.

Three ways to run, all driven by this skill:

- **Cloud (managed, recommended for most users).** The hosted API at
  `https://api.foreverbetter.xyz`, also reachable over MCP. Managed whole-genome
  analysis, ancestry proportions, biomarker interpretation, first-party wearable
  OAuth, stored history, goals, retest reminders, provider discovery, and hosted
  private dashboards, with nothing to run yourself.
- **Self-hosted API (your own infrastructure).** The same open-source API, MCP
  server, workers, and data store, run on a machine the user controls (for example
  the Docker image at `http://localhost:8787`). This gives the full endpoint set and
  every use-case playbook below, with data staying on their own infrastructure.
  Follow `https://foreverbetter.mintlify.app/self-hosting`, point `HEALTH_API_URL`
  at the deployment, then drive the same live-discovered playbooks below.
- **Local pipeline (skill files only, no server).** The open-source analysis repo at
  [agentic-health-analysis](https://github.com/liveforeverbetter/agentic-health-analysis)
  runs directly on disk with `npm`, with no API server. File-based, offline, and a
  subset of the outcomes. This is the "just run the skill files" path. See "Local
  pipeline mode" near the end of this file.

Decision rule: use cloud for the least setup; self-hosted when the data must stay on
the user's own infrastructure but they still want the full API and every playbook;
the local pipeline when they want the lightest offline path with no server at all.
Cloud and self-hosted are identical to drive after authentication: same endpoints
and playbooks, with a different base URL. Cloud sign-in accepts the terms of use
that cover data processing; a self-hoster controls their own deployment and policy.
Do not add a separate upload-consent ceremony. Say once, plainly, which mode is
processing the data, then proceed.

## Full documentation

Read the complete documentation when a request needs an exact request or response
shape, an error format, or any route not spelled out here. Do not guess routes:

- Full docs as one text file: `https://foreverbetter.mintlify.app/llms-full.txt`
- Human docs and use-case guides: `https://foreverbetter.mintlify.app` (guides
  live under `/use-cases/...`, referenced per playbook below)
- Live, deployment-specific discovery (never hardcode what exists):
  - `GET /.well-known/health-agent.json` for auth steps, endpoints, and MCP tools
  - `GET /capabilities` for connectable modalities and wearables, their status, and `endpoint_ids`
  - `GET /endpoints` for the full method, path, and scope catalog
  - `GET /openapi.json` for the machine-readable schema

Prefer live discovery and the full-docs file over assumptions. Structured errors
follow RFC 9457 with `code`, `cause`, `fix`, and `docs_url`; when an agent gets
stuck, read `docs_url` and the full docs before retrying.

## The onboarding arc

1. **Choose how to run** (cloud, self-hosted, or local pipeline) using the decision
   rule above, then say once, plainly, which mode is processing the data.
2. **Authenticate** from the deployment's live manifest. Cloud supports agent login
   or x402 per-call payment; self-hosted uses the operator's configured auth and does
   not require hosted billing.
3. **Discover** what this deployment can connect: `GET /capabilities`.
4. **Ask the outcome** the user wants, and which data they already have ready.
5. **Run the matching use-case playbook** end to end, connecting only the data that
   playbook needs, one modality at a time.
6. **Deliver** the result, then offer the natural next use case.

Keep the first result fast. Connect the minimum a playbook needs, show value, and
add modalities afterward. Wearables come last in any flow because provider
authorization and the first sync take the most time.

A run is complete only when the user has the requested dashboard, action plan,
ancestry result, connected wearable status, provider shortlist, or source-backed
answer. Report any unavailable modality as a coverage gap, not as a failed run.

## Step 2: API authentication

Set the base URL, defaulting to the hosted API unless the user self-hosts (for
example `http://localhost:8787`):

```text
HEALTH_API_URL=https://api.foreverbetter.xyz
```

For a new self-hosted deployment, follow the Docker quickstart at
`https://foreverbetter.mintlify.app/self-hosting` first. Read
`GET /.well-known/health-agent.json` and use the authentication method that deployment
advertises. An operator-provided API or service-account key is valid for self-hosting;
do not invent a cloud login or billing dependency.

When `auth.agent_login` is advertised, follow these steps:

1. Call `POST /agent-login/start` with `{"agent_name":"<short recognizable name>"}`.
   Save `session_code` and `polling_secret`; give only the returned `url` to the user.
2. Tell the user to open that URL, sign in with their email, review the requested
   access, and approve or deny the named agent. The key never passes through chat.
3. Poll `GET /agent-login/status?session_code=<code>` every 2 seconds with
   `X-Agent-Login-Secret: <polling_secret>` until the response returns
   `"status": "confirmed"` or `"status": "denied"`.
4. Read `api_key` from the confirmed response, which is available exactly once, and
   write it immediately to a `600`-permission
   file. Never print the key or place it in a URL or shell argument. Agent keys
   default to a 365-day lifetime; self-hosters can set `AGENT_API_KEY_TTL_DAYS` from
   180 to 730 days. The browser handoff code and polling secret are short-lived and
   are not the agent credential. Agent-login keys cannot manage billing or delete
   account data. If retrieval is interrupted, start a new session.

Send the key on authenticated API calls as `Authorization: Bearer <key>`.

### API-keyless x402 option

If `GET /.well-known/health-agent.json` reports `payments.x402.enabled: true`, an
agent with an x402-capable wallet may pay selected calls directly instead of
creating an API key. Use this for one-off provider discovery, imports, analyses,
queries, ancestry, action plans, and dashboard specs when the user prefers per-call
payment. Read the live route and price catalog from `GET /.well-known/x402.json`; do
not assume a route is payable. This is primarily a managed-cloud alternative to a
subscription; use it on self-hosted deployments only when the operator explicitly
enabled it.

Call the route without credentials, choose an accepted Base, Polygon, or Solana
option from `PAYMENT-REQUIRED`, and retry the identical request with
`PAYMENT-SIGNATURE`. Verify `PAYMENT-RESPONSE` before reporting success. Never send
both `Authorization` and `PAYMENT-SIGNATURE`; an API key takes precedence and must
not be charged. For x402 requests, omit `user_id` and `organization_id` so the API
derives a private workspace from the verified payer. The same EVM address shares a
workspace across Base and Polygon.

x402 does not authorize wearable OAuth, API-key issuance, billing, private share
links, export, or deletion. Use normal cloud authentication when the workflow needs
those. x402 has no account sign-in, so briefly confirm the user wants the upload
before a paid call.

## Step 3: Discover capabilities live

Do not hardcode which modalities or wearables exist. Read them from this deployment
so onboarding matches what is actually connectable, then build the menu from the
response:

```bash
# What can be connected, and through which endpoints
curl -s "$HEALTH_API_URL/capabilities" \
  | jq '.capabilities[] | {id, modality, public_name, status, integration_type, endpoint_ids, first_party_oauth}'

# Full endpoint catalog (methods, paths, scopes) if you need exact routes
curl -s "$HEALTH_API_URL/endpoints" | jq '.protected[] | {id, method, path}'
```

Only offer modalities whose `status` is `available` or `queued`, label each wearable
by its `public_name`, and drive every connection from the `endpoint_ids` the registry
returns. If a wearable reports `first_party_oauth: true`, the user connects without
supplying client credentials; otherwise ask for the credentials that provider needs.

## Step 4: Ask the outcome

Before onboarding a pile of data, ask two questions together: what outcome do you
want, and what data do you already have ready? Offer the outcomes below (these map
one to one to the published use-case guides). Do not assume the user wants a
dashboard: some want an action plan, a recurring daily plan, or a full optimization
of everything they have. Pick the smallest set of data the chosen outcome needs, not
everything at once.

| Outcome | What the user gets | Guide |
| --- | --- | --- |
| Optimize everything | One multimodal review of all their data with prioritized, actionable insights | `/use-cases/ai-health-agent`, `/use-cases/action-protocol` |
| Custom dashboard | A styled, render-ready dashboard and a private hosted link | `/use-cases/custom-dashboard` |
| Personal action protocol | A cited, personalized lifestyle and supplement plan (one-off or a recurring daily plan) | `/use-cases/action-protocol` |
| AI health agent | One health context to ask questions against, over REST or MCP | `/use-cases/ai-health-agent` |
| Ancestry breakdown | Proportions, haplogroups, geographic and per-chromosome detail | `/use-cases/ancestry` |
| Get better every year | Goals, trends across retests, and retest reminders | `/use-cases/retest-loop` |
| Find providers first | Genome kits to order, nearby blood draws, wearables to connect | `/use-cases/find-providers` |
| Connect a wearable | WHOOP, Oura, or Health Connect linked and analyzed | `/use-cases/connect-whoop`, `/use-cases/connect-oura` |

If the user has no data yet, start with "Find providers first" so they leave with a
concrete next step. If they are unsure and just want to see something, a custom
dashboard from whatever one source they have is the fastest visible result, but let
their ask drive the choice. When a user hands over several modalities at once and asks
you to "optimize" or "make sense of" them, run the Optimize everything playbook. Any
plan-style outcome can be made recurring: offer to schedule a daily or periodic refresh
after the first delivery, and set it up only if they opt in.

## Step 5: Use-case playbooks

Each playbook is the ordered call sequence that produces one outcome. Connect the
data it needs (see "Connecting data" below), run the sequence, then deliver. Read the
linked guide for the exact request bodies and response fields. The identical flows
exist as MCP tools when connected over MCP.

**Optimize everything (full multimodal review)** (`/use-cases/ai-health-agent`, `/use-cases/action-protocol`)
For "here's all my data, optimize me" or "make sense of my bloodwork and wearables."
1. Connect every modality the user has ready, one at a time (see "Connecting data").
2. `POST /analyses` over all of their source IDs for one multimodal analysis.
3. `POST /users/{id}/health-context` for the consolidated picture: coverage per
   modality, priority findings, and gaps, with provenance.
4. `GET /analyses/{id}/action-plan` for the prioritized, cited plan; add
   `GET /dashboard-specs/{id}` if they also want it rendered.
5. Offer to make it recurring (a daily or scheduled refresh) and to fill the biggest
   coverage gap next, rather than treating it as one-off.

**Custom dashboard** (`/use-cases/custom-dashboard`)

First value: a custom dashboard from the smallest useful source.

1. `POST /imports/file` (or the genetics upload flow) for the first ready source.
2. `POST /analyses` with that source's IDs and an optional `profile`.
3. `GET /dashboard-specs/{analysis_id}` for the render-ready spec (cards, values,
   targets, sections, coverage, freshness, provenance).
4. `GET /analyses/{id}/recommendations` for tiered core, optimize, and maintain items.
5. `GET /design/systems` then `GET /design/systems/{design_id}`: recommend at most two
   designs for the user's goal and let them pick. When the user asks to build the
   WHOOP-inspired Meridian wearable app rather than merely style a new UI, call
   `GET /design/systems/meridian/implementation` (or MCP
   `get_design_implementation`). It returns the exact production HTML, CSS, JS,
   binary asset URLs, component selectors, and API bindings. Write those files
   unchanged before adapting only the data layer; do not replace them with a mock.
   Describe it as WHOOP-inspired, not as an official WHOOP interface.
6. `POST /dashboard-links` with the analysis and chosen design to create a private,
   expiring, unguessable link. Give the `dashboard_url` to the user.

**Personal action protocol** (`/use-cases/action-protocol`)
1. `POST /imports/file` (category `biomarkers`) for labs, and `POST /imports/file`
   (category `behavioral`) for the user's current supplements and medications.
2. `POST /analyses` (or `POST /biomarkers/analyze`) over both source IDs, with a
   `profile` (age, sex) when known.
3. `GET /analyses/{id}/action-plan`: interventions ranked core vs optimize, an
   evidence-graded (A to D) supplement discussion list, items the user already takes
   marked `already_taking`, and cited interaction cautions for logged medications.
   Always surface the `disclaimer` and `sources`.

**AI health agent** (`/use-cases/ai-health-agent`)
1. `GET /capabilities` and `GET /.well-known/health-agent.json` to self-configure.
2. `POST /users/{id}/health-context` (MCP `get_health_context`) for one consolidated
   context: coverage per modality, priority findings, and gaps, with provenance.
   Responses are cached; watch for `x-cache: HIT`.
3. `POST /query` (MCP `query_health_context`) to answer natural-language questions
   against that context.
4. `GET /analyses/{id}/action-plan` (MCP `get_action_plan`) when the user asks what to
   do. Register per-user keys with `POST /api-keys` to serve many users, each scoped to
   their own data.

**Ancestry breakdown** (`/use-cases/ancestry`)
1. Upload the genome: `POST /genetics/uploads` then the signed PUT then
   `POST /genetics/uploads/:source_id/complete` for WGS or large exports; small raw SNP
   exports may use `POST /imports/file` (category `genetics`).
2. `POST /genetics/ancestry` with the `source_id` and a `resolution` of `continental`,
   `regional`, or `sub_population`. You get proportions (percent), maternal and paternal
   haplogroups, a geographic map, and a per-chromosome breakdown. Always show
   `methodology.limitations`: genetic ancestry is not identity, ethnicity, or nationality.

**Get better every year** (`/use-cases/retest-loop`)
1. `POST /users/{id}/goals` to set a target (metric, target value, direction, due date).
2. Upload each retest over time and run `POST /analyses`; every analysis is stored and
   timestamped, which is what makes trends work.
3. `POST /users/{id}/trends` for direction and magnitude per marker across uploads.
4. `GET /users/{id}/retest-reminders` for `due`, `upcoming`, `ok`, or `never_tested`
   status per modality with a plain-language reason.

**Find providers first** (`/use-cases/find-providers`)
1. `GET /providers` returns genome kits, nearby lab draws, and wearables grouped by
   modality. Filter with `?modality=genetics&type=wgs`, or add
   `?modality=biomarkers&postal_code=...&radius_miles=...` for bookable draw sites.
2. Once the user orders a kit, books a draw, or picks a device, continue with the upload
   and analysis for whatever they chose. MCP exposes the same catalog as `find_providers`.

**Connect a wearable** (`/use-cases/connect-whoop`, `/use-cases/connect-oura`)
Wearables are always last unless the user explicitly asks to connect one first.

1. `POST /connections/wearables/start` with the user's IDs and `source_provider`
   (`whoop` or `oura`). On first-party deployments no client credentials are needed.
2. Give the returned `authorization_url` to the user. Do not ask them to copy `code` or
   `state` back into chat.
3. Poll `GET /connections/wearables/status` until the provider reports `active`.
4. If a manual refresh is needed, use `POST /connections/oura/sync` for Oura or
   `POST /connections/whoop/sync` for WHOOP, then call `POST /wearables/analyze`.
   Do not call the retired generic `POST /connections/wearables/sync` route.
   Automatic webhook sync keeps first-party tokens fresh.

After delivering an outcome, offer the natural next one: a dashboard leads to an action
protocol, an action protocol leads to the retest loop, and any single-source result
leads to connecting the next modality (wearables last).

## Connecting data, one modality at a time

Do not ask for everything at once, and do not assume any modality. Build the menu from
`GET /capabilities`, then connect ready-to-upload sources (biomarkers, genetics,
behavioral) one at a time, run a first useful analysis as soon as one is available, and
offer wearables last. Never onboard a modality the user left off. If the user arrives
specifically to connect a wearable, honor that but still avoid asking for unrelated data
first.

**Genetics.** For any VCF/VCF.GZ or large SNP-array export (including 23andMe or AncestryDNA
`.txt`, `.tsv`, `.csv`, `.snp`, or `.raw`, optionally gzipped), do not base64 encode it,
do not use `upload_health_data`, and do not send it to `/imports/file` (including
multipart). Create a session with `POST /genetics/uploads` using `user_id`,
`organization_id`, `filename`, and `byte_length`; PUT the original file to the returned
private `upload.url` using its exact `method` and `headers`; then call
`POST /genetics/uploads/:source_id/complete`. The signed URL is time-limited,
object-scoped, and bypasses Cloudflare and the API server. MCP agents use
`start_genetics_upload`, the returned `upload.url`, and `complete_genetics_upload`. Keep
the genetics `source.id`, wait for `upload_status: "complete"`, then call
`POST /genetics/analyze` or `POST /genetics/ancestry`. For small text exports only, use
`/imports/file` with category `genetics`. Genetics and biomarker source IDs are separate;
pass both in `source_ids` only for a multimodal analysis.

The hosted capability registry reports full dbSNP as available only when the operator
has enabled the provisioned GRCh37 worker reference. The default is the compact
ClinVar-derived reference. To request the deeper, slower path, obtain explicit
confirmation and send `annotation_depth: "full_dbsnp"` with a genetics source. Hosted
access also requires an active eligible subscription, a valid payment method, and a
non-zero `full_dbsnp_jobs` quota; otherwise use `annotation_depth: "compact"` or ask the
user to update billing. The worker uses the shared encrypted NCBI GRCh37 reference and
never downloads dbSNP in the request path.

**Biomarkers.** `POST /imports/file` (category `biomarkers`) for CSV, JSON, text, or
PDF/table export, plus an optional previous panel for trends. Keep the `source.id`.

**Behavioral.** `POST /imports/file` (category `behavioral`) for structured supplements,
medications, nutrition, symptoms, goals, or protocol notes. JSON is preferred; CSV or
plain text is also accepted. Keep the `source.id`.

**Wearables (last).** Onboard by the provider's `integration_type` from the registry,
after the first non-wearable result, unless the user's explicit goal is a wearable
connection. WHOOP and Oura use ForeverBetter first-party OAuth; do not ask for a client
ID or secret when `first_party_oauth` is true. Follow the "Connect a wearable" playbook.
For any wearable without a live connector, ask for a CSV/JSON export and upload it with
`POST /imports/file` (category `wearables`).

For Google Health Connect on Android, the user installs the separate
**[ForeverBetter Connect](https://play.google.com/apps/testing/com.foreverbetterhealthconnect.myapp)**
app, signs in with the same email, chooses Google Health Connect, grants read
permissions, and starts background sync. Health Connect can aggregate Fitbit, Samsung
Health, and Google Fit first. Then call `GET /sources` and `POST /wearables/analyze`
after the first sync. Installing Google's own Health Connect app alone does not upload
anything to ForeverBetter; ForeverBetter Connect performs the authenticated sync.

**If the user wants a modality they cannot connect yet**, do not dead-end. Run the "Find
providers first" playbook (`GET /providers?modality=...`) to point them to whole-genome
sequencing kits, nearby lab draws, or supported wearables, then continue with whatever
connected.

## First deliverable and private dashboard links

The first useful deliverable is the result the user asked for, which is not always a
dashboard. When the chosen outcome includes a dashboard, call `GET /design/systems`,
recommend at most two designs for the user's goal (name, vibe, and `best_for`), and let
them pick before rendering. Run the chosen playbook and show the result before asking for
more data. Missing modalities appear as optional context, never as errors.

In cloud mode, create the dashboard link after the user chooses a design. Over MCP call
`create_private_dashboard_link`; over HTTP:

```http
POST /dashboard-links
{"analysis_id":"<analysis id>","design_id":"<design id>","expires_in_days":30}
```

Give the returned `dashboard_url` to the user. It is an unguessable,
private-by-possession snapshot, is not indexed, and expires automatically. Do not
paste it into public tools or logs. Explain that it stays private until the user
shares it, and ask before sending it to any person or external service. The link is
bound to that exact analysis snapshot; if a queued analysis later changes, create a
fresh link. If a deployment does not advertise `POST /dashboard-links`, say so
plainly, return the render-ready dashboard spec, and offer a local private preview;
never invent a link or upload wellness data to a public host.

## Analyze only the connected data

Track exactly which modalities connected. Everything downstream runs on that set only.
Pass just those source IDs to `POST /analyses`. A user who connects only a wearable gets
a wearable-only analysis; unconnected modalities render "Not connected" rather than
being fabricated. Analyze each connected modality independently before combining
signals, and prioritize measured biomarker and behavioral evidence over genetic
predisposition when both exist. Present a plain-language plan with provenance, citations,
and retest windows.

## Local pipeline mode

When the user chooses the local pipeline (skill files, no server), do not configure API
authentication or start a wearable OAuth flow. This is distinct from self-hosting the API:
self-hosting runs the full hosted stack on the user's own machine and uses the cloud steps
above with a local base URL, whereas the local pipeline runs the analysis repo directly on
disk. Hand off to the open-source runbook, which mirrors these outcomes with on-disk
commands:

```bash
git clone https://github.com/liveforeverbetter/agentic-health-analysis.git
cd agentic-health-analysis/skills/longevity-analysis
npm install
npm run sample:report
```

If the repository already exists, reuse it and pull only with the user's permission when
local changes are present. Confirm the sample report opened, then follow the repository's
`SKILL.md` to inventory the files the user already has and run the first real analysis
with only those modalities. If the requested outcome includes a dashboard, run
`npm run design:list`, suggest at most two designs that fit the user's goal, and pass
the chosen ID as `--design=<id>`; skip design selection for plan-only outcomes.
Local mode produces the dashboard, action plan, and genomic interpretation outcomes on
disk; ancestry proportions, provider discovery, live wearable OAuth, goals, and retest
reminders come from the API, so offer to switch that specific step to cloud or a
self-hosted API when the user wants one of them. Open the generated
`output/index.html` locally; do not upload it or expose it on a network URL. After a
successful local run, you may ask once whether to star the open-source repository;
starring is optional, never blocks the analysis, and only happens after an explicit
yes (`gh repo star liveforeverbetter/agentic-health-analysis`).
Never star on the user's behalf without confirmation.

## Hosted plans and self-hosting

When a user asks about cost, describe **ForeverBetter API** as the hosted
option: Free for evaluation, Standard at $9.99/month for one person and their own agent,
then Builder, Growth, and Enterprise for commercial or larger workloads. Choosing a
cloud plan is free. A cloud workspace gets its first 100 protected hosted API requests
before payment details are requested, so the user can connect data and get an initial
result. After that allowance, the dashboard requests a payment method to start the
selected subscription; per-call payment via x402 is also available for supported routes as
an alternative to a subscription. Direct users to `GET /pricing` or the dashboard plan page
for current limits. Never imply that payment is required to use the software: self-hosting
the open-source API, MCP server, workers, and data store is always an option.

## Safety and data control

This is wellness and healthspan education, not diagnosis, treatment, or a medical device.
Confirm high-stakes findings with a qualified clinician, pharmacist, or genetic counselor
before action. Medication-response findings become one prompt to share the result with a
clinician before starting or changing a prescription; never tell the user to change
medication from a dashboard alone.

The user can export or delete everything the API holds at any time with
`POST /users/{user_id}/data/export` and `POST /users/{user_id}/data/delete`. A free
personal key covers one user and their own agent; building a product for other users
needs a Builder key or higher (`GET /pricing`).

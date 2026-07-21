#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SignJWT } from 'jose';

const ENDPOINTS = [
  'capabilities.read',
  'pricing.read',
  'api_keys.create',
  'webhooks.read',
  'connections.start',
  'connections.callback',
  'connections.auth_url',
  'connections.sync',
  'connections.jobs.read',
  'imports.file',
  'analyses.create',
  'analyses.read',
  'analyses.list',
  'analyses.recommendations.read',
  'sources.list',
  'sources.read',
  'trends.read',
  'biomarkers.derive',
  'biomarkers.analyze',
  'wearables.analyze',
  'genetics.analyze',
  'genetics.jobs.read',
  'dashboard_specs.read',
  'health_context.read',
  'query.create',
  'labs.search',
  'data.export',
  'data.delete',
];

const args = parseArgs(process.argv.slice(2));
const baseUrl = String(args.get('base-url') ?? process.env.HEALTH_API ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const timeoutMs = Number(args.get('timeout-ms') ?? process.env.E2E_TIMEOUT_MS ?? '15000');
const runId = String(args.get('run-id') ?? new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14));
const userId = String(args.get('user-id') ?? `e2e_user_${runId}`);
const organizationId = String(args.get('organization-id') ?? `e2e_org_${runId}`);
const cleanup = args.has('cleanup') ? args.get('cleanup') !== 'false' : process.env.E2E_CLEANUP !== 'false';
let bearerToken = String(args.get('token') ?? process.env.E2E_BEARER_TOKEN ?? '');

const checks = [];
const summary = {
  base_url: baseUrl,
  user_id: userId,
  organization_id: organizationId,
  storage_mode: 'unknown',
  api_key_issued: false,
  source_ids: [],
  scoped_analysis_ids: {},
  analysis_id: undefined,
  genetic_job_id: undefined,
  mobile_source_id: undefined,
  export_counts: undefined,
  deletion_receipt_id: undefined,
};

if (!bearerToken) bearerToken = await maybeMintAdminToken();

await step('health responds', async () => {
  const { body } = await request('GET', '/health', { auth: false });
  assert(body.ok === true, '/health did not return ok=true');
});

await step('readiness is healthy', async () => {
  const { body } = await request('GET', '/ready', { auth: false });
  assert(body.ok === true, readinessFailure(body));
  summary.storage_mode = body.storage?.checks?.store ?? body.store?.checks?.store ?? body.store?.mode ?? 'unknown';
});

await step('public metadata endpoints are available', async () => {
  const [version, openapi, manifest, endpoints, capabilities, pricing] = await Promise.all([
    request('GET', '/version', { auth: false }),
    request('GET', '/openapi.json', { auth: false }),
    request('GET', '/.well-known/health-agent.json', { auth: false }),
    request('GET', '/endpoints', { auth: false }),
    request('GET', '/capabilities', { auth: false }),
    request('GET', '/pricing', { auth: false }),
  ]);
  assert(version.body.service === 'wellnizz-api', 'unexpected /version service');
  assert(openapi.body.info?.title === 'Wellnizz API', 'OpenAPI title is not current');
  assert(manifest.body.name === 'Wellnizz API', 'agent manifest name is not current');
  assert(Array.isArray(endpoints.body.protected) && endpoints.body.protected.length > 0, '/endpoints did not return protected endpoint metadata');
  assert(
    Array.isArray(capabilities.body.capabilities)
      && capabilities.body.capabilities.some(capability => capability.modality === 'wearables'),
    '/capabilities missing wearables modality',
  );
  assert(pricing.body.enforcement?.pricing_boundary, '/pricing missing pricing boundary');
});

await step('bootstrap token can issue a user-scoped free API key', async () => {
  requireBearer();
  const { body } = await request('POST', '/api-keys', {
    expectedStatus: 201,
    body: {
      name: 'e2e personal agent key',
      user_id: userId,
      organization_id: organizationId,
      tier: 'free',
      intended_use: 'personal_agent',
      scopes: ['health:data:read', 'health:data:write', 'health:connections:write', 'health:labs:read'],
      enabled_endpoints: ENDPOINTS,
      expires_in_days: 7,
    },
  });
  assert(typeof body.api_key === 'string' && body.api_key.length > 20, 'API key response did not include a token');
  assert(body.created?.user_id === userId, 'issued API key user_id mismatch');
  bearerToken = body.api_key;
  summary.api_key_issued = true;
  summary.api_key_preview = maskToken(body.api_key);
});

await step('commercial apps cannot use the free tier', async () => {
  const { body } = await request('POST', '/api-keys', {
    expectedStatus: 400,
    body: {
      user_id: userId,
      organization_id: organizationId,
      tier: 'free',
      intended_use: 'app_platform_service',
    },
  });
  assert(String(body.detail ?? body.message ?? '').includes('Free API keys'), 'free-tier commercial rejection message changed');
});

await step('wearable OAuth setup works for Oura and WHOOP', async () => {
  const oura = await request('POST', '/connections/oura/auth-url', {
    body: {
      client_id: 'e2e-oura-client',
      redirect_uri: 'https://wearables.foreverbetter.xyz/oauth/callback',
      state: `state_${runId}`,
    },
  });
  assert(String(oura.body.authorization_url).startsWith('https://cloud.ouraring.com/oauth/authorize'), 'Oura auth URL is malformed');

  const whoop = await request('POST', '/connections/whoop/auth-url', {
    body: {
      client_id: 'e2e-whoop-client',
      redirect_uri: 'https://wearables.foreverbetter.xyz/oauth/callback',
      state: `state_${runId}`,
    },
  });
  assert(String(whoop.body.authorization_url).startsWith('https://api.prod.whoop.com/oauth/oauth2/auth'), 'WHOOP auth URL is malformed');
});

await step('wearables connection start stores an event', async () => {
  const { body } = await request('POST', '/connections/wearables/start', {
    body: {
      user_id: userId,
      organization_id: organizationId,
      source_provider: 'oura',
      client_id: 'e2e-oura-client',
      redirect_uri: 'https://wearables.foreverbetter.xyz/oauth/callback',
      state: `state_${runId}`,
    },
  });
  assert(body.provider === 'wearables', 'wearables start provider mismatch');
  assert(body.source_provider === 'oura', 'wearables start source_provider mismatch');
  assert(typeof body.connection_event_id === 'string', 'wearables start did not emit an event');
});

await step('Health Connect returns the direct mobile bridge contract', async () => {
  const { body } = await request('POST', '/connections/wearables/start', {
    body: {
      user_id: userId,
      organization_id: organizationId,
      source_provider: 'health_connect',
      client_id: 'e2e-health-connect',
      redirect_uri: 'https://wearables.foreverbetter.xyz/oauth/callback',
    },
  });
  assert(body.connection_type === 'mobile_bridge', 'Health Connect did not return the mobile bridge contract');
  assert(Array.isArray(body.data_types) && body.data_types.includes('steps'), 'Health Connect data types are missing');
});

await step('mobile SDK sync stores Health Connect observations', async () => {
  const { body } = await request('POST', `/api/v1/sdk/users/${encodeURIComponent(userId)}/sync`, {
    expectedStatus: 202,
    body: {
      provider: 'health_connect',
      sdkVersion: 'e2e',
      syncTimestamp: new Date().toISOString(),
      data: {
        records: [
          { id: `steps-${runId}`, type: 'steps', value: 8420, unit: 'steps', startDate: '2026-06-07T00:00:00Z', endDate: '2026-06-07T23:59:59Z' },
        ],
      },
    },
  });
  assert(body.status === 'accepted', 'mobile SDK sync was not accepted');
  assert(typeof body.source_id === 'string', 'mobile SDK sync source id missing');
  summary.mobile_source_id = body.source_id;
});

const biomarkerSource = await importFixture('biomarkers', 'test/fixtures/biomarkers-full-panel.csv', {
  category: 'biomarkers',
  provider: 'e2e_lab',
  content_type: 'text/csv',
});

const wearableSource = await importFixture('wearables', 'test/fixtures/wearables-week.csv', {
  category: 'wearables',
  provider: 'e2e_wearable_export',
  content_type: 'text/csv',
});

const geneticSource = await importFixture('genetics', 'test/fixtures/genetic-sample.vcf', {
  category: 'genetics',
  provider: 'e2e_wgs_fixture',
  content_type: 'text/vcf',
});

await step('modality-scoped analyses enforce focused source types', async () => {
  const derive = await request('POST', '/biomarkers/derive', {
    expectedStatus: 201,
    body: {
      user_id: userId,
      organization_id: organizationId,
      source_ids: [biomarkerSource.id],
      profile: { age: 41, sex: 'male' },
    },
  });
  assert(derive.body.modality === 'biomarkers', 'derive response modality mismatch');
  assert(derive.body.operation === 'derive', 'derive response operation mismatch');
  assert(
    derive.body.derived_interpretations.every(item => item.type === 'derived_biomarker'),
    'derive response included non-derived findings',
  );

  const wearables = await request('POST', '/wearables/analyze', {
    expectedStatus: 201,
    body: {
      user_id: userId,
      organization_id: organizationId,
      source_ids: [wearableSource.id],
    },
  });
  assert(wearables.body.modality === 'wearables', 'wearable analysis modality mismatch');

  const genetics = await request('POST', '/genetics/analyze', {
    expectedStatus: 201,
    body: {
      user_id: userId,
      organization_id: organizationId,
      source_ids: [geneticSource.id],
    },
  });
  assert(genetics.body.modality === 'genetics', 'genetic analysis modality mismatch');

  const rejected = await request('POST', '/biomarkers/analyze', {
    expectedStatus: 400,
    body: {
      user_id: userId,
      organization_id: organizationId,
      source_ids: [wearableSource.id],
    },
  });
  assert(String(rejected.body.detail ?? '').includes('biomarkers'), 'mixed-modality rejection changed');

  summary.scoped_analysis_ids = {
    biomarkers: derive.body.id,
    wearables: wearables.body.id,
    genetics: genetics.body.id,
  };
});

await step('analysis runs across biomarkers, wearables, and genetics', async () => {
  const { body } = await request('POST', '/analyses', {
    idempotencyKey: `analysis-${runId}`,
    expectedStatus: 201,
    body: {
      user_id: userId,
      organization_id: organizationId,
      source_ids: [biomarkerSource.id, wearableSource.id, geneticSource.id],
      profile: { age: 41, sex: 'male' },
    },
  });
  assert(typeof body.id === 'string', 'analysis id missing');
  assert(body.source_ids?.length === 3, 'analysis did not include all three sources');
  assert(Array.isArray(body.normalized_observations) && body.normalized_observations.length > 0, 'analysis did not include normalized observations');
  assert(Array.isArray(body.derived_interpretations) && body.derived_interpretations.length > 0, 'analysis did not include derived interpretations');
  summary.analysis_id = body.id;
  summary.genetic_job_id = geneticJobId(body);
});

await step('analysis, dashboard, query, and health context are readable', async () => {
  const analysis = await request('GET', `/analyses/${encodeURIComponent(summary.analysis_id)}`);
  assert(analysis.body.id === summary.analysis_id, 'GET /analyses/:id returned the wrong analysis');

  const dashboard = await request('GET', `/dashboard-specs/${encodeURIComponent(summary.analysis_id)}`);
  assert(Array.isArray(dashboard.body.cards) && dashboard.body.cards.length > 0, 'dashboard spec has no cards');

  const query = await request('POST', '/query', {
    body: {
      user_id: userId,
      organization_id: organizationId,
      analysis_ids: [summary.analysis_id],
      query: 'What should I pay attention to across ApoB, HRV, and genetics?',
    },
  });
  assert(Array.isArray(query.body.matches), 'query response missing matches array');

  const context1 = await request('POST', `/users/${encodeURIComponent(userId)}/health-context`, {
    body: { organization_id: organizationId, analysis_ids: [summary.analysis_id], max_findings: 10 },
  });
  assert(context1.headers.get('x-cache') === 'MISS', 'first health-context request should be a cache miss');
  assert(context1.body.user_id === userId, 'health context user_id mismatch');

  const context2 = await request('POST', `/users/${encodeURIComponent(userId)}/health-context`, {
    body: { organization_id: organizationId, analysis_ids: [summary.analysis_id], max_findings: 10 },
  });
  assert(context2.headers.get('x-cache') === 'HIT', 'second health-context request should be a cache hit');
});

await step('sources and analyses are discoverable after upload', async () => {
  const sources = await request('GET', `/sources?user_id=${encodeURIComponent(userId)}&organization_id=${encodeURIComponent(organizationId)}`);
  assert(sources.body.count >= 3, `expected at least 3 discoverable sources, got ${sources.body.count}`);
  assert(sources.body.sources.every(source => source.user_id === userId), 'source listing leaked another user');

  const biomarkersOnly = await request('GET', `/sources?user_id=${encodeURIComponent(userId)}&organization_id=${encodeURIComponent(organizationId)}&category=biomarkers`);
  assert(biomarkersOnly.body.sources.every(source => source.category === 'biomarkers'), 'category filter returned mixed sources');

  const sourceDetail = await request('GET', `/sources/${encodeURIComponent(biomarkerSource.id)}`);
  assert(sourceDetail.body.source?.id === biomarkerSource.id, 'GET /sources/:id returned the wrong source');
  assert(Array.isArray(sourceDetail.body.normalized_observations) && sourceDetail.body.normalized_observations.length > 0, 'source detail missing normalized observations');

  const analyses = await request('GET', `/analyses?user_id=${encodeURIComponent(userId)}&organization_id=${encodeURIComponent(organizationId)}`);
  assert(analyses.body.analyses.some(item => item.id === summary.analysis_id), 'GET /analyses did not list the stored analysis');
  const listed = analyses.body.analyses.find(item => item.id === summary.analysis_id);
  assert(Array.isArray(listed.source_ids) && listed.source_ids.length === 3, 'analysis summary missing source ids');

  const scoped = await request('GET', `/analyses?user_id=${encodeURIComponent(userId)}&organization_id=${encodeURIComponent(organizationId)}&modality=biomarkers`);
  assert(scoped.body.analyses.every(item => item.modality === 'biomarkers'), 'modality filter returned mixed analyses');
});

await step('recommendations surface prioritized action items', async () => {
  const { body } = await request('GET', `/analyses/${encodeURIComponent(summary.analysis_id)}/recommendations`);
  assert(Array.isArray(body.recommendations), 'recommendations response missing recommendations array');
  assert(body.recommendations.length > 0, 'analysis produced no recommendations');
  assert(body.recommendations.every(item => typeof item.action === 'string' && item.action.length > 0), 'recommendation missing action text');
  assert(body.recommendations.every(item => item.status !== 'optimal'), 'recommendations included already-optimal findings');
  const rank = { high: 0, medium: 1, info: 2, low: 3 };
  const priorities = body.recommendations.map(item => rank[item.priority]);
  assert(priorities.every(value => value !== undefined), 'recommendation carried an unknown priority');
  assert(priorities.every((value, index) => index === 0 || priorities[index - 1] <= value), 'recommendations are not priority-ordered');
});

await step('trends compute longitudinal direction across uploads', async () => {
  await request('POST', '/imports/file', {
    idempotencyKey: `import-biomarkers-followup-${runId}`,
    expectedStatus: 201,
    body: {
      user_id: userId,
      organization_id: organizationId,
      category: 'biomarkers',
      filename: 'follow-up-panel.json',
      content_type: 'application/json',
      text: JSON.stringify({ readings: [
        { marker: 'ApoB', value: 88, unit: 'mg/dL', collected_at: '2027-01-05' },
        { marker: 'HDL-C', value: 61, unit: 'mg/dL', collected_at: '2027-01-05' },
      ] }),
    },
  });
  const { body } = await request('POST', `/users/${encodeURIComponent(userId)}/trends`, {
    body: { organization_id: organizationId },
  });
  assert(Array.isArray(body.markers) && body.markers.length > 0, 'trends response missing markers');
  assert(body.marker_count === body.markers.length, 'trend marker_count does not match markers');
  const apob = body.markers.find(marker => marker.marker === 'apob');
  assert(apob, 'expected an ApoB trend across uploads');
  assert(apob.points.length >= 2, 'ApoB trend did not span multiple uploads');
  assert(['improving', 'worsening', 'stable'].includes(apob.trend), `ApoB trend has no direction: ${apob.trend}`);
  const filtered = await request('POST', `/users/${encodeURIComponent(userId)}/trends`, {
    body: { organization_id: organizationId, modality: 'wearables' },
  });
  assert(filtered.body.markers.every(marker => marker.modality === 'wearables'), 'trend modality filter returned mixed markers');
});

await step('stored analysis can be re-run without re-upload', async () => {
  const { body } = await request('POST', `/analyses/${encodeURIComponent(summary.analysis_id)}/rerun`, { expectedStatus: 201 });
  assert(typeof body.id === 'string' && body.id !== summary.analysis_id, 'rerun did not create a new analysis');
  assert(body.source_ids?.length === 3, 'rerun lost source references');
});

await step('public synthetic sandbox behavior is explicit', async () => {
  const session = await request('POST', '/sandbox/sessions', { auth: false, expectedStatus: [201, 404], body: {} });
  if (session.response.status === 404) {
    assert(String(session.body.detail ?? '').includes('not enabled'), 'disabled sandbox did not return the expected explanation');
    return;
  }
  assert(typeof session.body.access_token === 'string', 'enabled sandbox did not return an access token');
  assert(session.body.synthetic === true, 'enabled sandbox did not identify its synthetic data boundary');
});

await step('queued genetic job is readable when queue mode is enabled', async () => {
  if (!summary.genetic_job_id) {
    console.log('skip - no queued genetic job was created; pipeline likely ran synchronously');
    return;
  }
  const { body } = await request('GET', `/genetics/jobs/${encodeURIComponent(summary.genetic_job_id)}`);
  assert(['queued', 'running', 'complete'].includes(body.status), `genetic job has unexpected status: ${body.status}`);
  assert(body.analysis_id === summary.analysis_id, 'genetic job analysis_id mismatch');
});

await step('lab locator handoffs are available', async () => {
  const { body } = await request('GET', '/labs/search?provider=all&postal_code=10001&country=US');
  assert(Array.isArray(body.results) && body.results.length >= 1, 'lab search returned no locator handoffs');
});

await step('webhook events include the scenario events', async () => {
  const { body } = await request('GET', `/webhook-events?user_id=${encodeURIComponent(userId)}&organization_id=${encodeURIComponent(organizationId)}&limit=50`);
  assert(Array.isArray(body.events), 'webhook events response missing events array');
  const eventTypes = new Set(body.events.map(event => event.type));
  assert(eventTypes.has('source.imported'), 'webhook events missing source.imported');
  assert(eventTypes.has('connection.started'), 'webhook events missing connection.started');
});

await step('export returns portability data', async () => {
  const { body } = await request('POST', `/users/${encodeURIComponent(userId)}/data/export`, {
    body: { organization_id: organizationId },
  });
  assert(body.counts?.sources >= 3, 'export did not include imported sources');
  assert(body.counts?.analyses >= 1, 'export did not include analysis');
  summary.export_counts = body.counts;
});

if (cleanup) {
  await step('delete tombstones the scenario data', async () => {
    const { body } = await request('POST', `/users/${encodeURIComponent(userId)}/data/delete`, {
      body: { organization_id: organizationId },
    });
    assert(body.sources >= 3, 'delete did not tombstone imported sources');
    assert(typeof body.receipt_id === 'string', 'delete did not return a receipt');
    summary.deletion_receipt_id = body.receipt_id;

    const deleted = await request('GET', `/analyses/${encodeURIComponent(summary.analysis_id)}`, { expectedStatus: 404 });
    assert((deleted.body.title ?? deleted.body.error) !== undefined, 'deleted analysis did not return problem details');
  });
}

console.log(`E2E scenario passed: ${checks.length}/${checks.length} checks passed.`);
console.log(JSON.stringify(redactSummary(summary), null, 2));

async function importFixture(label, fixturePath, input) {
  let source;
  await step(`imports ${label} fixture`, async () => {
    const text = await readFile(resolve(fixturePath), 'utf8');
    const { body } = await request('POST', '/imports/file', {
      idempotencyKey: `import-${label}-${runId}`,
      expectedStatus: 201,
      body: {
        user_id: userId,
        organization_id: organizationId,
        filename: fixturePath.split('/').pop(),
        text,
        ...input,
      },
    });
    assert(typeof body.source?.id === 'string', `${label} import missing source id`);
    assert(Array.isArray(body.normalized_observations), `${label} import missing normalized observations`);
    source = body.source;
    summary.source_ids.push(source.id);
  });
  return source;
}

async function request(method, path, options = {}) {
  const url = `${baseUrl}${path}`;
  const headers = new Headers(options.headers ?? {});
  if (options.auth !== false) {
    requireBearer();
    headers.set('authorization', `Bearer ${bearerToken}`);
  }
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey);
  const response = await fetchWithTimeout(url, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const expected = Array.isArray(options.expectedStatus)
    ? options.expectedStatus
    : [options.expectedStatus ?? 200];
  const text = await response.text();
  const body = text ? safeJson(text, path) : {};
  if (!expected.includes(response.status)) {
    throw new Error(`${method} ${path} returned ${response.status}, expected ${expected.join(' or ')}: ${text.slice(0, 500)}`);
  }
  return { response, headers: response.headers, body };
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function step(name, fn) {
  try {
    await fn();
    checks.push(name);
    if (!name.startsWith('queued genetic job')) console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function parseArgs(argv) {
  const parsed = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    if (token.includes('=')) {
      const [rawKey, ...rest] = token.split('=');
      parsed.set(rawKey.slice(2), rest.join('=') || 'true');
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      parsed.set(key, 'true');
    } else {
      parsed.set(key, next);
      i += 1;
    }
  }
  return parsed;
}

async function maybeMintAdminToken() {
  const serviceAccountSecret = process.env.SERVICE_ACCOUNT_JWT_SECRET;
  const apiKeySecret = process.env.API_KEY_JWT_SECRET;
  const secret = serviceAccountSecret ?? apiKeySecret;
  if (!secret) return '';
  const audience = (process.env.AUTH_AUDIENCE ?? 'foreverbetter-api').split(',')[0].trim();
  const payload = {
    user_id: serviceAccountSecret ? 'e2e-admin' : userId,
    scope: `${serviceAccountSecret ? 'health:admin ' : ''}health:data:read health:data:write health:connections:write health:labs:read`,
    organization_id: organizationId,
    enabled_endpoints: ENDPOINTS,
    ...(serviceAccountSecret ? {} : { token_type: 'api_key' }),
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setAudience(audience)
    .setSubject(serviceAccountSecret ? 'e2e-admin' : `e2e-bootstrap-${runId}`)
    .setIssuedAt()
    .setExpirationTime('20m')
    .sign(new TextEncoder().encode(secret));
}

function requireBearer() {
  if (!bearerToken) {
    throw new Error('No bearer token available. Pass --token, set E2E_BEARER_TOKEN, or run with SERVICE_ACCOUNT_JWT_SECRET/API_KEY_JWT_SECRET so this script can mint a short-lived admin test token.');
  }
}

function safeJson(text, path) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON response: ${text.slice(0, 300)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function geneticJobId(analysis) {
  const queued = analysis.derived_interpretations?.find(item => item.type === 'genetic_pipeline_queued');
  return queued?.raw && typeof queued.raw === 'object' ? queued.raw.job_id : undefined;
}

function maskToken(token) {
  if (!token || token.length < 20) return '<redacted>';
  return `${token.slice(0, 8)}...${token.slice(-6)}`;
}

function readinessFailure(body) {
  return `readiness failed: ${JSON.stringify(body, null, 2)}`;
}

function redactSummary(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === 'string' && item.includes('.')) return item.length > 80 ? maskToken(item) : item;
    return item;
  }));
}

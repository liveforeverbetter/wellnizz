import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createHealthApiServer } from '../src/http.js';
import { createPrivateDashboardLink, dashboardSpecMatchesSnapshot, renderPrivateDashboard, verifyPrivateDashboardToken } from '../src/core/dashboard-links.js';
import { getDesignSystem } from '../src/core/design-systems.js';
import { loadAuthConfig } from '../src/auth.js';
import { personalOrganizationId } from '../src/pricing.js';
import { HealthApiStore } from '../src/store.js';

// Enables /api-keys issuance on the default (auth-disabled) server.
process.env.API_KEY_JWT_SECRET ??= 'test-api-key-secret';
// This file intentionally exercises the shared server with more than the
// production per-window request budget. Keep rate-limit behavior covered by
// the dedicated quota server below instead of making test order significant.
process.env.RATE_LIMIT_MAX ??= '1000';

const server = createHealthApiServer();
let baseUrl = '';

before(async () => {
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('imports biomarkers, runs analysis, queries context, and returns a dashboard spec', async () => {
  const imported = await post('/imports/file', {
    user_id: 'user_test',
    category: 'biomarkers',
    filename: 'labs.csv',
    content_type: 'text/csv',
    text: 'marker,value,unit\nApoB,118,mg/dL\nHbA1c,5.7,%\nFasting Insulin,12,uIU/mL\nGlucose,96,mg/dL\n',
  });

  assert.equal(imported.source.category, 'biomarkers');
  assert.ok(imported.normalized_observations.length >= 4);

  const analysis = await post('/analyses', {
    user_id: 'user_test',
    source_ids: [imported.source.id],
    profile: { age: 42, sex: 'male' },
  });

  assert.equal(analysis.raw_source_references.length, 1);
  assert.ok(analysis.derived_interpretations.length > 0);
  assert.ok(analysis.dashboard_spec.cards.length > 0);
  assert.equal(analysis.dashboard_spec.schema_version, '1.0');
  assert.equal(analysis.dashboard_spec.quality.usable, true);
  assert.equal(analysis.dashboard_spec.quality.status, 'partial');
  assert.equal(analysis.dashboard_spec.coverage.find((item: any) => item.modality === 'biomarkers').present, true);
  assert.ok(analysis.dashboard_spec.sections.some((section: any) => section.category === 'biomarkers'));
  const apoBCard = analysis.dashboard_spec.cards.find((card: any) => card.title === 'ApoB');
  assert.equal(apoBCard.value, 118);
  assert.equal(apoBCard.unit, 'mg/dL');
  assert.equal(apoBCard.target.max, 80);
  assert.equal(apoBCard.visualization, 'range');
  assert.equal(apoBCard.confidence, 'high');
  assert.ok(apoBCard.provenance.source_ids.includes(imported.source.id));

  const query = await post('/query', {
    user_id: 'user_test',
    analysis_ids: [analysis.id],
    query: 'ApoB',
  });
  assert.ok(query.matches.length > 0);

  const dashboard = await get(`/dashboard-specs/${analysis.id}`);
  assert.equal(dashboard.analysis_id, analysis.id);
});

test('creates an expiring private dashboard link in the selected design', async () => {
  const imported = await post('/imports/file', {
    user_id: 'private_dashboard_user',
    category: 'biomarkers',
    filename: 'labs.csv',
    content_type: 'text/csv',
    text: 'marker,value,unit\nApoB,118,mg/dL\nHbA1c,5.7,%\n',
  });
  const analysis = await post('/analyses', {
    user_id: 'private_dashboard_user',
    source_ids: [imported.source.id],
  });

  const link = await post('/dashboard-links', {
    analysis_id: analysis.id,
    design_id: 'aperture',
    expires_in_days: 7,
  });
  assert.equal(link.analysis_id, analysis.id);
  assert.equal(link.design.id, 'aperture');
  assert.equal(link.visibility, 'private_by_possession');
  assert.match(link.dashboard_url, /\/dashboards\/private\//);

  const rendered = await fetch(link.dashboard_url);
  assert.equal(rendered.status, 200);
  assert.match(rendered.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(rendered.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.match(rendered.headers.get('x-robots-tag') ?? '', /noindex/);
  assert.match(rendered.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(rendered.headers.get('x-frame-options'), 'DENY');
  assert.equal(rendered.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(rendered.headers.get('x-content-type-options'), 'nosniff');
  const html = await rendered.text();
  assert.match(html, /Aperture private health dashboard/);
  assert.match(html, /ApoB/);
  assert.match(html, /Private link/);

  const tamperedUrl = `${link.dashboard_url.slice(0, -1)}${link.dashboard_url.endsWith('a') ? 'b' : 'a'}`;
  assert.equal((await fetch(tamperedUrl)).status, 404);

  const invalidExpiry = await fetch(`${baseUrl}/dashboard-links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ analysis_id: analysis.id, design_id: 'aperture', expires_in_days: 0 }),
  });
  assert.equal(invalidExpiry.status, 400);
  assert.match((await invalidExpiry.json()).detail, /integer from 1 to 90/);

  const invalidBody = await fetch(`${baseUrl}/dashboard-links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'null',
  });
  assert.equal(invalidBody.status, 400);
  assert.equal((await invalidBody.json()).detail, 'Request body must be a JSON object.');
  assert.equal((await fetch(`${baseUrl}/dashboards/private/%ZZ`)).status, 404);

  const design = getDesignSystem('aperture');
  assert.ok(design);
  assert.throws(() => createPrivateDashboardLink({
    analysisId: analysis.id,
    dashboardSpec: analysis.dashboard_spec,
    design,
    secret: 'test-api-key-secret',
    baseUrl: 'http://api.example',
    requireHttps: true,
  }), /must use HTTPS/);
  const hostileSpec = structuredClone(analysis.dashboard_spec);
  hostileSpec.cards[0].title = '<script>alert(1)</script>';
  hostileSpec.cards[0].summary = '<img src=x onerror=alert(1)>';
  const escapedHtml = renderPrivateDashboard(hostileSpec, design, new Date(Date.now() + 86_400_000).toISOString());
  assert.doesNotMatch(escapedHtml, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(escapedHtml, /<img src=x onerror=/);
  assert.match(escapedHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  const expiredLink = createPrivateDashboardLink({
    analysisId: analysis.id,
    dashboardSpec: analysis.dashboard_spec,
    design,
    expiresInDays: 1,
    secret: 'test-api-key-secret',
    baseUrl,
    now: Date.now() - 2 * 86_400_000,
  });
  const expiredToken = decodeURIComponent(new URL(expiredLink.dashboard_url).pathname.split('/').pop()!);
  assert.equal(verifyPrivateDashboardToken(expiredToken, 'test-api-key-secret'), undefined);

  const currentToken = decodeURIComponent(new URL(link.dashboard_url).pathname.split('/').pop()!);
  const currentPayload = verifyPrivateDashboardToken(currentToken, 'test-api-key-secret');
  assert.ok(currentPayload);
  assert.equal(dashboardSpecMatchesSnapshot(analysis.dashboard_spec, currentPayload.snapshot_sha256), true);
  assert.equal(dashboardSpecMatchesSnapshot({ ...analysis.dashboard_spec, generated_at: new Date().toISOString() }, currentPayload.snapshot_sha256), false);

  const previousPublicBaseUrl = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = 'https://trusted.example';
  try {
    const canonicalResponse = await fetch(`${baseUrl}/dashboard-links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'attacker.example', 'x-forwarded-proto': 'http' },
      body: JSON.stringify({ analysis_id: analysis.id, design_id: 'aperture' }),
    });
    assert.equal(canonicalResponse.status, 201);
    assert.match((await canonicalResponse.json()).dashboard_url, /^https:\/\/trusted\.example\/dashboards\/private\//);
  } finally {
    if (previousPublicBaseUrl == null) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousPublicBaseUrl;
  }
});

test('an issued dashboard URL stops opening when its stored analysis changes', async () => {
  const snapshotStore = new HealthApiStore();
  const snapshotServer = createHealthApiServer(snapshotStore);
  await new Promise<void>(resolve => snapshotServer.listen(0, resolve));
  const address = snapshotServer.address() as AddressInfo;
  const snapshotBase = `http://127.0.0.1:${address.port}`;
  const localPost = async (path: string, body: unknown) => {
    const response = await fetch(`${snapshotBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    assert.ok(response.ok, text);
    return JSON.parse(text);
  };

  try {
    const imported = await localPost('/imports/file', {
      user_id: 'snapshot_user', category: 'biomarkers', filename: 'labs.csv',
      text: 'marker,value,unit\nApoB,118,mg/dL\n',
    });
    const analysis = await localPost('/analyses', { user_id: 'snapshot_user', source_ids: [imported.source.id] });
    const link = await localPost('/dashboard-links', { analysis_id: analysis.id, design_id: 'aperture' });
    assert.equal((await fetch(link.dashboard_url)).status, 200);

    const stored = await snapshotStore.getAnalysis(analysis.id);
    assert.ok(stored);
    stored.dashboard_spec.cards[0].summary = 'A newly completed finding that was not in the shared snapshot.';
    await snapshotStore.saveAnalysis(stored);

    assert.equal((await fetch(link.dashboard_url)).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => snapshotServer.close(error => error ? reject(error) : resolve()));
  }
});

test('runs modality-scoped biomarker and wearable analyses', async () => {
  const biomarkers = await post('/imports/file', {
    user_id: 'scoped_user',
    organization_id: 'scoped_org',
    category: 'biomarkers',
    filename: 'labs.csv',
    content_type: 'text/csv',
    text: 'marker,value,unit\nTotal Cholesterol,190,mg/dL\nLDL,110,mg/dL\nHDL,50,mg/dL\nTriglycerides,120,mg/dL\nGlucose,92,mg/dL\nFasting Insulin,7,uIU/mL\n',
  });
  const wearables = await post('/imports/file', {
    user_id: 'scoped_user',
    organization_id: 'scoped_org',
    category: 'wearables',
    filename: 'wearables.csv',
    content_type: 'text/csv',
    text: 'metric,value,unit\nsleep_duration,7.4,hours\nhrv,54,ms\nresting_heart_rate,57,bpm\n',
  });

  const derived = await post('/biomarkers/derive', {
    user_id: 'scoped_user',
    organization_id: 'scoped_org',
    source_ids: [biomarkers.source.id],
  });
  assert.equal(derived.modality, 'biomarkers');
  assert.equal(derived.operation, 'derive');
  assert.ok(derived.derived_interpretations.length >= 4);
  assert.ok(derived.derived_interpretations.every((item: any) => item.type === 'derived_biomarker'));

  const biomarkerAnalysis = await post('/biomarkers/analyze', {
    user_id: 'scoped_user',
    organization_id: 'scoped_org',
    source_ids: [biomarkers.source.id],
  });
  assert.equal(biomarkerAnalysis.modality, 'biomarkers');
  assert.ok(biomarkerAnalysis.derived_interpretations.some((item: any) => item.type === 'lab_interpretation'));
  assert.ok(biomarkerAnalysis.derived_interpretations.some((item: any) => item.type === 'derived_biomarker'));

  const wearableAnalysis = await post('/wearables/analyze', {
    user_id: 'scoped_user',
    organization_id: 'scoped_org',
    source_ids: [wearables.source.id],
  });
  assert.equal(wearableAnalysis.modality, 'wearables');
  assert.equal(wearableAnalysis.operation, 'analyze');
  assert.ok(wearableAnalysis.derived_interpretations.every((item: any) => item.category === 'wearables'));

  const wrongModality = await fetch(`${baseUrl}/biomarkers/derive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user_id: 'scoped_user',
      organization_id: 'scoped_org',
      source_ids: [wearables.source.id],
    }),
  });
  assert.equal(wrongModality.status, 400);
  assert.match((await wrongModality.json()).detail, /biomarkers sources/);
});

test('builds WHOOP OAuth URLs', async () => {
  const whoop = await post('/connections/whoop/auth-url', {
    client_id: 'client_123',
    redirect_uri: 'http://localhost:8788/callback',
    state: 'abcdefgh',
  });
  assert.match(whoop.authorization_url, /api\.prod\.whoop\.com/);
  assert.ok(new URL(whoop.authorization_url).searchParams.get('state')!.length >= 8);
  assert.ok(whoop.scopes.includes('read:sleep'));
});

test('starts and completes a WHOOP OAuth wearables connection flow', async () => {
  const started = await post('/connections/wearables/start', {
    user_id: 'connect_user',
    organization_id: 'connect_org',
    source_provider: 'whoop',
    client_id: 'client_123',
    redirect_uri: 'http://localhost:8788/callback',
  });
  assert.equal(started.provider, 'wearables');
  assert.equal(started.source_provider, 'whoop');
  assert.equal(started.connection_type, 'oauth');
  assert.match(started.authorization_url, /api\.prod\.whoop\.com/);
  assert.ok(new URL(started.authorization_url).searchParams.get('state')!.length >= 8);
  assert.match(started.connection_event_id, /^evt_/);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('api.prod.whoop.com/oauth/oauth2/token')) {
      const body = String(init?.body ?? '');
      assert.match(body, /grant_type=authorization_code/);
      return new Response(JSON.stringify({ access_token: 'provider_access', refresh_token: 'provider_refresh', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return originalFetch(input, init);
  };

  try {
    const completed = await post('/connections/wearables/callback', {
      user_id: 'connect_user',
      organization_id: 'connect_org',
      source_provider: 'whoop',
      code: 'oauth_code',
      client_id: 'client_123',
      client_secret: 'client_secret',
      redirect_uri: 'http://localhost:8788/callback',
    });
    assert.equal(completed.provider, 'wearables');
    assert.equal(completed.connection_type, 'oauth');
    assert.equal(completed.external_account.provider, 'whoop');
    assert.equal(completed.external_account.external_user_id, 'connect_user');
    assert.equal(completed.external_account.metadata.source_provider, 'whoop');
    assert.equal(completed.token_storage, 'external_secret_store_required');
    const connectionStatus = await get('/connections/wearables/status?user_id=connect_user&organization_id=connect_org');
    assert.equal(connectionStatus.connections.length, 1);
    assert.equal(connectionStatus.connections[0].source_provider, 'whoop');
    assert.equal(connectionStatus.connections[0].status, 'active');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('connects Google Health Connect through the mobile bridge (no OAuth redirect)', async () => {
  const started = await post('/connections/wearables/start', {
    user_id: 'connect_user',
    organization_id: 'connect_org',
    source_provider: 'health_connect',
  });
  assert.equal(started.provider, 'wearables');
  assert.equal(started.source_provider, 'health_connect');
  assert.equal(started.connection_type, 'mobile_bridge');
  assert.equal(started.authorization_url, undefined);
  assert.ok(Array.isArray(started.data_types) && started.data_types.includes('steps'));
  assert.equal(started.ingestion.import_provider, 'health_connect');
  assert.equal(started.external_account.provider, 'health_connect');
  assert.ok(started.external_account.id.startsWith('acct_'));
  assert.match(started.connection_event_id, /^evt_/);

  const statusAfterBridgeStart = await get('/connections/wearables/status?user_id=connect_user&organization_id=connect_org');
  assert.deepEqual(
    statusAfterBridgeStart.connections.map((connection: any) => connection.source_provider).sort(),
    ['health_connect', 'whoop'],
  );

  const completed = await post('/connections/wearables/callback', {
    user_id: 'connect_user',
    organization_id: 'connect_org',
    source_provider: 'health_connect',
    external_user_id: 'android_device_1',
  });
  assert.equal(completed.connection_type, 'mobile_bridge');
  assert.equal(completed.external_account.metadata.source_provider, 'health_connect');
  assert.equal(completed.token_storage, undefined);
});

test('ingests a Health Connect SDK batch directly into ForeverBetter storage', async () => {
  const response = await fetch(`${baseUrl}/api/v1/sdk/users/dev-user/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'google',
      sdkVersion: '0.10.0',
      syncTimestamp: '2026-07-13T19:40:00Z',
      data: {
        records: [
          { id: 'hr-1', type: 'heartRate', startDate: '2026-07-13T19:00:00Z', endDate: '2026-07-13T19:00:00Z', value: 58, unit: 'bpm' },
          { id: 'hrv-1', type: 'heartRateVariabilitySDNN', startDate: '2026-07-13T19:00:00Z', endDate: '2026-07-13T19:00:00Z', value: 52, unit: 'ms' },
          { id: 'steps-1', type: 'steps', startDate: '2026-07-13T19:00:00Z', endDate: '2026-07-13T19:00:00Z', value: 8000, unit: 'count' },
        ],
        sleep: [
          { id: 'sleep-1', parentId: 'sleep-session-1', stage: 'light', startDate: '2026-07-12T23:00:00Z', endDate: '2026-07-13T06:30:00Z' },
        ],
        workouts: [],
      },
    }),
  });
  assert.equal(response.status, 202);
  const accepted = await response.json() as any;
  assert.equal(accepted.provider, 'health_connect');
  assert.equal(accepted.readings_count, 4);

  const source = await get(`/sources/${accepted.source_id}`);
  assert.equal(source.source.category, 'wearables');
  assert.equal(source.source.provider, 'health_connect');
  assert.ok(source.normalized_observations.some((observation: any) => observation.name === 'hrv' && observation.value === 52));
  assert.ok(source.normalized_observations.some((observation: any) => observation.name === 'sleep_duration' && observation.value === 7.5));
  assert.equal(source.normalized_observations.find((observation: any) => observation.name === 'steps')?.observed_at, '2026-07-13T19:00:00.000Z');
  assert.equal(source.normalized_observations.find((observation: any) => observation.name === 'sleep_duration')?.observed_at, '2026-07-13T06:30:00.000Z');

  const status = await get(`/connections/wearables/status?user_id=dev-user&organization_id=${personalOrganizationId('dev-user')}`);
  const healthConnect = status.connections.find((connection: any) => connection.source_provider === 'health_connect');
  assert.equal(healthConnect?.status, 'active');
  assert.equal(healthConnect?.mobile_sync_enabled, true);
  assert.ok(healthConnect?.last_synced_at);
});

test('refreshes a WHOOP access token via the refresh endpoint', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('api.prod.whoop.com/oauth/oauth2/token')) {
      assert.match(String(init?.body ?? ''), /grant_type=refresh_token/);
      return new Response(JSON.stringify({ access_token: 'fresh_access', refresh_token: 'rotated_refresh', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(input, init);
  };
  try {
    const refreshed = await post('/connections/whoop/refresh', { refresh_token: 'old_refresh', client_id: 'c', client_secret: 's' });
    assert.equal(refreshed.access_token, 'fresh_access');
    assert.equal(refreshed.refresh_token, 'rotated_refresh');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WHOOP sync auto-refreshes on a 401 and returns the rotated token', async () => {
  const originalFetch = globalThis.fetch;
  let refreshed = false;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/oauth/oauth2/token')) {
      refreshed = true;
      return new Response(JSON.stringify({ access_token: 'fresh_access', refresh_token: 'rotated', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('api.prod.whoop.com/developer')) {
      // First call (stale token) 401s; after refresh the new token succeeds.
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
      if (auth.includes('stale_access')) return new Response('unauthorized', { status: 401 });
      return new Response(JSON.stringify({ records: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(input, init);
  };
  try {
    const syncBody = {
      user_id: 'dev-user',
      organization_id: 'org_personal_dev_user',
      access_token: 'stale_access',
      refresh_token: 'old_refresh',
      client_id: 'c',
      client_secret: 's',
      start: '2026-06-01',
      end: '2026-06-02',
    };
    const idempotencyKey = `whoop-sync-${Date.now()}`;
    const first = await fetch(`${baseUrl}/connections/whoop/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(syncBody),
    });
    const firstResult = await first.json();
    assert.equal(refreshed, true);
    assert.equal(firstResult.provider, 'whoop');
    assert.equal(firstResult.refreshed_token.access_token, 'fresh_access');

    // Rotated OAuth credentials must reach the caller but must NOT be persisted in
    // the idempotency record - a replay returns the stored body with no token.
    const replay = await fetch(`${baseUrl}/connections/whoop/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(syncBody),
    });
    const replayResult = await replay.json();
    assert.equal(replayResult.provider, 'whoop');
    assert.equal(replayResult.refreshed_token, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WHOOP sync normalizes recovery and sleep records into observations', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/developer/v2/recovery')) {
      return new Response(JSON.stringify({ records: [{ score: { recovery_score: 66, resting_heart_rate: 54, hrv_rmssd_milli: 48.5, spo2_percentage: 96 } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/developer/v2/activity/sleep')) {
      return new Response(JSON.stringify({ records: [{ score: {
        sleep_efficiency_percentage: 91,
        respiratory_rate: 14.2,
        stage_summary: { total_in_bed_time_milli: 28_800_000, total_awake_time_milli: 1_800_000, total_slow_wave_sleep_time_milli: 5_400_000, total_rem_sleep_time_milli: 6_300_000 },
      } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('api.prod.whoop.com/developer')) {
      return new Response(JSON.stringify({ records: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(input, init);
  };
  try {
    const res = await fetch(`${baseUrl}/connections/whoop/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `whoop-normalize-${Date.now()}` },
      body: JSON.stringify({ user_id: 'dev-user', organization_id: 'org_personal_dev_user', access_token: 'good_access', start: '2026-06-01', end: '2026-06-02' }),
    });
    const body = await res.json();
    assert.equal(body.provider, 'whoop');
    const observations: any[] = body.normalized_observations ?? [];
    const byName = (name: string) => observations.find(observation => observation.name === name);
    assert.equal(byName('hrv')?.value, 48.5);
    assert.equal(byName('resting_heart_rate')?.value, 54);
    assert.equal(byName('recovery_score')?.value, 66);
    assert.equal(byName('sleep_efficiency')?.value, 91);
    // 28,800,000 ms in bed minus 1,800,000 ms awake = 27,000,000 ms = 7.5 hours.
    assert.equal(byName('sleep_duration')?.value, 7.5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('imported Health Connect record-type names resolve beyond steps', async () => {
  const imported = await post('/imports/file', {
    user_id: 'hc_import_user',
    category: 'wearables',
    provider: 'health_connect',
    filename: 'health-connect.json',
    content_type: 'application/json',
    text: JSON.stringify({ readings: [
      { type: 'Steps', value: 8200, unit: 'count' },
      { type: 'RestingHeartRate', value: 56, unit: 'bpm' },
      { type: 'HeartRateVariabilityRmssd', value: 47, unit: 'ms' },
      { type: 'OxygenSaturation', value: 97, unit: '%' },
    ] }),
  });
  const names = (imported.normalized_observations ?? []).map((observation: any) => observation.name);
  assert.ok(names.includes('steps'), 'steps present');
  assert.ok(names.includes('resting_heart_rate'), 'resting_heart_rate resolved from RestingHeartRate');
  assert.ok(names.includes('hrv'), 'hrv resolved from HeartRateVariabilityRmssd');
  assert.ok(names.includes('spo2'), 'spo2 resolved from OxygenSaturation');
});

test('Health Connect SDK sync auto-refreshes the wearables analysis with a heart_rate finding', async () => {
  const userId = 'hc_auto_user';
  const orgId = personalOrganizationId(userId);
  const sync = await fetch(`${baseUrl}/api/v1/sdk/users/${userId}/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'health_connect',
      sdkVersion: '0.10.0',
      syncTimestamp: '2026-07-20T08:00:00Z',
      data: {
        records: [
          { id: 'hr-1', type: 'heartRate', startDate: '2026-07-20T07:00:00Z', endDate: '2026-07-20T07:00:00Z', value: 62, unit: 'bpm' },
          { id: 'hrv-1', type: 'heartRateVariabilityRmssd', startDate: '2026-07-20T07:00:00Z', endDate: '2026-07-20T07:00:00Z', value: 44, unit: 'ms' },
          { id: 'steps-1', type: 'steps', startDate: '2026-07-20T07:00:00Z', endDate: '2026-07-20T07:00:00Z', value: 9000, unit: 'count' },
        ],
        sleep: [],
        workouts: [],
      },
    }),
  });
  assert.equal(sync.status, 202);

  // No manual /wearables/analyze call: the sync itself refreshed the analysis.
  const list = await get(`/analyses?modality=wearables&user_id=${userId}&organization_id=${orgId}&limit=1`);
  assert.equal(list.analyses.length, 1);
  const analysis = await get(`/analyses/${list.analyses[0].id}`);
  const names = analysis.derived_interpretations.map((item: any) => item.raw?.id).filter(Boolean);
  assert.ok(names.includes('heart_rate'), 'plain heart_rate now produces a finding');
  assert.ok(names.includes('hrv'), 'hrv finding present');
});

test('a nested Health Connect value object is not dropped', async () => {
  const userId = 'hc_nested_user';
  const orgId = personalOrganizationId(userId);
  const sync = await fetch(`${baseUrl}/api/v1/sdk/users/${userId}/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'health_connect',
      sdkVersion: '0.10.0',
      syncTimestamp: '2026-07-21T08:00:00Z',
      data: {
        records: [
          { id: 'rhr-1', type: 'restingHeartRate', startDate: '2026-07-21T07:00:00Z', endDate: '2026-07-21T07:00:00Z', value: { numericValue: 55 }, unit: 'bpm' },
        ],
        sleep: [],
        workouts: [],
      },
    }),
  });
  const body = await sync.json();
  assert.equal(body.readings_count, 1, 'nested { numericValue } value is parsed, not dropped');
  const source = await get(`/sources/${body.source_id}`);
  assert.equal(source.normalized_observations.find((observation: any) => observation.name === 'resting_heart_rate')?.value, 55);
});

test('wearable auto-analysis keeps one finding per metric across repeated imports', async () => {
  const userId = 'wearable_dedup_user';
  const orgId = personalOrganizationId(userId);
  for (const steps of [6000, 11000]) {
    await post('/imports/file', {
      user_id: userId,
      organization_id: orgId,
      category: 'wearables',
      filename: 'steps.csv',
      content_type: 'text/csv',
      text: `metric,value,unit\nsteps,${steps},steps\n`,
    });
  }
  const list = await get(`/analyses?modality=wearables&user_id=${userId}&organization_id=${orgId}&limit=1`);
  assert.equal(list.analyses.length, 1);
  const analysis = await get(`/analyses/${list.analyses[0].id}`);
  const stepFindings = analysis.derived_interpretations.filter((item: any) => item.raw?.id === 'steps');
  assert.equal(stepFindings.length, 1, 'two step imports collapse to a single steps finding');
});

test('retires the legacy wearable pull endpoint', async () => {
  const response = await fetch(`${baseUrl}/connections/wearables/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: 'wearables_user' }),
  });
  assert.equal(response.status, 410);
  const body = await response.json() as { detail?: string };
  assert.match(body.detail ?? '', /retired/i);
});

test('returns Quest and SYNLAB lab locator handoffs', async () => {
  const result = await get('/labs/search?provider=all&postal_code=10001&radius_miles=10');
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].status, 'locator_handoff');
  assert.match(result.results.map((item: any) => item.provider).join(','), /quest/);
  assert.match(result.results.map((item: any) => item.provider).join(','), /synlab/);
});

test('serves MCP-style tool calls', async () => {
  const initialized = await post('/mcp', { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
  assert.equal(initialized.result.serverInfo.name, 'wellnizz-api');

  const listed = await post('/mcp', { id: 1, method: 'tools/list', params: {} });
  assert.ok(listed.result.tools.some((tool: any) => tool.name === 'upload_health_data' && tool.inputSchema?.type === 'object'));
  assert.ok(listed.result.tools.some((tool: any) => tool.name === 'create_private_dashboard_link' && tool.inputSchema?.required?.includes('design_id')));
  assert.ok(listed.result.tools.some((tool: any) => tool.name === 'get_design_implementation' && tool.inputSchema?.properties?.design_id));
  for (const name of ['derive_biomarkers', 'analyze_biomarkers', 'analyze_wearables', 'analyze_genetics']) {
    assert.ok(listed.result.tools.some((tool: any) => tool.name === name), `missing MCP tool ${name}`);
  }

  const uploaded = await post('/mcp', {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'upload_health_data',
      arguments: {
        user_id: 'mcp_user',
        organization_id: 'mcp_org',
        category: 'biomarkers',
        filename: 'labs.csv',
        text: 'marker,value,unit\nGlucose,90,mg/dL\nInsulin,6,uIU/mL',
      },
    },
  });
  const uploadedBody = JSON.parse(uploaded.result.content[0].text);
  const derived = await post('/mcp', {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'derive_biomarkers',
      arguments: {
        user_id: 'mcp_user',
        organization_id: 'mcp_org',
        source_ids: [uploadedBody.source.id],
      },
    },
  });
  const derivedBody = JSON.parse(derived.result.content[0].text);
  assert.equal(derivedBody.operation, 'derive');

  const privateLink = await post('/mcp', {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'create_private_dashboard_link',
      arguments: { analysis_id: derivedBody.id, design_id: 'aperture', expires_in_days: 7 },
    },
  });
  const privateLinkBody = JSON.parse(privateLink.result.content[0].text);
  assert.equal(privateLinkBody.analysis_id, derivedBody.id);
  assert.match(privateLinkBody.dashboard_url, /\/dashboards\/private\//);
  assert.equal((await fetch(privateLinkBody.dashboard_url)).status, 200);

  const implementation = await post('/mcp', {
    jsonrpc: '2.0',
    id: 41,
    method: 'tools/call',
    params: { name: 'get_design_implementation', arguments: { design_id: 'meridian' } },
  });
  const implementationBody = JSON.parse(implementation.result.content[0].text);
  assert.equal(implementationBody.production_dashboard.entrypoint, 'dashboard/index.html');
  assert.ok(implementationBody.production_dashboard.files.some((file: any) => file.path === 'dashboard/index.html' && file.contents.includes('meridian-topbar')));

  const called = await post('/mcp', {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'find_nearby_labs',
      arguments: { provider: 'all', postal_code: '10001' },
    },
  });
  assert.equal(called.result.content[0].type, 'text');
  assert.ok(JSON.parse(called.result.content[0].text).results.length >= 2);
});

test('runs bundled analyze-health pipeline for uploaded VCF genetics data', async () => {
  const vcf = await readFile('vendor/health-analysis-skill/examples/sample-rsid-wgs.vcf', 'utf8');
  const imported = await post('/imports/file', {
    user_id: 'genetics_user',
    organization_id: 'org_genetics',
    category: 'genetics',
    filename: 'sample-rsid-wgs.vcf',
    content_type: 'text/vcf',
    text: vcf,
  });
  assert.equal(imported.source.category, 'genetics');
  assert.equal(imported.source.organization_id, 'org_genetics');

  const analysis = await post('/analyses', {
    user_id: 'genetics_user',
    organization_id: 'org_genetics',
    source_ids: [imported.source.id],
  });
  const geneticFinding = analysis.derived_interpretations.find((item: any) => item.type === 'genetic_pipeline_analysis');
  assert.ok(geneticFinding, JSON.stringify(analysis.derived_interpretations, null, 2));
  assert.equal(geneticFinding.status, 'complete');
  assert.ok(geneticFinding.raw.raw.trait_count > 0);
  assert.ok(analysis.dashboard_spec.cards.some((card: any) => card.category === 'genetics' && card.status === 'complete'));
});

test('finalizes a direct-to-storage genetics upload before analysis can start', async () => {
  const uploadStore = new HealthApiStore() as HealthApiStore & {
    createSignedPayloadUpload: (objectKey: string) => Promise<unknown>;
    uploadedPayloadSize: (objectKey: string) => Promise<number | undefined>;
  };
  const uploadedObjectKeys = new Set<string>();
  uploadStore.createSignedPayloadUpload = async objectKey => {
    uploadedObjectKeys.add(objectKey);
    return {
      object_key: objectKey,
      bucket_name: 'health-api-source-payloads',
      upload_url: 'https://uploads.example.com/private/genome.vcf.gz?signature=signed-upload-token',
      method: 'PUT',
      headers: { 'content-type': 'application/gzip' },
      expires_in_seconds: 3600,
    };
  };
  uploadStore.uploadedPayloadSize = async objectKey => uploadedObjectKeys.has(objectKey) ? 103 * 1024 * 1024 : undefined;
  const uploadServer = createHealthApiServer(uploadStore);
  await new Promise<void>(resolve => uploadServer.listen(0, resolve));
  const address = uploadServer.address() as AddressInfo;
  const uploadBaseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const started = await fetch(`${uploadBaseUrl}/genetics/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user_id: 'genetics_upload_user',
        organization_id: 'genetics_upload_org',
        filename: 'genome.vcf.gz',
        byte_length: 103 * 1024 * 1024,
      }),
    });
    assert.equal(started.status, 201);
    const session = await started.json();
    assert.equal(session.upload.protocol, 's3-presigned-put');
    assert.equal(session.upload.method, 'PUT');
    assert.match(session.upload.url, /uploads\.example\.com/);
    assert.equal(session.source.upload_status, 'pending');

    const snpExport = await fetch(`${uploadBaseUrl}/genetics/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user_id: 'genetics_upload_user', organization_id: 'genetics_upload_org',
        filename: '23andMe_raw.txt', byte_length: 1_024,
      }),
    });
    assert.equal(snpExport.status, 201);
    assert.equal((await snpExport.json()).source.content_type, 'text/plain');

    const tooLarge = await fetch(`${uploadBaseUrl}/genetics/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user_id: 'genetics_upload_user',
        organization_id: 'genetics_upload_org',
        filename: 'too-large.vcf.gz',
        byte_length: 513 * 1024 * 1024,
      }),
    });
    assert.equal(tooLarge.status, 413);

    const pendingAnalysis = await fetch(`${uploadBaseUrl}/genetics/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: 'genetics_upload_user', organization_id: 'genetics_upload_org', source_ids: [session.source_id] }),
    });
    assert.equal(pendingAnalysis.status, 409);

    const pendingAncestry = await fetch(`${uploadBaseUrl}/genetics/ancestry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: 'genetics_upload_user', organization_id: 'genetics_upload_org', source_id: session.source_id }),
    });
    assert.equal(pendingAncestry.status, 409);

    const completed = await fetch(`${uploadBaseUrl}/genetics/uploads/${session.source_id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: 'genetics_upload_user', organization_id: 'genetics_upload_org' }),
    });
    assert.equal(completed.status, 201);
    const finalized = await completed.json();
    assert.equal(finalized.source.upload_status, 'complete');
    assert.equal(finalized.source.byte_length, 103 * 1024 * 1024);

    const mcpStart = await fetch(`${uploadBaseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 7, method: 'tools/call', params: {
          name: 'start_genetics_upload',
          arguments: {
            user_id: 'genetics_upload_user', organization_id: 'genetics_upload_org',
            filename: 'ancestrydna_raw.txt', byte_length: 1_024,
          },
        },
      }),
    });
    assert.equal(mcpStart.status, 200);
    const mcpSession = JSON.parse((await mcpStart.json()).result.content[0].text);
    assert.equal(mcpSession.upload.protocol, 's3-presigned-put');
    assert.equal(mcpSession.finalize.tool, 'complete_genetics_upload');
  } finally {
    await new Promise<void>((resolve, reject) => uploadServer.close(error => error ? reject(error) : resolve()));
  }
});

test('returns ancestry analysis for uploaded genetic data', async () => {
  const vcf = await readFile('vendor/health-analysis-skill/examples/sample-rsid-wgs.vcf', 'utf8');
  const imported = await post('/imports/file', {
    user_id: 'ancestry_user',
    organization_id: 'org_ancestry',
    category: 'genetics',
    filename: 'sample-rsid-wgs.vcf',
    content_type: 'text/vcf',
    text: vcf,
  });

  const ancestry = await post('/genetics/ancestry', {
    user_id: 'ancestry_user',
    organization_id: 'org_ancestry',
    source_id: imported.source.id,
    reference_panel: '1000_genomes_phase3',
  });

  assert.equal(ancestry.reference_panel, '1000_genomes_phase3');
  assert.equal(ancestry.schema_version, '1.0');
  assert.equal(ancestry.proportion_unit, 'percent');
  assert.ok(ancestry.quality.variant_count > 0);
  assert.ok(ancestry.quality.rsid_count > 0);
  assert.ok(ancestry.methodology.reference_panel === '1000 Genomes Phase 3');
  assert.ok(ancestry.methodology.limitations.length > 0);
  assert.ok(ancestry.generated_at != null);
});

test('queues WGS genetics data when queue execution mode is enabled', async () => {
  const previousMode = process.env.HEALTH_ANALYSIS_EXECUTION_MODE;
  process.env.HEALTH_ANALYSIS_EXECUTION_MODE = 'queue';
  try {
    const vcf = await readFile('vendor/health-analysis-skill/examples/sample-rsid-wgs.vcf', 'utf8');
    const imported = await post('/imports/file', {
      user_id: 'queued_genetics_user',
      organization_id: 'org_genetics_queue',
      category: 'genetics',
      filename: 'sample-rsid-wgs.vcf',
      content_type: 'text/vcf',
      text: vcf,
    });

    const analysis = await post('/genetics/analyze', {
      user_id: 'queued_genetics_user',
      organization_id: 'org_genetics_queue',
      source_ids: [imported.source.id],
    });
    assert.equal(analysis.modality, 'genetics');
    assert.equal(analysis.operation, 'analyze');
    const queuedFinding = analysis.derived_interpretations.find((item: any) => item.type === 'genetic_pipeline_queued');
    assert.ok(queuedFinding, JSON.stringify(analysis.derived_interpretations, null, 2));
    assert.equal(queuedFinding.status, 'queued');
    assert.match(queuedFinding.raw.job_id, /^wgsjob_/);

    const job = await get(`/genetics/jobs/${queuedFinding.raw.job_id}`);
    assert.equal(job.status, 'queued');
    assert.equal(job.analysis_id, analysis.id);
    assert.equal(job.source_id, imported.source.id);
    assert.equal(job.result_summary, undefined);
  } finally {
    if (previousMode == null) delete process.env.HEALTH_ANALYSIS_EXECUTION_MODE;
    else process.env.HEALTH_ANALYSIS_EXECUTION_MODE = previousMode;
  }
});

test('serves readiness and agent discovery metadata', async () => {
  const health = await get('/health');
  assert.deepEqual(health, { ok: true, service: 'wellnizz-api' });

  const ready = await get('/ready');
  assert.equal(ready.ok, true);
  assert.equal(ready.service, 'wellnizz-api');
  assert.equal(ready.version, '0.5.2');
  assert.deepEqual(Object.keys(ready).sort(), ['ok', 'service', 'version']);

  const version = await get('/version');
  assert.deepEqual(version, { service: 'wellnizz-api', version: '0.5.2' });

  const readyDetails = await get('/ready/details');
  assert.equal(readyDetails.service, 'wellnizz-api');
  assert.equal(readyDetails.version, '0.5.2');
  assert.equal(readyDetails.storage.checks.store, 'memory');
  assert.ok(readyDetails.enabled_endpoints.includes('imports.file'));

  const manifest = await get('/.well-known/health-agent.json');
  assert.equal(manifest.name, 'Wellnizz API');
  assert.equal(manifest.service, 'wellnizz-api');
  assert.equal(manifest.version, '0.5.2');
  assert.ok(manifest.auth.token_requirements.endpoint_claims.includes('enabled_endpoints'));
  assert.equal(manifest.auth.token_requirements.full_user_data_reads_by_default, true);
  assert.ok(manifest.auth.token_requirements.default_user_data_read_endpoints.includes('sources.read'));
  assert.equal(manifest.auth.token_requirements.consequential_operations_require_endpoint_grant, true);
  assert.equal(manifest.auth.self_serve_key.steps.length, 3);
  assert.equal(manifest.auth.agent_login.steps[0].body.agent_name, '<short name shown to the user>');
  assert.equal(manifest.auth.agent_login.steps[2].headers['X-Agent-Login-Secret'], '<polling_secret>');
  assert.match(manifest.auth.self_serve_key.steps[0].call, /\/auth\/otp\/start$/);
  assert.deepEqual(manifest.auth.self_serve_key.steps[0].body, { email: '<user email>' });
  assert.match(manifest.auth.self_serve_key.steps[2].call, /\/api-keys$/);
  assert.ok(manifest.endpoints.mcp.tools.some((tool: any) => tool.name === 'upload_health_data'));
  assert.match(manifest.openapi_url, /\/openapi\.json$/);

  const openApi = await get('/openapi.json');
  assert.equal(openApi.openapi, '3.1.0');
  assert.equal(openApi.info.title, 'Wellnizz API');
  assert.equal(openApi.info.version, '0.5.2');
  assert.ok(openApi.paths['/mcp']);
  assert.ok(openApi.paths['/capabilities']);
  assert.ok(openApi.paths['/pricing']);
  assert.ok(openApi.paths['/api-keys']);
  assert.deepEqual(
    Object.keys(openApi.paths['/auth/otp/start'].post.requestBody.content['application/json'].schema.properties),
    ['email'],
  );
  assert.deepEqual(
    Object.keys(openApi.paths['/auth/otp/verify'].post.requestBody.content['application/json'].schema.properties),
    ['email', 'token'],
  );
  assert.ok(openApi.paths['/connections/wearables/start']);
  assert.ok(openApi.paths['/connections/wearables/callback']);
  assert.ok(openApi.paths['/api/v1/sdk/users/{user_id}/sync']);
  assert.ok(openApi.paths['/connections/wearables/jobs/{id}']);
  assert.ok(openApi.paths['/biomarkers/derive']);
  assert.ok(openApi.paths['/biomarkers/analyze']);
  assert.ok(openApi.paths['/wearables/analyze']);
  assert.ok(openApi.paths['/genetics/analyze']);
  assert.ok(openApi.paths['/biomarkers/derive'].post.responses[201]);
  assert.equal(openApi.paths['/analyses/{id}'].get.responses[200].content['application/json'].schema.$ref, '#/components/schemas/AnalysisResult');
  assert.equal(openApi.paths['/dashboard-specs/{analysis_id}'].get.responses[200].content['application/json'].schema.$ref, '#/components/schemas/DashboardSpec');
  assert.ok(openApi.paths['/design/systems/{id}/implementation']);
  assert.ok(openApi.paths['/dashboard-links']);
  assert.equal(openApi.paths['/dashboard-links'].post.responses[201].content['application/json'].schema.$ref, '#/components/schemas/DashboardLinkResult');
  assert.ok(openApi.paths['/dashboard-links'].post.responses[503]);
  assert.ok(openApi.paths['/dashboards/private/{token}']);
  assert.equal(openApi.paths['/genetics/ancestry'].post.responses[200].content['application/json'].schema.$ref, '#/components/schemas/AncestryResult');
  assert.ok(openApi.components.schemas.ProblemDetails);
  assert.ok(openApi.components.schemas.DashboardSpec.required.includes('quality'));
  assert.ok(openApi.components.schemas.DashboardLinkResult.required.includes('dashboard_url'));
  for (const methods of Object.values(openApi.paths) as any[]) {
    for (const operation of Object.values(methods) as any[]) {
      for (const [status, response] of Object.entries(operation.responses ?? {}) as Array<[string, any]>) {
        if (!status.startsWith('2')) continue;
        assert.ok(
          response.content?.['application/json']?.schema || response.content?.['text/html']?.schema,
          `success response ${status} must publish a response schema`,
        );
      }
    }
  }
  assert.ok(openApi.paths['/users/{user_id}/health-context']);
  assert.ok(openApi.paths['/users/{user_id}/data/export']);

  const capabilities = await get('/capabilities');
  assert.equal(capabilities.service, 'wellnizz-api');
  assert.ok(capabilities.capabilities.some((item: any) => item.id === 'genetics.wgs' && item.notes.join(' ').includes('dbSNP')));
  assert.ok(capabilities.capabilities.some((item: any) => item.id === 'health_context.summary'));
  const pricingResponse = await fetch(`${baseUrl}/pricing`);
  assert.equal(pricingResponse.status, 200);
  assert.match(pricingResponse.headers.get('cache-control') ?? '', /public/);
  const pricing = await pricingResponse.json();
  assert.equal(pricing.service, 'wellnizz-api');
  assert.ok(pricing.tiers.some((tier: any) => tier.id === 'free' && tier.monthly_usd === 0));
  const standard = pricing.tiers.find((tier: any) => tier.id === 'standard');
  assert.equal(standard?.monthly_usd, 9.99);
  assert.match(standard?.included.join(' ') ?? '', /WHOOP and Oura/);
  const hostedSelfServePrices = pricing.tiers
    .filter((tier: any) => ['standard', 'builder', 'growth'].includes(tier.id))
    .map((tier: any) => tier.monthly_usd);
  assert.deepEqual(hostedSelfServePrices, [9.99, 24.99, 49]);

  const billingResponse = await fetch(`${baseUrl}/billing/subscription?organization_id=${personalOrganizationId('dev-user')}`);
  assert.equal(billingResponse.status, 200);
  const billing = await billingResponse.json();
  assert.equal(billing.hosted_billing_configured, false);
  assert.equal(billing.self_hosting.available, true);

  for (const path of ['/', '/docs']) {
    const docsRedirect = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
    assert.equal(docsRedirect.status, 302);
    assert.equal(docsRedirect.headers.get('location'), path === '/' ? '/dashboard' : 'https://docs.wellnizz.com');
  }

  const dashboard = await fetch(`${baseUrl}/dashboard`);
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.headers.get('content-type') ?? '', /text\/html/);
  const dashboardHtml = await dashboard.text();
  assert.match(dashboardHtml, /Your health data, understood\./);
  assert.match(dashboardHtml, /Connect it yourself\./);
  assert.doesNotMatch(dashboardHtml, /Prefer to run it yourself/);

  const skill = await fetch(`${baseUrl}/SKILL.md`);
  assert.equal(skill.status, 200);
  assert.match(skill.headers.get('content-type') ?? '', /text\/markdown/);
  const skillMarkdown = await skill.text();
  assert.match(skillMarkdown, /Agent operating contract/i);
  assert.match(skillMarkdown, /Execution mode \(default to cloud\)/i);
  assert.match(skillMarkdown, /Cloud is the default/i);
  assert.match(skillMarkdown, /Open that URL in the user's default browser/i);
  assert.match(skillMarkdown, /Optimize everything/i);
  assert.match(skillMarkdown, /recurring daily plan/i);
  assert.match(skillMarkdown, /Do not assume the user wants a\s+dashboard/i);
  assert.match(skillMarkdown, /self-hosting/i);
  assert.match(skillMarkdown, /x402 per-call payment/i);
  assert.doesNotMatch(skillMarkdown, /Stripe/);
  assert.doesNotMatch(skillMarkdown, /explicit genetics consent/i);
  assert.match(skillMarkdown, /github\.com\/liveforeverbetter\/agentic-health-analysis/);
  assert.match(skillMarkdown, /Treat this as an execution workflow/i);
  assert.match(skillMarkdown, /A run is complete only when/i);
  assert.match(skillMarkdown, /agent-login\/start/);
  assert.match(skillMarkdown, /docs\.wellnizz\.com\/llms-full\.txt/);
  assert.doesNotMatch(skillMarkdown, /foreverbetter\.mintlify\.site/);
  assert.match(skillMarkdown, /GET \/design\/systems/);
  assert.match(skillMarkdown, /private-by-possession snapshot/i);
  assert.match(skillMarkdown, /Wearables are\s+always last/i);
  assert.match(skillMarkdown, /never\s+star on the user's behalf without confirmation/i);
  assert.match(skillMarkdown, /connections\/wearables\/start/);
  assert.match(skillMarkdown, /POST \/users\/\{user_id\}\/data\/export/);
  assert.doesNotMatch(skillMarkdown, /GET \/users\/\{user_id\}\/data\/export/);
  assert.match(skillMarkdown, /connections\/oura\/sync/);
  assert.match(skillMarkdown, /retired generic `POST \/connections\/wearables\/sync`/);
  assert.match(skillMarkdown, /Wellnizz Connect/);

  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
  const traced = await fetch(`${baseUrl}/health`, {
    headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
  });
  assert.equal(traced.headers.get('x-trace-id'), traceId);
  assert.match(traced.headers.get('traceparent') ?? '', new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
});

test('agent login requires explicit approval and returns a key only once', async () => {
  const startedResponse = await fetch(`${baseUrl}/agent-login/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent_name: 'My longevity agent' }),
  });
  assert.equal(startedResponse.status, 200);
  const started = await startedResponse.json();
  assert.match(started.session_code, /^FB-[A-F0-9]{32}$/);
  assert.match(started.polling_secret, /^fbp_[A-Za-z0-9_-]{40,}$/);
  assert.ok(!started.url.includes(started.polling_secret));

  const request = await fetch(`${baseUrl}/agent-login/request?session_code=${started.session_code}`).then(response => response.json());
  assert.equal(request.agent_name, 'My longevity agent');
  assert.ok(request.permissions.length >= 3);

  const missingSecret = await fetch(`${baseUrl}/agent-login/status?session_code=${started.session_code}`);
  assert.equal(missingSecret.status, 401);
  const pending = await fetch(`${baseUrl}/agent-login/status?session_code=${started.session_code}`, {
    headers: { 'x-agent-login-secret': started.polling_secret },
  }).then(response => response.json());
  assert.equal(pending.status, 'pending');

  const missingDecision = await fetch(`${baseUrl}/agent-login/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_code: started.session_code, access_token: 'local-session' }),
  });
  assert.equal(missingDecision.status, 400);

  const approved = await fetch(`${baseUrl}/agent-login/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_code: started.session_code, access_token: 'local-session', decision: 'approve' }),
  });
  assert.equal(approved.status, 200);

  const retrieved = await fetch(`${baseUrl}/agent-login/status?session_code=${started.session_code}`, {
    headers: { 'x-agent-login-secret': started.polling_secret },
  }).then(response => response.json());
  assert.equal(retrieved.status, 'confirmed');
  assert.match(retrieved.api_key, /^ey/);
  assert.equal(retrieved.created.name, 'My longevity agent key');
  assert.ok(!retrieved.created.enabled_endpoints.includes('data.delete'));
  assert.ok(!retrieved.created.enabled_endpoints.includes('billing.checkout.create'));

  const consumed = await fetch(`${baseUrl}/agent-login/status?session_code=${started.session_code}`, {
    headers: { 'x-agent-login-secret': started.polling_secret },
  }).then(response => response.json());
  assert.equal(consumed.status, 'expired');

  const deniedStart = await fetch(`${baseUrl}/agent-login/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_name: 'Unknown agent' }),
  }).then(response => response.json());
  const deniedDecision = await fetch(`${baseUrl}/agent-login/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_code: deniedStart.session_code, access_token: 'local-session', decision: 'deny' }),
  });
  assert.equal(deniedDecision.status, 200);
  const deniedStatus = await fetch(`${baseUrl}/agent-login/status?session_code=${deniedStart.session_code}`, {
    headers: { 'x-agent-login-secret': deniedStart.polling_secret },
  }).then(response => response.json());
  assert.equal(deniedStatus.status, 'denied');
});

test('public readiness is minimal', async () => {
  const response = await fetch(`${baseUrl}/ready`);
  assert.equal(response.status, 200);
  const readiness = await response.json();
  assert.deepEqual(Object.keys(readiness).sort(), ['ok', 'service', 'version']);
  assert.equal(readiness.storage, undefined);
  assert.equal(readiness.enabled_endpoints, undefined);
});

test('replays idempotent write responses', async () => {
  const body = {
    user_id: 'idempotent_user',
    organization_id: 'idempotent_org',
    category: 'biomarkers',
    filename: 'labs.csv',
    content_type: 'text/csv',
    text: 'marker,value,unit\nApoB,101,mg/dL\n',
  };
  const first = await postWithHeaders('/imports/file', body, { 'idempotency-key': 'import-123' });
  const replay = await postWithHeaders('/imports/file', body, { 'idempotency-key': 'import-123' });
  assert.equal(replay.source.id, first.source.id);
});

test('enforces per-user write quotas when configured', async () => {
  const previous = process.env.HEALTH_API_USER_QUOTAS;
  process.env.HEALTH_API_USER_QUOTAS = JSON.stringify({
    'imports.file': { window_ms: 60_000, max: 1 },
  });
  const quotaServer = createHealthApiServer();
  let quotaBaseUrl = '';
  await new Promise<void>(resolve => quotaServer.listen(0, resolve));
  try {
    const address = quotaServer.address() as AddressInfo;
    quotaBaseUrl = `http://127.0.0.1:${address.port}`;
    const body = {
      user_id: 'quota_user',
      organization_id: 'quota_org',
      category: 'biomarkers',
      filename: 'labs.csv',
      content_type: 'text/csv',
      text: 'marker,value,unit\nApoB,101,mg/dL\n',
    };
    const first = await fetch(`${quotaBaseUrl}/imports/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(first.status, 201);
    const second = await fetch(`${quotaBaseUrl}/imports/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(second.status, 429);
  } finally {
    await new Promise<void>((resolve, reject) => quotaServer.close(error => error ? reject(error) : resolve()));
    if (previous == null) delete process.env.HEALTH_API_USER_QUOTAS;
    else process.env.HEALTH_API_USER_QUOTAS = previous;
  }
});

test('tombstones tenant-scoped user data', async () => {
  const imported = await post('/imports/file', {
    user_id: 'delete_user',
    organization_id: 'delete_org',
    category: 'biomarkers',
    filename: 'labs.csv',
    content_type: 'text/csv',
    text: 'marker,value,unit\nApoB,101,mg/dL\n',
  });
  const analysis = await post('/analyses', {
    user_id: 'delete_user',
    organization_id: 'delete_org',
    source_ids: [imported.source.id],
  });

  const context = await post('/users/delete_user/health-context', {
    organization_id: 'delete_org',
    analysis_ids: [analysis.id],
  });
  assert.equal(context.user_id, 'delete_user');
  assert.ok(context.coverage.some((item: any) => item.modality === 'biomarkers' && item.present));
  assert.ok(context.priority_findings.length > 0);
  assert.ok(context.modality_contexts.biomarkers.present);
  assert.ok(context.modality_contexts.biomarkers.observed_markers.includes('apob'));
  assert.ok(context.modality_contexts.biomarkers.missing_priority_markers.includes('hba1c'));
  assert.ok(context.modality_contexts.biomarkers.domains.cardiometabolic.total >= 1);
  const cachedContext = await fetch(`${baseUrl}/users/delete_user/health-context`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ organization_id: 'delete_org', analysis_ids: [analysis.id] }),
  });
  assert.equal(cachedContext.status, 200);
  assert.equal(cachedContext.headers.get('x-cache'), 'HIT');

  const goal = await post('/users/delete_user/goals', {
    organization_id: 'delete_org',
    title: 'Get ApoB under 80 mg/dL',
    metric: 'apob',
    target_value: 80,
    target_direction: 'decrease',
  });
  assert.match(goal.id, /^goal_/);

  const exported = await post('/users/delete_user/data/export', {
    organization_id: 'delete_org',
  });
  assert.equal(exported.user_id, 'delete_user');
  assert.match(exported.receipt_id, /^export_receipt_/);
  assert.equal(exported.counts.sources, 1);
  assert.equal(exported.counts.analyses, 1);
  // Erasure/export must cover goals, not just sources/analyses.
  assert.equal(exported.counts.goals, 1);
  assert.equal(exported.data.goals[0].id, goal.id);
  assert.equal(exported.data.sources[0].id, imported.source.id);

  const deleted = await post('/users/delete_user/data/delete', {
    organization_id: 'delete_org',
  });
  assert.equal(deleted.user_id, 'delete_user');
  assert.equal(deleted.organization_id, 'delete_org');
  assert.equal(deleted.sources, 1);
  assert.equal(deleted.analyses, 1);
  assert.equal(deleted.goals, 1);
  assert.match(deleted.receipt_id, /^delete_receipt_/);

  // The goal must be unreadable after erasure.
  const goalAfterDelete = await fetch(`${baseUrl}/goals/${goal.id}`);
  assert.equal(goalAfterDelete.status, 404);
  assert.match(deleted.event_id, /^evt_/);
  assert.ok(deleted.retention_note.includes('tombstoned') || deleted.retention_note.includes('removed'));

  const response = await fetch(`${baseUrl}/analyses/${analysis.id}`);
  assert.equal(response.status, 404);

  const events = await get('/webhook-events?user_id=delete_user&organization_id=delete_org&limit=20');
  assert.ok(events.events.some((event: any) => event.type === 'source.imported'));
  assert.ok(events.events.some((event: any) => event.type === 'analysis.completed'));
  assert.ok(events.events.some((event: any) => event.type === 'export.ready'));
  assert.ok(events.events.some((event: any) => event.type === 'data.deleted'));
});

test('self-contained email OTP mints a session and rejects bad codes', async () => {
  // A dedicated server with an explicit signing secret and a review-login bypass
  // (deterministic, no inbox needed). The default EMAIL_DRIVER=console keeps
  // email delivery enabled without any SMTP configuration.
  const authConfig = loadAuthConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'service_account',
    AUTH_AUDIENCE: 'health-api',
    SERVICE_ACCOUNT_JWT_SECRET: 'otp-test-secret',
    API_KEY_JWT_SECRET: 'otp-test-secret',
  });
  // Review-login bypass is read from the process environment (deployment config).
  process.env.REVIEW_LOGIN_EMAIL = 'reviewer@example.com';
  process.env.REVIEW_LOGIN_CODE = '424242';
  const otpServer = createHealthApiServer(new HealthApiStore(), { auth: authConfig });
  await new Promise<void>(resolve => otpServer.listen(0, resolve));
  const address = otpServer.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const call = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  try {
    const started = await (await call('/auth/otp/start', { email: 'reviewer@example.com' })).json();
    assert.equal(started.ok, true);
    assert.equal(started.delivery, 'email');

    const verifyRes = await call('/auth/otp/verify', { email: 'reviewer@example.com', token: '424242' });
    assert.equal(verifyRes.status, 200);
    const verified = await verifyRes.json();
    assert.match(verified.user.id, /^usr_/);
    assert.equal(verified.token_type, 'Bearer');
    assert.equal(verified.access_token.split('.').length, 3, 'session is a signed JWT');
    const claims = decodeJwt(verified.access_token);
    assert.ok(Number(claims.exp) - Number(claims.iat) >= 7 * 24 * 60 * 60 - 1, 'email sign-in session lasts one week by default');

    // The minted session token authenticates a subsequent request.
    const caps = await fetch(`${base}/capabilities`, { headers: { authorization: `Bearer ${verified.access_token}` } });
    assert.equal(caps.status, 200);

    // Unknown email with a wrong code is rejected.
    await call('/auth/otp/start', { email: 'nobody@example.com' });
    const bad = await call('/auth/otp/verify', { email: 'nobody@example.com', token: '00000000' });
    assert.equal(bad.status, 400);
  } finally {
    delete process.env.REVIEW_LOGIN_EMAIL;
    delete process.env.REVIEW_LOGIN_CODE;
    otpServer.close();
  }
});

test('OIDC auth requires tokens, scopes, and same-user access', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey) as JWK & { kid?: string; alg?: string; use?: string };
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  const jwksServer = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise<void>(resolve => jwksServer.listen(0, resolve));
  const jwksAddress = jwksServer.address() as AddressInfo;
  const jwksUri = `http://127.0.0.1:${jwksAddress.port}/jwks`;

  const secureServer = createHealthApiServer(undefined, {
    auth: {
      mode: 'oidc',
      issuer: 'https://issuer.example/',
      audience: 'foreverbetter-health-api',
      jwksUri,
      algorithms: ['RS256'],
      allowedOrigins: ['https://app.example'],
      allowedOriginPatterns: [/^https:\/\/[a-z-]+\.preview\.example$/],
      requireHttps: false,
      maxBodyBytes: 1024 * 1024,
      routeOverrides: new Map(),
      rateLimitWindowMs: 60_000,
      rateLimitMax: 100,
      enabledEndpoints: new Set(),
      requireEnabledEndpointClaim: false,
      requireOrganizationClaim: false,
      billingAdminEmails: new Set(),
      billingAdminUserIds: new Set(),
      adminEmails: new Set(['owner@example.com']),
      apiKeySecret: 'api-key-secret',
    },
  });
  await new Promise<void>(resolve => secureServer.listen(0, resolve));
  const secureAddress = secureServer.address() as AddressInfo;
  const secureBase = `http://127.0.0.1:${secureAddress.port}`;

  async function token(userId: string, scope: string, claims: Record<string, unknown> = {}): Promise<string> {
    return new SignJWT({ scope, user_id: userId, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://issuer.example/')
      .setAudience('foreverbetter-health-api')
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  try {
    const denied = await fetch(`${secureBase}/imports/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: 'user_a', category: 'biomarkers', text: 'marker,value,unit\nApoB,100,mg/dL\n' }),
    });
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate') ?? '', /Bearer realm="wellnizz-api"/);
    assert.equal((await denied.json()).type, 'urn:wellnizz-api:problem:unauthorized');

    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ scope: '' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://issuer.example/')
      .setAudience('foreverbetter-health-api')
      .setSubject('user_expired')
      .setIssuedAt(now - 120)
      .setExpirationTime(now - 60)
      .sign(privateKey);
    const expiredKey = await fetch(`${secureBase}/api-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${expired}` },
      body: JSON.stringify({ name: 'expired session key', expires_in_days: 1 }),
    });
    assert.equal(expiredKey.status, 401);
    assert.equal((await expiredKey.json()).detail, 'Authentication failed.');

    const readOnly = await token('user_a', 'health:data:read');
    const publicReady = await fetch(`${secureBase}/ready`).then(response => response.json());
    assert.deepEqual(Object.keys(publicReady).sort(), ['ok', 'service', 'version']);
    const unauthenticatedReadyDetails = await fetch(`${secureBase}/ready/details`);
    assert.equal(unauthenticatedReadyDetails.status, 401);
    const nonAdminReadyDetails = await fetch(`${secureBase}/ready/details`, { headers: { authorization: `Bearer ${readOnly}` } });
    assert.equal(nonAdminReadyDetails.status, 403);
    const admin = await token('security_admin', 'health:admin');
    const adminReadyDetails = await fetch(`${secureBase}/ready/details`, { headers: { authorization: `Bearer ${admin}` } });
    assert.equal(adminReadyDetails.status, 200);
    assert.equal((await adminReadyDetails.json()).storage.checks.store, 'memory');

    const adminByEmail = await token('user_owner', '', { email: 'Owner@Example.com' });
    const emailAdminReadyDetails = await fetch(`${secureBase}/ready/details`, { headers: { authorization: `Bearer ${adminByEmail}` } });
    assert.equal(emailAdminReadyDetails.status, 200);
    const nonAdminEmail = await token('user_d', '', { email: 'someone-else@example.com' });
    const nonAdminEmailReadyDetails = await fetch(`${secureBase}/ready/details`, { headers: { authorization: `Bearer ${nonAdminEmail}` } });
    assert.equal(nonAdminEmailReadyDetails.status, 403);

    const missingScope = await fetch(`${secureBase}/imports/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${readOnly}` },
      body: JSON.stringify({ user_id: 'user_a', category: 'biomarkers', text: 'marker,value,unit\nApoB,100,mg/dL\n' }),
    });
    assert.equal(missingScope.status, 403);
    assert.equal((await missingScope.json()).type, 'urn:wellnizz-api:problem:forbidden');

    const bareUser = await token('user_c', '');
    const selfServeKey = await postTo(secureBase, '/api-keys', {
      name: 'first personal workspace key',
      tier: 'free',
      intended_use: 'personal_agent',
      expires_in_days: 30,
    }, bareUser);
    assert.equal(selfServeKey.created.organization_id, personalOrganizationId('user_c'));
    assert.equal(selfServeKey.created.user_id, 'user_c');
    const selfServeImport = await postTo(secureBase, '/imports/file', {
      user_id: 'user_c',
      organization_id: personalOrganizationId('user_c'),
      category: 'biomarkers',
      content_type: 'text/csv',
      text: 'marker,value,unit\nApoB,100,mg/dL\n',
    }, selfServeKey.api_key);
    assert.equal(selfServeImport.source.organization_id, personalOrganizationId('user_c'));

    const mobileWithoutFreshSignIn = await fetch(`${secureBase}/api-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bareUser}` },
      body: JSON.stringify({ intended_use: 'mobile_sync' }),
    });
    assert.equal(mobileWithoutFreshSignIn.status, 400);

    const mobileOtpSession = await token('user_c', '', { api_key_id: 'otp_session_test' });
    const mobileSyncKey = await postTo(secureBase, '/api-keys', {
      name: 'ForeverBetter Connect mobile key',
      tier: 'free',
      intended_use: 'mobile_sync',
      scopes: ['health:data:read', 'health:admin'],
      enabled_endpoints: ['analyses.read'],
      expires_in_days: 1,
    }, mobileOtpSession);
    assert.equal(mobileSyncKey.created.expires_at, null);
    assert.deepEqual(mobileSyncKey.created.scopes, ['health:data:write']);
    assert.deepEqual(mobileSyncKey.created.enabled_endpoints, ['connections.sync']);
    assert.equal(decodeJwt(mobileSyncKey.api_key).exp, undefined);
    const mobileSync = await fetch(`${secureBase}/api/v1/sdk/users/user_c/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-foreverbetter-api-key': mobileSyncKey.api_key },
      body: JSON.stringify({
        provider: 'health_connect',
        sdkVersion: '0.10.0',
        syncTimestamp: '2026-07-14T12:00:00Z',
        data: {
          records: [
            { id: 'steps-mobile-1', type: 'steps', startDate: '2026-07-14T11:00:00Z', endDate: '2026-07-14T12:00:00Z', value: 1200, unit: 'count' },
          ],
        },
      }),
    });
    assert.equal(mobileSync.status, 202);
    const mobileKeyCannotRead = await fetch(`${secureBase}/sources/${selfServeImport.source.id}`, {
      headers: { 'x-foreverbetter-api-key': mobileSyncKey.api_key },
    });
    assert.equal(mobileKeyCannotRead.status, 403);

    const arbitraryOrgKey = await fetch(`${secureBase}/api-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bareUser}` },
      body: JSON.stringify({ organization_id: 'org_not_claimed', tier: 'free', intended_use: 'personal_agent' }),
    });
    assert.equal(arbitraryOrgKey.status, 403);

    const writer = await token('user_a', 'health:data:read health:data:write', { organization_id: 'org_a' });
    const imported = await postTo(secureBase, '/imports/file', {
      user_id: 'user_a',
      organization_id: 'org_a',
      category: 'biomarkers',
      content_type: 'text/csv',
      text: 'marker,value,unit\nApoB,118,mg/dL\n',
    }, writer);
    assert.equal(imported.source.user_id, 'user_a');

    const intruder = await token('user_b', 'health:data:read health:data:write', { organization_id: 'org_a' });
    const crossUser = await fetch(`${secureBase}/analyses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${intruder}` },
      body: JSON.stringify({ user_id: 'user_b', organization_id: 'org_a', source_ids: [imported.source.id] }),
    });
    assert.equal(crossUser.status, 404);

    const analysis = await postTo(secureBase, '/analyses', {
      user_id: 'user_a',
      organization_id: 'org_a',
      source_ids: [imported.source.id],
    }, writer);
    assert.equal(analysis.user_id, 'user_a');

    const ownerDashboardLink = await fetch(`${secureBase}/dashboard-links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${writer}` },
      body: JSON.stringify({ analysis_id: analysis.id, design_id: 'aperture', expires_in_days: 7 }),
    });
    assert.equal(ownerDashboardLink.status, 201);

    const intruderDashboardLink = await fetch(`${secureBase}/dashboard-links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${intruder}` },
      body: JSON.stringify({ analysis_id: analysis.id, design_id: 'aperture', expires_in_days: 7 }),
    });
    assert.equal(intruderDashboardLink.status, 403);
    const intruderMcpDashboardLink = await postTo(secureBase, '/mcp', {
      jsonrpc: '2.0', id: 70, method: 'tools/call',
      params: { name: 'create_private_dashboard_link', arguments: { analysis_id: analysis.id, design_id: 'aperture' } },
    }, intruder);
    assert.equal(intruderMcpDashboardLink.error.code, -32000);
    assert.match(intruderMcpDashboardLink.error.message, /not allowed to access this user resource/i);

    const foreignRead = await fetch(`${secureBase}/analyses/${analysis.id}`, {
      headers: { authorization: `Bearer ${intruder}` },
    });
    assert.equal(foreignRead.status, 403);

    const ownRead = await fetch(`${secureBase}/analyses/${analysis.id}`, {
      headers: { authorization: `Bearer ${writer}`, origin: 'https://app.example' },
    });
    assert.equal(ownRead.status, 200);
    assert.equal(ownRead.headers.get('cache-control'), 'no-store');
    assert.equal(ownRead.headers.get('access-control-allow-origin'), 'https://app.example');

    const patternCorsRead = await fetch(`${secureBase}/analyses/${analysis.id}`, {
      headers: { authorization: `Bearer ${writer}`, origin: 'https://feature.preview.example' },
    });
    assert.equal(patternCorsRead.status, 200);
    assert.equal(patternCorsRead.headers.get('access-control-allow-origin'), 'https://feature.preview.example');

    // Discovery, recommendations, and trends endpoints enforce the same tenant boundary.
    const ownAnalysisList = await fetch(`${secureBase}/analyses?user_id=user_a&organization_id=org_a`, { headers: { authorization: `Bearer ${writer}` } });
    assert.equal(ownAnalysisList.status, 200);
    assert.ok((await ownAnalysisList.json()).analyses.some((item: any) => item.id === analysis.id));

    const intruderAnalysisList = await fetch(`${secureBase}/analyses?user_id=user_a&organization_id=org_a`, { headers: { authorization: `Bearer ${intruder}` } });
    assert.equal(intruderAnalysisList.status, 403);

    const intruderSourceList = await fetch(`${secureBase}/sources?user_id=user_a&organization_id=org_a`, { headers: { authorization: `Bearer ${intruder}` } });
    assert.equal(intruderSourceList.status, 403);

    const intruderSourceRead = await fetch(`${secureBase}/sources/${imported.source.id}`, { headers: { authorization: `Bearer ${intruder}` } });
    assert.equal(intruderSourceRead.status, 403);

    const intruderRecommendations = await fetch(`${secureBase}/analyses/${analysis.id}/recommendations`, { headers: { authorization: `Bearer ${intruder}` } });
    assert.equal(intruderRecommendations.status, 403);

    const intruderTrends = await fetch(`${secureBase}/users/user_a/trends`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${intruder}` },
      body: JSON.stringify({ organization_id: 'org_a' }),
    });
    assert.equal(intruderTrends.status, 403);

    const apiKey = await postTo(secureBase, '/api-keys', {
      name: 'docs example key',
      organization_id: 'org_a',
      tier: 'free',
      intended_use: 'personal_agent',
      expires_in_days: 30,
    }, writer);
    assert.equal(apiKey.created.tier, 'free');
    assert.equal(apiKey.created.intended_use, 'personal_agent');
    assert.equal(apiKey.created.organization_id, 'org_a');
    assert.match(apiKey.api_key, /^ey/);
    const apiKeyRead = await fetch(`${secureBase}/analyses/${analysis.id}`, {
      headers: { authorization: `Bearer ${apiKey.api_key}` },
    });
    assert.equal(apiKeyRead.status, 200);
    const mobileSdkApiKeyRead = await fetch(`${secureBase}/analyses/${analysis.id}`, {
      headers: { 'x-foreverbetter-api-key': apiKey.api_key },
    });
    assert.equal(mobileSdkApiKeyRead.status, 200);

    const commercialFree = await fetch(`${secureBase}/api-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${writer}` },
      body: JSON.stringify({ organization_id: 'org_a', tier: 'free', intended_use: 'app_platform_service' }),
    });
    assert.equal(commercialFree.status, 400);

    const endpointLimited = await token('user_a', 'health:data:read health:data:write', {
      app_metadata: { enabled_endpoints: ['query.create'] },
    });
    const defaultOwnSourceRead = await fetch(`${secureBase}/sources/${imported.source.id}`, {
      headers: { authorization: `Bearer ${endpointLimited}` },
    });
    assert.equal(defaultOwnSourceRead.status, 200, 'read scope grants access to all resources owned by the authenticated user');
    const endpointDenied = await fetch(`${secureBase}/imports/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${endpointLimited}` },
      body: JSON.stringify({ user_id: 'user_a', category: 'biomarkers', text: 'marker,value,unit\nApoB,100,mg/dL\n' }),
    });
    assert.equal(endpointDenied.status, 403);
    const dashboardGrantDenied = await fetch(`${secureBase}/dashboard-links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${endpointLimited}` },
      body: JSON.stringify({ analysis_id: analysis.id, design_id: 'aperture' }),
    });
    assert.equal(dashboardGrantDenied.status, 403);
    const mcpDashboardGrantDenied = await postTo(secureBase, '/mcp', {
      jsonrpc: '2.0', id: 71, method: 'tools/call',
      params: { name: 'create_private_dashboard_link', arguments: { analysis_id: analysis.id, design_id: 'aperture' } },
    }, endpointLimited);
    assert.equal(mcpDashboardGrantDenied.error.code, -32000);
    assert.match(mcpDashboardGrantDenied.error.message, /not enabled for endpoint: dashboard_links\.create/i);

    const mcpReadOnly = await token('user_a', 'health:data:read', {
      enabled_endpoints: ['query_health_context', 'get_dashboard_spec'],
    });
    const listedTools = await postTo(secureBase, '/mcp', { id: 2, method: 'tools/list', params: {} }, mcpReadOnly);
    assert.deepEqual(listedTools.result.tools.map((tool: any) => tool.name).sort(), [
      'get_action_plan',
      'get_dashboard_spec',
      'get_design_implementation',
      'get_health_context',
      'get_health_trends',
      'get_recommendations',
      'list_analyses',
      'list_sources',
      'query_health_context',
    ]);

    const orgWriter = await token('user_a', 'health:data:read health:data:write', {
      app_metadata: { org_ids: ['org_a'], enabled_endpoints: ['imports.file', 'analyses.create', 'dashboard_specs.read', 'query.create'] },
    });
    const orgImport = await postTo(secureBase, '/imports/file', {
      user_id: 'user_a',
      organization_id: 'org_a',
      category: 'biomarkers',
      content_type: 'text/csv',
      text: 'marker,value,unit\nApoB,122,mg/dL\n',
    }, orgWriter);
    assert.equal(orgImport.source.organization_id, 'org_a');

    const orgAnalysis = await postTo(secureBase, '/analyses', {
      user_id: 'user_a',
      organization_id: 'org_a',
      source_ids: [orgImport.source.id],
    }, orgWriter);
    assert.equal(orgAnalysis.organization_id, 'org_a');

    const wrongOrgToken = await token('user_a', 'health:data:read health:data:write', {
      organization_id: 'org_b',
      enabled_endpoints: ['analyses.create', 'dashboard_specs.read', 'dashboard_links.create', 'query.create'],
    });
    const crossOrgAnalysis = await fetch(`${secureBase}/analyses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${wrongOrgToken}` },
      body: JSON.stringify({ user_id: 'user_a', organization_id: 'org_b', source_ids: [orgImport.source.id] }),
    });
    assert.equal(crossOrgAnalysis.status, 404);

    const crossOrgDashboard = await fetch(`${secureBase}/dashboard-specs/${orgAnalysis.id}`, {
      headers: { authorization: `Bearer ${wrongOrgToken}` },
    });
    assert.equal(crossOrgDashboard.status, 403);
    const crossOrgDashboardLink = await fetch(`${secureBase}/dashboard-links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${wrongOrgToken}` },
      body: JSON.stringify({ analysis_id: orgAnalysis.id, design_id: 'aperture' }),
    });
    assert.equal(crossOrgDashboardLink.status, 403);
  } finally {
    await new Promise<void>((resolve, reject) => secureServer.close(error => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => jwksServer.close(error => error ? reject(error) : resolve()));
  }
});

test('lists sources and analyses, returns recommendations, and computes trends across uploads', async () => {
  const userId = 'discovery_user';
  const orgId = 'discovery_org';

  const first = await post('/imports/file', {
    user_id: userId,
    organization_id: orgId,
    category: 'biomarkers',
    filename: 'labs-jan.json',
    content_type: 'application/json',
    text: JSON.stringify({ readings: [
      { marker: 'ApoB', value: 120, unit: 'mg/dL', collected_at: '2026-01-01' },
      { marker: 'HDL-C', value: 45, unit: 'mg/dL', collected_at: '2026-01-01' },
    ] }),
  });
  const second = await post('/imports/file', {
    user_id: userId,
    organization_id: orgId,
    category: 'biomarkers',
    filename: 'labs-apr.json',
    content_type: 'application/json',
    text: JSON.stringify({ readings: [
      { marker: 'ApoB', value: 95, unit: 'mg/dL', collected_at: '2026-04-01' },
      { marker: 'HDL-C', value: 52, unit: 'mg/dL', collected_at: '2026-04-01' },
    ] }),
  });

  const sources = await get(`/sources?user_id=${userId}&organization_id=${orgId}`);
  assert.equal(sources.count, 2);
  assert.ok(sources.sources.every((source: any) => source.category === 'biomarkers'));

  const sourceRead = await get(`/sources/${first.source.id}`);
  assert.equal(sourceRead.source.id, first.source.id);
  assert.ok(sourceRead.normalized_observations.length >= 1);

  const analysis = await post('/biomarkers/analyze', {
    user_id: userId,
    organization_id: orgId,
    source_ids: [first.source.id, second.source.id],
  });
  assert.equal(analysis.modality, 'biomarkers');
  assert.equal(typeof analysis.healthspan_score, 'number');

  const analyses = await get(`/analyses?user_id=${userId}&organization_id=${orgId}`);
  assert.ok(analyses.analyses.some((item: any) => item.id === analysis.id));
  const summary = analyses.analyses.find((item: any) => item.id === analysis.id);
  assert.equal(summary.modality, 'biomarkers');
  assert.equal(typeof summary.healthspan_score, 'number');

  const modalityFiltered = await get(`/analyses?user_id=${userId}&organization_id=${orgId}&modality=wearables`);
  assert.ok(!modalityFiltered.analyses.some((item: any) => item.id === analysis.id));

  const recs = await get(`/analyses/${analysis.id}/recommendations`);
  assert.ok(Array.isArray(recs.recommendations));
  assert.ok(recs.recommendations.every((rec: any) => typeof rec.action === 'string' && rec.action.length > 0));
  assert.ok(recs.recommendations.every((rec: any) => rec.status !== 'optimal'));
  // Recommendations are also grouped into tiered protocol routines.
  assert.ok(Array.isArray(recs.protocols) && recs.protocols.length > 0);
  assert.ok(recs.protocols.every((routine: any) => Array.isArray(routine.items) && routine.items.length > 0 && Array.isArray(routine.domains)));
  assert.ok(recs.protocols.some((routine: any) => routine.id === 'core' || routine.id === 'optimize'));

  // The complete-analysis download 404s when no artifact was preserved (this
  // biomarkers analysis has no genetics artifact), rather than erroring.
  const fullAnalysisMissing = await fetch(`${baseUrl}/analyses/${analysis.id}/full-analysis`);
  assert.equal(fullAnalysisMissing.status, 404);

  const trends = await post(`/users/${userId}/trends`, { organization_id: orgId });
  const apob = trends.markers.find((marker: any) => marker.marker === 'apob');
  assert.ok(apob, 'expected an ApoB trend');
  assert.equal(apob.points.length, 2);
  assert.equal(apob.direction_basis, 'lower_is_better');
  assert.equal(apob.trend, 'improving'); // 120 -> 95
  const hdl = trends.markers.find((marker: any) => marker.marker === 'hdl_c');
  assert.equal(hdl.direction_basis, 'higher_is_better');
  assert.equal(hdl.trend, 'improving'); // 45 -> 52

  const rerun = await post(`/analyses/${analysis.id}/rerun`, {});
  assert.equal(rerun.modality, 'biomarkers');
  assert.notEqual(rerun.id, analysis.id);

  const mcpTrends = await post('/mcp', { id: 42, method: 'tools/call', params: { name: 'get_health_trends', arguments: { user_id: userId, organization_id: orgId } } });
  assert.match(mcpTrends.result.content[0].text, /"markers"/);
});

test('creates, lists, updates, and deletes health goals', async () => {
  const userId = 'goals_user';
  const orgId = 'org_personal_goals_user';
  const created = await post(`/users/${userId}/goals`, {
    organization_id: orgId,
    title: 'Get ApoB under 80 mg/dL',
    metric: 'apob',
    target_value: 80,
    target_unit: 'mg/dL',
    target_direction: 'decrease',
    due_date: '2027-01-01',
  });
  assert.match(created.id, /^goal_/);
  assert.equal(created.status, 'active');

  const list = await get(`/users/${userId}/goals?organization_id=${orgId}`);
  assert.equal(list.count, 1);
  assert.equal(list.goals[0].metric, 'apob');

  const updated = await post(`/goals/${created.id}`, { status: 'achieved', note: 'Hit target at last panel' });
  assert.equal(updated.status, 'achieved');

  const fetched = await get(`/goals/${created.id}`);
  assert.equal(fetched.status, 'achieved');

  const deleted = await post(`/goals/${created.id}/delete`, {});
  assert.equal(deleted.deleted, true);
  const afterDelete = await get(`/users/${userId}/goals?organization_id=${orgId}`);
  assert.equal(afterDelete.count, 0);
});

test('rejects an invalid goal update with a 400 instead of a 500', async () => {
  const userId = 'goals_validate_user';
  const orgId = 'org_personal_goals_validate_user';
  const created = await post(`/users/${userId}/goals`, { organization_id: orgId, title: 'Improve HRV' });

  const badStatus = await fetch(`${baseUrl}/goals/${created.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'not-a-status' }),
  });
  assert.equal(badStatus.status, 400);

  const badDate = await fetch(`${baseUrl}/goals/${created.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ due_date: 'soon' }),
  });
  assert.equal(badDate.status, 400);

  // A valid update still succeeds.
  const ok = await post(`/goals/${created.id}`, { status: 'achieved' });
  assert.equal(ok.status, 'achieved');
});

test('warns when an upload yields no recognized readings', async () => {
  const result = await post('/imports/file', {
    user_id: 'warn_user',
    organization_id: 'org_personal_warn_user',
    category: 'biomarkers',
    filename: 'notes.txt',
    content_type: 'text/plain',
    text: 'This is just a note with no lab markers in it.',
  });
  assert.equal(result.normalized_observations.length, 0);
  assert.ok(Array.isArray(result.warnings) && result.warnings.length >= 1);
  assert.match(result.warnings[0], /no recognized readings/i);
});

test('computes retest reminders from uploaded data', async () => {
  const userId = 'reminder_user';
  const orgId = 'org_personal_reminder_user';
  await post('/imports/file', {
    user_id: userId,
    organization_id: orgId,
    category: 'biomarkers',
    filename: 'labs.csv',
    text: 'marker,value,unit\nApoB,95,mg/dL\nHDL,55,mg/dL',
  });
  const reminders = await get(`/users/${userId}/retest-reminders?organization_id=${orgId}`);
  const biomarker = reminders.reminders.find((r: any) => r.category === 'biomarkers');
  assert.ok(biomarker);
  assert.equal(biomarker.cadence_days, 365);
  // Freshly uploaded, so it is current, not due.
  assert.equal(biomarker.status, 'ok');
  const behavioral = reminders.reminders.find((r: any) => r.category === 'behavioral');
  assert.equal(behavioral.status, 'never_tested');
});

test('serves a customized action plan for an analysis', async () => {
  const userId = 'plan_user';
  const orgId = 'org_personal_plan_user';
  const labs = await post('/imports/file', {
    user_id: userId, organization_id: orgId, category: 'biomarkers',
    filename: 'labs.csv', content_type: 'text/csv',
    text: 'marker,value,unit\nApoB,128,mg/dL\nVitamin D,24,ng/mL\n',
  });
  const behavioral = await post('/imports/file', {
    user_id: userId, organization_id: orgId, category: 'behavioral',
    filename: 'log.json', content_type: 'application/json',
    text: JSON.stringify({ entries: [{ kind: 'supplement', name: 'Vitamin D3', dose: '2000 IU' }] }),
  });
  const analysis = await post('/analyses', {
    user_id: userId, organization_id: orgId, source_ids: [labs.source.id, behavioral.source.id],
  });

  const plan = await get(`/analyses/${analysis.id}/action-plan`);
  assert.equal(plan.analysis_id, analysis.id);
  assert.ok(Array.isArray(plan.interventions) && Array.isArray(plan.supplements));
  // Low vitamin D -> D3, flagged already_taking since the user logs it.
  const d3 = plan.supplements.find((s: any) => s.id === 'vitamin_d3');
  assert.ok(d3, 'expected a vitamin D3 recommendation');
  assert.equal(d3.already_taking, true);
  assert.equal(d3.typical_dose, undefined);
  assert.match(d3.dose_guidance, /withheld|clinician|pharmacist/i);
  // High ApoB -> fiber/sterols appear among the supplements.
  assert.ok(plan.supplements.some((s: any) => s.id === 'soluble_fiber' || s.id === 'plant_sterols'));
  assert.match(plan.disclaimer, /not medical advice/i);
  assert.ok(plan.evidence_key.A);
});

test('finds providers across modalities in one call', async () => {
  const all = await get('/providers');
  assert.deepEqual(all.query.modalities, ['genetics', 'biomarkers', 'wearables']);
  assert.ok(all.genetics.length > 0);
  assert.ok(all.wearables.some((w: any) => w.id === 'whoop'));
  assert.ok(all.biomarkers.supported_providers.includes('quest'));

  const geneticsOnly = await get('/providers?modality=genetics&type=wgs');
  assert.deepEqual(geneticsOnly.query.modalities, ['genetics']);
  assert.ok(geneticsOnly.genetics.every((p: any) => p.type === 'wgs'));
  assert.equal(geneticsOnly.wearables, undefined);
});

test('serves public design systems without auth', async () => {
  // No Authorization header - design tokens are public reference data.
  const listRes = await fetch(`${baseUrl}/design/systems`);
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.equal(list.count, 3);
  assert.ok(list.systems.some((s: any) => /WHOOP/.test(s.inspired_by)));
  assert.ok(list.systems.some((s: any) => s.id === 'aperture'));

  const oneRes = await fetch(`${baseUrl}/design/systems/aperture`);
  assert.equal(oneRes.status, 200);
  const system = await oneRes.json();
  assert.equal(system.name, 'Aperture');
  assert.equal(system.layout.hero, 'aperture-overview');
  assert.equal(system.colors.primary, '#0EA5A0');
  assert.ok(system.components.aperture_action_card);
  assert.ok(system.typography.scale.display.size);
  assert.match(system.design_md, /# Aperture/);

  const meridian = await fetch(`${baseUrl}/design/systems/meridian`);
  assert.equal(meridian.status, 200);
  const meridianBody = await meridian.json();
  assert.equal(meridianBody.layout.hero, 'healthspan-performance');
  assert.match(meridianBody.inspired_by, /WHOOP/);
  assert.match(meridianBody.vibe, /WHOOP-inspired/);

  const implementation = await fetch(`${baseUrl}/design/systems/meridian/implementation`);
  assert.equal(implementation.status, 200);
  const packageBody = await implementation.json();
  assert.equal(packageBody.format, 'design_system_handoff');
  assert.equal(packageBody.production_dashboard.entrypoint, 'dashboard/index.html');
  assert.match(packageBody.description, /production dashboard source/);
  assert.ok(packageBody.production_dashboard.files.some((file: any) => file.path === 'dashboard/index.html' && file.contents.includes('meridian-topbar')));
  assert.ok(packageBody.production_dashboard.files.some((file: any) => file.path === 'dashboard/styles.css' && file.sha256.length === 64));
  assert.ok(packageBody.production_dashboard.components.some((component: any) => component.type === 'whoop_provider_card'));
  assert.ok(packageBody.production_dashboard.binary_assets.some((asset: any) => asset.path === 'dashboard/assets/tablet-dashboard.png'));
  assert.equal(packageBody.format, 'design_system_handoff');
  assert.equal(packageBody.components.length, 50);
  assert.ok(packageBody.components.some((component: any) => component.sourcePath === 'components/bio/BiomarkerPanel.jsx'));
  assert.ok(packageBody.components.some((component: any) => component.sourcePath === 'components/bio/BiomarkerRow.jsx'));
  assert.ok(packageBody.components.every((component: any) =>
    typeof component.sourcePath === 'string' && component.sourcePath.length > 0,
  ));
  assert.ok(packageBody.templates.every((template: any) =>
    typeof template.entryPath === 'string' && template.entryPath.length > 0,
  ));

  const apertureImplementation = await fetch(`${baseUrl}/design/systems/aperture/implementation`);
  assert.equal(apertureImplementation.status, 200);
  const aperturePackage = await apertureImplementation.json();
  assert.equal(aperturePackage.format, 'design_system_handoff');
  assert.equal(aperturePackage.components.length, 20);
  assert.ok(aperturePackage.components.some((component: any) => component.sourcePath === 'components/layout/Sidebar.jsx'));
  assert.ok(aperturePackage.templates.some((template: any) => template.entryPath === 'templates/health-dashboard/HealthDashboard.dc.html'));
  assert.ok(aperturePackage.starting_points.every((startingPoint: any) =>
    typeof startingPoint.path === 'string' && startingPoint.path.length > 0,
  ));

  const apertureStylesheet = await fetch(`${baseUrl}/design-system-specs/aperture/styles.css`);
  assert.equal(apertureStylesheet.status, 404);

  const meridianStylesheet = await fetch(`${baseUrl}/design-system-specs/meridian/styles.css`, { method: 'HEAD' });
  assert.equal(meridianStylesheet.status, 404);

  const missingImplementation = await fetch(`${baseUrl}/design/systems/nope/implementation`);
  assert.equal(missingImplementation.status, 404);
  const traversal = await fetch(`${baseUrl}/design-system-specs/aperture/..%2FSKILL.md`);
  assert.equal(traversal.status, 404);

  const missing = await fetch(`${baseUrl}/design/systems/nope`);
  assert.equal(missing.status, 404);
});

async function post(path: string, body: unknown): Promise<any> {
  return postWithHeaders(path, body, {});
}

async function postWithHeaders(path: string, body: unknown, headers: Record<string, string>): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(response.ok, text);
  return JSON.parse(text);
}

async function postTo(base: string, path: string, body: unknown, token: string): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(response.ok, text);
  return JSON.parse(text);
}

async function get(path: string): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  assert.ok(response.ok, text);
  return JSON.parse(text);
}

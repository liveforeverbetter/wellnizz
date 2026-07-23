import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';
import { createHealthApiServer } from '../src/http.js';
import { loadAuthConfig } from '../src/auth.js';
import { HealthApiStore } from '../src/store.js';

// A server with a first-party WHOOP app configured (auth disabled for the test).
const firstPartyConfig = loadAuthConfig({
  NODE_ENV: 'test',
  AUTH_MODE: 'disabled',
  WHOOP_CLIENT_ID: 'fb_first_party_client',
  WHOOP_CLIENT_SECRET: 'fb_first_party_secret',
  WHOOP_REDIRECT_URI: 'https://api.foreverbetter.xyz/dashboard',
  OURA_CLIENT_ID: 'fb_oura_client',
  OURA_CLIENT_SECRET: 'fb_oura_secret',
  OURA_REDIRECT_URI: 'https://api.foreverbetter.xyz/dashboard',
});
const store = new HealthApiStore();
const previousEncryptionKey = process.env.WHOOP_TOKEN_ENC_KEY;
process.env.WHOOP_TOKEN_ENC_KEY = randomBytes(32).toString('base64');
const server = createHealthApiServer(store, { auth: firstPartyConfig });
let baseUrl = '';

before(async () => {
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (previousEncryptionKey === undefined) delete process.env.WHOOP_TOKEN_ENC_KEY;
  else process.env.WHOOP_TOKEN_ENC_KEY = previousEncryptionKey;
});

test('a user can start a WHOOP connection without supplying credentials', async () => {
  const res = await fetch(`${baseUrl}/connections/wearables/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: 'signed_up_user', organization_id: 'personal_org', source_provider: 'whoop' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.connection_type, 'oauth');
  // The authorization URL is built from the server's first-party app.
  assert.match(body.authorization_url, /api\.prod\.whoop\.com/);
  assert.match(body.authorization_url, /fb_first_party_client/);
  assert.match(body.authorization_url, /dashboard/);
  assert.ok(body.scopes.includes('read:profile'));
  assert.equal(body.automatic_browser_completion, true);
  assert.match(new URL(body.authorization_url).searchParams.get('state') ?? '', /^fb1\.whoop\./);
});

test('persists first-party WHOOP tokens for webhook sync', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('oauth/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'provider_access', refresh_token: 'provider_refresh', expires_in: 3600, scope: 'offline read:profile read:sleep' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/developer/v2/user/profile/basic')) {
      return new Response(JSON.stringify({ user_id: 987654 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/developer/v2/webhook/subscription')) {
      if (init?.method === 'POST') return new Response(JSON.stringify({ success: true }), { status: 201, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(input, init);
  };
  try {
    const start = await fetch(`${baseUrl}/connections/wearables/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: 'persist_user', organization_id: 'persist_org', source_provider: 'whoop' }),
    });
    const state = new URL((await start.json()).authorization_url).searchParams.get('state');
    assert.ok(state);
    const res = await fetch(`${baseUrl}/connections/wearables/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: 'persist_user', organization_id: 'persist_org', source_provider: 'whoop', code: 'oauth_code', state }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.token_storage, 'server_encrypted_for_webhooks');
    assert.equal(body.webhook_sync_enabled, true);
    const token = await store.getProviderTokenByExternalUser('whoop', '987654');
    assert.ok(token);
    assert.equal(token?.user_id, 'persist_user');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects a signed first-party connection state for a different user', async () => {
  const start = await fetch(`${baseUrl}/connections/wearables/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: 'state_owner', organization_id: 'state_org', source_provider: 'whoop' }),
  });
  const state = new URL((await start.json()).authorization_url).searchParams.get('state');
  const callback = await fetch(`${baseUrl}/connections/wearables/callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: 'other_user', organization_id: 'state_org', source_provider: 'whoop', code: 'unused_code', state }),
  });
  assert.equal(callback.status, 400);
  assert.match((await callback.json()).detail, /does not match your account/);
});

test('explains a rejected WHOOP authorization code', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('oauth/oauth2/token')) {
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(input, init);
  };
  try {
    const res = await fetch(`${baseUrl}/connections/wearables/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: 'rejected_user', organization_id: 'rejected_org', source_provider: 'whoop', code: 'already-used-code' }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).detail, /expired or already been used/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('capabilities advertise first-party WHOOP OAuth when configured', async () => {
  const res = await fetch(`${baseUrl}/capabilities`);
  const body = await res.json();
  const whoop = body.capabilities.find((c: any) => c.id === 'wearables.whoop');
  assert.equal(whoop.first_party_oauth, true);
});

test('a user can connect and sync Oura without supplying credentials', async () => {
  const originalFetch = globalThis.fetch;
  const previousVerificationToken = process.env.OURA_WEBHOOK_VERIFICATION_TOKEN;
  process.env.OURA_WEBHOOK_VERIFICATION_TOKEN = 'test-oura-verification-token';
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('api.ouraring.com/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'oura_access', refresh_token: 'oura_refresh', expires_in: 3600, scope: 'daily heartrate personal workout' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/v2/webhook/subscription')) {
      if (init?.method === 'POST') throw new Error('Oura subscriptions already exist and must not be duplicated.');
      return new Response(JSON.stringify([
        ...['daily_activity', 'daily_readiness', 'daily_sleep'].flatMap(data_type => ['create', 'update'].map(event_type => ({ callback_url: 'https://api.foreverbetter.xyz/connections/oura/webhook', data_type, event_type }))),
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/usercollection/personal_info')) return new Response(JSON.stringify({ id: 'oura_member_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('daily_readiness')) return new Response(JSON.stringify({ data: [{ score: 83 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('daily_sleep')) return new Response(JSON.stringify({ data: [{ total_sleep_duration: 27000, efficiency: 91, average_hrv: 48, lowest_heart_rate: 52 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('daily_activity')) return new Response(JSON.stringify({ data: [{ steps: 8123, active_calories: 421 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return originalFetch(input, init);
  };
  try {
    const start = await fetch(`${baseUrl}/connections/wearables/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: 'oura_user', organization_id: 'oura_org', source_provider: 'oura' }),
    });
    const started = await start.json();
    assert.equal(start.status, 200);
    assert.match(started.authorization_url, /cloud\.ouraring\.com\/oauth\/authorize/);
    assert.match(started.authorization_url, /fb_oura_client/);

    const callback = await fetch(`${baseUrl}/connections/wearables/callback`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: 'oura_user', organization_id: 'oura_org', source_provider: 'oura', code: 'oura_code' }),
    });
    const connected = await callback.json();
    assert.equal(callback.status, 200);
    assert.equal(connected.token_storage, 'server_encrypted_for_sync');
    assert.equal(connected.server_sync_enabled, true);
    assert.ok(await store.getProviderTokenByExternalUser('oura', 'oura_member_1'));

    const sync = await fetch(`${baseUrl}/connections/oura/sync`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: 'oura_user', organization_id: 'oura_org', start: '2026-07-01', end: '2026-07-02' }),
    });
    const synced = await sync.json();
    assert.equal(sync.status, 200);
    assert.equal(synced.provider, 'oura');
    assert.ok(synced.normalized_observations.some((item: any) => item.name === 'hrv' && item.value === 48));
    assert.ok(synced.normalized_observations.some((item: any) => item.name === 'steps' && item.value === 8123));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousVerificationToken === undefined) delete process.env.OURA_WEBHOOK_VERIFICATION_TOKEN;
    else process.env.OURA_WEBHOOK_VERIFICATION_TOKEN = previousVerificationToken;
  }
});

test('accepts signed Oura webhook notifications and queues an Oura reconciliation', async () => {
  const previousVerificationToken = process.env.OURA_WEBHOOK_VERIFICATION_TOKEN;
  process.env.OURA_WEBHOOK_VERIFICATION_TOKEN = 'test-oura-verification-token';
  try {
    const challenge = await fetch(`${baseUrl}/connections/oura/webhook?verification_token=test-oura-verification-token&challenge=challenge_1`);
    assert.equal(challenge.status, 200);
    assert.deepEqual(await challenge.json(), { challenge: 'challenge_1' });

    const body = JSON.stringify({ event_type: 'update', data_type: 'daily_readiness', object_id: 'readiness_1', user_id: 'oura_member_1', id: 'event_1' });
    const timestamp = '2026-07-13T12:00:00.000Z';
    const signature = createHmac('sha256', 'fb_oura_secret').update(`${timestamp}${body}`).digest('hex').toUpperCase();
    const response = await fetch(`${baseUrl}/connections/oura/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-oura-timestamp': timestamp, 'x-oura-signature': signature },
      body,
    });
    assert.equal(response.status, 202);
    const queued = await response.json();
    const job = await store.getConnectorSyncJob(queued.job_id);
    assert.equal(job?.provider, 'oura');
    assert.equal((job?.request as any).provider_user_id, 'oura_member_1');
  } finally {
    if (previousVerificationToken === undefined) delete process.env.OURA_WEBHOOK_VERIFICATION_TOKEN;
    else process.env.OURA_WEBHOOK_VERIFICATION_TOKEN = previousVerificationToken;
  }
});

test('without first-party config, WHOOP start still requires client_id', async () => {
  const byoServer = createHealthApiServer(undefined, { auth: loadAuthConfig({ NODE_ENV: 'test', AUTH_MODE: 'disabled' }) });
  await new Promise<void>(resolve => byoServer.listen(0, resolve));
  const byoUrl = `http://127.0.0.1:${(byoServer.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${byoUrl}/connections/wearables/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: 'u', organization_id: 'o', source_provider: 'whoop' }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).detail, /client_id/);
  } finally {
    await new Promise<void>((resolve, reject) => byoServer.close(error => error ? reject(error) : resolve()));
  }
});

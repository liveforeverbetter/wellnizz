import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createHealthApiServer } from '../src/http.js';
import { loadAuthConfig } from '../src/auth.js';

const secret = 'synthetic-sandbox-test-secret-with-32-bytes';
const auth = loadAuthConfig({
  AUTH_MODE: 'service_account',
  AUTH_AUDIENCE: 'foreverbetter-health-api',
  SERVICE_ACCOUNT_JWT_SECRET: secret,
  API_KEY_JWT_SECRET: secret,
  HEALTH_API_PUBLIC_SANDBOX: 'true',
  REQUIRE_HTTPS: 'false',
});
const server = createHealthApiServer(undefined, { auth });
let baseUrl = '';

before(async () => {
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('creates a short-lived, non-persistent synthetic hero session end to end', async () => {
  const response = await fetch(`${baseUrl}/sandbox/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 201);
  const result = await response.json() as any;

  assert.equal(result.session.token_type, 'Bearer');
  assert.equal(result.session.synthetic_only, true);
  assert.equal(result.session.expires_in, 1800);
  assert.match(result.session.access_token, /^[^.]+\.[^.]+\.[^.]+$/);
  assert.equal(result.hero.synthetic, true);
  assert.equal(result.hero.persisted, false);
  assert.equal(result.hero.contract_version, '0.5.0');
  assert.equal(result.hero.coverage.find((item: any) => item.modality === 'biomarkers').status, 'connected');
  assert.equal(result.hero.coverage.find((item: any) => item.modality === 'wearables').status, 'connected');
  assert.ok(result.hero.analysis.dashboard_spec.cards.length > 0);
  assert.ok(result.hero.action_plan.interventions.length > 0);
  assert.ok(result.hero.action_plan.supplements.every((item: any) => item.typical_dose === undefined));
  assert.equal(result.hero.safety.supplement_doses_included, false);

  const rerun = await fetch(`${baseUrl}/sandbox/hero`, {
    method: 'POST',
    headers: { authorization: `Bearer ${result.session.access_token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(rerun.status, 200);
  const hero = await rerun.json() as any;
  assert.equal(hero.user_id, result.session.user_id);
  assert.equal(hero.organization_id, result.session.organization_id);
  assert.equal(hero.persisted, false);

  const realDataWrite = await fetch(`${baseUrl}/imports/file`, {
    method: 'POST',
    headers: { authorization: `Bearer ${result.session.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      user_id: result.session.user_id,
      organization_id: result.session.organization_id,
      category: 'biomarkers',
      text: 'marker,value,unit\nApoB,120,mg/dL',
    }),
  });
  assert.equal(realDataWrite.status, 403);
});

test('rejects missing or non-sandbox authorization on the hero route', async () => {
  const response = await fetch(`${baseUrl}/sandbox/hero`, { method: 'POST' });
  assert.equal(response.status, 401);
});

test('hides session issuance when the public sandbox flag is disabled', async () => {
  const disabledAuth = { ...auth, publicSandbox: false };
  const disabledServer = createHealthApiServer(undefined, { auth: disabledAuth });
  await new Promise<void>(resolve => disabledServer.listen(0, resolve));
  try {
    const address = disabledServer.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/sandbox/sessions`, { method: 'POST' });
    assert.equal(response.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => disabledServer.close(error => error ? reject(error) : resolve()));
  }
});

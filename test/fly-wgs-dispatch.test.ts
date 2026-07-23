import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchQueuedWgsWorker } from '../src/core/fly-wgs-dispatch.js';

const configured = {
  WGS_DISPATCH_ENABLED: 'true',
  WGS_WORKER_APP: 'fb-health-api',
  WGS_WORKER_MACHINE_ID: 'wgs-machine',
  FLY_MACHINE_API_TOKEN: 'test-token',
  FLY_MACHINE_API_HOST: 'https://machines.test',
};

test('starts the configured stopped WGS machine once queue work arrives', async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const outcome = await dispatchQueuedWgsWorker(configured, async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET' });
    if (requests.length === 1) return Response.json({ state: 'stopped' });
    return Response.json({ previous_state: 'stopped' });
  });

  assert.equal(outcome.state, 'started');
  assert.deepEqual(requests, [
    { url: 'https://machines.test/v1/apps/fb-health-api/machines/wgs-machine', method: 'GET' },
    { url: 'https://machines.test/v1/apps/fb-health-api/machines/wgs-machine/start', method: 'POST' },
  ]);
});

test('does not start a second WGS machine when one is already running', async () => {
  let calls = 0;
  const outcome = await dispatchQueuedWgsWorker(configured, async () => {
    calls += 1;
    return Response.json({ state: 'started' });
  });

  assert.equal(outcome.state, 'already_running');
  assert.equal(calls, 1);
});

test('refreshes a stopped worker to the current API image before starting it', async () => {
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  const outcome = await dispatchQueuedWgsWorker({ ...configured, FLY_IMAGE_REF: 'registry.fly.io/fb-health-api:new' }, async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined });
    if (requests.length === 1) return Response.json({ state: 'stopped', config: { image: 'registry.fly.io/fb-health-api:old', guest: { cpu_kind: 'shared' } } });
    return Response.json({});
  });

  assert.equal(outcome.state, 'started');
  assert.deepEqual(requests.map(({ url, method }) => ({ url, method })), [
    { url: 'https://machines.test/v1/apps/fb-health-api/machines/wgs-machine', method: 'GET' },
    { url: 'https://machines.test/v1/apps/fb-health-api/machines/wgs-machine', method: 'POST' },
    { url: 'https://machines.test/v1/apps/fb-health-api/machines/wgs-machine/start', method: 'POST' },
  ]);
  assert.deepEqual(JSON.parse(requests[1].body ?? '{}'), {
    config: { image: 'registry.fly.io/fb-health-api:new', guest: { cpu_kind: 'shared' } },
    skip_launch: true,
  });
});

test('keeps the job queued when a stopped worker cannot be refreshed', async () => {
  let calls = 0;
  const outcome = await dispatchQueuedWgsWorker({ ...configured, FLY_IMAGE_REF: 'registry.fly.io/fb-health-api:new' }, async () => {
    calls += 1;
    return calls === 1
      ? Response.json({ state: 'stopped', config: { image: 'registry.fly.io/fb-health-api:old' } })
      : new Response('update failed', { status: 422 });
  });

  assert.equal(outcome.state, 'capacity_unavailable');
  assert.match(outcome.message, /no start capacity/i);
});

test('keeps the job queued with an explicit capacity message when Fly cannot start it', async () => {
  let calls = 0;
  const outcome = await dispatchQueuedWgsWorker(configured, async () => {
    calls += 1;
    return calls === 1 ? Response.json({ state: 'stopped' }) : new Response('capacity', { status: 422 });
  });

  assert.equal(outcome.state, 'capacity_unavailable');
  assert.match(outcome.message, /no start capacity/i);
});

test('is a no-op until WGS dispatch is configured', async () => {
  const outcome = await dispatchQueuedWgsWorker({}, async () => {
    throw new Error('fetch should not be called');
  });
  assert.equal(outcome.state, 'disabled');
});

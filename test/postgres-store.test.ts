import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createId } from '../src/store.js';
import type { AnalysisResult, ConnectorSyncJob, ExternalAccount, GeneticAnalysisJob, Goal, NormalizedObservation, ProviderToken, RawSourceReference } from '../src/types.js';

// Runs only when TEST_DATABASE_URL points at a disposable Postgres. Without it,
// the suite skips so `npm test` stays infra-free.
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const shouldRun = Boolean(DATABASE_URL);
const opts = { skip: shouldRun ? false : 'set TEST_DATABASE_URL to run the Postgres store tests' };

let store: import('../src/connectors/postgres-store.js').PostgresHealthStore;
let closePool: () => Promise<void>;
let payloadDir: string;

const ORG = 'org_test';
const USER = 'user_test';

before(async () => {
  if (!shouldRun) return;
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.STORE_MODE = 'postgres';
  process.env.STORAGE_DRIVER = 'filesystem';
  payloadDir = await mkdtemp(join(tmpdir(), 'fb-payloads-'));
  process.env.PAYLOAD_DIR = payloadDir;

  const { runMigrations } = await import('../src/db/migrate.js');
  const { getPool, closePool: close } = await import('../src/db/pool.js');
  const { PostgresHealthStore } = await import('../src/connectors/postgres-store.js');
  closePool = close;
  await runMigrations();
  const pool = getPool();
  await pool.query(`truncate health_api.sources, health_api.observations, health_api.analyses,
    health_api.dashboard_specs, health_api.idempotency_keys, health_api.genetic_analysis_jobs,
    health_api.external_accounts, health_api.connector_sync_jobs, health_api.provider_tokens,
    health_api.webhook_events, health_api.goals restart identity cascade`);
  store = new PostgresHealthStore();
});

after(async () => {
  if (!shouldRun) return;
  await closePool?.();
  await rm(payloadDir, { recursive: true, force: true });
});

function sampleSource(overrides: Partial<RawSourceReference> = {}): RawSourceReference {
  return {
    id: createId('src'), user_id: USER, organization_id: ORG, category: 'biomarkers',
    provider: 'quest', filename: 'panel.csv', content_type: 'text/csv',
    received_at: new Date().toISOString(), byte_length: 12, storage_mode: 'memory', ...overrides,
  };
}

function sampleObservation(sourceId: string, overrides: Partial<NormalizedObservation> = {}): NormalizedObservation {
  return {
    id: createId('obs'), source_id: sourceId, user_id: USER, organization_id: ORG,
    category: 'biomarkers', type: 'ldl', name: 'LDL Cholesterol', value: 100, unit: 'mg/dL',
    observed_at: new Date().toISOString(), ...overrides,
  };
}

test('saveSource persists the row, observations, and payload round-trips', opts, async () => {
  const source = sampleSource();
  const observations = [sampleObservation(source.id)];
  await store.saveSource(source, observations, Buffer.from('col1,col2\n1,2\n'));

  const fetched = await store.getSource(source.id);
  assert.equal(fetched?.id, source.id);
  assert.equal(fetched?.storage_mode, 'durable');
  assert.equal(fetched?.organization_id, ORG);

  const payload = await store.getSourcePayload(source.id);
  assert.equal(payload?.toString(), 'col1,col2\n1,2\n');

  const dest = join(payloadDir, 'roundtrip.csv');
  assert.equal(await store.writeSourcePayloadToFile(source.id, dest), true);

  const obs = await store.getObservations([source.id]);
  assert.equal(obs.length, 1);
  assert.equal(obs[0]?.value, 100);
  assert.equal(obs[0]?.name, 'LDL Cholesterol');
});

test('tenant filters exclude other orgs', opts, async () => {
  const mine = sampleSource({ organization_id: ORG });
  const other = sampleSource({ organization_id: 'org_other' });
  await store.saveSource(mine, [sampleObservation(mine.id)]);
  await store.saveSource(other, [sampleObservation(other.id, { organization_id: 'org_other' })]);

  const listed = await store.listSourcesForUser(USER, new Set([ORG]));
  assert.ok(listed.every(source => source.organization_id === ORG));
  assert.ok(listed.some(source => source.id === mine.id));
  assert.ok(!listed.some(source => source.id === other.id));
});

test('analysis save/get and per-user lookup', opts, async () => {
  const source = sampleSource();
  await store.saveSource(source, []);
  const analysis: AnalysisResult = {
    id: createId('analysis'), user_id: USER, organization_id: ORG, created_at: new Date().toISOString(),
    source_ids: [source.id], raw_source_references: [], normalized_observations: [], derived_interpretations: [],
    dashboard_spec: {
      id: createId('dash'), user_id: USER, organization_id: ORG, analysis_id: 'x', generated_at: new Date().toISOString(),
      cards: [], provenance: { source_ids: [source.id], storage_mode: 'durable', clinical_boundary: 'test' },
    },
  };
  await store.saveAnalysis(analysis);
  const fetched = await store.getAnalysis(analysis.id);
  assert.equal(fetched?.id, analysis.id);
  const forUser = await store.getAnalysesForUser([], USER, new Set([ORG]));
  assert.ok(forUser.some(a => a.id === analysis.id));
});

test('idempotency records round-trip', opts, async () => {
  const record = { key: createId('idem'), method: 'POST', route: '/imports', subject: USER, status: 201, body: { ok: true }, created_at: new Date().toISOString() };
  await store.saveIdempotencyRecord(record);
  const fetched = await store.getIdempotencyRecord(record.key, 'POST', '/imports', USER);
  assert.equal(fetched?.status, 201);
  assert.deepEqual(fetched?.body, { ok: true });
});

test('transaction rollback removes database writes and uploaded payloads', opts, async () => {
  const source = sampleSource();
  await assert.rejects(store.withTransaction(async () => {
    await store.saveSource(source, [sampleObservation(source.id)], Buffer.from('rollback me'));
    throw new Error('force rollback');
  }), /force rollback/);
  assert.equal(await store.getSource(source.id), undefined);
  assert.equal(await store.getSourcePayload(source.id), undefined);
});

test('transaction isolation keys serialize the same paid request', opts, async () => {
  let active = 0;
  let maximumActive = 0;
  const work = () => store.withTransaction(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, 25));
    active -= 1;
  }, 'same-x402-payment');
  await Promise.all([work(), work()]);
  assert.equal(maximumActive, 1);
});

test('genetic job claim is exclusive under concurrency', opts, async () => {
  const source = sampleSource({ category: 'genetics' });
  await store.saveSource(source, []);
  const analysis: AnalysisResult = {
    id: createId('analysis'), user_id: USER, organization_id: ORG, created_at: new Date().toISOString(),
    source_ids: [source.id], raw_source_references: [], normalized_observations: [], derived_interpretations: [],
    dashboard_spec: { id: createId('dash'), user_id: USER, organization_id: ORG, analysis_id: 'x', generated_at: new Date().toISOString(), cards: [], provenance: { source_ids: [], storage_mode: 'durable', clinical_boundary: 'test' } },
  };
  await store.saveAnalysis(analysis);
  const job: GeneticAnalysisJob = {
    id: createId('gjob'), user_id: USER, organization_id: ORG, analysis_id: analysis.id, source_id: source.id,
    status: 'queued', attempts: 0, max_attempts: 3, priority: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  await store.createGeneticAnalysisJob(job);

  const [a, b] = await Promise.all([
    store.claimNextGeneticAnalysisJob('worker-a'),
    store.claimNextGeneticAnalysisJob('worker-b'),
  ]);
  const claimed = [a, b].filter(Boolean);
  assert.equal(claimed.length, 1, 'exactly one worker should claim the job');
  assert.equal(claimed[0]?.status, 'running');
  assert.equal(claimed[0]?.attempts, 1);

  await store.completeGeneticAnalysisJob(job.id, { done: true });
  const done = await store.getGeneticAnalysisJob(job.id);
  assert.equal(done?.status, 'complete');
});

test('failed genetic job requeues until attempts are exhausted', opts, async () => {
  const source = sampleSource({ category: 'genetics' });
  await store.saveSource(source, []);
  const analysis: AnalysisResult = {
    id: createId('analysis'), user_id: USER, organization_id: ORG, created_at: new Date().toISOString(),
    source_ids: [source.id], raw_source_references: [], normalized_observations: [], derived_interpretations: [],
    dashboard_spec: { id: createId('dash'), user_id: USER, organization_id: ORG, analysis_id: 'x', generated_at: new Date().toISOString(), cards: [], provenance: { source_ids: [], storage_mode: 'durable', clinical_boundary: 'test' } },
  };
  await store.saveAnalysis(analysis);
  const job: GeneticAnalysisJob = {
    id: createId('gjob'), user_id: USER, organization_id: ORG, analysis_id: analysis.id, source_id: source.id,
    status: 'queued', attempts: 0, max_attempts: 2, priority: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  await store.createGeneticAnalysisJob(job);

  const first = await store.claimNextGeneticAnalysisJob('w'); // attempts -> 1
  await store.failGeneticAnalysisJob(first!.id, 'boom');
  assert.equal((await store.getGeneticAnalysisJob(job.id))?.status, 'queued');
  assert.equal((await store.getGeneticAnalysisJob(job.id))?.error, 'boom');

  const second = await store.claimNextGeneticAnalysisJob('w'); // attempts -> 2
  assert.equal(second?.status, 'running');
  assert.equal(second?.error, undefined, 'a running retry must not expose the previous attempt error');
  await store.failGeneticAnalysisJob(second!.id, 'boom again');
  assert.equal((await store.getGeneticAnalysisJob(job.id))?.status, 'failed');
});

test('external account upsert merges metadata and provider tokens save/lookup', opts, async () => {
  const account: ExternalAccount = {
    id: createId('acct'), user_id: USER, organization_id: ORG, provider: 'whoop', external_user_id: 'whoop-123',
    status: 'active', metadata: { region: 'us' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const saved = await store.upsertExternalAccount(account);
  const resaved = await store.upsertExternalAccount({ ...account, id: createId('acct'), metadata: { plan: 'pro' } });
  assert.equal(resaved.id, saved.id, 'upsert keeps the original id');
  assert.deepEqual(resaved.metadata, { region: 'us', plan: 'pro' }, 'metadata shallow-merges');

  const token: ProviderToken = {
    id: createId('tok'), external_account_id: saved.id, user_id: USER, organization_id: ORG,
    provider: 'whoop', provider_external_user_id: 'whoop-123', access_token_encrypted: 'enc',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  await store.saveProviderToken(token);
  const fetched = await store.getProviderTokenByExternalUser('whoop', 'whoop-123');
  assert.equal(fetched?.access_token_encrypted, 'enc');
});

test('connector sync job claim + complete updates last_synced_at', opts, async () => {
  const account: ExternalAccount = {
    id: createId('acct'), user_id: USER, organization_id: ORG, provider: 'oura', external_user_id: 'oura-1',
    status: 'active', metadata: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const saved = await store.upsertExternalAccount(account);
  const job: ConnectorSyncJob = {
    id: createId('cjob'), user_id: USER, organization_id: ORG, provider: 'oura', external_account_id: saved.id,
    scheduled_for: new Date(Date.now() - 1000).toISOString(), status: 'queued', attempts: 0, max_attempts: 5, priority: 0,
    request: { source_provider: 'oura' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  await store.createConnectorSyncJob(job);
  const claimed = await store.claimNextConnectorSyncJob('w');
  assert.equal(claimed?.id, job.id);
  await store.completeConnectorSyncJob(job.id, { imported: 3 });
  const accounts = await store.listExternalAccountsForUser(USER, new Set([ORG]));
  assert.ok(accounts.find(a => a.id === saved.id)?.last_synced_at);
});

test('goals CRUD and export/tombstone', opts, async () => {
  const goal: Goal = {
    id: createId('goal'), user_id: USER, organization_id: ORG, title: 'Lower LDL', metric: 'ldl',
    target_value: 80, target_unit: 'mg/dL', target_direction: 'decrease', status: 'active',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  await store.createGoal(goal);
  const updated = await store.updateGoal(goal.id, { status: 'achieved' });
  assert.equal(updated?.status, 'achieved');
  const listed = await store.listGoals(USER, new Set([ORG]));
  assert.ok(listed.some(g => g.id === goal.id));

  const exported = await store.exportUserData(USER, ORG);
  assert.ok(exported.counts.goals >= 1);
  assert.equal(exported.user_id, USER);

  assert.equal(await store.deleteGoal(goal.id), true);
  assert.equal(await store.getGoal(goal.id), undefined);
});

test('otp challenges are single-use and expiry-aware', opts, async () => {
  const email = 'otp@example.com';
  const now = new Date();
  await store.createOtpChallenge({ id: createId('otp'), email, code_hash: 'hash-a', expires_at: new Date(now.getTime() + 60_000).toISOString(), created_at: now.toISOString() });
  // Wrong hash does not consume.
  assert.equal(await store.consumeOtpChallenge(email, 'wrong'), false);
  // Correct hash consumes once.
  assert.equal(await store.consumeOtpChallenge(email, 'hash-a'), true);
  assert.equal(await store.consumeOtpChallenge(email, 'hash-a'), false);
  // Expired challenge is not accepted.
  await store.createOtpChallenge({ id: createId('otp'), email, code_hash: 'hash-b', expires_at: new Date(now.getTime() - 1000).toISOString(), created_at: now.toISOString() });
  assert.equal(await store.consumeOtpChallenge(email, 'hash-b'), false);
});

test('readiness reports durable and ok', opts, async () => {
  const readiness = await store.readiness();
  assert.equal(readiness.durable, true);
  assert.equal(readiness.ok, true);
  assert.equal(readiness.checks.store, 'postgres');
});

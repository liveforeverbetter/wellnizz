import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGeneticsPipelineArgs, geneticsPipelineTimeoutMs } from '../src/core/genetics-runner.js';
import { createId, HealthApiStore } from '../src/store.js';
import type { GeneticAnalysisJob } from '../src/types.js';

test('full-dbSNP worker uses the bundled CLI dbsnp flag', () => {
  const args = buildGeneticsPipelineArgs(
    'user_1',
    '/tmp/upload.vcf.gz',
    '/tmp/output',
    { HEALTH_ANALYSIS_DBSNP_GRCH37_PATH: '/data/reference/dbsnp.grch37.vcf.gz' },
    { annotation_depth: 'full_dbsnp' },
  );

  assert.ok(args.includes('--dbsnp=/data/reference/dbsnp.grch37.vcf.gz'));
  assert.ok(!args.some(arg => arg.startsWith('--annotation-depth=')));
  assert.ok(!args.some(arg => arg.startsWith('--dbsnp-path=')));
});

test('compact worker does not pass a full-dbSNP reference', () => {
  const args = buildGeneticsPipelineArgs(
    'user_1',
    '/tmp/upload.vcf.gz',
    '/tmp/output',
    { HEALTH_ANALYSIS_DBSNP_GRCH37_PATH: '/data/reference/dbsnp.grch37.vcf.gz' },
    { annotation_depth: 'compact' },
  );

  assert.ok(!args.some(arg => arg.startsWith('--dbsnp=')));
});

test('full-dbSNP jobs use a dedicated long timeout', () => {
  assert.equal(
    geneticsPipelineTimeoutMs(
      { HEALTH_ANALYSIS_TIMEOUT_MS: '1800000' },
      { annotation_depth: 'full_dbsnp' },
    ),
    14_400_000,
  );
  assert.equal(
    geneticsPipelineTimeoutMs(
      { HEALTH_ANALYSIS_FULL_DBSNP_TIMEOUT_MS: '21600000' },
      { annotation_depth: 'full_dbsnp' },
    ),
    21_600_000,
  );
});

test('compact jobs retain the standard timeout', () => {
  assert.equal(
    geneticsPipelineTimeoutMs(
      { HEALTH_ANALYSIS_TIMEOUT_MS: '1800000' },
      { annotation_depth: 'compact' },
    ),
    1_800_000,
  );
});

test('claiming a genetic retry clears the previous attempt error', async () => {
  const store = new HealthApiStore();
  const now = new Date().toISOString();
  const job: GeneticAnalysisJob = {
    id: createId('wgsjob'),
    user_id: 'user_1',
    organization_id: 'org_1',
    analysis_id: createId('analysis'),
    source_id: createId('src'),
    annotation_depth: 'full_dbsnp',
    status: 'queued',
    attempts: 0,
    max_attempts: 2,
    priority: 0,
    created_at: now,
    updated_at: now,
  };
  await store.createGeneticAnalysisJob(job);

  const first = await store.claimNextGeneticAnalysisJob('worker-1');
  assert.ok(first);
  await store.failGeneticAnalysisJob(job.id, 'first attempt failed');
  assert.equal((await store.getGeneticAnalysisJob(job.id))?.status, 'queued');
  assert.equal((await store.getGeneticAnalysisJob(job.id))?.error, 'first attempt failed');

  const retry = await store.claimNextGeneticAnalysisJob('worker-2');
  assert.equal(retry?.status, 'running');
  assert.equal(retry?.attempts, 2);
  assert.equal(retry?.error, undefined);
});

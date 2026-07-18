import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendCommandOutputTail, buildGeneticsPipelineArgs, compactGeneticsDashboardForPersistence, geneticsPipelineTimeoutMs } from '../src/core/genetics-runner.js';
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

test('worker command capture retains only a bounded diagnostic tail', () => {
  let captured = '';
  for (let index = 0; index < 10_000; index++) {
    captured = appendCommandOutputTail(captured, `progress ${index.toString().padStart(5, '0')} ${'x'.repeat(80)}\n`, 4096);
  }
  assert.ok(Buffer.byteLength(captured) <= 4096);
  assert.doesNotMatch(captured, /progress 00000/);
  assert.match(captured, /progress 09999/);
});

test('WGS persistence keeps actionable results and bounds exploratory collections', () => {
  const uncommonMutations = Array.from({ length: 1000 }, (_, index) => ({ rsid: `rs${index}`, note: 'exploratory' }));
  const hereditaryFindings = Array.from({ length: 40 }, (_, index) => ({ id: `condition-${index}` }));
  const dashboard = {
    gli: 459,
    traits: [{ trait_id: 'drug_metabolism', score: 25 }],
    insights: [{ title: 'Drug metabolism' }],
    protocols: [{ title: 'Medication review' }],
    metadata: {
      variant_cards: {
        genetic_conditions: [{ rsid: 'rs-clinical' }],
        drug_response: [{ rsid: 'rs-drug' }],
        other_risks: [{ rsid: 'rs-risk' }],
        uncommon_mutations: uncommonMutations,
      },
      prs_scores: [{ disease: 'heart_disease', percentile: 80 }],
      condition_catalog_findings: {
        total_findings: hereditaryFindings.length,
        modalities: { hereditary: hereditaryFindings },
      },
    },
  };

  const compact = compactGeneticsDashboardForPersistence(dashboard) as typeof dashboard & {
    metadata: typeof dashboard.metadata & {
      persistence_compaction: {
        omitted: {
          uncommon_mutations: number;
          condition_catalog_findings: Record<string, number>;
        };
      };
    };
  };

  assert.deepEqual(compact.traits, dashboard.traits);
  assert.deepEqual(compact.insights, dashboard.insights);
  assert.deepEqual(compact.protocols, dashboard.protocols);
  assert.deepEqual(compact.metadata.variant_cards.genetic_conditions, [{ rsid: 'rs-clinical' }]);
  assert.deepEqual(compact.metadata.variant_cards.drug_response, [{ rsid: 'rs-drug' }]);
  assert.deepEqual(compact.metadata.variant_cards.other_risks, [{ rsid: 'rs-risk' }]);
  assert.equal(compact.metadata.variant_cards.uncommon_mutations.length, 0);
  assert.equal(compact.metadata.condition_catalog_findings.modalities.hereditary.length, 25);
  assert.equal(compact.metadata.persistence_compaction.omitted.uncommon_mutations, 1000);
  assert.equal(compact.metadata.persistence_compaction.omitted.condition_catalog_findings.hereditary, 15);
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

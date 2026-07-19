import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { appendCommandOutputTail, buildGeneticsPipelineArgs, compactGeneticsDashboardForPersistence, geneticsPipelineTimeoutMs } from '../src/core/genetics-runner.js';
import { createId, HealthApiStore } from '../src/store.js';
import type { AnalysisResult, GeneticAnalysisJob } from '../src/types.js';

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

test('compaction records the full-analysis artifact reference when provided', () => {
  const dashboard = { gli: 100, metadata: { variant_cards: { uncommon_mutations: [{ rsid: 'rs1' }] } } };
  const withRef = compactGeneticsDashboardForPersistence(dashboard, {
    object_key: 'analyses/an_1/full-analysis.json',
    bytes: 31_800_000,
    storage: 's3',
  }) as { metadata: { persistence_compaction: { full_artifact: { object_key: string; bytes: number; storage: string } | null; version: number } } };
  assert.equal(withRef.metadata.persistence_compaction.version, 2);
  assert.deepEqual(withRef.metadata.persistence_compaction.full_artifact, {
    object_key: 'analyses/an_1/full-analysis.json',
    bytes: 31_800_000,
    storage: 's3',
  });

  // Without a ref (e.g. object storage not configured), the field is explicit null.
  const withoutRef = compactGeneticsDashboardForPersistence(dashboard) as { metadata: { persistence_compaction: { full_artifact: unknown } } };
  assert.equal(withoutRef.metadata.persistence_compaction.full_artifact, null);
});

test('the store round-trips a full-analysis artifact without buffering on read', async () => {
  const store = new HealthApiStore();
  const body = Buffer.from(JSON.stringify({ complete: true, uncommon_mutations: Array.from({ length: 5000 }, (_, i) => i) }));
  const ref = await store.saveAnalysisArtifact('an_42', body);
  assert.equal(ref.object_key, 'analyses/an_42/full-analysis.json');
  assert.equal(ref.bytes, body.byteLength);
  assert.equal(await store.getAnalysisArtifactSize('an_42'), body.byteLength);

  const dest = path.join(os.tmpdir(), `fb-artifact-${Date.now()}.json`);
  const wrote = await store.writeAnalysisArtifactToFile('an_42', dest);
  assert.equal(wrote, true);
  assert.deepEqual(JSON.parse(await readFile(dest, 'utf8')), JSON.parse(body.toString('utf8')));
  await rm(dest, { force: true });

  assert.equal(await store.writeAnalysisArtifactToFile('missing', dest), false);
  assert.equal(await store.getAnalysisArtifactSize('missing'), undefined);
});

test('tombstoning a user deletes their full-analysis genomic artifacts', async () => {
  const store = new HealthApiStore();
  const analysis: AnalysisResult = {
    id: createId('analysis'), user_id: 'user_1', organization_id: 'org_1', created_at: new Date().toISOString(),
    source_ids: [], raw_source_references: [], normalized_observations: [], derived_interpretations: [],
    dashboard_spec: {
      id: createId('dash'), user_id: 'user_1', organization_id: 'org_1', analysis_id: 'x', generated_at: new Date().toISOString(),
      cards: [], provenance: { source_ids: [], storage_mode: 'durable', clinical_boundary: 'test' },
    },
  };
  await store.saveAnalysis(analysis);
  await store.saveAnalysisArtifact(analysis.id, Buffer.from('{"complete":true}'));
  assert.ok(await store.getAnalysisArtifactSize(analysis.id));

  await store.tombstoneUserData('user_1', 'org_1');
  assert.equal(await store.getAnalysisArtifactSize(analysis.id), undefined);
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

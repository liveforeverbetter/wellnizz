import assert from 'node:assert/strict';
import test from 'node:test';
import { queryHealthContext } from '../src/core/analysis.js';
import { upsertGeneticPipelineInterpretation } from '../src/core/genetic-analysis.js';
import { normalizeGeneticsDashboard } from '../src/core/genetic-insights.js';
import type { AnalysisResult, RawSourceReference } from '../src/types.js';

function analysisFixture(): AnalysisResult {
  return {
    id: 'analysis_1',
    user_id: 'user_1',
    organization_id: 'org_1',
    modality: 'genetics',
    operation: 'analyze',
    created_at: '2026-07-19T12:00:00Z',
    source_ids: ['source_1'],
    raw_source_references: [],
    normalized_observations: [],
    derived_interpretations: [],
    dashboard_spec: {
      id: 'dashboard_1', user_id: 'user_1', organization_id: 'org_1', analysis_id: 'analysis_1', generated_at: '2026-07-19T12:00:00Z', cards: [],
      provenance: { source_ids: ['source_1'], storage_mode: 'durable', clinical_boundary: 'test' },
    },
  };
}

const source: RawSourceReference = {
  id: 'source_1', user_id: 'user_1', organization_id: 'org_1', category: 'genetics', filename: 'genome.vcf.gz',
  received_at: '2026-07-19T11:00:00Z', byte_length: 100, storage_mode: 'durable', upload_status: 'complete',
};

test('completed analyses expose compact caffeine and performance findings to /query semantics', () => {
  const dashboard = {
    metadata: {
      prs_scores: [],
      curated_interpretations: [{ rsid: 'rs762551', gene: 'CYP1A2', interpretation: 'Observed inducibility-associated genotype.' }],
      variant_cards: {},
    },
  };
  normalizeGeneticsDashboard(dashboard, new Date('2026-07-19T12:00:00Z'));
  const analysis = analysisFixture();
  upsertGeneticPipelineInterpretation(analysis, source, {
    status: 'complete', summary: 'complete', dashboard, raw: { prs_count: 0 },
  });

  const consumer = analysis.derived_interpretations.find(item => item.type === 'genetic_consumer_insight');
  assert.ok(consumer);
  assert.equal(consumer.title, 'Caffeine clearance and sensitivity');
  assert.equal(consumer.status, 'informational');

  const query = queryHealthContext([], [analysis], 'caffeine half life');
  assert.equal(query.matches.length, 1);
  assert.ok('title' in query.matches[0]);
  assert.equal(query.matches[0].title, 'Caffeine clearance and sensitivity');
});

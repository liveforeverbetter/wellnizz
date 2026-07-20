import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGeneticSliceIndex, queryGeneticSlice } from '../src/core/genetic-slice.js';

test('builds gene and rsID index from variant cards and curated interpretations', () => {
  const dashboard = {
    metadata: {
      variant_cards: {
        clinical: [
          { rsid: 'rs334', gene: 'HBB', significance: 'pathogenic', interpretation: 'Sickle cell variant' },
          { rsid: 'rs113488022', gene: 'BRAF', significance: 'likely_pathogenic', interpretation: 'Kinase mutation' },
        ],
        performance: [
          { rsid: 'rs1815739', gene: 'ACTN3', interpretation: 'Power/endurance context' },
        ],
      },
      curated_interpretations: [
        { rsid: 'rs762551', gene: 'CYP1A2', interpretation: 'Caffeine inducibility' },
        { rsid: 'rs8192678', gene: 'PPARGC1A', interpretation: 'Aerobic trainability' },
      ],
    },
  };

  const index = buildGeneticSliceIndex(dashboard);
  assert.ok(index);
  assert.equal(index.schema_version, '1.0');
  assert.ok(index.generated_at);

  const hbb = index.gene_index['HBB'];
  assert.ok(hbb);
  assert.equal(hbb.length, 1);
  assert.equal(hbb[0].rsids[0], 'rs334');
  assert.equal(hbb[0].finding_category, 'variant_card');
  assert.equal(hbb[0].significance, 'pathogenic');

  const cypGenes = index.gene_index['CYP1A2'];
  assert.ok(cypGenes);
  assert.equal(cypGenes.length, 1);
  assert.equal(cypGenes[0].finding_category, 'curated_interpretation');

  const rs334 = index.rsid_index['rs334'];
  assert.ok(rs334);
  assert.equal(rs334[0].genes[0], 'HBB');

  const rs762551 = index.rsid_index['rs762551'];
  assert.ok(rs762551);
  assert.equal(rs762551[0].genes[0], 'CYP1A2');

  assert.equal(Object.keys(index.gene_index).length, 5);
  assert.equal(Object.keys(index.rsid_index).length, 5);
});

test('queryByGene returns matching entries and consumer insights', () => {
  const dashboard = {
    metadata: {
      variant_cards: {
        clinical: [
          { rsid: 'rs334', gene: 'HBB', significance: 'pathogenic', interpretation: 'Sickle cell variant' },
        ],
      },
      curated_interpretations: [
        { rsid: 'rs762551', gene: 'CYP1A2', interpretation: 'Caffeine inducibility' },
      ],
    },
  };

  const index = buildGeneticSliceIndex(dashboard);
  assert.ok(index);

  const result = queryGeneticSlice(index, [
    { id: 'marker:caffeine_clearance', trait_id: 'caffeine_clearance', display_name: 'Caffeine clearance and sensitivity', category: 'performance', calculation_state: 'not_applicable', result_summary: 'Relevant genotype observed.', consumer_value: 'Helps personalize caffeine.', genes: ['CYP1A2'], rsids: ['rs762551'] },
  ], { gene: 'CYP1A2' });

  assert.equal(result.matched_genes.length, 1);
  assert.equal(result.matched_genes[0].gene, 'CYP1A2');
  assert.equal(result.consumer_insights.length, 1);
  assert.equal(result.consumer_insights[0].display_name, 'Caffeine clearance and sensitivity');
});

test('queryByRsid returns matching entries', () => {
  const dashboard = {
    metadata: {
      variant_cards: {
        clinical: [
          { rsid: 'rs334', gene: 'HBB', interpretation: 'Sickle cell variant' },
        ],
      },
    },
  };

  const index = buildGeneticSliceIndex(dashboard);
  assert.ok(index);

  const result = queryGeneticSlice(index, [], { rsid: 'rs334' });
  assert.equal(result.matched_rsids.length, 1);
  assert.equal(result.matched_rsids[0].rsid, 'rs334');
  assert.equal(result.matched_rsids[0].genes[0], 'HBB');
});

test('queryBySignificance filters entries by clinical significance', () => {
  const dashboard = {
    metadata: {
      variant_cards: {
        clinical: [
          { rsid: 'rs334', gene: 'HBB', significance: 'pathogenic', interpretation: 'Sickle cell' },
          { rsid: 'rs113488022', gene: 'BRAF', significance: 'likely_pathogenic', interpretation: 'Kinase' },
          { rsid: 'rs123', gene: 'ABCA1', interpretation: 'Common variant' },
        ],
      },
    },
  };

  const index = buildGeneticSliceIndex(dashboard);
  assert.ok(index);

  const result = queryGeneticSlice(index, [], { significance: 'pathogenic' });
  assert.equal(result.matched_genes.length, 2);
  assert.deepEqual(result.matched_genes.map(e => e.gene).sort(), ['BRAF', 'HBB']);

  const noMatches = queryGeneticSlice(index, [], { significance: 'benign' });
  assert.equal(noMatches.matched_genes.length, 0);
  assert.equal(noMatches.matched_rsids.length, 0);
});

test('query without index returns note', () => {
  const result = queryGeneticSlice(undefined, [], { gene: 'BRCA1' });
  assert.equal(result.matched_genes.length, 0);
  assert.equal(result.matched_rsids.length, 0);
  assert.equal(result.consumer_insights.length, 0);
  assert.ok(result.note);
  assert.match(result.note!, /created before this feature/i);
});

test('query with empty index returns note', () => {
  const result = queryGeneticSlice({
    schema_version: '1.0',
    generated_at: '2026-07-19T00:00:00Z',
    gene_index: {},
    rsid_index: {},
  }, [], { gene: 'BRCA1' });
  assert.equal(result.matched_genes.length, 0);
  assert.ok(result.note);
  assert.match(result.note!, /produced no gene-level/i);
});

test('build from empty dashboard returns undefined', () => {
  assert.equal(buildGeneticSliceIndex({ metadata: {} }), undefined);
  assert.equal(buildGeneticSliceIndex({}), undefined);
  assert.equal(buildGeneticSliceIndex(null), undefined);
});

test('builds index from consumer genetics insights', () => {
  const dashboard = {
    metadata: {
      variant_cards: {},
      consumer_genetics: {
        insights: [
          { id: 'pgs:sleep_duration', trait_id: 'sleep_duration', display_name: 'Sleep duration', category: 'sleep_recovery', calculation_state: 'raw_score_only', result_summary: 'Raw model score available.', consumer_value: 'Helps compare.', genes: ['CLOCK'] },
        ],
      },
    },
  };

  const index = buildGeneticSliceIndex(dashboard);
  assert.ok(index);
  assert.ok(index.gene_index['CLOCK']);
});

test('query returns empty when gene not in index', () => {
  const index = buildGeneticSliceIndex({
    metadata: {
      variant_cards: {
        clinical: [{ rsid: 'rs334', gene: 'HBB', interpretation: 'Sickle cell' }],
      },
    },
  });
  assert.ok(index);

  const result = queryGeneticSlice(index, [], { gene: 'BRCA1' });
  assert.equal(result.matched_genes.length, 0);
  assert.equal(result.matched_rsids.length, 0);
  assert.equal(result.consumer_insights.length, 0);
});

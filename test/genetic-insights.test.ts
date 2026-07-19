import assert from 'node:assert/strict';
import test from 'node:test';
import { GENETIC_INTERPRETATION_RELEASE, normalizeGeneticsDashboard } from '../src/core/genetic-insights.js';

test('withholds legacy percentiles without explicit calibration provenance', () => {
  const dashboard = {
    metadata: {
      prs_scores: [{
        disease: 'caffeine_metabolism',
        score: 0.123,
        riskLabel: 'Fast',
        percentile: 92,
        variantsScored: 90,
        totalWeightedVariants: 100,
        coveragePct: 90,
        sourceId: 'PGS000001',
        sourceName: 'Example score',
      }],
    },
  };

  const section = normalizeGeneticsDashboard(dashboard, new Date('2026-07-19T12:00:00Z'));
  const score = dashboard.metadata.prs_scores[0] as Record<string, unknown>;
  assert.equal(score.percentile, null);
  assert.equal(score.riskLabel, 'Raw score only');
  assert.equal(score.calculationState, 'raw_score_only');
  assert.equal(section.insights[0].percentile, undefined);
  assert.equal(section.insights[0].calculation_state, 'raw_score_only');
  assert.equal(section.interpretation_release, GENETIC_INTERPRETATION_RELEASE);
  assert.equal(section.summary.reanalysis_recommended, true);
});

test('preserves a reference-relative percentile only with a named reference panel and method', () => {
  const dashboard = {
    metadata: {
      prs_scores: [{
        disease: 'coronary_artery_disease',
        score: 1.25,
        riskLabel: 'Elevated',
        percentile: 91,
        variantsScored: 950,
        totalWeightedVariants: 1000,
        coveragePct: 95,
        calibration: {
          state: 'reference_relative',
          method: 'pgsc_calc Z_MostSimilarPop',
          reference_panel: 'HGDP+1kGP',
          reference_release: 'v1',
        },
      }],
    },
  };

  const section = normalizeGeneticsDashboard(dashboard);
  assert.equal(dashboard.metadata.prs_scores[0].percentile, 91);
  assert.equal(section.insights[0].calculation_state, 'reference_relative');
  assert.equal(section.insights[0].percentile, 91);
  assert.equal(section.insights[0].calibration?.reference_panel, 'HGDP+1kGP');
});

test('marks low-coverage scores uninterpretable even if the legacy payload has a percentile', () => {
  const dashboard = {
    metadata: {
      prs_scores: [{
        disease: 'pulmonary_function',
        score: -0.4,
        riskLabel: 'Lower',
        percentile: 18,
        variantsScored: 30,
        totalWeightedVariants: 100,
        coveragePct: 30,
        calibration: {
          state: 'reference_relative',
          method: 'empirical',
          reference_panel: 'HGDP+1kGP',
        },
      }],
    },
  };

  const section = normalizeGeneticsDashboard(dashboard);
  assert.equal(dashboard.metadata.prs_scores[0].percentile, null);
  assert.equal(section.insights[0].calculation_state, 'insufficient_coverage');
  assert.equal(section.insights[0].percentile, undefined);
});

test('creates compact optimization spotlights from direct marker evidence', () => {
  const dashboard = {
    metadata: {
      prs_scores: [],
      curated_interpretations: [{
        rsid: 'rs1815739',
        gene: 'ACTN3',
        interpretation: 'Observed ACTN3 genotype with a reported muscle-fiber association.',
      }, {
        rsid: 'rs762551',
        gene: 'CYP1A2',
        interpretation: 'Observed CYP1A2 inducibility-associated genotype.',
      }],
      variant_cards: {},
    },
  };

  const section = normalizeGeneticsDashboard(dashboard);
  assert.ok(section.insights.some(item => item.trait_id === 'power_endurance_tendency'));
  assert.ok(section.insights.some(item => item.trait_id === 'caffeine_clearance'));
  assert.ok(section.insights
    .filter(item => ['power_endurance_tendency', 'caffeine_clearance'].includes(item.trait_id))
    .every(item => item.calculation_state === 'not_applicable' && item.reanalysis_recommended === false));
  assert.ok(section.requested_but_unavailable.some(item => item.trait_id === 'pulmonary_function'));
  assert.equal(section.summary.performance_and_optimization, 2);
  assert.equal(section.summary.raw_score_only, 0);
});

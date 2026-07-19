import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { buildPgsCalibrationRegistry } from '../src/core/pgs-calibration-builder.js';
import {
  calibratePgsScore,
  empiricalPercentile,
  PGS_SCORE_ALGORITHM,
  type PgsCalibrationRegistry,
  type PgsPopulationSimilarity,
  type PgsSuperPopulation,
} from '../src/core/pgs-calibration.js';
import { scoreWeightRows, type BundledPgsManifestEntry, type PgsWeightRow, type PositionGenotype } from '../src/core/pgs-position-scorer.js';

const populations: PgsSuperPopulation[] = ['AFR', 'AMR', 'EAS', 'EUR', 'SAS'];
const similarity: PgsPopulationSimilarity = {
  most_similar_population: 'EUR',
  low_confidence: false,
  method: 'pgsc_calc_random_forest',
  reference_panel: 'PGSC_HGDP+1kGP_v1',
  reference_release: 'v1',
};

test('empirical percentile uses a mid-rank for ties', () => {
  assert.equal(empiricalPercentile(2, [1, 2, 2, 4]), 50);
  assert.equal(empiricalPercentile(0, [1, 2, 3, 4]), 0);
  assert.equal(empiricalPercentile(5, [1, 2, 3, 4]), 100);
});

test('calibration requires matching model, build, population release, coverage, and confidence', () => {
  const registry = fixtureRegistry('model-sha', 1);
  const calibrated = calibratePgsScore({
    pgs_id: 'PGS_TEST', raw_score: 80, scoring_file_sha256: 'model-sha', genome_build: 'GRCh37',
    weighted_variant_count: 1, coverage_pct: 100, direction_interpretation: 'higher_trait_value', registry, similarity,
  });
  assert.equal(calibrated.calibrated, true);
  if (calibrated.calibrated) {
    assert.equal(calibrated.result.percentile, 80.5);
    assert.equal(calibrated.result.population, 'EUR');
    assert.equal(calibrated.result.population_sample_size, 100);
    assert.equal(calibrated.result.direction_interpretation, 'higher_trait_value');
  }

  const lowConfidence = calibratePgsScore({
    pgs_id: 'PGS_TEST', raw_score: 80, scoring_file_sha256: 'model-sha', genome_build: 'GRCh37',
    weighted_variant_count: 1, coverage_pct: 100, direction_interpretation: 'withheld', registry,
    similarity: { ...similarity, low_confidence: true },
  });
  assert.equal(lowConfidence.calibrated, false);
  if (!lowConfidence.calibrated) assert.match(lowConfidence.reason, /low confidence/i);

  const checksumMismatch = calibratePgsScore({
    pgs_id: 'PGS_TEST', raw_score: 80, scoring_file_sha256: 'different', genome_build: 'GRCh37',
    weighted_variant_count: 1, coverage_pct: 100, direction_interpretation: 'withheld', registry, similarity,
  });
  assert.equal(checksumMismatch.calibrated, false);
  if (!checksumMismatch.calibrated) assert.match(checksumMismatch.reason, /checksum/i);
});

test('position scorer emits a reference-relative percentile but keeps unknown trait direction withheld', () => {
  const definition: BundledPgsManifestEntry = {
    pgs_id: 'PGS_TEST', trait_id: 'pulmonary_function', display_name: 'Pulmonary function', consumer_category: 'performance',
    genome_build: 'GRCh37', scoring_file: 'test.txt', sha256: 'model-sha', variants: 1, weight_type: 'NR',
    source_url: 'https://example.test', calibration_state: 'raw_score_only', direction_interpretation: 'withheld', limitations: [],
  };
  const rows: PgsWeightRow[] = [{ chrom: '1', pos: 100, effectAllele: 'G', otherAllele: 'A', effectWeight: 40 }];
  const observed = new Map<string, PositionGenotype>([
    ['1:100', { chrom: '1', pos: 100, ref: 'A', alts: ['G'], gt: '1/1' }],
  ]);
  const result = scoreWeightRows(definition, 'registry-release', rows, observed, new Map(), fixtureRegistry('model-sha', 1), similarity);

  assert.equal(result.calculationState, 'reference_relative');
  assert.equal(result.percentile, 80.5);
  assert.equal(result.riskLabel, 'Higher model score');
  assert.match(result.description, /direction.*withheld/i);
  assert.equal(result.reanalysisRecommended, false);
});

test('research-only cognitive and social scores never expose direction or a calibrated percentile', () => {
  const definition: BundledPgsManifestEntry = {
    pgs_id: 'PGS_TEST', trait_id: 'fluid_intelligence_score', display_name: 'Fluid-reasoning research score',
    consumer_category: 'research_only', reporting_policy: 'research_only_non_directional',
    genome_build: 'GRCh37', scoring_file: 'test.txt', sha256: 'model-sha', variants: 1, weight_type: 'beta',
    source_url: 'https://example.test', calibration_state: 'raw_score_only', direction_interpretation: 'higher_trait_value', limitations: [],
  };
  const rows: PgsWeightRow[] = [{ chrom: '1', pos: 100, effectAllele: 'G', otherAllele: 'A', effectWeight: 40 }];
  const observed = new Map<string, PositionGenotype>([
    ['1:100', { chrom: '1', pos: 100, ref: 'A', alts: ['G'], gt: '1/1' }],
  ]);

  const result = scoreWeightRows(definition, 'registry-release', rows, observed, new Map(), fixtureRegistry('model-sha', 1), similarity);

  assert.equal(result.calculationState, 'research_only');
  assert.equal(result.reportingPolicy, 'research_only_non_directional');
  assert.equal(result.percentile, null);
  assert.equal(result.calibration, null);
  assert.equal(result.riskLabel, 'Research context only');
  assert.equal(result.reanalysisRecommended, false);
  assert.equal(result.provenance[0]?.direction_interpretation, 'withheld');
});

test('reference registry builder strips sample identifiers and requires every super-population', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pgs-calibration-test-'));
  try {
    const manifestPath = path.join(tempDir, 'manifest.json');
    const rowsPath = path.join(tempDir, 'scores.tsv');
    await writeFile(manifestPath, JSON.stringify({ scores: [{ pgs_id: 'PGS_TEST', sha256: 'model-sha', genome_build: 'GRCh37', variants: 1 }] }));
    const headers = 'sample_id\tsuper_population\tpgs_id\tscore\tscore_algorithm\tgenome_build\tweighted_variant_count\tscoring_file_sha256';
    const rows = [headers];
    for (const population of populations) {
      for (let index = 0; index < 100; index++) {
        rows.push(`${population}_${index}\t${population}\tPGS_TEST\t${index}\t${PGS_SCORE_ALGORITHM}\tGRCh37\t1\tmodel-sha`);
      }
    }
    await writeFile(rowsPath, `${rows.join('\n')}\n`);
    const registry = await buildPgsCalibrationRegistry({
      scoreRowsPath: rowsPath,
      scoreManifestPath: manifestPath,
      release: 'test-release',
      generatedAt: '2026-07-19T00:00:00.000Z',
      referencePanel: {
        id: 'PGSC_HGDP+1kGP_v1', release: 'v1', source_url: 'https://example.test/reference', sha256: 'reference-sha', unrelated_samples: 500,
      },
      generator: { name: 'test-generator', version: '1.0.0' },
    });
    assert.equal(registry.scores[0]?.populations.AFR?.n, 100);
    assert.equal(registry.scores[0]?.populations.EUR?.mean, 49.5);
    assert.doesNotMatch(JSON.stringify(registry), /EUR_42/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('reference registry builder rejects cross-population duplicate samples and panel count drift', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pgs-calibration-integrity-test-'));
  try {
    const manifestPath = path.join(tempDir, 'manifest.json');
    const rowsPath = path.join(tempDir, 'scores.tsv');
    await writeFile(manifestPath, JSON.stringify({ scores: [{ pgs_id: 'PGS_TEST', sha256: 'model-sha', genome_build: 'GRCh37', variants: 1 }] }));
    const headers = 'sample_id\tsuper_population\tpgs_id\tscore\tscore_algorithm\tgenome_build\tweighted_variant_count\tscoring_file_sha256';
    const rows = [headers];
    for (const population of populations) {
      for (let index = 0; index < 100; index++) {
        const sampleId = population === 'AMR' && index === 0 ? 'AFR_0' : `${population}_${index}`;
        rows.push(`${sampleId}\t${population}\tPGS_TEST\t${index}\t${PGS_SCORE_ALGORITHM}\tGRCh37\t1\tmodel-sha`);
      }
    }
    await writeFile(rowsPath, `${rows.join('\n')}\n`);
    await assert.rejects(
      buildPgsCalibrationRegistry({
        scoreRowsPath: rowsPath,
        scoreManifestPath: manifestPath,
        release: 'test-release',
        referencePanel: {
          id: 'PGSC_HGDP+1kGP_v1', release: 'v1', source_url: 'https://example.test/reference', sha256: 'reference-sha', unrelated_samples: 500,
        },
        generator: { name: 'test-generator', version: '1.0.0' },
      }),
      /appears in both AFR and AMR/,
    );

    const uniqueRows = rows.map(row => row.replace(/^AFR_0\tAMR\t/, 'AMR_0\tAMR\t'));
    await writeFile(rowsPath, `${uniqueRows.join('\n')}\n`);
    await assert.rejects(
      buildPgsCalibrationRegistry({
        scoreRowsPath: rowsPath,
        scoreManifestPath: manifestPath,
        release: 'test-release',
        referencePanel: {
          id: 'PGSC_HGDP+1kGP_v1', release: 'v1', source_url: 'https://example.test/reference', sha256: 'reference-sha', unrelated_samples: 501,
        },
        generator: { name: 'test-generator', version: '1.0.0' },
      }),
      /has 500 reference samples.*501/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function fixtureRegistry(scoringSha: string, variants: number): PgsCalibrationRegistry {
  const scores = Array.from({ length: 100 }, (_, index) => index);
  const distribution = { n: 100, mean: 49.5, standard_deviation: 29.0114919759, scores };
  return {
    schema_version: '1.0', release: 'test-release', generated_at: '2026-07-19T00:00:00.000Z',
    reference_panel: { id: 'PGSC_HGDP+1kGP_v1', release: 'v1', source_url: 'https://example.test', sha256: 'reference-sha', unrelated_samples: 500 },
    generator: { name: 'test', version: '1.0.0' },
    scores: [{
      pgs_id: 'PGS_TEST', scoring_file_sha256: scoringSha, score_algorithm: PGS_SCORE_ALGORITHM,
      genome_build: 'GRCh37', weighted_variant_count: variants,
      populations: Object.fromEntries(populations.map(population => [population, distribution])),
    }],
  };
}

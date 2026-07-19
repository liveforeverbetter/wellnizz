import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import {
  detectGenomeBuildFromVcfHeader,
  grch37Contig,
  normalizeChrom,
  parsePgsScoringFile,
  scoreWeightRows,
  type BundledPgsManifestEntry,
  type PgsWeightRow,
  type PositionGenotype,
} from '../src/core/pgs-position-scorer.js';

const definition: BundledPgsManifestEntry = {
  pgs_id: 'PGS_TEST',
  trait_id: 'pulmonary_function',
  display_name: 'Pulmonary function test model',
  consumer_category: 'performance',
  genome_build: 'GRCh37',
  scoring_file: 'test.txt',
  sha256: 'unused',
  variants: 4,
  weight_type: 'NR',
  source_url: 'https://example.test/score',
  evaluation_ancestry: 'Diverse',
  calibration_state: 'raw_score_only',
  direction_interpretation: 'withheld',
  limitations: ['Test fixture.'],
};

test('position-aware scorer applies observed dosage and disclosed reference inference', () => {
  const rows: PgsWeightRow[] = [
    { chrom: '1', pos: 100, effectAllele: 'G', otherAllele: 'A', effectWeight: 0.5 },
    { chrom: '2', pos: 200, effectAllele: 'T', otherAllele: 'C', effectWeight: 1 },
    { chrom: '3', pos: 300, effectAllele: 'A', otherAllele: 'G', effectWeight: -0.25 },
    { chrom: '4', pos: 400, effectAllele: 'C', otherAllele: 'T', effectWeight: 0.75 },
  ];
  const observed = new Map<string, PositionGenotype>([
    ['1:100', { chrom: '1', pos: 100, ref: 'A', alts: ['G'], gt: '0/1' }],
    ['3:300', { chrom: '3', pos: 300, ref: 'G', alts: ['C'], gt: '0/1' }],
  ]);
  const references = new Map([
    ['2:200', 'T'],
    ['4:400', 'A'],
  ]);

  const result = scoreWeightRows(definition, 'test-release', rows, observed, references);

  assert.equal(result.score, 2.5);
  assert.equal(result.variantsScored, 2);
  assert.equal(result.coveragePct, 50);
  assert.equal(result.calculationState, 'insufficient_coverage');
  assert.equal(result.percentile, null);
  assert.deepEqual(result.matchingQc, {
    observed_variant_calls: 2,
    inferred_homozygous_reference: 1,
    rejected_allele_mismatch: 1,
    missing_or_uncallable: 1,
    reference_inference_policy: 'dbsnp_reference_plus_variant_only_wgs_assumption',
  });
});

test('raw PGS results remain non-directional even at complete coverage', () => {
  const rows: PgsWeightRow[] = [
    { chrom: '1', pos: 100, effectAllele: 'G', otherAllele: 'A', effectWeight: 0.5 },
  ];
  const observed = new Map<string, PositionGenotype>([
    ['1:100', { chrom: '1', pos: 100, ref: 'A', alts: ['G'], gt: '1|1' }],
  ]);

  const result = scoreWeightRows(definition, 'test-release', rows, observed, new Map());

  assert.equal(result.score, 1);
  assert.equal(result.coveragePct, 100);
  assert.equal(result.calculationState, 'raw_score_only');
  assert.equal(result.riskLabel, 'Raw score only');
  assert.equal(result.percentile, null);
});

test('chromosome normalization handles common VCF and RefSeq names', () => {
  assert.equal(normalizeChrom('chr1'), '1');
  assert.equal(normalizeChrom('NC_000022.10'), '22');
  assert.equal(normalizeChrom('23'), 'X');
  assert.equal(normalizeChrom('NC_012920.1'), 'MT');
  assert.equal(grch37Contig('5'), 'NC_000005.9');
  assert.equal(grch37Contig('7'), 'NC_000007.13');
  assert.equal(grch37Contig('X'), 'NC_000023.10');
});

test('position-aware scoring requires an explicit compatible genome build', () => {
  assert.equal(detectGenomeBuildFromVcfHeader('##reference=GRCh37\n##contig=<ID=1>'), 'GRCh37');
  assert.equal(detectGenomeBuildFromVcfHeader('##contig=<ID=NC_000001.10,length=249250621>'), 'GRCh37');
  assert.equal(detectGenomeBuildFromVcfHeader('##reference=GRCh38\n##contig=<ID=chr1>'), 'GRCh38');
  assert.equal(detectGenomeBuildFromVcfHeader('##fileformat=VCFv4.2\n##contig=<ID=chr1>'), 'unknown');
});

test('bundled pulmonary model is pinned and parses all 279 weights', async () => {
  const scorePath = path.resolve(process.cwd(), 'data/genetics/pgs/PGS000210_hmPOS_GRCh37.txt');
  const rows = await parsePgsScoringFile(scorePath);

  assert.equal(rows.length, 279);
  assert.ok(rows.every(row => row.chrom && row.pos > 0 && row.effectAllele && Number.isFinite(row.effectWeight)));
});

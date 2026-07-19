import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeVCF } from '../ingestion/parse-vcf.js';
import type { LongevityProtocol, MarkerProvenance } from '../ingestion/parse-vcf.js';
import { collectCuratedInterpretationEvidence } from './index.js';

interface InterpretationMarker {
  gene: string;
  chrom: string;
  pos: number;
  evidenceTier?: number;
  tag?: string;
  interpretations: Record<string, {
    interpretation: string;
    recommendations: string[];
  }>;
  provenance?: MarkerProvenance;
}

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function loadMarkers(file: 'wellness' | 'personality' | 'performance'): Record<string, InterpretationMarker> {
  return JSON.parse(fs.readFileSync(
    path.join(packageDir, 'shared/interpretations', `${file}.json`),
    'utf8',
  )).markers as Record<string, InterpretationMarker>;
}

const expected = {
  rs12934922: { file: 'wellness', gene: 'BCO1', chrom: '16', pos: 81301694, ref: 'A', alleles: ['A', 'T'], genotypes: ['AA', 'AT', 'TT'] },
  rs601338: { file: 'wellness', gene: 'FUT2', chrom: '19', pos: 49206674, ref: 'G', alleles: ['G', 'A'], genotypes: ['AA', 'AG', 'GG'] },
  rs1801282: { file: 'wellness', gene: 'PPARG', chrom: '3', pos: 12393125, ref: 'C', alleles: ['C', 'G'], genotypes: ['CC', 'CG', 'GG'] },
  rs1800497: { file: 'personality', gene: 'ANKK1', chrom: '11', pos: 113270828, ref: 'G', alleles: ['G', 'A'], genotypes: ['AA', 'AG', 'GG'] },
  rs2282679: { file: 'wellness', gene: 'GC', chrom: '4', pos: 72608383, ref: 'T', alleles: ['T', 'G'], genotypes: ['GG', 'GT', 'TT'] },
  rs5082: { file: 'wellness', gene: 'APOA2', chrom: '1', pos: 161193683, ref: 'G', alleles: ['A', 'G'], genotypes: ['AA', 'AG', 'GG'] },
  rs174537: { file: 'wellness', gene: 'FADS1', chrom: '11', pos: 61552680, ref: 'G', alleles: ['G', 'T'], genotypes: ['GG', 'GT', 'TT'] },
  rs1260326: { file: 'wellness', gene: 'GCKR', chrom: '2', pos: 27730940, ref: 'T', alleles: ['C', 'T'], genotypes: ['CC', 'CT', 'TT'] },
  rs10830963: { file: 'wellness', gene: 'MTNR1B', chrom: '11', pos: 92708710, ref: 'C', alleles: ['C', 'G'], genotypes: ['CC', 'CG', 'GG'] },
  rs662799: { file: 'wellness', gene: 'APOA5', chrom: '11', pos: 116663707, ref: 'G', alleles: ['A', 'G'], genotypes: ['AA', 'AG', 'GG'] },
  rs1801725: { file: 'wellness', gene: 'CASR', chrom: '3', pos: 122003757, ref: 'G', alleles: ['G', 'T'], genotypes: ['GG', 'GT', 'TT'] },
  rs762551: { file: 'wellness', gene: 'CYP1A2', chrom: '15', pos: 75041917, ref: 'C', alleles: ['A', 'C'], genotypes: ['AA', 'AC', 'CC'] },
  rs5751876: { file: 'wellness', gene: 'ADORA2A', chrom: '22', pos: 24837301, ref: 'T', alleles: ['C', 'T'], genotypes: ['CC', 'CT', 'TT'] },
  rs1815739: { file: 'performance', gene: 'ACTN3', chrom: '11', pos: 66328095, ref: 'T', alleles: ['C', 'T'], genotypes: ['CC', 'CT', 'TT'] },
  rs8192678: { file: 'performance', gene: 'PPARGC1A', chrom: '4', pos: 23815662, ref: 'C', alleles: ['C', 'T'], genotypes: ['CC', 'CT', 'TT'] },
  rs17602729: { file: 'performance', gene: 'AMPD1', chrom: '1', pos: 115236057, ref: 'G', alleles: ['A', 'G'], genotypes: ['AA', 'AG', 'GG'] },
  rs12722: { file: 'performance', gene: 'COL5A1', chrom: '9', pos: 137734416, ref: 'C', alleles: ['C', 'T'], genotypes: ['CC', 'CT', 'TT'] },
} as const;

describe('phase 2 curated interpretation content', () => {
  const wellness = loadMarkers('wellness');
  const personality = loadMarkers('personality');
  const performance = loadMarkers('performance');

  for (const [rsid, identity] of Object.entries(expected)) {
    it(`${rsid} has verified identity, allele, and evidence provenance`, () => {
      const marker = (identity.file === 'wellness' ? wellness : identity.file === 'personality' ? personality : performance)[rsid];
      assert.ok(marker, `${rsid} is present`);
      assert.equal(marker.gene, identity.gene);
      assert.equal(marker.chrom, identity.chrom);
      assert.equal(marker.pos, identity.pos);
      assert.deepEqual(Object.keys(marker.interpretations).sort(), [...identity.genotypes].sort());

      const provenance = marker.provenance;
      assert.ok(provenance, `${rsid} includes provenance`);
      assert.equal(provenance.status, 'curated');
      assert.equal(provenance.reviewedAt, '2026-07-19');
      assert.equal(provenance.genomeBuild, 'GRCh37');
      assert.equal(provenance.referenceAllele, identity.ref);
      assert.deepEqual(provenance.commonAlleles, [...identity.alleles]);
      assert.ok(provenance.sources.length >= 2);
      assert.ok(provenance.sources.some(source => source.type === 'variant_identity'));
      assert.ok(provenance.sources.some(source =>
        source.type === 'primary_study'
        || source.type === 'systematic_review'
        || source.type === 'guideline'
      ));
      assert.ok(provenance.sources.every(source => source.url.startsWith('https://')));
      assert.ok(provenance.limitations.length >= 2);

      const consumerText = Object.values(marker.interpretations)
        .flatMap(value => [value.interpretation, ...value.recommendations])
        .join(' ');
      assert.doesNotMatch(consumerText, /\b\d+(?:\.\d+)?\s*(?:mcg|mg|g)\s*\/\s*day\b/i);
      assert.doesNotMatch(consumerText, /\b(?:guarantees?|will prevent|will cause)\b/i);
    });
  }

  it('keeps uncertain behavioral evidence explicitly non-predictive', () => {
    const text = JSON.stringify(personality.rs1800497);
    assert.equal(personality.rs1800497!.tag, 'ℹ️ Research Context');
    assert.match(text, /inconsistent/i);
    assert.match(text, /does not determine|do not use|do not interpret/i);
    assert.doesNotMatch(text, /higher addiction risk|lower addiction risk/i);
  });

  it('does not turn FUT2 secretor status into a B12 deficiency or supplement claim', () => {
    const text = JSON.stringify(wellness.rs601338);
    assert.match(text, /does not establish|do not infer/i);
    assert.match(text, /holotranscobalamin/i);
    assert.doesNotMatch(text, /supplementation .* beneficial|hidden.*deficiency|probiotics may help/i);
  });

  it('keeps performance and caffeine markers non-deterministic and measurement-led', () => {
    const reviewed = [
      wellness.rs762551,
      wellness.rs5751876,
      performance.rs1815739,
      performance.rs8192678,
      performance.rs17602729,
      performance.rs12722,
    ];
    const text = JSON.stringify(reviewed);
    assert.doesNotMatch(text, /natural advantage|better suited|optimized for|substantially reduced capacity|cups coffee ok|cup max/i);
    assert.doesNotMatch(text, /collagen peptides|NAD\+ precursor|CoQ10 support|iron.*mg/i);
    assert.match(text, /measur|track|symptom|response/i);
    assert.match(text, /does not|cannot|not a diagnosis/i);
  });
});

describe('curated interpretation report metadata', () => {
  it('carries reviewed wellness and performance provenance into report metadata', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-curated-provenance-'));
    const input = path.join(directory, 'curated.vcf');
    try {
      fs.writeFileSync(input, [
        '##fileformat=VCFv4.2',
        '##contig=<ID=1,length=249250621>',
        '##contig=<ID=4,length=191154276>',
        '##contig=<ID=9,length=141213431>',
        '##contig=<ID=11,length=135006516>',
        '##contig=<ID=15,length=102531392>',
        '##contig=<ID=22,length=51304566>',
        '##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">',
        '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE',
        '1\t115236057\trs17602729\tG\tA\t100\tPASS\t.\tGT\t0/1',
        '4\t23815662\trs8192678\tC\tT\t100\tPASS\t.\tGT\t0/1',
        '4\t72608383\trs2282679\tT\tG\t100\tPASS\t.\tGT\t1/1',
        '9\t137734416\trs12722\tC\tT\t100\tPASS\t.\tGT\t1/1',
        '11\t66328095\trs1815739\tT\tC\t100\tPASS\t.\tGT\t1/1',
        '15\t75041917\trs762551\tC\tA\t100\tPASS\t.\tGT\t1/1',
        '22\t24837301\trs5751876\tT\tC\t100\tPASS\t.\tGT\t0/0',
        '',
      ].join('\n'), 'utf8');

      const result = await analyzeVCF(input, { annotated: true, save: false });
      const evidence = collectCuratedInterpretationEvidence(result.protocol);
      const byRsid = new Map(evidence.map(item => [item.rsid, item]));
      for (const rsid of ['rs2282679', 'rs762551', 'rs5751876', 'rs1815739', 'rs8192678', 'rs17602729', 'rs12722']) {
        assert.equal(byRsid.get(rsid)?.provenance.status, 'curated', `${rsid} provenance is surfaced`);
      }
      assert.equal(byRsid.get('rs2282679')?.gene, 'GC');
      assert.equal(byRsid.get('rs2282679')?.provenance.referenceAllele, 'T');
      assert.ok(byRsid.get('rs2282679')?.provenance.sources.some(source => source.id === 'PMID:20541252'));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('retains provenance for matched findings and deduplicates by rsID', () => {
    const provenance: MarkerProvenance = {
      status: 'curated',
      reviewedAt: '2026-07-19',
      genomeBuild: 'GRCh37',
      referenceAllele: 'C',
      commonAlleles: ['C', 'G'],
      sources: [
        { id: 'identity', label: 'Identity', url: 'https://example.org/identity', type: 'variant_identity' },
        { id: 'study', label: 'Study', url: 'https://example.org/study', type: 'primary_study' },
      ],
      limitations: ['Population-level association.', 'Not diagnostic.'],
    };
    const protocol = {
      genomicProfile: {
        alerts: [{
          itemName: 'PPARG alert', tag: 'test', evidence: 'Short interpretation.', action: 'Check a measured biomarker.',
          gene: 'PPARG', rsid: 'rs1801282', evidenceTier: 2, provenance,
        }],
        topRisks: [{
          itemName: 'PPARG risk', tag: 'test', priority: 2, evidence: 'test',
          scienceSimplified: 'A longer interpretation that should replace the shorter duplicate.',
          supplementation: 'Use standard clinical screening.', gene: 'PPARG', rsid: 'rs1801282', evidenceTier: 2, provenance,
        }],
        superpowers: [{
          itemName: 'GC strength', tag: '🟢 Superpower', evidence: 'test', advantage: 'Measured status remains decisive.',
          gene: 'GC', rsid: 'rs2282679', evidenceTier: 2, provenance,
        }],
      },
    } as unknown as LongevityProtocol;

    const evidence = collectCuratedInterpretationEvidence(protocol);
    assert.equal(evidence.length, 2);
    assert.deepEqual(evidence.map(item => item.rsid), ['rs1801282', 'rs2282679']);
    assert.match(evidence[0]!.interpretation, /longer interpretation/);
    assert.equal(evidence[0]!.provenance, provenance);
    assert.equal(evidence[1]!.surface, 'strength');
  });
});

/**
 * Dashboard Transform Tests
 * Tests transformToDashboardData() — the bridge from pipeline output to dashboard JSON.
 *
 * Run: npx tsx --test scripts/pipeline/dashboard_transform.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { consumerizeGeneticAction, transformToDashboardData } from './index.js';
import type { DashboardOutput, EnrichedTrait } from './index.js';

// ── Sample pipeline output ──

const sampleTraits: EnrichedTrait[] = [
  { trait_id: 'methylation', score: 35, confidence: 0.90, mechanism: 'MTHFR enzyme efficiency' },
  { trait_id: 'inflammation', score: 55, confidence: 0.80, mechanism: 'IL-6 and TNF-alpha signaling' },
  { trait_id: 'cardiovascular_fitness', score: 70, confidence: 0.95, mechanism: 'VO2max capacity' },
  { trait_id: 'sleep_longevity', score: 70, confidence: 0.95, mechanism: 'Circadian rhythm regulation' },
  { trait_id: 'cholesterol', score: 25, confidence: 0.85, mechanism: 'PCSK9-mediated LDL receptor recycling' },
  { trait_id: 'lipid_metabolism', score: 40, confidence: 0.85, mechanism: 'APOB and PCSK9 regulation of LDL cholesterol' },
  { trait_id: 'dna_repair', score: 45, confidence: 0.70, mechanism: 'Base excision repair pathway' },
  { trait_id: 'neuroplasticity', score: 60, confidence: 0.88, mechanism: 'BDNF-mediated synaptic plasticity' },
];

const sampleOutput: DashboardOutput = {
  gli: 550,
  gli_rating: 'Moderate',
  category_gli: {
    'health-vulnerability': 450,
    pharmacogenomics: 520,
    'inherited-conditions': 600,
    traits: 580,
    metabolism: 550,
    'physical-traits': 700,
  },
  top_traits: [
    { trait_id: 'cardiovascular_fitness', score: 70, confidence: 0.95, mechanism: 'VO2max capacity' },
    { trait_id: 'sleep_longevity', score: 70, confidence: 0.95, mechanism: 'Circadian rhythm regulation' },
  ],
  traits: sampleTraits,
  priorities: [
    { trait_id: 'cholesterol', priority: 0.9 },
    { trait_id: 'methylation', priority: 0.7 },
    { trait_id: 'lipid_metabolism', priority: 0.6 },
    { trait_id: 'dna_repair', priority: 0.5 },
    { trait_id: 'inflammation', priority: 0.4 },
  ],
  insights: [
    { title: 'methylation', summary: 'Methylation is below optimal.', actions: [{ title: 'Take methylfolate' }] },
    { title: 'inflammation', summary: 'Inflammatory markers elevated.', actions: [{ title: 'Increase omega-3' }] },
  ],
  protocols: [
    {
      title: 'Core Optimization',
      description: 'Address highest-priority traits',
      impact: 'High',
      difficulty: 'Moderate',
      actions: [
        { title: 'Take methylfolate', description: 'L-methylfolate 400mcg daily' },
        { title: 'Omega-3 supplementation', description: '2g EPA/DHA daily' },
      ],
    },
  ],
  hallmark: {
    hallmarks_affected: 3,
    hallmark_scores: { genome_stability: 50, mitochondrial_function: 60, protein_homeostasis: 70 },
    actionable: [],
    genome_stability_score: 50,
  },
  metadata: {
    user_id: 'US',
    processed_at: '2026-05-03T00:00:00.000Z',
    trait_count: 8,
    insight_count: 2,
    protocol_count: 1,
    hallmark_count: 3,
    variant_count: 3700000,
    annotated_count: 1200000,
    curated_markers: 191,
    vep_rare_variants: 42,
    clinvar_pathogenic: 15,
    cpic_actionable: 8,
  },
};

// ── Tests ──

describe('transformToDashboardData', () => {
  it('should produce dashboard data with correct GLI score', () => {
    const data = transformToDashboardData(sampleOutput);
    assert.strictEqual(data.gli.score, 55); // 550 / 10 = 55
    assert.strictEqual(data.gli.rating, 'Moderate');
  });

  it('should clamp GLI score to 0-100', () => {
    const highOutput: DashboardOutput = { ...sampleOutput, gli: 1200, gli_rating: 'Excellent' };
    const data = transformToDashboardData(highOutput);
    assert.ok(data.gli.score <= 100);
    assert.ok(data.gli.score >= 0);
  });

  it('should produce 6 categories', () => {
    const data = transformToDashboardData(sampleOutput);
    assert.strictEqual(data.categories.length, 6);
  });

  it('should produce innate strengths', () => {
    const data = transformToDashboardData(sampleOutput);
    assert.strictEqual(data.innate_strengths.length, 2);
    assert.strictEqual(data.innate_strengths[0].gene, 'Heart Health');
    assert.strictEqual(data.innate_strengths[1].gene, 'Deep Sleep');
  });

  it('should include what_this_means text for Moderate rating', () => {
    const data = transformToDashboardData(sampleOutput);
    assert.ok(data.gli.what_this_means);
    assert.ok(data.gli.what_this_means!.length > 20);
  });

  it('should include focus areas from low-scoring traits', () => {
    const data = transformToDashboardData(sampleOutput);
    assert.ok(data.gli.focus_areas);
    assert.ok(data.gli.focus_areas!.length > 0);
    assert.ok(data.gli.focus_areas!.some(a => a.toLowerCase().includes('cholesterol')));
  });

  it('should map action plan with steps', () => {
    const data = transformToDashboardData(sampleOutput);
    assert.ok(data.action_plan.length > 0);
    const first = data.action_plan[0];
    assert.ok(first.priority === 'High Priority' || first.priority === 'Medium Priority');
    assert.ok(first.steps.length === 3);
  });

  it('should detect WGS from annotated count > 500K', () => {
    const data = transformToDashboardData(sampleOutput);
    assert.strictEqual(data.meta.data_source, 'Dante Labs WGS');
    assert.strictEqual(data.meta.coverage, '30');
  });

  it('should detect SNP array from low annotated count', () => {
    const arrayOutput: DashboardOutput = {
      ...sampleOutput,
      metadata: { ...sampleOutput.metadata, annotated_count: 500, variant_count: 500000 },
    };
    const data = transformToDashboardData(arrayOutput);
    assert.strictEqual(data.meta.data_source, 'SNP Array');
    assert.strictEqual(data.meta.coverage, '0.5');
  });

  it('should handle empty traits gracefully', () => {
    const emptyOutput: DashboardOutput = {
      ...sampleOutput,
      traits: [],
      insights: [],
      protocols: [],
      priorities: [],
      top_traits: [],
      metadata: { ...sampleOutput.metadata, trait_count: 0, insight_count: 0, protocol_count: 0 },
      category_gli: {},
    };
    const data = transformToDashboardData(emptyOutput);
    assert.strictEqual(data.innate_strengths.length, 0);
    assert.strictEqual(data.insights.length, 0);
    assert.strictEqual(data.action_plan.length, 0);
  });

  it('should handle protocol phases', () => {
    const data = transformToDashboardData(sampleOutput);
    assert.ok(data.protocols.length > 0);
    const proto = data.protocols[0];
    assert.ok(proto.phases.length > 0);
  });

  it('should translate medication-genetics guidance into personalized plain language', () => {
    const action = consumerizeGeneticAction({
      id: 'pretreatment_hla_screening',
      title: 'Pre-treatment HLA screening',
      description: 'Mandatory HLA-B*57:01 screening before abacavir; recommended for HLA-B*15:02 / HLA-A*31:01 before carbamazepine in at-risk populations',
    });

    assert.strictEqual(action.title, 'Review medication safety before starting a new prescription');
    assert.match(action.why, /personalized/i);
    assert.match(action.why, /your genetic results/i);
    assert.doesNotMatch(`${action.title} ${action.why} ${action.steps.join(' ')}`, /HLA-B|57:01|15:02|31:01|at-risk populations/i);
    assert.match(action.steps.join(' '), /clinician or pharmacist/i);
    assert.match(action.steps.join(' '), /Do not start, stop, or change/i);
  });
});

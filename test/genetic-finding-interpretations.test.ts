import assert from 'node:assert/strict';
import { test } from 'node:test';
import { upsertGeneticPipelineInterpretation } from '../src/core/genetic-analysis.js';
import { createId } from '../src/store.js';
import type { AnalysisResult, RawSourceReference } from '../src/types.js';
import type { GeneticsPipelineResult } from '../src/core/genetics-runner.js';

function emptyAnalysis(): AnalysisResult {
  return {
    id: createId('analysis'), user_id: 'user_1', organization_id: 'org_1', created_at: new Date().toISOString(),
    source_ids: [], raw_source_references: [], normalized_observations: [], derived_interpretations: [],
    dashboard_spec: {
      id: createId('dash'), user_id: 'user_1', organization_id: 'org_1', analysis_id: 'x', generated_at: new Date().toISOString(),
      cards: [], provenance: { source_ids: [], storage_mode: 'durable', clinical_boundary: 'test' },
    },
  } as unknown as AnalysisResult;
}

const source = {
  id: createId('src'), user_id: 'user_1', organization_id: 'org_1', category: 'genetics',
  filename: 'genome.vcf.gz', received_at: new Date().toISOString(), byte_length: 10, storage_mode: 'durable',
} as unknown as RawSourceReference;

function pipelineWithFindings(): GeneticsPipelineResult {
  return {
    status: 'complete',
    summary: 'ok',
    raw: { gli: 500 },
    dashboard: {
      metadata: {
        consumer_genetics: { interpretation_release: 'test', generated_at: new Date().toISOString(), summary: {}, insights: [] },
        variant_cards: {
          genetic_conditions: [{ gene: 'HFE', rsid: 'rs1800562', disease: 'Hereditary hemochromatosis', clinicalSignificance: 'pathogenic', category: 'genetic_conditions', annotation: 'Pathogenic HFE variant.' }],
          drug_response: [
            { gene: 'CYP2C19', rsid: 'rs4244285', disease: 'Clopidogrel response', clinicalSignificance: 'drug response', category: 'drug_response', annotation: 'Reduced clopidogrel activation.' },
            { gene: 'DIO1', rsid: 'rs2235544', disease: 'Levothyroxine response', category: 'drug_response', annotation: 'Levothyroxine response.' },
          ],
          other_risks: [{ gene: 'FCN3', rsid: 'rs4494157', disease: 'Rheumatic heart disease', category: 'other_risks', annotation: 'Risk factor.' }],
          rare_mutations: [],
          uncommon_mutations: Array.from({ length: 5000 }, (_, i) => ({ rsid: `rs${i}` })),
        },
        prs_scores: [
          { disease: 'bone_density', riskLabel: 'Lower', percentile: 11, description: 'Lower bone density.' },
          { disease: 'type_2_diabetes', riskLabel: 'Higher', percentile: 88 },
        ],
        condition_catalog_findings: {
          modalities: {
            hereditary: [{ id: 1, name: "Crohn's disease", modality: 'hereditary', panel_genes: ['IL23R', 'NOD2', 'ATG16L1'] }],
            pharmacology: [{ id: 2, name: 'Warfarin sensitivity', modality: 'pharmacology', panel_genes: ['VKORC1'] }],
          },
        },
      },
    },
  };
}

test('expands actionable dashboard findings into first-class interpretations', () => {
  const analysis = emptyAnalysis();
  upsertGeneticPipelineInterpretation(analysis, source, pipelineWithFindings());

  const byType = (t: string) => analysis.derived_interpretations.filter(i => i.type === t);
  assert.equal(byType('genetic_condition_finding').length, 1);
  assert.equal(byType('genetic_drug_response').length, 2);
  assert.equal(byType('genetic_risk_finding').length, 1);
  assert.equal(byType('genetic_prs_score').length, 2);
  assert.equal(byType('genetic_condition_catalog_match').length, 2);
  // Plus the single pipeline summary interpretation.
  assert.equal(byType('genetic_pipeline_analysis').length, 1);

  // The exploratory uncommon-mutation tail is never expanded into finding
  // interpretations (only the summary interpretation embeds the full dashboard,
  // which is compacted to zero uncommon mutations before this runs in prod).
  const findingTypes = ['genetic_condition_finding', 'genetic_drug_response', 'genetic_risk_finding', 'genetic_rare_variant', 'genetic_prs_score', 'genetic_condition_catalog_match'];
  const findings = analysis.derived_interpretations.filter(i => findingTypes.includes(i.type));
  assert.equal(findings.some(i => JSON.stringify(i.raw).includes('rs4999')), false);
  assert.ok(findings.length < 50, `findings should exclude the 5000 uncommon tail, got ${findings.length}`);

  const drug = byType('genetic_drug_response')[0]!;
  assert.equal(drug.status, 'pharmacogenomic');
  assert.match(String(drug.title), /CYP2C19/);
  assert.match(String(drug.action), /clinician or pharmacist/);
  const drugReport = (drug.raw as Record<string, any>).consumer_report;
  assert.equal(drugReport.schema_version, '1.0');
  assert.equal(drugReport.category, 'genetic_drug_response');
  assert.equal(drugReport.result.label, 'Reduced clopidogrel activation.');
  assert.equal(drugReport.evidence.variants[0].rsid, 'rs4244285');
  assert.equal(drugReport.evidence.variants[0].gene, 'CYP2C19');
  assert.match(drugReport.action, /clinician or pharmacist/);

  const pathogenic = byType('genetic_condition_finding')[0]!;
  assert.equal(pathogenic.status, 'action_recommended');

  const prs = byType('genetic_prs_score').find(i => /type 2 diabetes/i.test(i.title))!;
  assert.equal(prs.score, 88);
  const prsReport = (prs.raw as Record<string, any>).consumer_report;
  assert.equal(prsReport.category, 'genetic_prs_score');
  assert.equal(prsReport.evidence.calibration, undefined);
});

test('condition-catalog interpretations drop the large panel_genes array but keep the count', () => {
  const analysis = emptyAnalysis();
  upsertGeneticPipelineInterpretation(analysis, source, pipelineWithFindings());
  const crohns = analysis.derived_interpretations.find(i => i.type === 'genetic_condition_catalog_match' && /Crohn/.test(i.title))!;
  assert.ok(crohns);
  assert.equal((crohns.raw as Record<string, unknown>).panel_genes, undefined);
  assert.equal((crohns.raw as Record<string, unknown>).panel_gene_count, 3);
  assert.match(String(crohns.summary), /3 panel genes/);
});

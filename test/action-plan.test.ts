import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSourceReference, normalizeImportedFile } from '../src/core/normalization.js';
import { runHealthAnalysis } from '../src/core/analysis.js';
import { buildActionPlan } from '../src/core/action-plan.js';
import type { NormalizedObservation, RawSourceReference } from '../src/types.js';

function ingest(category: 'biomarkers' | 'behavioral', filename: string, contentType: string, text: string): { source: RawSourceReference; observations: NormalizedObservation[] } {
  const source = buildSourceReference(
    { user_id: 'u1', organization_id: 'o1', category, filename, content_type: contentType, text },
    Buffer.from(text, 'utf8'),
  );
  return { source, observations: normalizeImportedFile(source, text) };
}

test('builds an action plan mapping out-of-range markers to interventions and supplements', () => {
  const labs = ingest('biomarkers', 'labs.csv', 'text/csv',
    'marker,value,unit\nApoB,130,mg/dL\nTriglycerides,190,mg/dL\nVitamin D,22,ng/mL\nHomocysteine,14,umol/L\n');
  // The user already takes omega-3, and is on warfarin (anticoagulant + vitamin K antagonist).
  const behavioral = ingest('behavioral', 'log.json', 'application/json',
    JSON.stringify({ entries: [
      { kind: 'supplement', name: 'Omega-3', dose: '2 g' },
      { kind: 'medication', name: 'Warfarin', dose: '5 mg' },
    ] }));

  const analysis = runHealthAnalysis(
    'u1',
    [labs.source, behavioral.source],
    [...labs.observations, ...behavioral.observations],
    { age: 45, sex: 'male' },
    'o1',
  );
  const plan = buildActionPlan(analysis);

  const supplementIds = plan.supplements.map(s => s.id);
  const interventionIds = plan.interventions.map(i => i.id);

  // High ApoB -> fiber + plant sterols + omega-3 and the matching lifestyle changes.
  assert.ok(supplementIds.includes('soluble_fiber'));
  assert.ok(supplementIds.includes('plant_sterols'));
  assert.ok(interventionIds.includes('reduce_sat_fat'));
  // Low vitamin D -> D3. High homocysteine -> methylfolate + B12.
  assert.ok(supplementIds.includes('vitamin_d3'));
  assert.ok(supplementIds.includes('methylfolate'));
  assert.ok(supplementIds.includes('vitamin_b12'));

  // Omega-3 targets BOTH high ApoB and high triglycerides (aggregation across findings).
  const omega = plan.supplements.find(s => s.id === 'omega_3');
  assert.ok(omega, 'omega-3 should be recommended');
  assert.ok(omega!.targets.length >= 2, 'omega-3 should target multiple flagged markers');
  assert.equal(omega!.already_taking, true, 'omega-3 is already logged by the user');

  // Warfarin should raise a bleeding-risk caution on omega-3 and a vitamin K caution on K2.
  assert.ok(omega!.cautions.some(c => /warfarin/i.test(c) && /bleed/i.test(c)));
  const k2 = plan.supplements.find(s => s.id === 'vitamin_k2');
  assert.ok(k2 && k2.cautions.some(c => /warfarin/i.test(c)));

  // Warfarin is pharmacogenomic (CYP2C9/VKORC1) -> a plan-level caution.
  assert.ok(plan.cautions.some(c => /warfarin/i.test(c) && /pharmacogenomic|CPIC/i.test(c)));

  // Every supplement carries an evidence grade and a rationale; the plan is disclaimed.
  assert.ok(plan.supplements.every(s => ['A', 'B', 'C', 'D'].includes(s.evidence)));
  assert.ok(plan.supplements.every(s => s.rationale.startsWith('Targets')));
  assert.ok(plan.supplements.every(s => s.typical_dose === undefined && s.timing === undefined));
  assert.ok(plan.supplements.every(s => /withheld|clinician|pharmacist/i.test(s.dose_guidance)));
  assert.match(plan.disclaimer, /not medical advice/i);
  assert.ok(plan.summary.length > 0);

  const clinicianReviewedPlan = buildActionPlan(analysis, { includeSupplementDoses: true });
  assert.ok(clinicianReviewedPlan.supplements.every(s => typeof s.typical_dose === 'string'));
});

test('cites supp.ai for drug interactions and Pillser for outcomes', () => {
  const labs = ingest('biomarkers', 'labs.csv', 'text/csv',
    'marker,value,unit\nApoB,132,mg/dL\nVitamin D,21,ng/mL\n');
  const behavioral = ingest('behavioral', 'log.json', 'application/json',
    JSON.stringify({ entries: [{ kind: 'medication', name: 'Warfarin', dose: '5 mg' }] }));
  const analysis = runHealthAnalysis(
    'u4', [labs.source, behavioral.source], [...labs.observations, ...behavioral.observations],
    { age: 50, sex: 'male' }, 'o1',
  );
  const plan = buildActionPlan(analysis);

  // Low vitamin D recommends vitamin K2, which supp.ai documents interacting with
  // warfarin - the caution should be the cited, quantified one.
  const k2 = plan.supplements.find(s => s.id === 'vitamin_k2');
  assert.ok(k2, 'expected vitamin K2 for low vitamin D');
  const cited = k2!.cautions.find(c => /warfarin/i.test(c) && /supp\.ai/i.test(c));
  assert.ok(cited, `expected a supp.ai-cited warfarin caution, got: ${JSON.stringify(k2!.cautions)}`);
  assert.match(cited!, /\d+ literature report/);
  assert.ok(k2!.sources.some(s => s.name === 'SUPP.AI' && /supp\.ai/.test(s.url ?? '')));

  // High ApoB maps to Pillser's reduced-LDL outcome; a targeting supplement cites it.
  const apobSupp = plan.supplements.find(s => s.targets.some(t => t.marker === 'apob'));
  assert.ok(apobSupp, 'expected a supplement targeting ApoB');
  assert.ok(apobSupp!.sources.some(s => s.name === 'Pillser' && /pillser\.com/.test(s.url ?? '')));

  // Plan-level attribution to both sources.
  assert.ok(plan.sources.some(s => /supp\.ai/i.test(s.name)));
  assert.ok(plan.sources.some(s => /pillser/i.test(s.name)));
});

test('returns an empty, maintain-framed plan when nothing is out of range', () => {
  const labs = ingest('biomarkers', 'labs.csv', 'text/csv',
    'marker,value,unit\nApoB,70,mg/dL\nHDL-C,60,mg/dL\n');
  const analysis = runHealthAnalysis('u2', [labs.source], labs.observations, { age: 35, sex: 'female' }, 'o1');
  const plan = buildActionPlan(analysis);
  assert.equal(plan.supplements.length, 0);
  assert.equal(plan.interventions.length, 0);
  assert.match(plan.summary, /within target|no out-of-range/i);
  assert.equal(plan.status, 'ready');
});

test('does not report failed genetic processing as normal results', () => {
  const labs = ingest('biomarkers', 'labs.csv', 'text/csv',
    'marker,value,unit\nApoB,70,mg/dL\n');
  const analysis = runHealthAnalysis('u5', [labs.source], labs.observations, undefined, 'o1');
  analysis.derived_interpretations = [{
    id: 'der_failed_genetics',
    user_id: analysis.user_id,
    organization_id: analysis.organization_id,
    analysis_id: analysis.id,
    category: 'genetics',
    type: 'failed',
    title: 'Genetic analysis failed',
    status: 'failed',
    summary: 'Worker ran out of memory.',
    provenance: {
      source_ids: ['src_genetics'],
      source_categories: ['genetics'],
      source_type: 'failed',
      engine: 'test genetics worker',
      generated_at: new Date().toISOString(),
    },
  }];

  const plan = buildActionPlan(analysis);
  assert.equal(plan.status, 'failed');
  assert.equal(plan.interventions.length, 0);
  assert.equal(plan.supplements.length, 0);
  assert.equal(plan.sources.length, 0);
  assert.doesNotMatch(plan.summary, /within target|markers are normal/i);
  assert.match(plan.summary, /failed|reanalysis/i);
  assert.ok(plan.cautions.some(caution => /empty plan|processing failed/i.test(caution)));
});

test('does not recommend supplements off an unrecognized-unit finding', () => {
  // Glucose with a bogus unit is quarantined, so it must not drive the plan.
  const labs = ingest('biomarkers', 'labs.csv', 'text/csv',
    'marker,value,unit\nFasting Glucose,5.4,bananas\n');
  const analysis = runHealthAnalysis('u3', [labs.source], labs.observations, undefined, 'o1');
  const plan = buildActionPlan(analysis);
  assert.equal(plan.supplements.some(s => s.id === 'berberine'), false);
});

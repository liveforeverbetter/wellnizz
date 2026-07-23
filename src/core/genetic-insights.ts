/**
 * API-owned consumer genetics contract.
 *
 * The bundled analysis engine can evolve independently, but public API clients
 * must never receive an uncalibrated score as a population percentile. This
 * adapter normalizes legacy score payloads and produces compact, queryable
 * health and optimization insights from the completed WGS dashboard.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const GENETIC_INTERPRETATION_RELEASE = '2026-07-19.3';

// Curated trait catalog (data/genetics/curated-traits.json): analyzed genes,
// rsIDs, and heritability per trait, extracted from the WGS report corpus. Used
// to attach the full gene/rsID panel to a finding instead of the handful of
// hardcoded spotlights, so a whole-genome analysis surfaces the evidence it
// actually computed. Loaded once, best-effort (missing file degrades silently).
interface CuratedTraitFacts { genes: string[]; rsids: string[]; heritability_pct: number | null }
let curatedCatalogCache: Map<string, CuratedTraitFacts> | null | undefined;

function normalizeTraitKey(value: string | undefined): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function curatedCatalog(): Map<string, CuratedTraitFacts> | null {
  if (curatedCatalogCache !== undefined) return curatedCatalogCache;
  try {
    const raw = JSON.parse(readFileSync(resolve(process.cwd(), 'data/genetics/curated-traits.json'), 'utf8')) as { traits?: Record<string, { trait_id?: string; display_name?: string; genes?: string[]; rsids?: string[]; heritability_pct?: number | null }> };
    const map = new Map<string, CuratedTraitFacts>();
    for (const trait of Object.values(raw.traits ?? {})) {
      const facts: CuratedTraitFacts = { genes: trait.genes ?? [], rsids: trait.rsids ?? [], heritability_pct: trait.heritability_pct ?? null };
      for (const key of [trait.trait_id, trait.display_name]) {
        const normalized = normalizeTraitKey(key);
        if (normalized) map.set(normalized, facts);
      }
    }
    curatedCatalogCache = map;
  } catch {
    curatedCatalogCache = null;
  }
  return curatedCatalogCache;
}

function curatedFactsFor(...keys: Array<string | undefined>): CuratedTraitFacts | undefined {
  const catalog = curatedCatalog();
  if (!catalog) return undefined;
  for (const key of keys) {
    const hit = catalog.get(normalizeTraitKey(key));
    if (hit) return hit;
  }
  return undefined;
}

export type GeneticCalculationState =
  | 'calibrated_absolute_risk'
  | 'reference_relative'
  | 'raw_score_only'
  | 'insufficient_coverage'
  | 'research_only'
  | 'unsupported_model'
  | 'not_applicable'
  | 'failed_retryable';

export type GeneticConsumerCategory =
  | 'clinical_risk'
  | 'health_trait'
  | 'superpowers'
  | 'nutrition'
  | 'sleep_recovery'
  | 'pharmacogenomics'
  | 'research_only';

export interface GeneticConsumerInsight {
  id: string;
  trait_id: string;
  display_name: string;
  category: GeneticConsumerCategory;
  reporting_policy: 'consumer_context' | 'research_only_non_directional';
  calculation_state: GeneticCalculationState;
  result_summary: string;
  consumer_value: string;
  raw_score?: number;
  percentile?: number;
  risk_label?: string;
  coverage?: {
    matched_variants: number;
    expected_variants: number;
    percent: number;
    observed_variant_calls?: number;
    inferred_homozygous_reference?: number;
    rejected_allele_mismatch?: number;
    missing_or_uncallable?: number;
  };
  matching?: {
    genome_build?: string;
    method: 'rsid' | 'position_allele' | 'mixed' | 'unknown';
  };
  calibration?: {
    method: string;
    reference_panel?: string;
    reference_release?: string;
    population?: string;
    population_sample_size?: number;
    population_assignment_method?: string;
    z_score?: number;
    direction_interpretation?: string;
  };
  source?: {
    id?: string;
    name?: string;
    url?: string;
    release?: string;
  };
  genes?: string[];
  rsids?: string[];
  heritability_pct?: number;
  next_measurement?: string;
  limitations: string[];
  reanalysis_recommended: boolean;
}

export interface ConsumerGeneticsSection {
  schema_version: '1.0';
  interpretation_release: string;
  generated_at: string;
  summary: {
    total: number;
    calibrated: number;
    reference_relative: number;
    raw_score_only: number;
    insufficient_coverage: number;
    performance_and_optimization: number;
    research_only: number;
    reanalysis_recommended: boolean;
  };
  insights: GeneticConsumerInsight[];
  requested_but_unavailable: Array<{
    trait_id: string;
    display_name: string;
    reason: string;
    retry_when: string;
  }>;
  interpretation_boundary: string;
}

interface SpotlightDefinition {
  id: string;
  displayName: string;
  category: GeneticConsumerCategory;
  traitIds: string[];
  rsids?: string[];
  genes?: string[];
  consumerValue: string;
  nextMeasurement?: string;
  limitations: string[];
}

const SPOTLIGHTS: SpotlightDefinition[] = [
  {
    id: 'caffeine_clearance',
    displayName: 'Caffeine clearance and sensitivity',
    category: 'superpowers',
    traitIds: ['caffeine_metabolism'],
    rsids: ['rs762551', 'rs5751876'],
    genes: ['CYP1A2', 'ADORA2A'],
    consumerValue: 'Helps personalize caffeine dose and timing experiments around alertness, training, anxiety, and sleep.',
    nextMeasurement: 'Track caffeine dose and time beside sleep onset, sleep quality, resting heart rate, and perceived alertness.',
    limitations: [
      'CYP1A2 rs762551 primarily reflects inducibility; smoking, medications, hormones, pregnancy, and liver health can materially change clearance.',
      'ADORA2A relates more to sensitivity than clearance, so the two mechanisms must not be collapsed into one deterministic metabolizer label.',
    ],
  },
  {
    id: 'aerobic_trainability',
    displayName: 'Aerobic capacity and training response',
    category: 'superpowers',
    traitIds: ['vo2max', 'performance_polygenic', 'cardiorespiratory_fitness'],
    rsids: ['rs8192678'],
    genes: ['PPARGC1A'],
    consumerValue: 'Provides context for aerobic trainability while keeping measured VO2max and training history decisive.',
    nextMeasurement: 'Pair with a measured or consistently estimated VO2max and repeat after an 8-12 week aerobic block.',
    limitations: [
      'Single variants explain very little of cardiorespiratory fitness and do not cap achievable performance.',
      'Device-estimated VO2max, laboratory VO2max, age, sex, altitude, and training history are not interchangeable.',
    ],
  },
  {
    id: 'power_endurance_tendency',
    displayName: 'Power versus endurance tendency',
    category: 'superpowers',
    traitIds: ['muscle_fibre_context'],
    rsids: ['rs1815739'],
    genes: ['ACTN3'],
    consumerValue: 'An interesting training-context signal that can be compared with actual sprint, strength, and endurance performance.',
    nextMeasurement: 'Compare with repeatable sprint, jump, strength, and aerobic benchmarks rather than selecting a sport from genotype.',
    limitations: [
      'ACTN3 is non-deterministic and has modest predictive value for an individual.',
      'Training exposure, biomechanics, motivation, injury history, and many other variants dominate real performance.',
    ],
  },
  {
    id: 'grip_strength',
    displayName: 'Hand grip-strength tendency',
    category: 'superpowers',
    traitIds: ['grip_strength', 'muscular_strength'],
    consumerValue: 'Adds inherited context to a simple, repeatable marker of strength and healthy aging while keeping measured performance decisive.',
    nextMeasurement: 'Use a calibrated dynamometer and track the best of repeated trials under a consistent protocol.',
    limitations: [
      'The score predicts a population phenotype, not an individual ceiling or response to a training plan.',
      'Age, sex, body size, training, pain, injury, technique, and device protocol materially affect measured grip strength.',
    ],
  },
  {
    id: 'exercise_tolerance',
    displayName: 'Exercise tolerance and energy metabolism',
    category: 'superpowers',
    traitIds: ['exercise_tolerance'],
    rsids: ['rs17602729'],
    genes: ['AMPD1'],
    consumerValue: 'Can provide context when unusually rapid fatigue or exercise intolerance is also observed.',
    nextMeasurement: 'Use symptoms, training logs, lactate or cardiopulmonary exercise testing when clinically appropriate.',
    limitations: [
      'A genotype is not an explanation for exercise symptoms by itself.',
      'Chest pain, fainting, or unexplained severe breathlessness requires clinical evaluation regardless of genotype.',
    ],
  },
  {
    id: 'lean_body_mass',
    displayName: 'Fat-free mass tendency',
    category: 'superpowers',
    traitIds: ['lean_body_mass', 'fat_free_mass'],
    consumerValue: 'Adds inherited context to body composition, recovery, strength, and healthy-aging measurements without treating mass as performance.',
    nextMeasurement: 'Pair with DEXA or a consistent validated body-composition method, waist measures, and strength testing.',
    limitations: [
      'Fat-free mass includes water, organs, bone, and other tissue and is not identical to skeletal muscle or strength.',
      'Training, diet, hormones, illness, age, sex, and measurement method can outweigh inherited tendency.',
    ],
  },
  {
    id: 'walking_duration',
    displayName: 'Walking-duration research context',
    category: 'superpowers',
    traitIds: ['walking_duration', 'physical_activity'],
    consumerValue: 'Offers population-level context for habitual walking that can be compared with actual activity, opportunity, and functional capacity.',
    nextMeasurement: 'Use several weeks of steps, walking minutes, pace, terrain, and symptom data rather than inferring activity from genetics.',
    limitations: [
      'Walking is strongly shaped by environment, occupation, health, disability, transport access, and preference.',
      'This score does not measure motivation, discipline, exercise capacity, or the benefit a person can gain from activity.',
    ],
  },
  {
    id: 'soft_tissue_resilience',
    displayName: 'Tendon and soft-tissue resilience',
    category: 'superpowers',
    traitIds: ['tendon_injury', 'soft_tissue_injury'],
    rsids: ['rs12722'],
    genes: ['COL5A1'],
    consumerValue: 'Adds context to load progression and recovery when combined with actual injury history and biomechanics.',
    nextMeasurement: 'Track training-load spikes, pain, range of motion, and prior tendon injury.',
    limitations: [
      'Association strength varies by cohort, ancestry, sex, sport, and injury definition.',
      'It does not justify avoiding beneficial exercise.',
    ],
  },
  {
    id: 'sleep_timing',
    displayName: 'Sleep duration and chronotype tendency',
    category: 'sleep_recovery',
    traitIds: ['sleep_duration', 'chronotype_morningness'],
    consumerValue: 'Helps compare innate timing tendencies with work schedule, light exposure, caffeine timing, and wearable sleep patterns.',
    nextMeasurement: 'Use several weeks of sleep timing, duration, regularity, and morning-light data.',
    limitations: [
      'Genetic tendency is not a sleep disorder diagnosis.',
      'Work schedules, parenting, light, stress, illness, and stimulants can outweigh inherited tendency.',
    ],
  },
  {
    id: 'pulmonary_function',
    displayName: 'Pulmonary function and lung-capacity tendency',
    category: 'superpowers',
    traitIds: ['pulmonary_function', 'lung_function', 'fev1', 'fvc'],
    consumerValue: 'Provides novel context for respiratory performance when paired with FEV1, FVC, exercise testing, symptoms, smoking, and altitude.',
    nextMeasurement: 'Pair with quality-controlled spirometry or cardiopulmonary exercise testing; measured FEV1 and FVC take precedence.',
    limitations: [
      'A polygenic tendency cannot diagnose asthma, COPD, restriction, or exercise-induced bronchoconstriction.',
      'Smoking, air quality, respiratory disease, body size, age, sex, altitude, and test technique have major effects.',
    ],
  },
  {
    id: 'fluid_reasoning_research',
    displayName: 'Fluid-reasoning research score',
    category: 'research_only',
    traitIds: ['fluid_intelligence_score'],
    consumerValue: 'Makes a cohort-derived cognitive research model queryable without converting it into an intelligence or potential claim.',
    limitations: [
      'This is not a measure or prediction of general intelligence, creativity, judgment, knowledge, learning potential, or personal worth.',
      'Education, culture, language, health, opportunity, test setting, and population structure materially shape the modeled phenotype.',
      'Never use this result for education, employment, insurance, eligibility, or any other high-impact decision.',
    ],
  },
  {
    id: 'loneliness_research',
    displayName: 'Loneliness research score',
    category: 'research_only',
    traitIds: ['loneliness'],
    consumerValue: 'Makes an exploratory population model available as research provenance, not as a prediction about social connection or mental health.',
    limitations: [
      'Loneliness is a lived state shaped strongly by relationships, environment, health, culture, access, and current circumstances.',
      'This model cannot predict social ability, belonging, relationship quality, or future mental health for an individual.',
      'Never use this result for clinical, employment, insurance, eligibility, relationship, or other high-impact decisions.',
    ],
  },
  {
    id: 'friendship_satisfaction_research',
    displayName: 'Friendship-satisfaction research score',
    category: 'research_only',
    traitIds: ['friendship_satisfaction'],
    consumerValue: 'Preserves an exploratory social-phenotype model and its provenance without claiming to predict anyone\'s relationships.',
    limitations: [
      'This cohort-specific self-report phenotype is strongly shaped by relationships, opportunity, culture, health, and current circumstances.',
      'The score does not measure social skill, empathy, compatibility, trustworthiness, or personal worth.',
      'Never use this result for employment, insurance, eligibility, relationship, or other high-impact decisions.',
    ],
  },
  {
    id: 'neuroticism_research',
    displayName: 'Personality-trait research score',
    category: 'research_only',
    traitIds: ['neuroticism'],
    consumerValue: 'Exposes a published research model without turning a probabilistic questionnaire association into a personality identity.',
    limitations: [
      'A polygenic model does not define personality identity, resilience, emotional capacity, future behavior, or mental health.',
      'Current stress, health, trauma, support, culture, age, and questionnaire context materially affect reported traits.',
      'Never use this result for diagnosis, treatment, employment, insurance, eligibility, relationship, or other high-impact decisions.',
    ],
  },
];

/**
 * Normalize the dashboard in place to avoid duplicating a potentially large
 * WGS payload in memory. The caller should use the returned section for compact
 * query interpretations.
 */
export function normalizeGeneticsDashboard(dashboard: unknown, now = new Date()): ConsumerGeneticsSection {
  const record = objectRecord(dashboard);
  const metadata = objectRecord(record?.metadata);
  const prsScores = arrayRecords(metadata?.prs_scores);
  const insights = prsScores.map(normalizePolygenicScore);

  const directSignals = collectDirectSignals(record);
  for (const spotlight of SPOTLIGHTS) {
    if (insights.some(insight => insight.trait_id === spotlight.id || spotlight.traitIds.includes(insight.trait_id))) continue;
    const matches = directSignals.filter(signal => matchesSpotlight(signal, spotlight));
    if (matches.length === 0) continue;
    insights.push(directSpotlightInsight(spotlight, matches));
  }

  const availableTraits = new Set(insights.map(insight => insight.trait_id));
  const requestedButUnavailable = SPOTLIGHTS
    .filter(spotlight => spotlight.id === 'pulmonary_function' && !availableTraits.has(spotlight.id)
      && !spotlight.traitIds.some(id => availableTraits.has(id)))
    .map(spotlight => ({
      trait_id: spotlight.id,
      display_name: spotlight.displayName,
      reason: 'No approved, model-faithful pulmonary-function score was produced for this analysis.',
      retry_when: 'Reanalyze after the position/build-aware pulmonary PGS release is enabled, then interpret it beside measured spirometry.',
    }));

  const section: ConsumerGeneticsSection = {
    schema_version: '1.0',
    interpretation_release: GENETIC_INTERPRETATION_RELEASE,
    generated_at: now.toISOString(),
    summary: {
      total: insights.length,
      calibrated: insights.filter(item => item.calculation_state === 'calibrated_absolute_risk').length,
      reference_relative: insights.filter(item => item.calculation_state === 'reference_relative').length,
      raw_score_only: insights.filter(item => item.calculation_state === 'raw_score_only').length,
      insufficient_coverage: insights.filter(item => item.calculation_state === 'insufficient_coverage').length,
      performance_and_optimization: insights.filter(item => ['superpowers', 'nutrition', 'sleep_recovery'].includes(item.category)).length,
      research_only: insights.filter(item => item.category === 'research_only').length,
      reanalysis_recommended: insights.some(item => item.reanalysis_recommended) || requestedButUnavailable.length > 0,
    },
    insights,
    requested_but_unavailable: requestedButUnavailable,
    interpretation_boundary: 'Educational health, performance, nutrition, sleep, longevity, and research context. Not diagnosis, treatment, or a substitute for measured physiology and qualified clinical review. Cognitive, personality, and social research scores are never measures of intelligence, identity, social worth, relationship quality, or education or employment potential.',
  };

  if (metadata) {
    metadata.prs_scores = prsScores;
    metadata.consumer_genetics = section;
  }
  return section;
}

function normalizePolygenicScore(score: Record<string, unknown>): GeneticConsumerInsight {
  const traitId = stringValue(score.disease) ?? stringValue(score.trait_id) ?? 'unknown_polygenic_score';
  const coverage = scoreCoverage(score);
  const calibration = explicitCalibration(score);
  const reportingPolicy = reportingPolicyForScore(score, traitId);
  const state: GeneticCalculationState = coverage && coverage.percent < 75
    ? 'insufficient_coverage'
    : reportingPolicy === 'research_only_non_directional'
      ? 'research_only'
      : calibration?.state ?? 'raw_score_only';
  const rawScore = numberValue(score.score);
  const percentile = state === 'calibrated_absolute_risk' || state === 'reference_relative'
    ? numberValue(score.percentile)
    : undefined;
  const riskLabel = percentile == null ? undefined : stringValue(score.riskLabel) ?? stringValue(score.risk_label);
  const spotlight = SPOTLIGHTS.find(item => item.traitIds.includes(traitId));
  const curated = curatedFactsFor(traitId, spotlight?.displayName, stringValue(score.sourceName));

  // Sanitize the legacy engine payload itself so downstream dashboard clients
  // cannot accidentally render an unproven percentile.
  score.calculationState = state;
  score.percentile = percentile ?? null;
  score.riskLabel = riskLabel ?? (state === 'insufficient_coverage' ? 'Insufficient coverage' : 'Raw score only');
  score.calibration = state === 'research_only' ? null : calibration?.publicValue ?? null;
  score.reanalysisRecommended = state === 'raw_score_only' || state === 'insufficient_coverage';
  if (state === 'raw_score_only') {
    score.description = 'A model-weighted genetic score was calculated, but no compatible population calibration was supplied. No percentile or above/below-average claim is returned.';
  } else if (state === 'insufficient_coverage') {
    score.description = `Only ${coverage?.matched_variants ?? 0} of ${coverage?.expected_variants ?? 0} configured variants were matched. The model is not interpreted.`;
  } else if (state === 'research_only') {
    score.description = 'A published research model was calculated, but direction, percentile, and trait prediction are intentionally withheld. It must not be used for health or high-impact life decisions.';
  }

  return {
    id: `pgs:${stringValue(score.sourceId) ?? traitId}`,
    trait_id: traitId,
    display_name: spotlight?.displayName ?? stringValue(score.sourceName) ?? titleize(traitId),
    category: spotlight?.category ?? consumerCategoryForScore(score, traitId),
    reporting_policy: reportingPolicy,
    calculation_state: state,
    result_summary: state === 'raw_score_only'
      ? 'Raw model score available; population comparison withheld until compatible calibration is available.'
      : state === 'insufficient_coverage'
        ? 'The score was not interpreted because model coverage is below the API safety threshold.'
        : state === 'research_only'
          ? 'Research model calculated; direction, percentile, and individual trait prediction are intentionally withheld.'
        : `${riskLabel ?? 'Reference-relative result'}${percentile == null ? '' : ` (${Math.round(percentile)}th percentile)`}.`,
    consumer_value: spotlight?.consumerValue ?? consumerValueForTrait(traitId),
    raw_score: rawScore,
    percentile,
    risk_label: riskLabel,
    coverage,
    matching: {
      genome_build: stringValue(score.genomeBuild),
      method: matchingMethod(score),
    },
    calibration: state === 'research_only' ? undefined : calibration?.publicValue,
    source: {
      id: stringValue(score.sourceId),
      name: stringValue(score.sourceName),
      url: stringValue(score.sourceUrl),
      release: stringValue(score.sourceRelease),
    },
    genes: spotlight?.genes ?? (curated?.genes.length ? curated.genes : undefined),
    rsids: spotlight?.rsids ?? (curated?.rsids.length ? curated.rsids : undefined),
    heritability_pct: curated?.heritability_pct ?? undefined,
    next_measurement: spotlight?.nextMeasurement ?? measurementForTrait(traitId),
    limitations: [
      ...(spotlight?.limitations ?? []),
      'Polygenic results are probabilistic and can perform differently across ancestry, age, sex, phenotype definition, and genotyping pipelines.',
      ...(state === 'raw_score_only' ? ['This result has no compatible reference distribution and must not be read as low, average, or high.'] : []),
      ...(state === 'insufficient_coverage' ? ['Missing model variants can materially change the score; reanalysis is recommended when more complete matching is available.'] : []),
      ...(state === 'research_only' ? ['Research-only scores remain non-directional even if a reference distribution later becomes available. They must not be used to label a person or make high-impact decisions.'] : []),
    ],
    reanalysis_recommended: state === 'raw_score_only' || state === 'insufficient_coverage',
  };
}

function explicitCalibration(score: Record<string, unknown>): {
  state: 'calibrated_absolute_risk' | 'reference_relative';
  publicValue: NonNullable<GeneticConsumerInsight['calibration']>;
} | undefined {
  const calibration = objectRecord(score.calibration);
  const state = stringValue(calibration?.state) ?? stringValue(score.calibrationStatus) ?? stringValue(score.calibration_status);
  if (state !== 'calibrated_absolute_risk' && state !== 'reference_relative') return undefined;
  const method = stringValue(calibration?.method);
  const referencePanel = stringValue(calibration?.reference_panel) ?? stringValue(calibration?.referencePanel);
  if (!method || (state === 'reference_relative' && !referencePanel)) return undefined;
  return {
    state,
    publicValue: {
      method,
      reference_panel: referencePanel,
      reference_release: stringValue(calibration?.reference_release) ?? stringValue(calibration?.referenceRelease),
      population: stringValue(calibration?.population),
      population_sample_size: numberValue(calibration?.population_sample_size),
      population_assignment_method: stringValue(calibration?.population_assignment_method),
      z_score: numberValue(calibration?.z_score),
      direction_interpretation: stringValue(calibration?.direction_interpretation),
    },
  };
}

function scoreCoverage(score: Record<string, unknown>): GeneticConsumerInsight['coverage'] | undefined {
  const matched = numberValue(score.variantsScored) ?? numberValue(score.matched_variants);
  const expected = numberValue(score.totalWeightedVariants) ?? numberValue(score.expected_variants);
  const percent = numberValue(score.coveragePct) ?? numberValue(score.coverage_percent)
    ?? (matched != null && expected && expected > 0 ? Math.round((matched / expected) * 10_000) / 100 : undefined);
  if (matched == null || expected == null || percent == null) return undefined;
  const matchingQc = objectRecord(score.matchingQc) ?? objectRecord(score.matching_qc);
  return {
    matched_variants: matched,
    expected_variants: expected,
    percent,
    observed_variant_calls: numberValue(matchingQc?.observed_variant_calls),
    inferred_homozygous_reference: numberValue(matchingQc?.inferred_homozygous_reference),
    rejected_allele_mismatch: numberValue(matchingQc?.rejected_allele_mismatch),
    missing_or_uncallable: numberValue(matchingQc?.missing_or_uncallable),
  };
}

function collectDirectSignals(root: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  if (!root) return [];
  const metadata = objectRecord(root.metadata);
  const variantCards = objectRecord(metadata?.variant_cards);
  const direct = [
    ...arrayRecords(metadata?.curated_interpretations),
    ...Object.values(variantCards ?? {}).flatMap(arrayRecords),
  ];
  return direct;
}

function matchesSpotlight(signal: Record<string, unknown>, spotlight: SpotlightDefinition): boolean {
  const text = JSON.stringify(signal).toLowerCase();
  return Boolean(
    spotlight.rsids?.some(rsid => text.includes(rsid.toLowerCase()))
    || spotlight.genes?.some(gene => new RegExp(`(^|[^a-z0-9])${escapeRegex(gene.toLowerCase())}([^a-z0-9]|$)`).test(text)),
  );
}

function directSpotlightInsight(spotlight: SpotlightDefinition, signals: Array<Record<string, unknown>>): GeneticConsumerInsight {
  const rsids = unique(signals.flatMap(signal => extractMatches(JSON.stringify(signal), /rs\d+/gi)));
  const genes = unique((spotlight.genes ?? []).filter(gene => signals.some(signal => JSON.stringify(signal).toLowerCase().includes(gene.toLowerCase()))));
  const summaries = unique(signals.map(signal => stringValue(signal.interpretation)
    ?? stringValue(signal.annotation)
    ?? stringValue(signal.summary)
    ?? stringValue(signal.label)).filter((value): value is string => Boolean(value)));
  const curated = curatedFactsFor(spotlight.id, spotlight.displayName, ...spotlight.traitIds);
  return {
    id: `marker:${spotlight.id}`,
    trait_id: spotlight.id,
    display_name: spotlight.displayName,
    category: spotlight.category,
    reporting_policy: 'consumer_context',
    // A single-marker association is not a polygenic score. Keep it outside
    // the calibrated/raw-score state machine so summary counts and reanalysis
    // recommendations remain model-specific.
    calculation_state: 'not_applicable',
    result_summary: summaries[0] ?? 'A relevant genotype was observed; interpret it as context rather than a deterministic performance prediction.',
    consumer_value: spotlight.consumerValue,
    genes: genes.length ? genes : curated?.genes,
    rsids: rsids.length ? rsids : curated?.rsids,
    heritability_pct: curated?.heritability_pct ?? undefined,
    matching: { method: 'rsid' },
    next_measurement: spotlight.nextMeasurement,
    limitations: spotlight.limitations,
    reanalysis_recommended: false,
  };
}

function reportingPolicyForScore(score: Record<string, unknown>, traitId: string): GeneticConsumerInsight['reporting_policy'] {
  const explicit = stringValue(score.reportingPolicy) ?? stringValue(score.reporting_policy);
  const explicitCategory = stringValue(score.consumerCategory) ?? stringValue(score.consumer_category);
  if (explicit === 'research_only_non_directional' || explicitCategory === 'research_only' || categoryForTrait(traitId) === 'research_only') {
    return 'research_only_non_directional';
  }
  return 'consumer_context';
}

function consumerCategoryForScore(score: Record<string, unknown>, traitId: string): GeneticConsumerCategory {
  const explicit = stringValue(score.consumerCategory) ?? stringValue(score.consumer_category);
  if (explicit && isGeneticConsumerCategory(explicit)) return explicit;
  return categoryForTrait(traitId);
}

function isGeneticConsumerCategory(value: string): value is GeneticConsumerCategory {
  return ['clinical_risk', 'health_trait', 'superpowers', 'nutrition', 'sleep_recovery', 'pharmacogenomics', 'research_only'].includes(value);
}

function categoryForTrait(traitId: string): GeneticConsumerCategory {
  if (/(cancer|disease|diabetes|coronary|alzheimer|stroke|kidney|asthma|fibrillation)/.test(traitId)) return 'clinical_risk';
  if (/(vo2|grip|lean_body|fat_free|exercise|fitness|walking|caffeine|reaction_time)/.test(traitId)) return 'superpowers';
  if (/(sleep|chronotype)/.test(traitId)) return 'sleep_recovery';
  if (/(vitamin|homocysteine|alcohol)/.test(traitId)) return 'nutrition';
  if (/(cognitive|fluid_intelligence|neuroticism|personality|education|loneliness|friendship_satisfaction)/.test(traitId)) return 'research_only';
  return 'health_trait';
}

function consumerValueForTrait(traitId: string): string {
  if (categoryForTrait(traitId) === 'clinical_risk') return 'Adds inherited-risk context to family history, biomarkers, and guideline-based preventive care.';
  if (categoryForTrait(traitId) === 'research_only') return 'Interesting research context that is not used to make health or life decisions.';
  return 'Adds genetic context that can be compared with measured physiology, behavior, and longitudinal response.';
}

function measurementForTrait(traitId: string): string | undefined {
  if (/(ldl|hdl|triglyceride|cholesterol)/.test(traitId)) return 'Use a current fasting or clinically appropriate lipid panel; measured values take precedence.';
  if (/(glucose|diabetes|hba1c)/.test(traitId)) return 'Use HbA1c and glucose measurements together with age, family history, and clinical context.';
  if (/(vitamin_d)/.test(traitId)) return 'Measure serum 25-hydroxyvitamin D before changing intake or supplementation.';
  if (/(blood_pressure|systolic)/.test(traitId)) return 'Use repeated validated home or clinical blood-pressure measurements.';
  return undefined;
}

function matchingMethod(score: Record<string, unknown>): NonNullable<GeneticConsumerInsight['matching']>['method'] {
  const value = stringValue(score.matchingMethod) ?? stringValue(score.matching_method);
  if (value === 'rsid' || value === 'position_allele' || value === 'mixed') return value;
  return 'unknown';
}

function titleize(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

function extractMatches(value: string, pattern: RegExp): string[] {
  return value.match(pattern) ?? [];
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map(value => value.trim()).filter(Boolean))).sort();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(item => objectRecord(item)) as Array<Record<string, unknown>> : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * API-owned consumer genetics contract.
 *
 * The bundled analysis engine can evolve independently, but public API clients
 * must never receive an uncalibrated score as a population percentile. This
 * adapter normalizes legacy score payloads and produces compact, queryable
 * health and optimization insights from the completed WGS dashboard.
 */

export const GENETIC_INTERPRETATION_RELEASE = '2026-07-19.1';

export type GeneticCalculationState =
  | 'calibrated_absolute_risk'
  | 'reference_relative'
  | 'raw_score_only'
  | 'insufficient_coverage'
  | 'unsupported_model'
  | 'not_applicable'
  | 'failed_retryable';

export type GeneticConsumerCategory =
  | 'clinical_risk'
  | 'health_trait'
  | 'performance'
  | 'nutrition'
  | 'sleep_recovery'
  | 'pharmacogenomics'
  | 'research_only';

export interface GeneticConsumerInsight {
  id: string;
  trait_id: string;
  display_name: string;
  category: GeneticConsumerCategory;
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
  };
  source?: {
    id?: string;
    name?: string;
    url?: string;
    release?: string;
  };
  genes?: string[];
  rsids?: string[];
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
    category: 'performance',
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
    category: 'performance',
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
    category: 'performance',
    traitIds: ['grip_strength', 'muscular_strength'],
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
    id: 'exercise_tolerance',
    displayName: 'Exercise tolerance and energy metabolism',
    category: 'performance',
    traitIds: ['exercise_tolerance', 'lean_body_mass'],
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
    id: 'soft_tissue_resilience',
    displayName: 'Tendon and soft-tissue resilience',
    category: 'performance',
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
    category: 'performance',
    traitIds: ['pulmonary_function', 'lung_function', 'fev1', 'fvc'],
    consumerValue: 'Provides novel context for respiratory performance when paired with FEV1, FVC, exercise testing, symptoms, smoking, and altitude.',
    nextMeasurement: 'Pair with quality-controlled spirometry or cardiopulmonary exercise testing; measured FEV1 and FVC take precedence.',
    limitations: [
      'A polygenic tendency cannot diagnose asthma, COPD, restriction, or exercise-induced bronchoconstriction.',
      'Smoking, air quality, respiratory disease, body size, age, sex, altitude, and test technique have major effects.',
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
      performance_and_optimization: insights.filter(item => ['performance', 'nutrition', 'sleep_recovery'].includes(item.category)).length,
      reanalysis_recommended: insights.some(item => item.reanalysis_recommended) || requestedButUnavailable.length > 0,
    },
    insights,
    requested_but_unavailable: requestedButUnavailable,
    interpretation_boundary: 'Educational health, performance, nutrition, sleep, and longevity context. Not diagnosis, treatment, or a substitute for measured physiology and qualified clinical review.',
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
  const state: GeneticCalculationState = coverage && coverage.percent < 75
    ? 'insufficient_coverage'
    : calibration?.state ?? 'raw_score_only';
  const rawScore = numberValue(score.score);
  const percentile = state === 'calibrated_absolute_risk' || state === 'reference_relative'
    ? numberValue(score.percentile)
    : undefined;
  const riskLabel = percentile == null ? undefined : stringValue(score.riskLabel) ?? stringValue(score.risk_label);
  const spotlight = SPOTLIGHTS.find(item => item.traitIds.includes(traitId));

  // Sanitize the legacy engine payload itself so downstream dashboard clients
  // cannot accidentally render an unproven percentile.
  score.calculationState = state;
  score.percentile = percentile ?? null;
  score.riskLabel = riskLabel ?? (state === 'insufficient_coverage' ? 'Insufficient coverage' : 'Raw score only');
  score.calibration = calibration?.publicValue ?? null;
  score.reanalysisRecommended = state === 'raw_score_only' || state === 'insufficient_coverage';
  if (state === 'raw_score_only') {
    score.description = 'A model-weighted genetic score was calculated, but no compatible population calibration was supplied. No percentile or above/below-average claim is returned.';
  } else if (state === 'insufficient_coverage') {
    score.description = `Only ${coverage?.matched_variants ?? 0} of ${coverage?.expected_variants ?? 0} configured variants were matched. The model is not interpreted.`;
  }

  return {
    id: `pgs:${stringValue(score.sourceId) ?? traitId}`,
    trait_id: traitId,
    display_name: spotlight?.displayName ?? titleize(traitId),
    category: spotlight?.category ?? categoryForTrait(traitId),
    calculation_state: state,
    result_summary: state === 'raw_score_only'
      ? 'Raw model score available; population comparison withheld until compatible calibration is available.'
      : state === 'insufficient_coverage'
        ? 'The score was not interpreted because model coverage is below the API safety threshold.'
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
    calibration: calibration?.publicValue,
    source: {
      id: stringValue(score.sourceId),
      name: stringValue(score.sourceName),
      url: stringValue(score.sourceUrl),
      release: stringValue(score.sourceRelease),
    },
    next_measurement: spotlight?.nextMeasurement ?? measurementForTrait(traitId),
    limitations: [
      ...(spotlight?.limitations ?? []),
      'Polygenic results are probabilistic and can perform differently across ancestry, age, sex, phenotype definition, and genotyping pipelines.',
      ...(state === 'raw_score_only' ? ['This result has no compatible reference distribution and must not be read as low, average, or high.'] : []),
      ...(state === 'insufficient_coverage' ? ['Missing model variants can materially change the score; reanalysis is recommended when more complete matching is available.'] : []),
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
  return {
    id: `marker:${spotlight.id}`,
    trait_id: spotlight.id,
    display_name: spotlight.displayName,
    category: spotlight.category,
    // A single-marker association is not a polygenic score. Keep it outside
    // the calibrated/raw-score state machine so summary counts and reanalysis
    // recommendations remain model-specific.
    calculation_state: 'not_applicable',
    result_summary: summaries[0] ?? 'A relevant genotype was observed; interpret it as context rather than a deterministic performance prediction.',
    consumer_value: spotlight.consumerValue,
    genes,
    rsids,
    matching: { method: 'rsid' },
    next_measurement: spotlight.nextMeasurement,
    limitations: spotlight.limitations,
    reanalysis_recommended: false,
  };
}

function categoryForTrait(traitId: string): GeneticConsumerCategory {
  if (/(cancer|disease|diabetes|coronary|alzheimer|stroke|kidney|asthma|fibrillation)/.test(traitId)) return 'clinical_risk';
  if (/(vo2|grip|lean_body|exercise|fitness|caffeine|reaction_time)/.test(traitId)) return 'performance';
  if (/(sleep|chronotype)/.test(traitId)) return 'sleep_recovery';
  if (/(vitamin|homocysteine|alcohol)/.test(traitId)) return 'nutrition';
  if (/(cognitive|neuroticism|personality|education)/.test(traitId)) return 'research_only';
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

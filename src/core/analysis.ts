import { analyzeBiomarkers, analyzeWearables, aggregateWearableReadings, type BiomarkerReading, type WearableReading } from './engines.js';
import { analyzeBehavioral, type BehavioralEntry } from './behavioral.js';
import { createId, type HealthStore } from '../store.js';
import type {
  AnalysisResult,
  DashboardSpec,
  DerivedInterpretation,
  NormalizedObservation,
  RawSourceReference,
  SourceCategory,
  GeneticsAnnotationDepth,
  UserProfile,
} from '../types.js';

export interface AnalysisOptions {
  modality?: Extract<SourceCategory, 'biomarkers' | 'wearables' | 'genetics'>;
  operation?: 'analyze' | 'derive';
  annotation_depth?: GeneticsAnnotationDepth;
  // IANA timezone used to bucket wearable daily aggregates by the user's local
  // day; falls back to UTC when absent.
  timezone?: string;
}

export function runHealthAnalysis(
  userId: string,
  sources: RawSourceReference[],
  observations: NormalizedObservation[],
  profile?: UserProfile,
  organizationId?: string,
  options: AnalysisOptions = {},
): AnalysisResult {
  const analysisId = createId('analysis');
  const generatedAt = new Date().toISOString();
  const derived: DerivedInterpretation[] = [];
  const scopedSources = options.modality ? sources.filter(source => source.category === options.modality) : sources;
  const scopedObservations = options.modality ? observations.filter(observation => observation.category === options.modality) : observations;

  const biomarkerReadings = scopedObservations
    .filter(obs => obs.category === 'biomarkers' && obs.type === 'lab_result')
    .map(obs => obs.raw)
    .filter((raw): raw is BiomarkerReading => isReading(raw));
  if (biomarkerReadings.length > 0) {
    const summary = analyzeBiomarkers(biomarkerReadings, profile);
    const biomarkerSourceIds = scopedSources.filter(source => source.category === 'biomarkers').map(source => source.id);
    const findings = options.operation === 'derive'
      ? summary.findings.filter(finding => finding.source_type === 'derived')
      : summary.findings;
    derived.push(...findings.slice(0, 20).map(finding => ({
      id: createId('der'),
      user_id: userId,
      organization_id: organizationId,
      analysis_id: analysisId,
      category: 'biomarkers' as const,
      type: finding.source_type === 'derived' ? 'derived_biomarker' : 'lab_interpretation',
      title: finding.name,
      status: finding.status,
      score: finding.score,
      summary: finding.interpretation,
      action: finding.action,
      provenance: {
        source_ids: biomarkerSourceIds,
        source_categories: ['biomarkers' as const],
        source_type: (finding.source_type === 'derived' ? 'derived' : 'direct') as 'direct' | 'derived',
        engine: 'analyze-health biomarker_engine',
        generated_at: generatedAt,
      },
      raw: finding,
    })));
  }

  // Aggregate granular wearable observations into one daily reading per metric.
  // Read the canonical `name`/`value` rather than the raw payload: the mobile SDK
  // path stores the original device record in `raw` (whose `id` is the record id,
  // not the metric), so keying off raw silently dropped every SDK signal. Health
  // Connect also streams per-interval records, so the aggregator sums cumulative
  // metrics (steps, sleep), averages instantaneous ones (heart rate), and keeps
  // the latest point readings, then picks the most recent complete day.
  const wearableReceivedAt = new Map(scopedSources.map(source => [source.id, source.received_at]));
  const wearableRows = scopedObservations
    .filter(obs => obs.category === 'wearables' && obs.type === 'wearable_metric' && obs.name && typeof obs.value === 'number')
    .map(obs => ({ name: obs.name, value: obs.value as number, unit: obs.unit, observed_at: obs.observed_at, fallback_at: wearableReceivedAt.get(obs.source_id) }));
  const wearableReadings = aggregateWearableReadings(wearableRows, options.timezone);
  if (wearableReadings.length > 0) {
    const summary = analyzeWearables(wearableReadings);
    const wearableSourceIds = scopedSources.filter(source => source.category === 'wearables').map(source => source.id);
    derived.push(...summary.findings.slice(0, 20).map(finding => ({
      id: createId('der'),
      user_id: userId,
      organization_id: organizationId,
      analysis_id: analysisId,
      category: 'wearables' as const,
      type: 'wearable_interpretation',
      title: finding.name,
      status: finding.status,
      score: finding.score,
      summary: finding.interpretation,
      action: finding.action,
      provenance: {
        source_ids: wearableSourceIds,
        source_categories: ['wearables' as const],
        source_type: 'direct' as const,
        engine: 'analyze-health wearable_engine',
        generated_at: generatedAt,
      },
      raw: finding,
    })));
  }

  const behavioralEntries = scopedObservations
    .filter(obs => obs.category === 'behavioral' && isBehavioralEntry(obs.raw))
    .map(obs => obs.raw as BehavioralEntry);
  if (behavioralEntries.length > 0) {
    const summary = analyzeBehavioral(behavioralEntries);
    const behavioralSourceIds = scopedSources.filter(source => source.category === 'behavioral').map(source => source.id);
    derived.push(...summary.findings.slice(0, 20).map(finding => ({
      id: createId('der'),
      user_id: userId,
      organization_id: organizationId,
      analysis_id: analysisId,
      category: 'behavioral' as const,
      type: finding.id.endsWith('_inventory') ? finding.id : 'behavioral_interpretation',
      title: finding.name,
      status: finding.status,
      score: finding.score,
      summary: finding.interpretation,
      action: finding.action,
      provenance: {
        source_ids: behavioralSourceIds,
        source_categories: ['behavioral' as const],
        source_type: 'direct' as const,
        engine: 'analyze-health behavioral_engine',
        generated_at: generatedAt,
      },
      raw: finding,
    })));
  }

  if (scopedSources.some(source => source.category === 'genetics')) {
    derived.push({
      id: createId('der'),
      user_id: userId,
      organization_id: organizationId,
      analysis_id: analysisId,
      category: 'genetics',
      type: 'setup_required',
      title: 'Genetic analysis worker required',
      status: 'setup_required',
      summary: 'The hosted API accepted the genetic source reference. Full VCF/WGS interpretation is intentionally delegated to the local pipeline or a configured background worker.',
      action: 'Run the bundled analyze-health pipeline or configure a private worker before returning clinical-style variant interpretation.',
      provenance: {
        source_ids: scopedSources.filter(source => source.category === 'genetics').map(source => source.id),
        source_categories: ['genetics' as const],
        source_type: 'setup_required' as const,
        engine: 'health-api source registry',
        generated_at: generatedAt,
      },
    });
  }

  const dashboardSpec = buildDashboardSpec(userId, analysisId, derived, scopedSources, generatedAt, organizationId);
  const sourceModalities = new Set(scopedSources.map(source => source.category));
  return {
    id: analysisId,
    user_id: userId,
    organization_id: organizationId,
    modality: options.modality ?? (sourceModalities.size === 1 ? scopedSources[0]?.category : 'multimodal'),
    operation: options.operation ?? 'analyze',
    ...(options.annotation_depth ? { annotation_depth: options.annotation_depth } : {}),
    created_at: generatedAt,
    source_ids: scopedSources.map(source => source.id),
    raw_source_references: scopedSources,
    normalized_observations: scopedObservations,
    derived_interpretations: derived,
    dashboard_spec: dashboardSpec,
    ...computeHealthspan(derived),
  };
}

const SCORED_STATUSES = new Set(['optimal', 'watch', 'needs_attention']);

// A finding whose reported unit could not be recognized was scored against the
// canonical range on an assumption, so it is quarantined from the healthspan
// score and priority findings (it still appears in the interpretations with a
// "confirm the reported unit" note).
function isUnverifiedUnit(item: DerivedInterpretation): boolean {
  return Boolean(item.raw && typeof item.raw === 'object' && (item.raw as { unit_unrecognized?: boolean }).unit_unrecognized);
}

// Roll finding scores (0-100, higher is better) into an overall healthspan score
// plus per-domain sub-scores. Findings without a numeric score (missing markers,
// genetics awaiting the worker) are excluded so they neither help nor hurt.
function computeHealthspan(derived: DerivedInterpretation[]): { healthspan_score?: number; domain_scores?: Record<string, number> } {
  const scored = derived.filter(item => typeof item.score === 'number' && item.status != null && SCORED_STATUSES.has(item.status) && !isUnverifiedUnit(item));
  if (scored.length === 0) return {};
  const overall = Math.round(scored.reduce((sum, item) => sum + (item.score as number), 0) / scored.length);
  const byDomain = new Map<string, number[]>();
  for (const item of scored) {
    const domain = findingDomain(item) ?? item.category;
    const list = byDomain.get(domain) ?? [];
    list.push(item.score as number);
    byDomain.set(domain, list);
  }
  const domainScores: Record<string, number> = {};
  for (const [domain, scores] of byDomain) {
    domainScores[domain] = Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length);
  }
  return { healthspan_score: overall, domain_scores: domainScores };
}

function findingDomain(item: DerivedInterpretation): string | undefined {
  if (item.raw && typeof item.raw === 'object' && 'domain' in item.raw) {
    const domain = (item.raw as { domain?: unknown }).domain;
    if (typeof domain === 'string' && domain.length > 0) return domain;
  }
  return undefined;
}

// Re-run the wearables analysis over every wearable source a user has and store
// the result, so the dashboard's "latest analysis" reflects freshly synced data
// without the agent (or a self-hosted caller) manually calling /wearables/analyze.
// Runs after each wearable ingest. Callers should treat failures as non-fatal:
// storing the data is the primary operation, refreshing the analysis is a
// convenience on top. Set WEARABLE_AUTO_ANALYSIS=off to disable.
export async function runWearableAutoAnalysis(
  store: HealthStore,
  userId: string,
  organizationId?: string,
): Promise<AnalysisResult | undefined> {
  if (process.env.WEARABLE_AUTO_ANALYSIS === 'off') return undefined;
  const organizationIds = organizationId ? new Set([organizationId]) : undefined;
  const sources = (await store.listSourcesForUser(userId, organizationIds)).filter(source => source.category === 'wearables');
  if (sources.length === 0) return undefined;
  const observations = await store.getObservations(sources.map(source => source.id));
  const timezone = await resolveWearableTimezone(store, userId, organizationId);
  const analysis = runHealthAnalysis(userId, sources, observations, undefined, organizationId, { modality: 'wearables', operation: 'analyze', timezone });
  await store.saveAnalysis(analysis);
  return analysis;
}

// The wearable day boundary follows the user's device timezone when the mobile
// SDK reports one (stored on the wearable external account). Falls back to UTC.
export async function resolveWearableTimezone(store: HealthStore, userId: string, organizationId?: string): Promise<string | undefined> {
  const organizationIds = organizationId ? new Set([organizationId]) : undefined;
  const accounts = await store.listExternalAccountsForUser(userId, organizationIds);
  const withTimezone = accounts
    .filter(account => typeof account.metadata?.timezone === 'string' && account.metadata.timezone)
    .sort((a, b) => (b.last_synced_at ?? b.updated_at ?? '').localeCompare(a.last_synced_at ?? a.updated_at ?? ''));
  const timezone = withTimezone[0]?.metadata?.timezone;
  return typeof timezone === 'string' ? timezone : undefined;
}

export function summarizeAnalysis(analysis: AnalysisResult) {
  return {
    id: analysis.id,
    modality: analysis.modality,
    operation: analysis.operation,
    created_at: analysis.created_at,
    source_ids: analysis.source_ids,
    healthspan_score: analysis.healthspan_score,
    domain_scores: analysis.domain_scores,
    interpretation_count: analysis.derived_interpretations.length,
    top_findings: analysis.derived_interpretations
      .filter(item => (item.status === 'needs_attention' || item.status === 'watch') && !isUnverifiedUnit(item))
      .sort((a, b) => (a.score ?? 100) - (b.score ?? 100))
      .slice(0, 3)
      .map(item => ({ title: item.title, category: item.category, status: item.status, score: item.score })),
    dashboard_spec_id: analysis.dashboard_spec?.id,
  };
}

export function queryHealthContext(
  observations: NormalizedObservation[],
  analyses: AnalysisResult[],
  query: string,
): { query: string; matches: Array<NormalizedObservation | DerivedInterpretation> } {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const derived = analyses.flatMap(analysis => analysis.derived_interpretations);
  const haystack = [...observations, ...derived];
  const matches = haystack.filter(item => {
    const text = JSON.stringify(item).toLowerCase();
    return terms.every(term => text.includes(term));
  });
  return { query, matches: matches.slice(0, 50) };
}

function buildDashboardSpec(
  userId: string,
  analysisId: string,
  derived: DerivedInterpretation[],
  sources: RawSourceReference[],
  generatedAt: string,
  organizationId?: string,
): DashboardSpec {
  const cards: DashboardSpec['cards'] = derived.slice(0, 24).map(item => {
    const raw = objectRecord(item.raw);
    const min = finiteNumber(raw?.optimal_min);
    const max = finiteNumber(raw?.optimal_max);
    const value = finiteNumber(raw?.value);
    return {
      id: item.id,
      title: item.title,
      category: item.category,
      score: item.score,
      status: item.status,
      summary: item.summary,
      action: item.action,
      value,
      unit: typeof raw?.unit === 'string' ? raw.unit : undefined,
      target: min == null && max == null ? undefined : { min, max },
      visualization: value != null ? 'range' : item.score != null ? 'score' : 'status',
      confidence: item.provenance.source_type === 'direct'
        ? 'high'
        : item.provenance.source_type === 'derived' || item.provenance.source_type === 'combined'
          ? 'medium'
          : 'low',
      provenance: item.provenance,
    };
  });
  const coverage = dashboardCoverage(sources, derived);
  const quality = dashboardQuality(coverage, generatedAt);
  const sections = Array.from(new Set(cards.map(card => card.category))).map(category => ({
    id: `section_${category}`,
    title: presentationSectionTitle(category),
    category,
    card_ids: cards.filter(card => card.category === category).map(card => card.id),
  }));
  return {
    schema_version: '1.0',
    id: createId('dash'),
    user_id: userId,
    organization_id: organizationId,
    analysis_id: analysisId,
    generated_at: generatedAt,
    cards,
    coverage,
    quality,
    sections,
    provenance: {
      source_ids: sources.map(source => source.id),
      storage_mode: sources.some(source => source.storage_mode === 'durable') ? 'durable' : 'memory',
      clinical_boundary: 'Educational healthspan analysis only. Not a diagnosis, treatment plan, or clinical decision system.',
    },
  };
}

const DASHBOARD_MODALITIES: SourceCategory[] = ['wearables', 'biomarkers', 'genetics', 'behavioral'];
const FRESHNESS_DAYS: Record<SourceCategory, number> = {
  wearables: 7,
  biomarkers: 365,
  genetics: 3650,
  behavioral: 90,
};

function dashboardCoverage(sources: RawSourceReference[], derived: DerivedInterpretation[]): NonNullable<DashboardSpec['coverage']> {
  return DASHBOARD_MODALITIES.map(modality => {
    const modalitySources = sources.filter(source => source.category === modality);
    return {
      modality,
      present: modalitySources.length > 0 || derived.some(item => item.category === modality),
      source_count: modalitySources.length,
      finding_count: derived.filter(item => item.category === modality).length,
      latest_received_at: modalitySources.map(source => source.received_at).sort().at(-1),
    };
  });
}

function dashboardQuality(coverage: NonNullable<DashboardSpec['coverage']>, generatedAt: string): NonNullable<DashboardSpec['quality']> {
  const present = coverage.filter(item => item.present);
  const freshness = coverage.map(item => {
    const threshold = FRESHNESS_DAYS[item.modality];
    const latest = item.latest_received_at;
    const parsed = latest == null ? Number.NaN : Date.parse(latest);
    const ageDays = Number.isFinite(parsed) ? Math.max(0, Math.floor((Date.parse(generatedAt) - parsed) / 86_400_000)) : undefined;
    return {
      modality: item.modality,
      status: !item.present ? 'missing' as const : ageDays == null ? 'unknown' as const : ageDays <= threshold ? 'fresh' as const : 'stale' as const,
      threshold_days: threshold,
      latest_received_at: latest,
      age_days: ageDays,
    };
  });
  const missing = coverage.filter(item => !item.present).map(item => item.modality);
  const stale = freshness.filter(item => item.status === 'stale').map(item => item.modality);
  const warnings = [
    ...(missing.length > 0 ? [`Missing modalities: ${missing.join(', ')}. The available modalities are still usable.`] : []),
    ...(stale.length > 0 ? [`Stale modalities: ${stale.join(', ')}. Refresh these sources before making time-sensitive decisions.`] : []),
  ];
  return {
    status: present.length === 0 ? 'empty' : present.length === coverage.length ? 'complete' : 'partial',
    usable: present.length > 0,
    warnings,
    freshness,
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function presentationSectionTitle(category: string): string {
  if (category === 'biomarkers') return 'Biomarkers';
  if (category === 'wearables') return 'Sleep, recovery & activity';
  if (category === 'genetics') return 'Genetics & ancestry';
  if (category === 'behavioral') return 'Lifestyle & health context';
  return 'Multimodal insights';
}

function isReading(raw: unknown): raw is { id: string; value: number; unit?: string } {
  return Boolean(raw && typeof raw === 'object' && 'id' in raw && 'value' in raw);
}

function isBehavioralEntry(raw: unknown): raw is BehavioralEntry {
  return Boolean(raw && typeof raw === 'object' && 'kind' in raw && 'id' in raw);
}

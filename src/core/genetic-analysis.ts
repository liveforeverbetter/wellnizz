import { createId, type HealthStore } from '../store.js';
import type { AnalysisResult, GeneticAnalysisJob, GeneticsAnnotationDepth, RawSourceReference } from '../types.js';
import { runGeneticsPipeline, type GeneticsPipelineOptions, type GeneticsPipelineResult } from './genetics-runner.js';
import type { ConsumerGeneticsSection, GeneticConsumerInsight } from './genetic-insights.js';

export async function enrichAnalysisWithGeneticPipeline(
  analysis: AnalysisResult,
  sources: RawSourceReference[],
  store: HealthStore,
  options: GeneticsPipelineOptions = {},
): Promise<AnalysisResult> {
  const geneticSources = sources.filter(source => source.category === 'genetics');
  for (const source of geneticSources) {
    if (healthAnalysisEnv('EXECUTION_MODE') === 'queue') {
      const job = await enqueueGeneticAnalysisJob(analysis, source, store, options.annotation_depth);
      upsertGeneticQueuedInterpretation(analysis, source, job);
      continue;
    }
    const pipeline = await runGeneticsPipeline(analysis.user_id, source, await store.getSourcePayload(source.id), process.env, options);
    upsertGeneticPipelineInterpretation(analysis, source, pipeline);
  }
  return analysis;
}

export function upsertGeneticPipelineInterpretation(
  analysis: AnalysisResult,
  source: RawSourceReference,
  pipeline: GeneticsPipelineResult,
  jobId?: string,
): AnalysisResult {
  const interpretation = {
    id: createId('der'),
    user_id: analysis.user_id,
    organization_id: analysis.organization_id,
    analysis_id: analysis.id,
    category: 'genetics' as const,
    type: pipeline.status === 'complete' ? 'genetic_pipeline_analysis' : pipeline.status,
    title: pipeline.status === 'complete' ? 'Genetic analysis completed' : pipeline.status === 'failed' ? 'Genetic analysis failed' : 'Genetic analysis setup required',
    status: pipeline.status,
    score: pipeline.raw?.gli,
    summary: pipeline.summary,
    action: actionForPipelineStatus(pipeline.status),
    provenance: {
      source_ids: [source.id],
      source_categories: ['genetics' as const],
      source_type: pipeline.status === 'complete' ? 'derived' as const : pipeline.status as 'setup_required' | 'failed',
      engine: 'bundled analyze-health pipeline',
      generated_at: new Date().toISOString(),
    },
    raw: { ...pipeline, job_id: jobId },
  };
  removeGeneticCardsAndInterpretations(analysis, source.id);
  analysis.derived_interpretations.push(interpretation);
  for (const consumerInterpretation of consumerGeneticInterpretations(analysis, source, pipeline)) {
    analysis.derived_interpretations.push(consumerInterpretation);
  }
  // Surface the actionable variant, drug-response, polygenic, and condition
  // findings as first-class interpretations so the analysis reflects the real
  // depth of a WGS (clinically significant findings, not just a summary card).
  for (const finding of geneticFindingInterpretations(analysis, source, pipeline)) {
    analysis.derived_interpretations.push(finding);
  }
  analysis.dashboard_spec.cards.unshift({
    id: interpretation.id,
    title: interpretation.title,
    category: 'genetics',
    score: interpretation.score,
    status: interpretation.status,
    summary: pipeline.status === 'complete'
      ? geneticSummary(pipeline.raw)
      : pipeline.summary,
    action: interpretation.action,
  });
  return analysis;
}

function consumerGeneticInterpretations(
  analysis: AnalysisResult,
  source: RawSourceReference,
  pipeline: GeneticsPipelineResult,
): AnalysisResult['derived_interpretations'] {
  const section = consumerGeneticsSection(pipeline.dashboard);
  if (!section) return [];
  return section.insights.map(insight => ({
    id: createId('der'),
    user_id: analysis.user_id,
    organization_id: analysis.organization_id,
    analysis_id: analysis.id,
    category: 'genetics' as const,
    type: 'genetic_consumer_insight',
    title: insight.display_name,
    status: consumerInsightStatus(insight),
    score: insight.percentile,
    summary: insight.result_summary,
    action: insight.next_measurement,
    provenance: {
      source_ids: [source.id],
      source_categories: ['genetics' as const],
      source_type: 'derived' as const,
      engine: `Wellnizz consumer genetics ${section.interpretation_release}`,
      generated_at: section.generated_at,
    },
    raw: {
      ...insight,
      interpretation_release: section.interpretation_release,
      domain: insight.category,
      query_aliases: consumerInsightAliases(insight),
    },
  }));
}

function consumerGeneticsSection(dashboard: unknown): ConsumerGeneticsSection | undefined {
  if (!dashboard || typeof dashboard !== 'object' || Array.isArray(dashboard)) return undefined;
  const metadata = (dashboard as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const section = (metadata as Record<string, unknown>).consumer_genetics;
  if (!section || typeof section !== 'object' || Array.isArray(section)) return undefined;
  return section as unknown as ConsumerGeneticsSection;
}

// Per-category caps keep the exploratory long tail out of the inline analysis
// while retaining every clinically meaningful finding. The uncommon-mutation
// tail (tens of thousands) is never emitted here; use the full-analysis artifact
// for it.
const MAX_VARIANT_FINDINGS_PER_CATEGORY = 500;
const MAX_PRS_FINDINGS = 100;
const MAX_CONDITION_FINDINGS_PER_MODALITY = 250;

const VARIANT_FINDING_CATEGORIES: Array<{ key: string; type: string; noun: string }> = [
  { key: 'genetic_conditions', type: 'genetic_condition_finding', noun: 'Genetic condition' },
  { key: 'drug_response', type: 'genetic_drug_response', noun: 'Drug-response marker' },
  { key: 'other_risks', type: 'genetic_risk_finding', noun: 'Risk marker' },
  { key: 'rare_mutations', type: 'genetic_rare_variant', noun: 'Rare variant' },
];

// Expand the analyze-health dashboard's actionable collections into first-class
// derived interpretations: clinically significant variants, pharmacogenomic
// (drug-response) markers, polygenic risk scores, and condition-catalog matches.
// Exploratory uncommon variants are intentionally excluded (long tail; available
// via the full-analysis artifact).
function geneticFindingInterpretations(
  analysis: AnalysisResult,
  source: RawSourceReference,
  pipeline: GeneticsPipelineResult,
): AnalysisResult['derived_interpretations'] {
  const metadata = dashboardMetadataRecord(pipeline.dashboard);
  if (!metadata) return [];
  const generatedAt = new Date().toISOString();
  const provenance = (extra: Record<string, unknown> = {}) => ({
    source_ids: [source.id],
    source_categories: ['genetics' as const],
    source_type: 'derived' as const,
    engine: 'bundled analyze-health pipeline',
    generated_at: generatedAt,
    ...extra,
  });
  const base = (type: string, title: string, summary: string, action: string, status: string, raw: Record<string, unknown>, score?: number, extraProvenance?: Record<string, unknown>) => ({
    id: createId('der'),
    user_id: analysis.user_id,
    organization_id: analysis.organization_id,
    analysis_id: analysis.id,
    category: 'genetics' as const,
    type,
    title,
    status,
    ...(score != null ? { score } : {}),
    summary,
    action,
    provenance: provenance(extraProvenance),
    raw,
  });
  const findings: AnalysisResult['derived_interpretations'] = [];

  const variantCards = isRecord(metadata.variant_cards) ? metadata.variant_cards : {};
  for (const { key, type, noun } of VARIANT_FINDING_CATEGORIES) {
    const cards = Array.isArray(variantCards[key]) ? variantCards[key] : [];
    for (const card of cards.slice(0, MAX_VARIANT_FINDINGS_PER_CATEGORY)) {
      if (!isRecord(card)) continue;
      const gene = stringValue(card.gene) ?? '';
      const disease = stringValue(card.disease) ?? '';
      const title = [gene, disease].filter(Boolean).join(' — ') || noun;
      const summary = stringValue(card.annotation)
        ?? `${noun}${gene ? ` in ${gene}` : ''}${disease ? ` associated with ${disease}` : ''}.`;
      findings.push(base(type, title, summary, geneticFindingAction(card), variantFindingStatus(card), {
        ...card,
        consumer_report: geneticFindingConsumerReport(type, summary, geneticFindingAction(card), card),
      }));
    }
  }

  const prsScores = Array.isArray(metadata.prs_scores) ? metadata.prs_scores : [];
  for (const score of prsScores.slice(0, MAX_PRS_FINDINGS)) {
    if (!isRecord(score)) continue;
    const disease = (stringValue(score.disease) ?? 'polygenic trait').replace(/_/g, ' ');
    const summary = stringValue(score.description)
      ?? `Polygenic score for ${disease}: ${stringValue(score.riskLabel) ?? 'reported'}.`;
    findings.push(base(
      'genetic_prs_score',
      `Polygenic risk — ${disease}`,
      summary,
      'Polygenic scores are population-relative context, not a diagnosis. Confirm high-stakes risks with a clinician.',
      'informational',
      {
        ...score,
        consumer_report: geneticFindingConsumerReport(
          'genetic_prs_score',
          summary,
          'Polygenic scores are population-relative context, not a diagnosis. Confirm high-stakes risks with a clinician.',
          score,
        ),
      },
      numberValue(score.percentile),
    ));
  }

  // Condition-catalog findings: conditions whose gene panels the genome matched
  // (carrier status, disease risk). Drop the potentially large panel_genes array
  // from the stored copy to bound size; keep its count for context.
  const catalog = metadata.condition_catalog_findings;
  const modalities = isRecord(catalog) && isRecord(catalog.modalities) ? catalog.modalities : undefined;
  if (modalities) {
    for (const [modality, entries] of Object.entries(modalities)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries.slice(0, MAX_CONDITION_FINDINGS_PER_MODALITY)) {
        if (!isRecord(entry)) continue;
        const name = stringValue(entry.name);
        if (!name) continue;
        const panelGenes = Array.isArray(entry.panel_genes) ? entry.panel_genes.length : undefined;
        // The full panel_genes array can be large, so drop it for size, but keep
        // the matched genes (the ones this genome actually has variants in) as
        // evidence rather than discarding all gene context.
        const matchedGenes = Array.isArray(entry.matched_genes)
          ? (entry.matched_genes as unknown[]).filter((g): g is string => typeof g === 'string' && Boolean(g)).slice(0, 50)
          : [];
        const { panel_genes: _omitted, ...rest } = entry;
        if (matchedGenes.length) (rest as Record<string, unknown>).genes = matchedGenes;
        findings.push(base(
          'genetic_condition_catalog_match',
          name,
          `Condition-catalog match in the ${modality.replace(/-/g, ' ')} modality${panelGenes != null ? ` across ${panelGenes} panel genes` : ''}.`,
          'Catalog matches indicate relevant genes, not a diagnosis. Review carrier or disease-risk findings with a clinician.',
          'informational',
          {
            ...rest,
            ...(panelGenes != null ? { panel_gene_count: panelGenes } : {}),
            consumer_report: geneticFindingConsumerReport(
              'genetic_condition_catalog_match',
              `Condition-catalog match in the ${modality.replace(/-/g, ' ')} modality${panelGenes != null ? ` across ${panelGenes} panel genes` : ''}.`,
              'Catalog matches indicate relevant genes, not a diagnosis. Review carrier or disease-risk findings with a clinician.',
              { ...rest, ...(panelGenes != null ? { panel_gene_count: panelGenes } : {}) },
            ),
          },
          undefined,
          { modality },
        ));
      }
    }
  }

  return findings;
}

function variantFindingStatus(card: Record<string, unknown>): string {
  const significance = `${stringValue(card.clinicalSignificance) ?? ''} ${stringValue(card.confidenceTier) ?? ''}`.toLowerCase();
  if (significance.includes('pathogenic')) return 'action_recommended';
  if (String(card.category) === 'drug_response' || significance.includes('drug')) return 'pharmacogenomic';
  return 'informational';
}

function geneticFindingAction(card: Record<string, unknown>): string {
  if (String(card.category) === 'drug_response') {
    return 'Share this drug-response finding with a clinician or pharmacist before starting or changing a related medication.';
  }
  return 'Educational context. Confirm clinically significant or carrier findings with a qualified clinician or genetic counselor.';
}

// This compact, API-owned view keeps the existing Wellnizz categories and
// generated interpretation text, but gives clients a stable consumer-report
// hierarchy instead of asking every client to reverse-engineer opaque raw data.
// It deliberately does not invent dose changes or references when the pipeline
// has not supplied them.
function geneticFindingConsumerReport(
  findingType: string,
  resultSummary: string,
  action: string,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const gene = stringValue(raw.gene);
  const rsid = stringValue(raw.rsid);
  const limitations = stringArray(raw.limitations);
  const source = isRecord(raw.source) ? raw.source : undefined;
  return {
    schema_version: '1.0',
    category: findingType,
    description: stringValue(raw.consumer_value) ?? stringValue(raw.description) ?? stringValue(raw.annotation),
    result: {
      label: resultSummary,
      explanation: stringValue(raw.annotation),
    },
    evidence: {
      genes: gene ? [gene] : stringArray(raw.genes),
      variants: rsid ? [{
        rsid,
        gene,
        genotype: stringValue(raw.zygosity),
        clinical_significance: stringValue(raw.clinicalSignificance),
        confidence: stringValue(raw.confidenceTier) ?? stringValue(raw.confidenceLabel),
        review_status: stringValue(raw.reviewStatus),
      }] : [],
      coverage: isRecord(raw.coverage) ? raw.coverage : undefined,
      matching: isRecord(raw.matching) ? raw.matching : undefined,
      calibration: isRecord(raw.calibration) ? raw.calibration : undefined,
    },
    action,
    technical: compactTechnicalContext(raw),
    limitations,
    references: source ? [source] : [],
  };
}

function compactTechnicalContext(raw: Record<string, unknown>): Record<string, unknown> {
  const fields = [
    'clinicalSignificance', 'confidenceTier', 'confidenceLabel', 'reviewStatus',
    'calculationState', 'riskLabel', 'coveragePct', 'genomeBuild', 'sourceName', 'sourceRelease',
  ];
  return Object.fromEntries(fields.flatMap(field => raw[field] == null ? [] : [[field, raw[field]]])) as Record<string, unknown>;
}

function dashboardMetadataRecord(dashboard: unknown): Record<string, unknown> | undefined {
  if (!isRecord(dashboard)) return undefined;
  return isRecord(dashboard.metadata) ? dashboard.metadata : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function consumerInsightStatus(insight: GeneticConsumerInsight): string {
  if (insight.calculation_state === 'insufficient_coverage' || insight.calculation_state === 'failed_retryable') return 'reanalysis_recommended';
  if (insight.calculation_state === 'unsupported_model') return 'unsupported';
  if (insight.calculation_state === 'raw_score_only' || insight.calculation_state === 'research_only' || insight.calculation_state === 'not_applicable') return 'informational';
  return 'complete';
}

function consumerInsightAliases(insight: GeneticConsumerInsight): string[] {
  return Array.from(new Set([
    insight.trait_id,
    insight.display_name,
    ...(insight.genes ?? []),
    ...(insight.rsids ?? []),
    ...(insight.trait_id === 'caffeine_clearance' ? ['caffeine metabolism', 'caffeine half life', 'fast caffeine metabolizer', 'slow caffeine metabolizer'] : []),
    ...(insight.trait_id === 'pulmonary_function' ? ['lung capacity', 'FEV1', 'FVC', 'respiratory performance'] : []),
    ...(insight.trait_id === 'aerobic_trainability' ? ['VO2max', 'cardio fitness', 'aerobic response'] : []),
    ...(insight.trait_id === 'grip_strength' ? ['hand strength', 'dynamometer', 'muscular strength', 'healthy aging strength'] : []),
    ...(insight.trait_id === 'lean_body_mass' ? ['lean mass', 'fat free mass', 'body composition', 'muscle mass'] : []),
    ...(insight.trait_id === 'walking_duration' ? ['walking time', 'physical activity', 'daily steps'] : []),
    ...(insight.trait_id === 'sleep_duration' ? ['sleep need', 'sleep length', 'recovery'] : []),
    ...(insight.trait_id === 'chronotype_morningness' ? ['chronotype', 'morning person', 'evening person', 'sleep timing'] : []),
    ...(insight.trait_id === 'fluid_intelligence_score' ? ['fluid reasoning', 'cognitive research', 'cognitive performance', 'intelligence research'] : []),
    ...(insight.trait_id === 'loneliness' ? ['social connection research', 'loneliness research'] : []),
    ...(insight.trait_id === 'friendship_satisfaction' ? ['friendship research', 'social satisfaction research'] : []),
    ...(insight.trait_id === 'neuroticism' ? ['personality research', 'emotional trait research'] : []),
  ]));
}

export async function enqueueGeneticAnalysisJob(
  analysis: AnalysisResult,
  source: RawSourceReference,
  store: HealthStore,
  annotationDepth?: GeneticsAnnotationDepth,
): Promise<GeneticAnalysisJob> {
  const now = new Date().toISOString();
  const job: GeneticAnalysisJob = {
    id: createId('wgsjob'),
    user_id: analysis.user_id,
    organization_id: analysis.organization_id,
    analysis_id: analysis.id,
    source_id: source.id,
    annotation_depth: annotationDepth,
    status: 'queued',
    stage: 'queued',
    progress_pct: 0,
    progress_message: 'Waiting for the dedicated WGS worker.',
    attempts: 0,
    max_attempts: Number(healthAnalysisEnv('MAX_ATTEMPTS') ?? '3'),
    priority: Number(healthAnalysisEnv('QUEUE_PRIORITY') ?? '0'),
    created_at: now,
    updated_at: now,
  };
  await store.createGeneticAnalysisJob(job);
  return job;
}

function upsertGeneticQueuedInterpretation(
  analysis: AnalysisResult,
  source: RawSourceReference,
  job: GeneticAnalysisJob,
): AnalysisResult {
  const interpretation = {
    id: createId('der'),
    user_id: analysis.user_id,
    organization_id: analysis.organization_id,
    analysis_id: analysis.id,
    category: 'genetics' as const,
    type: 'genetic_pipeline_queued',
    title: 'Genetic analysis queued',
    status: 'queued',
    summary: 'The genetic source was accepted and queued for WGS/SNP-array interpretation by the hosted worker.',
    action: 'Wait for the WGS worker to complete, then re-read the analysis or dashboard spec.',
    provenance: {
      source_ids: [source.id],
      source_categories: ['genetics' as const],
      source_type: 'queued' as const,
      engine: 'health-api health analysis queue',
      generated_at: new Date().toISOString(),
    },
    raw: {
      job_id: job.id,
      status: job.status,
      stage: job.stage,
      progress_pct: job.progress_pct,
      progress_message: job.progress_message,
      attempts: job.attempts,
      max_attempts: job.max_attempts,
    },
  };
  removeGeneticCardsAndInterpretations(analysis, source.id);
  analysis.derived_interpretations.push(interpretation);
  analysis.dashboard_spec.cards.unshift({
    id: interpretation.id,
    title: interpretation.title,
    category: 'genetics',
    status: interpretation.status,
    summary: interpretation.summary,
    action: interpretation.action,
  });
  return analysis;
}

function removeGeneticCardsAndInterpretations(analysis: AnalysisResult, sourceId: string): void {
  const removedIds = new Set<string>();
  analysis.derived_interpretations = analysis.derived_interpretations.filter(item => {
    const remove = item.category === 'genetics' && item.provenance.source_ids.includes(sourceId);
    if (remove) removedIds.add(item.id);
    return !remove;
  });
  analysis.dashboard_spec.cards = analysis.dashboard_spec.cards.filter(card => !removedIds.has(card.id));
}

function actionForPipelineStatus(status: 'complete' | 'setup_required' | 'failed'): string {
  if (status === 'complete') return 'Review genetic findings with biomarker and wearable context. Treat clinical or medication findings as educational until confirmed by a qualified clinician.';
  if (status === 'setup_required') return 'Configure HEALTH_ANALYSIS_SKILL_DIR and durable genetic payload storage before running backend genetic interpretation in production.';
  return 'Inspect the pipeline error and run npm run doctor:vcf from the bundled analyze-health skill directory against the uploaded file.';
}

function geneticSummary(raw: Record<string, unknown> | undefined): string {
  if (!raw) return 'The uploaded genetic file was processed by the analyze-health pipeline.';
  const parts = [
    raw.gli != null ? `GLI ${raw.gli}${raw.gli_rating ? ` (${raw.gli_rating})` : ''}` : undefined,
    raw.variant_count != null ? `${raw.variant_count} variants` : undefined,
    raw.matched_marker_count != null ? `${raw.matched_marker_count} matched markers` : undefined,
    raw.cpic_actionable != null ? `${raw.cpic_actionable} CPIC matches` : undefined,
    raw.clinvar_pathogenic != null ? `${raw.clinvar_pathogenic} ClinVar pathogenic findings` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('; ') : 'The uploaded genetic file was processed by the analyze-health pipeline.';
}

function healthAnalysisEnv(name: string): string | undefined {
  return process.env[`HEALTH_ANALYSIS_${name}`] ?? process.env[`GENOMIC_ANALYSIS_${name}`];
}

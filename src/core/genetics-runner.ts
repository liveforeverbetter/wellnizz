import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GeneticAnalysisJobStage, GeneticsAnnotationDepth, RawSourceReference } from '../types.js';
import { normalizeGeneticsDashboard, type ConsumerGeneticsSection } from './genetic-insights.js';
import { scoreBundledPositionAwarePgs } from './pgs-position-scorer.js';
import type { PgsPopulationSimilarity } from './pgs-calibration.js';
import { buildGeneticSliceIndex } from './genetic-slice.js';

export interface GeneticsPipelineResult {
  status: 'complete' | 'setup_required' | 'failed';
  summary: string;
  dashboard?: unknown;
  dashboard_json_path?: string;
  dashboard_html_path?: string;
  raw?: {
    gli?: number;
    gli_rating?: string;
    trait_count?: number;
    insight_count?: number;
    protocol_count?: number;
    variant_count?: number;
    annotated_count?: number;
    matched_marker_count?: number;
    prs_count?: number;
    cpic_actionable?: number;
    clinvar_pathogenic?: number;
    annotation_depth_requested?: GeneticsAnnotationDepth;
    annotation_depth_used?: GeneticsAnnotationDepth;
    rsid_annotation_source?: string;
    rsid_extraction_method?: 'bcftools' | 'text_fallback';
    rsid_extraction_fallback_reason?: string;
    consumer_genetics?: ConsumerGeneticsSection['summary'] & {
      interpretation_release: string;
    };
  };
}

export interface FullAnalysisArtifactRef {
  object_key: string;
  bytes: number;
  storage?: string;
}

export interface GeneticsPipelineOptions {
  annotation_depth?: GeneticsAnnotationDepth;
  onProgress?: (progress: { stage: GeneticAnalysisJobStage; progress_pct: number; progress_message: string }) => void | Promise<void>;
  /**
   * Persists the COMPLETE (pre-compaction) analysis to durable storage before
   * the inline payload is bounded, so nothing is dropped. Runs on the WGS
   * worker (which has memory headroom); the 1 GB API server must never load
   * this blob wholesale. Returns the stored artifact reference, which is
   * recorded in `persistence_compaction.full_artifact` so read paths can fetch
   * the tail on demand. When omitted, behaviour is unchanged.
   */
  saveFullArtifact?: (body: Buffer) => Promise<FullAnalysisArtifactRef | undefined>;
  /**
   * Restores a previously cached dbSNP-annotated VCF into the given path (the
   * sibling the pipeline reuses), letting the run skip the multi-hour bcftools
   * annotation. Returns true when a cached annotation was restored.
   */
  restoreAnnotatedVcf?: (destinationPath: string) => Promise<boolean>;
  /**
   * Persists the freshly produced dbSNP-annotated VCF for reuse. Called even
   * when a later pipeline step fails, so the expensive annotation is never lost.
   */
  saveAnnotatedVcf?: (filePath: string) => Promise<void>;
  /** Produced by the dedicated pgsc_calc PRS process; never inferred from the 91-marker ancestry endpoint. */
  pgsPopulationSimilarity?: PgsPopulationSimilarity;
  /** When aborted, kills the current subprocess and rejects with an AbortError so the caller can requeue cleanly. */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_FULL_DBSNP_TIMEOUT_MS = 14_400_000;
const COMMAND_OUTPUT_TAIL_BYTES = 256 * 1024;
const INLINE_UNCOMMON_MUTATION_LIMIT = 0;
// Condition-catalog findings are the actionable, bounded collections (carrier
// status, disease risk, pharmacogenomic conditions) a WGS user actually wants,
// typically low hundreds per modality. Keep them inline rather than truncating
// to a token sample; only the exploratory uncommon-mutation tail stays out of
// the inline payload. The cap guards against a pathological genome producing a
// multi-megabyte inline result, and omitted counts remain for on-demand paging.
const INLINE_CONDITION_ENTRIES_PER_MODALITY = 500;
const DEFAULT_BUNDLED_SKILL_DIR = 'vendor/health-analysis-skill';
const LEGACY_SKILL_DIR = '../open-source/skills/genomic-analysis';

/** Minimal structural store surface the resume helper needs; avoids importing HealthStore here. */
export interface GeneticsCheckpointStore {
  getGeneticAnalysisCheckpoint(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined): Promise<unknown | undefined>;
  saveGeneticAnalysisCheckpoint(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined, result: unknown): Promise<void>;
}

function isCompletePipelineResult(value: unknown): value is GeneticsPipelineResult {
  return isRecord(value) && value.status === 'complete';
}

/**
 * Run the genetics pipeline, or resume from a durable checkpoint if the
 * expensive compute already completed on a previous attempt whose persistence
 * failed. On a fresh completed run, the result is checkpointed BEFORE the caller
 * attempts the fragile analysis/job DB writes, so those writes can be retried
 * without ever re-running the multi-hour annotation. A checkpoint write failure
 * is non-fatal: the in-memory result is still persisted normally.
 */
export async function resolveGeneticsPipeline(
  store: GeneticsCheckpointStore,
  job: { source_id: string; annotation_depth?: GeneticsAnnotationDepth },
  run: () => Promise<GeneticsPipelineResult>,
  hooks: {
    onResume?: () => void;
    onCheckpointSaved?: () => void;
    onCheckpointError?: (error: unknown) => void;
  } = {},
): Promise<{ pipeline: GeneticsPipelineResult; resumedFromCheckpoint: boolean }> {
  const checkpoint = await store.getGeneticAnalysisCheckpoint(job.source_id, job.annotation_depth).catch(() => undefined);
  if (isCompletePipelineResult(checkpoint)) {
    hooks.onResume?.();
    return { pipeline: checkpoint, resumedFromCheckpoint: true };
  }
  const pipeline = await run();
  if (pipeline.status === 'complete') {
    try {
      await store.saveGeneticAnalysisCheckpoint(job.source_id, job.annotation_depth, pipeline);
      hooks.onCheckpointSaved?.();
    } catch (error) {
      hooks.onCheckpointError?.(error);
    }
  }
  return { pipeline, resumedFromCheckpoint: false };
}

export async function runGeneticsPipeline(
  userId: string,
  source: RawSourceReference,
  payload: Buffer | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: GeneticsPipelineOptions = {},
): Promise<GeneticsPipelineResult> {
  if (!payload) {
    return {
      status: 'setup_required',
      summary: 'Genetic source payload is not available in the backend store. Configure durable object storage before asynchronous genetic analysis.',
    };
  }

  const uploadedPayload = payload;
  return runGeneticsPipelineWithWriter(userId, source, inputPath => fs.writeFile(inputPath, uploadedPayload), env, options);
}

export async function runGeneticsPipelineWithWriter(
  userId: string,
  source: RawSourceReference,
  writePayload: (inputPath: string) => Promise<boolean | void>,
  env: NodeJS.ProcessEnv = process.env,
  options: GeneticsPipelineOptions = {},
): Promise<GeneticsPipelineResult> {

  const skillDir = await resolveHealthAnalysisSkillDir(env);
  if (!await exists(path.join(skillDir, 'scripts/pipeline/index.ts'))) {
    return {
      status: 'setup_required',
      summary: `HEALTH_ANALYSIS_SKILL_DIR does not point to the bundled analyze-health skill: ${skillDir}`,
    };
  }

  const timeoutMs = geneticsPipelineTimeoutMs(env, options);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'health-api-genetics-'));
  const safeName = safeFilename(source.filename ?? `${source.id}.vcf`);
  const inputPath = path.join(tempDir, safeName);
  const outputDir = path.join(tempDir, 'output');
  await fs.mkdir(outputDir, { recursive: true });
  const wrotePayload = await writePayload(inputPath);
  if (wrotePayload === false) {
    return {
      status: 'setup_required',
      summary: 'Genetic source payload is not available in the backend store. Configure durable object storage before asynchronous genetic analysis.',
    };
  }

  if (options.annotation_depth === 'full_dbsnp' && !env.HEALTH_ANALYSIS_DBSNP_GRCH37_PATH) {
    return {
      status: 'setup_required',
      summary: 'Full dbSNP analysis was requested, but HEALTH_ANALYSIS_DBSNP_GRCH37_PATH is not configured. Configure the indexed GRCh37 reference, then submit a new analysis for this source.',
      raw: {
        annotation_depth_requested: 'full_dbsnp',
      },
    };
  }

  // The bundled pipeline reuses an annotated sibling named
  // `<basename>.annotated.vcf.gz` next to the input (parse-vcf analyzeVCF). If a
  // cached annotation exists for this source+depth, restore it there so the run
  // skips the multi-hour bcftools annotation entirely.
  const annotatedSiblingPath = path.join(tempDir, `${path.basename(inputPath, path.extname(inputPath))}.annotated.vcf.gz`);
  let restoredAnnotation = false;
  if (options.restoreAnnotatedVcf) {
    try {
      restoredAnnotation = await options.restoreAnnotatedVcf(annotatedSiblingPath);
      if (restoredAnnotation) {
        await options.onProgress?.({ stage: 'annotating_variants', progress_pct: 45, progress_message: 'Reusing the previously annotated genome; skipping dbSNP annotation.' });
      }
    } catch (restoreError) {
      restoredAnnotation = false;
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        event: 'annotated_vcf_restore_failed',
        user_id: userId,
        source_id: source.id,
        error: restoreError instanceof Error ? restoreError.message : String(restoreError),
      }));
    }
  }

  const commandArgs = buildGeneticsPipelineArgs(userId, inputPath, outputDir, env, options);
  const tsxCommand = env.TSX_BIN ?? path.resolve(process.cwd(), 'node_modules/.bin/tsx');
  await options.onProgress?.({ stage: 'annotating_variants', progress_pct: 10, progress_message: restoredAnnotation ? 'Loading the cached annotated genome.' : 'Normalizing the VCF and annotating variants.' });
  const result = await runCommand(tsxCommand, commandArgs, skillDir, timeoutMs, options.onProgress, options.signal);
  // Preserve the freshly annotated VCF for reuse BEFORE checking exit code, so a
  // failure in a later pipeline step (e.g. dashboard transform) never discards
  // the expensive annotation. Only save what we did not just restore from cache.
  if (!restoredAnnotation && options.saveAnnotatedVcf && await exists(annotatedSiblingPath)) {
    try {
      await options.saveAnnotatedVcf(annotatedSiblingPath);
      console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'annotated_vcf_cached', user_id: userId, source_id: source.id }));
    } catch (saveError) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        event: 'annotated_vcf_cache_failed',
        user_id: userId,
        source_id: source.id,
        error: saveError instanceof Error ? saveError.message : String(saveError),
      }));
    }
  }
  if (result.exitCode !== 0) {
    return {
      status: 'failed',
      summary: `Genomic analysis pipeline failed with exit code ${result.exitCode}: ${lastLines(result.stderr || result.stdout)}`,
      raw: {},
    };
  }

  const dashboardJsonPath = path.join(outputDir, `${userId}_dashboard.json`);
  const dashboard = await readJson(dashboardJsonPath);
  if (options.annotation_depth === 'full_dbsnp' && env.HEALTH_ANALYSIS_DBSNP_GRCH37_PATH && isRecord(dashboard)) {
    const registryDir = env.HEALTH_ANALYSIS_PGS_REGISTRY_DIR ?? path.resolve(process.cwd(), 'data/genetics/pgs');
    if (await exists(path.join(registryDir, 'manifest.json'))) {
      await options.onProgress?.({ stage: 'polygenic_scoring', progress_pct: 89, progress_message: 'Matching position- and allele-aware consumer performance scores.' });
      try {
        const calibrationRegistryPath = env.HEALTH_ANALYSIS_PGS_CALIBRATION_PATH
          ?? path.join(registryDir, 'calibration.json');
        const positionScores = await scoreBundledPositionAwarePgs(
          inputPath,
          env.HEALTH_ANALYSIS_DBSNP_GRCH37_PATH,
          registryDir,
          {
            ...(await exists(calibrationRegistryPath) ? { calibrationRegistryPath } : {}),
            populationSimilarity: options.pgsPopulationSimilarity,
          },
        );
        const metadata = isRecord(dashboard.metadata) ? dashboard.metadata : {};
        const existingScores = Array.isArray(metadata.prs_scores) ? metadata.prs_scores : [];
        const replacedIds = new Set(positionScores.scores.map(score => score.sourceId));
        metadata.prs_scores = [
          ...existingScores.filter(score => !isRecord(score) || !replacedIds.has(String(score.sourceId ?? score.pgsId ?? ''))),
          ...positionScores.scores,
        ];
        metadata.api_pgs_scoring = {
          registry_release: positionScores.registry_release,
          score_count: positionScores.scores.length,
          errors: positionScores.errors,
          matching_method: 'normalized_grch37_position_and_alleles',
          reference_inference_policy: 'dbsnp_reference_plus_variant_only_wgs_assumption',
          calibration_registry: await exists(calibrationRegistryPath) ? calibrationRegistryPath : null,
          population_similarity: options.pgsPopulationSimilarity ?? null,
          percentile_policy: 'empirical_MostSimilarPop_only_when_panel_model_build_coverage_and_population_assignment_match',
        };
        dashboard.metadata = metadata;
      } catch (pgsError) {
        const metadata = isRecord(dashboard.metadata) ? dashboard.metadata : {};
        metadata.api_pgs_scoring = {
          status: 'failed_retryable',
          error: pgsError instanceof Error ? pgsError.message : String(pgsError),
          reanalysis_recommended: true,
        };
        dashboard.metadata = metadata;
        console.warn(JSON.stringify({
          ts: new Date().toISOString(),
          event: 'position_aware_pgs_scoring_failed',
          user_id: userId,
          source_id: source.id,
          error: pgsError instanceof Error ? pgsError.message : String(pgsError),
        }));
      }
    }
  }
  await options.onProgress?.({ stage: 'consumer_interpretation', progress_pct: 92, progress_message: 'Building calibrated-safe consumer health and optimization interpretations.' });
  const consumerGenetics = normalizeGeneticsDashboard(dashboard);
  // Build the compact gene/rsID slice index from the full dashboard variant cards
  // and curated interpretations before the inline payload is bounded. This lets
  // targeted queries like "do I carry anything in gene BRCA1" answer without
  // downloading the full analysis artifact.
  const sliceIndex = buildGeneticSliceIndex(dashboard);
  if (sliceIndex && isRecord(dashboard) && isRecord(dashboard.metadata)) {
    dashboard.metadata.genetic_slice_index = sliceIndex;
  }
  const raw = summarizeDashboard(dashboard);
  raw.consumer_genetics = {
    ...consumerGenetics.summary,
    interpretation_release: consumerGenetics.interpretation_release,
  };
  // Persist the complete analysis before bounding the inline payload, so the
  // dropped tail is never lost. Failure here must not fail the analysis: the
  // bounded inline result is still valid and useful on its own.
  let fullArtifact: FullAnalysisArtifactRef | undefined;
  if (options.saveFullArtifact) {
    try {
      await options.onProgress?.({ stage: 'persisting_results', progress_pct: 95, progress_message: 'Saving the complete analysis and compact query results.' });
      const body = Buffer.from(JSON.stringify(dashboard));
      fullArtifact = await options.saveFullArtifact(body);
    } catch (artifactError) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        event: 'full_analysis_artifact_save_failed',
        user_id: userId,
        source_id: source.id,
        error: artifactError instanceof Error ? artifactError.message : String(artifactError),
      }));
    }
  }
  const persistedDashboard = compactGeneticsDashboardForPersistence(dashboard, fullArtifact);
  const fallback = rsidExtractionFallback(result.stderr);
  if (fallback) {
    raw.rsid_extraction_method = 'text_fallback';
    raw.rsid_extraction_fallback_reason = fallback;
    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      event: 'wgs_rsid_extraction_fallback',
      user_id: userId,
      source_id: source.id,
      bcftools_error: fallback,
    }));
  } else {
    raw.rsid_extraction_method ??= 'bcftools';
  }
  raw.annotation_depth_requested = options.annotation_depth ?? 'compact';
  raw.annotation_depth_used = options.annotation_depth === 'full_dbsnp' ? 'full_dbsnp' : 'compact';
  return {
    status: 'complete',
    summary: fallback
      ? 'Health analysis completed with the text VCF parser after the bcftools rsID query failed. Interpreted results are available now; the original query error is recorded so this source can be reanalyzed after the worker is repaired.'
      : 'Health analysis completed using the bundled analyze-health pipeline.',
    dashboard: persistedDashboard,
    dashboard_json_path: dashboardJsonPath,
    dashboard_html_path: path.join(outputDir, 'index.html'),
    raw,
  };
}

/**
 * The rendered WGS dashboard can contain tens of thousands of low-priority
 * variant cards. Embedding all of them in the analysis JSON makes routine API
 * reads allocate hundreds of megabytes while parsing JSON. Keep every
 * actionable clinical/drug/risk card and the complete trait/PRS summaries,
 * while bounding the large exploratory and condition-catalog collections.
 * Exact omitted counts remain in the payload so clients can explain the
 * bounded inline view and request a future artifact-backed deep dive.
 */
export function compactGeneticsDashboardForPersistence(
  dashboard: unknown,
  fullArtifact?: FullAnalysisArtifactRef,
): unknown {
  if (!isRecord(dashboard)) return dashboard;
  const metadata = isRecord(dashboard.metadata) ? dashboard.metadata : {};
  const variantCards = isRecord(metadata.variant_cards) ? metadata.variant_cards : {};
  const uncommonMutations = Array.isArray(variantCards.uncommon_mutations)
    ? variantCards.uncommon_mutations
    : [];
  const conditionMatches = compactConditionCatalog(metadata.condition_catalog_matches);
  const conditionFindings = compactConditionCatalog(metadata.condition_catalog_findings);

  return {
    ...dashboard,
    metadata: {
      ...metadata,
      variant_cards: {
        ...variantCards,
        uncommon_mutations: uncommonMutations.slice(0, INLINE_UNCOMMON_MUTATION_LIMIT),
      },
      condition_catalog_matches: conditionMatches.value,
      condition_catalog_findings: conditionFindings.value,
      persistence_compaction: {
        version: 2,
        reason: 'Large exploratory WGS collections are bounded in the inline API result; actionable clinical, drug-response, risk, trait, insight, protocol, and PRS results are retained. The complete analysis is preserved in the full_artifact when durable object storage is configured.',
        limits: {
          uncommon_mutations: INLINE_UNCOMMON_MUTATION_LIMIT,
          condition_entries_per_modality: INLINE_CONDITION_ENTRIES_PER_MODALITY,
        },
        omitted: {
          uncommon_mutations: Math.max(0, uncommonMutations.length - INLINE_UNCOMMON_MUTATION_LIMIT),
          condition_catalog_matches: conditionMatches.omitted,
          condition_catalog_findings: conditionFindings.omitted,
        },
        // Reference to the complete, uncompacted analysis in durable storage.
        // Absent when object storage is not configured (e.g. local dev).
        full_artifact: fullArtifact ?? null,
      },
    },
  };
}

function compactConditionCatalog(value: unknown): { value: unknown; omitted: Record<string, number> } {
  if (!isRecord(value) || !isRecord(value.modalities)) return { value, omitted: {} };
  const omitted: Record<string, number> = {};
  const modalities = Object.fromEntries(Object.entries(value.modalities).map(([name, entries]) => {
    if (!Array.isArray(entries)) return [name, entries];
    omitted[name] = Math.max(0, entries.length - INLINE_CONDITION_ENTRIES_PER_MODALITY);
    return [name, entries.slice(0, INLINE_CONDITION_ENTRIES_PER_MODALITY)];
  }));
  return { value: { ...value, modalities }, omitted };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function geneticsPipelineTimeoutMs(
  env: NodeJS.ProcessEnv,
  options: GeneticsPipelineOptions,
): number {
  const fallback = options.annotation_depth === 'full_dbsnp'
    ? DEFAULT_FULL_DBSNP_TIMEOUT_MS
    : DEFAULT_TIMEOUT_MS;
  const configured = options.annotation_depth === 'full_dbsnp'
    ? env.HEALTH_ANALYSIS_FULL_DBSNP_TIMEOUT_MS
    : env.HEALTH_ANALYSIS_TIMEOUT_MS ?? env.GENOMIC_ANALYSIS_TIMEOUT_MS;
  const value = Number(configured ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function buildGeneticsPipelineArgs(
  userId: string,
  inputPath: string,
  outputDir: string,
  env: NodeJS.ProcessEnv,
  options: GeneticsPipelineOptions,
): string[] {
  const args = [
    'scripts/pipeline/index.ts',
    `--genetics=${inputPath}`,
    `--user=${userId}`,
    `--out=${outputDir}`,
  ];
  const dbsnpPath = env.HEALTH_ANALYSIS_DBSNP_GRCH37_PATH;
  if (options.annotation_depth === 'full_dbsnp' && dbsnpPath) {
    // The bundled CLI contract is --dbsnp. Passing --annotation-depth or
    // --dbsnp-path causes it to reject the job before analysis starts.
    args.push(`--dbsnp=${dbsnpPath}`);
  }
  return args;
}

async function resolveHealthAnalysisSkillDir(env: NodeJS.ProcessEnv): Promise<string> {
  if (env.HEALTH_ANALYSIS_SKILL_DIR) return path.resolve(env.HEALTH_ANALYSIS_SKILL_DIR);
  if (env.GENOMIC_ANALYSIS_SKILL_DIR) return path.resolve(env.GENOMIC_ANALYSIS_SKILL_DIR);

  const bundled = path.resolve(DEFAULT_BUNDLED_SKILL_DIR);
  if (await exists(path.join(bundled, 'scripts/pipeline/index.ts'))) return bundled;

  return path.resolve(LEGACY_SKILL_DIR);
}

export function appendCommandOutputTail(current: string, chunk: Buffer | string, maxBytes = COMMAND_OUTPUT_TAIL_BYTES): string {
  const next = Buffer.from(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  const existing = Buffer.from(current);
  if (next.length >= maxBytes) return next.subarray(next.length - maxBytes).toString('utf8');
  const keepExistingBytes = Math.max(0, maxBytes - next.length);
  const keptExisting = existing.length > keepExistingBytes
    ? existing.subarray(existing.length - keepExistingBytes)
    : existing;
  return Buffer.concat([keptExisting, next]).toString('utf8');
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  onProgress?: GeneticsPipelineOptions['onProgress'],
  signal?: AbortSignal,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('Aborted')); return; }
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let progressWrites = Promise.resolve();
    let settled = false;
    const finish = (result: { exitCode: number | null; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      void progressWrites.finally(() => resolve(result));
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      stderr = appendCommandOutputTail(stderr, `\nTimed out after ${timeoutMs}ms.`);
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      process.stdout.write(chunk);
      stdout = appendCommandOutputTail(stdout, chunk);
      const progress = progressFromPipelineOutput(chunk.toString('utf8'));
      if (progress && onProgress) {
        progressWrites = progressWrites.then(() => onProgress(progress)).catch(error => {
          console.warn(JSON.stringify({ event: 'genetics_job_progress_update_failed', error: error instanceof Error ? error.message : String(error) }));
        });
      }
    });
    child.stderr.on('data', chunk => {
      process.stderr.write(chunk);
      stderr = appendCommandOutputTail(stderr, chunk);
    });
    child.on('close', exitCode => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      finish({ exitCode, stdout, stderr });
    });
    child.on('error', error => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      finish({ exitCode: 1, stdout, stderr: appendCommandOutputTail(stderr, `\n${error.message}`) });
    });
  });
}

export function progressFromPipelineOutput(output: string): { stage: GeneticAnalysisJobStage; progress_pct: number; progress_message: string } | undefined {
  const text = output.toLowerCase();
  if (text.includes('pipeline complete')) return { stage: 'consumer_interpretation', progress_pct: 88, progress_message: 'Core genomic analysis complete; preparing consumer interpretations.' };
  if (text.includes('prs:') || text.includes('polygenic risk')) return { stage: 'polygenic_scoring', progress_pct: 80, progress_message: 'Calculating polygenic health and optimization scores.' };
  if (text.includes('cpic') || text.includes('clinvar') || text.includes('step 5b')) return { stage: 'clinical_interpretation', progress_pct: 65, progress_message: 'Interpreting clinical and pharmacogenomic evidence.' };
  if (text.includes('extracting all rsids') || text.includes('genotype map')) return { stage: 'extracting_genotypes', progress_pct: 50, progress_message: 'Extracting genotypes for trait and score matching.' };
  if (text.includes('annotat') || text.includes('step 2') || text.includes('step 3')) return { stage: 'annotating_variants', progress_pct: 30, progress_message: 'Annotating variants against configured reference data.' };
  return undefined;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
}

function summarizeDashboard(dashboard: unknown): NonNullable<GeneticsPipelineResult['raw']> {
  if (!dashboard || typeof dashboard !== 'object') return {};
  const record = dashboard as Record<string, unknown>;
  const metadata = record.metadata && typeof record.metadata === 'object' ? record.metadata as Record<string, unknown> : {};
  return {
    gli: numberValue(record.gli),
    gli_rating: stringValue(record.gli_rating),
    trait_count: numberValue(metadata.trait_count),
    insight_count: numberValue(metadata.insight_count),
    protocol_count: numberValue(metadata.protocol_count),
    variant_count: numberValue(metadata.variant_count),
    annotated_count: numberValue(metadata.annotated_count),
    matched_marker_count: numberValue(metadata.matched_marker_count),
    prs_count: Array.isArray(metadata.prs_scores) ? metadata.prs_scores.length : undefined,
    cpic_actionable: numberValue(metadata.cpic_actionable),
    clinvar_pathogenic: numberValue(metadata.clinvar_pathogenic),
    rsid_annotation_source: stringValue(metadata.rsid_annotation_source),
    rsid_extraction_method: extractionMethodValue(metadata.rsid_extraction_method),
    rsid_extraction_fallback_reason: stringValue(metadata.rsid_extraction_fallback_reason),
  };
}

function rsidExtractionFallback(stderr: string): string | undefined {
  const prefix = '[vcf-rsid-extraction-fallback] ';
  for (const line of stderr.split(/\r?\n/)) {
    const start = line.indexOf(prefix);
    if (start < 0) continue;
    try {
      const payload = JSON.parse(line.slice(start + prefix.length)) as { reason?: unknown };
      if (typeof payload.reason === 'string' && payload.reason.trim()) return payload.reason;
    } catch {
      // Preserve the raw marker text if a future bundled parser changes shape.
      const raw = line.slice(start + prefix.length).trim();
      if (raw) return raw;
    }
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function extractionMethodValue(value: unknown): 'bcftools' | 'text_fallback' | undefined {
  return value === 'bcftools' || value === 'text_fallback' ? value : undefined;
}

function safeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160) || 'genetic-upload.vcf';
}

function lastLines(text: string, lineCount = 8): string {
  return text.split(/\r?\n/).filter(Boolean).slice(-lineCount).join('\n');
}

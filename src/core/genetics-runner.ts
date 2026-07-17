import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GeneticsAnnotationDepth, RawSourceReference } from '../types.js';

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
  };
}

export interface GeneticsPipelineOptions {
  annotation_depth?: GeneticsAnnotationDepth;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_FULL_DBSNP_TIMEOUT_MS = 14_400_000;
const DEFAULT_BUNDLED_SKILL_DIR = 'vendor/health-analysis-skill';
const LEGACY_SKILL_DIR = '../open-source/skills/genomic-analysis';

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

  const commandArgs = buildGeneticsPipelineArgs(userId, inputPath, outputDir, env, options);
  const tsxCommand = env.TSX_BIN ?? path.resolve(process.cwd(), 'node_modules/.bin/tsx');
  const result = await runCommand(tsxCommand, commandArgs, skillDir, timeoutMs);
  if (result.exitCode !== 0) {
    return {
      status: 'failed',
      summary: `Genomic analysis pipeline failed with exit code ${result.exitCode}: ${lastLines(result.stderr || result.stdout)}`,
      raw: {},
    };
  }

  const dashboardJsonPath = path.join(outputDir, `${userId}_dashboard.json`);
  const dashboard = await readJson(dashboardJsonPath);
  const raw = summarizeDashboard(dashboard);
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
    dashboard,
    dashboard_json_path: dashboardJsonPath,
    dashboard_html_path: path.join(outputDir, 'index.html'),
    raw,
  };
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

function runCommand(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      stderr += `\nTimed out after ${timeoutMs}ms.`;
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('close', exitCode => {
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr });
    });
    child.on('error', error => {
      clearTimeout(timeout);
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}` });
    });
  });
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

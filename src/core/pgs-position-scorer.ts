import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import {
  calibratePgsScore,
  loadPgsCalibrationRegistry,
  type PgsCalibrationRegistry,
  type PgsCalibrationResult,
  type PgsDirectionInterpretation,
  type PgsPopulationSimilarity,
} from './pgs-calibration.js';
import { loadOrBuildReferenceAlleleCache } from './pgs-reference-allele-cache.js';

export interface BundledPgsManifestEntry {
  pgs_id: string;
  trait_id: string;
  display_name: string;
  consumer_category: string;
  reporting_policy?: 'consumer_context' | 'research_only_non_directional';
  efo_id?: string;
  genome_build: 'GRCh37' | 'GRCh38';
  scoring_file: string;
  sha256: string;
  variants: number;
  weight_type: string;
  source_url: string;
  publication?: string;
  doi?: string;
  development_ancestry?: string;
  evaluation_ancestry?: string;
  calibration_state: 'raw_score_only';
  direction_interpretation: PgsDirectionInterpretation;
  license?: string;
  limitations: string[];
}

export interface PgsWeightRow {
  rsid?: string;
  chrom: string;
  pos: number;
  effectAllele: string;
  otherAllele?: string;
  effectWeight: number;
}

export interface PositionGenotype {
  chrom: string;
  pos: number;
  ref: string;
  alts: string[];
  gt: string;
}

export interface PositionAwarePgsResult {
  disease: string;
  score: number;
  riskLabel: string;
  percentile: number | null;
  description: string;
  variantsScored: number;
  totalWeightedVariants: number;
  coveragePct: number;
  confidence: 'low' | 'medium';
  confidenceTier: 'prs';
  sourceType: 'pgs_catalog_score';
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  sourceRelease: string;
  consumerCategory: string;
  reportingPolicy: 'consumer_context' | 'research_only_non_directional';
  genomeBuild: string;
  ancestry: string;
  matchingMethod: 'position_allele';
  calculationState: 'reference_relative' | 'raw_score_only' | 'insufficient_coverage' | 'research_only';
  calibration: PgsCalibrationResult | null;
  calibrationUnavailableReason?: string;
  reanalysisRecommended: boolean;
  matchingQc: {
    observed_variant_calls: number;
    inferred_homozygous_reference: number;
    rejected_allele_mismatch: number;
    missing_or_uncallable: number;
    reference_inference_policy: 'dbsnp_reference_plus_variant_only_wgs_assumption';
  };
  provenance: Array<Record<string, unknown>>;
}

interface PgsManifest {
  schema_version: string;
  release: string;
  scores: BundledPgsManifestEntry[];
}

export interface PositionAwarePgsCalibrationOptions {
  calibrationRegistryPath?: string;
  calibrationRegistry?: PgsCalibrationRegistry;
  populationSimilarity?: PgsPopulationSimilarity;
  /**
   * A build established by the annotation workflow rather than the VCF header.
   * This is intentionally a hint, not an override: a conflicting header still
   * fails closed. It is for legacy WGS VCFs whose headers omit a build even
   * though the durable full-dbsNP annotation proves the coordinate system.
   */
  inputGenomeBuildHint?: {
    genomeBuild: 'GRCh37' | 'GRCh38';
    source: string;
  };
}

export async function scoreBundledPositionAwarePgs(
  inputVcf: string,
  dbsnpVcf: string,
  registryDir: string,
  calibrationOptions: PositionAwarePgsCalibrationOptions = {},
): Promise<{
  registry_release: string;
  scores: PositionAwarePgsResult[];
  errors: Array<{ pgs_id: string; error: string }>;
}> {
  const manifest = JSON.parse(await readFile(path.join(registryDir, 'manifest.json'), 'utf8')) as PgsManifest;
  const loaded: Array<{ definition: BundledPgsManifestEntry; rows: PgsWeightRow[] }> = [];
  const errors: Array<{ pgs_id: string; error: string }> = [];
  for (const definition of manifest.scores) {
    try {
      const scorePath = path.join(registryDir, definition.scoring_file);
      await verifySha256(scorePath, definition.sha256);
      loaded.push({ definition, rows: await parsePgsScoringFile(scorePath) });
    } catch (error) {
      errors.push({ pgs_id: definition.pgs_id, error: errorMessage(error) });
    }
  }
  if (loaded.length === 0) return { registry_release: manifest.release, scores: [], errors };

  let calibrationRegistry = calibrationOptions.calibrationRegistry;
  if (!calibrationRegistry && calibrationOptions.calibrationRegistryPath) {
    try {
      calibrationRegistry = await loadPgsCalibrationRegistry(calibrationOptions.calibrationRegistryPath);
    } catch (error) {
      errors.push({ pgs_id: 'calibration_registry', error: errorMessage(error) });
    }
  }

  const inputBuild = resolveVcfGenomeBuild(
    await detectVcfGenomeBuild(inputVcf),
    calibrationOptions.inputGenomeBuildHint,
  );
  if (inputBuild !== 'GRCh37') {
    throw new Error(inputBuild === 'GRCh38'
      ? 'The bundled position-aware score is GRCh37, but the uploaded VCF header identifies GRCh38. Liftover or a GRCh38 score release is required.'
      : 'The uploaded VCF header does not identify GRCh37. Position-aware scoring is withheld rather than assuming a genome build.');
  }

  const allRows = loaded.flatMap(score => score.rows);
  const requestedKeys = new Set(allRows.map(row => positionKey(row.chrom, row.pos)));
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'foreverbetter-pgs-'));
  try {
    let references: Map<string, string>;
    try {
      const cacheResult = await loadOrBuildReferenceAlleleCache(manifest.release, allRows, {
        registryDir,
        dbsnpVcf,
      });
      references = cacheResult.cache;
      if (cacheResult.cache_path) {
        console.warn(JSON.stringify({
          ts: new Date().toISOString(),
          event: 'pgs_reference_allele_cache_used',
          cache_path: cacheResult.cache_path,
          position_count: references.size,
        }));
      }
    } catch (cacheError) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        event: 'pgs_reference_allele_cache_failed',
        error: cacheError instanceof Error ? cacheError.message : String(cacheError),
      }));
      references = await queryDbsnpReferenceAlleles(dbsnpVcf, requestedKeys, tempDir);
    }
    const observed = await queryObservedGenotypes(inputVcf, requestedKeys);
    const scores = loaded.map(({ definition, rows }) => scoreWeightRows(
      definition,
      manifest.release,
      rows,
      observed,
      references,
      calibrationRegistry,
      calibrationOptions.populationSimilarity,
    ));
    return { registry_release: manifest.release, scores, errors };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function scoreWeightRows(
  definition: BundledPgsManifestEntry,
  registryRelease: string,
  rows: PgsWeightRow[],
  observed: Map<string, PositionGenotype>,
  referenceAlleles: Map<string, string>,
  calibrationRegistry?: PgsCalibrationRegistry,
  populationSimilarity?: PgsPopulationSimilarity,
): PositionAwarePgsResult {
  let rawScore = 0;
  let observedCalls = 0;
  let inferredReference = 0;
  let rejectedAlleles = 0;
  let missing = 0;

  for (const row of rows) {
    const key = positionKey(row.chrom, row.pos);
    const call = observed.get(key);
    let alleles: string[] | undefined;
    if (call) {
      alleles = genotypeAlleles(call);
      if (!alleles) {
        missing++;
        continue;
      }
      observedCalls++;
    } else {
      const reference = referenceAlleles.get(key);
      if (!reference || !scoreAlleles(row).has(reference)) {
        missing++;
        continue;
      }
      alleles = [reference, reference];
      inferredReference++;
    }

    const allowed = scoreAlleles(row);
    if (alleles.some(allele => !allowed.has(allele))) {
      rejectedAlleles++;
      continue;
    }
    const dosage = alleles.filter(allele => allele === row.effectAllele).length;
    rawScore += dosage * row.effectWeight;
  }

  const matched = observedCalls + inferredReference - rejectedAlleles;
  const coveragePct = rows.length > 0 ? Math.round((matched / rows.length) * 10_000) / 100 : 0;
  const roundedScore = Math.round(rawScore * 1_000_000) / 1_000_000;
  const reportingPolicy = definition.reporting_policy ?? 'consumer_context';
  const directionInterpretation = reportingPolicy === 'research_only_non_directional'
    ? 'withheld'
    : definition.direction_interpretation;
  const calibrationDecision = calibratePgsScore({
    pgs_id: definition.pgs_id,
    raw_score: roundedScore,
    scoring_file_sha256: definition.sha256,
    genome_build: definition.genome_build,
    weighted_variant_count: rows.length,
    coverage_pct: coveragePct,
    direction_interpretation: directionInterpretation,
    registry: calibrationRegistry,
    similarity: populationSimilarity,
  });
  const calculationState = coveragePct < 95
    ? 'insufficient_coverage'
    : reportingPolicy === 'research_only_non_directional'
      ? 'research_only'
      : calibrationDecision.calibrated ? 'reference_relative' : 'raw_score_only';
  const calibration = calculationState === 'reference_relative' && calibrationDecision.calibrated
    ? calibrationDecision.result
    : null;
  const calibrationReason = !calibrationDecision.calibrated ? calibrationDecision.reason : undefined;
  const percentile = calibration?.percentile ?? null;
  return {
    disease: definition.trait_id,
    score: roundedScore,
    riskLabel: calculationState === 'reference_relative'
      ? referenceRelativeLabel(percentile!, directionInterpretation)
      : calculationState === 'raw_score_only'
        ? 'Raw score only'
        : calculationState === 'research_only' ? 'Research context only' : 'Insufficient coverage',
    percentile,
    description: calculationState === 'reference_relative'
      ? referenceRelativeDescription(percentile!, calibration!, directionInterpretation)
      : calculationState === 'raw_score_only'
        ? `The model was scored by normalized GRCh37 position and alleles. Percentile interpretation is withheld: ${calibrationDecision.calibrated ? 'unknown calibration error' : calibrationReason}`
        : calculationState === 'research_only'
          ? 'The research model was scored by normalized GRCh37 position and alleles. Direction, percentile, and trait prediction are intentionally withheld by reporting policy.'
        : `Only ${matched} of ${rows.length} model variants could be scored after position and allele quality control. No interpretation is returned.`,
    variantsScored: matched,
    totalWeightedVariants: rows.length,
    coveragePct,
    confidence: calculationState === 'reference_relative' ? 'medium' : 'low',
    confidenceTier: 'prs',
    sourceType: 'pgs_catalog_score',
    sourceId: definition.pgs_id,
    sourceName: definition.display_name,
    sourceUrl: definition.source_url,
    sourceRelease: registryRelease,
    consumerCategory: definition.consumer_category,
    reportingPolicy,
    genomeBuild: `${definition.genome_build} harmonized`,
    ancestry: [definition.development_ancestry, definition.evaluation_ancestry].filter(Boolean).join(' | '),
    matchingMethod: 'position_allele',
    calculationState,
    calibration,
    ...(calculationState === 'research_only'
      ? { calibrationUnavailableReason: 'Population ranking is intentionally withheld for this research-only model.' }
      : !calibrationDecision.calibrated ? { calibrationUnavailableReason: calibrationReason } : {}),
    reanalysisRecommended: calculationState === 'raw_score_only' || calculationState === 'insufficient_coverage',
    matchingQc: {
      observed_variant_calls: observedCalls,
      inferred_homozygous_reference: inferredReference,
      rejected_allele_mismatch: rejectedAlleles,
      missing_or_uncallable: missing,
      reference_inference_policy: 'dbsnp_reference_plus_variant_only_wgs_assumption',
    },
    provenance: [{
      source_id: definition.pgs_id,
      source_name: 'PGS Catalog',
      source_url: definition.source_url,
      publication: definition.publication,
      doi: definition.doi,
      efo_id: definition.efo_id,
      genome_build: definition.genome_build,
      weight_type: definition.weight_type,
      direction_interpretation: directionInterpretation,
      consumer_category: definition.consumer_category,
      reporting_policy: reportingPolicy,
      license: definition.license,
      limitations: definition.limitations,
    }],
  };
}

function referenceRelativeLabel(percentile: number, direction: PgsDirectionInterpretation): string {
  const band = percentile >= 80 ? 'Higher' : percentile < 20 ? 'Lower' : 'Typical';
  if (direction === 'higher_liability') return `${band} inherited liability`;
  if (direction === 'higher_trait_value') return `${band} genetic tendency`;
  return `${band} model score`;
}

function referenceRelativeDescription(
  percentile: number,
  calibration: PgsCalibrationResult,
  direction: PgsDirectionInterpretation,
): string {
  const rank = `${percentile.toFixed(1)}th percentile among ${calibration.population_sample_size} unrelated ${calibration.population} reference samples`;
  if (direction === 'higher_liability') return `The score is at the ${rank}; a higher score represents greater inherited liability, not absolute disease risk or a diagnosis.`;
  if (direction === 'higher_trait_value') return `The score is at the ${rank}; a higher score represents a higher genetically predicted trait value, not a measured phenotype.`;
  return `The model score is at the ${rank}. The source does not establish a safe consumer direction, so higher/lower trait interpretation remains withheld.`;
}

export async function parsePgsScoringFile(filePath: string): Promise<PgsWeightRow[]> {
  const input = createReadStream(filePath, 'utf8');
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let headers: string[] | undefined;
  const rows: PgsWeightRow[] = [];
  for await (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    if (!headers) {
      headers = line.split('\t');
      continue;
    }
    const columns = line.split('\t');
    const value = (name: string) => {
      const index = headers!.indexOf(name);
      return index < 0 ? '' : columns[index] ?? '';
    };
    const chrom = normalizeChrom(value('hm_chr') || value('chr_name'));
    const pos = Number(value('hm_pos') || value('chr_position'));
    const effectAllele = value('effect_allele').toUpperCase();
    const otherAllele = (value('other_allele') || value('hm_inferOtherAllele')).split('/')[0].toUpperCase();
    const effectWeight = Number(value('effect_weight'));
    if (!chrom || !Number.isInteger(pos) || pos <= 0 || !effectAllele || !Number.isFinite(effectWeight)) continue;
    rows.push({
      rsid: value('hm_rsID') || value('rsID') || undefined,
      chrom,
      pos,
      effectAllele,
      otherAllele: otherAllele || undefined,
      effectWeight,
    });
  }
  return rows;
}

async function queryObservedGenotypes(inputVcf: string, requestedKeys: Set<string>): Promise<Map<string, PositionGenotype>> {
  const output = new Map<string, PositionGenotype>();
  await forEachBcftoolsLine(['query', '-f', '%CHROM\t%POS\t%REF\t%ALT[\t%GT]\n', inputVcf], line => {
    const [chromRaw, posRaw, ref, alt, gt] = line.split('\t');
    const chrom = normalizeChrom(chromRaw);
    const pos = Number(posRaw);
    const key = positionKey(chrom, pos);
    if (!requestedKeys.has(key) || output.has(key) || !ref || !alt || !gt) return;
    output.set(key, { chrom, pos, ref: ref.toUpperCase(), alts: alt.toUpperCase().split(','), gt: gt.split(':')[0] });
  });
  return output;
}

async function queryDbsnpReferenceAlleles(dbsnpVcf: string, requestedKeys: Set<string>, tempDir: string): Promise<Map<string, string>> {
  const regionPath = path.join(tempDir, 'score-positions.tsv');
  const regions = Array.from(requestedKeys).sort(comparePositionKeys).map(key => {
    const [chrom, pos] = key.split(':');
    // `bcftools -R` expects the tabular form CHROM, FROM, TO. The explicit
    // end keeps this fallback to an exact single-base lookup.
    return `${grch37Contig(chrom)}\t${pos}\t${pos}`;
  }).join('\n');
  await writeFile(regionPath, `${regions}\n`);
  const output = new Map<string, string>();
  await forEachBcftoolsLine(['query', '-R', regionPath, '-f', '%CHROM\t%POS\t%REF\n', dbsnpVcf], line => {
    const [chromRaw, posRaw, ref] = line.split('\t');
    const key = positionKey(normalizeChrom(chromRaw), Number(posRaw));
    if (requestedKeys.has(key) && ref && !output.has(key)) output.set(key, ref.toUpperCase());
  });
  return output;
}

function comparePositionKeys(left: string, right: string): number {
  const [leftChrom, leftPos] = left.split(':');
  const [rightChrom, rightPos] = right.split(':');
  const leftRank = chromosomeRank(leftChrom);
  const rightRank = chromosomeRank(rightChrom);
  return leftRank - rightRank || Number(leftPos) - Number(rightPos);
}

function chromosomeRank(chrom: string): number {
  const normalized = normalizeChrom(chrom);
  if (normalized === 'X') return 23;
  if (normalized === 'Y') return 24;
  if (normalized === 'MT') return 25;
  return Number(normalized);
}

async function detectVcfGenomeBuild(inputVcf: string): Promise<'GRCh37' | 'GRCh38' | 'unknown'> {
  const header: string[] = [];
  await forEachBcftoolsLine(['view', '-h', inputVcf], line => header.push(line));
  return detectGenomeBuildFromVcfHeader(header.join('\n'));
}

export function detectGenomeBuildFromVcfHeader(header: string): 'GRCh37' | 'GRCh38' | 'unknown' {
  const value = header.toLowerCase();
  if (/(grch38|hg38|gcf_000001405\.26|nc_000001\.11)/.test(value)) return 'GRCh38';
  if (/(grch37|hg19|human_g1k_v37|hs37d5|gcf_000001405\.25|nc_000001\.10)/.test(value)) return 'GRCh37';
  return 'unknown';
}

/**
 * Resolve a VCF build without ever letting workflow provenance contradict an
 * explicit header. A hint exists solely to recover legacy files with no build
 * declaration after a verified annotation workflow has established it.
 */
export function resolveVcfGenomeBuild(
  detectedBuild: 'GRCh37' | 'GRCh38' | 'unknown',
  hint?: PositionAwarePgsCalibrationOptions['inputGenomeBuildHint'],
): 'GRCh37' | 'GRCh38' | 'unknown' {
  if (!hint || detectedBuild === hint.genomeBuild) return detectedBuild === 'unknown' ? hint?.genomeBuild ?? 'unknown' : detectedBuild;
  if (detectedBuild === 'unknown') return hint.genomeBuild;
  throw new Error(`The uploaded VCF header identifies ${detectedBuild}, which conflicts with the ${hint.genomeBuild} build established by ${hint.source}. Position-aware scoring is withheld.`);
}

function forEachBcftoolsLine(args: string[], callback: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('bcftools', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', callback);
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_384); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`bcftools ${args[0]} failed with exit ${code}: ${stderr.trim()}`)));
  });
}

function genotypeAlleles(call: PositionGenotype): string[] | undefined {
  const indexes = call.gt.split(/[|/]/);
  if (indexes.length !== 2 || indexes.some(index => index === '.')) return undefined;
  const available = [call.ref, ...call.alts];
  const alleles = indexes.map(index => available[Number(index)]).filter(Boolean);
  return alleles.length === 2 ? alleles : undefined;
}

function scoreAlleles(row: PgsWeightRow): Set<string> {
  return new Set([row.effectAllele, row.otherAllele].filter((value): value is string => Boolean(value)));
}

export function normalizeChrom(chrom: string): string {
  const stripped = chrom.replace(/^chr/i, '').toUpperCase();
  if (stripped === 'NC_012920.1') return 'MT';
  // PGS Catalog harmonized GRCh37 files can use the PLINK `XY` label for
  // pseudoautosomal variants. Those coordinates are represented on chromosome
  // X in the GRCh37 reference queried by this scorer.
  if (stripped === 'XY') return 'X';
  const nc = stripped.match(/^NC_0*(\d+)\./);
  if (nc) {
    const number = Number(nc[1]);
    if (number === 23) return 'X';
    if (number === 24) return 'Y';
    return String(number);
  }
  if (stripped === '23') return 'X';
  if (stripped === '24') return 'Y';
  if (stripped === 'M' || stripped === 'MT') return 'MT';
  return stripped;
}

export function grch37Contig(chrom: string): string {
  const accessions: Record<string, string> = {
    '1': 'NC_000001.10', '2': 'NC_000002.11', '3': 'NC_000003.11', '4': 'NC_000004.11',
    '5': 'NC_000005.9', '6': 'NC_000006.11', '7': 'NC_000007.13', '8': 'NC_000008.10',
    '9': 'NC_000009.11', '10': 'NC_000010.10', '11': 'NC_000011.9', '12': 'NC_000012.11',
    '13': 'NC_000013.10', '14': 'NC_000014.8', '15': 'NC_000015.9', '16': 'NC_000016.9',
    '17': 'NC_000017.10', '18': 'NC_000018.9', '19': 'NC_000019.9', '20': 'NC_000020.10',
    '21': 'NC_000021.8', '22': 'NC_000022.10', X: 'NC_000023.10', Y: 'NC_000024.9',
    MT: 'NC_012920.1',
  };
  const contig = accessions[normalizeChrom(chrom)];
  if (!contig) throw new Error(`Unsupported GRCh37 score contig: ${chrom}`);
  return contig;
}

function positionKey(chrom: string, pos: number): string {
  return `${normalizeChrom(chrom)}:${pos}`;
}

async function verifySha256(filePath: string, expected: string): Promise<void> {
  const body = await readFile(filePath);
  const actual = createHash('sha256').update(body).digest('hex');
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${path.basename(filePath)}: expected ${expected}, got ${actual}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

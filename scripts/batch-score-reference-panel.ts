import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { normalizeChrom, grch37Contig, parsePgsScoringFile, type PgsWeightRow } from '../src/core/pgs-position-scorer.js';
import { PGS_SCORE_ALGORITHM } from '../src/core/pgs-calibration.js';

interface PgsManifestEntry {
  pgs_id: string;
  scoring_file: string;
  sha256: string;
  genome_build: string;
  variants: number;
}

interface PgsManifest {
  release: string;
  scores: PgsManifestEntry[];
}

interface PopulationMetadata {
  sample_id: string;
  super_population: string;
}

/**
 * Batch-score every bundled PGS against every 1kGP+HGDP reference sample.
 *
 * Extracts ALL sample genotypes at scoring positions from multi-sample
 * per-chromosome VCFs in one bcftools call per chromosome. Scores are
 * computed in-memory per sample, per PGS, and written as a TSV for the
 * calibration builder.
 *
 * Usage:
 *   tsx scripts/batch-score-reference-panel.ts \
 *     --vcf-dir /path/to/extracted/panel/reference \
 *     --metadata /path/to/extracted/panel/metadata/sample_information.tsv \
 *     --registry-dir data/genetics/pgs \
 *     --out calibration-scores.tsv
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const vcfDir = required(args, 'vcf-dir');
  const metadataPath = required(args, 'metadata');
  const registryDir = args.get('registry-dir') ?? 'data/genetics/pgs';
  const outPath = required(args, 'out');
  const maxSamples = args.get('max-samples') ? Number(args.get('max-samples')) : undefined;

  const populations = readPopulationMetadata(metadataPath);
  const samples = maxSamples ? populations.slice(0, maxSamples) : populations;
  const sampleIds = new Set(samples.map(s => s.sample_id));
  const samplePopulations = new Map(samples.map(s => [s.sample_id, s.super_population]));

  console.error(JSON.stringify({
    event: 'batch_score_start',
    total_samples_in_panel: populations.length,
    selected_samples: samples.length,
    super_populations: countsBy(samples.map(s => s.super_population)),
  }));

  const manifest = JSON.parse(await readFile(path.join(registryDir, 'manifest.json'), 'utf8')) as PgsManifest;
  const loaded: Array<{ definition: PgsManifestEntry; rows: PgsWeightRow[] }> = [];
  for (const definition of manifest.scores) {
    const scorePath = path.join(registryDir, definition.scoring_file);
    const sha = createHash('sha256').update(readFileSync(scorePath)).digest('hex');
    if (sha !== definition.sha256) throw new Error(`SHA-256 mismatch for ${definition.pgs_id}`);
    loaded.push({ definition, rows: await parsePgsScoringFile(scorePath) });
  }
  console.error(JSON.stringify({ event: 'batch_score_scores_loaded', score_count: loaded.length }));

  const allRows = loaded.flatMap(s => s.rows);
  const positionMeta = new Map<string, { effectAllele: string; otherAllele?: string }>();
  const chromPositions = new Map<string, string[]>();
  for (const row of allRows) {
    const chrom = normalizeChrom(row.chrom);
    const key = `${chrom}:${row.pos}`;
    positionMeta.set(key, {
      effectAllele: row.effectAllele.toUpperCase(),
      otherAllele: row.otherAllele?.toUpperCase(),
    });
    const positions = chromPositions.get(chrom) ?? [];
    positions.push(`${grch37Contig(chrom)}\t${row.pos}`);
    chromPositions.set(chrom, positions);
  }

  const header = 'sample_id\tsuper_population\tpgs_id\tscore\tscore_algorithm\tgenome_build\tweighted_variant_count\tscoring_file_sha256\n';
  const outStream = createWriteStream(outPath);
  outStream.write(header);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'fb-prs-batch-'));
  try {
    const chroms = Array.from(chromPositions.keys());
    for (const chrom of chroms) {
      const regions = chromPositions.get(chrom)!;
      const sortedRegions = Array.from(new Set(regions)).sort();
      const regionPath = path.join(tempDir, `positions-${chrom}.txt`);
      await writeFile(regionPath, `${sortedRegions.join('\n')}\n`);

      const vcfPath = findVcfForChrom(vcfDir, chrom);
      if (!vcfPath) {
        console.error(JSON.stringify({ event: 'batch_score_chrom_missing', chrom }));
        continue;
      }

      console.error(JSON.stringify({ event: 'batch_score_chrom_start', chrom, positions: sortedRegions.length }));
      const genotypes = await queryAllSampleGenotypes(vcfPath, regionPath, sampleIds);
      console.error(JSON.stringify({ event: 'batch_score_chrom_done', chrom, positions_with_data: genotypes.size }));

      const genotypeEntries = Array.from(genotypes.entries());
      for (const [sampleId, sampleGenotypes] of genotypeEntries) {
        const population = samplePopulations.get(sampleId);
        if (!population) continue;
        for (const { definition, rows } of loaded) {
          const score = computeScore(rows, sampleGenotypes, positionMeta);
          outStream.write(`${sampleId}\t${population}\t${definition.pgs_id}\t${score}\t${PGS_SCORE_ALGORITHM}\t${definition.genome_build}\t${definition.variants}\t${definition.sha256}\n`);
        }
        sampleGenotypes.clear();
      }
      await rm(regionPath, { force: true });
    }
  } finally {
    outStream.end();
    await rm(tempDir, { recursive: true, force: true });
  }

  console.error(JSON.stringify({ event: 'batch_score_complete', output: outPath }));
}

async function queryAllSampleGenotypes(
  vcfPath: string,
  regionPath: string,
  sampleIds: Set<string>,
): Promise<Map<string, Map<string, { alleles: string[] }>>> {
  const perSample = new Map<string, Map<string, { alleles: string[] }>>();

  await forEachBcftoolsLine([
    'query', '-R', regionPath,
    '-f', '%CHROM\t%POS\t%REF\t%ALT[\t%SAMPLE=%GT]\n',
    vcfPath,
  ], line => {
    const cols = line.split('\t');
    if (cols.length < 5) return;
    const chrom = normalizeChrom(cols[0]);
    const pos = Number(cols[1]);
    const key = `${chrom}:${pos}`;
    const ref = cols[2].toUpperCase();
    const alts = cols[3].toUpperCase().split(',');
    const available = [ref, ...alts];

    for (let i = 4; i < cols.length; i++) {
      const cell = cols[i];
      const eqIdx = cell.indexOf('=');
      if (eqIdx < 0) continue;
      const sampleId = cell.slice(0, eqIdx);
      if (!sampleIds.has(sampleId)) continue;
      const gt = cell.slice(eqIdx + 1).split(':')[0];
      if (!gt || gt === '.' || gt === './.' || gt === '.|.') continue;
      const indexes = gt.split(/[|/]/).map(Number);
      if (indexes.length !== 2 || indexes.some(n => Number.isNaN(n))) continue;
      const alleles = indexes.map(n => available[n]).filter(Boolean);
      if (alleles.length !== 2) continue;
      let sampleMap = perSample.get(sampleId);
      if (!sampleMap) {
        sampleMap = new Map();
        perSample.set(sampleId, sampleMap);
      }
      sampleMap.set(key, { alleles });
    }
  });

  return perSample;
}

function computeScore(
  rows: PgsWeightRow[],
  genotypes: Map<string, { alleles: string[] }>,
  positionMeta: Map<string, { effectAllele: string; otherAllele?: string }>,
): number {
  let score = 0;
  for (const row of rows) {
    const key = `${normalizeChrom(row.chrom)}:${row.pos}`;
    const call = genotypes.get(key);
    if (!call) continue;
    const effect = row.effectAllele.toUpperCase();
    const other = row.otherAllele?.toUpperCase();
    const allowed = new Set([effect, other].filter(Boolean));
    if (call.alleles.some(a => !allowed.has(a.toUpperCase()))) continue;
    const dosage = call.alleles.filter(a => a.toUpperCase() === effect).length;
    score += dosage * row.effectWeight;
  }
  return Math.round(score * 1_000_000) / 1_000_000;
}

function findVcfForChrom(vcfDir: string, chrom: string): string | undefined {
  const fs = require('node:fs');
  const candidates = [
    path.join(vcfDir, `chr${chrom}.vcf.gz`),
    path.join(vcfDir, `${chrom}.vcf.gz`),
    path.join(vcfDir, `chr${chrom}.bcf`),
    path.join(vcfDir, `${chrom}.bcf`),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const entry of fs.readdirSync(vcfDir)) {
    const base = path.basename(entry).toLowerCase();
    if ((base.includes(`chr${chrom}`) || base.includes(`${chrom}.`) || base.includes(`_${chrom}_`))
      && (base.endsWith('.vcf.gz') || base.endsWith('.bcf'))) {
      return path.join(vcfDir, entry);
    }
  }
  return undefined;
}

function readPopulationMetadata(filePath: string): PopulationMetadata[] {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split('\t');
  const sampleIdx = header.findIndex(h => {
    const lower = h.toLowerCase();
    return lower === 'sample_id' || lower === 'sample' || lower === 'iid' || lower === '#iid' || lower === 'fid_iid';
  });
  const popIdx = header.findIndex(h => {
    const lower = h.toLowerCase();
    return lower === 'super_population' || lower === 'super_pop' || lower === 'population' || lower === 'pop' || lower === 'group';
  });
  if (sampleIdx < 0 || popIdx < 0) {
    throw new Error(`Metadata file must have sample_id and super_population columns. Found: ${header.join(', ')}`);
  }
  const validPops = new Set(['AFR', 'AMR', 'EAS', 'EUR', 'SAS']);
  return lines.slice(1)
    .map(line => {
      const cols = line.split('\t');
      const sampleId = cols[sampleIdx]?.trim();
      const pop = cols[popIdx]?.trim();
      if (!sampleId || !pop || !validPops.has(pop)) return undefined;
      // Handle FID_IID format (common in PLINK family files)
      const iid = sampleId.includes('_') ? sampleId.split('_').pop()! : sampleId;
      return { sample_id: iid, super_population: pop };
    })
    .filter((s): s is PopulationMetadata => Boolean(s));
}

function forEachBcftoolsLine(args: string[], callback: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('bcftools', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', callback);
    lines.on('close', () => child.stderr.destroy());
    child.stderr.on('data', chunk => {
      const text = chunk.toString('utf8');
      stderr = `${stderr}${text}`.slice(-32_768);
      process.stderr.write(text);
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`bcftools ${args[0]} failed with exit ${code}: ${stderr.trim()}`));
        return;
      }
      resolve();
    });
  });
}

function countsBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function parseArgs(values: string[]): Map<string, string> {
  const output = new Map<string, string>();
  for (let i = 0; i < values.length; i += 2) {
    if (!values[i]?.startsWith('--') || !values[i + 1]) throw new Error(`Invalid argument near ${values[i] ?? '<end>'}. Expected --name value.`);
    output.set(values[i].slice(2), values[i + 1]);
  }
  return output;
}

function required(args: Map<string, string>, name: string): string {
  const value = args.get(name);
  if (!value) throw new Error(`Missing required --${name}.`);
  return value;
}

void main().catch(error => {
  console.error(JSON.stringify({
    event: 'batch_score_failed',
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
});

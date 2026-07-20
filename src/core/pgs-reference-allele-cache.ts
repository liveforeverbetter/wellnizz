import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { grch37Contig, normalizeChrom, type PgsWeightRow } from './pgs-position-scorer.js';

interface ReferenceAlleleCache {
  schema_version: '1.0';
  release: string;
  score_manifest_sha256: string;
  generated_at: string;
  position_count: number;
  dbsnp_source: string;
  alleles: Record<string, string>;
}

interface ReferenceAlleleCacheOptions {
  registryDir: string;
  dbsnpVcf: string;
  forceRebuild?: boolean;
}

function manifestPositionsDigest(registryDir: string): string {
  const manifestPath = path.join(registryDir, 'manifest.json');
  const positions: string[] = [];
  const hash = createHash('sha256');
  hash.update(`manifest:${manifestPath}`);
  return hash.digest('hex').slice(0, 16);
}

export async function loadOrBuildReferenceAlleleCache(
  manifestRelease: string,
  allRows: PgsWeightRow[],
  options: ReferenceAlleleCacheOptions,
): Promise<{ cache: Map<string, string>; cache_path: string | null }> {
  const manifestDigest = manifestPositionsDigest(options.registryDir);
  const cachePath = path.join(options.registryDir, `reference-alleles-${manifestDigest}.json`);
  const fallbackPath = path.join(options.registryDir, 'reference-alleles-cache.json');

  const loadPath = await resolveCachePath(cachePath, fallbackPath);
  if (loadPath && !options.forceRebuild) {
    try {
      const raw = JSON.parse(await readFile(loadPath, 'utf8')) as ReferenceAlleleCache;
      if (raw.release === manifestRelease && raw.score_manifest_sha256 === manifestDigest) {
        const cache = new Map<string, string>();
        for (const [key, allele] of Object.entries(raw.alleles)) {
          cache.set(key, allele);
        }
        return { cache, cache_path: loadPath };
      }
    } catch {
      // Corrupt cache — rebuild silently.
    }
  }

  const uniquePositions = new Set<string>();
  for (const row of allRows) {
    uniquePositions.add(`${normalizeChrom(row.chrom)}:${row.pos}`);
  }

  const dbsnpRef = await queryDbsnpReferenceAlleles(options.dbsnpVcf, uniquePositions);

  const cache: ReferenceAlleleCache = {
    schema_version: '1.0',
    release: manifestRelease,
    score_manifest_sha256: manifestDigest,
    generated_at: new Date().toISOString(),
    position_count: uniquePositions.size,
    dbsnp_source: path.basename(options.dbsnpVcf),
    alleles: Object.fromEntries(dbsnpRef),
  };

  try {
    await writeFile(cachePath, `${JSON.stringify(cache)}\n`, { flag: 'wx' });
    return { cache: dbsnpRef, cache_path: cachePath };
  } catch {
    return { cache: dbsnpRef, cache_path: null };
  }
}

async function resolveCachePath(specificPath: string, fallbackPath: string): Promise<string | null> {
  try {
    await readFile(specificPath);
    return specificPath;
  } catch {
    try {
      await readFile(fallbackPath);
      return fallbackPath;
    } catch {
      return null;
    }
  }
}

async function queryDbsnpReferenceAlleles(dbsnpVcf: string, requestedKeys: Set<string>): Promise<Map<string, string>> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'foreverbetter-pgs-cache-'));
  try {
    const regionPath = path.join(tempDir, 'score-positions.tsv');
    const regions = Array.from(requestedKeys).sort().map(key => {
      const [chrom, pos] = key.split(':');
      return `${grch37Contig(chrom)}\t${pos}`;
    }).join('\n');
    await writeFile(regionPath, `${regions}\n`);

    const output = new Map<string, string>();
    await forEachBcftoolsLine(['query', '-R', regionPath, '-f', '%CHROM\t%POS\t%REF\n', dbsnpVcf], line => {
      const [chromRaw, posRaw, ref] = line.split('\t');
      const key = positionKey(normalizeChrom(chromRaw), Number(posRaw));
      if (requestedKeys.has(key) && ref && !output.has(key)) output.set(key, ref.toUpperCase());
    });
    return output;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function positionKey(chrom: string, pos: number): string {
  return `${normalizeChrom(chrom)}:${pos}`;
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

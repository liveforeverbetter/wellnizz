#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const skillDir = resolve(root, process.env.HEALTH_ANALYSIS_SKILL_DIR ?? 'vendor/health-analysis-skill');
const requireSource = process.argv.includes('--require-source');

const requiredFiles = [
  'SKILL.md',
  'package.json',
  'package-lock.json',
  'scripts/pipeline/index.ts',
  'templates/longevity-dashboard.html',
  'reference/clinvar/clinvar-rsid-reference.manifest.json',
  'reference/wellness/wellness-reference.manifest.json',
];

const missing = requiredFiles.filter((file) => !existsSync(resolve(skillDir, file)));
if (missing.length > 0) {
  console.error(`Health analysis skill bundle is incomplete at ${skillDir}`);
  for (const file of missing) console.error(`missing: ${file}`);
  process.exit(1);
}

const packageJson = JSON.parse(readFileSync(resolve(skillDir, 'package.json'), 'utf8'));
if (packageJson.name !== 'analyze-longevity') {
  console.error(`Unexpected health analysis package name: ${packageJson.name}`);
  process.exit(1);
}

const manifestPath = resolve(skillDir, '.bundle-manifest');
if (!existsSync(manifestPath)) {
  console.error(`Health analysis bundle manifest is missing: ${manifestPath}`);
  process.exit(1);
}

const manifest = Object.fromEntries(
  readFileSync(manifestPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      const split = line.indexOf('=');
      return split < 0 ? [line, ''] : [line.slice(0, split), line.slice(split + 1)];
    }),
);

if (manifest.source_subdir !== 'skills/longevity-analysis') {
  console.error(`Unexpected source_subdir in bundle manifest: ${manifest.source_subdir}`);
  process.exit(1);
}

// The manifest records a portable repository origin for provenance. Freshness
// comparison uses the explicitly configured checkout or the sibling source
// repository, never a developer-specific absolute path from the bundle.
const sourceRepo = resolve(process.env.HEALTH_ANALYSIS_SKILL_SOURCE ?? resolve(root, '../open-source'));
if (!requireSource) {
  console.log(`Health analysis skill bundle verified internally at ${skillDir}. Run with --require-source to compare it with the separate source checkout.`);
  process.exit(0);
}
if (!existsSync(sourceRepo)) {
  console.error(`Source checkout is required for freshness verification: ${sourceRepo}`);
  process.exit(1);
}

let sourceCommit;
try {
  sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRepo, encoding: 'utf8' }).trim();
} catch {
  console.error(`Source path is not a readable git checkout: ${sourceRepo}`);
  process.exit(1);
}

if (manifest.source_commit !== sourceCommit) {
  console.error(`Stale health analysis bundle: manifest=${manifest.source_commit} source=${sourceCommit}`);
  process.exit(1);
}

const listed = execFileSync(
  'git',
  ['ls-files', '-co', '--exclude-standard', '--', manifest.source_subdir],
  { cwd: sourceRepo, encoding: 'utf8' },
).split(/\r?\n/).filter(Boolean);

const expected = new Map();
for (const sourcePath of listed) {
  const relativePath = sourcePath.slice(`${manifest.source_subdir}/`.length);
  expected.set(relativePath, readFileSync(resolve(sourceRepo, sourcePath)));
}

function bundledFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) files.push(...bundledFiles(path));
    else files.push(relative(skillDir, path).split(sep).join('/'));
  }
  return files;
}

const actualPaths = bundledFiles(skillDir).filter(path => path !== '.bundle-manifest');
const unexpected = actualPaths.filter(path => !expected.has(path));
const absent = [...expected.keys()].filter(path => !actualPaths.includes(path));
const changed = [...expected.entries()]
  .filter(([path, contents]) => actualPaths.includes(path) && !readFileSync(resolve(skillDir, path)).equals(contents))
  .map(([path]) => path);

if (unexpected.length || absent.length || changed.length) {
  console.error('Health analysis skill bundle does not match the scoped source working tree.');
  for (const path of unexpected) console.error(`unexpected: ${path}`);
  for (const path of absent) console.error(`missing: ${path}`);
  for (const path of changed) console.error(`changed: ${path}`);
  process.exit(1);
}

console.log(`Health analysis skill bundle verified against ${sourceCommit}${manifest.source_dirty === 'true' ? ' + scoped working-tree changes' : ''}.`);

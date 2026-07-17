#!/usr/bin/env npx tsx
/**
 * Lightweight public-distribution doctor.
 *
 * This intentionally avoids large reference checks. It verifies that a copied
 * skill folder has the files, prompts, examples, and npm scripts needed for
 * onboarding and local smoke validation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

interface Check {
  id: string;
  label: string;
  passed: boolean;
  evidence: string;
}

interface WgsTruthsetConfig {
  truthsets?: Array<{
    id: string;
    input: string;
    expected_calls?: Array<{ id: string; class: string; reportability: string; genes: string[] }>;
    expected_classes?: string[];
  }>;
  external_truthsets?: Array<{ id: string; source_url?: string; truth_vcf_url?: string; query_vcf?: string }>;
  required_future_truthsets?: Array<{ id: string; status: string; reason: string }>;
}

interface WgsInterpretationCatalog {
  dosage_sensitive_regions?: unknown[];
  repeat_loci?: unknown[];
  structural_genes?: unknown[];
}

interface OptionalReferenceManifest {
  version: string;
  bloat_policy?: {
    bundle_in_repo?: boolean;
    local_cache_roots?: string[];
  };
  assets?: Array<{ id: string; group: string; expected_files?: unknown[]; setup_commands?: string[] }>;
  tools?: Array<{ id: string; command: string }>;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '../..');
const maxExampleBytes = 8 * 1024 * 1024;
const maxExamplesTotalBytes = 8 * 1024 * 1024;

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function readJson<T>(filePath: string): T {
  return JSON.parse(read(filePath)) as T;
}

function exists(relPath: string): boolean {
  return fs.existsSync(path.join(packageDir, relPath));
}

function bytes(relPath: string): number {
  return fs.statSync(path.join(packageDir, relPath)).size;
}

function add(checks: Check[], id: string, label: string, passed: boolean, evidence: string): void {
  checks.push({ id, label, passed, evidence });
}

function includesAll(text: string, phrases: string[]): { passed: boolean; missing: string[] } {
  const missing = phrases.filter(phrase => !text.includes(phrase));
  return { passed: missing.length === 0, missing };
}

function resolveFromPackage(relPath: string): string {
  return path.resolve(packageDir, relPath);
}

function resolveTruthsetInput(inputPath: string): string {
  if (path.isAbsolute(inputPath)) return inputPath;
  const fromReferences = path.resolve(packageDir, 'references', inputPath);
  if (fs.existsSync(fromReferences)) return fromReferences;
  return path.resolve(packageDir, inputPath);
}

function countRsidVcfRecords(relPath: string): number {
  const text = read(path.join(packageDir, relPath));
  return text
    .split(/\r?\n/)
    .filter(line => line && !line.startsWith('#') && line.split('\t')[2]?.startsWith('rs'))
    .length;
}

function listFilesRecursive(relPath: string): string[] {
  const absPath = path.join(packageDir, relPath);
  if (!fs.existsSync(absPath)) return [];
  const stat = fs.statSync(absPath);
  if (stat.isFile()) return [relPath];
  return fs.readdirSync(absPath)
    .flatMap(entry => listFilesRecursive(path.join(relPath, entry)));
}

function main(): void {
  const checks: Check[] = [];
  const requiredFiles = [
    'SKILL.md',
    'PIPELINE.md',
    'package.json',
    'package-lock.json',
    'templates/longevity-dashboard.html',
    'shared/dashboard-types.ts',
    'references/wgs-process.md',
    'references/optional-reference-manifest.json',
    'references/cnv-sv-repeat-evidence.compact.json',
    'references/cnv-sv-repeat-evidence.schema.json',
    'reference/clinvar/clinvar-rsid-reference.manifest.json',
    'reference/clinvar/clinvar_rsid_annotation.tsv.gz',
    'reference/clinvar/clinvar_rsid_annotation.tsv.gz.tbi',
    'reference/clinvar/clinvar_index.txt.gz',
    'reference/wellness/wellness-reference.manifest.json',
    'reference/wellness/gwas_wellness_associations.json.gz',
    'reference/wellness/pgs_wellness_weights.json.gz',
    'examples/sample-dashboard.json',
    'examples/sample-rsid-wgs.vcf',
    'examples/sample-biomarkers.csv',
    'examples/sample-biomarkers-previous.csv',
    'examples/sample-whoop-api.json',
  ];

  for (const relPath of requiredFiles) {
    add(checks, `file.${relPath}`, `Required file exists: ${relPath}`, exists(relPath), relPath);
  }

  const pkg = JSON.parse(read(path.join(packageDir, 'package.json'))) as { scripts?: Record<string, string> };
  for (const script of ['pipeline', 'sample:report', 'smoke:wgs', 'doctor', 'typecheck', 'evaluate', 'audit:pipeline']) {
    add(checks, `script.${script}`, `npm script exists: ${script}`, Boolean(pkg.scripts?.[script]), pkg.scripts?.[script] ?? 'missing');
  }
  for (const script of ['setup:rsids', 'doctor:vcf', 'annotate:vcf']) {
    add(checks, `script.${script}`, `ClinVar rsID npm script exists: ${script}`, Boolean(pkg.scripts?.[script]), pkg.scripts?.[script] ?? 'missing');
  }
  for (const script of ['wgs:variant-classes', 'wgs:caller-manifest', 'wgs:query-readiness', 'wgs:validate', 'wgs:external-validation', 'wgs:truthsets']) {
    add(checks, `script.${script}`, `WGS npm script exists: ${script}`, Boolean(pkg.scripts?.[script]), pkg.scripts?.[script] ?? 'missing');
  }
  for (const script of ['reference:doctor', 'reference:setup', 'reference:wellness', 'reference:fixtures', 'cnv:validate']) {
    add(checks, `script.${script}`, `Reference npm script exists: ${script}`, Boolean(pkg.scripts?.[script]), pkg.scripts?.[script] ?? 'missing');
  }

  const skill = read(path.join(packageDir, 'SKILL.md'));
  const onboardingOrder = [
    skill.indexOf('1. Outcome:'),
    skill.indexOf('2. Ready data:'),
    skill.indexOf('3. Annotation depth'),
  ];
  add(
    checks,
    'onboarding.outcome_first',
    'Skill asks for the outcome before inventorying only the data it needs',
    onboardingOrder.every(index => index >= 0) && onboardingOrder[0] < onboardingOrder[1] && onboardingOrder[1] < onboardingOrder[2],
    'SKILL.md invocation behavior',
  );
  const onboardingOptions = includesAll(skill, [
    'WHOOP',
    'Oura',
    'Apple Health',
    'Garmin',
    'OHealth',
    'Fitbit/Google Health',
    'CSV/JSON export',
    'PDF/table export',
    'whole-genome VCF/VCF.GZ',
    '23andMe raw data',
    'AncestryDNA raw data',
    'none',
  ]);
  add(
    checks,
    'onboarding.modality_options',
    'Skill gives concrete wearable, biomarker, and genetic intake options',
    onboardingOptions.passed,
    onboardingOptions.missing.length ? `missing: ${onboardingOptions.missing.join(', ')}` : 'all present',
  );
  add(
    checks,
    'onboarding.link_prompt',
    'Skill accepts local file paths or private download links',
    /local file paths? or private download links?/i.test(skill),
    'SKILL.md invocation behavior',
  );
  add(
    checks,
    'onboarding.answer_tailoring',
    'Skill tailors rendering and next steps from available modalities',
    /Tailor the next step to the answers/i.test(skill) && /--biomarkers/.test(skill) && /--wearables/.test(skill) && /sample:report/.test(skill),
    'SKILL.md answer-specific behavior',
  );
  add(
    checks,
    'onboarding.cron_prompt',
    'Skill offers opt-in recurring action plans after the first requested result',
    /After delivering the first requested result/i.test(skill) && /plan recurring/i.test(skill) && /explicitly opts? in/i.test(skill),
    'SKILL.md post-result behavior',
  );

  const wgsProcess = read(path.join(packageDir, 'references/wgs-process.md'));
  for (const phrase of ['rsID annotation', 'Interpretation Layers', 'Variant-Class Coverage', 'GIAB External Validation', 'Release Gate']) {
    add(checks, `wgs_process.${phrase}`, `WGS process covers ${phrase}`, wgsProcess.includes(phrase), phrase);
  }
  const wgsInputTypes = includesAll(wgsProcess, [
    'WGS VCF/VCF.GZ with rsIDs',
    'WGS VCF/VCF.GZ without rsIDs',
    'SNP-array export',
    'BAM/CRAM/FASTQ',
    'CNV/SV/repeat-only caller output',
  ]);
  add(checks, 'wgs_process.input_types', 'WGS process classifies all supported input types', wgsInputTypes.passed, wgsInputTypes.missing.length ? `missing: ${wgsInputTypes.missing.join(', ')}` : 'all present');

  const wgsLayers = includesAll(wgsProcess, ['Curated markers', 'ClinVar', 'CPIC', 'PRS', 'VEP', 'WGS class catalog', 'Knowledge graph', 'Biomarkers/wearables']);
  add(checks, 'wgs_process.interpretation_layers', 'WGS process names every interpretation layer', wgsLayers.passed, wgsLayers.missing.length ? `missing: ${wgsLayers.missing.join(', ')}` : 'all present');

  const wgsClasses = includesAll(wgsProcess, ['SNV', 'Small indel', 'CNV', 'SV/rearrangement', 'Tandem repeat', 'Large insertion/deletion']);
  add(checks, 'wgs_process.variant_classes', 'WGS process names every expected variant class', wgsClasses.passed, wgsClasses.missing.length ? `missing: ${wgsClasses.missing.join(', ')}` : 'all present');

  const wgsExternalBoundary = includesAll(wgsProcess, ['What Is Not Bundled Locally', 'Full dbSNP rsID reference', 'Ensembl VEP cache', 'BAM/CRAM/FASTQ caller stack', 'GIAB truthsets and query VCFs']);
  add(checks, 'wgs_process.external_boundary', 'WGS process separates heavyweight external assets from local validation', wgsExternalBoundary.passed, wgsExternalBoundary.missing.length ? `missing: ${wgsExternalBoundary.missing.join(', ')}` : 'all present');

  const referenceManifest = readJson<OptionalReferenceManifest>(resolveFromPackage('references/optional-reference-manifest.json'));
  const manifestGroups = new Set((referenceManifest.assets ?? []).map(asset => asset.group));
  add(checks, 'reference_manifest.bloat_policy', 'Optional reference manifest keeps heavyweight assets out of git', referenceManifest.bloat_policy?.bundle_in_repo === false, JSON.stringify(referenceManifest.bloat_policy ?? {}));
  add(checks, 'reference_manifest.asset_groups', 'Optional reference manifest covers dbSNP, ClinVar, VEP, GIAB, and caller outputs', ['dbsnp', 'clinvar', 'vep', 'giab', 'caller-output'].every(group => manifestGroups.has(group)), [...manifestGroups].join(', '));
  add(checks, 'reference_manifest.expected_files', 'Optional reference manifest records expected files and sizes', (referenceManifest.assets ?? []).every(asset => (asset.expected_files?.length ?? 0) > 0), `${referenceManifest.assets?.length ?? 0} assets`);
  add(checks, 'reference_manifest.tools', 'Optional reference manifest checks caller/reference tools', (referenceManifest.tools?.length ?? 0) >= 5, `${referenceManifest.tools?.length ?? 0} tools`);

  const clinvarManifest = readJson<{
    row_counts?: { rsid_annotation_rows?: number; unique_rsids?: number; interpretation_rows?: number };
    disclosure?: { limitation?: string; not_diagnostic?: string; vus_policy?: string };
  }>(resolveFromPackage('reference/clinvar/clinvar-rsid-reference.manifest.json'));
  add(checks, 'clinvar_default.row_counts', 'Bundled ClinVar rsID default has production-scale row counts', (clinvarManifest.row_counts?.unique_rsids ?? 0) >= 2_000_000 && (clinvarManifest.row_counts?.interpretation_rows ?? 0) >= 2_000_000, JSON.stringify(clinvarManifest.row_counts ?? {}));
  add(checks, 'clinvar_default.disclosure', 'Bundled ClinVar rsID default discloses ClinVar-only scope', Boolean(clinvarManifest.disclosure?.limitation?.includes('not full dbSNP') && clinvarManifest.disclosure?.not_diagnostic && clinvarManifest.disclosure?.vus_policy), JSON.stringify(clinvarManifest.disclosure ?? {}));
  const clinvarDefaultFiles = [
    'reference/clinvar/clinvar_rsid_annotation.tsv.gz',
    'reference/clinvar/clinvar_rsid_annotation.tsv.gz.tbi',
    'reference/clinvar/clinvar_index.txt.gz',
    'reference/clinvar/clinvar-rsid-reference.manifest.json',
  ];
  const clinvarDefaultBytes = clinvarDefaultFiles.reduce((sum, relPath) => sum + bytes(relPath), 0);
  const largestClinvarDefault = clinvarDefaultFiles
    .map(relPath => ({ relPath, size: bytes(relPath) }))
    .reduce((max, item) => item.size > max.size ? item : max, { relPath: '', size: 0 });
  add(checks, 'clinvar_default.total_size', 'Bundled ClinVar rsID default stays under 1GB', clinvarDefaultBytes < 1024 * 1024 * 1024, `${clinvarDefaultBytes} bytes`);
  add(checks, 'clinvar_default.github_file_size', 'Bundled ClinVar rsID default avoids GitHub 100MB file limit', largestClinvarDefault.size < 100 * 1024 * 1024, `${largestClinvarDefault.relPath} ${largestClinvarDefault.size} bytes`);

  const wellnessManifest = readJson<{
    counts?: { gwas_associations?: number; gwas_rsids?: number; pgs_scores_selected?: number; pgs_variants?: number };
    disclosures?: { ancestry?: string; genome_build?: string; coverage?: string; not_diagnostic?: string };
    sources?: Array<{ source_id?: string; source_name?: string; source_url?: string }>;
  }>(resolveFromPackage('reference/wellness/wellness-reference.manifest.json'));
  const wellnessSources = new Set((wellnessManifest.sources ?? []).map(source => source.source_id));
  add(checks, 'wellness_reference.row_counts', 'Bundled wellness reference has GWAS and PGS depth', (wellnessManifest.counts?.gwas_associations ?? 0) >= 100_000 && (wellnessManifest.counts?.pgs_variants ?? 0) >= 100_000 && (wellnessManifest.counts?.pgs_scores_selected ?? 0) >= 8, JSON.stringify(wellnessManifest.counts ?? {}));
  add(checks, 'wellness_reference.sources', 'Bundled wellness reference records GWAS and PGS sources', wellnessSources.has('gwas_catalog') && wellnessSources.has('pgs_catalog'), JSON.stringify(wellnessManifest.sources ?? []));
  add(checks, 'wellness_reference.disclosure', 'Bundled wellness reference discloses ancestry, build, coverage, and non-diagnostic limits', Boolean(wellnessManifest.disclosures?.ancestry && wellnessManifest.disclosures?.genome_build && wellnessManifest.disclosures?.coverage && wellnessManifest.disclosures?.not_diagnostic), JSON.stringify(wellnessManifest.disclosures ?? {}));
  const wellnessDefaultFiles = [
    'reference/wellness/gwas_wellness_associations.json.gz',
    'reference/wellness/pgs_wellness_weights.json.gz',
    'reference/wellness/wellness-reference.manifest.json',
  ];
  const wellnessDefaultBytes = wellnessDefaultFiles.reduce((sum, relPath) => sum + bytes(relPath), 0);
  const largestWellnessDefault = wellnessDefaultFiles
    .map(relPath => ({ relPath, size: bytes(relPath) }))
    .reduce((max, item) => item.size > max.size ? item : max, { relPath: '', size: 0 });
  add(checks, 'wellness_reference.total_size', 'Bundled wellness reference stays under 1GB', wellnessDefaultBytes < 1024 * 1024 * 1024, `${wellnessDefaultBytes} bytes`);
  add(checks, 'wellness_reference.github_file_size', 'Bundled wellness reference avoids GitHub 100MB file limit', largestWellnessDefault.size < 100 * 1024 * 1024, `${largestWellnessDefault.relPath} ${largestWellnessDefault.size} bytes`);

  const truthsets = readJson<WgsTruthsetConfig>(resolveFromPackage('references/wgs-validation-truthsets.json'));
  const localTruthsets = truthsets.truthsets ?? [];
  const externalTruthsets = truthsets.external_truthsets ?? [];
  const futureTruthsets = truthsets.required_future_truthsets ?? [];
  add(checks, 'wgs_validation.local_truthsets', 'Local WGS validation has synthetic truthsets', localTruthsets.length >= 4, `${localTruthsets.length} truthsets`);
  add(checks, 'wgs_validation.external_truthsets', 'External GIAB truthsets are configured but not bundled', externalTruthsets.length >= 3, `${externalTruthsets.length} external truthsets`);
  add(checks, 'wgs_validation.future_truthsets', 'Future WGS truthset gaps are explicit', futureTruthsets.length >= 3, `${futureTruthsets.length} future truthsets`);

  const truthsetInputs = localTruthsets.map(truthset => resolveTruthsetInput(truthset.input));
  const missingTruthsetInputs = truthsetInputs.filter(input => !fs.existsSync(input));
  const truthsetInputBytes = truthsetInputs
    .filter(input => fs.existsSync(input))
    .reduce((sum, input) => sum + fs.statSync(input).size, 0);
  add(checks, 'wgs_validation.truthset_inputs_exist', 'Synthetic WGS truthset input VCFs are present', missingTruthsetInputs.length === 0, missingTruthsetInputs.length ? `missing: ${missingTruthsetInputs.join(', ')}` : `${truthsetInputs.length} inputs`);
  add(checks, 'wgs_validation.truthset_inputs_small', 'Synthetic WGS truthset inputs stay small', truthsetInputBytes <= 64 * 1024, `${truthsetInputBytes} bytes`);

  const expectedClasses = new Set(localTruthsets.flatMap(truthset => truthset.expected_classes ?? []));
  const expectedReportable = localTruthsets.flatMap(truthset => truthset.expected_calls ?? []).filter(call => call.reportability === 'clinician_review').length;
  add(checks, 'wgs_validation.class_coverage', 'Synthetic WGS truthsets cover all local variant classes', expectedClasses.size >= 5, `${expectedClasses.size} classes`);
  add(checks, 'wgs_validation.reportability_coverage', 'Synthetic WGS truthsets cover reportable calls', expectedReportable >= 8, `${expectedReportable} clinician-review calls`);

  const catalog = readJson<WgsInterpretationCatalog>(resolveFromPackage('references/wgs-interpretation-catalog.json'));
  add(checks, 'wgs_catalog.dosage_regions', 'Local WGS catalog includes dosage-sensitive regions', (catalog.dosage_sensitive_regions?.length ?? 0) >= 3, `${catalog.dosage_sensitive_regions?.length ?? 0} regions`);
  add(checks, 'wgs_catalog.repeat_loci', 'Local WGS catalog includes repeat loci', (catalog.repeat_loci?.length ?? 0) >= 2, `${catalog.repeat_loci?.length ?? 0} loci`);
  add(checks, 'wgs_catalog.structural_genes', 'Local WGS catalog includes structural genes', (catalog.structural_genes?.length ?? 0) >= 4, `${catalog.structural_genes?.length ?? 0} genes`);

  const pipelineSource = read(resolveFromPackage('scripts/pipeline/index.ts'));
  const disclosureContract = includesAll(pipelineSource, ['vep_status', 'wgs_validation_coverage', 'local_vcf_coverage', 'prs_note', 'ClinVar', 'CPIC']);
  add(checks, 'dashboard.disclosure_contract', 'Pipeline emits WGS/VEP/PRS disclosure contract fields', disclosureContract.passed, disclosureContract.missing.length ? `missing: ${disclosureContract.missing.join(', ')}` : 'all present');

  const rsidRecords = countRsidVcfRecords('examples/sample-rsid-wgs.vcf');
  add(checks, 'fixture.rsid_wgs_records', 'Packaged WGS smoke fixture has rsID records', rsidRecords >= 10, `${rsidRecords} rsID records`);

  const exampleFiles = listFilesRecursive('examples');
  const exampleSizes = exampleFiles.map(relPath => ({ relPath, size: bytes(relPath) }));
  const largest = exampleSizes.reduce((max, item) => item.size > max.size ? item : max, { relPath: '', size: 0 });
  const total = exampleSizes.reduce((sum, item) => sum + item.size, 0);
  add(checks, 'size.examples_single', 'No packaged example exceeds size budget', largest.size <= maxExampleBytes, `${largest.relPath} ${largest.size} bytes`);
  add(checks, 'size.examples_total', 'Packaged examples stay within size budget', total <= maxExamplesTotalBytes, `${total} bytes`);

  const failed = checks.filter(check => !check.passed);
  const report = {
    status: failed.length === 0 ? 'pass' : 'fail',
    package_dir: packageDir,
    checks,
    failed,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failed.length > 0) process.exit(1);
}

main();

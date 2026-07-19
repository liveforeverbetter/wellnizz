#!/usr/bin/env npx tsx
/**
 * Internal interpretation-depth metrics.
 *
 * This measures whether the local-first genomics pipeline has enough compact
 * interpretation slices to be credible without vendoring large ClinVar, CPIC,
 * dbSNP, or PGS Catalog archives into the repo.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { ACMG_SF_GENES, RECESSIVE_DISEASE_GENES } from './clinvar_enrichment.js';
import { CPIC_LEVEL_A_PAIRS } from './cpic_enrichment.js';
import { buildCompactInterpretationCatalog } from './compact_interpretation_catalog.js';

interface PrsWeights {
  diseases?: string[];
  variants?: Array<{ rsid?: string; disease?: string }>;
}

interface DepthThresholds {
  source_family_min: number;
  curated_marker_min: number;
  provenance_graded_marker_min: number;
  clinvar_gene_target_min: number;
  cpic_gene_drug_rule_min: number;
  cpic_unique_gene_min: number;
  pgs_trait_min: number;
  pgs_variant_min: number;
  wellness_pgs_trait_min: number;
  wgs_class_entry_min: number;
  compact_catalog_max_bytes: number;
}

export interface InterpretationDepthReport {
  generated_at: string;
  purpose: string;
  thresholds: DepthThresholds;
  summary: {
    score: number;
    status: 'pass' | 'warn' | 'fail';
    source_families_supported: number;
    default_requires_large_database: boolean;
    compact_catalog_entries: number;
    compact_catalog_bytes: number;
    curated_marker_entries: number;
    provenance_graded_markers: number;
    clinvar_gene_targets: number;
    acmg_secondary_genes: number;
    recessive_carrier_genes: number;
    cpic_gene_drug_rules: number;
    cpic_unique_genes: number;
    cpic_unique_drugs: number;
    cpic_unique_rsids: number;
    pgs_traits: number;
    pgs_variants: number;
    wellness_pgs_traits: number;
    wgs_class_entries: number;
    deeper_caller_optional_entries: number;
  };
  metrics: Array<{
    id: string;
    label: string;
    actual: number | boolean;
    target: number | boolean;
    score: number;
    passed: boolean;
  }>;
  install_policy: {
    large_external_caches_in_repo: boolean;
    optional_network_enrichment: boolean;
    repo_contained_default: boolean;
    note: string;
  };
  source_families: Array<{
    id: string;
    role: string;
    local_slice: string;
    large_database_required_for_default: boolean;
  }>;
  passed: boolean;
}

const DEFAULT_THRESHOLDS: DepthThresholds = {
  source_family_min: 5,
  curated_marker_min: 250,
  provenance_graded_marker_min: 11,
  clinvar_gene_target_min: 150,
  cpic_gene_drug_rule_min: 10,
  cpic_unique_gene_min: 8,
  pgs_trait_min: 27,
  pgs_variant_min: 180,
  wellness_pgs_trait_min: 18,
  wgs_class_entry_min: 8,
  compact_catalog_max_bytes: 2_000_000,
};

const WELLNESS_TRAITS = new Set([
  'telomere_length',
  'vo2max',
  'grip_strength',
  'bone_density',
  'sleep_duration',
  'chronotype_morningness',
  'hdl_cholesterol',
  'ldl_cholesterol',
  'triglycerides',
  'systolic_bp',
  'crp_inflammation',
  'il6_inflammation',
  'igf1_levels',
  'lean_body_mass',
  'vitamin_d',
  'homocysteine',
  'epigenetic_age_grimage',
  'reaction_time',
  'cognitive_performance',
  'neuroticism',
  'alcohol_consumption',
  'caffeine_metabolism',
]);

function argValue(flag: string): string | undefined {
  const direct = process.argv.find(arg => arg.startsWith(`${flag}=`));
  if (direct) return direct.split('=').slice(1).join('=');
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function percentScore(actual: number, target: number): number {
  if (target <= 0) return actual >= target ? 100 : 0;
  return Math.round(Math.max(0, Math.min(1, actual / target)) * 100);
}

function countProvenanceGradedMarkers(packageDir: string): number {
  const interpretationsDir = path.join(packageDir, 'shared/interpretations');
  return fs.readdirSync(interpretationsDir)
    .filter(file => file.endsWith('.json'))
    .reduce((count, file) => {
      const parsed = readJson<{ markers?: Record<string, { provenance?: { status?: string; sources?: unknown[] } }> }>(
        path.join(interpretationsDir, file),
      );
      return count + Object.values(parsed.markers ?? {}).filter(marker =>
        marker.provenance?.status === 'curated'
        && Array.isArray(marker.provenance.sources)
        && marker.provenance.sources.length >= 2
      ).length;
    }, 0);
}

function metric(
  id: string,
  label: string,
  actual: number | boolean,
  target: number | boolean,
  score: number,
) {
  const bounded = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));
  return {
    id,
    label,
    actual,
    target,
    score: Math.round(bounded),
    passed: bounded >= 100,
  };
}

export function buildInterpretationDepthReport(packageDir: string, thresholds: DepthThresholds = DEFAULT_THRESHOLDS): InterpretationDepthReport {
  const compactCatalog = buildCompactInterpretationCatalog({ packageDir });
  const prsPath = path.join(packageDir, 'shared/prs_weights.json');
  const prs = fs.existsSync(prsPath) ? readJson<PrsWeights>(prsPath) : {};

  const cpicUniqueGenes = new Set(CPIC_LEVEL_A_PAIRS.map(pair => pair.gene));
  const cpicUniqueDrugs = new Set(CPIC_LEVEL_A_PAIRS.map(pair => pair.drug));
  const cpicUniqueRsids = new Set(CPIC_LEVEL_A_PAIRS.map(pair => pair.rsid));
  const pgsTraits = new Set(prs.diseases ?? []);
  const pgsVariantRsids = new Set((prs.variants ?? []).map(variant => variant.rsid).filter(Boolean));
  const wellnessPgsTraits = [...pgsTraits].filter(trait => WELLNESS_TRAITS.has(trait)).length;

  const curatedMarkerEntries = compactCatalog.entries.filter(entry => entry.source_type === 'curated_rsid_marker').length;
  const provenanceGradedMarkers = countProvenanceGradedMarkers(packageDir);
  const clinvarGeneTargets = compactCatalog.entries.filter(entry => entry.source_type === 'clinvar_gene_slice').length;
  const cpicGeneDrugRules = compactCatalog.entries.filter(entry => entry.source_type === 'cpic_drug_gene_rule').length;
  const wgsClassEntries = compactCatalog.entries.filter(entry => entry.source_type === 'cnv_sv_repeat_catalog').length;
  const sourceFamiliesSupported = new Set(compactCatalog.entries.map(entry => entry.source_type)).size;
  const defaultRequiresLargeDatabase = compactCatalog.summary.raw_read_callers_required_for_default
    || !compactCatalog.summary.within_repo_size_budget
    || compactCatalog.size_budget.large_external_caches_in_repo;

  const metrics = [
    metric('source_families', 'Independent compact source families', sourceFamiliesSupported, thresholds.source_family_min, percentScore(sourceFamiliesSupported, thresholds.source_family_min)),
    metric('curated_markers', 'Curated rsID interpretation markers', curatedMarkerEntries, thresholds.curated_marker_min, percentScore(curatedMarkerEntries, thresholds.curated_marker_min)),
    metric('provenance_graded_markers', 'Curated markers with build, allele, source, and limitation provenance', provenanceGradedMarkers, thresholds.provenance_graded_marker_min, percentScore(provenanceGradedMarkers, thresholds.provenance_graded_marker_min)),
    metric('clinvar_targets', 'ClinVar target genes covered by compact review templates', clinvarGeneTargets, thresholds.clinvar_gene_target_min, percentScore(clinvarGeneTargets, thresholds.clinvar_gene_target_min)),
    metric('cpic_rules', 'CPIC Level A gene-drug rules covered locally', cpicGeneDrugRules, thresholds.cpic_gene_drug_rule_min, percentScore(cpicGeneDrugRules, thresholds.cpic_gene_drug_rule_min)),
    metric('cpic_unique_genes', 'Unique CPIC pharmacogenes covered', cpicUniqueGenes.size, thresholds.cpic_unique_gene_min, percentScore(cpicUniqueGenes.size, thresholds.cpic_unique_gene_min)),
    metric('pgs_traits', 'PRS traits covered by compact local weights', pgsTraits.size, thresholds.pgs_trait_min, percentScore(pgsTraits.size, thresholds.pgs_trait_min)),
    metric('pgs_variants', 'PRS rsIDs covered by compact local weights', pgsVariantRsids.size, thresholds.pgs_variant_min, percentScore(pgsVariantRsids.size, thresholds.pgs_variant_min)),
    metric('wellness_pgs_traits', 'Wellness and optimization PRS traits', wellnessPgsTraits, thresholds.wellness_pgs_trait_min, percentScore(wellnessPgsTraits, thresholds.wellness_pgs_trait_min)),
    metric('wgs_class_entries', 'CNV/SV/repeat compact interpretation entries', wgsClassEntries, thresholds.wgs_class_entry_min, percentScore(wgsClassEntries, thresholds.wgs_class_entry_min)),
    metric('compact_size', 'Compiled compact catalog stays below repo size budget', compactCatalog.summary.compiled_json_bytes <= thresholds.compact_catalog_max_bytes, true, compactCatalog.summary.compiled_json_bytes <= thresholds.compact_catalog_max_bytes ? 100 : 0),
    metric('large_database_default', 'Default path does not require a large local database', defaultRequiresLargeDatabase, false, defaultRequiresLargeDatabase ? 0 : 100),
  ];
  const passed = metrics.every(item => item.passed);
  const rawScore = Math.round(metrics.reduce((sum, item) => sum + item.score, 0) / metrics.length);

  return {
    generated_at: new Date().toISOString(),
    purpose: 'Internal coverage depth report for compact, local-first variant interpretation.',
    thresholds,
    summary: {
      score: passed ? rawScore : Math.min(rawScore, 89),
      status: metrics.some(item => item.score < 60) ? 'fail' : passed ? 'pass' : 'warn',
      source_families_supported: sourceFamiliesSupported,
      default_requires_large_database: defaultRequiresLargeDatabase,
      compact_catalog_entries: compactCatalog.summary.total_entries,
      compact_catalog_bytes: compactCatalog.summary.compiled_json_bytes,
      curated_marker_entries: curatedMarkerEntries,
      provenance_graded_markers: provenanceGradedMarkers,
      clinvar_gene_targets: clinvarGeneTargets,
      acmg_secondary_genes: ACMG_SF_GENES.size,
      recessive_carrier_genes: RECESSIVE_DISEASE_GENES.size,
      cpic_gene_drug_rules: cpicGeneDrugRules,
      cpic_unique_genes: cpicUniqueGenes.size,
      cpic_unique_drugs: cpicUniqueDrugs.size,
      cpic_unique_rsids: cpicUniqueRsids.size,
      pgs_traits: pgsTraits.size,
      pgs_variants: pgsVariantRsids.size,
      wellness_pgs_traits: wellnessPgsTraits,
      wgs_class_entries: wgsClassEntries,
      deeper_caller_optional_entries: compactCatalog.summary.requires_deeper_caller_entries,
    },
    metrics,
    install_policy: {
      large_external_caches_in_repo: compactCatalog.size_budget.large_external_caches_in_repo,
      optional_network_enrichment: true,
      repo_contained_default: !defaultRequiresLargeDatabase,
      note: 'Default interpretation uses repo-contained compact slices; large public sources are optional caches or source-generation inputs.',
    },
    source_families: [
      {
        id: 'curated_rsid_marker',
        role: 'direct genotype interpretation for common and wellness-relevant markers',
        local_slice: 'shared/interpretations/*.json',
        large_database_required_for_default: false,
      },
      {
        id: 'clinvar_gene_slice',
        role: 'P/LP target-gene and carrier-status review templates',
        local_slice: 'ACMG and recessive gene sets in clinvar_enrichment.ts',
        large_database_required_for_default: false,
      },
      {
        id: 'cpic_drug_gene_rule',
        role: 'pharmacogenetic gene-drug rules for clinician discussion',
        local_slice: 'CPIC Level A pairs in cpic_enrichment.ts',
        large_database_required_for_default: false,
      },
      {
        id: 'polygenic_score',
        role: 'selected wellness, cardiometabolic, cancer, cognition, and aging-adjacent PRS scores',
        local_slice: 'shared/prs_weights.json',
        large_database_required_for_default: false,
      },
      {
        id: 'cnv_sv_repeat_catalog',
        role: 'CNV, SV, large-indel, and tandem-repeat readiness and interpretation templates',
        local_slice: 'references/wgs-interpretation-catalog.json',
        large_database_required_for_default: false,
      },
    ],
    passed,
  };
}

function main(): void {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const packageDir = path.resolve(scriptDir, '../..');
  const outPath = path.resolve(argValue('--out') ?? path.join(packageDir, 'output/interpretation-depth-report.json'));
  const report = buildInterpretationDepthReport(packageDir);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    status: report.passed ? 'pass' : 'fail',
    score: report.summary.score,
    output: outPath,
    source_families_supported: report.summary.source_families_supported,
    compact_catalog_entries: report.summary.compact_catalog_entries,
    provenance_graded_markers: report.summary.provenance_graded_markers,
    clinvar_gene_targets: report.summary.clinvar_gene_targets,
    cpic_gene_drug_rules: report.summary.cpic_gene_drug_rules,
    pgs_traits: report.summary.pgs_traits,
    pgs_variants: report.summary.pgs_variants,
    default_requires_large_database: report.summary.default_requires_large_database,
  }, null, 2));
  if (!report.passed) process.exit(1);
}

if (process.argv[1]?.endsWith('interpretation_depth_metrics.ts')) {
  main();
}

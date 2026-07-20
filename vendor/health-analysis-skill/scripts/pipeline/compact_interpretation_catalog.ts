#!/usr/bin/env npx tsx
/**
 * Compact VCF-first interpretation catalog builder.
 *
 * This compiles only repo-contained interpretation slices. Large public source
 * databases remain optional local caches; the compiled report records their
 * source policy without vendoring raw archives.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { ACMG_GENE_INFO, ACMG_SF_GENES, RECESSIVE_DISEASE_GENES } from './clinvar_enrichment.js';
import { CPIC_LEVEL_A_PAIRS } from './cpic_enrichment.js';
import { HEREDITARY_CANCER_PANEL_GENES, HEREDITARY_CANCER_PANEL_SOURCE } from './hereditary_cancer_panel.js';

type CatalogCategory =
  | 'genetic_vulnerability'
  | 'pharmacogenetics'
  | 'hereditary_conditions'
  | 'personal_traits'
  | 'wellness'
  | 'ancestry'
  | 'wgs_variant_class'
  | 'pathway_context';

type CatalogSourceType =
  | 'curated_rsid_marker'
  | 'polygenic_score'
  | 'cnv_sv_repeat_catalog'
  | 'knowledge_graph_topic'
  | 'clinvar_gene_slice'
  | 'cpic_drug_gene_rule';

interface CatalogManifest {
  version: string;
  purpose: string;
  default_input_model: {
    expected_inputs: string[];
    raw_read_inputs: string[];
    raw_read_callers_required_for_default: boolean;
    raw_read_callers_required_when: string[];
  };
  repo_size_budget: {
    compiled_catalog_max_bytes: number;
    reference_manifest_max_bytes: number;
    large_external_caches_in_repo: boolean;
  };
  repo_contained_sources: Array<{ id: string; path: string; role: string; source_policy: string }>;
  optional_external_sources: Array<{ id: string; name: string; url: string; recommended_use: string; repo_policy: string }>;
  consumer_interpretation_policy: {
    always_distinguish: string[];
    do_not_claim: string[];
  };
}

interface CompactCatalogEntry {
  id: string;
  category: CatalogCategory;
  source_type: CatalogSourceType;
  source: string;
  evidence_tier: 1 | 2 | 3;
  consumer_ready: boolean;
  requires_deeper_caller: boolean;
  rsid?: string;
  gene?: string;
  trait?: string;
  label: string;
  consumer_scope: string;
}

interface MarkerFile {
  markers?: Record<string, {
    gene?: string;
    display?: string;
    name?: string;
    category?: string;
    evidenceTier?: 1 | 2 | 3;
  }>;
}

interface PrsWeights {
  diseases?: string[];
}

interface WgsCatalog {
  dosage_sensitive_regions?: Array<{ id?: string; gene?: string; condition?: string; label?: string }>;
  repeat_loci?: Array<{ id?: string; gene?: string; condition?: string; label?: string }>;
  structural_genes?: Array<{ gene?: string; condition?: string; label?: string; reason?: string }>;
}

export interface CompactInterpretationCatalog {
  version: string;
  generated_at: string;
  manifest_path: string;
  input_model: CatalogManifest['default_input_model'];
  size_budget: CatalogManifest['repo_size_budget'];
  optional_external_sources: CatalogManifest['optional_external_sources'];
  consumer_interpretation_policy: CatalogManifest['consumer_interpretation_policy'];
  entries: CompactCatalogEntry[];
  summary: {
    total_entries: number;
    consumer_ready_entries: number;
    requires_deeper_caller_entries: number;
    categories: Record<string, number>;
    source_types: Record<string, number>;
    wellness_optimization_entries: number;
    clinvar_gene_targets: number;
    cpic_gene_drug_rules: number;
    optional_source_families: number;
    raw_read_callers_required_for_default: boolean;
    compiled_json_bytes: number;
    within_repo_size_budget: boolean;
  };
}

const INTERPRETATION_FILES: Array<{ file: string; category: CatalogCategory }> = [
  { file: 'health-vulnerability.json', category: 'health_vulnerability' },
  { file: 'pharmacogenomics.json', category: 'pharmacogenomics' },
  { file: 'inherited-conditions.json', category: 'inherited_conditions' },
  { file: 'cognitive.json', category: 'cognitive' },
  { file: 'superpowers.json', category: 'superpowers' },
  { file: 'metabolism.json', category: 'metabolism' },
  { file: 'physical-traits.json', category: 'physical_traits' },
  { file: 'cardiometabolic.json', category: 'cardiometabolic' },
  { file: 'inflammation.json', category: 'inflammation' },
  { file: 'cellular-health.json', category: 'cellular_health' },
  { file: 'skeletal-health.json', category: 'skeletal_health' },
];

const WELLNESS_OPTIMIZATION_TRAITS = new Set([
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
  'alcohol_consumption',
  'caffeine_metabolism',
]);

const CLINVAR_WELLNESS_REVIEW_GENES: Array<{ gene: string; label: string; category: CatalogCategory }> = [
  { gene: 'APOE', label: 'APOE lipid and neurodegeneration ClinVar review', category: 'genetic_vulnerability' },
  { gene: 'LPA', label: 'LPA inherited lipoprotein(a) ClinVar review', category: 'genetic_vulnerability' },
  { gene: 'TTR', label: 'TTR amyloidosis ClinVar review', category: 'hereditary_conditions' },
  { gene: 'GCK', label: 'GCK monogenic glucose regulation ClinVar review', category: 'genetic_vulnerability' },
  { gene: 'HNF1A', label: 'HNF1A monogenic diabetes ClinVar review', category: 'genetic_vulnerability' },
  { gene: 'HNF4A', label: 'HNF4A monogenic diabetes ClinVar review', category: 'genetic_vulnerability' },
  { gene: 'ABCG5', label: 'ABCG5 sterol metabolism ClinVar review', category: 'genetic_vulnerability' },
  { gene: 'ABCG8', label: 'ABCG8 sterol metabolism ClinVar review', category: 'genetic_vulnerability' },
  { gene: 'CETP', label: 'CETP lipid metabolism ClinVar review', category: 'genetic_vulnerability' },
  { gene: 'LPL', label: 'LPL triglyceride metabolism ClinVar review', category: 'genetic_vulnerability' },
  { gene: 'APOC3', label: 'APOC3 triglyceride metabolism ClinVar review', category: 'genetic_vulnerability' },
  { gene: 'ANGPTL3', label: 'ANGPTL3 lipid metabolism ClinVar review', category: 'genetic_vulnerability' },
  { gene: 'ANGPTL4', label: 'ANGPTL4 lipid metabolism ClinVar review', category: 'genetic_vulnerability' },
  { gene: 'PALB2', label: 'PALB2 hereditary cancer ClinVar review', category: 'hereditary_conditions' },
  { gene: 'CHEK2', label: 'CHEK2 hereditary cancer ClinVar review', category: 'hereditary_conditions' },
  { gene: 'BARD1', label: 'BARD1 hereditary cancer ClinVar review', category: 'hereditary_conditions' },
  { gene: 'RAD51C', label: 'RAD51C hereditary cancer ClinVar review', category: 'hereditary_conditions' },
  { gene: 'RAD51D', label: 'RAD51D hereditary cancer ClinVar review', category: 'hereditary_conditions' },
  { gene: 'MITF', label: 'MITF melanoma susceptibility ClinVar review', category: 'genetic_vulnerability' },
  { gene: 'MC1R', label: 'MC1R skin and pigment-risk ClinVar review', category: 'genetic_vulnerability' },
];

function argValue(flag: string): string | undefined {
  const direct = process.argv.find(arg => arg.startsWith(`${flag}=`));
  if (direct) return direct.split('=').slice(1).join('=');
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function readOptionalJson<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return readJson<T>(filePath);
}

function normalizeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

function titleize(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function addEntry(entries: Map<string, CompactCatalogEntry>, entry: CompactCatalogEntry): void {
  entries.set(normalizeId(entry.id), { ...entry, id: normalizeId(entry.id) });
}

function addMarkerEntries(packageDir: string, entries: Map<string, CompactCatalogEntry>): void {
  const interpretationsDir = path.join(packageDir, 'shared/interpretations');
  for (const item of INTERPRETATION_FILES) {
    const data = readOptionalJson<MarkerFile>(path.join(interpretationsDir, item.file));
    for (const [rsid, marker] of Object.entries(data?.markers ?? {})) {
      addEntry(entries, {
        id: `rsid_${item.file}_${rsid}`,
        category: item.category,
        source_type: 'curated_rsid_marker',
        source: `shared/interpretations/${item.file}`,
        evidence_tier: marker.evidenceTier ?? (item.category === 'pharmacogenetics' || item.category === 'hereditary_conditions' ? 1 : 2),
        consumer_ready: true,
        requires_deeper_caller: false,
        rsid,
        gene: marker.gene,
        label: marker.display || marker.name || `${marker.gene ?? rsid} marker`,
        consumer_scope: 'Direct genotype-level interpretation when this rsID is present in a WGS or SNP-array VCF.',
      });
    }
  }
}

function inferPrsCategory(trait: string): CatalogCategory {
  if (WELLNESS_OPTIMIZATION_TRAITS.has(trait)) return 'wellness';
  return 'genetic_vulnerability';
}

function addPrsEntries(packageDir: string, entries: Map<string, CompactCatalogEntry>): void {
  const data = readOptionalJson<PrsWeights>(path.join(packageDir, 'shared/prs_weights.json'));
  for (const trait of data?.diseases ?? []) {
    addEntry(entries, {
      id: `prs_${trait}`,
      category: inferPrsCategory(trait),
      source_type: 'polygenic_score',
      source: 'shared/prs_weights.json',
      evidence_tier: WELLNESS_OPTIMIZATION_TRAITS.has(trait) ? 2 : 1,
      consumer_ready: true,
      requires_deeper_caller: false,
      trait,
      label: `${titleize(trait)} polygenic score`,
      consumer_scope: 'Directional polygenic interpretation when enough score variants are present; explain alongside biomarkers and behavior data.',
    });
  }
}

function addClinVarTargetEntries(entries: Map<string, CompactCatalogEntry>): void {
  for (const gene of ACMG_SF_GENES) {
    const info = ACMG_GENE_INFO[gene];
    addEntry(entries, {
      id: `clinvar_acmg_${gene}`,
      category: 'hereditary_conditions',
      source_type: 'clinvar_gene_slice',
      source: 'scripts/pipeline/clinvar_enrichment.ts',
      evidence_tier: 1,
      consumer_ready: true,
      requires_deeper_caller: false,
      gene,
      label: info ? `${gene} ${info.condition} ClinVar review` : `${gene} ACMG ClinVar review`,
      consumer_scope: 'Only surface matched pathogenic or likely pathogenic variants with review-status context; absence of a match is not a clinical clearance.',
    });
  }

  for (const gene of HEREDITARY_CANCER_PANEL_GENES) {
    addEntry(entries, {
      id: `clinvar_hereditary_cancer_panel_${gene}`,
      category: 'hereditary_conditions',
      source_type: 'clinvar_gene_slice',
      source: HEREDITARY_CANCER_PANEL_SOURCE,
      evidence_tier: 1,
      consumer_ready: true,
      requires_deeper_caller: false,
      gene,
      label: `${gene} hereditary cancer ClinVar review`,
      consumer_scope: 'Only surface matched pathogenic, likely pathogenic, risk-factor, or protective variants with review-status context; absence of a match is not a clinical clearance.',
    });
  }

  for (const gene of RECESSIVE_DISEASE_GENES) {
    addEntry(entries, {
      id: `clinvar_carrier_${gene}`,
      category: 'hereditary_conditions',
      source_type: 'clinvar_gene_slice',
      source: 'scripts/pipeline/clinvar_enrichment.ts',
      evidence_tier: 2,
      consumer_ready: true,
      requires_deeper_caller: false,
      gene,
      label: `${gene} carrier-status ClinVar review`,
      consumer_scope: 'Only surface matched pathogenic or likely pathogenic carrier findings with zygosity and inheritance context.',
    });
  }

  for (const item of CLINVAR_WELLNESS_REVIEW_GENES) {
    addEntry(entries, {
      id: `clinvar_wellness_review_${item.gene}`,
      category: item.category,
      source_type: 'clinvar_gene_slice',
      source: 'scripts/pipeline/compact_interpretation_catalog.ts',
      evidence_tier: 2,
      consumer_ready: true,
      requires_deeper_caller: false,
      gene: item.gene,
      label: item.label,
      consumer_scope: 'Only surface matched ClinVar-supported findings with evidence status and plain-language wellness or prevention context.',
    });
  }
}

function addCpicRuleEntries(entries: Map<string, CompactCatalogEntry>): void {
  for (const pair of CPIC_LEVEL_A_PAIRS) {
    addEntry(entries, {
      id: `cpic_${pair.gene}_${pair.drug}_${pair.rsid}`,
      category: 'pharmacogenetics',
      source_type: 'cpic_drug_gene_rule',
      source: 'scripts/pipeline/cpic_enrichment.ts',
      evidence_tier: pair.cpicLevel === 'A' ? 1 : 2,
      consumer_ready: true,
      requires_deeper_caller: false,
      rsid: pair.rsid,
      gene: pair.gene,
      label: `${pair.gene} - ${pair.drug} CPIC ${pair.cpicLevel} rule`,
      consumer_scope: 'Report as medication-response context for clinician discussion; do not present as a standalone prescribing instruction.',
    });
  }
}

function addWgsClassEntries(packageDir: string, entries: Map<string, CompactCatalogEntry>): void {
  const catalog = readOptionalJson<WgsCatalog>(path.join(packageDir, 'references/wgs-interpretation-catalog.json'));
  for (const region of catalog?.dosage_sensitive_regions ?? []) {
    addEntry(entries, {
      id: `cnv_${region.id ?? region.gene ?? region.condition ?? region.label}`,
      category: 'wgs_variant_class',
      source_type: 'cnv_sv_repeat_catalog',
      source: 'references/wgs-interpretation-catalog.json',
      evidence_tier: 1,
      consumer_ready: false,
      requires_deeper_caller: true,
      gene: region.gene,
      label: `${region.condition || region.label || region.gene || 'Dosage-sensitive region'} CNV readiness`,
      consumer_scope: 'Report only after the input VCF contains validated CNV calls or a deeper caller is run from BAM/CRAM.',
    });
  }
  for (const repeat of catalog?.repeat_loci ?? []) {
    addEntry(entries, {
      id: `repeat_${repeat.id ?? repeat.gene ?? repeat.condition ?? repeat.label}`,
      category: 'wgs_variant_class',
      source_type: 'cnv_sv_repeat_catalog',
      source: 'references/wgs-interpretation-catalog.json',
      evidence_tier: 1,
      consumer_ready: false,
      requires_deeper_caller: true,
      gene: repeat.gene,
      label: `${repeat.condition || repeat.label || repeat.gene || 'Repeat locus'} readiness`,
      consumer_scope: 'Report only after the input VCF contains validated repeat calls or a repeat caller is run from BAM/CRAM.',
    });
  }
  for (const structural of catalog?.structural_genes ?? []) {
    addEntry(entries, {
      id: `sv_${structural.gene ?? structural.condition ?? structural.label}`,
      category: 'wgs_variant_class',
      source_type: 'cnv_sv_repeat_catalog',
      source: 'references/wgs-interpretation-catalog.json',
      evidence_tier: 1,
      consumer_ready: false,
      requires_deeper_caller: true,
      gene: structural.gene,
      label: `${structural.condition || structural.label || structural.gene || 'Structural gene'} SV readiness`,
      consumer_scope: structural.reason || 'Report only after the input VCF contains validated structural-variant calls.',
    });
  }
}

function addKnowledgeGraphEntries(packageDir: string, entries: Map<string, CompactCatalogEntry>): void {
  const data = readOptionalJson<Record<string, unknown>>(path.join(packageDir, 'shared/knowledge_graph_data.json'));
  for (const topic of Object.keys(data ?? {})) {
    if (topic.startsWith('_')) continue;
    addEntry(entries, {
      id: `kg_${topic}`,
      category: 'pathway_context',
      source_type: 'knowledge_graph_topic',
      source: 'shared/knowledge_graph_data.json',
      evidence_tier: 3,
      consumer_ready: true,
      requires_deeper_caller: false,
      trait: topic,
      label: titleize(topic),
      consumer_scope: 'Pathway and action context used after variant or PRS evidence maps into this topic.',
    });
  }
}

function summarize(entries: CompactCatalogEntry[], manifest: CatalogManifest): CompactInterpretationCatalog['summary'] {
  const categories: Record<string, number> = {};
  const sourceTypes: Record<string, number> = {};
  for (const entry of entries) {
    categories[entry.category] = (categories[entry.category] ?? 0) + 1;
    sourceTypes[entry.source_type] = (sourceTypes[entry.source_type] ?? 0) + 1;
  }
  const roughBytes = Buffer.byteLength(JSON.stringify({ entries }), 'utf8');
  return {
    total_entries: entries.length,
    consumer_ready_entries: entries.filter(entry => entry.consumer_ready).length,
    requires_deeper_caller_entries: entries.filter(entry => entry.requires_deeper_caller).length,
    categories,
    source_types: sourceTypes,
    wellness_optimization_entries: entries.filter(entry =>
      entry.category === 'wellness'
        || (entry.trait ? WELLNESS_OPTIMIZATION_TRAITS.has(entry.trait) : false)
        || /sleep|vo2|max|vitamin|homocysteine|telomere|caffeine|alcohol|reaction|cognitive|cholesterol|inflammation/i.test(entry.label)
    ).length,
    clinvar_gene_targets: entries.filter(entry => entry.source_type === 'clinvar_gene_slice').length,
    cpic_gene_drug_rules: entries.filter(entry => entry.source_type === 'cpic_drug_gene_rule').length,
    optional_source_families: manifest.optional_external_sources.length,
    raw_read_callers_required_for_default: manifest.default_input_model.raw_read_callers_required_for_default,
    compiled_json_bytes: roughBytes,
    within_repo_size_budget: roughBytes <= manifest.repo_size_budget.compiled_catalog_max_bytes,
  };
}

export function buildCompactInterpretationCatalog(options: {
  packageDir: string;
  manifestPath?: string;
}): CompactInterpretationCatalog {
  const manifestPath = options.manifestPath ?? path.join(options.packageDir, 'references/compact-catalog-manifest.json');
  const manifest = readJson<CatalogManifest>(manifestPath);
  const entriesById = new Map<string, CompactCatalogEntry>();
  addMarkerEntries(options.packageDir, entriesById);
  addPrsEntries(options.packageDir, entriesById);
  addClinVarTargetEntries(entriesById);
  addCpicRuleEntries(entriesById);
  addWgsClassEntries(options.packageDir, entriesById);
  addKnowledgeGraphEntries(options.packageDir, entriesById);
  const entries = [...entriesById.values()].sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));

  const catalog: CompactInterpretationCatalog = {
    version: manifest.version,
    generated_at: new Date().toISOString(),
    manifest_path: manifestPath,
    input_model: manifest.default_input_model,
    size_budget: manifest.repo_size_budget,
    optional_external_sources: manifest.optional_external_sources,
    consumer_interpretation_policy: manifest.consumer_interpretation_policy,
    entries,
    summary: summarize(entries, manifest),
  };
  catalog.summary.compiled_json_bytes = Buffer.byteLength(JSON.stringify(catalog), 'utf8');
  catalog.summary.within_repo_size_budget = catalog.summary.compiled_json_bytes <= manifest.repo_size_budget.compiled_catalog_max_bytes;
  return catalog;
}

function main(): void {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const packageDir = path.resolve(scriptDir, '../..');
  const outPath = path.resolve(argValue('--out') ?? path.join(packageDir, 'output/compact-interpretation-catalog.json'));
  const catalog = buildCompactInterpretationCatalog({ packageDir });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    status: catalog.summary.within_repo_size_budget ? 'pass' : 'fail',
    output: outPath,
    total_entries: catalog.summary.total_entries,
    consumer_ready_entries: catalog.summary.consumer_ready_entries,
    wellness_optimization_entries: catalog.summary.wellness_optimization_entries,
    compiled_json_bytes: catalog.summary.compiled_json_bytes,
    raw_read_callers_required_for_default: catalog.summary.raw_read_callers_required_for_default,
  }, null, 2));
  if (!catalog.summary.within_repo_size_budget) process.exit(1);
}

if (process.argv[1]?.endsWith('compact_interpretation_catalog.ts')) {
  main();
}

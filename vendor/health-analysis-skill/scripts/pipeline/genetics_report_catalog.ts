#!/usr/bin/env npx tsx
/**
 * Internal genetics report-catalog builder.
 *
 * This is not rendered to users. It gives the skill pipeline a report-topic
 * inventory comparable to consumer WGS products without polluting rsID marker
 * interpretation files with gene-level or capability-level coverage entries.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { ACMG_GENE_INFO, ACMG_SF_GENES, RECESSIVE_DISEASE_GENES } from './clinvar_enrichment.js';
import { HEREDITARY_CANCER_PANEL_GENES, HEREDITARY_CANCER_PANEL_SOURCE } from './hereditary_cancer_panel.js';

export type GeneticsReportCategory =
  | 'genetic_vulnerability'
  | 'pharmacogenetics'
  | 'hereditary_conditions'
  | 'personal_traits'
  | 'metabolism'
  | 'physical-traits';

export type GeneticsReportSourceType =
  | 'curated_marker'
  | 'acmg_secondary_findings'
  | 'hereditary_cancer_panel_gene'
  | 'recessive_carrier_gene'
  | 'pharmacogene'
  | 'personal_trait_gene'
  | 'polygenic_risk_score'
  | 'knowledge_graph_topic'
  | 'wgs_variant_class';

export interface GeneticsReportCatalogEntry {
  id: string;
  category: GeneticsReportCategory;
  label: string;
  source_type: GeneticsReportSourceType;
  evidence_source: string;
  evidence_tier: 1 | 2 | 3;
  capability: string;
  gene?: string;
}

export interface GeneticsReportCatalog {
  version: string;
  generated_at: string;
  purpose: string;
  entries: GeneticsReportCatalogEntry[];
  summary: {
    total_entries: number;
    valid_entries: number;
    duplicate_ids_dropped: number;
    source_types: string[];
    category_counts: Record<GeneticsReportCategory, number>;
    invalid_entries: Array<{ id?: string; reason: string }>;
  };
}

interface MarkerFile {
  markers?: Record<string, {
    gene?: string;
    display?: string;
    name?: string;
    category?: string;
  }>;
}

interface PrsWeights {
  diseases?: string[];
}

interface WgsCatalog {
  dosage_sensitive_regions?: Array<{ region?: string; gene?: string; condition?: string; label?: string }>;
  repeat_loci?: Array<{ locus?: string; gene?: string; condition?: string; label?: string }>;
  structural_genes?: Array<{ gene?: string; condition?: string; label?: string }>;
}

const CATEGORY_COUNTS_TEMPLATE: Record<GeneticsReportCategory, number> = {
  genetic_vulnerability: 0,
  pharmacogenetics: 0,
  hereditary_conditions: 0,
  personal_traits: 0,
  wellness: 0,
  ancestry: 0,
};

const INTERPRETATION_CATEGORY_MAP: Record<string, GeneticsReportCategory> = {
  vulnerability: 'genetic_vulnerability',
  pharmacology: 'pharmacogenetics',
  hereditary: 'hereditary_conditions',
  personality: 'personal_traits',
  performance: 'personal_traits',
  wellness: 'metabolism',
  ancestry: 'physical-traits',
};

const INTERPRETATION_FILES: Array<{ file: string; sourceCategory: string }> = [
  { file: 'vulnerability.json', sourceCategory: 'vulnerability' },
  { file: 'pharmacology.json', sourceCategory: 'pharmacogenomics' },
  { file: 'hereditary.json', sourceCategory: 'inherited-conditions' },
  { file: 'personality.json', sourceCategory: 'cognitive' },
  { file: 'performance.json', sourceCategory: 'superpowers' },
  { file: 'wellness.json', sourceCategory: 'metabolism' },
  { file: 'ancestry.json', sourceCategory: 'physical-traits' },
];

const PERSONAL_PRS = new Set([
  'vo2max',
  'grip_strength',
  'sleep_duration',
  'chronotype_morningness',
  'reaction_time',
  'cognitive_performance',
  'neuroticism',
  'alcohol_consumption',
  'caffeine_metabolism',
  'lean_body_mass',
]);

const WELLNESS_PRS = new Set([
  'telomere_length',
  'vitamin_d',
  'homocysteine',
  'epigenetic_age_grimage',
  'igf1_levels',
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

function readOptionalJson<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return readJson<T>(filePath);
  } catch {
    return undefined;
  }
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
    .replace(/^_+/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function isValidEntry(entry: GeneticsReportCatalogEntry): string | undefined {
  if (!entry.id) return 'missing id';
  if (!entry.category) return 'missing category';
  if (!entry.label) return 'missing label';
  if (!entry.source_type) return 'missing source_type';
  if (!entry.evidence_source) return 'missing evidence_source';
  if (!entry.capability) return 'missing capability';
  if (![1, 2, 3].includes(entry.evidence_tier)) return 'missing evidence_tier';
  return undefined;
}

function inferPrsCategory(trait: string): GeneticsReportCategory {
  if (PERSONAL_PRS.has(trait)) return 'personal_traits';
  if (WELLNESS_PRS.has(trait)) return 'metabolism';
  return 'genetic_vulnerability';
}

function inferKnowledgeGraphCategory(topic: string): GeneticsReportCategory {
  if (/(drug|cyp|warfarin|statin|thiopurine|fluoropyrimidine|irinotecan|cardiotoxicity|acetylator|smoking_cessation|hypersensitivity|transport)/i.test(topic)) {
    return 'pharmacogenetics';
  }
  if (/(carrier|clinvar|hereditary|aortopathy|arrhythmia|cardiomyopathy|connective_tissue|developmental|rare_functional|monogenic|thrombosis|hearing_health|eye_health|heme_metabolism|iron_overload|kidney_health|muscular|malignant_hyperthermia)/i.test(topic)) {
    return 'hereditary_conditions';
  }
  if (/(risk|cardio|cholesterol|lipid|blood_pressure|cancer|neurodegeneration|inflammation|glucose|insulin|body_weight|bone|brain|liver|respiratory|thyroid|urate|skin_health|health_profile|baseline_labs)/i.test(topic)) {
    return 'genetic_vulnerability';
  }
  if (/(fitness|performance|strength|exercise|sleep|circadian|dopamine|serotonin|neuroplasticity|neurotransmitter|alcohol|caffeine|lactose|histamine|body_composition|thermogenesis)/i.test(topic)) {
    return 'personal_traits';
  }
  return 'metabolism';
}

function addEntry(
  entriesById: Map<string, GeneticsReportCatalogEntry>,
  duplicateCounter: { count: number },
  entry: GeneticsReportCatalogEntry,
): void {
  const normalizedEntry = { ...entry, id: normalizeId(entry.id) };
  if (entriesById.has(normalizedEntry.id)) {
    duplicateCounter.count += 1;
    return;
  }
  entriesById.set(normalizedEntry.id, normalizedEntry);
}

function addInterpretationMarkers(packageDir: string, entriesById: Map<string, GeneticsReportCatalogEntry>, duplicates: { count: number }): void {
  const interpretationDir = path.join(packageDir, 'shared/interpretations');
  for (const { file, sourceCategory } of INTERPRETATION_FILES) {
    const filePath = path.join(interpretationDir, file);
    const data = readOptionalJson<MarkerFile>(filePath);
    const category = INTERPRETATION_CATEGORY_MAP[sourceCategory];
    if (!data?.markers || !category) continue;

    for (const [rsid, marker] of Object.entries(data.markers)) {
      addEntry(entriesById, duplicates, {
        id: `marker_${file}_${rsid}`,
        category,
        label: marker.display || marker.name || `${marker.gene ?? rsid} marker`,
        source_type: 'curated_marker',
        evidence_source: `shared/interpretations/${file}`,
        evidence_tier: category === 'hereditary_conditions' || category === 'pharmacogenetics' ? 1 : 2,
        capability: 'rsid_genotype_interpretation',
        gene: marker.gene,
      });
    }
  }
}

function addAcmgAndCarrierGenes(entriesById: Map<string, GeneticsReportCatalogEntry>, duplicates: { count: number }): void {
  for (const gene of ACMG_SF_GENES) {
    const info = ACMG_GENE_INFO[gene];
    addEntry(entriesById, duplicates, {
      id: `acmg_secondary_${gene}`,
      category: 'hereditary_conditions',
      label: info ? `${gene} - ${info.condition}` : `${gene} ACMG secondary finding`,
      source_type: 'acmg_secondary_findings',
      evidence_source: 'ACMG secondary findings gene set in clinvar_enrichment.ts',
      evidence_tier: 1,
      capability: 'actionable_secondary_finding_gene_review',
      gene,
    });
  }

  for (const gene of HEREDITARY_CANCER_PANEL_GENES) {
    addEntry(entriesById, duplicates, {
      id: `hereditary_cancer_panel_${gene}`,
      category: 'hereditary_conditions',
      label: `${gene} hereditary cancer panel review`,
      source_type: 'hereditary_cancer_panel_gene',
      evidence_source: HEREDITARY_CANCER_PANEL_SOURCE,
      evidence_tier: 1,
      capability: 'hereditary_cancer_clinvar_gene_review',
      gene,
    });
  }

  for (const gene of RECESSIVE_DISEASE_GENES) {
    addEntry(entriesById, duplicates, {
      id: `recessive_carrier_${gene}`,
      category: 'hereditary_conditions',
      label: `${gene} carrier-status interpretation`,
      source_type: 'recessive_carrier_gene',
      evidence_source: 'recessive disease gene set in clinvar_enrichment.ts',
      evidence_tier: 2,
      capability: 'carrier_status_gene_review',
      gene,
    });
  }
}

function addPharmacogeneReports(packageDir: string, entriesById: Map<string, GeneticsReportCatalogEntry>, duplicates: { count: number }): void {
  const data = readOptionalJson<MarkerFile>(path.join(packageDir, 'shared/interpretations/pharmacology.json'));
  const genes = new Set<string>();
  for (const marker of Object.values(data?.markers ?? {})) {
    const gene = marker.gene?.trim();
    if (gene && gene !== 'ClinVar') genes.add(gene);
  }
  for (const gene of genes) {
    addEntry(entriesById, duplicates, {
      id: `pharmacogene_${gene}`,
      category: 'pharmacogenetics',
      label: `${gene} pharmacogenomic interpretation`,
      source_type: 'pharmacogene',
      evidence_source: 'shared/interpretations/pharmacology.json',
      evidence_tier: 1,
      capability: 'pharmacogene_drug_response_review',
      gene,
    });
  }
}

function addPersonalTraitGeneReports(packageDir: string, entriesById: Map<string, GeneticsReportCatalogEntry>, duplicates: { count: number }): void {
  const traitFiles = ['personality.json', 'performance.json'];
  const genes = new Set<string>();
  for (const file of traitFiles) {
    const data = readOptionalJson<MarkerFile>(path.join(packageDir, 'shared/interpretations', file));
    for (const marker of Object.values(data?.markers ?? {})) {
      const gene = marker.gene?.trim();
      if (gene && gene !== 'ClinVar') genes.add(gene);
    }
  }
  for (const gene of genes) {
    addEntry(entriesById, duplicates, {
      id: `personal_trait_gene_${gene}`,
      category: 'personal_traits',
      label: `${gene} personal-trait interpretation`,
      source_type: 'personal_trait_gene',
      evidence_source: 'shared/interpretations/personality.json + performance.json',
      evidence_tier: 2,
      capability: 'personal_trait_gene_review',
      gene,
    });
  }
}

function addPrsReports(packageDir: string, entriesById: Map<string, GeneticsReportCatalogEntry>, duplicates: { count: number }): void {
  const data = readOptionalJson<PrsWeights>(path.join(packageDir, 'shared/prs_weights.json'));
  for (const trait of data?.diseases ?? []) {
    addEntry(entriesById, duplicates, {
      id: `prs_${trait}`,
      category: inferPrsCategory(trait),
      label: `${titleize(trait)} PRS`,
      source_type: 'polygenic_risk_score',
      evidence_source: 'shared/prs_weights.json',
      evidence_tier: 2,
      capability: 'polygenic_risk_score',
    });
  }
}

function addKnowledgeGraphTopics(packageDir: string, entriesById: Map<string, GeneticsReportCatalogEntry>, duplicates: { count: number }): void {
  const data = readOptionalJson<Record<string, unknown>>(path.join(packageDir, 'shared/knowledge_graph_data.json'));
  for (const topic of Object.keys(data ?? {})) {
    if (topic.startsWith('_')) continue;
    addEntry(entriesById, duplicates, {
      id: `kg_${topic}`,
      category: inferKnowledgeGraphCategory(topic),
      label: titleize(topic),
      source_type: 'knowledge_graph_topic',
      evidence_source: 'shared/knowledge_graph_data.json',
      evidence_tier: inferKnowledgeGraphCategory(topic) === 'metabolism' ? 3 : 2,
      capability: 'trait_to_protocol_mapping',
    });
  }
}

function addWgsClassReports(packageDir: string, entriesById: Map<string, GeneticsReportCatalogEntry>, duplicates: { count: number }): void {
  const catalog = readOptionalJson<WgsCatalog>(path.join(packageDir, 'references/wgs-interpretation-catalog.json'));
  for (const region of catalog?.dosage_sensitive_regions ?? []) {
    const label = region.condition || region.label || region.region || region.gene || 'Dosage-sensitive region';
    addEntry(entriesById, duplicates, {
      id: `wgs_cnv_${label}`,
      category: 'hereditary_conditions',
      label: `${label} CNV interpretation`,
      source_type: 'wgs_variant_class',
      evidence_source: 'references/wgs-interpretation-catalog.json',
      evidence_tier: 1,
      capability: 'copy_number_variant_interpretation',
      gene: region.gene,
    });
  }
  for (const repeat of catalog?.repeat_loci ?? []) {
    const label = repeat.condition || repeat.label || repeat.locus || repeat.gene || 'Repeat-expansion locus';
    addEntry(entriesById, duplicates, {
      id: `wgs_repeat_${label}`,
      category: 'hereditary_conditions',
      label: `${label} repeat interpretation`,
      source_type: 'wgs_variant_class',
      evidence_source: 'references/wgs-interpretation-catalog.json',
      evidence_tier: 1,
      capability: 'tandem_repeat_interpretation',
      gene: repeat.gene,
    });
  }
  for (const structural of catalog?.structural_genes ?? []) {
    const label = structural.condition || structural.label || structural.gene || 'Structural variant gene';
    addEntry(entriesById, duplicates, {
      id: `wgs_structural_${label}`,
      category: 'hereditary_conditions',
      label: `${label} structural-variant interpretation`,
      source_type: 'wgs_variant_class',
      evidence_source: 'references/wgs-interpretation-catalog.json',
      evidence_tier: 1,
      capability: 'structural_variant_interpretation',
      gene: structural.gene,
    });
  }
}

export function buildGeneticsReportCatalog(packageDir: string): GeneticsReportCatalog {
  const entriesById = new Map<string, GeneticsReportCatalogEntry>();
  const duplicates = { count: 0 };

  addInterpretationMarkers(packageDir, entriesById, duplicates);
  addAcmgAndCarrierGenes(entriesById, duplicates);
  addPharmacogeneReports(packageDir, entriesById, duplicates);
  addPersonalTraitGeneReports(packageDir, entriesById, duplicates);
  addPrsReports(packageDir, entriesById, duplicates);
  addKnowledgeGraphTopics(packageDir, entriesById, duplicates);
  addWgsClassReports(packageDir, entriesById, duplicates);

  const entries = [...entriesById.values()].sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  const invalidEntries = entries
    .map(entry => ({ id: entry.id, reason: isValidEntry(entry) }))
    .filter((item): item is { id: string; reason: string } => Boolean(item.reason));
  const categoryCounts = { ...CATEGORY_COUNTS_TEMPLATE };
  for (const entry of entries) {
    categoryCounts[entry.category] += 1;
  }

  return {
    version: '2026-06-01',
    generated_at: new Date().toISOString(),
    purpose: 'Internal genetics report-topic coverage inventory for pipeline benchmarking only.',
    entries,
    summary: {
      total_entries: entries.length,
      valid_entries: entries.length - invalidEntries.length,
      duplicate_ids_dropped: duplicates.count,
      source_types: [...new Set(entries.map(entry => entry.source_type))].sort(),
      category_counts: categoryCounts,
      invalid_entries: invalidEntries,
    },
  };
}

function main(): void {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const packageDir = path.resolve(scriptDir, '../..');
  const outPath = path.resolve(argValue('--out') ?? path.join(packageDir, 'output/genetics-report-catalog.json'));
  const catalog = buildGeneticsReportCatalog(packageDir);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    status: catalog.summary.invalid_entries.length === 0 ? 'pass' : 'fail',
    total_entries: catalog.summary.total_entries,
    category_counts: catalog.summary.category_counts,
    source_types: catalog.summary.source_types,
    output: outPath,
  }, null, 2));
  if (catalog.summary.invalid_entries.length > 0) process.exit(1);
}

if (process.argv[1]?.endsWith('genetics_report_catalog.ts')) {
  main();
}

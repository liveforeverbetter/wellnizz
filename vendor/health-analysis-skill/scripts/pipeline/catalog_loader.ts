/**
 * Condition Catalog Loader
 *
 * Loads the six modality catalogs in `skills/longevity-analysis/{folder}/catalog/`
 * and surfaces matching entries given a user's annotated VCF gene set.
 *
 * Each catalog is condition-centric (a disease, drug, trait, or population)
 * with a gene panel and editorial narrative. This module is the bridge from
 * "VCF parsed into gene/variant calls" to "show me the condition-level context
 * for what the user actually carries."
 *
 * Pair with `shared/interpretations/{modality}.json` which is variant-centric
 * (per-rsID effect calls).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  HEREDITARY_CANCER_PANEL_GENES,
  HEREDITARY_CANCER_PANEL_ID,
  HEREDITARY_CANCER_PANEL_NAME,
  HEREDITARY_CANCER_PANEL_SOURCE,
} from './hereditary_cancer_panel.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// scripts/pipeline/  →  skills/longevity-analysis/
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

export type CatalogModality =
  | 'genetic-vulnerability'
  | 'inherited-conditions'
  | 'pharmacogenomics'
  | 'cognitive'
  | 'metabolism'
  | 'physical-traits';

export interface CatalogEntry {
  id: number;
  name: string | null;
  url_slug?: string | null;
  loci_count?: number | null;
}

export interface EditorialBlock {
  name?: string;
  description?: string;
  overview?: string;
  symptoms?: string;
  causes?: string;
  prevention?: string;
  dose?: string;
  report?: string;
  technical_description?: string;
  technical_citations?: string;
}

export interface StatusLookup {
  [statusId: string]: string;
}

export interface ConditionCatalog {
  modality: CatalogModality;
  entries: CatalogEntry[];
  editorial: Record<string, EditorialBlock>;
  geneMap: Record<string, string[]>;
  statusLookup?: StatusLookup;
}

export interface SurfacedCondition {
  id: number;
  name: string | null;
  modality: CatalogModality;
  editorial: EditorialBlock;
  matched_genes: string[];
  all_genes: string[];
  match_ratio: number;
}

export interface PharmacogeneVariant {
  gene: string;
  chromosome: string;
  position: number;
  rsid: string | null;
  reference_allele: string | null;
  alleles: Array<{ id: string; name: string }>;
}

export interface PharmacogeneVariantCatalog {
  [gene: string]: PharmacogeneVariant[];
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function addSyntheticHereditaryCancerPanel(catalog: ConditionCatalog): ConditionCatalog {
  if (catalog.modality !== 'inherited-conditions') return catalog;
  const id = String(HEREDITARY_CANCER_PANEL_ID);
  if (catalog.geneMap[id]) return catalog;

  return {
    ...catalog,
    entries: [
      ...catalog.entries,
      {
        id: HEREDITARY_CANCER_PANEL_ID,
        name: HEREDITARY_CANCER_PANEL_NAME,
        url_slug: 'results/monogenic-diseases/hereditary-multi-cancer-predisposition-panel',
        loci_count: HEREDITARY_CANCER_PANEL_GENES.length,
      },
    ],
    geneMap: {
      ...catalog.geneMap,
      [id]: [...HEREDITARY_CANCER_PANEL_GENES],
    },
    editorial: {
      ...catalog.editorial,
      [id]: {
        name: HEREDITARY_CANCER_PANEL_NAME,
        description: 'A broad hereditary cancer gene panel covering DNA repair, Lynch syndrome, tumor suppressor, endocrine, renal, skin, gastrointestinal, breast/gynecologic, and sarcoma predisposition genes.',
        overview: 'This panel context is used to keep hereditary cancer findings grouped when ClinVar evidence lands in any of the 71 genes. A matched pathogenic or risk-factor variant is not a diagnosis; it is a prompt for clinical confirmation and genetic counseling.',
        prevention: 'Use confirmed pathogenic findings to guide specialist review, family cascade testing, and organ-specific surveillance. A negative result in this local pipeline does not rule out inherited cancer risk, structural variants, RNA splicing effects, or non-inherited lifetime cancer risk.',
        technical_description: `Panel membership follows ${HEREDITARY_CANCER_PANEL_SOURCE}. The local pipeline joins user-specific ClinVar evidence by HGNC gene symbol and only promotes pathogenic, likely pathogenic, risk-factor, or protective evidence into condition findings.`,
      },
    },
  };
}

export function loadCatalog(modality: CatalogModality): ConditionCatalog {
  const dir = path.join(PACKAGE_ROOT, modality, 'catalog');
  const entries = readJsonSafe<CatalogEntry[]>(path.join(dir, 'catalog.json')) ?? [];
  const editorial = readJsonSafe<Record<string, EditorialBlock>>(path.join(dir, 'editorial.json')) ?? {};
  const geneMap = readJsonSafe<Record<string, string[]>>(path.join(dir, 'gene_map.json')) ?? {};
  const statusLookup = readJsonSafe<StatusLookup>(path.join(dir, 'status_lookup.json')) ?? undefined;
  return addSyntheticHereditaryCancerPanel({ modality, entries, editorial, geneMap, statusLookup });
}

export function loadAllCatalogs(): Record<CatalogModality, ConditionCatalog> {
  const modalities: CatalogModality[] = [
    'genetic-vulnerability',
    'inherited-conditions',
    'pharmacogenomics',
    'cognitive',
    'metabolism',
    'physical-traits',
  ];
  return modalities.reduce((acc, m) => {
    acc[m] = loadCatalog(m);
    return acc;
  }, {} as Record<CatalogModality, ConditionCatalog>);
}

/**
 * Surface catalog conditions whose gene panel intersects the user's gene set.
 *
 * Pass the set of HGNC gene symbols present in the annotated VCF (case-sensitive,
 * one symbol per gene). Returns the matched conditions ordered by match ratio
 * (descending), then by total panel size (descending).
 */
export function surfaceForGenes(catalog: ConditionCatalog, userGenes: Set<string>): SurfacedCondition[] {
  const out: SurfacedCondition[] = [];
  for (const entry of catalog.entries) {
    const panel = catalog.geneMap[String(entry.id)] ?? [];
    if (panel.length === 0) continue;
    const matched = panel.filter((g) => userGenes.has(g));
    if (matched.length === 0) continue;
    out.push({
      id: entry.id,
      name: entry.name,
      modality: catalog.modality,
      editorial: catalog.editorial[String(entry.id)] ?? {},
      matched_genes: matched,
      all_genes: panel,
      match_ratio: matched.length / panel.length,
    });
  }
  out.sort((a, b) => {
    if (b.match_ratio !== a.match_ratio) return b.match_ratio - a.match_ratio;
    return b.all_genes.length - a.all_genes.length;
  });
  return out;
}

export function loadPharmacogeneList(): string[] {
  const dir = path.join(PACKAGE_ROOT, 'pharmacogenomics', 'catalog');
  return readJsonSafe<string[]>(path.join(dir, 'pharmacogene_list.json')) ?? [];
}

export function loadPharmacogeneVariantCatalog(): PharmacogeneVariantCatalog {
  const dir = path.join(PACKAGE_ROOT, 'pharmacogenomics', 'catalog');
  return readJsonSafe<PharmacogeneVariantCatalog>(path.join(dir, 'pharmacogene_variant_catalog.json')) ?? {};
}

/**
 * Lookup pharmacogene variants by rsID across the whole pharmacogene catalog.
 * Useful when matching against an annotated VCF that has rsIDs but not genes.
 */
export function pharmacogeneVariantByRsid(catalog: PharmacogeneVariantCatalog, rsid: string): PharmacogeneVariant | null {
  for (const variants of Object.values(catalog)) {
    for (const v of variants) {
      if (v.rsid === rsid) return v;
    }
  }
  return null;
}

/**
 * Resolve a numeric status id (e.g. drugstatus 1289) to its human-readable label.
 */
export function resolveStatus(catalog: ConditionCatalog, statusId: number | string | null | undefined): string | null {
  if (statusId === null || statusId === undefined) return null;
  return catalog.statusLookup?.[String(statusId)] ?? null;
}

export interface CatalogMatchSummary {
  /** Distinct HGNC gene symbols seen in the user's annotated VCF */
  user_gene_count: number;
  /** Per-modality surfaced conditions */
  modalities: Partial<Record<CatalogModality, SurfacedCondition[]>>;
  /** Total surfaced conditions across all modalities */
  total_matches: number;
}

/**
 * Surface catalog matches across every modality for a user's gene set.
 *
 * Pass the HGNC gene symbols extracted from the annotated VCF (typically gathered
 * from ClinVar variant cards, VEP missense calls, and the protocol's alerts/
 * superpowers). Returns the per-modality match lists plus a count summary that
 * the dashboard transform can render.
 */
export function surfaceAcrossModalities(
  userGenes: Set<string>,
  catalogs?: Partial<Record<CatalogModality, ConditionCatalog>>,
): CatalogMatchSummary {
  const all = catalogs ?? loadAllCatalogs();
  const modalities: Partial<Record<CatalogModality, SurfacedCondition[]>> = {};
  let total = 0;
  for (const [modality, catalog] of Object.entries(all) as Array<[CatalogModality, ConditionCatalog | undefined]>) {
    if (!catalog) continue;
    const matches = surfaceForGenes(catalog, userGenes);
    modalities[modality] = matches;
    total += matches.length;
  }
  return {
    user_gene_count: userGenes.size,
    modalities,
    total_matches: total,
  };
}

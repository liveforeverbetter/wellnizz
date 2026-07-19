#!/usr/bin/env npx tsx
/**
 * Genomic Analysis Pipeline
 *
 * VCF File → Longevity Protocol JSON → Dashboard
 *
 * Usage:
 *   npx tsx scripts/analyze-vcf.ts <path-to-vcf-file> [--annotated]
 *
 * The pipeline:
 * 1. Parses VCF and optionally annotates with rsIDs via bcftools + dbSNP
 * 2. Builds rsID lookup map (primary) with position-based fallback
 * 3. Matches variants against interpretation database
 * 4. Outputs Longevity Protocol JSON for dashboard rendering
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "url";
import {
  queryClinVarForRSIDs,
  generateClinVarAlerts,
} from "../pipeline/clinvar_enrichment.js";
import type { ClinVarAnnotation } from "../pipeline/clinvar_enrichment.js";
import { matchCPIC, generateCPICAlerts } from "../pipeline/cpic_enrichment.js";
import { annotateWithVEP } from "../pipeline/vep_annotation.js";
import type { VEPAnnotation, VEPResult } from "../pipeline/vep_annotation.js";
import {
  findClinVarAnnotationReference,
  getClinVarDisclosure,
  getPackageDir,
} from "../pipeline/clinvar_reference.js";
import { runVcfDoctor } from "../pipeline/vcf_doctor.js";
import { writeVcfContigRenameMap } from "./vcf-contigs.js";

// ============================================================================
// Types
// ============================================================================

interface Variant {
  chrom: string;
  pos: number;
  id: string;
  ref: string;
  alt: string;
  qual: string;
  filter: string;
  info: string;
  format?: string;
  samples?: string[];
}

interface VariantMapEntry {
  chrom: string;
  pos: number;
  ref: string;
  alt: string;
  gt?: string;
}

export interface LongevityProtocol {
  version: string;
  generated: string;
  source: {
    fileName: string;
    variantCount: number;
    annotatedCount: number;
    matchedMarkerCount?: number;
    rsidAnnotationSource?: string;
    rsidAnnotationLimitation?: string;
    rsidExtractionMethod?: "bcftools" | "text_fallback";
    rsidExtractionFallbackReason?: string;
  };
  biologicalDossier: {
    name?: string;
    age?: number;
    gender?: string;
    ethnicity?: string;
  };
  genomicProfile: {
    alerts: Alert[];
    superpowers: Superpower[];
    topRisks: Risk[];
  };
  curatedInterpretations?: CuratedProtocolInterpretation[];
  dailyStack: {
    morning: Supplement[];
    prePerformance: Supplement[];
    night: Supplement[];
  };
  sourcingSafety: {
    formsToAvoid: string[];
    brandCriteria: string;
  };
}

export interface CuratedProtocolInterpretation {
  rsid: string;
  gene: string;
  label: string;
  interpretation: string;
  action?: string;
  evidenceTier?: 1 | 2 | 3;
  provenance: MarkerProvenance;
}

export interface InterpretationSource {
  id: string;
  label: string;
  url: string;
  type:
    | "variant_identity"
    | "primary_study"
    | "systematic_review"
    | "guideline"
    | "catalog";
}

export interface MarkerProvenance {
  status: "curated";
  reviewedAt: string;
  genomeBuild: "GRCh37";
  referenceAllele: string;
  commonAlleles: string[];
  sources: InterpretationSource[];
  limitations: string[];
}

interface Alert {
  itemName: string;
  tag: string;
  evidence: string;
  action: string;
  gene: string;
  rsid?: string;
  evidenceTier?: 1 | 2 | 3;
  provenance?: MarkerProvenance;
}

interface Superpower {
  itemName: string;
  tag: "🟢 Superpower";
  evidence: string;
  advantage: string;
  rsid?: string;
  gene?: string;
  evidenceTier?: 1 | 2 | 3;
  provenance?: MarkerProvenance;
}

interface Risk {
  itemName: string;
  tag: string;
  priority: 1 | 2 | 3;
  evidence: string;
  scienceSimplified: string;
  supplementation?: string;
  evidenceTier?: 1 | 2 | 3;
  rsid?: string;
  gene?: string;
  provenance?: MarkerProvenance;
}

interface Supplement {
  compound: string;
  dosage: string;
  timing: "morning" | "prePerformance" | "night";
  theWhy: string;
  brands: string[];
  reason: string;
}

type SupplementTiming = "morning" | "prePerformance" | "night";
type SupplementInput = {
  compound: string;
  dosage: string;
  brands?: string[];
  timing?: SupplementTiming;
};
type SupplementBuckets = Partial<Record<SupplementTiming, SupplementInput[]>>;
type SupplementSource = SupplementInput[] | SupplementBuckets;

interface MarkerInterpretation {
  rsid: string;
  gene: string;
  name: string;
  display: string;
  chrom: string;
  pos: number;
  category: string;
  tag?: string;
  evidenceTier?: 1 | 2 | 3;
  provenance?: MarkerProvenance;
  genotypes: {
    [genotype: string]: {
      effect: string;
      interpretation: string;
      recommendations: string[];
      priority: string;
      action?: string;
      supplements?: SupplementSource;
      theWhy?: string;
      scienceSimplified?: string;
    };
  };
  supplements?: SupplementSource;
  theWhy?: string;
  scienceSimplified?: string;
}

// Default tags based on category
const CATEGORY_TAGS: Record<string, string> = {
  vulnerability: "🛑 Risk Mitigation",
  wellness: "ℹ️ Dietary Rule",
  pharmacology: "⚠️ Medical Alert",
  performance: "🟢 Superpower",
  personality: "🟢 Superpower",
  hereditary: "⚠️ Medical Alert",
  ancestry: "🟢 Superpower",
  longevity: "⏳ Longevity Signal",
};

// Default supplements for common genes
const DEFAULT_SUPPLEMENTS: Record<
  string,
  {
    timing: "morning" | "prePerformance" | "night";
    compound: string;
    dosage: string;
    brands: string[];
  }[]
> = {
  MTHFR: [
    {
      timing: "morning",
      compound: "Methylfolate",
      dosage: "400-800mcg",
      brands: ["Thorne", "Pure Encapsulations", "Life Extension"],
    },
    {
      timing: "morning",
      compound: "B12",
      dosage: "1000mcg",
      brands: ["Pure Encapsulations", "Thorne"],
    },
  ],
  COMT: [
    {
      timing: "morning",
      compound: "Magnesium Glycinate",
      dosage: "400mg",
      brands: ["Thorne", "Pure Encapsulations"],
    },
    {
      timing: "night",
      compound: "L-Theanine",
      dosage: "200mg",
      brands: ["NOW Foods", "Thorne"],
    },
  ],
  CYP1A2: [
    {
      timing: "morning",
      compound: "Milk Thistle",
      dosage: "250mg",
      brands: ["Pure Encapsulations", "Thorne"],
    },
  ],
  SOD2: [
    {
      timing: "morning",
      compound: "CoQ10",
      dosage: "100mg",
      brands: ["Qunol", "Thorne"],
    },
    {
      timing: "morning",
      compound: "Alpha Lipoic Acid",
      dosage: "300mg",
      brands: ["Pure Encapsulations", "Thorne"],
    },
  ],
  XPC: [
    {
      timing: "night",
      compound: "Curcumin",
      dosage: "500mg",
      brands: ["Thorne", "Life Extension"],
    },
  ],
  APOE: [
    {
      timing: "morning",
      compound: "Omega-3",
      dosage: "2g",
      brands: ["Nordic Naturals", "Life Extension"],
    },
    {
      timing: "night",
      compound: "Vitamin D3",
      dosage: "2000IU",
      brands: ["Thorne", "Pure Encapsulations"],
    },
  ],
  SIRT1: [
    {
      timing: "morning",
      compound: "Resveratrol",
      dosage: "250mg",
      brands: ["Life Extension", "Thorne"],
    },
  ],
  IL6: [
    {
      timing: "morning",
      compound: "Omega-3",
      dosage: "2g",
      brands: ["Nordic Naturals", "Life Extension"],
    },
  ],
};

function getDefaultSupplements(gene: string): Array<{
  compound: string;
  dosage: string;
  brands: string[];
  timing: "morning" | "prePerformance" | "night";
}> {
  return DEFAULT_SUPPLEMENTS[gene] || [];
}

function normalizeSupplementBuckets(
  source?: SupplementSource
): SupplementBuckets {
  const buckets: SupplementBuckets = {};
  if (!source) return buckets;

  if (Array.isArray(source)) {
    for (const supp of source) {
      const timing = supp.timing ?? "morning";
      buckets[timing] = buckets[timing] ?? [];
      buckets[timing]?.push(supp);
    }
    return buckets;
  }

  for (const timing of ["morning", "prePerformance", "night"] as const) {
    const supplements = source[timing];
    if (Array.isArray(supplements)) buckets[timing] = supplements;
  }

  return buckets;
}

// ============================================================================
// Utility Functions
// ============================================================================

function normalizeChrom(chrom: string): string {
  // NC_000001.10 format → "1"
  if (chrom.startsWith("NC_0000") && chrom.includes(".")) {
    const num = parseInt(chrom.split(".")[0].slice(-4), 10);
    return String(num);
  }
  if (chrom.startsWith("NC_000") && chrom.includes(".")) {
    const num = parseInt(chrom.split(".")[0].slice(-3), 10);
    return String(num);
  }
  // chr1 → 1, chrM → M
  return chrom.replace(/^chr/i, "").toUpperCase();
}

function parseVCFLine(line: string): Variant | null {
  if (line.startsWith("#")) return null;
  const parts = line.split("\t");
  if (parts.length < 5) return null;

  return {
    chrom: parts[0],
    pos: parseInt(parts[1], 10),
    id: parts[2],
    ref: parts[3],
    alt: parts[4],
    qual: parts[5],
    filter: parts[6],
    info: parts[7],
    format: parts[8],
    samples: parts.slice(9),
  };
}

function convertGT(gt: string, ref: string, alt: string): string | null {
  if (!gt || gt === "." || gt === "./." || gt === ".|.") return null;
  const parts = gt.split(/\/|\|/);
  if (parts.length !== 2) return null;
  const get = (n: number) => (n === 0 ? ref.toUpperCase() : alt.toUpperCase());
  const a1 = get(parseInt(parts[0], 10));
  const a2 = get(parseInt(parts[1], 10));
  if (!a1 || !a2) return null;
  return a1 + a2;
}

function loadInterpretations(
  interpretationsDir: string
): Map<string, MarkerInterpretation> {
  const markers = new Map<string, MarkerInterpretation>();
  const files = [
    "wellness.json",
    "pharmacology.json",
    "personality.json",
    "performance.json",
    "vulnerability.json",
    "hereditary.json",
    "ancestry.json",
    "longevity.json",
  ];

  for (const file of files) {
    const filePath = path.join(interpretationsDir, file);
    if (!fs.existsSync(filePath)) continue;

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(content);

      if (data.markers) {
        for (const [rsid, marker] of Object.entries(data.markers)) {
          // The JSON uses "interpretations" but code expects "genotypes" - normalize the structure
          const normalized = marker as any;
          if (normalized.interpretations && !normalized.genotypes) {
            normalized.genotypes = normalized.interpretations;
            delete normalized.interpretations;
          }
          const existing = markers.get(rsid);
          if (existing?.provenance && !normalized.provenance) {
            continue;
          }
          markers.set(rsid, normalized as MarkerInterpretation);
        }
      }
    } catch (e) {
      console.warn(`Warning: Could not parse ${file}: ${e}`);
    }
  }

  return markers;
}

// ============================================================================
// Core Pipeline
// ============================================================================

/**
 * Parse a VCF file but only extract variants matching the given rsIDs.
 * Streams command output through a temporary file so WGS-scale query results
 * never become one giant JavaScript string.
 */
export interface VcfRsidExtractionResult {
  variants: Variant[];
  totalVariants: number;
  annotatedCount: number;
  extractionMethod: "bcftools" | "text_fallback";
  fallbackReason?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function forEachLineInFileSync(
  filePath: string,
  onLine: (line: string) => void
): void {
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      const text = pending + decoder.write(buffer.subarray(0, bytesRead));
      let lineStart = 0;
      let newline = text.indexOf("\n", lineStart);
      while (newline >= 0) {
        const line = text.slice(lineStart, newline).replace(/\r$/, "");
        if (line) onLine(line);
        lineStart = newline + 1;
        newline = text.indexOf("\n", lineStart);
      }
      pending = text.slice(lineStart);
    } while (bytesRead > 0);
    pending += decoder.end();
    if (pending) onLine(pending.replace(/\r$/, ""));
  } finally {
    fs.closeSync(descriptor);
  }
}

function forEachCommandOutputLineSync(
  command: string,
  nearbyPath: string,
  timeout: number,
  onLine: (line: string) => void
): void {
  const tempDir = fs.mkdtempSync(
    path.join(path.dirname(nearbyPath), ".vcf-query-")
  );
  const outputPath = path.join(tempDir, "query.tsv");
  try {
    execSync(`set -o pipefail; ${command} > ${shellQuote(outputPath)}`, {
      timeout,
      shell: "/bin/bash",
      stdio: ["ignore", "ignore", "pipe"],
    });
    forEachLineInFileSync(outputPath, onLine);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function rsidsFromIdField(id: string): string[] {
  return id.split(";").filter(candidate => /^rs\d+/i.test(candidate));
}

function appendTargetVariants(
  variants: Variant[],
  targetSet: Set<string>,
  input: { chrom: string; pos: number; id: string; ref: string; alt: string; gtRaw?: string }
): void {
  for (const rsid of rsidsFromIdField(input.id)) {
    if (!targetSet.has(rsid)) continue;
    variants.push({
      chrom: input.chrom,
      pos: input.pos,
      id: rsid,
      ref: input.ref,
      alt: input.alt,
      qual: ".",
      filter: ".",
      info: ".",
      samples: input.gtRaw ? [input.gtRaw] : [],
    });
  }
}

export function parseVCFWithRSIDs(
  vcfPath: string,
  targetRSIDs: string[]
): VcfRsidExtractionResult {
  // Single-pass extraction via bcftools query — avoids repeated full decompression.
  // Outputs CHROM,POS,ID,REF,ALT,GT for every rs-annotated variant in one pass.
  const targetSet = new Set(targetRSIDs);
  const variants: Variant[] = [];
  let totalVariants = 0;
  let annotatedCount = 0;
  let extractionMethod: VcfRsidExtractionResult["extractionMethod"] =
    "bcftools";
  let fallbackReason: string | undefined;

  try {
    forEachCommandOutputLineSync(
      `bcftools query -f '%CHROM\\t%POS\\t%ID\\t%REF\\t%ALT[\\t%GT]\\n' ${shellQuote(vcfPath)} | awk -F'\\t' '$3 ~ /(^|;)rs[0-9]+/'`,
      vcfPath,
      120000,
      line => {
        annotatedCount++;
        const [chrom, posStr, id, ref, alt, gtRaw] = line.split("\t");
        if (!chrom || !posStr || !id || !ref || !alt) return;
        appendTargetVariants(variants, targetSet, {
          chrom,
          pos: parseInt(posStr, 10),
          id,
          ref,
          alt,
          gtRaw,
        });
      }
    );

    // Total variant count: use bcftools index -n (instant for indexed BGZip).
    // A valid, unindexed VCF still needs an exact count.
    try {
      const nResult = execSync(`bcftools index -n ${shellQuote(vcfPath)} 2>/dev/null`, {
        encoding: "utf8",
      });
      totalVariants = parseInt(nResult.trim(), 10) || annotatedCount;
    } catch {
      const nResult = execSync(
        `set -o pipefail; bcftools view -H ${shellQuote(vcfPath)} | wc -l`,
        { encoding: "utf8", timeout: 300000, shell: "/bin/bash" }
      );
      totalVariants = parseInt(nResult.trim(), 10) || 0;
    }
  } catch (error) {
    extractionMethod = "text_fallback";
    fallbackReason = commandFailureSummary(error);
    console.warn(
      `[vcf-rsid-extraction-fallback] ${JSON.stringify({ reason: fallbackReason })}`
    );
    try {
      totalVariants = 0;
      annotatedCount = 0;
      variants.length = 0;
      forEachCommandOutputLineSync(
        `gzip -cdf ${shellQuote(vcfPath)} | awk '!/^#/'`,
        vcfPath,
        300000,
        line => {
          totalVariants++;
          const parsed = parseVCFLine(line);
          if (!parsed) return;
          const rsids = rsidsFromIdField(parsed.id);
          if (rsids.length === 0) return;
          annotatedCount++;
          appendTargetVariants(variants, targetSet, {
            chrom: parsed.chrom,
            pos: parsed.pos,
            id: parsed.id,
            ref: parsed.ref,
            alt: parsed.alt,
            gtRaw: parsed.samples?.[0],
          });
        }
      );
    } catch (fallbackError) {
      throw new Error(
        `bcftools query failed (${fallbackReason}); text fallback failed (${commandFailureSummary(fallbackError)})`
      );
    }
  }

  return {
    variants,
    totalVariants,
    annotatedCount,
    extractionMethod,
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

function commandFailureSummary(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const record = error as { message?: unknown; stderr?: unknown; status?: unknown };
  const stderr = Buffer.isBuffer(record.stderr)
    ? record.stderr.toString("utf8")
    : typeof record.stderr === "string"
      ? record.stderr
      : "";
  const message = typeof record.message === "string" ? record.message : "";
  const status = typeof record.status === "number" ? `exit ${record.status}: ` : "";
  const detail = (stderr.trim() || message.trim() || String(error))
    .replace(/\s+/g, " ")
    .slice(0, 800);
  return `${status}${detail}`;
}

/**
 * Legacy full parse function — only used for the initial check (reads first line)
 * to determine if VCF has rsIDs or needs annotation.
 */
function parseVCF(vcfPath: string): Variant[] {
  // Quick check: read just the first data line to determine format
  try {
    const firstLine = execSync(
      `zcat -f "${vcfPath}" 2>/dev/null | grep -v "^#" | head -1`,
      { encoding: "utf8" }
    ).trim();
    if (firstLine) {
      const variant = parseVCFLine(firstLine);
      return variant ? [variant] : [];
    }
  } catch {}
  return [];
}

function buildRSIDMap(variants: Variant[]): Map<string, VariantMapEntry[]> {
  const rsidMap = new Map<string, VariantMapEntry[]>();

  for (const v of variants) {
    if (!v.id || !v.id.startsWith("rs")) continue;

    const normalizedChrom = normalizeChrom(v.chrom);
    const entry: VariantMapEntry = {
      chrom: normalizedChrom,
      pos: v.pos,
      ref: v.ref,
      alt: v.alt,
      gt: v.samples?.[0]?.split(":")[0],
    };

    const existing = rsidMap.get(v.id) || [];
    existing.push(entry);
    rsidMap.set(v.id, existing);
  }

  return rsidMap;
}

function findVariantByRSID(
  rsidMap: Map<string, VariantMapEntry[]>,
  rsid: string,
  expectedChrom: string,
  expectedPos: number
): VariantMapEntry | null {
  const entries = rsidMap.get(rsid);
  if (!entries) return null;

  // Find exact position match to handle rsID collisions
  for (const entry of entries) {
    if (entry.chrom === expectedChrom && entry.pos === expectedPos) {
      return entry;
    }
  }

  // Fallback: return first entry if no position match (collision)
  return entries[0] || null;
}

function analyzeVariants(
  variants: Variant[],
  rsidMap: Map<string, VariantMapEntry[]>,
  interpretations: Map<string, MarkerInterpretation>
): {
  alerts: Alert[];
  superpowers: Superpower[];
  topRisks: Risk[];
  supplements: Supplement[];
  curatedInterpretations: CuratedProtocolInterpretation[];
} {
  const alerts: Alert[] = [];
  const superpowers: Superpower[] = [];
  const topRisks: Risk[] = [];
  const supplements: Supplement[] = [];
  const curatedInterpretations: CuratedProtocolInterpretation[] = [];

  const found = new Set<string>();

  for (const variant of variants) {
    if (!variant.id || !variant.id.startsWith("rs")) continue;
    if (found.has(variant.id)) continue; // Skip duplicates

    const interpretation = interpretations.get(variant.id);
    if (!interpretation) continue;

    const normalizedChrom = normalizeChrom(variant.chrom);
    const variantData = findVariantByRSID(
      rsidMap,
      variant.id,
      normalizedChrom,
      variant.pos
    );
    if (!variantData) continue;

    found.add(variant.id);

    // Get genotype from VCF data
    let genotype = "unknown";
    if (variantData.gt) {
      const converted = convertGT(
        variantData.gt,
        variantData.ref,
        variantData.alt
      );
      if (converted) genotype = converted;
    } else if (variant.samples?.[0]) {
      // Try to get from original variant
      const parts = variant.samples[0].split(":");
      const gt = parts[0];
      const converted = convertGT(gt, variant.ref, variant.alt);
      if (converted) genotype = converted;
    }

    // Look up genotype-specific interpretation, fall back to '*' wildcard
    // (used by ClinVar-expanded entries where per-genotype data isn't available)
    const genotypeData =
      interpretation.genotypes[genotype] ||
      (genotype.length === 2
        ? interpretation.genotypes[`${genotype[1]}${genotype[0]}`]
        : undefined) ||
      interpretation.genotypes["*"];
    if (!genotypeData) continue;

    const priority = genotypeData.priority;
    const isRisk = priority === "high" || priority === "medium";

    // Infer tag from category if not present
    const tag =
      interpretation.tag ||
      CATEGORY_TAGS[interpretation.category] ||
      "ℹ️ Dietary Rule";
    const isSuperpower = tag.includes("Superpower");

    // Build evidence string
    const evidence = `${
      interpretation.display || interpretation.name
    } (${genotype}) - ${genotypeData.effect || genotypeData.interpretation}`;

    // Build theWhy and scienceSimplified from available data
    const theWhy =
      interpretation.theWhy ||
      genotypeData.theWhy ||
      `${interpretation.gene} ${interpretation.name} variant affects ${interpretation.category}`;
    const scienceSimplified =
      genotypeData.scienceSimplified ||
      interpretation.scienceSimplified ||
      genotypeData.interpretation;

    if (interpretation.provenance) {
      curatedInterpretations.push({
        rsid: variant.id,
        gene: interpretation.gene,
        label: interpretation.display || interpretation.name,
        interpretation: genotypeData.interpretation,
        action: genotypeData.recommendations?.join(", "),
        evidenceTier: interpretation.evidenceTier,
        provenance: interpretation.provenance,
      });
    }

    // Create superpower items
    if (isSuperpower) {
      superpowers.push({
        itemName: interpretation.name,
        tag: tag as "🟢 Superpower",
        evidence: `${interpretation.gene} ${interpretation.name}`,
        advantage: genotypeData.interpretation,
        rsid: variant.id,
        gene: interpretation.gene,
        evidenceTier: interpretation.evidenceTier,
        provenance: interpretation.provenance,
      });
    }

    // Create risk items
    if (isRisk) {
      // Determine priority (1-3)
      const riskCount = topRisks.length;
      const riskPriority = (riskCount + 1) as 1 | 2 | 3;

      topRisks.push({
        itemName: `${interpretation.gene} ${interpretation.name}`,
        tag: tag as "🛑 Risk Mitigation",
        priority: riskPriority,
        evidence: `${interpretation.gene} ${interpretation.name} (${variant.id})`,
        scienceSimplified: scienceSimplified,
        supplementation: genotypeData.recommendations?.join(", "),
        evidenceTier: interpretation.evidenceTier,
        rsid: variant.id,
        gene: interpretation.gene,
        provenance: interpretation.provenance,
      });

      // Add alerts for medical or dietary variants
      if (tag.includes("Medical Alert") || tag.includes("Dietary Rule")) {
        const action =
          genotypeData.action || generateAction(interpretation.gene, genotype);
        alerts.push({
          itemName: interpretation.gene,
          tag: tag as "⚠️ Medical Alert" | "ℹ️ Dietary Rule",
          evidence,
          action,
          gene: interpretation.gene,
          rsid: variant.id,
          evidenceTier: interpretation.evidenceTier,
          provenance: interpretation.provenance,
        });
      }
    }

    // Collect supplements - use genotypeData.supplements or interpretation.supplements or fall back to defaults
    const geneSupplements = normalizeSupplementBuckets(
      genotypeData.supplements ||
        interpretation.supplements ||
        (interpretation.provenance ? [] : getDefaultSupplements(interpretation.gene))
    );

    for (const [timing, supps] of Object.entries(geneSupplements)) {
      if (!supps || supps.length === 0) continue;
      for (const supp of supps) {
        supplements.push({
          compound: supp.compound,
          dosage: supp.dosage,
          timing: timing as SupplementTiming,
          theWhy,
          brands: supp.brands ?? [],
          reason: `${interpretation.gene} ${interpretation.name}: ${genotypeData.interpretation}`,
        });
      }
    }
  }

  return { alerts, superpowers, topRisks, supplements, curatedInterpretations };
}

function generateAction(gene: string, genotype: string): string {
  switch (gene) {
    case "CYP1A2":
      return genotype === "CC"
        ? "Limit caffeine, avoid after 12:00 PM"
        : "Moderate caffeine intake";
    case "LCT":
      return genotype === "GG"
        ? "Avoid dairy or use lactase supplements"
        : "Monitor dairy tolerance";
    case "HLA":
      return "Consider gluten-free diet, test for celiac";
    default:
      return "Monitor and follow up with healthcare provider";
  }
}

function deduplicateSupplements(supplements: Supplement[]): Supplement[] {
  const seen = new Map<string, Supplement>();
  const result: Supplement[] = [];

  for (const supp of supplements) {
    const key = supp.compound.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, supp);
      result.push(supp);
    }
  }

  return result;
}

function categorizeSupplements(supplements: Supplement[]): {
  morning: Supplement[];
  prePerformance: Supplement[];
  night: Supplement[];
} {
  const morning: Supplement[] = [];
  const prePerformance: Supplement[] = [];
  const night: Supplement[] = [];

  for (const supp of supplements) {
    switch (supp.timing) {
      case "morning":
        morning.push(supp);
        break;
      case "prePerformance":
        prePerformance.push(supp);
        break;
      case "night":
        night.push(supp);
        break;
    }
  }

  return { morning, prePerformance, night };
}

// ============================================================================
// Core Pipeline (exported for programmatic use)
// ============================================================================

export interface AnalyzeVCFOptions {
  annotated?: boolean;
  save?: boolean;
  outputDir?: string;
  interpretationsDir?: string;
  dbsnpPath?: string;
}

export interface AnalyzeVCFResult {
  protocol: LongevityProtocol;
  protocolPath: string;
  variants: Variant[];
  annotatedCount: number;
  rsidMap: Map<string, VariantMapEntry[]>;
  vepAnnotations?: Map<string, VEPAnnotation>;
  /** All rsIDs from the VCF, not just curated marker targets — for full ClinVar/CPIC sweep */
  allRSIDs?: string[];
  /** All user genotypes keyed by rsID — for CPIC pharmacogenomic matching */
  allGenotypes?: Map<string, string>;
  /** Raw ClinVar annotations before being converted to alerts */
  clinvarAnnotations?: ClinVarAnnotation[];
  /** Total variant count in the VCF */
  totalVariants?: number;
  /** Source used to populate VCF ID rsIDs */
  rsidAnnotationSource?: string;
  /** User-facing limitation for the rsID annotation source */
  rsidAnnotationLimitation?: string;
  /** Parser used to extract rsIDs and genotypes from the final VCF. */
  rsidExtractionMethod?: "bcftools" | "text_fallback";
  /** Original bcftools failure retained when text extraction was required. */
  rsidExtractionFallbackReason?: string;
}

/**
 * Detected file formats.
 */
export type GenomicFileFormat = "vcf" | "23andme" | "ancestrydna" | "unknown";

/**
 * Auto-detect the genomic data file format.
 *
 * - VCF files start with `##fileformat=VCF` in the header.
 * - 23andMe raw data is tab-separated with `# rsid` as the first data-column header.
 * - AncestryDNA raw data is tab-separated with `rsid` in the header line.
 * - Unknown: anything else gets a user-friendly error.
 *
 * Reads only the first 4KB of the file to detect the format.
 */
export function detectFileFormat(vcfPath: string): GenomicFileFormat {
  if (!fs.existsSync(vcfPath)) {
    throw new Error(
      `File not found: ${vcfPath}\n\n` +
        `Please check the path and try again. ` +
        `Supported formats: VCF (Dante Labs WGS, any whole-genome sequencing), ` +
        `23andMe raw data export, AncestryDNA raw data export.`
    );
  }

  const ext = path.extname(vcfPath).toLowerCase();

  // Read first 4KB of the file
  const fd = fs.openSync(vcfPath, "r");
  const buf = Buffer.alloc(4096);
  fs.readSync(fd, buf, 0, 4096, 0);
  fs.closeSync(fd);

  // Handle gzipped files: try reading via zcat
  let header: string;
  if (ext === ".gz") {
    try {
      header = execSync(`zcat -f "${vcfPath}" 2>/dev/null | head -200`, {
        encoding: "utf8",
        timeout: 10000,
      });
    } catch {
      header = buf.toString("utf8").slice(0, 1000);
    }
  } else {
    header = buf.toString("utf8");
  }

  // VCF detection: starts with ##fileformat=VCF
  if (header.includes("##fileformat=VCF")) {
    return "vcf";
  }

  // 23andMe detection: tab-separated, starts with # rsid header
  if (header.includes("# rsid") && header.includes("\t")) {
    return "23andme";
  }

  // AncestryDNA detection: tab-separated, rsid column in header
  // AncestryDNA headers look like: rsid\tchromosome\tposition\tallele1\tallele2
  if (
    header.includes("rsid") &&
    header.includes("\t") &&
    !header.startsWith("#") &&
    !header.startsWith("##")
  ) {
    return "ancestrydna";
  }

  // Last attempt: check raw bytes for text patterns
  const raw = buf.toString("utf8", 0, Math.min(buf.length, 500));
  if (raw.includes("##fileformat=VCF")) {
    return "vcf";
  }
  if (raw.includes("# rsid") && raw.includes("\t")) {
    return "23andme";
  }
  if (
    raw.includes("rsid") &&
    raw.includes("\t") &&
    !raw.startsWith("#") &&
    !raw.startsWith("##")
  ) {
    return "ancestrydna";
  }

  return "unknown";
}

/**
 * Analyze a VCF file and return the LongevityProtocol.
 * This is the exported core function that can be called programmatically
 * without spawning a subprocess.
 *
 * Supports:
 *   - VCF (.vcf, .vcf.gz) — full pipeline with ClinVar/CPIC/VEP
 *   - 23andMe raw data (.txt) — reduced pipeline (marker matching only)
 */
export async function analyzeVCF(
  vcfPath: string,
  options: AnalyzeVCFOptions = {}
): Promise<AnalyzeVCFResult> {
  const {
    annotated: isPreAnnotated = false,
    save = true,
    outputDir: customOutputDir,
    interpretationsDir: customInterpDir,
    dbsnpPath: customDbsnpPath,
  } = options;

  if (!fs.existsSync(vcfPath)) {
    throw new Error(
      `File not found: ${vcfPath}\n\n` +
        `Please check the path and try again. ` +
        `Supported formats: VCF (Dante Labs WGS, any whole-genome sequencing), ` +
        `23andMe raw data export, AncestryDNA raw data export.`
    );
  }

  // Preflight: detect format and warn on SNP arrays (reduced coverage)
  const format = detectFileFormat(vcfPath);
  if (format === "unknown") {
    throw new Error(
      `Unrecognized file format: ${vcfPath}\n\n` +
        `Supported formats:\n` +
        `  1. VCF (.vcf or .vcf.gz) — Dante Labs WGS, any whole-genome sequencing\n` +
        `  2. 23andMe raw data export — tab-separated text file (header: # rsid...)\n` +
        `  3. AncestryDNA raw data export — tab-separated text file (header: rsid...)\n\n` +
        `The file you provided does not appear to match any supported format. ` +
        `Please check:\n` +
        `  - Is the file a valid genetic data export?\n` +
        `  - If zipped (.gz), is it gzip-compressed VCF?\n` +
        `  - If 23andMe/AncestryDNA, did you download the 'Raw Data' export?`
    );
  }
  if (format === "23andme" || format === "ancestrydna") {
    const label = format === "23andme" ? "23andMe" : "AncestryDNA";
    console.log(
      `📋 Detected ${label} format — running reduced pipeline (marker matching only).`
    );
    console.log(
      "   ClinVar, CPIC, and VEP enrichment will be skipped (low SNP coverage)."
    );
  }

  const vcfDir = path.dirname(vcfPath);
  const vcfBasename = path.basename(vcfPath, path.extname(vcfPath));
  const interpretationsDir =
    customInterpDir ||
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "shared",
      "interpretations"
    );

  // Step 1: Annotate with rsIDs if needed
  let finalVCFPath = vcfPath;
  let rsidAnnotationSource = "provided_in_input";
  let rsidAnnotationLimitation = "rsIDs were already present in the input VCF.";

  if (!isPreAnnotated) {
    console.log("📋 Step 1: Checking if annotation is needed...");

    const sampleVariant = parseVCF(vcfPath)[0];
    let needsAnnotation = !sampleVariant?.id?.startsWith("rs");
    try {
      const doctor = runVcfDoctor(vcfPath);
      if (doctor.likely_wgs && doctor.rsid_density < 0.1) {
        needsAnnotation = true;
      }
    } catch {
      // Keep the fast first-record check as the fallback if the doctor cannot run.
    }

    if (needsAnnotation) {
      console.log("   VCF lacks rsID annotations, annotating with dbSNP...");

      const annotatedPath = path.join(
        vcfDir,
        `${vcfBasename}.annotated.vcf.gz`
      );

      const existingAnnotationHasRsids =
        fs.existsSync(annotatedPath) &&
        runVcfDoctor(annotatedPath).rsid_variants > 0;
      if (existingAnnotationHasRsids) {
        console.log(`   Using existing annotation: ${annotatedPath}`);
        finalVCFPath = annotatedPath;
        rsidAnnotationSource = "existing_annotated_vcf";
        rsidAnnotationLimitation =
          "Using a previously generated annotated VCF. Confirm the annotation reference if provenance matters.";
      } else {
        if (fs.existsSync(annotatedPath)) {
          console.log(
            "   Ignoring existing annotation because it contains zero rsIDs; regenerating it."
          );
          try {
            fs.unlinkSync(annotatedPath);
          } catch {}
          try {
            fs.unlinkSync(`${annotatedPath}.csi`);
          } catch {}
          try {
            fs.unlinkSync(`${annotatedPath}.tbi`);
          } catch {}
        }
        // Prefer the lean ClinVar-derived annotation TSV (22MB, bundled in repo) over the
        // full dbSNP (26GB, external). An explicit dbSNP path opts into full coverage.
        const packageDir = getPackageDir();
        const refDir = path.resolve(packageDir, "..", "..", "reference");
        const leanAnnotPath = findClinVarAnnotationReference(packageDir);
        const leanAnnotIndex = leanAnnotPath ? `${leanAnnotPath}.tbi` : "";
        const dbsnpPath =
          customDbsnpPath || path.join(refDir, "dbsnp/GCF_000001405.25.gz");
        const disclosure = getClinVarDisclosure(packageDir);

        const useLeanAnnot =
          !customDbsnpPath &&
          leanAnnotPath !== undefined &&
          fs.existsSync(leanAnnotPath) &&
          fs.existsSync(leanAnnotIndex);
        const useDbsnp =
          fs.existsSync(dbsnpPath) &&
          (fs.existsSync(`${dbsnpPath}.csi`) ||
            fs.existsSync(`${dbsnpPath}.tbi`));

        if (!useLeanAnnot && !useDbsnp) {
          throw new Error(
            "No rsID annotation reference found.\n" +
              "  Expected (lean, bundled): reference/clinvar/clinvar_rsid_annotation.tsv.gz\n" +
              "  Optional (full dbSNP):    ../../reference/dbsnp/GCF_000001405.25.gz\n" +
              "Run: npm run setup:rsids"
          );
        }

        console.log(
          useLeanAnnot
            ? "   Annotating with lean ClinVar rsID reference..."
            : "   Annotating with dbSNP GRCh37 (26GB)..."
        );
        if (useLeanAnnot) {
          console.log(`   Scope: ${disclosure.limitation}`);
          rsidAnnotationSource = "ClinVar GRCh37 rsID subset";
          rsidAnnotationLimitation = disclosure.limitation;
        } else {
          rsidAnnotationSource = "dbSNP GRCh37";
          rsidAnnotationLimitation =
            "Full dbSNP rsID annotation was used when available locally.";
        }
        try {
          const normalizedPath = path.join(
            vcfDir,
            `${vcfBasename}.normalized.vcf.gz`
          );
          const renamedPath = path.join(
            vcfDir,
            `${vcfBasename}.annotation-contigs.vcf.gz`
          );
          const contigMapPath = path.join(
            vcfDir,
            `${vcfBasename}.annotation-contigs.tsv`
          );
          console.log("   Compressing and normalizing VCF...");
          execSync(`zcat -f "${vcfPath}" | bgzip > "${normalizedPath}"`, {
            stdio: "inherit",
            shell: "/bin/bash",
          });
          execSync(`bcftools index "${normalizedPath}"`, {
            stdio: "inherit",
            shell: "/bin/bash",
          });

          const renameEntries = writeVcfContigRenameMap(
            normalizedPath,
            useLeanAnnot ? "clinvar-grch37" : "dbsnp-grch37",
            contigMapPath
          );
          const annotationInput = renameEntries.length
            ? renamedPath
            : normalizedPath;
          if (renameEntries.length) {
            console.log(
              `   Normalizing ${renameEntries.length} contig name${
                renameEntries.length === 1 ? "" : "s"
              } for ${
                useLeanAnnot ? "the ClinVar GRCh37" : "the dbSNP GRCh37"
              } reference...`
            );
            execSync(
              `bcftools annotate --rename-chrs "${contigMapPath}" -Oz -o "${renamedPath}" "${normalizedPath}"`,
              { stdio: "pipe" }
            );
            execSync(`bcftools index "${renamedPath}"`, { stdio: "pipe" });
          }

          if (useLeanAnnot) {
            // Lean path: the tabix-indexed TSV expects numeric GRCh37 chromosomes.
            console.log(
              "   Running bcftools annotate with ClinVar rsID TSV..."
            );
            execSync(
              `bcftools annotate -a "${leanAnnotPath}" -c CHROM,POS,REF,ALT,ID -Oz -o "${annotatedPath}" --threads 4 "${annotationInput}" 2>&1`,
              { stdio: "pipe" }
            );
          }
          if (!useLeanAnnot) {
            console.log("   Running bcftools annotate with dbSNP rsIDs...");
            execSync(
              `bcftools annotate -a "${dbsnpPath}" -c ID -Oz -o "${annotatedPath}" --threads 8 "${annotationInput}" 2>&1`,
              { stdio: "pipe" }
            );
          }

          if (!fs.existsSync(annotatedPath)) {
            throw new Error("bcftools annotate failed to produce output file");
          }

          execSync(`bcftools index "${annotatedPath}"`, { stdio: "pipe" });

          const annotatedContent = execSync(
            `gunzip -c "${annotatedPath}" | grep -v "^#" | cut -f3 | grep "^rs" | wc -l`,
            { encoding: "utf8" }
          );
          const rsidCount = parseInt(annotatedContent.trim(), 10);

          if (rsidCount === 0) {
            throw new Error(
              `rsID annotation added zero identifiers after ${
                useLeanAnnot ? "ClinVar" : "dbSNP"
              } contig normalization. Confirm the genome build and reference provenance before retrying.`
            );
          } else {
            console.log(
              `   ✅ Annotation complete: ${rsidCount.toLocaleString()} variants received rsIDs`
            );
          }

          try {
            fs.unlinkSync(normalizedPath);
          } catch {}
          try {
            fs.unlinkSync(normalizedPath + ".csi");
          } catch {}
          try {
            fs.unlinkSync(renamedPath);
          } catch {}
          try {
            fs.unlinkSync(`${renamedPath}.csi`);
          } catch {}
          try {
            fs.unlinkSync(`${renamedPath}.tbi`);
          } catch {}
          try {
            fs.unlinkSync(contigMapPath);
          } catch {}

          finalVCFPath = annotatedPath;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`rsID annotation failed: ${msg}`);
        }
      }
    } else {
      console.log("   VCF already has rsID annotations");
    }
  } else {
    rsidAnnotationSource = "preannotated_input";
    rsidAnnotationLimitation =
      "The caller marked this VCF as preannotated. The pipeline did not add or verify rsIDs.";
  }

  // Step 1a: VEP functional annotation (optional — skipped if VEP not installed)
  console.log("\n🧬 Step 1a: Running VEP functional annotation (optional)...");
  let vepResult: {
    annotations: Map<string, VEPAnnotation>;
    highImpactCount: number;
    moderateImpactCount: number;
  } | null = null;
  try {
    const vep = annotateWithVEP(finalVCFPath);
    if (vep) {
      vepResult = {
        annotations: vep.annotations,
        highImpactCount: vep.highImpactCount,
        moderateImpactCount: vep.moderateImpactCount,
      };
      console.log(
        `   VEP annotations: ${vep.totalAnnotated} (${vep.highImpactCount} HIGH impact, ${vep.moderateImpactCount} MODERATE)`
      );
    }
  } catch (err) {
    console.warn(
      "   ⚠️  VEP annotation step failed, continuing without functional annotation"
    );
  }

  // Step 2: Load interpretations first (to get target rsIDs for efficient parsing)
  console.log("\n🧪 Step 2: Loading interpretation database...");
  const interpretations = loadInterpretations(interpretationsDir);
  const targetRSIDs = Array.from(interpretations.keys());
  console.log(`   Markers loaded: ${interpretations.size}`);

  // Step 3: Parse VCF (only extract variants matching our interpretation DB rsIDs)
  console.log("\n📖 Step 3: Extracting relevant variants from VCF...");
  const extraction = parseVCFWithRSIDs(finalVCFPath, targetRSIDs);
  const { variants, totalVariants, annotatedCount } = extraction;
  console.log(`   Total variants in VCF: ${totalVariants.toLocaleString()}`);
  console.log(`   Variants matched: ${variants.length}`);

  // Step 4: Build rsID map
  console.log("\n🗺️  Step 4: Building rsID lookup map...");
  const rsidMap = buildRSIDMap(variants);
  console.log(`   Unique rsIDs: ${rsidMap.size.toLocaleString()}`);

  // Step 5: Analyze variants
  console.log("\n🔬 Step 5: Analyzing variants against database...");
  const { alerts, superpowers, topRisks, supplements, curatedInterpretations } = analyzeVariants(
    variants,
    rsidMap,
    interpretations
  );

  console.log(`   Alerts found: ${alerts.length}`);
  console.log(`   Superpowers found: ${superpowers.length}`);
  console.log(`   Top risks found: ${topRisks.length}`);
  console.log(`   Supplements recommended: ${supplements.length}`);

  // Single-pass extraction of all rs-annotated variants with genotypes.
  // Reuses the same bcftools query output for both ClinVar rsID lookup and CPIC genotype matching,
  // replacing two separate full-file decompression passes with one.
  console.log(
    "\n🔍 Extracting all rsIDs + genotypes from full VCF (single pass)..."
  );
  const allGenotypes = new Map<string, string>();
  const rsidsWithoutGenotypes = new Set<string>();
  const recordGenotypeLine = (line: string, sampleIncludesFormat: boolean) => {
    const [idField, ref, alt, sampleValue] = line.split("\t");
    if (!idField) return;
    const gtRaw = sampleIncludesFormat ? sampleValue?.split(":")[0] : sampleValue;
    const gt = ref && alt && gtRaw ? convertGT(gtRaw.trim(), ref, alt) : null;
    for (const rsid of rsidsFromIdField(idField)) {
      if (gt && !allGenotypes.has(rsid)) {
        allGenotypes.set(rsid, gt);
        rsidsWithoutGenotypes.delete(rsid);
      } else if (!allGenotypes.has(rsid)) {
        rsidsWithoutGenotypes.add(rsid);
      }
    }
  };
  try {
    forEachCommandOutputLineSync(
      `bcftools query -f '%ID\\t%REF\\t%ALT[\\t%GT]\\n' ${shellQuote(finalVCFPath)} | awk -F'\\t' '$1 ~ /(^|;)rs[0-9]+/'`,
      finalVCFPath,
      180000,
      line => recordGenotypeLine(line, false)
    );
  } catch (err) {
    const queryFailure = commandFailureSummary(err);
    extraction.extractionMethod = "text_fallback";
    extraction.fallbackReason = extraction.fallbackReason
      ? `${extraction.fallbackReason}; genotype query: ${queryFailure}`
      : `genotype query: ${queryFailure}`;
    console.warn(
      `[vcf-rsid-extraction-fallback] ${JSON.stringify({ reason: extraction.fallbackReason })}`
    );
    try {
      forEachCommandOutputLineSync(
        `gzip -cdf ${shellQuote(finalVCFPath)} | awk -F'\\t' '!/^#/ && $3 ~ /(^|;)rs[0-9]+/ {print $3"\\t"$4"\\t"$5"\\t"$10}'`,
        finalVCFPath,
        300000,
        line => recordGenotypeLine(line, true)
      );
    } catch (fallbackError) {
      extraction.fallbackReason = `${extraction.fallbackReason ?? 'genotype query failed'}; genotype text fallback failed: ${commandFailureSummary(fallbackError)}`;
      console.warn(
        `   ⚠️  Genotype map build failed, continuing with reduced CPIC matching: ${commandFailureSummary(fallbackError)}`
      );
    }
  }
  const allRSIDs = [
    ...allGenotypes.keys(),
    ...rsidsWithoutGenotypes,
  ];
  console.log(
    `   ${allRSIDs.length.toLocaleString()} unique rsIDs, ${allGenotypes.size.toLocaleString()} with genotypes`
  );

  // Step 5b: ClinVar enrichment (all annotated rsIDs, no cap)
  console.log("\n🏥 Step 5b: Cross-referencing against ClinVar...");
  let clinvarAlerts: Array<{
    itemName: string;
    tag: string;
    evidence: string;
    action: string;
    gene: string;
    rsid: string;
  }> = [];
  console.log(
    `   ClinVar lookup on ${allRSIDs.length.toLocaleString()} rsIDs...`
  );
  const clinvarResult = queryClinVarForRSIDs(allRSIDs);
  clinvarAlerts = generateClinVarAlerts(clinvarResult.annotations);
  console.log(`   ClinVar alerts generated: ${clinvarAlerts.length}`);

  // Step 5c: CPIC pharmacogenomic enrichment
  console.log(
    "\n💊 Step 5c: Pharmacogenomic analysis (CPIC drug-gene pairs)..."
  );
  let cpicAlerts: Array<{
    itemName: string;
    tag: string;
    evidence: string;
    action: string;
    gene: string;
    rsid: string;
  }> = [];
  // Use the full VCF genotype map (all rsIDs) for CPIC matching, not just the 191 targets
  const userGenotypes: Array<{ rsid: string; genotype: string }> = [];
  for (const [rsid, gt] of allGenotypes) {
    userGenotypes.push({ rsid, genotype: gt });
  }
  const cpicResult = matchCPIC(userGenotypes);
  cpicAlerts = generateCPICAlerts(cpicResult);
  console.log(
    `   CPIC matches: ${cpicResult.totalFound} (${cpicResult.levelAMatches} Level A, ${cpicResult.levelBMatches} Level B)`
  );

  // Step 6: Build protocol
  console.log("\n📝 Step 6: Generating Longevity Protocol...");

  const deduplicatedSupplements = deduplicateSupplements(supplements);
  const categorizedSupplements = categorizeSupplements(deduplicatedSupplements);

  const protocol: LongevityProtocol = {
    version: "1.0.0",
    generated: new Date().toISOString(),
    source: {
      fileName: path.basename(vcfPath),
      variantCount: totalVariants,
      annotatedCount,
      matchedMarkerCount: variants.length,
      rsidAnnotationSource,
      rsidAnnotationLimitation,
      rsidExtractionMethod: extraction.extractionMethod,
      rsidExtractionFallbackReason: extraction.fallbackReason,
    },
    biologicalDossier: {},
    genomicProfile: {
      alerts: [
        ...alerts,
        ...clinvarAlerts.filter((ca) => ca.tag.includes("Medical Alert")),
        ...cpicAlerts.filter((ca) => ca.tag.includes("Medical Alert")),
      ],
      superpowers: [
        ...superpowers,
        ...clinvarAlerts
          .filter((ca) => ca.tag.includes("Superpower"))
          .map((ca) => ({
            itemName: ca.itemName,
            tag: ca.tag as "🟢 Superpower",
            evidence: ca.evidence,
            advantage: ca.action,
          })),
      ],
      topRisks: [
        ...topRisks,
        ...clinvarAlerts
          .filter(
            (ca) =>
              ca.tag.includes("Risk Mitigation") ||
              ca.tag.includes("Dietary Rule")
          )
          .map((ca, i) => ({
            itemName: ca.itemName,
            tag: ca.tag as "🛑 Risk Mitigation" | "ℹ️ Dietary Rule",
            priority: Math.min(i + topRisks.length + 1, 3) as 1 | 2 | 3,
            evidence: ca.evidence,
            scienceSimplified: ca.action,
          })),
        ...cpicAlerts
          .filter((ca) => !ca.tag.includes("Medical Alert"))
          .map((ca, i) => ({
            itemName: ca.itemName,
            tag: ca.tag as "🛑 Risk Mitigation" | "ℹ️ Dietary Rule",
            priority: Math.min(
              i + topRisks.length + clinvarAlerts.length + 1,
              3
            ) as 1 | 2 | 3,
            evidence: ca.evidence,
            scienceSimplified: ca.action,
          })),
      ],
    },
    curatedInterpretations,
    dailyStack: categorizedSupplements,
    sourcingSafety: {
      formsToAvoid: [
        "Cyanocobalamin (use methylcobalamin instead)",
        "Synthetic folic acid (use methylfolate for MTHFR variants)",
        "Calcium carbonate (poor absorption, use citrate)",
      ],
      brandCriteria:
        "Only purchase supplements that are NSF Certified for Sport or GMP Certified. Recommended brands: Thorne, Pure Encapsulations, Life Extension, Momentous.",
    },
  };

  // Save protocol if requested
  const outputDir = customOutputDir || vcfDir;
  const protocolPath = path.join(outputDir, "longevity-protocol.json");
  if (save) {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(protocolPath, JSON.stringify(protocol, null, 2));
    console.log(`   Protocol saved to: ${protocolPath}`);
  }

  // Summary
  console.log("\n" + "=".repeat(50));
  console.log("📊 ANALYSIS SUMMARY");
  console.log("=".repeat(50));
  console.log(`   Source: ${protocol.source.fileName}`);
  console.log(
    `   Total variants: ${protocol.source.variantCount.toLocaleString()}`
  );
  console.log(
    `   Analyzed with rsIDs: ${protocol.source.annotatedCount.toLocaleString()}`
  );
  console.log(
    `   Matched curated markers: ${(
      protocol.source.matchedMarkerCount ?? variants.length
    ).toLocaleString()}`
  );
  console.log(
    `   Matched in database: ${
      alerts.length + superpowers.length + topRisks.length
    }`
  );
  console.log("\n   🏷️  Tags applied:");
  console.log(`      Alerts: ${alerts.length}`);
  console.log(`      Superpowers: ${superpowers.length}`);
  console.log(`      Top Risks: ${topRisks.length}`);
  console.log("\n   💊 Supplements:");
  console.log(`      Morning: ${categorizedSupplements.morning.length}`);
  console.log(
    `      Pre-Performance: ${categorizedSupplements.prePerformance.length}`
  );
  console.log(`      Night: ${categorizedSupplements.night.length}`);
  console.log(
    "\n✅ Analysis complete! Protocol JSON ready for dashboard rendering."
  );

  return {
    protocol,
    protocolPath,
    variants,
    annotatedCount,
    rsidMap,
    vepAnnotations: vepResult?.annotations,
    allRSIDs,
    allGenotypes,
    clinvarAnnotations: clinvarResult.annotations,
    totalVariants,
    rsidAnnotationSource,
    rsidAnnotationLimitation,
    rsidExtractionMethod: extraction.extractionMethod,
    rsidExtractionFallbackReason: extraction.fallbackReason,
  };
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function run(argv: string[]) {
  console.log("🧬 Genomic Analysis Pipeline");
  console.log("============================\n");

  const vcfPath = argv[2];
  const isPreAnnotated = argv.includes("--annotated");

  if (!vcfPath) {
    console.error(
      "Usage: npx tsx scripts/analyze-vcf.ts <path-to-vcf-file> [--annotated]"
    );
    process.exit(1);
  }

  try {
    const result = await analyzeVCF(vcfPath, { annotated: isPreAnnotated });
    return result.protocolPath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ ${msg}`);
    process.exit(1);
  }
}

// ============================================================================
// Entry Point
// ============================================================================

// Only execute CLI when run directly (not when imported as a module)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.argv).catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
}

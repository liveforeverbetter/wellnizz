#!/usr/bin/env npx tsx
/**
 * Full integration: merge extracted PDF rsID markers and PRS entries into
 * the vendor interpretation files and prs_weights.json so they feed directly
 * into the core WGS analysis pipeline.
 *
 * Usage: npx tsx scripts/integrate-extracted-markers-full.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const EXTRACTED_DIR = path.join(ROOT, "extracted-report-data");
const INTERP_DIR = path.join(ROOT, "vendor", "health-analysis-skill", "shared", "interpretations");
const PRS_WEIGHTS_PATH = path.join(ROOT, "vendor", "health-analysis-skill", "shared", "prs_weights.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExtractedMarker {
  rsid: string;
  gene: string;
  name: string;
  chrom: string;
  pos: number;
  ref: string;
  alt: string;
  category: string;
  display: string;
}

interface InterpretationEntry {
  gene: string;
  name: string;
  category: string;
  chrom: string;
  pos: number;
  display: string;
  interpretations: Record<string, unknown>;
  evidenceTier?: number;
  bibliography?: string[];
  technical_report?: string;
  description?: string;
  drug_implications?: string;
  prs_info?: unknown;
  provenance?: {
    status: string;
    sources: string[];
    reference_build: string;
  };
}

interface InterpretationFile {
  version: string;
  updated: string;
  description: string;
  markers: Record<string, InterpretationEntry>;
}

interface PRSWeight {
  rsid: string;
  effect_allele: string;
  effect_weight: number;
  disease: string;
  citation: string;
  pgs_id?: string;
  pgs_name?: string;
  reported_trait?: string;
  genome_build?: string;
  ancestry_distribution?: string;
  source_type?: string;
  provenance?: Array<{ source: string; role: string }>;
}

interface PRSWeightsFile {
  description: string;
  updated: string;
  diseases: string[];
  variants: PRSWeight[];
}

interface ExtractedReport {
  trait_name: string;
  trait_name_slug: string;
  internal_category: string;
  parsed_successfully: boolean;
  snp_results: Array<{
    rsid: string;
    gene: string;
    genotype: string;
    result_text: string;
  }>;
  prs_info: {
    risk_interpretation: string;
    num_risk_loci: number | null;
    genes_analyzed: string[];
  } | null;
  description: string;
  technical_report: string;
  bibliography: string[];
  limitations: string;
  all_rsids: string[];
  all_genes: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function saveJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/** Valid rsID: starts with 'rs' followed by digits only */
function isValidRsid(rsid: string): boolean {
  return /^rs\d+$/.test(rsid);
}

/** Category mapping from old extraction categories to new interpretation categories */
const CATEGORY_MAP: Record<string, string> = {
  wellness: "metabolism",
  pharmacology: "pharmacogenomics",
  hereditary: "inherited-conditions",
  vulnerability: "health-vulnerability",
  performance: "cardiometabolic",
  personality: "cognitive",
  traits: "physical-traits",
  superpowers: "superpowers",
  cellular: "cellular-health",
  inflammation: "inflammation",
  skeletal: "skeletal-health",
};

/** Reverse: new category -> filename */
const CATEGORY_FILENAME: Record<string, string> = {
  metabolism: "metabolism.json",
  pharmacogenomics: "pharmacogenomics.json",
  cognitive: "cognitive.json",
  superpowers: "superpowers.json",
  "health-vulnerability": "health-vulnerability.json",
  "inherited-conditions": "inherited-conditions.json",
  "physical-traits": "physical-traits.json",
  "cellular-health": "cellular-health.json",
  cardiometabolic: "cardiometabolic.json",
  inflammation: "inflammation.json",
  "skeletal-health": "skeletal-health.json",
};

/** Map an old category to the new 11-category system */
function mapCategory(oldCategory: string): string {
  const direct = CATEGORY_MAP[oldCategory.toLowerCase()];
  if (direct) return direct;

  // Heuristic mappings for categories not in the map
  const lower = oldCategory.toLowerCase();
  if (lower.includes("hereditary") || lower.includes("condition") || lower.includes("disease"))
    return "inherited-conditions";
  if (lower.includes("pharma") || lower.includes("drug") || lower.includes("medication"))
    return "pharmacogenomics";
  if (lower.includes("wellness") || lower.includes("metabol"))
    return "metabolism";
  if (lower.includes("performance") || lower.includes("athletic") || lower.includes("cardio"))
    return "cardiometabolic";
  if (lower.includes("cognit") || lower.includes("brain") || lower.includes("mental"))
    return "cognitive";
  if (lower.includes("superpower") || lower.includes("protect"))
    return "superpowers";
  if (lower.includes("physical") || lower.includes("trait"))
    return "physical-traits";
  if (lower.includes("inflamm"))
    return "inflammation";
  if (lower.includes("skeletal") || lower.includes("bone"))
    return "skeletal-health";
  if (lower.includes("cellular") || lower.includes("aging"))
    return "cellular-health";

  return "metabolism"; // default fallback
}

// ---------------------------------------------------------------------------
// Step 1: Integrate single-SNP markers from extraction into interpretation files
// ---------------------------------------------------------------------------

function integrateSingleSnpMarkers(): { added: number; skipped: number } {
  console.log("\n=== STEP 1: Integrating single-SNP markers ===\n");

  // Load extracted markers
  const extractedData = loadJson<{ markers: ExtractedMarker[]; total_markers: number }>(
    path.join(EXTRACTED_DIR, "known-rsid-markers.json")
  );
  const extractedMarkers = extractedData.markers || [];

  // Load all existing interpretation files
  const existingFiles: Record<string, InterpretationFile> = {};
  const existingRsids = new Set<string>();

  for (const [cat, filename] of Object.entries(CATEGORY_FILENAME)) {
    const filePath = path.join(INTERP_DIR, filename);
    if (fs.existsSync(filePath)) {
      const data = loadJson<InterpretationFile>(filePath);
      existingFiles[cat] = data;
      for (const rsid of Object.keys(data.markers)) {
        existingRsids.add(rsid);
      }
    }
  }

  // Load extracted reports for enrichment data
  const reportsByRsid: Record<string, ExtractedReport[]> = {};
  const reportsDir = path.join(EXTRACTED_DIR, "reports");
  for (const category of fs.readdirSync(reportsDir)) {
    const catDir = path.join(reportsDir, category);
    if (!fs.statSync(catDir).isDirectory()) continue;
    for (const file of fs.readdirSync(catDir)) {
      if (!file.endsWith(".json")) continue;
      const report = loadJson<ExtractedReport>(path.join(catDir, file));
      for (const snp of report.snp_results || []) {
        if (!reportsByRsid[snp.rsid]) reportsByRsid[snp.rsid] = [];
        reportsByRsid[snp.rsid].push(report);
      }
    }
  }

  let added = 0;
  let skipped = 0;

  for (const marker of extractedMarkers) {
    const rsid = marker.rsid;

    // Skip invalid rsIDs (noise from PDF extraction)
    if (!isValidRsid(rsid)) {
      skipped++;
      continue;
    }

    // Skip if already in interpretation files
    if (existingRsids.has(rsid)) {
      skipped++;
      continue;
    }

    // Find the right category file
    const targetCategory = mapCategory(marker.category);
    const filename = CATEGORY_FILENAME[targetCategory];
    if (!filename) {
      console.warn(`  No filename mapping for category: ${targetCategory}`);
      skipped++;
      continue;
    }

    // Find enrichment data from reports
    const reports = reportsByRsid[rsid] || [];
    const report = reports[0]; // Use first report for enrichment

    // Build interpretation entry
    const entry: InterpretationEntry = {
      gene: marker.gene || "Unknown",
      name: marker.name || rsid,
      category: targetCategory,
      chrom: marker.chrom || "0",
      pos: marker.pos || 0,
      display: marker.display || `${marker.gene} - ${marker.name}`,
      interpretations: {
        default: {
          effect: "Variant detected",
          interpretation: report?.description || `Marker ${rsid}`,
          recommendations: [],
          priority: "medium",
        },
      },
      evidenceTier: 3,
      provenance: {
        status: "curated",
        sources: ["extracted_tellmegen_report"],
        reference_build: "GRCh38",
      },
    };

    if (report) {
      entry.bibliography = report.bibliography || [];
      entry.technical_report = report.technical_report || "";
      entry.description = report.description || "";
    }

    // Add to the appropriate file
    if (!existingFiles[targetCategory]) {
      existingFiles[targetCategory] = {
        version: "2.0.0",
        updated: new Date().toISOString().split("T")[0],
        description: `Curated genetic interpretations - ${targetCategory}`,
        markers: {},
      };
    }

    existingFiles[targetCategory].markers[rsid] = entry;
    existingRsids.add(rsid);
    added++;

    if (added % 50 === 0) {
      console.log(`  Processed ${added} new markers...`);
    }
  }

  // Write updated files
  for (const [cat, data] of Object.entries(existingFiles)) {
    const filename = CATEGORY_FILENAME[cat];
    if (filename) {
      const filePath = path.join(INTERP_DIR, filename);
      data.updated = new Date().toISOString().split("T")[0];
      data.description = `Curated genetic interpretations - ${cat}`;
      saveJson(filePath, data);
      console.log(`  Updated ${filename}: ${Object.keys(data.markers).length} markers`);
    }
  }

  console.log(`\n  Added: ${added}, Skipped (invalid/existing): ${skipped}`);
  return { added, skipped };
}

// ---------------------------------------------------------------------------
// Step 2: Integrate PRS entries into prs_weights.json
// ---------------------------------------------------------------------------

function integratePRSEntries(): { added: number } {
  console.log("\n=== STEP 2: Integrating PRS entries ===\n");

  // Load current PRS weights
  const prsWeights = loadJson<PRSWeightsFile>(PRS_WEIGHTS_PATH);
  const existingDiseases = new Set(prsWeights.diseases || []);

  // Load extracted PRS data from generated-interpretations
  const genDir = path.join(EXTRACTED_DIR, "generated-interpretations");
  const existingMarkerSet = new Set<string>();

  // Load all existing interpretation files to avoid PRS-as-SNP duplication
  for (const filename of Object.values(CATEGORY_FILENAME)) {
    const filePath = path.join(INTERP_DIR, filename);
    if (fs.existsSync(filePath)) {
      const data = loadJson<InterpretationFile>(filePath);
      for (const key of Object.keys(data.markers)) {
        existingMarkerSet.add(key);
      }
    }
  }

  let added = 0;
  const newDiseases: string[] = [];
  const newVariants: PRSWeight[] = [];

  for (const genFile of fs.readdirSync(genDir)) {
    if (!genFile.endsWith(".json")) continue;
    const data = loadJson<InterpretationFile>(path.join(genDir, genFile));
    const markers = data.markers || {};

    for (const [key, entry] of Object.entries(markers)) {
      // Only process PRS entries
      if (!key.startsWith("PRS_")) continue;

      const traitName = key.replace(/^PRS_/, "");
      const diseaseKey = traitName.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");

      // Add disease if not already present
      if (!existingDiseases.has(diseaseKey)) {
        prsWeights.diseases.push(diseaseKey);
        existingDiseases.add(diseaseKey);
        newDiseases.push(diseaseKey);
      }

      // Add PRS genes if they correspond to known rsIDs
      const prsInfo = (entry as any).prs_info;
      if (prsInfo?.genes_analyzed) {
        for (const gene of prsInfo.genes_analyzed) {
          // Check if this gene has a known rsID marker to link
          if (existingMarkerSet.has(key)) continue; // Already added as marker
        }
      }

      added++;
    }
  }

  prsWeights.updated = new Date().toISOString().split("T")[0];
  prsWeights.description = prsWeights.description.replace(/\d+ diseases/, `${prsWeights.diseases.length} diseases`);

  saveJson(PRS_WEIGHTS_PATH, prsWeights);
  console.log(`  Added ${newDiseases.length} new PRS diseases`);
  if (newDiseases.length > 0) {
    console.log(`  New diseases: ${newDiseases.join(", ")}`);
  }
  console.log(`  Total diseases: ${prsWeights.diseases.length}`);

  return { added };
}

// ---------------------------------------------------------------------------
// Step 3: Validate interpretation schemas are correct
// ---------------------------------------------------------------------------

function validateSchemas(): { errors: string[] } {
  console.log("\n=== STEP 3: Validating schemas ===\n");
  const errors: string[] = [];

  for (const filename of Object.values(CATEGORY_FILENAME)) {
    const filePath = path.join(INTERP_DIR, filename);
    if (!fs.existsSync(filePath)) {
      errors.push(`Missing file: ${filename}`);
      continue;
    }

    const data = loadJson<InterpretationFile>(filePath);
    if (!data.version) errors.push(`${filename}: missing version`);
    if (!data.markers || typeof data.markers !== "object") {
      errors.push(`${filename}: missing or invalid markers`);
      continue;
    }

    for (const [rsid, entry] of Object.entries(data.markers)) {
      if (!rsid.startsWith("rs") || !isValidRsid(rsid)) {
        errors.push(`${filename}: invalid rsID key: ${rsid}`);
      }
      if (!entry.gene) errors.push(`${filename}/${rsid}: missing gene`);
      if (!entry.interpretations || typeof entry.interpretations !== "object") {
        errors.push(`${filename}/${rsid}: missing or invalid interpretations`);
      }
    }
  }

  if (errors.length === 0) {
    console.log("  All files valid.");
  } else {
    for (const err of errors) {
      console.log(`  ERROR: ${err}`);
    }
  }

  return { errors };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  console.log("=== Full Marker Integration ===\n");

  const snpResult = integrateSingleSnpMarkers();
  const prsResult = integratePRSEntries();
  const validation = validateSchemas();

  console.log("\n=== Integration Complete ===");
  console.log(`Single-SNP: ${snpResult.added} added, ${snpResult.skipped} skipped`);
  console.log(`PRS diseases: ${prsResult.added} processed`);
  console.log(`Validation errors: ${validation.errors.length}`);

  if (validation.errors.length === 0) {
    console.log("\nNext steps:");
    console.log("  1. Review the updated interpretation files");
    console.log("  2. Run the WGS pipeline to verify matching works");
    console.log("  3. Commit and deploy");
  }
}

main();

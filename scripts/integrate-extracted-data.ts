#!/usr/bin/env npx tsx
/**
 * Integration script: reads extracted report data and updates the curated
 * interpretation pipeline.  All references to the data source are kept out
 * of the committed files; extracted data lives locally only.
 *
 * Usage: npx tsx scripts/integrate-extracted-data.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTRACTED_DIR = path.join(__dirname, "..", "extracted-report-data");
const INTERPRETATIONS_DIR = path.join(
  __dirname,
  "..",
  "vendor",
  "health-analysis-skill",
  "shared",
  "interpretations"
);
const MARKER_DB_FILE = path.join(
  __dirname,
  "..",
  "vendor",
  "health-analysis-skill",
  "shared",
  "marker-database-expanded.ts"
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExtractedReport {
  trait_name: string;
  trait_name_slug: string;
  internal_category: string;
  parsed_successfully: boolean;
  snp_results: {
    rsid: string;
    gene: string;
    genotype: string;
    result_text: string;
  }[];
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
  pharma_results: {
    summary_result: string;
    phenotype: string;
    interpretation: string;
    snps: { snp: string; gene: string; genotype: string; phenotype: string; interpretation: string }[];
  } | null;
  hereditary_results: {
    summary_result: string;
    gene_results: { gene: string; genotype: string; result_text: string; rsid: string | null }[];
  } | null;
}

interface InterpretationFile {
  version: string;
  updated: string;
  description: string;
  markers: Record<string, InterpretationEntry>;
}

interface InterpretationEntry {
  gene: string;
  name: string;
  category: string;
  chrom: string | number;
  pos: number;
  display: string;
  interpretations: Record<string, InterpretationVariant>;
  evidenceTier?: number;
  bibliography?: string[];
  technical_report?: string;
  description?: string;
}

interface InterpretationVariant {
  effect: string;
  interpretation: string;
  recommendations: string[];
  priority: string;
  supplements?: unknown[];
  theWhy?: string;
  scienceSimplified?: string;
}

interface RsidMarker {
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

// ---------------------------------------------------------------------------
// Load extracted data
// ---------------------------------------------------------------------------

function loadReport(filepath: string): ExtractedReport {
  return JSON.parse(fs.readFileSync(filepath, "utf-8"));
}

function loadAllReports(): ExtractedReport[] {
  const reports: ExtractedReport[] = [];
  const reportsDir = path.join(EXTRACTED_DIR, "reports");
  if (!fs.existsSync(reportsDir)) {
    console.log(`No extracted reports found at ${reportsDir}`);
    return reports;
  }
  const categories = fs.readdirSync(reportsDir);
  for (const cat of categories) {
    const catDir = path.join(reportsDir, cat);
    if (!fs.statSync(catDir).isDirectory()) continue;
    for (const file of fs.readdirSync(catDir)) {
      if (!file.endsWith(".json")) continue;
      reports.push(loadReport(path.join(catDir, file)));
    }
  }
  return reports;
}

// ---------------------------------------------------------------------------
// Update interpretation files
// ---------------------------------------------------------------------------

function loadInterpretationFile(category: string): InterpretationFile {
  const fileMap: Record<string, string> = {
    wellness: "wellness.json",
    pharmacology: "pharmacology.json",
    hereditary: "hereditary.json",
    vulnerability: "vulnerability.json",
    performance: "performance.json",
    personality: "personality.json",
    ancestry: "ancestry.json",
  };
  const filepath = path.join(INTERPRETATIONS_DIR, fileMap[category] || `${category}.json`);
  if (!fs.existsSync(filepath)) {
    return { version: "1.0.0", updated: "", description: "", markers: {} };
  }
  return JSON.parse(fs.readFileSync(filepath, "utf-8"));
}

function saveInterpretationFile(category: string, data: InterpretationFile) {
  const fileMap: Record<string, string> = {
    wellness: "wellness.json",
    pharmacology: "pharmacology.json",
    hereditary: "hereditary.json",
    vulnerability: "vulnerability.json",
    performance: "performance.json",
    personality: "personality.json",
    ancestry: "ancestry.json",
  };
  const filepath = path.join(INTERPRETATIONS_DIR, fileMap[category] || `${category}.json`);
  data.updated = new Date().toISOString().split("T")[0];
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  console.log(`  Updated ${filepath} (${Object.keys(data.markers).length} markers)`);
}

/** Priority heuristic based on result text */
function inferPriority(text: string, category: string): string {
  const lower = text.toLowerCase();
  if (category === "hereditary") return "high";
  if (/high.*risk|significant|strongly|severely|homozygous.*variant|pathogenic/i.test(lower)) return "high";
  if (/protective|beneficial|advantage|no.*risk|not.*carrier|normal|typical|reference/i.test(lower)) return "low";
  return "medium";
}

function inferEffect(text: string): string {
  const lower = text.toLowerCase();
  if (/protective/i.test(lower)) return "Protective effect";
  if (/no.*risk|normal|reference|typical/i.test(lower)) return "Reference / typical";
  if (/risk/i.test(lower)) return "Risk variant";
  return "Variant detected";
}

// ---------------------------------------------------------------------------
// Main integration
// ---------------------------------------------------------------------------

function main() {
  const reports = loadAllReports();
  if (reports.length === 0) {
    console.log("No reports to integrate. Run scripts/extract-pdf-data.ts first.");
    return;
  }
  console.log(`Loaded ${reports.length} extracted reports`);

  const stats = { added: 0, skipped: 0, updated: 0 };

  // Group reports by internal category
  const byCat: Record<string, ExtractedReport[]> = {};
  for (const r of reports) {
    if (!r.parsed_successfully) continue;
    if (!byCat[r.internal_category]) byCat[r.internal_category] = [];
    byCat[r.internal_category].push(r);
  }

  // For each category, merge SNP-level interpretations into the interpretation files
  for (const [cat, catReports] of Object.entries(byCat)) {
    const interpFile = loadInterpretationFile(cat);

    for (const report of catReports) {
      for (const snp of report.snp_results) {
        const existingMarker = interpFile.markers[snp.rsid];

        if (existingMarker && existingMarker.interpretations) {
          // Update with richer data if available
          const gtKey = snp.genotype;
          if (!existingMarker.interpretations[gtKey]) {
            existingMarker.interpretations[gtKey] = {
              effect: inferEffect(snp.result_text),
              interpretation: snp.result_text,
              recommendations: [snp.result_text],
              priority: inferPriority(snp.result_text, cat),
            };
            stats.updated++;
          }
          // Update bibliography, technical report, description if missing
          if (!existingMarker.bibliography && report.bibliography.length > 0) {
            existingMarker.bibliography = report.bibliography;
          }
          if (!existingMarker.technical_report && report.technical_report) {
            existingMarker.technical_report = report.technical_report;
          }
          if (!existingMarker.description && report.description) {
            existingMarker.description = report.description;
          }
          continue;
        }

        // Parse genotype to build interpretations
        const gtParts = snp.genotype.split("/");
        if (gtParts.length !== 2) continue;

        const newMarker: InterpretationEntry = {
          gene: snp.gene,
          name: report.trait_name,
          category: cat,
          chrom: "",
          pos: 0,
          display: `${snp.gene} - ${report.trait_name}`,
          interpretations: {
            [snp.genotype]: {
              effect: inferEffect(snp.result_text),
              interpretation: snp.result_text,
              recommendations: [snp.result_text],
              priority: inferPriority(snp.result_text, cat),
            },
          },
          evidenceTier: 2,
        };

        if (report.bibliography.length > 0) {
          newMarker.bibliography = report.bibliography;
        }
        if (report.technical_report) {
          newMarker.technical_report = report.technical_report;
        }
        if (report.description) {
          newMarker.description = report.description;
        }

        interpFile.markers[snp.rsid] = newMarker;
        stats.added++;
      }
    }

    saveInterpretationFile(cat, interpFile);
  }

  // Summary
  console.log(`\n=== Integration Summary ===`);
  console.log(`New markers added: ${stats.added}`);
  console.log(`Existing markers updated: ${stats.updated}`);
  console.log(`Skipped (already complete): ${stats.skipped}`);
  console.log(`\nCategories processed: ${Object.keys(byCat).join(", ")}`);
}

main();

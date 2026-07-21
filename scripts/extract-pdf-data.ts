#!/usr/bin/env npx tsx
/**
 * Extract structured data from health report PDFs.
 * Reads PDF text via pdftotext, parses trait names, SNP-level results,
 * polygenic scores, technical reports, and bibliographies.
 *
 * Outputs JSON files to extracted-report-data/ for integration into
 * the curated interpretation pipeline.
 *
 * Usage: npx tsx scripts/extract-pdf-data.ts
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT_DIR = process.argv[2] || path.join(
  process.env.HOME || "/tmp",
  "Downloads",
  "report-pdfs"
);
const OUTPUT_DIR = path.join(
  __dirname,
  "..",
  "extracted-report-data"
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SnpResult {
  rsid: string;
  gene: string;
  genotype: string;
  result_text: string;
}

interface ExtractedReport {
  filename: string;
  category: string;
  trait_name: string;
  /** Full extracted text (for debugging) */
  raw_text: string;
  /** Single-SNP results found in this report */
  snp_results: SnpResult[];
  /** Polygenic / PRS info */
  prs_info: {
    result_summary: string;
    risk_interpretation: string;
    num_risk_loci: number | null;
    genes_analyzed: string[];
  } | null;
  /** Consumer-friendly description paragraphs */
  description: string;
  /** Technical report text */
  technical_report: string;
  /** Bibliography lines */
  bibliography: string[];
  /** Study limitations */
  limitations: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(filepath: string): string {
  try {
    return execSync(`pdftotext "${filepath}" -`, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15_000,
    }).toString();
  } catch {
    return "";
  }
}

/** Strip non-printable / Unicode drawing characters that pdftotext often emits */
function cleanText(raw: string): string {
  return raw
    .replace(/[\u2000-\u206F\u2800-\u28FF\uE000-\uF8FF\uDB80-\uDBFF\uDC00-\uDFFF]/g, "")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Map directory name to our internal category key */
function mapCategory(dirName: string): string {
  const map: Record<string, string> = {
    Wellness: "wellness",
    Traits: "performance", // traits map to performance/personality based on content
    HereditaryConditions: "hereditary",
    Pharmacology: "pharmacology",
  };
  return map[dirName] || "wellness";
}

/** Extract trait name from first few lines (usually after "Wellness / ...", "Traits / ..." etc.) */
function extractTraitName(text: string, rawFilename: string): string {
  // Pattern: "Category / Trait name" appears early in the PDF
  const m = text.match(/^[A-Z][a-z]+[\s]*\/[\s]*([^\n]+)/m);
  if (m) return m[1].trim();

  // Fallback to filename
  return rawFilename
    .replace(/\.pdf$/i, "")
    .replace(/_/g, " ")
    .trim();
}

/** Extract SNP-level results from the "SNP" ... "GENOTYPE" ... "RESULT" blocks */
function extractSnpResults(text: string): SnpResult[] {
  const results: SnpResult[] = [];
  // Each SNP block: SNP [rsID] GEN OR REGION [gene] GENOTYPE [gt] RESULT [...]
  const snpBlockRe =
    /SNP\s*\n\s*(rs\d+)\s*\n\s*GEN\s+OR\s+REGION\s*\n\s*([^\n]+?)\s*\n\s*GENOTYPE\s*\n\s*([^\n]+?)\s*\n\s*RESULT\s*\n([\s\S]*?)(?=\n\s*(?:SNP\s*\n|For the obtaining|These results|\n\s*\n\s*\n))/g;

  let match: RegExpExecArray | null;
  while ((match = snpBlockRe.exec(text)) !== null) {
    results.push({
      rsid: match[1].trim(),
      gene: match[2].trim(),
      genotype: match[3].trim(),
      result_text: match[4].trim(),
    });
  }
  return results;
}

/** Extract polygenic / PRS info: risk percentages, loci count, genes analyzed */
function extractPrsInfo(text: string): ExtractedReport["prs_info"] {
  // Check if this is a PRS-based report (has "Number of risk loci" section)
  const lociMatch = text.match(/Number\s+of\s+risk\s+loci\s*\n\s*(\d+)\s*loci/i);
  const genesMatch = text.match(
    /Genes\s+analyzed\s*\n([\s\S]*?)(?=\n\s*\n|\nThese results)/
  );

  if (!lociMatch && !genesMatch) return null;

  const genesAnalyzed = genesMatch
    ? genesMatch[1]
        .replace(/\n/g, " ")
        .split(/[,\s]+/)
        .map((g) => g.trim())
        .filter((g) => g.length > 1 && !/^\d+$/.test(g))
    : [];

  // Extract risk percentages (e.g. "Low levels 74%" / "High levels 26%")
  const pctRe = /([^\d\n]+?)\s+(\d+)%/g;
  const percentages: string[] = [];
  let pm: RegExpExecArray | null;
  while ((pm = pctRe.exec(text)) !== null) {
    percentages.push(`${pm[1].trim()}: ${pm[2]}%`);
  }

  // Extract the result summary line (e.g. "Your genetic results indicate\nLow levels")
  const summaryMatch = text.match(
    /Your\s+(?:genetic\s+)?results?\s+indicate\s*\n\s*([^\n]+)/i
  );
  let riskInterpretation = "";
  if (percentages.length > 0) {
    riskInterpretation = percentages.join(" | ");
  }
  if (summaryMatch) {
    // Prepend summary if not already in percentages
    const summary = summaryMatch[1].trim();
    if (!riskInterpretation.includes(summary)) {
      riskInterpretation = `${summary} — ${riskInterpretation}`;
    }
  }

  return {
    result_summary: riskInterpretation,
    risk_interpretation: riskInterpretation,
    num_risk_loci: lociMatch ? parseInt(lociMatch[1], 10) : null,
    genes_analyzed: genesAnalyzed,
  };
}

/** Extract description text (between trait name and "Your genetic results indicate" / "Technical report") */
function extractDescription(text: string): string {
  const descMatch = text.match(
    /^(?:[\s\S]*?\/[\s\S]*?)\n\n([\s\S]*?)(?=Your\s+(?:genetic\s+)?results?\s+indicate|Technical report|For the obtaining)/i
  );
  if (!descMatch) return "";
  return descMatch[1].trim();
}

/** Extract technical report text */
function extractTechnicalReport(text: string): string {
  const techMatch = text.match(
    /Technical\s+report\s*\n([\s\S]*?)(?=\n\s*(?:Bibliography|Study limitations|Genetic test|$))/i
  );
  if (!techMatch) return "";
  return techMatch[1].trim();
}

/** Extract bibliography lines */
function extractBibliography(text: string): string[] {
  const bibMatch = text.match(
    /Bibliography\s*\n([\s\S]*?)(?=\n\s*(?:Study limitations|Genetic test|$))/i
  );
  if (!bibMatch) return [];
  return bibMatch[1]
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 10 && !/^Study limitations/i.test(l));
}

/** Extract study limitations */
function extractLimitations(text: string): string {
  const limMatch = text.match(
    /Study\s+limitations\s*\n([\s\S]*?)(?=\n\s*(?:Genetic test|$))/i
  );
  if (!limMatch) return "";
  return limMatch[1].trim();
}

// ---------------------------------------------------------------------------
// Pharmacology-specific extraction
// ---------------------------------------------------------------------------

interface PharmaSnpResult {
  snp: string;
  position: string;
  chromosome: string;
  gene: string;
  genotype: string;
  phenotype: string;
  interpretation: string;
}

function extractPharmaResults(text: string): {
  summary_result: string;
  phenotype: string;
  interpretation: string;
  snps: PharmaSnpResult[];
} {
  const result: {
    summary_result: string;
    phenotype: string;
    interpretation: string;
    snps: PharmaSnpResult[];
  } = { summary_result: "", phenotype: "", interpretation: "", snps: [] };

  // Extract the result summary line
  const rMatch = text.match(/Your\s+result\s+is\s*\n\s*([^\n]+)/i);
  if (rMatch) result.summary_result = rMatch[1].trim();

  // Extract phenotype
  const pMatch = text.match(/Phenotype\s*\n\s*([^\n]+)/i);
  if (pMatch) result.phenotype = pMatch[1].trim();

  // Extract interpretation
  const iMatch = text.match(/Interpretation\s*\n([\s\S]*?)(?=\n\s*(?:For obtaining|Technical|SNP|$))/i);
  if (iMatch) result.interpretation = iMatch[1].trim();

  // Extract SNP details
  const snpBlockRe =
    /SNP\s*\n\s*(rs\d+)\s*\n\s*(\d+)\s*\n\s*Chromosome\s*\n\s*([^\n]+)\s*\n\s*Gene\s*\n\s*([^\n]+)\s*\n\s*Genotype\s*\n\s*([^\n]+)\s*\n\s*Phenotype\s*\n\s*([^\n]+)\s*\n\s*Interpretation\s*\n([\s\S]*?)(?=\n\s*(?:SNP\s*$|$))/g;

  let sm: RegExpExecArray | null;
  while ((sm = snpBlockRe.exec(text)) !== null) {
    result.snps.push({
      snp: sm[1].trim(),
      position: sm[2].trim(),
      chromosome: sm[3].trim(),
      gene: sm[4].trim(),
      genotype: sm[5].trim(),
      phenotype: sm[6].trim(),
      interpretation: sm[7].trim(),
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Hereditary-specific extraction
// ---------------------------------------------------------------------------

interface HereditaryResult {
  gene: string;
  variant: string;
  genotype: string;
  result_text: string;
  rsid: string | null;
}

function extractHereditaryResults(text: string): {
  summary_result: string;
  gene_results: HereditaryResult[];
  description: string;
  technical_report: string;
  bibliography: string[];
} {
  const result: {
    summary_result: string;
    gene_results: HereditaryResult[];
    description: string;
    technical_report: string;
    bibliography: string[];
  } = { summary_result: "", gene_results: [], description: "", technical_report: "", bibliography: [] };

  // Summary result
  const rMatch = text.match(/Your\s+(?:genetic\s+)?results?\s+indicate\s*\n\s*([^\n]+)/i);
  if (rMatch) result.summary_result = rMatch[1].trim();

  // Gene results: "SNP rsID GEN OR REGION gene GENOTYPE gt RESULT text"
  const snpResults = extractSnpResults(text);
  for (const snp of snpResults) {
    result.gene_results.push({
      gene: snp.gene,
      variant: "",
      genotype: snp.genotype,
      result_text: snp.result_text,
      rsid: snp.rsid,
    });
  }

  // If no SNP-level results, look for gene-with-mutation patterns
  if (result.gene_results.length === 0) {
    const geneBlockRe =
      /(?:GENE|Gene)\s*\n\s*([^\n]+?)\s*\n\s*(?:VARIANT|Variant)?\s*\n?\s*([^\n]+?)?\s*\n\s*GENOTYPE\s*\n\s*([^\n]+?)\s*\n\s*RESULT\s*\n([\s\S]*?)(?=\n\s*(?:GENE|Gene|$))/g;
    let gm: RegExpExecArray | null;
    while ((gm = geneBlockRe.exec(text)) !== null) {
      result.gene_results.push({
        gene: gm[1].trim(),
        variant: (gm[2] || "").trim(),
        genotype: gm[3].trim(),
        result_text: gm[4].trim(),
        rsid: null,
      });
    }
  }

  result.description = extractDescription(text);
  result.technical_report = extractTechnicalReport(text);
  result.bibliography = extractBibliography(text);

  return result;
}

// ---------------------------------------------------------------------------
// Trait type detection (maps Traits → appropriate internal category)
// ---------------------------------------------------------------------------

const PERSONALITY_TRAITS = new Set([
  "gene comt",
  "gene mtr",
  "gene mtrr",
  "alcohol flush",
  "farmer-hunter",
  "food intake control",
  "preference for sweets",
  "bitter taste perception",
  "caffeine and anxiety",
  "caffeine dependence",
]);

const PERFORMANCE_TRAITS = new Set([
  "muscle endurance",
  "exercise-induced muscle damage",
  "basal metabolic rate",
  "resting heart rate",
  "usual walking pace",
  "caffeine and sports performance",
  "antioxidant capacity",
  "myoadenylate deaminase",
  "farmer-hunter",
  "lung function",
]);

function categorizeTrait(traitName: string, parentCategory: string): string {
  const lower = traitName.toLowerCase();
  if (parentCategory === "pharmacology") return "pharmacology";
  if (parentCategory === "hereditary") return "hereditary";
  if (parentCategory === "wellness") return "wellness";

  // Traits is the tricky one - split between performance and personality
  if (PERSONALITY_TRAITS.has(lower)) return "personality";
  if (PERFORMANCE_TRAITS.has(lower)) return "performance";

  // Default mapping for Traits/others → wellness
  if (parentCategory === "performance") {
    // Check if it contains gene-specific info (MTR, MTRR, COMT, etc.) → personality
    if (
      /\b(COMT|MTR|MTRR|BDNF|SLC6A4|HTR2A|ADRA2A|BDNF|DRD2)\b/i.test(
        traitName
      )
    ) {
      return "personality";
    }
    return "performance";
  }

  return "wellness";
}

// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------

interface ParsedReport {
  filename: string;
  source_category: string; // Directory it came from
  internal_category: string; // Our internal category mapping
  trait_name: string;
  trait_name_slug: string; // For file naming
  raw_text_length: number;
  parsed_successfully: boolean;
  parse_error?: string;
  // Unified fields
  result_summary: string;
  snp_results: SnpResult[];
  prs_info: ExtractedReport["prs_info"];
  description: string;
  technical_report: string;
  bibliography: string[];
  limitations: string;
  // Pharma-specific
  pharma_results: ReturnType<typeof extractPharmaResults> | null;
  // Hereditary-specific
  hereditary_results: ReturnType<typeof extractHereditaryResults> | null;
  // All rsIDs found
  all_rsids: string[];
  // All genes found
  all_genes: string[];
}

function parseReport(filepath: string, categoryDir: string): ParsedReport {
  const filename = path.basename(filepath, ".pdf");
  const raw = cleanText(extractText(filepath));

  if (!raw || raw.length < 50) {
    return {
      filename,
      source_category: categoryDir,
      internal_category: mapCategory(categoryDir),
      trait_name: filename.replace(/_/g, " "),
      trait_name_slug: filename.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/(^_|_$)/g, ""),
      raw_text_length: raw.length,
      parsed_successfully: false,
      parse_error: "PDF contains no extractable text (image-based or corrupted)",
      result_summary: "",
      snp_results: [],
      prs_info: null,
      description: "",
      technical_report: "",
      bibliography: [],
      limitations: "",
      pharma_results: null,
      hereditary_results: null,
      all_rsids: [],
      all_genes: [],
    };
  }

  const traitName = extractTraitName(raw, filename);
  const internalCat = categorizeTrait(
    traitName,
    mapCategory(categoryDir)
  );

  // Extract all rsIDs from text
  const rsidMatches = raw.matchAll(/rs(\d+)/gi);
  const allRsids = [...new Set([...rsidMatches].map((m) => `rs${m[1]}`))];

  // Extract all gene names (capital-letter gene symbols from "Genes analyzed" or "GEN OR REGION")
  const geneSet = new Set<string>();
  // From "GEN OR REGION" blocks
  for (const g of raw.matchAll(/GEN\s+OR\s+REGION\s*\n\s*([^\n]+)/gi)) {
    geneSet.add(g[1].trim());
  }
  // From "Genes analyzed" blocks
  const gaMatch = raw.match(/Genes\s+analyzed\s*\n([\s\S]*?)(?=\n\s*\n|\nThese results)/i);
  if (gaMatch) {
    gaMatch[1]
      .replace(/\n/g, " ")
      .split(/[,\s]+/)
      .map((g) => g.trim())
      .filter((g) => g.length > 1 && /^[A-Z]/.test(g))
      .forEach((g) => geneSet.add(g));
  }
  // From "GENE" mentions in heredity
  for (const g of raw.matchAll(/\b([A-Z][A-Z0-9]{1,8})\b/g)) {
    // Only add if it looks like a gene symbol (all caps with possible numbers, 2-9 chars)
    // Filter out PDF noise / common false positives
    const NOISE = new Set(["PDF", "WGS", "SNP", "GEN", "REGION", "GENOTYPE", "RESULT", "GWAS", "DNA", "RNA", "PRS", "JL", "AI", "URL", "NIH", "NHS", "GWAS", "SNPS", "LPH", "SSR", "IBD", "COPD", "BMD", "TSH", "PSA", "HDL", "LDL", "BMI", "ABO", "RH", "FVC", "ROS", "UVB", "HLA", "MCP", "VDR", "LCT", "TBI"]);
    if (/^[A-Z][A-Z0-9]{1,8}$/.test(g[1]) && g[1].length >= 2 && !NOISE.has(g[1])) {
      geneSet.add(g[1]);
    }
  }

  const allGenes = [...geneSet];

  return {
    filename,
    source_category: categoryDir,
    internal_category: internalCat,
    trait_name: traitName,
    trait_name_slug: filename.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/(^_|_$)/g, ""),
    raw_text_length: raw.length,
    parsed_successfully: true,
    result_summary: "",
    snp_results: extractSnpResults(raw),
    prs_info: extractPrsInfo(raw),
    description: extractDescription(raw),
    technical_report: extractTechnicalReport(raw),
    bibliography: extractBibliography(raw),
    limitations: extractLimitations(raw),
    pharma_results:
      mapCategory(categoryDir) === "pharmacology"
        ? extractPharmaResults(raw)
        : null,
    hereditary_results:
      mapCategory(categoryDir) === "hereditary"
        ? extractHereditaryResults(raw)
        : null,
    all_rsids: allRsids,
    all_genes: allGenes,
  };
}

// ---------------------------------------------------------------------------
// Aggregate: build known-rsid-markers.json, interpretations, citations
// ---------------------------------------------------------------------------

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

interface CitationEntry {
  id: string;
  text: string;
  traits: string[];
  source_reports: string[];
}

function buildOutputs(allReports: ParsedReport[]) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // 1. Save individual parsed reports
  const reportsDir = path.join(OUTPUT_DIR, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  // Group by category
  const byCategory: Record<string, ParsedReport[]> = {};
  for (const r of allReports) {
    const cat = r.internal_category;
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(r);

    // Write individual report JSON
    const catDir = path.join(reportsDir, cat);
    fs.mkdirSync(catDir, { recursive: true });
    const outPath = path.join(catDir, `${r.trait_name_slug}.json`);
    fs.writeFileSync(outPath, JSON.stringify(r, null, 2));
  }

  // 2. Build known-rsid-markers.json
  const allMarkers: RsidMarker[] = [];
  const seenRsids = new Set<string>();

  for (const r of allReports) {
    if (!r.parsed_successfully) continue;
    for (const snp of r.snp_results) {
      if (seenRsids.has(snp.rsid)) continue;
      seenRsids.add(snp.rsid);

      allMarkers.push({
        rsid: snp.rsid,
        gene: snp.gene,
        name: r.trait_name,
        chrom: "",
        pos: 0,
        ref: "",
        alt: "",
        category: r.internal_category,
        display: `${snp.gene} - ${r.trait_name}`,
      });
    }
  }

  // Also add rsIDs found in text but not in SNP results
  for (const r of allReports) {
    if (!r.parsed_successfully) continue;
    for (const rsid of r.all_rsids) {
      if (seenRsids.has(rsid)) continue;
      seenRsids.add(rsid);
      allMarkers.push({
        rsid,
        gene: "",
        name: r.trait_name,
        chrom: "",
        pos: 0,
        ref: "",
        alt: "",
        category: r.internal_category,
        display: `${rsid} - ${r.trait_name}`,
      });
    }
  }

  const markersJson = {
    version: "1.0.0",
    updated: new Date().toISOString().split("T")[0],
    description: "Known rsID markers extracted from health reports",
    total_markers: allMarkers.length,
    markers: allMarkers,
  };

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "known-rsid-markers.json"),
    JSON.stringify(markersJson, null, 2)
  );

  // 3. Build interpretation catalog per category
  const interpretationsDir = path.join(
    OUTPUT_DIR,
    "generated-interpretations"
  );
  fs.mkdirSync(interpretationsDir, { recursive: true });

  for (const [cat, reports] of Object.entries(byCategory)) {
    const markers: Record<string, unknown> = {};

    for (const r of reports) {
      if (!r.parsed_successfully) continue;

      for (const snp of r.snp_results) {
        // Build genotype interpretations from the result text
        const genotypes: Record<string, unknown> = {};

        // Parse genotype like "G/A" or "C/C" or "C/T"
        const gtParts = snp.genotype.split("/");
        if (gtParts.length === 2) {
          const a1 = gtParts[0].trim();
          const a2 = gtParts[1].trim();

          // Determine effect from result text
          let priority = "medium";
          let effect = "Variant detected";
          if (
            /normal|typical|reference|no.*risk|not.*carrier/i.test(
              snp.result_text
            )
          )
            priority = "low";
          if (
            /high.*risk|significant|strongly|severely|homozygous/i.test(
              snp.result_text
            )
          )
            priority = "high";
          if (/protective|beneficial|advantage/i.test(snp.result_text)) {
            effect = "Protective effect";
            priority = "low";
          }

          if (snpsInPharma(cat)) {
            // For pharmacology, use the pharma-specific interpretation
            genotypes[snp.genotype] = {
              effect: effect,
              interpretation: snp.result_text,
              recommendations: [
                "See full pharmacogenomics report for drug-specific guidance",
              ],
              priority: priority,
              drug_implications: r.pharma_results?.interpretation || "",
            };
          } else {
            genotypes[snp.genotype] = {
              effect: effect,
              interpretation: snp.result_text,
              recommendations: [snp.result_text],
              priority: priority,
            };
          }
        }

        markers[snp.rsid] = {
          gene: snp.gene,
          name: r.trait_name,
          category: cat,
          chrom: "",
          pos: 0,
          display: `${snp.gene} - ${r.trait_name}`,
          interpretations: genotypes,
          evidenceTier: 2,
          bibliography: r.bibliography,
          technical_report: r.technical_report,
          description: r.description,
        };
      }

      // For PRS-based reports without SNP results, create a report-level entry
      if (r.snp_results.length === 0 && r.prs_info && r.all_rsids.length > 0) {
        const reportKey = r.trait_name_slug;
        markers[`PRS_${reportKey}`] = {
          gene: r.all_genes.join(", "),
          name: r.trait_name,
          category: cat,
          chrom: "",
          pos: 0,
          display: r.trait_name,
          prs_info: {
            num_risk_loci: r.prs_info.num_risk_loci,
            genes_analyzed: r.prs_info.genes_analyzed,
            risk_interpretation: r.prs_info.risk_interpretation,
          },
          interpretations: {
            polygenic: {
              effect: r.prs_info.risk_interpretation,
              interpretation: r.description,
              recommendations: [
                "Polygenic trait - multiple genetic variants contribute",
              ],
              priority: "medium",
            },
          },
          evidenceTier: 2,
          bibliography: r.bibliography,
          technical_report: r.technical_report,
          description: r.description,
        };
      }
    }

    const interpretationFile: Record<string, unknown> = {
      version: "1.0.0",
      updated: new Date().toISOString().split("T")[0],
      description: `${cat} interpretations - auto-generated from health reports`,
      markers,
    };

    fs.writeFileSync(
      path.join(interpretationsDir, `${cat}.json`),
      JSON.stringify(interpretationFile, null, 2)
    );
  }

  // 4. Build citation database
  const citationDb: CitationEntry[] = [];
  const seenCitations = new Set<string>();

  for (const r of allReports) {
    if (!r.parsed_successfully) continue;
    for (const bib of r.bibliography) {
      const key = bib.substring(0, 80);
      if (seenCitations.has(key)) continue;
      seenCitations.add(key);

      citationDb.push({
        id: `cite_${citationDb.length + 1}`.padStart(8, "0"),
        text: bib,
        traits: [r.trait_name],
        source_reports: [r.filename],
      });
    }
  }

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "citations.json"),
    JSON.stringify(
      {
        version: "1.0.0",
        updated: new Date().toISOString().split("T")[0],
        total_citations: citationDb.length,
        citations: citationDb,
      },
      null,
      2
    )
  );

  // 5. Build gene-to-rsID lookup index
  const geneRsidIndex: Record<string, string[]> = {};
  for (const r of allReports) {
    if (!r.parsed_successfully) continue;
    if (r.all_rsids.length === 0) continue;

    for (const gene of r.all_genes) {
      if (!geneRsidIndex[gene]) geneRsidIndex[gene] = [];
      for (const rsid of r.all_rsids) {
        if (!geneRsidIndex[gene].includes(rsid)) {
          geneRsidIndex[gene].push(rsid);
        }
      }
    }
  }

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "gene-rsid-index.json"),
    JSON.stringify(
      {
        version: "1.0.0",
        updated: new Date().toISOString().split("T")[0],
        description: "Gene-to-rsID lookup index",
        genes: Object.keys(geneRsidIndex).length,
        index: geneRsidIndex,
      },
      null,
      2
    )
  );

  // 6. Build trait catalog (all trait names with metadata)
  const traitCatalog = allReports
    .filter((r) => r.parsed_successfully)
    .map((r) => ({
      trait_name: r.trait_name,
      trait_name_slug: r.trait_name_slug,
      category: r.internal_category,
      source_category: r.source_category,
      has_snp_results: r.snp_results.length > 0,
      has_prs_info: r.prs_info !== null,
      num_rsids: r.all_rsids.length,
      num_genes: r.all_genes.length,
      report_type: r.snp_results.length > 0 ? "SNP-based" : "PRS/polygenic",
    }));

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "trait-catalog.json"),
    JSON.stringify(
      {
        version: "1.0.0",
        updated: new Date().toISOString().split("T")[0],
        total_traits: traitCatalog.length,
        traits: traitCatalog,
      },
      null,
      2
    )
  );

  // 7. Summary statistics
  const failed = allReports.filter((r) => !r.parsed_successfully);
  console.log(`\n=== Extraction Summary ===`);
  console.log(`Total PDFs processed: ${allReports.length}`);
  console.log(`Successfully parsed: ${allReports.filter((r) => r.parsed_successfully).length}`);
  console.log(`Failed (no text): ${failed.length}`);
  if (failed.length > 0) {
    console.log(`  Failed files:`);
    for (const f of failed) console.log(`    - ${f.filename}`);
  }
  console.log(`\nTotal unique rsIDs: ${allMarkers.length}`);
  console.log(`Total citations: ${citationDb.length}`);
  console.log(`\nOutput written to: ${OUTPUT_DIR}`);
}

function snpsInPharma(cat: string): boolean {
  return cat === "pharmacology";
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(INPUT_DIR)) {
    console.error(`Input directory not found: ${INPUT_DIR}`);
    process.exit(1);
  }

  const allReports: ParsedReport[] = [];

  const categoryDirs = fs
    .readdirSync(INPUT_DIR)
    .filter((d) => !d.startsWith(".") && fs.statSync(path.join(INPUT_DIR, d)).isDirectory());

  for (const catDir of categoryDirs) {
    const catPath = path.join(INPUT_DIR, catDir);
    const pdfs = fs
      .readdirSync(catPath)
      .filter((f) => f.toLowerCase().endsWith(".pdf"));

    console.log(`\nProcessing ${catDir} (${pdfs.length} PDFs)...`);

    for (const pdf of pdfs) {
      const filepath = path.join(catPath, pdf);
      const report = parseReport(filepath, catDir);
      allReports.push(report);

      const status = report.parsed_successfully ? "OK" : "FAIL";
      const snpInfo =
        report.snp_results.length > 0
          ? ` (${report.snp_results.length} SNPs)`
          : report.prs_info
            ? " (PRS)"
            : "";
      const geneInfo = report.all_genes.length > 0 ? ` [${report.all_genes.length} genes]` : '';
      console.log(`  ${status}: ${pdf}${snpInfo}${geneInfo}`);
    }
  }

  buildOutputs(allReports);
}

main();

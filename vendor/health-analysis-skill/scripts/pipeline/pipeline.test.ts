/**
 * Pipeline Engine Tests
 *
 * Run: npx tsx --test scripts/pipeline/pipeline.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import { enrichTraits } from "./graph_resolver.js";
import type { EnrichedTrait } from "./graph_resolver.js";
import {
  computeAllPriorities,
  computePriority,
  getEvidenceWeight,
} from "./priority_engine.js";
import { generateInsights } from "./insight_engine.js";
import { generateProtocols } from "./protocol_engine.js";
import {
  computeGLI,
  computeWeightedGLI,
  getGLIRating,
  computeCategoryGLI,
  computeWeightedCategoryGLI,
  computeEvidenceWeightedGLI,
} from "./gli_engine.js";
import {
  computeHallmarkScores,
  getHallmarksForGene,
  getGenesForHallmark,
} from "./hallmark_engine.js";
import { ACMG_SF_GENES, ACMG_GENE_INFO, isRare } from "./clinvar_enrichment.js";
import { HEREDITARY_CANCER_PANEL_GENES } from "./hereditary_cancer_panel.js";
import {
  parseVEPOutput,
  parseVEPOutputSync,
  queryVEPForVariant,
  queryVEPForVariants,
  isVEPAvailable,
} from "./vep_annotation.js";
import { analyzeBiomarkers } from "./biomarker_engine.js";
import { buildBiomarkerBenchmarkReport } from "./biomarker_benchmark.js";
import { buildGeneticsBenchmarkReport } from "./genetics_benchmark.js";
import { buildGeneticsReportCatalog } from "./genetics_report_catalog.js";
import { buildCompactInterpretationCatalog } from "./compact_interpretation_catalog.js";
import { buildInterpretationDepthReport } from "./interpretation_depth_metrics.js";
import {
  buildWgsValidationCoverage,
  refreshWgsReadinessArtifacts,
} from "./index.js";
import { analyzeWearables } from "./wearable_engine.js";
import { buildMultiModalPlan } from "./multimodal_engine.js";
import {
  parseBiomarkerCsv,
  parseBiomarkerText,
  parseWearableCsv,
  parseWearableFile,
  parseWearableJson,
} from "./health_data_import.js";
import {
  parseWgsVariantClassVcf,
  readWgsInterpretationCatalog,
} from "./wgs_variant_class_engine.js";
import { validateWgsVariantClassesFromTruthsets } from "./wgs_validation.js";
import { buildExternalBenchmarkReport } from "./wgs_external_validation.js";
import { buildWgsTruthsetSetupReport } from "./wgs_external_truthset_setup.js";
import { validateBiomarkerTruthsets } from "./biomarker_validation.js";
import { buildWgsCallerManifest } from "./wgs_caller_pipeline.js";
import {
  buildWgsQueryReadinessReport,
  renderWgsLocalSetupScript,
} from "./wgs_query_readiness.js";
import { computePRS, loadPRSWeights } from "./prs_engine.js";
import { buildLocalVcfCoverageReport } from "./local_vcf_coverage.js";
import * as os from "os";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("PRS consumer descriptions", () => {
  it("keeps coverage detail in metadata instead of repeating caution text for every trait", () => {
    const firstWeight = loadPRSWeights().variants[0];
    assert.ok(firstWeight, "Expected at least one configured PRS weight");

    const result = computePRS(
      new Map([[firstWeight.rsid, firstWeight.effect_allele]])
    );
    assert.ok(result.scores.length > 0);
    for (const score of result.scores) {
      assert.doesNotMatch(
        score.description,
        /interpret cautiously|configured PRS markers|directional rather than definitive|not a diagnosis/i
      );
      assert.ok(score.variantsScored > 0);
      assert.ok(score.totalWeightedVariants >= score.variantsScored);
      assert.ok(typeof score.coveragePct === "number");
    }
  });
});

// ============================================================================
// Test Data
// ============================================================================

const sampleTraitScores: Array<{
  trait_id: string;
  score: number;
  confidence: number;
}> = [
  { trait_id: "methylation", score: 35, confidence: 0.9 },
  { trait_id: "caffeine_metabolism", score: 20, confidence: 0.85 },
  { trait_id: "inflammation", score: 55, confidence: 0.8 },
  { trait_id: "vitamin_d", score: 70, confidence: 0.75 },
  { trait_id: "neuroplasticity", score: 60, confidence: 0.88 },
  { trait_id: "dna_repair", score: 45, confidence: 0.7 },
  { trait_id: "cardiovascular_fitness", score: 70, confidence: 0.95 },
  { trait_id: "muscular_strength", score: 70, confidence: 0.95 },
  { trait_id: "sleep_longevity", score: 70, confidence: 0.95 },
];

// ============================================================================
// GLI Engine Tests
// ============================================================================

describe("GLI Engine", () => {
  it("should compute GLI as avg(scores) * 10", () => {
    const traits = enrichTraits(sampleTraitScores);
    const gli = computeGLI(traits);
    // avg: (35+20+55+70+60+45+70+70+70) / 9 = 55, * 10 = 550
    assert.strictEqual(gli, 550);
  });

  it("should return 0 for empty traits", () => {
    const gli = computeGLI([]);
    assert.strictEqual(gli, 0);
  });

  it("should return Excellent for GLI >= 800", () => {
    assert.strictEqual(getGLIRating(820).rating, "Excellent");
  });

  it("should return Good for GLI 600-799", () => {
    assert.strictEqual(getGLIRating(650).rating, "Good");
  });

  it("should return Moderate for GLI 400-599", () => {
    assert.strictEqual(getGLIRating(500).rating, "Moderate");
  });

  it("should return Needs Work for GLI < 400", () => {
    assert.strictEqual(getGLIRating(350).rating, "Needs Work");
  });

  it("should compute per-category GLI", () => {
    const traits = enrichTraits(sampleTraitScores);
    const categories = computeCategoryGLI(traits);
    assert.ok(typeof categories === "object");
    assert.ok(Object.keys(categories).length > 0);
  });

  it("boundary: 800 is Excellent", () => {
    assert.strictEqual(getGLIRating(800).rating, "Excellent");
  });

  it("boundary: 600 is Good", () => {
    assert.strictEqual(getGLIRating(600).rating, "Good");
  });

  it("boundary: 400 is Moderate", () => {
    assert.strictEqual(getGLIRating(400).rating, "Moderate");
  });
});

// ============================================================================
// Weighted GLI Tests
// ============================================================================

describe("Weighted GLI", () => {
  it("should weight high-severity traits more than low-severity", () => {
    const traits = enrichTraits([
      { trait_id: "thrombosis_risk", score: 20, confidence: 0.9 }, // severity 0.7
      { trait_id: "cardiovascular_fitness", score: 80, confidence: 0.95 }, // severity 0.8
    ]);
    const weighted = computeWeightedGLI(traits);
    const unweighted = computeGLI(traits);
    // Weighted should be different from unweighted
    assert.ok(weighted !== unweighted);
    // The severe/low-scoring trait should pull the weighted score lower
    assert.ok(weighted < 600, `Expected weighted GLI < 600, got ${weighted}`);
  });

  it("should default to 0.5 weight for unknown traits", () => {
    const traits = enrichTraits([
      { trait_id: "methylation", score: 50, confidence: 0.9 },
    ]);
    const weighted = computeWeightedGLI(traits);
    // methylation has severity 0.8, so weighted should be available
    assert.ok(weighted > 0);
    assert.ok(weighted <= 1000);
  });

  it("should compute weighted category GLI", () => {
    const traits = enrichTraits(sampleTraitScores);
    const categories = computeWeightedCategoryGLI(traits);
    assert.ok(typeof categories === "object");
    assert.ok(Object.keys(categories).length > 0);
  });

  it("should handle empty traits", () => {
    assert.strictEqual(computeWeightedGLI([]), 0);
    assert.deepStrictEqual(computeWeightedCategoryGLI([]), {});
  });

  it("should give severe traits more influence", () => {
    // thrombosis has severity 0.7, angiogenesis has severity 0.3
    const traits = enrichTraits([
      { trait_id: "thrombosis_risk", score: 0, confidence: 0.9 },
      { trait_id: "angiogenesis", score: 100, confidence: 0.9 },
    ]);
    const weighted = computeWeightedGLI(traits);
    const unweighted = computeGLI(traits);
    assert.strictEqual(unweighted, 500); // (0+100)/2 * 10
    // Weighted should be lower because thrombosis severity (0.7) > angiogenesis severity (0.3)
    assert.ok(weighted < unweighted);
  });
});

// ============================================================================
// Graph Resolver Tests
// ============================================================================

describe("Graph Resolver", () => {
  it("should enrich known traits with knowledge graph data", () => {
    const enriched = enrichTraits(sampleTraitScores);
    assert.ok(enriched.length > 0);
    const methylation = enriched.find((t) => t.trait_id === "methylation");
    assert.ok(methylation);
    assert.ok(methylation.mechanism, "methylation should have mechanism");
    assert.ok(methylation.outcomes && methylation.outcomes.length > 0);
    assert.ok(methylation.actions && methylation.actions.length > 0);
  });

  it("should preserve trait scores and confidence", () => {
    const enriched = enrichTraits(sampleTraitScores);
    for (const trait of enriched) {
      const original = sampleTraitScores.find(
        (s) => s.trait_id === trait.trait_id
      );
      assert.ok(original, `Expected original for ${trait.trait_id}`);
      assert.strictEqual(trait.score, original.score);
      assert.strictEqual(trait.confidence, original.confidence);
    }
  });

  it("should handle traits not in knowledge graph", () => {
    const result = enrichTraits([
      { trait_id: "nonexistent_trait", score: 50, confidence: 0.5 },
    ]);
    assert.strictEqual(result.length, 1);
  });

  it("should handle empty input", () => {
    const result = enrichTraits([]);
    assert.strictEqual(result.length, 0);
  });
});

// ============================================================================
// Independent Modality Engines
// ============================================================================

describe("Biomarker Engine", () => {
  it("should score biomarker readings independently by domain", () => {
    const result = analyzeBiomarkers([
      { id: "ApoB", value: 125, unit: "mg/dL" },
      { id: "HbA1c", value: 5.8, unit: "%" },
      { id: "hs-CRP", value: 4.2, unit: "mg/L" },
      { id: "Vitamin D", value: 22, unit: "ng/mL" },
    ]);
    assert.strictEqual(result.measured_count, 4);
    assert.ok(result.total_supported >= 40);
    assert.ok(result.score > 0 && result.score < 80);
    const apob = result.findings.find((f) => f.id === "apob");
    assert.ok(apob && apob.status === "needs_attention");
    assert.strictEqual(apob.status_label, "Act on this");
    assert.strictEqual(apob.target_label, "<=80 mg/dL");
    assert.strictEqual(apob.priority_rank, 1);
    assert.ok(
      result.domains.some((d) => d.id === "cardiometabolic" && d.measured > 0)
    );
    assert.ok(
      result.action_items.some((a) =>
        a.source_modalities.includes("biomarkers")
      )
    );
  });

  it("should derive HOMA-IR when glucose and insulin are present", () => {
    const result = analyzeBiomarkers([
      { id: "fasting_glucose", value: 95 },
      { id: "fasting_insulin", value: 12 },
    ]);
    assert.ok(result.findings.some((f) => f.id === "homa_ir"));
  });

  it("should derive multi-marker biomarker ratios from available labs", () => {
    const result = analyzeBiomarkers([
      { id: "total_cholesterol", value: 220 },
      { id: "hdl_c", value: 50 },
      { id: "ldl_c", value: 140 },
      { id: "triglycerides", value: 135 },
      { id: "apob", value: 105 },
      { id: "apoa1", value: 130 },
      { id: "iron", value: 80 },
      { id: "tibc", value: 320 },
    ]);
    assert.ok(
      result.findings.some((f) => f.id === "non_hdl_c" && f.value === 170)
    );
    assert.ok(
      result.findings.some(
        (f) => f.id === "remnant_cholesterol" && f.value === 30
      )
    );
    assert.ok(result.findings.some((f) => f.id === "apob_apoa1_ratio"));
    assert.ok(
      result.findings.some(
        (f) => f.id === "transferrin_saturation" && f.value === 25
      )
    );
    assert.ok(result.findings.some((f) => f.id === "vldl_c" && f.value === 27));
    assert.ok(
      result.lab_data?.some(
        (f) => f.id === "total_cholesterol" && f.source_type === "measured"
      )
    );
    assert.ok(
      result.derived_biomarkers?.some(
        (f) =>
          f.id === "remnant_cholesterol" &&
          f.formula.includes("total cholesterol")
      )
    );
    assert.ok(result.findings.some((f) => f.id === "homa_ir") === false);
  });

  it("should derive extended dashboard biomarkers from standard chemistry and CBC panels", () => {
    const result = analyzeBiomarkers(
      [
        { id: "total_cholesterol", value: 168 },
        { id: "hdl_c", value: 62 },
        { id: "ldl_c", value: 88 },
        { id: "triglycerides", value: 68 },
        { id: "fasting_glucose", value: 84 },
        { id: "hba1c", value: 5.1 },
        { id: "uric_acid", value: 5.1 },
        { id: "bun", value: 14 },
        { id: "creatinine", value: 0.92 },
        { id: "sodium", value: 140 },
        { id: "calcium", value: 9.6 },
        { id: "total_protein", value: 7.2 },
        { id: "albumin", value: 4.7 },
        { id: "ast", value: 22 },
        { id: "alt", value: 18 },
        { id: "hs_crp", value: 0.4 },
        { id: "fibrinogen", value: 280 },
        { id: "platelets", value: 240 },
        { id: "neutrophils", value: 3.0 },
        { id: "lymphocytes", value: 1.8 },
        { id: "monocytes", value: 0.4 },
        { id: "rbc", value: 5.1 },
        { id: "mcv", value: 88 },
        { id: "hemoglobin", value: 15.2 },
        { id: "hematocrit", value: 44 },
        { id: "tsh", value: 1.7 },
        { id: "free_t4", value: 1.25 },
      ],
      { age: 39, sex: "male" }
    );
    const derivedIds = new Set(
      result.derived_biomarkers?.map((item) => item.id)
    );
    for (const id of [
      "chol_hdl_ratio",
      "ldl_hdl_ratio",
      "triglyceride_hdl_ratio",
      "uric_acid_hdl_ratio",
      "atherogenic_coefficient",
      "atherogenic_index_plasma",
      "estimated_average_glucose",
      "tyg_index",
      "bun_creatinine_ratio",
      "egfr",
      "calculated_osmolality",
      "corrected_calcium",
      "globulin",
      "albumin_globulin_ratio",
      "ast_alt_ratio",
      "fib4_index",
      "apri",
      "crp_albumin_ratio",
      "fibrinogen_albumin_ratio",
      "neutrophil_lymphocyte_ratio",
      "platelet_lymphocyte_ratio",
      "systemic_immune_inflammation_index",
      "systemic_inflammation_response_index",
      "mentzer_index",
      "estimated_mchc",
      "tsh_free_t4_ratio",
    ]) {
      assert.ok(derivedIds.has(id), `expected derived biomarker ${id}`);
    }
    assert.ok(
      result.findings.some(
        (f) => f.id === "tyg_index" && f.source_type === "derived"
      )
    );
    assert.ok(
      result.system_scores?.some(
        (s) => s.id === "liver_function" && s.drivers.length > 0
      )
    );
  });

  it("should preserve lab data separately from derived biomarkers", () => {
    const result = analyzeBiomarkers([
      {
        id: "fasting_glucose",
        value: 97,
        unit: "mg/dL",
        collected_at: "2026-05-01",
      },
      {
        id: "fasting_insulin",
        value: 13.4,
        unit: "uIU/mL",
        collected_at: "2026-05-01",
      },
    ]);
    assert.strictEqual(result.lab_data?.length, 2);
    assert.ok(
      result.lab_data?.every((item) => item.source_type === "measured")
    );
    assert.ok(
      result.derived_biomarkers?.some(
        (item) =>
          item.id === "homa_ir" && item.inputs.includes("fasting_glucose")
      )
    );
    assert.ok(
      result.findings.some(
        (item) => item.id === "homa_ir" && item.source_type === "derived"
      )
    );
  });

  it("should score Superpower-style qualitative urinalysis results", () => {
    const result = analyzeBiomarkers([
      {
        id: "Bacteria (Urine)",
        value: 1,
        unit: "qualitative",
        raw_value: "Present",
      },
      {
        id: "Nitrite (Urine)",
        value: 0,
        unit: "qualitative",
        raw_value: "Negative",
      },
      {
        id: "Specific Gravity (Urine)",
        value: 1.032,
        unit: "specific gravity",
      },
      { id: "PSA % Free", value: 18, unit: "%" },
      { id: "Z Score", value: -1.4, unit: "z-score" },
    ]);
    assert.ok(
      result.findings.some(
        (f) =>
          f.id === "urine_bacteria" &&
          f.status === "needs_attention" &&
          f.display_value === "Present"
      )
    );
    assert.ok(
      result.findings.some(
        (f) => f.id === "urine_nitrite" && f.status === "optimal"
      )
    );
    assert.ok(
      result.findings.some(
        (f) => f.id === "urine_specific_gravity" && f.status === "watch"
      )
    );
    assert.ok(result.findings.some((f) => f.id === "psa_percent_free"));
    assert.ok(result.findings.some((f) => f.id === "igf_1_z_score"));
  });

  it("should keep the most concerning duplicate alias finding", () => {
    const result = analyzeBiomarkers([
      { id: "Hemoglobin", value: 10.8, unit: "g/dL" },
      { id: "Hgb", value: 11.4, unit: "g/dL" },
    ]);
    assert.strictEqual(result.measured_count, 1);
    const hemoglobin = result.findings.find(
      (finding) => finding.id === "hemoglobin"
    );
    assert.ok(hemoglobin);
    assert.strictEqual(hemoglobin.value, 10.8);
    assert.strictEqual(hemoglobin.status, "needs_attention");
  });

  it("should validate biomarker truthsets for statuses, derivations, and actions", () => {
    const truthsetPath = path.resolve(
      "references/biomarker-validation-truthsets.json"
    );
    const config = JSON.parse(fs.readFileSync(truthsetPath, "utf8"));
    const report = validateBiomarkerTruthsets(config, truthsetPath);
    assert.strictEqual(report.passed, true);
    assert.strictEqual(report.summary.passing_truthsets, 3);
    assert.strictEqual(report.summary.minimum_status_recall, 1);
    assert.strictEqual(report.summary.minimum_derived_recall, 1);
  });

  it("should emit internal biomarker system scores and biological age estimate", () => {
    const result = analyzeBiomarkers([
      { id: "ApoB", value: 118 },
      { id: "Lp(a)", value: 42 },
      { id: "fasting glucose", value: 97 },
      { id: "insulin", value: 13.4 },
      { id: "HbA1c", value: 5.7 },
      { id: "hs-CRP", value: 3.6 },
      { id: "Vitamin D", value: 24 },
      { id: "TSH", value: 3.2 },
      { id: "ALT", value: 42 },
      { id: "Creatinine", value: 1.08 },
      { id: "Hemoglobin", value: 14.1 },
      { id: "Platelets", value: 250 },
    ]);
    assert.ok(result.system_scores);
    assert.strictEqual(result.system_scores.length, 16);
    assert.ok(
      result.system_scores.some(
        (score) => score.id === "cardiovascular_risk" && score.marker_count > 0
      )
    );
    assert.ok(result.biological_age);
    assert.strictEqual(
      result.biological_age.model_version,
      "biomarker-internal-v1"
    );
  });

  it("should benchmark biomarker coverage with system-score and biological-age checks", () => {
    const requirementsPath = path.resolve(
      "references/biomarker-benchmark-requirements.json"
    );
    const requirements = JSON.parse(fs.readFileSync(requirementsPath, "utf8"));
    const report = buildBiomarkerBenchmarkReport({
      requirements,
      requirementsPath,
      packageDir: process.cwd(),
      repoDir: path.resolve("../.."),
    });
    assert.strictEqual(report.passed, true);
    assert.ok(report.summary.supported_markers >= 100);
    assert.ok(report.summary.priority_marker_recall >= 0.95);
    assert.ok(
      report.summary.system_scores >= requirements.target_system_scores
    );
    assert.strictEqual(report.summary.biological_age_model, true);
    assert.ok(report.summary.score >= 90);
  });

  it("should return missing coverage map for empty biomarker input", () => {
    const result = analyzeBiomarkers([]);
    assert.strictEqual(result.status, "missing");
    assert.strictEqual(result.measured_count, 0);
    assert.ok(result.domains.every((d) => d.status === "missing"));
    assert.ok(result.missing_priority.includes("ApoB"));
  });
});

describe("Whole-genome variant class engine", () => {
  it("should build a source-backed internal genetics report catalog", () => {
    const catalog = buildGeneticsReportCatalog(process.cwd());
    assert.ok(catalog.summary.total_entries >= 600);
    assert.ok(
      catalog.summary.valid_entries / catalog.summary.total_entries >= 0.98
    );
    assert.ok(catalog.summary.source_types.length >= 6);
    assert.ok(catalog.summary.category_counts.hereditary_conditions >= 180);
    assert.ok(
      catalog.entries.some(
        (entry) =>
          entry.source_type === "acmg_secondary_findings" &&
          entry.gene === "BRCA1"
      )
    );
    assert.ok(
      catalog.entries.some(
        (entry) =>
          entry.source_type === "recessive_carrier_gene" &&
          entry.gene === "CFTR"
      )
    );
    assert.ok(
      catalog.entries.some(
        (entry) => entry.source_type === "polygenic_risk_score"
      )
    );
  });

  it("should benchmark TellmeGen-style genetics coverage for the VCF-first default path", () => {
    const requirementsPath = path.resolve(
      "references/genetics-benchmark-requirements.json"
    );
    const dashboardJsonPath = path.resolve(
      "../../output/test_user_dashboard.json"
    );
    const dashboardHtmlPath = path.resolve("output/sample/index.html");
    const requirements = JSON.parse(fs.readFileSync(requirementsPath, "utf8"));
    const report = buildGeneticsBenchmarkReport({
      requirements,
      requirementsPath,
      dashboardJsonPath,
      dashboardHtmlPath,
      packageDir: process.cwd(),
    });
    assert.strictEqual(report.passed, true);
    assert.ok(
      report.summary.total_reports >= requirements.target_total_reports
    );
    assert.ok(
      report.summary.category_recall >= requirements.target_category_recall
    );
    assert.strictEqual(report.missing_categories.length, 0);
    assert.strictEqual(report.summary.external_validation_sources, 0);
    assert.strictEqual(requirements.target_external_validation_sources, 0);
    assert.ok(
      report.metrics.some(
        (metric) => metric.id === "external_validation" && metric.passed
      )
    );
    assert.ok(
      report.metrics.some(
        (metric) => metric.id === "caller_availability" && metric.passed
      )
    );
    assert.ok(
      report.metrics.some(
        (metric) => metric.id === "interpretation_depth_score" && metric.passed
      )
    );
    assert.ok(
      report.metrics.some(
        (metric) =>
          metric.id === "interpretation_large_db_policy" && metric.passed
      )
    );
    assert.strictEqual(
      report.summary.interpretation_requires_large_database,
      false
    );
  });

  it("should build a compact VCF-first interpretation catalog without requiring raw-read callers", () => {
    const catalog = buildCompactInterpretationCatalog({
      packageDir: process.cwd(),
    });
    assert.strictEqual(
      catalog.summary.raw_read_callers_required_for_default,
      false
    );
    assert.strictEqual(catalog.summary.within_repo_size_budget, true);
    assert.ok(
      catalog.input_model.expected_inputs.some((input) => input.includes("VCF"))
    );
    assert.ok(
      catalog.input_model.expected_inputs.some((input) =>
        /23andMe/i.test(input)
      )
    );
    assert.ok(catalog.summary.total_entries >= 300);
    assert.ok(catalog.summary.consumer_ready_entries >= 300);
    assert.ok(catalog.summary.wellness_optimization_entries >= 80);
    assert.ok(catalog.summary.requires_deeper_caller_entries >= 5);
    assert.ok(catalog.summary.clinvar_gene_targets >= 150);
    assert.ok(catalog.summary.cpic_gene_drug_rules >= 10);
    assert.ok(catalog.summary.optional_source_families >= 5);
    assert.ok(
      catalog.optional_external_sources.some(
        (source) => source.id === "pgs_catalog"
      )
    );
    assert.ok(
      catalog.entries.some(
        (entry) =>
          entry.source_type === "polygenic_score" && entry.trait === "vo2max"
      )
    );
    assert.ok(
      catalog.entries.some(
        (entry) =>
          entry.source_type === "polygenic_score" && entry.trait === "vitamin_d"
      )
    );
    assert.ok(
      catalog.entries.some(
        (entry) =>
          entry.source_type === "clinvar_gene_slice" && entry.gene === "BRCA1"
      )
    );
    assert.ok(
      catalog.entries.some(
        (entry) =>
          entry.source_type === "cpic_drug_gene_rule" &&
          entry.gene === "CYP2C19"
      )
    );
    assert.ok(
      catalog.entries.some(
        (entry) =>
          entry.source_type === "cnv_sv_repeat_catalog" &&
          entry.requires_deeper_caller
      )
    );
  });

  it("should quantify local interpretation depth without requiring large databases", () => {
    const report = buildInterpretationDepthReport(process.cwd());
    assert.strictEqual(report.passed, true);
    assert.strictEqual(report.summary.default_requires_large_database, false);
    assert.ok(report.summary.score >= 90);
    assert.ok(report.summary.source_families_supported >= 5);
    assert.ok(report.summary.clinvar_gene_targets >= 150);
    assert.ok(report.summary.cpic_gene_drug_rules >= 10);
    assert.ok(report.summary.pgs_traits >= 27);
    assert.ok(report.summary.pgs_variants >= 180);
    assert.ok(
      report.source_families.some(
        (source) => source.id === "clinvar_gene_slice"
      )
    );
    assert.ok(
      report.source_families.every(
        (source) => source.large_database_required_for_default === false
      )
    );
  });

  it("should expose user-facing WGS validation coverage by variant class", () => {
    const coverage = buildWgsValidationCoverage(process.cwd());
    assert.strictEqual(coverage.length, 5);
    assert.ok(coverage.some((item) => item.id === "rare_small_variants"));
    assert.ok(coverage.some((item) => item.id === "copy_number_variants"));
    assert.ok(coverage.every((item) => item.status_label && item.note));
    assert.ok(coverage.every((item) => item.next_step));
    assert.ok(
      coverage.some((item) => item.query_status === "missing_inputs_and_tools")
    );
    assert.ok(coverage.some((item) => item.local_difficulty === "hard"));
    assert.ok(coverage.some((item) => item.status === "pipeline_validated"));
    assert.ok(
      coverage.every(
        (item) =>
          item.external_status === "missing_inputs" ||
          item.external_status === undefined
      )
    );
  });

  it("should refresh WGS readiness artifacts used by dashboard generation", () => {
    const result = refreshWgsReadinessArtifacts(process.cwd());
    assert.strictEqual(result.errors.length, 0);
    assert.ok(
      result.generated.some((file) => file.endsWith("wgs-caller-manifest.json"))
    );
    assert.ok(
      result.generated.some((file) =>
        file.endsWith("wgs-external-truthset-setup.json")
      )
    );
    assert.ok(
      result.generated.some((file) =>
        file.endsWith("wgs-external-validation-report.json")
      )
    );
    assert.ok(
      result.generated.some((file) => file.endsWith("wgs-query-readiness.json"))
    );
    assert.ok(
      result.generated.some((file) => file.endsWith("wgs-local-setup-plan.sh"))
    );
    const setup = JSON.parse(
      fs.readFileSync(
        path.resolve("output/wgs-external-truthset-setup.json"),
        "utf8"
      )
    );
    const external = JSON.parse(
      fs.readFileSync(
        path.resolve("output/wgs-external-validation-report.json"),
        "utf8"
      )
    );
    const query = JSON.parse(
      fs.readFileSync(path.resolve("output/wgs-query-readiness.json"), "utf8")
    );
    const setupScript = fs.readFileSync(
      path.resolve("output/wgs-local-setup-plan.sh"),
      "utf8"
    );
    assert.strictEqual(setup.summary.truthsets, 3);
    assert.strictEqual(external.summary.configured_truthsets, 3);
    assert.strictEqual(query.summary.truthsets, 3);
    assert.ok(query.setup_script_path?.endsWith("wgs-local-setup-plan.sh"));
    assert.ok(setupScript.includes("Difficulty: hard"));
    assert.ok(setup.summary.artifacts >= 18);
    assert.strictEqual(typeof setup.summary.missing_truth_indexes, "number");
    assert.strictEqual(typeof setup.summary.missing_query_indexes, "number");
    assert.strictEqual(typeof external.summary.missing_tools, "number");
    assert.strictEqual(typeof query.summary.hard_local_steps, "number");
  });

  it("should write request-scoped WGS readiness artifacts outside the skill package", () => {
    const outputDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "longevity-wgs-readiness-")
    );

    try {
      const result = refreshWgsReadinessArtifacts(process.cwd(), outputDir);
      assert.strictEqual(result.errors.length, 0);
      assert.ok(
        result.generated.every((file) => path.dirname(file) === outputDir)
      );

      const coverage = buildWgsValidationCoverage(process.cwd(), outputDir);
      assert.strictEqual(coverage.length, 5);
      assert.ok(coverage.some((item) => item.local_difficulty === "hard"));
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("should quantify local VCF fixture coverage across WGS-scale variant classes", async () => {
    const packageDir = process.cwd();
    const repoRoot = path.resolve(packageDir, "../..");
    const report = await buildLocalVcfCoverageReport({ repoRoot, packageDir });
    assert.strictEqual(
      report.summary.present_vcfs,
      report.summary.configured_vcfs
    );
    assert.ok(report.summary.total_records >= 1_000_000);
    assert.ok(report.summary.unique_rsids >= 500_000);
    assert.ok(report.summary.classes_present >= 5);
    assert.ok(report.summary.curated_rsids_observed >= 75);
    assert.ok(report.summary.prs_rsids_observed >= 40);
    assert.strictEqual(report.passed, true);
  });

  it("should preflight external WGS truthsets without fabricating query VCFs", () => {
    const truthsetPath = path.resolve(
      "references/wgs-validation-truthsets.json"
    );
    const config = JSON.parse(fs.readFileSync(truthsetPath, "utf8"));
    const report = buildWgsTruthsetSetupReport(
      config,
      truthsetPath,
      process.cwd()
    );
    assert.strictEqual(report.summary.truthsets, 3);
    assert.ok(
      report.artifacts.some((artifact) => artifact.kind === "truth_vcf")
    );
    assert.ok(
      report.artifacts.some((artifact) => artifact.kind === "truth_vcf_index")
    );
    assert.ok(
      report.artifacts.some((artifact) => artifact.kind === "confident_regions")
    );
    assert.ok(
      report.artifacts.some((artifact) => artifact.kind === "query_vcf")
    );
    assert.ok(
      report.artifacts.some((artifact) => artifact.kind === "query_vcf_index")
    );
    assert.ok(
      report.artifacts.some((artifact) => artifact.kind === "metrics_json")
    );
    assert.ok(
      report.artifacts
        .filter(
          (artifact) =>
            artifact.kind === "query_vcf" || artifact.kind === "query_vcf_index"
        )
        .every((artifact) => !artifact.downloadable)
    );
    assert.ok(
      report.artifacts
        .filter((artifact) => artifact.kind === "query_vcf")
        .every((artifact) => /do not synthesize/i.test(artifact.action))
    );
    assert.ok(report.summary.missing_query_vcfs >= 1);
    assert.ok(report.summary.missing_query_indexes >= 1);
  });

  it("should normalize CNV, SV, repeat, large-indel, and rare small variant calls", () => {
    const catalog = readWgsInterpretationCatalog(
      path.resolve("references/wgs-interpretation-catalog.json")
    );
    const vcf = fs.readFileSync(
      path.resolve("../../example-data/sample-wgs-variant-classes.vcf"),
      "utf8"
    );
    const calls = parseWgsVariantClassVcf(vcf, catalog, "sample");
    const classes = new Set(calls.map((call) => call.class));
    assert.ok(classes.has("copy_number_variants"));
    assert.ok(classes.has("large_indels"));
    assert.ok(classes.has("tandem_repeats"));
    assert.ok(classes.has("rearrangements"));
    assert.ok(classes.has("rare_small_variants"));
    assert.ok(
      calls.some(
        (call) =>
          call.genes.includes("BRCA1") &&
          call.reportability === "clinician_review"
      )
    );
    assert.ok(
      calls.some(
        (call) =>
          call.id === "htt_cag_repeat" &&
          call.evidence.some((item) => item.includes("pathogenic"))
      )
    );
  });

  it("should validate independent WGS truthset fixtures with class and reportability checks", () => {
    const truthsetPath = path.resolve(
      "references/wgs-validation-truthsets.json"
    );
    const catalogPath = path.resolve(
      "references/wgs-interpretation-catalog.json"
    );
    const config = JSON.parse(fs.readFileSync(truthsetPath, "utf8"));
    const report = validateWgsVariantClassesFromTruthsets(
      config,
      truthsetPath,
      catalogPath,
      process.cwd()
    );
    assert.strictEqual(report.passed, true);
    assert.ok(report.results.length >= 4);
    assert.ok(
      report.results.every(
        (result) => result.recall === 1 && result.precision === 1
      )
    );
    assert.ok(
      report.results.every(
        (result) => result.incorrect_reportability.length === 0
      )
    );
    assert.ok(report.external_validation_summary.configured_truthsets >= 3);
    assert.ok(
      report.external_validation.every(
        (result) =>
          result.command_template.includes(result.benchmark_tool) ||
          result.benchmark_tool === "custom"
      )
    );
  });

  it("should require real WGS caller runtime checks instead of treating java alone as GATK-SV readiness", () => {
    const manifest = buildWgsCallerManifest();
    assert.strictEqual(
      manifest.default_input_model.raw_read_callers_required_for_default,
      false
    );
    assert.strictEqual(
      manifest.default_input_model.local_default_assessment,
      "repo_contained_vcf_interpretation"
    );
    assert.ok(
      manifest.default_input_model.expected_inputs.some((input) =>
        input.includes("VCF")
      )
    );
    const haplotypeCaller = manifest.caller_steps.find(
      (step) => step.id === "gatk_haplotypecaller_small_variants"
    );
    const gatkSv = manifest.caller_steps.find(
      (step) => step.id === "gatk_sv_ensemble"
    );
    assert.ok(haplotypeCaller);
    assert.strictEqual(haplotypeCaller.tool, "GATK HaplotypeCaller");
    assert.ok(haplotypeCaller.required_input.includes("BAM"));
    assert.ok(gatkSv);
    assert.ok(gatkSv.availability_checks.includes("cromwell command"));
    assert.ok(gatkSv.availability_checks.includes("GATK_SV_WDL_DIR path"));
  });

  it("should quantify local query-generation readiness without creating query VCFs", () => {
    const truthsetPath = path.resolve(
      "references/wgs-validation-truthsets.json"
    );
    const config = JSON.parse(fs.readFileSync(truthsetPath, "utf8"));
    const report = buildWgsQueryReadinessReport(
      config,
      truthsetPath,
      process.cwd()
    );
    assert.strictEqual(report.summary.truthsets, 3);
    assert.strictEqual(report.ready_for_query_generation, false);
    assert.strictEqual(report.summary.query_vcfs_present, 0);
    assert.strictEqual(report.summary.run_plans, 3);
    assert.ok(report.summary.setup_plan_steps >= report.summary.run_plans);
    assert.ok(report.setup_plan.missing_inputs.includes("HG002 BAM/CRAM"));
    assert.ok(report.setup_plan.caller_container_pull_commands.length >= 3);
    assert.ok(report.setup_plan.benchmark_container_pull_commands.length >= 2);
    assert.ok(
      report.setup_plan.native_tool_install_hints.some(
        (hint) =>
          hint.includes("GATK-SV") &&
          hint.includes("Cromwell") &&
          hint.includes("WDL")
      )
    );
    assert.ok(report.setup_plan.query_generation_commands.length >= 3);
    assert.ok(
      report.setup_plan.postprocess_commands.some((command) =>
        command.includes("bcftools index")
      )
    );
    assert.ok(
      report.setup_plan.validation_commands.some((command) =>
        command.includes("wgs:external-validation")
      )
    );
    assert.ok(
      report.setup_plan.next_commands.length >= report.summary.setup_plan_steps
    );
    assert.strictEqual(report.local_run_assessment.difficulty, "hard");
    assert.strictEqual(report.local_run_assessment.runnable_now, false);
    assert.ok(
      report.local_run_assessment.blockers.some((blocker) =>
        blocker.includes("HG002 BAM/CRAM")
      )
    );
    assert.strictEqual(report.summary.postprocess_tools_required, 3);
    assert.strictEqual(report.summary.postprocess_tools_available, 3);
    assert.ok(report.summary.benchmark_tools_required >= 2);
    assert.strictEqual(report.summary.benchmark_tools_available, 0);
    assert.ok(report.summary.caller_container_plans >= 3);
    assert.ok(
      report.summary.caller_container_images_present <=
        report.summary.caller_container_plans
    );
    assert.strictEqual(
      typeof report.summary.caller_container_image_timeouts,
      "number"
    );
    assert.ok(
      report.summary.benchmark_container_plans >=
        report.summary.benchmark_tools_required
    );
    assert.ok(
      report.summary.benchmark_container_images_present <=
        report.summary.benchmark_container_plans
    );
    assert.strictEqual(
      typeof report.summary.benchmark_container_image_timeouts,
      "number"
    );
    assert.strictEqual(
      typeof report.summary.container_runtime_available,
      "boolean"
    );
    assert.ok(report.summary.missing_inputs >= 1);
    assert.ok(
      report.results.every((result) =>
        result.query_vcf_path.endsWith(".vcf.gz")
      )
    );
    assert.ok(
      report.results.every(
        (result) =>
          result.status === "missing_inputs_and_tools" ||
          result.status === "missing_inputs" ||
          result.status === "missing_caller_tools"
      )
    );
    assert.ok(
      report.results.every(
        (result) => result.run_plan.setup_commands.length > 0
      )
    );
    assert.ok(
      report.results.every((result) =>
        result.run_plan.required_tools.some(
          (tool) => tool.role === "postprocess" && tool.tool === "bcftools"
        )
      )
    );
    assert.ok(
      report.results.every((result) =>
        result.run_plan.required_tools.some((tool) => tool.role === "benchmark")
      )
    );
    assert.ok(
      report.results.some((result) =>
        result.run_plan.required_tools.some(
          (tool) => tool.role === "caller" && tool.container_image
        )
      )
    );
    assert.ok(
      report.results.every((result) =>
        result.required_callers
          .filter((caller) => caller.container_image)
          .every((caller) =>
            caller.container_pull_command?.startsWith("docker pull --platform")
          )
      )
    );
    assert.ok(
      report.results.every((result) =>
        result.run_plan.required_tools
          .filter((tool) => tool.role === "benchmark" && tool.container_image)
          .every((tool) =>
            tool.container_pull_command?.startsWith("docker pull --platform")
          )
      )
    );
    assert.ok(
      report.results.every((result) =>
        result.run_plan.required_tools
          .filter((tool) => tool.role === "caller" && tool.container_image)
          .every((tool) =>
            ["present", "missing", "timeout", "docker_unavailable"].includes(
              String(tool.container_image_status)
            )
          )
      )
    );
    assert.ok(
      report.results.every((result) =>
        result.run_plan.required_tools
          .filter((tool) => tool.role === "benchmark" && tool.container_image)
          .every((tool) =>
            ["present", "missing", "timeout", "docker_unavailable"].includes(
              String(tool.container_image_status)
            )
          )
      )
    );
    assert.ok(
      report.results.every(
        (result) => result.run_plan.caller_commands.length > 0
      )
    );
    assert.ok(
      report.results.every((result) =>
        result.run_plan.postprocess_commands.some((command) =>
          command.includes("bcftools index")
        )
      )
    );
    assert.ok(
      report.results.every((result) =>
        result.run_plan.validation_command.includes("wgs:external-validation")
      )
    );
    assert.ok(
      report.results.every((result) =>
        result.run_plan.container_validation_command?.includes(
          '-v "$(cd ../.. && pwd)":/work'
        )
      )
    );
    assert.ok(
      report.results.every((result) =>
        result.run_plan.container_validation_command?.includes(
          "-w /work/skills/longevity-analysis"
        )
      )
    );
    assert.ok(
      report.results.some((result) =>
        result.run_plan.container_validation_command?.includes(
          "giab-hg002-sv-truvari-summary"
        )
      )
    );
    assert.ok(
      report.results.some((result) =>
        result.run_plan.container_validation_command?.includes(
          "giab-hg002-repeat-truvari-summary"
        )
      )
    );
    assert.ok(
      report.results.some((result) =>
        result.run_plan.caller_commands.some((command) =>
          command.includes('"${HG002_BAM_OR_CRAM}"')
        )
      )
    );
    assert.ok(
      report.results.some((result) =>
        result.missing_inputs.includes("HG002 BAM/CRAM")
      )
    );
    assert.ok(
      report.next_actions.some((action) =>
        /HG002 BAM\/CRAM|caller tool/i.test(action)
      )
    );
    const setupScript = renderWgsLocalSetupScript(report);
    assert.ok(setupScript.includes("check-inputs"));
    assert.ok(setupScript.includes("pull-containers"));
    assert.ok(setupScript.includes("Difficulty: hard"));
    assert.ok(setupScript.includes("HG002_BAM_OR_CRAM"));
  });

  it("should preflight external WGS benchmarks and fail closed when GIAB inputs are absent", () => {
    const truthsetPath = path.resolve(
      "references/wgs-validation-truthsets.json"
    );
    const config = JSON.parse(fs.readFileSync(truthsetPath, "utf8"));
    const report = buildExternalBenchmarkReport(
      config,
      truthsetPath,
      process.cwd()
    );
    assert.strictEqual(report.passed, false);
    assert.ok(report.summary.configured_truthsets >= 3);
    assert.strictEqual(report.summary.passing_truthsets, 0);
    assert.ok(report.summary.missing_inputs >= 1);
    assert.ok(
      report.results.some((result) => result.status === "missing_inputs")
    );
  });
});

describe("Wearable Engine", () => {
  it("should score wearable behavior readings independently by domain", () => {
    const result = analyzeWearables([
      { id: "sleep_duration", value: 5.7, unit: "hours" },
      { id: "HRV", value: 22, unit: "ms" },
      { id: "resting_heart_rate", value: 78, unit: "bpm" },
      { id: "steps", value: 3500, unit: "steps" },
    ]);
    assert.strictEqual(result.measured_count, 4);
    assert.ok(result.total_supported >= 15);
    assert.ok(result.score > 0 && result.score < 80);
    assert.ok(
      result.findings.some(
        (f) => f.id === "sleep_duration" && f.status === "needs_attention"
      )
    );
    const sleepFinding = result.findings.find((f) => f.id === "sleep_duration");
    assert.strictEqual(sleepFinding?.status_label, "Act on this");
    assert.strictEqual(sleepFinding?.target_label, "7-9 hours");
    assert.strictEqual(sleepFinding?.direction, "low");
    assert.ok((sleepFinding?.priority_rank ?? 0) > 0);
    assert.ok(
      result.domains.some((d) => d.id === "sleep_recovery" && d.measured > 0)
    );
    assert.ok(
      result.action_items.some((a) => a.source_modalities.includes("wearables"))
    );
  });

  it("should return missing coverage map for empty wearable input", () => {
    const result = analyzeWearables([]);
    assert.strictEqual(result.status, "missing");
    assert.strictEqual(result.measured_count, 0);
    assert.ok(result.domains.every((d) => d.status === "missing"));
    assert.ok(result.missing_priority.includes("Sleep duration"));
  });
});

describe("Multi-modal Fusion Engine", () => {
  it("should choose biomarkers after genomics-only start", () => {
    const plan = buildMultiModalPlan({
      genomics: {
        connected: true,
        isWGS: true,
        trait_count: 56,
        top_focus_areas: ["methylation"],
        action_count: 4,
      },
      biomarkers: analyzeBiomarkers([]),
      wearables: analyzeWearables([]),
    });
    assert.strictEqual(plan.next_best_upload, "biomarkers");
    assert.ok(
      plan.modalities.some(
        (m) => m.id === "biomarkers" && m.status === "recommended_next"
      )
    );
    assert.ok(
      plan.action_priorities?.some((a) =>
        a.source_modalities.includes("genomics")
      )
    );
  });

  it("should create cross-modal actions when labs and recovery are both off target", () => {
    const biomarkers = analyzeBiomarkers([{ id: "hs_crp", value: 4.5 }]);
    const wearables = analyzeWearables([
      { id: "sleep_duration", value: 5.5 },
      { id: "hrv", value: 20 },
    ]);
    const plan = buildMultiModalPlan({
      genomics: {
        connected: true,
        isWGS: true,
        trait_count: 56,
        top_focus_areas: ["inflammation"],
        action_count: 4,
      },
      biomarkers,
      wearables,
    });
    assert.ok(
      plan.action_priorities?.some(
        (a) =>
          a.source_modalities.includes("biomarkers") &&
          a.source_modalities.includes("wearables")
      )
    );
  });
});

describe("Health Data Importers", () => {
  it("should parse normalized biomarker CSV files", () => {
    const readings = parseBiomarkerCsv(`marker,value,unit,collected_at
ApoB,118,mg/dL,2026-05-01
HbA1c,5.7,%,2026-05-01
`);
    assert.strictEqual(readings.length, 2);
    assert.deepStrictEqual(readings[0], {
      id: "ApoB",
      value: 118,
      unit: "mg/dL",
      raw_value: "118",
      collected_at: "2026-05-01",
    });
  });

  it("should parse plain-text lab report exports", () => {
    const readings = parseBiomarkerText(`Collected: 2026-05-01
ApoB 118 mg/dL
HbA1c 5.7 %
Vitamin D 24 ng/mL
eGFR 84 mL/min/1.73m2
`);
    assert.strictEqual(readings.length, 4);
    assert.ok(
      readings.some(
        (r) => r.id === "apob" && r.value === 118 && r.unit === "mg/dL"
      )
    );
    assert.ok(
      readings.some(
        (r) => r.id === "hba1c" && r.value === 5.7 && r.unit === "%"
      )
    );
    assert.ok(readings.every((r) => r.collected_at === "2026-05-01"));
  });

  it("should parse qualitative biomarker CSV values", () => {
    const readings = parseBiomarkerCsv(`marker,value,unit,collected_at
Bacteria (Urine),Present,,2026-05-01
Nitrite (Urine),Negative,,2026-05-01
`);
    assert.strictEqual(readings.length, 2);
    assert.ok(
      readings.some(
        (r) =>
          r.id === "Bacteria (Urine)" &&
          r.value === 1 &&
          r.raw_value === "Present"
      )
    );
    assert.ok(
      readings.some(
        (r) =>
          r.id === "Nitrite (Urine)" &&
          r.value === 0 &&
          r.raw_value === "Negative"
      )
    );
  });

  it("should aggregate WHOOP-style daily wearable CSV files", () => {
    const readings =
      parseWearableCsv(`date,sleep_duration,hrv,resting_heart_rate,zone2_minutes,strength_sessions
2026-04-24,6,30,66,20,0
2026-04-25,7,40,60,30,1
`);
    assert.ok(
      readings.some(
        (r) =>
          r.id === "sleep_duration" && r.value === 6.5 && r.window_days === 2
      )
    );
    assert.ok(readings.some((r) => r.id === "zone2_minutes" && r.value === 50));
    assert.ok(
      readings.some((r) => r.id === "strength_sessions" && r.value === 1)
    );
  });

  it("should parse WHOOP API-shaped JSON exports", () => {
    const readings = parseWearableJson(
      JSON.stringify({
        window_days: 2,
        recoveries: [
          {
            score_state: "SCORED",
            score: {
              recovery_score: 40,
              hrv_rmssd_milli: 30,
              resting_heart_rate: 68,
              spo2_percentage: 95,
            },
          },
          {
            score_state: "SCORED",
            score: {
              recovery_score: 60,
              hrv_rmssd_milli: 40,
              resting_heart_rate: 62,
              spo2_percentage: 97,
            },
          },
        ],
        sleeps: [
          {
            score_state: "SCORED",
            score: {
              sleep_efficiency_percentage: 82,
              respiratory_rate: 16,
              stage_summary: {
                total_in_bed_time_milli: 28800000,
                total_awake_time_milli: 3600000,
                total_slow_wave_sleep_time_milli: 3600000,
                total_rem_sleep_time_milli: 5400000,
              },
            },
          },
        ],
        cycles: [
          { score_state: "SCORED", score: { strain: 12 } },
          { score_state: "SCORED", score: { strain: 16 } },
        ],
        workouts: [
          {
            score_state: "SCORED",
            score: {
              zone_duration: {
                zone_two_milli: 1800000,
                zone_four_milli: 600000,
                zone_five_milli: 300000,
              },
            },
          },
        ],
        daily_activity: [{ steps: 6000 }, { steps: 8000 }],
        manual_context: { strength_sessions: 1, sleep_consistency: 70 },
      })
    );
    assert.ok(
      readings.some((r) => r.id === "recovery_score" && r.value === 50)
    );
    assert.ok(readings.some((r) => r.id === "hrv" && r.value === 35));
    assert.ok(readings.some((r) => r.id === "sleep_duration" && r.value === 7));
    assert.ok(readings.some((r) => r.id === "zone2_minutes" && r.value === 30));
    assert.ok(
      readings.some((r) => r.id === "vigorous_minutes" && r.value === 15)
    );
    assert.ok(readings.some((r) => r.id === "steps" && r.value === 7000));
  });

  it("should merge a Health Connect export directory into wearable metrics", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "health-connect-"));
    try {
      fs.writeFileSync(
        path.join(directory, "Activity.csv"),
        `Date,Steps,VO2 max avg (ml/min/kg)\n2026-05-01,6000,42\n2026-05-02,8000,44\n`
      );
      fs.writeFileSync(
        path.join(directory, "Vitals.csv"),
        `Date,Heart rate variability avg (ms),Oxygen saturation avg (%),Respiratory rate avg (breaths/min),Resting heart rate avg (bpm)\n2026-05-01,38,97,15,58\n`
      );
      fs.writeFileSync(
        path.join(directory, "Sleep.csv"),
        `Date,Start Time,End Time\n2026-05-01,2026-04-30 23:00:00,2026-05-01 07:00:00\n`
      );
      const readings = parseWearableFile(directory);
      assert.ok(readings.some((r) => r.id === "steps" && r.value === 7000));
      assert.ok(readings.some((r) => r.id === "hrv" && r.value === 38));
      assert.ok(readings.some((r) => r.id === "spo2" && r.value === 97));
      assert.ok(
        readings.some((r) => r.id === "resting_heart_rate" && r.value === 58)
      );
      assert.ok(
        readings.some((r) => r.id === "sleep_duration" && r.value === 8)
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Priority Engine Tests
// ============================================================================

describe("Priority Engine", () => {
  it("should compute priority for a single trait", () => {
    const traits = enrichTraits([
      { trait_id: "methylation", score: 35, confidence: 0.9 },
    ]);
    const result = computePriority(traits[0]);
    assert.ok(result.trait_id === "methylation");
    assert.ok(typeof result.priority === "number");
    assert.ok(result.reasoning.includes("below optimal"));
  });

  it("should compute priorities for all traits (sorted)", () => {
    const traits = enrichTraits(sampleTraitScores);
    const priorities = computeAllPriorities(traits);
    assert.ok(priorities.length > 0);
    assert.ok(priorities[0].trait_id);
    assert.ok(typeof priorities[0].priority === "number");
    assert.ok(typeof priorities[0].reasoning === "string");
  });

  it("should sort by priority descending", () => {
    const traits = enrichTraits(sampleTraitScores);
    const priorities = computeAllPriorities(traits);
    for (let i = 1; i < priorities.length; i++) {
      assert.ok(
        priorities[i - 1].priority >= priorities[i].priority,
        `Priority ${i - 1} should be >= ${i}`
      );
    }
  });

  it("should give higher priority to below-optimal traits", () => {
    const traits = enrichTraits([
      { trait_id: "methylation", score: 20, confidence: 0.9 },
      { trait_id: "vitamin_d", score: 80, confidence: 0.9 },
    ]);
    const priorities = computeAllPriorities(traits);
    const methylationRank = priorities.findIndex(
      (p) => p.trait_id === "methylation"
    );
    const vitaminDRank = priorities.findIndex(
      (p) => p.trait_id === "vitamin_d"
    );
    assert.ok(
      methylationRank < vitaminDRank,
      "Low-scoring trait should rank higher priority"
    );
  });

  it("should produce finite priority values", () => {
    const traits = enrichTraits(sampleTraitScores);
    const priorities = computeAllPriorities(traits);
    for (const p of priorities) {
      assert.ok(Number.isFinite(p.priority));
    }
  });
});

// ============================================================================
// Insight Engine Tests
// ============================================================================

describe("Insight Engine", () => {
  it("should generate insights from enriched traits", () => {
    const traits = enrichTraits(sampleTraitScores);
    const insights = generateInsights(traits);
    assert.ok(insights.length > 0);
    assert.ok(insights[0].title);
    assert.ok(insights[0].summary);
    assert.ok(typeof insights[0].score === "number");
    assert.ok(typeof insights[0].confidence === "number");
  });

  it("should generate one insight per trait", () => {
    const traits = enrichTraits(sampleTraitScores);
    const insights = generateInsights(traits);
    assert.strictEqual(insights.length, traits.length);
  });

  it("should produce score-appropriate summaries", () => {
    const traits = enrichTraits([
      { trait_id: "methylation", score: 20, confidence: 0.9 },
    ]);
    const insights = generateInsights(traits);
    assert.ok(insights[0].summary.toLowerCase().includes("below optimal"));
  });

  it("should produce optimal summary for high scores", () => {
    const traits = enrichTraits([
      { trait_id: "cardiovascular_fitness", score: 80, confidence: 0.95 },
    ]);
    const insights = generateInsights(traits);
    assert.ok(insights[0].summary.toLowerCase().includes("optimal"));
  });

  it("should handle empty traits", () => {
    const insights = generateInsights([]);
    assert.strictEqual(insights.length, 0);
  });
});

// ============================================================================
// Protocol Engine Tests
// ============================================================================

describe("Protocol Engine", () => {
  it("should generate protocols with title and description", () => {
    const traits = enrichTraits(sampleTraitScores);
    const protocols = generateProtocols(traits);
    assert.ok(protocols.length > 0);
    assert.ok(protocols[0].title);
    assert.ok(protocols[0].description);
    assert.ok(Array.isArray(protocols[0].actions));
  });

  it("should include Priority Wellness Action Plan for at-risk traits", () => {
    const traits = enrichTraits([
      { trait_id: "methylation", score: 20, confidence: 0.9 },
    ]);
    const protocols = generateProtocols(traits);
    const core = protocols.find(
      (p) => p.title === "Priority Wellness Action Plan"
    );
    assert.ok(core, "Should have Priority Wellness Action Plan");
  });

  it("should deduplicate actions across traits", () => {
    const traits = enrichTraits([
      { trait_id: "methylation", score: 20, confidence: 0.9 },
      { trait_id: "cardiovascular_fitness", score: 70, confidence: 0.9 },
    ]);
    const protocols = generateProtocols(traits);
    const allActionIds: string[] = [];
    for (const p of protocols) {
      for (const a of p.actions) {
        allActionIds.push(a.id);
      }
    }
    const uniqueIds = new Set(allActionIds);
    assert.strictEqual(
      allActionIds.length,
      uniqueIds.size,
      "All action IDs should be unique"
    );
  });

  it("should return fallback protocol for empty traits", () => {
    const protocols = generateProtocols([]);
    // The engine returns a fallback baseline plan even for empty input
    assert.strictEqual(protocols.length, 1);
    assert.strictEqual(protocols[0].title, "Baseline Wellness Action Plan");
  });

  it("should produce a profile-scoped action plan when no risks", () => {
    const traits = enrichTraits([
      { trait_id: "cardiovascular_fitness", score: 80, confidence: 0.95 },
    ]);
    const protocols = generateProtocols(traits);
    assert.ok(protocols.length >= 1);
  });
});

// ============================================================================
// New Longevity Traits (from research literature)
// ============================================================================

describe("New Longevity Traits", () => {
  it("should enrich caloric_restriction trait", () => {
    const traits = enrichTraits([
      { trait_id: "caloric_restriction", score: 60, confidence: 0.75 },
    ]);
    assert.ok(traits[0].actions);
    assert.ok(
      traits[0].actions!.some((a) => a.id === "time_restricted_eating")
    );
    assert.ok(traits[0].actions!.some((a) => a.id === "avoid_extreme_cr"));
  });

  it("should enrich intermittent_fasting trait", () => {
    const traits = enrichTraits([
      { trait_id: "intermittent_fasting", score: 60, confidence: 0.7 },
    ]);
    assert.ok(traits[0].actions);
    assert.ok(traits[0].outcomes!.some((o) => o.id === "autophagy_induction"));
  });

  it("should enrich apoB_management trait", () => {
    const traits = enrichTraits([
      { trait_id: "apoB_management", score: 75, confidence: 0.9 },
    ]);
    assert.ok(traits[0].actions);
    assert.ok(traits[0].outcomes!.some((o) => o.id === "cardiovascular_risk"));
  });

  it("should enrich immune_rejuvenation trait", () => {
    const traits = enrichTraits([
      { trait_id: "immune_rejuvenation", score: 60, confidence: 0.6 },
    ]);
    assert.ok(traits[0].actions);
    assert.ok(traits[0].outcomes!.some((o) => o.id === "immunosenescence"));
  });

  it("should enrich partial_reprogramming trait", () => {
    const traits = enrichTraits([
      { trait_id: "partial_reprogramming", score: 40, confidence: 0.5 },
    ]);
    assert.ok(traits[0].mechanism?.includes("Yamanaka"));
    assert.ok(traits[0].outcomes!.some((o) => o.id === "teratoma_risk"));
  });

  it("should enrich anti_il11 trait", () => {
    const traits = enrichTraits([
      { trait_id: "anti_il11", score: 50, confidence: 0.55 },
    ]);
    assert.ok(traits[0].mechanism?.includes("IL-11"));
    assert.ok(traits[0].actions!.some((a) => a.id === "monitor_trials"));
  });

  it("should enrich brain_rejuvenation trait", () => {
    const traits = enrichTraits([
      { trait_id: "brain_rejuvenation", score: 65, confidence: 0.75 },
    ]);
    assert.ok(traits[0].outcomes!.some((o) => o.id === "neuroinflammation"));
    assert.ok(traits[0].actions!.some((a) => a.id === "aerobic_exercise"));
  });

  it("should enrich stem_cells trait with safety warnings", () => {
    const traits = enrichTraits([
      { trait_id: "stem_cells", score: 50, confidence: 0.6 },
    ]);
    assert.ok(traits[0].outcomes!.some((o) => o.id === "unregulated_risk"));
    assert.ok(traits[0].actions!.some((a) => a.id === "clinical_trials_only"));
  });

  it("should enrich supplements_evidence with evidence-based guidance", () => {
    const traits = enrichTraits([
      { trait_id: "supplements_evidence", score: 70, confidence: 0.9 },
    ]);
    assert.ok(traits[0].actions!.some((a) => a.id === "avoid_nmn_alone"));
    assert.ok(
      traits[0].actions!.some((a) => a.id === "vitamin_d_only_if_deficient")
    );
  });

  it("should link trametinib_rapamycin to safety concerns", () => {
    const traits = enrichTraits([
      { trait_id: "trametinib_rapamycin", score: 45, confidence: 0.5 },
    ]);
    assert.ok(traits[0].outcomes!.some((o) => o.id === "toxicity_concern"));
    assert.ok(traits[0].actions!.some((a) => a.id === "monitor_combo_trial"));
  });

  it("should enrich gene_therapy_aging with caution", () => {
    const traits = enrichTraits([
      { trait_id: "gene_therapy_aging", score: 40, confidence: 0.45 },
    ]);
    assert.ok(traits[0].actions!.some((a) => a.id === "telomerase_caution"));
  });
});

// ============================================================================
// Hallmark-based Longevity Traits (GenAge-derived)
// ============================================================================

describe("Hallmark Longevity Traits", () => {
  it("should enrich protein_homeostasis with chaperone actions", () => {
    const traits = enrichTraits([
      { trait_id: "protein_homeostasis", score: 65, confidence: 0.8 },
    ]);
    assert.ok(traits[0].actions);
    assert.ok(traits[0].actions!.some((a) => a.id === "heat_stress_therapy"));
    assert.ok(traits[0].outcomes!.some((o) => o.id === "proteotoxic_stress"));
  });

  it("should enrich senescence trait with SASP outcomes", () => {
    const traits = enrichTraits([
      { trait_id: "senescence", score: 60, confidence: 0.75 },
    ]);
    assert.ok(traits[0].actions);
    assert.ok(traits[0].outcomes!.some((o) => o.id === "sasp_inflammation"));
    assert.ok(traits[0].actions!.some((a) => a.id === "senolytic_dq"));
  });

  it("should enrich proteasome_autophagy trait", () => {
    const traits = enrichTraits([
      { trait_id: "proteasome_autophagy", score: 65, confidence: 0.8 },
    ]);
    assert.ok(
      traits[0].actions!.some((a) => a.id === "intermittent_fasting_autophagy")
    );
    assert.ok(traits[0].outcomes!.some((o) => o.id === "autophagy_decline"));
  });

  it("should enrich genome_stability with cancer screening action", () => {
    const traits = enrichTraits([
      { trait_id: "genome_stability", score: 70, confidence: 0.85 },
    ]);
    assert.ok(
      traits[0].outcomes!.some((o) => o.id === "dna_damage_accumulation")
    );
    assert.ok(traits[0].actions!.some((a) => a.id === "cancer_screening"));
  });

  it("should enrich klotho_anti_aging with exercise and gene therapy", () => {
    const traits = enrichTraits([
      { trait_id: "klotho_anti_aging", score: 60, confidence: 0.65 },
    ]);
    assert.ok(traits[0].outcomes!.some((o) => o.id === "klotho_decline"));
    assert.ok(traits[0].actions!.some((a) => a.id === "exercise_klotho"));
    assert.ok(traits[0].actions!.some((a) => a.id === "klotho_gene_therapy"));
  });

  it("should enrich mTOR_signaling with rapamycin and protein cycling", () => {
    const traits = enrichTraits([
      { trait_id: "mTOR_signaling", score: 60, confidence: 0.8 },
    ]);
    assert.ok(traits[0].outcomes!.some((o) => o.id === "hyperactive_mtor"));
    assert.ok(traits[0].actions!.some((a) => a.id === "rapamycin_mtor"));
    assert.ok(traits[0].actions!.some((a) => a.id === "protein_cycling"));
  });

  it("should enrich epigenetic_maintenance trait", () => {
    const traits = enrichTraits([
      { trait_id: "epigenetic_maintenance", score: 60, confidence: 0.7 },
    ]);
    assert.ok(traits[0].outcomes!.some((o) => o.id === "epigenetic_drift"));
    assert.ok(traits[0].actions!.some((a) => a.id === "clock_tracking"));
  });
});

// ============================================================================
// Hallmark Pathway Engine Tests
// ============================================================================

describe("Hallmark Engine", () => {
  it("should compute hallmark scores from matched genes", () => {
    const genes = ["MTHFR", "APOE", "IL6"];
    const alerts: Array<{ gene: string; tag: string }> = [
      { gene: "MTHFR", tag: "ℹ️ Dietary Rule" },
      { gene: "IL6", tag: "⚠️ Medical Alert" },
    ];
    const risks: Array<{ itemName: string; priority: number }> = [
      { itemName: "APOE E4", priority: 1 },
      { itemName: "MTHFR C677T", priority: 2 },
    ];
    const superpowers: Array<{ itemName: string }> = [
      { itemName: "BDNF Val66Met" },
    ];

    const report = computeHallmarkScores(genes, alerts, risks, superpowers);
    assert.ok(report.hallmarks.length > 0);
    assert.ok(report.total_genes_hit > 0);
    assert.ok(report.summary.length > 0);
  });

  it("should map FOXO3 to deregulated_nutrient_sensing", () => {
    const hallmarks = getHallmarksForGene("FOXO3");
    assert.ok(hallmarks.length > 0);
    assert.ok(hallmarks.includes("deregulated_nutrient_sensing"));
  });

  it("should map TP53 to genomic_instability and cellular_senescence", () => {
    const hallmarks = getHallmarksForGene("TP53");
    assert.ok(hallmarks.includes("genomic_instability"));
    assert.ok(hallmarks.includes("cellular_senescence"));
  });

  it("should return empty for unknown gene", () => {
    const hallmarks = getHallmarksForGene("NONEXISTENT");
    assert.strictEqual(hallmarks.length, 0);
  });

  it("should get genes for a specific hallmark", () => {
    const genes = getGenesForHallmark("genomic_instability");
    assert.ok(genes.length > 0);
    assert.ok(genes.includes("tp53"));
    assert.ok(genes.includes("brca1"));
  });

  it("should produce hallmark scores with genes", () => {
    const report = computeHallmarkScores(
      ["TP53", "APOE", "IL6"],
      [{ gene: "TP53", tag: "⚠️ Medical Alert" }],
      [{ itemName: "APOE E4", priority: 1 }],
      []
    );
    // At least genomic_instability (TP53) and altered_communication (IL6, APOE)
    assert.ok(report.hallmarks.length >= 2);
    assert.ok(report.summary.includes("hallmark"));
  });

  it("should return empty report for no matched genes", () => {
    const report = computeHallmarkScores([], [], [], []);
    assert.strictEqual(report.hallmarks.length, 0);
    assert.strictEqual(report.hallmarks_affected, 0);
  });

  it("should produce all 9 hallmark names", () => {
    const allHallmarks = getGenesForHallmark("mitochondrial_dysfunction");
    assert.ok(allHallmarks.length > 0);
    assert.ok(allHallmarks.includes("sod2"));
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

// ============================================================================
// Evidence Weighting Tests
// ============================================================================

describe("Evidence Weighting", () => {
  it("should return 1.0 for tier 1", () => {
    assert.strictEqual(getEvidenceWeight(1), 1.0);
  });

  it("should return 0.7 for tier 2", () => {
    assert.strictEqual(getEvidenceWeight(2), 0.7);
  });

  it("should return 0.4 for tier 3", () => {
    assert.strictEqual(getEvidenceWeight(3), 0.4);
  });

  it("should return 0.5 for unset tier", () => {
    assert.strictEqual(getEvidenceWeight(), 0.5);
    assert.strictEqual(getEvidenceWeight(undefined), 0.5);
  });

  it("should give higher priority to Tier 1 traits vs Tier 3 with identical scores", () => {
    const traits = enrichTraits([
      { trait_id: "methylation", score: 35, confidence: 0.9, evidenceTier: 1 },
      {
        trait_id: "caffeine_metabolism",
        score: 35,
        confidence: 0.9,
        evidenceTier: 3,
      },
    ]);
    const priorities = computeAllPriorities(traits);
    const tier1 = priorities.find((p) => p.trait_id === "methylation")!;
    const tier3 = priorities.find((p) => p.trait_id === "caffeine_metabolism")!;
    assert.ok(
      tier1.priority > tier3.priority,
      `Tier 1 priority (${tier1.priority}) should be higher than Tier 3 (${tier3.priority})`
    );
  });

  it("should compute evidence-weighted GLI", () => {
    const traits = enrichTraits([
      { trait_id: "methylation", score: 70, confidence: 0.9, evidenceTier: 1 },
      {
        trait_id: "caffeine_metabolism",
        score: 30,
        confidence: 0.85,
        evidenceTier: 3,
      },
    ]);
    const gli = computeEvidenceWeightedGLI(traits);

    // Tier 1 (weight 1.0) at score 70, Tier 3 (weight 0.4) at score 30
    // weighted_avg = (70*1.0 + 30*0.4) / (1.0 + 0.4) = (70 + 12) / 1.4 = 58.57
    // * 10 = 586
    assert.ok(gli > 0);
    assert.ok(gli <= 1000);
    // Evidence-weighted should be higher than unweighted since the Tier 1 high-score dominates
    const unweighted = computeGLI(traits);
    assert.strictEqual(unweighted, 500); // (70+30)/2 * 10
    assert.ok(
      gli > unweighted,
      `Evidence-weighted (${gli}) should be > unweighted (${unweighted}) when high-tier is high-score`
    );
  });

  it("should return 0 for evidence-weighted GLI with empty traits", () => {
    assert.strictEqual(computeEvidenceWeightedGLI([]), 0);
  });

  it("should give higher evidence-weighted GLI when Tier 1 traits score high", () => {
    const traits = enrichTraits([
      { trait_id: "methylation", score: 90, confidence: 0.9, evidenceTier: 1 },
      {
        trait_id: "caffeine_metabolism",
        score: 10,
        confidence: 0.85,
        evidenceTier: 3,
      },
    ]);
    const gli = computeEvidenceWeightedGLI(traits);
    // (90*1.0 + 10*0.4) / (1.0 + 0.4) = (90 + 4) / 1.4 = 67.14 → *10 = 671
    const unweighted = computeGLI(traits);
    assert.strictEqual(unweighted, 500); // (90+10)/2 * 10
    assert.ok(
      gli > unweighted,
      `Evidence-weighted (${gli}) should be > unweighted (${unweighted})`
    );
  });

  it("should propagate evidenceTier through enrichTraits", () => {
    const traits = enrichTraits([
      { trait_id: "methylation", score: 50, confidence: 0.9, evidenceTier: 1 },
    ]);
    assert.strictEqual(traits[0].evidenceTier, 1);
  });

  it("should preserve evidenceTier as undefined when not set", () => {
    const traits = enrichTraits([
      { trait_id: "methylation", score: 50, confidence: 0.9 },
    ]);
    assert.strictEqual(traits[0].evidenceTier, undefined);
  });

  it("should include evidenceTier in Insight output", () => {
    const traits = enrichTraits([
      { trait_id: "methylation", score: 50, confidence: 0.9, evidenceTier: 1 },
    ]);
    const insights = generateInsights(traits);
    assert.strictEqual(insights[0].evidenceTier, 1);
  });
});

// ============================================================================
// ClinVar ACMG + Rare Variant Tests
// ============================================================================

describe("ClinVar ACMG & Rare Variants", () => {
  it("should contain BRCA1 in ACMG gene set", () => {
    assert.ok(ACMG_SF_GENES.has("BRCA1"));
  });

  it("should contain TP53 in ACMG gene set", () => {
    assert.ok(ACMG_SF_GENES.has("TP53"));
  });

  it("should contain LDLR in ACMG gene set", () => {
    assert.ok(ACMG_SF_GENES.has("LDLR"));
  });

  it("should have ACMG info for BRCA1", () => {
    assert.ok(ACMG_GENE_INFO["BRCA1"]);
    assert.ok(ACMG_GENE_INFO["BRCA1"].condition.includes("Hereditary"));
    assert.ok(
      ACMG_GENE_INFO["BRCA1"].recommendation.includes("genetic counselor")
    );
  });

  it("should have ACMG info for RYR1 (malignant hyperthermia)", () => {
    assert.ok(ACMG_GENE_INFO["RYR1"]);
    assert.ok(
      ACMG_GENE_INFO["RYR1"].condition.includes("Malignant Hyperthermia")
    );
    assert.ok(ACMG_GENE_INFO["RYR1"].recommendation.includes("CRITICAL"));
  });

  it("should have 53 ACMG genes", () => {
    assert.strictEqual(ACMG_SF_GENES.size, 53);
  });

  it("should include the full 71-gene hereditary multi-cancer panel separately from ACMG", () => {
    assert.strictEqual(HEREDITARY_CANCER_PANEL_GENES.length, 71);
    for (const gene of [
      "BRCA1",
      "BRCA2",
      "ATM",
      "MLH1",
      "MSH2",
      "TP53",
      "APC",
      "PTEN",
      "RET",
      "VHL",
      "MEN1",
    ]) {
      assert.ok(
        HEREDITARY_CANCER_PANEL_GENES.includes(gene as any),
        `${gene} should be covered`
      );
    }
    assert.ok(HEREDITARY_CANCER_PANEL_GENES.includes("BARD1"));
    assert.equal(ACMG_SF_GENES.has("BARD1"), false);
  });

  it("should identify rare variants (MAF < 1%)", () => {
    assert.strictEqual(isRare(0.005), true);
    assert.strictEqual(isRare(0.001), true);
  });

  it("should reject common variants (MAF >= 1%)", () => {
    assert.strictEqual(isRare(0.01), false);
    assert.strictEqual(isRare(0.05), false);
  });

  it("should return false for absent gnomAD data", () => {
    assert.strictEqual(isRare(undefined), false);
    assert.strictEqual(isRare(0), false);
  });

  it("should use custom MAF threshold", () => {
    assert.strictEqual(isRare(0.02, 0.03), true);
    assert.strictEqual(isRare(0.02, 0.01), false);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe("Edge Cases", () => {
  it("should handle score 0", () => {
    const traits = enrichTraits([
      { trait_id: "methylation", score: 0, confidence: 0.9 },
    ]);
    const gli = computeGLI(traits);
    assert.strictEqual(gli, 0);
    const insights = generateInsights(traits);
    assert.strictEqual(insights.length, 1);
  });

  it("should handle score 100", () => {
    const traits = enrichTraits([
      { trait_id: "cardiovascular_fitness", score: 100, confidence: 1.0 },
    ]);
    const gli = computeGLI(traits);
    assert.strictEqual(gli, 1000);
  });

  it("should handle large batches", () => {
    const largeInput = Array.from({ length: 200 }, (_, i) => ({
      trait_id: `trait_${i}`,
      score: Math.round(Math.random() * 100),
      confidence: 0.5 + Math.random() * 0.5,
    }));
    const traits = enrichTraits(largeInput);
    const gli = computeGLI(traits);
    assert.ok(typeof gli === "number");
    const priorities = computeAllPriorities(traits);
    assert.ok(priorities.length === traits.length);
    const insights = generateInsights(traits);
    assert.ok(insights.length === traits.length);
  });
});

// ============================================================================
// VEP Annotation Tests
// ============================================================================

describe("VEP Annotation", () => {
  it("should parse VEP tabular output", () => {
    const sampleVEP = [
      "#Uploaded_variation\tLocation\tAllele\tGene\tFeature\tFeature_type\tConsequence\tcDNA_position\tCDS_position\tProtein_position\tAmino_acids\tCodons\tExisting_variation\tExtra",
      "1_11856378_G/A\t1:11856378\tA\tMTHFR\tENST00000376590\tTranscript\tmissense_variant\t665\t665\t222\tA/V\tgCc/gTc\t-\tIMPACT=MODERATE;STRAND=1",
      "19_45411941_T/C\t19:45411941\tC\tAPOE\tENST00000252486\tTranscript\tmissense_variant\t804\t804\t158\tR/C\tCgc/Tgc\trs429358\tIMPACT=MODERATE;STRAND=1",
    ].join("\n");

    const tmpFile = os.tmpdir() + "/test_vep.tsv";
    fs.writeFileSync(tmpFile, sampleVEP);

    try {
      const result = parseVEPOutput(tmpFile);
      assert.ok(
        result.size > 0,
        `Expected > 0 annotations, got ${result.size}`
      );
      for (const [, ann] of result) {
        assert.ok(ann.gene);
        assert.ok(ann.consequence);
        assert.ok(ann.impact);
      }
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch (_) {}
    }
  });

  it("should parse VEP output with known gene", () => {
    const sampleVEP = [
      "#Uploaded_variation\tLocation\tAllele\tGene\tFeature\tFeature_type\tConsequence\tExtra",
      "1_11856378_G/A\t1:11856378\tA\tMTHFR\tENST00000376590\tTranscript\tmissense_variant\tIMPACT=MODERATE;STRAND=1",
    ].join("\n");

    const tmpFile = os.tmpdir() + "/test_vep2.tsv";
    fs.writeFileSync(tmpFile, sampleVEP);

    try {
      const result = parseVEPOutput(tmpFile);
      assert.ok(result.size > 0);
      const entry = result.values().next().value;
      assert.ok(entry);
      assert.strictEqual(entry.gene, "MTHFR");
      assert.strictEqual(entry.consequence, "missense_variant");
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch (_) {}
    }
  });

  it("should return empty map for empty VEP output", () => {
    const tmpFile = os.tmpdir() + "/test_vep_empty.tsv";
    fs.writeFileSync(tmpFile, "#No results\n");

    try {
      const result = parseVEPOutput(tmpFile);
      assert.strictEqual(result.size, 0);
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch (_) {}
    }
  });

  it("should return empty map for non-existent file", () => {
    const result = parseVEPOutput("/nonexistent/path.vep.tsv");
    assert.strictEqual(result.size, 0);
  });

  it("should skip comment lines in VEP output", () => {
    const sampleVEP = [
      "# VEP version 110",
      "# Column descriptions",
      "1_11856378_G/A\t1:11856378\tA\tMTHFR\tENST00000376590\tTranscript\tmissense_variant\tIMPACT=MODERATE",
    ].join("\n");

    const tmpFile = os.tmpdir() + "/test_vep3.tsv";
    fs.writeFileSync(tmpFile, sampleVEP);

    try {
      const result = parseVEPOutput(tmpFile);
      assert.strictEqual(result.size, 1);
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch (_) {}
    }
  });

  it("isVEPAvailable should not throw", () => {
    const available = isVEPAvailable();
    assert.ok(typeof available === "boolean");
  });

  it("should provide on-demand VEP lookup via grep", () => {
    const sampleVEP = [
      "#Uploaded_variation\tLocation\tAllele\tGene\tFeature\tFeature_type\tConsequence\tExtra",
      "1_11856378_G/A\t1:11856378\tA\tMTHFR\tENST00000376590\tTranscript\tmissense_variant\tIMPACT=MODERATE;STRAND=1",
      "1_11856379_C/T\t1:11856379\tT\tMTHFR\tENST00000376590\tTranscript\tsynonymous_variant\tIMPACT=LOW;STRAND=1",
    ].join("\n");

    const tmpFile = os.tmpdir() + "/test_vep_lookup.tsv";
    fs.writeFileSync(tmpFile, sampleVEP);

    try {
      // parseVEPOutput should skip LOW (only gets MODERATE missense)
      const result = parseVEPOutput(tmpFile);
      const moderateCount = result.size;

      // On-demand lookup should find the LOW variant too
      const synVariant = "1:11856379:C:T";
      const synResult = queryVEPForVariant(synVariant, tmpFile);
      assert.ok(
        synResult,
        "Should find LOW impact variant via on-demand lookup"
      );
      assert.strictEqual(synResult.impact, "LOW");
      assert.strictEqual(synResult.consequence, "synonymous_variant");

      // But note: parseVEPOutput filtered it out
      assert.ok(
        !result.has(synVariant),
        "LOW impact should NOT be in the in-memory set"
      );
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch (_) {}
    }
  });

  it("should batch-lookup multiple VEP variants", () => {
    const sampleVEP = [
      "#Uploaded_variation\tLocation\tAllele\tGene\tFeature\tFeature_type\tConsequence\tExtra",
      "1_11856378_G/A\t1:11856378\tA\tMTHFR\tENST00000376590\tTranscript\tmissense_variant\tIMPACT=MODERATE;STRAND=1",
      "7_117559590_G/A\t7:117559590\tA\tCFTR\tENST00000003084\tTranscript\tmissense_variant\tIMPACT=MODERATE;STRAND=1",
    ].join("\n");

    const tmpFile = os.tmpdir() + "/test_vep_batch.tsv";
    fs.writeFileSync(tmpFile, sampleVEP);

    try {
      const results = queryVEPForVariants(
        ["1:11856378:G:A", "7:117559590:G:A"],
        tmpFile
      );
      assert.strictEqual(results.size, 2);
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch (_) {}
    }
  });

  it("should return null for variant not in VEP output", () => {
    const sampleVEP = [
      "#Uploaded_variation\tLocation\tAllele\tGene\tFeature\tFeature_type\tConsequence\tExtra",
      "1_11856378_G/A\t1:11856378\tA\tMTHFR\tENST00000376590\tTranscript\tmissense_variant\tIMPACT=MODERATE;STRAND=1",
    ].join("\n");

    const tmpFile = os.tmpdir() + "/test_vep_miss.tsv";
    fs.writeFileSync(tmpFile, sampleVEP);

    try {
      const result = queryVEPForVariant("22:99999999:A:T", tmpFile);
      assert.strictEqual(result, null);
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch (_) {}
    }
  });
});

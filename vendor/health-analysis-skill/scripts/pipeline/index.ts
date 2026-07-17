/**
 * Analyze Longevity Pipeline - Main Orchestrator
 * End-to-end pipeline for processing local genomics, biomarker, and wearable data.
 *
 * Flow:
 * WGS VCF -> analyze-vcf.ts -> LongevityProtocol JSON
 *                                                        ↓
 *                              wgs-pipeline transform (LongevityProtocol → PipelineOutput)
 *                                                        ↓
 *                          Trait Engine → Graph Resolver → Insight Engine
 *                                                        ↓
 *                          Protocol Engine → GLI Engine → Dashboard Output
 *
 * This module bridges genetic ingestion with the wellness pipeline spec
 * (trait -> insight -> protocol -> GLI).
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { injectTheme } from "../../shared/design/theme.js";
import {
  isFullDashboardDesign,
  renderFullDashboard,
} from "../../shared/design/render-designs.js";
import { PipelineLogger } from "./pipeline_logger.js";

import { analyzeVCF } from "../ingestion/parse-vcf.js";
import type {
  LongevityProtocol,
  AnalyzeVCFResult,
} from "../ingestion/parse-vcf.js";
import { enrichTraits } from "./graph_resolver.js";
import type { EnrichedTrait } from "./graph_resolver.js";
import {
  queryClinVarForRSIDs,
  generateVariantAnnotation,
  categorizeVariantForTab,
  isRecessiveDiseaseGene,
  type ClinVarAnnotation,
  type VariantCategory,
  type ClinVarConfidenceTier,
} from "./clinvar_enrichment.js";
import { matchCPIC } from "./cpic_enrichment.js";
import type { VEPAnnotation } from "./vep_annotation.js";
import { computeAllPriorities } from "./priority_engine.js";
import type { PriorityResult } from "./priority_engine.js";
import { generateInsights } from "./insight_engine.js";
import type { Insight } from "./insight_engine.js";
import { generateProtocols } from "./protocol_engine.js";
import type { Protocol } from "./protocol_engine.js";
import {
  computeWeightedGLI,
  getGLIRating,
  computeWeightedCategoryGLI,
} from "./gli_engine.js";
import {
  computeHallmarkScores,
  type HallmarkReport,
} from "./hallmark_engine.js";
import { computePRS, type PRSScore } from "./prs_engine.js";
import { computeGWASHits, getGWASRefDir } from "./gwas_engine.js";
import type { GWASTraitSection } from "../../shared/dashboard-types.js";
import {
  enrichVEPMissenseLongevity,
  mapVEPMissenseToTraits,
  type MissenseCall,
} from "./vep_missense_enrichment.js";
import { analyzeBiomarkers } from "./biomarker_engine.js";
import type { BiomarkerReading, UserProfile } from "./biomarker_engine.js";
import { analyzeWearables } from "./wearable_engine.js";
import type { WearableReading } from "./wearable_engine.js";
import { buildMultiModalPlan } from "./multimodal_engine.js";
import { parseBiomarkerFile, parseWearableFile } from "./health_data_import.js";
import type {
  PersonalizedActionPlan,
  PersonalizedAction,
  PlanReviewItem,
  PlanModality,
  PlanSafetyTier,
} from "../../shared/dashboard-types.js";
import { composePersonalizedActionPlan } from "./action_plan_composer.js";
import { buildNormalizedObservations } from "./observation_adapters.js";
import { buildExternalBenchmarkReport } from "./wgs_external_validation.js";
import { buildWgsTruthsetSetupReport } from "./wgs_external_truthset_setup.js";
import { buildWgsCallerManifest } from "./wgs_caller_pipeline.js";
import {
  buildWgsQueryReadinessReport,
  renderWgsLocalSetupScript,
} from "./wgs_query_readiness.js";
import { runVcfDoctor } from "./vcf_doctor.js";
import { renderDashboard } from "../../src/renderer/render.js";
import {
  surfaceAcrossModalities,
  type CatalogMatchSummary,
} from "./catalog_loader.js";
import {
  resolveCatalogEvidence,
  type CatalogFindings,
} from "./catalog_evidence_resolver.js";
import type {
  DashboardData,
  Meta,
  Gli,
  InnateStrength,
  Category,
  Insight as RInsight,
  ActionItem,
  Protocol as RProtocol,
  ProtocolPhase,
  StatusColor,
  ActionPriority,
  ClinVarVariantCard,
  GeneticVariantsSection,
  SignificanceColor,
  PRSScore as DashboardPRSScore,
  VEPMissenseSection,
  WgsValidationCoverage,
  LocalVcfCoverageSummary,
  BiomarkerAnalysisSummary,
  BiomarkerFinding,
} from "../../shared/dashboard-types.js";

// Re-export engines for external use.
// computeGLI, computeCategoryGLI, computeEvidenceWeightedGLI are available
// from gli_engine.js directly but are not re-exported here — they are unused
// by the pipeline. Tests import from gli_engine.js directly.
export {
  computeWeightedGLI,
  computeWeightedCategoryGLI,
} from "./gli_engine.js";
export * from "./hallmark_engine.js";
export * from "./trait_engine.js";
export * from "./graph_resolver.js";
export * from "./priority_engine.js";
export * from "./insight_engine.js";
export * from "./protocol_engine.js";
export * from "./gli_engine.js";
export * from "./biomarker_engine.js";
export * from "./wearable_engine.js";
export * from "./multimodal_engine.js";
export * from "./health_data_import.js";

// ============================================================================
// Types - Pipeline Output (User's Spec)
// ============================================================================

export interface Variant {
  rsid: string;
  genotype: string;
  quality: number;
}

export interface UserData {
  user_id: string;
  variants: Variant[];
  metadata?: Record<string, unknown>;
}

export interface DashboardOutput {
  gli: number;
  gli_rating: string;
  category_gli: Record<string, number>;
  top_traits: Array<{
    trait_id: string;
    score: number;
    confidence: number;
    mechanism: string;
  }>;
  traits: EnrichedTrait[];
  priorities: PriorityResult[];
  insights: Insight[];
  protocols: Protocol[];
  hallmark: HallmarkReport;
  metadata: {
    user_id: string;
    processed_at: string;
    trait_count: number;
    insight_count: number;
    protocol_count: number;
    hallmark_count: number;
    variant_count?: number;
    annotated_count?: number;
    matched_marker_count?: number;
    /** Number of curated health markers in the interpretation database */
    curated_markers: number;
    /** Number of rare HIGH/MODERATE functional variants (VEP, gnomAD AF < 0.01) */
    vep_rare_variants: number;
    /** Number of ClinVar pathogenic/likely pathogenic findings */
    clinvar_pathogenic: number;
    /** Number of CPIC actionable drug-gene interaction matches */
    cpic_actionable: number;
    /** Total ClinVar variants shown in the genetic variants tab */
    variant_tab_count: number;
    /** Genetic variants organized by category */
    variant_cards: GeneticVariantsSection;
    rsid_annotation_source?: string;
    rsid_annotation_limitation?: string;
    clinvar_confidence_counts?: Partial<Record<ClinVarConfidenceTier, number>>;
    /** Polygenic risk scores */
    prs_scores: PRSScore[];
    /** Internal local VCF fixture coverage summary */
    local_vcf_coverage?: LocalVcfCoverageSummary;
    /** GWAS Catalog trait associations */
    gwas_traits?: import("../../shared/dashboard-types.js").GWASTraitSection;
    /** VEP missense calls in longevity genes */
    vep_missense_calls?: MissenseCall[];
    vep_missense_genes?: string[];
    vep_missense_count?: number;
    vep_missense_damaging?: number;
    vep_status?: "included" | "skipped";
    vep_annotation_count?: number;
    wgs_validation_coverage?: WgsValidationCoverage[];
    /**
     * Condition-catalog gene-level summary across the six modalities
     * (hereditary, polygenic, pharmacology, personal traits, wellness,
     * ancestry) for the HGNC gene set derived from the user's annotated VCF.
     * Cheap, always populated.
     */
    condition_catalog_matches?: CatalogMatchSummary;
    /**
     * Condition-catalog findings with evidence joined from ClinVar (carrier
     * status / pathogenic calls), CPIC (drug-gene metabolizer phenotype and
     * dose recommendation), PGS Catalog (polygenic risk percentile), and GWAS
     * Catalog (trait directional evidence). Populated whenever the respective
     * evidence streams ran successfully — provides the per-condition status
     * the upstream surfaces for monogenic conditions, the metabolizer
     * phenotype the upstream surfaces for pharmacology, and the risk
     * percentile the upstream surfaces for polygenic / trait / wellness
     * entries.
     */
    condition_catalog_findings?: CatalogFindings;
  };
}

// ============================================================================
// Longevity Protocol Types (re-exported from analyze-vcf.ts for convenience)
// ============================================================================

export type { LongevityProtocol };

export interface DashboardTransformOptions {
  biomarkerReadings?: BiomarkerReading[];
  previousBiomarkerReadings?: BiomarkerReading[];
  wearableReadings?: WearableReading[];
  userProfile?: UserProfile;
}

interface WgsVariantClassSummaryFile {
  class_counts?: Record<string, number>;
  calls?: Array<{ class?: string; reportability?: string }>;
}

interface WgsValidationReportFile {
  results?: Array<{
    expected_classes?: string[];
    observed_classes?: string[];
    missing_classes?: string[];
    reportable_classes?: number;
    recall?: number;
    precision?: number;
    passed?: boolean;
  }>;
}

interface WgsExternalValidationReportFile {
  results?: Array<{
    truthset_id?: string;
    source_name?: string;
    benchmark_tool?: string;
    variant_classes?: string[];
    status?: string;
    passed?: boolean;
    tool_available?: boolean;
    truth_vcf_present?: boolean;
    confident_regions_present?: boolean;
    query_vcf_present?: boolean;
    metrics_present?: boolean;
    gap?: string;
    recall?: number;
    precision?: number;
  }>;
}

interface WgsTruthsetSetupReportFile {
  artifacts?: Array<{
    truthset_id?: string;
    kind?:
      | "truth_vcf"
      | "truth_vcf_index"
      | "confident_regions"
      | "query_vcf"
      | "query_vcf_index"
      | "metrics_json";
    present?: boolean;
    downloadable?: boolean;
    action?: string;
  }>;
  tools?: Array<{ tool?: string; available?: boolean; install_hint?: string }>;
}

interface WgsQueryReadinessReportFile {
  summary?: {
    truthsets?: number;
    ready_to_validate?: number;
    ready_to_generate?: number;
    hard_local_steps?: number;
    run_plans?: number;
  };
  results?: Array<{
    truthset_id?: string;
    variant_classes?: string[];
    status?: string;
    local_difficulty?: "easy" | "medium" | "hard";
    ready_to_generate?: boolean;
    query_vcf_present?: boolean;
    query_vcf_index_present?: boolean;
    missing_inputs?: string[];
    missing_caller_requirements?: string[];
    next_action?: string;
  }>;
}

interface WgsCallerManifestFile {
  caller_steps?: Array<{
    variant_class?: string;
    tool?: string;
    available?: boolean;
  }>;
}

interface LocalVcfCoverageReportFile {
  summary?: LocalVcfCoverageSummary;
}

function readLocalVcfCoverage(
  packageDir?: string
): LocalVcfCoverageSummary | undefined {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const resolvedPackageDir = packageDir ?? path.resolve(scriptDir, "../..");
  return readOptionalJsonFile<LocalVcfCoverageReportFile>(
    path.join(resolvedPackageDir, "output/local-vcf-coverage.json")
  )?.summary;
}

const WGS_VARIANT_CLASS_LABELS: Record<string, string> = {
  rare_small_variants: "Rare small variants",
  copy_number_variants: "Copy number variants",
  large_indels: "Large insertions/deletions",
  tandem_repeats: "Tandem repeats",
  rearrangements: "Rearrangements",
};

function readOptionalJsonFile<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function formatPercentMetric(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "not measured";
  return `${Math.round(value * 100)}%`;
}

export interface WgsReadinessRefreshResult {
  generated: string[];
  skipped: string[];
  errors: string[];
}

export function refreshWgsReadinessArtifacts(
  packageDir?: string,
  artifactOutputDir?: string
): WgsReadinessRefreshResult {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const resolvedPackageDir = packageDir ?? path.resolve(scriptDir, "../..");
  const outputDir = artifactOutputDir ?? path.join(resolvedPackageDir, "output");
  const truthsetPath = path.join(
    resolvedPackageDir,
    "references/wgs-validation-truthsets.json"
  );
  const generated: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  fs.mkdirSync(outputDir, { recursive: true });

  try {
    const callerManifestPath = path.join(outputDir, "wgs-caller-manifest.json");
    const callerManifest = buildWgsCallerManifest();
    fs.writeFileSync(
      callerManifestPath,
      `${JSON.stringify(callerManifest, null, 2)}\n`,
      "utf8"
    );
    generated.push(callerManifestPath);
  } catch (error) {
    errors.push(
      `caller manifest: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const truthsetConfig = readOptionalJsonFile<any>(truthsetPath);
  if (!truthsetConfig) {
    skipped.push(
      `External truthset config missing or unreadable: ${truthsetPath}`
    );
    return { generated, skipped, errors };
  }

  try {
    const setupPath = path.join(outputDir, "wgs-external-truthset-setup.json");
    const setupReport = buildWgsTruthsetSetupReport(
      truthsetConfig,
      truthsetPath,
      resolvedPackageDir
    );
    fs.writeFileSync(
      setupPath,
      `${JSON.stringify(setupReport, null, 2)}\n`,
      "utf8"
    );
    generated.push(setupPath);
  } catch (error) {
    errors.push(
      `truthset setup: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  try {
    const externalPath = path.join(
      outputDir,
      "wgs-external-validation-report.json"
    );
    const externalReport = buildExternalBenchmarkReport(
      truthsetConfig,
      truthsetPath,
      resolvedPackageDir,
      false
    );
    fs.writeFileSync(
      externalPath,
      `${JSON.stringify(externalReport, null, 2)}\n`,
      "utf8"
    );
    generated.push(externalPath);
  } catch (error) {
    errors.push(
      `external validation preflight: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  try {
    const queryReadinessPath = path.join(outputDir, "wgs-query-readiness.json");
    const querySetupScriptPath = path.join(
      outputDir,
      "wgs-local-setup-plan.sh"
    );
    const queryReadiness = buildWgsQueryReadinessReport(
      truthsetConfig,
      truthsetPath,
      resolvedPackageDir
    );
    queryReadiness.setup_script_path = querySetupScriptPath;
    fs.writeFileSync(
      queryReadinessPath,
      `${JSON.stringify(queryReadiness, null, 2)}\n`,
      "utf8"
    );
    generated.push(queryReadinessPath);
    fs.writeFileSync(
      querySetupScriptPath,
      renderWgsLocalSetupScript(queryReadiness),
      "utf8"
    );
    fs.chmodSync(querySetupScriptPath, 0o755);
    generated.push(querySetupScriptPath);
  } catch (error) {
    errors.push(
      `query generation readiness: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return { generated, skipped, errors };
}

export function buildWgsValidationCoverage(
  packageDir?: string,
  artifactOutputDir?: string
): WgsValidationCoverage[] {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const resolvedPackageDir = packageDir ?? path.resolve(scriptDir, "../..");
  const outputDir = artifactOutputDir ?? path.join(resolvedPackageDir, "output");
  const classSummary = readOptionalJsonFile<WgsVariantClassSummaryFile>(
    path.join(outputDir, "wgs-variant-class-summary.json")
  );
  const validation = readOptionalJsonFile<WgsValidationReportFile>(
    path.join(outputDir, "wgs-validation-report.json")
  );
  const external = readOptionalJsonFile<WgsExternalValidationReportFile>(
    path.join(outputDir, "wgs-external-validation-report.json")
  );
  const setup = readOptionalJsonFile<WgsTruthsetSetupReportFile>(
    path.join(outputDir, "wgs-external-truthset-setup.json")
  );
  const queryReadiness = readOptionalJsonFile<WgsQueryReadinessReportFile>(
    path.join(outputDir, "wgs-query-readiness.json")
  );
  const manifest = readOptionalJsonFile<WgsCallerManifestFile>(
    path.join(outputDir, "wgs-caller-manifest.json")
  );

  return Object.entries(WGS_VARIANT_CLASS_LABELS).map(([id, label]) => {
    const callCount = classSummary?.class_counts?.[id] ?? 0;
    const reportableCount = (classSummary?.calls ?? []).filter(
      (call) =>
        call.class === id &&
        call.reportability &&
        call.reportability !== "research_only"
    ).length;
    const syntheticResults = (validation?.results ?? []).filter(
      (result) =>
        (result.expected_classes ?? []).includes(id) ||
        (result.observed_classes ?? []).includes(id)
    );
    const syntheticValidated = syntheticResults.some(
      (result) => result.passed && !(result.missing_classes ?? []).includes(id)
    );
    const bestSynthetic = syntheticResults
      .filter((result) => result.recall != null && result.precision != null)
      .sort(
        (a, b) =>
          (b.recall ?? 0) +
          (b.precision ?? 0) -
          ((a.recall ?? 0) + (a.precision ?? 0))
      )[0];
    const externalResults = (external?.results ?? []).filter((result) =>
      (result.variant_classes ?? []).includes(id)
    );
    const passingExternal = externalResults.find((result) => result.passed);
    const mostRelevantExternal = passingExternal ?? externalResults[0];
    const queryResults = (queryReadiness?.results ?? []).filter((result) =>
      (result.variant_classes ?? []).includes(id)
    );
    const mostRelevantQuery =
      queryResults.find((result) => result.status === "ready_to_validate") ??
      queryResults.find((result) => result.ready_to_generate) ??
      queryResults[0];
    const callerSteps = (manifest?.caller_steps ?? []).filter((step) =>
      (step.variant_class ?? "")
        .split(",")
        .map((item) => item.trim())
        .includes(id)
    );
    const callerTools = callerSteps
      .map((step) => step.tool)
      .filter((tool): tool is string => Boolean(tool));
    const callerAvailable = callerSteps.some((step) => step.available);
    const setupArtifacts = (setup?.artifacts ?? []).filter((artifact) =>
      externalResults.some(
        (result) => result.truthset_id === artifact.truthset_id
      )
    );
    const missingTruthArtifacts = setupArtifacts.filter(
      (artifact) =>
        (artifact.kind === "truth_vcf" ||
          artifact.kind === "truth_vcf_index" ||
          artifact.kind === "confident_regions") &&
        !artifact.present
    );
    const missingQueryArtifacts = setupArtifacts.filter(
      (artifact) =>
        (artifact.kind === "query_vcf" ||
          artifact.kind === "query_vcf_index") &&
        !artifact.present
    );
    const missingMetricsArtifacts = setupArtifacts.filter(
      (artifact) => artifact.kind === "metrics_json" && !artifact.present
    );
    const externalTools = new Set(
      externalResults
        .map((result) => result.benchmark_tool)
        .filter((tool): tool is string => Boolean(tool))
    );
    const missingTools = (setup?.tools ?? [])
      .filter((tool) => tool.tool && externalTools.has(tool.tool))
      .filter((tool) => !tool.available);
    const status: WgsValidationCoverage["status"] = passingExternal
      ? "externally_validated"
      : syntheticValidated
      ? "pipeline_validated"
      : callerAvailable || callCount > 0 || externalResults.length > 0
      ? "pending_external_validation"
      : "not_available";
    const statusLabel: Record<WgsValidationCoverage["status"], string> = {
      externally_validated: "Externally validated",
      pipeline_validated: "Pipeline fixture validated; external pending",
      pending_external_validation: "Pending external validation",
      not_available: "Not available",
    };
    const note = passingExternal
      ? `External benchmark passed against ${
          passingExternal.source_name ?? passingExternal.truthset_id
        }.`
      : syntheticValidated
      ? `Parser and interpretation fixture passed (${formatPercentMetric(
          bestSynthetic?.recall
        )} recall, ${formatPercentMetric(
          bestSynthetic?.precision
        )} precision); GIAB-style external validation is still pending.`
      : externalResults.length > 0
      ? `External benchmark configured but not yet passing (${
          mostRelevantExternal?.status ?? "pending"
        }).`
      : "No benchmark evidence is currently available for this variant class.";
    const nextStep = passingExternal
      ? "External benchmark is complete for this variant class."
      : missingTruthArtifacts.length > 0
      ? "Next: download the external GIAB/truthset artifacts for this class."
      : missingQueryArtifacts.length > 0
      ? `Next: ${
          mostRelevantQuery?.next_action ??
          "run the matching HG002 caller pipeline to generate the local query VCF."
        }`
      : missingTools.length > 0
      ? `Next: install the benchmark tool ${missingTools
          .map((tool) => tool.tool)
          .filter(Boolean)
          .join(" / ")}.`
      : missingMetricsArtifacts.length > 0
      ? "Next: run external validation to produce precision/recall metrics."
      : externalResults.length > 0
      ? `Next: resolve external validation status ${
          mostRelevantExternal?.status ?? "pending"
        }.`
      : "Next: configure an external validation truthset for this class.";

    return {
      id,
      label,
      status,
      status_label: statusLabel[status],
      call_count: callCount,
      reportable_count: reportableCount,
      caller_available: callerAvailable,
      caller_tools: [...new Set(callerTools)],
      external_source:
        mostRelevantExternal?.source_name ?? mostRelevantExternal?.truthset_id,
      external_status: mostRelevantExternal?.status,
      query_status: mostRelevantQuery?.status,
      local_difficulty: mostRelevantQuery?.local_difficulty,
      recall: passingExternal?.recall ?? bestSynthetic?.recall,
      precision: passingExternal?.precision ?? bestSynthetic?.precision,
      note,
      next_step: nextStep,
    };
  });
}

// ============================================================================
// Core Pipeline Functions
// ============================================================================

/**
 * Map LongevityProtocol to trait scores for pipeline processing.
 * This transforms the existing pipeline's output into the user's pipeline format.
 */
function mapProtocolToTraits(protocol: LongevityProtocol): Array<{
  trait_id: string;
  score: number;
  confidence: number;
  evidenceTier?: 1 | 2 | 3;
}> {
  // Gene-based to knowledge graph trait mapping
  // Expanded to cover all wellness, vulnerability, pharmacology, performance, personality markers
  const geneToTraitMap: Record<string, string> = Object.fromEntries([
    ["mthfr", "methylation"],
    ["mtr", "methylation"],
    ["mtrr", "methylation"],
    ["parp1", "dna_repair"],
    ["apob", "lipid_metabolism"],
    ["pcsk9", "cholesterol"],
    ["il6", "inflammation"],
    ["nos3", "cardiovascular"],
    ["a148v", "oxidative_metabolism"],
    ["cyp1a1", "detoxification"],
    ["cyp1b1", "detoxification"],
    ["cyp1a2", "caffeine_metabolism"],
    ["bdnf", "neuroplasticity"],
    ["comt", "dopamine_metabolism"],
    ["actn3", "muscle_performance"],
    ["lct", "lactose_intolerance"],
    ["mcm6", "lactose_intolerance"],
    ["sirt1", "longevity_pathway"],
    ["sod2", "oxidative_stress"],
    ["vdr", "vitamin_d"],
    ["bcmo1", "vitamin_a"],
    ["cbs", "cysteine_metabolism"],
    ["dao", "histamine_intolerance"],
    ["hnmt", "histamine_intolerance"],
    ["hif1a", "hypoxia_response"],
    ["ppargc1a", "mitochondrial_biogenesis"],
    ["gstm1", "detoxification"],
    ["gstt1", "detoxification"],
    ["gsta1", "detoxification"],
    ["gsto1", "detoxification"],
    ["hmox1", "heme_metabolism"],
    ["nfe2l2", "oxidative_stress_response"],
    ["pnpla3", "lipid_storage"],
    ["tm6sf2", "lipid_storage"],
    ["xpc", "dna_repair"],
    ["ercc2", "dna_repair"],
    ["ogg1", "dna_repair"],
    ["mutyh", "dna_repair"],
    ["xrcc1", "dna_repair"],
    ["atm", "dna_repair"],
    ["sirt3", "mitochondrial_function"],
    ["sirt6", "dna_repair"],
    ["elovl2", "lipid_composition"],
    ["fads1", "omega3_metabolism"],
    ["fads2", "omega3_metabolism"],
    ["abca1", "cholesterol_transport"],
    ["lipc", "lipid_metabolism"],
    ["apoc3", "triglyceride_metabolism"],
    ["slco1b1", "drug_transport"],
    ["slc39a8", "zinc_homeostasis"],
    ["gpx1", "selenium_metabolism"],
    ["dio2", "thyroid_metabolism"],
    ["trpm6", "magnesium_status"],
    ["tmpress6", "iron_homeostasis"],
    ["slc19a1", "b12_metabolism"],
    ["pemt", "choline_metabolism"],
    ["elovl2", "omega3_metabolism"],
    ["nampt", "nad_metabolism"],
    ["nmnat1", "nad_metabolism"],
    ["nadsyn1", "nad_metabolism"],
    ["ampk", "energy_metabolism"],
    ["per2", "circadian_rhythm"],
    ["clock", "circadian_rhythm"],
    ["fabp7", "fatty_acid_transport"],
    ["crp", "inflammation_marker"],
    ["tnf", "inflammation"],
    ["il10", "anti_inflammation"],
    ["vegfa", "angiogenesis"],
    ["il1b", "inflammation"],
    ["il1a", "inflammation"],
    ["apoe", "lipid_transport"],
    ["tcf7l2", "insulin_signaling"],
    ["agtr1", "blood_pressure"],
    ["hfe", "iron_metabolism"],
    ["foxo3", "longevity"],
    ["tert", "telomere_maintenance"],
    ["lpa", "cardiovascular_risk"],
    ["cetp", "cholesterol_transport"],
    ["cdkn2bas", "cell_cycle"],
    ["f5", "thrombosis_risk"],
    ["f2", "thrombosis_risk"],
    ["f13a1", "thrombosis_risk"],
    ["ldlr", "ldl_receptor"],
    ["gckr", "glucose_metabolism"],
    ["fto", "body_weight"],
    ["gipr", "incretin_response"],
    ["gnpda2", "glucose_metabolism"],
    ["zranb3", "dna_repair"],
    ["xdh", "xanthine_oxidase"],
    ["il6r", "inflammation"],
    ["cnih4", "insulin_signaling"],
    ["hdac4", "muscle_performance"],
    ["gdf5", "joint_health"],
    ["_col1a1", "collagen"],
    ["col1a1", "collagen"],
    ["cftr", "respiratory_health"],
    ["lmna", "lamin_aging"],
    ["galt", "galactose_metabolism"],
    ["abcg2", "urate_excretion"],
    ["cyp3a4", "drug_metabolism"],
    ["cyp3a5", "drug_metabolism"],
    ["cyp2c9", "drug_metabolism"],
    ["cyp2c19", "drug_metabolism"],
    ["cyp2d6", "drug_metabolism"],
    ["abcb1", "drug_transport"],
    ["slc01b1", "drug_transport"],
    ["nat2", "acetylator_status"],
    ["tpmt", "thiopurine_metabolism"],
    ["dpyd", "fluorouracil_metabolism"],
    ["ugt1a1", "bilirubin_metabolism"],
    ["cyp2c8", "drug_metabolism"],
    ["cyp2b6", "drug_metabolism"],
    ["actn3", "muscle_performance"],
    ["ace", "cardiovascular_fitness"],
    ["aded", "muscle_performance"],
    ["ampd1", "exercise_endurance"],
    ["hfe", "iron_handling"],
    ["mthfr", "methylation"],
    ["mtr", "methylation"],
    ["mtrr", "methylation"],
    ["bdnf", "neuroplasticity"],
    ["comt", "dopamine_metabolism"],
    ["drd2", "dopamine_signaling"],
    ["slc6a4", "serotonin_transport"],
    ["htt", "neurotrophic_factor"],
    ["ckm", "muscle_energy"],
    ["myod1", "muscle_development"],
    ["vegfa", "angiogenesis"],
    ["eng", "endothelial_function"],
    ["nos3", "endothelial_function"],
    ["cdkn2b-as1", "cardiovascular"],
    ["cdkn2a", "cell_cycle"],
    ["cdkn2b", "cell_cycle"],
    ["enos", "endothelial_function"],
    ["ucp2", "thermogenesis"],
    ["ucp3", "muscle_metabolism"],
    ["enpp1", "glucose_metabolism"],
    ["cdkal1", "glucose_metabolism"],
    ["capn10", "glucose_metabolism"],
    ["ppard", "fatty_acid_oxidation"],
    ["pparg", "adipogenesis"],
    ["adipoq", "adiponectin"],
    ["lepr", "leptin_signaling"],
    ["fndc5", "irisin_response"],
    ["hadrsa", "histamine_response"],
    ["slc6a4", "serotonin_transport"],
    ["bdnt", "neuroplasticity"],
    ["comt", "dopamine_metabolism"],
    ["drd1", "dopamine_signaling"],
    ["drd2", "dopamine_signaling"],
    ["drd4", "dopamine_signaling"],
    ["maoa", "neurotransmitter_metabolism"],
    ["htr2a", "serotonin_signaling"],
    ["htr1a", "serotonin_signaling"],
    ["chrna4", "cholinergic_signaling"],
    ["chrna7", "cholinergic_signaling"],
    ["gria1", "glutamate_signaling"],
    ["grin2a", "glutamate_signaling"],
    ["grin2b", "glutamate_signaling"],
    ["bdnf", "neuroplasticity"],
    ["ngf", "nerve_growth"],
    ["arc", "synaptic_plasticity"],
    ["cftr", "respiratory_health"],
    ["chit1", "inflammation"],
    ["chi3l1", "inflammation"],
    ["cntnap2", "neuroplasticity"],
    ["esr1", "inflammation"],
    ["stat4", "immune_response"],
    ["irf5", "immune_response"],
    ["cd244", "immune_response"],
    ["slc11a1", "immune_response"],
    ["fcn3", "immune_response"],
    ["epo", "blood_health"],
    ["oprm1", "drug_metabolism"],
    ["tas2r38", "body_weight"],
    ["t", "developmental"],
    ["tbxt", "developmental"],
    ["glcci1", "drug_metabolism"],
    ["neb", "muscle_performance"],
    ["nos1", "endothelial_function"],
    ["nos2", "inflammation"],
    ["dio1", "thyroid_function"],
    ["gclm", "oxidative_stress"],
    ["gclc", "oxidative_stress"],
    ["tp53", "genome_stability"],
    ["kl", "klotho_anti_aging"],
    ["akt1", "insulin_signaling"],
    ["gsk3b", "insulin_signaling"],
    ["cat", "oxidative_stress"],
    ["gpx1", "oxidative_stress"],
    ["gpx4", "oxidative_stress"],
    ["prdx1", "oxidative_stress"],
    ["txn", "oxidative_stress"],
    ["wrn", "genome_stability"],
    ["blm", "genome_stability"],
    ["recql4", "genome_stability"],
    ["hspa1a", "protein_homeostasis"],
    ["hspa1b", "protein_homeostasis"],
    ["hspa8", "protein_homeostasis"],
    ["hspa9", "mitochondrial_function"],
    ["hspd1", "protein_homeostasis"],
    ["hsp90aa1", "protein_homeostasis"],
    ["stub1", "protein_homeostasis"],
    ["sirt7", "mitochondrial_function"],
    ["pml", "senescence"],
    ["igf1", "insulin_signaling"],
    ["gdf11", "neuroplasticity"],
    ["pten", "insulin_signaling"],
    ["mtor", "mTOR_signaling"],
    ["rictor", "mTOR_signaling"],
    ["gsr", "oxidative_stress"],
    ["gss", "oxidative_stress"],
    ["gstp1", "detoxification"],
    ["h2afx", "genome_stability"],
    ["rad51", "genome_stability"],
    ["rad52", "genome_stability"],
    ["pold1", "genome_stability"],
    ["polg", "mitochondrial_function"],
    ["ercc1", "genome_stability"],
    ["ercc3", "genome_stability"],
    ["ercc4", "genome_stability"],
    ["ercc5", "genome_stability"],
    ["ercc6", "genome_stability"],
    ["ercc8", "genome_stability"],
    ["xpa", "genome_stability"],
    ["mlh1", "genome_stability"],
    ["chek2", "genome_stability"],
    ["nbn", "genome_stability"],
    ["pin1", "protein_homeostasis"],
    ["sqstm1", "proteasome_autophagy"],
    ["bcl2", "senescence"],
    ["bax", "senescence"],
    ["bak1", "senescence"],
    ["fas", "senescence"],
    ["rb1", "genome_stability"],
    ["myc", "senescence"],
    ["hras", "senescence"],
    ["umed", "oxidative_stress"],
    ["ubolm", "proteasome_autophagy"],
    ["sumo1", "protein_homeostasis"],
    ["gclc", "oxidative_stress"],
    ["gclm", "oxidative_stress"],
    ["pon1", "oxidative_stress"],
    ["hla-a", "immune_response"],
    ["hla-b", "immune_response"],
    ["hla-c", "immune_response"],
    ["hla-dqa1", "immune_response"],
    ["hla-dqb1", "immune_response"],
    ["hla-drb1", "immune_response"],
    ["irf5", "immune_response"],
    ["stat4", "immune_response"],
    ["tnfaip3", "inflammation"],
    ["ptpn22", "immune_response"],
    ["blk", "immune_response"],
    ["tnfsf4", "immune_response"],
    ["myh7", "cardiomyopathy"],
    ["mybpc3", "cardiomyopathy"],
    ["tnnt2", "cardiomyopathy"],
    ["ttn", "cardiomyopathy"],
    ["lmna", "cardiomyopathy"],
    ["dsp", "cardiomyopathy"],
    ["dsg2", "cardiomyopathy"],
    ["pkp2", "cardiomyopathy"],
    ["scn5a", "arrhythmia"],
    ["kcnh2", "arrhythmia"],
    ["kcnq1", "arrhythmia"],
    ["ryr2", "arrhythmia"],
    ["kcnq1ot1", "arrhythmia"],
    ["cacna1c", "arrhythmia"],
    ["fbn1", "connective_tissue"],
    ["col1a1", "connective_tissue"],
    ["col1a2", "connective_tissue"],
    ["col3a1", "connective_tissue"],
    ["col5a1", "connective_tissue"],
    ["col5a2", "connective_tissue"],
    ["tgfb1", "connective_tissue"],
    ["tgfb2", "connective_tissue"],
    ["tgfb3", "connective_tissue"],
    ["tgfbr1", "connective_tissue"],
    ["tgfbr2", "connective_tissue"],
    ["smad3", "connective_tissue"],
    ["brca1", "hereditary_cancer"],
    ["brca2", "hereditary_cancer"],
    ["tp53", "hereditary_cancer"],
    ["msh2", "dna_repair"],
    ["msh6", "dna_repair"],
    ["pms2", "dna_repair"],
    ["apc", "hereditary_cancer"],
    ["pten", "hereditary_cancer"],
    ["ret", "hereditary_cancer"],
    ["men1", "hereditary_cancer"],
    ["nf1", "hereditary_cancer"],
    ["nf2", "hereditary_cancer"],
    ["vhl", "hereditary_cancer"],
    ["cdh1", "hereditary_cancer"],
    ["stk11", "hereditary_cancer"],
    ["rpe65", "eye_health"],
    ["abca4", "eye_health"],
    ["rds", "eye_health"],
    ["crb1", "eye_health"],
    ["ush2a", "eye_health"],
    ["myo7a", "eye_health"],
    ["eya4", "eye_health"],
    ["prom1", "eye_health"],
    ["prph2", "eye_health"],
    ["cfh", "eye_health"],
    ["arms2", "eye_health"],
    ["htra1", "eye_health"],
    ["umod", "kidney_health"],
    ["pkd1", "kidney_health"],
    ["pkd2", "kidney_health"],
    ["col4a3", "kidney_health"],
    ["col4a4", "kidney_health"],
    ["col4a5", "kidney_health"],
    ["nphp1", "kidney_health"],
    ["nphp4", "kidney_health"],
    ["col2a1", "bone_health"],
    ["fgfr3", "bone_health"],
    ["comp", "bone_health"],
    ["sox9", "bone_health"],
    ["runx2", "bone_health"],
    ["sost", "bone_health"],
    ["dio1", "thyroid_function"],
    ["dio2", "thyroid_function"],
    ["tshr", "thyroid_function"],
    ["casr", "calcium_metabolism"],
    ["cyp27b1", "vitamin_d"],
    ["cyp24a1", "vitamin_d"],
    ["g6pc", "glucose_metabolism"],
    ["pomc", "body_weight"],
    ["mc4r", "body_weight"],
    ["lep", "body_weight"],
    ["lepr", "body_weight"],
    ["htt", "neuroplasticity"],
    ["atxn1", "neurological_health"],
    ["atxn3", "neurological_health"],
    ["cacna1a", "neurological_health"],
    ["scn1a", "neurological_health"],
    ["f8", "thrombosis_risk"],
    ["f9", "thrombosis_risk"],
    ["proc", "thrombosis_risk"],
    ["pros1", "thrombosis_risk"],
    ["serpinc1", "thrombosis_risk"],
  ]);

  /**
   * Categorize an unmapped gene/disease name into a known trait bucket.
   * Prevents raw ClinVar disease names from leaking into the pipeline as trait IDs.
   */
  function categorizeUnknownGene(raw: string): string {
    const g = raw.toLowerCase().replace(/[,;]/g, "");
    // Already a known disease category
    if (
      /cancer|tumor|neoplas|melanoma|leukemia|lymphoma|sarcoma|carcinoma/i.test(
        g
      )
    )
      return "hereditary_cancer";
    if (/heart|cardio|arrhythmia|long_qt|brugada|dilated|hypertrophic/i.test(g))
      return "cardiomyopathy";
    if (
      /alzheimer|parkinson|dementia|huntington|neurodeg|ataxia|spastic/i.test(g)
    )
      return "neurological_health";
    if (
      /lupus|autoimmune|rheumatoid|multiple_sclerosis|crohn|colitis|celiac|psoriasis/i.test(
        g
      )
    )
      return "immune_response";
    if (/eye|retin|macular|cornea|blind|vision|cataract|glaucoma/i.test(g))
      return "eye_health";
    if (/kidney|renal|nephro|polycystic/i.test(g)) return "kidney_health";
    if (/bone|skeletal|osteop|osteogenesis|dwarfism|chondro/i.test(g))
      return "bone_health";
    if (/clot|thrombo|hemophilia|bleeding|factor_/i.test(g))
      return "thrombosis_risk";
    if (/connective|marfan|ehlers|aneurysm|aort/i.test(g))
      return "connective_tissue";
    if (/metabol|diabetes|obesity|thyroid|endocrine/i.test(g))
      return "glucose_metabolism";
    if (/deaf|hearing|ear/i.test(g)) return "hearing_health";
    if (/muscular|muscle|myopathy|dystrophy/i.test(g))
      return "muscle_performance";
    if (/liver|hepatitis|cirrhosis|biliary/i.test(g)) return "liver_health";
    if (/lung|pulmonary|respiratory|asthma|copd/i.test(g))
      return "respiratory_health";
    if (/skin|dermat|epiderm/i.test(g)) return "skin_health";
    if (/anemia|thalassemia|hemoglobin|hb_/i.test(g)) return "blood_health";
    // Check for known gene categories
    if (/cyp\d|ugt|nat\d|sult|gst/i.test(g)) return "drug_metabolism";
    if (/hla-[a-z]/i.test(g)) return "immune_response";
    if (/col\d/i.test(g) && g.length <= 6) return "connective_tissue";
    // Still unknown — return a generic bucket rather than leaking the raw name
    return "health_profile";
  }

  const traits: Array<{
    trait_id: string;
    score: number;
    confidence: number;
    evidenceTier?: 1 | 2 | 3;
  }> = [];

  // Map alerts to traits
  for (const alert of protocol.genomicProfile.alerts) {
    const gene = alert.gene.toLowerCase();
    const targetTrait = geneToTraitMap[gene] || categorizeUnknownGene(gene);

    let score = 50;
    if (alert.tag.includes("Medical Alert")) {
      score = 35;
    } else if (alert.tag.includes("Dietary Rule")) {
      score = 45;
    }

    traits.push({
      trait_id: targetTrait,
      score,
      confidence: 0.85,
      evidenceTier: alert.evidenceTier,
    });
  }

  // Map topRisks to traits
  for (const risk of protocol.genomicProfile.topRisks) {
    const parts = risk.itemName.split(" ");
    const gene = parts[0].toLowerCase();
    const targetTrait = geneToTraitMap[gene] || categorizeUnknownGene(gene);

    const baseScore = 60 - risk.priority * 10;
    const score = Math.max(25, baseScore);

    traits.push({
      trait_id: targetTrait,
      score,
      confidence: 0.9,
      evidenceTier: risk.evidenceTier,
    });
  }

  // Map superpowers to traits
  for (const sp of protocol.genomicProfile.superpowers) {
    const parts = sp.itemName.split(" ");
    const gene = parts[0].toLowerCase();
    const targetTrait = geneToTraitMap[gene] || categorizeUnknownGene(gene);

    traits.push({
      trait_id: targetTrait,
      score: 80,
      confidence: 0.85,
      evidenceTier: sp.evidenceTier,
    });

    // If this superpower has a known rsID and it's in the edge catalog, also emit a
    // protective_* trait so it surfaces as a named genetic edge on the dashboard.
    if (
      sp.rsid &&
      sp.rsid.startsWith("rs") &&
      FAVORABLE_EDGE_CATALOG[sp.rsid]
    ) {
      traits.push({
        trait_id: `protective_${sp.rsid.toLowerCase()}`,
        score: 85,
        confidence: 0.8,
        evidenceTier: sp.evidenceTier,
      });
    }
  }

  // Add supplement-based traits
  for (const supp of protocol.dailyStack.morning) {
    const reason = supp.reason.toLowerCase();

    if (reason.includes("methyl") || reason.includes("folate")) {
      traits.push({ trait_id: "methylation", score: 45, confidence: 0.85 });
    }
    if (
      reason.includes("omega") ||
      reason.includes("inflammation") ||
      reason.includes("anti-inflammatory")
    ) {
      traits.push({ trait_id: "inflammation", score: 50, confidence: 0.8 });
    }
    if (reason.includes("b12") || reason.includes("cobalamin")) {
      traits.push({ trait_id: "b12_metabolism", score: 55, confidence: 0.85 });
    }
    if (
      reason.includes("lipid") ||
      reason.includes("ldl") ||
      reason.includes("statin")
    ) {
      traits.push({ trait_id: "cholesterol", score: 40, confidence: 0.85 });
    }
    if (
      reason.includes("coa") ||
      reason.includes("q10") ||
      reason.includes("mitochondrial")
    ) {
      traits.push({ trait_id: "mitochondrial", score: 55, confidence: 0.8 });
    }
  }

  // Deduplicate by trait_id, taking the lowest score (most concern), preserving evidence tier
  const traitMap = new Map<
    string,
    {
      trait_id: string;
      score: number;
      confidence: number;
      evidenceTier?: 1 | 2 | 3;
    }
  >();
  for (const trait of traits) {
    const existing = traitMap.get(trait.trait_id);
    if (!existing || trait.score < existing.score) {
      traitMap.set(trait.trait_id, trait);
    } else if (
      existing &&
      trait.score === existing.score &&
      trait.evidenceTier !== undefined &&
      existing.evidenceTier === undefined
    ) {
      // If same score, prefer the one with evidence tier set
      traitMap.set(trait.trait_id, trait);
    }
  }

  // Add baseline longevity recommendations (Tier 1 from science/biology/longevity)
  // These apply to everyone regardless of genetic profile
  const baselineLongevityTraits: Array<{
    trait_id: string;
    score: number;
    confidence: number;
  }> = [
    { trait_id: "cardiovascular_fitness", score: 70, confidence: 0.95 }, // VO2max - everyone should work on this
    { trait_id: "muscular_strength", score: 70, confidence: 0.95 }, // Resistance training
    { trait_id: "sleep_longevity", score: 70, confidence: 0.95 }, // Sleep 7-9 hours
    { trait_id: "baseline_labs", score: 75, confidence: 0.9 }, // Annual labs
    { trait_id: "body_composition", score: 75, confidence: 0.85 }, // Waist circumference, DEXA
    { trait_id: "glucose_insulin_management", score: 75, confidence: 0.9 }, // Annual glucose/insulin
    { trait_id: "lipid_management", score: 75, confidence: 0.9 }, // Annual lipid panel + apoB
    { trait_id: "blood_pressure_control", score: 75, confidence: 0.9 }, // BP monitoring
    { trait_id: "caloric_restriction", score: 60, confidence: 0.75 }, // Moderate CR / time-restricted eating
    { trait_id: "intermittent_fasting", score: 60, confidence: 0.7 }, // IF protocols
    { trait_id: "apoB_management", score: 75, confidence: 0.9 }, // apoB as superior lipid marker
    { trait_id: "immune_rejuvenation", score: 60, confidence: 0.6 }, // Emerging immunosenescence reversal
    { trait_id: "brain_rejuvenation", score: 65, confidence: 0.75 }, // Brain anti-aging (exercise, sleep, cognition)
    { trait_id: "supplements_evidence", score: 70, confidence: 0.9 }, // Evidence-based supplement guidance
    { trait_id: "protein_homeostasis", score: 65, confidence: 0.8 }, // Proteostasis via heat shock, chaperones
    { trait_id: "senescence", score: 60, confidence: 0.75 }, // Cellular senescence / SASP burden
    { trait_id: "proteasome_autophagy", score: 65, confidence: 0.8 }, // Autophagy and protein clearance
    { trait_id: "genome_stability", score: 70, confidence: 0.85 }, // DNA repair capacity
    { trait_id: "epigenetic_maintenance", score: 60, confidence: 0.7 }, // Epigenetic drift / aging clocks
    { trait_id: "klotho_anti_aging", score: 60, confidence: 0.65 }, // Klotho levels and cognitive protection
    { trait_id: "mTOR_signaling", score: 60, confidence: 0.8 }, // mTOR pathway and rapamycin
  ];

  for (const trait of baselineLongevityTraits) {
    // Only add if not already present (genetic traits take priority)
    if (!traitMap.has(trait.trait_id)) {
      traitMap.set(trait.trait_id, trait);
    }
  }

  return Array.from(traitMap.values());
}

/**
 * Map ClinVar pathogenic/likely-pathogenic annotations to trait scores.
 * Pathogenic findings get low scores (more concerning); protective get high scores.
 *
 * Accepts Map<string,any>, ClinVarAnnotation[], or ClinVarEnrichmentResult.
 */
function mapClinVarToTraits(
  clinvarAnnotations: any
): Array<{ trait_id: string; score: number; confidence: number }> {
  if (!clinvarAnnotations) return [];

  // Normalize to entries: Array<[string, any]>
  let entries: Array<[string, any]>;

  if (Array.isArray(clinvarAnnotations)) {
    // Already an array of ClinVarAnnotation objects
    if (clinvarAnnotations.length === 0) return [];
    entries = clinvarAnnotations.map(
      (a: any) => [a.rsid || "", a] as [string, any]
    );
  } else if (Array.isArray(clinvarAnnotations.annotations)) {
    // ClinVarEnrichmentResult with annotations array
    const list: any[] = clinvarAnnotations.annotations;
    if (list.length === 0) return [];
    entries = list.map((a: any) => [a.rsid || "", a] as [string, any]);
  } else if (
    typeof clinvarAnnotations.size === "number" &&
    clinvarAnnotations.size > 0
  ) {
    // Map<string, any>
    entries = Array.from(clinvarAnnotations);
  } else {
    return [];
  }

  const traits: Array<{ trait_id: string; score: number; confidence: number }> =
    [];

  for (const [rsid, annotation] of entries) {
    const clinicalSig =
      annotation?.clinical_significance ||
      annotation?.clinicalSignificance ||
      "";
    const diseaseName =
      annotation?.disease_name ||
      annotation?.diseaseName ||
      annotation?.trait ||
      "";
    const gene = annotation?.gene_symbol || annotation?.gene || "";

    if (isStrictPathogenicClinVarSignificance(clinicalSig)) {
      // Detect carrier status: heterozygous pathogenic in recessive disease gene
      const geneSymbol = (
        annotation?.gene_symbol ||
        annotation?.gene ||
        ""
      ).toUpperCase();
      const isRecessive = isRecessiveDiseaseGene(geneSymbol);
      const isHeterozygous =
        !annotation?.zygosity || annotation?.zygosity === "Heterozygous";
      const isCarrier = isRecessive && isHeterozygous;

      // Map disease categories to trait IDs
      let traitId = "clinvar_pathogenic";
      if (/cancer|tumor|melanom|leukemia|lymphoma|sarcoma/i.test(diseaseName)) {
        traitId = "cancer_susceptibility";
      } else if (
        /heart|cardio|arrhythmia|aort|myopathy|brugada|long qt/i.test(
          diseaseName
        )
      ) {
        traitId = "cardiomyopathy_risk";
      } else if (
        /alzheimer|parkinson|dementia|huntington|als|neurodeg/i.test(
          diseaseName
        )
      ) {
        traitId = "neurodegeneration_risk";
      } else if (
        /lipid|cholesterol|hyperchol|ldl|apob|familial/i.test(diseaseName)
      ) {
        traitId = "lipid_disorder";
      } else if (/thrombo|clot|factor|hemophili|bleeding/i.test(diseaseName)) {
        traitId = "thrombosis_risk";
      } else if (/iron|hemochro/i.test(diseaseName)) {
        traitId = "iron_overload";
      }

      traits.push({
        trait_id: traitId,
        score: isCarrier ? 55 : 30, // Carrier = moderate/informational; homozygous = concerning
        confidence: 0.9,
      });
    } else if (clinicalSig.toLowerCase().includes("protective")) {
      traits.push({
        trait_id: `protective_${(rsid || "variant").toLowerCase()}`,
        score: 85, // Protective → high score
        confidence: 0.8,
      });
    }
  }

  return traits;
}

function isStrictPathogenicClinVarSignificance(significance: string): boolean {
  const normalized = significance.toLowerCase();
  if (!normalized.includes("pathogenic")) return false;
  if (normalized.includes("benign")) return false;
  if (normalized.includes("uncertain")) return false;
  if (normalized.includes("conflicting")) return false;
  if (normalized.includes("not provided")) return false;
  if (normalized.includes("association")) return false;
  if (normalized.includes("risk factor")) return false;
  return true;
}

/**
 * Map CPIC pharmacogenomic matches to pharmacology traits.
 * Level A matches (strongest evidence) get higher weight.
 */
function mapCPICToTraits(
  cpicResult: any
): Array<{ trait_id: string; score: number; confidence: number }> {
  if (!cpicResult || !cpicResult.matches || cpicResult.matches.length === 0)
    return [];
  if (cpicResult.totalFound === 0) return [];

  const traits: Array<{ trait_id: string; score: number; confidence: number }> =
    [];

  for (const match of cpicResult.matches || []) {
    const gene = match.gene || "";
    const level = match.cpicLevel || "";

    // Map CPIC genes to trait IDs
    let traitId = "drug_metabolism";
    if (/CYP2D6/i.test(gene)) {
      traitId = "cyp2d6_metabolism";
    } else if (/CYP2C19/i.test(gene)) {
      traitId = "cyp2c19_metabolism";
    } else if (/CYP2C9/i.test(gene)) {
      traitId = "cyp2c9_metabolism";
    } else if (/CYP3A/i.test(gene)) {
      traitId = "cyp3a_metabolism";
    } else if (/TPMT/i.test(gene)) {
      traitId = "thiopurine_toxicity";
    } else if (/DPYD/i.test(gene)) {
      traitId = "fluoropyrimidine_toxicity";
    } else if (/UGT1A1/i.test(gene)) {
      traitId = "irinotecan_toxicity";
    } else if (/SLCO1B1/i.test(gene)) {
      traitId = "statin_myopathy";
    } else if (/RYR1|CACNA1S/i.test(gene)) {
      traitId = "malignant_hyperthermia";
    } else if (/VKORC1/i.test(gene)) {
      traitId = "warfarin_sensitivity";
    } else if (/HLA/i.test(gene)) {
      traitId = "drug_hypersensitivity";
    }

    // Level A = highest evidence → more weight, lower score when actionable
    const score = level === "A" ? 40 : 50;
    traits.push({
      trait_id: traitId,
      score,
      confidence: level === "A" ? 0.95 : 0.8,
    });
  }

  return traits;
}

/**
 * Map VEP rare functional variants (HIGH/MODERATE impact, gnomAD AF < 0.01) to traits.
 */
function mapVEPToTraits(
  vepAnnotations: Map<string, VEPAnnotation> | undefined
): Array<{ trait_id: string; score: number; confidence: number }> {
  if (!vepAnnotations || vepAnnotations.size === 0) return [];

  const traits: Array<{ trait_id: string; score: number; confidence: number }> =
    [];

  for (const [key, ann] of vepAnnotations) {
    // Filter: only rare variants (gnomAD AF < 0.01) with HIGH or MODERATE impact
    if (ann.gnomadAF >= 0.01) continue;
    if (ann.impact !== "HIGH" && ann.impact !== "MODERATE") continue;

    const consequence = ann.consequence || "";
    const gene = (ann.gene || "").toLowerCase();

    // Map consequence types to trait IDs
    let traitId = "rare_functional_variant";
    let score = 40;

    if (/stop_gained|frameshift|splice/i.test(consequence)) {
      // Loss-of-function in known disease genes
      score = 25;
      if (/brca|p53|tp53|apc|mlh|msh|pms|rb1|pten|atm|chek/i.test(gene)) {
        traitId = "cancer_susceptibility";
      } else if (/ttn|myh|mybpc|tnnt|tpm|actc|lmna/i.test(gene)) {
        traitId = "cardiomyopathy_risk";
      } else if (/scn|kcnh|kcnq/i.test(gene)) {
        traitId = "arrhythmia_risk";
      } else if (/fbn|tgfb|smad|col3|acta/i.test(gene)) {
        traitId = "aortopathy_risk";
      } else {
        traitId = "rare_functional_variant";
      }
    } else if (/missense|inframe/i.test(consequence)) {
      score = 45;
      if (/ldlr|apob|pcsk9|lpa/i.test(gene)) {
        traitId = "lipid_disorder";
      } else if (/gck|hnf|kcnj|abcc/i.test(gene)) {
        traitId = "monogenic_diabetes";
      } else {
        traitId = "rare_functional_variant";
      }
    }

    traits.push({
      trait_id: traitId,
      score,
      confidence: ann.impact === "HIGH" ? 0.9 : 0.75,
    });
  }

  return traits;
}

/**
 * Merge trait scores from multiple sources.
 * When the same trait_id appears in multiple sources, prefer the lower (more concerning) score.
 * Preserves evidenceTier and confidence from the lowest-scoring entry.
 */
function mergeTraitScores(
  existing: Array<{
    trait_id: string;
    score: number;
    confidence: number;
    evidenceTier?: 1 | 2 | 3;
  }>,
  ...additional: Array<
    Array<{
      trait_id: string;
      score: number;
      confidence: number;
      evidenceTier?: 1 | 2 | 3;
    }>
  >
): Array<{
  trait_id: string;
  score: number;
  confidence: number;
  evidenceTier?: 1 | 2 | 3;
}> {
  const merged = new Map<
    string,
    {
      trait_id: string;
      score: number;
      confidence: number;
      evidenceTier?: 1 | 2 | 3;
    }
  >();

  for (const trait of existing) {
    merged.set(trait.trait_id, trait);
  }

  for (const batch of additional) {
    for (const trait of batch) {
      const current = merged.get(trait.trait_id);
      if (!current || trait.score < current.score) {
        // Prefer the lower (more concerning) score
        merged.set(trait.trait_id, {
          trait_id: trait.trait_id,
          score: trait.score,
          confidence: Math.max(trait.confidence, current?.confidence || 0),
          evidenceTier: trait.evidenceTier || current?.evidenceTier,
        });
      } else if (
        trait.score === (current?.score || Infinity) &&
        trait.evidenceTier !== undefined &&
        current?.evidenceTier === undefined
      ) {
        merged.set(trait.trait_id, {
          ...trait,
          confidence: Math.max(trait.confidence, current.confidence),
        });
      }
    }
  }

  return Array.from(merged.values());
}

/**
 * Map clinical significance to a color badge for the variant card UI.
 */
function significanceToColor(significance: string): SignificanceColor {
  const s = significance.toLowerCase();
  if (isStrictPathogenicClinVarSignificance(s)) return "red";
  if (s.includes("drug")) return "purple";
  if (s.includes("uncertain")) return "orange";
  if (s.includes("benign") || s.includes("protective")) return "green";
  if (s.includes("risk")) return "orange";
  return "blue";
}

function confidenceTierLabel(tier?: ClinVarConfidenceTier): string {
  switch (tier) {
    case "pathogenic_likely_pathogenic":
      return "Pathogenic / likely pathogenic";
    case "drug_response":
      return "Drug response";
    case "risk_factor_protective":
      return "Risk factor / protective";
    case "vus":
      return "Variant of uncertain significance";
    case "benign":
      return "Benign / likely benign";
    case "conflicting_classifications":
      return "Conflicting classifications";
    default:
      return "Other ClinVar classification";
  }
}

function countClinVarConfidenceTiers(
  annotations?: ClinVarAnnotation[]
): Partial<Record<ClinVarConfidenceTier, number>> {
  const counts: Partial<Record<ClinVarConfidenceTier, number>> = {};
  for (const annotation of annotations ?? []) {
    const tier = annotation.confidenceTier ?? "other";
    counts[tier] = (counts[tier] ?? 0) + 1;
  }
  return counts;
}

/**
 * Build ClinVar variant cards from annotations and genotypes.
 * This function takes the ClinVar annotations from analyzeVCF results
 * and organizes them into the 5 Dante Labs-inspired categories.
 */
function buildClinVarVariantCards(
  clinvarAnnotations: Map<string, any> | any | undefined,
  genotypes: Map<string, string> | undefined,
  vepAnnotations?: Map<string, any> | undefined
): GeneticVariantsSection {
  const cards: GeneticVariantsSection = {
    genetic_conditions: [],
    drug_response: [],
    other_risks: [],
    rare_mutations: [],
    uncommon_mutations: [],
  };

  if (!clinvarAnnotations) return cards;

  // Handle Map<string, any>, ClinVarAnnotation[], or ClinVarEnrichmentResult
  let annotationEntries: Array<[string, any]>;
  if (Array.isArray(clinvarAnnotations)) {
    // Plain array of ClinVarAnnotation objects
    if (clinvarAnnotations.length === 0) return cards;
    annotationEntries = clinvarAnnotations.map(
      (a: any) => [a.rsid || "", a] as [string, any]
    );
  } else if (Array.isArray(clinvarAnnotations.annotations)) {
    // ClinVarEnrichmentResult with annotations array
    const list: any[] = clinvarAnnotations.annotations;
    if (list.length === 0) return cards;
    annotationEntries = list.map(
      (a: any) => [a.rsid || "", a] as [string, any]
    );
  } else if (
    typeof clinvarAnnotations.size === "number" &&
    clinvarAnnotations.size > 0
  ) {
    // Map-like object
    annotationEntries = Array.from(clinvarAnnotations as Map<string, any>);
  } else {
    return cards;
  }

  for (const [rsid, raw] of annotationEntries) {
    const annotation: ClinVarAnnotation = {
      rsid: raw.rsid || rsid,
      clinicalSignificance:
        raw.clinicalSignificance || raw.clinical_significance || "not_provided",
      diseaseName:
        raw.diseaseName || raw.disease_name || raw.trait || "not_specified",
      geneInfo: raw.geneInfo || raw.gene_symbol || raw.gene || "",
      reviewStatus: raw.reviewStatus || raw.review_status || "no_assertion",
      gnomadAF: raw.gnomadAF !== undefined ? raw.gnomadAF : raw.gnomad_af,
      isRare: raw.isRare !== undefined ? raw.isRare : raw.is_rare,
      isACMG: raw.isACMG !== undefined ? raw.isACMG : raw.is_acmg,
      acmgCondition: raw.acmgCondition || raw.acmg_condition,
      acmgRecommendation: raw.acmgRecommendation || raw.acmg_recommendation,
      populationFrequency: raw.populationFrequency || raw.population_frequency,
      evidenceTier: raw.evidenceTier || raw.evidence_tier,
      confidenceTier: raw.confidenceTier || raw.confidence_tier,
    };

    // Determine zygosity from genotype
    const gt = genotypes?.get(rsid) || genotypes?.get(`rs${rsid}`) || "";
    let zygosity: "Homozygous" | "Heterozygous" = "Heterozygous";
    if (gt) {
      const [a1, a2] = gt.replace(/[|/]/g, "/").split("/");
      if (a1 && a2 && a1 !== "0" && a2 !== "0" && a1 === a2) {
        zygosity = "Homozygous";
      }
    }

    // Get CADD score from VEP if available
    let caddScore: number | undefined;
    if (vepAnnotations) {
      for (const [key, vep] of vepAnnotations) {
        if (
          (vep.rsid || "").toString() === rsid.toString() ||
          key.includes(rsid.toString())
        ) {
          if (vep.cadd_phred !== undefined) caddScore = vep.cadd_phred;
          if (vep.cadd_raw !== undefined && caddScore === undefined)
            caddScore = vep.cadd_raw;
          break;
        }
      }
    }

    // Generate consumer annotation
    const consumerAnnotation = generateVariantAnnotation(
      annotation,
      zygosity,
      caddScore
    );

    // Categorize
    const category = categorizeVariantForTab(annotation);

    const gene =
      annotation.geneInfo.split(":")[0] ||
      annotation.geneInfo.split("|")[0] ||
      "Unknown";
    const disease =
      annotation.diseaseName
        .replace(/_/g, " ")
        .replace(/not_specified|not provided/i, "")
        .trim() || "Not specified";
    const frequency =
      annotation.populationFrequency ||
      (annotation.isRare ? "Rare (<1%)" : "Common (>5%)");

    const card: ClinVarVariantCard = {
      gene,
      rsid: annotation.rsid,
      disease,
      clinicalSignificance: annotation.clinicalSignificance.replace(/_/g, " "),
      confidenceTier: annotation.confidenceTier,
      confidenceLabel: confidenceTierLabel(annotation.confidenceTier),
      significanceColor: significanceToColor(annotation.clinicalSignificance),
      category,
      zygosity,
      frequency,
      caddScore,
      annotation: consumerAnnotation,
      reviewStatus: annotation.reviewStatus,
    };

    cards[category].push(card);
  }

  return cards;
}

/**
 * Run the complete WGS pipeline on a VCF file.
 * This orchestrates: analyzeVCF → transform → trait pipeline → GLI → dashboard
 * Uses direct function import instead of spawning a subprocess.
 */
/**
 * Pipeline step error tracker — collects errors without halting the pipeline.
 */
interface PipelineError {
  step: string;
  error: string;
}

export async function runPipelineFromVCF(
  vcfPath: string,
  userId: string = "user_001",
  logDir?: string,
  options: { dbsnpPath?: string; wgsArtifactsDir?: string } = {}
): Promise<DashboardOutput> {
  const startTime = Date.now();
  const errors: PipelineError[] = [];
  const steps: Array<{
    step: string;
    start: number;
    duration_ms: number;
    status: "ok" | "error";
  }> = [];
  const markStart = (step: string) => {
    const s = Date.now();
    steps.push({ step, start: s, duration_ms: 0, status: "ok" });
    return s;
  };
  const markEnd = (start: number, status: "ok" | "error" = "ok") => {
    const s = steps[steps.length - 1];
    if (s) {
      s.duration_ms = Date.now() - start;
      s.status = status;
    }
  };
  let enrichedTraits: EnrichedTrait[] = [];
  let priorities: PriorityResult[] = [];
  let insights: Insight[] = [];
  let protocols: Protocol[] = [];
  let gli = 0;
  let gliRating = getGLIRating(0);
  let categoryGli: Record<string, number> = {};
  let topTraits: Array<{
    trait_id: string;
    score: number;
    confidence: number;
    mechanism: string;
  }> = [];
  let hallmark: HallmarkReport = {
    hallmarks: [],
    total_genes_hit: 0,
    hallmarks_affected: 0,
    summary: "",
  };
  let variantCards: GeneticVariantsSection = {
    genetic_conditions: [],
    drug_response: [],
    other_risks: [],
    rare_mutations: [],
    uncommon_mutations: [],
  };
  let prsScores: PRSScore[] = [];
  let gwasTraits: GWASTraitSection | undefined;
  let cpicMatches: import("./cpic_enrichment.js").CPICMatch[] = [];
  let vepMissenseCalls: MissenseCall[] = [];
  let vepMissenseGenesFound: string[] = [];
  let vepMissenseCount = 0;
  let vepMissenseDamaging = 0;
  let protocol: LongevityProtocol;
  const wgsReadiness = refreshWgsReadinessArtifacts(undefined, options.wgsArtifactsDir);
  const localVcfCoverage = readLocalVcfCoverage();
  if (wgsReadiness.errors.length > 0) {
    errors.push({
      step: "wgs_readiness_preflight",
      error: wgsReadiness.errors.join("; "),
    });
  }

  // Step 1: Run the local genetic ingestion path (fatal if it fails)
  console.log("Running local genetic ingestion...");
  let s1 = markStart("analyze_vcf");
  let result: Awaited<ReturnType<typeof analyzeVCF>>;
  try {
    const vcfDoctor = runVcfDoctor(vcfPath);
    if (vcfDoctor.warnings.length > 0) {
      console.log("   VCF doctor warnings:");
      for (const warning of vcfDoctor.warnings) console.log(`   - ${warning}`);
      console.log(`   Recommendation: ${vcfDoctor.recommendation}`);
    }

    // analyzeVCF validates an existing annotated sibling before reusing it.
    // Passing the original path prevents a zero-rsID artifact from being
    // trusted merely because it has an `.annotated.vcf.gz` filename.
    result = await analyzeVCF(vcfPath, {
      save: false,
      dbsnpPath: options.dbsnpPath,
    });
    protocol = result.protocol;
    markEnd(s1);
  } catch (err: any) {
    markEnd(s1, "error");
    console.error(`❌ Pipeline fatal error (VCF analysis): ${err.message}`);
    throw new Error(`VCF analysis failed: ${err.message}`);
  }

  // Step 2: Transform LongevityProtocol to trait scores
  console.log("📊 Transforming protocol to trait scores...");
  let s2 = markStart("trait_mapping");
  let traitScores: Array<{
    trait_id: string;
    score: number;
    confidence: number;
    evidenceTier?: 1 | 2 | 3;
  }> = [];
  let curatedMarkerCount = 0;
  let vepRareCount = 0;
  let clinvarPathogenicCount = 0;
  let cpicActionableCount = 0;
  try {
    traitScores = mapProtocolToTraits(protocol);

    // Map ClinVar annotations to traits
    if (result.clinvarAnnotations && result.clinvarAnnotations.length > 0) {
      const clinvarTraits = mapClinVarToTraits(result.clinvarAnnotations);
      clinvarPathogenicCount = result.clinvarAnnotations.filter(
        (annotation: any) =>
          isStrictPathogenicClinVarSignificance(
            annotation?.clinical_significance ||
              annotation?.clinicalSignificance ||
              ""
          )
      ).length;
      traitScores = mergeTraitScores(traitScores, clinvarTraits);
    }

    // Map CPIC matches to traits
    if (result.allGenotypes && result.allGenotypes.size > 0) {
      const cpicUserGenotypes: Array<{ rsid: string; genotype: string }> = [];
      for (const [rsid, gt] of result.allGenotypes) {
        cpicUserGenotypes.push({ rsid, genotype: gt });
      }
      const cpicResult = matchCPIC(cpicUserGenotypes);
      const cpicTraits = mapCPICToTraits(cpicResult);
      cpicActionableCount = cpicResult?.matches?.length || 0;
      cpicMatches = cpicResult?.matches ?? [];
      traitScores = mergeTraitScores(traitScores, cpicTraits);
    }

    // Map VEP rare variants to traits
    if (result.vepAnnotations && result.vepAnnotations.size > 0) {
      const rareVariants = new Map<string, VEPAnnotation>();
      for (const [key, ann] of result.vepAnnotations) {
        if (
          ann.gnomadAF < 0.01 &&
          (ann.impact === "HIGH" || ann.impact === "MODERATE")
        ) {
          rareVariants.set(key, ann);
        }
      }
      vepRareCount = rareVariants.size;
      const vepTraits = mapVEPToTraits(rareVariants);
      traitScores = mergeTraitScores(traitScores, vepTraits);

      // VEP Missense enrichment: annotate all missense variants in longevity genes
      // (not just rare ones — common functional variants matter for healthspan)
      const vepMissenseResult = enrichVEPMissenseLongevity(
        result.vepAnnotations,
        result.allGenotypes
      );
      if (vepMissenseResult.longevityGeneHits > 0) {
        console.log(
          `   VEP missense: ${vepMissenseResult.longevityGeneHits} missense variants in ${vepMissenseResult.genesFound.length} longevity genes (${vepMissenseResult.damagingCalls} damaging)`
        );
        const missenseTraits = mapVEPMissenseToTraits(vepMissenseResult);
        traitScores = mergeTraitScores(traitScores, missenseTraits);
        vepMissenseCalls = vepMissenseResult.calls;
        vepMissenseGenesFound = vepMissenseResult.genesFound;
        vepMissenseCount = vepMissenseResult.longevityGeneHits;
        vepMissenseDamaging = vepMissenseResult.damagingCalls;
      }
    }

    // Count curated markers from the protocol
    curatedMarkerCount =
      (protocol.genomicProfile?.alerts?.length || 0) +
      (protocol.genomicProfile?.topRisks?.length || 0) +
      (protocol.genomicProfile?.superpowers?.length || 0);

    markEnd(s2);
  } catch (err: any) {
    markEnd(s2, "error");
    errors.push({ step: "trait_mapping", error: err.message });
    console.error(`   ⚠️  Trait mapping failed: ${err.message}`);
  }

  // Step 2b: Build variant cards and compute PRS
  console.log("🧬 Building variant cards and computing PRS...");
  let s2b = markStart("variant_cards_prs");
  try {
    variantCards = buildClinVarVariantCards(
      result.clinvarAnnotations,
      result.allGenotypes,
      result.vepAnnotations
    );

    // Compute PRS from genotype map
    if (result.allGenotypes && result.allGenotypes.size > 0) {
      prsScores = computePRS(result.allGenotypes).scores;
    }

    // Compute GWAS trait associations
    if (result.allGenotypes && result.allGenotypes.size > 0) {
      try {
        const gwasResult = computeGWASHits(
          result.allGenotypes,
          getGWASRefDir()
        );
        if (gwasResult.referencePresent) {
          gwasTraits = {
            totalHits: gwasResult.totalHits,
            totalRsidsScanned: gwasResult.totalRsidsScanned,
            referencePresent: true,
            sourceName: gwasResult.sourceName,
            sourceRelease: gwasResult.sourceRelease,
            genomeBuild: gwasResult.genomeBuild,
            ancestryDisclosure: gwasResult.ancestryDisclosure,
            buildDisclosure: gwasResult.buildDisclosure,
            coverageDisclosure: gwasResult.coverageDisclosure,
            domains: gwasResult.domains.map((d) => ({
              domain: d.domain,
              label: d.label,
              hitCount: d.hitCount,
              netSignal: d.netSignal,
              topHits: d.hits.slice(0, 20).map((h) => ({
                rsid: h.rsid,
                gene: h.gene,
                trait: h.trait,
                effectDirection: h.effectDirection,
                copiesOfEffectAllele: h.copiesOfEffectAllele,
                or: h.or,
                p: h.p,
                n: h.n,
                magnitudeLabel: h.magnitudeLabel,
                interpretation: h.interpretation,
                confidenceTier: h.confidenceTier,
                sourceType: h.sourceType,
                sourceId: h.sourceId,
                sourceUrl: h.sourceUrl,
                sourceRelease: h.sourceRelease,
                genomeBuild: h.genomeBuild,
              })),
            })),
          };
          console.log(
            `   GWAS: ${gwasResult.totalHits} associations across ${gwasResult.domains.length} domains`
          );
        } else {
          console.log(
            "   GWAS: reference not found (run scripts/reference-build/build-gwas-reference.ts to build)"
          );
        }
      } catch (gwasErr: any) {
        console.warn(`   GWAS: skipped — ${gwasErr.message}`);
      }
    }

    const totalVariants =
      variantCards.genetic_conditions.length +
      variantCards.drug_response.length +
      variantCards.other_risks.length +
      variantCards.rare_mutations.length +
      variantCards.uncommon_mutations.length;

    console.log(`   Variants: ${totalVariants} across 5 categories`);
    if (prsScores.length > 0) {
      console.log(`   PRS: ${prsScores.length} disease scores computed`);
    }
    markEnd(s2b);
  } catch (err: any) {
    markEnd(s2b, "error");
    errors.push({ step: "variant_cards_prs", error: err.message });
    console.error(`   ⚠️  Variant card building failed: ${err.message}`);
  }

  // Step 3: Enrich with knowledge graph
  console.log("🔗 Resolving knowledge graph...");
  let s3 = markStart("graph_resolver");
  try {
    enrichedTraits = enrichTraits(traitScores);
    markEnd(s3);
  } catch (err: any) {
    markEnd(s3, "error");
    errors.push({ step: "graph_resolver", error: err.message });
    console.error(`   ⚠️  Knowledge graph enrichment failed: ${err.message}`);
  }

  // Step 4: Compute priorities
  console.log("⚡ Computing priorities...");
  let s4 = markStart("priority_engine");
  try {
    priorities = computeAllPriorities(enrichedTraits);
    markEnd(s4);
  } catch (err: any) {
    markEnd(s4, "error");
    errors.push({ step: "priority_engine", error: err.message });
    console.error(`   ⚠️  Priority computation failed: ${err.message}`);
  }

  // Step 5: Generate insights
  console.log("💡 Generating insights...");
  let s5 = markStart("insight_engine");
  try {
    insights = generateInsights(enrichedTraits);
    markEnd(s5);
  } catch (err: any) {
    markEnd(s5, "error");
    errors.push({ step: "insight_engine", error: err.message });
    console.error(`   ⚠️  Insight generation failed: ${err.message}`);
  }

  // Step 6: Generate protocols
  console.log("📋 Generating protocols...");
  let s6 = markStart("protocol_engine");
  try {
    protocols = generateProtocols(enrichedTraits);
    markEnd(s6);
  } catch (err: any) {
    markEnd(s6, "error");
    errors.push({ step: "protocol_engine", error: err.message });
    console.error(`   ⚠️  Protocol generation failed: ${err.message}`);
  }

  // Step 7: Compute GLI
  console.log("🎯 Computing GLI...");
  let s7 = markStart("gli_engine");
  try {
    gli = computeWeightedGLI(enrichedTraits);
    gliRating = getGLIRating(gli);
    categoryGli = computeWeightedCategoryGLI(enrichedTraits);
    markEnd(s7);
  } catch (err: any) {
    markEnd(s7, "error");
    errors.push({ step: "gli_engine", error: err.message });
    console.error(`   ⚠️  GLI computation failed: ${err.message}`);
  }

  // Step 8: Get top traits (sorted by priority)
  let s8 = markStart("top_traits");
  try {
    topTraits = priorities.slice(0, 5).map((p) => {
      const trait = enrichedTraits.find((t) => t.trait_id === p.trait_id);
      return trait
        ? {
            trait_id: trait.trait_id,
            score: trait.score,
            confidence: trait.confidence,
            mechanism: trait.mechanism || "",
          }
        : { trait_id: p.trait_id, score: 0, confidence: 0, mechanism: "" };
    });
    markEnd(s8);
  } catch (err: any) {
    markEnd(s8, "error");
    errors.push({ step: "top_traits", error: err.message });
    console.error(`   ⚠️  Top traits extraction failed: ${err.message}`);
  }

  // Step 9: Compute hallmark pathway scores
  console.log("🧬 Computing hallmark pathway scores...");
  let s9 = markStart("hallmark_engine");
  try {
    const matchedGenes: string[] = [];
    for (const alert of protocol.genomicProfile.alerts) {
      if (!matchedGenes.includes(alert.gene)) matchedGenes.push(alert.gene);
    }
    for (const risk of protocol.genomicProfile.topRisks) {
      const geneName = risk.itemName.split(" ")[0];
      if (!matchedGenes.includes(geneName)) matchedGenes.push(geneName);
    }
    for (const sp of protocol.genomicProfile.superpowers) {
      const geneName = sp.itemName.split(" ")[0];
      if (!matchedGenes.includes(geneName)) matchedGenes.push(geneName);
    }
    hallmark = computeHallmarkScores(
      matchedGenes,
      protocol.genomicProfile.alerts,
      protocol.genomicProfile.topRisks,
      protocol.genomicProfile.superpowers
    );
    markEnd(s9);
    console.log(`   Hallmarks affected: ${hallmark.hallmarks_affected}/9`);
  } catch (err: any) {
    markEnd(s9, "error");
    errors.push({ step: "hallmark_engine", error: err.message });
    console.error(`   ⚠️  Hallmark computation failed: ${err.message}`);
  }

  // Collect the HGNC gene set the user's VCF actually touched, across every
  // gene-bearing surface the pipeline has produced so far. The condition catalog
  // surfaces conditions whose gene panel intersects this set.
  const userGeneSet = new Set<string>();
  const collectGene = (g: string | null | undefined) => {
    if (!g) return;
    for (const token of String(g).split(/[\s,;|/]+/)) {
      const symbol = token.trim().toUpperCase();
      if (symbol && symbol !== "UNKNOWN") userGeneSet.add(symbol);
    }
  };
  for (const card of [
    ...variantCards.genetic_conditions,
    ...variantCards.drug_response,
    ...variantCards.other_risks,
    ...variantCards.rare_mutations,
    ...variantCards.uncommon_mutations,
  ])
    collectGene(card.gene);
  for (const a of protocol.genomicProfile.alerts) collectGene(a.gene);
  for (const sp of protocol.genomicProfile.superpowers) collectGene(sp.gene);
  for (const g of vepMissenseGenesFound ?? []) collectGene(g);
  let conditionCatalogMatches: CatalogMatchSummary | undefined;
  let conditionCatalogFindings: CatalogFindings | undefined;
  try {
    conditionCatalogMatches = surfaceAcrossModalities(userGeneSet);
  } catch (e) {
    // Catalog surfacing is enrichment, not core — never let it crash the pipeline.
    console.warn(`condition catalog surfacing failed: ${(e as Error).message}`);
  }
  try {
    conditionCatalogFindings = resolveCatalogEvidence({
      userGenes: userGeneSet,
      clinvarAnnotations: result.clinvarAnnotations,
      cpicMatches,
      prsScores,
      gwasTraits,
      userGenotypes: result.allGenotypes,
    });
  } catch (e) {
    console.warn(`catalog evidence resolution failed: ${(e as Error).message}`);
  }

  const output: DashboardOutput = {
    gli,
    gli_rating: gliRating.rating,
    category_gli: categoryGli,
    top_traits: topTraits,
    traits: enrichedTraits,
    priorities,
    insights,
    protocols,
    hallmark,
    metadata: {
      user_id: userId,
      processed_at: new Date().toISOString(),
      trait_count: enrichedTraits.length,
      insight_count: insights.length,
      protocol_count: protocols.length,
      hallmark_count: hallmark.hallmarks_affected,
      variant_count: protocol.source.variantCount,
      annotated_count: protocol.source.annotatedCount,
      matched_marker_count:
        protocol.source.matchedMarkerCount ?? result.variants.length,
      curated_markers: curatedMarkerCount,
      vep_rare_variants: vepRareCount,
      clinvar_pathogenic: clinvarPathogenicCount,
      cpic_actionable: cpicActionableCount,
      variant_tab_count:
        variantCards.genetic_conditions.length +
        variantCards.drug_response.length +
        variantCards.other_risks.length +
        variantCards.rare_mutations.length +
        variantCards.uncommon_mutations.length,
      variant_cards: variantCards,
      rsid_annotation_source:
        protocol.source.rsidAnnotationSource ?? result.rsidAnnotationSource,
      rsid_annotation_limitation:
        protocol.source.rsidAnnotationLimitation ??
        result.rsidAnnotationLimitation,
      clinvar_confidence_counts: countClinVarConfidenceTiers(
        result.clinvarAnnotations
      ),
      prs_scores: prsScores,
      gwas_traits: gwasTraits,
      vep_missense_calls: vepMissenseCalls,
      vep_missense_genes: vepMissenseGenesFound,
      vep_missense_count: vepMissenseCount,
      vep_missense_damaging: vepMissenseDamaging,
      vep_status: result.vepAnnotations ? "included" : "skipped",
      vep_annotation_count: result.vepAnnotations?.size || 0,
      wgs_validation_coverage: buildWgsValidationCoverage(undefined, options.wgsArtifactsDir),
      local_vcf_coverage: localVcfCoverage,
      condition_catalog_matches: conditionCatalogMatches,
      condition_catalog_findings: conditionCatalogFindings,
    },
  };

  const elapsed = Date.now() - startTime;
  if (errors.length > 0) {
    console.log(
      `⚠️  Pipeline complete with ${errors.length} degraded step(s) in ${elapsed}ms`
    );
    for (const e of errors) {
      console.log(`   - ${e.step}: ${e.error}`);
    }
  } else {
    console.log(`✅ Pipeline complete in ${elapsed}ms`);
  }
  console.log(`   GLI: ${gli} (${gliRating.rating})`);
  console.log(`   Traits: ${output.metadata.trait_count}`);
  console.log(`   Insights: ${output.metadata.insight_count}`);
  console.log(`   Protocols: ${output.metadata.protocol_count}`);

  // Write pipeline run log
  if (logDir) {
    try {
      const logger = new PipelineLogger(logDir, userId);
      for (const s of steps) {
        if (s.status === "error") {
          const errMsg =
            errors.find((e) => e.step === s.step)?.error || "unknown";
          logger.logEntry({
            step: s.step,
            duration_ms: s.duration_ms,
            status: "error",
            error: errMsg,
            timestamp: new Date().toISOString(),
          });
        } else {
          logger.logEntry({
            step: s.step,
            duration_ms: s.duration_ms,
            status: "ok",
            timestamp: new Date().toISOString(),
          });
        }
      }
      logger.close();
    } catch {
      // Log file write should never crash the pipeline
    }
  }

  return output;
}

/**
 * Run pipeline from existing LongevityProtocol JSON (for testing/debugging)
 */
export function runPipelineFromProtocol(
  protocol: LongevityProtocol,
  userId: string = "user_001"
): DashboardOutput {
  const errors: PipelineError[] = [];

  // Step 2: Transform protocol to trait scores
  let traitScores: Array<{
    trait_id: string;
    score: number;
    confidence: number;
    evidenceTier?: 1 | 2 | 3;
  }> = [];
  try {
    traitScores = mapProtocolToTraits(protocol);
  } catch (err: any) {
    errors.push({ step: "trait_mapping", error: err.message });
  }

  // Step 3: Enrich with knowledge graph
  let enrichedTraits: EnrichedTrait[] = [];
  try {
    enrichedTraits = enrichTraits(traitScores);
  } catch (err: any) {
    errors.push({ step: "graph_resolver", error: err.message });
  }

  // Step 4: Compute priorities
  let priorities: PriorityResult[] = [];
  try {
    priorities = computeAllPriorities(enrichedTraits);
  } catch (err: any) {
    errors.push({ step: "priority_engine", error: err.message });
  }

  // Step 5: Generate insights
  let insights: Insight[] = [];
  try {
    insights = generateInsights(enrichedTraits);
  } catch (err: any) {
    errors.push({ step: "insight_engine", error: err.message });
  }

  // Step 6: Generate protocols
  let protocols: Protocol[] = [];
  try {
    protocols = generateProtocols(enrichedTraits);
  } catch (err: any) {
    errors.push({ step: "protocol_engine", error: err.message });
  }

  // Step 7: Compute GLI
  let gli = 0;
  let gliRating = getGLIRating(0);
  let categoryGli: Record<string, number> = {};
  try {
    gli = computeWeightedGLI(enrichedTraits);
    gliRating = getGLIRating(gli);
    categoryGli = computeWeightedCategoryGLI(enrichedTraits);
  } catch (err: any) {
    errors.push({ step: "gli_engine", error: err.message });
  }

  // Step 8: Top traits
  let topTraits: Array<{
    trait_id: string;
    score: number;
    confidence: number;
    mechanism: string;
  }> = [];
  try {
    topTraits = priorities.slice(0, 5).map((p) => {
      const trait = enrichedTraits.find((t) => t.trait_id === p.trait_id);
      return trait
        ? {
            trait_id: trait.trait_id,
            score: trait.score,
            confidence: trait.confidence,
            mechanism: trait.mechanism || "",
          }
        : { trait_id: p.trait_id, score: 0, confidence: 0, mechanism: "" };
    });
  } catch (err: any) {
    errors.push({ step: "top_traits", error: err.message });
  }

  // Step 9: Hallmark scores
  let hallmark: HallmarkReport = {
    hallmarks: [],
    total_genes_hit: 0,
    hallmarks_affected: 0,
    summary: "",
  };
  try {
    const matchedGenes: string[] = [];
    for (const alert of protocol.genomicProfile.alerts) {
      if (!matchedGenes.includes(alert.gene)) matchedGenes.push(alert.gene);
    }
    for (const risk of protocol.genomicProfile.topRisks) {
      const geneName = risk.itemName.split(" ")[0];
      if (!matchedGenes.includes(geneName)) matchedGenes.push(geneName);
    }
    for (const sp of protocol.genomicProfile.superpowers) {
      const geneName = sp.itemName.split(" ")[0];
      if (!matchedGenes.includes(geneName)) matchedGenes.push(geneName);
    }
    hallmark = computeHallmarkScores(
      matchedGenes,
      protocol.genomicProfile.alerts,
      protocol.genomicProfile.topRisks,
      protocol.genomicProfile.superpowers
    );
  } catch (err: any) {
    errors.push({ step: "hallmark_engine", error: err.message });
  }

  const wgsReadiness = refreshWgsReadinessArtifacts();
  const localVcfCoverage = readLocalVcfCoverage();
  if (wgsReadiness.errors.length > 0) {
    errors.push({
      step: "wgs_readiness_preflight",
      error: wgsReadiness.errors.join("; "),
    });
  }

  if (errors.length > 0) {
    console.warn(
      `⚠️  Pipeline completed with ${errors.length} degraded step(s):`
    );
    for (const e of errors) {
      console.warn(`   - ${e.step}: ${e.error}`);
    }
  }

  // Surface catalog matches from the protocol's alert/superpower gene set
  // (no variant_cards available in this path).
  const protocolGeneSet = new Set<string>();
  for (const a of protocol.genomicProfile.alerts)
    if (a.gene) protocolGeneSet.add(a.gene.toUpperCase());
  for (const sp of protocol.genomicProfile.superpowers)
    if (sp.gene) protocolGeneSet.add(sp.gene.toUpperCase());
  let conditionCatalogMatches: CatalogMatchSummary | undefined;
  try {
    conditionCatalogMatches = surfaceAcrossModalities(protocolGeneSet);
  } catch (e) {
    console.warn(`condition catalog surfacing failed: ${(e as Error).message}`);
  }

  return {
    gli,
    gli_rating: gliRating.rating,
    category_gli: categoryGli,
    top_traits: topTraits,
    traits: enrichedTraits,
    priorities,
    insights,
    protocols,
    hallmark,
    metadata: {
      user_id: userId,
      processed_at: new Date().toISOString(),
      trait_count: enrichedTraits.length,
      insight_count: insights.length,
      protocol_count: protocols.length,
      hallmark_count: hallmark.hallmarks_affected,
      variant_count: 0,
      annotated_count: 0,
      matched_marker_count: 0,
      curated_markers: 0,
      vep_rare_variants: 0,
      clinvar_pathogenic: 0,
      cpic_actionable: 0,
      variant_tab_count: 0,
      variant_cards: {
        genetic_conditions: [],
        drug_response: [],
        other_risks: [],
        rare_mutations: [],
        uncommon_mutations: [],
      },
      prs_scores: [],
      vep_status: "skipped",
      vep_annotation_count: 0,
      wgs_validation_coverage: buildWgsValidationCoverage(),
      local_vcf_coverage: localVcfCoverage,
      condition_catalog_matches: conditionCatalogMatches,
    },
  };
}

/**
 * Save pipeline output to dashboard.json
 */
export function savePipelineOutput(
  output: DashboardOutput,
  userId: string,
  outputDir: string
): string {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const dashboardPath = path.join(outputDir, `${userId}_dashboard.json`);
  fs.writeFileSync(dashboardPath, JSON.stringify(output, null, 2));
  console.log(`📄 Dashboard saved: ${dashboardPath}`);

  return dashboardPath;
}

export function printDailyActionPlanCronPrompt(outputDir: string): void {
  const dashboardPath = path.join(path.resolve(outputDir), "index.html");
  console.log("");
  console.log("Daily action plan automation:");
  console.log(
    "Ask the user: Do you want to set up a recurring cron job so your agent reviews the latest dashboard and generates a daily action plan?"
  );
  console.log(`Dashboard context: ${dashboardPath}`);
  console.log(
    "Only add cron after explicit opt-in, with the exact agent command, schedule, output location, and local data paths confirmed."
  );
}

// ============================================================================
// Dashboard HTML Rendering
// ============================================================================

function capitalizeWords(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function scoreToStatusColor(score: number): StatusColor {
  if (score >= 75) return "optimal";
  if (score >= 55) return "neutral";
  if (score >= 35) return "moderate";
  return "critical";
}

function statusColorToLabel(color: StatusColor): string {
  switch (color) {
    case "optimal":
      return "Optimal";
    case "neutral":
      return "Good";
    case "moderate":
      return "Fair";
    case "critical":
      return "At Risk";
  }
}

/**
 * Map trait-level category_gli keys to the 6 standard dashboard categories.
 * Groups individual trait IDs into their parent category and averages scores.
 */
function mapCategoryGLI(
  categoryGli: Record<string, number>
): Record<string, number> {
  const groups: Record<string, number[]> = {
    vulnerability: [],
    pharmacology: [],
    hereditary: [],
    traits: [],
    wellness: [],
    ancestry: [],
  };

  for (const [key, score] of Object.entries(categoryGli)) {
    const k = key.toLowerCase();
    // Vulnerability: disease risks, inflammation, cardiovascular, lipids, DNA repair
    if (
      /cholesterol|lipid_metab|apob|pcsk9|ldlr|inflamm|cardiovascular|endothelial|blood_pressure|apoB|dna(?!_repair)/i.test(
        k
      )
    ) {
      groups.vulnerability.push(score);
    } else if (
      /dna_repair|genome_stability|telomere|senescence|oncogene/i.test(k)
    ) {
      groups.vulnerability.push(score);
    } else if (/thrombos|clotting|cancer_suscept|neurodeg|alzheimer/i.test(k)) {
      groups.vulnerability.push(score);
    } else if (
      /cardiomyopathy|arrhythmia|aortopathy|cardiotoxicity|long_qt/i.test(k)
    ) {
      groups.vulnerability.push(score);
    } else if (/monogenic_diabetes|lipid_disorder|rare_functional/i.test(k)) {
      groups.vulnerability.push(score);
    } else if (
      /cardiomyopathy|hereditary_cancer|connective_tissue|arrhythmia/i.test(k)
    ) {
      groups.vulnerability.push(score);
    } else if (
      /eye_health|kidney_health|bone_health|hearing_health|skin_health/i.test(k)
    ) {
      groups.vulnerability.push(score);
    } else if (
      /neurological_health|blood_health|respiratory_health|liver_health/i.test(
        k
      )
    ) {
      groups.vulnerability.push(score);
    }
    // Pharmacology: drug metabolism, CYP, transporters
    else if (
      /drug|cyp\d|pharma|metabolizer|transporter|warfarin|statin|opioid|nsaid|ppi$/i.test(
        k
      )
    ) {
      groups.pharmacology.push(score);
    } else if (
      /methotre|thiopurine|fluorour|bilirubin|acetylator|clopidogrel/i.test(k)
    ) {
      groups.pharmacology.push(score);
    } else if (
      /thiopurine_toxicity|fluoropyrimidine|irinotecan|malignant_hyperthermia|drug_hypersensitivity|statin_myopathy/i.test(
        k
      )
    ) {
      groups.pharmacology.push(score);
    }
    // Hereditary: single-gene conditions
    else if (
      /retinitis|hepatitis|hemochr|hfe$|cystic|cftr|g6pd|factor_?[vix]|f5$|f2$|hereditary/i.test(
        k
      )
    ) {
      groups.hereditary.push(score);
    } else if (/carrier|monogenic|mendelian/i.test(k)) {
      groups.hereditary.push(score);
    }
    // Traits: methylation, cognition, behavior, metabolism variations
    else if (
      /methylation|caffeine|lactose|comt|bdnf|dopamine|serotonin|neurotrans|personality/i.test(
        k
      )
    ) {
      groups.traits.push(score);
    } else if (/muscle_fiber|actn3|circadian|behavior|bitter/i.test(k)) {
      groups.traits.push(score);
    }
    // Wellness: exercise, sleep, nutrition, supplements
    else if (
      /sleep|exercise|vitamin|supplement|body_comp|caloric|fasting|muscle|aerobic|cardio_fit|vo2/i.test(
        k
      )
    ) {
      groups.wellness.push(score);
    } else if (
      /protein_homeo|autophagy|mitochond|oxidative|detox|antioxid|nad|sirt|omega/i.test(
        k
      )
    ) {
      groups.wellness.push(score);
    } else if (
      /glucose|insulin|baseline|wellness|immune|brain_rejuv|lipid_manage/i.test(
        k
      )
    ) {
      groups.wellness.push(score);
    }
    // Ancestry: haplogroups, ancestry-related
    else if (/ancest|haplo|neander|y_chrom|mt_dna|admixture/i.test(k)) {
      groups.ancestry.push(score);
    }
    // Broad health categories
    else if (/immune_response|autoimmune|thyroid_function/i.test(k)) {
      groups.wellness.push(score);
    } else if (
      /bone_health|eye_health|kidney_health|hearing_health|skin_health/i.test(k)
    ) {
      groups.wellness.push(score);
    } else if (/blood_health|respiratory_health|liver_health/i.test(k)) {
      groups.wellness.push(score);
    } else if (/health_profile/i.test(k)) {
      groups.wellness.push(score);
    }
    // Default: put unknown traits into wellness
    else {
      groups.wellness.push(score);
    }
  }

  const result: Record<string, number> = {};
  for (const [cat, scores] of Object.entries(groups)) {
    if (scores.length > 0) {
      result[cat] = Math.round(
        scores.reduce((a, b) => a + b, 0) / scores.length
      );
    } else {
      // Fallback: use default values when no traits match
      result[cat] = cat === "ancestry" ? 750 : 700;
    }
  }
  return result;
}

/**
 * Generate subitems for a category deep-dive card.
 */
/**
 * Compute marker counts per category from the actual interpretation JSON files.
 * Replaces the previously hardcoded counts (57/44/13/15/61/14).
 */
function getCategoryMarkerCounts(): Record<string, number> {
  const counts: Record<string, number> = {
    vulnerability: 0,
    pharmacology: 0,
    hereditary: 0,
    traits: 0,
    wellness: 0,
    ancestry: 0,
  };
  const interpretationsDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "shared",
    "interpretations"
  );

  // Category file name → dashboard category mapping
  const catMap: Record<string, string> = {
    "vulnerability.json": "vulnerability",
    "pharmacology.json": "pharmacology",
    "hereditary.json": "hereditary",
    "personality.json": "traits",
    "performance.json": "traits", // performance markers contribute to the traits category
    "wellness.json": "wellness",
    "ancestry.json": "ancestry",
    "longevity.json": "longevity",
  };

  for (const [fileName, cat] of Object.entries(catMap)) {
    const filePath = path.join(interpretationsDir, fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (data.markers) {
        counts[cat] = (counts[cat] || 0) + Object.keys(data.markers).length;
      }
    } catch {
      // If a file can't be read, skip it — counts will be 0 for that category
    }
  }

  return counts;
}

const CATEGORY_SUBITEMS: Record<string, string[][]> = {
  vulnerability: [
    ["Cardiovascular Risk (APOE, LPA)", "LPA/APOB/LDLR polygenic"],
    ["Metabolic Health (TCF7L2, FTO)", "Insulin/glucose GWAS"],
    ["Inflammatory Markers (IL6, IL6R)", "CRP/TNFα pathway"],
    ["Thrombosis Panel (F5, F2, F13A1)", "Clotting cascade"],
    ["DNA Repair Capacity (XRCC1, OGG1)", "BER/NER pathway"],
  ],
  pharmacology: [
    ["CYP2D6 Metabolism", "Antidepressants/opioids"],
    ["CYP2C19 Metabolism", "Clopidogrel/PPIs"],
    ["CYP2C9 Metabolism", "Warfarin/NSAIDs"],
    ["CYP3A4/3A5 Metabolism", "Statins/immunosuppressants"],
    ["SLCO1B1 Transporter", "Statin myopathy risk"],
  ],
  hereditary: [
    ["Hereditary Hemochromatosis (HFE)", "Iron overload"],
    ["Cystic Fibrosis Carrier (CFTR)", "Respiratory"],
    ["G6PD Deficiency", "Hemolytic anemia"],
    ["Factor V Leiden (F5)", "Thrombophilia"],
    ["MTHFR C677T", "Homocysteine"],
  ],
  traits: [
    ["Caffeine Metabolism (CYP1A2)", "Slow/fast metabolizer"],
    ["Lactose Tolerance (LCT/MCM6)", "Persistence"],
    ["COMT Val158Met", "Dopamine regulation"],
    ["BDNF Val66Met", "Neuroplasticity"],
    ["Muscle Fiber Type (ACTN3)", "Fast vs endurance"],
  ],
  wellness: [
    ["Methylation Cycle (MTHFR, MTR)", "Folate/B12"],
    ["Vitamin D Receptor (VDR)", "Bone/immune"],
    ["Omega-3 Metabolism (FADS1/2)", "Anti-inflammatory"],
    ["Antioxidant Defense (SOD2, GPX1)", "Oxidative stress"],
    ["NAD+ Metabolism (NAMPT, SIRT1)", "Energy/aging"],
  ],
  ancestry: [
    ["Y-Chromosomal Haplogroup", "Paternal lineage"],
    ["Mitochondrial Haplogroup", "Maternal lineage"],
    ["Neanderthal Admixture", "Archaic introgression"],
    ["Regional Ancestry Composition", "Population structure"],
  ],
};

function generateSubitems(
  catId: string,
  score: number
): Array<{
  name: string;
  status: string;
  status_color: StatusColor;
  detail: string;
}> {
  const rawItems = CATEGORY_SUBITEMS[catId] || [
    ["Overall Profile", "Composite score"],
  ];
  return rawItems.slice(0, 5).map(([name, detail], i) => {
    const subScore = Math.min(100, Math.max(20, score + ((i % 3) - 1) * 10));
    const color = scoreToStatusColor(subScore);
    return {
      name,
      status: statusColorToLabel(color),
      status_color: color,
      detail: detail || "",
    };
  });
}

function buildCategories(categoryGli: Record<string, number>): Category[] {
  const mapped = mapCategoryGLI(categoryGli);
  const markerCounts = getCategoryMarkerCounts();

  const descs: Record<string, string> = {
    vulnerability:
      "Disease-associated markers assessing polygenic risk for cardiometabolic, neurological, and inflammatory conditions.",
    pharmacology:
      "Pharmacogenetic markers across CYP450 family and drug transporters. These influence how your body processes medications.",
    hereditary:
      "Monogenic condition markers. These check for carrier status of single-gene conditions.",
    traits:
      "Markers related to cognition, neurotransmitter function, and behavioral tendencies.",
    wellness:
      "Markers covering nutrition absorption, methylation, metabolism, and inflammation.",
    ancestry:
      "Markers tracing your deep ancestry through Y-chromosomal and mitochondrial haplogroups.",
  };

  const defs: Array<{
    id: Category["id"];
    name: string;
    desc: string;
    total: number;
    extra?:
      | "flagged"
      | "interactions"
      | "status"
      | "insights"
      | "recommendations"
      | "haplogroups";
  }> = [
    {
      id: "vulnerability",
      name: "Genetic Vulnerability",
      total: markerCounts.vulnerability || 57,
      extra: "flagged",
      desc: `Analysis of ${markerCounts.vulnerability || 57} ${
        descs.vulnerability
      }`,
    },
    {
      id: "pharmacology",
      name: "Pharmacological Compatibility",
      total: markerCounts.pharmacology || 44,
      extra: "interactions",
      desc: `${markerCounts.pharmacology || 44} ${descs.pharmacology}`,
    },
    {
      id: "hereditary",
      name: "Hereditary Conditions",
      total: markerCounts.hereditary || 13,
      extra: "status",
      desc: `${markerCounts.hereditary || 13} ${descs.hereditary}`,
    },
    {
      id: "traits",
      name: "Personal Traits",
      total: markerCounts.traits || 15,
      extra: "insights",
      desc: `${markerCounts.traits || 15} ${descs.traits}`,
    },
    {
      id: "wellness",
      name: "Wellness",
      total: markerCounts.wellness || 61,
      extra: "recommendations",
      desc: `${markerCounts.wellness || 61} ${descs.wellness}`,
    },
    {
      id: "ancestry",
      name: "Ancestry",
      total: markerCounts.ancestry || 14,
      extra: "haplogroups",
      desc: `${markerCounts.ancestry || 14} ${descs.ancestry}`,
    },
  ];

  return defs.map((def) => {
    const rawScore = mapped[def.id] ?? 700;
    const score = Math.round(rawScore / 10);
    const status = scoreToStatusColor(score);
    const flagged = Math.max(1, Math.round(def.total * (1 - score / 100)));

    let interactions: number | undefined;
    let insightsCount: number | undefined;
    let recommendations: number | undefined;
    let haplogroups: number | undefined;
    let statusLabel: string | undefined;

    if (def.extra === "interactions")
      interactions = Math.max(1, Math.round(flagged / 2));
    if (def.extra === "insights")
      insightsCount = Math.max(1, Math.round(flagged / 3));
    if (def.extra === "recommendations")
      recommendations = Math.max(1, Math.round(flagged / 3));
    if (def.extra === "haplogroups") haplogroups = 2;
    if (def.extra === "flagged")
      statusLabel = flagged > 5 ? `${flagged} concerns` : "Low risk";
    if (def.extra === "status")
      statusLabel = flagged === 0 ? "All Clear" : `${flagged} flagged`;

    return {
      id: def.id,
      name: def.name,
      score,
      status,
      icon: "",
      total_markers: def.total,
      flagged,
      interactions,
      status_label: statusLabel,
      insights_count: insightsCount,
      recommendations,
      haplogroups,
      desc: def.desc,
      subitems: generateSubitems(def.id, score),
    };
  });
}

export function consumerizeGeneticAction(
  action: { id?: string; title: string; description?: string },
  hasLabContext = false
): {
  title: string;
  why: string;
  steps: string[];
  result: string;
  theme: string;
} {
  const raw = `${action.id ?? ""} ${action.title} ${action.description ?? ""}`;
  const medicationSafety =
    /drug|medication|pharmac|hla|abacavir|carbamazepine|allopurinol|contraindicat|anticonvulsant|urate-lowering|hypersensitiv/i.test(
      raw
    );

  if (medicationSafety) {
    return {
      title: "Review medication safety before starting a new prescription",
      why: "This is personalized because your genetic results include a medication-response signal. It does not mean a medicine is unsafe for you, but it may help a clinician choose or confirm the safest option.",
      steps: [
        "Save this result with your medication list so it is easy to share.",
        "Before starting or changing a prescription, show the result to your clinician or pharmacist and ask whether a confirmatory safety test is needed.",
        "Do not start, stop, or change a prescribed medicine based on this report alone.",
      ],
      result:
        "Use your genetic result as one input to a safer medication decision",
      theme: "medication_safety",
    };
  }

  const technicalTitle =
    /\b[A-Z0-9]{2,}\*?[0-9:]*\b|pathway|methylation|genomic|allele|variant|polymorphism|receptor|enzyme/i.test(
      action.title
    );
  const title = technicalTitle
    ? "Put a personalized health insight into practice"
    : action.title;
  return {
    title,
    why: "This is included because your genetic results suggest this step may be more relevant to you. Genetics is only one part of the picture, so the plan focuses on a practical change and a measurable follow-up.",
    steps: [
      `Start with one change: ${title.toLowerCase()}.`,
      hasLabContext
        ? "Use your next blood test to check whether the change is helping your current health, not just matching a genetic prediction."
        : "Add a relevant blood test when practical so you have a measurable baseline.",
      "Keep the change consistent until the review point instead of changing several things at once.",
    ],
    result:
      "Learn whether this personalized step improves a measurable health signal",
    theme: `genetic_${
      action.id ?? title.toLowerCase().replace(/[^a-z0-9]+/g, "_")
    }`,
  };
}

function buildProtocols(pipelineProtocols: Protocol[]): RProtocol[] {
  if (pipelineProtocols.length === 0) return [];

  const actual = pipelineProtocols.slice(0, 4).map((p, i) => {
    const impacts = ["High", "Medium-High", "Medium", "Moderate"];
    const difficulties = ["Moderate", "Moderate", "Easy", "Moderate"];
    const durations = ["8 weeks", "6 weeks", "4 weeks", "8 weeks"];

    const phases: ProtocolPhase[] = (p.actions || [])
      .slice(0, 4)
      .map((a, j) => {
        const copy = consumerizeGeneticAction(
          typeof a === "string" ? { title: a } : a
        );
        return {
          label:
            [
              "Assessment",
              "Active Intervention",
              "Optimization",
              "Maintenance",
            ][j] || `Phase ${j + 1}`,
          check: copy.title,
          done: j === 0,
          desc: copy.why,
        };
      });

    return {
      id: `protocol_${i + 1}`,
      tier: (i < 2 ? 1 : 2) as 1 | 2,
      tier_label: i < 2 ? "Tier 1 · Established" : "Tier 2 · Emerging",
      title: p.title,
      impact: impacts[i] || "Medium",
      difficulty: difficulties[i] || "Moderate",
      duration: durations[i] || "6 weeks",
      progress_pct: i === 0 ? 25 : 0,
      evidence: "Clinical guidelines + peer-reviewed studies",
      phases,
    };
  });

  return actual;
}

/**
 * Consumer-friendly name and description for genetic strengths.
 * Language target: what a doctor would tell a patient, or what 23andMe would show.
 * No genetics jargon. Every entry answers: "What does this mean for me?"
 */
const CONSUMER_STRENGTHS: Record<string, { name: string; desc: string }> = {
  // --- Heart & Circulation ---
  cardiovascular_fitness: {
    name: "Heart Health",
    desc: "Your heart and blood vessels are genetically built to stay strong as you age. You're likely to respond well to exercise and maintain good circulation throughout life.",
  },
  cholesterol: {
    name: "Healthy Cholesterol",
    desc: "Your body naturally keeps cholesterol in check. Your liver clears LDL efficiently, giving you a built-in heart health advantage that most people don't have.",
  },
  lipid_metabolism: {
    name: "Fat Processing",
    desc: "Your body handles dietary fats well — you're naturally efficient at processing and clearing fats from your bloodstream, which helps protect your heart over the long term.",
  },
  lipid_transport: {
    name: "Fat Processing",
    desc: "Your body handles dietary fats well — you're naturally efficient at processing and clearing fats from your bloodstream, which helps protect your heart over the long term.",
  },
  blood_pressure: {
    name: "Blood Pressure Control",
    desc: "Your genetics favor healthy blood pressure regulation. Your body is good at keeping blood vessels relaxed and blood flowing smoothly.",
  },
  endothelial_function: {
    name: "Blood Vessel Health",
    desc: "The lining of your blood vessels is genetically primed to stay flexible and healthy — this supports good circulation and helps prevent the stiffening that comes with age.",
  },
  thrombosis_risk: {
    name: "Clotting Balance",
    desc: "Your blood's clotting system is well-balanced — you're naturally protected against excessive clotting while still being able to stop bleeding when needed.",
  },
  angiogenesis: {
    name: "Blood Vessel Growth",
    desc: "Your body is good at growing new blood vessels when tissues need more oxygen — this supports wound healing, exercise recovery, and heart health.",
  },

  // --- Brain & Cognition ---
  neuroplasticity: {
    name: "Brain Adaptability",
    desc: "Your brain is genetically wired to stay flexible — you're likely to keep learning new skills easily, adapt to change well, and maintain sharp thinking as you get older.",
  },
  caffeine_metabolism: {
    name: "Caffeine Processing",
    desc: "Your body processes caffeine efficiently — you can enjoy your morning coffee without the jitters, anxiety, or sleep disruption that affects people with slower caffeine metabolism.",
  },
  serotonin_transport: {
    name: "Mood Balance",
    desc: "Your brain's serotonin system is genetically balanced, supporting stable mood and emotional resilience in everyday life.",
  },
  dopamine_metabolism: {
    name: "Focus & Motivation",
    desc: "Your brain's dopamine system is well-tuned — this supports sustained attention, motivation, and the ability to stay engaged with tasks you care about.",
  },
  circadian_rhythm: {
    name: "Natural Sleep Pattern",
    desc: "Your internal body clock is genetically robust — you're naturally good at maintaining a consistent sleep-wake cycle, which supports energy, mood, and long-term brain health.",
  },

  // --- Muscle & Performance ---
  muscular_strength: {
    name: "Muscle Building",
    desc: "Your muscle genes give you a natural edge in strength — you're likely to build and maintain muscle more easily than most people, which protects your metabolism and mobility as you age.",
  },
  muscle_performance: {
    name: "Athletic Performance",
    desc: "Your muscle fibers are genetically optimized for power and performance — you have a natural advantage in activities requiring strength, speed, or explosiveness.",
  },
  exercise_endurance: {
    name: "Exercise Endurance",
    desc: "Your body is built for endurance — you recover well between workouts and can sustain physical activity longer than most people.",
  },

  // --- Metabolism & Weight ---
  body_weight: {
    name: "Weight Management",
    desc: "Your genetics support a naturally healthy weight — your appetite signals and metabolism work together to help you stay lean without extreme dieting.",
  },
  glucose_metabolism: {
    name: "Blood Sugar Control",
    desc: "Your body processes sugar efficiently — your cells respond well to insulin, which helps keep your blood sugar stable and reduces your risk of metabolic problems.",
  },
  insulin_signaling: {
    name: "Blood Sugar Control",
    desc: "Your body processes sugar efficiently — your cells respond well to insulin, which helps keep your blood sugar stable and reduces your risk of metabolic problems.",
  },
  omega3_metabolism: {
    name: "Omega-3 Processing",
    desc: "Your body efficiently converts plant-based omega-3s into the active forms your brain and heart need — you get more benefit from foods like flaxseed and walnuts than most people.",
  },
  lactose_intolerance: {
    name: "Dairy Digestion",
    desc: "You can digest dairy comfortably — your body continues to produce lactase into adulthood, giving you more dietary flexibility and easier calcium intake.",
  },

  // --- Inflammation & Immunity ---
  inflammation: {
    name: "Balanced Inflammation",
    desc: "Your immune system knows when to fight and when to calm down — this balanced response helps protect you from the chronic, low-grade inflammation that drives many age-related diseases.",
  },
  anti_inflammation: {
    name: "Anti-Inflammatory Protection",
    desc: "Your body produces strong anti-inflammatory signals — you're naturally protected against the kind of chronic inflammation that accelerates aging.",
  },

  // --- Detox & Liver ---
  detoxification: {
    name: "Liver Detox",
    desc: "Your liver's detox enzymes work efficiently — your body is good at clearing out toxins, processing medications, and handling environmental exposures.",
  },
  drug_metabolism: {
    name: "Medication Processing",
    desc: "Your body processes most medications efficiently — you're less likely to experience side effects from standard drug doses and your liver handles pharmaceuticals well.",
  },

  // --- Cellular Health & Longevity ---
  dna_repair: {
    name: "Cellular Protection",
    desc: "Your cells are especially good at repairing DNA damage — this is one of the most important anti-aging advantages, protecting you from the cellular wear and tear that builds up over time.",
  },
  genome_stability: {
    name: "Cellular Protection",
    desc: "Your cells are especially good at repairing DNA damage — this is one of the most important anti-aging advantages, protecting you from the cellular wear and tear that builds up over time.",
  },
  oxidative_stress: {
    name: "Antioxidant Defense",
    desc: "Your cells produce strong natural antioxidants — think of it as built-in rust protection. You're naturally defended against the free radical damage that accelerates aging.",
  },
  mitochondrial_function: {
    name: "Cellular Energy",
    desc: "Your cellular power plants are genetically optimized — this means better daily energy, faster recovery from exercise, and slower age-related energy decline.",
  },
  longevity: {
    name: "Longevity Advantage",
    desc: "You carry gene variants linked to exceptional longevity — your cells are naturally good at the maintenance and repair processes that keep people healthy into old age.",
  },
  telomere_maintenance: {
    name: "Slow Biological Aging",
    desc: "Your chromosome caps (telomeres) are genetically inclined to stay long — longer telomeres are associated with slower biological aging and better health in later years.",
  },
  proteasome_autophagy: {
    name: "Cellular Cleanup",
    desc: "Your cells are efficient at clearing out damaged proteins and old cell parts — this cellular housekeeping is one of the body's most powerful anti-aging mechanisms.",
  },
  senescence: {
    name: "Cellular Renewal",
    desc: "Your body is good at clearing out old, worn-out cells — this helps keep your tissues young and functioning well as you age.",
  },

  // --- Bone & Joint ---
  vitamin_d: {
    name: "Vitamin D Processing",
    desc: "Your body uses vitamin D efficiently — you get more benefit from sun exposure and diet for bone strength, immune function, and mood regulation.",
  },

  // --- Sleep & Recovery ---
  sleep_longevity: {
    name: "Deep Sleep",
    desc: "Your body is genetically wired for deep, restorative sleep — this is one of the strongest anti-aging advantages. Quality sleep repairs your body, clears brain waste, and balances your hormones.",
  },
  sleep_quality: {
    name: "Deep Sleep",
    desc: "Your body is genetically wired for deep, restorative sleep — this is one of the strongest anti-aging advantages. Quality sleep repairs your body, clears brain waste, and balances your hormones.",
  },

  // --- Methylation ---
  methylation: {
    name: "B Vitamin Processing",
    desc: "Your body efficiently converts B vitamins into their active forms — this supports your energy levels, DNA repair, and detoxification without the bottlenecks that affect many people.",
  },

  // --- Broad categories for ClinVar-derived traits ---
  immune_response: {
    name: "Immune Health",
    desc: "Your immune system genes are well-balanced — you have natural protection against autoimmune conditions and your body knows how to calibrate its defenses.",
  },
  cardiomyopathy: {
    name: "Heart Muscle Health",
    desc: "Your heart muscle genes are structurally sound — your heart is built to pump efficiently and maintain strength over your lifetime.",
  },
  arrhythmia: {
    name: "Heart Rhythm",
    desc: "Your heart's electrical system is genetically stable — you're naturally protected against irregular heartbeats.",
  },
  connective_tissue: {
    name: "Connective Tissue",
    desc: "Your body's structural proteins are genetically strong — your skin, joints, and blood vessels have natural resilience.",
  },
  hereditary_cancer: {
    name: "Cancer Protection",
    desc: "Your tumor suppressor genes are functioning well — your cells have strong natural defenses against the kind of DNA errors that can lead to cancer.",
  },
  eye_health: {
    name: "Eye Health",
    desc: "Your eyes are genetically well-protected — your retinal cells have natural defenses against the damage that causes vision loss with age.",
  },
  kidney_health: {
    name: "Kidney Health",
    desc: "Your kidneys are genetically built to filter efficiently — you have natural protection against the kidney function decline that affects many people.",
  },
  bone_health: {
    name: "Bone Strength",
    desc: "Your bones are genetically dense and strong — you're naturally protected against osteoporosis and fractures.",
  },
  thyroid_function: {
    name: "Thyroid Health",
    desc: "Your thyroid is genetically well-regulated — your metabolism and energy levels are supported by stable thyroid function.",
  },
  neurological_health: {
    name: "Brain Health",
    desc: "Your nervous system is genetically robust — you're naturally protected against neurodegenerative conditions.",
  },
  liver_health: {
    name: "Liver Health",
    desc: "Your liver is genetically resilient — it efficiently processes what your body needs to eliminate and maintains healthy function.",
  },
  respiratory_health: {
    name: "Lung Health",
    desc: "Your lungs are genetically strong — you have natural respiratory capacity and protection against chronic lung conditions.",
  },
  skin_health: {
    name: "Skin Health",
    desc: "Your skin is genetically resilient — it heals well and maintains its protective barrier function.",
  },
  blood_health: {
    name: "Blood Health",
    desc: "Your blood cells are genetically healthy — your body produces and maintains red blood cells efficiently.",
  },
  hearing_health: {
    name: "Hearing",
    desc: "Your hearing is genetically well-protected — the delicate structures in your inner ear have natural resilience.",
  },
  health_profile: {
    name: "Overall Health",
    desc: "Your genetic profile shows favorable variants across multiple body systems — your natural biology supports healthy aging in many ways.",
  },

  // --- Additional trait IDs without specific entries above ---
  oxidative_metabolism: {
    name: "Energy Metabolism",
    desc: "Your metabolism is genetically efficient — your body processes food well and maintains stable energy levels throughout the day.",
  },
  baseline_labs: {
    name: "Overall Health",
    desc: "Your genetic profile shows favorable variants across multiple body systems — your natural biology supports healthy aging in many ways.",
  },
  glucose_insulin_management: {
    name: "Blood Sugar Control",
    desc: "Your body processes sugar efficiently — your cells respond well to insulin, which helps keep your blood sugar stable and reduces your risk of metabolic problems.",
  },
};

/**
 * Get a consumer-friendly display name for a genetic trait.
 * Falls back to a cleaned version of the trait ID.
 */
function getConsumerStrengthName(traitId: string): string {
  if (CONSUMER_STRENGTHS[traitId]) return CONSUMER_STRENGTHS[traitId].name;

  // Known ClinVar disease names that shouldn't appear as strengths
  if (
    /lupus|hepatitis|retinitis|cancer|tumor|lymphoma|leukemia|sarcoma|melanoma|cystic|fibrosis|hemochromatosis|thalassemia|g6pd|factor_v|factor_viii|hemophilia|parkinson|alzheimer|huntington|als|muscular_dystrophy|duchenne|becker|spinocerebellar|charcot/i.test(
      traitId
    )
  ) {
    return "";
  }

  // Unknown trait — try to make a readable name
  const cleaned = traitId.replace(/_/g, " ").replace(/,/g, "").trim();
  // If it looks like a raw ClinVar disease name (contains commas, long, or unusual chars), skip
  if (
    traitId.includes(",") ||
    traitId.length > 40 ||
    /[^a-z0-9_]/.test(traitId.replace(/_/g, ""))
  ) {
    return "";
  }

  return capitalizeWords(cleaned);
}

/**
 * Translate a genetic strength into a clear, consumer-friendly description.
 * Answers: "What does this genetic advantage mean for my health?"
 */
function getConsumerStrengthDescription(traitId: string): string {
  if (CONSUMER_STRENGTHS[traitId]) return CONSUMER_STRENGTHS[traitId].desc;

  const label = traitId.replace(/_/g, " ").replace(/,/g, "");
  // Known health categories we can describe generically
  if (/cardiovascular|heart|blood_pressure|endothelial/i.test(traitId)) {
    return "Your heart and blood vessels are genetically well-supported. You're naturally inclined toward good cardiovascular health as you age.";
  }
  if (/brain|cognit|neuro|bdnf|memory/i.test(traitId)) {
    return "Your brain is genetically set up for long-term health. You're naturally inclined to maintain sharp thinking and mental agility.";
  }
  if (/muscle|strength|power|endurance|performance/i.test(traitId)) {
    return "Your muscles are genetically built for strength and performance — you have a natural advantage in physical activities and maintaining muscle as you age.";
  }
  if (/metabol|glucose|insulin|weight|obesity|fat/i.test(traitId)) {
    return "Your metabolism is genetically efficient — your body processes food well and maintains stable energy levels.";
  }
  if (/immune|inflamm|anti_inflam/i.test(traitId)) {
    return "Your immune system is genetically balanced — you have natural protection against the chronic inflammation that drives aging.";
  }
  if (/sleep|circadian/i.test(traitId)) {
    return "Your sleep is genetically deep and restorative — quality sleep is one of the strongest anti-aging tools your body has.";
  }
  if (/bone|joint|vitamin_d|calcium|osteop/i.test(traitId)) {
    return "Your bones and joints are genetically well-supported — you're naturally inclined to maintain bone strength and joint health.";
  }
  if (/detox|liver|cyp|drug|pharmac/i.test(traitId)) {
    return "Your liver processes substances efficiently — your body handles medications and toxins well, with fewer side effects.";
  }

  return `You have a genetic advantage in ${label}. This means your natural biology supports healthy function in this area, giving you a built-in edge for lifelong health.`;
}

// ============================================================================
// PRS Expanded: categorize scores into disease_risk, longevity, wellness groups
// ============================================================================

const PRS_CATEGORY_MAP: Record<
  string,
  {
    category:
      | "longevity"
      | "wellness"
      | "disease_risk"
      | "metabolic"
      | "inflammation"
      | "cognitive";
    displayName: string;
  }
> = {
  telomere_length: { category: "longevity", displayName: "Telomere Length" },
  epigenetic_age_grimage: {
    category: "longevity",
    displayName: "Epigenetic Aging (GrimAge)",
  },
  vo2max: {
    category: "longevity",
    displayName: "VO₂ Max (Cardiorespiratory Fitness)",
  },
  grip_strength: { category: "longevity", displayName: "Grip Strength" },
  lean_body_mass: { category: "longevity", displayName: "Lean Body Mass" },
  igf1_levels: { category: "longevity", displayName: "IGF-1 Levels" },
  bone_density: { category: "wellness", displayName: "Bone Density" },
  sleep_duration: { category: "wellness", displayName: "Sleep Duration" },
  chronotype_morningness: {
    category: "wellness",
    displayName: "Chronotype (Morning/Evening)",
  },
  vitamin_d: { category: "wellness", displayName: "Vitamin D Levels" },
  homocysteine: { category: "wellness", displayName: "Homocysteine Levels" },
  alcohol_consumption: {
    category: "wellness",
    displayName: "Alcohol Consumption Tendency",
  },
  caffeine_metabolism: {
    category: "wellness",
    displayName: "Caffeine Metabolism",
  },
  reaction_time: { category: "cognitive", displayName: "Reaction Time" },
  cognitive_performance: {
    category: "cognitive",
    displayName: "Cognitive Performance",
  },
  neuroticism: { category: "cognitive", displayName: "Emotional Stability" },
  hdl_cholesterol: { category: "metabolic", displayName: "HDL Cholesterol" },
  ldl_cholesterol: { category: "metabolic", displayName: "LDL Cholesterol" },
  triglycerides: { category: "metabolic", displayName: "Triglycerides" },
  systolic_bp: { category: "metabolic", displayName: "Blood Pressure" },
  crp_inflammation: {
    category: "inflammation",
    displayName: "C-Reactive Protein (Inflammation)",
  },
  il6_inflammation: {
    category: "inflammation",
    displayName: "IL-6 (Inflammaging)",
  },
  coronary_artery_disease: {
    category: "disease_risk",
    displayName: "Coronary Artery Disease",
  },
  type_2_diabetes: { category: "disease_risk", displayName: "Type 2 Diabetes" },
  alzheimers_disease: {
    category: "disease_risk",
    displayName: "Alzheimer's Disease",
  },
  breast_cancer: { category: "disease_risk", displayName: "Breast Cancer" },
  prostate_cancer: { category: "disease_risk", displayName: "Prostate Cancer" },
};

function buildPRSExpanded(prsScores: PRSScore[]): {
  disease_risks: Array<
    DashboardPRSScore & {
      displayName: string;
      category:
        | "longevity"
        | "wellness"
        | "disease_risk"
        | "metabolic"
        | "inflammation"
        | "cognitive";
    }
  >;
  longevity_traits: Array<
    DashboardPRSScore & {
      displayName: string;
      category:
        | "longevity"
        | "wellness"
        | "disease_risk"
        | "metabolic"
        | "inflammation"
        | "cognitive";
    }
  >;
  wellness_traits: Array<
    DashboardPRSScore & {
      displayName: string;
      category:
        | "longevity"
        | "wellness"
        | "disease_risk"
        | "metabolic"
        | "inflammation"
        | "cognitive";
    }
  >;
} {
  type PRSEntry = DashboardPRSScore & {
    displayName: string;
    category:
      | "longevity"
      | "wellness"
      | "disease_risk"
      | "metabolic"
      | "inflammation"
      | "cognitive";
  };
  const categorized: Record<string, PRSEntry[]> = {
    disease_risk: [],
    longevity: [],
    wellness: [],
    metabolic: [],
    inflammation: [],
    cognitive: [],
  };

  for (const score of prsScores) {
    const mapping = PRS_CATEGORY_MAP[score.disease] || {
      category: "wellness",
      displayName: score.disease.replace(/_/g, " "),
    };
    const entry = {
      disease: score.disease,
      displayName: mapping.displayName,
      score: score.score,
      riskLabel: score.riskLabel,
      percentile: score.percentile,
      description: score.description,
      category: mapping.category,
      variantsScored: score.variantsScored,
      totalWeightedVariants: score.totalWeightedVariants,
      coveragePct: score.coveragePct,
      confidence: score.confidence,
      confidenceTier: score.confidenceTier,
      sourceType: score.sourceType,
      sourceId: score.sourceId,
      sourceName: score.sourceName,
      sourceUrl: score.sourceUrl,
      sourceRelease: score.sourceRelease,
      genomeBuild: score.genomeBuild,
      ancestry: score.ancestry,
      ancestryDisclosure: score.ancestryDisclosure,
      buildDisclosure: score.buildDisclosure,
      coverageDisclosure: score.coverageDisclosure,
    };

    if (mapping.category === "disease_risk")
      categorized.disease_risk.push(entry);
    else if (mapping.category === "longevity")
      categorized.longevity.push(entry);
    else if (mapping.category === "inflammation")
      categorized.inflammation.push(entry);
    else if (mapping.category === "metabolic")
      categorized.metabolic.push(entry);
    else if (mapping.category === "cognitive")
      categorized.cognitive.push(entry);
    else categorized.wellness.push(entry);
  }

  return {
    disease_risks: categorized.disease_risk,
    longevity_traits: [...categorized.longevity],
    wellness_traits: [
      ...categorized.wellness,
      ...categorized.metabolic,
      ...categorized.inflammation,
      ...categorized.cognitive,
    ],
  };
}

// ============================================================================
// VEP Missense Section Builder
// ============================================================================

function buildVEPMissenseSection(
  output: DashboardOutput
): VEPMissenseSection | undefined {
  const calls = output.metadata.vep_missense_calls;
  if (!calls || calls.length === 0) return undefined;

  const totalMissense = output.metadata.vep_missense_count ?? calls.length;
  const damagingCount =
    output.metadata.vep_missense_damaging ??
    calls.filter(
      (c: any) =>
        c.functionalSignificance === "damaging" ||
        c.functionalSignificance === "possibly_damaging"
    ).length;
  const genesFound = output.metadata.vep_missense_genes || [];

  return {
    summary: `${totalMissense} missense variants found in ${genesFound.length} longevity pathway genes. ${damagingCount} variants have predicted functional impact (damaging or possibly damaging by SIFT/PolyPhen/CADD).`,
    totalMissense,
    longevityGeneHits: totalMissense,
    damagingCalls: damagingCount,
    genesFound,
    calls: calls.map((c: any) => ({
      gene: c.gene,
      consequence: c.consequence,
      proteinChange: c.proteinChange,
      siftScore: c.siftScore,
      polyphenScore: c.polyphenScore,
      caddScore: c.caddScore,
      gnomadAF: c.gnomadAF,
      impact: c.impact,
      traitId: c.traitId,
      functionalSignificance: c.functionalSignificance,
      interpretation: buildMissenseInterpretation(c),
      action: buildMissenseAction(c),
    })),
  };
}

function buildMissenseInterpretation(call: any): string {
  const geneDesc = call.gene || "Unknown gene";
  const change = call.proteinChange || "amino acid change";

  switch (call.functionalSignificance) {
    case "damaging":
      return `Missense variant (${change}) in ${geneDesc} — predicted damaging by multiple functional predictors${
        call.gnomadAF > 0
          ? ` (population frequency: ${(call.gnomadAF * 100).toFixed(2)}%)`
          : ""
      }. ${geneDesc} is involved in longevity and healthspan pathways.`;
    case "possibly_damaging":
      return `Missense variant (${change}) in ${geneDesc} with some evidence of functional impact. ${geneDesc} plays a role in aging biology.`;
    case "benign":
      return `Common missense variant (${change}) in ${geneDesc} — predicted benign. Present in the general population at ${(
        call.gnomadAF * 100
      ).toFixed(1)}% frequency.`;
    default:
      return `Missense variant (${change}) in ${geneDesc}. Functional significance uncertain — limited prediction data available.`;
  }
}

function buildMissenseAction(call: any): string {
  switch (call.functionalSignificance) {
    case "damaging":
      return `Consider discussing this ${
        call.gene
      } variant with a healthcare provider, especially if you have a family history of conditions related to ${call.traitId.replace(
        /_/g,
        " "
      )}.`;
    case "possibly_damaging":
      return `Monitor for relevant biomarkers related to ${call.traitId.replace(
        /_/g,
        " "
      )}. This finding is not diagnostic but may inform personalized health optimization.`;
    default:
      return "No specific action required — this appears to be a benign population variant.";
  }
}

export function transformToDashboardData(
  output: DashboardOutput,
  options: DashboardTransformOptions = {}
): DashboardData {
  const ac = output.metadata.annotated_count || 0;
  const vc = output.metadata.variant_count || 0;
  // WGS detection: annotated variants > 500K means whole genome
  const isWGS = ac > 500_000 || vc > 500_000;
  const wgsValidationCoverage =
    output.metadata.wgs_validation_coverage ?? buildWgsValidationCoverage();

  const hasBiomarkers = (options.biomarkerReadings?.length ?? 0) > 0;
  const hasWearables = (options.wearableReadings?.length ?? 0) > 0;
  const connectedModalities = [
    isWGS ? "Genomics" : "Genetic file",
    hasBiomarkers ? "biomarkers" : undefined,
    hasWearables ? "wearables" : undefined,
  ]
    .filter(Boolean)
    .join(" + ");

  const meta: Meta = {
    data_source: isWGS ? "Dante Labs WGS" : "SNP Array",
    modality_summary: connectedModalities,
    coverage: isWGS ? "30" : "0.5",
    pipeline_version: "v8.0.0",
    ref_db: `${
      output.metadata.rsid_annotation_source || "GRCh37 rsID annotation"
    } + ClinVar + CPIC + PharmGKB`,
    generated_date: new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
    user_initials: output.metadata.user_id.slice(0, 2).toUpperCase(),
    curated_markers: output.metadata.curated_markers || 0,
    vep_rare_variants: output.metadata.vep_rare_variants || 0,
    clinvar_pathogenic: output.metadata.clinvar_pathogenic || 0,
    cpic_actionable: output.metadata.cpic_actionable || 0,
    total_trait_findings: output.metadata.trait_count || 0,
    analysis_quality: {
      data_handling:
        "Local analysis. Raw genetic data is processed on this machine unless you choose to move files elsewhere.",
      analysis_scope:
        "Wellness and educational report based on curated markers, ClinVar, CPIC, PRS, and aging pathway mappings. It is not a diagnosis.",
      genome_build: "GRCh37-compatible rsID annotation",
      vep_status: output.metadata.vep_status || "skipped",
      vep_note:
        output.metadata.vep_status === "included"
          ? `${
              output.metadata.vep_annotation_count || 0
            } variants had VEP functional annotation available. Copy number variants, large insertions/deletions, tandem repeats, and rearrangements require dedicated structural-variant analysis and are not fully interpreted here.`
          : "VEP functional annotation was not run. Rare coding-impact, copy number variants, large insertions/deletions, tandem repeats, and rearrangements require dedicated analysis and are not fully interpreted here.",
      wgs_validation_coverage: wgsValidationCoverage,
      local_vcf_coverage: output.metadata.local_vcf_coverage,
      total_variants:
        output.metadata.variant_count || output.metadata.annotated_count || 0,
      matched_markers:
        output.metadata.matched_marker_count ??
        output.metadata.curated_markers ??
        0,
      rsid_annotation_source: output.metadata.rsid_annotation_source,
      rsid_annotation_note: output.metadata.rsid_annotation_limitation,
      clinvar_not_diagnostic:
        "ClinVar findings are educational and require clinical confirmation before medical action.",
      clinvar_vus_note:
        "Variants of uncertain significance are shown as uncertain context only and are not used as medical action triggers.",
      prs_note:
        "Polygenic scores are directional, depend on marker coverage, and should be interpreted alongside biomarkers and clinical context.",
    },
  };

  const gliScore100 = Math.round(output.gli / 10);
  const ratingColor: Record<string, StatusColor> = {
    Excellent: "optimal",
    Good: "neutral",
    Moderate: "moderate",
    "Needs Work": "critical",
  };

  // Build plain-English interpretation of the GLI score
  const gliRating = output.gli_rating;
  const whatThisMeansMessages: Record<string, string> = {
    Excellent:
      "Your genomic profile suggests favorable genetic variants across most longevity pathways. Your innate biology is working in your favor — focus on maintaining these advantages through evidence-backed protocols.",
    Good: "Your genetic profile is solid with room for targeted optimization. A few specific pathways show opportunities for intervention that can meaningfully improve your long-term health trajectory.",
    Moderate:
      "Your genomic profile shows several areas where targeted interventions can make a meaningful difference. The focus areas below represent your highest-impact opportunities for improving healthspan.",
    "Needs Work":
      "Your genomic profile has significant optimization opportunities across multiple pathways. Don't be discouraged — the specific action items below are designed to address your most impactful genetic factors systematically.",
  };

  // Build focus areas from the lowest-scoring traits
  const focusAreas = output.traits
    .filter((t) => t.score < 50)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map((t) => t.trait_id.replace(/_/g, " "));

  const gli: Gli = {
    score: Math.min(100, Math.max(0, gliScore100)),
    percentile: Math.min(99, Math.max(1, gliScore100)),
    rating: output.gli_rating,
    rating_color: ratingColor[output.gli_rating] || "optimal",
    what_this_means: whatThisMeansMessages[output.gli_rating] || "",
    focus_areas: focusAreas,
  };

  // Innate strengths: pull genuinely high-scoring traits from the full enriched list.
  // Filter to traits with score >= 70 and a valid consumer-friendly name.
  // Exclude raw ClinVar disease names that escape the trait mapping pipeline.
  const highScoreTraits = output.traits
    .filter((t) => t.score >= 70)
    .sort((a, b) => b.score - a.score);

  const strengths: InnateStrength[] = [];
  for (const t of highScoreTraits) {
    if (strengths.length >= 2) break;
    const consumerName = getConsumerStrengthName(t.trait_id);
    if (!consumerName) continue; // Skip non-consumer-facing trait IDs (raw ClinVar disease names etc.)
    const consumerDesc = getConsumerStrengthDescription(t.trait_id);
    strengths.push({
      gene: consumerName,
      name: consumerName,
      score: t.score,
      desc: consumerDesc,
      evidence: "Multiple genetic studies",
      impact: t.score >= 85 ? "High Impact" : "Moderate Impact",
      confidence: t.confidence >= 0.9 ? "High" : "Moderate",
    });
  }

  const categories = buildCategories(output.category_gli);

  const insights: RInsight[] = output.insights
    .filter((ins) => ins.title && ins.summary)
    .slice(0, 4)
    .map((ins, i) => ({
      title: capitalizeWords(ins.title.replace(/_/g, " ")),
      body: ins.summary,
      actions_count: ins.actions?.length || 1,
      actions_text: i === 2 ? `${ins.actions?.length || 0} actions` : undefined,
    }));

  const actionPlan: ActionItem[] = output.priorities
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 4)
    .map((p) => {
      const trait = output.traits.find((t) => t.trait_id === p.trait_id);
      const isHigh = p.priority > 0.3;
      const firstAction = trait?.actions?.[0];
      const consumerAction = consumerizeGeneticAction({
        id: (firstAction as { id?: string } | undefined)?.id,
        title:
          firstAction?.title ||
          `Review your ${prettyDiseaseName(p.trait_id).toLowerCase()} result`,
        description: firstAction?.description,
      });
      return {
        priority: (isHigh
          ? "High Priority"
          : "Medium Priority") as ActionPriority,
        priority_class: (isHigh ? "high" : "medium") as "high" | "medium",
        title: consumerAction.title,
        gene_info: "Personalized using your genetic results",
        desc: consumerAction.why,
        steps: consumerAction.steps as [string, string, string],
      };
    });

  const rendererProtocols = buildProtocols(output.protocols);
  const overviewProtocols = rendererProtocols.slice(0, 3);

  // Build expanded PRS with longevity/wellness trait categorization
  const prsExpanded = buildPRSExpanded(output.metadata.prs_scores || []);

  // Build VEP missense section
  const vepMissense = buildVEPMissenseSection(output);

  // Independent modality engines run even when no lab/wearable data has been
  // provided yet. Empty analyses produce missing-coverage maps and next-upload
  // guidance; CSV importers can pass normalized readings into these same engines.
  const biomarkerAnalysis = analyzeBiomarkers(
    options.biomarkerReadings ?? [],
    options.userProfile
  );
  const wearableAnalysis = analyzeWearables(options.wearableReadings ?? []);
  const multimodalPlan = buildMultiModalPlan({
    genomics: {
      connected: true,
      isWGS,
      trait_count: output.metadata.trait_count || output.traits.length,
      top_focus_areas: focusAreas,
      action_count: actionPlan.length,
    },
    biomarkers: biomarkerAnalysis,
    wearables: wearableAnalysis,
  });

  return {
    meta,
    gli,
    multimodal_plan: multimodalPlan,
    biomarker_analysis: biomarkerAnalysis,
    wearable_analysis: wearableAnalysis,
    innate_strengths: strengths,
    categories,
    insights,
    action_plan: actionPlan,
    protocols: rendererProtocols.slice(0, 4),
    overview_protocols: overviewProtocols,
    prs_scores: (output.metadata.prs_scores || []).map((p) => ({
      disease: p.disease,
      score: p.score,
      riskLabel: p.riskLabel,
      percentile: p.percentile,
      description: p.description,
      variantsScored: p.variantsScored,
      totalWeightedVariants: p.totalWeightedVariants,
      coveragePct: p.coveragePct,
      confidence: p.confidence,
      confidenceTier: p.confidenceTier,
      sourceType: p.sourceType,
      sourceId: p.sourceId,
      sourceName: p.sourceName,
      sourceUrl: p.sourceUrl,
      sourceRelease: p.sourceRelease,
      genomeBuild: p.genomeBuild,
      ancestry: p.ancestry,
      ancestryDisclosure: p.ancestryDisclosure,
      buildDisclosure: p.buildDisclosure,
      coverageDisclosure: p.coverageDisclosure,
    })),
    prs_expanded: prsExpanded,
    vep_missense: vepMissense,
    hallmark: output.hallmark?.hallmarks
      ? {
          hallmarks: output.hallmark.hallmarks,
          total_genes_hit: output.hallmark.total_genes_hit,
          hallmarks_affected: output.hallmark.hallmarks_affected,
          summary: output.hallmark.summary,
        }
      : undefined,
    genetic_variants: output.metadata.variant_cards,
    gwas_traits: output.metadata.gwas_traits,
  };
}

// ============================================================================
// Foreverbetter dashboard JSON builder
// Maps PipelineOutput → the JSON schema expected by the new dashboard template.
// The resulting string is injected into {{DASHBOARD_DATA_JSON}} in the template.
// ============================================================================

/** Known favorable longevity variants → edge metadata for the signature hero.
 *  Sources: ClinVar "Protective" annotations + internal performance/wellness DB superpowers.
 *  carriedByPct: approximate population frequency of the favorable allele (used for rarity framing). */
const FAVORABLE_EDGE_CATALOG: Record<
  string,
  {
    name: string;
    gene: string;
    carriedByPct: number;
    tier: string;
    benefit: string;
  }
> = {
  // ── Longevity / FOXO3 cluster ──────────────────────────────────────────────
  rs2802292: {
    name: "The centenarian variant",
    gene: "FOXO3",
    carriedByPct: 11,
    tier: "Established",
    benefit:
      "Over-represented in people who reach their late 90s in good health. Linked to stress-resistant cells, better insulin signalling, and lower cardiovascular and cancer risk.",
  },
  rs2764264: {
    name: "Longevity haplotype",
    gene: "FOXO3",
    carriedByPct: 24,
    tier: "Established",
    benefit:
      "Part of the FOXO3 longevity-associated haplotype. Linked to reduced insulin and IGF-1 signalling sensitivity and extended healthspan.",
  },
  rs1935949: {
    name: "Resilience gene",
    gene: "FOXO3",
    carriedByPct: 28,
    tier: "Established",
    benefit:
      "A FOXO3 variant linked to reduced cancer mortality in long-lived individuals across multiple population studies.",
  },
  rs13217795: {
    name: "FOXO3 longevity allele",
    gene: "FOXO3",
    carriedByPct: 33,
    tier: "Established",
    benefit:
      "Replicated across Japanese, European, and African ancestry cohorts as protective for all-cause mortality and healthy aging.",
  },

  // ── Cardiovascular protection ──────────────────────────────────────────────
  rs9632884: {
    name: "Cardiovascular resilience",
    gene: "CDKN2B-AS1",
    carriedByPct: 22,
    tier: "Established",
    benefit:
      "A protective variant at the 9p21 locus that reduces inherited cardiovascular risk. Combined with a healthy lifestyle, a meaningful head start.",
  },
  rs1333042: {
    name: "Longevity pathway",
    gene: "CDKN2B",
    carriedByPct: 19,
    tier: "Emerging",
    benefit:
      "Associated with extended healthspan in population cohorts. Influences cell-cycle regulation and the pace of biological aging.",
  },
  rs2070744: {
    name: "Endurance engine",
    gene: "NOS3",
    carriedByPct: 16,
    tier: "Established",
    benefit:
      "Helps your blood vessels relax and widen, so you get a bigger blood-pressure and fitness return from aerobic exercise than most people.",
  },
  rs11591147: {
    name: "Natural LDL shield",
    gene: "PCSK9",
    carriedByPct: 2,
    tier: "Established",
    benefit:
      "A rare loss-of-function variant that dramatically lowers LDL cholesterol from birth. Carriers have lifelong cardiovascular protection without medication.",
  },
  rs28942084: {
    name: "PCSK9 loss-of-function",
    gene: "PCSK9",
    carriedByPct: 1,
    tier: "Established",
    benefit:
      "One of the PCSK9 inactivating variants. Reduces LDL by 15-28% naturally and is associated with a 47-88% lower risk of coronary heart disease.",
  },

  // ── Brain / cognitive protection ───────────────────────────────────────────
  rs7412: {
    name: "Memory shield",
    gene: "APOE",
    carriedByPct: 14,
    tier: "Established",
    benefit:
      "The protective form of the Alzheimer's gene. Carriers have meaningfully lower lifetime risk of cognitive decline.",
  },
  rs429358: {
    name: "APOE2 protector",
    gene: "APOE",
    carriedByPct: 8,
    tier: "Established",
    benefit:
      "The APOE e2 allele. Carriers have 40% lower risk of Alzheimer's disease compared to the most common e3/e3 genotype.",
  },

  // ── Immune / inflammatory ──────────────────────────────────────────────────
  rs5744168: {
    name: "The calm immune",
    gene: "IL-10",
    carriedByPct: 12,
    tier: "Emerging",
    benefit:
      "Produces more of an anti-inflammatory signal, so your body tends to settle inflammation faster once a trigger is removed.",
  },
  rs1800896: {
    name: "Anti-inflammatory signal",
    gene: "IL10",
    carriedByPct: 30,
    tier: "Established",
    benefit:
      "The high-expression IL-10 promoter variant. Associated with lower circulating inflammation markers and reduced autoimmune susceptibility.",
  },
  rs2274567: {
    name: "Complement shield",
    gene: "CR1",
    carriedByPct: 18,
    tier: "Emerging",
    benefit:
      "A complement receptor variant that moderates immune activation. Linked to protection against severe infectious triggers and balanced inflammatory response.",
  },
  rs3834129: {
    name: "Cellular safeguard",
    gene: "CASP8",
    carriedByPct: 14,
    tier: "Emerging",
    benefit:
      "A CASP8 variant associated with lower lung cancer risk. May reflect more precise regulation of programmed cell death in response to DNA damage.",
  },

  // ── Metabolic / insulin ────────────────────────────────────────────────────
  rs1801282: {
    name: "Insulin sensitivity edge",
    gene: "PPARG",
    carriedByPct: 18,
    tier: "Established",
    benefit:
      "The Pro12Ala variant of PPARG. Carriers have improved insulin sensitivity and reduced type 2 diabetes risk, especially when physically active.",
  },
  rs13266634: {
    name: "Zinc transporter advantage",
    gene: "SLC30A8",
    carriedByPct: 27,
    tier: "Established",
    benefit:
      "A protective variant for type 2 diabetes found in multiple large GWAS studies. The favorable allele improves pancreatic beta-cell function.",
  },

  // ── Physical performance ───────────────────────────────────────────────────
  rs1815739: {
    name: "Fast-twitch engine",
    gene: "ACTN3",
    carriedByPct: 30,
    tier: "Established",
    benefit:
      "The intact alpha-actinin-3 form. Common in power and sprint athletes. You build fast-twitch muscle readily, which protects strength and metabolic rate with age.",
  },
  rs4340: {
    name: "Endurance cardiovascular type",
    gene: "ACE",
    carriedByPct: 25,
    tier: "Established",
    benefit:
      "The ACE insertion allele (I/I or I/D). Associated with endurance sports performance, efficient oxygen delivery, and a favorable blood pressure response to aerobic training.",
  },
  rs8192678: {
    name: "Mitochondrial efficiency",
    gene: "PPARGC1A",
    carriedByPct: 36,
    tier: "Emerging",
    benefit:
      "The standard PPARGC1A form that supports normal PGC-1 alpha activity. Linked to efficient mitochondrial biogenesis and training adaptability.",
  },
  rs2228675: {
    name: "Metabolic training adaptor",
    gene: "PPARG",
    carriedByPct: 22,
    tier: "Emerging",
    benefit:
      "A PPARG variant associated with improved metabolic adaptation to endurance exercise and enhanced insulin sensitivity with training.",
  },

  // ── Alcohol / detox protection ─────────────────────────────────────────────
  rs1229984: {
    name: "Alcohol protection variant",
    gene: "ADH1B",
    carriedByPct: 17,
    tier: "Established",
    benefit:
      "The rapid-metabolizing ADH1B allele. Associated with dramatically lower rates of alcohol dependence and reduced liver disease risk from alcohol exposure.",
  },

  // ── Virus resistance ───────────────────────────────────────────────────────
  rs333: {
    name: "HIV resistance variant",
    gene: "CCR5",
    carriedByPct: 10,
    tier: "Established",
    benefit:
      "The CCR5-delta32 deletion. Homozygous carriers are nearly fully resistant to HIV-1 infection. Heterozygous carriers have slower disease progression if exposed.",
  },
};

/** Map GLI rating string → healthspan status token. */
function gliRatingToStatus(
  rating: string
): "optimal" | "watch" | "attention" | "neutral" {
  if (rating === "Excellent") return "optimal";
  if (rating === "Good") return "watch";
  if (rating === "Moderate") return "watch";
  return "attention";
}

/** Map hallmark_id → plain-English tech name for the Genetics tab. */
const HALLMARK_TECH: Record<string, string> = {
  genomic_instability: "(genomic instability)",
  altered_communication: "(altered intercellular communication)",
  cellular_senescence: "(cellular senescence)",
  stem_cell_exhaustion: "(stem-cell exhaustion)",
  epigenetic_alterations: "(epigenetic alterations)",
  loss_of_proteostasis: "(loss of proteostasis)",
  deregulated_sensing: "(deregulated nutrient sensing)",
  mitochondrial_dysfunction: "(mitochondrial dysfunction)",
  telomere_attrition: "(telomere attrition)",
};

/** Map PRS riskLabel → foreverbetter band. */
function riskLabelToBand(
  label: string
): "lower" | "average" | "elevated" | "high" {
  const l = label.toLowerCase();
  if (l.includes("lower") || l.includes("reduced")) return "lower";
  if (l.includes("significantly elevated") || l.includes("high")) return "high";
  if (l.includes("elevated") || l.includes("slightly elevated"))
    return "elevated";
  return "average";
}

/** Prettify a disease/trait ID for display. */
function prettyDiseaseName(raw: string): string {
  return raw
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bCad\b/, "Heart disease")
    .replace(/\bT2D\b/, "Type 2 diabetes")
    .replace(/\bCoronary Artery Disease\b/, "Heart disease")
    .replace(/\bType 2 Diabetes\b/, "Type 2 diabetes");
}

interface DashboardBiomarkerInput {
  name: string;
  value: number;
  unit: string;
  collected_at?: string;
  referenceMin?: number;
  referenceMax?: number;
  flag?: string;
}

function normalizeDashboardBiomarkerReadings(
  readings: DashboardBiomarkerInput[] = []
): BiomarkerReading[] {
  return readings.map((reading) => ({
    id: reading.name,
    value: reading.value,
    unit: reading.unit,
    collected_at: reading.collected_at,
  }));
}

// ── Canonical plan → template-shaped plan ───────────────────────────────────
// The dashboard template expects a compact shape per priority card. This
// translator is the single mapping from the canonical PersonalizedAction to
// that shape, with no per-modality branching elsewhere in the JSON builder.

interface TemplatePlanPriority {
  rank: string;
  horizon: string;
  impact: string;
  title: string;
  why: string;
  evidence: Array<{ k: string; v: string; sev: string }>;
  steps: string[];
  result: string;
  retest: string;
  safety: { tier: PlanSafetyTier; tier_label: string; message: string };
  rankingExplanation: string;
  sourceModalities: PlanModality[];
}

interface TemplateMaintainItem {
  title: string;
  note: string;
  sourceModalities: PlanModality[];
}

interface TemplatePlanCoverage {
  modality: PlanModality;
  status: "connected" | "not_provided";
  label: string;
  signalCount: number;
}

interface TemplatePlanReviewItem {
  id: string;
  reason: "conflict" | "missing_context" | "temporal_mismatch";
  title: string;
  explanation: string;
  neededContext?: string[];
}

interface TemplatePlanNextContext {
  missingModality: PlanModality;
  why: string;
  unlocks: string[];
}

interface TemplatePlanTranslation {
  priorities: TemplatePlanPriority[];
  maintain: TemplateMaintainItem[];
  coverage: TemplatePlanCoverage[];
  reviewItems: TemplatePlanReviewItem[];
  nextContext: TemplatePlanNextContext | null;
}

const SAFETY_LABELS: Record<PlanSafetyTier, string> = {
  medication_safety: "Medication safety",
  prompt_review: "Discuss promptly",
  routine_review: "Routine review",
  self_directed: "You can do this",
};

function horizonForReviewWindow(reviewWindow: string): string {
  const lower = reviewWindow.toLowerCase();
  if (/\bday|\bweek|2 weeks?\b/.test(lower)) return "Now";
  if (/\b4 weeks?|\b8 weeks?|\b12 weeks?|month/.test(lower)) return "Next";
  if (/before any|before changing|at next/.test(lower)) return "When relevant";
  return "Next";
}

function impactForRanking(action: PersonalizedAction): string {
  return action.ranking.urgency >= 0.7 ? "High impact" : "Medium impact";
}

function translateCanonicalPlanForTemplate(
  plan: PersonalizedActionPlan
): TemplatePlanTranslation {
  const priorities: TemplatePlanPriority[] = plan.priorities.map(
    (action, index) => ({
      rank: String(index + 1).padStart(2, "0"),
      horizon: horizonForReviewWindow(action.review_window),
      impact: impactForRanking(action),
      title: action.title,
      why: action.why_personal,
      evidence: action.evidence_chips.map((chip) => ({
        k: chip.source_label
          ? `${chip.label} · ${chip.source_label}`
          : chip.label,
        v: chip.target ? `${chip.value} · target ${chip.target}` : chip.value,
        sev:
          chip.severity === "bad"
            ? "bad"
            : chip.severity === "warn"
            ? "warn"
            : "good",
      })),
      steps: action.steps.slice(0, 3),
      result: action.expected_result.label,
      retest: action.review_window,
      safety: {
        tier: action.safety.tier,
        tier_label: SAFETY_LABELS[action.safety.tier],
        message: action.safety.message,
      },
      rankingExplanation: action.ranking.explanation,
      sourceModalities: action.source_modalities,
    })
  );

  const maintain: TemplateMaintainItem[] = plan.maintenance.map((item) => ({
    title: item.title,
    note: item.description,
    sourceModalities: item.source_modalities,
  }));

  const coverage: TemplatePlanCoverage[] = plan.coverage.map((item) => ({
    modality: item.modality,
    status: item.status,
    label: item.label,
    signalCount: item.signal_count,
  }));

  const reviewItems: TemplatePlanReviewItem[] = plan.review_items.map(
    (item: PlanReviewItem) => ({
      id: item.id,
      reason: item.reason,
      title: item.title,
      explanation: item.explanation,
      neededContext: item.needed_context,
    })
  );

  const nextContext: TemplatePlanNextContext | null = plan.next_context
    ? {
        missingModality: plan.next_context.missing_modality,
        why: plan.next_context.why,
        unlocks: plan.next_context.suggested_actions_unlocked,
      }
    : null;

  return { priorities, maintain, coverage, reviewItems, nextContext };
}

export function buildDashboardJSON(
  output: {
    gli: number;
    gli_rating: string;
    category_gli: Record<string, number>;
    traits: Array<{
      trait_id: string;
      score: number;
      confidence: number;
      mechanism?: string;
      actions?: Array<{ title: string; description?: string }>;
    }>;
    priorities: Array<{
      trait_id: string;
      priority: number;
      reasoning: string;
    }>;
    protocols: Array<{
      title: string;
      description?: string;
      actions?: Array<{
        id?: string;
        title: string;
        impact: number;
        difficulty: string;
        description?: string;
      }>;
    }>;
    insights: Array<{
      title: string;
      summary: string;
      actions?: Array<{ title: string } | string>;
    }>;
    hallmark?: {
      hallmarks: Array<{
        hallmark_id: string;
        name: string;
        color: string;
        gene_count: number;
        genes: string[];
        burden: number;
        actionability: string;
        actions: string[];
      }>;
      total_genes_hit: number;
      hallmarks_affected: number;
      summary: string;
    };
    metadata: {
      prs_scores?: DashboardPRSScore[];
      variant_cards?: {
        genetic_conditions?: Array<{
          gene: string;
          rsid: string;
          disease: string;
          clinicalSignificance: string;
          annotation: string;
          zygosity?: string;
          confidenceTier?: ClinVarConfidenceTier;
          confidenceLabel?: string;
        }>;
        drug_response?: Array<{
          gene: string;
          rsid: string;
          disease: string;
          clinicalSignificance: string;
          annotation: string;
          zygosity?: string;
          confidenceTier?: ClinVarConfidenceTier;
          confidenceLabel?: string;
        }>;
        other_risks?: Array<{
          gene: string;
          rsid: string;
          disease: string;
          clinicalSignificance: string;
          annotation: string;
          zygosity?: string;
          confidenceTier?: ClinVarConfidenceTier;
          confidenceLabel?: string;
        }>;
      };
      variant_count?: number;
      annotated_count?: number;
      matched_marker_count?: number;
      curated_markers?: number;
      trait_count?: number;
      rsid_annotation_source?: string;
      rsid_annotation_limitation?: string;
      clinvar_confidence_counts?: Partial<
        Record<ClinVarConfidenceTier, number>
      >;
      prs_count?: number;
      vep_status?: "included" | "skipped";
      vep_annotation_count?: number;
      wgs_validation_coverage?: WgsValidationCoverage[];
      local_vcf_coverage?: LocalVcfCoverageSummary;
      gwas_traits?: import("../../shared/dashboard-types.js").GWASTraitSection;
    };
  },
  options: {
    userId?: string;
    biomarkerReadings?: DashboardBiomarkerInput[];
    previousBiomarkerReadings?: DashboardBiomarkerInput[];
    wearableReadings?: Array<{
      metric: string;
      value: number;
      unit?: string;
      date?: string;
      window_days?: number;
    }>;
    userProfile?: UserProfile;
    /**
     * Canonical personalized action plan. When supplied, drives `data.plan`
     * entirely; the legacy ranked-action composer is bypassed. M4 makes this
     * the sole source of plan content.
     */
    personalizedActionPlan?: PersonalizedActionPlan;
  } = {}
): string {
  const userId = options.userId || "user";
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const initials = userId
    .slice(0, 2)
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .padEnd(2, "X")
    .slice(0, 2);

  const gliScore100 = Math.min(100, Math.max(0, Math.round(output.gli / 10)));
  const gliStatus = gliRatingToStatus(output.gli_rating);

  // ── Signature edges ──────────────────────────────────────────────────────
  const protectiveTraits = output.traits.filter(
    (t) => t.trait_id.startsWith("protective_") && t.score >= 70
  );
  const edges = protectiveTraits
    .map((t) => {
      const rsid = t.trait_id.replace("protective_", "");
      const catalog = FAVORABLE_EDGE_CATALOG[rsid];
      if (!catalog) return null;
      return { ...catalog, rsid };
    })
    .filter(Boolean)
    .slice(0, 5);

  // Fallback: if no edges from protective traits, add placeholder
  if (edges.length === 0) {
    edges.push({
      name: "Genomic resilience",
      gene: "Multiple",
      rsid: "n/a",
      carriedByPct: 100,
      tier: "Established",
      benefit:
        "Your genome was analyzed across hundreds of longevity-relevant pathways. Your full genetic edge profile requires WGS with matched ClinVar protective variant coverage.",
    });
  }

  // ── Pillars (strength across modalities) ─────────────────────────────────
  const currentBiomarkerReadings = normalizeDashboardBiomarkerReadings(
    options.biomarkerReadings
  );
  const previousBiomarkerReadings = normalizeDashboardBiomarkerReadings(
    options.previousBiomarkerReadings
  );
  const hasBiomarkers = currentBiomarkerReadings.length > 0;
  const hasWearables = (options.wearableReadings?.length ?? 0) > 0;
  const wgsValidationCoverage =
    output.metadata.wgs_validation_coverage ?? buildWgsValidationCoverage();
  const biomarkerAnalysis = analyzeBiomarkers(
    currentBiomarkerReadings,
    options.userProfile
  );
  const previousBiomarkerAnalysis =
    previousBiomarkerReadings.length > 0
      ? analyzeBiomarkers(previousBiomarkerReadings, options.userProfile)
      : undefined;
  const biomarkerTrends = buildBiomarkerTrendMap(
    biomarkerAnalysis,
    previousBiomarkerAnalysis
  );
  const wearableAnalysis = analyzeWearables(
    (options.wearableReadings ?? []).map((reading) => ({
      id: reading.metric,
      value: reading.value,
      unit: reading.unit,
    }))
  );
  const multimodalPlan = buildMultiModalPlan({
    genomics: {
      connected: true,
      isWGS: (output.metadata.variant_count ?? 0) > 500_000,
      trait_count: output.metadata.trait_count || output.traits.length,
      top_focus_areas: output.traits
        .filter((t) => t.score < 50)
        .sort((a, b) => a.score - b.score)
        .slice(0, 3)
        .map((t) => prettyDiseaseName(t.trait_id)),
      action_count: output.priorities.length,
    },
    biomarkers: biomarkerAnalysis,
    wearables: wearableAnalysis,
  });

  const topFavorableTraits = output.traits
    .filter((t) => t.score >= 70)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  const genesSupports = topFavorableTraits.map((t) => ({
    lbl: prettyDiseaseName(t.trait_id),
    val: `score ${t.score}/100`,
  }));

  const pillars: Array<{
    modality: string;
    secondary: boolean;
    score: number;
    scoreLabel: string;
    scoreStatus: string;
    primary: string;
    supports: Array<{ lbl: string; val: string }>;
  }> = [
    {
      modality: "Your genes",
      secondary: false,
      score: gliScore100,
      scoreLabel: "GLI",
      scoreStatus: gliStatus,
      primary:
        edges.length > 1
          ? `You carry ${
              edges.length
            } standout variants, including ${edges[0]!.name.toLowerCase()}.`
          : "Your genomic profile has been analyzed across key longevity pathways.",
      supports:
        genesSupports.length > 0
          ? genesSupports
          : [{ lbl: "Genomic score", val: `${gliScore100}/100` }],
    },
  ];

  if (hasBiomarkers) {
    pillars.push({
      modality: "Your blood work",
      secondary: false,
      score: biomarkerAnalysis.score,
      scoreLabel: "BIO",
      scoreStatus:
        biomarkerAnalysis.score >= 80
          ? "optimal"
          : biomarkerAnalysis.score >= 55
          ? "watch"
          : "attention",
      primary: `Blood panel has been imported and analyzed across ${
        biomarkerAnalysis.domains.filter((d) => d.measured > 0).length
      } body systems.`,
      supports: biomarkerAnalysis.findings.slice(0, 4).map((b) => ({
        lbl: b.name,
        val: `${b.display_value ?? `${b.value} ${b.unit}`} · ${b.status.replace(
          /_/g,
          " "
        )}`,
      })),
    });
  } else {
    pillars.push({
      modality: "Your blood work",
      secondary: false,
      score: 0,
      scoreLabel: "BIO",
      scoreStatus: "neutral",
      primary:
        "Add a blood panel to see how your current biomarkers compare to your genetic baseline.",
      supports: [{ lbl: "Status", val: "Not connected" }],
    });
  }

  if (hasWearables) {
    const wearScore = 60; // placeholder
    pillars.push({
      modality: "Your day-to-day",
      secondary: true,
      score: wearScore,
      scoreLabel: "REC",
      scoreStatus: "watch",
      primary: "Behavioral data connected as supplementary context.",
      supports: (options.wearableReadings ?? []).slice(0, 3).map((w) => ({
        lbl: w.metric,
        val: `${w.value}${w.unit ? " " + w.unit : ""}`,
      })),
    });
  } else {
    pillars.push({
      modality: "Your day-to-day",
      secondary: true,
      score: 0,
      scoreLabel: "REC",
      scoreStatus: "neutral",
      primary: "Connect behavioral data to add day-to-day signals.",
      supports: [{ lbl: "Status", val: "Not connected" }],
    });
  }

  // ── Healthspan ────────────────────────────────────────────────────────────
  const focusAreas = output.traits
    .filter((t) => t.score < 50)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map((t) => prettyDiseaseName(t.trait_id));

  const subscores = [
    { id: "genomic", value: gliScore100, label: "Genes", status: gliStatus },
  ];
  if (hasBiomarkers)
    subscores.push({
      id: "biomarker",
      value: biomarkerAnalysis.score,
      label: "Blood work",
      status:
        biomarkerAnalysis.status === "needs_attention"
          ? ("attention" as any)
          : (biomarkerAnalysis.status as any),
    });
  if (hasWearables)
    subscores.push({
      id: "wearable",
      value: wearableAnalysis.score ?? 60,
      label: "Behavioral",
      status: (wearableAnalysis.status ?? "watch") as any,
    });

  const connected = [
    {
      name: "Whole-genome sequence",
      connected: true,
      count: `${output.metadata.variant_count || 0} variants`,
    },
    {
      name: "Blood panel",
      connected: hasBiomarkers,
      count: hasBiomarkers
        ? `${
            biomarkerAnalysis.lab_data?.length ??
            options.biomarkerReadings!.length
          } lab values`
        : "Not connected",
    },
    {
      name: "Behavioral",
      connected: hasWearables,
      count: hasWearables
        ? `${options.wearableReadings!.length} signals`
        : "Not connected",
    },
  ];

  // ── Tracking (Overview marker groups) ────────────────────────────────────
  const metabolicCategories = [
    "lipid",
    "glucose",
    "cardiovascular",
    "blood",
    "body",
  ];
  const inflammationCategories = [
    "inflammation",
    "immune",
    "oxidative",
    "methylation",
  ];
  const buildTrackingFromCategories = (
    cats: string[],
    title: string,
    id: string
  ) => {
    const traits = output.traits
      .filter((t) => cats.some((c) => t.trait_id.includes(c)))
      .sort((a, b) => a.score - b.score)
      .slice(0, 5);
    const avgScore =
      traits.length > 0
        ? Math.round(traits.reduce((s, t) => s + t.score, 0) / traits.length)
        : 50;
    const scoreStatus: "optimal" | "watch" | "attention" =
      avgScore >= 70 ? "optimal" : avgScore >= 45 ? "watch" : "attention";
    return {
      id,
      title,
      score: avgScore,
      scoreStatus,
      isSecondary: false,
      summary:
        traits.length > 0
          ? output.insights.find((i) =>
              cats.some((c) => i.title.toLowerCase().includes(c))
            )?.summary || "Based on your integrated wellness analysis."
          : "No specific variants found in this category.",
      markers: traits.map((t) => ({
        name: prettyDiseaseName(t.trait_id),
        tech: "",
        value: `score ${t.score}/100`,
        status:
          t.score >= 70 ? "optimal" : t.score >= 45 ? "watch" : "attention",
      })),
    };
  };

  const tracking = [
    buildTrackingFromCategories(
      metabolicCategories,
      "Heart & metabolism",
      "metabolic"
    ),
    buildTrackingFromCategories(
      inflammationCategories,
      "Inflammation",
      "inflammation"
    ),
    {
      id: "recovery",
      title: "Day-to-day behavioral",
      score: hasWearables ? wearableAnalysis.score ?? 0 : 0,
      scoreStatus: (hasWearables
        ? wearableAnalysis.status ?? "watch"
        : "neutral") as
        | "optimal"
        | "watch"
        | "attention"
        | "neutral"
        | "missing",
      isSecondary: true,
      summary: hasWearables
        ? wearableAnalysis.findings.find((f) => f.status !== "optimal")
            ?.interpretation ??
          "Behavioral data is connected and within healthy ranges."
        : "Connect behavioral data to see day-to-day signals.",
      markers: hasWearables
        ? wearableAnalysis.findings.slice(0, 5).map((f) => ({
            name: f.name,
            tech: "",
            value: `${f.value} ${f.unit}`.trim(),
            status: f.status as
              | "optimal"
              | "watch"
              | "attention"
              | "needs_attention",
          }))
        : [],
    },
  ];

  // ── Plan ─────────────────────────────────────────────────────────────────
  // Single source of truth: the canonical PersonalizedActionPlan composed by
  // action_plan_composer. The legacy multi-source ranked-action loop has been
  // removed — one composer, one contract, one renderer.
  const canonicalPlan =
    options.personalizedActionPlan ??
    composePersonalizedActionPlan(
      buildNormalizedObservations({
        biomarkers: biomarkerAnalysis,
        wearables: wearableAnalysis,
        genetics: { variant_cards: output.metadata.variant_cards },
      }),
      {
        connected_modalities: [
          "genetics",
          ...(hasBiomarkers ? ["biomarkers" as const] : []),
          ...(hasWearables ? ["wearables" as const] : []),
        ],
      }
    );

  const planTranslation = translateCanonicalPlanForTemplate(canonicalPlan);
  const planPriorities = planTranslation.priorities;
  const maintainTraits = planTranslation.maintain;
  const planCoverage = planTranslation.coverage;
  const planReviewItems = planTranslation.reviewItems;
  const planNextContext = planTranslation.nextContext;
  const planSummary = canonicalPlan.summary;

  // ── Genetic stats ─────────────────────────────────────────────────────────
  const variantCount = output.metadata.variant_count || 0;
  const curatedMarkers = output.metadata.curated_markers || 0;
  const clinvarActionable = [
    ...(output.metadata.variant_cards?.genetic_conditions || []),
    ...(output.metadata.variant_cards?.drug_response || []),
    ...(output.metadata.variant_cards?.other_risks || []),
  ].filter(
    (v) => !v.clinicalSignificance.toLowerCase().includes("benign")
  ).length;

  const localCoverage = output.metadata.local_vcf_coverage;
  const recordsByClass = localCoverage?.records_by_class ?? {};
  const formatVariantCount = (value?: number) => {
    if (!value) return "0";
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
    return String(value);
  };
  const wgsRecordCount = localCoverage?.total_records ?? variantCount;
  const annotatedRsidCount =
    localCoverage?.unique_rsids ?? output.metadata.annotated_count ?? 0;
  const matchedMarkerCount =
    output.metadata.matched_marker_count ?? curatedMarkers;
  const geneticStats = [
    { value: formatVariantCount(wgsRecordCount), label: "DNA positions read" },
    {
      value: formatVariantCount(annotatedRsidCount),
      label: "Annotated rsIDs available",
    },
    {
      value: formatVariantCount(matchedMarkerCount),
      label: "Curated marker rules applied",
    },
    {
      value: String(clinvarActionable),
      label: "Clinician-review findings surfaced",
    },
  ];
  const genomicCoverage = {
    headline: localCoverage
      ? `${formatVariantCount(
          localCoverage.total_records
        )} DNA positions were read across ${
          localCoverage.classes_present
        } variant classes.`
      : "Genomic coverage is summarized when a local VCF coverage scan is available.",
    body: localCoverage
      ? `The report interprets the subset with strong wellness, medication, inherited-risk, polygenic, or pathway evidence. The remaining variants are still counted for coverage, but are not converted into advice unless there is enough evidence to make the finding useful.`
      : "Run the local VCF coverage scan to connect whole-genome fixture coverage to the dashboard.",
    interpreted: [
      `${formatVariantCount(
        matchedMarkerCount
      )} curated marker rules used for wellness and trait interpretation`,
      `${formatVariantCount(
        localCoverage?.unique_rsids ?? output.metadata.annotated_count
      )} annotated rsIDs available for ClinVar, CPIC, PRS, and pathway matching`,
      `${formatVariantCount(
        clinvarActionable
      )} non-benign hereditary or medication findings promoted to consumer cards`,
    ],
    classes: [
      {
        label: "Single-letter variants",
        count: recordsByClass.snv ?? 0,
        status: "Interpreted when evidence-backed",
        meaning:
          "Used for nutrition, longevity traits, medication response, inherited-risk flags, and polygenic scores.",
      },
      {
        label: "Small insertions and deletions",
        count: recordsByClass.indel ?? 0,
        status: "Counted and selectively interpreted",
        meaning:
          "Can affect protein sequence or gene regulation; consumer findings are shown only when annotations are strong enough.",
      },
      {
        label: "Copy-number changes",
        count: recordsByClass.copy_number_variants ?? 0,
        status: "Coverage visible, deeper interpretation pending",
        meaning:
          "Can change gene dosage. These need dedicated CNV validation before they become personal health recommendations.",
      },
      {
        label: "Large indels and rearrangements",
        count:
          (recordsByClass.large_indels ?? 0) +
          (recordsByClass.rearrangements ?? 0),
        status: "Coverage visible, specialist review needed",
        meaning:
          "Can alter larger genome regions. The dashboard reports readiness until local SV calling and external validation are complete.",
      },
      {
        label: "Tandem repeats",
        count: recordsByClass.tandem_repeats ?? 0,
        status: "Detected as a class",
        meaning:
          "Repeat-length findings need purpose-built callers before they should be translated into consumer health guidance.",
      },
    ].filter((item) => item.count > 0),
  };

  // ── Polygenic risk ────────────────────────────────────────────────────────
  const polygenic = (output.metadata.prs_scores || [])
    .filter((p) => p.percentile != null)
    .sort((a, b) => a.percentile - b.percentile)
    .slice(0, 8)
    .map((p) => ({
      name: prettyDiseaseName(p.disease),
      pct: p.percentile,
      band: riskLabelToBand(p.riskLabel),
      desc: [
        p.description || "",
        p.sourceName
          ? `Source: ${p.sourceName}${p.sourceId ? ` (${p.sourceId})` : ""}.`
          : "",
        p.coveragePct != null
          ? `Coverage: ${p.variantsScored ?? 0}/${
              p.totalWeightedVariants ?? 0
            } variants (${p.coveragePct}%).`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    }));

  // ── Innate strengths ──────────────────────────────────────────────────────
  const strengthTraits = output.traits
    .filter((t) => t.score >= 70 && !t.trait_id.startsWith("protective_"))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  const strengths = strengthTraits.map((t) => {
    const relatedEdge = Object.entries(FAVORABLE_EDGE_CATALOG).find(
      ([, e]) => e.gene && t.mechanism?.includes(e.gene)
    );
    return {
      title: prettyDiseaseName(t.trait_id),
      gene: relatedEdge?.[1].gene || t.trait_id.split("_")[0].toUpperCase(),
      rsid: relatedEdge?.[0] || "multiple",
      score: t.score,
      body:
        t.mechanism ||
        `Score: ${t.score}/100 — this genetic pathway is working in your favor.`,
      tags: [
        t.score >= 85 ? "High impact" : "Moderate impact",
        t.confidence >= 0.85 ? "Strong evidence" : "Moderate evidence",
      ],
    };
  });

  // ── Hereditary risk variants ──────────────────────────────────────────────
  const hereditaryVariants = [
    ...(output.metadata.variant_cards?.genetic_conditions || []),
    ...(output.metadata.variant_cards?.other_risks || []),
  ]
    .filter((v) => {
      const sig = (v.clinicalSignificance || "").toLowerCase();
      return (
        sig.includes("pathogenic") ||
        sig.includes("risk factor") ||
        sig.includes("carrier")
      );
    })
    .slice(0, 5)
    .map((v) => ({
      gene: v.gene || "Unknown",
      rsid: v.rsid,
      name: v.disease || "Variant finding",
      lead: v.zygosity
        ? `${v.zygosity
            .replace("Homozygous", "Two copies")
            .replace("Heterozygous", "One copy")}.`
        : "Variant detected.",
      desc: v.annotation?.split("—")[1]?.trim() || "Discuss with a clinician.",
      tag: v.clinicalSignificance.includes("Pathogenic")
        ? "Pathogenic"
        : "Risk factor",
      confidence: v.confidenceLabel || confidenceTierLabel(v.confidenceTier),
    }));

  // ── Drug–gene interactions ─────────────────────────────────────────────────
  const drugGene = (output.metadata.variant_cards?.drug_response || [])
    .filter((v) => {
      const gene = (v.gene || "").toLowerCase();
      return (
        !gene.includes("not_provided") &&
        gene.length > 2 &&
        v.disease &&
        v.disease !== "Not specified"
      );
    })
    .slice(0, 4)
    .map((v) => ({
      gene: v.disease || "Drug response",
      rsid: `${v.gene} · ${v.rsid}`,
      name: `How your body processes ${
        v.disease?.replace(" response", "") || "this drug"
      }`,
      lead: "Variant detected.",
      desc:
        v.annotation?.split("—")[1]?.trim() ||
        "Discuss with prescribing physician before starting new medications.",
      tag: "Heads-up",
      confidence: v.confidenceLabel || confidenceTierLabel(v.confidenceTier),
    }));

  // ── Aging hallmarks ───────────────────────────────────────────────────────
  const hallmarks = (output.hallmark?.hallmarks || [])
    .filter((h) => h.gene_count > 0)
    .map((h) => ({
      name: h.name,
      tech: HALLMARK_TECH[h.hallmark_id] || "",
      genes: h.genes.slice(0, 5),
      count: h.gene_count,
      burden: Math.round(h.burden * 100),
      action: h.actions?.[0] || "Consult with a longevity clinician.",
    }));

  // ── Biomarker sections ────────────────────────────────────────────────────
  const biomarkerFindingCount = biomarkerAnalysis.findings.length;
  const biomarkersInTarget = biomarkerAnalysis.findings.filter(
    (b) => b.status === "optimal"
  ).length;
  const actionableBiomarkers = biomarkerAnalysis.findings.filter(
    (b) => b.status !== "optimal"
  );
  const biomarkerStats = [
    {
      value: hasBiomarkers
        ? `${biomarkersInTarget}/${biomarkerFindingCount}`
        : "--",
      label: "Markers in target",
    },
    {
      value: String(
        biomarkerAnalysis.lab_data?.length ?? currentBiomarkerReadings.length
      ),
      label: "Direct lab values analyzed",
    },
    {
      value: hasBiomarkers
        ? String(biomarkerAnalysis.derived_biomarkers?.length ?? 0)
        : "--",
      label: "Derived biomarkers calculated",
    },
    {
      value: hasBiomarkers ? String(biomarkerAnalysis.score) : "--",
      label: "Bloodwork score out of 100",
    },
    {
      value: hasBiomarkers ? String(actionableBiomarkers.length) : "--",
      label: "Priority markers to review",
    },
    {
      value: hasBiomarkers ? dateStr : "Not connected",
      label: hasBiomarkers ? "Date of data import" : "Connect blood panel",
    },
  ];

  const priorityFindings = actionableBiomarkers.slice(0, 3);
  const biomarkerPriority =
    hasBiomarkers && priorityFindings.length > 0
      ? {
          title: "Highest-leverage lab signals",
          body: "These direct or derived biomarkers are furthest from the wellness target. They are sorted first because they are the clearest places to act and retest.",
          markers: priorityFindings.map((b) => ({
            name: b.name,
            value: b.display_value ?? `${b.value} ${b.unit}`,
            statusLabel: b.status_label ?? b.status,
            target: b.target_label ?? "",
            trendLabel: biomarkerTrends.get(b.id)?.trend_label ?? "",
          })),
        }
      : {
          title: "No blood panel connected",
          body: "Export your blood panel as CSV and re-run the pipeline with --biomarkers=path.csv to see your biomarker analysis here.",
          markers: [],
        };

  const biomarkerCategories = hasBiomarkers
    ? buildBiomarkerCategoriesFromAnalysis(biomarkerAnalysis, biomarkerTrends)
    : [];

  // ── Behavioral (wearable) sections ───────────────────────────────────────
  const wearableFindingCount = hasWearables
    ? wearableAnalysis.findings.length
    : 0;
  const wearablesInTarget = hasWearables
    ? wearableAnalysis.findings.filter((f) => f.status === "optimal").length
    : 0;
  const actionableWearables = hasWearables
    ? wearableAnalysis.findings.filter((f) => f.status !== "optimal").length
    : 0;
  const wearableWindows = Array.from(
    new Set(
      (options.wearableReadings ?? [])
        .map((reading) => reading.window_days)
        .filter((days): days is number => Number.isFinite(days))
    )
  ).sort((a, b) => a - b);
  const wearableWindowLabel = hasWearables
    ? wearableWindows.length === 1
      ? `${wearableWindows[0]} d`
      : wearableWindows.length > 1
      ? `${wearableWindows[0]}-${wearableWindows[wearableWindows.length - 1]} d`
      : "30 d"
    : "--";
  const wearableStats = [
    {
      value: hasWearables
        ? `${wearablesInTarget}/${wearableFindingCount}`
        : "--",
      label: "Signals in target",
    },
    {
      value: String(wearableAnalysis.measured_count ?? 0),
      label: "Signals tracked",
    },
    {
      value: hasWearables ? String(wearableAnalysis.score ?? 0) : "--",
      label: "Behavioral score out of 100",
    },
    {
      value: hasWearables ? String(actionableWearables) : "--",
      label: "Priority signals to review",
    },
    { value: wearableWindowLabel, label: "Behavioral time window" },
  ];

  // Build domain cards directly from the analyzeWearables output so every marker
  // shows its scored status and interpretation text rather than a fixed "watch".
  const wearableDomains = hasWearables
    ? wearableAnalysis.domains
        .filter((d) => d.measured > 0)
        .sort((a, b) => a.score - b.score)
        .map((d) => {
          const domainFindings = wearableAnalysis.findings.filter(
            (f) => f.domain === d.id
          );
          const topFinding = domainFindings.find((f) => f.status !== "optimal");
          return {
            title: d.name,
            score: d.score,
            scoreStatus: d.status,
            summary: topFinding
              ? topFinding.interpretation
              : `${d.measured} signal${
                  d.measured !== 1 ? "s" : ""
                } measured — all within healthy ranges.`,
            markers: domainFindings.map((f) => ({
              name: f.name,
              tech: "",
              value: `${f.value} ${f.unit}`.trim(),
              status: f.status,
              statusLabel: f.status_label ?? f.status,
              targetLabel: f.target_label ?? "",
              priorityRank: f.priority_rank,
              interpretation: f.interpretation,
              action: f.action,
            })),
          };
        })
    : [];

  // ── Assemble ───────────────────────────────────────────────────────────────
  const dashboardData = {
    member: { name: userId, initials, lastUpdated: dateStr },
    biomarker_analysis: biomarkerAnalysis,
    wearable_analysis: wearableAnalysis,
    multimodal_plan: multimodalPlan,
    quality: {
      vep_status: output.metadata.vep_status ?? "skipped",
      local_vcf_coverage: output.metadata.local_vcf_coverage,
      total_variants: output.metadata.variant_count ?? 0,
      annotated_variants: output.metadata.annotated_count ?? 0,
      matched_markers:
        output.metadata.matched_marker_count ??
        output.metadata.curated_markers ??
        0,
      rsid_annotation_source: output.metadata.rsid_annotation_source,
      rsid_annotation_note: output.metadata.rsid_annotation_limitation,
      clinvar_confidence_counts:
        output.metadata.clinvar_confidence_counts ?? {},
      clinvar_not_diagnostic:
        "ClinVar findings are educational and require clinical confirmation before medical action.",
      clinvar_vus_note:
        "Variants of uncertain significance are shown as uncertain context only and are not used as medical action triggers.",
    },

    signature: {
      eyebrow: "Standout variants",
      headlineBefore: "You carry",
      headlineAfter: "genes that put you ahead.",
      sub: "Out of the millions of variants in your genome, these few are both uncommon and firmly on your side. You were born with them, and they are yours for life.",
      edges: edges.filter(Boolean),
    },

    identity: { pillars },
    healthspan: {
      gli: gliScore100,
      gliStatus,
      percentile: gliScore100,
      focusAreas,
      subscores,
      connected,
    },
    tracking,
    plan: {
      intro: `This is ${userId}'s personalized action plan. ${planSummary}`,
      summary: planSummary,
      coverage: planCoverage,
      priorities: planPriorities,
      maintain: maintainTraits,
      reviewItems: planReviewItems,
      nextContext: planNextContext,
      emptyState: planPriorities.length === 0,
    },

    geneticStats,
    genomicCoverage,
    polygenic,
    strengths,
    hereditary: hereditaryVariants,
    drugGene,
    hallmarks,
    gwasTraits: output.metadata.gwas_traits ?? null,

    biomarkerStats,
    biomarkerPriority,
    biomarkerCategories,

    wearableStats,
    wearableDomains,
  };

  return JSON.stringify(dashboardData, null, 2);
}

function roundDelta(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatTrendDelta(delta: number, unit: string): string {
  const value = roundDelta(delta);
  const sign = value > 0 ? "+" : "";
  return `${sign}${value}${unit ? ` ${unit}` : ""}`;
}

function buildBiomarkerTrendMap(
  current: BiomarkerAnalysisSummary,
  previous?: BiomarkerAnalysisSummary
): Map<string, { trend_delta: number; trend_label: string }> {
  const trends = new Map<
    string,
    { trend_delta: number; trend_label: string }
  >();
  if (!previous) return trends;

  const previousById = new Map(
    previous.findings.map((finding) => [finding.id, finding])
  );
  for (const finding of current.findings) {
    const prior = previousById.get(finding.id);
    if (!prior) continue;
    if (finding.unit && prior.unit && finding.unit !== prior.unit) continue;

    const delta = roundDelta(finding.value - prior.value);
    const scoreDelta = finding.score - prior.score;
    const deltaText = formatTrendDelta(delta, finding.unit);
    const trendLabel =
      scoreDelta >= 3
        ? `Improved, ${deltaText} since last panel`
        : scoreDelta <= -3
        ? `Moved away from target, ${deltaText} since last panel`
        : `Stable, ${deltaText} since last panel`;

    trends.set(finding.id, { trend_delta: delta, trend_label: trendLabel });
  }
  return trends;
}

/** Group analyzed biomarkers into body-system cards, with derived values appended. */
function buildBiomarkerCategoriesFromAnalysis(
  analysis: BiomarkerAnalysisSummary,
  trends: Map<string, { trend_delta: number; trend_label: string }> = new Map()
): Array<{
  title: string;
  score: number;
  scoreStatus: string;
  summary: string;
  markers: Array<{
    name: string;
    tech: string;
    value: string;
    status: string;
    statusLabel: string;
    targetLabel: string;
    priorityRank?: number;
    trendLabel?: string;
    trendDelta?: number;
    info: string;
  }>;
}> {
  const statusFor = (
    status: string
  ): "optimal" | "watch" | "attention" | "neutral" => {
    if (status === "optimal") return "optimal";
    if (status === "watch") return "watch";
    if (status === "needs_attention") return "attention";
    return "neutral";
  };

  const valuesById = new Map([
    ...(analysis.lab_data ?? []).map(
      (value) => [value.id, value.display_value] as const
    ),
    ...(analysis.derived_biomarkers ?? []).map(
      (value) => [value.id, value.display_value] as const
    ),
  ]);
  const findingById = new Map(
    analysis.findings.map((finding) => [finding.id, finding])
  );
  const rowsFor = (ids: string[]) =>
    ids
      .map((id) => findingById.get(id))
      .filter((finding): finding is BiomarkerFinding => Boolean(finding))
      .map((finding) => ({
        name: finding.name,
        tech: finding.source_type === "derived" ? "Calculated" : "Lab result",
        value:
          valuesById.get(finding.id) ??
          finding.display_value ??
          `${finding.value} ${finding.unit}`,
        status: statusFor(finding.status),
        statusLabel: finding.status_label ?? finding.status.replace(/_/g, " "),
        targetLabel: finding.target_label ?? "",
        priorityRank: finding.priority_rank,
        trendLabel: trends.get(finding.id)?.trend_label,
        trendDelta: trends.get(finding.id)?.trend_delta,
        info:
          finding.source_type === "derived"
            ? `Derived biomarker. ${finding.interpretation} ${finding.action}`
            : `${finding.interpretation} ${finding.action}`,
      }));

  const derivedIds = (analysis.derived_biomarkers ?? []).map((item) => item.id);
  const domainGroups = analysis.domains
    .filter((domain) => domain.measured > 0)
    .map((domain) => {
      const ids = analysis.findings
        .filter(
          (finding) =>
            finding.domain === domain.id && finding.source_type !== "derived"
        )
        .map((finding) => finding.id);
      return {
        title: domain.name,
        score: domain.score,
        scoreStatus: statusFor(domain.status),
        summary: `${rowsFor(ids).length} marker${
          rowsFor(ids).length === 1 ? "" : "s"
        } analyzed in this body system, ordered by distance from target.`,
        markers: rowsFor(ids),
      };
    })
    .filter((group) => group.markers.length > 0)
    .sort((a, b) => a.score - b.score || b.markers.length - a.markers.length);

  const derivedOnly = rowsFor(derivedIds);
  return [
    ...domainGroups,
    derivedOnly.length > 0
      ? {
          title: "Derived biomarkers",
          score: derivedOnly.length
            ? Math.round(
                derivedOnly.reduce(
                  (sum, item) =>
                    sum +
                    (item.status === "optimal"
                      ? 90
                      : item.status === "watch"
                      ? 60
                      : 35),
                  0
                ) / derivedOnly.length
              )
            : 0,
          scoreStatus: derivedOnly.some((item) => item.status === "attention")
            ? "attention"
            : derivedOnly.some((item) => item.status === "watch")
            ? "watch"
            : "optimal",
          summary: `${derivedOnly.length} calculated value${
            derivedOnly.length === 1 ? "" : "s"
          } derived from the direct labs.`,
          markers: derivedOnly,
        }
      : null,
  ].filter(Boolean) as Array<{
    title: string;
    score: number;
    scoreStatus: string;
    summary: string;
    markers: Array<{
      name: string;
      tech: string;
      value: string;
      status: string;
      statusLabel: string;
      targetLabel: string;
      priorityRank?: number;
      trendLabel?: string;
      trendDelta?: number;
      info: string;
    }>;
  }>;
}

/** Group raw biomarker readings into the body-system categories expected by the dashboard. */
function buildBiomarkerCategoriesFromReadings(
  readings: Array<{
    name: string;
    value: number;
    unit: string;
    referenceMin?: number;
    referenceMax?: number;
    flag?: string;
  }>
): Array<{
  title: string;
  score: number;
  scoreStatus: string;
  summary: string;
  markers: Array<{
    name: string;
    tech: string;
    value: string;
    status: string;
    info: string;
  }>;
}> {
  const categories: Array<{ title: string; keywords: string[] }> = [
    {
      title: "Heart & cholesterol",
      keywords: [
        "cholesterol",
        "ldl",
        "hdl",
        "triglyceride",
        "apob",
        "lpa",
        "homocysteine",
        "lipid",
      ],
    },
    {
      title: "Blood sugar & insulin",
      keywords: ["glucose", "hba1c", "insulin", "homa", "a1c"],
    },
    {
      title: "Inflammation & immune",
      keywords: [
        "crp",
        "ferritin",
        "esr",
        "wbc",
        "albumin",
        "inflammation",
        "immune",
      ],
    },
    {
      title: "Vitamins & nutrients",
      keywords: [
        "vitamin",
        "omega",
        "folate",
        "b12",
        "magnesium",
        "zinc",
        "selenium",
      ],
    },
    {
      title: "Liver",
      keywords: ["alt", "ast", "ggt", "alp", "bilirubin", "liver"],
    },
    {
      title: "Kidney & electrolytes",
      keywords: ["creatinine", "egfr", "bun", "sodium", "potassium", "kidney"],
    },
    {
      title: "Thyroid & hormones",
      keywords: [
        "tsh",
        "thyroid",
        "testosterone",
        "cortisol",
        "estrogen",
        "hormone",
      ],
    },
    {
      title: "Blood count",
      keywords: [
        "hemoglobin",
        "hematocrit",
        "rbc",
        "platelet",
        "neutrophil",
        "lymphocyte",
        "cbc",
      ],
    },
  ];

  const statusFromFlag = (
    flag?: string
  ): "optimal" | "watch" | "attention" | "neutral" => {
    if (!flag || flag === "N" || flag === "normal") return "optimal";
    if (flag === "H" || flag === "L") return "watch";
    return "attention";
  };

  return categories
    .map((cat) => {
      const matched = readings.filter((r) =>
        cat.keywords.some((k) => r.name.toLowerCase().includes(k))
      );
      if (matched.length === 0) return null;

      const scores = matched.map((r) =>
        statusFromFlag(r.flag) === "optimal"
          ? 80
          : statusFromFlag(r.flag) === "watch"
          ? 55
          : 30
      );
      const avgScore = Math.round(
        scores.reduce((s, v) => s + v, 0) / scores.length
      );
      const scoreStatus =
        avgScore >= 70 ? "optimal" : avgScore >= 50 ? "watch" : "attention";

      return {
        title: cat.title,
        score: avgScore,
        scoreStatus,
        summary: `${matched.length} marker${
          matched.length !== 1 ? "s" : ""
        } in this category.`,
        markers: matched.map((r) => ({
          name: r.name,
          tech: "",
          value: `${r.value} ${r.unit}`,
          status: statusFromFlag(r.flag),
          info:
            r.flag && r.flag !== "N" && r.flag !== "normal"
              ? `This marker is outside its reference range (${
                  r.referenceMin ?? "?"
                } - ${r.referenceMax ?? "?"} ${
                  r.unit
                }). Discuss with your clinician.`
              : "This marker is within its reference range.",
        })),
      };
    })
    .filter(Boolean) as any[];
}

/** Group raw wearable readings into domain panels expected by the dashboard. */
function buildWearableDomainsFromReadings(
  readings: Array<{ metric: string; value: number; unit?: string }>
): Array<{
  title: string;
  score: number;
  scoreStatus: string;
  summary: string;
  markers: Array<{ name: string; tech: string; value: string; status: string }>;
}> {
  const domains: Array<{ title: string; keywords: string[] }> = [
    {
      title: "Cardiovascular recovery",
      keywords: ["hrv", "rhr", "heart", "spo2", "oxygen", "recovery"],
    },
    {
      title: "Sleep & rest",
      keywords: ["sleep", "deep", "rem", "awake", "bedtime"],
    },
    {
      title: "Movement & training",
      keywords: ["steps", "active", "calories", "workout", "zone", "training"],
    },
    {
      title: "Daily rhythm",
      keywords: ["strain", "stress", "readiness", "variability"],
    },
  ];

  return domains
    .map((d) => {
      const matched = readings.filter((r) =>
        d.keywords.some((k) => r.metric.toLowerCase().includes(k))
      );
      if (matched.length === 0) return null;
      return {
        title: d.title,
        score: 60,
        scoreStatus: "watch",
        summary: `${matched.length} signal${
          matched.length !== 1 ? "s" : ""
        } connected in this domain.`,
        markers: matched.map((r) => ({
          name: r.metric,
          tech: "",
          value: `${r.value}${r.unit ? " " + r.unit : ""}`,
          status: "watch" as const,
        })),
      };
    })
    .filter(Boolean) as any[];
}

// ============================================================================
// CLI Entry Point
// Only runs when executed directly (not when imported as a module)
// ============================================================================

if (
  process.argv[1] &&
  (process.argv[1].endsWith("/index.ts") ||
    process.argv[1].endsWith("/index.js"))
) {
  (async function main() {
    const {
      runHealthAnalysis,
      saveHealthAnalysisOutput,
      summarizeRunForConsole,
    } = await import("./health_analysis.js");
    const { runInputDoctor, renderDoctorReport } = await import(
      "./input_doctor.js"
    );

    const HELP_TEXT = `
🧬 foreverbetter Health Pipeline

Usage:
  npm run pipeline -- --genetics=path [--biomarkers=path] [--biomarkers-previous=path] [--wearables=path] [--dbsnp=path] [--user=id] [--out=dir]
  npm run pipeline -- --biomarkers=path [--wearables=path] [--user=id] [--out=dir]
  npm run pipeline -- --wearables=path [--user=id] [--out=dir]
  npm run pipeline -- --doctor [--genetics=path] [--biomarkers=path] [--wearables=path]
  npm run sample:report

At least one of --genetics, --biomarkers, or --wearables must be supplied.
Genetics is optional — the pipeline will run on any combination of supplied modalities.

Examples:
  Biomarkers + wearables, no genetics:
    npm run pipeline -- --biomarkers=examples/sample-biomarkers.csv --wearables=examples/sample-whoop-api.json --user=user_001 --out=./output

  Genetics + biomarkers:
    npm run pipeline -- --genetics=/path/to/sample.vcf.gz --biomarkers=examples/sample-biomarkers.csv --user=user_001 --out=./output

  Doctor (preflight only):
    npm run pipeline -- --doctor --biomarkers=examples/sample-biomarkers.csv --wearables=examples/sample-whoop-api.json

Supported flags:
  --genetics=<path>             VCF/VCF.GZ, 23andMe raw text, AncestryDNA raw text
  --biomarkers=<path>           CSV / JSON / plain-text lab export
  --biomarkers-previous=<path>  Prior biomarker panel (enables trend deltas)
  --wearables=<path>            WHOOP / Oura / Apple Health CSV or JSON export
  --dbsnp=<path>                Optional full GRCh37 dbSNP VCF; opts into broad rsID recovery
  --user=<id>                   Identifier for the report (default: user_001)
  --out=<dir>                   Output directory (default: ./output)
  --design=<id|path>            Dashboard layout: foreverbetter (the full all-modality
                                Healthspan dossier), ring-data, performance, apex,
                                clinical-modern (default), metabolic,
                                system-cards, serene, or a custom tokens JSON.
                                "dossier" remains a backwards-compatible alias.
                                index.html uses it; deep-dive.html always keeps
                                the full dossier view. Preview: npm run design:vet
  --doctor                      Preflight inputs and exit without analysis
  --help, -h                    Show this help

Positioning:
  - Wellness and healthspan education only
  - Raw data stays local unless you move/upload it yourself
  - Not a diagnosis, treatment plan, or clinical decision tool

Output:
  - {out}/{user}_action_plan.json       Canonical PersonalizedActionPlan
  - {out}/{user}_health_analysis.json   Observations + plan summary
  - {out}/{user}_dashboard.json         Full dashboard JSON (genetics-supplied runs)
  - {out}/index.html                    Rendered dashboard (genetics-supplied runs)

Note: positional arguments are no longer accepted. Use the named flags above.
`;

    const args = process.argv.slice(2);

    // Reject positional arguments with an explicit, named-flag-pointing error.
    const positional = args.filter(
      (arg) => !arg.startsWith("--") && !arg.startsWith("-")
    );
    if (positional.length > 0) {
      console.error("❌ Positional arguments are no longer supported.");
      console.error("");
      console.error(
        `   You supplied: ${positional.map((p) => `"${p}"`).join(" ")}`
      );
      console.error("");
      console.error("   Use named flags instead:");
      console.error(
        "     npm run pipeline -- --genetics=path --biomarkers=path --wearables=path --user=id --out=dir"
      );
      console.error("");
      console.error("   Examples:");
      console.error(
        "     npm run pipeline -- --genetics=/path/to/file.vcf.gz --user=user_001 --out=./output"
      );
      console.error(
        "     npm run pipeline -- --biomarkers=examples/sample-biomarkers.csv --wearables=examples/sample-whoop-api.json"
      );
      console.error("");
      console.error(
        "   See `npm run pipeline -- --help` for the full flag list."
      );
      process.exit(2);
    }

    const help = args.includes("--help") || args.includes("-h");
    const doctorMode = args.includes("--doctor");

    function flag(name: string): string | undefined {
      const prefix = `--${name}=`;
      const found = args.find((arg) => arg.startsWith(prefix));
      return found ? found.slice(prefix.length) : undefined;
    }

    const geneticsPath = flag("genetics");
    const biomarkersPath = flag("biomarkers");
    const previousBiomarkersPath = flag("biomarkers-previous");
    const wearablesPath = flag("wearables");
    const dbsnpPath = flag("dbsnp");
    const userId = flag("user") ?? "user_001";
    const outputDir = flag("out") ?? "./output";

    // Reject unknown flags so a typo never silently runs the wrong thing.
    const KNOWN_FLAGS = new Set([
      "--genetics",
      "--biomarkers",
      "--biomarkers-previous",
      "--wearables",
      "--dbsnp",
      "--user",
      "--out",
      "--design",
      "--doctor",
      "--help",
      "-h",
    ]);
    for (const arg of args) {
      if (!arg.startsWith("-")) continue;
      if (KNOWN_FLAGS.has(arg)) continue;
      const flagName = arg.split("=")[0];
      if (KNOWN_FLAGS.has(flagName!)) continue;
      console.error(`❌ Unknown flag: ${flagName}`);
      console.error(
        "   Run `npm run pipeline -- --help` for the supported flag list."
      );
      process.exit(2);
    }

    if (help || args.length === 0) {
      console.log(HELP_TEXT);
      process.exit(help ? 0 : 0);
    }

    if (doctorMode) {
      const report = runInputDoctor({
        geneticsPath,
        biomarkersPath,
        previousBiomarkersPath,
        wearablesPath,
      });
      console.log(renderDoctorReport(report));
      fs.mkdirSync(outputDir, { recursive: true });
      const reportPath = path.join(outputDir, `${userId}_input_doctor.json`);
      fs.writeFileSync(
        reportPath,
        `${JSON.stringify(report, null, 2)}\n`,
        "utf8"
      );
      console.log(`\nReport JSON saved: ${path.resolve(reportPath)}`);
      process.exit(report.any_error ? 1 : 0);
    }

    // Require at least one modality.
    if (!geneticsPath && !biomarkersPath && !wearablesPath) {
      console.error("❌ No modality supplied.");
      console.error(
        "   Supply at least one of --genetics, --biomarkers, --wearables."
      );
      console.error("   Run `npm run pipeline -- --help` for examples.");
      process.exit(2);
    }

    // Preflight existence checks for any supplied path; surface a clear error before doing work.
    const preflight = runInputDoctor({
      geneticsPath,
      biomarkersPath,
      previousBiomarkersPath,
      wearablesPath,
    });
    if (preflight.any_error) {
      console.error(renderDoctorReport(preflight));
      process.exit(1);
    }

    const supplied: string[] = [];
    if (geneticsPath) supplied.push(`genetics=${geneticsPath}`);
    if (biomarkersPath) supplied.push(`biomarkers=${biomarkersPath}`);
    if (previousBiomarkersPath)
      supplied.push(`biomarkers-previous=${previousBiomarkersPath}`);
    if (wearablesPath) supplied.push(`wearables=${wearablesPath}`);
    if (dbsnpPath) supplied.push("dbsnp=custom reference");

    console.log("🚀 Starting health pipeline");
    console.log(`   User: ${userId}`);
    console.log(`   Output: ${path.resolve(outputDir)}`);
    for (const line of supplied) console.log(`   ${line}`);
    console.log("");

    try {
      const result = await runHealthAnalysis({
        user_id: userId,
        geneticsPath,
        biomarkersPath,
        previousBiomarkersPath,
        wearablesPath,
        dbsnpPath,
        logDir: geneticsPath ? outputDir : undefined,
        wgsArtifactsDir: geneticsPath ? outputDir : undefined,
      });

      // Always save the canonical plan + analysis summary.
      const saved = saveHealthAnalysisOutput(result, { outputDir });

      // When genetics is supplied, also render the existing dashboard so the
      // rich genomic sections remain available. The dashboard renderer
      // migration to the canonical plan lands in Milestone 4.
      let htmlPath: string | undefined;
      if (result.genomic_output) {
        const output = result.genomic_output;
        savePipelineOutput(output, userId, outputDir);

        console.log("🎨 Rendering dashboard HTML...");
        const scriptDir = path.dirname(fileURLToPath(import.meta.url));
        const templatePath = path.resolve(
          scriptDir,
          "../../templates/longevity-dashboard.html"
        );
        const template = injectTheme(
          fs.readFileSync(templatePath, "utf-8"),
          process.argv.find((a) => a.startsWith("--design="))?.split("=")[1]
        );
        const biomarkerReadings = biomarkersPath
          ? parseBiomarkerFile(biomarkersPath)
          : [];
        const previousBiomarkerReadings = previousBiomarkersPath
          ? parseBiomarkerFile(previousBiomarkersPath)
          : [];
        const wearableReadings = wearablesPath
          ? parseWearableFile(wearablesPath)
          : [];
        const dashboardJson = buildDashboardJSON(output, {
          userId,
          biomarkerReadings: biomarkerReadings.map((reading) => ({
            name: reading.id,
            value: reading.value,
            unit: reading.unit ?? "",
            collected_at: reading.collected_at,
          })),
          previousBiomarkerReadings: previousBiomarkerReadings.map(
            (reading) => ({
              name: reading.id,
              value: reading.value,
              unit: reading.unit ?? "",
              collected_at: reading.collected_at,
            })
          ),
          wearableReadings: wearableReadings.map((reading) => ({
            metric: reading.id,
            value: reading.value,
            unit: reading.unit,
          })),
          personalizedActionPlan: result.plan,
        });
        const dashboardData = transformToDashboardData(output, {
          biomarkerReadings,
          previousBiomarkerReadings,
          wearableReadings,
        });
        // Attach the canonical plan so M4 / downstream consumers can render it directly.
        (
          dashboardData as { personalized_action_plan?: typeof result.plan }
        ).personalized_action_plan = result.plan;
        const html = renderDashboard(template, dashboardData, dashboardJson);
        // Primary dashboard = the chosen distinct design layout. The deep genomic
        // template is preserved as deep-dive.html.
        const styledDesign = process.argv
          .find((a) => a.startsWith("--design="))
          ?.split("=")[1];
        // The `foreverbetter` design IS the full deep Healthspan dossier dashboard, so
        // its index.html is that same all-modality render; every other design gets
        // its own distinct per-design layout. deep-dive.html is always the deep view.
        const styled = isFullDashboardDesign(styledDesign)
          ? html
          : renderFullDashboard(JSON.parse(dashboardJson), styledDesign);
        htmlPath = path.join(outputDir, "index.html");
        fs.writeFileSync(htmlPath, styled, "utf-8");
        fs.writeFileSync(path.join(outputDir, "deep-dive.html"), html, "utf-8");
        console.log(
          `📄 Dashboard saved: ${htmlPath} (design: ${
            styledDesign ?? "clinical-modern"
          }; deep genomic view: deep-dive.html)`
        );

        // Clean up decompressed temp files to avoid accumulating disk waste
        if (geneticsPath) {
          try {
            const tempPatterns = [".decompressed.tmp.vcf", ".tmp.vcf"];
            const baseDir = path.dirname(path.resolve(geneticsPath));
            const files = fs.readdirSync(baseDir);
            for (const f of files) {
              if (tempPatterns.some((p) => f.includes(p))) {
                const filePath = path.join(baseDir, f);
                fs.unlinkSync(filePath);
                console.log(
                  `🧹 Cleaned up temp file: ${path.basename(filePath)}`
                );
              }
            }
          } catch {
            // best-effort
          }
        }
      } else {
        // No genetics: render the same dashboard with a neutral genomic stub so
        // the canonical Plan tab is identical to the genetics-supplied flow.
        console.log(
          "ℹ️  Genetics not supplied — rendering modality-optional dashboard."
        );
        const { emptyGenomicOutput } = await import("./health_analysis.js");
        const stub = emptyGenomicOutput(userId);
        const scriptDir = path.dirname(fileURLToPath(import.meta.url));
        const templatePath = path.resolve(
          scriptDir,
          "../../templates/longevity-dashboard.html"
        );
        const template = injectTheme(
          fs.readFileSync(templatePath, "utf-8"),
          process.argv.find((a) => a.startsWith("--design="))?.split("=")[1]
        );
        const biomarkerReadings = biomarkersPath
          ? parseBiomarkerFile(biomarkersPath)
          : [];
        const previousBiomarkerReadings = previousBiomarkersPath
          ? parseBiomarkerFile(previousBiomarkersPath)
          : [];
        const wearableReadings = wearablesPath
          ? parseWearableFile(wearablesPath)
          : [];
        const dashboardJson = buildDashboardJSON(stub, {
          userId,
          biomarkerReadings: biomarkerReadings.map((reading) => ({
            name: reading.id,
            value: reading.value,
            unit: reading.unit ?? "",
            collected_at: reading.collected_at,
          })),
          previousBiomarkerReadings: previousBiomarkerReadings.map(
            (reading) => ({
              name: reading.id,
              value: reading.value,
              unit: reading.unit ?? "",
              collected_at: reading.collected_at,
            })
          ),
          wearableReadings: wearableReadings.map((reading) => ({
            metric: reading.id,
            value: reading.value,
            unit: reading.unit,
          })),
          personalizedActionPlan: result.plan,
        });
        const dashboardData = transformToDashboardData(stub, {
          biomarkerReadings,
          previousBiomarkerReadings,
          wearableReadings,
        });
        (
          dashboardData as { personalized_action_plan?: typeof result.plan }
        ).personalized_action_plan = result.plan;
        const html = renderDashboard(template, dashboardData, dashboardJson);
        // Primary dashboard = the chosen distinct design layout. The deep genomic
        // template is preserved as deep-dive.html.
        const styledDesign = process.argv
          .find((a) => a.startsWith("--design="))
          ?.split("=")[1];
        // The `foreverbetter` design IS the full deep Healthspan dossier dashboard, so
        // its index.html is that same all-modality render; every other design gets
        // its own distinct per-design layout. deep-dive.html is always the deep view.
        const styled = isFullDashboardDesign(styledDesign)
          ? html
          : renderFullDashboard(JSON.parse(dashboardJson), styledDesign);
        htmlPath = path.join(outputDir, "index.html");
        fs.writeFileSync(htmlPath, styled, "utf-8");
        fs.writeFileSync(path.join(outputDir, "deep-dive.html"), html, "utf-8");
        console.log(
          `📄 Dashboard saved: ${htmlPath} (design: ${
            styledDesign ?? "clinical-modern"
          }; deep genomic view: deep-dive.html)`
        );
      }

      console.log("");
      console.log("=".repeat(50));
      console.log("📊 PIPELINE SUMMARY");
      console.log("=".repeat(50));
      console.log(summarizeRunForConsole(result));
      console.log("");
      console.log("Your files stayed on this machine.");
      console.log("");
      console.log("Output:");
      console.log(`  action plan:    ${path.resolve(saved.plan_path)}`);
      console.log(`  analysis:       ${path.resolve(saved.analysis_path)}`);
      if (htmlPath) {
        console.log(`  dashboard html: ${path.resolve(htmlPath)}`);
      }

      console.log("");
      console.log("✅ Pipeline complete!");

      // Keep generated reports on disk. Opening a browser is an explicit user
      // action so pipeline runs remain quiet in agent and terminal workflows.
      printDailyActionPlanCronPrompt(outputDir);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("❌ Pipeline failed");

      if (msg.includes("bcftools") || msg.includes("command not found")) {
        console.error(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  bcftools is required but not found.

  Install:
    macOS:  brew install htslib
    Linux:  sudo apt install bcftools

  Then re-run the pipeline.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      } else if (msg.includes("ENOENT") && msg.includes("dbsnp")) {
        console.error(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  dbSNP reference database not found.

  Download and index the reference:
    bcftools index reference/dbsnp/GCF_000001405.25.gz

  This requires the 26GB dbSNP GRCh37 file.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      } else if (msg.includes("ENOENT")) {
        console.error(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Input file not found.

  Run \`npm run pipeline -- --doctor [--flags...]\` to preflight every
  supplied path and see exactly which file is missing.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      } else if (
        msg.includes("ENOSPC") ||
        msg.includes("disk") ||
        msg.includes("space")
      ) {
        console.error(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Not enough disk space.

  The pipeline needs ~30GB free for temporary VCF
  decompression. Free up space and re-run.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      } else if (msg.includes("VCF") || msg.includes("vcf")) {
        console.error(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Error processing the genetics file.

  Check that:
    - The file is a valid VCF (bgzip compressed)
    - The file is not corrupted
    - You have read permissions

  Details: ${msg}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      } else {
        console.error(`   ${msg}`);
      }
      process.exit(1);
    }
  })();
} // end CLI-only block

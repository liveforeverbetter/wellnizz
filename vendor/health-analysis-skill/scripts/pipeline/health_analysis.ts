/**
 * Modality-optional health analysis orchestrator.
 *
 * Accepts any subset of {genetics, biomarkers, wearables}, runs each
 * analyzer independently, normalizes the outputs into observations, and
 * composes one canonical PersonalizedActionPlan. Genetics is never
 * required; the WGS pipeline only runs when a genetics file is supplied.
 */

import * as fs from "fs";
import * as path from "path";

import { runPipelineFromVCF } from "./index.js";
import type { DashboardOutput } from "./index.js";
import { analyzeBiomarkers } from "./biomarker_engine.js";
import type { UserProfile } from "./biomarker_engine.js";
import { analyzeWearables } from "./wearable_engine.js";
import type {
  BiomarkerAnalysisSummary,
  WearableAnalysisSummary,
} from "../../shared/dashboard-types.js";
import { parseBiomarkerFile, parseWearableFile } from "./health_data_import.js";
import {
  buildNormalizedObservations,
  type GeneticInputView,
} from "./observation_adapters.js";
import { composePersonalizedActionPlan } from "./action_plan_composer.js";
import type { ComposerOptions } from "./action_plan_composer.js";
import type {
  NormalizedObservation,
  ObservationModality,
} from "./observation_types.js";
import type { PersonalizedActionPlan } from "../../shared/dashboard-types.js";

export interface HealthAnalysisInput {
  user_id?: string;
  geneticsPath?: string;
  biomarkersPath?: string;
  previousBiomarkersPath?: string;
  wearablesPath?: string;
  /** Optional full GRCh37 dbSNP VCF; selecting it opts out of the lean default. */
  dbsnpPath?: string;
  userProfile?: UserProfile;
  logDir?: string;
  wgsArtifactsDir?: string;
  /** Deterministic timestamp for tests. */
  generated_at?: string;
}

export interface HealthAnalysisResult {
  user_id: string;
  generated_at: string;
  /** Modalities the caller supplied (file path present). */
  modalities_supplied: ObservationModality[];
  /** Modalities that produced at least one observation. */
  modalities_with_observations: ObservationModality[];
  observations: NormalizedObservation[];
  plan: PersonalizedActionPlan;
  genomic_output?: DashboardOutput;
  biomarker_analysis?: BiomarkerAnalysisSummary;
  previous_biomarker_analysis?: BiomarkerAnalysisSummary;
  wearable_analysis?: WearableAnalysisSummary;
}

function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Adapter that lifts a DashboardOutput into the genetics adapter input view.
 * Kept inline so callers do not have to know the genomic schema.
 */
function genomicViewFromOutput(
  output: DashboardOutput | undefined
): GeneticInputView | undefined {
  if (!output) return undefined;
  return { variant_cards: output.metadata?.variant_cards };
}

export async function runHealthAnalysis(
  input: HealthAnalysisInput
): Promise<HealthAnalysisResult> {
  const user_id = input.user_id ?? "user_001";
  const generated_at = input.generated_at ?? nowISO();

  const supplied: ObservationModality[] = [];
  if (input.geneticsPath) supplied.push("genetics");
  if (input.biomarkersPath) supplied.push("biomarkers");
  if (input.wearablesPath) supplied.push("wearables");

  // Genetics: run the existing WGS pipeline only when a file is supplied.
  let genomic_output: DashboardOutput | undefined;
  if (input.geneticsPath) {
    genomic_output = await runPipelineFromVCF(
      input.geneticsPath,
      user_id,
      input.logDir,
      {
        dbsnpPath: input.dbsnpPath,
        wgsArtifactsDir: input.wgsArtifactsDir,
      }
    );
  }

  // Biomarkers: parse + analyze (current + optional previous panel).
  let biomarker_analysis: BiomarkerAnalysisSummary | undefined;
  let previous_biomarker_analysis: BiomarkerAnalysisSummary | undefined;
  if (input.biomarkersPath) {
    const readings = parseBiomarkerFile(input.biomarkersPath);
    biomarker_analysis = analyzeBiomarkers(readings, input.userProfile);
  }
  if (input.previousBiomarkersPath) {
    const previous = parseBiomarkerFile(input.previousBiomarkersPath);
    previous_biomarker_analysis = analyzeBiomarkers(
      previous,
      input.userProfile
    );
  }

  // Wearables: parse + analyze.
  let wearable_analysis: WearableAnalysisSummary | undefined;
  if (input.wearablesPath) {
    const readings = parseWearableFile(input.wearablesPath);
    wearable_analysis = analyzeWearables(readings);
  }

  // Normalize.
  const observations = buildNormalizedObservations({
    biomarkers: biomarker_analysis,
    wearables: wearable_analysis,
    genetics: genomicViewFromOutput(genomic_output),
  });

  const composerOptions: ComposerOptions = {
    connected_modalities: supplied,
    generated_at,
  };
  const plan = composePersonalizedActionPlan(observations, composerOptions);

  const presentModalities = new Set<ObservationModality>();
  for (const obs of observations) presentModalities.add(obs.modality);

  return {
    user_id,
    generated_at,
    modalities_supplied: supplied,
    modalities_with_observations: Array.from(presentModalities),
    observations,
    plan,
    genomic_output,
    biomarker_analysis,
    previous_biomarker_analysis,
    wearable_analysis,
  };
}

export interface SaveHealthAnalysisOptions {
  outputDir: string;
  /** Pretty-prints JSON when true (default). */
  pretty?: boolean;
}

export interface SavedHealthAnalysisPaths {
  plan_path: string;
  analysis_path: string;
}

export function saveHealthAnalysisOutput(
  result: HealthAnalysisResult,
  options: SaveHealthAnalysisOptions
): SavedHealthAnalysisPaths {
  fs.mkdirSync(options.outputDir, { recursive: true });
  const planPath = path.join(
    options.outputDir,
    `${result.user_id}_action_plan.json`
  );
  const analysisPath = path.join(
    options.outputDir,
    `${result.user_id}_health_analysis.json`
  );
  const indent = options.pretty === false ? undefined : 2;
  fs.writeFileSync(
    planPath,
    `${JSON.stringify(result.plan, null, indent)}\n`,
    "utf8"
  );
  // Persist a summary that the dashboard renderer (M4) and audit tools can read.
  const analysisSummary = {
    user_id: result.user_id,
    generated_at: result.generated_at,
    modalities_supplied: result.modalities_supplied,
    modalities_with_observations: result.modalities_with_observations,
    observation_count: result.observations.length,
    plan_priority_count: result.plan.priorities.length,
    plan_review_count: result.plan.review_items.length,
    plan_maintenance_count: result.plan.maintenance.length,
    has_genomic_output: Boolean(result.genomic_output),
    has_biomarker_analysis: Boolean(result.biomarker_analysis),
    has_wearable_analysis: Boolean(result.wearable_analysis),
    observations: result.observations,
  };
  fs.writeFileSync(
    analysisPath,
    `${JSON.stringify(analysisSummary, null, indent)}\n`,
    "utf8"
  );
  return { plan_path: planPath, analysis_path: analysisPath };
}

/**
 * Build a minimal genomic-shaped stub for the dashboard JSON builder when
 * genetics is absent. All genetics-derived sections render as neutral
 * "Not connected" placeholders; the canonical plan still drives the Plan tab.
 */
export function emptyGenomicOutput(user_id: string): DashboardOutput {
  return {
    gli: 0,
    gli_rating: "Not connected",
    category_gli: {},
    top_traits: [],
    traits: [],
    priorities: [],
    insights: [],
    protocols: [],
    hallmark: {
      hallmarks: [],
      total_genes_hit: 0,
      hallmarks_affected: 0,
      summary: "Genetics not connected.",
    },
    metadata: {
      user_id,
      processed_at: new Date().toISOString(),
      trait_count: 0,
      insight_count: 0,
      protocol_count: 0,
      hallmark_count: 0,
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
    },
  };
}

export function summarizeRunForConsole(result: HealthAnalysisResult): string {
  const lines: string[] = [];
  const labels: Record<ObservationModality, string> = {
    genetics: "genetics",
    biomarkers: "blood test",
    wearables: "wearable",
  };
  const supplied =
    result.modalities_supplied.map((m) => labels[m]).join(" + ") || "no data";
  lines.push(`Analyzed: ${supplied}`);
  if (result.biomarker_analysis)
    lines.push(
      `  blood: ${result.biomarker_analysis.measured_count} lab values`
    );
  if (result.wearable_analysis)
    lines.push(
      `  wearable: ${result.wearable_analysis.measured_count} signals`
    );
  if (result.genomic_output) {
    const variantCount = result.genomic_output.metadata.variant_count ?? 0;
    lines.push(`  genetics: ${variantCount.toLocaleString()} variants`);
  }
  const priorityCount = result.plan.priorities.length;
  const reviewCount = result.plan.review_items.length;
  lines.push(
    `Created: ${priorityCount} personalized priorit${
      priorityCount === 1 ? "y" : "ies"
    }` +
      (reviewCount > 0
        ? `; ${reviewCount} item${reviewCount === 1 ? "" : "s"} need${
            reviewCount === 1 ? "s" : ""
          } review`
        : "")
  );
  return lines.join("\n");
}

#!/usr/bin/env npx tsx
/**
 * Render a local sample dashboard without processing a user's genetic file.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { renderDashboard } from "../../src/renderer/render.js";
import { injectTheme } from "../../shared/design/theme.js";
import {
  isFullDashboardDesign,
  renderFullDashboard,
} from "../../shared/design/render-designs.js";
import {
  buildDashboardJSON,
  printDailyActionPlanCronPrompt,
  refreshWgsReadinessArtifacts,
  transformToDashboardData,
} from "./index.js";
import type { DashboardOutput } from "./index.js";
import { generateProtocols } from "./protocol_engine.js";
import { parseBiomarkerFile, parseWearableFile } from "./health_data_import.js";
import { buildLocalVcfCoverageReport } from "./local_vcf_coverage.js";
import { buildCompactInterpretationCatalog } from "./compact_interpretation_catalog.js";
import { buildInterpretationDepthReport } from "./interpretation_depth_metrics.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "../..");
const repoDir = path.resolve(packageDir, "../..");
const examplesDir = path.join(packageDir, "examples");
const sampleJsonPath = firstExistingPath([
  path.join(examplesDir, "sample-dashboard.json"),
  path.join(repoDir, "output/test_user_dashboard.json"),
]);
const sampleBiomarkersPath = firstExistingPath([
  path.join(examplesDir, "sample-biomarkers.csv"),
  path.join(repoDir, "example-data/sample-biomarkers.csv"),
]);
const samplePreviousBiomarkersPath = firstExistingPath([
  path.join(examplesDir, "sample-biomarkers-previous.csv"),
  path.join(repoDir, "example-data/sample-biomarkers-previous.csv"),
]);
const sampleWearablesPath = firstExistingPath([
  path.join(examplesDir, "sample-whoop-api.json"),
  path.join(repoDir, "example-data/sample-whoop-api.json"),
]);
const templatePath = path.join(
  packageDir,
  "templates/longevity-dashboard.html"
);
const outputDir = path.join(packageDir, "output/sample");
const outputPath = path.join(outputDir, "index.html");
const localVcfCoveragePath = path.join(
  packageDir,
  "output/local-vcf-coverage.json"
);
const compactCatalogPath = path.join(
  packageDir,
  "output/compact-interpretation-catalog.json"
);
const interpretationDepthPath = path.join(
  packageDir,
  "output/interpretation-depth-report.json"
);

function firstExistingPath(paths: string[]): string {
  return paths.find((candidate) => fs.existsSync(candidate)) ?? paths[0]!;
}

if (!fs.existsSync(sampleJsonPath)) {
  throw new Error(
    `Sample dashboard JSON not found. Expected packaged example at: ${sampleJsonPath}`
  );
}

fs.mkdirSync(outputDir, { recursive: true });
const wgsReadiness = refreshWgsReadinessArtifacts(packageDir);
const localVcfCoverage = await buildLocalVcfCoverageReport({
  repoRoot: repoDir,
  packageDir,
});
fs.writeFileSync(
  localVcfCoveragePath,
  `${JSON.stringify(localVcfCoverage, null, 2)}\n`,
  "utf8"
);
const compactCatalog = buildCompactInterpretationCatalog({ packageDir });
fs.writeFileSync(
  compactCatalogPath,
  `${JSON.stringify(compactCatalog, null, 2)}\n`,
  "utf8"
);
const interpretationDepth = buildInterpretationDepthReport(packageDir);
fs.writeFileSync(
  interpretationDepthPath,
  `${JSON.stringify(interpretationDepth, null, 2)}\n`,
  "utf8"
);

const sampleOutput = JSON.parse(
  fs.readFileSync(sampleJsonPath, "utf8")
) as DashboardOutput;
sampleOutput.protocols = generateProtocols(sampleOutput.traits || []);
sampleOutput.metadata.protocol_count = sampleOutput.protocols.length;
sampleOutput.metadata.local_vcf_coverage = localVcfCoverage.summary;
sampleOutput.metadata.variant_count = Math.max(
  sampleOutput.metadata.variant_count ?? 0,
  localVcfCoverage.summary.total_records
);
sampleOutput.metadata.annotated_count = Math.max(
  sampleOutput.metadata.annotated_count ?? 0,
  localVcfCoverage.summary.annotated_records
);
const template = injectTheme(
  fs.readFileSync(templatePath, "utf8"),
  process.argv.find((a) => a.startsWith("--design="))?.split("=")[1]
);
const biomarkerReadings = fs.existsSync(sampleBiomarkersPath)
  ? parseBiomarkerFile(sampleBiomarkersPath)
  : [];
const previousBiomarkerReadings = fs.existsSync(samplePreviousBiomarkersPath)
  ? parseBiomarkerFile(samplePreviousBiomarkersPath)
  : [];
const wearableReadings = fs.existsSync(sampleWearablesPath)
  ? parseWearableFile(sampleWearablesPath)
  : [];
const dashboardData = transformToDashboardData(sampleOutput, {
  biomarkerReadings,
  previousBiomarkerReadings,
  wearableReadings,
});
const dashboardJson = buildDashboardJSON(sampleOutput, {
  userId: sampleOutput.metadata.user_id,
  biomarkerReadings: biomarkerReadings.map((reading) => ({
    name: reading.id,
    value: reading.value,
    unit: reading.unit ?? "",
    collected_at: reading.collected_at,
  })),
  previousBiomarkerReadings: previousBiomarkerReadings.map((reading) => ({
    name: reading.id,
    value: reading.value,
    unit: reading.unit ?? "",
    collected_at: reading.collected_at,
  })),
  wearableReadings: wearableReadings.map((reading) => ({
    metric: reading.id,
    value: reading.value,
    unit: reading.unit,
  })),
});
const html = renderDashboard(template, dashboardData, dashboardJson);

// Keep the sample command on the same generation path as the production
// pipeline: the ForeverBetter dossier stays the deep template, while every
// other selected design (including APEX) renders its own full dashboard.
const styledDesign = process.argv
  .find((a) => a.startsWith("--design="))
  ?.split("=")[1];
const styled = isFullDashboardDesign(styledDesign)
  ? html
  : renderFullDashboard(JSON.parse(dashboardJson), styledDesign);

fs.writeFileSync(outputPath, styled, "utf8");

console.log("Sample wellness report rendered.");
console.log(`Open: ${outputPath}`);
console.log(`Biomarkers loaded: ${biomarkerReadings.length}`);
console.log(
  `Previous biomarker panel loaded: ${previousBiomarkerReadings.length}`
);
console.log(`Wearable signals loaded: ${wearableReadings.length}`);
console.log(
  `Local VCF records covered: ${localVcfCoverage.summary.total_records.toLocaleString()}`
);
console.log(
  `Compact VCF catalog entries: ${compactCatalog.summary.total_entries.toLocaleString()} (${compactCatalog.summary.wellness_optimization_entries.toLocaleString()} wellness/optimization)`
);
console.log(
  `Interpretation depth score: ${interpretationDepth.summary.score} (${interpretationDepth.summary.source_families_supported} compact source families)`
);
if (wgsReadiness.errors.length > 0) {
  console.log(
    `WGS readiness preflight warnings: ${wgsReadiness.errors.length}`
  );
}
printDailyActionPlanCronPrompt(outputDir);

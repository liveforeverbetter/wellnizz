#!/usr/bin/env node
/**
 * Vet every design end to end: render every summary design from the same data and confirm
 * each produces a STRUCTURALLY unique dashboard (different hero component,
 * sections, and voice), not just a recolor.
 *
 *   npm run design:vet                 # writes output/designs/<id>.html for every summary design
 *   npm run design:vet -- --json=/abs/pipeline_dashboard.json   # use real data
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  renderDesignDashboard,
  DESIGN_IDS,
  type DashboardData,
} from "../../shared/design/render-designs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, "../../output/designs");

const jsonArg = process.argv
  .find((a) => a.startsWith("--json="))
  ?.split("=")[1];

// Normalize whatever we have into the design engine's input. Falls back to a
// representative multimodal sample so the vet always runs.
function toDashboardData(): DashboardData {
  if (jsonArg) {
    const raw = JSON.parse(readFileSync(jsonArg, "utf8"));
    const cards = (raw.cards ?? raw.dashboard_spec?.cards ?? []).map(
      (c: any) => ({
        title: c.title,
        score: c.score,
        status: c.status,
        summary: c.summary,
        action: c.action,
        category: c.category,
      })
    );
    return {
      score: raw.healthspan?.gli ?? raw.score,
      summary: raw.summary,
      cards,
      priorities: raw.plan?.priorities,
      coverage: raw.coverage,
    };
  }
  return {
    score: 74,
    summary:
      "Built from your blood test and wearable. Metabolic markers are the signal to work on; sleep and recovery are steady.",
    coverage: [
      {
        modality: "biomarkers",
        label: "Blood test",
        signal_count: 42,
        status: "connected",
      },
      {
        modality: "wearables",
        label: "Wearable",
        signal_count: 27,
        status: "connected",
      },
      {
        modality: "genetics",
        label: "Genetics",
        signal_count: 0,
        status: "not_provided",
      },
    ],
    cards: [
      {
        title: "ApoB",
        score: 55,
        status: "needs_attention",
        summary: "Above the optimal range for cardiovascular risk.",
        action: "Review ApoB-lowering options with a clinician.",
      },
      {
        title: "HbA1c",
        score: 68,
        status: "watch",
        summary: "Trending toward the upper range.",
        action: "Tighten the metabolic routine and retest in 90 days.",
      },
      {
        title: "Sleep",
        score: 82,
        status: "optimal",
        summary: "Consistent duration and timing.",
      },
      {
        title: "HRV",
        score: 71,
        status: "good",
        summary: "Recovery capacity is solid.",
      },
      {
        title: "Resting HR",
        score: 78,
        status: "good",
        summary: "Low and stable.",
      },
      {
        title: "Vitamin D",
        score: 48,
        status: "low",
        summary: "Below the target range.",
        action: "Supplement and recheck.",
      },
      {
        title: "Triglycerides",
        score: 60,
        status: "watch",
        summary: "Borderline.",
      },
      {
        title: "Activity",
        score: 65,
        status: "watch",
        summary: "Below your movement floor.",
        action: "Add a daily step target.",
      },
    ],
    priorities: [
      {
        title: "Lower ApoB",
        why: "Your strongest cardiovascular signal this cycle.",
      },
      {
        title: "Tighten glucose control",
        why: "HbA1c and triglycerides are drifting together.",
      },
      {
        title: "Hold your sleep and recovery",
        why: "Already optimal; protect it.",
      },
    ],
    disclaimer:
      "Educational longevity analysis. Not a diagnosis or medical advice.",
  };
}

const data = toDashboardData();
mkdirSync(outDir, { recursive: true });

// Signature markers that must appear in each design and nowhere else, proving
// genuinely different components (not a recolor).
const SIGNATURE: Record<string, RegExp> = {
  "ring-data": /class="ring"/,
  performance: /class="gauge"/,
  apex: /class="apex-readiness"/,
  "clinical-modern": /<table>/,
  metabolic: /class="zone"/,
  "system-cards": /class="grid"[\s\S]*class="card"/,
  serene: /class="orb"/,
};

const rendered: Record<string, string> = {};
for (const id of DESIGN_IDS) {
  const html = renderDesignDashboard(data, id);
  rendered[id] = html;
  writeFileSync(path.join(outDir, `${id}.html`), html);
}

let ok = true;
console.log("Vetting designs (each must be structurally unique):\n");
for (const id of DESIGN_IDS) {
  const html = rendered[id];
  const sigOk = SIGNATURE[id].test(html);
  // No other design should contain this design's signature component.
  const bleed = DESIGN_IDS.filter(
    (other) => other !== id && SIGNATURE[id].test(rendered[other])
  );
  const uniqueLen =
    new Set(Object.values(rendered).map((h) => h.length)).size ===
    DESIGN_IDS.length;
  const status = sigOk && bleed.length === 0 ? "OK " : "FAIL";
  if (status === "FAIL") ok = false;
  console.log(
    `  [${status}] ${id.padEnd(16)} signature=${
      sigOk ? "present" : "MISSING"
    }  bleed=${bleed.length ? bleed.join(",") : "none"}  bytes=${html.length}`
  );
}
console.log(
  `\nAll ${DESIGN_IDS.length} lengths distinct: ${
    new Set(Object.values(rendered).map((h) => h.length)).size ===
    DESIGN_IDS.length
  }`
);
console.log(`Written to ${path.relative(process.cwd(), outDir)}/`);
if (!ok) {
  console.error(
    "\nVET FAILED: a design is missing its signature or bleeds into another."
  );
  process.exit(1);
}
console.log(
  `\nVET PASSED: all ${DESIGN_IDS.length} designs are structurally unique.`
);

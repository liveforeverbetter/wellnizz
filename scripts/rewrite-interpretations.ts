#!/usr/bin/env npx tsx
/**
 * Rewrite interpretation content to substantially differ from source text
 * and reorganize into new category system including a "superpowers" category.
 *
 * Usage: npx tsx scripts/rewrite-interpretations.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTERPRETATIONS_DIR = path.join(
  __dirname, "..", "vendor", "health-analysis-skill", "shared", "interpretations"
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InterpretationVariant {
  effect: string;
  interpretation: string;
  recommendations: string[];
  priority: string;
  supplements?: unknown[];
  theWhy?: string;
  scienceSimplified?: string;
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
  drug_implications?: string;
  prs_info?: unknown;
}

interface InterpretationFile {
  version: string;
  updated: string;
  description: string;
  markers: Record<string, InterpretationEntry>;
}

// ---------------------------------------------------------------------------
// Category system (deliberately different from any provider's naming)
// ---------------------------------------------------------------------------

type NewCategory =
  | "superpowers"        // protective/advantageous variants, athletic gifts, longevity boosters
  | "metabolism"         // nutrition, vitamins, folate cycle, body composition, glucose
  | "cardiometabolic"    // heart, vessels, blood pressure, cholesterol, lipoproteins
  | "inflammation"       // immune function, cytokines, histamine, food sensitivity
  | "pharmacogenomics"   // drug efficacy, dosage, adverse reaction risk
  | "health-vulnerability" // polygenic disease susceptibility, chronic condition risk
  | "inherited-conditions" // monogenic disorders, carrier status, rare disease genes
  | "physical-traits"    // appearance, senses, blood type, morphology
  | "cognitive"          // brain function, personality, mood, sleep, behavior
  | "cellular-health"    // aging, oxidative stress, telomeres, epigenetic age, detox
  | "skeletal-health"    // bone density, joint health, osteoarthritis, tendinopathy
  ;

const CATEGORY_DESCRIPTIONS: Record<NewCategory, string> = {
  superpowers: "Protective variants, athletic gifts, longevity advantages, and disease resistance",
  metabolism: "Nutrition, vitamin metabolism, body composition, and energy balance",
  cardiometabolic: "Cardiovascular health, blood pressure, cholesterol, and lipid profiles",
  inflammation: "Immune regulation, inflammatory markers, histamine, and food sensitivities",
  pharmacogenomics: "Drug efficacy, metabolism, dosage guidance, and adverse reaction risk",
  "health-vulnerability": "Polygenic susceptibility, chronic disease risk, and age-related conditions",
  "inherited-conditions": "Monogenic disorders, carrier status, and rare disease variants",
  "physical-traits": "Appearance, sensory traits, blood type, and physical characteristics",
  cognitive: "Brain function, personality, mood, sleep, and behavioral tendencies",
  "cellular-health": "Aging biology, oxidative stress, telomere maintenance, and detox pathways",
  "skeletal-health": "Bone strength, joint integrity, tendinopathy risk, and connective tissue",
};

// ---------------------------------------------------------------------------
// Trait → category assignments
// ---------------------------------------------------------------------------

// Superpowers: unequivocally beneficial or protective
const SUPERPOWERS_TRAITS = new Set([
  // Athletic advantages
  "ACTN3 R577X", "R577X", "ACE I/D", "I/D",
  "PPARGC1A G482S", "G482S", "MSTN K153R", "K153R",
  // Longevity / protective
  "FOXO3 G>T", "G>T", "KL-VS (F352V / S370C)", "F352V (KL-VS)",
  // Protective variants
  "CCR5Delta32 and susceptibility to HIV infection", "Duffy Antigen, malaria resistant",
  // Disease resistance / advantageous metabolism
  "Alcohol flush reaction", "Lactase persistence",
  // Beneficial vitamin handling
  "SLC23A1 (vitamin C levels)", "DHCR7 (vitamin D synthesis)",
  // Enhanced performance / regeneration
  "Muscle endurance", "Exercise-induced muscle damage (regeneration capacity)",
  // APOE protective
  "APOE e2 marker", "e2 marker",
  // Longevity pathway variants
  "TERT C>T", "C>T", "FOXO3", "AXIN1 (aging)",
  // Longevity category trait names
  "Pro72Arg", "Trp262Arg", "T>C (A300T)", "G>A", "I405V",
  "FokI", "P477T", "ZNG1A (aging rate)", "FAM234A (aging)",
  "CCDC26 (aging rate)", "CHCHD6 (aging rate)", "HBG2 (aging)", "MRC1 (neuroimaging)",
]);

// Bone density / structural
const SKELETAL_TRAITS = new Set([
  "Bone mineral density", "VDR BsmI", "VDR TaqI", "VDR FokI",
  "BsmI", "TaqI", "Tendinopathies in upper extremities (arms)",
  "Tendinopathies in lower extremities (legs)",
  "CPED1 (heel bone mineral density)", "LRP5 (heel bone mineral density)",
  "SFRP4 (heel bone mineral density)", "SMG6 (heel bone mineral density)",
  "TMEM135 (heel bone mineral density)", "TNFRSF11B (heel bone mineral density)",
  "TNFSF11 (trunk bone mineral density)", "WNT16 (heel bone mineral density)",
  "ADRB3 Trp64Arg", "Trp64Arg",
]);

// Metabolism & nutrition
const METABOLISM_TRAITS = new Set([
  "MTHFR C677T", "MTHFR A1298C", "MTRR A66G", "MTR A2756G", "CBS C699T",
  "Gene MTHFR", "FTO A>T", "A>T",
  "Body mass index", "Body fat percentage", "Prediction of visceral adipose tissue",
  "Food intake control", "Preference for sweets", "Farmer-hunter profile",
  "Blood glucose", "Glycated hemoglobin levels",
  "Vitamin D levels", "Vitamin B12 levels", "Vitamin C levels", "Vitamin E levels",
  "Levels of vitamin A (beta carotene)",
  "Long-chain omega fatty acids levels",
  "SLC23A1 (vitamin C levels)", "DHCR7 (vitamin D synthesis)",
  "Caffeine dependence after prolonged consumption",
  "Bitter taste perception",
  "Basal metabolic rate",
  "Serum phosphate levels", "Calcium levels", "Creatinine levels",
  "Urate levels", "Galectin-3 levels",
  // Metabolism enzymes
  "GSTA1 T/C", "GSTA1 N92S", "GSTA1 C69S",
  "NQO1 P187S", "SOD2 V16A",
]);

// Cardiometabolic
const CARDIOMETABOLIC_TRAITS = new Set([
  "Systolic blood pressure levels", "Diastolic blood pressure levels",
  "LDL cholesterol levels", "HDL cholesterol levels",
  "Apolipoprotein A1 levels", "Apolipoprotein B levels",
  "LPA Ile4399Met", "LPA Gly492Arg",
  "PCSK9 Gly496Glu", "PCSK9 Val474Ile",
  "CETP TaqB1", "CETP Val422Ile",
  "NOS3 Asp298Glu", "AGTR1 A1166C",
  "Intraocular pressure",
  "Resting heart rate", "QT Intervals",
  "ADRB2 Arg16Gly", "ADRB2 R16G", "ADRB2 Gln27Glu", "ADRB2 Q27E",
  "ADRB3 Trp64Arg",
  "ABCG8 (non-high density lipoprotein cholesterol)",
  "EDN1 (high density lipoprotein cholesterol)",
  "NPC1L1 (low density lipoprotein cholesterol)",
  "SORT1 (low density lipoprotein cholesterol)",
]);

// Inflammation & immune
const INFLAMMATION_TRAITS = new Set([
  "IL6 -572G>C", "IL10 -1082A>G", "CRP +1059G>C", "TNF -308G>A",
  "C-reactive protein levels",
  "Histamine intolerance", "Celiac disease predisposition",
  "Genetic predisposition to peanut allergy",
  "Lactose intolerance",
  "Eosinophil count", "Lymphocyte count", "Monocyte count",
  "Neutrophil count", "White blood cell count",
  "SCN1A (C reactive protein levels)",
  "HLA-DQA1 (celiac disease)",
]);

// Health vulnerability (polygenic risk + susceptibility)
const HEALTH_VULNERABILITY_TRAITS = new Set([
  "TCF7L2 C/T", "HFE C282Y", "HFE H63D",
  "APOE e4 marker", "e4 marker",
  "BRCA1 S1535S", "BRCA2 N372H",
]);

// Physical traits
const PHYSICAL_TRAITS = new Set([
  "Hair Shape", "Hair color", "Probability of having red hair",
  "Skin melanin levels", "Facial aging",
  "Eye clarity", "Pigmented rings on the iris", "Corneal curvature",
  "Blood Group ABO/Rh",
  "Earwax type / Armpit odor", "Earlobe type",
  "Height", "Birth weight",
  "Male baldness", "Acne vulgaris",
  "Tooth morphology", "Permanent tooth eruption",
  "Smell", "Asparagus odor detection", "Photic sneeze reflex",
  "Nasion prominence",
  "Usual walking pace", "Spleen volume",
  "Myoadenylate deaminase (AMPD1 gene)", "C34T",
  "Intensity of itching due to mosquito bites",
  "Probability of snoring",
]);

// Cognitive / brain
const COGNITIVE_TRAITS = new Set([
  "COMT Val158Met", "BDNF Val66Met", "ADRA2A C-1291G",
  "SLC6A4 5-HTTLPR", "HTR2A His452Tyr",
  "Gene COMT", "Gene MTR", "Gene MTRR",
  "CLOCK T3111C", "PER2 T>C",
  "Sleep duration", "Insomnia", "Morning circadian rhythm (Morning person)",
  "Cognitive ability", "Mental agility", "Risk tendency", "Neuroticisms",
  "Nicotine dependence after prolonged consumption",
  "Alcohol dependence after prolonged consumption",
  "Caffeine and anxiety", "Caffeine and sports performance",
  "Left-handedness (left lateral)",
  "MTRR A66G", "MTR A2756G",
  "FABP7 T>C",
  "HCRTR2 (sleep duration)", "SLC6A3 (sleep duration)",
]);

// Cellular health
const CELLULAR_HEALTH_TRAITS = new Set([
  "Antioxidant capacity",
  "Telomere length", "Epigenetic aging",
  "FOXO3 G>T", "TERT C>T",
  "SOD2 V16A",
  "TP53 Pro72Arg", "P477T",
  "Lung function (exhaled air volume)",
  "MTHFR C677T", // methylation is cellular health
  "MTHFR A1298C",
  "GSTA1 T/C",  // detox
  "GSTA1 N92S", "GSTA1 C69S",
  "NQO1 P187S",
  // Liver
  "Liver iron levels", "Alanine aminotransferase levels",
  "Aspartate aminotransferase levels", "Bilirubin levels",
  "Gamma glutamyl transferase levels",
  "Total serum protein levels", "Serum albumin levels",
  "Resistin levels", "Selectin E levels",
  "Sex hormone regulation (SHBG)", "Estradiol levels",
  "Thyroid function (TSH levels)",
  "PSA (Prostate Specific Antigen) Levels",
  "Secretor status and ABH antigens (FUT2 gene)",
  "Persistence of fetal hemoglobin",
  "Blood coagulation, factor V Leiden and 20210G-A",
  "Dental caries and periodontitis",
  "Corneal hysteresis", "Mouth ulcers",
  "Frequency of bowel movements",
  "Heat production in response to cold",
  "Cathepsin D levels",
  "Alkaline phosphatase levels", "Red blood cell count",
]);

// Inherited conditions (remain as-is)
const INHERITED_TRAITS = new Set<string>([
  "BRCA1 S1535S", "BRCA2 N372H",
]);

// Exercise/physical performance → superpowers or cellular health
const EXERCISE_TRAITS = new Set([
  "Exercise-induced muscle damage (initial phase)",
  "Exercise-induced muscle damage (second phase)",
  "G>A (-1607)", "G>T (Sp1 binding site)",
  "A148V", "Ala55Val",
  "T2628C", "C55T", "-55C>T", "-634G>C",
  "R292X", "P12A",
  "SLC2A9 (smoking status, coffee consumption, urat)",
  "rs12594956", "rs12644422", "rs17300203", "rs3025058", "rs3213849", "rs884944",
]);

// ---------------------------------------------------------------------------
// Rewriting engine
// ---------------------------------------------------------------------------

/** Heuristic: is this a low-quality entry (interpretation == recommendations[0])? */
function isLowQuality(interp: InterpretationVariant): boolean {
  return (
    interp.recommendations.length > 0 &&
    interp.recommendations[0] === interp.interpretation
  );
}

/** Rewrite a "variant detected" style generic interpretation into something useful */
function rewriteVariantDetected(
  interp: InterpretationVariant,
  gene: string,
  traitName: string,
  context: { technical_report?: string; description?: string },
): InterpretationVariant {
  // Extract the key scientific claim from the interpretation
  const orig = interp.interpretation;

  const hasVariant = !/do not have|no.*variant/i.test(orig);
  const isProtective = /protective|beneficial|advantage|lower risk/i.test(orig);
  const isRisk = /risk|increased|susceptibility|predispos/i.test(orig);

  let effect = interp.effect;
  let interpretation = "";
  let recommendations: string[] = [];
  let priority = interp.priority;

  // Build a rewritten, substantially different interpretation
  if (hasVariant) {
    if (isProtective) {
      effect = `Beneficial ${gene} variant`;
      interpretation = `${traitName} — your ${gene} genotype suggests a favorable profile that may confer some natural advantage. This is a statistical association from population studies, not a guarantee of any outcome.`;
      recommendations = [
        `Continue healthy lifestyle habits that support ${traitName.toLowerCase()}`,
        "Genotype alone does not override environmental and behavioral factors",
      ];
      priority = "low";
    } else if (isRisk) {
      effect = `Elevated-risk ${gene} genotype`;
      interpretation = `Population studies link your ${gene} variant to altered probability for ${traitName.toLowerCase()}. This reflects group-level statistics; individual risk depends substantially on lifestyle, family history, and other genes.`;
      recommendations = [
        `Discuss ${traitName.toLowerCase()} screening with a healthcare provider if family history is present`,
        "Lifestyle modifications often reduce genetic risk — diet, exercise, and avoiding known triggers matter",
      ];
      priority = "high";
    } else {
      effect = `Variant in ${gene}`;
      interpretation = `Your ${gene} genotype is one of several genetic factors linked to ${traitName.toLowerCase()}. Research in this area continues to evolve, and most traits have multiple genetic and environmental contributors.`;
      recommendations = [
        `Stay informed as new research clarifies the role of ${gene} in ${traitName.toLowerCase()}`,
        "Consider discussing with a healthcare provider familiar with genetic interpretation",
      ];
      priority = "medium";
    }
  } else {
    // No variant detected
    effect = `Typical ${gene} function`;
    interpretation = `Your ${gene} genotype is the most common form in reference populations. This does not rule out ${traitName.toLowerCase()} risk from other genes, environmental exposures, or rare variants not covered by standard genotyping.`;
    recommendations = [
      `No specific ${gene}-directed intervention indicated, but standard health screening still applies`,
      `Other genetic and environmental factors contribute to ${traitName.toLowerCase()} — genotype alone is not the full picture`,
    ];
    priority = "low";
  }

  return { effect, interpretation, recommendations, priority };
}

/** Rewrite an existing quality interpretation to differ more from source */
function rewriteQualityEntry(
  interp: InterpretationVariant,
  gene: string,
  traitName: string,
  context: { technical_report?: string; description?: string },
): InterpretationVariant {
  // Keep the core effect but rephrase the interpretation and recommendations
  const sentences = interp.interpretation
    .split(". ")
    .filter((s) => s.length > 10);

  // Build a reworded interpretation from the original ideas
  let reworded = "";
  if (sentences.length > 0) {
    // Reorder and restructure
    const mainClaim = sentences[0];

    // Transform common patterns
    reworded = mainClaim
      .replace(/^(The|A|An) (\w+) genotype is/, "Genotype $2 may contribute to")
      .replace(/associated with/i, "linked to")
      .replace(/significantly/i, "notably")
      .replace(/reduced/i, "lower")
      .replace(/increased/i, "elevated")
      .replace(/impaired/i, "altered")
      .replace(/strongly/i, "")
      .replace(/recommended/i, "worth considering")
      .replace(/essential/i, "important")
      .replace(/crucial/i, "key");

    // If the rewrite made no substantial change, restructure entirely
    if (reworded === mainClaim) {
      reworded = `For ${traitName.toLowerCase()}, your ${gene} variant is one contributing factor — ${mainClaim.toLowerCase()}`;
    }
  }

  if (!reworded) reworded = interp.interpretation;

  // Add caveat
  if (interp.priority !== "low") {
    reworded += " This is a statistical association that interacts with lifestyle, environment, and other genetic factors.";
  }

  // Rewrite recommendations
  const newRecs = interp.recommendations.map((r) =>
    r
      .replace(/Strongly recommended/i, "Worth prioritizing")
      .replace(/recommended/i, "worth considering")
      .replace(/essential/i, "important")
      .replace(/must/i, "may benefit from")
      .replace(/Consult/i, "Discuss with")
      .replace(/Monitor/i, "Track")
      .replace(/Enhanced/i, "More frequent")
  );

  // Deduplicate recs that match the interpretation
  const filteredRecs = newRecs.filter((r) => r !== reworded && r !== interp.interpretation);

  return {
    effect: interp.effect,
    interpretation: reworded,
    recommendations: filteredRecs.length > 0 ? filteredRecs : newRecs,
    priority: interp.priority,
    supplements: interp.supplements,
    theWhy: interp.theWhy,
    scienceSimplified: interp.scienceSimplified,
  };
}

// ---------------------------------------------------------------------------
// Category assignment
// ---------------------------------------------------------------------------

function assignCategory(
  traitName: string,
  gene: string,
  currentCategory: string,
  interps: Record<string, InterpretationVariant>,
): NewCategory {
  const lowerName = traitName.toLowerCase();
  const lowerGene = gene.toLowerCase();

  // Check explicit trait names first
  if (currentCategory === "pharmacology") return "pharmacogenomics";
  if (currentCategory === "hereditary") return "inherited-conditions";

  // Check explicit trait sets
  if (SUPERPOWERS_TRAITS.has(traitName)) return "superpowers";
  if (SKELETAL_TRAITS.has(traitName)) return "skeletal-health";
  if (METABOLISM_TRAITS.has(traitName)) return "metabolism";
  if (CARDIOMETABOLIC_TRAITS.has(traitName)) return "cardiometabolic";
  if (INFLAMMATION_TRAITS.has(traitName)) return "inflammation";
  if (HEALTH_VULNERABILITY_TRAITS.has(traitName)) return "health-vulnerability";
  if (PHYSICAL_TRAITS.has(traitName)) return "physical-traits";
  if (COGNITIVE_TRAITS.has(traitName)) return "cognitive";
  if (CELLULAR_HEALTH_TRAITS.has(traitName)) return "cellular-health";
  if (EXERCISE_TRAITS.has(traitName)) return "superpowers";

  // Gene-level heuristics
  if (["ACTN3", "ACE", "PPARGC1A", "MSTN"].includes(gene)) return "superpowers";
  if (["FOXO3", "TERT", "KLOTHO", "KL", "APOE"].includes(gene)) {
    // Check if it's the protective e2 allele
    const hasText = JSON.stringify(interps).toLowerCase();
    if (hasText.includes("protective") || hasText.includes("e2") || hasText.includes("longevity")) {
      return "superpowers";
    }
    return "health-vulnerability";
  }
  if (gene === "VDR") return "skeletal-health";
  if (["ADRB2", "ADRB3", "AGT", "AGTR1", "NOS3", "CETP", "LPA", "PCSK9"].includes(gene)) return "cardiometabolic";
  if (["IL1B", "IL6", "IL10", "TNF", "CRP", "HLA"].includes(gene)) return "inflammation";
  if (["MTHFR", "MTR", "MTRR", "CBS", "FTO", "CYP1A2", "GSTA1", "NQO1"].includes(gene)) return "metabolism";
  if (["COMT", "BDNF", "SLC6A4", "HTR2A", "ADRA2A", "CLOCK", "PER2"].includes(gene)) return "cognitive";
  if (["BRCA1", "BRCA2", "HFE", "TCF7L2"].includes(gene)) return "health-vulnerability";
  if (["SOD2", "TP53", "GPX1"].includes(gene)) return "cellular-health";

  // Fallback by keyword
  if (/bone|density|tendinopathy|osteoarthritis|joint/i.test(lowerName)) return "skeletal-health";
  if (/vitamin|nutrient|body mass|body fat|glucose|glycat|metabol/i.test(lowerName)) return "metabolism";
  if (/blood pressure|cholesterol|lipid|apolipop|cardio|heart/i.test(lowerName)) return "cardiometabolic";
  if (/inflam|immune|allerg|celiac|histamin|lactose|food/i.test(lowerName)) return "inflammation";
  if (/drug|dosage|efficacy|adverse|metabolizer|warfarin|statin|opioid/i.test(lowerName)) return "pharmacogenomics";
  if (/cancer|diabetes|alzheimer|parkinson|disease risk|vulnerability/i.test(lowerName)) return "health-vulnerability";
  if (/hair|skin|eye|ear|blood group|height|weight|color|shape|smell|taste/i.test(lowerName)) return "physical-traits";
  if (/sleep|cognit|mental|personality|mood|anxiety|depress|behavior|intelli/i.test(lowerName)) return "cognitive";
  if (/aging|telomere|oxidat|detox|longevity|epigen/i.test(lowerName)) return "cellular-health";
  if (/endur|strength|sprint|athletic|regenerat|muscle damag/i.test(lowerName)) return "superpowers";
  if (/hereditary|inherited|carrier|monogenic|mendelian/i.test(lowerName)) return "inherited-conditions";

  // Category-level fallback
  if (currentCategory === "vulnerability") return "health-vulnerability";
  if (currentCategory === "longevity") return "cellular-health";
  if (currentCategory === "performance") return "superpowers";
  if (currentCategory === "personality") return "cognitive";
  if (currentCategory === "ancestry") return "physical-traits";
  if (currentCategory === "wellness") return "metabolism";

  return "cellular-health";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Categories that are being replaced (their files will be deleted) */
const OLD_CATEGORIES = [
  "wellness", "pharmacology", "hereditary", "performance",
  "personality", "vulnerability", "ancestry", "longevity",
];

/** New category files to create */
const NEW_CATEGORY_FILES: Record<NewCategory, string> = {
  superpowers: "superpowers.json",
  metabolism: "metabolism.json",
  cardiometabolic: "cardiometabolic.json",
  inflammation: "inflammation.json",
  pharmacogenomics: "pharmacogenomics.json",
  "health-vulnerability": "health-vulnerability.json",
  "inherited-conditions": "inherited-conditions.json",
  "physical-traits": "physical-traits.json",
  cognitive: "cognitive.json",
  "cellular-health": "cellular-health.json",
  "skeletal-health": "skeletal-health.json",
};

function loadOldFile(cat: string): InterpretationFile {
  const fpath = path.join(INTERPRETATIONS_DIR, `${cat}.json`);
  if (!fs.existsSync(fpath)) {
    return { version: "1.0.0", updated: "", description: "", markers: {} };
  }
  return JSON.parse(fs.readFileSync(fpath, "utf-8"));
}

function main() {
  // 1. Collect all markers from old category files
  const allMarkers: Record<string, InterpretationEntry> = {};
  const markerMetadata: Record<string, { oldCategory: string }> = {};

  for (const cat of OLD_CATEGORIES) {
    const file = loadOldFile(cat);
    for (const [rsid, entry] of Object.entries(file.markers)) {
      if (allMarkers[rsid]) {
        // Merge interpretations from duplicate entries
        Object.assign(allMarkers[rsid].interpretations, entry.interpretations);
        if (!allMarkers[rsid].bibliography && entry.bibliography) {
          allMarkers[rsid].bibliography = entry.bibliography;
        }
        if (!allMarkers[rsid].technical_report && entry.technical_report) {
          allMarkers[rsid].technical_report = entry.technical_report;
        }
        continue;
      }
      allMarkers[rsid] = entry;
      markerMetadata[rsid] = { oldCategory: cat };
    }
  }

  console.log(`Loaded ${Object.keys(allMarkers).length} total markers from ${OLD_CATEGORIES.length} files`);

  // 2. Rewrite interpretations and assign new categories
  const newFiles: Record<string, InterpretationFile> = {};
  for (const [cat, filename] of Object.entries(NEW_CATEGORY_FILES)) {
    newFiles[cat] = {
      version: "2.0.0",
      updated: new Date().toISOString().split("T")[0],
      description: CATEGORY_DESCRIPTIONS[cat as NewCategory],
      markers: {},
    };
  }

  let rewrites = 0;
  let recategorized = 0;
  let skipped = 0;
  const categoryStats: Record<string, number> = {};

  for (const [rsid, entry] of Object.entries(allMarkers)) {
    const oldCat = markerMetadata[rsid]?.oldCategory || "wellness";
    const traitName = entry.name || "";
    const gene = entry.gene || "";

    // Determine new category
    const newCat = assignCategory(traitName, gene, oldCat, entry.interpretations);
    if (newCat !== oldCat) recategorized++;

    // Track stats
    categoryStats[newCat] = (categoryStats[newCat] || 0) + 1;

    // Rewrite interpretations
    const rewritten: Record<string, InterpretationVariant> = {};
    for (const [genotype, interp] of Object.entries(entry.interpretations)) {
      if (isLowQuality(interp) || /You (have|do not have|are)/.test(interp.interpretation)) {
        // Low-quality entry — replace entirely
        rewritten[genotype] = rewriteVariantDetected(interp, gene, traitName, {
          technical_report: entry.technical_report,
          description: entry.description,
        });
        rewrites++;
      } else {
        // Existing quality entry — tweak for differentiation
        const qualityEntry = rewriteQualityEntry(interp, gene, traitName, {
          technical_report: entry.technical_report,
          description: entry.description,
        });
        rewritten[genotype] = qualityEntry;
        rewrites++;
      }
    }

    // Create new entry with updated category
    const newEntry: InterpretationEntry = {
      ...entry,
      category: newCat,
      interpretations: rewritten,
    };

    // Clean up source-specific fields that shouldn't be verbatim
    if (newEntry.technical_report) {
      // Paraphrase the technical report
      newEntry.technical_report = paraphraseTechnicalReport(newEntry.technical_report, gene, traitName);
    }

    // Add the marker to the new category
    newFiles[newCat].markers[rsid] = newEntry;
  }

  console.log(`\nRewrote ${rewrites} genotype interpretations`);
  console.log(`Recategorized ${recategorized} markers to different categories`);

  // 3. Write new files
  console.log("\n--- New category files ---");
  for (const [cat, file] of Object.entries(newFiles)) {
    const fpath = path.join(INTERPRETATIONS_DIR, NEW_CATEGORY_FILES[cat as NewCategory]);
    fs.writeFileSync(fpath, JSON.stringify(file, null, 2));
    const count = Object.keys(file.markers).length;
    console.log(`  ${cat}: ${count} markers → ${path.basename(fpath)}`);
  }

  // 4. Backup old files with .bak extension (don't delete, just rename)
  for (const cat of OLD_CATEGORIES) {
    const oldPath = path.join(INTERPRETATIONS_DIR, `${cat}.json`);
    const bakPath = path.join(INTERPRETATIONS_DIR, `${cat}.json.bak`);
    if (fs.existsSync(oldPath)) {
      fs.renameSync(oldPath, bakPath);
      console.log(`  Backed up: ${cat}.json → ${cat}.json.bak`);
    }
  }

  // 5. Summary
  console.log(`\n=== Rewrite Summary ===`);
  console.log(`Total markers: ${Object.keys(allMarkers).length}`);
  console.log(`Genotypes rewritten: ${rewrites}`);
  console.log(`Markers recategorized: ${recategorized}`);
  console.log(`New categories: ${Object.keys(NEW_CATEGORY_FILES).join(", ")}`);
  console.log("\nPer-category distribution:");
  for (const [cat, count] of Object.entries(categoryStats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat.padEnd(22)}: ${count}`);
  }
}

function paraphraseTechnicalReport(report: string, gene: string, traitName: string): string {
  if (!report || report.length < 50) return report;

  // Split into sentences
  const sentences = report.split(/(?<=[.!?])\s+/);

  // Transform each sentence
  const rewritten = sentences.map((s: string) => {
    let r = s.trim();
    if (!r) return r;

    // Apply transformations to change phrasing
    r = r
      .replace(/it has been observed that/i, "research indicates that")
      .replace(/studies have shown that/gi, "evidence suggests that")
      .replace(/has been associated with/gi, "correlates with")
      .replace(/is known to/gi, "tends to")
      .replace(/has been demonstrated/gi, "has been documented")
      .replace(/widely studied/gi, "extensively researched")
      .replace(/plays a fundamental role/gi, "serves a key function")
      .replace(/is responsible for/gi, "mediates")
      .replace(/it is important to note/gi, "notably,")
      .replace(/in recent years/gi, "in the past decade")
      .replace(/has been described/gi, "has been characterized")
      .replace(/may be/gi, "can be")
      .replace(/appears to be/gi, "seems to function as");

    return r;
  });

  return rewritten.join(" ");
}

main();

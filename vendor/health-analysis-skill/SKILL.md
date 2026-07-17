---
name: analyze-longevity-core
description: |
  Implementation runbook for the public analyze-longevity skill: multimodal health
  analysis that turns blood biomarkers, wearable/behavioral data, and optional
  genetics into one healthspan dashboard and a customized, evidence-graded action
  plan. Any one, two, or three modalities work. Genetics is optional context, not
  a requirement. Use this skill when a user wants to:
  - Analyze blood test biomarkers from a CSV/JSON/PDF/manual panel, including a derived-marker layer (HOMA-IR, ApoB/ApoA1, TyG, FIB-4, AST/ALT, and more)
  - Connect wearable or behavior data from WHOOP, Oura, Apple Health, Garmin, OHealth, etc.
  - Add genetic context from a VCF/WGS or SNP-array export (Dante Labs, 23andMe, AncestryDNA)
  - Get a personalized action plan ranked across whatever modalities are present, with a corroboration boost when biomarker, wearable, and genetic signals agree
  - Generate a themed, self-contained healthspan dashboard from one or more modalities
  - Run the end-to-end pipeline: import -> observations -> priorities/GLI -> action plan -> dashboard

  Triggered by "analyze my biomarkers", "blood test dashboard", "WHOOP data",
  "Oura data", "healthspan analysis", "health dashboard", "action plan",
  "biomarker upload", "analyze my genome", "upload my DNA data", "WGS report",
  "GLI score", or any request involving biomarkers, wearables, genetics, or
  multimodal longevity data.

  Modality notes: biomarkers and wearables need no genetics. When genetics is
  supplied, WGS (Dante Labs, etc.) gives full rsID coverage; SNP arrays (23andMe,
  AncestryDNA) give limited coverage. Raw-read callers are optional escalation,
  not required for normal dashboard generation.
---

# Analyze Longevity Core Runbook

Wellness-oriented analysis for Whole Genome Sequencing (WGS), SNP array data, blood biomarkers, and wearable/behavioral data.
This skill provides the **complete end-to-end local VCF pipeline** plus a dashboard-ready multi-modal upload and action path.
Users start by inventorying wearables, biomarkers, and genetics separately, then render the dashboard with the available modalities. The current public CLI is genetics-first for personalized dashboard generation, with biomarker and wearable files added when present.

## How to run it: local pipeline, self-hosted API, or cloud

ForeverBetter runs three ways, and this runbook is the **local pipeline half**:

- **Local pipeline (this repo).** Raw genetic, biomarker, and wearable data stay on
  the user's machine. Genomic processing, action-plan generation, and dashboard
  rendering all run on disk with `npm`, with no API server. Lightest and fully
  offline, and a subset of the outcomes. This is the "just run the skill files" path.
- **Self-hosted API (own infrastructure).** The same open-source API, MCP server,
  workers, and data store run on a machine the user controls (for example the Docker
  image at `http://localhost:8787`). This gives the full endpoint set and every hosted
  playbook, with data on the user's own infrastructure. Drive it with the hosted
  onboarding skill `https://api.foreverbetter.xyz/SKILL.md`, pointing `HEALTH_API_URL`
  at the local deployment. Follow the Docker quickstart at
  `https://foreverbetter.mintlify.app/self-hosting`.
- **Cloud (managed).** The hosted API at `https://api.foreverbetter.xyz` (also over
  MCP) adds ancestry proportions, first-party wearable OAuth, provider discovery,
  goals, retest reminders, stored history, and hosted private dashboard links.

Use the local pipeline when the user wants the lightest offline path with no server;
self-host or use cloud when they want the full playbook set (ancestry proportions,
wearable OAuth, providers, goals, reminders, hosted links). All three produce the same
core outcomes; capabilities that need the API are marked below. The local pipeline keeps
everything on the machine, so no upload consent applies; just say once which mode is
processing the data.

## Full documentation

- Full hosted docs as one text file: `https://foreverbetter.mintlify.app/llms-full.txt`
- Hosted onboarding skill: `https://api.foreverbetter.xyz/SKILL.md`
- Local depth: `PIPELINE.md` (module step map), `references/wgs-process.md`
  (best-available WGS interpretation), and the engine tables below.

## Ask the outcome, then run its local playbook

Before processing data, ask what outcome the user wants and which files they have
ready. Each outcome maps to a local command sequence. Connect only what the chosen
outcome needs; do not require every modality for a first result. Named flags only.

| Outcome | Local path | Needs the API (self-hosted or cloud) |
| --- | --- | --- |
| Optimize everything | `npm run pipeline -- --genetics=<vcf> --biomarkers=<csv> --wearables=<json> --user=user_001 --out=./output` (all ready modalities at once); return `output/{user}_action_plan.json` and `_health_analysis.json`. Add `--design=<id>` only when the user also asks for a dashboard. | Consolidated `POST /users/{id}/health-context` for one cross-modal picture |
| Custom dashboard | `npm run design:list`, then `npm run pipeline -- --biomarkers=<csv> [--genetics=<vcf>] [--wearables=<json>] --design=<id> --user=user_001 --out=./output`; open `output/index.html` | Hosted private dashboard link (`POST /dashboard-links`) |
| Personal action protocol | Same pipeline run; the plan is `output/{user}_action_plan.json` | Supplement-vs-medication interaction citations (supp.ai/Pillser) via `GET /analyses/{id}/action-plan` |
| AI health agent | Point the agent at generated `output/{user}_health_analysis.json`, `_action_plan.json`, and `_dashboard.json` | Consolidated health context, `POST /query`, and MCP tools |
| Ancestry breakdown | `npm run pipeline -- --genetics=<vcf> ...`; ancestry markers and haplogroups render in the genomics report | 1000-Genomes proportions, geographic map, per-chromosome breakdown via `POST /genetics/ancestry` |
| Get better every year | Re-run with `--biomarkers=<new> --biomarkers-previous=<old>` for panel-over-panel trends | Goals and retest reminders (`/users/{id}/goals`, `/retest-reminders`) |
| Find providers first | API only: no local provider catalog | Genome kits, nearby blood draws, and wearables via `GET /providers` |
| Connect a wearable | Upload an exported WHOOP/Oura CSV/JSON with `--wearables=<file>` | Live OAuth and webhook sync via `POST /connections/wearables/start` |

For full dbSNP annotation locally, add `--dbsnp=<ref>`
after confirming the download and storage cost; the compact ClinVar-derived reference is
the default. Any plan outcome can be recurring: the optional cron step (see "Invocation
Behavior" below) lets the agent refresh a daily action plan from the latest data. Deliver
the result, then offer the natural next outcome. The detailed architecture, engine tables,
and pipeline phases below are the reference layer for these playbooks.

## Product Promise

This product positions itself as annual biomarkers, a private dashboard, a clear wellness protocol, optional genetic context, and wearables later. The skill should therefore behave as a healthspan operating system, not a DNA-only report:

1. Ask what outcome the user wants, then inventory only the files that outcome needs.
2. Normalize each upload into shared health domains.
3. Produce one prioritized action plan with provenance and wellness boundaries.
4. Encourage annual biomarker retesting and optional behavior tracking.

The action plan must read as the user's personalized plan rather than a genetics report. Use genetic findings as background personalization, prioritize measured biomarker and behavioral signals when available, and translate any genetic contribution into plain-language actions. Do not expose allele names, pathway jargon, raw confidence scores, or prescribing language in consumer action cards. Medication-response findings should become one concise prompt to share the result with a clinician or pharmacist before starting or changing a relevant prescription; never tell the user to change medication from the dashboard alone.

Against consumer-WGS-platform competitors, the differentiator is not merely "more variants". It is local-first WGS interpretation plus ClinVar, CPIC, PRS, aging hallmarks, blood biomarker grounding, and behavior data that makes actions retestable.

## Pipeline Architecture

Use `PIPELINE.md` for the detailed step map. Use `references/wgs-process.md` when the user asks how to make WGS interpretation as complete as possible. Keep this file as the execution guide, not the full architecture reference.

Current flow: `parse-vcf.ts` normalizes/annotates VCF input, `pipeline/index.ts` maps genetics into traits/enrichment/GLI/protocols, `health_data_import.ts` normalizes biomarker and wearable uploads, and `renderDashboard()` produces `{user_id}_dashboard.json` plus `index.html`.

Run `npm run audit:pipeline` after `npm run sample:report` for targeted metrics on every major processing, visualization, and skill-hygiene step.

Run `npm run catalog:build` to regenerate the compact repo-contained interpretation catalog. It validates that WGS VCF/23andMe-style inputs can be interpreted without installing BAM/CRAM caller stacks, while preserving optional external source policy for ClinVar, CPIC, PGS Catalog, GWAS Catalog, and Open Targets Genetics.

Run `npm run interpretation:depth` after catalog changes. This writes the internal-only depth benchmark at `output/interpretation-depth-report.json`, covering curated rsID markers, ClinVar target genes, CPIC drug-gene rules, selected PGS weights, and WGS CNV/SV/repeat interpretation slices without requiring a massive local database.

Run `npm run reference:wellness` to refresh the compact GWAS Catalog + PGS Catalog wellness layer. It downloads raw GWAS/PGS source files into ignored `reference/wellness/raw/`, verifies PGS MD5 files when available, and rebuilds the committed compact runtime files in `reference/wellness/`. The dashboard treats these as association context with ancestry, genome-build, and coverage disclosures.

### Enrichment Layer Summary

| Engine                            | Source                                                  | What it does                                                                                                                                                                              | Runs in                            |
| --------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `clinvar_enrichment.ts`           | Bundled compressed ClinVar rsID index                   | Pathogenic/likely-pathogenic variant detection, drug response, risk/protective, VUS, benign, conflicting classifications, ACMG SF v3.2 gene flagging, population frequency, review status | Phase 1 Step 3 + Phase 2 Step 6b/7 |
| `cpic_enrichment.ts`              | CPIC Level A/B guidelines, PharmGKB                     | Drug-gene pair matching (clopidogrel, warfarin, statins, etc.), genotype → phenotype → clinical recommendation                                                                            | Phase 1 Step 4 + Phase 2 Step 6c   |
| `interpretation_depth_metrics.ts` | Compact local source slices                             | Internal benchmark for ClinVar/CPIC/PGS/WGS interpretation depth and no-large-DB default policy                                                                                           | Evaluation layer                   |
| `vep_annotation.ts`               | Ensembl VEP (cache/offline)                             | Consequence prediction (missense, stop_gained, etc.), SIFT/PolyPhen, gnomAD AF, IMPACT rating. Optional — skips if VEP not installed                                                      | Phase 1 Step 1a + Phase 2 Step 6d  |
| `hallmark_engine.ts`              | Lopez-Otin aging hallmarks                              | Maps matched genes against 9 aging hallmark pathways, computes pathway-level scores                                                                                                       | Phase 2 Step 13                    |
| `prs_engine.ts`                   | PGS Catalog compact wellness weights + curated fallback | PGS/PRS scores for disease, longevity, and wellness traits with source ID, ancestry/build disclosure, and marker coverage confidence                                                      | Phase 2 Step 7                     |
| `gwas_engine.ts`                  | GWAS Catalog compact wellness associations              | Trait-level GWAS association context across longevity, performance, sleep, cardiometabolic, immune, nutrition, and cognitive domains; not diagnostic                                      | Phase 2 Step 7                     |
| `vep_missense_enrichment.ts`      | Ensembl VEP + longevity gene set                        | Annotates missense variants in 150+ longevity pathway genes (FOXO3, SIRT1-7, MTOR, AMPK, KL, TP53, etc.) with SIFT/PolyPhen/CADD functional impact scoring                                | Phase 2 Step 6d                    |
| `biomarker_engine.ts`             | Normalized lab readings                                 | Independent blood marker analysis across cardiometabolic, glucose/insulin, inflammation, nutrient, hormone/thyroid, organ-function, and hematology domains                                | Multi-modal layer                  |
| `wearable_engine.ts`              | Normalized wearable readings                            | Independent behavior analysis across sleep/recovery, cardiovascular recovery, activity/training, and rhythm consistency                                                                   | Multi-modal layer                  |
| `multimodal_engine.ts`            | Genomics + biomarkers + wearables                       | Cautious fusion layer that chooses the next upload and emits cross-modal actions only when modalities change the next step                                                                | Multi-modal layer                  |

`biomarker_engine.ts` also computes a dashboard-native derived-marker layer from
standard lab panels. Keep measured `lab_data` separate from
`derived_biomarkers`, but render both as first-class dashboard signals. Current
derived coverage includes HOMA-IR, non-HDL-C, remnant cholesterol, VLDL-C,
ApoB/ApoA1, transferrin saturation, lipid ratios, TyG, estimated average
glucose, BUN/creatinine, calculated osmolality, corrected calcium,
albumin/globulin, AST/ALT, FIB-4, APRI, CRP/albumin, fibrinogen/albumin,
CBC immune ratios, Mentzer index, estimated MCHC, and TSH/free T4.

### Multi-Modal Dashboard Layer

The renderer contract now includes `multimodal_plan`, which lets a genomics-only report show the next upload path instead of ending at DNA interpretation.

| Modality   | Inputs                                                                 | Dashboard role                                                                 | Implementation status                                                                                                                                                                         |
| ---------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Genomics   | VCF/VCF.GZ, WGS export, SNP-array raw text                             | Stable predisposition, ClinVar/CPIC flags, PRS, aging hallmarks, trait context | VCF/WGS implemented                                                                                                                                                                           |
| Biomarkers | Lab PDF/text export, CSV, manual marker table, optional previous panel | Current physiology, retestable baseline, annual trend target                   | Normalized CSV/JSON and plain-text lab export importer + independent scoring engine implemented; target labels and previous-panel trend display implemented; direct PDF table extraction next |
| Wearables  | WHOOP, Oura, Apple Health, Garmin, OHealth CSV/API export              | Sleep, recovery, activity, HRV, RHR, adherence between lab draws               | WHOOP-style daily CSV/API JSON importer + independent scoring engine implemented; target/status labels and prioritized behavior actions implemented; authenticated sync next                  |

Biomarker domains to support first:

- Cardiometabolic: ApoB, LDL-C, HDL-C, triglycerides, total cholesterol, non-HDL-C, Lp(a).
- Glucose and insulin: fasting glucose, fasting insulin, HbA1c, HOMA-IR.
- Inflammation and immune: hs-CRP, ferritin, homocysteine, WBC, neutrophils, lymphocytes.
- Nutrient status: vitamin D, B12, folate, magnesium, omega-3 index, uric acid.
- Hormone and thyroid: TSH, free T4, free T3, total/free testosterone, estradiol, SHBG, DHEA-S, morning cortisol.
- Organ function and safety: ALT, AST, GGT, ALP, bilirubin, creatinine, eGFR, BUN, albumin.
- Hematology: hemoglobin, hematocrit, platelets, RDW, MCV.

Wearable domains to support first:

- Sleep and recovery: sleep duration, sleep efficiency, deep sleep, REM sleep, recovery/readiness score.
- Cardiovascular recovery: HRV, resting heart rate, respiratory rate, SpO2.
- Activity and training load: steps, zone 2 minutes, vigorous minutes, strength sessions, VO2max estimate, strain.
- Rhythm and consistency: sleep consistency, bedtime variability, wake-time variability, alcohol days.

Important behavior: analyze each modality independently first. Do not let genetics explain away an abnormal biomarker, and do not let a wearable score substitute for a lab value. Fusion is allowed only when it changes the practical next action or retest window.

### PRS Trait Coverage (27 traits)

**Disease risk (5):** CAD, T2D, Alzheimer's, breast cancer, prostate cancer
**Longevity biomarkers (6):** Telomere length, VO2max, grip strength, epigenetic age (GrimAge), IGF-1, lean body mass
**Metabolic health (4):** HDL cholesterol, LDL cholesterol, triglycerides, blood pressure
**Inflammation (2):** C-reactive protein, IL-6
**Wellness (7):** Bone density, sleep duration, chronotype, vitamin D, homocysteine, alcohol consumption, caffeine metabolism
**Cognitive (3):** Reaction time, cognitive performance, emotional stability

When `reference/wellness/pgs_wellness_weights.json.gz` is present, PRS uses PGS Catalog rsID-backed compact scores first and fills missing traits from the curated fallback registry. Coordinate-only PGS scores are skipped by the rsID engine until position-aware PRS scoring is added.

### VEP Missense Coverage

150+ longevity pathway genes across 11 functional categories:

- Core longevity pathways (FOXO3, SIRT1-7, MTOR, IGF1R, KL, AKT1/2)
- AMPK & energy sensing (PRKAA1/2, PRKAB1/2, PRKAG1/2/3)
- DNA repair & genome stability (TP53, ATM, BRCA1/2, WRN, OGG1, PARP1)
- Proteostasis & autophagy (ATG5/7, BECN1, HSPA1A/B, HSPA9, LAMP2)
- Mitochondrial function (PPARGC1A, SOD2, CAT, GPX1/4, UCP1/2/3, PINK1)
- NAD+ metabolism (NAMPT, NMNAT1/2/3, CD38, NNMT)
- Inflammation & inflammaging (NFKB1/2, NLRP3, IL1B, IL6, TNF, CRP)
- Epigenetic regulation (DNMT1/3A/3B, TET1/2/3, HDAC1/2/3)
- Senescence & SASP (CDKN2A/p16, CDKN1A/p21, LMNB1)
- Stem cells & regeneration (SOX2, KLF4, LIN28A/B, NOTCH1)
- Vascular & metabolic (APOE, PCSK9, LDLR, MTHFR, VDR)

---

## Quick Start

This is the implementation quickstart for the public `analyze-longevity` skill.
The root repository `SKILL.md` is the install entry point; this file is the detailed runbook.

### Install As A Skill

Install the repository root, then run commands from the implementation directory:

```bash
npx skills add liveforeverbetter/agentic-health-analysis
cd ~/.codex/skills/analyze-longevity/skills/longevity-analysis
npm install
```

For development without installing the skill:

```bash
git clone https://github.com/liveforeverbetter/agentic-health-analysis.git
cd agentic-health-analysis/skills/longevity-analysis
npm install
```

### Invocation Behavior

When this skill is invoked, first confirm or infer these inputs in this order:

1. Outcome: ask what the user wants first, such as a full multimodal optimization,
   an actionable or recurring daily plan, a dashboard, ancestry context, or trends.
   Do not assume a dashboard is the goal.
2. Ready data: ask only for the local file paths or private download links needed for
   that outcome. For "optimize everything," inventory wearable/behavior, biomarkers,
   and genetics together; for a narrower request, do not add unrelated modalities.
   Offer concrete inputs when helpful: WHOOP, Oura, Apple Health, Garmin, OHealth,
   Fitbit/Google Health, or another CSV/JSON export for wearables; a CSV, JSON,
   plain-text, or PDF/table export for labs; and a whole-genome VCF/VCF.GZ,
   23andMe raw data, AncestryDNA raw data, or another SNP-array export for genetics.
   Each modality can also be `none`.
3. Annotation depth, only when genetics is included: ask, "Which annotation depth
   would you like? Simplified analysis (recommended) uses the bundled lightweight
   ClinVar-derived reference and requires no 20+ GB database download. Full dbSNP
   coverage provides broader rsID annotation, but requires downloading and storing
   more than 20 GB of reference data and takes substantially longer to set up and process."
4. Execution mode: this runbook is the local pipeline by default. If the user wants
   the full API on their own infrastructure or managed cloud, hand off to the hosted
   onboarding skill and keep the distinction explicit.
5. Product scope: wellness/educational interpretation, not diagnosis or treatment.

Do not ask consumers which genome build they have during onboarding. Infer it from the genetic file or provider metadata when possible, and handle an unknown build as part of input validation.
Default to simplified analysis unless the user explicitly chooses full dbSNP coverage. Full dbSNP improves variant identifier coverage; it does not make every variant medically interpretable.

Follow the selected branch explicitly:

- Simplified: run `npm run doctor:vcf -- <vcf>`, use the bundled ClinVar-derived rsID reference if annotation is needed, and continue to the dashboard pipeline. The annotation step normalizes `chr1` / `1` / `NC_000001.10` naming to the bundled table's numeric GRCh37 form before matching.
- Full dbSNP: run `npm run doctor:vcf -- <vcf>`, infer the build from the file or provider metadata, identify only the matching dbSNP reference, report its exact estimated download and storage requirement, and obtain confirmation before downloading anything. Download and index that matching reference, then run the dashboard pipeline with `--dbsnp=<reference>`; the annotation step normalizes standard human contigs to the GRCh37 NCBI accessions expected by dbSNP.
- If the build cannot be inferred safely, explain that full dbSNP annotation cannot proceed reliably and offer simplified analysis instead. Do not make the consumer choose between GRCh37 and GRCh38.

Tailor the next step to the answers:

- Genetics present: ask the annotation-depth follow-up, complete the selected annotation branch, then run the pipeline with `--genetics=...`, adding `--biomarkers=...`, `--biomarkers-previous=...`, and `--wearables=...` only when those files support the chosen outcome.
- Genetics absent: the canonical composer still runs from any combination of `--biomarkers` and `--wearables` flags. Genome sections render neutral "Not connected" placeholders and the plan uses measured evidence directly. Suggest genetics later only as a non-blocking context upgrade.
- Genetics present but biomarkers missing: produce the requested result with biomarker coverage marked missing and recommend labs next because they make the plan retestable.
- Genetics present but wearables missing: produce the requested result with behavioral coverage marked missing and recommend wearable/behavior data after labs.
- Biomarkers or wearables present but genetics missing: run the pipeline with the supplied flags and produce a personalized plan from measured data. Do not require or fabricate genetics.
- No user data yet: run `npm run sample:report` so the user can preview the dashboard before processing sensitive data.

If the user has not provided data files yet, ask for:

- The absolute path or private download link for any wearable/behavior export.
- The absolute path or private download link for any biomarker/lab CSV, JSON, text, PDF/table export, and optional previous panel.
- The absolute path or private download link for a VCF/VCF.GZ, 23andMe/Ancestry raw file, or other SNP-array export.
- A report/user ID and output directory, or use `user_001` and `./output`.

If the user only wants to preview the dashboard, run the packaged sample report. Do not fabricate user genomic, biomarker, or wearable data.

After delivering the first requested result, offer to make a plan recurring when that
would help. Do not install automation unless the user explicitly opts in, and confirm
the exact agent command, schedule, output location, and local data paths before writing
a crontab entry.

For the MVP, VEP functional annotation is intentionally optional and may be skipped. Do not block the user on VEP setup unless they specifically ask for rare coding-impact or missense consequence interpretation.

Raw-read callers such as DeepVariant/GATK, CNV/SV callers, or repeat callers are only necessary when the user provides FASTQ/BAM/CRAM, when the vendor VCF lacks the variant class being interpreted, or when external benchmark query VCFs must be regenerated from GIAB-style reads. Do not install or require them for a normal VCF/23andMe dashboard run.

For deeper WGS work, follow `references/wgs-process.md`. It defines the checklist for rsID annotation, VEP, ClinVar/CPIC/PRS mapping, CNV/SV/repeat interpretation, GIAB validation, and dashboard coverage disclosure.

The skill bundles a lean ClinVar GRCh37 rsID reference by default:

```bash
npm run doctor:vcf -- /absolute/path/to/user.vcf.gz
npm run annotate:vcf -- /absolute/path/to/user.vcf.gz ./output/user.annotated.vcf.gz
npm run setup:rsids
```

`annotate:vcf` uses the bundled ClinVar-derived `reference/clinvar/clinvar_rsid_annotation.tsv.gz`. This is ClinVar-only rsID recovery, not full dbSNP annotation. It normalizes standard human contigs to numeric GRCh37 names before matching, then fails closed if zero rsIDs are added. It improves unannotated WGS clinical/wellness interpretation while still missing many non-ClinVar rsIDs used by GWAS, PRS, and consumer marker databases. Use full dbSNP only when broad rsID recovery is needed.

```bash
# Render a sample wellness report before processing sensitive data
npm run sample:report

# Run a tiny rsID-annotated WGS smoke test through the real pipeline and renderer
npm run smoke:wgs

# Check the installable skill surface, onboarding prompts, WGS docs, and example-size budget
npm run doctor

# Modality-optional pipeline (named flags only — positional arguments are rejected)
# Genetics is optional; supply any combination of --genetics, --biomarkers, --wearables.
npm run pipeline -- \
  --genetics=/absolute/path/to/your.vcf.gz \
  --user=user_001 --out=./output

# Genetics + blood test + wearable export
npm run pipeline -- \
  --genetics=/absolute/path/to/your.vcf.gz \
  --biomarkers=/absolute/path/to/biomarkers.csv \
  --biomarkers-previous=/absolute/path/to/previous-biomarkers.csv \
  --wearables=/absolute/path/to/whoop-or-wearable.json \
  --user=user_001 --out=./output

# Biomarkers + wearables, no genetics
npm run pipeline -- \
  --biomarkers=/absolute/path/to/biomarkers.csv \
  --wearables=/absolute/path/to/whoop-or-wearable.json \
  --user=user_001 --out=./output

# Preflight any combination without running the analysis
npm run pipeline -- --doctor \
  --biomarkers=/absolute/path/to/biomarkers.csv \
  --wearables=/absolute/path/to/whoop-or-wearable.json

# Render HTML again from an existing dashboard JSON
npm run render -- ./output/user_001_dashboard.json ./output

# Score generated artifacts against genomic, multimodal, actionability, and UX criteria
npm run evaluate

# Write per-step processing, visualization, and skill-hygiene diagnostics
npm run audit:pipeline

# Or run just the variant analysis step (VCF → longevity-protocol.json)
npm run analyze -- /absolute/path/to/your.vcf.gz
```

**Recommended flow:**

1. Install `analyze-longevity` and run `npm install` from `skills/longevity-analysis`.
2. If no user data is available, run `npm run sample:report`.
3. To verify the installed skill without large references, run `npm run smoke:wgs`.
4. To verify distribution readiness, run `npm run doctor`.
5. To inspect optional heavyweight references without bloating the repo, run `npm run reference:doctor` and `npm run reference:setup`.
6. With a user VCF, run `npm run pipeline -- --genetics=/absolute/path/to/user.vcf.gz --user=user_001 --out=./output`. Without genetics, drop the `--genetics` flag and supply `--biomarkers` and/or `--wearables` instead — the canonical action plan composer runs from whichever modalities are present.
7. Keep the generated `index.html` on disk. Do not open it automatically; only
   open it in a browser when the user explicitly asks for a visual report.
8. Run `npm run evaluate`, `npm run audit:pipeline`, and `npm run typecheck` before publishing changes.

For a cloned repository smoke test with the bundled large VCF, install Git LFS first, then from `skills/longevity-analysis` run:

```bash
git lfs install
git lfs pull
npm run pipeline -- --genetics=../../example-data/snps.vcf.gz --user=smoke_user --out=./output
```

---

## Pipeline Steps In Detail

### Phase 1: VCF Analysis (`parse-vcf.ts` → `analyzeVCF`)

#### Step 1: Data Type Detection & rsID Annotation

The pipeline inspects the VCF to determine WGS vs. SNP array:

- **WGS:** Millions of variants (~3.7M), NC\_ format contigs, GATK-style headers.
  Needs rsID annotation. The default path uses bundled ClinVar GRCh37 rsID recovery; full dbSNP GRCh37 remains optional for broader coverage.
- **SNP arrays:** Hundreds of thousands, chr prefix, provider-specific format.
  May already have rsIDs. ClinVar/CPIC/VEP enrichment skipped for < 100K variants.

`doctor:vcf` reports rsID density. `annotate:vcf` runs `bcftools annotate` against the bundled ClinVar-derived TSV after normalizing standard human contigs to numeric GRCh37 names. With `npm run pipeline -- --genetics=<vcf> --dbsnp=<reference>`, the full dbSNP path instead normalizes standard human contigs to GRCh37 NCBI accessions. Neither path silently accepts a generated annotation with zero rsIDs.

#### Step 1a: VEP Functional Annotation (Optional)

`vep_annotation.ts` shells out to Ensembl VEP with `--cache --offline --everything`:

- Consequence type (missense, stop_gained, frameshift, splice, etc.)
- SIFT and PolyPhen pathogenicity scores
- gnomAD allele frequency
- IMPACT rating (HIGH, MODERATE, LOW, MODIFIER)
- Output cached as `.vep.tsv` alongside the VCF

**Gracefully skipped** if VEP is not installed or cache is missing. No pipeline failure.

#### Step 2: Interpretation Database Matching

Matches all annotated rsIDs against the interpretation database of 784 clinically-relevant
markers across 8 categories (wellness, vulnerability, pharmacology, performance,
personality, hereditary, longevity, ancestry).

#### Step 3: ClinVar Enrichment

`clinvar_enrichment.ts` cross-references **ALL annotated rsIDs** (not just the 784 curated markers)
against a pre-built ClinVar index:

- Clinical significance (pathogenic, likely-pathogenic, VUS, benign, protective)
- Disease/gene mapping with review status
- ACMG SF v3.2 gene set flags (BRCA1/2, TP53, LDLR, FBN1, etc.)
- Population frequency classification (rare < 1%, uncommon 1-5%, common > 5%)
- Consumer-facing annotation generation

Results are merged into the LongevityProtocol as alerts, risk mitigations, and superpowers.

#### Step 4: CPIC Pharmacogenomic Enrichment

`cpic_enrichment.ts` matches the **full VCF genotype map** (all rsIDs, not just targets)
against hardcoded CPIC Level A/B drug-gene pairs:

- CYP2C19-clopidogrel, VKORC1-warfarin, CYP2D6-codeine, SLCO1B1-statins,
  DPYD-fluorouracil, TPMT-thiopurines, UGT1A1-irinotecan, HLA-abacavir, etc.
- Genotype → phenotype → clinical recommendation
- 18 drug-gene rules with published CPIC guideline URLs

Results are merged into the LongevityProtocol as medical alerts.

#### Step 5: Protocol Assembly

All results (interpretation DB + ClinVar + CPIC) are assembled into a `LongevityProtocol`:
alerts, superpowers, topRisks (sorted by priority), and a categorized supplement stack.
Output: `longevity-protocol.json`.

---

### Phase 2: Trait Pipeline (`pipeline/index.ts` → `runPipelineFromVCF`)

#### Step 6: Multi-Source Trait Score Mapping

Four independent scoring streams are merged via `mergeTraitScores()` (lower score wins):

| Stream                      | Source                                    | Scope                       | Example trait IDs produced                                                                                                     |
| --------------------------- | ----------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 6a. `mapProtocolToTraits()` | Interpretation DB (784 markers)           | 200+ gene→trait lookup      | `methylation`, `inflammation`, `neuroplasticity`, `dna_repair`                                                                 |
| 6b. `mapClinVarToTraits()`  | ClinVar annotations (from Phase 1 Step 3) | Pathogenic only             | `cancer_susceptibility`, `cardiomyopathy_risk`, `neurodegeneration_risk`, `lipid_disorder`, `thrombosis_risk`, `iron_overload` |
| 6c. `mapCPICToTraits()`     | CPIC matches (re-evaluated)               | Level A/B drug-gene pairs   | `cyp2d6_metabolism`, `cyp2c19_metabolism`, `warfarin_sensitivity`, `statin_myopathy`, `drug_hypersensitivity`                  |
| 6d. `mapVEPToTraits()`      | VEP rare HIGH/MODERATE (AF < 0.01)        | Loss-of-function + missense | `cancer_susceptibility`, `cardiomyopathy_risk`, `arrhythmia_risk`, `aortopathy_risk`, `lipid_disorder`, `monogenic_diabetes`   |

Score assignment: pathogenic = 25-45 (concerning), protective = 85, CPIC Level A = 40 (actionable).
All trait IDs resolve against the knowledge graph (134 traits). Unmatched IDs get a
fallback node — never silently dropped.

#### Step 7: Variant Cards & Polygenic Risk Scores

- `buildClinVarVariantCards()` organizes ClinVar annotations into 5 Dante Labs-inspired
  categories: genetic_conditions, drug_response, other_risks, rare_mutations, uncommon_mutations.
  Each card includes zygosity determination, CADD score enrichment from VEP, consumer annotation,
  and significance color coding.
- `computePRS()` calculates polygenic risk scores for 5 common diseases using published
  GWAS weights from PGC, GIANT, BCAC, PRACTICAL, and IGAP consortia. Population
  parameters (mean/SD) are used to compute percentiles and risk labels.

#### Step 8: Knowledge Graph Enrichment

`graph_resolver.ts` enriches every merged trait score against `knowledge_graph_data.json`
(134 traits with mechanism, outcomes, actions). Traits not found in the graph receive a
fallback node with generic outcome (severity 0.5) and two standard actions — they flow
through priority, insight, protocol, and GLI engines rather than being discarded.

#### Step 9: Priority Scoring

`priority_engine.ts` computes per-trait priority scores: risk × severity × impact × confidence.
Results are sorted descending for downstream consumption.

#### Step 10: Insight Generation

`insight_engine.ts` generates score-appropriate human-readable summaries. High-scoring
traits get "maintain" language; low-scoring traits get "action needed" language.

#### Step 11: Protocol Generation

`protocol_engine.ts` bundles actions into Core Optimization (at-risk traits, score < 40),
Maintenance (moderate traits, 40-70), and Wellness Maintenance protocols with difficulty tags.

#### Step 12: GLI Computation

`gli_engine.ts` computes the **severity-weighted** Genomic Longevity Index (0–1000).
Higher-severity traits (e.g., thrombosis risk 0.7) influence the score more than
lower-severity traits (e.g., lipid composition 0.3). Also computes per-category GLI.

| GLI Range | Rating     | Description                             |
| --------- | ---------- | --------------------------------------- |
| 800–1000  | Excellent  | Outstanding genomic longevity profile   |
| 600–799   | Good       | Good profile with room for optimization |
| 400–599   | Moderate   | Targeted interventions recommended      |
| 0–399     | Needs Work | Significant optimization opportunities  |

#### Step 13: Hallmark Pathway Analysis

`hallmark_engine.ts` maps all matched genes against the 9 Lopez-Otin aging hallmarks:
genomic instability, telomere attrition, epigenetic alterations, loss of proteostasis,
deregulated nutrient sensing, mitochondrial dysfunction, cellular senescence,
stem cell exhaustion, and altered intercellular communication. Each hallmark gets a
pathway-level score and the number of hallmarks affected drives a genome stability score.

#### Step 14: Top Traits Extraction

Top 5 traits by priority score are extracted for the dashboard hero section.

#### Step 15: Dashboard Rendering

`src/renderer/render.ts` renders a complete self-contained HTML dashboard via Nunjucks:

- GLI hero ring with conic gradient and score badge
- Provenance bar (data source, coverage, markers, pipeline version, ClinVar/CPIC/VEP counts)
- Multi-modal upload path showing connected data, next best upload, biomarker domains, and wearable domains
- Category GLI breakdown cards with drill-down detail cards
- Innate strengths cards on the Overview tab
- Insight cards with action counts
- Actionable plan cards with priority badges and step lists
- Protocol scroll cards (Overview) and full protocol detail cards (Protocols tab)
- Genetic Variants tab (5 categories of ClinVar variant cards)
- Polygenic risk score section
- Dark mode, density, and motion tweaks panel
- Keyboard shortcuts (1/2/3 tabs, t theme toggle, ? overlay)
- Print/PDF export with `@media print` stylesheet

### Performance / WHOOP-style design contract

The bundled `shared/design/systems.json` `performance` system is a complete
responsive contract for custom dashboards, not just a palette. It is inspired
by the performance-tracking genre and uses original tokens and components.

- Lead with **recovery, sleep performance, and strain**; use HRV, resting heart
  rate, respiratory rate, oxygen, temperature, stress, and activities as the
  health-monitor context.
- Keep **biomarkers, genetics, and health context** as explicit sections below
  live wearable signals. Each section declares required fields, optional fields,
  empty states, responsive behavior, provenance, and freshness rules.
- Use the direct-coach **FOCUS** plan contract: `FOCUS`, `MAINTAIN`, `WATCH`, and
  `RETEST`, with why-now, steps, target metric, check-in, source IDs, confidence,
  and a wellness safety note.
- Follow the motion choreography in the system: gauge sweep, optional healthspan
  orb, count-in, bar growth, and focus reveal. Respect `prefers-reduced-motion`
  by rendering final values immediately.

The performance renderer is white-label and responsive. A custom React, native,
or agent-generated surface can use the same contract while replacing the HTML
components.

### APEX design-system contract

`--design=apex` selects the source-faithful APEX dashboard implementation. It
uses the same full multimodal pipeline object as the ForeverBetter dashboard and
the API's `GET /design/systems/apex` response, so the design can be recreated
without shipping the original handoff prototype.

- Use the APEX near-black canvas, Archivo UI hierarchy, and JetBrains Mono for
  values; do not substitute an inspiration brand in white-label output.
- Keep the fixed information order and tabs: sticky header → keyboard-operable
  Overview, Action plan, Genomic, Wearable, and Biomarker tabs → Sleep,
  Recovery, and Strain readiness rings → observation / monitor → FOCUS →
  genomic context → biomarker / biological-age context. Tab transitions may
  stagger panels and tiles briefly, but must switch instantly with reduced
  motion and preserve keyboard focus.
- Keep source chips and freshness beside live signals; never create readiness,
  streak, or biological-age values from absent data.
- Preserve the APEX token, layout, modality, action-plan, and reduced-motion
  contract in `shared/design/systems.json` when generating another surface.

---

## Interpretation Database

784 clinically relevant markers across 8 JSON files (loaded at runtime, never hardcoded).

```
skills/longevity-analysis/shared/interpretations/
├── wellness.json         # 141 markers – nutrition, methylation, metabolism, detox, inflammation,
│                        #   circadian, gut immunity, selenium, thyroid, adipokines
├── pharmacology.json     # 78 markers  – drug metabolism, CYP450, pharmacogenetics, ABCB1, OPRM1
├── vulnerability.json    # 151 markers – GWAS disease risk (APOE, TCF7L2, LPA, 9p21.3, SNCA, LPL, MLXIPL, etc.) + ACMG FH genes
├── performance.json      # 40 markers  – athletic potential, injury risk, mitochondrial, VO2max, bone density
├── personality.json      # 46 markers  – cognitive, neurotransmitter, social bonding, stress, Alzheimer's
├── hereditary.json       # 294 markers – monogenic conditions, carrier status, ACMG SF v3.2 P/LP variants
├── longevity.json        # 20 markers  – centenarian GWAS (FOXO3, CETP, KLOTHO), aging rate, autophagy,
│                        #   telomere, mTOR/AMPK, IGF signaling
└── ancestry.json         # 14 markers  – haplogroups, Neanderthal %
```

### Expanding the Interpretation Database

To regenerate ClinVar-expanded interpretations after updating the ClinVar index:

```bash
npx tsx skills/longevity-analysis/scripts/pipeline/expand_interpretations.ts
```

This reads `example-data/clinvar_matches.json` and generates genotype-agnostic
interpretations (`*` wildcard key) for all clinically actionable variants not
already in the curated set. Entries are classified as:

- **pharmacology** — drug response variants (tramadol, statins, levothyroxine, etc.)
- **hereditary** — pathogenic/likely-pathogenic variants (disease genes)
- **vulnerability** — risk factor variants (CAD, macular degeneration, autoimmune)

The pipeline supports `*` wildcard genotypes — when a specific genotype isn't
found, the wildcard interpretation is used as a fallback (`parse-vcf.ts:442`).

---

## Scripts Reference

| Script                                       | Purpose                                                                                                                                                          | Command                                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `scripts/ingestion/parse-vcf.ts`             | VCF parsing, rsID annotation, ClinVar/CPIC/VEP enrichment, interpretation matching → `longevity-protocol.json`                                                   | `npx tsx scripts/ingestion/parse-vcf.ts <vcf> [--annotated]`                                                       |
| `scripts/pipeline/index.ts`                  | Full end-to-end pipeline → `{user}_action_plan.json` + `{user}_health_analysis.json` + `index.html` (+ `{user}_dashboard.json` when genetics supplied)           | `npx tsx scripts/pipeline/index.ts --genetics=<vcf> --biomarkers=<csv> --wearables=<json> --user=<id> --out=<dir>` |
| `scripts/pipeline/health_analysis.ts`        | Modality-optional orchestrator. Runs genetics/biomarker/wearable engines, normalizes observations, composes the canonical plan.                                  | `runHealthAnalysis({ geneticsPath?, biomarkersPath?, wearablesPath?, userProfile? })`                              |
| `scripts/pipeline/action_plan_composer.ts`   | Single composer over `NormalizedObservation[]` + curated `InterventionRule[]`. Emits 0-3 qualified priorities, review items, maintenance, optional next-context. | `composePersonalizedActionPlan(observations, options)`                                                             |
| `scripts/pipeline/intervention_rules.ts`     | Typed curated rule catalog. Versioned; deduped by `intervention_id`.                                                                                             | n/a — imported by composer                                                                                         |
| `scripts/pipeline/input_doctor.ts`           | Unified preflight for any combination of genetics/biomarkers/wearables. Reports problem + cause + fix + example.                                                 | `npm run pipeline -- --doctor --biomarkers=path ...`                                                               |
| `scripts/pipeline/audit-pipeline.ts`         | Quantitative diagnostic audit → `output/pipeline-audit.json` + `.md`                                                                                             | `npm run audit:pipeline`                                                                                           |
| `scripts/pipeline/pipeline.test.ts`          | Test suite                                                                                                                                                       | `npx tsx --test scripts/pipeline/pipeline.test.ts`                                                                 |
| `scripts/pipeline/expand_interpretations.ts` | ClinVar → interpretation DB expansion engine                                                                                                                     | `npx tsx scripts/pipeline/expand_interpretations.ts`                                                               |

For the module-level step map and audit outputs, read `PIPELINE.md`.
For the best-available WGS interpretation process, read `references/wgs-process.md`.

---

## Output Contract

The renderer consumes the skill-local contract in `shared/dashboard-types.ts`. Key dashboard fields are GLI, per-category GLI, top traits, enriched traits, priorities, insights, protocols, aging hallmark report, ClinVar variant cards, PRS scores, GWAS trait sections, and `multimodal_plan`.

`transformToDashboardData()` runs empty biomarker/wearable analyses during a genomics-only VCF run so the dashboard shows supported domains, missing priority markers, and the next upload path. Future biomarker and wearable parsers should pass normalized readings into `analyzeBiomarkers()` and `analyzeWearables()` rather than creating separate dashboard sections.

---

## Testing

100 tests covering all engine modules, including independent biomarker, wearable, and multi-modal fusion engines:

```bash
npx tsx --test skills/longevity-analysis/scripts/pipeline/pipeline.test.ts
```

---

## Reference Data

Bundled compact references live under `reference/clinvar/` and `reference/wellness/`. Full dbSNP, VEP caches, raw GWAS/PGS downloads, and raw-read caller assets are optional local setup items documented in `references/optional-reference-manifest.json` and `references/wgs-process.md`.

Primary external sources represented in the pipeline are ClinVar, CPIC, PharmGKB, ACMG secondary findings, GWAS Catalog, PGS Catalog, Ensembl VEP, and peer-reviewed variant literature.

Condition-centric scope and editorial blocks for the six consumer modalities (hereditary, pharmacology, genetic-vulnerability, personality, wellness, ancestry) live under `skills/longevity-analysis/{folder}/catalog/` and are consumed via `scripts/pipeline/catalog_loader.ts` to wrap the rsID-level interpretation layer with condition-level context whenever a user uploads a VCF. See `PIPELINE.md` § _Condition Catalog Layer_ for the schema and consumption pattern.

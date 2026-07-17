# WGS Process And Interpretation Checklist

This is the best-available process for getting a WGS file as close as possible to complete, auditable interpretation in the local dashboard.

The normal public path is still VCF-first: users provide a WGS VCF/VCF.GZ from a sequencing provider, and the skill produces dashboard JSON plus `index.html`. Raw-read calling from FASTQ/BAM/CRAM is an advanced escalation path, not a first-run requirement.

## 1. Identify The Input

Classify the user file before running interpretation:

| Input                            | Expected path                                                              | Interpretation depth         |
| -------------------------------- | -------------------------------------------------------------------------- | ---------------------------- |
| WGS VCF/VCF.GZ with rsIDs        | Run directly through `npm run pipeline`                                    | Best normal public path      |
| WGS VCF/VCF.GZ without rsIDs     | Annotate or provide a position-to-rsID reference first                     | Strong after annotation      |
| SNP-array export                 | Run through reduced-coverage mode where supported                          | Limited to array markers     |
| BAM/CRAM/FASTQ                   | Run caller setup first, then feed generated VCFs to the dashboard pipeline | Advanced                     |
| CNV/SV/repeat-only caller output | Normalize to VCF-like records, then validate/report by class               | Advanced variant-class layer |

Ask for:

- Absolute file path.
- Provider and genome build if known.
- Whether the file already has rsIDs in the VCF `ID` column.
- Whether the user has separate CNV/SV/repeat outputs.
- Optional biomarker and wearable files to make the action plan retestable.

## 2. Normalize And Preflight

For every WGS VCF:

1. Confirm it is readable.
2. Confirm it has VCF headers and sample genotype columns.
3. Count total variant records.
4. Count rsID-annotated records.
5. Detect genome build/provider when possible.
6. Record whether VEP, ClinVar, CPIC, PRS, and WGS variant-class references are available.

Useful commands from `skills/longevity-analysis`:

```bash
npm run smoke:wgs
npm run doctor:vcf -- /absolute/path/to/user.vcf.gz
npm run annotate:vcf -- /absolute/path/to/user.vcf.gz ./output/user.annotated.vcf.gz
npm run pipeline -- /absolute/path/to/user.vcf.gz user_001 ./output
npm run vcf:coverage
npm run catalog:build
npm run interpretation:depth
```

Expected public-dashboard threshold:

- WGS-scale path: hundreds of thousands to millions of variants.
- Strong local fixture coverage: at least 1,000,000 local records, 500,000 rsIDs, 5 variant classes, 75 curated-rsID overlaps, and 40 PRS overlaps.
- Compact interpretation depth: score at least 90, with ClinVar, CPIC, PGS, curated markers, and WGS class slices represented.

## 3. rsID Annotation

rsID mapping is the most important practical improvement for provider WGS files. The current curated interpretation database, ClinVar lookup, CPIC rules, and PRS weights are mostly rsID keyed.

If the VCF has rsIDs:

```bash
npm run pipeline -- /absolute/path/to/annotated.vcf.gz user_001 ./output
```

If the VCF lacks rsIDs, use the lean ClinVar rsID annotation reference or full dbSNP reference:

| Reference                                          | Use                                                | Tradeoff                                           |
| -------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| `reference/clinvar/clinvar_rsid_annotation.tsv.gz` | Bundled lean annotation for clinically known rsIDs | Smaller and default, misses many non-ClinVar rsIDs |
| `reference/dbsnp/GCF_000001405.25.gz`              | Full dbSNP rsID annotation                         | Large, best coverage                               |

Default setup and update commands:

```bash
npm run doctor:vcf -- /absolute/path/to/user.vcf.gz
npm run setup:rsids
npm run reference:wellness
npm run annotate:vcf -- /absolute/path/to/user.vcf.gz ./output/user.annotated.vcf.gz
npm run pipeline -- ./output/user.annotated.vcf.gz user_001 ./output
```

`setup:rsids` downloads the current NCBI ClinVar GRCh37 VCF, verifies the NCBI MD5, rebuilds the tabix-indexed position-to-rsID TSV, rebuilds the compressed `rsID|clinicalSignificance|disease|gene|reviewStatus` index, and writes `reference/clinvar/clinvar-rsid-reference.manifest.json`.

Disclose the default annotation scope in the dashboard:

- ClinVar rsID recovery only.
- Not full dbSNP annotation.
- Not diagnostic and not a clinical decision tool.
- VUS findings are context only, not action triggers.
- Full dbSNP is still required when broad non-ClinVar rsID recovery is needed for GWAS/PRS/consumer-marker coverage.

`reference:wellness` builds the PGS Catalog + GWAS Catalog association layer used for wellness optimization. It commits only compact derived files (`gwas_wellness_associations.json.gz`, `pgs_wellness_weights.json.gz`, and manifest) and keeps raw GWAS/PGS downloads under ignored `reference/wellness/raw/`.

Dashboard interpretation rules:

- PGS scores are conditional on observed marker coverage, ancestry fit, and genome build.
- GWAS hits are population-level associations, not ClinVar assertions.
- Coordinate-only PGS Catalog scores are skipped by the rsID PRS engine until position-aware scoring is implemented.
- Every PGS/GWAS output should carry source ID, source URL/release, confidence tier, and ancestry/build/coverage disclosure.

The implementation normalizes standard human contigs automatically before annotation:

- Bundled ClinVar GRCh37 subset: `chr1`, `1`, or `NC_000001.10` → `1`.
- Full dbSNP GRCh37: `chr1`, `1`, or `NC_000001.10` → `NC_000001.10`.

Use a full dbSNP reference explicitly after the user opts in:

```bash
npm run pipeline -- --genetics=/absolute/path/to/user.vcf.gz --dbsnp=/absolute/path/to/GCF_000001405.25.gz --user=user_001 --out=./output
```

When annotation still fails, check:

- `chr1`
- `1`
- `NC_000001.10`
- GRCh37 vs GRCh38 coordinate mismatch

Do not silently continue if a generated WGS annotation has zero rsIDs. The pipeline rejects that artifact and regenerates it rather than treating its filename as proof of successful annotation.

## 4. Interpretation Layers

The WGS dashboard should preserve which layer produced each finding.

| Layer                | Input                             | Interpretation output                                                                        | User-facing stance                                        |
| -------------------- | --------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Curated markers      | rsID + genotype                   | Wellness, pharmacology, hereditary, vulnerability, performance, personality, ancestry traits | Consumer-ready, still educational                         |
| ClinVar              | rsIDs across the full VCF         | Pathogenic/likely pathogenic, VUS, drug response, ACMG flags                                 | Confirm clinically before action                          |
| CPIC                 | rsID genotype map                 | Drug-gene context and phenotype hints                                                        | Informational; do not change medication from report alone |
| PRS                  | rsID weights                      | Directional disease, longevity, and wellness polygenic scores                                | Risk context, not diagnosis                               |
| VEP                  | variant consequence annotations   | Rare coding-impact and missense context                                                      | Optional; disclose when skipped                           |
| WGS class catalog    | CNV/SV/repeat/large-indel records | Structural and repeat finding cards where evidence exists                                    | Reportable only when evidence tier and class are clear    |
| Knowledge graph      | merged traits                     | Mechanisms, outcomes, actions, hallmark links                                                | Wellness protocol generation                              |
| Biomarkers/wearables | optional user files               | Retestable current-state context                                                             | Use to prioritize and retest actions                      |

If a layer is missing, the dashboard should disclose that limitation instead of presenting the WGS report as complete.

## 5. Variant-Class Coverage

WGS should be treated as more than SNPs. Track these classes separately:

| Class                    | Normal source                                   | Interpretation requirement                                |
| ------------------------ | ----------------------------------------------- | --------------------------------------------------------- |
| SNV                      | WGS VCF                                         | rsID or position mapping, curated/ClinVar/PRS/VEP mapping |
| Small indel              | WGS VCF                                         | VEP or ClinVar mapping where available                    |
| CNV                      | Vendor CNV VCF or caller output                 | Dosage-sensitive region/gene catalog and evidence tier    |
| SV/rearrangement         | Vendor SV VCF or caller output                  | ClinGen/dbVar/DGV-style support where available           |
| Tandem repeat            | Repeat caller output or provider repeat records | Repeat-specific thresholds and condition catalog          |
| Large insertion/deletion | SV/indel caller output                          | Reportability by class, gene/region, and evidence         |

Run:

```bash
npm run wgs:variant-classes
npm run wgs:validate
npm run wgs:query-readiness
```

`npm run wgs:validate` validates parser/class/reportability behavior against internal fixtures. `npm run wgs:query-readiness` tells you what is missing for external GIAB precision/recall validation.

## 6. Optional VEP Setup

VEP improves rare coding-impact interpretation. It is optional because it is a large local dependency.

Use VEP when:

- The user asks for rare coding-impact or missense interpretation.
- The VCF has many non-rsID rare variants.
- You need consequence, SIFT, PolyPhen, gnomAD frequency, or impact labels.

Keep behavior fail-soft:

- If VEP is present, include `vep_status: included` and annotation counts.
- If VEP is missing, include `vep_status: skipped` and state that rare coding-impact interpretation is limited.

## 7. Raw-Read Caller Escalation

Use raw-read callers only when needed:

- The user provides BAM/CRAM/FASTQ rather than VCF.
- The provider VCF omits CNV/SV/repeat records the user wants interpreted.
- You are generating HG002 query VCFs for GIAB external validation.

Expected caller families:

| Need           | Example tool family                                     | Output                                       |
| -------------- | ------------------------------------------------------- | -------------------------------------------- |
| Small variants | DeepVariant, GATK HaplotypeCaller                       | SNV/indel VCF                                |
| CNV            | GATK gCNV or equivalent                                 | CNV VCF/segments                             |
| SV             | Manta, GATK-SV, Sniffles-style tools depending on reads | SV VCF                                       |
| Tandem repeats | ExpansionHunter-style tools                             | Repeat calls converted to reportable records |

Run:

```bash
npm run wgs:caller-manifest
npm run wgs:query-readiness
./output/wgs-local-setup-plan.sh summary
./output/wgs-local-setup-plan.sh print-plan
```

Do not treat Java, Docker, or one caller as evidence that the full WGS stack is ready. The readiness report must show input files, caller tools, postprocess tools, and benchmark tools separately.

## 8. GIAB External Validation

GIAB is the advanced validation benchmark, not a user requirement.

Use it to answer: if we call variants from a known HG002 genome, do we recover trusted truth variants with acceptable precision and recall?

Process:

```bash
npm run wgs:truthsets
npm run wgs:truthsets -- --check-remote
npm run wgs:query-readiness
npm run wgs:external-validation
```

Only use `--download` or `--run` when the workstation has enough disk, memory, caller inputs, and benchmark tools.

Expected current public state can be:

- `wgs:query-readiness`: `setup_required`.
- `wgs:external-validation`: fail-closed preflight until query VCFs and indexes exist.

That is acceptable for public release if the normal VCF dashboard path is green and the advanced setup path is explicit.

## 9. Dashboard Interpretation Contract

Every generated WGS dashboard should make these states visible:

- Input type and variant count.
- Annotated rsID count.
- Curated marker matches.
- ClinVar pathogenic/likely pathogenic counts and variant categories.
- ClinVar confidence tiers: pathogenic/likely pathogenic, drug response, risk factor/protective, VUS, benign, conflicting classifications.
- rsID annotation source and limitation, especially when using the bundled ClinVar-only rsID subset rather than full dbSNP.
- CPIC actionable count.
- PRS count and PRS limitation language.
- VEP included/skipped state.
- WGS variant-class coverage and external-validation state.
- Local processing and wellness/non-diagnostic boundary.
- Suggested next data upload, usually biomarkers, when the report is genomics-only.

If any state is missing from the payload, treat it as a pipeline quality gap before public release.

## 10. Release Gate

Before claiming the WGS process is release-ready, run:

```bash
npm run sample:report
npm run smoke:wgs
npm run doctor
npm run reference:doctor
npm run reference:setup
npm run reference:fixtures
npm run cnv:validate
npm run catalog:build
npm run interpretation:depth
npm run vcf:coverage
npm run wgs:variant-classes
npm run wgs:validate
npm run wgs:query-readiness
npm run evaluate
npm run audit:pipeline
npm run typecheck
npm test
```

The normal public release can ship when:

- Sample report renders.
- The packaged rsID WGS smoke fixture produces dashboard JSON and HTML.
- A real rsID-annotated VCF produces dashboard JSON and HTML.
- The compact catalog and interpretation-depth reports pass.
- The optional-reference manifest reports missing heavyweight assets as setup actions, not bundled repo files.
- The tiny rsID/ClinVar/WGS/GIAB fixtures and compact CNV/SV/repeat evidence fixture validate locally.
- Internal WGS class validation passes.
- GIAB external validation is either runnable or explicitly documented as `setup_required`.
- The dashboard discloses missing VEP, missing external validation, and reduced coverage when applicable.

## 11. What Is Not Bundled Locally

The repo should keep the public skill lightweight. These items are intentionally documented or preflighted, not bundled:

| Item                                                       | Local status                            | Why it is not bundled                                                                                                      |
| ---------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Raw GWAS Catalog and PGS Catalog dumps                     | Ignored under `reference/wellness/raw/` | The compact derived wellness indexes are bundled; raw TSV/scoring cache includes large files and should be rebuilt locally |
| Full dbSNP rsID reference                                  | Not bundled                             | Large reference archive; users can point to a local copy when needed                                                       |
| ClinVar full VCF/index                                     | Not bundled                             | Large and updateable; the bundled default is the lean ClinVar rsID TSV plus compressed interpretation index                |
| Ensembl VEP cache                                          | Optional external dependency            | Large cache and installation-specific setup                                                                                |
| BAM/CRAM/FASTQ caller stack                                | Not bundled                             | DeepVariant/GATK/Manta/GATK-SV/ExpansionHunter style tooling is heavyweight and platform-specific                          |
| GIAB truthsets and query VCFs                              | Not bundled                             | Advanced precision/recall benchmark assets; normal dashboard generation does not require them                              |
| Public CNV/SV/repeat evidence catalogs at production depth | Small local fixture only                | The repo includes synthetic regression fixtures; production-scale catalogs should be documented and versioned separately   |

The local repo should validate the process shape without these assets:

- `npm run doctor` checks that the WGS process document, scripts, local synthetic fixtures, and disclosure contracts are present.
- `npm run reference:doctor` checks optional dbSNP, ClinVar, VEP, GIAB, caller-output, and tool readiness from a tiny manifest.
- `npm run reference:setup` prints or writes setup/download plans for ignored local reference caches; downloads require explicit `--download`.
- `npm run reference:fixtures` validates tiny rsID, ClinVar, WGS class, and GIAB-style fixtures.
- `npm run cnv:validate` validates the compact CNV/SV/repeat evidence fixture and its non-completeness disclosure.
- `npm run wgs:validate` checks parser/class/reportability behavior against small synthetic WGS truthsets.
- `npm run wgs:query-readiness` fails closed with setup actions when external GIAB query generation is not ready.

## 12. Highest-Value Improvements

Priority improvements for deeper WGS coverage:

1. Add a lean ClinVar/dbSNP-derived rsID annotation extractor on top of the optional reference setup path so unannotated provider VCFs do not stall.
2. Add a machine-readable interpretation-provenance summary to every dashboard payload.
3. Expand WGS CNV/SV/repeat interpretation catalogs from public evidence sources.
4. Add an explicit `coverage_mode` field: `wgs_full`, `wgs_reduced`, `snp_array`, `sample_preview`, or `unknown`.
5. Expand `npm run reference:doctor` to optionally verify local checksum sidecars for downloaded references.
6. Keep GIAB validation as an advanced benchmark with fail-closed preflight, not a normal user dependency.

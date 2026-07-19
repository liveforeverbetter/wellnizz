# Curated interpretation standard

This document defines the minimum bar for consumer-facing genotype
interpretations. The objective is useful depth with traceable evidence, not the
largest possible marker count.

## Required evidence record

Every newly curated marker must include:

- a verified rsID, chromosome, and position on GRCh37;
- forward-strand reference and common alleles;
- genotype keys that use only those common alleles;
- an evidence tier;
- a stable variant-identity source plus at least one primary study, guideline,
  or recognized catalog source;
- the curation date and at least two limitations;
- conservative consumer wording that distinguishes association from diagnosis.

The parser carries this record into matched alerts, risks, and strengths. The
pipeline then writes the deduplicated records to
`metadata.curated_interpretations`, so callers can explain and query the source
of an interpretation without loading the whole interpretation database.

## Phase 2 reviewed set

The 2026-07-19 review added seven wellness markers and corrected four existing
records:

| Marker | Gene | Consumer topic | Review outcome |
| --- | --- | --- | --- |
| rs2282679 | GC | circulating 25-hydroxyvitamin D | added; measured level remains decisive |
| rs5082 | APOA2 | saturated-fat interaction | added at tier 3; observational interaction only |
| rs174537 | FADS1 | PUFA conversion proxy | added; ancestry/diet limitations explicit |
| rs1260326 | GCKR | triglyceride/glucose tradeoff | added; opposing effects preserved |
| rs10830963 | MTNR1B | fasting glucose | added; modest association, not diagnostic |
| rs662799 | APOA5 | triglycerides | added with reverse-strand publication caveat |
| rs1801725 | CASR | serum calcium | added; no intake change from genotype alone |
| rs12934922 | BCO1 | beta-carotene conversion | corrected coordinate, alleles, gene symbol, and safety wording |
| rs601338 | FUT2 | secretor status | corrected coordinate; removed unsupported B12-deficiency and supplement claims |
| rs1801282 | PPARG | Pro12Ala metabolic association | corrected from the wrong PPARD chr6 identity |
| rs1800497 | ANKK1 | Taq1A receptor association | corrected locus/gene; removed deterministic addiction claims and marked research-only |

The focused regression suite verifies all 11 identities, genotype keys,
provenance records, source URL classes, limitations, and consumer-safety
wording. `interpretation:depth` also requires at least 11 provenance-graded
markers before the report can pass.

## Deliberate boundaries

### PRS breadth

The current compact PGS input includes score files that cannot all be used by
the rsID-only scoring engine. Some contain coordinate-based variants, and an
uncalibrated score would otherwise fall back to a misleading average percentile.
Meaningful PRS expansion therefore requires both:

1. position/build-aware matching for score variants that lack rsIDs; and
2. population-specific calibration parameters for every surfaced score.

Do not add a disease label to the PRS registry merely because a PGS file is
available. Until both conditions are met, retain the smaller calibrated set and
disclose coverage.

### Clinical and pharmacogenomic markers

High-stakes variants such as F5 rs6025, F2 rs1799963, OPRM1 rs1799971, and
CYP4F2 rs2108622 are deferred to the clinical/pharmacogenomic phase. They need
guideline-level review, strand/build validation, phenotype logic, and explicit
clinician or pharmacist routing. A single-SNP consumer card is not an adequate
substitute for that work.

## Validation

From `skills/longevity-analysis`:

```bash
npx tsx --test scripts/pipeline/curated_interpretation_content.test.ts
npm run typecheck
npm run interpretation:depth
npm run test:all
```

The full suite writes some shared audit artifacts. If unrelated artifact tests
are run concurrently, rerun those artifact-producing tests serially before
classifying a failure as a product regression.

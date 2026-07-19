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

## Performance and optimization safety pass

The 2026-07-19 performance pass reviewed six consumer-interest markers. These
records are deliberately framed as context for self-observation and measured
performance, not as talent selection, training prescriptions, supplement
recommendations, or substitutes for pulmonary testing.

| Marker | Gene | Consumer topic | Review outcome |
| --- | --- | --- | --- |
| rs762551 | CYP1A2 | caffeine metabolism context | corrected to CYP1A2 inducibility; removed genotype-based dose and timing prescriptions |
| rs5751876 | ADORA2A | caffeine sensitivity context | consolidated duplicate records; retained anxiety/sleep-response context with limitations |
| rs1815739 | ACTN3 | muscle performance association | corrected GRCh37 identity and alleles; removed talent and sport-selection claims |
| rs8192678 | PPARGC1A | aerobic adaptation research | corrected genotype orientation; removed deterministic VO2 and mitochondrial claims |
| rs17602729 | AMPD1 | exercise intolerance context | corrected rsID, coordinate, and alleles; routes persistent symptoms to clinical evaluation |
| rs12722 | COL5A1 | tendon/soft-tissue association | corrected coordinate; removed deterministic tissue-mechanics and collagen-dose claims |

All six records carry stable variant identity, primary or synthesis evidence,
curation date, and explicit limitations. Together with the Phase 2 wellness
set, the report now contains 17 provenance-graded markers. The parser also
retains every matched reviewed record in `metadata.curated_interpretations`,
including low-priority consumer findings, so API query surfaces do not depend
on whether a marker happened to be promoted into an alert, risk, or strength.

Reviewed markers must not inherit generic genotype-driven supplement stacks.
The content regression fixture asserts this behavior for the six performance
markers plus ADORA2A.

## Deliberate boundaries

### PRS breadth

The current compact PGS input includes score files that cannot all be used by
the rsID-only scoring engine. Some contain coordinate-based variants, and an
uncalibrated score would otherwise fall back to a misleading average percentile.
Meaningful PRS expansion therefore requires both:

1. position/build-aware matching for score variants that lack rsIDs; and
2. population-specific calibration parameters for every surfaced absolute or
   percentile interpretation.

Position/build-aware matching may still expose a well-covered raw score when
calibration is unavailable, provided the result is clearly labeled raw-only,
does not infer direction or risk, and reports observed, reference-inferred,
rejected, and missing variant counts.

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

# Genomic Interpretations Database

**This is the authoritative source of truth for all variant interpretations.**

The analysis pipeline MUST read from this file - never hardcode interpretations elsewhere.

## File Structure

This directory contains interpretation data organized by category:

```
shared/
├── interpretations/
│   ├── wellness.json      # Nutrition, methylation, metabolism, inflammation
│   ├── pharmacology.json  # Drug metabolism, pharmacogenetics
│   ├── personality.json   # Cognitive, neurotransmitter, behavioral
│   ├── performance.json   # Athletic, exercise response
│   ├── vulnerability.json # Disease risks, complex traits
│   ├── hereditary.json   # Monogenic conditions, carrier status
│   └── ancestry.json      # Haplogroups, ancestry composition
└── marker-database.md     # Marker metadata (rsID, position, genes)
```

## JSON Schema

Each interpretation file contains:

```json
{
  "version": "1.0.0",
  "updated": "2026-04-23",
  "markers": {
    "rs2282679": {
      "gene": "GC",
      "name": "Vitamin D-binding protein marker",
      "category": "wellness",
      "chrom": "4",
      "pos": 72608383,
      "evidenceTier": 2,
      "provenance": {
        "status": "curated",
        "reviewedAt": "2026-07-19",
        "genomeBuild": "GRCh37",
        "referenceAllele": "T",
        "commonAlleles": ["T", "G"],
        "sources": [
          {
            "id": "ensembl-grch37-rs2282679",
            "label": "Ensembl GRCh37 variant record",
            "url": "https://grch37.ensembl.org/Homo_sapiens/Variation/Explore?v=rs2282679",
            "type": "variant_identity"
          },
          {
            "id": "PMID:20541252",
            "label": "Genome-wide association study of vitamin D insufficiency",
            "url": "https://pubmed.ncbi.nlm.nih.gov/20541252/",
            "type": "primary_study"
          }
        ],
        "limitations": [
          "Population-level association; not a vitamin D deficiency diagnosis.",
          "Measured 25-hydroxyvitamin D is more informative for individual decisions."
        ]
      },
      "interpretations": {
        "TT": {
          "effect": "No lower-vitamin-D allele detected",
          "interpretation": "Reference group for this population-level association.",
          "recommendations": ["Use a measured level when clinically appropriate"],
          "priority": "low"
        },
        "GT": {
          "effect": "One allele associated with lower 25-hydroxyvitamin D",
          "interpretation": "A modest population-level association, not a diagnosis.",
          "recommendations": ["Base decisions on measured status and clinical guidance"],
          "priority": "low"
        },
        "GG": {
          "effect": "Two alleles associated with lower 25-hydroxyvitamin D",
          "interpretation": "A population-level association, not a deficiency diagnosis.",
          "recommendations": ["Base decisions on measured status and clinical guidance"],
          "priority": "medium"
        }
      }
    }
  }
}
```

## Critical Rules

1. **All interpretations MUST be in these JSON files** - no hardcoding
2. **The analysis script reads JSON at runtime** - never duplicates interpretation data
3. **Update these files when adding new markers** - keeps single source of truth
4. **Marker metadata (rsID, position, category) comes from marker-database.md**
5. **New curated entries MUST use GRCh37 forward-strand alleles** and include
   `provenance` with a variant-identity source, an evidence source, and at least
   two explicit limitations.
6. **Recommendations MUST NOT prescribe a dose, diagnose disease, or imply a
   deterministic behavioral outcome.** Prefer measured biomarkers, established
   screening guidance, and clinician review where appropriate.
7. **Evidence tier is not source provenance.** Keep both: the tier grades the
   evidence class, while provenance makes the identity, sources, review date,
   and uncertainty auditable.

See [Curated interpretation standard](../../docs/curated-interpretations.md)
for the review workflow, the currently provenance-graded marker set, and the
known PRS/clinical boundaries.

## Key Markers Reference

### Wellness
- MTHFR: rs1801133, rs1801131
- IL6: rs1800795
- IL10: rs1800896
- FTO: rs9939609
- LCT: rs4988235
- MCM6: rs182549535

### Pharmacology
- CYP1A2: rs762551
- CYP2C19: rs12248560, rs4244285
- CYP2D6: rs3892097

### Performance
- ACTN3: rs1815739
- ACE: rs4340

import assert from "node:assert";
import { describe, it } from "node:test";

import {
  annotationReferenceContig,
  buildContigRenameEntries,
  canonicalHumanContig,
} from "../ingestion/vcf-contigs.js";

describe("VCF annotation contig normalization", () => {
  it("maps provider-style GRCh37 contigs to the numeric ClinVar convention", () => {
    assert.deepEqual(
      buildContigRenameEntries(
        ["chr1", "chrX", "chrM", "GL000191.1"],
        "clinvar-grch37"
      ),
      [
        { from: "chr1", to: "1" },
        { from: "chrX", to: "X" },
        { from: "chrM", to: "MT" },
      ]
    );
  });

  it("maps both numeric and provider-style contigs to GRCh37 dbSNP accessions", () => {
    assert.deepEqual(
      buildContigRenameEntries(["1", "chr2", "MT"], "dbsnp-grch37"),
      [
        { from: "1", to: "NC_000001.10" },
        { from: "chr2", to: "NC_000002.11" },
        { from: "MT", to: "NC_012920.1" },
      ]
    );
  });

  it("recognizes existing NCBI contigs and leaves each target convention stable", () => {
    assert.equal(canonicalHumanContig("NC_000001.10"), "1");
    assert.equal(
      annotationReferenceContig("NC_000001.10", "clinvar-grch37"),
      "1"
    );
    assert.equal(
      annotationReferenceContig("NC_000001.10", "dbsnp-grch37"),
      "NC_000001.10"
    );
  });
});

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it } from "node:test";

import { annotateVcfWithClinVarRsids } from "../ingestion/annotate-vcf.js";
import { runVcfDoctor } from "./vcf_doctor.js";

describe("ClinVar rsID annotation", () => {
  it("normalizes a chr-prefixed GRCh37 VCF before matching the numeric reference", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "fb-vcf-annotation-")
    );
    const input = path.join(directory, "provider.vcf");
    const output = path.join(directory, "provider.annotated.vcf.gz");
    try {
      fs.writeFileSync(
        input,
        [
          "##fileformat=VCFv4.2",
          "##contig=<ID=chr1,length=249250621>",
          '##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">',
          "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
          "chr1\t69134\t.\tA\tG\t.\tPASS\t.\tGT\t0/1",
          "",
        ].join("\n"),
        "utf8"
      );

      annotateVcfWithClinVarRsids(input, output);
      assert.equal(runVcfDoctor(output).rsid_variants, 1);
      const record = execFileSync("bcftools", ["view", "-H", output], {
        encoding: "utf8",
      });
      assert.match(record, /^1\t69134\trs781394307\tA\tG/m);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

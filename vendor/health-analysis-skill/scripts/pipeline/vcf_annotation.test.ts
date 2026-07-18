import assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { annotateVcfWithClinVarRsids } from "../ingestion/annotate-vcf.js";
import { analyzeVCF, parseVCFWithRSIDs } from "../ingestion/parse-vcf.js";
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

  it("accepts a valid unindexed WGS VCF with zero rsIDs", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-vcf-zero-rsid-"));
    const input = path.join(directory, "provider.vcf");
    try {
      fs.writeFileSync(
        input,
        [
          "##fileformat=VCFv4.2",
          "##contig=<ID=1,length=249250621>",
          '##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">',
          "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
          "1\t100\t.\tA\tG\t.\tPASS\t.\tGT\t0/1",
          "1\t200\t.\tC\tT\t.\tPASS\t.\tGT\t1/1",
          "",
        ].join("\n"),
        "utf8"
      );

      const result = parseVCFWithRSIDs(input, ["rs123"]);
      assert.equal(result.totalVariants, 2);
      assert.equal(result.annotatedCount, 0);
      assert.equal(result.variants.length, 0);
      assert.equal(result.extractionMethod, "bcftools");
      assert.equal(result.fallbackReason, undefined);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps zero rsIDs non-fatal when bcftools fails and text fallback is used", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-vcf-fallback-"));
    const input = path.join(directory, "provider.vcf");
    const fakeBcftools = path.join(directory, "bcftools");
    const previousPath = process.env.PATH;
    const previousWarn = console.warn;
    const warnings: string[] = [];
    try {
      fs.writeFileSync(
        input,
        [
          "##fileformat=VCFv4.2",
          "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE",
          "1\t100\t.\tA\tG\t.\tPASS\t.\tGT\t0/1",
          "1\t200\t.\tC\tT\t.\tPASS\t.\tGT\t1/1",
          "",
        ].join("\n"),
        "utf8"
      );
      fs.writeFileSync(fakeBcftools, "#!/bin/sh\necho forced bcftools failure >&2\nexit 23\n", "utf8");
      fs.chmodSync(fakeBcftools, 0o755);
      process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ""}`;
      console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));

      const result = parseVCFWithRSIDs(input, ["rs123"]);
      assert.equal(result.totalVariants, 2);
      assert.equal(result.annotatedCount, 0);
      assert.equal(result.variants.length, 0);
      assert.equal(result.extractionMethod, "text_fallback");
      assert.match(result.fallbackReason ?? "", /forced bcftools failure/);
      assert.ok(warnings.some(line => line.includes("[vcf-rsid-extraction-fallback]")));
    } finally {
      process.env.PATH = previousPath;
      console.warn = previousWarn;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("streams hundreds of thousands of rsIDs and handles multi-ID dbSNP records", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-vcf-streaming-"));
    const input = path.join(directory, "provider.vcf");
    const fakeBcftools = path.join(directory, "bcftools");
    const previousPath = process.env.PATH;
    try {
      fs.writeFileSync(input, "##fileformat=VCFv4.2\n", "utf8");
      fs.writeFileSync(
        fakeBcftools,
        [
          "#!/bin/sh",
          "if [ \"$1\" = query ]; then",
          "  awk 'BEGIN { for (i=1; i<=300000; i++) { id=(i==300000 ? \"rs299999;rs300000\" : \"rs\" i); printf \"1\\t%d\\t%s\\tA\\tG\\t0/1\\n\", i, id } }'",
          "  exit 0",
          "fi",
          "if [ \"$1\" = index ] && [ \"$2\" = -n ]; then echo 300000; exit 0; fi",
          "exit 1",
          "",
        ].join("\n"),
        "utf8"
      );
      fs.chmodSync(fakeBcftools, 0o755);
      process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ""}`;

      const result = parseVCFWithRSIDs(input, ["rs300000"]);
      assert.equal(result.totalVariants, 300000);
      assert.equal(result.annotatedCount, 300000);
      assert.equal(result.variants.length, 1);
      assert.equal(result.variants[0]?.id, "rs300000");
      assert.equal(result.extractionMethod, "bcftools");
    } finally {
      process.env.PATH = previousPath;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("annotates and interprets a raw zero-ID VCF through the full dbSNP path", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-vcf-full-dbsnp-"));
    const input = path.join(directory, "provider.vcf");
    const referenceVcf = path.join(directory, "dbsnp.vcf");
    const referenceGz = `${referenceVcf}.gz`;
    try {
      const samplePath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../examples/sample-rsid-wgs.vcf"
      );
      const sampleLines = fs.readFileSync(samplePath, "utf8").trimEnd().split("\n");
      const headers = sampleLines.filter(line => line.startsWith("#"));
      const records = sampleLines.filter(line => !line.startsWith("#")).slice(0, 4);
      const rawRecords = records.map(line => {
        const fields = line.split("\t");
        fields[2] = ".";
        return fields.join("\t");
      });
      fs.writeFileSync(input, [...headers, ...rawRecords, ""].join("\n"), "utf8");
      fs.writeFileSync(referenceVcf, [...headers, ...records, ""].join("\n"), "utf8");
      execFileSync("bgzip", ["-f", referenceVcf]);
      execFileSync("bcftools", ["index", "-f", referenceGz]);

      const result = await analyzeVCF(input, {
        save: false,
        dbsnpPath: referenceGz,
      });

      assert.equal(result.rsidAnnotationSource, "dbSNP GRCh37");
      assert.equal(result.rsidExtractionMethod, "bcftools");
      assert.equal(result.totalVariants, 4);
      assert.equal(result.annotatedCount, 4);
      assert.equal(result.allRSIDs?.length, 4);
      assert.ok(result.variants.length > 0, "at least one recovered rsID should be interpreted");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

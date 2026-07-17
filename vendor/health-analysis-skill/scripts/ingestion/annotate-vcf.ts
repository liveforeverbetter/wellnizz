#!/usr/bin/env npx tsx

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync, execSync } from "child_process";
import { fileURLToPath } from "url";
import {
  getClinVarDisclosure,
  requireClinVarAnnotationReference,
} from "../pipeline/clinvar_reference.js";
import { runVcfDoctor } from "../pipeline/vcf_doctor.js";
import { writeVcfContigRenameMap } from "./vcf-contigs.js";

function usage(): never {
  console.error(
    "Usage: npm run annotate:vcf -- <input.vcf[.gz]> <output.annotated.vcf.gz> [--reference=/path/clinvar_rsid_annotation.tsv.gz]"
  );
  process.exit(1);
}

function requireTool(tool: string): void {
  try {
    execFileSync("which", [tool], { stdio: "ignore" });
  } catch {
    throw new Error(
      `${tool} is required. Install htslib/bcftools before running annotate:vcf.`
    );
  }
}

function parseArgs(argv: string[]): {
  input: string;
  output: string;
  reference?: string;
} {
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const referenceArg = argv.find((arg) => arg.startsWith("--reference="));
  if (positional.length < 2) usage();
  return {
    input: positional[0],
    output: positional[1],
    reference: referenceArg?.split("=").slice(1).join("="),
  };
}

function isIndexed(vcfPath: string): boolean {
  return fs.existsSync(`${vcfPath}.tbi`) || fs.existsSync(`${vcfPath}.csi`);
}

function prepareInput(input: string): { path: string; cleanup: string[] } {
  if (input.endsWith(".gz") && isIndexed(input))
    return { path: input, cleanup: [] };

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "clinvar-rsid-annotate-")
  );
  const compressed = path.join(
    tempDir,
    `${path.basename(input).replace(/\.gz$/, "")}.gz`
  );
  const cleanup = [tempDir];

  execSync(`zcat -f "${input}" | bgzip > "${compressed}"`, {
    stdio: "inherit",
    shell: "/bin/bash",
  });

  try {
    execFileSync("bcftools", ["index", "-f", compressed], { stdio: "inherit" });
  } catch {
    execFileSync("tabix", ["-f", "-p", "vcf", compressed], {
      stdio: "inherit",
    });
  }

  return { path: compressed, cleanup };
}

export function annotateVcfWithClinVarRsids(
  input: string,
  output: string,
  reference?: string
): void {
  for (const tool of ["bcftools", "bgzip", "tabix"]) requireTool(tool);
  if (!fs.existsSync(input)) throw new Error(`Input VCF not found: ${input}`);
  if (!output.endsWith(".vcf.gz"))
    throw new Error("Output path must end with .vcf.gz");

  const referencePath = reference ?? requireClinVarAnnotationReference();
  if (!fs.existsSync(referencePath))
    throw new Error(`Reference not found: ${referencePath}`);
  if (!fs.existsSync(`${referencePath}.tbi`))
    throw new Error(`Reference tabix index not found: ${referencePath}.tbi`);

  const disclosure = getClinVarDisclosure();
  console.log("ClinVar rsID annotation");
  console.log(`  Reference: ${referencePath}`);
  console.log(`  Scope: ${disclosure.limitation}`);

  const prepared = prepareInput(input);
  const normalizationDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "clinvar-rsid-normalize-")
  );
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  try {
    const contigMapPath = path.join(
      normalizationDir,
      "clinvar-grch37-contigs.tsv"
    );
    const normalizedPath = path.join(
      normalizationDir,
      "clinvar-grch37-normalized.vcf.gz"
    );
    const renameEntries = writeVcfContigRenameMap(
      prepared.path,
      "clinvar-grch37",
      contigMapPath
    );
    const annotationInput = renameEntries.length
      ? normalizedPath
      : prepared.path;
    if (renameEntries.length) {
      console.log(
        `  Normalizing ${renameEntries.length} contig name${
          renameEntries.length === 1 ? "" : "s"
        } for the ClinVar GRCh37 reference...`
      );
      execFileSync(
        "bcftools",
        [
          "annotate",
          "--rename-chrs",
          contigMapPath,
          "-Oz",
          "-o",
          normalizedPath,
          prepared.path,
        ],
        { stdio: "inherit" }
      );
      execFileSync("bcftools", ["index", "-f", normalizedPath], {
        stdio: "inherit",
      });
    }
    execFileSync(
      "bcftools",
      [
        "annotate",
        "-a",
        referencePath,
        "-c",
        "CHROM,POS,REF,ALT,ID",
        "-Oz",
        "-o",
        output,
        annotationInput,
      ],
      { stdio: "inherit" }
    );
    execFileSync("bcftools", ["index", "-f", output], { stdio: "inherit" });
  } finally {
    try {
      fs.rmSync(normalizationDir, { recursive: true, force: true });
    } catch {}
    for (const item of prepared.cleanup) {
      try {
        fs.rmSync(item, { recursive: true, force: true });
      } catch {}
    }
  }

  const report = runVcfDoctor(output);
  if (report.rsid_variants === 0) {
    throw new Error(
      "ClinVar rsID annotation added zero identifiers after contig normalization. Confirm the genome build and reference provenance before retrying."
    );
  }
  console.log(
    JSON.stringify(
      {
        status: report.status,
        output,
        total_variants: report.total_variants,
        rsid_variants: report.rsid_variants,
        rsid_density: report.rsid_density,
        warnings: report.warnings,
        disclosure,
      },
      null,
      2
    )
  );
}

function main(): void {
  const { input, output, reference } = parseArgs(process.argv.slice(2));
  annotateVcfWithClinVarRsids(input, output, reference);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}

/**
 * Contig normalization for position-based rsID annotation.
 *
 * Provider VCFs commonly use `chr1`, while the bundled GRCh37 ClinVar table
 * uses `1` and the GRCh37 dbSNP VCF uses NCBI `NC_` accessions. Keep this
 * conversion separate from downstream chromosome comparison, which always
 * normalizes variants back to simple human labels.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

export type AnnotationReferenceContigs = "clinvar-grch37" | "dbsnp-grch37";

const NCBI_GRCH37_CONTIGS: Record<string, string> = {
  "1": "NC_000001.10",
  "2": "NC_000002.11",
  "3": "NC_000003.11",
  "4": "NC_000004.11",
  "5": "NC_000005.9",
  "6": "NC_000006.11",
  "7": "NC_000007.13",
  "8": "NC_000008.10",
  "9": "NC_000009.11",
  "10": "NC_000010.10",
  "11": "NC_000011.9",
  "12": "NC_000012.11",
  "13": "NC_000013.10",
  "14": "NC_000014.8",
  "15": "NC_000015.9",
  "16": "NC_000016.9",
  "17": "NC_000017.10",
  "18": "NC_000018.9",
  "19": "NC_000019.9",
  "20": "NC_000020.10",
  "21": "NC_000021.8",
  "22": "NC_000022.10",
  X: "NC_000023.10",
  Y: "NC_000024.9",
  MT: "NC_012920.1",
};

const NCBI_TO_CANONICAL = new Map(
  Object.entries(NCBI_GRCH37_CONTIGS).map(([canonical, ncbi]) => [
    ncbi.replace(/\.\d+$/, "").toUpperCase(),
    canonical,
  ])
);

/** Returns 1-22, X, Y, or MT for standard human contigs, otherwise undefined. */
export function canonicalHumanContig(contig: string): string | undefined {
  const trimmed = contig.trim();
  if (!trimmed) return undefined;

  const ncbi = trimmed.toUpperCase().replace(/\.\d+$/, "");
  const fromNcbi = NCBI_TO_CANONICAL.get(ncbi);
  if (fromNcbi) return fromNcbi;

  const plain = trimmed.replace(/^chr/i, "").toUpperCase();
  if (/^(?:[1-9]|1\d|2[0-2])$/.test(plain)) return String(Number(plain));
  if (plain === "X" || plain === "Y") return plain;
  if (plain === "M" || plain === "MT") return "MT";
  return undefined;
}

export function annotationReferenceContig(
  sourceContig: string,
  reference: AnnotationReferenceContigs
): string | undefined {
  const canonical = canonicalHumanContig(sourceContig);
  if (!canonical) return undefined;
  return reference === "clinvar-grch37"
    ? canonical
    : NCBI_GRCH37_CONTIGS[canonical];
}

export function buildContigRenameEntries(
  sourceContigs: string[],
  reference: AnnotationReferenceContigs
): Array<{ from: string; to: string }> {
  return sourceContigs
    .map((from) => ({ from, to: annotationReferenceContig(from, reference) }))
    .filter(
      (entry): entry is { from: string; to: string } =>
        Boolean(entry.to) && entry.from !== entry.to
    );
}

function vcfHeaderContigs(vcfPath: string): string[] {
  const header = execFileSync("bcftools", ["view", "-h", vcfPath], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return header
    .split("\n")
    .map((line) => line.match(/^##contig=<ID=([^,>]+)/)?.[1])
    .filter((contig): contig is string => Boolean(contig));
}

/**
 * Writes a `bcftools annotate --rename-chrs` map for the actual contigs found
 * in a VCF. Returns the entries so callers can avoid creating an unnecessary
 * intermediate VCF when names already match the annotation reference.
 */
export function writeVcfContigRenameMap(
  vcfPath: string,
  reference: AnnotationReferenceContigs,
  mapPath: string
): Array<{ from: string; to: string }> {
  const entries = buildContigRenameEntries(
    vcfHeaderContigs(vcfPath),
    reference
  );
  if (entries.length) {
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(
      mapPath,
      `${entries.map((entry) => `${entry.from}\t${entry.to}`).join("\n")}\n`,
      "utf8"
    );
  }
  return entries;
}

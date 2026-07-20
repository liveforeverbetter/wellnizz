export interface GeneIndexEntry {
  gene: string;
  rsids: string[];
  finding_category: 'curated_interpretation' | 'variant_card' | 'consumer_insight';
  summary: string;
  significance?: string;
}

export interface RsidIndexEntry {
  rsid: string;
  genes: string[];
  finding_category: 'curated_interpretation' | 'variant_card' | 'consumer_insight';
  summary: string;
  significance?: string;
}

export interface GeneticSliceIndex {
  schema_version: '1.0';
  generated_at: string;
  gene_index: Record<string, GeneIndexEntry[]>;
  rsid_index: Record<string, RsidIndexEntry[]>;
}

export interface GeneticSliceQuery {
  gene?: string;
  rsid?: string;
  significance?: string;
  category?: string;
}

export interface GeneticSliceResult {
  query: GeneticSliceQuery;
  matched_genes: GeneIndexEntry[];
  matched_rsids: RsidIndexEntry[];
  consumer_insights: Array<{
    id: string;
    trait_id: string;
    display_name: string;
    category: string;
    calculation_state: string;
    result_summary: string;
    consumer_value: string;
    genes?: string[];
    rsids?: string[];
    next_measurement?: string;
  }>;
  note?: string;
}

/**
 * Build a compact gene/rsID slice index from the full dashboard before
 * compaction bounds the inline payload. The index preserves the mapping
 * from every gene and rsID to its finding summaries without carrying the
 * heavy variant-card payloads that fill the inline result.
 */
export function buildGeneticSliceIndex(dashboard: unknown, now = new Date()): GeneticSliceIndex | undefined {
  const metadata = objectRecord(dashboard) != null ? objectRecord(objectRecord(dashboard)?.metadata) : undefined;
  if (!metadata) return undefined;

  const geneIndex: Record<string, GeneIndexEntry[]> = {};
  const rsidIndex: Record<string, RsidIndexEntry[]> = {};

  const curated = arrayRecords(metadata.curated_interpretations);
  for (const entry of curated) {
    const genes = extractUnique(entry, 'gene');
    const rsids = extractUnique(entry, 'rsid');
    const summary = stringValue(entry.interpretation) ?? stringValue(entry.annotation) ?? stringValue(entry.summary) ?? '';
    const significance = stringValue(entry.significance);
    for (const gene of genes) {
      addGeneEntry(geneIndex, gene, { gene, rsids, finding_category: 'curated_interpretation', summary, significance });
    }
    for (const rsid of rsids) {
      addRsidEntry(rsidIndex, rsid, { rsid, genes, finding_category: 'curated_interpretation', summary, significance });
    }
  }

  const variantCards = objectRecord(metadata.variant_cards);
  if (variantCards) {
    for (const [category, cards] of Object.entries(variantCards)) {
      if (!Array.isArray(cards)) continue;
      for (const card of cards) {
        if (!objectRecord(card)) continue;
        const genes = extractUnique(card, 'gene');
        const rsids = extractUnique(card, 'rsid');
        const summary = stringValue(card.interpretation) ?? stringValue(card.annotation) ?? stringValue(card.summary) ?? '';
        const significance = stringValue(card.significance) ?? stringValue(card.clinical_significance);
        for (const gene of genes) {
          addGeneEntry(geneIndex, gene, { gene, rsids, finding_category: 'variant_card', summary, significance });
        }
        for (const rsid of rsids) {
          addRsidEntry(rsidIndex, rsid, { rsid, genes, finding_category: 'variant_card', summary, significance });
        }
      }
    }
  }

  const consumerSection = objectRecord(metadata.consumer_genetics);
  if (consumerSection) {
    const insights = arrayRecords(consumerSection.insights);
    for (const insight of insights) {
      const genes = arrayValues(insight.genes).map(String);
      const rsids = arrayValues(insight.rsids).map(String);
      const summary = stringValue(insight.result_summary) ?? '';
      for (const gene of genes) {
        addGeneEntry(geneIndex, gene, { gene, rsids, finding_category: 'consumer_insight', summary });
      }
      for (const rsid of rsids) {
        addRsidEntry(rsidIndex, rsid, { rsid, genes, finding_category: 'consumer_insight', summary });
      }
    }
  }

  if (Object.keys(geneIndex).length === 0 && Object.keys(rsidIndex).length === 0) return undefined;

  return {
    schema_version: '1.0',
    generated_at: now.toISOString(),
    gene_index: geneIndex,
    rsid_index: rsidIndex,
  };
}

/**
 * Query the slice index for matching entries by gene, rsID, or significance level.
 * Works against the bounded inline index. Returns matching gene entries, rsID
 * entries, and consumer insights. When the index is not available (analysis
 * predates this feature), returns a note suggesting reanalysis.
 */
export function queryGeneticSlice(
  index: GeneticSliceIndex | undefined,
  consumerInsights: Array<Record<string, unknown>> | undefined,
  query: GeneticSliceQuery,
): GeneticSliceResult {
  const geneResults: GeneIndexEntry[] = [];
  const rsidResults: RsidIndexEntry[] = [];

  if (index) {
    const queryGene = query.gene?.trim().toUpperCase();
    const queryRsid = query.rsid?.trim().toLowerCase();
    const querySig = query.significance?.trim().toLowerCase();

    if (queryGene) {
      const matchingGene = index.gene_index[queryGene];
      if (matchingGene) {
        for (const entry of matchingGene) {
          if (!sigFilter(entry.significance, querySig)) continue;
          geneResults.push(entry);
        }
      }
    }

    if (queryRsid) {
      const matchingRsid = index.rsid_index[queryRsid];
      if (matchingRsid) {
        for (const entry of matchingRsid) {
          if (!sigFilter(entry.significance, querySig)) continue;
          rsidResults.push(entry);
        }
      }
    }

    if (!queryGene && !queryRsid && querySig) {
      for (const [gene, entries] of Object.entries(index.gene_index)) {
        for (const entry of entries) {
          if (sigFilter(entry.significance, querySig)) {
            geneResults.push(entry);
          }
        }
      }
      for (const [rsid, entries] of Object.entries(index.rsid_index)) {
        for (const entry of entries) {
          if (sigFilter(entry.significance, querySig)) {
            rsidResults.push(entry);
          }
        }
      }
    }
  }

  const matchedInsightGenes = new Set(geneResults.map(e => e.gene));
  const matchedInsightRsids = new Set(rsidResults.map(e => e.rsid));
  const insights = (consumerInsights ?? []).filter(insight => {
    const genes = arrayValues(insight.genes).map(String);
    const rsids = arrayValues(insight.rsids).map(String);
    return genes.some(g => matchedInsightGenes.has(g.toUpperCase()))
      || rsids.some(r => matchedInsightRsids.has(r.toLowerCase()));
  }).map(insight => ({
    id: stringValue(insight.id) ?? stringValue(insight.trait_id) ?? '',
    trait_id: stringValue(insight.trait_id) ?? '',
    display_name: stringValue(insight.display_name) ?? '',
    category: stringValue(insight.category) ?? '',
    calculation_state: stringValue(insight.calculation_state) ?? '',
    result_summary: stringValue(insight.result_summary) ?? '',
    consumer_value: stringValue(insight.consumer_value) ?? '',
    genes: arrayValues(insight.genes).map(String),
    rsids: arrayValues(insight.rsids).map(String),
    next_measurement: stringValue(insight.next_measurement),
  }));

  const result: GeneticSliceResult = {
    query,
    matched_genes: geneResults,
    matched_rsids: rsidResults,
    consumer_insights: insights,
  };

  if (!index) {
    result.note = 'No genetic slice index is available for this analysis. It was created before this feature shipped. Reanalyze the source to produce an indexed result, or download the full analysis artifact for a complete search.';
  } else if (Object.keys(index.gene_index).length === 0 && Object.keys(index.rsid_index).length === 0) {
    result.note = 'This analysis produced no gene-level or rsID-level findings.';
  }

  return result;
}

function sigFilter(significance: string | undefined, querySig: string | undefined): boolean {
  if (!querySig) return true;
  if (!significance) return false;
  return significance.toLowerCase().includes(querySig);
}

function addGeneEntry(index: Record<string, GeneIndexEntry[]>, gene: string, entry: GeneIndexEntry): void {
  const key = gene.toUpperCase();
  index[key] = (index[key] ?? []).concat([entry]);
}

function addRsidEntry(index: Record<string, RsidIndexEntry[]>, rsid: string, entry: RsidIndexEntry): void {
  const key = rsid.toLowerCase();
  index[key] = (index[key] ?? []).concat([entry]);
}

function extractUnique(record: Record<string, unknown> | undefined, field: string): string[] {
  if (!record) return [];
  const value = record[field];
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim());
  return [];
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(item => objectRecord(item)) as Array<Record<string, unknown>> : [];
}

function arrayValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

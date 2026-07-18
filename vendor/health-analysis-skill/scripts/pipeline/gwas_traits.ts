/**
 * GWAS → trait folding
 *
 * Turns GWAS Catalog domain summaries into trait scores so population-level
 * associations reach the insight, priority, protocol, and GLI engines. Before
 * this, the GWAS layer was matched but consumed by nothing: it existed only as
 * a truncated, display-only side panel.
 *
 * Safety design:
 *  - Distinct `_polygenic` trait_ids, so GWAS signal is ADDITIVE and can never
 *    merge-override a curated or ClinVar trait on a shared id (mergeTraitScores
 *    keeps the lower score regardless of tier).
 *  - Evidence tier 3 (weakest): curated (tier 1) and ClinVar (tier 1/2) always
 *    outrank GWAS in priority ordering.
 *  - Scores stay in a soft mid-band (34-74), so a population-level association
 *    never presents as strongly as a pathogenic finding (~25).
 *  - One aggregated signal per domain (bounded to <=10 traits), not one per hit,
 *    so the trait/insight/priority system is enriched, not flooded.
 */

/** Inline GWAS hit cards surfaced per domain in the embedded analysis. Raised
 *  from 20 to widen browsable breadth; the persisted payload stays bounded by
 *  the API's persistence_compaction (Phase 1c tightens the full tiering). */
export const GWAS_INLINE_HITS_PER_DOMAIN = 40;

/** Bounded map from GWAS engine domain ids to additive polygenic trait ids. */
export const GWAS_DOMAIN_POLYGENIC_TRAIT: Record<string, string> = {
  cardiovascular: "cardiovascular_polygenic",
  metabolic: "metabolic_polygenic",
  longevity: "longevity_polygenic",
  brain_cognitive: "cognitive_polygenic",
  athletic_performance: "performance_polygenic",
  sleep: "sleep_polygenic",
  immune: "immune_polygenic",
  nutrition: "nutrition_polygenic",
  cancer_risk: "cancer_polygenic",
  other: "other_traits_polygenic",
};

export interface GWASTraitScore {
  trait_id: string;
  score: number;
  confidence: number;
  evidenceTier: 1 | 2 | 3;
}

interface GWASDomainLike {
  domain: string;
  netSignal: string;
  hitCount?: number;
  hits?: unknown[];
}

/** Net-signal band -> soft score (lower = more concerning), never below 34. */
export function netSignalToPolygenicScore(net: string): number {
  switch (net) {
    case "favorable": return 74;
    case "slightly_favorable": return 64;
    case "typical": return 55;
    case "slightly_elevated": return 44;
    case "elevated": return 34;
    default: return 55;
  }
}

export function mapGWASToTraits(
  gwasResult: { domains?: GWASDomainLike[] } | null | undefined
): GWASTraitScore[] {
  if (!gwasResult || !Array.isArray(gwasResult.domains) || gwasResult.domains.length === 0) {
    return [];
  }
  const traits: GWASTraitScore[] = [];
  for (const d of gwasResult.domains) {
    const hitCount = d.hitCount ?? (Array.isArray(d.hits) ? d.hits.length : 0);
    if (hitCount <= 0) continue;
    const traitId = GWAS_DOMAIN_POLYGENIC_TRAIT[d.domain] ?? `${d.domain}_polygenic`;
    // Confidence grows slowly with the number of concordant associations, but
    // stays low: GWAS is population-level, ancestry-dependent, and each hit is
    // individually small-effect.
    const confidence = Math.min(0.6, 0.35 + Math.log10(1 + hitCount) * 0.1);
    traits.push({
      trait_id: traitId,
      score: netSignalToPolygenicScore(d.netSignal),
      confidence,
      evidenceTier: 3,
    });
  }
  return traits;
}

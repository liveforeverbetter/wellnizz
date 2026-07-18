/**
 * GWAS → trait folding unit tests
 *
 * Run: npx tsx --test scripts/pipeline/gwas_traits.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  mapGWASToTraits,
  netSignalToPolygenicScore,
  GWAS_INLINE_HITS_PER_DOMAIN,
} from "./gwas_traits.js";

describe("mapGWASToTraits", () => {
  it("returns [] for empty or missing input", () => {
    assert.deepEqual(mapGWASToTraits(null), []);
    assert.deepEqual(mapGWASToTraits(undefined), []);
    assert.deepEqual(mapGWASToTraits({}), []);
    assert.deepEqual(mapGWASToTraits({ domains: [] }), []);
  });

  it("emits one additive, tier-3 polygenic trait per domain with hits", () => {
    const traits = mapGWASToTraits({
      domains: [
        { domain: "cardiovascular", netSignal: "elevated", hitCount: 120 },
        { domain: "longevity", netSignal: "favorable", hitCount: 8 },
      ],
    });
    assert.equal(traits.length, 2);
    for (const t of traits) {
      assert.equal(t.evidenceTier, 3, "GWAS traits must be the weakest tier");
      assert.ok(t.trait_id.endsWith("_polygenic"), "must use additive _polygenic ids");
      assert.ok(t.confidence <= 0.6, "population-level confidence stays capped");
    }
    const ids = traits.map((t) => t.trait_id);
    assert.deepEqual(ids, ["cardiovascular_polygenic", "longevity_polygenic"]);
  });

  it("skips domains with no hits", () => {
    const traits = mapGWASToTraits({
      domains: [
        { domain: "sleep", netSignal: "typical", hitCount: 0 },
        { domain: "immune", netSignal: "typical", hits: [] },
      ],
    });
    assert.deepEqual(traits, []);
  });

  it("keeps every score in the soft mid-band (never as concerning as pathogenic ~25)", () => {
    for (const net of ["favorable", "slightly_favorable", "typical", "slightly_elevated", "elevated", "unknown"]) {
      const score = netSignalToPolygenicScore(net);
      assert.ok(score >= 34 && score <= 74, `${net} -> ${score} out of band`);
    }
    // A more concerning net signal must map to a lower (more concerning) score.
    assert.ok(netSignalToPolygenicScore("elevated") < netSignalToPolygenicScore("favorable"));
  });

  it("maps an unknown domain to a namespaced _polygenic id (never collides with curated ids)", () => {
    const traits = mapGWASToTraits({ domains: [{ domain: "novel_domain", netSignal: "typical", hitCount: 3 }] });
    assert.equal(traits[0].trait_id, "novel_domain_polygenic");
  });

  it("keeps the inline hit cap bounded", () => {
    assert.ok(GWAS_INLINE_HITS_PER_DOMAIN > 0 && GWAS_INLINE_HITS_PER_DOMAIN <= 100);
  });
});

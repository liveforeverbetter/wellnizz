#!/usr/bin/env node
// Build the sourced knowledge base for action plans.
//
// Pulls real supplement–drug interactions from SUPP.AI (Allen Institute for AI,
// https://supp.ai) and the current study-count + URL for each mapped outcome page
// on Pillser (https://pillser.com). Writes committed TypeScript data modules that
// the action-plan engine loads at runtime - no network calls happen per request.
//
// Refresh with: npm run kb:build
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = resolve(ROOT, 'src/data');
const SUPP_AI = 'https://supp.ai/api';
const UA = 'foreverbetter-api KB builder (contact: dev@foreverbetter.xyz)';

// Catalog supplement id -> the ingredient name to resolve on SUPP.AI. Kept in
// sync with the SUPPLEMENTS catalog in src/core/action-plan.ts.
const SUPPLEMENT_QUERIES = {
  omega_3: 'fish oil',
  soluble_fiber: 'psyllium',
  plant_sterols: 'beta-sitosterol',
  berberine: 'berberine',
  bergamot: 'bergamot',
  methylfolate: 'folic acid',
  vitamin_b12: 'vitamin b12',
  vitamin_b6: 'vitamin b6',
  vitamin_d3: 'vitamin d',
  vitamin_k2: 'vitamin k',
  magnesium_glycinate: 'magnesium',
  iron_bisglycinate: 'ferrous sulfate',
  vitamin_c: 'ascorbic acid',
  tart_cherry: 'cherry',
  curcumin: 'curcumin',
  inositol: 'inositol',
  ashwagandha: 'ashwagandha',
  glycine: 'glycine',
  l_theanine: 'theanine',
  coq10: 'ubiquinone',
  creatine: 'creatine',
};

const MIN_EVIDENCE = 3;   // ignore single-mention interactions as noise
const MAX_PER_SUPP = 25;  // keep the strongest interactions per supplement
const MAX_ALIASES = 12;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// Pick the canonical ingredient among search hits: the supplement-type agent with
// the most interactions (branded/compound products carry few or none). Falls back
// to a name match. Returns the winner plus its already-fetched first page.
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function resolveSupplement(query) {
  const data = await getJson(`${SUPP_AI}/agent/search?q=${encodeURIComponent(query)}`);
  const results = data.results ?? data.agents ?? [];
  const nq = norm(query);
  // Only consider agents whose name actually contains the query term, so a fuzzy
  // hit (theanine -> "Threonine", ascorbic acid -> "Hydroxyproline") can't win on
  // interaction count. Then prefer an exact name match, else most interactions.
  const eligible = results
    .filter(a => a.ent_type === 'supplement' && norm(a.preferred_name ?? a.name).includes(nq))
    .slice(0, 6);
  if (eligible.length === 0) return undefined;
  let best;
  for (const cand of eligible) {
    try {
      const page1 = await getJson(`${SUPP_AI}/agent/${cand.cui}/interactions?p=1`);
      const total = page1.total ?? (page1.interactions?.length ?? 0);
      const exact = norm(cand.preferred_name ?? cand.name) === nq;
      const score = (exact ? 1_000_000 : 0) + total;
      if (!best || score > best.score) best = { cui: cand.cui, name: cand.preferred_name ?? cand.name, total, score, page1 };
      await sleep(120);
    } catch { /* skip unreachable candidate */ }
  }
  return best;
}

async function drugInteractions(cui, page1) {
  const out = [];
  const collect = (items) => {
    for (const it of items) {
      const agent = it.agent ?? {};
      if (agent.ent_type !== 'drug') continue;
      const evidenceCount = it.evidence_count ?? (Array.isArray(it.evidence) ? it.evidence.length : 0);
      if (evidenceCount < MIN_EVIDENCE) continue;
      const aliases = dedupe([
        agent.preferred_name,
        ...(agent.synonyms ?? []),
        ...(agent.tradenames ?? []),
      ].filter(Boolean).map(s => String(s).toLowerCase().trim())).slice(0, MAX_ALIASES);
      out.push({
        cui: agent.cui,
        name: agent.preferred_name,
        aliases,
        evidence_count: evidenceCount,
        url: it.slug ? `https://supp.ai/i/${it.slug}` : `https://supp.ai/a/${cui}`,
      });
    }
  };
  const firstItems = page1?.interactions ?? [];
  collect(firstItems);
  const perPage = page1?.interactions_per_page ?? firstItems.length;
  const total = page1?.total ?? firstItems.length;
  const lastPage = Math.min(20, Math.ceil(total / (perPage || 50)));
  for (let page = 2; page <= lastPage; page += 1) {
    const data = await getJson(`${SUPP_AI}/agent/${cui}/interactions?p=${page}`);
    const items = data.interactions ?? [];
    collect(items);
    await sleep(150);
    if (items.length === 0) break;
  }
  return out.sort((a, b) => b.evidence_count - a.evidence_count).slice(0, MAX_PER_SUPP);
}

function dedupe(arr) {
  return [...new Set(arr)];
}

async function buildSuppAi() {
  const supplements = {};
  for (const [id, query] of Object.entries(SUPPLEMENT_QUERIES)) {
    try {
      const resolved = await resolveSupplement(query);
      if (!resolved) { console.warn(`  ! no supp.ai match for ${id} (${query})`); continue; }
      await sleep(150);
      const interactions = await drugInteractions(resolved.cui, resolved.page1);
      supplements[id] = { cui: resolved.cui, matched_name: resolved.name, drug_interactions: interactions };
      console.log(`  ${id}: ${resolved.name} (${resolved.cui}) -> ${interactions.length} drug interactions (of ${resolved.total} total)`);
      await sleep(200);
    } catch (err) {
      console.warn(`  ! ${id}: ${err.message}`);
    }
  }
  return supplements;
}

// Pillser outcome pages we cite as an evidence base. Slugs verified against the
// live site; study_count is filled from the page at build time.
const PILLSER_OUTCOMES = {
  'increased-hdl-cholesterol-levels': 'Increased HDL cholesterol levels',
  'reduced-ldl-cholesterol-levels': 'Reduced LDL cholesterol levels',
  'reduced-triglycerides': 'Reduced triglycerides',
  'improved-insulin-sensitivity': 'Improved insulin sensitivity',
  'reduced-blood-glucose-levels': 'Reduced blood glucose levels',
  'reduced-inflammation': 'Reduced inflammation',
  'reduced-blood-pressure': 'Reduced blood pressure',
  'reduced-body-weight': 'Reduced body weight',
  'improved-sleep-quality': 'Improved sleep quality',
  'reduced-uric-acid-levels': 'Reduced uric acid levels',
  'increased-testosterone-levels': 'Increased testosterone levels',
  'reduced-homocysteine-levels': 'Reduced homocysteine levels',
};

async function fetchStudyCount(slug) {
  const res = await fetch(`https://pillser.com/health-outcomes/${slug}`, { headers: { 'user-agent': UA } });
  if (!res.ok) return { ok: false, count: null };
  const html = await res.text();
  const matches = [...html.matchAll(/([0-9][0-9,]{0,6})\s+stud(?:y|ies)/gi)]
    .map(m => Number(m[1].replace(/,/g, '')))
    .filter(n => Number.isFinite(n));
  const count = matches.length ? Math.max(...matches) : null;
  return { ok: true, count };
}

async function buildPillser() {
  const outcomes = {};
  for (const [slug, title] of Object.entries(PILLSER_OUTCOMES)) {
    try {
      const { ok, count } = await fetchStudyCount(slug);
      if (!ok) { console.warn(`  ! pillser ${slug} not reachable`); continue; }
      outcomes[slug] = { title, url: `https://pillser.com/health-outcomes/${slug}`, study_count: count };
      console.log(`  ${slug}: ${count ?? '?'} studies`);
      await sleep(200);
    } catch (err) {
      console.warn(`  ! pillser ${slug}: ${err.message}`);
    }
  }
  return outcomes;
}

function tsModule(banner, exportName, value) {
  return `${banner}\n\nexport default ${JSON.stringify(value, null, 2)};\n`;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  console.log('Pulling supplement–drug interactions from supp.ai...');
  const supplements = await buildSuppAi();
  const interactionsDoc = {
    source: 'SUPP.AI (Allen Institute for AI)',
    source_url: 'https://supp.ai',
    license: 'Evidence extracted from the scientific literature; see supp.ai for citations.',
    generated_at: generatedAt,
    supplements,
  };
  await writeFile(
    resolve(DATA_DIR, 'supplement-interactions.ts'),
    tsModule('// GENERATED by scripts/build-kb.mjs from supp.ai - do not edit by hand. Refresh: npm run kb:build', 'default', interactionsDoc),
  );

  console.log('Recording Pillser outcome citations...');
  const outcomes = await buildPillser();
  const outcomesDoc = {
    source: 'Pillser',
    source_url: 'https://pillser.com/health-outcomes',
    generated_at: generatedAt,
    outcomes,
  };
  await writeFile(
    resolve(DATA_DIR, 'outcome-sources.ts'),
    tsModule('// GENERATED by scripts/build-kb.mjs from pillser.com - do not edit by hand. Refresh: npm run kb:build', 'default', outcomesDoc),
  );

  const interactionCount = Object.values(supplements).reduce((n, s) => n + s.drug_interactions.length, 0);
  console.log(`\nDone. ${Object.keys(supplements).length} supplements, ${interactionCount} drug interactions; ${Object.keys(outcomes).length} outcome citations.`);
}

main().catch(err => { console.error(err); process.exit(1); });

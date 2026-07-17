/**
 * Performance dashboard (WHOOP-style voice) — thorough, all modalities.
 *
 * An original, production-grade athletic/recovery dashboard rendered from the
 * full transformed pipeline data: recovery/strain/HRV gauges, wearable domains,
 * a biomarker panel with a biological-age read, genetic "edges" (strengths),
 * polygenic risk bars, aging-hallmark load, pharmacogenomic/hereditary context,
 * and the full action plan (focus / maintain / retest). Bold, high-contrast,
 * uppercase-labelled, with animated arcs and bars. Design language is our own,
 * inspired by the performance-tracking genre, no proprietary assets.
 *
 * Consumes the transformed dashboard object (buildDashboardJSON output). Every
 * section degrades gracefully when a modality is not connected.
 */
import { resolveTheme, themeCss, type DesignTokens } from './theme.js';

type Any = any;
// Safe display of a value that may be a string, number, or an object like
// {value, unit, display}. Never renders "[object Object]".
const disp = (v: Any): string => {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.display != null) return String(v.display);
    if (v.value != null) return `${v.value}${v.unit ? ' ' + v.unit : ''}`;
    return String(v.text ?? v.label ?? v.name ?? '');
  }
  return String(v);
};
const esc = (s: unknown) => disp(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const num = (n?: number) => (n == null || Number.isNaN(n) ? '--' : String(Math.round(n)));
const clampPct = (n?: number) => Math.max(2, Math.min(100, Number(n ?? 0)));
const STATUS_VAR: Record<string, string> = {
  optimal: 'positive', good: 'positive', ok: 'positive', in_range: 'positive', strong: 'positive',
  watch: 'warning', upcoming: 'warning', borderline: 'warning', moderate: 'warning',
  needs_attention: 'negative', high: 'negative', low: 'negative', out_of_range: 'negative', poor: 'negative',
  missing: 'text-muted', not_connected: 'text-muted', not_provided: 'text-muted',
};
const sc = (s?: string) => `var(--${STATUS_VAR[String(s ?? '').toLowerCase()] ?? 'primary'})`;

// Semicircular gauge with tick marks + gradient arc + big value.
function gauge(label: string, score: number | undefined, id: string, stops: string[], sub?: string): string {
  const w = 210, h = 128, cx = w / 2, cy = 116, r = 88, sw = 15;
  const has = score != null;
  const a1 = Math.PI - (Math.PI * clampPct(score)) / 100;
  const P = (a: number, rad: number) => `${(cx + rad * Math.cos(a)).toFixed(1)} ${(cy - rad * Math.sin(a)).toFixed(1)}`;
  const arc = (f: number, t: number, rad: number) => `M ${P(f, rad)} A ${rad} ${rad} 0 0 1 ${P(t, rad)}`;
  const ticks = Array.from({ length: 11 }, (_, i) => { const a = Math.PI - (Math.PI * i) / 10; return `<line x1="${(cx + (r + 11) * Math.cos(a)).toFixed(1)}" y1="${(cy - (r + 11) * Math.sin(a)).toFixed(1)}" x2="${(cx + (r + 3) * Math.cos(a)).toFixed(1)}" y2="${(cy - (r + 3) * Math.sin(a)).toFixed(1)}" stroke="var(--border)" stroke-width="2"/>`; }).join('');
  const grad = stops.map((s, i) => `<stop offset="${i / (stops.length - 1)}" stop-color="${s}"/>`).join('');
  return `<div class="gauge"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">${grad}</linearGradient></defs>${ticks}
    <path d="${arc(Math.PI, 0, r)}" fill="none" stroke="var(--surface-alt)" stroke-width="${sw}" stroke-linecap="round"/>
    ${has ? `<path d="${arc(Math.PI, a1, r)}" fill="none" stroke="url(#${id})" stroke-width="${sw}" stroke-linecap="round" class="arc"/>` : ''}
  </svg><div class="gv">${num(score)}</div><div class="gl">${esc(label)}</div>${sub ? `<div class="gs">${esc(sub)}</div>` : ''}</div>`;
}

// WHOOP-style compact score ring: the reference uses three small circles in
// the daily header rather than a single hero score. Keep the actual display
// value separate from the normalized arc so strain can remain 0–21.
function scoreRing(label: string, displayValue: string, pct: number | undefined, id: string, color: string, sub?: string): string {
  const s = 116, r = 47, sw = 6, circ = 2 * Math.PI * r;
  const off = circ - (circ * clampPct(pct)) / 100;
  return `<article class="score-ring"><div class="score-ring-svg"><svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
    <circle cx="58" cy="58" r="${r}" fill="none" stroke="var(--surface-alt)" stroke-width="${sw}"/>
    <circle cx="58" cy="58" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${circ}" stroke-dashoffset="${off}" transform="rotate(-90 58 58)" class="ring-arc" style="--ring-off:${off};--ring-circ:${circ}"/>
  </svg><strong>${esc(displayValue)}</strong></div><span class="score-label">${esc(label)}</span>${sub ? `<span class="score-sub">${esc(sub)}</span>` : ''}</article>`;
}

function sparkline(values: number[], color = 'var(--accent)'): string {
  const points = values.length > 1 ? values : [0, 0];
  const min = Math.min(...points), max = Math.max(...points), range = max - min || 1;
  const coords = points.map((value, i) => `${(i / (points.length - 1)) * 120},${24 - ((value - min) / range) * 18}`).join(' ');
  return `<svg class="spark" viewBox="0 0 120 28" role="img" aria-label="Recent trend"><polyline points="${coords}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function particles(count = 42): string {
  return Array.from({ length: count }, (_, i) => {
    const angle = (i * 137.5) % 360;
    const radius = 28 + ((i * 17) % 66);
    const delay = -((i * 0.37) % 12).toFixed(2);
    const size = 1 + (i % 3) * 0.55;
    return `<i style="--a:${angle}deg;--r:${radius}%;--d:${delay}s;--s:${size}px"></i>`;
  }).join('');
}

function metricById(wa: Any, ids: string[]): Any | undefined {
  const findings = (wa?.findings ?? []) as Any[];
  return ids.map(id => findings.find(f => String(f.id ?? '').toLowerCase() === id.toLowerCase())).find(Boolean);
}

// Labeled horizontal meter with an animated fill.
function meter(name: string, value: string, pct: number, status?: string): string {
  return `<div class="mtr"><div class="mh"><span class="mn">${esc(name)}</span><span class="mv">${esc(value)}</span></div>
    <div class="mt"><i style="width:${clampPct(pct)}%;background:${sc(status)}"></i></div></div>`;
}

function section(kicker: string, title: string, body: string): string {
  return `<section class="sec"><div class="sec-h"><span class="sec-k">${esc(kicker)}</span><h2>${esc(title)}</h2></div>${body}</section>`;
}

function coverageChips(plan: Any, healthspan: Any): string {
  const conn = (healthspan?.connected ?? []) as Any[];
  const items = conn.length ? conn.map(c => `<span class="chip ${c.connected ? 'on' : 'off'}">${c.connected ? '●' : '○'} ${esc(c.name)}<i>${esc(c.count)}</i></span>`).join('') : '';
  return items ? `<div class="chips">${items}</div>` : '';
}

// ---- section renderers ----

function wearableSection(wa: Any): string {
  if (!wa || wa.status === 'missing' || !(wa.domains ?? []).some((d: Any) => d.measured > 0)) {
    return section('Wearable', 'Sleep & recovery', `<div class="empty">No wearable connected. Connect a compatible source to unlock recovery, sleep, and strain tracking.</div>`);
  }
  const blocks = (wa.domains ?? []).filter((d: Any) => d.measured > 0).map((d: Any) => {
    // `analyzeWearables` keeps `top_findings` as compact labels and exposes
    // the full scored records in `findings`; prefer those records so values,
    // units, targets, and status are visible in the dashboard.
    const domainFindings = (wa.findings ?? []).filter((f: Any) => f.domain === d.id);
    const findings = (domainFindings.length ? domainFindings : (d.top_findings ?? []).map((f: Any) => ({ name: f })))
      .slice(0, 4).map((f: Any) => meter(f.name ?? f.marker ?? '', f.value != null ? `${f.value} ${f.unit ?? ''}`.trim() : f.display ?? '', f.score ?? d.score, f.status ?? d.status)).join('');
    return `<div class="dom"><div class="dom-h"><span class="dom-n">${esc(d.name)}</span><span class="dom-s" style="color:${sc(d.status)}">${num(d.score)}</span></div>${findings || `<div class="dom-a">${esc((d.actions ?? [])[0] ?? '')}</div>`}</div>`;
  }).join('');
  return section('Wearable', 'Sleep & recovery', `<div class="grid2">${blocks}</div>`);
}

function healthMonitorSection(wa: Any): string {
  const preferred = ['hrv', 'resting_heart_rate', 'respiratory_rate', 'spo2', 'skin_temperature', 'blood_pressure', 'sleep_debt_minutes'];
  const findings = (wa?.findings ?? []) as Any[];
  const byId = new Map(findings.map((finding: Any) => [String(finding.id ?? '').toLowerCase(), finding]));
  const cards = preferred.map(id => byId.get(id)).filter(Boolean).map((f: Any) => `<article class="monitor">
    <div class="monitor-top"><span class="monitor-label">${esc(f.name)}</span><span class="monitor-state" style="color:${sc(f.status)}">${esc(f.status_label ?? f.status ?? '')}</span></div>
    <div class="monitor-value">${esc(f.value)} <small>${esc(f.unit ?? '')}</small></div>
    <div class="monitor-target">${esc(f.target_label ?? 'Personal baseline')}</div>
  </article>`).join('');
  if (!cards) return section('Health monitor', 'Baseline signals', `<div class="empty">No baseline-relative monitor signals are available yet. A connected wearable will add HRV, resting heart rate, respiratory rate, oxygen, temperature, and sleep-debt context here.</div>`);
  return section('Health monitor', 'Baseline signals', `<div class="monitor-grid">${cards}</div>`);
}

function stressSection(wa: Any): string {
  const stress = metricById(wa, ['stress', 'stress_score', 'day_stress']);
  if (!stress) return section('Stress monitor', 'Your load, in context', `<div class="empty">No stress signal is synced yet. Add a wearable with stress tracking or a quick check-in to explain what your recovery score cannot see.</div>`);
  const score = Number(stress.score ?? stress.value ?? 0);
  const state = String(stress.status_label ?? stress.status ?? 'Monitor');
  return section('Stress monitor', 'Your load, in context', `<div class="stress-card"><div class="stress-head"><div><span class="stress-kicker">Current state</span><strong>${esc(state)}</strong></div><span class="stress-time">${esc(stress.observed_at ?? 'Today')}</span></div><div class="stress-band"><i style="left:${clampPct(score)}%"></i></div><div class="stress-scale"><span>Low</span><span>Moderate</span><span>High</span></div><p>${esc(stress.interpretation ?? stress.action ?? 'Use this signal with sleep, activity, and your own context—not as a diagnosis.')}</p></div>`);
}

function activitySection(wa: Any): string {
  const ids = ['steps', 'zone2_minutes', 'strength_sessions', 'workout_count', 'vigorous_minutes', 'strain'];
  const items = ids.map(id => metricById(wa, [id])).filter(Boolean).slice(0, 6);
  if (!items.length) return section('My day', "Today's activities", `<div class="empty">No activity signals are synced yet. Your next workout or daily movement will appear here.</div>`);
  const rows = items.map((f: Any, i: number) => `<div class="activity-row"><span class="activity-dot" style="background:${i % 2 ? 'var(--accent)' : 'var(--primary)'}"></span><div class="activity-copy"><strong>${esc(f.name)}</strong><span>${esc(f.interpretation ?? f.target_label ?? 'Tracked from your wearable')}</span></div><b>${esc(`${f.value} ${f.unit ?? ''}`.trim())}</b></div>`).join('');
  return section('My day', "Today's activities", `<div class="activity-list">${rows}</div>`);
}

function sleepPerformanceSection(wa: Any): string {
  const sleep = metricById(wa, ['sleep_performance']);
  const duration = metricById(wa, ['sleep_duration']);
  const debt = metricById(wa, ['sleep_debt_minutes']);
  const consistency = metricById(wa, ['sleep_consistency']);
  if (!sleep && !duration) return section('Sleep', 'Sleep performance', `<div class="empty">No sleep signal is synced yet. Connect a wearable to see sleep need, duration, debt, and consistency.</div>`);
  const score = sleep?.value ?? sleep?.score;
  const details = [duration, debt, consistency].filter(Boolean).map((f: Any) => `<div class="sleep-stat"><span>${esc(f.name)}</span><b>${esc(`${f.value} ${f.unit ?? ''}`.trim())}</b><small>${esc(f.target_label ?? '')}</small></div>`).join('');
  return section('Sleep', 'Sleep performance', `<div class="sleep-panel"><div class="sleep-score"><div class="sleep-ring">${scoreRing('Sleep', score == null ? '--' : `${Math.round(score)}%`, score, 'sleep', 'var(--accent)')}</div><p>${esc(sleep?.interpretation ?? 'Sleep need coverage is one of the clearest levers for tomorrow’s recovery.')}</p></div><div class="sleep-stats">${details}</div></div>`);
}

function healthContextSection(ctx: Any): string {
  const entries = Array.isArray(ctx) ? ctx : (ctx?.entries ?? ctx?.events ?? []);
  if (!entries.length) return section('Daily context', 'What changed today?', `<div class="empty">Add a quick note or tag for illness, travel, alcohol, stress, pain, schedule, or perceived exertion when the sensors do not explain the signal.</div>`);
  const cards = entries.slice(0, 6).map((entry: Any) => `<div class="ctx-entry"><span class="ctx-type">${esc(entry.context_type ?? entry.type ?? 'Check-in')}</span><span class="ctx-time">${esc(entry.recorded_at ?? entry.date ?? '')}</span><p>${esc(entry.value_or_note ?? entry.note ?? entry.value ?? '')}</p></div>`).join('');
  return section('Daily context', 'What changed today?', `<div class="context-list">${cards}</div>`);
}

function biomarkerSection(ba: Any): string {
  if (!ba || ba.status === 'missing' || ba.measured_count === 0) {
    return section('Biomarkers', 'Blood work', `<div class="empty">No blood panel connected. Add a biomarker export (ApoB, HbA1c, lipids, and more) to fuel the engine read.</div>`);
  }
  const bioAge = ba.biological_age ? `<div class="bioage"><span class="ba-l">Biological age</span><span class="ba-v">${esc(ba.biological_age.value ?? ba.biological_age)}</span></div>` : '';
  const blocks = (ba.domains ?? []).filter((d: Any) => d.measured > 0).map((d: Any) => {
    const domainFindings = (ba.findings ?? []).filter((f: Any) => f.domain === d.id);
    const findings = (domainFindings.length ? domainFindings : (d.top_findings ?? []).map((f: Any) => ({ name: f })))
      .slice(0, 4).map((f: Any) => meter(f.name ?? f.marker ?? '', f.value != null ? `${f.value} ${f.unit ?? ''}`.trim() : f.display ?? '', f.score ?? d.score, f.status ?? d.status)).join('');
    return `<div class="dom"><div class="dom-h"><span class="dom-n">${esc(d.name)}</span><span class="dom-s" style="color:${sc(d.status)}">${num(d.score)}</span></div>${findings || `<div class="dom-a">${esc((d.actions ?? [])[0] ?? '')}</div>`}</div>`;
  }).join('');
  return section('Biomarkers', 'Blood work', `${bioAge}<div class="grid2">${blocks}</div>`);
}

function edgesSection(strengths: Any[]): string {
  if (!strengths?.length) return '';
  const cards = strengths.slice(0, 6).map((s: Any) => `<div class="edge">
    <div class="edge-h"><span class="edge-t">${esc(s.title)}</span><span class="edge-sc">${num(s.score)}</span></div>
    <div class="edge-g">${esc(s.gene)}${s.rsid ? ` · ${esc(s.rsid)}` : ''}</div>
    <div class="mt sm"><i style="width:${clampPct(s.score)}%;background:var(--positive)"></i></div>
    <p class="edge-b">${esc(s.body)}</p>
    <div class="tags">${(s.tags ?? []).map((t: string) => `<span class="tag">${esc(t)}</span>`).join('')}</div></div>`).join('');
  return section('Genetics', 'Your genetic edges', `<div class="edges">${cards}</div>`);
}

function polygenicSection(prs: Any[]): string {
  if (!prs?.length) return '';
  const rows = prs.slice(0, 6).map((p: Any) => {
    const higher = String(p.band).toLowerCase().includes('high');
    return `<div class="prs"><div class="prs-h"><span class="prs-n">${esc(p.name)}</span><span class="prs-b" style="color:${higher ? 'var(--warning)' : 'var(--accent)'}">${esc(p.band)} · ${esc(p.pct)}%</span></div>
      <div class="prs-track"><span class="prs-fill" style="width:100%;background:linear-gradient(90deg,var(--accent),var(--surface-alt) 50%,var(--warning))"></span><span class="prs-dot" style="left:calc(${clampPct(p.pct)}% - 6px)"></span></div></div>`;
  }).join('');
  return section('Genetics', 'Polygenic risk', `<div class="prslist">${rows}</div>`);
}

function hallmarkSection(h: Any): string {
  const list = (h?.hallmarks ?? h) as Any[];
  if (!Array.isArray(list) || !list.length) return '';
  const chips = list.slice(0, 9).map((m: Any) => `<div class="hm"><div class="hm-h"><span>${esc(m.name)}</span><b>${num(m.burden)}</b></div>
    <div class="mt sm"><i style="width:${clampPct(m.burden)}%;background:${m.burden >= 66 ? 'var(--negative)' : m.burden >= 33 ? 'var(--warning)' : 'var(--positive)'}"></i></div>
    ${m.action ? `<div class="hm-a">${esc(m.action)}</div>` : ''}</div>`).join('');
  return section('Genetics', 'Aging hallmarks', `<div class="grid2">${chips}</div>`);
}

function contextSection(drugGene: Any[], hereditary: Any[]): string {
  const items = [...(drugGene ?? []), ...(hereditary ?? [])].slice(0, 6);
  if (!items.length) return '';
  const cards = items.map((c: Any) => `<div class="ctx"><div class="ctx-n">${esc(c.name)}</div><div class="ctx-g">${esc(c.gene)}${c.rsid ? ` · ${esc(c.rsid)}` : ''}</div><p class="ctx-d">${esc(c.lead ?? '')} ${esc(String(c.desc ?? '').slice(0, 160))}</p></div>`).join('');
  return section('Genetics', 'Discuss with a clinician', `<div class="grid2">${cards}</div><p class="note">Genetic context for a conversation with a clinician or pharmacist, not a diagnosis.</p>`);
}

function planSection(plan: Any): string {
  const pri = (plan?.priorities ?? []) as Any[];
  const focus = pri.length ? pri.slice(0, 3).map((p: Any, i: number) => `<div class="focus"><div class="focus-n">0${i + 1}</div>
    <div><div class="focus-t">${esc(p.title ?? p.headline)}</div>${(p.why ?? p.reasoning) ? `<div class="focus-w">${esc(p.why ?? p.reasoning)}</div>` : ''}
    ${(p.steps ?? []).length ? `<ul class="steps">${(p.steps ?? []).slice(0, 3).map((s: string) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}</div></div>`).join('')
    : `<div class="empty">No qualified priorities right now. Keep the maintenance items below and add the next data source to sharpen the plan.</div>`;
  const maintain = (plan?.maintain ?? []).slice(0, 4).map((m: Any) => `<li>${esc(m.title ?? m.text ?? m)}</li>`).join('');
  const review = (plan?.reviewItems ?? plan?.review ?? []).slice(0, 4).map((r: Any) => `<li>${esc(r.title ?? r.text ?? r)}</li>`).join('');
  return section('Action plan', plan?.summary ? 'Your focus' : 'Your focus',
    `${plan?.summary ? `<p class="lede">${esc(plan.summary)}</p>` : ''}<div class="focuslist">${focus}</div>
     ${maintain ? `<div class="sub"><h3>Maintain</h3><ul class="dl">${maintain}</ul></div>` : ''}
     ${review ? `<div class="sub"><h3>Retest</h3><ul class="dl">${review}</ul></div>` : ''}`);
}

function heroOrb(d: Any): string {
  const score = d.healthspan?.gli ?? d.gli ?? d.score;
  const planSummary = d.plan?.summary ?? 'Your signals are ready for a closer look.';
  const label = score == null ? 'Healthspan signal' : `${Math.round(Number(score))} / 100`;
  return `<section class="orb-hero"><div class="orb-wrap"><div class="orb-particles">${particles()}</div><div class="orb-core"><span>HEALTHSPAN</span><strong>${esc(label)}</strong><em>${score == null ? 'Connect more signals' : 'Your pace, in context'}</em></div></div><div class="orb-copy"><span class="orb-kicker">A longer view</span><h1>Steady and healthy</h1><p>${esc(planSummary)}</p><a href="#action-plan" class="orb-link">View your plan <span>→</span></a></div></section>`;
}

export function renderPerformanceFull(d: Any, theme: DesignTokens): string {
  const { rootCss, fontsHref } = themeCss(theme);
  const hs = d.healthspan ?? {};
  const wa = d.wearable_analysis ?? {};
  // Use the selected design or caller-provided product name rather than an
  // inspiration brand, so this renderer remains white-label and reusable.
  const brand = d.brand_name ?? d.brand?.name ?? d.organization?.name ?? theme.name ?? 'Performance';
  const recovery = metricById(wa, ['recovery_score']);
  const sleep = metricById(wa, ['sleep_performance']);
  const strain = metricById(wa, ['strain']);
  const member = d.member?.initials ?? d.member?.name ?? '';
  const strainPct = strain?.value == null ? undefined : (Number(strain.value) / 21) * 100;
  const css = `
  *{margin:0;padding:0;box-sizing:border-box}
  ${rootCss}
  :root{--ink-soft:color-mix(in srgb,var(--text) 76%,var(--background));--glow:rgba(22,236,143,.25)}
  html{scroll-behavior:smooth}body{background:radial-gradient(1100px 460px at 50% -180px,rgba(0,147,233,.16),transparent 72%),var(--background);color:var(--text);font-family:var(--font-body);-webkit-font-smoothing:antialiased}
  .wrap{max-width:1120px;margin:0 auto;padding:24px 28px 72px}
  @keyframes fu{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
  @keyframes ringSweep{from{stroke-dashoffset:var(--ring-circ)}to{stroke-dashoffset:var(--ring-off)}}
  @keyframes arcSweep{from{stroke-dasharray:0 999}to{stroke-dasharray:999 0}}
  @keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
  @keyframes orbPulse{0%,100%{transform:scale(.98);opacity:.82}50%{transform:scale(1.02);opacity:1}}
  @keyframes particleDrift{0%{transform:rotate(var(--a)) translateX(var(--r)) scale(.7);opacity:.25}50%{opacity:.95}100%{transform:rotate(calc(var(--a) + 18deg)) translateX(calc(var(--r) + 3%)) scale(1);opacity:.25}}
  @media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
  .topbar{display:flex;justify-content:space-between;align-items:center;padding:8px 0 18px;border-bottom:1px solid var(--border);color:var(--text-muted)}
  .brand{font-size:13px;letter-spacing:.26em;font-weight:800;color:var(--text)}.top-actions{display:flex;align-items:center;gap:18px;font-size:12px}.avatar{width:28px;height:28px;border:1px solid var(--border);border-radius:50%;display:grid;place-items:center;color:var(--primary);font-weight:800;font-size:10px}
  .day-nav{display:flex;justify-content:center;align-items:center;gap:12px;margin:24px 0 8px;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--text-muted)}.day-nav b{color:var(--text);font-weight:700;background:var(--surface);border:1px solid var(--border);padding:7px 14px;border-radius:999px}
  .hero{padding:10px 0 0;text-align:center;animation:fu .65s ease both}.hero-kicker{font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:var(--text-muted)}
  .score-rings{display:flex;justify-content:center;gap:30px;margin:18px 0 12px}.score-ring{display:flex;flex-direction:column;align-items:center;min-width:110px}.score-ring-svg{width:116px;height:116px;position:relative}.score-ring-svg svg{display:block}.score-ring-svg strong{position:absolute;inset:0;display:grid;place-items:center;font-family:var(--font-display);font-size:26px;font-weight:800}.ring-arc{animation:ringSweep 1s cubic-bezier(.22,1,.36,1) both}.score-label{font-size:10px;letter-spacing:.2em;text-transform:uppercase;font-weight:800;margin-top:8px}.score-sub{font-size:11px;color:var(--text-muted);margin-top:3px}
  .coverage{display:flex;justify-content:center;gap:8px;flex-wrap:wrap;margin:14px 0 0}.chip{font-size:11px;padding:6px 12px;border-radius:999px;border:1px solid var(--border);color:var(--text-muted);display:flex;gap:6px;align-items:center}.chip.on{color:var(--text)}.chip i{opacity:.62;font-style:normal}
  .orb-hero{display:grid;grid-template-columns:minmax(300px,420px) 1fr;gap:46px;align-items:center;margin:42px auto 0;max-width:900px;padding:26px 0 18px}.orb-wrap{position:relative;width:min(360px,72vw);aspect-ratio:1;margin:auto;border-radius:50%;background:radial-gradient(circle at 50% 46%,rgba(22,236,143,.28),rgba(22,236,143,.09) 46%,transparent 70%);filter:drop-shadow(0 0 26px rgba(22,236,143,.17));animation:orbPulse 12s ease-in-out infinite}.orb-wrap::before{content:"";position:absolute;inset:9%;border-radius:50%;border:1px solid rgba(22,236,143,.24);box-shadow:inset 0 0 40px rgba(22,236,143,.16)}.orb-particles{position:absolute;inset:0;overflow:hidden;border-radius:50%}.orb-particles i{position:absolute;left:50%;top:50%;width:var(--s);height:var(--s);border-radius:50%;background:var(--primary);box-shadow:0 0 8px var(--primary);transform-origin:0 0;animation:particleDrift var(--d) ease-in-out infinite alternate}.orb-core{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}.orb-core span{font-size:10px;letter-spacing:.26em;color:var(--text-muted);font-weight:800}.orb-core strong{font-family:var(--font-display);font-size:42px;line-height:1;margin:10px 0 7px}.orb-core em{font-style:normal;color:var(--primary);font-size:12px;font-weight:700}.orb-copy{text-align:left}.orb-kicker{font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--primary);font-weight:800}.orb-copy h1{font-size:30px;line-height:1.05;margin:9px 0 10px;font-weight:800;letter-spacing:-.02em}.orb-copy p{max-width:420px;color:var(--text-muted);line-height:1.65;font-size:14px}.orb-link{display:inline-flex;gap:10px;align-items:center;margin-top:18px;color:var(--primary);font-size:11px;text-transform:uppercase;letter-spacing:.14em;font-weight:800;text-decoration:none}.orb-link span{font-size:18px;line-height:0}
  .sec{margin-top:48px;animation:fu .5s ease both}.sec-h{display:flex;align-items:baseline;gap:14px;border-bottom:1px solid var(--border);padding-bottom:12px;margin-bottom:18px}.sec-k{font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--primary);font-weight:800}.sec-h h2{font-size:22px;font-weight:800;letter-spacing:-.015em}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .dom{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md,10px);padding:18px}.dom-h{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px}.dom-n{font-size:13px;letter-spacing:.06em;text-transform:uppercase;font-weight:700}.dom-s{font-family:var(--font-display);font-size:24px;font-weight:800}.dom-a{font-size:13.5px;color:var(--text-muted);line-height:1.5}.mtr{margin:9px 0}.mh{display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px}.mn{color:var(--text)}.mv{color:var(--text-muted);font-family:var(--font-mono,monospace)}.mt{height:7px;border-radius:4px;background:var(--surface-alt);overflow:hidden}.mt.sm{height:6px}.mt i{display:block;height:100%;border-radius:4px;transform-origin:left;animation:grow 1s cubic-bezier(.22,1,.36,1) both}
  .monitor-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.monitor{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md,10px);padding:16px;min-height:142px}.monitor-top{display:flex;justify-content:space-between;gap:12px;align-items:baseline}.monitor-label{font-size:10px;letter-spacing:.1em;text-transform:uppercase;font-weight:800}.monitor-state{font-size:10px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;text-align:right}.monitor-value{font-family:var(--font-display);font-size:28px;font-weight:800;margin-top:12px}.monitor-value small{font-family:var(--font-body);font-size:12px;color:var(--text-muted);font-weight:500}.monitor-target{font-size:11px;color:var(--text-muted);margin-top:3px}.spark{display:block;width:100%;height:28px;margin-top:10px;opacity:.9}
  .sleep-panel{display:grid;grid-template-columns:1fr 1.4fr;gap:20px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md,10px);padding:20px}.sleep-score{display:flex;gap:18px;align-items:center}.sleep-score p{font-size:13px;color:var(--text-muted);line-height:1.5}.sleep-ring .score-ring{min-width:94px}.sleep-ring .score-ring-svg{width:94px;height:94px}.sleep-ring .score-ring-svg svg{width:94px;height:94px}.sleep-ring .score-ring-svg strong{font-size:21px}.sleep-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.sleep-stat{display:flex;flex-direction:column;justify-content:center;border-left:1px solid var(--border);padding-left:15px}.sleep-stat span{font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em}.sleep-stat b{font-family:var(--font-display);font-size:21px;margin-top:7px}.sleep-stat small{font-size:10px;color:var(--text-muted);margin-top:3px}
  .stress-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md,10px);padding:20px}.stress-head{display:flex;justify-content:space-between;align-items:flex-end}.stress-kicker{display:block;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--text-muted);margin-bottom:5px}.stress-head strong{font-size:26px}.stress-time{font-size:11px;color:var(--text-muted)}.stress-band{height:9px;border-radius:9px;background:linear-gradient(90deg,var(--positive) 0 33%,var(--warning) 33% 66%,var(--negative) 66%);margin:22px 0 6px;position:relative}.stress-band i{position:absolute;top:-5px;width:18px;height:18px;border-radius:50%;background:var(--text);border:4px solid var(--surface);box-shadow:0 0 0 1px var(--border);transform:translateX(-50%)}.stress-scale{display:flex;justify-content:space-between;color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.stress-card p{font-size:13.5px;color:var(--text-muted);line-height:1.55;margin-top:18px;max-width:680px}
  .activity-list{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md,10px);padding:4px 18px}.activity-row{display:flex;align-items:center;gap:13px;padding:14px 0;border-bottom:1px solid var(--border)}.activity-row:last-child{border-bottom:0}.activity-dot{width:8px;height:8px;border-radius:50%;box-shadow:0 0 10px currentColor}.activity-copy{display:flex;flex-direction:column;gap:2px;flex:1}.activity-copy strong{font-size:14px}.activity-copy span{font-size:12px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.activity-row>b{font-family:var(--font-mono,monospace);font-size:12px;color:var(--text-muted);font-weight:500}
  .context-list{display:flex;flex-direction:column}.ctx-entry{display:grid;grid-template-columns:150px 1fr;gap:10px;border-bottom:1px solid var(--border);padding:13px 0}.ctx-type{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--primary);font-weight:700}.ctx-time{font-size:11px;color:var(--text-muted);text-align:right}.ctx-entry p{grid-column:1/-1;font-size:13.5px;color:var(--text-muted);line-height:1.5}.edges{display:grid;grid-template-columns:1fr 1fr;gap:16px}.edge{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md,10px);padding:18px;border-left:3px solid var(--positive)}.edge-h{display:flex;justify-content:space-between;align-items:baseline}.edge-t{font-weight:800;font-size:15px}.edge-sc{font-family:var(--font-display);font-weight:800;color:var(--positive)}.edge-g{font-size:12px;color:var(--text-muted);font-family:var(--font-mono,monospace);margin:2px 0 10px}.edge-b{font-size:13.5px;color:var(--text-muted);line-height:1.5;margin-top:10px}.tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}.tag{font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;padding:3px 8px;border-radius:4px;background:var(--surface-alt);color:var(--text-muted);font-weight:600}
  .prslist{display:flex;flex-direction:column;gap:16px}.prs-h{display:flex;justify-content:space-between;font-size:14px;margin-bottom:8px}.prs-n{font-weight:700}.prs-b{font-size:12px;letter-spacing:.04em;text-transform:uppercase;font-weight:700}.prs-track{position:relative;height:8px;border-radius:999px;overflow:hidden}.prs-fill{position:absolute;inset:0;border-radius:999px;opacity:.5}.prs-dot{position:absolute;top:-3px;width:14px;height:14px;border-radius:50%;background:var(--text);border:2px solid var(--surface)}.hm{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md,10px);padding:14px 16px}.hm-h{display:flex;justify-content:space-between;font-size:13px;margin-bottom:8px}.hm-h b{font-family:var(--font-display)}.hm-a{font-size:12.5px;color:var(--text-muted);margin-top:8px;line-height:1.4}.ctx{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md,10px);padding:16px}.ctx-n{font-weight:700;font-size:14px}.ctx-g{font-size:12px;color:var(--text-muted);font-family:var(--font-mono,monospace);margin:2px 0 8px}.ctx-d{font-size:13px;color:var(--text-muted);line-height:1.5}.note{font-size:12px;color:var(--text-muted);margin-top:12px;font-style:italic}
  .bioage{display:inline-flex;align-items:baseline;gap:10px;background:var(--surface);border:1px solid var(--border);border-radius:999px;padding:10px 18px;margin-bottom:16px}.ba-l{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted)}.ba-v{font-family:var(--font-display);font-size:22px;font-weight:800}.lede{color:var(--text-muted);font-size:15px;line-height:1.6;max-width:680px;margin-bottom:18px}.focuslist{display:flex;flex-direction:column;gap:14px}.focus{display:flex;gap:16px;border-left:3px solid var(--primary);padding:12px 0 12px 16px}.focus-n{font-family:var(--font-display);font-size:22px;font-weight:800;color:var(--primary);line-height:1}.focus-t{font-weight:800;font-size:16px}.focus-w{color:var(--text-muted);font-size:14px;margin-top:4px;line-height:1.5}.steps{margin:10px 0 0;padding-left:18px}.steps li{font-size:13.5px;color:var(--text-muted);line-height:1.6}.sub{margin-top:24px}.sub h3{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--text-muted);font-weight:700;margin-bottom:8px}.dl li{list-style:none;padding:11px 0;border-bottom:1px solid var(--border);font-size:14px}.empty{background:var(--surface);border:1px dashed var(--border);border-radius:var(--radius-md,10px);padding:20px;font-size:14px;color:var(--text-muted);line-height:1.55}footer{margin-top:52px;padding-top:18px;border-top:1px solid var(--border);font-size:12px;color:var(--text-muted);line-height:1.6}
  @media (max-width:900px){.monitor-grid{grid-template-columns:repeat(2,1fr)}.orb-hero{grid-template-columns:1fr;gap:20px}.orb-copy{text-align:center}.orb-copy p{margin:0 auto}.orb-link{justify-content:center}}
  @media (max-width:720px){.wrap{padding:18px 16px 52px}.top-actions{gap:10px}.day-nav{margin-top:18px}.score-rings{gap:8px;justify-content:space-between}.score-ring{min-width:0;flex:1}.score-ring-svg{width:92px;height:92px}.score-ring-svg svg{width:92px;height:92px}.score-ring-svg strong{font-size:22px}.score-label{font-size:9px;letter-spacing:.13em}.grid2,.edges,.monitor-grid{grid-template-columns:1fr}.sleep-panel{grid-template-columns:1fr}.sleep-score{align-items:flex-start}.sleep-stats{grid-template-columns:1fr 1fr}.sleep-stat{border-left:0;border-top:1px solid var(--border);padding:12px 0 0}.ctx-entry{grid-template-columns:1fr}.ctx-time{text-align:left}.ctx-entry p{grid-column:auto}.sec{margin-top:38px}.sec-h{gap:9px}.sec-h h2{font-size:19px}.orb-wrap{width:min(290px,80vw)}}
  `;
  const sleepScore = sleep?.value ?? sleep?.score;
  const recoveryScore = recovery?.value ?? recovery?.score;
  const strainDisplay = strain?.value == null ? '--' : Number(strain.value).toFixed(1);
  return `<!doctype html><html lang="en" data-design="performance"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>My day · Performance</title>${fontsHref ? `<link rel="stylesheet" href="${fontsHref}">` : ''}<style>${css}</style></head><body><div class="wrap">
  <header class="topbar"><span class="brand">${esc(brand)}</span><div class="top-actions"><span>${esc(member)}</span><span class="avatar">${esc(member.slice(0, 2))}</span></div></header>
  <nav class="day-nav" aria-label="Day navigation"><span>‹</span><b>TODAY</b><span>›</span></nav>
  <section class="hero"><span class="hero-kicker">My day</span><div class="score-rings">${scoreRing('Sleep', sleepScore == null ? '--' : `${Math.round(Number(sleepScore))}%`, sleepScore, 'r-sleep', 'var(--accent)', sleep?.status_label)}${scoreRing('Recovery', recoveryScore == null ? '--' : `${Math.round(Number(recoveryScore))}%`, recoveryScore, 'r-recovery', 'var(--primary)', recovery?.status_label)}${scoreRing('Strain', strainDisplay, strainPct, 'r-strain', 'var(--accent)', strain?.status_label ?? 'load')}</div>${coverageChips(d.plan, hs)}</section>
  ${heroOrb(d)}
  ${sleepPerformanceSection(wa)}
  ${wearableSection(wa)}
  ${healthMonitorSection(wa)}
  ${stressSection(wa)}
  ${activitySection(wa)}
  ${biomarkerSection(d.biomarker_analysis)}
  ${edgesSection(d.strengths)}
  ${polygenicSection(d.polygenic)}
  ${hallmarkSection(d.hallmarks ?? d.hallmark)}
  ${contextSection(d.drugGene, d.hereditary)}
  ${healthContextSection(d.health_context ?? d.healthContext)}
  <div id="action-plan">${planSection(d.plan)}</div>
  <footer>${esc(d.plan?.disclaimer ?? 'Educational longevity analysis. Not a diagnosis or medical advice. Confirm high-stakes findings with a clinician.')}</footer>
</div></body></html>`;
}

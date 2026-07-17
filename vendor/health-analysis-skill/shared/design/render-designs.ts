/**
 * Per-design dashboard engine (high-fidelity).
 *
 * Each design system renders a STRUCTURALLY different, production-grade
 * dashboard: its own hero data-viz (gradient ring, tick-marked gauges, a
 * reference-range lab table, a glucose zone curve, a category card grid, a
 * breathing orb), section order, and voice. Inspired by the aesthetic
 * categories of well-known wellness apps; the design language is our own, no
 * proprietary assets. All self-contained HTML + inline SVG + CSS, with subtle
 * on-load motion. Shared: token theming (theme.ts), escaping, the coverage
 * strip, and the footer.
 */
import { resolveTheme, themeCss, type DesignTokens } from "./theme.js";
import { renderApexFull, renderApexSummary } from "./render-apex.js";
import { renderPerformanceFull } from "./render-performance.js";

export interface DashboardData {
  score?: number; // overall 0-100
  summary?: string;
  coverage?: Array<{
    modality: string;
    label: string;
    signal_count: number;
    status: string;
  }>;
  cards: Array<{
    title: string;
    score?: number;
    status?: string;
    summary?: string;
    action?: string;
    category?: string;
  }>;
  priorities?: Array<{ title: string; why?: string; steps?: string[] }>;
  disclaimer?: string;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!)
  );
const STATUS_VAR: Record<string, string> = {
  optimal: "positive",
  good: "positive",
  ok: "positive",
  in_range: "positive",
  watch: "warning",
  upcoming: "warning",
  borderline: "warning",
  needs_attention: "negative",
  high: "negative",
  low: "negative",
  out_of_range: "negative",
  missing: "text-muted",
  not_connected: "text-muted",
  not_provided: "text-muted",
};
const statusColor = (s?: string) =>
  `var(--${STATUS_VAR[String(s ?? "").toLowerCase()] ?? "primary"})`;
const clampPct = (n?: number) => Math.max(3, Math.min(100, Number(n ?? 0)));
const num = (n?: number) => (n == null ? "--" : String(Math.round(n)));

interface DesignVoice {
  scoreWord: string;
  heroKicker: string;
  planTitle: string;
  tone: "editorial" | "coach" | "clinical" | "data" | "system" | "calm";
}
const VOICE: Record<string, DesignVoice> = {
  "ring-data": {
    scoreWord: "Readiness",
    heroKicker: "Today",
    planTitle: "Gentle next steps",
    tone: "editorial",
  },
  performance: {
    scoreWord: "Recovery",
    heroKicker: "TODAY'S READINESS",
    planTitle: "FOCUS",
    tone: "coach",
  },
  apex: {
    scoreWord: "Readiness",
    heroKicker: "MY DAY",
    planTitle: "FOCUS",
    tone: "coach",
  },
  "clinical-modern": {
    scoreWord: "Healthspan",
    heroKicker: "Panel summary",
    planTitle: "Clinical priorities",
    tone: "clinical",
  },
  metabolic: {
    scoreWord: "Metabolic",
    heroKicker: "Your signal",
    planTitle: "Protocol",
    tone: "data",
  },
  "system-cards": {
    scoreWord: "Overall",
    heroKicker: "Summary",
    planTitle: "Suggestions",
    tone: "system",
  },
  serene: {
    scoreWord: "Balance",
    heroKicker: "Where you are",
    planTitle: "One thing at a time",
    tone: "calm",
  },
};

// A short data-provenance strip ("42 blood · 27 wearable"), a premium touch that
// shows the dashboard is built from the person's own signals.
function coverageStrip(d: DashboardData, cls = "cov"): string {
  const parts = (d.coverage ?? [])
    .filter((c) => c.status === "connected" && c.signal_count > 0)
    .map(
      (c) =>
        `<span>${esc(c.signal_count)} ${esc(
          String(c.label).toLowerCase()
        )}</span>`
    );
  return parts.length
    ? `<div class="${cls}">${parts.join("<i>·</i>")}</div>`
    : "";
}

function head(theme: DesignTokens, title: string, extraCss: string): string {
  const { rootCss, fontsHref } = themeCss(theme);
  return `<!doctype html><html lang="en" data-design="${theme.id}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>${
    fontsHref ? `\n<link rel="stylesheet" href="${fontsHref}">` : ""
  }
<style>
${rootCss}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{background:var(--background);color:var(--text);font-family:var(--font-body);line-height:1.5;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.wrap{max-width:1120px;margin:0 auto;padding:56px 28px}
::selection{background:var(--primary);color:var(--on-primary,#fff)}
footer{margin-top:52px;padding-top:18px;border-top:1px solid var(--border);font-size:12px;line-height:1.6;color:var(--text-muted)}
.cov{display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:12.5px;color:var(--text-muted);letter-spacing:.01em}
.cov i{opacity:.5;font-style:normal}
@keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes ringFill{from{stroke-dashoffset:var(--circ)}to{stroke-dashoffset:var(--off)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
${extraCss}
</style></head><body><div class="wrap">`;
}
const foot = (d: DashboardData) =>
  `<footer>${esc(
    d.disclaimer ??
      "Educational longevity analysis. Not a diagnosis or medical advice. Confirm high-stakes findings with a clinician."
  )}</footer></div></body></html>`;

// ---- SVG building blocks ----

// Gradient progress ring with a soft glow and animated fill.
function ringSVG(
  score: number,
  opts: {
    size?: number;
    stroke?: number;
    id: string;
    from: string;
    to: string;
    track?: string;
    glow?: boolean;
  }
): string {
  const size = opts.size ?? 240,
    sw = opts.stroke ?? 14,
    r = size / 2 - sw,
    circ = 2 * Math.PI * r;
  const off = circ - (circ * clampPct(score)) / 100;
  return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="--circ:${circ};--off:${off}">
    <defs><linearGradient id="${opts.id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${
        opts.from
      }"/><stop offset="1" stop-color="${opts.to}"/></linearGradient>
      ${
        opts.glow
          ? `<filter id="${opts.id}-g" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`
          : ""
      }</defs>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${
    opts.track ?? "var(--border)"
  }" stroke-width="${sw}"/>
    <circle cx="${size / 2}" cy="${
    size / 2
  }" r="${r}" fill="none" stroke="url(#${
    opts.id
  })" stroke-width="${sw}" stroke-linecap="round"
      stroke-dasharray="${circ}" stroke-dashoffset="${off}" transform="rotate(-90 ${
    size / 2
  } ${size / 2})"
      ${
        opts.glow ? `filter="url(#${opts.id}-g)"` : ""
      } style="animation:ringFill 1.4s cubic-bezier(.22,1,.36,1) both"/>
  </svg>`;
}

// Semicircular gauge with tick marks and a gradient arc.
function gaugeSVG(
  label: string,
  score: number,
  id: string,
  stops: string[]
): string {
  const w = 220,
    h = 130,
    cx = w / 2,
    cy = 118,
    r = 92,
    sw = 16;
  const a0 = Math.PI,
    a1 = Math.PI - (Math.PI * clampPct(score)) / 100;
  const p = (ang: number, rad: number) =>
    `${cx + rad * Math.cos(ang)} ${cy - rad * Math.sin(ang)}`;
  const arc = (fromA: number, toA: number, rad: number, large = 0) =>
    `M ${p(fromA, rad)} A ${rad} ${rad} 0 ${large} 1 ${p(toA, rad)}`;
  const ticks = Array.from({ length: 11 }, (_, i) => {
    const ang = Math.PI - (Math.PI * i) / 10;
    return `<line x1="${cx + (r + 10) * Math.cos(ang)}" y1="${
      cy - (r + 10) * Math.sin(ang)
    }" x2="${cx + (r + 2) * Math.cos(ang)}" y2="${
      cy - (r + 2) * Math.sin(ang)
    }" stroke="var(--border)" stroke-width="2"/>`;
  }).join("");
  const grad = stops
    .map(
      (s, i) => `<stop offset="${i / (stops.length - 1)}" stop-color="${s}"/>`
    )
    .join("");
  return `<div class="gauge"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">${grad}</linearGradient></defs>
    ${ticks}
    <path d="${arc(
      Math.PI,
      0,
      r,
      1
    )}" fill="none" stroke="var(--surface-alt)" stroke-width="${sw}" stroke-linecap="round"/>
    <path d="${arc(
      a0,
      a1,
      r,
      0
    )}" fill="none" stroke="url(#${id})" stroke-width="${sw}" stroke-linecap="round" style="animation:fadeIn 1.2s ease both"/>
  </svg><div class="gauge-val">${num(
    score
  )}</div><div class="gauge-label">${esc(label)}</div></div>`;
}

// Small donut for a percentage (in-range, etc.).
function donutSVG(pct: number, color: string): string {
  const s = 84,
    r = 34,
    sw = 9,
    circ = 2 * Math.PI * r,
    off = circ - (circ * clampPct(pct)) / 100;
  return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
    <circle cx="${s / 2}" cy="${
    s / 2
  }" r="${r}" fill="none" stroke="var(--surface-alt)" stroke-width="${sw}"/>
    <circle cx="${s / 2}" cy="${
    s / 2
  }" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"
      stroke-dasharray="${circ}" stroke-dashoffset="${off}" transform="rotate(-90 ${
    s / 2
  } ${s / 2})"/>
    <text x="${s / 2}" y="${
    s / 2 + 5
  }" text-anchor="middle" font-size="20" font-weight="700" fill="var(--text)">${Math.round(
    pct
  )}</text></svg>`;
}

// Deterministic little sparkline from a seed value (illustrative trend).
function sparkline(seed: number, color: string): string {
  const w = 92,
    h = 28,
    n = 12;
  let x = seed * 7.13;
  const pts = Array.from({ length: n }, (_, i) => {
    x = (Math.sin(x) + 1) / 2;
    return `${(i / (n - 1)) * w},${h - (0.2 + x * 0.6) * h}`;
  }).join(" ");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// ==== ring-data (Oura): calm editorial, gradient ring, contributor rings ====
function renderRingData(
  d: DashboardData,
  theme: DesignTokens,
  v: DesignVoice
): string {
  const css = `body{background:radial-gradient(120% 80% at 50% -10%, color-mix(in srgb,var(--primary) 10%,transparent), transparent 60%),var(--background)}
    .hero{display:flex;flex-direction:column;align-items:center;text-align:center;padding:20px 0 4px;animation:fadeUp .7s ease both}
    .kicker{font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:var(--text-muted)}
    .ring-wrap{position:relative;margin:22px 0 6px}
    .ring-num{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
    .ring-num b{font-family:var(--font-display);font-weight:500;font-size:66px;letter-spacing:-.02em;line-height:1}
    .ring-num s{text-decoration:none;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--text-muted);margin-top:6px}
    .hero h1{font-family:var(--font-display);font-weight:400;font-size:26px;margin-top:6px}
    .hero p{color:var(--text-muted);max-width:520px;margin:14px auto 0;line-height:1.65}
    .contrib{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:46px}
    .c{display:flex;flex-direction:column;align-items:center;gap:10px;padding:20px 10px}
    .c .cn{font-family:var(--font-display);font-size:16px}.c .cl{font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;text-align:center}
    .plan{margin-top:48px}.plan h2{font-family:var(--font-display);font-weight:400;font-size:19px;color:var(--text-muted);margin-bottom:6px}
    .plan li{list-style:none;padding:18px 0;border-top:1px solid var(--border);line-height:1.6;display:flex;gap:14px;align-items:baseline}
    .plan li b{font-family:var(--font-display);color:var(--primary);font-weight:500}
    footer{text-align:center}`;
  const contrib = d.cards
    .slice(0, 3)
    .map(
      (c) => `<div class="c">
    ${ringSVG(c.score ?? 0, {
      size: 92,
      stroke: 8,
      id: `c-${esc(c.title).replace(/\W/g, "")}`,
      from: statusColor(c.status),
      to: "var(--accent)",
    })}
    <div class="cn">${num(c.score)}</div><div class="cl">${esc(
        c.title
      )}</div></div>`
    )
    .join("");
  const plan = (
    d.priorities ??
    d.cards
      .slice(0, 3)
      .map((c) => ({ title: c.action ?? c.summary ?? c.title }))
  )
    .slice(0, 3)
    .map((p, i) => `<li><b>0${i + 1}</b><span>${esc(p.title)}</span></li>`)
    .join("");
  return (
    head(theme, `${v.scoreWord} today`, css) +
    `<section class="hero"><p class="kicker">${esc(v.heroKicker)}</p>
      <div class="ring-wrap">${ringSVG(d.score ?? 0, {
        size: 244,
        stroke: 14,
        id: "hero",
        from: "var(--primary)",
        to: "var(--accent)",
        glow: true,
      })}
        <div class="ring-num"><b>${num(d.score)}</b><s>${esc(
      v.scoreWord
    )}</s></div></div>
      <h1>Your ${v.scoreWord.toLowerCase()} is ${
      d.score != null && d.score >= 70 ? "balanced" : "worth a look"
    }</h1>
      ${d.summary ? `<p>${esc(d.summary)}</p>` : ""}
      <div style="margin-top:18px">${coverageStrip(d)}</div></section>
    <div class="contrib">${contrib}</div>
    <section class="plan"><h2>${esc(
      v.planTitle
    )}</h2><ul>${plan}</ul></section>` +
    foot(d)
  );
}

// ==== performance (WHOOP): bold coach, dual tick-marked gauges, metric bars ====
function renderPerformance(
  d: DashboardData,
  theme: DesignTokens,
  v: DesignVoice
): string {
  const css = `.kicker{text-align:center;font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px}
    .band{height:4px;border-radius:2px;background:linear-gradient(90deg,var(--negative),var(--warning),var(--positive));margin:0 auto 26px;max-width:520px}
    .hero{display:flex;gap:48px;justify-content:center;flex-wrap:wrap;animation:fadeUp .6s ease both}
    .gauge{text-align:center;position:relative}
    .gauge-val{position:absolute;top:62px;left:0;right:0;font-family:var(--font-display);font-size:46px;font-weight:800;letter-spacing:-.02em}
    .gauge-label{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--text-muted);margin-top:2px}
    .cov{justify-content:center;margin-top:22px}
    .bars{margin-top:40px;border-top:1px solid var(--border)}
    .bar{display:grid;grid-template-columns:160px 1fr 52px;align-items:center;gap:16px;padding:15px 0;border-bottom:1px solid var(--border)}
    .bar .n{font-size:12.5px;letter-spacing:.1em;text-transform:uppercase;font-weight:700}
    .bar .t{height:8px;border-radius:4px;background:var(--surface-alt);overflow:hidden}
    .bar .t i{display:block;height:100%;border-radius:4px;animation:fadeIn 1s ease both}
    .bar .v{font-family:var(--font-display);font-weight:800;text-align:right;font-size:19px}
    .plan{margin-top:40px}.plan h2{font-size:13px;letter-spacing:.22em;text-transform:uppercase;font-weight:800;color:var(--text-muted);margin-bottom:14px}
    .p{border-left:3px solid var(--primary);padding:12px 0 12px 16px;margin-bottom:14px}
    .p .pt{font-weight:800;letter-spacing:.02em}.p .pw{color:var(--text-muted);font-size:14px;margin-top:4px;line-height:1.5}`;
  const bars = d.cards
    .slice(0, 8)
    .map(
      (c) => `<div class="bar"><span class="n">${esc(c.title)}</span>
    <div class="t"><i style="width:${clampPct(
      c.score
    )}%;background:${statusColor(c.status)}"></i></div><span class="v">${num(
        c.score
      )}</span></div>`
    )
    .join("");
  const plan = (
    d.priorities ??
    d.cards
      .filter((c) => c.action)
      .slice(0, 3)
      .map((c) => ({ title: c.action!, why: c.summary }))
  )
    .slice(0, 3)
    .map(
      (p) =>
        `<div class="p"><div class="pt">${esc(p.title)}</div>${
          (p as any).why ? `<div class="pw">${esc((p as any).why)}</div>` : ""
        }</div>`
    )
    .join("");
  return (
    head(theme, `${v.scoreWord}`, css) +
    `<p class="kicker">${esc(v.heroKicker)}</p><div class="band"></div>
    <section class="hero">
      ${gaugeSVG("Recovery", d.score ?? 0, "g-rec", [
        "var(--negative)",
        "var(--warning)",
        "var(--positive)",
      ])}
      ${gaugeSVG("Strain", d.cards[0]?.score ?? 0, "g-str", [
        "var(--accent)",
        "var(--primary)",
      ])}
    </section>${coverageStrip(d)}
    <section class="bars">${bars}</section>
    <section class="plan"><h2>${esc(v.planTitle)}</h2>${plan}</section>` +
    foot(d)
  );
}

// ==== clinical-modern (Superpower): lab panel, donut, reference-range table ====
function renderClinical(
  d: DashboardData,
  theme: DesignTokens,
  v: DesignVoice
): string {
  const flagged = d.cards.filter((c) =>
    [
      "watch",
      "needs_attention",
      "high",
      "low",
      "out_of_range",
      "borderline",
    ].includes(String(c.status).toLowerCase())
  ).length;
  const inRange = d.cards.length - flagged;
  const pct = d.cards.length ? (inRange / d.cards.length) * 100 : 0;
  const css = `.top{display:flex;justify-content:space-between;align-items:center;gap:32px;flex-wrap:wrap;padding-bottom:26px;border-bottom:2px solid var(--text);animation:fadeUp .5s ease both}
    .top .kicker{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--text-muted)}
    .top h1{font-size:34px;font-weight:700;letter-spacing:-.025em;margin-top:6px}
    .top .sub{color:var(--text-muted);margin-top:6px;font-size:14px}
    .donut{display:flex;align-items:center;gap:16px}.donut .dl{font-size:13px;color:var(--text-muted);max-width:120px;line-height:1.4}
    table{width:100%;border-collapse:collapse;margin-top:8px}
    th{text-align:left;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted);padding:14px 12px;border-bottom:1px solid var(--border);font-weight:600}
    td{padding:16px 12px;border-bottom:1px solid var(--border);font-size:14px;vertical-align:middle}
    tr{animation:fadeUp .5s ease both}
    .mk{font-weight:600}.val{font-family:var(--font-mono,ui-monospace,monospace);font-size:15px}
    .range{width:190px}.range .t{height:6px;border-radius:999px;background:linear-gradient(90deg,var(--surface-alt),var(--surface-alt));position:relative}
    .range .band{position:absolute;top:0;bottom:0;left:30%;right:22%;background:color-mix(in srgb,var(--positive) 28%,transparent);border-radius:999px}
    .range .dot{position:absolute;top:-4px;width:14px;height:14px;border-radius:50%;border:2px solid var(--surface);box-shadow:0 1px 3px rgba(0,0,0,.18)}
    .pill{display:inline-block;font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;padding:4px 10px;border-radius:999px}
    .rec{margin-top:36px}.rec h2{font-size:19px;font-weight:600;margin-bottom:14px;letter-spacing:-.01em}
    .rec li{list-style:none;padding:14px 0;border-bottom:1px solid var(--border);display:flex;gap:14px}
    .rec li b{color:var(--primary)}`;
  const rows = d.cards
    .slice(0, 12)
    .map(
      (c, i) => `<tr style="animation-delay:${i * 40}ms"><td class="mk">${esc(
        c.title
      )}</td>
    <td class="val">${num(c.score)}</td>
    <td class="range"><div class="t"><div class="band"></div><div class="dot" style="left:calc(${clampPct(
      c.score
    )}% - 7px);background:${statusColor(c.status)}"></div></div></td>
    <td><span class="pill" style="color:${statusColor(
      c.status
    )};background:color-mix(in srgb,${statusColor(
        c.status
      )} 14%,transparent)">${esc(
        String(c.status ?? "").replace(/_/g, " ")
      )}</span></td></tr>`
    )
    .join("");
  const recs = (
    d.priorities ??
    d.cards
      .filter((c) => c.action)
      .slice(0, 4)
      .map((c) => ({ title: c.action! }))
  )
    .slice(0, 4)
    .map((p, i) => `<li><b>0${i + 1}</b><span>${esc(p.title)}</span></li>`)
    .join("");
  return (
    head(theme, `${v.scoreWord} panel`, css) +
    `<div class="top"><div><p class="kicker">${esc(v.heroKicker)}</p><h1>${
      v.scoreWord
    } panel</h1>
      <div class="sub">${esc(
        d.summary ?? `${d.cards.length} markers reviewed.`
      )}</div><div style="margin-top:10px">${coverageStrip(d)}</div></div>
      <div class="donut">${donutSVG(
        pct,
        "var(--positive)"
      )}<div class="dl">${inRange} of ${
      d.cards.length
    } markers in range</div></div></div>
    <table><thead><tr><th>Marker</th><th>Value</th><th>Reference range</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
    <section class="rec"><h2>${esc(
      v.planTitle
    )}</h2><ul>${recs}</ul></section>` +
    foot(d)
  );
}

// ==== metabolic (Levels): glucose-style zone curve, time-in-range, chips ====
function renderMetabolic(
  d: DashboardData,
  theme: DesignTokens,
  v: DesignVoice
): string {
  const inRange = d.cards.filter((c) =>
    ["optimal", "good", "ok", "in_range"].includes(
      String(c.status).toLowerCase()
    )
  ).length;
  const pct = d.cards.length ? Math.round((inRange / d.cards.length) * 100) : 0;
  // A smooth illustrative curve seeded by the score, undulating within the
  // in-range band (not real CGM data) so it reads as a healthy metabolic trace.
  const W = 640,
    H = 150,
    seed = (d.score ?? 60) * 0.09;
  const pts = Array.from({ length: 40 }, (_, i) => {
    const t = i / 39;
    const y =
      0.46 +
      0.15 * Math.sin(t * 6.2 + seed) +
      0.06 * Math.sin(t * 15 + seed * 2);
    return [t * W, y * H] as [number, number];
  });
  const path = pts
    .map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join(" ");
  const area = `${path} L${W} ${H} L0 ${H} Z`;
  const css = `.hero{animation:fadeUp .6s ease both}.kicker{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--text-muted)}
    .headline{display:flex;align-items:flex-end;gap:20px;margin:6px 0 22px;flex-wrap:wrap}
    .metascore{font-family:var(--font-display);font-size:64px;font-weight:700;line-height:.9;letter-spacing:-.02em}
    .headline .tir{display:flex;align-items:center;gap:12px}.tir .tl{font-size:13px;color:var(--text-muted);line-height:1.35;max-width:130px}
    .chart{position:relative;border-radius:var(--radius-lg,20px);overflow:hidden;border:1px solid var(--border);background:var(--surface)}
    .chart .zones{position:absolute;inset:0;display:flex;flex-direction:column}
    .chart .zones i{flex:1}
    .chips{display:flex;flex-wrap:wrap;gap:10px;margin-top:30px}
    .chip{border:1px solid var(--border);border-radius:999px;padding:9px 15px;font-size:13.5px;display:flex;gap:9px;align-items:center;background:var(--surface)}
    .chip .dot{width:9px;height:9px;border-radius:50%}.chip b{font-family:var(--font-display)}
    .plan{margin-top:38px}.plan h2{font-size:19px;font-weight:600;margin-bottom:12px}
    .p{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md,14px);padding:16px 18px;margin-bottom:10px;animation:fadeUp .5s ease both}
    .p b{font-size:15px}.p .w{color:var(--text-muted);font-size:14px;margin-top:4px;line-height:1.5}`;
  const chips = d.cards
    .slice(0, 10)
    .map(
      (c) =>
        `<span class="chip"><span class="dot" style="background:${statusColor(
          c.status
        )}"></span>${esc(c.title)} <b>${num(c.score)}</b></span>`
    )
    .join("");
  const plan = (
    d.priorities ??
    d.cards
      .filter((c) => c.action)
      .slice(0, 3)
      .map((c) => ({ title: c.action!, why: c.summary }))
  )
    .slice(0, 3)
    .map(
      (p) =>
        `<div class="p"><b>${esc(p.title)}</b>${
          (p as any).why ? `<div class="w">${esc((p as any).why)}</div>` : ""
        }</div>`
    )
    .join("");
  return (
    head(theme, `${v.scoreWord} signal`, css) +
    `<section class="hero"><p class="kicker">${esc(v.heroKicker)}</p>
      <div class="headline"><div class="metascore">${num(d.score)}</div>
        <div class="tir">${donutSVG(
          pct,
          "var(--positive)"
        )}<div class="tl">${pct}% of markers in range</div></div></div>
      <div class="chart"><div class="zones"><i style="background:color-mix(in srgb,var(--negative) 10%,transparent)"></i><i style="background:color-mix(in srgb,var(--positive) 12%,transparent)"></i><i style="background:color-mix(in srgb,var(--warning) 10%,transparent)"></i></div>
        <svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block"><defs><linearGradient id="mg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--primary)" stop-opacity=".35"/><stop offset="1" stop-color="var(--primary)" stop-opacity="0"/></linearGradient></defs>
          <path class="zone" d="${area}" fill="url(#mg)"/><path d="${path}" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round"/></svg></div>
      <div style="margin-top:16px">${coverageStrip(d)}</div></section>
    <div class="chips">${chips}</div>
    <section class="plan"><h2>${esc(v.planTitle)}</h2>${plan}</section>` +
    foot(d)
  );
}

// ==== system-cards (Apple Health): rounded cards, icons, sparklines ====
function renderSystemCards(
  d: DashboardData,
  theme: DesignTokens,
  v: DesignVoice
): string {
  const css = `.top{margin-bottom:22px;animation:fadeUp .5s ease both}.top .kicker{font-size:13px;color:var(--text-muted)}
    .top h1{font-size:32px;font-weight:700;letter-spacing:.006em;margin-top:2px}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px}
    .card{background:var(--surface);border-radius:var(--radius-lg,20px);padding:20px;box-shadow:var(--shadow,0 1px 3px rgba(0,0,0,.06));animation:fadeUp .5s ease both}
    .card .h{display:flex;align-items:center;gap:10px;margin-bottom:14px}
    .card .icon{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:#fff}
    .card .ct{font-size:15px;font-weight:600}
    .card .cv{font-size:34px;font-weight:700;letter-spacing:-.02em;line-height:1}
    .card .row{display:flex;justify-content:space-between;align-items:flex-end;margin-top:6px}
    .card .cs{font-size:12.5px;font-weight:600;text-transform:capitalize}
    .card .cm{font-size:13px;color:var(--text-muted);margin-top:10px;line-height:1.5}
    .plan{margin-top:22px;background:var(--surface);border-radius:var(--radius-lg,20px);padding:22px;box-shadow:var(--shadow,none)}
    .plan h2{font-size:17px;font-weight:600;margin-bottom:6px}.plan .r{padding:13px 0;border-bottom:1px solid var(--border)}.plan .r:last-child{border:0}`;
  const cards = d.cards
    .slice(0, 9)
    .map(
      (c, i) => `<div class="card" style="animation-delay:${i * 45}ms">
    <div class="h"><div class="icon" style="background:${statusColor(
      c.status
    )}">${esc(String(c.title)[0] ?? "H")}</div><div class="ct">${esc(
        c.title
      )}</div></div>
    <div class="row"><div class="cv">${num(c.score)}</div>${sparkline(
        (c.score ?? 50) + i,
        statusColor(c.status)
      )}</div>
    <div class="cs" style="color:${statusColor(c.status)}">${esc(
        String(c.status ?? "").replace(/_/g, " ")
      )}</div>
    ${c.summary ? `<div class="cm">${esc(c.summary)}</div>` : ""}</div>`
    )
    .join("");
  const plan = (
    d.priorities ??
    d.cards
      .filter((c) => c.action)
      .slice(0, 4)
      .map((c) => ({ title: c.action! }))
  )
    .slice(0, 4)
    .map((p) => `<div class="r">${esc(p.title)}</div>`)
    .join("");
  return (
    head(theme, `${v.scoreWord}`, css) +
    `<div class="top"><p class="kicker">${esc(v.heroKicker)} · ${
      v.scoreWord
    } ${num(d.score)}</p><h1>Your ${v.scoreWord.toLowerCase()}</h1>
      <div style="margin-top:10px">${coverageStrip(d)}</div></div>
    <div class="grid">${cards}</div>
    <section class="plan"><h2>${esc(v.planTitle)}</h2>${plan}</section>` +
    foot(d)
  );
}

// ==== serene (Calm): glowing breathing orb, one thing at a time ====
function renderSerene(
  d: DashboardData,
  theme: DesignTokens,
  v: DesignVoice
): string {
  const css = `body{background:var(--background)}.wrap{padding:96px 28px;max-width:720px}
    @keyframes breathe{0%,100%{transform:scale(1);opacity:.92}50%{transform:scale(1.06);opacity:1}}
    .hero{text-align:center;animation:fadeIn 1.2s ease both}
    .orbwrap{position:relative;width:240px;height:240px;margin:0 auto 40px}
    .orb{position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 42% 34%,var(--primary),color-mix(in srgb,var(--accent) 60%,var(--primary)) 55%,transparent 72%);filter:blur(2px);animation:breathe 7s ease-in-out infinite}
    .orb-num{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:var(--font-display);font-size:64px;font-weight:400;color:var(--text)}
    .k{font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:var(--text-muted)}
    h1{font-family:var(--font-display);font-weight:400;font-size:36px;margin-top:24px;line-height:1.32}
    .hero p{color:var(--text-muted);max-width:460px;margin:18px auto 0;line-height:1.85;font-size:17px}
    .insight{max-width:580px;margin:64px auto 0;text-align:center;font-family:var(--font-display);font-size:23px;font-weight:400;line-height:1.55;color:var(--text)}
    .plan{max-width:540px;margin:64px auto 0}.plan h2{text-align:center;font-family:var(--font-display);font-weight:400;font-size:17px;color:var(--text-muted);margin-bottom:22px}
    .plan .p{text-align:center;padding:20px 0;border-top:1px solid var(--border);line-height:1.65;font-size:16px}
    .cov{justify-content:center;margin-top:22px}footer{text-align:center;border:0}`;
  const top = d.cards[0];
  const plan = (
    d.priorities ??
    d.cards
      .slice(0, 2)
      .map((c) => ({ title: c.action ?? c.summary ?? c.title }))
  )
    .slice(0, 2)
    .map((p) => `<div class="p">${esc(p.title)}</div>`)
    .join("");
  return (
    head(theme, `${v.scoreWord}`, css) +
    `<section class="hero"><p class="k">${esc(v.heroKicker)}</p>
      <div class="orbwrap"><div class="orb"></div><div class="orb-num">${num(
        d.score
      )}</div></div>
      <h1>Take a breath.<br>Your ${v.scoreWord.toLowerCase()} is ${
      d.score != null && d.score >= 70 ? "steady" : "asking for attention"
    }.</h1>
      ${d.summary ? `<p>${esc(d.summary)}</p>` : ""}${coverageStrip(
      d
    )}</section>
    ${
      top
        ? `<p class="insight">${esc(
            top.summary ?? `${top.title} is the signal to sit with today.`
          )}</p>`
        : ""
    }
    <section class="plan"><h2>${esc(v.planTitle)}</h2>${plan}</section>` +
    foot(d)
  );
}

const RENDERERS: Record<
  string,
  (d: DashboardData, t: DesignTokens, v: DesignVoice) => string
> = {
  "ring-data": renderRingData,
  performance: renderPerformance,
  apex: (data, theme) => renderApexSummary(data, theme),
  "clinical-modern": renderClinical,
  metabolic: renderMetabolic,
  "system-cards": renderSystemCards,
  serene: renderSerene,
};

// Render a full, self-contained dashboard whose STRUCTURE (not just color) is
// determined by the chosen design. `design` is a bundled id, a custom tokens
// path, or undefined (defaults to clinical-modern).
export function renderDesignDashboard(
  data: DashboardData,
  design?: string
): string {
  const theme = resolveTheme(design);
  const voice = VOICE[theme.id] ?? VOICE["clinical-modern"];
  const renderer = RENDERERS[theme.id] ?? renderClinical;
  return renderer(data, theme, voice);
}

// The summary-engine designs (each has a self-contained renderer above).
export const DESIGN_IDS = Object.keys(RENDERERS);

// `foreverbetter` is the full Healthspan dossier dashboard — the original house
// layout. It does NOT render through the summary engine; locally it IS the deep
// template (see scripts/pipeline/index.ts). Its canonical id matches the API
// design-system endpoint. Keep `dossier` as a backwards-compatible input alias.
export const FULL_DASHBOARD_DESIGN = "foreverbetter";
export const LEGACY_FULL_DASHBOARD_DESIGN = "dossier";

export function isFullDashboardDesign(design?: string): boolean {
  return (
    design === FULL_DASHBOARD_DESIGN || design === LEGACY_FULL_DASHBOARD_DESIGN
  );
}

// Every selectable design id, including the full-dashboard `foreverbetter`.
export const ALL_DESIGN_IDS = [FULL_DASHBOARD_DESIGN, ...DESIGN_IDS];

// Render from the FULL transformed pipeline dashboard object (all modalities).
// Designs with a thorough, all-modality renderer use it (performance and APEX);
// the others derive the minimal shape and use their layout until upgraded.
// Note: `foreverbetter` is rendered upstream in the pipeline (index.html = the deep
// template). If it reaches here (e.g. a cloud render with no deep template), it
// degrades to the clinical summary carrying the warm-paper dossier tokens.
export function renderFullDashboard(full: any, design?: string): string {
  const theme = resolveTheme(design);
  if (theme.id === "performance") return renderPerformanceFull(full, theme);
  if (theme.id === "apex") return renderApexFull(full, theme);
  return renderDesignDashboard(pipelineToDashboardData(full), design);
}

// Normalize the local pipeline's transformed dashboard JSON (buildDashboardJSON
// output) into the design engine's input. `tracking[]` are the multimodal
// category cards; plan/healthspan supply the rest. Defensive on field names.
export function pipelineToDashboardData(d: any): DashboardData {
  const cards = (d?.tracking ?? []).map((t: any) => ({
    title: t.title,
    score: t.score,
    status: t.scoreStatus ?? t.status,
    summary: t.summary,
    category: t.id,
  }));
  const priorities = (d?.plan?.priorities ?? []).map((p: any) => ({
    title: p.title ?? p.headline ?? p.name ?? String(p),
    why: p.why ?? p.reasoning ?? p.body ?? p.summary,
    steps: p.steps,
  }));
  return {
    score: d?.healthspan?.gli ?? d?.score,
    summary: d?.plan?.summary ?? d?.multimodal_plan?.summary,
    coverage: d?.plan?.coverage,
    cards,
    priorities,
    disclaimer: d?.plan?.disclaimer,
  };
}

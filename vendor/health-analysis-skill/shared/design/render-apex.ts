/**
 * APEX dashboard renderer — a source-faithful, white-label implementation of
 * the supplied APEX Design System handoff. It consumes the same transformed
 * multimodal dashboard object as the ForeverBetter dashboard, rather than a
 * prototype data shape, so future generations can reproduce the layout from
 * the `apex` design-system contract.
 */
import { themeCss, type DesignTokens } from "./theme.js";

type Any = any;

const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]!)
  );
const value = (item: Any) => item?.value ?? item?.score;
const number = (item: Any, suffix = "") =>
  value(item) == null ? "--" : `${Math.round(Number(value(item)))}${suffix}`;
const pct = (raw: unknown) => Math.max(0, Math.min(100, Number(raw ?? 0)));
const strainPct = (item: Any) =>
  value(item) == null ? undefined : pct((Number(value(item)) / 21) * 100);
const findMetric = (analysis: Any, ids: string[]) =>
  (analysis?.findings ?? []).find((item: Any) =>
    ids.includes(String(item.id ?? "").toLowerCase())
  );
const status = (raw: unknown) => {
  const key = String(raw ?? "").toLowerCase();
  if (["optimal", "good", "ok", "in_range", "strong", "low"].includes(key))
    return "optimal";
  if (["watch", "borderline", "moderate", "elevated"].includes(key))
    return "monitor";
  if (["needs_attention", "high", "out_of_range", "poor"].includes(key))
    return "act";
  return "neutral";
};

function readinessRing(
  label: string,
  display: string,
  score: number | undefined,
  color: string,
  sub?: string,
  delay = 0
): string {
  const size = 150,
    radius = 61,
    stroke = 8,
    circumference = 2 * Math.PI * radius;
  const offset = circumference - (circumference * pct(score)) / 100;
  return `<article class="apex-readiness" style="--ring-color:${color};--ring-circ:${circumference};--ring-off:${offset};--ring-delay:${delay}ms">
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><circle cx="75" cy="75" r="${radius}" class="ring-track"/><circle cx="75" cy="75" r="${radius}" class="ring-value" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" transform="rotate(-90 75 75)"/></svg>
    <strong>${esc(display)}</strong><span>${esc(label)}</span>${
    sub ? `<em>${esc(sub)}</em>` : ""
  }
  </article>`;
}

function sourceChips(full: Any): string {
  const connected = full?.healthspan?.connected ?? full?.plan?.coverage ?? [];
  const chips = connected
    .filter(
      (item: Any) => item.connected !== false && item.status !== "not_provided"
    )
    .map(
      (item: Any) =>
        `<span class="source-chip">${esc(
          item.name ?? item.label ?? item.source_provider ?? "Source"
        )}${
          item.count ?? item.signal_count
            ? ` · ${esc(item.count ?? item.signal_count)}`
            : ""
        }</span>`
    )
    .join("");
  return chips ? `<div class="sources">${chips}</div>` : "";
}

function section(
  id: string,
  eyebrow: string,
  title: string,
  content: string,
  panelId = id
): string {
  const isPrimaryPanel = id === panelId;
  const accessibility = isPrimaryPanel
    ? `role="tabpanel" aria-labelledby="apex-tab-${panelId}"`
    : `role="region" aria-label="${esc(title)}"`;
  return `<section id="${id}" class="apex-section apex-panel" ${accessibility} data-apex-panel="${panelId}"><div class="section-head"><span>${esc(
    eyebrow
  )}</span><h2>${esc(title)}</h2></div>${content}</section>`;
}

type ApexTab = { id: string; label: string };

function tabs(items: ApexTab[]): string {
  return `<nav class="tabs" role="tablist" aria-label="Dashboard sections" data-motion="apex-tab-transition">${items
    .map(
      (item, index) =>
        `<button id="apex-tab-${
          item.id
        }" type="button" role="tab" data-apex-tab="${item.id}" aria-controls="${
          item.id
        }" aria-selected="${index === 0 ? "true" : "false"}" tabindex="${
          index === 0 ? "0" : "-1"
        }">${esc(item.label)}</button>`
    )
    .join("")}</nav>`;
}

function monitorTiles(analysis: Any): string {
  const ids = [
    "hrv",
    "resting_heart_rate",
    "respiratory_rate",
    "spo2",
    "blood_oxygen",
    "skin_temperature",
    "stress",
  ];
  const findings = ids.map((id) => findMetric(analysis, [id])).filter(Boolean);
  if (!findings.length)
    return `<div class="empty">No baseline-relative monitor signals are available yet. Connect a compatible wearable to add a measured HRV, resting heart rate, respiratory rate, oxygen, temperature, or stress signal.</div>`;
  return `<div class="monitor-grid">${findings
    .map(
      (item: Any) =>
        `<article class="monitor-tile"><div><span>${esc(
          item.name ?? item.id
        )}</span><i class="dot ${status(item.status)}"></i></div><strong>${esc(
          item.value
        )} <small>${esc(item.unit ?? "")}</small></strong><p>${esc(
          item.target_label ?? item.interpretation ?? "Personal baseline"
        )}</p></article>`
    )
    .join("")}</div>`;
}

function focusCards(plan: Any): string {
  const priorities = plan?.priorities ?? [];
  if (!priorities.length)
    return `<div class="empty">No qualified FOCUS items yet. Add a data source or a short check-in to make the next action more specific.</div>`;
  return `<div class="focus-list">${priorities
    .slice(0, 3)
    .map(
      (item: Any, index: number) =>
        `<article class="focus-card"><b>0${
          index + 1
        }</b><div><div class="focus-meta"><span>${esc(
          item.cadence ?? item.priority ?? "Today"
        )}</span>${
          item.confidence
            ? `<span class="source-chip">${esc(item.confidence)}</span>`
            : ""
        }</div><h3>${esc(item.title ?? item.headline)}</h3>${
          item.why ?? item.reasoning
            ? `<p>${esc(item.why ?? item.reasoning)}</p>`
            : ""
        }${
          (item.steps ?? []).length
            ? `<ol>${item.steps
                .slice(0, 3)
                .map((step: string) => `<li>${esc(step)}</li>`)
                .join("")}</ol>`
            : ""
        }</div></article>`
    )
    .join("")}</div>`;
}

function biomarkerContext(analysis: Any): string {
  if (
    !analysis ||
    analysis.status === "missing" ||
    analysis.measured_count === 0
  )
    return `<div class="empty">No blood panel is connected. Daily wearable guidance stays useful; add measured biomarkers for longer-horizon context.</div>`;
  const biologicalAge = analysis.biological_age;
  // The local pipeline's `score` is a derived 0–100 model, not an age in
  // years. Keep that distinction visible so a score can never be mistaken for
  // the person's biological age.
  const biologicalAgeValue =
    typeof biologicalAge === "object" && biologicalAge !== null
      ? biologicalAge.value ?? biologicalAge.age ?? biologicalAge.score
      : biologicalAge;
  const biologicalAgeIsAge =
    typeof biologicalAge === "object" &&
    biologicalAge !== null &&
    (biologicalAge.value != null || biologicalAge.age != null);
  const biologicalAgeLabel = biologicalAgeIsAge
    ? "Biological age"
    : "Biological-age signal";
  const biologicalAgeDisplay =
    biologicalAgeValue == null
      ? ""
      : biologicalAgeIsAge
      ? String(biologicalAgeValue)
      : `${Math.round(Number(biologicalAgeValue))} / 100`;
  const biologicalAgeMethod =
    typeof biologicalAge === "object" && biologicalAge !== null
      ? biologicalAge.method ??
        biologicalAge.model_version ??
        "Derived biomarker model"
      : "Derived biomarker model";
  const domains = (analysis.domains ?? [])
    .filter((domain: Any) => domain.measured > 0)
    .slice(0, 4);
  const domainCards = domains
    .map(
      (domain: Any) =>
        `<article class="range-card"><div><span>${esc(
          domain.name
        )}</span><b>${esc(
          Math.round(Number(domain.score ?? 0))
        )}</b></div><div class="range"><i style="width:${pct(
          domain.score
        )}%;background:var(--primary)"></i></div><p>${esc(
          (domain.actions ?? [])[0] ?? "Measured biomarker context"
        )}</p></article>`
    )
    .join("");
  return `<div class="biomarker-layout">${
    biologicalAgeDisplay
      ? `<article class="bio-orb"><div><span>${biologicalAgeLabel}</span><strong>${esc(
          biologicalAgeDisplay
        )}</strong><em>${esc(biologicalAgeMethod)}</em></div></article>`
      : ""
  }<div class="range-cards">${
    domainCards ||
    `<div class="empty">Biomarker records are connected but no scored domains are available yet.</div>`
  }</div></div>`;
}

function geneticContext(full: Any): string {
  const quality = full?.quality ?? {};
  const matchedMarkers = Number(quality.matched_markers ?? 0);
  const hasReportedCoverage = quality.matched_markers != null;
  if (hasReportedCoverage && matchedMarkers === 0) {
    const totalVariants = Number(quality.total_variants ?? 0);
    const annotatedRsids = Number(quality.annotated_variants ?? 0);
    const totalLabel = totalVariants
      ? `${totalVariants.toLocaleString()} DNA positions read`
      : "Genome source connected";
    return `<div class="empty"><strong>Genomic interpretation is limited.</strong><br>${esc(
      totalLabel
    )} · ${esc(
      `${annotatedRsids.toLocaleString()} annotated rsIDs available`
    )}. No evidence-backed genetic findings are shown until the VCF is annotated against its matching genome build.</div>`;
  }
  const strengths = full?.strengths ?? [];
  const polygenic = full?.polygenic ?? [];
  const cards = [...strengths.slice(0, 4), ...polygenic.slice(0, 2)];
  if (!cards.length)
    return `<div class="empty">No genetic context is connected. This section remains optional and never changes measured readiness by itself.</div>`;
  return `<div class="gene-grid">${cards
    .map(
      (item: Any) =>
        `<article class="gene-card"><div><span class="badge tier">${esc(
          item.evidence_tier ?? item.band ?? "Context"
        )}</span>${
          item.gene
            ? `<code>${esc(item.gene)}${
                item.rsid ? ` · ${esc(item.rsid)}` : ""
              }</code>`
            : ""
        }</div><h3>${esc(item.title ?? item.name)}</h3><p>${esc(
          item.body ?? item.lead ?? item.desc ?? "Evidence-graded context"
        )}</p></article>`
    )
    .join("")}</div>`;
}

function overviewInsight(full: Any): string {
  const summary = full?.plan?.summary ?? full?.multimodal_plan?.summary;
  const context =
    full?.health_context?.entries?.[0] ?? full?.health_context?.[0];
  const copy = summary ?? context?.value_or_note ?? context?.note;
  return copy
    ? `<div class="insight"><span>Observation</span><p>${esc(copy)}</p></div>`
    : "";
}

function dailyOutlook(full: Any, wearable: Any): string {
  const context = full?.health_context ?? full?.healthContext;
  const entries = Array.isArray(context)
    ? context
    : context?.entries ?? context?.events ?? [];
  const activities = [
    "steps",
    "zone2_minutes",
    "strength_sessions",
    "workout_count",
  ]
    .map((id) => findMetric(wearable, [id]))
    .filter(Boolean)
    .slice(0, 3);
  if (!entries.length && !activities.length)
    return `<div class="empty">No daily context or activity sequence is synced yet. Add a short check-in when the signals need a human explanation.</div>`;
  const rows = [
    ...entries
      .slice(0, 2)
      .map(
        (entry: Any) =>
          `<div class="outlook-row"><span>${esc(
            entry.context_type ?? entry.type ?? "Check-in"
          )}</span><p>${esc(
            entry.value_or_note ?? entry.note ?? entry.value ?? ""
          )}</p></div>`
      ),
    ...activities.map(
      (item: Any) =>
        `<div class="outlook-row"><span>${esc(
          item.name ?? item.id
        )}</span><p>${esc(`${item.value} ${item.unit ?? ""}`.trim())}</p></div>`
    ),
  ].join("");
  return `<div class="outlook">${rows}</div>`;
}

function shell(theme: DesignTokens, title: string, body: string): string {
  const { rootCss, fontsHref } = themeCss(theme);
  const css = `
  ${rootCss}
  *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(900px 440px at 50% -160px,#0D1F16 0%,transparent 72%),var(--background);color:var(--text);font-family:var(--font-body);-webkit-font-smoothing:antialiased}.apex-wrap{max-width:1180px;margin:auto;padding:0 28px 72px}.apex-header{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:16px 0 12px;background:rgba(7,16,12,.88);backdrop-filter:blur(18px);border-bottom:1px solid var(--border)}.brand{display:flex;align-items:center;gap:9px;font-size:13px;font-weight:800;letter-spacing:.08em}.brand-mark{display:grid;place-items:center;width:25px;height:25px;border-radius:8px;background:var(--primary);color:var(--on-primary);font-size:15px}.header-copy{font-size:11px;color:var(--text-muted);font-family:var(--font-mono,ui-monospace,monospace)}.tabs{display:flex;gap:20px;overflow:auto;border-bottom:1px solid var(--border);padding:0 0 1px}.tabs a{flex:none;padding:14px 0 12px;color:var(--text-muted);text-decoration:none;text-transform:uppercase;font-size:10px;font-weight:700;letter-spacing:.13em;border-bottom:2px solid transparent}.tabs a:first-child{color:var(--text);border-color:var(--primary)}.apex-hero{padding:40px 0 20px;text-align:center;animation:apex-up .5s both}.eyebrow,.section-head>span,.insight>span{display:block;text-transform:uppercase;letter-spacing:.15em;font-size:10px;font-weight:700;color:var(--text-muted)}.apex-hero h1{font-family:var(--font-display);font-size:clamp(30px,4vw,44px);letter-spacing:-.03em;line-height:1;margin:8px 0 26px}.readiness-row{display:flex;justify-content:center;gap:22px;flex-wrap:wrap}.apex-readiness{position:relative;width:150px;min-height:190px;display:flex;flex-direction:column;align-items:center}.apex-readiness svg{display:block}.ring-track,.ring-value{fill:none;stroke-width:8}.ring-track{stroke:rgba(255,255,255,.06)}.ring-value{stroke:var(--ring-color);stroke-linecap:round;animation:apex-ring 1.3s cubic-bezier(.22,1,.36,1) both}.apex-readiness strong{position:absolute;top:59px;font-family:var(--font-mono,ui-monospace,monospace);font-size:28px;letter-spacing:-.06em}.apex-readiness span{margin-top:7px;font-size:10px;letter-spacing:.14em;text-transform:uppercase;font-weight:700}.apex-readiness em{font-style:normal;font-size:11px;color:var(--text-muted);margin-top:4px}.sources{display:flex;justify-content:center;gap:7px;flex-wrap:wrap;margin-top:16px}.source-chip{display:inline-flex;align-items:center;border:1px solid var(--border);background:rgba(255,255,255,.04);border-radius:6px;padding:5px 7px;color:var(--text-muted);font:500 10px/1 var(--font-mono,ui-monospace,monospace)}.insight{display:grid;grid-template-columns:120px 1fr;gap:16px;margin:22px auto 0;max-width:900px;padding:16px 18px;border-left:3px solid var(--primary);border-radius:8px;background:#0E2018;text-align:left}.insight p{margin:0;line-height:1.5;font-size:14px}.apex-section{margin-top:46px;animation:apex-up .5s both}.section-head{display:flex;align-items:baseline;gap:14px;padding-bottom:13px;margin-bottom:16px;border-bottom:1px solid var(--border)}.section-head h2{font-family:var(--font-display);font-size:22px;letter-spacing:-.02em;margin:0}.monitor-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.monitor-tile,.range-card,.gene-card{border:1px solid var(--border);border-radius:14px;background:var(--surface);padding:16px}.monitor-tile>div,.range-card>div,.gene-card>div{display:flex;align-items:center;justify-content:space-between;gap:10px}.monitor-tile span,.range-card span{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted)}.dot{width:7px;height:7px;border-radius:50%;background:var(--text-muted)}.dot.optimal{background:var(--positive);box-shadow:0 0 12px var(--positive)}.dot.monitor{background:var(--warning)}.dot.act{background:var(--negative)}.monitor-tile strong{display:block;margin-top:14px;font-family:var(--font-mono,ui-monospace,monospace);font-size:23px;letter-spacing:-.06em}.monitor-tile small{font:500 11px var(--font-body);color:var(--text-muted);letter-spacing:0}.monitor-tile p,.range-card p,.gene-card p{margin:7px 0 0;color:var(--text-muted);font-size:12px;line-height:1.45}.focus-list{display:grid;gap:12px}.focus-card{display:grid;grid-template-columns:40px 1fr;gap:14px;padding:17px 0 17px 18px;border-left:3px solid var(--primary);background:linear-gradient(90deg,rgba(22,236,143,.07),transparent 65%)}.focus-card>b{font:700 19px/1 var(--font-mono,ui-monospace,monospace);color:var(--primary)}.focus-meta{display:flex;gap:7px;align-items:center}.focus-meta>span:first-child{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--warning)}.focus-card h3,.gene-card h3{margin:7px 0 0;font-size:16px}.focus-card p{margin:5px 0 0;color:var(--text-muted);font-size:13px;line-height:1.5}.focus-card ol{padding-left:18px;margin:10px 0 0;color:var(--text-muted);font-size:12px;line-height:1.65}.biomarker-layout{display:grid;grid-template-columns:minmax(220px,.72fr) 1.28fr;gap:18px;align-items:center}.bio-orb{display:grid;place-items:center;aspect-ratio:1;border-radius:50%;background:radial-gradient(circle,rgba(22,236,143,.24),rgba(22,236,143,.04) 48%,transparent 70%);border:1px solid rgba(22,236,143,.2);text-align:center;animation:apex-orb 5s ease-in-out infinite}.bio-orb span,.bio-orb em{display:block;font-size:10px;letter-spacing:.13em;text-transform:uppercase;color:var(--text-muted);font-style:normal}.bio-orb strong{display:block;margin:8px 0;font:700 clamp(32px,4vw,48px)/1 var(--font-mono,ui-monospace,monospace);letter-spacing:-.08em}.bio-orb em{color:var(--primary);letter-spacing:.04em;text-transform:none}.range-cards{display:grid;gap:10px}.range-card b{font:700 16px var(--font-mono,ui-monospace,monospace)}.range{height:8px;background:var(--surface-alt);border-radius:999px;overflow:hidden;margin-top:14px}.range i{display:block;height:100%;border-radius:999px;transform-origin:left;animation:apex-grow .9s cubic-bezier(.22,1,.36,1) both}.gene-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.badge{border-radius:999px;padding:4px 7px;font:700 9px/1 var(--font-body);text-transform:uppercase;letter-spacing:.1em}.tier{color:#04180F;background:var(--accent)}.gene-card code{font:500 10px var(--font-mono,ui-monospace,monospace);color:var(--text-muted)}.empty{border:1px dashed var(--border);border-radius:14px;padding:18px;color:var(--text-muted);font-size:13px;line-height:1.55}.apex-footer{margin-top:52px;padding-top:18px;border-top:1px solid var(--border);color:var(--text-muted);font-size:11px;line-height:1.6}@keyframes apex-ring{from{stroke-dashoffset:var(--ring-circ)}to{stroke-dashoffset:var(--ring-off)}}@keyframes apex-up{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}@keyframes apex-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}@keyframes apex-orb{0%,100%{filter:drop-shadow(0 0 8px rgba(22,236,143,.14))}50%{filter:drop-shadow(0 0 24px rgba(22,236,143,.26))}}@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;scroll-behavior:auto!important}}@media(max-width:720px){.apex-wrap{padding:0 16px 52px}.header-copy{display:none}.tabs{gap:17px;margin:0 -16px;padding:0 16px}.apex-hero{padding-top:30px}.readiness-row{gap:4px}.apex-readiness{width:102px;transform:scale(.82);transform-origin:top;height:157px;margin:0 -8px}.insight{grid-template-columns:1fr;gap:7px}.monitor-grid,.gene-grid,.biomarker-layout{grid-template-columns:1fr}.bio-orb{max-width:270px;width:100%;justify-self:center}.section-head{gap:9px}.section-head h2{font-size:20px}}
  `;
  const outlookCss = `.outlook{border:1px solid var(--border);border-radius:14px;background:var(--surface);padding:4px 16px}.outlook-row{display:grid;grid-template-columns:160px 1fr;gap:16px;align-items:baseline;padding:13px 0;border-bottom:1px solid var(--border)}.outlook-row:last-child{border-bottom:0}.outlook-row span{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted)}.outlook-row p{margin:0;font-size:13px;line-height:1.45}@media(max-width:720px){.outlook-row{grid-template-columns:1fr;gap:5px}}`;
  const interactionCss = `.tabs button{appearance:none;flex:none;padding:14px 0 12px;color:var(--text-muted);background:none;border:0;border-bottom:2px solid transparent;font:700 10px/1 var(--font-body);letter-spacing:.13em;text-transform:uppercase;cursor:pointer}.tabs button[aria-selected="true"]{color:var(--text);border-color:var(--primary)}.tabs button:focus-visible{outline:2px solid var(--primary);outline-offset:-2px;border-radius:4px}.apex-panel[hidden]{display:none!important}.apex-panel.is-entering{animation:apex-panel-in .5s cubic-bezier(.22,1,.36,1) both}.ring-value{animation-delay:var(--ring-delay,0ms)}.apex-panel.is-entering .monitor-tile,.apex-panel.is-entering .focus-card,.apex-panel.is-entering .gene-card,.apex-panel.is-entering .range-card,.apex-panel.is-entering .outlook-row{animation:apex-up .5s cubic-bezier(.22,1,.36,1) both;animation-delay:calc(var(--item-index,0) * 55ms)}.monitor-tile:nth-child(2),.focus-card:nth-child(2),.gene-card:nth-child(2),.range-card:nth-child(2),.outlook-row:nth-child(2){--item-index:1}.monitor-tile:nth-child(3),.focus-card:nth-child(3),.gene-card:nth-child(3),.range-card:nth-child(3),.outlook-row:nth-child(3){--item-index:2}.monitor-tile:nth-child(4),.gene-card:nth-child(4),.range-card:nth-child(4){--item-index:3}.monitor-tile:nth-child(5){--item-index:4}@keyframes apex-panel-in{from{opacity:0;transform:translateY(8px);filter:blur(2px)}to{opacity:1;transform:none;filter:none}}`;
  const interactionScript = `<script>(()=>{const tabs=[...document.querySelectorAll('[data-apex-tab]')];const panels=[...document.querySelectorAll('[data-apex-panel]')];if(!tabs.length||!panels.length)return;const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;const activate=(id,focus=false)=>{tabs.forEach(tab=>{const selected=tab.dataset.apexTab===id;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;if(selected&&focus)tab.focus();});panels.forEach(panel=>{const selected=panel.dataset.apexPanel===id;panel.hidden=!selected;panel.classList.toggle('is-active',selected);if(selected&&!reduced){panel.classList.remove('is-entering');void panel.offsetWidth;panel.classList.add('is-entering');}});};tabs.forEach((tab,index)=>{tab.addEventListener('click',()=>activate(tab.dataset.apexTab||''));tab.addEventListener('keydown',event=>{if(!['ArrowRight','ArrowLeft','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;activate(tabs[next].dataset.apexTab||'',true);});});activate(tabs[0].dataset.apexTab||'');})();</script>`;
  return `<!doctype html><html lang="en" data-design="apex"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(
    title
  )}</title>${
    fontsHref ? `<link rel="stylesheet" href="${fontsHref}">` : ""
  }<style>${css}${outlookCss}${interactionCss}</style></head><body>${body}${interactionScript}</body></html>`;
}

export function renderApexFull(full: Any, theme: DesignTokens): string {
  const wearable = full?.wearable_analysis ?? {};
  const sleep = findMetric(wearable, ["sleep_performance"]);
  const recovery = findMetric(wearable, ["recovery_score"]);
  const strain = findMetric(wearable, ["strain"]);
  const brand =
    full?.brand_name ??
    full?.brand?.name ??
    full?.organization?.name ??
    theme.name;
  const sleepDisplay = value(sleep) == null ? "--" : `${number(sleep)}%`;
  const recoveryDisplay =
    value(recovery) == null ? "--" : `${number(recovery)}%`;
  const load = value(strain) == null ? "--" : Number(value(strain)).toFixed(1);
  const content = `<main class="apex-wrap"><header class="apex-header"><div class="brand"><span class="brand-mark">A</span>${esc(
    brand
  )}</div><span class="header-copy">SOURCE-AWARE HEALTHSPAN</span></header>${tabs(
    [
      { id: "overview", label: "Overview" },
      { id: "plan", label: "Action plan" },
      { id: "genetics", label: "Genomic" },
      { id: "wearables", label: "Wearable" },
      { id: "biomarkers", label: "Biomarker" },
    ]
  )}<section id="overview" class="apex-hero apex-panel" role="tabpanel" aria-labelledby="apex-tab-overview" data-apex-panel="overview"><span class="eyebrow">My day</span><h1>Readiness, in context</h1><div class="readiness-row">${readinessRing(
    "Sleep",
    sleepDisplay,
    value(sleep),
    "#4ECDC4",
    sleep?.status_label,
    0
  )}${readinessRing(
    "Recovery",
    recoveryDisplay,
    value(recovery),
    "#E6B450",
    recovery?.status_label,
    80
  )}${readinessRing(
    "Strain",
    load,
    strainPct(strain),
    "#5AA9E6",
    strain?.status_label ?? (strain ? "load" : undefined),
    160
  )}</div>${sourceChips(full)}${overviewInsight(full)}</section>${section(
    "wearables",
    "Wearable",
    "Health monitor",
    monitorTiles(wearable)
  )}${section(
    "outlook",
    "Daily outlook",
    "What changed today?",
    dailyOutlook(full, wearable),
    "overview"
  )}${section("plan", "Action plan", "FOCUS", focusCards(full?.plan))}${section(
    "genetics",
    "Genomic",
    "Genetic context",
    geneticContext(full)
  )}${section(
    "biomarkers",
    "Biomarker",
    "Longer view",
    biomarkerContext(full?.biomarker_analysis)
  )}<footer class="apex-footer">${esc(
    full?.plan?.disclaimer ??
      "Educational longevity analysis. Not a diagnosis or medical advice. Confirm high-stakes findings with a clinician."
  )}</footer></main>`;
  return shell(theme, `My day · ${brand}`, content);
}

export function renderApexSummary(
  data: {
    score?: number;
    summary?: string;
    cards: Array<{
      title: string;
      score?: number;
      status?: string;
      summary?: string;
      action?: string;
    }>;
    priorities?: Array<{ title: string; why?: string; steps?: string[] }>;
    disclaimer?: string;
  },
  theme: DesignTokens
): string {
  const cards = data.cards.slice(0, 6);
  const ringCards = [
    {
      label: "Readiness",
      display: data.score == null ? "--" : String(Math.round(data.score)),
      score: data.score,
      color: "#E6B450",
    },
    {
      label: cards[0]?.title ?? "Signal",
      display:
        cards[0]?.score == null ? "--" : String(Math.round(cards[0].score)),
      score: cards[0]?.score,
      color: "#4ECDC4",
    },
    {
      label: cards[1]?.title ?? "Context",
      display:
        cards[1]?.score == null ? "--" : String(Math.round(cards[1].score)),
      score: cards[1]?.score,
      color: "#5AA9E6",
    },
  ];
  const monitor =
    cards
      .map(
        (card) =>
          `<article class="monitor-tile"><div><span>${esc(
            card.title
          )}</span><i class="dot ${status(card.status)}"></i></div><strong>${
            card.score == null ? "--" : esc(Math.round(card.score))
          }</strong><p>${esc(card.summary ?? "Measured signal")}</p></article>`
      )
      .join("") ||
    `<div class="empty">No measured signals are available yet.</div>`;
  const plan = (
    data.priorities ??
    cards
      .filter((card) => card.action)
      .map((card) => ({ title: card.action!, why: card.summary }))
  ).slice(0, 3);
  const content = `<main class="apex-wrap"><header class="apex-header"><div class="brand"><span class="brand-mark">A</span>${esc(
    theme.name
  )}</div><span class="header-copy">SOURCE-AWARE HEALTHSPAN</span></header>${tabs(
    [
      { id: "overview", label: "Overview" },
      { id: "plan", label: "Action plan" },
    ]
  )}<section id="overview" class="apex-hero apex-panel" role="tabpanel" aria-labelledby="apex-tab-overview" data-apex-panel="overview"><span class="eyebrow">Today</span><h1>Readiness, in context</h1><div class="readiness-row">${ringCards
    .map((item, index) =>
      readinessRing(
        item.label,
        item.display,
        item.score,
        item.color,
        undefined,
        index * 80
      )
    )
    .join("")}</div>${
    data.summary
      ? `<div class="insight"><span>Observation</span><p>${esc(
          data.summary
        )}</p></div>`
      : ""
  }</section>${section(
    "signals",
    "Signals",
    "Health monitor",
    `<div class="monitor-grid">${monitor}</div>`,
    "overview"
  )}${section(
    "plan",
    "Action plan",
    "FOCUS",
    focusCards({ priorities: plan })
  )}<footer class="apex-footer">${esc(
    data.disclaimer ??
      "Educational longevity analysis. Not a diagnosis or medical advice."
  )}</footer></main>`;
  return shell(theme, `Today · ${theme.name}`, content);
}

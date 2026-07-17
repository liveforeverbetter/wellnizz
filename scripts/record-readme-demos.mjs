import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const root = process.cwd();
const outputDir = path.join(root, 'assets', 'demos');
const temporaryDir = path.join(root, '.demo-recording');
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
let server;

try {
  await mkdir(outputDir, { recursive: true });
  await rm(temporaryDir, { recursive: true, force: true });
  await mkdir(temporaryDir, { recursive: true });
  server = startApi(port);
  await waitForApi();
  const data = await buildDemoData();
  const themes = buildThemes(data.designSystems);
  const browser = await chromium.launch({ headless: true });
  try {
    for (const scene of scenes(data)) await recordScene(browser, scene, themes[scene.system]);
  } finally {
    await browser.close();
  }
  console.log(`Recorded 5 README demos in ${path.relative(root, outputDir)}`);
} finally {
  server?.kill('SIGTERM');
  await rm(temporaryDir, { recursive: true, force: true });
}

function startApi(apiPort) {
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(apiPort),
      PUBLIC_BASE_URL: `http://127.0.0.1:${apiPort}`,
      NODE_ENV: 'development',
      STORE_MODE: 'memory',
      STORAGE_DRIVER: 'memory',
      AUTH_MODE: 'disabled',
      EMAIL_DRIVER: 'none',
      HEALTH_ANALYSIS_EXECUTION_MODE: 'inline',
      AUDIT_IP_HASH_SALT: 'readme-demo-only',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => process.stdout.write(`[demo-api] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[demo-api] ${chunk}`));
  return child;
}

async function waitForApi() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode != null) throw new Error(`Demo API exited with code ${server.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/ready`);
      if (response.ok) return;
    } catch {}
    await delay(150);
  }
  throw new Error('Timed out waiting for the demo API.');
}

async function buildDemoData() {
  const userId = 'dev-user';
  const organizationId = 'demo-org';
  const labs = await api('/imports/file', {
    user_id: userId,
    organization_id: organizationId,
    category: 'biomarkers',
    filename: 'longevity-panel.csv',
    content_type: 'text/csv',
    text: 'marker,value,unit\nApoB,118,mg/dL\nHDL,47,mg/dL\nTriglycerides,136,mg/dL\nGlucose,96,mg/dL\nInsulin,8.1,uIU/mL\nhsCRP,0.7,mg/L\nVitamin D,34,ng/mL\nFerritin,92,ng/mL\n',
  });
  const wearables = await api('/imports/file', {
    user_id: userId,
    organization_id: organizationId,
    category: 'wearables',
    filename: 'wearable-week.json',
    content_type: 'application/json',
    text: JSON.stringify({ readings: [
      { id: 'sleep_duration', value: 7.4, unit: 'hours' },
      { id: 'hrv', value: 61, unit: 'ms' },
      { id: 'resting_heart_rate', value: 52, unit: 'bpm' },
      { id: 'recovery_score', value: 76, unit: '%' },
      { id: 'steps', value: 9342, unit: 'steps' },
    ] }),
  });
  const analysis = await api('/analyses', {
    user_id: userId,
    organization_id: organizationId,
    source_ids: [labs.source.id, wearables.source.id],
  });
  const dashboard = await api(`/dashboard-specs/${analysis.id}`, undefined, 'GET');
  const actionPlan = await api(`/analyses/${analysis.id}/action-plan`, undefined, 'GET');

  const vcf = [
    '##fileformat=VCFv4.2',
    '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE',
    '1\t159174683\trs2814778\tT\tC\t.\tPASS\t.\tGT\t0/0',
    '15\t48426484\trs1426654\tG\tA\t.\tPASS\t.\tGT\t1/1',
    '5\t33951693\trs16891982\tC\tG\t.\tPASS\t.\tGT\t0/0',
    '2\t109513601\trs3827760\tG\tA\t.\tPASS\t.\tGT\t0/0',
    '15\t28365618\trs12913832\tC\tT\t.\tPASS\t.\tGT\t1/1',
  ].join('\n');
  const genetics = await api('/imports/file', {
    user_id: userId,
    organization_id: organizationId,
    category: 'genetics',
    filename: 'ancestry-demo.vcf',
    content_type: 'text/vcard',
    text: vcf,
  });
  const ancestry = await api('/genetics/ancestry', {
    user_id: userId,
    organization_id: organizationId,
    source_id: genetics.source.id,
    resolution: 'regional',
  });

  const mobile = await api(`/api/v1/sdk/users/${userId}/sync`, {
    provider: 'health_connect',
    sdkVersion: '1.0.0',
    syncTimestamp: '2026-07-16T07:30:00Z',
    data: {
      records: [
        { id: 'steps-1', type: 'steps', value: 9342, unit: 'steps', startDate: '2026-07-15T00:00:00Z', endDate: '2026-07-15T23:59:59Z' },
        { id: 'hrv-1', type: 'heartRateVariabilityRmssd', value: 61, unit: 'ms', startDate: '2026-07-16T06:55:00Z', endDate: '2026-07-16T07:00:00Z' },
        { id: 'rhr-1', type: 'restingHeartRate', value: 52, unit: 'bpm', startDate: '2026-07-16T06:55:00Z', endDate: '2026-07-16T07:00:00Z' },
      ],
      sleep: [
        { id: 'sleep-1', parentId: 'night-1', stage: 'light', startDate: '2026-07-15T23:20:00Z', endDate: '2026-07-16T03:10:00Z' },
        { id: 'sleep-2', parentId: 'night-1', stage: 'deep', startDate: '2026-07-16T03:10:00Z', endDate: '2026-07-16T06:45:00Z' },
      ],
    },
  });
  const capabilities = await api('/capabilities', undefined, 'GET');
  const providers = await api('/providers', undefined, 'GET');
  const designs = await api('/design/systems', undefined, 'GET');
  const designSystems = [];
  for (const summary of designs.systems ?? []) {
    designSystems.push(await api(`/design/systems/${summary.id}`, undefined, 'GET'));
  }

  return { labs, wearables, analysis, dashboard, actionPlan, ancestry, mobile, capabilities, providers, designs, designSystems };
}

async function api(route, body, method = 'POST') {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : {};
}

// Every scene is themed from the tokens the running API returns on
// GET /design/systems, so the recordings show the shipped design contracts.
function buildThemes(designSystems) {
  const GOOGLE_FONT_FALLBACKS = {
    Fustat: 'Fustat:wght@400;500;600;700;800',
    'Geist Mono': 'Geist+Mono:wght@400;500',
  };
  const themes = {};
  for (const system of designSystems) {
    const families = [system.typography.font_display, system.typography.font_body, system.typography.font_mono ?? ''];
    const queries = new Set(system.typography.google_fonts ?? []);
    for (const stack of families) {
      const family = familyOf(stack);
      if (queries.size === 0 && GOOGLE_FONT_FALLBACKS[family]) queries.add(GOOGLE_FONT_FALLBACKS[family]);
    }
    themes[system.id] = {
      id: system.id,
      name: system.name,
      scheme: system.color_scheme === 'dark' ? 'dark' : 'light',
      colors: system.colors,
      radii: system.radii,
      motion: system.motion,
      typography: system.typography,
      fontHref: queries.size
        ? `https://fonts.googleapis.com/css2?${[...queries].map(query => `family=${query}`).join('&')}&display=block`
        : '',
    };
  }
  return themes;
}

function familyOf(stack) {
  const first = String(stack ?? '').split(',')[0] ?? '';
  return first.replace(/["']/g, '').trim();
}

function scenes(data) {
  const ancestryRows = Array.isArray(data.ancestry.ancestry) ? data.ancestry.ancestry.slice(0, 4) : [];
  const capabilityCount = Array.isArray(data.capabilities.capabilities)
    ? data.capabilities.capabilities.length
    : Number(data.capabilities.count ?? 4);
  const providerCount = Array.isArray(data.providers.providers)
    ? data.providers.providers.length
    : Number(data.providers.count ?? 5);
  const designCount = Number(data.designs.count ?? data.designs.systems?.length ?? 3);
  const priorities = planPriorities(data.actionPlan);
  return [
    {
      id: 'multimodal-dashboard',
      system: 'foreverbetter',
      eyebrow: 'CUSTOM DASHBOARD',
      title: 'One health view. Every signal keeps its source.',
      subtitle: `${data.dashboard.schema_version ? `Dashboard contract ${data.dashboard.schema_version}` : 'Renderer-neutral dashboard contract'} built from real biomarker and wearable imports, rendered in the ForeverBetter dossier system.`,
      style: dossierStyles(),
      body: dashboardScene(priorities),
      footer: `POST /imports/file  >  POST /analyses  >  GET /dashboard-specs/${shortId(data.analysis.id)}`,
    },
    {
      id: 'ancestry-from-vcf',
      system: 'foreverbetter',
      eyebrow: 'GENETICS',
      title: 'VCF to provenance-aware ancestry',
      subtitle: `${data.ancestry.quality?.matched_markers ?? 0} ancestry-informative markers matched with confidence and method metadata.`,
      style: dossierStyles() + ancestryStyles(),
      body: ancestryScene(ancestryRows, data.ancestry),
      footer: `ancestry-demo.vcf  >  ${escapeHtml(data.ancestry.method?.id ?? 'curated ancestry model')}  >  regional result`,
    },
    {
      id: 'wearable-mobile-sync',
      system: 'aperture',
      eyebrow: 'HEALTH CONNECT',
      title: 'On-device readings, normalized in one request',
      subtitle: `The mobile SDK delivered ${data.mobile.readings_count ?? 5} source-backed observations directly to the user workspace, shown in the Aperture system.`,
      style: mobileStyles(),
      body: mobileScene(data.mobile),
      footer: `POST /api/v1/sdk/users/dev-user/sync  >  202 Accepted  >  source ${shortId(data.mobile.source_id)}`,
    },
    {
      id: 'agent-daily-brief',
      system: 'aperture',
      eyebrow: 'AGENT DELIVERY',
      title: 'Your top priorities, delivered in chat',
      subtitle: 'A scheduled agent with a scoped key reads the latest health context and action plan, then posts the daily brief to Telegram, WhatsApp, or any chat runtime.',
      style: chatStyles(),
      body: chatScene(priorities),
      footer: `GET /health-context  >  GET /analyses/${shortId(data.analysis.id)}/action-plan  >  chat delivery`,
      duration: 7800,
    },
    {
      id: 'wearable-data-console',
      system: 'meridian',
      eyebrow: 'DEVELOPER CONSOLE',
      title: 'A complete surface for apps and agents',
      subtitle: `${capabilityCount} capability groups, ${providerCount} provider records, ${designCount} design contracts, REST, MCP, Stripe, and x402, in the Meridian workspace.`,
      style: consoleStyles(),
      body: consoleScene(data, designCount),
      footer: 'GET /capabilities  >  GET /design/systems  >  POST /mcp',
    },
  ];
}

function planPriorities(actionPlan) {
  const order = { core: 0, recommended: 1, optional: 2 };
  const interventions = Array.isArray(actionPlan.interventions) ? actionPlan.interventions : [];
  const ranked = [...interventions].sort((a, b) => (order[a.priority] ?? 3) - (order[b.priority] ?? 3));
  const fallback = [
    { name: 'Zone 2 aerobic base', detail: '3 sessions this week', priority: 'core' },
    { name: 'Fiber first at meals', detail: 'target 35 g per day', priority: 'core' },
    { name: 'Retest ApoB', detail: 'in 8 to 12 weeks', priority: 'recommended' },
  ];
  const rows = (ranked.length ? ranked : fallback).slice(0, 3);
  return rows.map(row => ({
    name: trim(row.name, 30),
    detail: trim(row.detail ?? row.rationale ?? '', 44),
    priority: row.priority ?? 'core',
  }));
}

function trim(value, max) {
  const text = String(value ?? '').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 3);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > max / 2 ? cut.slice(0, boundary) : cut).replace(/[\s,;&]+$/, '')}...`;
}

// Scene 1: ForeverBetter warm-paper healthspan dossier.
function dashboardScene(priorities) {
  return `
    <div class="sheet reveal d1">
      <div class="sheet-head"><span>HEALTHSPAN DOSSIER</span><span>MULTIMODAL / 2 SOURCES</span></div>
      <div class="index-row reveal d2">
        <div class="index-value"><b>76</b><i>/100</i></div>
        <div class="index-copy"><b>Longevity index, today</b><p>Composite of direct biomarker values and wearable recovery signals.</p></div>
      </div>
      <div class="ledger">
        ${ledgerRow('Recovery', '76%', 'ready for load', 0, 76, 'd3')}
        ${ledgerRow('Sleep', '7.4 h', 'steady baseline', 1, 82, 'd4')}
        ${ledgerRow('HRV', '61 ms', '+8% vs baseline', 4, 68, 'd5')}
        ${ledgerRow('ApoB', '118 mg/dL', 'first priority', 3, 42, 'd6')}
      </div>
      <div class="plan-strip reveal d6">
        <span>Daily priorities</span>
        ${priorities.map(item => `<i>${escapeHtml(item.name)}</i>`).join('')}
      </div>
    </div>`;
}

function ledgerRow(label, value, note, vizIndex, width, delayClass) {
  return `<div class="ledger-row reveal ${delayClass}"><small>${label}</small><b>${value}</b><em>${note}</em><span><i style="--w:${width}%;background:var(--v${vizIndex})"></i></span></div>`;
}

// Scene 2: ancestry donut on the same dossier paper.
function ancestryScene(rows, ancestry) {
  const safeRows = rows.length ? rows : [
    { region: 'European', proportion: 72 },
    { region: 'East Asian', proportion: 13 },
    { region: 'African', proportion: 9 },
    { region: 'American', proportion: 6 },
  ];
  let cursor = 0;
  const segments = safeRows.map((row, index) => {
    const start = cursor;
    cursor += Number(row.proportion || 0);
    return `var(--v${index}) ${start}% ${cursor}%`;
  }).join(',');
  return `
    <div class="sheet reveal d1">
      <div class="sheet-head"><span>ANCESTRY REPORT</span><span>REGIONAL RESOLUTION</span></div>
      <div class="ancestry-wrap">
        <div class="donut reveal d2" style="--segments:conic-gradient(${segments})"><div><b>${ancestry.quality?.matched_markers ?? 0}</b><small>markers</small></div></div>
        <div class="ancestry-list">${safeRows.map((row, index) => `<div class="ancestry-row reveal d${index + 2}"><i style="background:var(--v${index})"></i><span>${escapeHtml(String(row.region ?? row.label ?? 'Region').trim())}</span><b>${Number(row.proportion ?? 0).toFixed(1)}%</b></div>`).join('')}</div>
      </div>
      <div class="method reveal d6"><span>Method</span><b>${escapeHtml(ancestry.methodology?.reference_panel ?? '1000 Genomes reference panel')}</b><em>${escapeHtml(ancestry.quality?.confidence ?? ancestry.confidence ?? 'confidence reported')}</em></div>
    </div>`;
}

// Scene 3: Aperture calm daily overview around the mobile sync flow.
function mobileScene(mobile) {
  return `
    <div class="phone reveal d1">
      <div class="phone-top"><span>9:41</span><b>ForeverBetter Connect</b><i></i></div>
      <div class="sync-ring"><span>100%</span><small>synced</small></div>
      <div class="permission reveal d2"><i>&#10003;</i><span><b>Activity</b><small>9,342 steps</small></span><em>Shared</em></div>
      <div class="permission reveal d3"><i>&#10003;</i><span><b>Recovery</b><small>61 ms HRV</small></span><em>Shared</em></div>
      <div class="permission reveal d4"><i>&#10003;</i><span><b>Sleep</b><small>7 h 25 m</small></span><em>Shared</em></div>
    </div>
    <div class="sync-flow">
      ${flowNode('1', 'Read on device', 'User-granted permissions', 'd2')}
      ${flowNode('2', 'Normalize', `${mobile.readings_count ?? 5} observations`, 'd3')}
      ${flowNode('3', 'Store privately', shortId(mobile.source_id), 'd4')}
      ${flowNode('4', 'Ready for agents', 'Scoped API access', 'd5')}
    </div>`;
}

function flowNode(step, title, detail, delayClass) {
  return `<div class="flow-node reveal ${delayClass}"><i>${step}</i><span><b>${title}</b><small>${detail}</small></span></div>`;
}

// Scene 4: agent chat delivery of the daily plan, Aperture voice.
function chatScene(priorities) {
  return `
    <div class="chat reveal d1">
      <div class="chat-head">
        <span class="avatar">FB</span>
        <span class="who"><b>ForeverBetter Agent</b><small>online &middot; scoped key</small></span>
        <span class="lock">read-only</span>
      </div>
      <div class="chat-body">
        <div class="day-chip reveal d1">Today 7:02</div>
        <div class="bubble user reveal d2">Morning. What should I focus on today?</div>
        <div class="typing reveal-typing"><i></i><i></i><i></i></div>
        <div class="bubble agent reveal d4">Good morning. Recovery 76%, HRV 61 ms, sleep 7 h 24 m. Clear for a hard session.</div>
        <div class="bubble agent card reveal d5">
          <b>Today's top 3</b>
          ${priorities.map((item, index) => `<div class="todo"><i class="p-${escapeHtml(item.priority)}">${index + 1}</i><span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.detail)}</small></span></div>`).join('')}
        </div>
        <div class="bubble agent reveal d6">Full picture: <span class="link-chip">private dashboard link</span><span class="ticks">&#10003;&#10003;</span></div>
      </div>
    </div>
    <div class="chat-note reveal d6">The agent runtime owns the schedule and the channel. The API supplies bounded data and the ranked plan.</div>`;
}

// Scene 5: Meridian instrument-panel developer console.
function consoleScene(data, designCount) {
  const designs = (data.designs.systems ?? []).slice(0, 6);
  return `
    <div class="console-shell reveal d1">
      <aside><b>FB</b><span class="active">Overview</span><span>Sources</span><span>Analyses</span><span>Agents</span><span>Billing</span></aside>
      <main>
        <div class="console-head">
          <div><small>WORKSPACE</small><h3>Health developer console</h3></div>
          <div class="orb reveal d2"><span>76</span><small>ready</small></div>
        </div>
        <div class="surface-grid">
          <section class="reveal d3"><small>DATA SURFACES</small><b>4 modalities</b><p>Biomarkers, wearables, genetics, health context</p><span class="bar" style="--c:var(--v0)"></span></section>
          <section class="reveal d4"><small>AGENT ACCESS</small><b>REST + MCP</b><p>Scoped keys, explicit approval, bounded tools</p><span class="bar" style="--c:var(--v1)"></span></section>
          <section class="reveal d5"><small>PAYMENTS</small><b>Stripe + x402</b><p>Subscriptions or pay per request in USDC</p><span class="bar" style="--c:var(--v2)"></span></section>
        </div>
        <div class="design-strip reveal d6"><span>Design contracts</span>${designs.map(item => `<i>${escapeHtml(item.name)}</i>`).join('')}<b>${designCount} via GET /design/systems</b></div>
      </main>
    </div>`;
}

async function recordScene(browser, scene, theme) {
  if (!theme) throw new Error(`Design system ${scene.system} missing from GET /design/systems.`);
  const sceneDir = path.join(temporaryDir, scene.id);
  await mkdir(sceneDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: sceneDir, size: { width: 1280, height: 720 } },
    colorScheme: theme.scheme,
  });
  const page = await context.newPage();
  await page.setContent(documentFor(scene, theme), { waitUntil: 'load' });
  await page.waitForTimeout(scene.duration ?? 6500);
  const video = page.video();
  await page.close();
  await context.close();
  const webm = await video.path();
  const mp4 = path.join(outputDir, `${scene.id}.mp4`);
  const gif = path.join(outputDir, `${scene.id}.gif`);
  await command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', webm, '-an', '-c:v', 'libx264', '-crf', '21', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
  await command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', mp4, '-vf', 'fps=10,scale=800:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3', gif]);
  console.log(`  ${scene.id}.mp4 and ${scene.id}.gif [${theme.id}]`);
}

function baseStyles(theme) {
  const c = theme.colors;
  const t = theme.typography;
  const viz = c.data_viz ?? [c.primary, c.accent, c.positive, c.warning, c.negative];
  return `
    :root{color-scheme:${theme.scheme};
      --bg:${c.background};--surface:${c.surface};--surface-alt:${c.surface_alt};--border:${c.border};
      --text:${c.text};--muted:${c.text_muted};--primary:${c.primary};--on-primary:${c.on_primary};
      --accent:${c.accent};--positive:${c.positive};--warning:${c.warning};--negative:${c.negative};
      ${viz.map((color, index) => `--v${index}:${color};`).join('')}
      --r-sm:${theme.radii.sm};--r-md:${theme.radii.md};--r-lg:${theme.radii.lg};--r-pill:${theme.radii.pill};
      --font-display:${t.font_display};--font-body:${t.font_body};--font-mono:${t.font_mono ?? 'ui-monospace, monospace'};
      --ease:${theme.motion.easing.entrance};--line:color-mix(in srgb, var(--text) 10%, transparent)}
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
    body{font-family:var(--font-body);background:${theme.scheme === 'light' && c.gradient ? `${c.gradient}, ${c.background}` : c.background};background-color:var(--bg);color:var(--text);visibility:hidden}
    body.go{visibility:visible}
    .frame{position:relative;width:100%;height:100%;padding:40px 54px 30px;display:grid;grid-template-rows:auto 1fr auto;gap:20px}
    .top{display:flex;justify-content:space-between;align-items:center}
    .brand{display:flex;gap:12px;align-items:center;font-weight:700;letter-spacing:-.02em}
    .mark{width:32px;height:32px;border:1px solid var(--primary);border-radius:var(--r-pill);display:grid;place-items:center;color:var(--primary);font-family:var(--font-display)}
    .live{display:flex;gap:9px;align-items:center;padding:8px 13px;border:1px solid var(--border);border-radius:var(--r-pill);color:var(--muted);font-size:12px;background:color-mix(in srgb, var(--surface) 82%, transparent)}
    .live i{width:7px;height:7px;border-radius:50%;background:var(--positive);box-shadow:0 0 12px var(--positive)}
    .live b{color:var(--text);font-weight:600}
    .intro{display:grid;grid-template-columns:minmax(0,390px) 1fr;gap:44px;min-height:0}
    .copy{padding-top:14px}
    .eyebrow{display:block;color:var(--primary);font-size:11px;font-weight:800;letter-spacing:.18em;margin-bottom:15px}
    .copy h1{font-family:var(--font-display);font-size:42px;line-height:1.04;letter-spacing:-.025em;margin:0 0 18px;font-weight:600}
    .copy p{font-size:14.5px;line-height:1.6;color:var(--muted);margin:0;max-width:360px}
    .content{min-height:0;position:relative}
    .footer{height:42px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:flex-end;color:var(--muted);font:11px var(--font-mono)}
    .footer b{color:var(--text);font-weight:500}
    .reveal{opacity:0;transform:translateY(14px)}
    .go .reveal{animation:reveal .65s var(--ease) forwards}
    .go .d1{animation-delay:.25s}.go .d2{animation-delay:.65s}.go .d3{animation-delay:1.05s}.go .d4{animation-delay:1.45s}.go .d5{animation-delay:1.85s}.go .d6{animation-delay:2.25s}
    @keyframes reveal{to{opacity:1;transform:none}}
    @media(prefers-reduced-motion:reduce){*{animation-duration:.01ms!important;animation-delay:0s!important}}`;
}

// ForeverBetter dossier: warm paper, hairline ledger, serif numerals.
function dossierStyles() {
  return `
    .sheet{height:100%;max-height:470px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);padding:22px 26px 18px;box-shadow:0 24px 60px -28px rgba(20,16,10,.30);display:flex;flex-direction:column;gap:14px}
    .sheet-head{display:flex;justify-content:space-between;font-size:10px;letter-spacing:.14em;color:var(--muted);border-bottom:2px solid var(--text);padding-bottom:10px;font-weight:600}
    .index-row{display:flex;gap:20px;align-items:center}
    .index-value{font-family:var(--font-display)}
    .index-value b{font-size:64px;font-weight:600;letter-spacing:-.02em}
    .index-value i{font-style:normal;color:var(--muted);font-size:18px}
    .index-copy b{display:block;font-size:14px;margin-bottom:4px}
    .index-copy p{margin:0;color:var(--muted);font-size:12px;max-width:330px;line-height:1.5}
    .ledger{display:flex;flex-direction:column}
    .ledger-row{display:grid;grid-template-columns:92px 120px 1fr 130px;gap:14px;align-items:center;padding:11px 2px;border-top:1px solid var(--border)}
    .ledger-row small{color:var(--muted);font-size:10px;letter-spacing:.1em;text-transform:uppercase;font-weight:600}
    .ledger-row b{font-family:var(--font-display);font-size:23px;font-weight:600}
    .ledger-row em{font-style:normal;color:var(--muted);font-size:12px}
    .ledger-row span{height:4px;background:var(--surface-alt);border-radius:var(--r-pill);overflow:hidden}
    .ledger-row span i{display:block;height:100%;width:0;border-radius:var(--r-pill)}
    .go .ledger-row span i{animation:grow 1.1s 2.3s var(--ease) forwards}
    @keyframes grow{to{width:var(--w)}}
    .plan-strip{margin-top:auto;display:flex;gap:8px;align-items:center;border-top:2px solid var(--text);padding-top:13px}
    .plan-strip span{font-size:11px;font-weight:700;margin-right:6px}
    .plan-strip i{font-style:normal;font-size:11px;padding:7px 11px;border-radius:var(--r-pill);border:1px solid var(--primary);color:var(--primary);font-weight:600}`;
}

function ancestryStyles() {
  return `
    .ancestry-wrap{display:grid;grid-template-columns:230px 1fr;align-items:center;gap:32px;flex:1}
    .donut{position:relative;width:210px;height:210px;border-radius:50%;background:var(--segments);display:grid;place-items:center}
    .donut:before{content:"";position:absolute;width:138px;height:138px;border-radius:50%;background:var(--surface);border:1px solid var(--border)}
    .donut div{position:relative;z-index:1;text-align:center}
    .donut b{display:block;font:600 40px var(--font-display)}
    .donut small{text-transform:uppercase;letter-spacing:.12em;color:var(--muted);font-size:9px}
    .ancestry-list{display:grid;gap:0}
    .ancestry-row{display:grid;grid-template-columns:10px 1fr auto;gap:11px;align-items:center;padding:12px 2px;border-top:1px solid var(--border)}
    .ancestry-row i{width:9px;height:9px;border-radius:2px}
    .ancestry-row span{font-size:13px}
    .ancestry-row b{font:600 20px var(--font-display)}
    .method{display:grid;grid-template-columns:70px 1fr auto;gap:13px;align-items:center;margin-top:auto;padding-top:12px;border-top:2px solid var(--text);color:var(--muted);font-size:10px;letter-spacing:.06em}
    .method b{color:var(--text);font-weight:600;letter-spacing:0}
    .method em{font-style:italic;color:var(--positive)}`;
}

// Aperture: warm-white canvas, soft cards, teal progress.
function mobileStyles() {
  return `
    .phone{position:absolute;left:12px;top:-6px;width:245px;height:360px;border:1px solid var(--border);border-radius:var(--r-lg);background:var(--surface);box-shadow:0 1px 2px rgba(23,26,31,.04),0 24px 48px -16px rgba(23,26,31,.16);padding:20px 16px}
    .phone-top{display:flex;justify-content:space-between;align-items:center;font-size:8px;color:var(--muted)}
    .phone-top b{font-size:9px;color:var(--text)}
    .phone-top i{width:6px;height:6px;background:var(--primary);border-radius:50%}
    .sync-ring{position:relative;width:104px;height:104px;border:8px solid var(--surface-alt);border-top-color:var(--primary);border-right-color:var(--primary);border-radius:50%;margin:20px auto 16px;display:grid;place-items:center;transform:rotate(-12deg)}
    .sync-ring span,.sync-ring small{transform:rotate(12deg)}
    .sync-ring span{font:800 24px var(--font-display);color:var(--text)}
    .sync-ring small{position:absolute;margin-top:36px;color:var(--muted);font-size:8px}
    .permission{display:grid;grid-template-columns:23px 1fr auto;gap:8px;align-items:center;padding:9px 5px;border-top:1px solid var(--border)}
    .permission>i{width:19px;height:19px;border-radius:50%;background:color-mix(in srgb, var(--primary) 14%, var(--surface));color:var(--primary);font-style:normal;font-size:10px;display:grid;place-items:center}
    .permission span b,.permission span small{display:block}
    .permission span b{font-size:9.5px}
    .permission span small{font-size:7.5px;color:var(--muted);margin-top:2px}
    .permission em{font-size:8px;color:var(--primary);font-style:normal;font-weight:600}
    .sync-flow{margin-left:296px;display:grid;gap:11px;padding-top:12px}
    .flow-node{display:grid;grid-template-columns:38px 1fr;gap:12px;align-items:center;padding:14px 16px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--surface);box-shadow:0 1px 2px rgba(23,26,31,.04),0 6px 20px -8px rgba(23,26,31,.10)}
    .flow-node>i{width:30px;height:30px;border-radius:var(--r-sm);background:color-mix(in srgb, var(--primary) 14%, var(--surface));color:var(--primary);font-style:normal;display:grid;place-items:center;font-weight:800}
    .flow-node b,.flow-node small{display:block}
    .flow-node b{font-size:12.5px}
    .flow-node small{font-size:10.5px;color:var(--muted);margin-top:3px}`;
}

// Aperture chat: messenger framing for the daily brief.
function chatStyles() {
  return `
    .chat{position:absolute;left:0;top:-18px;width:400px;height:478px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:0 1px 2px rgba(23,26,31,.04),0 28px 56px -20px rgba(23,26,31,.18);display:flex;flex-direction:column;overflow:hidden}
    .chat-head{display:flex;gap:10px;align-items:center;padding:13px 16px;border-bottom:1px solid var(--border);background:color-mix(in srgb, var(--surface-alt) 55%, var(--surface))}
    .avatar{width:34px;height:34px;border-radius:50%;background:var(--primary);color:var(--on-primary);display:grid;place-items:center;font-weight:800;font-size:12px}
    .who{flex:1}
    .who b{display:block;font-size:13px}
    .who small{font-size:10px;color:var(--positive)}
    .lock{font-size:9px;color:var(--muted);border:1px solid var(--border);border-radius:var(--r-pill);padding:4px 9px}
    .chat-body{flex:1;padding:13px 14px 14px;display:flex;flex-direction:column;gap:8px;background:color-mix(in srgb, var(--surface-alt) 35%, var(--surface))}
    .day-chip{align-self:center;font-size:9px;color:var(--muted);background:var(--surface);border:1px solid var(--border);border-radius:var(--r-pill);padding:4px 11px}
    .bubble{max-width:84%;padding:9px 13px;font-size:11.5px;line-height:1.5;border-radius:var(--r-md)}
    .bubble.user{align-self:flex-end;background:var(--primary);color:var(--on-primary);border-bottom-right-radius:4px}
    .bubble.agent{align-self:flex-start;background:var(--surface);border:1px solid var(--border);border-bottom-left-radius:4px}
    .bubble.card b{display:block;font-size:11px;margin-bottom:8px}
    .todo{display:grid;grid-template-columns:22px 1fr;gap:9px;align-items:center;padding:5px 0;border-top:1px solid var(--border)}
    .todo i{width:20px;height:20px;border-radius:50%;font-style:normal;font-size:10px;font-weight:800;display:grid;place-items:center;color:var(--on-primary)}
    .todo i.p-core{background:var(--primary)}
    .todo i.p-recommended{background:var(--accent)}
    .todo i.p-optional{background:var(--warning)}
    .todo span b{display:block;font-size:11px;margin:0}
    .todo span small{font-size:9.5px;color:var(--muted)}
    .link-chip{display:inline-block;margin-left:2px;padding:3px 9px;border-radius:var(--r-pill);background:color-mix(in srgb, var(--accent) 14%, var(--surface));color:var(--accent);font-weight:600;font-size:11px}
    .ticks{margin-left:8px;color:var(--primary);font-size:10px;letter-spacing:-2px}
    .typing{align-self:flex-start;display:flex;gap:4px;padding:11px 14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);border-bottom-left-radius:4px;opacity:0}
    .go .typing{animation:typing-window 1.5s .95s linear forwards}
    .typing i{width:6px;height:6px;border-radius:50%;background:var(--muted);animation:blink 1s infinite}
    .typing i:nth-child(2){animation-delay:.2s}
    .typing i:nth-child(3){animation-delay:.4s}
    @keyframes typing-window{0%{opacity:0;height:auto}8%{opacity:1}80%{opacity:1}100%{opacity:0;height:0;padding:0;border:0;margin:-5px 0 0}}
    @keyframes blink{0%,100%{opacity:.25}50%{opacity:1}}
    .go .chat-body .d4{animation-delay:2.55s}
    .go .chat-body .d5{animation-delay:3.35s}
    .go .chat-body .d6{animation-delay:4.4s}
    .chat-note{position:absolute;left:428px;top:150px;max-width:230px;font-size:12.5px;line-height:1.65;color:var(--muted);border-left:2px solid var(--primary);padding-left:16px}`;
}

// Meridian: dark instrument panel with mint readiness channel.
function consoleStyles() {
  return `
    .console-shell{height:370px;border:1px solid var(--border);border-radius:var(--r-lg);background:var(--surface);overflow:hidden;display:grid;grid-template-columns:125px 1fr;box-shadow:0 24px 64px rgba(0,0,0,.5)}
    .console-shell aside{padding:18px 13px;background:var(--bg);border-right:1px solid var(--border);display:flex;flex-direction:column;gap:9px}
    .console-shell aside b{width:31px;height:31px;border-radius:var(--r-sm);background:var(--primary);color:var(--on-primary);display:grid;place-items:center;margin-bottom:18px}
    .console-shell aside span{font-size:9.5px;color:var(--muted);padding:8px;border-radius:var(--r-sm)}
    .console-shell aside .active{color:var(--text);background:var(--surface-alt)}
    .console-shell main{padding:20px 22px}
    .console-head{display:flex;justify-content:space-between;align-items:center}
    .console-head small{font-size:9px;color:var(--primary);letter-spacing:.16em;font-weight:700}
    .console-head h3{margin:5px 0 0;font:700 23px var(--font-display);letter-spacing:-.03em}
    .orb{position:relative;width:64px;height:64px;border-radius:50%;background:conic-gradient(var(--primary) 0% 76%, color-mix(in srgb, var(--text) 8%, transparent) 76% 100%);display:grid;place-items:center}
    .orb:before{content:"";position:absolute;width:50px;height:50px;border-radius:50%;background:var(--surface)}
    .orb span{position:relative;font:700 18px var(--font-display);color:var(--primary)}
    .orb small{position:absolute;bottom:9px;font-size:6.5px;color:var(--muted);letter-spacing:.1em;text-transform:uppercase}
    .surface-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:20px}
    .surface-grid section{position:relative;padding:15px 14px 18px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--surface-alt);overflow:hidden}
    .surface-grid small{font-size:7.5px;letter-spacing:.14em;color:var(--muted);font-weight:700}
    .surface-grid b{display:block;margin-top:12px;font:700 19px var(--font-display);letter-spacing:-.02em}
    .surface-grid p{font-size:8.5px;color:var(--muted);line-height:1.5;margin:8px 0 0}
    .surface-grid .bar{position:absolute;left:0;right:0;bottom:0;height:3px;background:var(--c)}
    .design-strip{display:flex;align-items:center;gap:6px;margin-top:16px;padding:13px;border:1px solid var(--border);border-radius:var(--r-md)}
    .design-strip span{font-size:9.5px;color:var(--muted);margin-right:4px}
    .design-strip i{font-style:normal;font-size:8px;padding:6px 8px;border-radius:var(--r-sm);background:var(--surface-alt);color:var(--text)}
    .design-strip b{margin-left:auto;font-size:8.5px;color:var(--primary);font-family:var(--font-mono)}`;
}

function documentFor(scene, theme) {
  const fontLinks = theme.fontHref
    ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${theme.fontHref}">`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8">${fontLinks}<style>${baseStyles(theme)}${scene.style}</style></head><body><div class="frame"><header class="top"><div class="brand"><span class="mark">F</span>ForeverBetter API</div><span class="live"><i></i>Design contract <b>&nbsp;${escapeHtml(theme.name)}</b>&nbsp; from GET /design/systems</span></header><section class="intro"><div class="copy reveal d1"><span class="eyebrow">${escapeHtml(scene.eyebrow)}</span><h1>${escapeHtml(scene.title)}</h1><p>${escapeHtml(scene.subtitle)}</p></div><div class="content">${scene.body}</div></section><footer class="footer"><b>${escapeHtml(scene.footer)}</b><span>REST + MCP / provenance included</span></footer></div><script>document.fonts.ready.then(() => requestAnimationFrame(() => document.body.classList.add('go')));</script></body></html>`;
}

function command(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: root, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${binary} exited with code ${code}.`)));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const selected = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(selected));
    });
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shortId(value) {
  const text = String(value ?? 'pending');
  return text.length > 16 ? `${text.slice(0, 13)}...` : text;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

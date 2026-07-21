import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DashboardSpec } from '../types.js';
import type { DesignSystem } from './design-systems.js';

export interface PrivateDashboardLinkPayload {
  analysis_id: string;
  design_id: string;
  expires_at: string;
  snapshot_sha256: string;
}

export interface PrivateDashboardLinkResult {
  dashboard_url: string;
  analysis_id: string;
  design: { id: string; name: string; layout: DesignSystem['layout'] };
  visibility: 'private_by_possession';
  expires_at: string;
  sharing: {
    default: 'private';
    optional: true;
    note: string;
  };
}

export class DashboardLinkValidationError extends Error {}
export class DashboardLinkConfigurationError extends Error {}

interface SignedDashboardPayload {
  analysis_id: string;
  design_id: string;
  exp: number;
  nonce: string;
  snapshot_sha256: string;
}

export function createPrivateDashboardToken(
  analysisId: string,
  designId: string,
  expiresAt: Date,
  secret: string,
  snapshotSha256: string,
): string {
  const payload: SignedDashboardPayload = {
    analysis_id: analysisId,
    design_id: designId,
    exp: Math.floor(expiresAt.getTime() / 1000),
    nonce: randomBytes(18).toString('base64url'),
    snapshot_sha256: snapshotSha256,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded, secret)}`;
}

export function createPrivateDashboardLink(input: {
  analysisId: string;
  dashboardSpec: DashboardSpec;
  design: DesignSystem;
  expiresInDays?: number;
  secret?: string;
  baseUrl: string;
  requireHttps?: boolean;
  now?: number;
}): PrivateDashboardLinkResult {
  if (!input.secret) {
    throw new DashboardLinkConfigurationError('Private dashboard links require API_KEY_JWT_SECRET or SERVICE_ACCOUNT_JWT_SECRET.');
  }
  if (!input.baseUrl.trim()) {
    throw new DashboardLinkConfigurationError('Private dashboard links require PUBLIC_BASE_URL on HTTPS deployments.');
  }
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(input.baseUrl);
  } catch {
    throw new DashboardLinkConfigurationError('PUBLIC_BASE_URL must be a valid HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(parsedBaseUrl.protocol) || parsedBaseUrl.username || parsedBaseUrl.password) {
    throw new DashboardLinkConfigurationError('PUBLIC_BASE_URL must be a valid HTTP or HTTPS URL.');
  }
  if (input.requireHttps && parsedBaseUrl.protocol !== 'https:') {
    throw new DashboardLinkConfigurationError('PUBLIC_BASE_URL must use HTTPS for private dashboard links.');
  }
  const expiresInDays = input.expiresInDays ?? 30;
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 90) {
    throw new DashboardLinkValidationError('expires_in_days must be an integer from 1 to 90.');
  }
  const expiresAt = new Date((input.now ?? Date.now()) + expiresInDays * 86_400_000);
  const token = createPrivateDashboardToken(input.analysisId, input.design.id, expiresAt, input.secret, dashboardSpecDigest(input.dashboardSpec));
  const baseUrl = `${parsedBaseUrl.origin}${parsedBaseUrl.pathname.replace(/\/+$/, '')}`;
  return {
    dashboard_url: `${baseUrl}/dashboards/private/${encodeURIComponent(token)}`,
    analysis_id: input.analysisId,
    design: { id: input.design.id, name: input.design.name, layout: input.design.layout },
    visibility: 'private_by_possession',
    expires_at: expiresAt.toISOString(),
    sharing: {
      default: 'private',
      optional: true,
      note: 'Anyone with this unguessable URL can view this dashboard snapshot until it expires. Share it only with people you trust.',
    },
  };
}

export function verifyPrivateDashboardToken(token: string, secret: string): PrivateDashboardLinkPayload | undefined {
  const [encoded, suppliedSignature, extra] = token.split('.');
  if (!encoded || !suppliedSignature || extra) return undefined;
  const expectedSignature = sign(encoded, secret);
  const supplied = Buffer.from(suppliedSignature, 'base64url');
  const expected = Buffer.from(expectedSignature, 'base64url');
  if (supplied.toString('base64url') !== suppliedSignature) return undefined;
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<SignedDashboardPayload>;
    if (typeof payload.analysis_id !== 'string' || typeof payload.design_id !== 'string') return undefined;
    if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return undefined;
    if (typeof payload.nonce !== 'string' || payload.nonce.length < 16) return undefined;
    if (typeof payload.snapshot_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(payload.snapshot_sha256)) return undefined;
    return {
      analysis_id: payload.analysis_id,
      design_id: payload.design_id,
      expires_at: new Date(payload.exp * 1000).toISOString(),
      snapshot_sha256: payload.snapshot_sha256,
    };
  } catch {
    return undefined;
  }
}

export function dashboardSpecMatchesSnapshot(spec: DashboardSpec, expectedDigest: string): boolean {
  const supplied = Buffer.from(expectedDigest, 'hex');
  const actual = Buffer.from(dashboardSpecDigest(spec), 'hex');
  return supplied.length === actual.length && timingSafeEqual(supplied, actual);
}

export function renderPrivateDashboard(
  spec: DashboardSpec,
  design: DesignSystem & { design_md: string },
  expiresAt: string,
): string {
  const cards = spec.cards;
  const scored = cards.map(card => card.score).filter((score): score is number => Number.isFinite(score));
  const score = scored.length > 0 ? Math.round(scored.reduce((sum, value) => sum + value, 0) / scored.length) : undefined;
  const coverage = (spec.coverage ?? []).map(item => `
    <li class="coverage ${item.present ? 'present' : 'missing'}">
      <span>${escapeHtml(titleCase(item.modality))}</span>
      <strong>${item.present ? `${item.finding_count} findings` : 'Optional'}</strong>
    </li>`).join('');
  const cardHtml = cards.map(card => `
    <article class="metric-card" data-status="${escapeHtml(card.status ?? 'info')}">
      <div class="metric-head"><span>${escapeHtml(titleCase(card.category))}</span><span>${escapeHtml(card.confidence ?? 'context')}</span></div>
      <h2>${escapeHtml(card.title)}</h2>
      ${card.value != null ? `<p class="metric-value">${escapeHtml(formatNumber(card.value))}<small>${escapeHtml(card.unit ?? '')}</small></p>` : ''}
      ${card.score != null ? `<div class="score-track"><i style="width:${clamp(card.score, 0, 100)}%"></i></div>` : ''}
      ${card.summary ? `<p>${escapeHtml(card.summary)}</p>` : ''}
      ${card.action ? `<div class="next-step"><span>Next step</span>${escapeHtml(card.action)}</div>` : ''}
    </article>`).join('');
  const warnings = spec.quality?.warnings ?? [];
  const warningHtml = warnings.length > 0
    ? `<aside class="quality"><strong>Coverage note</strong>${warnings.map(item => `<p>${escapeHtml(item)}</p>`).join('')}</aside>`
    : '';
  const layout = design.layout;
  const heroValue = score == null ? 'Your baseline' : String(score);
  const heroLabel = layout?.score_word ?? 'Healthspan';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>${escapeHtml(design.name)} private health dashboard</title>
  <style>
    :root{--bg:${cssColor(design.colors.background)};--surface:${cssColor(design.colors.surface)};--surface2:${cssColor(design.colors.surface_alt)};--border:${cssColor(design.colors.border)};--text:${cssColor(design.colors.text)};--muted:${cssColor(design.colors.text_muted)};--primary:${cssColor(design.colors.primary)};--accent:${cssColor(design.colors.accent)};--positive:${cssColor(design.colors.positive)};--warning:${cssColor(design.colors.warning)};--negative:${cssColor(design.colors.negative)};--radius:${cssLength(design.radii.lg)};--shadow:${escapeCss(design.elevation[1] ?? design.elevation[0] ?? 'none')}}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:${escapeCss(design.typography.font_body)},ui-sans-serif,system-ui,-apple-system,sans-serif;line-height:1.5}body:before{content:"";position:fixed;inset:-20vh -10vw auto;height:55vh;background:radial-gradient(circle at 70% 20%,color-mix(in srgb,var(--primary) 22%,transparent),transparent 60%);pointer-events:none}main{position:relative;width:min(1180px,calc(100% - 32px));margin:auto;padding:28px 0 80px}.topbar{display:flex;justify-content:space-between;gap:20px;align-items:center;padding:10px 0 34px}.eyebrow,.metric-head,.next-step span{font-size:11px;font-weight:750;letter-spacing:.11em;text-transform:uppercase;color:var(--muted)}.private{display:inline-flex;gap:8px;align-items:center;border:1px solid var(--border);background:var(--surface);padding:8px 12px;border-radius:999px;font-size:12px}.private i{width:8px;height:8px;border-radius:50%;background:var(--positive);box-shadow:0 0 0 4px color-mix(in srgb,var(--positive) 18%,transparent)}.hero{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(260px,.6fr);gap:20px;margin-bottom:20px}.hero-copy,.hero-score{border:1px solid var(--border);background:color-mix(in srgb,var(--surface) 92%,transparent);box-shadow:var(--shadow);border-radius:var(--radius);padding:clamp(24px,4vw,52px)}h1{font-family:${escapeCss(design.typography.font_display)},ui-serif,Georgia,serif;font-size:clamp(42px,7vw,88px);line-height:.95;letter-spacing:-.055em;margin:12px 0 20px;max-width:850px}.hero-copy p{font-size:17px;color:var(--muted);max-width:680px}.hero-score{display:grid;place-items:center;text-align:center;overflow:hidden}.hero-score strong{display:grid;place-items:center;width:190px;aspect-ratio:1;border-radius:50%;font-size:58px;line-height:1;background:radial-gradient(circle,var(--surface) 56%,transparent 58%),conic-gradient(var(--primary) ${score ?? 68}%,var(--surface2) 0);box-shadow:inset 0 0 0 1px var(--border)}.hero-score span{display:block;margin-top:16px;color:var(--muted)}.coverage-list{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:0;margin:0 0 20px;list-style:none}.coverage{display:flex;justify-content:space-between;gap:12px;padding:16px 18px;border:1px solid var(--border);border-radius:${cssLength(design.radii.md)};background:var(--surface);font-size:13px}.coverage strong{color:var(--muted);font-weight:600}.coverage.present strong{color:var(--positive)}.quality{border:1px solid color-mix(in srgb,var(--warning) 45%,var(--border));background:color-mix(in srgb,var(--warning) 10%,var(--surface));padding:18px 20px;border-radius:${cssLength(design.radii.md)};margin-bottom:20px}.quality p{margin:4px 0;color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.metric-card{min-height:260px;border:1px solid var(--border);border-radius:${cssLength(design.radii.md)};background:var(--surface);padding:22px;box-shadow:var(--shadow)}.metric-card h2{font-size:22px;line-height:1.15;margin:20px 0 10px}.metric-card>p{color:var(--muted)}.metric-head{display:flex;justify-content:space-between;gap:8px}.metric-value{font-size:36px!important;color:var(--text)!important;margin:10px 0}.metric-value small{font-size:13px;margin-left:6px;color:var(--muted)}.score-track{height:7px;background:var(--surface2);border-radius:99px;overflow:hidden;margin:14px 0}.score-track i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--accent),var(--primary))}.next-step{margin-top:18px;padding-top:16px;border-top:1px solid var(--border);font-size:14px}.next-step span{display:block;margin-bottom:6px}.foot{display:flex;justify-content:space-between;gap:20px;margin-top:32px;padding-top:20px;border-top:1px solid var(--border);color:var(--muted);font-size:12px}.foot p{margin:0;max-width:680px}
    body[data-hero="lab-table"] .grid{grid-template-columns:1fr}body[data-hero="lab-table"] .metric-card{min-height:auto;display:grid;grid-template-columns:1fr .7fr 1.5fr;gap:18px;align-items:center}body[data-hero="lab-table"] .metric-card h2{margin:0}body[data-hero="card-grid"] .hero-score{display:none}body[data-hero="card-grid"] .hero{grid-template-columns:1fr}body[data-hero="breathing-orb"] .hero-score strong{animation:breathe 6s ease-in-out infinite;background:radial-gradient(circle at 35% 30%,var(--accent),var(--primary) 45%,var(--surface2) 72%)}@keyframes breathe{50%{transform:scale(1.08);filter:brightness(1.12)}}@media(prefers-reduced-motion:reduce){*{animation:none!important}}@media(max-width:850px){.hero{grid-template-columns:1fr}.coverage-list{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr 1fr}body[data-hero="lab-table"] .metric-card{grid-template-columns:1fr}}@media(max-width:560px){main{width:min(100% - 20px,1180px)}.topbar{align-items:flex-start;flex-direction:column}.coverage-list,.grid{grid-template-columns:1fr}.hero-copy,.hero-score{padding:24px}.hero-score strong{width:150px}.foot{flex-direction:column}}
  </style>
</head>
<body data-hero="${escapeHtml(layout?.hero ?? 'card-grid')}">
  <main>
    <header class="topbar"><div><div class="eyebrow">Wellnizz · ${escapeHtml(design.name)}</div></div><div class="private"><i></i>Private link · expires ${escapeHtml(formatDate(expiresAt))}</div></header>
    <section class="hero">
      <div class="hero-copy"><div class="eyebrow">${escapeHtml(layout?.voice ?? 'personal')} dashboard</div><h1>Your wellness data, made useful.</h1><p>${escapeHtml(layout?.summary ?? design.vibe)} Built from the data currently connected; add context when it becomes useful.</p></div>
      <div class="hero-score"><div><strong>${escapeHtml(heroValue)}</strong><span>${escapeHtml(heroLabel)}</span></div></div>
    </section>
    <ul class="coverage-list">${coverage}</ul>
    ${warningHtml}
    <section class="grid">${cardHtml || '<article class="metric-card"><h2>Your dashboard is ready for data</h2><p>Connect one source to populate the first useful view.</p></article>'}</section>
    <footer class="foot"><p>${escapeHtml(spec.provenance.clinical_boundary)}</p><p>Generated ${escapeHtml(formatDate(spec.generated_at))} · This URL grants view access to this snapshot. Share it only with people you trust.</p></footer>
  </main>
</body>
</html>`;
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function dashboardSpecDigest(spec: DashboardSpec): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex');
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]!);
}

function escapeCss(value: string): string {
  return value.replace(/[{};<>]/g, '');
}

function cssColor(value: string): string {
  return /^#[0-9a-f]{3,8}$/i.test(value) ? value : '#111827';
}

function cssLength(value: string): string {
  return /^\d+(?:\.\d+)?(?:px|rem|em|%)$/.test(value) ? value : '16px';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(date);
}

function titleCase(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
}

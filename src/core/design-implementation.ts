import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MERIDIAN_ROOT = join(process.cwd(), 'public', 'design-systems', 'meridian');
const DESIGN_SPECIFICATIONS_ROOT = join(process.cwd(), 'public', 'design-system-specs');
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/liveforeverbetter/foreverbetter/main/public/design-system-specs';

export async function getDesignImplementation(id: string, baseUrl: string) {
  if (id === 'aperture') {
    const zipUrl = `${GITHUB_RAW_BASE}/aperture-handoff.zip`;
    const meta = await loadDesignMeta('aperture');
    return {
      schema_version: '1.0',
      id: 'aperture',
      name: 'Aperture design-system handoff',
      description: 'The complete Aperture component, token, template, and UI-kit specification. Download the full ZIP from the supplied URL.',
      format: 'design_system_handoff',
      download: { url: zipUrl, format: 'zip', size_bytes: await zipSize('aperture') },
      ...meta,
    };
  }

  if (id === 'meridian') {
    const zipUrl = `${GITHUB_RAW_BASE}/meridian-handoff.zip`;
    const meta = await loadDesignMeta('meridian');
    const sourceBase = `${baseUrl.replace(/\/$/, '')}/dashboard`;
    return {
      schema_version: '1.0',
      id: 'meridian',
      name: 'Meridian design-system handoff + wearable dashboard',
      description: 'The complete Meridian component, token, template, and UI-kit specification. Download the full ZIP from the supplied URL. Also includes the production dashboard source.',
      format: 'design_system_handoff',
      download: { url: zipUrl, format: 'zip', size_bytes: await zipSize('meridian') },
      ...meta,
      production_dashboard: {
        entrypoint: 'dashboard/index.html',
        framework: 'vanilla_html_css_javascript',
        components: [
          component('app_shell', '#app-shell', 'Authenticated dashboard shell and route container.'),
          component('auth_shell', '#auth-shell', 'Agent-first sign-in and workspace-key handoff.'),
          component('healthspan_readiness', '.meridian-readiness-card', 'Connection-backed health-context readiness orb; it never invents health values.'),
          component('whoop_provider_card', '.meridian-whoop-card', 'WHOOP OAuth connection CTA plus recovery, strain, and sleep visual channels.'),
          component('source_status_card', '.source-card', 'Provider status card populated from persisted connections.'),
          component('agent_context', '.agent-context-card', 'MCP-ready health context and available agent tools.'),
        ],
        data_bindings: [
          { component: 'healthspan_readiness', endpoint: 'GET /connections/wearables/status', fields: ['connections[].source_provider', 'connections[].status', 'connections[].last_synced_at'], behaviour: 'app.js computes readiness from real connected providers.' },
          { component: 'whoop_provider_card', endpoint: 'POST /connections/wearables/start', fields: ['authorization_url'], behaviour: 'app.js starts first-party WHOOP OAuth and redirects the browser.' },
          { component: 'source_status_card', endpoint: 'GET /connections/wearables/status', fields: ['connections[].webhook_sync_enabled', 'connections[].server_sync_enabled'], behaviour: 'app.js renders connected and automatic-update state.' },
          { component: 'agent_context', endpoint: 'GET /dashboard-specs/{analysis_id}', fields: ['cards', 'sections', 'coverage', 'quality', 'provenance'], behaviour: 'Use this data contract for a personalized analysis dashboard.' },
        ],
        files: [
          designFile('dashboard/index.html', 'text/html; charset=utf-8', await readFile(join(MERIDIAN_ROOT, 'index.html'), 'utf8')),
          designFile('dashboard/styles.css', 'text/css; charset=utf-8', await readFile(join(MERIDIAN_ROOT, 'styles.css'), 'utf8')),
          designFile('dashboard/app.js', 'application/javascript; charset=utf-8', await readFile(join(MERIDIAN_ROOT, 'app.js'), 'utf8')),
        ],
        binary_assets: [
          { path: 'dashboard/favicon.svg', media_type: 'image/svg+xml', url: `${sourceBase}/favicon.svg` },
          { path: 'dashboard/assets/tablet-dashboard.png', media_type: 'image/png', url: `${sourceBase}/assets/tablet-dashboard.png` },
        ],
        install: {
          instruction: 'Write files exactly at the supplied paths, download binary_assets to their listed paths, and serve the dashboard directory at /dashboard on the same wellnizz API origin.',
          required_routes: ['/auth/otp/start', '/auth/otp/verify', '/api-keys', '/capabilities', '/connections/wearables/start', '/connections/wearables/status', '/connections/wearables/callback', '/dashboard-specs/{analysis_id}'],
        },
      },
    };
  }

  if (id === 'foreverbetter') {
    const zipUrl = `${GITHUB_RAW_BASE}/foreverbetter-handoff.zip`;
    const meta = await loadDesignMeta('foreverbetter');
    return {
      schema_version: '1.0',
      id: 'foreverbetter',
      name: 'Wellnizz Healthspan Dossier — house design system',
      description: 'The complete Wellnizz component, token, template, and voice specification. Download the full ZIP from the supplied URL.',
      format: 'design_system_handoff',
      download: { url: zipUrl, format: 'zip', size_bytes: await zipSize('foreverbetter') },
      ...meta,
      voice: {
        philosophy: 'Evidence-first, empathetic, editorial. Every insight pins to a measurement. No fabricated scores. Placeholder sections signal missing data.',
        tone: 'Confident health coach who reads the literature. Warm but never cloying. Numbers-first, narrative-second.',
        rules: [
          'Every data point must trace to a measurement or genetic variant the user has actually provided',
          'Missing data → placeholder section with a clear CTA to connect the relevant source',
          'Sentence case everywhere except the lone "Become a Member" CTA',
          'No exclamation marks. No emoji. Brand is "wellnizz" lowercase, one word.',
          'Risk encoded via top-left pill badge + score color, never left-border accent cards',
          'One gradient maximum per surface: the GLI ring',
          'Tabular numerals on every score, price, percentage, currency',
          'Always include the medical disclaimer verbatim in any complete deliverable',
        ],
      },
      template: {
        entrypoint: 'templates/foreverbetter-dashboard/ForeverbetterDashboard.dc.html',
        instruction: 'Unzip the handoff. The dashboard template is at templates/foreverbetter-dashboard/. Render the full template with real user data, substituting live wellnizz API values for every {{placeholder}}. When the user lacks data for a section, render it as an empty-state card with a CTA to connect the missing source. The GLI ring, category grid, superpower cards, finding cells, action plan, and protocols must all stand independently.',
        data_contract_path: 'GET /dashboard-specs/{analysis_id}',
        prompt_injection: `Implement the full Wellnizz dashboard template. Use all available data the user has stored with wellnizz — genetics, biomarkers, wearables, and health context. For any data the user hasn't provided, render a placeholder card with a clear call-to-action to connect that data source (e.g. "Connect your WHOOP", "Upload blood work", "Add a DNA file"). Every section and overview must stand on its own with the data available. Never fabricate scores or invent plausible-looking metrics. The GLI ring, modality coverage chart, superpower cards, biomarker rows, trait cards, findings cells, action plan items, and protocols are the canonical section order — preserve it.`,
      },
    };
  }

  return undefined;
}

async function loadDesignMeta(id: string) {
  const root = join(DESIGN_SPECIFICATIONS_ROOT, id);
  try {
    const manifestRaw = await readFile(join(root, '_ds_manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
    return {
      components: manifestArray(manifest, 'components'),
      templates: manifestArray(manifest, 'templates'),
      starting_points: manifestArray(manifest, 'startingPoints'),
    };
  } catch {
    return { components: [], templates: [], starting_points: [] };
  }
}

async function zipSize(id: string): Promise<number> {
  try {
    const s = await stat(join(DESIGN_SPECIFICATIONS_ROOT, `${id}-handoff.zip`));
    return s.size;
  } catch { return 0; }
}

function manifestArray(manifest: Record<string, unknown>, key: string): unknown[] {
  const value = manifest[key];
  return Array.isArray(value) ? value : [];
}

function designFile(path: string, mediaType: string, contents: string) {
  return { path, media_type: mediaType, contents, sha256: createHash('sha256').update(contents).digest('hex') };
}

function component(type: string, selector: string, description: string) {
  return { type, selector, description };
}

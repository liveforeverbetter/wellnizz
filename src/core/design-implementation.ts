import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MERIDIAN_ROOT = join(process.cwd(), 'public', 'design-systems', 'meridian');

type DesignFile = {
  path: string;
  media_type: string;
  contents: string;
  sha256: string;
};

/**
 * The Meridian-skinned dashboard source, packaged for coding agents. This is
 * deliberately files rather than generated React or opaque component JSON: an
 * agent can write the files, serve them at /dashboard, and obtain the same UI
 * and connection behaviour. The files are a pinned snapshot; the hosted
 * account dashboard itself uses the ForeverBetter brand identity.
 */
export async function getDesignImplementation(id: string, baseUrl: string) {
  if (id !== 'meridian') return undefined;

  const [html, css, javascript] = await Promise.all([
    readFile(join(MERIDIAN_ROOT, 'index.html'), 'utf8'),
    readFile(join(MERIDIAN_ROOT, 'styles.css'), 'utf8'),
    readFile(join(MERIDIAN_ROOT, 'app.js'), 'utf8'),
  ]);
  const sourceBase = `${baseUrl.replace(/\/$/, '')}/dashboard`;
  const files = [
    designFile('dashboard/index.html', 'text/html; charset=utf-8', html),
    designFile('dashboard/styles.css', 'text/css; charset=utf-8', css),
    designFile('dashboard/app.js', 'application/javascript; charset=utf-8', javascript),
  ];

  return {
    schema_version: '1.0',
    id: 'meridian',
    name: 'Meridian wearable dashboard implementation',
    description: 'A WHOOP-inspired wearable-performance dashboard for recovery, strain, sleep, and source-aware healthspan context. It is an independent ForeverBetter implementation, not affiliated with or endorsed by WHOOP.',
    inspired_by: 'WHOOP wearable-performance information architecture',
    format: 'production_files',
    entrypoint: 'dashboard/index.html',
    framework: 'vanilla_html_css_javascript',
    files,
    binary_assets: [
      { path: 'dashboard/favicon.svg', media_type: 'image/svg+xml', url: `${sourceBase}/favicon.svg` },
      { path: 'dashboard/assets/tablet-dashboard.png', media_type: 'image/png', url: `${sourceBase}/assets/tablet-dashboard.png` },
    ],
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
    install: {
      instruction: 'Write files exactly at the supplied paths, download binary_assets to their listed paths, and serve the dashboard directory at /dashboard on the same ForeverBetter API origin. Do not substitute mock health values: retain the supplied endpoint bindings and app.js state handling.',
      required_routes: ['/auth/otp/start', '/auth/otp/verify', '/api-keys', '/capabilities', '/connections/wearables/start', '/connections/wearables/status', '/connections/wearables/callback', '/dashboard-specs/{analysis_id}'],
    },
  };
}

function designFile(path: string, mediaType: string, contents: string): DesignFile {
  return {
    path,
    media_type: mediaType,
    contents,
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}

function component(type: string, selector: string, description: string) {
  return { type, selector, description };
}

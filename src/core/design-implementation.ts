import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const MERIDIAN_ROOT = join(process.cwd(), 'public', 'design-systems', 'meridian');
const DESIGN_SPECIFICATIONS_ROOT = join(process.cwd(), 'public', 'design-system-specs');
const DESIGN_SPECIFICATION_IDS = new Set(['aperture', 'meridian', 'foreverbetter']);

type DesignFile = {
  path: string;
  media_type: string;
  contents: string;
  sha256: string;
};

type DesignSpecificationFile = DesignFile & { url: string };

type DesignSpecification = {
  schema_version: '1.0';
  id: string;
  format: 'design_system_handoff';
  root_url: string;
  readme_path: string;
  manifest: Record<string, unknown>;
  files: DesignSpecificationFile[];
  binary_assets: Array<{ path: string; media_type: string; url: string; sha256: string }>;
  excluded: string[];
};

/**
 * The Meridian-skinned dashboard source, packaged for coding agents. This is
 * deliberately files rather than generated React or opaque component JSON: an
 * agent can write the files, serve them at /dashboard, and obtain the same UI
 * and connection behaviour. The files are a pinned snapshot; the hosted
 * account dashboard itself uses the ForeverBetter brand identity.
 */
export async function getDesignImplementation(id: string, baseUrl: string) {
  const specification = await getDesignSpecification(id, baseUrl);
  if (!specification) return undefined;

  if (id === 'aperture') {
    return {
      schema_version: '1.0',
      id: 'aperture',
      name: 'Aperture full design-system handoff',
      description: 'The complete Aperture component, token, template, and UI-kit specification. UI-kit data is illustrative only and must be replaced with scoped wellnizz API data.',
      format: 'design_system_handoff',
      entrypoint: specification.readme_path,
      files: specification.files,
      binary_assets: specification.binary_assets,
      components: manifestArray(specification.manifest, 'components'),
      templates: manifestArray(specification.manifest, 'templates'),
      starting_points: manifestArray(specification.manifest, 'startingPoints'),
      design_specification: specification,
    };
  }

  if (id === 'foreverbetter') {
    return {
      schema_version: '1.0',
      id: 'foreverbetter',
      name: 'wellnizz Healthspan Dossier — full design system',
      description: 'The house design system for wellnizz. A warm-paper editorial healthspan dossier with the full component library, tokens, layout sections, component definitions, metrics, modalities, responsive rules, animations, action plan guidance, and data capture patterns. Code-defined from the live API, not from an external handoff.',
      format: 'design_system_handoff',
      entrypoint: specification.readme_path,
      files: specification.files,
      binary_assets: specification.binary_assets,
      components: manifestArray(specification.manifest, 'components'),
      templates: manifestArray(specification.manifest, 'templates'),
      starting_points: manifestArray(specification.manifest, 'startingPoints'),
      design_specification: specification,
    };
  }

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
    description: 'A WHOOP-inspired wearable-performance dashboard for recovery, strain, sleep, and source-aware healthspan context. It is an independent wellnizz implementation, not affiliated with or endorsed by WHOOP.',
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
      instruction: 'Write files exactly at the supplied paths, download binary_assets to their listed paths, and serve the dashboard directory at /dashboard on the same wellnizz API origin. Do not substitute mock health values: retain the supplied endpoint bindings and app.js state handling.',
      required_routes: ['/auth/otp/start', '/auth/otp/verify', '/api-keys', '/capabilities', '/connections/wearables/start', '/connections/wearables/status', '/connections/wearables/callback', '/dashboard-specs/{analysis_id}'],
    },
    design_specification: specification,
  };
}

async function getDesignSpecification(id: string, baseUrl: string): Promise<DesignSpecification | undefined> {
  if (!DESIGN_SPECIFICATION_IDS.has(id)) return undefined;
  const root = join(DESIGN_SPECIFICATIONS_ROOT, id);
  const files = await listFiles(root);
  const sourceBase = `${baseUrl.replace(/\/$/, '')}/design-system-specs/${encodeURIComponent(id)}`;
  const textFiles: DesignSpecificationFile[] = [];
  const binaryAssets: DesignSpecification['binary_assets'] = [];

  for (const file of files) {
    const relativePath = relative(root, file).split('\\').join('/');
    const assetUrl = `${sourceBase}/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
    const contents = await readFile(file);
    const sha256 = createHash('sha256').update(contents).digest('hex');
    if (isTextFile(relativePath)) {
      textFiles.push({
        path: `design-system/${relativePath}`,
        media_type: mediaType(relativePath),
        contents: contents.toString('utf8'),
        sha256,
        url: assetUrl,
      });
    } else {
      binaryAssets.push({
        path: `design-system/${relativePath}`,
        media_type: mediaType(relativePath),
        url: assetUrl,
        sha256,
      });
    }
  }

  const manifestFile = textFiles.find(file => file.path === 'design-system/_ds_manifest.json');
  if (!manifestFile) throw new Error(`Design specification manifest missing for ${id}.`);
  return {
    schema_version: '1.0',
    id,
    format: 'design_system_handoff',
    root_url: sourceBase,
    readme_path: 'design-system/README.md',
    manifest: JSON.parse(manifestFile.contents) as Record<string, unknown>,
    files: textFiles,
    binary_assets: binaryAssets,
    excluded: ['uploads/ (reference material and sample imagery excluded from the public handoff)'],
  };
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }));
  return nested.flat().sort();
}

function isTextFile(path: string): boolean {
  return new Set(['.css', '.d.ts', '.html', '.js', '.json', '.jsx', '.md', '.svg', '.ts']).has(extension(path));
}

function extension(path: string): string {
  return path.endsWith('.d.ts') ? '.d.ts' : extname(path).toLowerCase();
}

function mediaType(path: string): string {
  const types: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.d.ts': 'text/plain; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.jsx': 'application/javascript; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.ts': 'text/plain; charset=utf-8',
    '.ttf': 'font/ttf',
  };
  return types[extension(path)] ?? 'application/octet-stream';
}

function manifestArray(manifest: Record<string, unknown>, key: string): unknown[] {
  const value = manifest[key];
  return Array.isArray(value) ? value : [];
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

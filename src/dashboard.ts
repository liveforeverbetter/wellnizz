import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { securityHeaders, type AuthConfig } from './auth.js';

const DASHBOARD_ROOT = join(process.cwd(), 'public', 'dashboard');
const DESIGN_SYSTEM_SPECS_ROOT = join(process.cwd(), 'public', 'design-system-specs');
// Served at /SKILL.md. The canonical agent skill lives in skills/wellnizz/ (a
// self-contained folder installable with `npx skills add`), and is served from
// there so there is a single source of truth with no duplicate copy.
const PUBLIC_SKILL_PATH = join(process.cwd(), 'skills', 'wellnizz', 'SKILL.md');
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.jsx': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.md': 'text/markdown; charset=utf-8',
};

export async function serveDashboardAsset(req: IncomingMessage, res: ServerResponse, config: AuthConfig, pathname: string): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const assetPath = assetPathFor(pathname);
  if (!assetPath) return false;

  try {
    const body = await readFile(assetPath);
    const contentType = CONTENT_TYPES[extension(assetPath)] ?? 'application/octet-stream';
    const cacheable = !assetPath.endsWith('index.html');
    res.writeHead(200, {
      ...securityHeaders(config, req.headers.origin),
      'content-type': contentType,
      'cache-control': cacheable ? 'public, max-age=300, stale-while-revalidate=300' : 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, {
      ...securityHeaders(config, req.headers.origin),
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify({ error: 'Dashboard asset not found.' }));
  }
  return true;
}

function assetPathFor(pathname: string): string | undefined {
  if (pathname.toLowerCase() === '/skill.md') return PUBLIC_SKILL_PATH;
  if (pathname === '/dashboard' || pathname === '/dashboard/') return join(DASHBOARD_ROOT, 'index.html');
  if (pathname.startsWith('/dashboard/')) return publicAssetPath(DASHBOARD_ROOT, pathname.slice('/dashboard/'.length));
  if (pathname.startsWith('/design-system-specs/')) return publicAssetPath(DESIGN_SYSTEM_SPECS_ROOT, pathname.slice('/design-system-specs/'.length));
  return undefined;
}

function publicAssetPath(root: string, relative: string): string | undefined {
  if (!relative || relative.includes('\0')) return undefined;
  const candidate = normalize(join(root, relative));
  return candidate.startsWith(`${root}/`) ? candidate : undefined;
}

function extension(pathname: string): string {
  const match = pathname.match(/\.[^.]+$/);
  return match?.[0] ?? '';
}

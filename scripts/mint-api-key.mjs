#!/usr/bin/env node
// Mint a long-lived API-key JWT the ForeverBetter API accepts via its API-key auth path
// (src/auth.ts → authenticateApiKey). The token is HS256-signed with
// API_KEY_JWT_SECRET and carries token_type=api_key plus scope / enabled_endpoints
// / organization_id claims, so it works regardless of AUTH_MODE and satisfies the
// strict endpoint + organization claim requirements.
//
// Usage:
//   API_KEY_JWT_SECRET=... node scripts/mint-api-key.mjs \
//     --out .secrets/prod-admin-token.txt \
//     --sub agent-admin-01 --org foreverbetter --scope health:admin --days 365
//
// The full token is written to --out (never printed). Decoded claims are printed
// for confirmation. Keep the output file out of git (.secrets/ is gitignored).

import { writeFileSync } from 'node:fs';
import { SignJWT } from 'jose';

// Canonical endpoint catalogue (mirrors the sandbox token set in src/auth.ts).
const ALL_ENDPOINTS = [
  'imports.file', 'capabilities.read', 'pricing.read', 'api_keys.create',
  'webhooks.read', 'analyses.create', 'analyses.read', 'genetics.ancestry.create', 'genetics.jobs.read',
  'biomarkers.derive', 'biomarkers.analyze', 'wearables.analyze', 'genetics.analyze',
  'dashboard_specs.read', 'health_context.read', 'query.create', 'labs.search',
  'connections.start', 'connections.callback', 'connections.auth_url',
  'connections.sync', 'connections.jobs.read', 'data.export', 'data.delete',
];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const secret = process.env.API_KEY_JWT_SECRET;
if (!secret) {
  console.error('ERROR: API_KEY_JWT_SECRET must be set in the environment.');
  process.exit(1);
}

const out = arg('out', '.secrets/api-key-token.txt');
const sub = arg('sub', 'agent-admin-01');
const userId = arg('user', sub);
const org = arg('org', 'foreverbetter');
const scope = arg('scope', 'health:admin');
const audience = arg('aud', (process.env.AUTH_AUDIENCE ?? 'foreverbetter-api').split(',')[0].trim());
const issuer = arg('iss', process.env.AUTH_ISSUER ?? undefined);
const days = Number(arg('days', '365'));

const now = Math.floor(Date.now() / 1000);
const exp = now + days * 24 * 60 * 60;

const claims = {
  token_type: 'api_key',
  aud: audience,
  sub,
  user_id: userId,
  scope,
  enabled_endpoints: ALL_ENDPOINTS,
  organization_id: org,
  iat: now,
  exp,
};
if (issuer) claims.iss = issuer;

const token = await new SignJWT(claims)
  .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
  .sign(new TextEncoder().encode(secret));

// `--out -` writes the token to stdout (handy for `docker compose exec`); any
// other value writes to that file with 0600. Informational output goes to
// stderr either way so stdout stays clean for piping.
const { token_type, ...printable } = claims;
console.error('Minted API-key JWT.');
console.error('Claims:', JSON.stringify({ token_type, ...printable, enabled_endpoints: `[${ALL_ENDPOINTS.length} endpoints]` }, null, 2));
console.error('Expires:', new Date(exp * 1000).toISOString());

if (out === '-') {
  process.stdout.write(token + '\n');
} else {
  writeFileSync(out, token + '\n', { mode: 0o600 });
  console.error('Token written to ' + out + ' (not printed).');
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { DEFAULT_USER_DATA_READ_ENDPOINTS, normalizeEndpointId, type EndpointId } from './endpoints.js';

export type AuthMode = 'oidc' | 'service_account' | 'test_token' | 'disabled';
export type AuthScope =
  | 'health:data:read'
  | 'health:data:write'
  | 'health:connections:write'
  | 'health:labs:read'
  | 'health:admin';

export interface AuthConfig {
  mode: AuthMode;
  issuer?: string;
  audience?: string | string[];
  jwksUri?: string;
  algorithms: string[];
  allowedOrigins: string[];
  allowedOriginPatterns: RegExp[];
  requireHttps: boolean;
  maxBodyBytes: number;
  routeOverrides: Map<string, RouteConfigOverride>;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  enabledEndpoints: Set<string>;
  requireEnabledEndpointClaim: boolean;
  /** Allow read-only access to the authenticated user's wellness data without per-endpoint grants. Defaults to true. */
  fullUserDataReadByDefault?: boolean;
  requireOrganizationClaim: boolean;
  /** Narrow hosted billing bypass; does not grant health:admin or data access. */
  billingAdminEmails: Set<string>;
  billingAdminUserIds: Set<string>;
  /**
   * Full administrative grant. Any authenticated token whose verified email
   * claim matches receives the health:admin scope, including API keys minted
   * from that identity. Operator emails only; keep it a deployment secret.
   */
  adminEmails: Set<string>;
  testToken?: string;
  serviceAccountSecret?: string;
  apiKeySecret?: string;
  publicSandbox?: boolean;
  // First-party wearable OAuth apps. When set, a signed-up user can connect
  // without supplying developer credentials - the server fills them in.
  whoopOAuth?: { clientId: string; clientSecret: string; defaultRedirectUri?: string };
  ouraOAuth?: { clientId: string; clientSecret: string; defaultRedirectUri?: string };
}

export interface RouteConfigOverride {
  maxBodyBytes?: number;
  rateLimitWindowMs?: number;
  rateLimitMax?: number;
}

export interface AuthContext {
  subject: string;
  userId: string;
  scopes: Set<string>;
  enabledEndpoints?: Set<string>;
  organizationIds?: Set<string>;
  claims: JWTPayload;
  mode: AuthMode | 'api_key' | 'x402';
}

export class AuthError extends Error {
  constructor(public status: 401 | 403, message: string) {
    super(message);
  }
}

const DEFAULT_ALGORITHMS = ['RS256', 'ES256'];
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const mode = (env.AUTH_MODE ?? (env.NODE_ENV === 'production' ? 'oidc' : 'disabled')) as AuthMode;
  if (mode !== 'oidc' && mode !== 'service_account' && mode !== 'test_token' && mode !== 'disabled') {
    throw new Error('AUTH_MODE must be "oidc", "service_account", "test_token", or "disabled".');
  }
  if (env.NODE_ENV === 'production' && mode !== 'oidc' && mode !== 'service_account') {
    throw new Error('Production deployment requires AUTH_MODE=oidc or AUTH_MODE=service_account.');
  }
  // Never let the synthetic sandbox (which mints unauthenticated demo sessions)
  // run in production.
  if (env.NODE_ENV === 'production' && env.HEALTH_API_PUBLIC_SANDBOX === 'true') {
    throw new Error('HEALTH_API_PUBLIC_SANDBOX must not be enabled in production.');
  }
  const issuer = env.AUTH_ISSUER;
  const audience = parseAudience(env.AUTH_AUDIENCE);
  if ((mode === 'oidc' || mode === 'service_account') && !audience) {
    throw new Error('AUTH_AUDIENCE is required when AUTH_MODE=oidc or AUTH_MODE=service_account.');
  }
  if (mode === 'oidc' && !issuer) {
    throw new Error('AUTH_ISSUER and AUTH_AUDIENCE are required when AUTH_MODE=oidc.');
  }
  if (mode === 'service_account' && !env.SERVICE_ACCOUNT_JWT_SECRET) {
    throw new Error('SERVICE_ACCOUNT_JWT_SECRET is required when AUTH_MODE=service_account.');
  }
  if (env.NODE_ENV === 'production') {
    if (mode === 'service_account') {
      assertProductionSecret('SERVICE_ACCOUNT_JWT_SECRET', env.SERVICE_ACCOUNT_JWT_SECRET);
    }
    if (env.API_KEY_JWT_SECRET) {
      assertProductionSecret('API_KEY_JWT_SECRET', env.API_KEY_JWT_SECRET);
    }
    assertProductionSecret('AUDIT_IP_HASH_SALT', env.AUDIT_IP_HASH_SALT);
  }
  const allowedOrigins = (env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const allowedOriginPatterns = parseRegexList(env.CORS_ALLOWED_ORIGIN_PATTERNS);
  // Empty means CORS is closed: no cross-origin browser client is allowed. The
  // same-origin dashboard and server-to-server/agent callers (which send no
  // Origin) still work, so this is a safe default rather than a hard error.
  if (env.NODE_ENV === 'production' && allowedOrigins.length === 0 && allowedOriginPatterns.length === 0) {
    console.warn(JSON.stringify({ ts: new Date().toISOString(), event: 'cors_closed', message: 'No CORS_ALLOWED_ORIGINS set; cross-origin browser requests are blocked. Set it to your dashboard origin to allow them.' }));
  }
  return {
    mode,
    issuer,
    audience,
    jwksUri: env.AUTH_JWKS_URI,
    algorithms: (env.AUTH_JWT_ALGORITHMS ?? DEFAULT_ALGORITHMS.join(','))
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
    allowedOrigins,
    allowedOriginPatterns,
    requireHttps: env.REQUIRE_HTTPS === 'true' || env.NODE_ENV === 'production',
    maxBodyBytes: Number(env.MAX_BODY_BYTES ?? String(10 * 1024 * 1024)),
    routeOverrides: parseRouteOverrides(env.HEALTH_API_ROUTE_OVERRIDES),
    rateLimitWindowMs: Number(env.RATE_LIMIT_WINDOW_MS ?? '60000'),
    rateLimitMax: Number(env.RATE_LIMIT_MAX ?? '120'),
    enabledEndpoints: parseEnabledEndpoints(env.HEALTH_API_ENABLED_ENDPOINTS ?? env.ENABLED_ENDPOINTS),
    requireEnabledEndpointClaim: env.REQUIRE_ENABLED_ENDPOINT_CLAIM === 'true',
    fullUserDataReadByDefault: env.AGENT_FULL_USER_DATA_READS !== 'false',
    requireOrganizationClaim: env.REQUIRE_ORGANIZATION_CLAIM === 'true',
    billingAdminEmails: normalizeEmailSet(env.HEALTH_API_BILLING_ADMIN_EMAILS),
    billingAdminUserIds: parseStringSet(env.HEALTH_API_BILLING_ADMIN_USER_IDS),
    adminEmails: normalizeEmailSet(env.HEALTH_API_ADMIN_EMAILS),
    testToken: env.TEST_BEARER_TOKEN,
    serviceAccountSecret: env.SERVICE_ACCOUNT_JWT_SECRET,
    apiKeySecret: env.API_KEY_JWT_SECRET ?? env.SERVICE_ACCOUNT_JWT_SECRET,
    publicSandbox: env.HEALTH_API_PUBLIC_SANDBOX === 'true',
    whoopOAuth: env.WHOOP_CLIENT_ID && env.WHOOP_CLIENT_SECRET
      ? { clientId: env.WHOOP_CLIENT_ID, clientSecret: env.WHOOP_CLIENT_SECRET, defaultRedirectUri: resolveOAuthRedirectUri(env.WHOOP_REDIRECT_URI, env.PUBLIC_BASE_URL, 'WHOOP_REDIRECT_URI') }
      : undefined,
    ouraOAuth: env.OURA_CLIENT_ID && env.OURA_CLIENT_SECRET
      ? { clientId: env.OURA_CLIENT_ID, clientSecret: env.OURA_CLIENT_SECRET, defaultRedirectUri: resolveOAuthRedirectUri(env.OURA_REDIRECT_URI, env.PUBLIC_BASE_URL, 'OURA_REDIRECT_URI') }
      : undefined,
  };
}

// The OAuth redirect URI must exactly match a URL pre-registered with the
// provider (WHOOP/Oura), and that URL must live at the app's public origin. An
// explicit *_REDIRECT_URI left over from a previous domain (e.g. after a rename)
// keeps a stale origin that no longer matches PUBLIC_BASE_URL, which the provider
// rejects with "redirect_uri does not match". Honor the explicit value only when
// its origin matches PUBLIC_BASE_URL; otherwise drop it so the request-time
// PUBLIC_BASE_URL derivation (`${base}/dashboard`) is used instead, keeping the
// redirect URI self-healing across domain changes.
export function resolveOAuthRedirectUri(explicit: string | undefined, publicBaseUrl: string | undefined, envName: string): string | undefined {
  const configured = explicit?.trim();
  if (!configured) return undefined;
  const base = publicBaseUrl?.trim();
  if (!base) return configured;
  let configuredOrigin: string;
  let baseOrigin: string;
  try {
    configuredOrigin = new URL(configured).origin;
    baseOrigin = new URL(base).origin;
  } catch {
    return configured;
  }
  if (configuredOrigin === baseOrigin) return configured;
  console.warn(JSON.stringify({
    ts: new Date().toISOString(),
    event: 'oauth_redirect_uri_origin_mismatch',
    env: envName,
    configured_origin: configuredOrigin,
    public_base_origin: baseOrigin,
    action: 'ignoring stale redirect URI and deriving from PUBLIC_BASE_URL',
  }));
  return undefined;
}

function assertProductionSecret(name: string, value: string | undefined): void {
  if (!value || value.length < 32 || /change[-_ ]?me|example|test[-_ ]?secret/i.test(value)) {
    throw new Error(`${name} must be a unique secret of at least 32 characters in production.`);
  }
}

export function securityHeaders(config: AuthConfig, origin?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'geolocation=(), microphone=(), camera=()',
    vary: 'Origin',
  };
  if (config.requireHttps) {
    headers['strict-transport-security'] = 'max-age=63072000; includeSubDomains; preload';
  }
  if (origin && isAllowedOrigin(config, origin)) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-headers'] = 'authorization, content-type, idempotency-key, x-request-id, payment-signature';
    headers['access-control-expose-headers'] = 'payment-required, payment-response, extension-responses';
    headers['access-control-allow-methods'] = 'GET, POST, DELETE, OPTIONS';
  }
  return headers;
}

export function primaryAuthAudience(config: Pick<AuthConfig, 'audience'>): string {
  if (Array.isArray(config.audience)) return config.audience[0] ?? 'foreverbetter-api';
  return config.audience ?? 'foreverbetter-api';
}

export function isAllowedOrigin(config: AuthConfig, origin: string): boolean {
  return config.allowedOrigins.includes(origin)
    || config.allowedOriginPatterns.some(pattern => pattern.test(origin));
}

export function bodyLimitForRoute(config: AuthConfig, method: string, path: string, fallback = config.maxBodyBytes): number {
  return routeOverride(config, method, path)?.maxBodyBytes ?? fallback;
}

export function rateLimitForRoute(config: AuthConfig, method: string, path: string): { windowMs: number; max: number } {
  const override = routeOverride(config, method, path);
  return {
    windowMs: override?.rateLimitWindowMs ?? config.rateLimitWindowMs,
    max: override?.rateLimitMax ?? config.rateLimitMax,
  };
}

export async function authenticate(req: IncomingMessage, config: AuthConfig): Promise<AuthContext> {
  if (config.mode === 'disabled') {
    return {
      subject: 'dev-user',
      userId: 'dev-user',
      scopes: new Set<AuthScope>(['health:data:read', 'health:data:write', 'health:connections:write', 'health:labs:read', 'health:admin']),
      enabledEndpoints: undefined,
      organizationIds: undefined,
      claims: {},
      mode: 'disabled',
    };
  }

  // The first-party mobile SDK sends durable scoped API keys in this header.
  // It is accepted only when the value verifies as one of our signed API-key
  // JWTs below; browser and agent access continues to use Bearer tokens.
  const token = bearerToken(req.headers.authorization) ?? mobileSdkApiKey(req.headers['x-foreverbetter-api-key']);
  if (!token) throw new AuthError(401, 'Missing Bearer access token or mobile SDK API key.');

  if (config.mode === 'test_token') {
    if (token !== config.testToken) throw new AuthError(401, 'Invalid sandbox bearer token.');
    return {
      subject: 'sandbox-agent',
      userId: 'sandbox-user',
      scopes: new Set<AuthScope>(['health:data:read', 'health:data:write', 'health:connections:write', 'health:labs:read']),
      enabledEndpoints: new Set(['imports.file', 'capabilities.read', 'pricing.read', 'api_keys.create', 'webhooks.read', 'analyses.create', 'analyses.read', 'biomarkers.derive', 'biomarkers.analyze', 'wearables.analyze', 'genetics.analyze', 'genetics.ancestry.create', 'genetics.jobs.read', 'dashboard_specs.read', 'dashboard_links.create', 'health_context.read', 'query.create', 'labs.search', 'connections.start', 'connections.callback', 'connections.auth_url', 'connections.sync', 'connections.jobs.read', 'data.export', 'data.delete']),
      organizationIds: new Set(['sandbox-org']),
      claims: {},
      mode: 'test_token',
    };
  }

  const apiKeyAuth = await authenticateApiKey(token, config);
  if (apiKeyAuth) return apiKeyAuth;

  let verified;
  try {
    verified = config.mode === 'service_account'
      ? await jwtVerify(token, new TextEncoder().encode(config.serviceAccountSecret!), {
        audience: config.audience,
        algorithms: ['HS256'],
      })
      : await jwtVerify(token, remoteJwks(config), {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: config.algorithms,
      });
  } catch {
    // jose throws for expired, malformed, and signature-invalid tokens. Keep
    // those failures on the authentication contract instead of letting them
    // fall through as an opaque 400 from the top-level request handler.
    throw new AuthError(401, 'Invalid or expired Bearer access token.');
  }
  const subject = verified.payload.sub;
  if (!subject) throw new AuthError(401, 'Token is missing sub claim.');
  return withAdminEmailGrant({
    subject,
    userId: userIdFromClaims(verified.payload, subject),
    scopes: scopesFromClaims(verified.payload),
    enabledEndpoints: enabledEndpointsFromClaims(verified.payload),
    organizationIds: organizationIdsFromClaims(verified.payload),
    claims: verified.payload,
    mode: config.mode,
  }, config);
}

/**
 * The email claim is trusted here because every accepted token is either
 * issued by the configured identity provider after an email sign-in or signed
 * by this deployment with the minting identity's email embedded.
 */
function withAdminEmailGrant(auth: AuthContext, config: Pick<AuthConfig, 'adminEmails'>): AuthContext {
  if (config.adminEmails.size === 0) return auth;
  const email = typeof auth.claims.email === 'string' ? auth.claims.email.trim().toLowerCase() : '';
  if (email && config.adminEmails.has(email)) auth.scopes.add('health:admin');
  return auth;
}

async function authenticateApiKey(token: string, config: AuthConfig): Promise<AuthContext | undefined> {
  if (!config.apiKeySecret || !config.audience) return undefined;
  try {
    const verified = await jwtVerify(token, new TextEncoder().encode(config.apiKeySecret), {
      audience: config.audience,
      algorithms: ['HS256'],
    });
    if ((verified.payload as Record<string, unknown>).token_type !== 'api_key') return undefined;
    const subject = verified.payload.sub;
    if (!subject) throw new AuthError(401, 'API key is missing sub claim.');
    return withAdminEmailGrant({
      subject,
      userId: userIdFromClaims(verified.payload, subject),
      scopes: scopesFromClaims(verified.payload),
      enabledEndpoints: enabledEndpointsFromClaims(verified.payload),
      organizationIds: organizationIdsFromClaims(verified.payload),
      claims: verified.payload,
      mode: 'api_key',
    }, config);
  } catch {
    return undefined;
  }
}

export async function probeAuthConfig(config: AuthConfig): Promise<{ ok: boolean; checks: Record<string, boolean | string | number> }> {
  const checks: Record<string, boolean | string | number> = {
    mode: config.mode,
    audience: config.mode === 'oidc' || config.mode === 'service_account' ? Boolean(config.audience) : 'not_required',
  };
  if (config.mode === 'oidc') {
    try {
      const jwksUrl = jwksUri(config);
      const response = await fetch(jwksUrl, { method: 'GET', headers: { accept: 'application/json' } });
      checks.jwks = response.ok;
      if (!response.ok) checks.jwks_status = response.status;
    } catch {
      checks.jwks = false;
    }
  }
  if (config.mode === 'service_account') checks.service_account_secret = Boolean(config.serviceAccountSecret);
  checks.api_key_secret = config.apiKeySecret ? true : 'not_configured';
  if (config.mode === 'test_token') checks.test_token = Boolean(config.testToken);
  return { ok: Object.values(checks).every(value => value !== false), checks };
}

export function hasScope(auth: AuthContext, scope: AuthScope): boolean {
  return auth.scopes.has('health:admin') || auth.scopes.has(scope);
}

/** Billing administration only bypasses hosted Stripe pricing checks. */
export function isBillingAdmin(auth: AuthContext, config: Pick<AuthConfig, 'billingAdminEmails' | 'billingAdminUserIds'>): boolean {
  if (config.billingAdminUserIds.has(auth.userId)) return true;
  const claims = auth.claims as Record<string, unknown>;
  if (claims.billing_admin === true) return true;
  const nested = claims.app_metadata;
  if (nested && typeof nested === 'object' && !Array.isArray(nested) && (nested as Record<string, unknown>).billing_admin === true) return true;
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  return Boolean(email && config.billingAdminEmails.has(email));
}

export function requireScope(auth: AuthContext, scope: AuthScope): void {
  if (hasScope(auth, scope)) return;
  throw new AuthError(403, `Missing required scope: ${scope}`);
}

export function isEndpointEnabled(auth: AuthContext, config: AuthConfig, endpointId: EndpointId): boolean {
  if (config.enabledEndpoints.size > 0 && !config.enabledEndpoints.has(endpointId)) return false;
  if (hasDefaultUserDataReadAccess(auth, config, endpointId)) return true;
  if (auth.enabledEndpoints && auth.enabledEndpoints.size > 0) return auth.enabledEndpoints.has(endpointId);
  return !config.requireEnabledEndpointClaim;
}

export function requireEndpointAccess(auth: AuthContext, config: AuthConfig, endpointId: EndpointId): void {
  if (config.enabledEndpoints.size > 0 && !config.enabledEndpoints.has(endpointId)) {
    throw new AuthError(403, `Endpoint is not enabled for this deployment: ${endpointId}`);
  }
  if (hasDefaultUserDataReadAccess(auth, config, endpointId)) return;
  if (auth.enabledEndpoints && auth.enabledEndpoints.size > 0 && !auth.enabledEndpoints.has(endpointId)) {
    throw new AuthError(403, `Token is not enabled for endpoint: ${endpointId}`);
  }
  if (config.requireEnabledEndpointClaim && (!auth.enabledEndpoints || !auth.enabledEndpoints.has(endpointId))) {
    throw new AuthError(403, `Token must explicitly enable endpoint: ${endpointId}`);
  }
}

function hasDefaultUserDataReadAccess(auth: AuthContext, config: AuthConfig, endpointId: EndpointId): boolean {
  return config.fullUserDataReadByDefault !== false
    && hasScope(auth, 'health:data:read')
    && DEFAULT_USER_DATA_READ_ENDPOINTS.has(endpointId);
}

export function requireUserAccess(auth: AuthContext, userId: string): void {
  if (auth.scopes.has('health:admin') || auth.userId === userId || auth.subject === userId) return;
  throw new AuthError(403, 'Token is not allowed to access this user resource.');
}

export function requireOrganizationAccess(auth: AuthContext, config: AuthConfig, organizationId?: string): void {
  if (auth.scopes.has('health:admin')) return;
  if (!organizationId) {
    throw new AuthError(403, 'organization_id is required for protected resources.');
  }
  if (!auth.organizationIds || auth.organizationIds.size === 0) {
    if (config.requireOrganizationClaim) throw new AuthError(403, 'Token must include an organization claim.');
    return;
  }
  if (!auth.organizationIds.has(organizationId)) {
    throw new AuthError(403, 'Token is not allowed to access this organization resource.');
  }
}

export function requireResourceAccess(
  auth: AuthContext,
  config: AuthConfig,
  resource: { userId: string; organizationId?: string },
): void {
  requireUserAccess(auth, resource.userId);
  requireOrganizationAccess(auth, config, resource.organizationId);
}

export function resolveOrganizationId(auth: AuthContext, config: AuthConfig, requestedOrganizationId?: string): string | undefined {
  if (requestedOrganizationId) {
    requireOrganizationAccess(auth, config, requestedOrganizationId);
    return requestedOrganizationId;
  }
  if (auth.scopes.has('health:admin')) return undefined;
  if (auth.organizationIds?.size === 1) return Array.from(auth.organizationIds)[0];
  throw new AuthError(403, 'organization_id is required when a token has multiple or no allowed organizations.');
}

export function assertHttps(req: IncomingMessage, config: AuthConfig): void {
  if (!config.requireHttps) return;
  const proto = req.headers['x-forwarded-proto'];
  const host = req.headers.host ?? '';
  const hostname = host.split(':')[0];
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  if (proto !== 'https' && !isLocalhost) {
    throw new AuthError(403, 'HTTPS is required.');
  }
}

function remoteJwks(config: AuthConfig): ReturnType<typeof createRemoteJWKSet> {
  const uri = jwksUri(config);
  const cached = jwksCache.get(uri);
  if (cached) return cached;
  const keySet = createRemoteJWKSet(new URL(uri));
  jwksCache.set(uri, keySet);
  return keySet;
}

function jwksUri(config: AuthConfig): string {
  return config.jwksUri ?? `${config.issuer!.replace(/\/$/, '')}/.well-known/jwks.json`;
}

function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function mobileSdkApiKey(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const token = value?.trim();
  return token || undefined;
}

function scopesFromClaims(payload: JWTPayload): Set<string> {
  const scopeClaim = typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : [];
  const permissions = Array.isArray((payload as { permissions?: unknown }).permissions)
    ? (payload as { permissions: unknown[] }).permissions.filter((value): value is string => typeof value === 'string')
    : [];
  const scp = Array.isArray((payload as { scp?: unknown }).scp)
    ? (payload as { scp: unknown[] }).scp.filter((value): value is string => typeof value === 'string')
    : [];
  return new Set([...scopeClaim, ...permissions, ...scp].filter(Boolean));
}

function enabledEndpointsFromClaims(payload: JWTPayload): Set<string> | undefined {
  const endpoints = valuesFromClaim(payload, 'health_enabled_endpoints')
    ?? valuesFromClaim(payload, 'enabled_endpoints')
    ?? valuesFromClaim(payload, 'allowed_endpoints')
    ?? valuesFromNestedClaim(payload, 'app_metadata', 'health_enabled_endpoints')
    ?? valuesFromNestedClaim(payload, 'app_metadata', 'enabled_endpoints')
    ?? valuesFromNestedClaim(payload, 'app_metadata', 'allowed_endpoints');
  if (!endpoints) return undefined;
  return parseEnabledEndpoints(endpoints);
}

function organizationIdsFromClaims(payload: JWTPayload): Set<string> | undefined {
  const organizations = valuesFromClaim(payload, 'organization_id')
    ?? valuesFromClaim(payload, 'org_id')
    ?? valuesFromClaim(payload, 'organization_ids')
    ?? valuesFromClaim(payload, 'org_ids')
    ?? valuesFromClaim(payload, 'allowed_organizations')
    ?? valuesFromNestedClaim(payload, 'app_metadata', 'organization_id')
    ?? valuesFromNestedClaim(payload, 'app_metadata', 'org_id')
    ?? valuesFromNestedClaim(payload, 'app_metadata', 'organization_ids')
    ?? valuesFromNestedClaim(payload, 'app_metadata', 'org_ids')
    ?? valuesFromNestedClaim(payload, 'app_metadata', 'allowed_organizations');
  if (!organizations) return undefined;
  return parseStringSet(organizations);
}

function valuesFromClaim(payload: JWTPayload, key: string): string[] | string | undefined {
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return undefined;
}

function valuesFromNestedClaim(payload: JWTPayload, parent: string, key: string): string[] | string | undefined {
  const object = (payload as Record<string, unknown>)[parent];
  if (object == null || typeof object !== 'object' || Array.isArray(object)) return undefined;
  const value = (object as Record<string, unknown>)[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return undefined;
}

function parseEnabledEndpoints(value: string | string[] | undefined): Set<string> {
  const enabled = Array.from(parseStringSet(value));
  const normalized = new Set<string>();
  for (const endpoint of enabled) {
    const canonical = normalizeEndpointId(endpoint);
    if (!canonical) {
      throw new Error(`Unknown endpoint id in enabled endpoint list: ${endpoint}`);
    }
    normalized.add(canonical);
  }
  return normalized;
}

function parseStringSet(value: string | string[] | undefined): Set<string> {
  const raw = Array.isArray(value) ? value : (value ?? '').split(/[,\s]+/);
  return new Set(raw.map(item => item.trim()).filter(Boolean));
}

function normalizeEmailSet(value: string | undefined): Set<string> {
  return new Set(Array.from(parseStringSet(value)).map(email => email.toLowerCase()));
}

function userIdFromClaims(payload: JWTPayload, subject: string): string {
  const customUserId = (payload as { user_id?: unknown })?.user_id;
  if (typeof customUserId === 'string' && customUserId.trim()) return customUserId;
  return subject;
}

function parseRegexList(value: string | undefined): RegExp[] {
  return (value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => new RegExp(item));
}

function parseAudience(value: string | undefined): string | string[] | undefined {
  const audiences = (value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  if (audiences.length === 0) return undefined;
  return audiences.length === 1 ? audiences[0] : audiences;
}

function parseRouteOverrides(value: string | undefined): Map<string, RouteConfigOverride> {
  if (!value?.trim()) return new Map();
  const parsed = JSON.parse(value) as Record<string, Record<string, unknown>>;
  return new Map(Object.entries(parsed).map(([route, raw]) => [normalizeRouteKey(route), {
    maxBodyBytes: numberOverride(raw.max_body_bytes ?? raw.maxBodyBytes),
    rateLimitWindowMs: numberOverride(raw.rate_limit_window_ms ?? raw.rateLimitWindowMs),
    rateLimitMax: numberOverride(raw.rate_limit_max ?? raw.rateLimitMax),
  }]));
}

function routeOverride(config: AuthConfig, method: string, path: string): RouteConfigOverride | undefined {
  return config.routeOverrides.get(normalizeRouteKey(`${method} ${path}`))
    ?? config.routeOverrides.get(normalizeRouteKey(path));
}

function normalizeRouteKey(route: string): string {
  return route.trim().replace(/\s+/g, ' ').toUpperCase().replace(/^([A-Z]+) (\/.*)$/, '$1 $2');
}

function numberOverride(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

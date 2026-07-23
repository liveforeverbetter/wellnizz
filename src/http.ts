import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { URL } from 'node:url';
import { runHealthAnalysis, queryHealthContext, summarizeAnalysis, runWearableAutoAnalysis, resolveWearableTimezone, type AnalysisOptions } from './core/analysis.js';
import { runAncestryAnalysis, type AncestryAnalysisInput } from './core/ancestry-analysis.js';
import { buildHealthContext } from './core/health-context.js';
import { buildHealthTrends } from './core/trends.js';
import { computeRetestReminders } from './core/reminders.js';
import { enrichAnalysisWithGeneticPipeline } from './core/genetic-analysis.js';
import { dispatchQueuedWgsWorker } from './core/fly-wgs-dispatch.js';
import { queryGeneticSlice, type GeneticSliceIndex } from './core/genetic-slice.js';
import { buildRecommendations } from './core/recommendations.js';
import { buildActionPlan } from './core/action-plan.js';
import { buildSyntheticHero } from './core/sandbox.js';
import { createPrivateDashboardLink, DashboardLinkConfigurationError, DashboardLinkValidationError, dashboardSpecMatchesSnapshot, renderPrivateDashboard, verifyPrivateDashboardToken } from './core/dashboard-links.js';
import { connectorSyncJobSummary, enqueueWearablesSync } from './core/wearable-sync.js';
import { emitWebhookEvent as emitSharedWebhookEvent, validateWebhookDeliveryConfig } from './core/webhook-emit.js';
import { normalizeHealthConnectPayload, type HealthConnectSdkPayload } from './core/health-connect.js';
import { buildSourceReference, decodeImportBuffer, normalizeImportedFile, type FileImportInput } from './core/normalization.js';
import { extractImportText, type ImportTextResult } from './core/pdf.js';
import { geneticUploadPayloadKey, type SignedPayloadUpload } from './connectors/payload-store.js';
import { buildOAuthUrl, exchangeOAuthCode, fetchOuraUserId, fetchWhoopUserId, mobileBridgeConnection, ProviderHttpError, refreshOAuthToken, syncWearableProvider, wearableProviderInfo, type OAuthTokenSet } from './connectors/wearables.js';
import { decryptToken, encryptToken, loadTokenEncryptionKey } from './connectors/token-crypto.js';
import { parseWhoopWebhookPayload, verifyWhoopSignature, whoopResourceType, WHOOP_SIGNATURE_HEADER, WHOOP_SIGNATURE_TIMESTAMP_HEADER } from './connectors/whoop-webhook.js';
import { searchLabs } from './connectors/labs.js';
import { listWgsProviders, getWgsProvider } from './connectors/wgs-providers.js';
import { BillingError, StripeBillingService, stripeBillingConfig } from './billing.js';
import { capabilitiesCatalog } from './capabilities.js';
import { listDesignSystems, getDesignSystem } from './core/design-systems.js';
import { getDesignImplementation } from './core/design-implementation.js';
import { findProviders, parseModalities } from './core/providers.js';
import { assertTierQuota, DEFAULT_API_KEY_ENDPOINTS, issueApiKey, issueSandboxSession, personalOrganizationId, pricingCatalog, tierRateLimitForClaims, type ApiKeyCreateRequest, type TierQuotaId } from './pricing.js';
import { startAgentOtp, verifyAgentOtp, OtpAuthError, type AgentOtpStartRequest, type AgentOtpVerifyRequest } from './connectors/otp.js';
import { emailEnabled, validateEmailConfig } from './connectors/email.js';
import { handleMcpRequest } from './mcp.js';
import { serveDashboardAsset } from './dashboard.js';
import { HealthApiStore } from './store.js';
import {
  AuthError,
  assertHttps,
  authenticate,
  bodyLimitForRoute,
  loadAuthConfig,
  probeAuthConfig,
  rateLimitForRoute,
  requireEndpointAccess,
  requireResourceAccess,
  requireScope,
  requireUserAccess,
  resolveOrganizationId,
  isBillingAdmin,
  securityHeaders,
  type AuthConfig,
  type AuthContext,
} from './auth.js';
import { auditEvent, clientIp } from './audit.js';
import { DEFAULT_USER_DATA_READ_ENDPOINTS, ENDPOINTS, endpointCatalog, type EndpointId } from './endpoints.js';
import { InMemoryRateLimiter, RateLimitError } from './rate-limit.js';
import { assertUserQuota, loadUserQuotaConfig } from './quota.js';
import { traceContext } from './tracing.js';
import { openApiDocument } from './schemas.js';
import { SERVICE_VERSION } from './version.js';
import { X402Gateway, X402GatewayError, describeX402, loadX402Config } from './x402.js';
import { createId, type HealthStore, type IdempotencyRecord } from './store.js';
import type { AnalysisResult, ConnectorSyncRequest, GeneticsAnnotationDepth, Goal, GoalDirection, GoalStatus, OAuthTokenRequest, OAuthUrlRequest, ProviderId, RawSourceReference, SourceCategory, WearablesConnectionCallbackRequest, WearablesConnectionStartRequest, WebhookEventType } from './types.js';

export interface HealthApiServerOptions {
  auth?: AuthConfig;
  x402?: X402Gateway | false;
}

const OTP_BODY_BYTES = 8 * 1024;
const IDEMPOTENCY_KEY_MAX = 200;
const requestIds = new WeakMap<IncomingMessage, string>();

interface AgentLoginSession {
  status: 'pending' | 'confirmed' | 'denied';
  pollingSecretHash: Buffer;
  agentName: string;
  apiKey?: Awaited<ReturnType<typeof issueApiKey>>;
  expiresAt: number;
}

const agentLoginSessions = new Map<string, AgentLoginSession>();
const AGENT_LOGIN_TTL_MS = 600_000;
const AGENT_API_KEY_DEFAULT_TTL_DAYS = 365;
const AGENT_API_KEY_MIN_TTL_DAYS = 180;
const AGENT_API_KEY_MAX_TTL_DAYS = 730;
const AGENT_LOGIN_ENDPOINTS = DEFAULT_API_KEY_ENDPOINTS.filter(endpoint => (
  endpoint !== 'billing.checkout.create'
  && endpoint !== 'billing.portal.create'
  && endpoint !== 'data.delete'
));

function generateSessionCode(): string {
  return `FB-${randomBytes(16).toString('hex').toUpperCase()}`;
}

function generatePollingSecret(): string {
  return `fbp_${randomBytes(32).toString('base64url')}`;
}

function hashPollingSecret(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

function pollingSecretMatches(session: AgentLoginSession, provided: string): boolean {
  const received = hashPollingSecret(provided);
  return received.length === session.pollingSecretHash.length && timingSafeEqual(received, session.pollingSecretHash);
}

function agentName(value: unknown): string {
  if (typeof value !== 'string') return 'Your agent';
  const normalized = value.trim().replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 80);
  return normalized || 'Your agent';
}

function resolveBaseUrl(req: IncomingMessage, config: AuthConfig): string {
  return publicBaseUrl(req, config);
}

function pruneExpiredLoginSessions() {
  const now = Date.now();
  for (const [code, session] of agentLoginSessions) {
    if (session.expiresAt < now) agentLoginSessions.delete(code);
  }
}

interface ResponsePayload {
  status: number;
  body: unknown;
}

interface CacheEntry {
  expiresAt: number;
  body: unknown;
}

interface AnalysisInput {
  user_id: string;
  organization_id?: string;
  source_ids: string[];
  profile?: { age?: number; sex?: 'male' | 'female' };
  annotation_depth?: GeneticsAnnotationDepth;
}

const SCOPED_ANALYSIS_ROUTES: Record<string, { endpointId: EndpointId; modality: AnalysisOptions['modality']; operation: AnalysisOptions['operation'] }> = {
  '/biomarkers/derive': { endpointId: 'biomarkers.derive', modality: 'biomarkers', operation: 'derive' },
  '/biomarkers/analyze': { endpointId: 'biomarkers.analyze', modality: 'biomarkers', operation: 'analyze' },
  '/wearables/analyze': { endpointId: 'wearables.analyze', modality: 'wearables', operation: 'analyze' },
  '/genetics/analyze': { endpointId: 'genetics.analyze', modality: 'genetics', operation: 'analyze' },
};

export function createHealthApiServer(store: HealthStore = new HealthApiStore(), options: HealthApiServerOptions = {}) {
  validateEmailConfig();
  validateWebhookDeliveryConfig();
  const authConfig = options.auth ?? loadAuthConfig();
  const x402Config = options.x402 === undefined ? loadX402Config() : undefined;
  const x402Gateway = options.x402 === false ? undefined : options.x402 ?? (x402Config ? new X402Gateway(x402Config) : undefined);
  const rateLimiter = new InMemoryRateLimiter(authConfig.rateLimitWindowMs, authConfig.rateLimitMax);
  const quotaConfig = loadUserQuotaConfig();
  const quotaLimiter = new InMemoryRateLimiter(0, 0);
  const responseCache = new Map<string, CacheEntry>();
  return createServer(async (req, res) => {
    try {
      rateLimiter.assertAllowed(`ip:${clientIp(req)}`);
      if (x402Gateway?.matches(req)) {
        const trace = traceContext(req);
        for (const [name, value] of Object.entries({
          ...securityHeaders(authConfig, req.headers.origin),
          'x-request-id': requestId(req),
          'x-trace-id': trace.trace_id,
          traceparent: trace.traceparent,
        })) res.setHeader(name, value);
        const paid = await x402Gateway.execute(req, res, async (paidAuth, paidResponse) => {
          await route(req, paidResponse, store, authConfig, rateLimiter, quotaLimiter, quotaConfig, responseCache, paidAuth, x402Gateway);
        }, work => {
          const key = req.headers['idempotency-key'];
          return store.withTransaction(work, Array.isArray(key) ? key[0] : key);
        });
        if (paid.handled) return;
      }
      await route(req, res, store, authConfig, rateLimiter, quotaLimiter, quotaConfig, responseCache, undefined, x402Gateway);
    } catch (error) {
      const status = statusForError(error);
      sendJson(req, res, authConfig, status, problemDetails(req, status, error), errorHeaders(status, req));
      auditEvent(req, status === 401 || status === 403 ? 'denied' : 'error', {
        route: routeForAudit(req),
        status,
        error: safeErrorMessage(error, status),
      });
    }
  });
}

async function route(req: IncomingMessage, res: ServerResponse, store: HealthStore, authConfig: AuthConfig, rateLimiter: InMemoryRateLimiter, quotaLimiter: InMemoryRateLimiter, quotaConfig: ReturnType<typeof loadUserQuotaConfig>, responseCache: Map<string, CacheEntry>, paidAuth?: AuthContext, x402Gateway?: X402Gateway): Promise<void> {
  const originalUrl = new URL(req.url ?? '/', 'http://localhost');
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/v1/')) url.pathname = url.pathname.slice(3);
  const method = req.method ?? 'GET';
  rateLimiter.assertAllowed(`ip-route:${clientIp(req)}:${method}:${url.pathname}`, rateLimitForRoute(authConfig, method, url.pathname));
  if (method === 'OPTIONS') return sendJson(req, res, authConfig, 204, {});

  if (method === 'GET' && url.pathname === '/') {
    return sendRedirect(req, res, authConfig, '/dashboard');
  }

  if (method === 'GET' && url.pathname === '/docs') {
    return sendRedirect(req, res, authConfig, docsUrl());
  }

  if (await serveDashboardAsset(req, res, authConfig, url.pathname)) return;

  // /health and /ready must answer over plain HTTP for platform healthchecks
  // (Fly and similar reverse proxies hit the internal port without TLS termination).
  // Keep the public response deliberately minimal. Detailed dependency and
  // storage diagnostics are available only to authenticated administrators.
  if (method === 'GET' && url.pathname === '/health') {
    return sendJson(req, res, authConfig, 200, { ok: true, service: 'wellnizz-api' });
  }
  if (method === 'GET' && url.pathname === '/ready') {
    const readiness = await readinessPayload(authConfig, store, x402Gateway);
    return sendJson(req, res, authConfig, readiness.ok ? 200 : 503, {
      ok: readiness.ok,
      service: 'wellnizz-api',
      version: SERVICE_VERSION,
    });
  }

  assertHttps(req, authConfig);

  // Stripe signs webhooks rather than presenting a tenant bearer token, so
  // verify the raw body before the normal authentication path consumes it.
  if (method === 'POST' && url.pathname === '/billing/stripe/webhook') {
    const billingConfig = stripeBillingConfig();
    if (!billingConfig) throw new HttpError(503, 'Hosted billing is not configured.');
    const rawBody = await readRawBody(req, 512 * 1024);
    const signature = Array.isArray(req.headers['stripe-signature']) ? req.headers['stripe-signature'][0] : req.headers['stripe-signature'];
    try {
      await new StripeBillingService(billingConfig).processWebhook(rawBody, signature);
    } catch (error) {
      if (error instanceof BillingError) throw new HttpError(error.status, error.message);
      throw error;
    }
    auditEvent(req, 'success', { route: url.pathname, status: 200 });
    return sendJson(req, res, authConfig, 200, { received: true });
  }

  if (method === 'GET' && url.pathname === '/version') {
    return sendJson(req, res, authConfig, 200, { service: 'wellnizz-api', version: SERVICE_VERSION });
  }

  if (method === 'GET' && url.pathname === '/openapi.json') {
    return sendJson(req, res, authConfig, 200, openApiDocument(publicBaseUrl(req, authConfig), x402Gateway?.describe()));
  }

  if (method === 'GET' && url.pathname === '/endpoints') {
    return sendJson(req, res, authConfig, 200, endpointCatalog(authConfig.enabledEndpoints));
  }

  if (method === 'GET' && url.pathname === '/capabilities') {
    return sendJson(req, res, authConfig, 200, capabilitiesCatalog({
      whoopFirstParty: Boolean(authConfig.whoopOAuth),
      ouraFirstParty: Boolean(authConfig.ouraOAuth),
      fullDbsnpConfigured: fullDbsnpConfigured(),
    }), publicCacheHeaders(300));
  }

  if (method === 'GET' && url.pathname === '/pricing') {
    return sendJson(req, res, authConfig, 200, pricingCatalog(), publicCacheHeaders(300));
  }

  if (method === 'GET' && url.pathname === '/design/systems') {
    return sendJson(req, res, authConfig, 200, listDesignSystems(), publicCacheHeaders(3600));
  }

  const designImplementationMatch = url.pathname.match(/^\/design\/systems\/([^/]+)\/implementation$/);
  if (method === 'GET' && designImplementationMatch) {
    const implementation = await getDesignImplementation(decodeURIComponent(designImplementationMatch[1]), resolveBaseUrl(req, authConfig));
    if (!implementation) throw new HttpError(404, 'Design implementation not found. List available systems at GET /design/systems.');
    return sendJson(req, res, authConfig, 200, implementation, publicCacheHeaders(300));
  }

  const designSystemMatch = url.pathname.match(/^\/design\/systems\/([^/]+)$/);
  if (method === 'GET' && designSystemMatch) {
    const system = getDesignSystem(decodeURIComponent(designSystemMatch[1]));
    if (!system) throw new HttpError(404, 'Design system not found. List available systems at GET /design/systems.');
    return sendJson(req, res, authConfig, 200, system, publicCacheHeaders(3600));
  }

  const privateDashboardMatch = url.pathname.match(/^\/dashboards\/private\/([^/]+)$/);
  if (method === 'GET' && privateDashboardMatch) {
    const secret = dashboardLinkSecret(authConfig);
    let token: string;
    try {
      token = decodeURIComponent(privateDashboardMatch[1]);
    } catch {
      throw new HttpError(404, 'Dashboard link not found or expired.');
    }
    const payload = secret ? verifyPrivateDashboardToken(token, secret) : undefined;
    if (!payload) throw new HttpError(404, 'Dashboard link not found or expired.');
    const analysis = await store.getAnalysis(payload.analysis_id);
    const design = getDesignSystem(payload.design_id);
    if (!analysis || !design || !dashboardSpecMatchesSnapshot(analysis.dashboard_spec, payload.snapshot_sha256)) {
      throw new HttpError(404, 'Dashboard link not found or expired.');
    }
    auditEvent(req, 'success', { route: '/dashboards/private/:token', status: 200 });
    return sendHtml(req, res, authConfig, 200, renderPrivateDashboard(analysis.dashboard_spec, design, payload.expires_at));
  }

  if (method === 'GET' && (url.pathname === '/.well-known/health-agent.json' || url.pathname === '/agent/manifest')) {
    return sendJson(req, res, authConfig, 200, agentManifest(req, authConfig, x402Gateway));
  }

  if (method === 'GET' && (url.pathname === '/.well-known/x402.json' || url.pathname === '/x402/routes')) {
    return sendJson(req, res, authConfig, 200, x402Gateway?.describe() ?? describeX402(), publicCacheHeaders(300));
  }

  if (method === 'POST' && url.pathname === '/auth/otp/start') {
    rateLimiter.assertAllowed(`otp-start:${clientIp(req)}`, { windowMs: 60_000, max: 5 });
    const input = await readJson<AgentOtpStartRequest>(req, bodyLimitForRoute(authConfig, method, url.pathname, OTP_BODY_BYTES));
    const result = await startAgentOtp(input, store, authConfig).catch((error) => mapOtpError(error, 'start'));
    auditEvent(req, 'success', { route: url.pathname, status: 200 });
    return sendJson(req, res, authConfig, 200, result);
  }

  if (method === 'POST' && url.pathname === '/auth/otp/verify') {
    // Bound brute-force against the 8-digit code by client IP.
    rateLimiter.assertAllowed(`otp-verify:${clientIp(req)}`, { windowMs: 60_000, max: 10 });
    const input = await readJson<AgentOtpVerifyRequest>(req, bodyLimitForRoute(authConfig, method, url.pathname, OTP_BODY_BYTES));
    const result = await verifyAgentOtp(input, store, authConfig).catch((error) => mapOtpError(error, 'verify'));
    auditEvent(req, 'success', { route: url.pathname, status: 200 });
    return sendJson(req, res, authConfig, 200, result);
  }

  if (method === 'POST' && url.pathname === '/sandbox/sessions') {
    if (!authConfig.publicSandbox) throw new HttpError(404, 'Synthetic sandbox is not enabled on this deployment.');
    rateLimiter.assertAllowed(`sandbox-session:${clientIp(req)}`, { windowMs: 60_000, max: 5 });
    let session;
    try {
      session = await issueSandboxSession(authConfig);
    } catch (error) {
      throw new HttpError(503, error instanceof Error ? error.message : 'Synthetic sandbox is unavailable.');
    }
    const hero = buildSyntheticHero(session.user_id, session.organization_id, SERVICE_VERSION);
    auditEvent(req, 'success', { route: url.pathname, status: 201, synthetic: true, persisted: false });
    return sendJson(req, res, authConfig, 201, {
      session,
      hero,
      first_action: {
        method: 'POST',
        path: '/sandbox/hero',
        authorization: `Bearer ${session.access_token}`,
      },
    });
  }

  // WHOOP webhook receiver. Authenticated by WHOOP's HMAC signature (not a tenant
  // bearer token), so it sits ahead of authenticate(). It responds 2XX fast and
  // enqueues a sync job for asynchronous processing, per WHOOP's guidance.
  if (method === 'POST' && url.pathname === '/connections/whoop/webhook') {
    return handleWhoopWebhook(req, res, store, authConfig);
  }

  // Oura verifies a subscription with a signed GET challenge, then sends signed
  // POST notifications. Both are authenticated by Oura headers rather than a
  // tenant bearer token, so they must run before authenticate().
  if ((method === 'GET' || method === 'POST') && url.pathname === '/connections/oura/webhook') {
    return handleOuraWebhook(req, res, store, authConfig, url);
  }

  if (method === 'POST' && url.pathname === '/agent-login/start') {
    rateLimiter.assertAllowed(`agent-login-start:${clientIp(req)}`, { windowMs: 60_000, max: 5 });
    pruneExpiredLoginSessions();
    const input = await readJson<{ agent_name?: string }>(req, bodyLimitForRoute(authConfig, method, url.pathname, OTP_BODY_BYTES));
    const sessionCode = generateSessionCode();
    const pollingSecret = generatePollingSecret();
    const requestedAgentName = agentName(input.agent_name);
    const baseUrl = resolveBaseUrl(req, authConfig);
    agentLoginSessions.set(sessionCode, {
      status: 'pending',
      pollingSecretHash: hashPollingSecret(pollingSecret),
      agentName: requestedAgentName,
      expiresAt: Date.now() + AGENT_LOGIN_TTL_MS,
    });
    auditEvent(req, 'success', { route: url.pathname, status: 200 });
    return sendJson(req, res, authConfig, 200, {
      session_code: sessionCode,
      polling_secret: pollingSecret,
      url: `${baseUrl}/dashboard?agent-login=${sessionCode}`,
      expires_in_seconds: Math.floor(AGENT_LOGIN_TTL_MS / 1000),
      api_key_expires_in_days: agentApiKeyTtlDays(),
      note: 'Open this URL in the user\'s browser (share it only if you cannot open one) so they can sign in and approve the named agent. Poll GET /agent-login/status with X-Agent-Login-Secret. The API key is returned once.',
    });
  }

  if (method === 'GET' && url.pathname === '/agent-login/request') {
    rateLimiter.assertAllowed(`agent-login-request:${clientIp(req)}`, { windowMs: 60_000, max: 20 });
    const sessionCode = (url.searchParams.get('session_code') ?? '').toUpperCase();
    if (!sessionCode) throw new HttpError(400, 'session_code query parameter is required.');
    pruneExpiredLoginSessions();
    const session = agentLoginSessions.get(sessionCode);
    if (!session) throw new HttpError(404, 'Agent authorization request not found or expired. Ask the agent to start again.');
    return sendJson(req, res, authConfig, 200, {
      agent_name: session.agentName,
      status: session.status,
      permissions: [
        'Read, upload, and analyze your wellness data',
        'Connect approved wearable and data sources',
        'Create private dashboards, action plans, and goals',
        'Export a copy of your wellness data',
        'Cannot manage billing or delete your account data',
      ],
      api_key_expires_in_days: agentApiKeyTtlDays(),
      expires_in_seconds: Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 1000)),
    });
  }

  if (method === 'GET' && url.pathname === '/agent-login/status') {
    rateLimiter.assertAllowed(`agent-login-status:${clientIp(req)}`, { windowMs: 60_000, max: 40 });
    const sessionCode = url.searchParams.get('session_code') ?? '';
    if (!sessionCode) throw new HttpError(400, 'session_code query parameter is required.');
    pruneExpiredLoginSessions();
    const session = agentLoginSessions.get(sessionCode.toUpperCase());
    if (!session) {
      auditEvent(req, 'success', { route: url.pathname, status: 200, error: 'session code not found or expired' });
      return sendJson(req, res, authConfig, 200, { status: 'expired' });
    }
    const pollingSecretHeader = req.headers['x-agent-login-secret'];
    const pollingSecret = Array.isArray(pollingSecretHeader) ? pollingSecretHeader[0] : pollingSecretHeader;
    if (!pollingSecret || !pollingSecretMatches(session, pollingSecret)) {
      throw new HttpError(401, 'Agent login polling secret is missing or invalid.');
    }
    if (session.status === 'pending') {
      return sendJson(req, res, authConfig, 200, { status: 'pending' });
    }
    if (session.status === 'denied') {
      agentLoginSessions.delete(sessionCode.toUpperCase());
      return sendJson(req, res, authConfig, 200, { status: 'denied' });
    }
    agentLoginSessions.delete(sessionCode.toUpperCase());
    auditEvent(req, 'success', { route: url.pathname, status: 200 });
    return sendJson(req, res, authConfig, 200, {
      status: 'confirmed',
      api_key: session.apiKey!.api_key,
      authorization_header: session.apiKey!.authorization_header,
      created: session.apiKey!.created,
      usage: session.apiKey!.usage,
    });
  }

  if (method === 'POST' && url.pathname === '/agent-login/confirm') {
    rateLimiter.assertAllowed(`agent-login-confirm:${clientIp(req)}`, { windowMs: 60_000, max: 10 });
    const input = await readJson<{ session_code: string; access_token: string; decision: 'approve' | 'deny' }>(req, bodyLimitForRoute(authConfig, method, url.pathname, OTP_BODY_BYTES));
    const sessionCode = (input.session_code ?? '').toUpperCase();
    if (!sessionCode) throw new HttpError(400, 'session_code is required.');
    if (input.decision !== 'approve' && input.decision !== 'deny') throw new HttpError(400, 'decision must be approve or deny.');
    pruneExpiredLoginSessions();
    const session = agentLoginSessions.get(sessionCode);
    if (!session || session.status !== 'pending') {
      throw new HttpError(400, 'Session code not found, already used, or expired.');
    }
    // Verify the browser's access token by running authenticate
    const mockReq = { headers: { authorization: `Bearer ${input.access_token}` } } as IncomingMessage;
    let userAuth: AuthContext;
    try {
      userAuth = await authenticate(mockReq, authConfig);
    } catch (error) {
      throw new HttpError(401, error instanceof Error ? error.message : 'Invalid or expired session token. Try authenticating again.');
    }
    if (input.decision === 'deny') {
      session.status = 'denied';
      auditEvent(req, 'success', { route: url.pathname, status: 200, auth: userAuth });
      return sendJson(req, res, authConfig, 200, { ok: true, status: 'denied' });
    }
    // Mint a personal API key for this user
    try {
      const apiKey = await issueApiKey({
        name: `${session.agentName} key`,
        expires_in_days: agentApiKeyTtlDays(),
        enabled_endpoints: AGENT_LOGIN_ENDPOINTS,
      }, userAuth, authConfig);
      session.status = 'confirmed';
      session.apiKey = apiKey;
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : 'Could not create API key.');
    }
    auditEvent(req, 'success', { route: url.pathname, status: 200, auth: userAuth });
    return sendJson(req, res, authConfig, 200, { ok: true, status: 'confirmed', note: 'API key created. The waiting agent can retrieve it once.' });
  }

  const auth = paidAuth ?? await authenticate(req, authConfig);
  const billing = stripeBillingConfig() ? new StripeBillingService() : undefined;
  const billingAdmin = isBillingAdmin(auth, authConfig);
  if (billingAdmin) {
    (auth.claims as Record<string, unknown>).tier = 'enterprise';
    (auth.claims as Record<string, unknown>).billing_admin = true;
  } else if (billing) {
    await applyCurrentBillingTier(auth, billing);
  }
  rateLimiter.assertAllowed(`subject:${auth.subject}:${method}:${url.pathname}`, rateLimitForRoute(authConfig, method, url.pathname));
  const tierRateLimit = tierRateLimitForClaims(auth.claims);
  if (tierRateLimit) rateLimiter.assertAllowed(`tier:${auth.subject}`, tierRateLimit);
  if (method === 'GET' && url.pathname === '/ready/details') {
    if (!billingAdmin && !auth.scopes.has('health:admin')) throw new HttpError(403, 'Administrative access is required for readiness diagnostics.');
    const readiness = await readinessPayload(authConfig, store, x402Gateway);
    return sendJson(req, res, authConfig, readiness.ok ? 200 : 503, readiness);
  }
  if (billing && !billingAdmin && (auth.claims as Record<string, unknown>).tier === 'free' && isHostedIntroductoryRequest(method, url.pathname)) {
    const organizationId = auth.organizationIds?.size === 1
      ? Array.from(auth.organizationIds)[0]
      : personalOrganizationId(auth.userId);
    const usage = await billing.consumeIntroductoryRequest(auth.userId, organizationId);
    if (!usage.allowed) {
      throw new HttpError(402, `Your first ${usage.limit} hosted API requests are complete. Choose a plan and add a payment method to continue. Self-hosting remains available.`);
    }
  }

  // The Connect app's on-device Health Connect collector posts this stable SDK
  // envelope so user data lands directly in Wellnizz storage.
  const mobileSdkSyncMatch = originalUrl.pathname.match(/^\/api\/v1\/sdk\/users\/([^/]+)\/sync$/);
  if (method === 'POST' && mobileSdkSyncMatch) {
    const userId = decodeURIComponent(mobileSdkSyncMatch[1]);
    requireUserAccess(auth, userId);
    const organizationId = personalOrganizationId(userId);
    assertUserQuota(quotaLimiter, quotaConfig, 'connections.sync', userId, organizationId);
    const payload = await readJson<HealthConnectSdkPayload>(req, bodyLimitForRoute(authConfig, method, originalUrl.pathname));
    const result = await ingestHealthConnectSdkPayload(payload, userId, organizationId, store);
    await refreshWearableAnalysis(store, userId, organizationId);
    await emitWebhookEvent(store, 'wearables.sync.completed', {
      userId,
      organizationId,
      subjectId: result.source.id,
      requestId: requestId(req),
      data: {
        provider: 'health_connect',
        readings_count: result.readings_count,
        source_id: result.source.id,
      },
    });
    auditEvent(req, 'success', { route: '/api/v1/sdk/users/:user_id/sync', status: 202, auth });
    return sendJson(req, res, authConfig, 202, {
      status: 'accepted',
      provider: 'health_connect',
      readings_count: result.readings_count,
      source_id: result.source.id,
    });
  }

  if (method === 'POST' && url.pathname === '/sandbox/hero') {
    if (auth.claims.sandbox !== true || auth.claims.synthetic_only !== true) {
      throw new AuthError(403, 'This route accepts only a synthetic sandbox session.');
    }
    if (!auth.organizationIds || auth.organizationIds.size !== 1) {
      throw new AuthError(403, 'Synthetic sandbox session must contain exactly one organization.');
    }
    const organizationId = Array.from(auth.organizationIds)[0];
    auditEvent(req, 'success', { route: url.pathname, status: 200, auth, synthetic: true, persisted: false });
    return sendJson(req, res, authConfig, 200, buildSyntheticHero(auth.userId, organizationId, SERVICE_VERSION));
  }

  if (method === 'POST' && url.pathname === '/api-keys') {
    const input = await readJson<ApiKeyCreateRequest>(req, bodyLimitForRoute(authConfig, method, url.pathname, OTP_BODY_BYTES));
    if (!isSelfServePersonalApiKey(input, auth)) {
      requireEndpoint(auth, authConfig, 'api_keys.create');
      requireScope(auth, 'health:data:read');
    }
    try {
      const organizationId = input.organization_id ?? (auth.organizationIds?.size === 1 ? Array.from(auth.organizationIds)[0] : personalOrganizationId(auth.userId));
      const paidTier = input.tier && input.tier !== 'free' && billing
        ? await billing.activeTierFor(auth.userId, organizationId)
        : undefined;
      const result = await issueApiKey(input, auth, authConfig, { allowPaidTier: paidTier });
      auditEvent(req, 'success', { route: url.pathname, status: 201, auth });
      return sendJson(req, res, authConfig, 201, result);
    } catch (error) {
      throw new HttpError(authConfig.apiKeySecret || authConfig.serviceAccountSecret ? 400 : 503, error instanceof Error ? error.message : 'API key could not be issued.');
    }
  }

  if (method === 'GET' && url.pathname === '/billing/subscription') {
    requireEndpoint(auth, authConfig, 'billing.subscription.read');
    requireScope(auth, 'health:data:read');
    const organizationId = resolveOrganizationId(auth, authConfig, url.searchParams.get('organization_id') ?? undefined);
    if (!organizationId) throw new HttpError(400, 'organization_id is required for billing.');
    const subscription = billing ? await billing.subscriptionFor(auth.userId, organizationId) : undefined;
    const introductoryUsage = billing && !['active', 'trialing'].includes(subscription?.status ?? '')
      ? await billing.introductoryUsageFor(auth.userId, organizationId)
      : undefined;
    return sendJson(req, res, authConfig, 200, {
      hosted_billing_configured: Boolean(billing),
      billing_admin: billingAdmin,
      effective_tier: (auth.claims as Record<string, unknown>).tier ?? 'free',
      subscription,
      introductory_usage: introductoryUsage,
      self_hosting: { available: true, url: `${docsUrl().replace(/\/$/, '')}/self-hosting` },
    });
  }

  if (method === 'POST' && url.pathname === '/billing/checkout') {
    requireEndpoint(auth, authConfig, 'billing.checkout.create');
    requireScope(auth, 'health:data:read');
    if (!billing) throw new HttpError(503, 'Hosted billing is not configured.');
    const input = await readJson<{ tier: 'standard' | 'builder' | 'growth'; organization_id?: string; activation_source: 'wearable' | 'biomarkers' | 'genetics' | 'health_connect' | 'request_limit' }>(req, bodyLimitForRoute(authConfig, method, url.pathname, OTP_BODY_BYTES));
    const organizationId = resolveOrganizationId(auth, authConfig, input.organization_id);
    if (!organizationId) throw new HttpError(400, 'organization_id is required for billing.');
    const existingSubscription = await billing.subscriptionFor(auth.userId, organizationId);
    if (!existingSubscription || !['active', 'trialing'].includes(existingSubscription.status)) {
      const introductoryUsage = await billing.introductoryUsageFor(auth.userId, organizationId);
      if (!introductoryUsage.payment_required) {
        throw new HttpError(409, `Checkout becomes available after ${introductoryUsage.limit} protected hosted API requests. You have ${introductoryUsage.remaining} free requests remaining.`);
      }
    }
    if (!['wearable', 'biomarkers', 'genetics', 'health_connect', 'request_limit'].includes(input.activation_source)) {
      throw new HttpError(400, 'activation_source must be wearable, biomarkers, genetics, health_connect, or request_limit.');
    }
    const session = await billing.createCheckoutSession({ userId: auth.userId, organizationId, tier: input.tier, activationSource: input.activation_source });
    auditEvent(req, 'success', { route: url.pathname, status: 201, auth });
    return sendJson(req, res, authConfig, 201, session);
  }

  if (method === 'POST' && url.pathname === '/billing/portal') {
    requireEndpoint(auth, authConfig, 'billing.portal.create');
    requireScope(auth, 'health:data:read');
    if (!billing) throw new HttpError(503, 'Hosted billing is not configured.');
    const input = await readJson<{ organization_id?: string }>(req, bodyLimitForRoute(authConfig, method, url.pathname, OTP_BODY_BYTES));
    const organizationId = resolveOrganizationId(auth, authConfig, input.organization_id);
    if (!organizationId) throw new HttpError(400, 'organization_id is required for billing.');
    const session = await billing.createPortalSession({ userId: auth.userId, organizationId });
    auditEvent(req, 'success', { route: url.pathname, status: 201, auth });
    return sendJson(req, res, authConfig, 201, session);
  }

  if (method === 'GET' && url.pathname === '/webhook-events') {
    requireEndpoint(auth, authConfig, 'webhooks.read');
    requireScope(auth, 'health:data:read');
    const userId = url.searchParams.get('user_id') ?? auth.userId;
    const organizationId = url.searchParams.get('organization_id') ?? undefined;
    requireUserAccess(auth, userId);
    if (organizationId) requireResourceAccess(auth, authConfig, { userId: userId ?? auth.userId, organizationId });
    const events = await store.listWebhookEvents({
      userId,
      organizationId,
      type: url.searchParams.get('type') ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? '50'),
    });
    auditEvent(req, 'success', { route: url.pathname, status: 200, auth });
    return sendJson(req, res, authConfig, 200, { events });
  }

  if (method === 'POST' && url.pathname === '/imports/file') {
    requireEndpoint(auth, authConfig, 'imports.file');
    requireScope(auth, 'health:data:write');
    const input = await readJson<FileImportInput>(req, bodyLimitForRoute(authConfig, method, url.pathname));
    input.user_id ||= auth.userId;
    requireUserAccess(auth, input.user_id);
    input.organization_id = resolveOrganizationId(auth, authConfig, input.organization_id);
    assertPlanQuota(quotaLimiter, auth, 'imports.file');
    const payload = decodeImportBuffer(input);
    assertUserQuota(quotaLimiter, quotaConfig, 'imports.file', input.user_id, input.organization_id);
    const extraction = input.category === 'genetics'
      ? { text: '', is_pdf: false, extraction_failed: false }
      : await extractImportText(input, payload);
    const source = buildSourceReference(input, payload);
    const observations = normalizeImportedFile(source, extraction.text);
    const warnings = importWarnings(input.category, extraction, observations.length);
    const result = await withIdempotency(req, store, auth, url.pathname, async () => {
      await store.saveSource(source, observations, input.category === 'genetics' ? payload : undefined);
      await emitWebhookEvent(store, 'source.imported', {
        userId: input.user_id,
        organizationId: input.organization_id,
        subjectId: source.id,
        requestId: requestId(req),
        data: {
          source_id: source.id,
          category: source.category,
          provider: source.provider,
          observations: observations.length,
        },
      });
      return { status: 201, body: { source, normalized_observations: observations, ...(warnings.length ? { warnings } : {}) } };
    });
    if (input.category === 'wearables') await refreshWearableAnalysis(store, input.user_id, input.organization_id);
    auditEvent(req, 'success', { route: url.pathname, status: 201, auth });
    return sendJson(req, res, authConfig, result.status, result.body);
  }

  if (method === 'POST' && url.pathname === '/genetics/uploads') {
    requireEndpoint(auth, authConfig, 'imports.file');
    requireScope(auth, 'health:data:write');
    const input = await readJson<GeneticsUploadInitInput>(req, bodyLimitForRoute(authConfig, method, url.pathname, OTP_BODY_BYTES));
    requireUserAccess(auth, input.user_id);
    const organizationId = resolveOrganizationId(auth, authConfig, input.organization_id);
    if (!organizationId) throw new HttpError(400, 'organization_id is required for direct genetics uploads.');
    const filename = validatedGeneticsFilename(input.filename);
    const declaredBytes = validatedGeneticsUploadBytes(input.byte_length);
    const directStore = directGeneticsUploadStore(store);
    if (!directStore) throw new HttpError(503, 'Direct-to-storage genetics uploads require S3-compatible object storage on this deployment. Use a small file import or configure STORAGE_DRIVER=s3.');

    const source: RawSourceReference = {
      id: createId('src'),
      user_id: input.user_id,
      organization_id: organizationId,
      category: 'genetics',
      provider: input.provider,
      filename,
      content_type: input.content_type || geneticsContentType(filename),
      received_at: new Date().toISOString(),
      byte_length: declaredBytes,
      storage_mode: 'durable',
      upload_status: 'pending',
    };
    const objectKey = geneticUploadPayloadKey(source, organizationId);
    const upload = await directStore.createSignedPayloadUpload(objectKey, source.content_type);
    const observations = normalizeImportedFile(source, '');
    // Persist source metadata before issuing the signed upload URL. The random source
    // id scopes the object key; finalize can therefore recover trusted metadata
    // without accepting a client-supplied storage path.
    await store.saveSource(source, observations, undefined, objectKey);
    auditEvent(req, 'success', { route: url.pathname, status: 201, auth });
    return sendJson(req, res, authConfig, 201, geneticsUploadSession(source, upload));
  }

  const geneticsUploadCompleteMatch = url.pathname.match(/^\/genetics\/uploads\/([^/]+)\/complete$/);
  if (method === 'POST' && geneticsUploadCompleteMatch) {
    requireEndpoint(auth, authConfig, 'imports.file');
    requireScope(auth, 'health:data:write');
    const input = await readJson<{ user_id: string; organization_id?: string }>(req, bodyLimitForRoute(authConfig, method, url.pathname, OTP_BODY_BYTES));
    requireUserAccess(auth, input.user_id);
    const organizationId = resolveOrganizationId(auth, authConfig, input.organization_id);
    if (!organizationId) throw new HttpError(400, 'organization_id is required for direct genetics uploads.');
    const source = await store.getSource(geneticsUploadCompleteMatch[1]);
    if (!source || source.category !== 'genetics') throw new HttpError(404, 'Genetics upload session not found.');
    requireResourceAccess(auth, authConfig, { userId: source.user_id, organizationId: source.organization_id });
    if (source.user_id !== input.user_id || source.organization_id !== organizationId) throw new HttpError(403, 'Access denied.');
    const directStore = directGeneticsUploadStore(store);
    if (!directStore) throw new HttpError(503, 'Direct-to-storage genetics uploads require S3-compatible object storage on this deployment.');
    const objectKey = geneticUploadPayloadKey(source, organizationId);
    const byteLength = await directStore.uploadedPayloadSize(objectKey);
    if (!byteLength) throw new HttpError(409, 'The uploaded genetics file is not available yet. Finish the direct upload before finalizing.');
    validatedGeneticsUploadBytes(byteLength);
    source.byte_length = byteLength;
    source.upload_status = 'complete';
    const observations = normalizeImportedFile(source, '');
    await withIdempotency(req, store, auth, url.pathname, async () => {
      await store.saveSource(source, observations, undefined, objectKey);
      await emitWebhookEvent(store, 'source.imported', {
        userId: source.user_id,
        organizationId: source.organization_id,
        subjectId: source.id,
        requestId: requestId(req),
        data: { source_id: source.id, category: source.category, provider: source.provider, observations: observations.length },
      });
      return { status: 201, body: { source, normalized_observations: observations } };
    });
    auditEvent(req, 'success', { route: '/genetics/uploads/:id/complete', status: 201, auth });
    return sendJson(req, res, authConfig, 201, { source, normalized_observations: observations });
  }

  const authUrlMatch = url.pathname.match(/^\/connections\/([^/]+)\/auth-url$/);
  if (method === 'POST' && authUrlMatch) {
    requireEndpoint(auth, authConfig, 'connections.auth_url');
    requireScope(auth, 'health:connections:write');
    auditEvent(req, 'success', { route: url.pathname, status: 200, auth });
    return sendJson(req, res, authConfig, 200, buildOAuthUrl(authUrlMatch[1] as ProviderId, await readJson<OAuthUrlRequest>(req, bodyLimitForRoute(authConfig, method, url.pathname))));
  }

  if (method === 'POST' && url.pathname === '/connections/wearables/start') {
    requireEndpoint(auth, authConfig, 'connections.start');
    requireScope(auth, 'health:connections:write');
    const input = await readJson<WearablesConnectionStartRequest>(req, bodyLimitForRoute(authConfig, method, url.pathname));
    requireUserAccess(auth, input.user_id);
    input.organization_id = resolveOrganizationId(auth, authConfig, input.organization_id);
    const provider = wearableProviderInfo(input.source_provider);
    if (!provider) throw new HttpError(400, `Unsupported wearable provider: ${input.source_provider}. Supported: whoop, oura, health_connect.`);

    // Mobile-bridge providers (Google Health Connect) have no server OAuth redirect.
    // Register the external account and return the bridge setup contract.
    if (provider.connection_type === 'mobile_bridge') {
      if (!input.organization_id) throw new HttpError(400, 'organization_id is required to register a wearable connection.');
      const account = await store.upsertExternalAccount({
        id: `acct_${randomUUID()}`,
        user_id: input.user_id,
        organization_id: input.organization_id,
        provider: input.source_provider,
        external_user_id: input.user_id,
        status: 'active',
        metadata: { source_provider: input.source_provider, connection_type: 'mobile_bridge' },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      const event = await emitWebhookEvent(store, 'connection.started', {
        userId: input.user_id,
        organizationId: input.organization_id,
        subjectId: account.id,
        requestId: requestId(req),
        data: { provider: 'wearables', source_provider: input.source_provider, connection_type: 'mobile_bridge' },
      });
      auditEvent(req, 'success', { route: url.pathname, status: 200, auth });
      return sendJson(req, res, authConfig, 200, { ...mobileBridgeConnection(provider), external_account: account, connection_event_id: event.id });
    }

    // First-party fallback: if the caller omits credentials, use the server's
    // configured OAuth app so a signed-up user can connect without pasting any.
    const firstParty = firstPartyOAuthFor(input.source_provider, authConfig);
    const baseUrl = publicBaseUrl(req, authConfig);
    const clientId = input.client_id ?? firstParty?.clientId;
    const redirectUri = input.redirect_uri ?? firstParty?.defaultRedirectUri ?? `${baseUrl}/dashboard`;
    if (!clientId || !redirectUri) throw new HttpError(400, `${provider.display_name} OAuth requires client_id and redirect_uri (or a server-configured first-party app).`);
    const connectionState = firstParty
      ? issueFirstPartyConnectionState(input.source_provider, input.user_id, input.organization_id)
      : input.state;
    const authUrl = buildOAuthUrl(input.source_provider, { ...input, state: connectionState, client_id: clientId, redirect_uri: redirectUri });
    const event = await emitWebhookEvent(store, 'connection.started', {
      userId: input.user_id,
      organizationId: input.organization_id,
      requestId: requestId(req),
      data: {
        provider: 'wearables',
        source_provider: input.source_provider,
        scopes: authUrl.scopes,
      },
    });
    auditEvent(req, 'success', { route: url.pathname, status: 200, auth });
    return sendJson(req, res, authConfig, 200, {
      provider: 'wearables',
      source_provider: input.source_provider,
      connection_type: 'oauth',
      authorization_url: authUrl.authorization_url,
      scopes: authUrl.scopes,
      automatic_browser_completion: Boolean(connectionState?.startsWith('fb1.')),
      connection_event_id: event.id,
    });
  }

  if (method === 'GET' && url.pathname === '/connections/wearables/status') {
    requireEndpoint(auth, authConfig, 'connections.start');
    requireScope(auth, 'health:connections:write');
    const userId = url.searchParams.get('user_id') ?? auth.userId;
    requireUserAccess(auth, userId);
    const organizationId = resolveOrganizationId(auth, authConfig, url.searchParams.get('organization_id') ?? undefined);
    const organizationIds = organizationId ? new Set([organizationId]) : auth.organizationIds;
    const accounts = await store.listExternalAccountsForUser(userId, organizationIds);
    const connections = accounts
      .filter(account => wearableProviderInfo(account.provider as ProviderId) || account.provider === 'wearables')
      .map(account => ({
        id: account.id,
        source_provider: account.metadata.source_provider ?? account.provider,
        status: account.status,
        webhook_sync_enabled: account.metadata.webhook_sync_enabled === true,
        server_sync_enabled: account.metadata.server_sync_enabled === true,
        mobile_sync_enabled: account.metadata.mobile_sync_enabled === true,
        last_synced_at: account.last_synced_at,
        updated_at: account.updated_at,
      }));
    auditEvent(req, 'success', { route: url.pathname, status: 200, auth });
    return sendJson(req, res, authConfig, 200, { connections });
  }

  const tokenMatch = url.pathname.match(/^\/connections\/([^/]+)\/token$/);
  if (method === 'POST' && tokenMatch) {
    requireEndpoint(auth, authConfig, 'connections.token');
    requireScope(auth, 'health:connections:write');
    const tokenResult = await exchangeOAuthCode(tokenMatch[1] as ProviderId, await readJson<OAuthTokenRequest>(req, bodyLimitForRoute(authConfig, method, url.pathname)));
    auditEvent(req, 'success', { route: url.pathname, status: 200, auth });
    return sendJson(req, res, authConfig, 200, tokenResult);
  }

  const refreshMatch = url.pathname.match(/^\/connections\/([^/]+)\/refresh$/);
  if (method === 'POST' && refreshMatch) {
    requireEndpoint(auth, authConfig, 'connections.refresh');
    requireScope(auth, 'health:connections:write');
    const input = await readJson<{ refresh_token?: string; client_id?: string; client_secret?: string; scopes?: string[] }>(req, bodyLimitForRoute(authConfig, method, url.pathname));
    const refreshFirstParty = firstPartyOAuthFor(refreshMatch[1], authConfig);
    const refreshClientId = input.client_id ?? refreshFirstParty?.clientId;
    const refreshClientSecret = input.client_secret ?? refreshFirstParty?.clientSecret;
    if (!input.refresh_token || !refreshClientId || !refreshClientSecret) {
      throw new HttpError(400, 'refresh requires refresh_token, client_id, and client_secret (or a server-configured first-party app).');
    }
    const tokenSet = await refreshOAuthToken(refreshMatch[1] as ProviderId, { refresh_token: input.refresh_token, client_id: refreshClientId, client_secret: refreshClientSecret, scopes: input.scopes });
    auditEvent(req, 'success', { route: '/connections/:provider/refresh', status: 200, auth });
    return sendJson(req, res, authConfig, 200, tokenSet);
  }

  if (method === 'POST' && url.pathname === '/connections/wearables/callback') {
    requireEndpoint(auth, authConfig, 'connections.callback');
    requireScope(auth, 'health:connections:write');
    const input = await readJson<WearablesConnectionCallbackRequest>(req, bodyLimitForRoute(authConfig, method, url.pathname));
    requireUserAccess(auth, input.user_id);
    input.organization_id = resolveOrganizationId(auth, authConfig, input.organization_id);
    if (!input.organization_id) throw new HttpError(400, 'organization_id is required to register a wearable connection.');
    const provider = wearableProviderInfo(input.source_provider);
    if (!provider) throw new HttpError(400, `Unsupported wearable provider: ${input.source_provider}. Supported: whoop, oura, health_connect.`);
    const externalUserId = input.external_user_id ?? input.user_id;

    if (input.state?.startsWith('fb1.')) {
      assertFirstPartyConnectionState(input.state, input.source_provider, input.user_id, input.organization_id);
    }

    // Mobile-bridge providers register a bridge account without OAuth token exchange.
    const isBridge = provider.connection_type === 'mobile_bridge';
    // First-party fallback (see the start handler): fill in server credentials
    // when the caller only sends the authorization code.
    const firstParty = firstPartyOAuthFor(input.source_provider, authConfig);
    const callbackBaseUrl = publicBaseUrl(req, authConfig);
    const callbackInput = {
      ...input,
      client_id: input.client_id ?? firstParty?.clientId,
      client_secret: input.client_secret ?? firstParty?.clientSecret,
      redirect_uri: input.redirect_uri ?? firstParty?.defaultRedirectUri ?? `${callbackBaseUrl}/dashboard`,
    };
    if (!isBridge && (!callbackInput.code || !callbackInput.client_id || !callbackInput.client_secret || !callbackInput.redirect_uri)) {
      throw new HttpError(400, `${provider.display_name} OAuth callback requires code, client_id, client_secret, and redirect_uri (or a server-configured first-party app).`);
    }
    const tokenResult = isBridge ? undefined : await exchangeOAuthCode(input.source_provider, callbackInput);
    const account = await store.upsertExternalAccount({
      id: `acct_${randomUUID()}`,
      user_id: input.user_id,
      organization_id: input.organization_id,
      provider: input.source_provider,
      external_user_id: externalUserId,
      status: 'active',
      metadata: isBridge
        ? { source_provider: input.source_provider, connection_type: 'mobile_bridge' }
        : {
          source_provider: input.source_provider,
          token_storage: 'external_secret_store_required',
          token_response_keys: Object.keys(tokenResult && typeof tokenResult === 'object' && !Array.isArray(tokenResult) ? tokenResult as Record<string, unknown> : {}),
        },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    // First-party OAuth connections opt into encrypted token storage. WHOOP
    // uses it for webhook sync; Oura uses it for first-party on-demand sync.
    // BYO callers keep the stateless contract.
    let webhookEnabled = false;
    let serverSyncEnabled = false;
    if (!isBridge && input.source_provider === 'whoop' && firstParty && getTokenEncryptionKey()) {
      webhookEnabled = await persistWhoopTokens({
        store,
        account,
        tokenResult: tokenResult as OAuthTokenSet,
        key: getTokenEncryptionKey()!,
        authConfig,
      });
      serverSyncEnabled = webhookEnabled;
    } else if (!isBridge && input.source_provider === 'oura' && firstParty && getTokenEncryptionKey()) {
      serverSyncEnabled = await persistOuraTokens({
        store,
        account,
        tokenResult: tokenResult as OAuthTokenSet,
        key: getTokenEncryptionKey()!,
        authConfig,
      });
    }
    const event = await emitWebhookEvent(store, 'connection.completed', {
      userId: input.user_id,
      organizationId: input.organization_id,
      subjectId: account.id,
      requestId: requestId(req),
      data: {
        provider: 'wearables',
        source_provider: input.source_provider,
        external_account_id: account.id,
      },
    });
    auditEvent(req, 'success', { route: url.pathname, status: 200, auth });
    return sendJson(req, res, authConfig, 200, {
      provider: 'wearables',
      source_provider: input.source_provider,
      connection_type: provider.connection_type,
      external_account: account,
      connection_event_id: event.id,
      ...(isBridge ? {} : {
        token_storage: webhookEnabled ? 'server_encrypted_for_webhooks' : serverSyncEnabled ? 'server_encrypted_for_sync' : 'external_secret_store_required',
        webhook_sync_enabled: webhookEnabled,
        server_sync_enabled: serverSyncEnabled,
      }),
    });
  }

  const syncMatch = url.pathname.match(/^\/connections\/([^/]+)\/sync$/);
  if (method === 'POST' && url.pathname === '/connections/wearables/sync') {
    requireEndpoint(auth, authConfig, 'connections.sync');
    requireScope(auth, 'health:connections:write');
    throw new HttpError(410, 'This legacy wearable pull endpoint has been retired. Use the Wellnizz mobile SDK sync endpoint, or upload normalized Health Connect readings through POST /imports/file with category "wearables" and provider "health_connect".');
  }

  if (method === 'POST' && syncMatch) {
    requireEndpoint(auth, authConfig, 'connections.sync');
    requireScope(auth, 'health:connections:write');
    if (syncMatch[1] !== 'whoop' && syncMatch[1] !== 'oura') {
      throw new HttpError(404, 'Direct wearable sync supports WHOOP and Oura. Use the mobile SDK or file import for Health Connect data.');
    }
    const input = await readJson<ConnectorSyncRequest>(req, bodyLimitForRoute(authConfig, method, url.pathname));
    requireUserAccess(auth, input.user_id);
    input.organization_id = resolveOrganizationId(auth, authConfig, input.organization_id);
    assertPlanQuota(quotaLimiter, auth, 'connections.sync');
    assertUserQuota(quotaLimiter, quotaConfig, 'connections.sync', input.user_id, input.organization_id);
    let refreshedToken: unknown;
    const result = await withIdempotency(req, store, auth, url.pathname, async () => {
      const provider = syncMatch[1] as ProviderId;
      const firstParty = firstPartyOAuthFor(provider, authConfig);
      const ouraAccount = provider === 'oura'
        ? (await store.listExternalAccountsForUser(input.user_id, new Set([input.organization_id!]))).find(account => account.provider === 'oura' || (account.provider === 'wearables' && account.metadata.source_provider === 'oura'))
        : undefined;
      const ouraMemberId = input.provider_user_id
        ?? input.external_user_id
        ?? (typeof ouraAccount?.metadata.oura_user_id === 'string' ? ouraAccount.metadata.oura_user_id : undefined)
        ?? input.user_id;
      const stored = provider === 'oura' && firstParty && getTokenEncryptionKey() && !input.access_token && !input.refresh_token
        ? await store.getProviderTokenByExternalUser('oura', ouraMemberId)
        : undefined;
      const key = getTokenEncryptionKey();
      const providerInput = stored && key
        ? {
          ...input,
          access_token: stored.access_token_encrypted ? decryptToken(stored.access_token_encrypted, key) : undefined,
          refresh_token: stored.refresh_token_encrypted ? decryptToken(stored.refresh_token_encrypted, key) : undefined,
          client_id: firstParty?.clientId,
          client_secret: firstParty?.clientSecret,
        }
        : input;
      const syncResult = await syncWearableProvider(provider, providerInput);
      if (stored && key && syncResult.refreshed_token) {
        await saveRotatedProviderToken(store, stored, syncResult.refreshed_token, key);
      }
      // Rotated OAuth credentials are returned to the caller to persist, but must
      // never be written into the durable idempotency record. Hold them aside and
      // keep the persisted/replayed body free of token material.
      refreshedToken = syncResult.refreshed_token;
      const { refreshed_token, ...syncBody } = syncResult;
      if (syncResult.readings?.length) {
        const payload = Buffer.from(JSON.stringify(syncResult.raw), 'utf8');
        const source = buildSourceReference({
          user_id: input.user_id,
          organization_id: input.organization_id,
          category: 'wearables',
          provider: syncResult.provider,
          filename: `${syncResult.provider}-sync.json`,
          content_type: 'application/json',
          text: payload.toString('utf8'),
        }, payload);
        const observations = normalizeImportedFile(source, JSON.stringify({ readings: syncResult.readings }));
        await store.saveSource(source, observations);
        return { status: 200, body: { ...syncBody, source, normalized_observations: observations } };
      }
      return { status: 200, body: syncBody };
    });
    if (result.body && typeof result.body === 'object' && 'normalized_observations' in result.body) {
      await refreshWearableAnalysis(store, input.user_id, input.organization_id);
    }
    // Re-attach the rotated token only on a fresh sync (undefined on idempotent
    // replay, which is correct: the token was already delivered and has rotated).
    const responseBody = refreshedToken && result.body && typeof result.body === 'object'
      ? { ...(result.body as Record<string, unknown>), refreshed_token: refreshedToken }
      : result.body;
    auditEvent(req, 'success', { route: url.pathname, status: 200, auth });
    return sendJson(req, res, authConfig, result.status, responseBody);
  }

  const wearableJobMatch = url.pathname.match(/^\/connections\/wearables\/jobs\/([^/]+)$/);
  if (method === 'GET' && wearableJobMatch) {
    requireEndpoint(auth, authConfig, 'connections.jobs.read');
    requireScope(auth, 'health:connections:write');
    const job = await store.getConnectorSyncJob(wearableJobMatch[1]);
    if (!job) throw new HttpError(404, 'Wearable sync job not found.');
    requireResourceAccess(auth, authConfig, { userId: job.user_id, organizationId: job.organization_id });
    auditEvent(req, 'success', { route: '/connections/wearables/jobs/:id', status: 200, auth });
    return sendJson(req, res, authConfig, 200, connectorSyncJobSummary(job));
  }

  const scopedAnalysis = SCOPED_ANALYSIS_ROUTES[url.pathname];
  if (method === 'POST' && scopedAnalysis) {
    requireEndpoint(auth, authConfig, scopedAnalysis.endpointId);
    requireScope(auth, 'health:data:write');
    const input = await readJson<AnalysisInput>(req, bodyLimitForRoute(authConfig, method, url.pathname));
    input.annotation_depth = normalizeAnnotationDepth(input.annotation_depth);
    input.user_id ||= auth.userId;
    requireAnalysisInput(input);
    requireUserAccess(auth, input.user_id);
    const organizationId = resolveOrganizationId(auth, authConfig, input.organization_id);
    assertPlanQuota(quotaLimiter, auth, 'analyses.create');
    assertUserQuota(quotaLimiter, quotaConfig, 'analyses.create', input.user_id, organizationId);
    const sources = await store.getSourcesForUserAndOrganization(input.source_ids, input.user_id, organizationId);
    if (sources.length !== input.source_ids.length) throw new HttpError(404, 'One or more source_ids were not found.');
    if (sources.some(source => source.category !== scopedAnalysis.modality)) {
      throw new HttpError(400, `All source_ids must reference ${scopedAnalysis.modality} sources.`);
    }
    if (input.annotation_depth === 'full_dbsnp' && scopedAnalysis.modality !== 'genetics') {
      throw new HttpError(400, 'annotation_depth is only valid for genetics analyses.');
    }
    await enforceFullDbsnpAccess(auth, authConfig, organizationId, input.annotation_depth, billing);
    const result = await withIdempotency(req, store, auth, url.pathname, async () => {
      const analysis = await createStoredAnalysis(input, sources, store, organizationId, { ...scopedAnalysis, annotation_depth: input.annotation_depth });
      await emitAnalysisWebhook(req, store, analysis);
      return { status: 201, body: analysis };
    });
    auditEvent(req, 'success', { route: url.pathname, status: 201, auth });
    return sendJson(req, res, authConfig, result.status, result.body);
  }

  if (method === 'POST' && url.pathname === '/analyses') {
    requireEndpoint(auth, authConfig, 'analyses.create');
    requireScope(auth, 'health:data:write');
    const input = await readJson<AnalysisInput>(req, bodyLimitForRoute(authConfig, method, url.pathname));
    input.annotation_depth = normalizeAnnotationDepth(input.annotation_depth);
    input.user_id ||= auth.userId;
    requireAnalysisInput(input);
    requireUserAccess(auth, input.user_id);
    const organizationId = resolveOrganizationId(auth, authConfig, input.organization_id);
    assertPlanQuota(quotaLimiter, auth, 'analyses.create');
    assertUserQuota(quotaLimiter, quotaConfig, 'analyses.create', input.user_id, organizationId);
    const sources = await store.getSourcesForUserAndOrganization(input.source_ids, input.user_id, organizationId);
    if (sources.length !== input.source_ids.length) throw new HttpError(404, 'One or more source_ids were not found.');
    if (input.annotation_depth === 'full_dbsnp' && !sources.some(source => source.category === 'genetics')) {
      throw new HttpError(400, 'annotation_depth is only valid when source_ids includes a genetics source.');
    }
    await enforceFullDbsnpAccess(auth, authConfig, organizationId, input.annotation_depth, billing);
    const result = await withIdempotency(req, store, auth, url.pathname, async () => {
      const analysis = await createStoredAnalysis(input, sources, store, organizationId);
      await emitAnalysisWebhook(req, store, analysis);
      return { status: 201, body: analysis };
    });
    auditEvent(req, 'success', { route: url.pathname, status: 201, auth });
    return sendJson(req, res, authConfig, result.status, result.body);
  }

  if (method === 'GET' && url.pathname === '/analyses') {
    requireEndpoint(auth, authConfig, 'analyses.list');
    requireScope(auth, 'health:data:read');
    const userId = url.searchParams.get('user_id') ?? auth.userId;
    if (!userId) throw new HttpError(400, 'user_id is required to list analyses.');
    requireUserAccess(auth, userId);
    const organizationId = resolveOrganizationId(auth, authConfig, url.searchParams.get('organization_id') ?? undefined);
    const organizationIds = organizationId ? new Set([organizationId]) : auth.organizationIds;
    const modality = url.searchParams.get('modality') ?? undefined;
    const since = url.searchParams.get('since') ?? undefined;
    const limit = clampLimit(url.searchParams.get('limit'), 50, 200);
    const { analyses, total } = await store.listAnalysisSummaries(userId, organizationIds, { modality, since, limit });
    const summaries = analyses.map(summarizeAnalysis);
    auditEvent(req, 'success', { route: url.pathname, status: 200, auth });
    return sendJson(req, res, authConfig, 200, { analyses: summaries, count: summaries.length, total });
  }

  const analysisMatch = url.pathname.match(/^\/analyses\/([^/]+)$/);
  if (method === 'GET' && analysisMatch) {
    requireEndpoint(auth, authConfig, 'analyses.read');
    requireScope(auth, 'health:data:read');
    const analysis = await store.getAnalysis(analysisMatch[1]);
    if (!analysis) throw new HttpError(404, 'Analysis not found.');
    requireResourceAccess(auth, authConfig, { userId: analysis.user_id, organizationId: analysis.organization_id });
    auditEvent(req, 'success', { route: '/analyses/:id', status: 200, auth });
    return sendJson(req, res, authConfig, 200, analysis);
  }

  const recommendationsMatch = url.pathname.match(/^\/analyses\/([^/]+)\/recommendations$/);
  if (method === 'GET' && recommendationsMatch) {
    requireEndpoint(auth, authConfig, 'analyses.recommendations.read');
    requireScope(auth, 'health:data:read');
    const analysis = await store.getAnalysis(recommendationsMatch[1]);
    if (!analysis) throw new HttpError(404, 'Analysis not found.');
    requireResourceAccess(auth, authConfig, { userId: analysis.user_id, organizationId: analysis.organization_id });
    auditEvent(req, 'success', { route: '/analyses/:id/recommendations', status: 200, auth });
    return sendJson(req, res, authConfig, 200, buildRecommendations(analysis));
  }

  const actionPlanMatch = url.pathname.match(/^\/analyses\/([^/]+)\/action-plan$/);
  if (method === 'GET' && actionPlanMatch) {
    requireEndpoint(auth, authConfig, 'analyses.action_plan.read');
    requireScope(auth, 'health:data:read');
    const analysis = await store.getAnalysis(actionPlanMatch[1]);
    if (!analysis) throw new HttpError(404, 'Analysis not found.');
    requireResourceAccess(auth, authConfig, { userId: analysis.user_id, organizationId: analysis.organization_id });
    auditEvent(req, 'success', { route: '/analyses/:id/action-plan', status: 200, auth });
    return sendJson(req, res, authConfig, 200, buildActionPlan(analysis, {
      includeSupplementDoses: process.env.HEALTH_API_INCLUDE_SUPPLEMENT_DOSES === 'true',
    }));
  }

  const fullAnalysisMatch = url.pathname.match(/^\/analyses\/([^/]+)\/full-analysis$/);
  if (method === 'GET' && fullAnalysisMatch) {
    requireEndpoint(auth, authConfig, 'analyses.read');
    requireScope(auth, 'health:data:read');
    const analysis = await store.getAnalysis(fullAnalysisMatch[1]);
    if (!analysis) throw new HttpError(404, 'Analysis not found.');
    requireResourceAccess(auth, authConfig, { userId: analysis.user_id, organizationId: analysis.organization_id });
    const bytes = await store.getAnalysisArtifactSize(analysis.id);
    if (bytes === undefined) {
      throw new HttpError(404, 'No complete-analysis artifact is stored for this analysis. It predates artifact preservation, or durable object storage is not configured on this deployment.');
    }
    const downloadStore = analysisArtifactDownloadStore(store);
    const signed = downloadStore ? await downloadStore.createAnalysisArtifactDownload(analysis.id) : undefined;
    if (!signed) {
      throw new HttpError(503, 'Direct download of the complete analysis requires object storage (STORAGE_DRIVER=s3) on this deployment. The bounded inline analysis remains available at /analyses/{id}.');
    }
    auditEvent(req, 'success', { route: '/analyses/:id/full-analysis', status: 200, auth });
    return sendJson(req, res, authConfig, 200, {
      analysis_id: analysis.id,
      object_key: `analyses/${analysis.id}/full-analysis.json`,
      bytes,
      download_url: signed.download_url,
      expires_in_seconds: signed.expires_in_seconds,
      note: 'Fetch the complete, uncompacted analysis directly from download_url; it streams from object storage and never passes through the API server.',
    });
  }

  const geneticSliceMatch = url.pathname.match(/^\/analyses\/([^/]+)\/genetic-slice$/);
  if (method === 'GET' && geneticSliceMatch) {
    requireEndpoint(auth, authConfig, 'analyses.read');
    requireScope(auth, 'health:data:read');
    const analysis = await store.getAnalysis(geneticSliceMatch[1]);
    if (!analysis) throw new HttpError(404, 'Analysis not found.');
    requireResourceAccess(auth, authConfig, { userId: analysis.user_id, organizationId: analysis.organization_id });
    const gene = url.searchParams.get('gene') ?? undefined;
    const rsid = url.searchParams.get('rsid') ?? undefined;
    const significance = url.searchParams.get('significance') ?? undefined;
    const category = url.searchParams.get('category') ?? undefined;
    if (!gene && !rsid && !significance) {
      throw new HttpError(400, 'Provide at least one query parameter: gene, rsid, or significance.');
    }
    const geneticPipeline = analysis.derived_interpretations.find(item =>
      item.type === 'genetic_pipeline_analysis' && item.status === 'complete' && item.raw);
    if (!geneticPipeline?.raw) {
      throw new HttpError(404, 'No completed genetic pipeline results are available for this analysis. Wait for the WGS worker to finish or submit a new analysis.');
    }
    const dashboardRaw = (geneticPipeline.raw as Record<string, unknown>).dashboard;
    const metadata = dashboardRaw && typeof dashboardRaw === 'object' && !Array.isArray(dashboardRaw)
      ? (dashboardRaw as Record<string, unknown>).metadata
      : undefined;
    const inlineSliceIndex = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).genetic_slice_index as GeneticSliceIndex | undefined
      : undefined;
    // The slice index is offloaded to its own artifact (it indexes every variant
    // and can be tens of MB). Load it on demand when it is not inline.
    const sliceIndex = inlineSliceIndex ?? await loadOffloadedSliceIndex(store, geneticSliceMatch[1]!);
    const consumerGenetics = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).consumer_genetics as Record<string, unknown> | undefined
      : undefined;
    const insights = consumerGenetics && typeof consumerGenetics === 'object' && !Array.isArray(consumerGenetics)
      ? consumerGenetics.insights as Array<Record<string, unknown>> | undefined ?? undefined
      : undefined;
    const result = queryGeneticSlice(sliceIndex, insights, { gene, rsid, significance, category });
    auditEvent(req, 'success', { route: '/analyses/:id/genetic-slice', status: 200, auth });
    return sendJson(req, res, authConfig, 200, result);
  }

  const rerunMatch = url.pathname.match(/^\/analyses\/([^/]+)\/rerun$/);
  if (method === 'POST' && rerunMatch) {
    requireEndpoint(auth, authConfig, 'analyses.create');
    requireScope(auth, 'health:data:write');
    const existing = await store.getAnalysis(rerunMatch[1]);
    if (!existing) throw new HttpError(404, 'Analysis not found.');
    requireResourceAccess(auth, authConfig, { userId: existing.user_id, organizationId: existing.organization_id });
    const organizationId = existing.organization_id;
    const sources = await store.getSourcesForUserAndOrganization(existing.source_ids, existing.user_id, organizationId);
    if (sources.length === 0) throw new HttpError(409, 'Source data for this analysis is no longer available to re-run.');
    assertPlanQuota(quotaLimiter, auth, 'analyses.create');
    assertUserQuota(quotaLimiter, quotaConfig, 'analyses.create', existing.user_id, organizationId);
    const scopedModality = existing.modality === 'biomarkers' || existing.modality === 'wearables' || existing.modality === 'genetics'
      ? existing.modality
      : undefined;
    const analysis = await createStoredAnalysis(
      { user_id: existing.user_id, organization_id: organizationId, source_ids: existing.source_ids, annotation_depth: existing.annotation_depth },
      sources,
      store,
      organizationId,
      { modality: scopedModality, operation: existing.operation },
    );
    await emitAnalysisWebhook(req, store, analysis);
    auditEvent(req, 'success', { route: '/analyses/:id/rerun', status: 201, auth });
    return sendJson(req, res, authConfig, 201, analysis);
  }

  if (method === 'GET' && url.pathname === '/sources') {
    requireEndpoint(auth, authConfig, 'sources.list');
    requireScope(auth, 'health:data:read');
    const userId = url.searchParams.get('user_id') ?? auth.userId;
    if (!userId) throw new HttpError(400, 'user_id is required to list sources.');
    requireUserAccess(auth, userId);
    const organizationId = resolveOrganizationId(auth, authConfig, url.searchParams.get('organization_id') ?? undefined);
    const organizationIds = organizationId ? new Set([organizationId]) : auth.organizationIds;
    const category = url.searchParams.get('category') ?? undefined;
    const since = url.searchParams.get('since') ?? undefined;
    const limit = clampLimit(url.searchParams.get('limit'), 50, 200);
    const sources = (await store.listSourcesForUser(userId, organizationIds))
      .filter(source => category == null || source.category === category)
      .filter(source => since == null || source.received_at >= since)
      .sort((a, b) => b.received_at.localeCompare(a.received_at));
    const items = sources.slice(0, limit);
    auditEvent(req, 'success', { route: url.pathname, status: 200, auth });
    return sendJson(req, res, authConfig, 200, { sources: items, count: items.length, total: sources.length });
  }

  const sourceMatch = url.pathname.match(/^\/sources\/([^/]+)$/);
  if (method === 'GET' && sourceMatch) {
    requireEndpoint(auth, authConfig, 'sources.read');
    requireScope(auth, 'health:data:read');
    const source = await store.getSource(decodeURIComponent(sourceMatch[1]));
    if (!source) throw new HttpError(404, 'Source not found.');
    requireResourceAccess(auth, authConfig, { userId: source.user_id, organizationId: source.organization_id });
    const observations = await store.getObservations([source.id]);
    auditEvent(req, 'success', { route: '/sources/:id', status: 200, auth });
    return sendJson(req, res, authConfig, 200, { source, normalized_observations: observations });
  }

  if (method === 'POST' && url.pathname === '/genetics/ancestry') {
    requireEndpoint(auth, authConfig, 'genetics.ancestry.create');
    requireScope(auth, 'health:data:read');
    const input = await readJson<AncestryAnalysisInput>(req, bodyLimitForRoute(authConfig, method, url.pathname, OTP_BODY_BYTES));
    input.user_id ||= auth.userId;
    requireUserAccess(auth, input.user_id);
    const organizationId = resolveOrganizationId(auth, authConfig, input.organization_id);
    const source = await store.getSource(input.source_id);
    if (!source || source.user_id !== input.user_id || source.organization_id !== organizationId) throw new HttpError(404, 'Genetic source not found.');
    if (source.category !== 'genetics') throw new HttpError(400, 'source_id must reference an uploaded genetics source.');
    if (source.upload_status === 'pending') throw new HttpError(409, 'A genetics upload is still in progress. Finalize the direct upload before starting ancestry analysis.');
    const result = runAncestryAnalysis({ ...input, organization_id: organizationId }, source, await store.getSourcePayload(source.id));
    auditEvent(req, 'success', { route: '/genetics/ancestry', status: 200, auth });
    return sendJson(req, res, authConfig, 200, result);
  }

  const geneticJobMatch = url.pathname.match(/^\/genetics\/jobs\/([^/]+)$/);
  if (method === 'GET' && geneticJobMatch) {
    requireEndpoint(auth, authConfig, 'genetics.jobs.read');
    requireScope(auth, 'health:data:read');
    const job = await store.getGeneticAnalysisJob(geneticJobMatch[1]);
    if (!job) throw new HttpError(404, 'Genetic analysis job not found.');
    requireResourceAccess(auth, authConfig, { userId: job.user_id, organizationId: job.organization_id });
    auditEvent(req, 'success', { route: '/genetics/jobs/:id', status: 200, auth });
    return sendJson(req, res, authConfig, 200, {
      id: job.id,
      analysis_id: job.analysis_id,
      source_id: job.source_id,
      user_id: job.user_id,
      organization_id: job.organization_id,
      status: job.status,
      stage: job.stage,
      progress_pct: job.progress_pct,
      progress_message: job.progress_message,
      last_progress_at: job.last_progress_at,
      attempts: job.attempts,
      max_attempts: job.max_attempts,
      retryable: job.status !== 'complete' && job.attempts < job.max_attempts,
      reanalysis_recommended: job.reanalysis_recommended,
      reanalysis_reason: job.reanalysis_reason,
      created_at: job.created_at,
      updated_at: job.updated_at,
      started_at: job.started_at,
      completed_at: job.completed_at,
      error: job.error,
      result_summary: summarizeJobResult(job.result),
    });
  }

  const dashboardMatch = url.pathname.match(/^\/dashboard-specs\/([^/]+)$/);
  if (method === 'GET' && dashboardMatch) {
    requireEndpoint(auth, authConfig, 'dashboard_specs.read');
    requireScope(auth, 'health:data:read');
    const analysis = await store.getAnalysis(dashboardMatch[1]);
    if (!analysis) throw new HttpError(404, 'Dashboard spec not found.');
    requireResourceAccess(auth, authConfig, { userId: analysis.user_id, organizationId: analysis.organization_id });
    auditEvent(req, 'success', { route: '/dashboard-specs/:id', status: 200, auth });
    return sendJson(req, res, authConfig, 200, analysis.dashboard_spec);
  }

  if (method === 'POST' && url.pathname === '/dashboard-links') {
    requireEndpoint(auth, authConfig, 'dashboard_links.create');
    requireScope(auth, 'health:data:read');
    const input = await readJson<unknown>(req, bodyLimitForRoute(authConfig, method, url.pathname, OTP_BODY_BYTES));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Request body must be a JSON object.');
    const dashboardInput = input as { analysis_id?: unknown; design_id?: unknown; expires_in_days?: unknown };
    if (typeof dashboardInput.analysis_id !== 'string' || !dashboardInput.analysis_id.trim()) throw new HttpError(400, 'analysis_id is required.');
    if (typeof dashboardInput.design_id !== 'string' || !dashboardInput.design_id.trim()) throw new HttpError(400, 'design_id is required. Choose one from GET /design/systems.');
    const analysis = await store.getAnalysis(dashboardInput.analysis_id);
    if (!analysis) throw new HttpError(404, 'Analysis not found.');
    requireResourceAccess(auth, authConfig, { userId: analysis.user_id, organizationId: analysis.organization_id });
    const design = getDesignSystem(dashboardInput.design_id);
    if (!design) throw new HttpError(400, 'Unknown design_id. Choose one from GET /design/systems.');
    let result;
    try {
      result = createPrivateDashboardLink({
        analysisId: analysis.id,
        dashboardSpec: analysis.dashboard_spec,
        design,
        expiresInDays: dashboardInput.expires_in_days as number | undefined,
        secret: dashboardLinkSecret(authConfig),
        baseUrl: dashboardLinkBaseUrl(req, authConfig),
        requireHttps: authConfig.requireHttps,
      });
    } catch (error) {
      if (error instanceof DashboardLinkValidationError) throw new HttpError(400, error.message);
      if (error instanceof DashboardLinkConfigurationError) throw new HttpError(503, error.message);
      throw error;
    }
    auditEvent(req, 'success', { route: url.pathname, status: 201, auth });
    return sendJson(req, res, authConfig, 201, result);
  }

  if (method === 'POST' && url.pathname === '/query') {
    requireEndpoint(auth, authConfig, 'query.create');
    requireScope(auth, 'health:data:read');
    const input = await readJson<{ user_id?: string; organization_id?: string; query: string; analysis_ids?: string[] }>(req, bodyLimitForRoute(authConfig, method, url.pathname));
    input.user_id ||= auth.userId;
    requireUserAccess(auth, input.user_id);
    const organizationId = resolveOrganizationId(auth, authConfig, input.organization_id);
    assertPlanQuota(quotaLimiter, auth, 'query.create');
    const organizationIds = organizationId ? new Set([organizationId]) : auth.organizationIds;
    const analyses = await store.getAnalysesForUser(input.analysis_ids ?? [], input.user_id, organizationIds);
    auditEvent(req, 'success', { route: url.pathname, status: 200, auth });
    return sendJson(req, res, authConfig, 200, queryHealthContext(await store.getUserObservations(input.user_id, organizationIds), analyses, input.query));
  }

  const healthContextMatch = url.pathname.match(/^\/users\/([^/]+)\/health-context$/);
  if (method === 'POST' && healthContextMatch) {
    requireEndpoint(auth, authConfig, 'health_context.read');
    requireScope(auth, 'health:data:read');
    const userId = decodeURIComponent(healthContextMatch[1]);
    const input = await readJson<{ organization_id?: string; analysis_ids?: string[]; max_findings?: number }>(req, bodyLimitForRoute(authConfig, method, url.pathname, OTP_BODY_BYTES));
    requireUserAccess(auth, userId);
    const organizationId = resolveOrganizationId(auth, authConfig, input.organization_id);
    const cacheKey = healthContextCacheKey(auth, userId, organizationId, input);
    const cached = readCache(responseCache, cacheKey);
    if (cached) {
      auditEvent(req, 'success', { route: '/users/:user_id/health-context', status: 200, auth });
      return sendJson(req, res, authConfig, 200, cached, { 'x-cache': 'HIT' });
    }
    assertPlanQuota(quotaLimiter, auth, 'health_context.read');
    const organizationIds = organizationId ? new Set([organizationId]) : auth.organizationIds;
    const analyses = await store.getAnalysesForUser(input.analysis_ids ?? [], userId, organizationIds);
    const observations = await store.getUserObservations(userId, organizationIds);
    const context = buildHealthContext({
      userId,
      organizationId,
      observations,
      analyses,
      maxFindings: input.max_findings,
    });
    writeCache(responseCache, cacheKey, context, 60_000);
    auditEvent(req, 'success', { route: '/users/:user_id/health-context', status: 200, auth });
    return sendJson(req, res, authConfig, 200, context, { 'x-cache': 'MISS' });
  }

  const trendsMatch = url.pathname.match(/^\/users\/([^/]+)\/trends$/);
  if (method === 'POST' && trendsMatch) {
    requireEndpoint(auth, authConfig, 'trends.read');
    requireScope(auth, 'health:data:read');
    const userId = decodeURIComponent(trendsMatch[1]);
    const input = await readJson<{ organization_id?: string; markers?: string[]; modality?: SourceCategory; window_days?: number }>(req, bodyLimitForRoute(authConfig, method, url.pathname, OTP_BODY_BYTES));
    requireUserAccess(auth, userId);
    const organizationId = resolveOrganizationId(auth, authConfig, input.organization_id);
    const organizationIds = organizationId ? new Set([organizationId]) : auth.organizationIds;
    const [observations, sources] = await Promise.all([
      store.getUserObservations(userId, organizationIds),
      store.listSourcesForUser(userId, organizationIds),
    ]);
    const result = buildHealthTrends({
      userId,
      organizationId,
      observations,
      sources,
      options: { markers: input.markers, modality: input.modality, windowDays: input.window_days },
    });
    auditEvent(req, 'success', { route: '/users/:user_id/trends', status: 200, auth });
    return sendJson(req, res, authConfig, 200, result);
  }

  const remindersMatch = url.pathname.match(/^\/users\/([^/]+)\/retest-reminders$/);
  if (method === 'GET' && remindersMatch) {
    requireEndpoint(auth, authConfig, 'retest_reminders.read');
    requireScope(auth, 'health:data:read');
    const userId = decodeURIComponent(remindersMatch[1]);
    requireUserAccess(auth, userId);
    const organizationId = resolveOrganizationId(auth, authConfig, url.searchParams.get('organization_id') ?? undefined);
    const organizationIds = organizationId ? new Set([organizationId]) : auth.organizationIds;
    const [observations, sources] = await Promise.all([
      store.getUserObservations(userId, organizationIds),
      store.listSourcesForUser(userId, organizationIds),
    ]);
    const reminders = computeRetestReminders({ sources, observations });
    auditEvent(req, 'success', { route: '/users/:user_id/retest-reminders', status: 200, auth });
    return sendJson(req, res, authConfig, 200, { user_id: userId, organization_id: organizationId, generated_at: new Date().toISOString(), reminders });
  }

  const goalsCollectionMatch = url.pathname.match(/^\/users\/([^/]+)\/goals$/);
  if (goalsCollectionMatch) {
    const userId = decodeURIComponent(goalsCollectionMatch[1]);
    if (method === 'POST') {
      requireEndpoint(auth, authConfig, 'goals.create');
      requireScope(auth, 'health:data:write');
      const input = await readJson<{ title?: string; metric?: string; target_value?: number; target_unit?: string; target_direction?: GoalDirection; due_date?: string; note?: string; organization_id?: string }>(req, bodyLimitForRoute(authConfig, method, url.pathname, OTP_BODY_BYTES));
      requireUserAccess(auth, userId);
      const organizationId = resolveOrganizationId(auth, authConfig, input.organization_id);
      validateGoalInput(input, { partial: false });
      const now = new Date().toISOString();
      const goal: Goal = {
        id: createId('goal'),
        user_id: userId,
        organization_id: organizationId,
        title: input.title!.trim(),
        metric: input.metric,
        target_value: input.target_value,
        target_unit: input.target_unit,
        target_direction: input.target_direction,
        due_date: input.due_date,
        status: 'active',
        note: input.note,
        created_at: now,
        updated_at: now,
      };
      const result = await withIdempotency(req, store, auth, url.pathname, async () => {
        await store.createGoal(goal);
        await emitWebhookEvent(store, 'goal.created', { userId, organizationId, subjectId: goal.id, requestId: requestId(req), data: { goal_id: goal.id, metric: goal.metric } });
        return { status: 201, body: goal };
      });
      auditEvent(req, 'success', { route: '/users/:user_id/goals', status: 201, auth });
      return sendJson(req, res, authConfig, result.status, result.body);
    }
    if (method === 'GET') {
      requireEndpoint(auth, authConfig, 'goals.list');
      requireScope(auth, 'health:data:read');
      requireUserAccess(auth, userId);
      const organizationId = resolveOrganizationId(auth, authConfig, url.searchParams.get('organization_id') ?? undefined);
      const organizationIds = organizationId ? new Set([organizationId]) : auth.organizationIds;
      const goals = await store.listGoals(userId, organizationIds);
      auditEvent(req, 'success', { route: '/users/:user_id/goals', status: 200, auth });
      return sendJson(req, res, authConfig, 200, { user_id: userId, count: goals.length, goals });
    }
  }

  const goalDeleteMatch = url.pathname.match(/^\/goals\/([^/]+)\/delete$/);
  if (method === 'POST' && goalDeleteMatch) {
    requireEndpoint(auth, authConfig, 'goals.delete');
    requireScope(auth, 'health:data:write');
    const goal = await store.getGoal(goalDeleteMatch[1]);
    if (!goal) throw new HttpError(404, 'Goal not found.');
    requireResourceAccess(auth, authConfig, { userId: goal.user_id, organizationId: goal.organization_id });
    await store.deleteGoal(goal.id);
    auditEvent(req, 'success', { route: '/goals/:id/delete', status: 200, auth });
    return sendJson(req, res, authConfig, 200, { deleted: true, goal_id: goal.id });
  }

  const goalMatch = url.pathname.match(/^\/goals\/([^/]+)$/);
  if (goalMatch) {
    const goal = await store.getGoal(goalMatch[1]);
    if (!goal) throw new HttpError(404, 'Goal not found.');
    requireResourceAccess(auth, authConfig, { userId: goal.user_id, organizationId: goal.organization_id });
    if (method === 'GET') {
      requireEndpoint(auth, authConfig, 'goals.read');
      requireScope(auth, 'health:data:read');
      auditEvent(req, 'success', { route: '/goals/:id', status: 200, auth });
      return sendJson(req, res, authConfig, 200, goal);
    }
    if (method === 'POST') {
      requireEndpoint(auth, authConfig, 'goals.update');
      requireScope(auth, 'health:data:write');
      const patch = await readJson<{ title?: string; metric?: string; target_value?: number; target_unit?: string; target_direction?: GoalDirection; due_date?: string; status?: GoalStatus; note?: string }>(req, bodyLimitForRoute(authConfig, method, url.pathname, OTP_BODY_BYTES));
      validateGoalInput(patch, { partial: true });
      const updated = await store.updateGoal(goal.id, patch);
      auditEvent(req, 'success', { route: '/goals/:id', status: 200, auth });
      return sendJson(req, res, authConfig, 200, updated);
    }
  }

  if (method === 'GET' && url.pathname === '/providers') {
    requireEndpoint(auth, authConfig, 'providers.search');
    requireScope(auth, 'health:data:read');
    const lat = url.searchParams.get('lat');
    const lon = url.searchParams.get('lon');
    auditEvent(req, 'success', { route: url.pathname, status: 200, auth });
    return sendJson(req, res, authConfig, 200, await findProviders({
      modalities: parseModalities(url.searchParams.get('modality') ?? url.searchParams.get('modalities')),
      type: url.searchParams.get('type') ?? undefined,
      region: url.searchParams.get('region') ?? undefined,
      lab_provider: (url.searchParams.get('lab_provider') as 'quest' | 'synlab' | 'all' | null) ?? undefined,
      postal_code: url.searchParams.get('postal_code') ?? undefined,
      city: url.searchParams.get('city') ?? undefined,
      country: url.searchParams.get('country') ?? undefined,
      lat: lat == null ? undefined : Number(lat),
      lon: lon == null ? undefined : Number(lon),
      radius_miles: url.searchParams.get('radius_miles') == null ? undefined : Number(url.searchParams.get('radius_miles')),
    }), publicCacheHeaders(300));
  }

  if (method === 'GET' && url.pathname === '/labs/search') {
    requireEndpoint(auth, authConfig, 'labs.search');
    requireScope(auth, 'health:labs:read');
    const lat = url.searchParams.get('lat');
    const lon = url.searchParams.get('lon');
    auditEvent(req, 'success', { route: url.pathname, status: 200, auth });
    return sendJson(req, res, authConfig, 200, {
      results: await searchLabs({
        provider: (url.searchParams.get('provider') as 'quest' | 'synlab' | 'all' | null) ?? 'all',
        postal_code: url.searchParams.get('postal_code') ?? undefined,
        city: url.searchParams.get('city') ?? undefined,
        country: url.searchParams.get('country') ?? undefined,
        lat: lat == null ? undefined : Number(lat),
        lon: lon == null ? undefined : Number(lon),
        radius_miles: Number(url.searchParams.get('radius_miles') ?? '25'),
      }),
    });
  }

  if (method === 'GET' && url.pathname === '/wgs-providers') {
    requireEndpoint(auth, authConfig, 'wgs_providers.list');
    requireScope(auth, 'health:data:read');
    const type = url.searchParams.get('type') ?? 'all';
    const region = url.searchParams.get('region') ?? undefined;
    auditEvent(req, 'success', { route: url.pathname, status: 200, auth });
    return sendJson(req, res, authConfig, 200, {
      providers: listWgsProviders({ type, region }),
    }, publicCacheHeaders(3600));
  }

  const wgsProviderMatch = url.pathname.match(/^\/wgs-providers\/([^/]+)$/);
  if (method === 'GET' && wgsProviderMatch) {
    requireEndpoint(auth, authConfig, 'wgs_providers.read');
    requireScope(auth, 'health:data:read');
    const provider = getWgsProvider(decodeURIComponent(wgsProviderMatch[1]));
    if (!provider) throw new HttpError(404, 'WGS provider not found.');
    auditEvent(req, 'success', { route: '/wgs-providers/:id', status: 200, auth });
    return sendJson(req, res, authConfig, 200, provider, publicCacheHeaders(3600));
  }

  const deleteDataMatch = url.pathname.match(/^\/users\/([^/]+)\/data\/delete$/);
  if (method === 'POST' && deleteDataMatch) {
    requireEndpoint(auth, authConfig, 'data.delete');
    requireScope(auth, 'health:data:write');
    const input = await readJson<{ organization_id?: string }>(req, bodyLimitForRoute(authConfig, method, url.pathname, OTP_BODY_BYTES));
    const userId = decodeURIComponent(deleteDataMatch[1]);
    requireUserAccess(auth, userId);
    const organizationId = resolveOrganizationId(auth, authConfig, input.organization_id);
    const result = await store.tombstoneUserData(userId, organizationId);
    result.request_id = requestId(req);
    const event = await emitWebhookEvent(store, 'data.deleted', {
      userId,
      organizationId,
      requestId: requestId(req),
      data: {
        receipt_id: result.receipt_id,
        counts: {
          sources: result.sources,
          observations: result.observations,
          analyses: result.analyses,
          dashboard_specs: result.dashboard_specs,
        },
        affected_source_ids: result.affected_source_ids,
      },
    });
    result.event_id = event.id;
    auditEvent(req, 'success', { route: '/users/:user_id/data/delete', status: 200, auth });
    return sendJson(req, res, authConfig, 200, result);
  }

  const exportDataMatch = url.pathname.match(/^\/users\/([^/]+)\/data\/export$/);
  if (method === 'POST' && exportDataMatch) {
    requireEndpoint(auth, authConfig, 'data.export');
    requireScope(auth, 'health:data:read');
    const input = await readJson<{ organization_id?: string }>(req, bodyLimitForRoute(authConfig, method, url.pathname, OTP_BODY_BYTES));
    const userId = decodeURIComponent(exportDataMatch[1]);
    requireUserAccess(auth, userId);
    const organizationId = resolveOrganizationId(auth, authConfig, input.organization_id);
    const result = await store.exportUserData(userId, organizationId, requestId(req));
    const event = await emitWebhookEvent(store, 'export.ready', {
      userId,
      organizationId,
      requestId: requestId(req),
      data: {
        receipt_id: result.receipt_id,
        counts: result.counts,
      },
    });
    auditEvent(req, 'success', { route: '/users/:user_id/data/export', status: 200, auth });
    return sendJson(req, res, authConfig, 200, { ...result, event_id: event.id });
  }

  if (method === 'POST' && url.pathname === '/mcp') {
    const result = await handleMcpRequest(await readJson(req, bodyLimitForRoute(authConfig, method, url.pathname)), store, auth, authConfig, requestId(req), dashboardLinkBaseUrl(req, authConfig));
    auditEvent(req, isMcpErrorResponse(result) ? 'error' : 'success', { route: url.pathname, status: 200, auth });
    return sendJson(req, res, authConfig, 200, result);
  }

  throw new HttpError(404, `Route not found: ${method} ${originalUrl.pathname}`);
}

function requiresQueuedGeneticPreSave(sources: Array<{ category: string }>): boolean {
  const mode = process.env.HEALTH_ANALYSIS_EXECUTION_MODE ?? process.env.GENOMIC_ANALYSIS_EXECUTION_MODE;
  return mode === 'queue' && sources.some(source => source.category === 'genetics');
}

function requireAnalysisInput(input: AnalysisInput): void {
  if (!input.user_id || !Array.isArray(input.source_ids) || input.source_ids.length === 0) {
    throw new HttpError(400, 'user_id and at least one source_id are required.');
  }
}

function normalizeAnnotationDepth(value: unknown): GeneticsAnnotationDepth | undefined {
  if (value == null || value === '') return undefined;
  if (value === 'compact' || value === 'full_dbsnp') return value;
  throw new HttpError(400, 'annotation_depth must be "compact" or "full_dbsnp".');
}

function fullDbsnpConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HEALTH_ANALYSIS_FULL_DBSNP_ENABLED === 'true'
    && Boolean(env.HEALTH_ANALYSIS_DBSNP_GRCH37_PATH);
}

async function enforceFullDbsnpAccess(
  auth: AuthContext,
  authConfig: AuthConfig,
  organizationId: string | undefined,
  annotationDepth: GeneticsAnnotationDepth | undefined,
  billing: StripeBillingService | undefined,
): Promise<void> {
  if (annotationDepth !== 'full_dbsnp') return;
  if (!fullDbsnpConfigured()) {
    throw new HttpError(503, 'Full dbSNP annotation is not provisioned on this deployment. Use compact annotation or ask the operator to configure the GRCh37 dbSNP worker reference.');
  }
  if (billing && !isBillingAdmin(auth, authConfig)) {
    if (!organizationId) throw new HttpError(400, 'organization_id is required for hosted full dbSNP annotation.');
    await billing.assertFullDbsnpAccess(auth.userId, organizationId);
  }
}

function clampLimit(raw: string | null, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}


async function createStoredAnalysis(
  input: AnalysisInput,
  sources: RawSourceReference[],
  store: HealthStore,
  organizationId: string | undefined,
  options: AnalysisOptions = {},
): Promise<AnalysisResult> {
  if (sources.some(source => source.category === 'genetics' && source.upload_status === 'pending')) {
    throw new HttpError(409, 'A genetics upload is still in progress. Finalize the direct upload before starting analysis.');
  }
  const analysisOptions: AnalysisOptions = {
    ...options,
    ...(input.annotation_depth ? { annotation_depth: input.annotation_depth } : {}),
    ...(options.modality === 'wearables' ? { timezone: await resolveWearableTimezone(store, input.user_id, organizationId) } : {}),
  };
  const baseAnalysis = runHealthAnalysis(
    input.user_id,
    sources,
    await store.getObservations(input.source_ids),
    input.profile,
    organizationId,
    analysisOptions,
  );
  if (requiresQueuedGeneticPreSave(sources)) await store.saveAnalysis(baseAnalysis);
  const analysis = await enrichAnalysisWithGeneticPipeline(baseAnalysis, sources, store, { annotation_depth: input.annotation_depth });
  await store.saveAnalysis(analysis);
  await requestQueuedWgsCapacity(analysis, store);
  return analysis;
}

async function requestQueuedWgsCapacity(analysis: AnalysisResult, store: HealthStore): Promise<void> {
  const queued = analysis.derived_interpretations.find(item => item.type === 'genetic_pipeline_queued');
  const raw = queued?.raw;
  const jobId = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).job_id : undefined;
  if (typeof jobId !== 'string') return;
  const dispatch = await dispatchQueuedWgsWorker();
  await store.updateGeneticAnalysisJobProgress(jobId, {
    stage: 'queued',
    progress_pct: 0,
    progress_message: dispatch.message,
  });
}

// Refresh the stored wearables analysis after new wearable data lands so the
// dashboard's "latest analysis" is never stale. Best-effort: a failure here must
// not fail the ingest that already persisted the data.
async function refreshWearableAnalysis(store: HealthStore, userId: string, organizationId?: string): Promise<void> {
  try {
    await runWearableAutoAnalysis(store, userId, organizationId);
  } catch (error) {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      service: 'wellnizz-api',
      event: 'wearable_auto_analysis_failed',
      user_id: userId,
      organization_id: organizationId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function emitAnalysisWebhook(req: IncomingMessage, store: HealthStore, analysis: AnalysisResult): Promise<void> {
  const geneticQueued = analysis.derived_interpretations.find(item => item.type === 'genetic_pipeline_queued');
  await emitWebhookEvent(store, geneticQueued ? 'genetics.job.queued' : 'analysis.completed', {
    userId: analysis.user_id,
    organizationId: analysis.organization_id,
    subjectId: analysis.id,
    requestId: requestId(req),
    data: {
      analysis_id: analysis.id,
      modality: analysis.modality,
      operation: analysis.operation,
      source_ids: analysis.source_ids,
      derived_interpretations: analysis.derived_interpretations.length,
      genetic_job_id: geneticQueued?.raw && typeof geneticQueued.raw === 'object'
        ? (geneticQueued.raw as Record<string, unknown>).job_id
        : undefined,
    },
  });
}

function isSelfServePersonalApiKey(input: ApiKeyCreateRequest, auth: AuthContext): boolean {
  if (auth.scopes.has('health:admin')) return false;
  const intendedUse = input.intended_use ?? 'personal_agent';
  const tier = input.tier ?? (intendedUse === 'app_platform_service' ? 'builder' : 'free');
  if (!['personal_agent', 'mobile_sync'].includes(intendedUse) || tier !== 'free') return false;
  if (input.user_id && input.user_id !== auth.userId) return false;
  if (!input.organization_id) return true;
  return input.organization_id === personalOrganizationId(auth.userId)
    || auth.organizationIds?.has(input.organization_id) === true;
}

function summarizeJobResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  return {
    status: record.status,
    summary: record.summary,
    raw: record.raw,
  };
}

interface GeneticsUploadInitInput {
  user_id: string;
  organization_id?: string;
  filename: string;
  byte_length: number;
  content_type?: string;
  provider?: string;
}

type DirectGeneticsUploadStore = HealthStore & {
  createSignedPayloadUpload(objectKey: string, contentType?: string): Promise<SignedPayloadUpload>;
  uploadedPayloadSize(objectKey: string): Promise<number | undefined>;
  directPayloadUploadsEnabled?: () => boolean;
};

function directGeneticsUploadStore(store: HealthStore): DirectGeneticsUploadStore | undefined {
  const candidate = store as Partial<DirectGeneticsUploadStore>;
  return typeof candidate.createSignedPayloadUpload === 'function'
    && typeof candidate.uploadedPayloadSize === 'function'
    && (typeof candidate.directPayloadUploadsEnabled !== 'function' || candidate.directPayloadUploadsEnabled())
    ? candidate as DirectGeneticsUploadStore
    : undefined;
}

type ArtifactDownloadStore = HealthStore & {
  createAnalysisArtifactDownload(analysisId: string): Promise<{ download_url: string; expires_in_seconds: number } | undefined>;
};

function analysisArtifactDownloadStore(store: HealthStore): ArtifactDownloadStore | undefined {
  const candidate = store as Partial<ArtifactDownloadStore>;
  return typeof candidate.createAnalysisArtifactDownload === 'function'
    ? candidate as ArtifactDownloadStore
    : undefined;
}

function validatedGeneticsFilename(filename: string): string {
  const value = filename.trim().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160);
  if (!/\.(vcf|txt|tsv|csv|snp|raw)(\.gz)?$/i.test(value)) {
    throw new HttpError(400, 'Genetics uploads must be VCF/VCF.GZ or a SNP-array raw export (.txt, .tsv, .csv, .snp, or .raw; optional .gz).');
  }
  return value;
}

function geneticsContentType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.gz')) return 'application/gzip';
  if (lower.endsWith('.vcf')) return 'text/vcf';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.tsv')) return 'text/tab-separated-values';
  return 'text/plain';
}

function validatedGeneticsUploadBytes(value: number): number {
  const maxBytes = Number(process.env.MAX_GENETICS_UPLOAD_BYTES ?? 512 * 1024 * 1024);
  if (!Number.isFinite(value) || value <= 0) throw new HttpError(400, 'byte_length must be a positive number.');
  if (value > maxBytes) throw new HttpError(413, `Genetics upload exceeds the configured ${formatByteLimit(maxBytes)} limit.`);
  return Math.floor(value);
}

function formatByteLimit(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return mib < 1024 ? `${Math.round(mib)} MB` : `${(mib / 1024).toFixed(1).replace(/\\.0$/, '')} GB`;
}

function geneticsUploadSession(source: RawSourceReference, upload: SignedPayloadUpload): Record<string, unknown> {
  return {
    source_id: source.id,
    status: 'uploading',
    source,
    upload: {
      protocol: 's3-presigned-put',
      url: upload.upload_url,
      method: upload.method,
      headers: upload.headers,
      expires_in_seconds: upload.expires_in_seconds,
      object: {
        bucket_name: upload.bucket_name,
        object_key: upload.object_key,
        content_type: source.content_type,
      },
    },
    finalize: {
      method: 'POST',
      endpoint: `/genetics/uploads/${source.id}/complete`,
      body: { user_id: source.user_id, organization_id: source.organization_id },
    },
  };
}

async function ingestHealthConnectSdkPayload(
  payload: HealthConnectSdkPayload,
  userId: string,
  organizationId: string,
  store: HealthStore,
): Promise<{ source: RawSourceReference; readings_count: number }> {
  const provider = payload.provider?.toLowerCase();
  if (provider !== 'google' && provider !== 'health_connect') {
    throw new HttpError(400, 'Health Connect sync payload provider must be "google" or "health_connect".');
  }
  if (!payload.sdkVersion || !payload.syncTimestamp || !payload.data) {
    throw new HttpError(400, 'Health Connect sync payload requires sdkVersion, syncTimestamp, and data.');
  }

  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const source = buildSourceReference({
    user_id: userId,
    organization_id: organizationId,
    category: 'wearables',
    provider: 'health_connect',
    filename: `health-connect-${payload.syncTimestamp.replace(/[^a-zA-Z0-9]+/g, '-')}.json`,
    content_type: 'application/json',
  }, raw);
  const observations = normalizeHealthConnectPayload(source, payload.data);
  await store.saveSource(source, observations, raw);
  await store.upsertExternalAccount({
    id: `acct_${randomUUID()}`,
    user_id: userId,
    organization_id: organizationId,
    provider: 'health_connect',
    external_user_id: userId,
    status: 'active',
    last_synced_at: new Date().toISOString(),
    metadata: {
      source_provider: 'health_connect',
      connection_type: 'mobile_bridge',
      mobile_sync_enabled: true,
      last_batch_readings: observations.length,
      last_sync_timestamp: payload.syncTimestamp,
      ...(typeof payload.timezone === 'string' && payload.timezone ? { timezone: payload.timezone } : {}),
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return { source, readings_count: observations.length };
}

async function readJson<T = unknown>(req: IncomingMessage, maxBodyBytes = 10 * 1024 * 1024): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBodyBytes) throw new HttpError(413, 'Request body is too large.');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

async function readRawBody(req: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBodyBytes) throw new HttpError(413, 'Request body is too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(req: IncomingMessage, res: ServerResponse, config: AuthConfig, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const trace = traceContext(req);
  res.writeHead(status, {
    ...securityHeaders(config, req.headers.origin),
    'x-request-id': requestId(req),
    'x-trace-id': trace.trace_id,
    traceparent: trace.traceparent,
    ...extraHeaders,
  });
  res.end(status === 204 ? undefined : JSON.stringify(body, null, 2));
}

function sendHtml(req: IncomingMessage, res: ServerResponse, config: AuthConfig, status: number, body: string): void {
  const trace = traceContext(req);
  res.writeHead(status, {
    ...securityHeaders(config, req.headers.origin),
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'private, no-store, max-age=0',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-robots-tag': 'noindex, nofollow, noarchive',
    'x-request-id': requestId(req),
    'x-trace-id': trace.trace_id,
    traceparent: trace.traceparent,
  });
  res.end(body);
}

function sendRedirect(req: IncomingMessage, res: ServerResponse, config: AuthConfig, location: string): void {
  res.writeHead(302, {
    ...securityHeaders(config, req.headers.origin),
    'cache-control': 'public, max-age=300',
    location,
  });
  res.end();
}

function publicCacheHeaders(seconds: number): Record<string, string> {
  return {
    'cache-control': `public, max-age=${seconds}, stale-while-revalidate=${seconds}`,
  };
}

function healthContextCacheKey(auth: AuthContext, userId: string, organizationId: string | undefined, input: { analysis_ids?: string[]; max_findings?: number }): string {
  return JSON.stringify({
    subject: auth.subject,
    user_id: userId,
    organization_id: organizationId ?? null,
    analysis_ids: [...(input.analysis_ids ?? [])].sort(),
    max_findings: input.max_findings ?? null,
  });
}

function readCache(cache: Map<string, CacheEntry>, key: string): unknown | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.body;
}

function writeCache(cache: Map<string, CacheEntry>, key: string, body: unknown, ttlMs: number): void {
  if (cache.size > 1000) {
    const now = Date.now();
    for (const [itemKey, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(itemKey);
    }
  }
  cache.set(key, { body, expiresAt: Date.now() + ttlMs });
}

function isMcpErrorResponse(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && 'error' in result);
}

function requireEndpoint(auth: Awaited<ReturnType<typeof authenticate>>, config: AuthConfig, endpointId: EndpointId): void {
  requireEndpointAccess(auth, config, endpointId);
}

function assertPlanQuota(limiter: InMemoryRateLimiter, auth: AuthContext, id: TierQuotaId): void {
  assertTierQuota(limiter, auth, id);
}

async function applyCurrentBillingTier(auth: AuthContext, billing: StripeBillingService): Promise<void> {
  const organizationId = auth.organizationIds?.size === 1
    ? Array.from(auth.organizationIds)[0]
    : personalOrganizationId(auth.userId);
  const activeTier = await billing.activeTierFor(auth.userId, organizationId);
  // Stripe is the authority. This also lets the dashboard's short-lived free
  // session acquire the purchased tier immediately after Checkout, rather than
  // requiring a user to mint a replacement API key before continuing.
  (auth.claims as Record<string, unknown>).tier = activeTier ?? 'free';
}

function isHostedIntroductoryRequest(method: string, pathname: string): boolean {
  if (pathname.startsWith('/billing/') || pathname.startsWith('/auth/') || pathname.startsWith('/agent-login/')) return false;
  if (pathname === '/api-keys' || pathname === '/capabilities' || pathname === '/pricing' || pathname === '/endpoints') return false;
  // Every remaining authenticated data request is a meaningful part of the
  // evaluation workflow (including MCP tool calls), while browser assets and
  // public health/readiness endpoints return before authentication.
  return method !== 'OPTIONS';
}

async function withIdempotency(
  req: IncomingMessage,
  store: HealthStore,
  auth: AuthContext,
  route: string,
  handler: () => Promise<ResponsePayload>,
): Promise<ResponsePayload> {
  const key = idempotencyKey(req);
  if (!key) return handler();
  const method = req.method ?? 'GET';
  const existing = await store.getIdempotencyRecord(key, method, route, auth.subject);
  if (existing) return { status: existing.status, body: existing.body };
  const response = await handler();
  const record: IdempotencyRecord = {
    key,
    method,
    route,
    subject: auth.subject,
    status: response.status,
    body: response.body,
    created_at: new Date().toISOString(),
  };
  await store.saveIdempotencyRecord(record);
  return response;
}

function idempotencyKey(req: IncomingMessage): string | undefined {
  const raw = req.headers['idempotency-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (key == null || key === '') return undefined;
  if (key.length > IDEMPOTENCY_KEY_MAX) throw new HttpError(400, 'Idempotency-Key is too long.');
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) throw new HttpError(400, 'Idempotency-Key contains unsupported characters.');
  return key;
}

function problemDetails(req: IncomingMessage, status: number, error: unknown): Record<string, unknown> {
  return {
    type: problemType(status),
    title: problemTitle(status),
    status,
    detail: safeErrorMessage(error, status),
    instance: routeForAudit(req),
    request_id: requestId(req),
  };
}

// Public documentation location, overridable per deployment.
function docsUrl(): string {
  return process.env.DOCS_URL ?? 'https://docs.wellnizz.com';
}

// RFC 7807 problem type identifiers. Vendor-neutral URNs so responses carry no
// hardcoded hostname.
function problemType(status: number): string {
  if (status === 402) return 'urn:wellnizz-api:problem:payment-required';
  if (status === 401) return 'urn:wellnizz-api:problem:unauthorized';
  if (status === 403) return 'urn:wellnizz-api:problem:forbidden';
  if (status === 404) return 'urn:wellnizz-api:problem:not-found';
  if (status === 413) return 'urn:wellnizz-api:problem:body-too-large';
  if (status === 429) return 'urn:wellnizz-api:problem:rate-limited';
  if (status >= 500) return 'urn:wellnizz-api:problem:internal';
  return 'urn:wellnizz-api:problem:bad-request';
}

function problemTitle(status: number): string {
  if (status === 402) return 'Payment Required';
  if (status === 401) return 'Unauthorized';
  if (status === 403) return 'Forbidden';
  if (status === 404) return 'Not Found';
  if (status === 413) return 'Payload Too Large';
  if (status === 429) return 'Too Many Requests';
  if (status >= 500) return 'Internal Server Error';
  return 'Bad Request';
}

function safeErrorMessage(error: unknown, status: number): string {
  if (status === 401) return 'Authentication failed.';
  if (status === 403) return 'Access denied.';
  // 429s carry an actionable, non-sensitive message (e.g. the email rate-limit hint) - surface it.
  if (status === 429) return error instanceof HttpError || error instanceof RateLimitError ? error.message : 'Rate limit exceeded.';
  if (status >= 500) return 'Internal server error.';
  if (error instanceof ProviderHttpError) {
    if (error.message.includes('token exchange failed')) {
      const provider = error.message.toLowerCase().includes('oura') ? 'Oura' : 'WHOOP';
      return `${provider} rejected this authorization code. It may have expired or already been used. Start a new ${provider} connection and complete it once.`;
    }
    const provider = error.message.toLowerCase().includes('oura') ? 'Oura' : 'WHOOP';
    return `${provider} could not process the request. Start a new connection and try again.`;
  }
  if (error instanceof HttpError || error instanceof AuthError || error instanceof RateLimitError || error instanceof BillingError) return error.message;
  if (error instanceof SyntaxError) return 'Invalid JSON request body.';
  return 'Request could not be processed.';
}

function errorHeaders(status: number, req: IncomingMessage): Record<string, string> {
  if (status !== 401) return {};
  return {
    'www-authenticate': `Bearer realm="wellnizz-api", error="invalid_token", error_uri="${publicBaseUrl(req, {
      mode: 'disabled',
      algorithms: [],
      allowedOrigins: [],
      allowedOriginPatterns: [],
      requireHttps: false,
      maxBodyBytes: 0,
      routeOverrides: new Map(),
      rateLimitWindowMs: 0,
      rateLimitMax: 0,
      enabledEndpoints: new Set(),
      requireEnabledEndpointClaim: false,
      requireOrganizationClaim: false,
      billingAdminEmails: new Set(),
      billingAdminUserIds: new Set(),
      adminEmails: new Set(),
      apiKeySecret: undefined,
  })}/.well-known/health-agent.json"`,
  };
}

function routeForAudit(req: IncomingMessage): string {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (/^\/dashboards\/private\/[^/]+$/.test(pathname)) return '/dashboards/private/:token';
  return pathname;
}

function requestId(req: IncomingMessage): string {
  const cached = requestIds.get(req);
  if (cached) return cached;
  const value = req.headers['x-request-id'];
  const id = typeof value === 'string' && value.trim()
    ? value
    : Array.isArray(value) && value[0]?.trim()
      ? value[0]
      : randomUUID();
  requestIds.set(req, id);
  return id;
}

async function readinessPayload(config: AuthConfig, store: HealthStore, x402Gateway?: X402Gateway) {
  const [storeReady, authReady, x402Ready] = await Promise.all([
    store.readiness(),
    probeAuthConfig(config),
    x402Gateway?.probe() ?? Promise.resolve({ ok: true, enabled: false }),
  ]);
  // Email sign-in is optional (agents can also present API keys directly), so it
  // is reported but does not gate readiness.
  const otpConfigured = emailEnabled() && Boolean(config.apiKeySecret ?? config.serviceAccountSecret);
  const production = process.env.NODE_ENV === 'production';
  const ok = storeReady.ok
    && authReady.ok
    && (!production || storeReady.durable);
  return {
    ok,
    service: 'wellnizz-api',
    version: SERVICE_VERSION,
    auth_mode: config.mode,
    storage: storeReady,
    auth: authReady,
    x402: x402Gateway ? { enabled: true, ...x402Ready } : x402Ready,
    otp_configured: otpConfigured,
    require_https: config.requireHttps,
    require_enabled_endpoint_claim: config.requireEnabledEndpointClaim,
    require_organization_claim: config.requireOrganizationClaim,
    enabled_endpoints: enabledEndpointIds(config),
  };
}

function agentManifest(req: IncomingMessage, config: AuthConfig, x402Gateway?: X402Gateway) {
  const baseUrl = publicBaseUrl(req, config);
  return {
    service: 'wellnizz-api',
    name: 'Wellnizz API',
    version: SERVICE_VERSION,
    base_url: baseUrl,
    auth: {
      type: 'bearer',
      mode: config.mode,
      otp_start_url: `${baseUrl}/auth/otp/start`,
      otp_verify_url: `${baseUrl}/auth/otp/verify`,
      agent_login: {
        summary: 'Secure browser-based login. The user reviews and approves a named agent; the agent receives the API key once in an HTTP response body.',
        steps: [
          {
            call: `POST ${baseUrl}/agent-login/start`,
            body: { agent_name: '<short name shown to the user>' },
            note: 'Returns session_code, polling_secret, and url. Keep polling_secret private; the url is the only part the user sees.',
          },
          {
            note: 'Open the url in the user\'s browser for them, sharing it only when you cannot open one. They sign in with email OTP, review the requested access, and explicitly approve or deny it.',
          },
          {
            call: `GET ${baseUrl}/agent-login/status?session_code=<code>`,
            headers: { 'X-Agent-Login-Secret': '<polling_secret>' },
            note: 'Returns pending, denied, or confirmed. A confirmed api_key is returned exactly once. Store it immediately in a 600-permission file and never print it.',
          },
        ],
        session_code_ttl_seconds: Math.floor(AGENT_LOGIN_TTL_MS / 1000),
        api_key_ttl_days: agentApiKeyTtlDays(),
        api_key_ttl_range_days: { min: AGENT_API_KEY_MIN_TTL_DAYS, max: AGENT_API_KEY_MAX_TTL_DAYS },
        recommendation: 'Use agent_login for all new agent onboarding. The self_serve_key flow is supported for backwards compatibility.',
      },
      self_serve_key: {
        summary: 'Mint a durable free personal API key in three calls. The key acts only for the verified email owner.',
        steps: [
          {
            call: `POST ${baseUrl}/auth/otp/start`,
            body: { email: '<user email>' },
            note: 'Emails the user an 8-digit code. Ask the user to read you the code.',
          },
          {
            call: `POST ${baseUrl}/auth/otp/verify`,
            body: { email: '<user email>', token: '<8-digit code>' },
            note: 'Returns a short-lived access_token session for that user.',
          },
          {
            call: `POST ${baseUrl}/api-keys`,
            authorization: 'Bearer <access_token from verify>',
            body: {},
            note: 'Returns a free personal_agent API key, shown once. Defaults: 365-day expiry, personal organization derived from the user id, and the standard personal scope and endpoint grants (imports, analyses, trends, goals, query, health context, wearable connections).',
          },
        ],
        exemption: 'token_requirements below do not block this sequence: a fresh OTP access token with no organization or endpoint claims may call POST /api-keys for a free personal key, and the issued key carries all required claims.',
        docs_url: docsUrl(),
      },
      synthetic_sandbox: config.publicSandbox
        ? {
            session_url: `${baseUrl}/sandbox/sessions`,
            synthetic_only: true,
            persisted: false,
            token_ttl_minutes: 30,
          }
        : undefined,
      token_requirements: {
        audience: config.audience,
        issuer: config.issuer,
        scopes_claims: ['scope', 'permissions', 'scp'],
        endpoint_claims: ['health_enabled_endpoints', 'enabled_endpoints', 'allowed_endpoints', 'app_metadata.health_enabled_endpoints', 'app_metadata.enabled_endpoints', 'app_metadata.allowed_endpoints'],
        require_endpoint_claim: config.requireEnabledEndpointClaim,
        full_user_data_reads_by_default: config.fullUserDataReadByDefault !== false,
        default_user_data_read_endpoints: config.fullUserDataReadByDefault === false ? [] : Array.from(DEFAULT_USER_DATA_READ_ENDPOINTS),
        consequential_operations_require_endpoint_grant: true,
        organization_claims: [
          'organization_id',
          'org_id',
          'organization_ids',
          'org_ids',
          'allowed_organizations',
          'app_metadata.organization_id',
          'app_metadata.org_id',
          'app_metadata.organization_ids',
          'app_metadata.org_ids',
          'app_metadata.allowed_organizations',
        ],
        require_organization_claim: config.requireOrganizationClaim,
      },
    },
    payments: {
      x402: x402Gateway?.describe() ?? describeX402(),
      discovery_url: `${baseUrl}/.well-known/x402.json`,
      note: 'Protected routes accept either a scoped API key or one x402 payment. API-key requests are never charged.',
    },
    endpoints: endpointCatalog(config.enabledEndpoints),
    openapi_url: `${baseUrl}/openapi.json`,
    documentation_url: docsUrl(),
  };
}

function agentApiKeyTtlDays(env: NodeJS.ProcessEnv = process.env): number {
  const requested = Number(env.AGENT_API_KEY_TTL_DAYS ?? AGENT_API_KEY_DEFAULT_TTL_DAYS);
  if (!Number.isFinite(requested)) return AGENT_API_KEY_DEFAULT_TTL_DAYS;
  return Math.min(AGENT_API_KEY_MAX_TTL_DAYS, Math.max(AGENT_API_KEY_MIN_TTL_DAYS, Math.floor(requested)));
}

// Load the offloaded gene/rsID slice index from its artifact into memory for a
// slice query. Streamed to a temp file first (never buffered from object storage
// directly), then parsed. Returns undefined when no artifact exists.
async function loadOffloadedSliceIndex(store: HealthStore, analysisId: string): Promise<GeneticSliceIndex | undefined> {
  const destination = pathJoin(tmpdir(), `genetic-slice-${randomUUID()}.json`);
  try {
    const wrote = await store.writeAnalysisSliceArtifactToFile(analysisId, destination);
    if (!wrote) return undefined;
    return JSON.parse(await readFile(destination, 'utf8')) as GeneticSliceIndex;
  } catch {
    return undefined;
  } finally {
    await rm(destination, { force: true }).catch(() => undefined);
  }
}

function publicBaseUrl(req: IncomingMessage, config: AuthConfig): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  const protoHeader = req.headers['x-forwarded-proto'];
  const proto = typeof protoHeader === 'string' ? protoHeader.split(',')[0]!.trim() : config.requireHttps ? 'https' : 'http';
  return `${proto}://${req.headers.host ?? 'localhost:8787'}`;
}

function dashboardLinkSecret(config: AuthConfig): string | undefined {
  return config.apiKeySecret ?? config.serviceAccountSecret;
}

function dashboardLinkBaseUrl(req: IncomingMessage, config: AuthConfig): string {
  if (process.env.PUBLIC_BASE_URL?.trim()) return publicBaseUrl(req, config);
  return config.requireHttps ? '' : publicBaseUrl(req, config);
}

function enabledEndpointIds(config: AuthConfig): string[] {
  if (config.enabledEndpoints.size === 0) return ENDPOINTS.map(endpoint => endpoint.id);
  return ENDPOINTS.filter(endpoint => config.enabledEndpoints.has(endpoint.id)).map(endpoint => endpoint.id);
}

async function emitWebhookEvent(
  store: HealthStore,
  type: WebhookEventType,
  input: {
    userId?: string;
    organizationId?: string;
    subjectId?: string;
    requestId?: string;
    data: Record<string, unknown>;
  },
) {
  return emitSharedWebhookEvent(store, type, input);
}

// Server token-encryption key, memoized. Undefined when WHOOP_TOKEN_ENC_KEY is
// unset, in which case webhook-driven syncs stay disabled and connections keep
// the stateless (external secret store) contract.
let tokenEncryptionKeyMemo: { value: Buffer | undefined } | undefined;
function getTokenEncryptionKey(): Buffer | undefined {
  if (!tokenEncryptionKeyMemo) tokenEncryptionKeyMemo = { value: loadTokenEncryptionKey() };
  return tokenEncryptionKeyMemo.value;
}

function firstPartyOAuthFor(provider: string, authConfig: AuthConfig): { clientId: string; clientSecret: string; defaultRedirectUri?: string } | undefined {
  if (provider === 'whoop') return authConfig.whoopOAuth;
  if (provider === 'oura') return authConfig.ouraOAuth;
  return undefined;
}

const FIRST_PARTY_CONNECTION_STATE_TTL_MS = 15 * 60 * 1000;

function issueFirstPartyConnectionState(provider: 'whoop' | 'oura' | 'health_connect', userId: string, organizationId: string | undefined): string | undefined {
  const key = getTokenEncryptionKey();
  if (!key || !organizationId) return undefined;
  const payload = Buffer.from(JSON.stringify({ v: 1, provider, user_id: userId, organization_id: organizationId, exp: Date.now() + FIRST_PARTY_CONNECTION_STATE_TTL_MS, nonce: randomBytes(12).toString('base64url') })).toString('base64url');
  const signingInput = `fb1.${provider}.${payload}`;
  const signature = createHmac('sha256', key).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

function assertFirstPartyConnectionState(state: string, provider: string, userId: string, organizationId: string | undefined): void {
  const [version, stateProvider, payload, signature, ...extra] = state.split('.');
  if (version !== 'fb1' || !stateProvider || !payload || !signature || extra.length > 0) {
    throw new HttpError(400, 'This wearable connection state is invalid. Start the connection again.');
  }
  const key = getTokenEncryptionKey();
  const expected = key ? createHmac('sha256', key).update(`${version}.${stateProvider}.${payload}`).digest('base64url') : '';
  if (!constantTimeEqual(signature, expected)) {
    throw new HttpError(400, 'This wearable connection state is invalid. Start the connection again.');
  }
  let claims: { v?: number; provider?: string; user_id?: string; organization_id?: string; exp?: number };
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof claims;
  } catch {
    throw new HttpError(400, 'This wearable connection state is invalid. Start the connection again.');
  }
  const expiresAt = claims.exp;
  if (claims.v !== 1 || claims.provider !== provider || stateProvider !== provider || claims.user_id !== userId || claims.organization_id !== organizationId || !Number.isFinite(expiresAt) || expiresAt === undefined || expiresAt <= Date.now()) {
    throw new HttpError(400, 'This wearable connection state has expired or does not match your account. Start the connection again.');
  }
}

async function saveRotatedProviderToken(store: HealthStore, token: import('./types.js').ProviderToken, tokenSet: OAuthTokenSet, key: Buffer): Promise<void> {
  const refreshToken = tokenSet.refresh_token
    ? encryptToken(tokenSet.refresh_token, key)
    : token.refresh_token_encrypted;
  await store.saveProviderToken({
    ...token,
    access_token_encrypted: tokenSet.access_token ? encryptToken(tokenSet.access_token, key) : token.access_token_encrypted,
    refresh_token_encrypted: refreshToken,
    scope: tokenSet.scope ?? token.scope,
    token_type: tokenSet.token_type ?? token.token_type,
    expires_at: tokenSet.expires_in ? new Date(Date.now() + tokenSet.expires_in * 1000).toISOString() : token.expires_at,
    updated_at: new Date().toISOString(),
  });
}

// Oura webhook deliveries use the Oura member id. Store that join key alongside
// the encrypted OAuth tokens so reconnects, direct sync, and webhook sync all
// target the same durable connection.
async function persistOuraTokens(params: {
  store: HealthStore;
  account: { id: string; user_id: string; organization_id: string; provider: string; external_user_id: string; metadata: Record<string, unknown> };
  tokenResult: OAuthTokenSet;
  key: Buffer;
  authConfig: AuthConfig;
}): Promise<boolean> {
  const { store, account, tokenResult, key, authConfig } = params;
  if (!tokenResult.access_token && !tokenResult.refresh_token) return false;
  const ouraUserId = tokenResult.access_token
    ? await fetchOuraUserId(tokenResult.access_token).catch(() => undefined)
    : undefined;
  if (!ouraUserId) {
    throw new HttpError(502, 'Oura profile access could not be verified. Reconnect Oura and approve personal access so automatic updates can be enabled.');
  }
  await store.saveProviderToken({
    id: `ptok_${randomUUID()}`,
    external_account_id: account.id,
    user_id: account.user_id,
    organization_id: account.organization_id,
    provider: 'oura',
    provider_external_user_id: ouraUserId,
    access_token_encrypted: tokenResult.access_token ? encryptToken(tokenResult.access_token, key) : undefined,
    refresh_token_encrypted: tokenResult.refresh_token ? encryptToken(tokenResult.refresh_token, key) : undefined,
    scope: tokenResult.scope,
    token_type: tokenResult.token_type,
    expires_at: tokenResult.expires_in ? new Date(Date.now() + tokenResult.expires_in * 1000).toISOString() : undefined,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const webhookEnabled = await ensureOuraWebhookSubscriptions(authConfig).catch(() => false);
  await store.upsertExternalAccount({
    ...account,
    provider: account.provider,
    status: 'active',
    metadata: { ...account.metadata, oura_user_id: ouraUserId, server_sync_enabled: true, webhook_sync_enabled: webhookEnabled },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return true;
}

// Persist encrypted WHOOP tokens for a connected account and record the WHOOP
// user id (the webhook join key) on the account metadata. Returns whether a
// webhook-syncable token was stored.
async function persistWhoopTokens(params: {
  store: HealthStore;
  account: { id: string; user_id: string; organization_id: string; provider: string; external_user_id: string; metadata: Record<string, unknown> };
  tokenResult: OAuthTokenSet;
  key: Buffer;
  authConfig: AuthConfig;
}): Promise<boolean> {
  const { store, account, tokenResult, key, authConfig } = params;
  const accessToken = tokenResult?.access_token;
  const refreshToken = tokenResult?.refresh_token;
  if (!accessToken && !refreshToken) return false;

  // Resolve the WHOOP-side user id so inbound webhooks can be matched back to
  // this connection. Without it we cannot route webhooks, so skip storage.
  let whoopUserId: string | undefined;
  if (accessToken) whoopUserId = await fetchWhoopUserId(accessToken).catch(() => undefined);
  if (!whoopUserId) {
    throw new HttpError(502, 'WHOOP profile access could not be verified. Reconnect WHOOP and approve profile access so automatic updates can be enabled.');
  }

  const expiresAt = tokenResult.expires_in
    ? new Date(Date.now() + tokenResult.expires_in * 1000).toISOString()
    : undefined;

  await store.saveProviderToken({
    id: `ptok_${randomUUID()}`,
    external_account_id: account.id,
    user_id: account.user_id,
    organization_id: account.organization_id,
    provider: 'whoop',
    provider_external_user_id: whoopUserId,
    access_token_encrypted: accessToken ? encryptToken(accessToken, key) : undefined,
    refresh_token_encrypted: refreshToken ? encryptToken(refreshToken, key) : undefined,
    scope: tokenResult.scope,
    token_type: tokenResult.token_type,
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  await store.upsertExternalAccount({
    id: account.id,
    user_id: account.user_id,
    organization_id: account.organization_id,
    provider: account.provider,
    external_user_id: account.external_user_id,
    status: 'active',
    metadata: { ...account.metadata, whoop_user_id: whoopUserId, webhook_sync_enabled: true },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  // Register WHOOP webhook subscriptions so incoming data is synced automatically.
  // Subscription registration is idempotent; we call it on every connection to
  // ensure the deployment's callback URL is registered even if it was removed.
  if (accessToken) {
    await ensureWhoopWebhookSubscriptions(accessToken, authConfig).catch(() => false);
  }

  return true;
}

const WHOOP_WEBHOOK_EVENT_TYPES = ['sleep.updated', 'recovery.updated', 'workout.updated'];

async function ensureWhoopWebhookSubscriptions(accessToken: string, authConfig: AuthConfig): Promise<boolean> {
  const baseUrl = new URL(authConfig.whoopOAuth?.defaultRedirectUri ?? process.env.PUBLIC_BASE_URL ?? 'http://localhost:8787').origin;
  const callbackUrl = `${baseUrl}/connections/whoop/webhook`;
  const headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };

  try {
    const existingResponse = await fetch('https://api.prod.whoop.com/developer/v2/webhook/subscription', { headers });
    if (!existingResponse.ok) return false;
    const existingBody = await existingResponse.json() as Array<Record<string, unknown>> | { subscriptions?: Array<Record<string, unknown>> };
    const existing = Array.isArray(existingBody) ? existingBody : (existingBody?.subscriptions ?? []);

    for (const eventType of WHOOP_WEBHOOK_EVENT_TYPES) {
      const found = existing.some(sub => sub.callback_url === callbackUrl && sub.event_type === eventType);
      if (found) continue;
      const response = await fetch('https://api.prod.whoop.com/developer/v2/webhook/subscription', {
        method: 'POST',
        headers,
        body: JSON.stringify({ callback_url: callbackUrl, event_type: eventType }),
      });
      if (!response.ok) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// WHOOP webhook receiver. Verifies the HMAC signature over the raw body, then
// enqueues an async sync job keyed on the WHOOP user id. Always responds 2XX
// quickly for valid signatures so WHOOP does not retry.
async function handleWhoopWebhook(req: IncomingMessage, res: ServerResponse, store: HealthStore, authConfig: AuthConfig): Promise<void> {
  const firstParty = authConfig.whoopOAuth;
  const rawBody = await readRawBody(req, 64 * 1024);
  if (!firstParty) {
    auditEvent(req, 'denied', { route: '/connections/whoop/webhook', status: 404 });
    return sendJson(req, res, authConfig, 404, problemDetails(req, 404, new HttpError(404, 'WHOOP webhooks are not enabled on this deployment.')));
  }

  const valid = verifyWhoopSignature({
    rawBody,
    signature: headerValue(req, WHOOP_SIGNATURE_HEADER),
    timestamp: headerValue(req, WHOOP_SIGNATURE_TIMESTAMP_HEADER),
    clientSecret: firstParty.clientSecret,
  });
  if (!valid) {
    auditEvent(req, 'denied', { route: '/connections/whoop/webhook', status: 401 });
    return sendJson(req, res, authConfig, 401, problemDetails(req, 401, new HttpError(401, 'Invalid WHOOP webhook signature.')));
  }

  const payload = parseWhoopWebhookPayload(rawBody);
  const resourceType = payload ? whoopResourceType(payload.type) : undefined;
  // Acknowledge unparseable or unhandled event types with 204 so WHOOP stops
  // retrying; there is nothing actionable to sync.
  if (!payload || !resourceType) {
    auditEvent(req, 'success', { route: '/connections/whoop/webhook', status: 204 });
    return sendJson(req, res, authConfig, 204, {});
  }

  const whoopUserId = String(payload.user_id);
  const token = await store.getProviderTokenByExternalUser('whoop', whoopUserId);
  // Unknown WHOOP user (revoked, or never connected on this deployment). Ack so
  // WHOOP does not retry indefinitely.
  if (!token) {
    auditEvent(req, 'success', { route: '/connections/whoop/webhook', status: 202 });
    return sendJson(req, res, authConfig, 202, { status: 'ignored', reason: 'no matching WHOOP connection' });
  }

  const job = await enqueueWearablesSync({
    user_id: token.user_id,
    organization_id: token.organization_id,
    provider_user_id: whoopUserId,
    external_user_id: token.external_account_id,
    source_provider: 'whoop',
    webhook_resource_type: resourceType,
    webhook_resource_id: String(payload.id),
    webhook_trace_id: payload.trace_id,
  }, store);

  auditEvent(req, 'success', { route: '/connections/whoop/webhook', status: 202 });
  return sendJson(req, res, authConfig, 202, { status: 'queued', job_id: job.id });
}

const OURA_WEBHOOK_DATA_TYPES = ['daily_activity', 'daily_readiness', 'daily_sleep'] as const;
const OURA_WEBHOOK_EVENT_TYPES = ['create', 'update'] as const;

// Register subscriptions through Oura's API instead of requiring an operator to
// copy a callback URL into a separate console. Registration is idempotent: an
// already-present callback/data/event tuple is retained.
async function ensureOuraWebhookSubscriptions(authConfig: AuthConfig): Promise<boolean> {
  const oauth = authConfig.ouraOAuth;
  const verificationToken = process.env.OURA_WEBHOOK_VERIFICATION_TOKEN;
  if (!oauth || !verificationToken) return false;
  const callbackUrl = `${new URL(oauth.defaultRedirectUri ?? process.env.PUBLIC_BASE_URL ?? 'http://localhost:8787').origin}/connections/oura/webhook`;
  const headers = {
    'content-type': 'application/json',
    'x-client-id': oauth.clientId,
    'x-client-secret': oauth.clientSecret,
  };
  const existingResponse = await fetch('https://api.ouraring.com/v2/webhook/subscription', { headers });
  if (!existingResponse.ok) return false;
  const existingBody = await existingResponse.json() as unknown;
  // Oura returns a top-level subscription array (rather than the { data } shape
  // used by its wellness-data endpoints). Accept both forms defensively so a
  // reconnect never creates duplicate subscriptions.
  const existing = Array.isArray(existingBody)
    ? existingBody as Array<Record<string, unknown>>
    : (existingBody && typeof existingBody === 'object' && Array.isArray((existingBody as { data?: unknown }).data)
      ? (existingBody as { data: Array<Record<string, unknown>> }).data
      : []);
  for (const dataType of OURA_WEBHOOK_DATA_TYPES) {
    for (const eventType of OURA_WEBHOOK_EVENT_TYPES) {
      const found = existing.some(subscription => subscription.callback_url === callbackUrl
        && subscription.data_type === dataType && subscription.event_type === eventType);
      if (found) continue;
      const response = await fetch('https://api.ouraring.com/v2/webhook/subscription', {
        method: 'POST',
        headers,
        body: JSON.stringify({ callback_url: callbackUrl, verification_token: verificationToken, event_type: eventType, data_type: dataType }),
      });
      if (!response.ok) return false;
    }
  }
  return true;
}

// Oura sends a GET challenge while creating a subscription and then POSTs HMAC
// signed notifications. The notification body is treated as a trigger for a
// token-backed reconciliation fetch rather than as wellness data to persist.
async function handleOuraWebhook(req: IncomingMessage, res: ServerResponse, store: HealthStore, authConfig: AuthConfig, url: URL): Promise<void> {
  const verificationToken = process.env.OURA_WEBHOOK_VERIFICATION_TOKEN;
  if (!authConfig.ouraOAuth || !verificationToken) {
    auditEvent(req, 'denied', { route: '/connections/oura/webhook', status: 404 });
    return sendJson(req, res, authConfig, 404, problemDetails(req, 404, new HttpError(404, 'Oura webhooks are not enabled on this deployment.')));
  }
  if (req.method === 'GET') {
    const supplied = url.searchParams.get('verification_token') ?? '';
    if (!constantTimeEqual(supplied, verificationToken)) {
      auditEvent(req, 'denied', { route: '/connections/oura/webhook', status: 401 });
      return sendJson(req, res, authConfig, 401, problemDetails(req, 401, new HttpError(401, 'Invalid Oura webhook verification token.')));
    }
    auditEvent(req, 'success', { route: '/connections/oura/webhook', status: 200 });
    return sendJson(req, res, authConfig, 200, { challenge: url.searchParams.get('challenge') ?? '' });
  }

  const rawBody = await readRawBody(req, 64 * 1024);
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    payload = parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Oura webhook payload must be a JSON object.');
  }
  const timestamp = headerValue(req, 'x-oura-timestamp');
  const signature = headerValue(req, 'x-oura-signature');
  const expectedSignature = timestamp
    ? createHmac('sha256', authConfig.ouraOAuth.clientSecret).update(`${timestamp}${JSON.stringify(payload)}`).digest('hex').toUpperCase()
    : '';
  if (!signature || !constantTimeEqual(signature, expectedSignature)) {
    auditEvent(req, 'denied', { route: '/connections/oura/webhook', status: 401 });
    return sendJson(req, res, authConfig, 401, problemDetails(req, 401, new HttpError(401, 'Invalid Oura webhook signature.')));
  }
  const dataType = typeof payload.data_type === 'string' ? payload.data_type : undefined;
  const eventType = typeof payload.event_type === 'string' ? payload.event_type : undefined;
  const ouraUserId = typeof payload.user_id === 'string' || typeof payload.user_id === 'number' ? String(payload.user_id) : undefined;
  if (!dataType || !OURA_WEBHOOK_DATA_TYPES.includes(dataType as typeof OURA_WEBHOOK_DATA_TYPES[number]) || !ouraUserId) {
    auditEvent(req, 'success', { route: '/connections/oura/webhook', status: 204 });
    return sendJson(req, res, authConfig, 204, {});
  }
  const token = await store.getProviderTokenByExternalUser('oura', ouraUserId);
  if (!token) {
    auditEvent(req, 'success', { route: '/connections/oura/webhook', status: 202 });
    return sendJson(req, res, authConfig, 202, { status: 'ignored', reason: 'no matching Oura connection' });
  }
  const job = await enqueueWearablesSync({
    user_id: token.user_id,
    organization_id: token.organization_id,
    provider_user_id: ouraUserId,
    external_user_id: token.external_account_id,
    source_provider: 'oura',
    webhook_resource_type: dataType,
    webhook_resource_id: typeof payload.object_id === 'string' ? payload.object_id : undefined,
    webhook_trace_id: typeof payload.id === 'string' ? payload.id : eventType,
  }, store);
  auditEvent(req, 'success', { route: '/connections/oura/webhook', status: 202 });
  return sendJson(req, res, authConfig, 202, { status: 'queued', job_id: job.id });
}

function constantTimeEqual(value: string, expected: string): boolean {
  const valueBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return valueBuffer.length === expectedBuffer.length && timingSafeEqual(valueBuffer, expectedBuffer);
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}


const GOAL_STATUSES = new Set(['active', 'achieved', 'archived']);
const GOAL_DIRECTIONS = new Set(['decrease', 'increase', 'maintain']);

// Validate a goal create/update body and throw a clear 400 rather than letting a
// bad value reach the store (where a DB check constraint surfaces as a 500) or
// become durable data. `partial` allows omitted fields on update.
function validateGoalInput(
  input: { title?: unknown; target_value?: unknown; target_direction?: unknown; due_date?: unknown; status?: unknown },
  { partial }: { partial: boolean },
): void {
  if (!partial || input.title !== undefined) {
    if (typeof input.title !== 'string' || !input.title.trim()) throw new HttpError(400, 'Goal title is required and must be a non-empty string.');
  }
  if (input.target_value !== undefined && input.target_value !== null) {
    if (typeof input.target_value !== 'number' || !Number.isFinite(input.target_value)) throw new HttpError(400, 'target_value must be a finite number.');
  }
  if (input.target_direction !== undefined && input.target_direction !== null) {
    if (typeof input.target_direction !== 'string' || !GOAL_DIRECTIONS.has(input.target_direction)) throw new HttpError(400, "target_direction must be one of 'decrease', 'increase', or 'maintain'.");
  }
  if (input.status !== undefined) {
    if (typeof input.status !== 'string' || !GOAL_STATUSES.has(input.status)) throw new HttpError(400, "status must be one of 'active', 'achieved', or 'archived'.");
  }
  if (input.due_date !== undefined && input.due_date !== null && input.due_date !== '') {
    if (typeof input.due_date !== 'string' || Number.isNaN(Date.parse(input.due_date))) throw new HttpError(400, 'due_date must be a valid date string (for example 2027-01-01).');
  }
}

// A non-genetics upload that produced no observations is a silent failure unless
// we tell the caller why: an unreadable PDF vs. an unrecognized/empty format.
function importWarnings(category: string, extraction: ImportTextResult, observationCount: number): string[] {
  if (category === 'genetics' || observationCount > 0) return [];
  if (extraction.extraction_failed || (extraction.is_pdf && extraction.text.trim() === '')) {
    return ['No text could be extracted from this PDF (it may be a scanned image). Upload a text-based PDF, a CSV/JSON/FHIR export, or paste the values directly.'];
  }
  return ['No recognized readings were found in this upload. Check that marker names and units are present and the format is CSV, JSON, FHIR, or lab text.'];
}

function mapOtpError(error: unknown, flow: 'start' | 'verify'): never {
  if (!(error instanceof OtpAuthError)) throw error;
  const code = error.code ?? '';
  const status = error.status ?? 400;
  if (status === 429 || code.includes('rate_limit')) {
    throw new HttpError(429, flow === 'start'
      ? 'Too many sign-in emails were requested. Wait a minute and try again, or enter the 8-digit code from the last email we sent.'
      : 'Too many attempts. Wait a minute, then try the code again.');
  }
  if (status >= 500) {
    throw new HttpError(502, 'The email service is temporarily unavailable. Please try again in a moment.');
  }
  if (flow === 'verify') {
    throw new HttpError(400, 'That code is invalid or has expired. Request a new sign-in email and try again.');
  }
  if (code === 'email_disabled') {
    throw new HttpError(400, error.message);
  }
  throw new HttpError(400, 'That email address looks invalid. Double-check it and try again.');
}

function statusForError(error: unknown): number {
  if (error instanceof AuthError) return error.status;
  if (error instanceof X402GatewayError) return error.status;
  if (error instanceof RateLimitError) return 429;
  if (error instanceof ProviderHttpError) return error.status >= 500 ? 502 : 400;
  if (error instanceof BillingError) return error.status;
  return error instanceof HttpError ? error.status : 400;
}

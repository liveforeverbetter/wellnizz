import { createHash, randomUUID } from 'node:crypto';
import { SignJWT, type JWTPayload } from 'jose';
import { isBillingAdmin, primaryAuthAudience, type AuthConfig, type AuthContext, type AuthScope } from './auth.js';
import type { EndpointId } from './endpoints.js';
import { InMemoryRateLimiter } from './rate-limit.js';

export type PricingTierId = 'free' | 'standard' | 'builder' | 'growth' | 'enterprise';
export type IntendedUse = 'personal_agent' | 'mobile_sync' | 'app_platform_service';
export const HOSTED_INTRODUCTORY_REQUEST_LIMIT = 100;

export interface PricingTier {
  id: PricingTierId;
  name: string;
  monthly_usd: number | 'custom';
  included: string[];
  rate_limit: {
    requests_per_minute: number;
  };
  monthly_quotas: Record<string, number | 'custom'>;
  intended_use: string[];
  runtime_daily_quotas: Partial<Record<TierQuotaId, number>>;
  caching: {
    public_metadata_seconds: number;
    idempotency_replay: boolean;
    health_context_cache_seconds: number;
  };
  notes: string[];
}

export type TierQuotaId =
  | 'imports.file'
  | 'analyses.create'
  | 'connections.sync'
  | 'query.create'
  | 'health_context.read';

export interface ApiKeyCreateRequest {
  name?: string;
  user_id?: string;
  organization_id?: string;
  tier?: PricingTierId;
  intended_use?: IntendedUse;
  scopes?: AuthScope[];
  enabled_endpoints?: EndpointId[];
  expires_in_days?: number;
}

export interface ApiKeyIssueResult {
  api_key: string;
  authorization_header: string;
  created: {
    id: string;
    name: string;
    token_type: 'api_key';
    tier: PricingTierId;
    intended_use: IntendedUse;
    user_id: string;
    organization_id: string;
    scopes: AuthScope[];
    enabled_endpoints: EndpointId[];
    expires_at: string | null;
  };
  usage: {
    send_header: string;
    pricing_tier: PricingTier;
    key_is_shown_once: boolean;
  };
}

export const DEFAULT_API_KEY_ENDPOINTS: EndpointId[] = [
  'capabilities.read',
  'pricing.read',
  'billing.subscription.read',
  'billing.checkout.create',
  'billing.portal.create',
  'imports.file',
  'analyses.create',
  'analyses.read',
  'analyses.list',
  'analyses.recommendations.read',
  'analyses.action_plan.read',
  'sources.list',
  'sources.read',
  'trends.read',
  'biomarkers.derive',
  'biomarkers.analyze',
  'wearables.analyze',
  'genetics.uploads.create',
  'genetics.uploads.complete',
  'genetics.analyze',
  'genetics.ancestry.create',
  'genetics.jobs.read',
  'dashboard_specs.read',
  'dashboard_links.create',
  'health_context.read',
  'goals.create',
  'goals.list',
  'goals.read',
  'goals.update',
  'goals.delete',
  'retest_reminders.read',
  'query.create',
  'providers.search',
  'labs.search',
  'connections.start',
  'connections.callback',
  'connections.sync',
  'connections.refresh',
  'connections.jobs.read',
  'data.export',
  'data.delete',
];

const SANDBOX_SESSION_ENDPOINTS: EndpointId[] = [
  'capabilities.read',
  'analyses.read',
  'analyses.action_plan.read',
  'dashboard_specs.read',
  'health_context.read',
];
const SANDBOX_SESSION_SCOPES: AuthScope[] = ['health:data:read'];
const SANDBOX_SESSION_TTL_SECONDS = 30 * 60;

export interface SandboxSessionResult {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  expires_at: string;
  synthetic_only: true;
  user_id: string;
  organization_id: string;
}

const DEFAULT_API_KEY_SCOPES: AuthScope[] = [
  'health:data:read',
  'health:data:write',
  'health:connections:write',
  'health:labs:read',
];

export const PRICING_TIERS: PricingTier[] = [
  {
    id: 'free',
    name: 'Free',
    monthly_usd: 0,
    included: ['Build and test with real API keys', 'MCP and OpenAPI access', 'Self-hosting with no hosted subscription required'],
    intended_use: ['Personal wellness data use', 'Your own agent or automation', 'Evaluation before building a commercial app'],
    rate_limit: { requests_per_minute: 60 },
    monthly_quotas: {
      health_context_reads: 250,
      queries: 250,
      uploads: 25,
      analyses: 25,
      wearable_syncs: 10,
      wgs_jobs: 1,
      full_dbsnp_jobs: 0,
    },
    runtime_daily_quotas: {
      'imports.file': 10,
      'analyses.create': 10,
      'connections.sync': 3,
      'query.create': 100,
      'health_context.read': 100,
    },
    caching: { public_metadata_seconds: 300, idempotency_replay: true, health_context_cache_seconds: 60 },
    notes: ['Free is for evaluation and your own authorized agent. Building an app, platform, or service for others requires Builder or higher. Full dbSNP is not included. Self-hosting is always available and is not limited by this hosted plan.'],
  },
  {
    id: 'standard',
    name: 'Standard',
    monthly_usd: 9.99,
    included: ['Everything in Free', 'Personal agent and MCP access', 'WHOOP and Oura connections', 'Larger hosted quotas for personal wellness context', 'Managed cloud storage and queued genetics processing'],
    intended_use: ['Individual health data workspace', 'Personal agent or automation', 'Non-commercial personal use'],
    rate_limit: { requests_per_minute: 120 },
    monthly_quotas: {
      health_context_reads: 5000,
      queries: 5000,
      uploads: 250,
      analyses: 250,
      wearable_syncs: 100,
      wgs_jobs: 5,
      full_dbsnp_jobs: 0,
    },
    runtime_daily_quotas: {
      'imports.file': 50,
      'analyses.create': 50,
      'connections.sync': 25,
      'query.create': 500,
      'health_context.read': 500,
    },
    caching: { public_metadata_seconds: 300, idempotency_replay: true, health_context_cache_seconds: 60 },
    notes: ['For one person and their own agent. Not for serving other users through an app or service.'],
  },
  {
    id: 'builder',
    name: 'Builder',
    monthly_usd: 24.99,
    included: ['Everything in Standard', 'Commercial agent prototypes', 'Production wearable and biomarker workflows', 'Webhooks for agent automation'],
    intended_use: ['Commercial agent products', 'SaaS pilots', 'Internal wellness products', 'Apps serving other users'],
    rate_limit: { requests_per_minute: 240 },
    monthly_quotas: {
      health_context_reads: 12000,
      queries: 12000,
      uploads: 1000,
      analyses: 750,
      wearable_syncs: 300,
      wgs_jobs: 15,
      full_dbsnp_jobs: 3,
    },
    runtime_daily_quotas: {
      'imports.file': 125,
      'analyses.create': 100,
      'connections.sync': 60,
      'query.create': 1200,
      'health_context.read': 1200,
    },
    caching: { public_metadata_seconds: 300, idempotency_replay: true, health_context_cache_seconds: 60 },
    notes: ['For a commercial agent, early SaaS, or an internal workflow that serves other people. Full dbSNP is an advanced paid capability with a limited job quota once the hosted reference worker is provisioned.'],
  },
  {
    id: 'growth',
    name: 'Growth',
    monthly_usd: 49,
    included: ['Everything in Builder', 'Multi-agent and multi-workspace automation', 'Higher-volume sync and webhook workflows', 'Priority support path'],
    intended_use: ['Production agent products', 'B2B wellness products', 'Multi-tenant service'],
    rate_limit: { requests_per_minute: 600 },
    monthly_quotas: {
      health_context_reads: 50000,
      queries: 50000,
      uploads: 5000,
      analyses: 3000,
      wearable_syncs: 1500,
      wgs_jobs: 50,
      full_dbsnp_jobs: 10,
    },
    runtime_daily_quotas: {
      'imports.file': 500,
      'analyses.create': 400,
      'connections.sync': 250,
      'query.create': 5000,
      'health_context.read': 5000,
    },
    caching: { public_metadata_seconds: 300, idempotency_replay: true, health_context_cache_seconds: 60 },
    notes: ['The highest self-serve hosted plan: for production agent products with recurring syncs. Full dbSNP is an advanced paid capability with a limited job quota once the hosted reference worker is provisioned.'],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    monthly_usd: 'custom',
    included: ['Custom limits', 'BAA/vendor review if needed', 'Dedicated environments and support'],
    intended_use: ['Regulated customers', 'High-volume platforms', 'Dedicated worker/storage requirements', 'Custom contracts'],
    rate_limit: { requests_per_minute: 5000 },
    monthly_quotas: {
      health_context_reads: 'custom',
      queries: 'custom',
      uploads: 'custom',
      analyses: 'custom',
      wearable_syncs: 'custom',
      wgs_jobs: 'custom',
      full_dbsnp_jobs: 'custom',
    },
    runtime_daily_quotas: {},
    caching: { public_metadata_seconds: 300, idempotency_replay: true, health_context_cache_seconds: 60 },
    notes: ['Use for regulated customers, high WGS volume, custom retention, or dedicated worker/storage requirements.'],
  },
];

export function pricingCatalog() {
  return {
    service: 'foreverbetter-api',
    generated_at: new Date().toISOString(),
    currency: 'USD',
    hosted_introductory_allowance: {
      requests: HOSTED_INTRODUCTORY_REQUEST_LIMIT,
      payment_method_required_after: HOSTED_INTRODUCTORY_REQUEST_LIMIT,
      scope: 'per cloud workspace',
      summary: `Your first ${HOSTED_INTRODUCTORY_REQUEST_LIMIT} protected hosted API requests are free. When you choose to continue, Checkout collects a payment method and the selected subscription begins. Self-hosting is always available without a hosted subscription.`,
    },
    tiers: PRICING_TIERS,
    enforcement: {
      auth: 'API keys are bearer JWTs with tier, scope, endpoint, user, and organization claims.',
      pricing_boundary: 'Free keys are for personal use or your own authorized agent. Apps, platforms, SaaS products, and services for other users require Builder or higher.',
      runtime_rate_limiting: 'Per-IP, per-route, per-subject, and per-tier fixed-window limits are enforced by the API process.',
      runtime_quotas: 'Runtime daily quotas are enforced in-process for v1; production multi-instance deployments should move quota counters to Redis or durable storage.',
      caching: 'Public metadata endpoints are cacheable; write endpoints support Idempotency-Key replay; sensitive user data is returned with no-store by default.',
    },
  };
}

export async function issueApiKey(
  input: ApiKeyCreateRequest,
  auth: AuthContext,
  config: AuthConfig,
  options: { allowPaidTier?: PricingTierId } = {},
): Promise<ApiKeyIssueResult> {
  const secret = config.apiKeySecret ?? config.serviceAccountSecret;
  if (!secret) throw new Error('API key issuing requires API_KEY_JWT_SECRET or SERVICE_ACCOUNT_JWT_SECRET.');

  const intendedUse = input.intended_use ?? 'personal_agent';
  const requestedTier = input.tier ?? (intendedUse === 'app_platform_service' ? 'builder' : 'free');
  if (!tierById(requestedTier)) throw new Error(`Unknown pricing tier: ${requestedTier}`);
  if (intendedUse === 'app_platform_service' && requestedTier === 'free') {
    throw new Error('Free API keys are for personal use or your own agent. Building an app, platform, or service requires Builder or higher.');
  }
  if (intendedUse === 'mobile_sync' && requestedTier !== 'free') {
    throw new Error('ForeverBetter Connect mobile sync credentials use the free device-session tier.');
  }
  const isAdmin = auth.scopes.has('health:admin');
  const billingAdmin = isBillingAdmin(auth, config);
  if (intendedUse === 'mobile_sync' && !isAdmin && !String(auth.claims.api_key_id ?? '').startsWith('otp_session_')) {
    throw new Error('Mobile sync credentials require a fresh email sign-in session.');
  }
  if (!isAdmin && !billingAdmin && requestedTier !== 'free' && options.allowPaidTier !== requestedTier) {
    throw new Error('A current hosted subscription is required before issuing a paid-tier API key.');
  }

  const userId = input.user_id ?? auth.userId;
  if (!isAdmin && userId !== auth.userId) throw new Error('Non-admin tokens can issue API keys only for their own user_id.');

  const organizationId = resolveApiKeyOrganizationId(input.organization_id, userId, auth, isAdmin);
  if (!isAdmin && auth.organizationIds && auth.organizationIds.size > 0 && !auth.organizationIds.has(organizationId)) {
    throw new Error('Token is not allowed to issue API keys for this organization.');
  }

  const persistentMobileSync = intendedUse === 'mobile_sync';
  const scopes = persistentMobileSync
    ? (['health:data:write'] satisfies AuthScope[])
    : sanitizeScopes(input.scopes ?? DEFAULT_API_KEY_SCOPES, isAdmin);
  const endpoints = persistentMobileSync
    ? (['connections.sync'] satisfies EndpointId[])
    : sanitizeEndpoints(input.enabled_endpoints ?? DEFAULT_API_KEY_ENDPOINTS);
  const expiresInDays = Math.min(Math.max(input.expires_in_days ?? 365, 1), 730);
  const expiresAt = persistentMobileSync ? undefined : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
  const id = `key_${randomUUID()}`;
  const name = input.name?.trim() || `${requestedTier} api key`;
  const tier = tierById(requestedTier)!;

  const payload: JWTPayload & Record<string, unknown> = {
    token_type: 'api_key',
    api_key_id: id,
    name,
    tier: requestedTier,
    intended_use: intendedUse,
    user_id: userId,
    ...(typeof auth.claims.email === 'string' ? { email: auth.claims.email } : {}),
    scope: scopes.join(' '),
    enabled_endpoints: endpoints,
    organization_id: organizationId,
  };
  let tokenBuilder = new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setAudience(primaryAuthAudience(config))
    .setSubject(id)
    .setIssuedAt();
  if (expiresAt) tokenBuilder = tokenBuilder.setExpirationTime(Math.floor(expiresAt.getTime() / 1000));
  const token = await tokenBuilder.sign(new TextEncoder().encode(secret));

  return {
    api_key: token,
    authorization_header: `Bearer ${token}`,
    created: {
      id,
      name,
      token_type: 'api_key',
      tier: requestedTier,
      intended_use: intendedUse,
      user_id: userId,
      organization_id: organizationId,
      scopes,
      enabled_endpoints: endpoints,
      expires_at: expiresAt?.toISOString() ?? null,
    },
    usage: {
      send_header: 'Authorization: Bearer <api_key>',
      pricing_tier: tier,
      key_is_shown_once: true,
    },
  };
}

export async function issueSandboxSession(config: AuthConfig): Promise<SandboxSessionResult> {
  const secret = config.apiKeySecret ?? config.serviceAccountSecret;
  if (!secret) throw new Error('Synthetic sandbox requires API_KEY_JWT_SECRET or SERVICE_ACCOUNT_JWT_SECRET.');
  const suffix = randomUUID();
  const userId = `sandbox_${suffix}`;
  const organizationId = `org_sandbox_${suffix.replace(/-/g, '').slice(0, 24)}`;
  const expiresAt = new Date(Date.now() + SANDBOX_SESSION_TTL_SECONDS * 1000);
  const token = await new SignJWT({
    token_type: 'api_key',
    api_key_id: `sandbox_key_${randomUUID()}`,
    name: 'synthetic sandbox session',
    tier: 'free',
    intended_use: 'personal_agent',
    user_id: userId,
    organization_id: organizationId,
    scope: SANDBOX_SESSION_SCOPES.join(' '),
    enabled_endpoints: SANDBOX_SESSION_ENDPOINTS,
    sandbox: true,
    synthetic_only: true,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setAudience(primaryAuthAudience(config))
    .setSubject(`sandbox_session_${suffix}`)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(new TextEncoder().encode(secret));

  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: SANDBOX_SESSION_TTL_SECONDS,
    expires_at: expiresAt.toISOString(),
    synthetic_only: true,
    user_id: userId,
    organization_id: organizationId,
  };
}

// Stable per-email user id so a returning user keeps the same account and data.
export function otpSessionUserId(email: string): string {
  const hash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);
  return `usr_${hash}`;
}

// Mint a short-lived personal session for an email that just passed OTP. The
// token is an HS256 api_key JWT accepted by authenticate(); the dashboard and
// agent-login flow use it to act as, and issue a durable key for, this user.
export async function issueUserSession(email: string, config: AuthConfig): Promise<{
  access_token: string;
  token_type: string;
  expires_at: number;
  expires_in: number;
  user: { id: string; email: string };
}> {
  const secret = config.apiKeySecret ?? config.serviceAccountSecret;
  if (!secret) throw new Error('OTP sessions require API_KEY_JWT_SECRET or SERVICE_ACCOUNT_JWT_SECRET.');
  const ttlSeconds = Number(process.env.OTP_SESSION_TTL_SECONDS ?? 3600);
  const normalizedEmail = email.trim().toLowerCase();
  const userId = otpSessionUserId(normalizedEmail);
  const organizationId = personalOrganizationId(userId);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const token = await new SignJWT({
    token_type: 'api_key',
    api_key_id: `otp_session_${randomUUID()}`,
    name: 'email sign-in session',
    tier: 'free',
    intended_use: 'personal_agent',
    user_id: userId,
    email: normalizedEmail,
    organization_id: organizationId,
    scope: DEFAULT_API_KEY_SCOPES.join(' '),
    enabled_endpoints: DEFAULT_API_KEY_ENDPOINTS,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setAudience(primaryAuthAudience(config))
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(new TextEncoder().encode(secret));
  return {
    access_token: token,
    token_type: 'Bearer',
    expires_at: Math.floor(expiresAt.getTime() / 1000),
    expires_in: ttlSeconds,
    user: { id: userId, email: normalizedEmail },
  };
}

export function personalOrganizationId(userId: string): string {
  const normalized = userId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
  return `org_personal_${normalized || 'user'}`;
}

export function tierById(id: string | undefined): PricingTier | undefined {
  return PRICING_TIERS.find(tier => tier.id === id);
}

export function tierRateLimitForClaims(claims: JWTPayload): { windowMs: number; max: number } | undefined {
  const tier = tierById(typeof (claims as Record<string, unknown>).tier === 'string' ? (claims as Record<string, string>).tier : undefined);
  if (!tier) return undefined;
  return { windowMs: 60_000, max: tier.rate_limit.requests_per_minute };
}

export function assertTierQuota(limiter: InMemoryRateLimiter, auth: AuthContext, id: TierQuotaId): void {
  const tier = tierById(typeof (auth.claims as Record<string, unknown>).tier === 'string' ? (auth.claims as Record<string, string>).tier : undefined);
  if (!tier) return;
  const max = tier.runtime_daily_quotas[id];
  if (!max) return;
  limiter.assertAllowed(`tier-quota:${tier.id}:${id}:${auth.subject}`, { windowMs: 24 * 60 * 60 * 1000, max });
}

function sanitizeScopes(scopes: AuthScope[], isAdmin: boolean): AuthScope[] {
  const allowed = new Set<AuthScope>(DEFAULT_API_KEY_SCOPES);
  if (isAdmin) allowed.add('health:admin');
  const sanitized = Array.from(new Set(scopes.filter(scope => allowed.has(scope))));
  return sanitized.length > 0 ? sanitized : DEFAULT_API_KEY_SCOPES;
}

function sanitizeEndpoints(endpoints: EndpointId[]): EndpointId[] {
  return Array.from(new Set(endpoints.length > 0 ? endpoints : DEFAULT_API_KEY_ENDPOINTS));
}

function resolveApiKeyOrganizationId(
  requestedOrganizationId: string | undefined,
  userId: string,
  auth: AuthContext,
  isAdmin: boolean,
): string {
  if (requestedOrganizationId) {
    if (!isAdmin && (!auth.organizationIds || auth.organizationIds.size === 0) && requestedOrganizationId !== personalOrganizationId(userId)) {
      throw new Error('First-time users can issue free keys only for their personal workspace.');
    }
    return requestedOrganizationId;
  }
  if (auth.organizationIds?.size === 1) return Array.from(auth.organizationIds)[0];
  return personalOrganizationId(userId);
}

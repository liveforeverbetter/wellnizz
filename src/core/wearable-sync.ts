import { syncWearableProvider } from '../connectors/wearables.js';
import { runWearableAutoAnalysis } from './analysis.js';
import { decryptToken, encryptToken, loadTokenEncryptionKey } from '../connectors/token-crypto.js';
import { createId, type HealthStore } from '../store.js';
import { buildSourceReference, normalizeImportedFile } from './normalization.js';
import type { ConnectorSyncJob, ConnectorSyncRequest, ProviderToken } from '../types.js';

export interface PersistedWhoopWebhookSync {
  provider: 'whoop';
  readings_count: number;
  resource_type?: string;
  source?: ReturnType<typeof buildSourceReference>;
  normalized_observations?: ReturnType<typeof normalizeImportedFile>;
}

export interface PersistedOuraWebhookSync {
  provider: 'oura';
  readings_count: number;
  resource_type?: string;
  source?: ReturnType<typeof buildSourceReference>;
  normalized_observations?: ReturnType<typeof normalizeImportedFile>;
}

// Run a WHOOP sync triggered by an inbound webhook. Resolves the stored
// encrypted refresh token for the connection, refreshes an access token, pulls a
// recent window (WHOOP webhooks are notifications, so we re-fetch rather than
// trust the payload), and persists normalized observations. WHOOP's own docs
// recommend treating webhooks as triggers for a reconciling fetch.
export async function runWhoopWebhookSync(input: ConnectorSyncRequest, store: HealthStore): Promise<PersistedWhoopWebhookSync> {
  const key = loadTokenEncryptionKey();
  if (!key) throw new Error('WHOOP_TOKEN_ENC_KEY is required to process WHOOP webhook syncs.');
  const clientId = process.env.WHOOP_CLIENT_ID;
  const clientSecret = process.env.WHOOP_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET are required to process WHOOP webhook syncs.');

  const token = await resolveWhoopToken(input, store);
  if (!token) throw new Error('No stored WHOOP token for this connection; cannot sync.');

  const accessToken = token.access_token_encrypted ? decryptToken(token.access_token_encrypted, key) : undefined;
  const refreshToken = token.refresh_token_encrypted ? decryptToken(token.refresh_token_encrypted, key) : undefined;

  const syncResult = await syncWearableProvider('whoop', {
    user_id: input.user_id,
    organization_id: input.organization_id,
    access_token: accessToken,
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    start: input.start ?? isoDaysAgo(7),
    end: input.end,
    limit: input.limit,
  });

  // Persist a rotated refresh token so the next webhook can reuse it.
  if (syncResult.refreshed_token) {
    const rotatedAccess = syncResult.refreshed_token.access_token;
    const rotatedRefresh = syncResult.refreshed_token.refresh_token ?? refreshToken;
    const expiresAt = syncResult.refreshed_token.expires_in
      ? new Date(Date.now() + syncResult.refreshed_token.expires_in * 1000).toISOString()
      : token.expires_at;
    await store.saveProviderToken({
      ...token,
      access_token_encrypted: rotatedAccess ? encryptTokenValue(rotatedAccess, key) : token.access_token_encrypted,
      refresh_token_encrypted: rotatedRefresh ? encryptTokenValue(rotatedRefresh, key) : token.refresh_token_encrypted,
      scope: syncResult.refreshed_token.scope ?? token.scope,
      token_type: syncResult.refreshed_token.token_type ?? token.token_type,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    });
  }

  if (!syncResult.readings?.length) {
    return { provider: 'whoop', readings_count: 0, resource_type: input.webhook_resource_type };
  }

  const payload = Buffer.from(JSON.stringify(syncResult.raw), 'utf8');
  const source = buildSourceReference({
    user_id: input.user_id,
    organization_id: input.organization_id,
    category: 'wearables',
    provider: 'whoop',
    filename: `whoop-webhook-sync.json`,
    content_type: 'application/json',
    text: payload.toString('utf8'),
  }, payload);
  const normalized_observations = normalizeImportedFile(source, JSON.stringify({ readings: syncResult.readings }));
  await store.saveSource(source, normalized_observations);
  await refreshWearableAnalysis(store, input.user_id, input.organization_id);
  return {
    provider: 'whoop',
    readings_count: syncResult.readings.length,
    resource_type: input.webhook_resource_type,
    source,
    normalized_observations,
  };
}

async function resolveWhoopToken(input: ConnectorSyncRequest, store: HealthStore): Promise<ProviderToken | undefined> {
  // Webhook jobs carry the WHOOP user id via provider_user_id; fall back to the
  // external_user_id used as the account reference.
  const candidates = [input.provider_user_id, input.external_user_id].filter((v): v is string => Boolean(v));
  for (const candidate of candidates) {
    const token = await store.getProviderTokenByExternalUser('whoop', candidate);
    if (token) return token;
  }
  return undefined;
}

// Oura webhook payloads are notifications rather than source-of-truth health
// data. Re-fetch a small recent window with the stored encrypted token, then
// persist the normalized observations just as we do for WHOOP.
export async function runOuraWebhookSync(input: ConnectorSyncRequest, store: HealthStore): Promise<PersistedOuraWebhookSync> {
  const key = loadTokenEncryptionKey();
  if (!key) throw new Error('WHOOP_TOKEN_ENC_KEY is required to process Oura webhook syncs.');
  const clientId = process.env.OURA_CLIENT_ID;
  const clientSecret = process.env.OURA_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('OURA_CLIENT_ID and OURA_CLIENT_SECRET are required to process Oura webhook syncs.');

  const token = await resolveOuraToken(input, store);
  if (!token) throw new Error('No stored Oura token for this connection; cannot sync.');
  const accessToken = token.access_token_encrypted ? decryptToken(token.access_token_encrypted, key) : undefined;
  const refreshToken = token.refresh_token_encrypted ? decryptToken(token.refresh_token_encrypted, key) : undefined;
  const syncResult = await syncWearableProvider('oura', {
    user_id: input.user_id,
    organization_id: input.organization_id,
    access_token: accessToken,
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    start: input.start ?? isoDaysAgo(2),
    end: input.end,
    limit: input.limit,
  });
  if (syncResult.refreshed_token) {
    const rotatedAccess = syncResult.refreshed_token.access_token;
    const rotatedRefresh = syncResult.refreshed_token.refresh_token ?? refreshToken;
    await store.saveProviderToken({
      ...token,
      access_token_encrypted: rotatedAccess ? encryptTokenValue(rotatedAccess, key) : token.access_token_encrypted,
      refresh_token_encrypted: rotatedRefresh ? encryptTokenValue(rotatedRefresh, key) : token.refresh_token_encrypted,
      scope: syncResult.refreshed_token.scope ?? token.scope,
      token_type: syncResult.refreshed_token.token_type ?? token.token_type,
      expires_at: syncResult.refreshed_token.expires_in ? new Date(Date.now() + syncResult.refreshed_token.expires_in * 1000).toISOString() : token.expires_at,
      updated_at: new Date().toISOString(),
    });
  }
  if (!syncResult.readings?.length) return { provider: 'oura', readings_count: 0, resource_type: input.webhook_resource_type };

  const payload = Buffer.from(JSON.stringify(syncResult.raw), 'utf8');
  const source = buildSourceReference({
    user_id: input.user_id,
    organization_id: input.organization_id,
    category: 'wearables',
    provider: 'oura',
    filename: 'oura-webhook-sync.json',
    content_type: 'application/json',
    text: payload.toString('utf8'),
  }, payload);
  const normalized_observations = normalizeImportedFile(source, JSON.stringify({ readings: syncResult.readings }));
  await store.saveSource(source, normalized_observations);
  await refreshWearableAnalysis(store, input.user_id, input.organization_id);
  return { provider: 'oura', readings_count: syncResult.readings.length, resource_type: input.webhook_resource_type, source, normalized_observations };
}

async function resolveOuraToken(input: ConnectorSyncRequest, store: HealthStore): Promise<ProviderToken | undefined> {
  const candidates = [input.provider_user_id, input.external_user_id].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const token = await store.getProviderTokenByExternalUser('oura', candidate);
    if (token) return token;
  }
  return undefined;
}

// Refresh the stored wearables analysis after a webhook sync persists new
// readings, so the dashboard reflects the sync without a manual re-analysis.
// Best-effort: a failure must not fail the webhook job.
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

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function encryptTokenValue(plaintext: string, key: Buffer): string {
  return encryptToken(plaintext, key);
}

export async function enqueueWearablesSync(input: ConnectorSyncRequest, store: HealthStore): Promise<ConnectorSyncJob> {
  const now = new Date().toISOString();
  const externalUserId = input.provider_user_id ?? input.external_user_id ?? input.user_id;

  // Webhook jobs reference an already-connected account and store no inline
  // credentials in the queue.
  if (input.source_provider === 'whoop' || input.source_provider === 'oura') {
    const job: ConnectorSyncJob = {
      id: createId('wjob'),
      user_id: input.user_id,
      organization_id: requireOrganizationId(input.organization_id),
      provider: input.source_provider,
      external_account_id: input.external_user_id,
      scheduled_for: input.scheduled_for ?? now,
      status: 'queued',
      attempts: 0,
      max_attempts: Number(process.env.WEARABLE_SYNC_MAX_ATTEMPTS ?? '5'),
      priority: 0,
      request: sanitizedSyncRequest(input, externalUserId),
      created_at: now,
      updated_at: now,
    };
    await store.createConnectorSyncJob(job);
    return job;
  }

  throw new Error('Queued wearable sync supports WHOOP and Oura webhook jobs only. Use the mobile SDK or file import for Health Connect data.');
}

export function connectorSyncJobSummary(job: ConnectorSyncJob): Record<string, unknown> {
  return {
    id: job.id,
    user_id: job.user_id,
    organization_id: job.organization_id,
    provider: job.provider,
    external_account_id: job.external_account_id,
    scheduled_for: job.scheduled_for,
    status: job.status,
    attempts: job.attempts,
    max_attempts: job.max_attempts,
    created_at: job.created_at,
    updated_at: job.updated_at,
    started_at: job.started_at,
    completed_at: job.completed_at,
    error: job.error,
    result: job.result,
  };
}

function sanitizedSyncRequest(input: ConnectorSyncRequest, externalUserId: string): Record<string, unknown> {
  return {
    user_id: input.user_id,
    organization_id: input.organization_id,
    provider_user_id: externalUserId,
    external_user_id: externalUserId,
    api_base_url: input.api_base_url,
    types: input.types,
    start: input.start,
    end: input.end,
    limit: input.limit,
    source_provider: input.source_provider,
    webhook_resource_type: input.webhook_resource_type,
    webhook_resource_id: input.webhook_resource_id,
    webhook_trace_id: input.webhook_trace_id,
  };
}

function requireOrganizationId(value: string | undefined): string {
  if (!value) throw new Error('organization_id is required to queue wearable sync jobs.');
  return value;
}

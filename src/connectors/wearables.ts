import { randomBytes } from 'node:crypto';
import type { ConnectorSyncRequest, OAuthTokenRequest, OAuthUrlRequest, ProviderId } from '../types.js';
import type { WearableReading } from '../core/engines.js';

export interface WearableConnector {
  id: 'whoop' | 'oura';
  auth_url: string;
  token_url: string;
  api_base_url: string;
  default_scopes: string[];
}

// Direct OAuth wearable connectors. WHOOP is the supported server-side OAuth
// provider. Google Health Connect is an on-device Android aggregator and is
// integrated through a mobile bridge instead (see WEARABLE_PROVIDERS).
export const WEARABLE_CONNECTORS: Record<'whoop' | 'oura', WearableConnector> = {
  whoop: {
    id: 'whoop',
    auth_url: 'https://api.prod.whoop.com/oauth/oauth2/auth',
    token_url: 'https://api.prod.whoop.com/oauth/oauth2/token',
    api_base_url: 'https://api.prod.whoop.com/developer/v2',
    // read:profile is required to resolve the WHOOP user id used by webhook
    // deliveries. Without it, the OAuth exchange succeeds but token persistence
    // falls back to the stateless contract.
    default_scopes: ['offline', 'read:profile', 'read:cycles', 'read:recovery', 'read:sleep', 'read:workout'],
  },
  oura: {
    id: 'oura',
    auth_url: 'https://cloud.ouraring.com/oauth/authorize',
    token_url: 'https://api.ouraring.com/oauth/token',
    api_base_url: 'https://api.ouraring.com/v2',
    // Oura users can choose which permissions to grant. These are the least
    // scopes needed for the dashboard's sleep, readiness, activity and HRV use.
    default_scopes: ['daily', 'heartrate', 'personal', 'workout'],
  },
};

export type WearableProviderId = 'whoop' | 'oura' | 'health_connect';
export type WearableConnectionType = 'oauth' | 'mobile_bridge';

export interface WearableProviderInfo {
  id: WearableProviderId;
  display_name: string;
  connection_type: WearableConnectionType;
  data_types: string[];
  notes: string[];
}

// Public catalog of supported wearable providers behind the generic `wearables`
// surface. WHOOP connects via server-side OAuth; Google Health Connect connects
// via an on-device mobile bridge that reads Health Connect and pushes normalized
// readings to the API.
export const WEARABLE_PROVIDERS: WearableProviderInfo[] = [
  {
    id: 'whoop',
    display_name: 'WHOOP',
    connection_type: 'oauth',
    data_types: ['sleep', 'recovery', 'cycles', 'workouts', 'hrv', 'resting_heart_rate'],
    notes: ['Server-side OAuth. Build an authorization URL, exchange the code, then sync normalized observations.'],
  },
  {
    id: 'oura',
    display_name: 'Oura',
    connection_type: 'oauth',
    data_types: ['sleep', 'readiness', 'activity', 'workouts', 'hrv', 'resting_heart_rate', 'steps'],
    notes: ['Server-side OAuth using Oura API V2. Build an authorization URL, exchange the code, then sync normalized daily observations.'],
  },
  {
    id: 'health_connect',
    display_name: 'Google Health Connect',
    connection_type: 'mobile_bridge',
    data_types: ['steps', 'sleep', 'heart_rate', 'hrv', 'oxygen_saturation', 'active_energy', 'respiratory_rate', 'vo2_max', 'weight', 'body_fat', 'blood_pressure', 'blood_glucose'],
    notes: [
      'On-device Android aggregator. It can surface data from Fitbit, Samsung Health, Google Fit, and many other Android apps in one place.',
      'Connect with a mobile bridge: request Health Connect read permissions on-device, then sync through the Wellnizz mobile SDK or POST /imports/file (category: wearables, provider: health_connect).',
      'There is no server OAuth redirect for Health Connect. POST /connections/wearables/start returns the bridge setup contract instead of an authorization URL.',
    ],
  },
];

export function wearableProviderInfo(provider: string): WearableProviderInfo | undefined {
  return WEARABLE_PROVIDERS.find(entry => entry.id === provider);
}

// Health Connect record types (and common bridge aliases) mapped to canonical
// wearable metric ids. Mobile bridges can either pre-map to these ids or send
// Health Connect names directly - parseWearableJson resolves both via aliases.
export const HEALTH_CONNECT_METRIC_MAP: Record<string, string> = {
  steps: 'steps',
  totalstepscount: 'steps',
  sleepsession: 'sleep_duration',
  sleep_duration: 'sleep_duration',
  heartratevariabilityrmssd: 'hrv',
  hrv: 'hrv',
  restingheartrate: 'resting_heart_rate',
  resting_heart_rate: 'resting_heart_rate',
  oxygensaturation: 'spo2',
  oxygen_saturation: 'spo2',
  respiratoryrate: 'respiratory_rate',
  respiratory_rate: 'respiratory_rate',
  activecaloriesburned: 'active_energy',
  active_calories_burned: 'active_energy',
  vo2max: 'vo2max_estimate',
  vo2_max: 'vo2max_estimate',
  weight: 'weight',
  bodyfat: 'body_fat_percent',
  body_fat: 'body_fat_percent',
  bloodglucose: 'glucose_mean',
  blood_glucose: 'glucose_mean',
  bloodpressuresystolic: 'systolic_bp',
  blood_pressure_systolic: 'systolic_bp',
  bloodpressurediastolic: 'diastolic_bp',
  blood_pressure_diastolic: 'diastolic_bp',
};

// The bridge setup contract returned by /connections/wearables/start for
// mobile-bridge providers such as Health Connect.
export function mobileBridgeConnection(provider: WearableProviderInfo): {
  provider: 'wearables';
  source_provider: WearableProviderId;
  connection_type: 'mobile_bridge';
  data_types: string[];
  instructions: string[];
  ingestion: { sync_endpoint: string; import_endpoint: string; import_provider: string; import_category: 'wearables' };
  notes: string[];
} {
  return {
    provider: 'wearables',
    source_provider: provider.id,
    connection_type: 'mobile_bridge',
    data_types: provider.data_types,
    instructions: [
      'In your Android app, request Health Connect read permissions for the data types you need.',
      'Read the latest records from Health Connect on-device.',
      'Map each record to a canonical wearable metric id (see HEALTH_CONNECT_METRIC_MAP) or send Health Connect names directly.',
      'Sync with the Wellnizz mobile SDK, or push normalized readings to POST /imports/file with category "wearables" and provider "health_connect".',
    ],
    ingestion: {
      sync_endpoint: 'Wellnizz mobile SDK direct sync',
      import_endpoint: 'POST /imports/file',
      import_provider: 'health_connect',
      import_category: 'wearables',
    },
    notes: provider.notes,
  };
}

export function buildOAuthUrl(provider: ProviderId, input: OAuthUrlRequest): { provider: string; authorization_url: string; scopes: string[] } {
  const connector = wearableConnector(provider);
  const scopes = input.scopes?.length ? input.scopes : connector.default_scopes;
  // WHOOP requires at least eight characters. Generate 192 bits of entropy
  // when callers omit state so dashboard and agent-started flows are safe by
  // default instead of relying on every client to remember this OAuth detail.
  const requestedState = input.state?.trim();
  const state = requestedState && requestedState.length >= 8
    ? requestedState
    : randomBytes(24).toString('base64url');
  const params = new URLSearchParams({
    client_id: input.client_id,
    redirect_uri: input.redirect_uri,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
  });
  return {
    provider: connector.id,
    authorization_url: `${connector.auth_url}?${params.toString()}`,
    scopes,
  };
}

export async function exchangeOAuthCode(provider: ProviderId, input: OAuthTokenRequest): Promise<unknown> {
  const connector = wearableConnector(provider);
  const response = await fetch(connector.token_url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      client_id: input.client_id,
      client_secret: input.client_secret,
      redirect_uri: input.redirect_uri,
    }),
  });
  return checkedJson(response, `${connector.id} token exchange`);
}

// Resolve the WHOOP-side user id for a freshly issued access token. Webhooks are
// keyed on this id, so it is the join key between an inbound webhook and the
// stored connection.
export async function fetchWhoopUserId(accessToken: string): Promise<string | undefined> {
  const connector = WEARABLE_CONNECTORS.whoop;
  const profile = await providerGet(`${connector.api_base_url}/user/profile/basic`, accessToken);
  const record = objectRecord(profile);
  const id = record.user_id ?? record.userId;
  return id == null ? undefined : String(id);
}

// Oura webhook deliveries are keyed on the Oura member id. Resolve it during
// OAuth completion so a delivery can be joined to the encrypted token later.
export async function fetchOuraUserId(accessToken: string): Promise<string | undefined> {
  const connector = WEARABLE_CONNECTORS.oura;
  const profile = await providerGet(`${connector.api_base_url}/usercollection/personal_info`, accessToken);
  const id = objectRecord(profile).id;
  return id == null ? undefined : String(id);
}

export interface OAuthRefreshRequest {
  refresh_token: string;
  client_id: string;
  client_secret: string;
  scopes?: string[];
}

export interface OAuthTokenSet {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

// Exchange a refresh token for a fresh access token. Long-lived provider tokens
// expire; without this, scheduled syncs silently stop returning data.
export async function refreshOAuthToken(provider: ProviderId, input: OAuthRefreshRequest): Promise<OAuthTokenSet> {
  const connector = wearableConnector(provider);
  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: input.refresh_token,
    client_id: input.client_id,
    client_secret: input.client_secret,
  };
  // WHOOP requires the offline scope to be re-requested on refresh. Oura does
  // not require scopes on refresh and its refresh tokens are single-use.
  const scopes = input.scopes?.length
    ? input.scopes
    : connector.id === 'whoop' ? connector.default_scopes.filter(scope => scope === 'offline') : [];
  if (scopes.length) body.scope = scopes.join(' ');
  const response = await fetch(connector.token_url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body),
  });
  return checkedJson(response, `${connector.id} token refresh`) as Promise<OAuthTokenSet>;
}

export interface WearableSyncResult {
  provider: 'whoop' | 'oura' | 'wearables';
  raw: unknown[];
  readings?: WearableReading[];
  refreshed_token?: OAuthTokenSet;
}

export async function syncWearableProvider(provider: ProviderId, input: ConnectorSyncRequest): Promise<WearableSyncResult> {
  const connector = wearableConnector(provider);
  if (provider === 'whoop') {
    const { raw, refreshed } = await fetchWhoop(input, connector);
    return { provider: 'whoop', raw, refreshed_token: refreshed };
  }
  const { raw, readings, refreshed } = await fetchOura(input, connector);
  return { provider: 'oura', raw, readings, refreshed_token: refreshed };
}

export class ProviderHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

function wearableConnector(provider: ProviderId): WearableConnector {
  if (provider !== 'whoop' && provider !== 'oura') {
    throw new Error(`Unsupported OAuth wearable provider: ${provider}. WHOOP and Oura use OAuth; Google Health Connect uses a mobile bridge.`);
  }
  return WEARABLE_CONNECTORS[provider];
}

async function fetchOura(input: ConnectorSyncRequest, connector: WearableConnector): Promise<{ raw: unknown[]; readings: WearableReading[]; refreshed?: OAuthTokenSet }> {
  if (!input.access_token && !input.refresh_token) throw new Error('Oura sync requires access_token (or refresh_token with client credentials).');
  const params = windowParams(input, false);
  const paths = ['/usercollection/daily_readiness', '/usercollection/daily_sleep', '/usercollection/daily_activity'];
  const canRefresh = Boolean(input.refresh_token && input.client_id && input.client_secret);
  const fetchAll = async (token: string) => {
    const raw = await Promise.all(paths.map(path => providerGet(`${connector.api_base_url}${path}?${params}`, token)));
    return { raw, readings: normalizeOuraReadings(raw) };
  };

  if (input.access_token) {
    try {
      return await fetchAll(input.access_token);
    } catch (error) {
      if (!(error instanceof ProviderHttpError && error.status === 401 && canRefresh)) throw error;
    }
  }
  const refreshed = await refreshOAuthToken('oura', {
    refresh_token: input.refresh_token!,
    client_id: input.client_id!,
    client_secret: input.client_secret!,
  });
  if (!refreshed.access_token) throw new Error('Oura token refresh did not return an access_token.');
  return { ...(await fetchAll(refreshed.access_token)), refreshed };
}

function normalizeOuraReadings(payloads: unknown[]): WearableReading[] {
  const [readiness, sleep, activity] = payloads.map(responseRows);
  const readings: WearableReading[] = [];
  for (const row of readiness) {
    const score = numberValue(objectRecord(row).score);
    if (score != null) readings.push({ id: 'recovery_score', value: score, unit: 'score' });
  }
  for (const row of sleep) {
    const record = objectRecord(row);
    const totalSleep = numberValue(record.total_sleep_duration);
    if (totalSleep != null) readings.push({ id: 'sleep_duration', value: Math.round((totalSleep / 3600) * 100) / 100, unit: 'hours' });
    const efficiency = numberValue(record.efficiency);
    if (efficiency != null) readings.push({ id: 'sleep_efficiency', value: efficiency, unit: '%' });
    const hrv = numberValue(record.average_hrv);
    if (hrv != null) readings.push({ id: 'hrv', value: hrv, unit: 'ms' });
    const restingHeartRate = numberValue(record.lowest_heart_rate);
    if (restingHeartRate != null) readings.push({ id: 'resting_heart_rate', value: restingHeartRate, unit: 'bpm' });
  }
  for (const row of activity) {
    const record = objectRecord(row);
    const steps = numberValue(record.steps);
    if (steps != null) readings.push({ id: 'steps', value: steps, unit: 'steps' });
    const activeEnergy = numberValue(record.active_calories);
    if (activeEnergy != null) readings.push({ id: 'active_energy', value: activeEnergy, unit: 'kcal' });
  }
  return readings;
}

async function fetchWhoop(input: ConnectorSyncRequest, connector: WearableConnector): Promise<{ raw: unknown[]; refreshed?: OAuthTokenSet }> {
  if (!input.access_token && !input.refresh_token) throw new Error('WHOOP sync requires access_token (or refresh_token with client credentials).');
  const params = windowParams(input, true);
  const paths = ['/cycle', '/recovery', '/activity/sleep', '/activity/workout'];
  const canRefresh = Boolean(input.refresh_token && input.client_id && input.client_secret);

  const fetchAll = (token: string) => Promise.all(paths.map(path => providerGet(`${connector.api_base_url}${path}?${params}`, token)));

  if (input.access_token) {
    try {
      return { raw: await fetchAll(input.access_token) };
    } catch (error) {
      if (!(error instanceof ProviderHttpError && error.status === 401 && canRefresh)) throw error;
    }
  }

  // Access token missing or expired (401): refresh once and retry, returning the
  // new token set so the caller can persist it.
  const refreshed = await refreshOAuthToken('whoop', {
    refresh_token: input.refresh_token!,
    client_id: input.client_id!,
    client_secret: input.client_secret!,
  });
  if (!refreshed.access_token) throw new Error('WHOOP token refresh did not return an access_token.');
  return { raw: await fetchAll(refreshed.access_token), refreshed };
}

function windowParams(input: ConnectorSyncRequest, dateTime: boolean): string {
  const params = new URLSearchParams();
  if (dateTime) {
    if (input.start) params.set('start', `${input.start}T00:00:00.000Z`);
    if (input.end) params.set('end', `${input.end}T23:59:59.999Z`);
    params.set('limit', String(Math.min(Math.max(input.limit ?? 25, 1), 25)));
  } else {
    if (input.start) params.set('start_date', input.start);
    if (input.end) params.set('end_date', input.end);
  }
  return params.toString();
}

async function providerGet(url: string, accessToken: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  return checkedJson(response, url);
}

function responseRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = objectRecord(payload);
  if (Array.isArray(record.data)) return record.data;
  if (Array.isArray(record.items)) return record.items;
  return [];
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

async function checkedJson(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) throw new ProviderHttpError(response.status, `${label} failed with ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/**
 * Cloud client for a compatible hosted health API.
 *
 * This is the optional "cloud mode" bridge. It mirrors the hosted API so the
 * skill can, instead of (or in addition to) running locally, upload data, run
 * analyses, and fetch the same canonical action plan / dashboard shape from the
 * server. The server adds what a local script cannot do: wearable OAuth,
 * persistence, retest reminders, and hosted dashboards.
 *
 * White-label: this client is provider-neutral. It talks to whatever base URL
 * is in HEALTH_API_URL. It defaults to the reference hosted instance only so
 * cloud mode works out of the box; override HEALTH_API_URL for any compatible
 * deployment.
 *
 * Auth: a scoped API key from the service's agent dashboard, sent as a bearer
 * token. Get one at `${HEALTH_API_URL}/dashboard`.
 */

export interface CloudConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'https://app.wellnizz.com';

export function cloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  return {
    baseUrl: (env.HEALTH_API_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
    apiKey: env.HEALTH_API_KEY,
    timeoutMs: Number(env.HEALTH_API_TIMEOUT_MS ?? 15_000),
  };
}

export type Modality = 'genetics' | 'biomarkers' | 'wearables' | 'behavioral';

export interface CloudProblem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  code?: string;
  cause?: string;
  fix?: string;
  docs_url?: string;
  request_id?: string;
  retryable?: boolean;
  message?: string;
}

export class CloudApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly problem: CloudProblem,
  ) {
    super(message);
    this.name = 'CloudApiError';
  }
}

export interface CloudSource {
  id: string;
  user_id: string;
  organization_id?: string;
  category: Modality;
  provider?: string;
  received_at?: string;
}

export interface CloudObservation {
  id?: string;
  category: Modality;
  name?: string;
  value?: string | number;
  unit?: string;
}

export interface UploadFileResponse {
  source: CloudSource;
  normalized_observations?: CloudObservation[];
  warnings?: string[];
}

export interface CloudDashboardCard {
  id: string;
  title: string;
  category: string;
  score?: number;
  status?: string;
  summary?: string;
  action?: string;
}

export interface CloudDashboardSpec {
  id: string;
  user_id: string;
  organization_id?: string;
  analysis_id: string;
  generated_at: string;
  cards: CloudDashboardCard[];
  provenance: {
    source_ids: string[];
    storage_mode: 'memory' | 'supabase';
    clinical_boundary: string;
  };
}

export interface CloudAnalysis {
  id: string;
  user_id: string;
  organization_id?: string;
  source_ids: string[];
  raw_source_references: CloudSource[];
  normalized_observations: CloudObservation[];
  dashboard_spec: CloudDashboardSpec;
  healthspan_score?: number;
  domain_scores?: Record<string, number>;
}

export interface CloudActionItem {
  id: string;
  name: string;
  detail?: string;
  rationale: string;
  priority: 'core' | 'optimize';
  targets: Array<{ marker: string; finding: string; direction: 'low' | 'high' | 'ok'; status?: string }>;
}

export interface CloudActionPlan {
  analysis_id: string;
  user_id: string;
  organization_id?: string;
  generated_at: string;
  status: 'ready' | 'processing' | 'setup_required' | 'failed';
  summary: string;
  interventions: CloudActionItem[];
  supplements: Array<CloudActionItem & { typical_dose?: string; timing?: string; dose_guidance: string; cautions: string[] }>;
  cautions: string[];
  disclaimer: string;
  provenance: { analysis_id: string; source_ids: string[]; engine: string };
}

export interface WearableConnectionResponse {
  provider: 'wearables';
  source_provider: 'whoop' | 'health_connect';
  connection_type: 'oauth' | 'mobile_bridge';
  authorization_url?: string;
  scopes?: string[];
  connection_event_id?: string;
}

type JsonObject = Record<string, unknown>;

function asProblem(value: unknown): CloudProblem {
  return value && typeof value === 'object' ? value as CloudProblem : {};
}

async function call<T>(config: CloudConfig, method: string, path: string, body?: unknown): Promise<T> {
  const timeoutMs = Number.isFinite(config.timeoutMs) ? Number(config.timeoutMs) : 15_000;
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CloudApiError(`Cloud ${method} ${path} failed before a response: ${message}`, 0, {
      code: 'network_error',
      detail: message,
      retryable: true,
    });
  }
  const text = await res.text();
  let json: unknown;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      const problem = { code: 'invalid_json_response', detail: text.slice(0, 300), retryable: res.status >= 500 };
      throw new CloudApiError(`Cloud ${method} ${path} -> ${res.status}: response was not valid JSON`, res.status, problem);
    }
  }
  if (!res.ok) {
    const problem = asProblem(json);
    const detail = problem.detail ?? problem.message ?? (text.slice(0, 300) || res.statusText);
    throw new CloudApiError(`Cloud ${method} ${path} -> ${res.status}: ${detail}`, res.status, problem);
  }
  if (json === undefined) {
    throw new CloudApiError(`Cloud ${method} ${path} -> ${res.status}: response body was empty`, res.status, {
      code: 'empty_response',
      retryable: res.status >= 500,
    });
  }
  return json as T;
}

export class HealthApiClient {
  constructor(private readonly config: CloudConfig = cloudConfig()) {}

  requireKey(): void {
    if (!this.config.apiKey) {
      throw new Error(`HEALTH_API_KEY is not set. Get one at ${this.config.baseUrl}/dashboard (sign in, create an API key).`);
    }
  }

  get dashboardUrl(): string {
    return `${this.config.baseUrl}/dashboard`;
  }

  // --- Public reference data (no key required) ---

  capabilities() {
    return call<{ service: string; generated_at: string; capabilities: JsonObject[] }>(this.config, 'GET', '/capabilities');
  }

  listDesignSystems() {
    return call<{ count: number; note: string; systems: JsonObject[] }>(this.config, 'GET', '/design/systems');
  }

  getDesignSystem(id: string) {
    return call<JsonObject>(this.config, 'GET', `/design/systems/${encodeURIComponent(id)}`);
  }

  // Provider discovery for data the user does not have yet. Pass any of
  // genetics/biomarkers/wearables; biomarkers needs a location for draw sites.
  findProviders(opts: { modalities?: Modality[]; type?: string; region?: string; postal_code?: string; city?: string; country?: string } = {}) {
    const q = new URLSearchParams();
    if (opts.modalities?.length) q.set('modality', opts.modalities.join(','));
    for (const k of ['type', 'region', 'postal_code', 'city', 'country'] as const) {
      if (opts[k]) q.set(k, String(opts[k]));
    }
    const suffix = q.toString() ? `?${q}` : '';
    return call<JsonObject>(this.config, 'GET', `/providers${suffix}`);
  }

  // --- Scoped data flow (key required) ---

  uploadFile(input: { user_id: string; organization_id?: string; category: Modality; filename: string; content_type: string; text: string }) {
    this.requireKey();
    return call<UploadFileResponse>(this.config, 'POST', '/imports/file', input);
  }

  createAnalysis(input: { user_id: string; organization_id?: string; source_ids: string[]; profile?: { age?: number; sex?: 'male' | 'female' } }) {
    this.requireKey();
    return call<CloudAnalysis>(this.config, 'POST', '/analyses', input);
  }

  getActionPlan(analysisId: string) {
    this.requireKey();
    return call<CloudActionPlan>(this.config, 'GET', `/analyses/${encodeURIComponent(analysisId)}/action-plan`);
  }

  getRecommendations(analysisId: string) {
    this.requireKey();
    return call<JsonObject>(this.config, 'GET', `/analyses/${encodeURIComponent(analysisId)}/recommendations`);
  }

  getDashboardSpec(analysisId: string) {
    this.requireKey();
    return call<CloudDashboardSpec>(this.config, 'GET', `/dashboard-specs/${encodeURIComponent(analysisId)}`);
  }

  getHealthContext(userId: string, input: { organization_id?: string; analysis_ids?: string[]; max_findings?: number } = {}) {
    this.requireKey();
    return call<JsonObject>(this.config, 'POST', `/users/${encodeURIComponent(userId)}/health-context`, input);
  }

  getTrends(userId: string, input: { organization_id?: string } = {}) {
    this.requireKey();
    return call<JsonObject>(this.config, 'POST', `/users/${encodeURIComponent(userId)}/trends`, input);
  }

  getRetestReminders(userId: string, organizationId?: string) {
    this.requireKey();
    const suffix = organizationId ? `?organization_id=${encodeURIComponent(organizationId)}` : '';
    return call<JsonObject>(this.config, 'GET', `/users/${encodeURIComponent(userId)}/retest-reminders${suffix}`);
  }

  runAncestry(input: { user_id: string; organization_id?: string; source_id: string; resolution?: 'continental' | 'regional' }) {
    this.requireKey();
    return call<JsonObject>(this.config, 'POST', '/genetics/ancestry', input);
  }

  // Wearable OAuth: cloud-only. Returns an authorization_url to send the user to
  // (WHOOP), or a mobile-bridge setup contract (Health Connect).
  startWearableConnection(input: { user_id: string; organization_id?: string; source_provider: 'whoop' | 'health_connect'; client_id?: string; redirect_uri?: string }) {
    this.requireKey();
    return call<WearableConnectionResponse>(this.config, 'POST', '/connections/wearables/start', input);
  }
}

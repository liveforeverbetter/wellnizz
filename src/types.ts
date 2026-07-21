export type SourceCategory = 'genetics' | 'biomarkers' | 'wearables' | 'behavioral';
export type GeneticsAnnotationDepth = 'compact' | 'full_dbsnp';
export type ProviderId = 'whoop' | 'oura' | 'health_connect' | 'wearables' | 'quest' | 'synlab';

export interface UserProfile {
  age?: number;
  sex?: 'male' | 'female';
}

export interface RawSourceReference {
  id: string;
  user_id: string;
  organization_id?: string;
  category: SourceCategory;
  filename?: string;
  content_type?: string;
  provider?: ProviderId | string;
  received_at: string;
  byte_length: number;
  storage_mode: 'memory' | 'durable';
  upload_status?: 'pending' | 'complete';
}

export interface NormalizedObservation {
  id: string;
  user_id: string;
  organization_id?: string;
  source_id: string;
  category: SourceCategory;
  type: string;
  name: string;
  value?: number;
  unit?: string;
  observed_at?: string;
  provider?: string;
  raw?: unknown;
}

export type DerivedSourceType = 'direct' | 'derived' | 'combined' | 'queued' | 'setup_required' | 'failed';

export interface DerivedInterpretation {
  id: string;
  user_id: string;
  organization_id?: string;
  analysis_id: string;
  category: SourceCategory | 'multimodal';
  type: string;
  title: string;
  status?: string;
  score?: number;
  summary?: string;
  action?: string;
  provenance: {
    source_ids: string[];
    source_categories: SourceCategory[];
    source_type: DerivedSourceType;
    engine: string;
    generated_at: string;
  };
  raw?: unknown;
}

export interface AnalysisResult {
  id: string;
  user_id: string;
  organization_id?: string;
  modality?: SourceCategory | 'multimodal';
  operation?: 'analyze' | 'derive';
  annotation_depth?: GeneticsAnnotationDepth;
  created_at: string;
  source_ids: string[];
  raw_source_references: RawSourceReference[];
  normalized_observations: NormalizedObservation[];
  derived_interpretations: DerivedInterpretation[];
  dashboard_spec: DashboardSpec;
  healthspan_score?: number;
  domain_scores?: Record<string, number>;
}

export type GeneticAnalysisJobStatus = 'queued' | 'running' | 'complete' | 'failed';
export type GeneticAnalysisJobStage =
  | 'queued'
  | 'preparing'
  | 'annotating_variants'
  | 'extracting_genotypes'
  | 'clinical_interpretation'
  | 'polygenic_scoring'
  | 'consumer_interpretation'
  | 'persisting_results'
  | 'retry_queued'
  | 'complete'
  | 'failed';
export type ConnectorSyncJobStatus = 'queued' | 'running' | 'complete' | 'failed';
export type WebhookEventType =
  | 'connection.started'
  | 'connection.completed'
  | 'source.imported'
  | 'analysis.completed'
  | 'analysis.failed'
  | 'wearables.sync.queued'
  | 'wearables.sync.completed'
  | 'wearables.data.updated'
  | 'genetics.job.queued'
  | 'export.ready'
  | 'data.deleted'
  | 'goal.created'
  | 'retest.due';

export type GoalStatus = 'active' | 'achieved' | 'archived';
export type GoalDirection = 'decrease' | 'increase' | 'maintain';

export interface Goal {
  id: string;
  user_id: string;
  organization_id?: string;
  title: string;
  metric?: string;
  target_value?: number;
  target_unit?: string;
  target_direction?: GoalDirection;
  due_date?: string;
  status: GoalStatus;
  note?: string;
  created_at: string;
  updated_at: string;
}

export interface RetestReminder {
  category: SourceCategory;
  metric?: string;
  last_observed_at?: string;
  cadence_days: number;
  next_due_at?: string;
  days_until_due?: number;
  status: 'due' | 'upcoming' | 'ok' | 'never_tested';
  reason: string;
}

export interface ExternalAccount {
  id: string;
  user_id: string;
  organization_id: string;
  provider: 'wearables' | string;
  external_user_id: string;
  status: 'active' | 'revoked' | 'errored';
  last_synced_at?: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// Encrypted-at-rest provider OAuth tokens. The *_encrypted fields hold the
// AES-256-GCM envelope produced by src/connectors/token-crypto.ts; plaintext
// tokens never touch the store layer.
export interface ProviderToken {
  id: string;
  external_account_id: string;
  user_id: string;
  organization_id: string;
  provider: string;
  provider_external_user_id: string;
  access_token_encrypted?: string;
  refresh_token_encrypted?: string;
  scope?: string;
  token_type?: string;
  expires_at?: string;
  created_at: string;
  updated_at: string;
}

export interface ConnectorSyncJob {
  id: string;
  user_id: string;
  organization_id: string;
  provider: 'wearables' | string;
  external_account_id?: string;
  scheduled_for: string;
  status: ConnectorSyncJobStatus;
  attempts: number;
  max_attempts: number;
  priority: number;
  worker_id?: string;
  locked_at?: string;
  started_at?: string;
  completed_at?: string;
  error?: string;
  result?: unknown;
  request: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface TombstoneResult {
  user_id: string;
  organization_id?: string;
  deleted_at: string;
  sources: number;
  observations: number;
  analyses: number;
  dashboard_specs: number;
  goals?: number;
  receipt_id?: string;
  request_id?: string;
  retention_note?: string;
  affected_source_ids?: string[];
  event_id?: string;
}

export interface DataExportResult {
  user_id: string;
  organization_id?: string;
  exported_at: string;
  receipt_id: string;
  request_id?: string;
  format: 'json';
  counts: {
    sources: number;
    observations: number;
    analyses: number;
    dashboard_specs: number;
    genetic_jobs: number;
    connector_sync_jobs: number;
    external_accounts: number;
    goals: number;
  };
  data: {
    sources: RawSourceReference[];
    observations: NormalizedObservation[];
    analyses: AnalysisResult[];
    genetic_jobs: GeneticAnalysisJob[];
    connector_sync_jobs: ConnectorSyncJob[];
    external_accounts: ExternalAccount[];
    goals: Goal[];
  };
  retention_note: string;
}

// A pending email sign-in challenge. The plaintext code is never stored; only a
// salted hash. Consumed single-use on successful verification.
export interface OtpChallenge {
  id: string;
  email: string;
  code_hash: string;
  expires_at: string;
  created_at: string;
}

export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  user_id?: string;
  organization_id?: string;
  subject_id?: string;
  request_id?: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface GeneticAnalysisJob {
  id: string;
  user_id: string;
  organization_id?: string;
  analysis_id: string;
  source_id: string;
  annotation_depth?: GeneticsAnnotationDepth;
  status: GeneticAnalysisJobStatus;
  stage?: GeneticAnalysisJobStage;
  progress_pct?: number;
  progress_message?: string;
  last_progress_at?: string;
  reanalysis_recommended?: boolean;
  reanalysis_reason?: string;
  attempts: number;
  max_attempts: number;
  priority: number;
  worker_id?: string;
  locked_at?: string;
  started_at?: string;
  completed_at?: string;
  error?: string;
  result?: unknown;
  created_at: string;
  updated_at: string;
}

export interface DashboardSpec {
  /** Additive presentation contract version; legacy cards remain available. */
  schema_version?: '1.0';
  id: string;
  user_id: string;
  organization_id?: string;
  analysis_id: string;
  generated_at: string;
  cards: Array<{
    id: string;
    title: string;
    category: string;
    score?: number;
    status?: string;
    summary?: string;
    action?: string;
    value?: number;
    unit?: string;
    target?: { min?: number; max?: number };
    visualization?: 'range' | 'score' | 'status';
    confidence?: 'high' | 'medium' | 'low';
    provenance?: DerivedInterpretation['provenance'];
  }>;
  coverage?: Array<{
    modality: SourceCategory;
    present: boolean;
    source_count: number;
    finding_count: number;
    latest_received_at?: string;
  }>;
  quality?: {
    status: 'complete' | 'partial' | 'empty';
    usable: boolean;
    warnings: string[];
    freshness: Array<{
      modality: SourceCategory;
      status: 'fresh' | 'stale' | 'missing' | 'unknown';
      threshold_days: number;
      latest_received_at?: string;
      age_days?: number;
    }>;
  };
  sections?: Array<{
    id: string;
    title: string;
    category: string;
    card_ids: string[];
  }>;
  provenance: {
    source_ids: string[];
    storage_mode: 'memory' | 'durable';
    clinical_boundary: string;
  };
}

export interface OAuthUrlRequest {
  client_id: string;
  redirect_uri: string;
  state?: string;
  scopes?: string[];
}

export interface WearablesConnectionStartRequest extends OAuthUrlRequest {
  user_id: string;
  organization_id?: string;
  source_provider: 'whoop' | 'oura' | 'health_connect';
}

export interface OAuthTokenRequest {
  code: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
}

export interface WearablesConnectionCallbackRequest extends OAuthTokenRequest {
  user_id: string;
  organization_id?: string;
  source_provider: 'whoop' | 'oura' | 'health_connect';
  external_user_id?: string;
  // First-party connections carry an opaque, signed state generated by the
  // start endpoint. It binds an agent-started browser redirect to the intended
  // Wellnizz user without asking them to copy credentials back to an agent.
  state?: string;
}

export interface ConnectorSyncRequest {
  access_token?: string;
  // Optional OAuth refresh credentials: when provided, an OAuth wearable sync
  // that hits a 401 refreshes the access token once and retries.
  refresh_token?: string;
  client_id?: string;
  client_secret?: string;
  user_id: string;
  organization_id?: string;
  provider_user_id?: string;
  external_user_id?: string;
  api_base_url?: string;
  types?: string[];
  start?: string;
  end?: string;
  limit?: number;
  async?: boolean;
  scheduled_for?: string;
  // Populated for webhook-triggered WHOOP syncs: the resource WHOOP flagged
  // as updated (sleep, workout, recovery) and its provider-side id. When present,
  // the worker resolves stored tokens by provider_external_user_id rather than
  // requiring inline credentials.
  source_provider?: 'whoop' | 'oura';
  webhook_resource_type?: string;
  webhook_resource_id?: string;
  webhook_trace_id?: string;
}

export interface LabSearchResult {
  provider: 'quest' | 'synlab';
  status: 'locator_handoff' | 'partner_api_result';
  query: Record<string, string | number | undefined>;
  locator_url: string;
  booking_url?: string;
  notes: string[];
  locations: Array<{
    id: string;
    name: string;
    address?: string;
    distance_miles?: number;
    latitude?: number;
    longitude?: number;
    phone?: string;
    booking_url?: string;
    source_url?: string;
  }>;
}

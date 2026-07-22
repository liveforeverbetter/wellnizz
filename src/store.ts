import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { AnalysisResult, ConnectorSyncJob, DataExportResult, ExternalAccount, GeneticAnalysisJob, GeneticAnalysisJobStage, GeneticsAnnotationDepth, Goal, NormalizedObservation, OtpChallenge, ProviderToken, RawSourceReference, TombstoneResult, WebhookEvent } from './types.js';

export interface IdempotencyRecord {
  key: string;
  method: string;
  route: string;
  subject: string;
  status: number;
  body: unknown;
  created_at: string;
}

export interface HealthStore {
  withTransaction<T>(work: () => Promise<T>, isolationKey?: string): Promise<T>;
  saveSource(source: RawSourceReference, observations: NormalizedObservation[], payload?: Buffer, existingPayloadObjectKey?: string): Promise<void>;
  getSource(id: string): Promise<RawSourceReference | undefined>;
  getSourcePayload(id: string): Promise<Buffer | undefined>;
  writeSourcePayloadToFile(id: string, destination: string): Promise<boolean>;
  getSources(ids: string[]): Promise<RawSourceReference[]>;
  getSourcesForUser(ids: string[], userId: string): Promise<RawSourceReference[]>;
  getSourcesForUserAndOrganization(ids: string[], userId: string, organizationId?: string): Promise<RawSourceReference[]>;
  listSourcesForUser(userId: string, organizationIds?: Set<string>): Promise<RawSourceReference[]>;
  getObservations(sourceIds: string[]): Promise<NormalizedObservation[]>;
  getUserObservations(userId: string, organizationIds?: Set<string>): Promise<NormalizedObservation[]>;
  saveAnalysis(result: AnalysisResult): Promise<void>;
  getAnalysis(id: string): Promise<AnalysisResult | undefined>;
  // Full, uncompacted analysis artifact stored in durable object storage.
  // The write happens on the WGS worker; read paths must stream it to a file
  // (writeAnalysisArtifactToFile) rather than buffering it in the API process.
  saveAnalysisArtifact(analysisId: string, body: Buffer, contentType?: string): Promise<{ object_key: string; bytes: number; storage: string }>;
  writeAnalysisArtifactToFile(analysisId: string, destination: string): Promise<boolean>;
  getAnalysisArtifactSize(analysisId: string): Promise<number | undefined>;
  getAnalysesForUser(ids: string[], userId: string, organizationIds?: Set<string>): Promise<AnalysisResult[]>;
  getIdempotencyRecord(key: string, method: string, route: string, subject: string): Promise<IdempotencyRecord | undefined>;
  saveIdempotencyRecord(record: IdempotencyRecord): Promise<void>;
  createGeneticAnalysisJob(job: GeneticAnalysisJob): Promise<void>;
  getGeneticAnalysisJob(id: string): Promise<GeneticAnalysisJob | undefined>;
  claimNextGeneticAnalysisJob(workerId: string): Promise<GeneticAnalysisJob | undefined>;
  updateGeneticAnalysisJobProgress(id: string, progress: { stage: GeneticAnalysisJobStage; progress_pct: number; progress_message?: string }): Promise<void>;
  completeGeneticAnalysisJob(id: string, result: unknown): Promise<void>;
  failGeneticAnalysisJob(id: string, error: string, options?: { retryable?: boolean }): Promise<void>;
  /** Reset a specific running job back to queued without counting the interrupted run as a failed attempt. */
  requeueGeneticAnalysisJob(id: string): Promise<void>;
  /** Reset all running jobs whose lock is older than staleMinutes (default 30) back to queued. Returns the number reset. */
  resetStaleGeneticAnalysisJobs(staleMinutes?: number): Promise<number>;
  // Durable checkpoint of a COMPLETED genetics pipeline result. The WGS worker
  // writes it the moment the multi-hour annotation finishes, before the fragile
  // analysis/job DB writes. If those writes fail, the next attempt resumes from
  // this checkpoint and retries only the fast save instead of re-running the
  // annotation. Keyed by source + annotation depth so a different-depth
  // re-analysis recomputes. Stored in durable object storage, not the DB, so a
  // DB-side failure cannot also lose the checkpoint.
  saveGeneticAnalysisCheckpoint(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined, result: unknown): Promise<void>;
  getGeneticAnalysisCheckpoint(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined): Promise<unknown | undefined>;
  clearGeneticAnalysisCheckpoint(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined): Promise<void>;
  // Durable cache of the dbSNP-annotated VCF (the multi-hour bcftools output),
  // keyed by source + annotation depth. Saved from the worker's temp file even
  // when a later pipeline step fails, so a retry or re-analysis reuses the
  // annotation and skips bcftools entirely. Stored as a file stream, never
  // buffered in the API process.
  saveGeneticAnnotationArtifact(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined, filePath: string): Promise<void>;
  getGeneticAnnotationArtifactToFile(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined, destination: string): Promise<boolean>;
  clearGeneticAnnotationArtifact(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined): Promise<void>;
  upsertExternalAccount(account: ExternalAccount): Promise<ExternalAccount>;
  listExternalAccountsForUser(userId: string, organizationIds?: Set<string>): Promise<ExternalAccount[]>;
  saveProviderToken(token: ProviderToken): Promise<ProviderToken>;
  getProviderTokenByExternalUser(provider: string, providerExternalUserId: string): Promise<ProviderToken | undefined>;
  getConnectorSyncJob(id: string): Promise<ConnectorSyncJob | undefined>;
  createConnectorSyncJob(job: ConnectorSyncJob): Promise<void>;
  claimNextConnectorSyncJob(workerId: string): Promise<ConnectorSyncJob | undefined>;
  completeConnectorSyncJob(id: string, result: unknown): Promise<void>;
  failConnectorSyncJob(id: string, error: string): Promise<void>;
  createWebhookEvent(event: WebhookEvent): Promise<void>;
  listWebhookEvents(input: { userId?: string; organizationId?: string; limit?: number; type?: string }): Promise<WebhookEvent[]>;
  createOtpChallenge(challenge: OtpChallenge): Promise<void>;
  consumeOtpChallenge(email: string, codeHash: string): Promise<boolean>;
  createGoal(goal: Goal): Promise<Goal>;
  getGoal(id: string): Promise<Goal | undefined>;
  listGoals(userId: string, organizationIds?: Set<string>): Promise<Goal[]>;
  updateGoal(id: string, patch: Partial<Pick<Goal, 'title' | 'metric' | 'target_value' | 'target_unit' | 'target_direction' | 'due_date' | 'status' | 'note'>>): Promise<Goal | undefined>;
  deleteGoal(id: string): Promise<boolean>;
  exportUserData(userId: string, organizationId?: string, requestId?: string): Promise<DataExportResult>;
  tombstoneUserData(userId: string, organizationId?: string): Promise<TombstoneResult>;
  readiness(): Promise<{ ok: boolean; durable: boolean; checks: Record<string, boolean | string> }>;
}

export class HealthApiStore implements HealthStore {
  private sources = new Map<string, RawSourceReference>();
  private observations = new Map<string, NormalizedObservation[]>();
  private analyses = new Map<string, AnalysisResult>();
  private analysisArtifacts = new Map<string, Buffer>();
  private sourcePayloads = new Map<string, Buffer>();
  private idempotency = new Map<string, IdempotencyRecord>();
  private geneticJobs = new Map<string, GeneticAnalysisJob>();
  private geneticCheckpoints = new Map<string, unknown>();
  private geneticAnnotationArtifacts = new Map<string, Buffer>();
  private externalAccounts = new Map<string, ExternalAccount>();
  private providerTokens = new Map<string, ProviderToken>();
  private connectorSyncJobs = new Map<string, ConnectorSyncJob>();
  private webhookEvents = new Map<string, WebhookEvent>();
  private goals = new Map<string, Goal>();
  private otpChallenges = new Map<string, OtpChallenge>();
  private transactionTail: Promise<void> = Promise.resolve();

  async withTransaction<T>(work: () => Promise<T>, _isolationKey?: string): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const snapshot = {
      sources: new Map(this.sources),
      observations: new Map(Array.from(this.observations, ([key, value]) => [key, [...value]])),
      analyses: new Map(this.analyses),
      analysisArtifacts: new Map(Array.from(this.analysisArtifacts, ([key, value]) => [key, Buffer.from(value)])),
      sourcePayloads: new Map(Array.from(this.sourcePayloads, ([key, value]) => [key, Buffer.from(value)])),
      idempotency: new Map(this.idempotency),
      geneticJobs: new Map(this.geneticJobs),
      geneticCheckpoints: new Map(this.geneticCheckpoints),
      geneticAnnotationArtifacts: new Map(Array.from(this.geneticAnnotationArtifacts, ([key, value]) => [key, Buffer.from(value)])),
      externalAccounts: new Map(this.externalAccounts),
      providerTokens: new Map(this.providerTokens),
      connectorSyncJobs: new Map(this.connectorSyncJobs),
      webhookEvents: new Map(this.webhookEvents),
      goals: new Map(this.goals),
      otpChallenges: new Map(this.otpChallenges),
    };
    try {
      return await work();
    } catch (error) {
      this.sources = snapshot.sources;
      this.observations = snapshot.observations;
      this.analyses = snapshot.analyses;
      this.analysisArtifacts = snapshot.analysisArtifacts;
      this.sourcePayloads = snapshot.sourcePayloads;
      this.idempotency = snapshot.idempotency;
      this.geneticJobs = snapshot.geneticJobs;
      this.geneticCheckpoints = snapshot.geneticCheckpoints;
      this.geneticAnnotationArtifacts = snapshot.geneticAnnotationArtifacts;
      this.externalAccounts = snapshot.externalAccounts;
      this.providerTokens = snapshot.providerTokens;
      this.connectorSyncJobs = snapshot.connectorSyncJobs;
      this.webhookEvents = snapshot.webhookEvents;
      this.goals = snapshot.goals;
      this.otpChallenges = snapshot.otpChallenges;
      throw error;
    } finally {
      release();
    }
  }

  async saveSource(source: RawSourceReference, observations: NormalizedObservation[], payload?: Buffer, _existingPayloadObjectKey?: string): Promise<void> {
    this.sources.set(source.id, source);
    this.observations.set(source.id, observations);
    if (payload) this.sourcePayloads.set(source.id, payload);
  }

  async getSource(id: string): Promise<RawSourceReference | undefined> {
    return this.sources.get(id);
  }

  async getSourcePayload(id: string): Promise<Buffer | undefined> {
    return this.sourcePayloads.get(id);
  }

  async writeSourcePayloadToFile(id: string, destination: string): Promise<boolean> {
    const payload = this.sourcePayloads.get(id);
    if (!payload) return false;
    await writeFile(destination, payload);
    return true;
  }

  async getSources(ids: string[]): Promise<RawSourceReference[]> {
    return ids.map(id => this.sources.get(id)).filter((source): source is RawSourceReference => Boolean(source));
  }

  async getSourcesForUser(ids: string[], userId: string): Promise<RawSourceReference[]> {
    return (await this.getSources(ids)).filter(source => source.user_id === userId);
  }

  async getSourcesForUserAndOrganization(ids: string[], userId: string, organizationId?: string): Promise<RawSourceReference[]> {
    return (await this.getSourcesForUser(ids, userId)).filter(source => organizationId == null || source.organization_id === organizationId);
  }

  async listSourcesForUser(userId: string, organizationIds?: Set<string>): Promise<RawSourceReference[]> {
    return Array.from(this.sources.values()).filter(source => (
      source.user_id === userId && isAllowedOrganization(source.organization_id, organizationIds)
    ));
  }

  async getObservations(sourceIds: string[]): Promise<NormalizedObservation[]> {
    return sourceIds.flatMap(id => this.observations.get(id) ?? []);
  }

  async getUserObservations(userId: string, organizationIds?: Set<string>): Promise<NormalizedObservation[]> {
    return Array.from(this.observations.values()).flat().filter(obs => (
      obs.user_id === userId && isAllowedOrganization(obs.organization_id, organizationIds)
    ));
  }

  async saveAnalysis(result: AnalysisResult): Promise<void> {
    this.analyses.set(result.id, result);
  }

  async getAnalysis(id: string): Promise<AnalysisResult | undefined> {
    return this.analyses.get(id);
  }

  async saveAnalysisArtifact(analysisId: string, body: Buffer): Promise<{ object_key: string; bytes: number; storage: string }> {
    const object_key = `analyses/${analysisId}/full-analysis.json`;
    this.analysisArtifacts.set(object_key, Buffer.from(body));
    return { object_key, bytes: body.byteLength, storage: 'memory' };
  }

  async writeAnalysisArtifactToFile(analysisId: string, destination: string): Promise<boolean> {
    const body = this.analysisArtifacts.get(`analyses/${analysisId}/full-analysis.json`);
    if (!body) return false;
    await writeFile(destination, body);
    return true;
  }

  async getAnalysisArtifactSize(analysisId: string): Promise<number | undefined> {
    return this.analysisArtifacts.get(`analyses/${analysisId}/full-analysis.json`)?.byteLength;
  }

  async getAnalysesForUser(ids: string[], userId: string, organizationIds?: Set<string>): Promise<AnalysisResult[]> {
    const candidates = ids.length === 0
      ? Array.from(this.analyses.values())
      : ids.map(id => this.analyses.get(id));
    return candidates
      .filter((analysis): analysis is AnalysisResult => Boolean(
        analysis && analysis.user_id === userId && isAllowedOrganization(analysis.organization_id, organizationIds),
      ));
  }

  async getIdempotencyRecord(key: string, method: string, route: string, subject: string): Promise<IdempotencyRecord | undefined> {
    return this.idempotency.get(idempotencyMapKey(key, method, route, subject));
  }

  async saveIdempotencyRecord(record: IdempotencyRecord): Promise<void> {
    this.idempotency.set(idempotencyMapKey(record.key, record.method, record.route, record.subject), record);
  }

  async createGeneticAnalysisJob(job: GeneticAnalysisJob): Promise<void> {
    this.geneticJobs.set(job.id, job);
  }

  async getGeneticAnalysisJob(id: string): Promise<GeneticAnalysisJob | undefined> {
    return this.geneticJobs.get(id);
  }

  async claimNextGeneticAnalysisJob(workerId: string): Promise<GeneticAnalysisJob | undefined> {
    const job = Array.from(this.geneticJobs.values())
      .filter(item => item.status === 'queued' || (item.status === 'failed' && item.attempts < item.max_attempts))
      .sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at))[0];
    if (!job) return undefined;
    const now = new Date().toISOString();
    const claimed: GeneticAnalysisJob = {
      ...job,
      status: 'running',
      stage: 'preparing',
      progress_pct: 5,
      progress_message: 'Preparing the uploaded genome for analysis.',
      last_progress_at: now,
      attempts: job.attempts + 1,
      worker_id: workerId,
      locked_at: now,
      error: undefined,
      started_at: job.started_at ?? now,
      updated_at: now,
    };
    this.geneticJobs.set(claimed.id, claimed);
    return claimed;
  }

  async updateGeneticAnalysisJobProgress(
    id: string,
    progress: { stage: GeneticAnalysisJobStage; progress_pct: number; progress_message?: string },
  ): Promise<void> {
    const job = this.geneticJobs.get(id);
    if (!job) return;
    const now = new Date().toISOString();
    this.geneticJobs.set(id, {
      ...job,
      ...progress,
      progress_pct: Math.max(job.progress_pct ?? 0, Math.max(0, Math.min(100, Math.round(progress.progress_pct)))),
      last_progress_at: now,
      updated_at: now,
    });
  }

  async completeGeneticAnalysisJob(id: string, result: unknown): Promise<void> {
    const job = this.geneticJobs.get(id);
    if (!job) return;
    const now = new Date().toISOString();
    const reanalysisRecommended = resultRequestsGeneticReanalysis(result);
    this.geneticJobs.set(id, {
      ...job,
      status: 'complete',
      stage: 'complete',
      progress_pct: 100,
      progress_message: 'Analysis complete. Interpreted results are ready.',
      last_progress_at: now,
      completed_at: now,
      updated_at: now,
      result,
      error: undefined,
      reanalysis_recommended: reanalysisRecommended,
      reanalysis_reason: reanalysisRecommended
        ? 'A raw or incomplete genetic score can be upgraded when a compatible calibration or score-registry release becomes available.'
        : undefined,
    });
  }

  async failGeneticAnalysisJob(id: string, error: string, options?: { retryable?: boolean }): Promise<void> {
    const job = this.geneticJobs.get(id);
    if (!job) return;
    const retryable = options?.retryable ?? (job.attempts < job.max_attempts);
    this.geneticJobs.set(id, {
      ...job,
      status: retryable ? 'queued' : 'failed',
      stage: retryable ? 'retry_queued' : 'failed',
      progress_message: retryable
        ? 'This attempt failed and has been queued for retry.'
        : 'Analysis attempts are exhausted. The source can be reanalyzed after the reported issue is corrected.',
      last_progress_at: new Date().toISOString(),
      reanalysis_recommended: !retryable,
      reanalysis_reason: !retryable ? error : undefined,
      locked_at: undefined,
      worker_id: undefined,
      updated_at: new Date().toISOString(),
      error,
    });
  }

  async requeueGeneticAnalysisJob(id: string): Promise<void> {
    const job = this.geneticJobs.get(id);
    if (!job) return;
    this.geneticJobs.set(id, {
      ...job,
      status: 'queued',
      stage: 'queued',
      progress_pct: 0,
      progress_message: 'Waiting for the dedicated WGS worker.',
      attempts: Math.max(0, job.attempts - 1),
      locked_at: undefined,
      worker_id: undefined,
      updated_at: new Date().toISOString(),
    });
  }

  async resetStaleGeneticAnalysisJobs(staleMinutes = 30): Promise<number> {
    const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();
    let count = 0;
    for (const job of this.geneticJobs.values()) {
      if (job.status === 'running' && job.locked_at && job.locked_at < cutoff) {
        await this.requeueGeneticAnalysisJob(job.id);
        count++;
      }
    }
    return count;
  }

  async saveGeneticAnalysisCheckpoint(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined, result: unknown): Promise<void> {
    this.geneticCheckpoints.set(geneticCheckpointObjectKey(sourceId, annotationDepth), result);
  }

  async getGeneticAnalysisCheckpoint(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined): Promise<unknown | undefined> {
    return this.geneticCheckpoints.get(geneticCheckpointObjectKey(sourceId, annotationDepth));
  }

  async clearGeneticAnalysisCheckpoint(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined): Promise<void> {
    this.geneticCheckpoints.delete(geneticCheckpointObjectKey(sourceId, annotationDepth));
  }

  async saveGeneticAnnotationArtifact(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined, filePath: string): Promise<void> {
    this.geneticAnnotationArtifacts.set(geneticAnnotationObjectKey(sourceId, annotationDepth), await readFile(filePath));
  }

  async getGeneticAnnotationArtifactToFile(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined, destination: string): Promise<boolean> {
    const body = this.geneticAnnotationArtifacts.get(geneticAnnotationObjectKey(sourceId, annotationDepth));
    if (!body) return false;
    await writeFile(destination, body);
    return true;
  }

  async clearGeneticAnnotationArtifact(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined): Promise<void> {
    this.geneticAnnotationArtifacts.delete(geneticAnnotationObjectKey(sourceId, annotationDepth));
  }

  async upsertExternalAccount(account: ExternalAccount): Promise<ExternalAccount> {
    const existing = Array.from(this.externalAccounts.values()).find(item => (
      item.user_id === account.user_id
      && item.organization_id === account.organization_id
      && item.provider === account.provider
      && item.external_user_id === account.external_user_id
    ));
    const saved = existing ? {
      ...existing,
      status: account.status,
      last_synced_at: account.last_synced_at ?? existing.last_synced_at,
      metadata: { ...existing.metadata, ...account.metadata },
      updated_at: new Date().toISOString(),
    } : account;
    this.externalAccounts.set(saved.id, saved);
    return saved;
  }

  async listExternalAccountsForUser(userId: string, organizationIds?: Set<string>): Promise<ExternalAccount[]> {
    return Array.from(this.externalAccounts.values()).filter(account => (
      account.user_id === userId && isAllowedOrganization(account.organization_id, organizationIds)
    ));
  }

  async saveProviderToken(token: ProviderToken): Promise<ProviderToken> {
    const existing = Array.from(this.providerTokens.values()).find(item => (
      item.provider === token.provider && item.provider_external_user_id === token.provider_external_user_id
    ));
    const saved: ProviderToken = existing
      ? { ...existing, ...token, id: existing.id, created_at: existing.created_at, updated_at: new Date().toISOString() }
      : token;
    this.providerTokens.set(saved.id, saved);
    return saved;
  }

  async getProviderTokenByExternalUser(provider: string, providerExternalUserId: string): Promise<ProviderToken | undefined> {
    return Array.from(this.providerTokens.values()).find(item => (
      item.provider === provider && item.provider_external_user_id === providerExternalUserId
    ));
  }

  async createConnectorSyncJob(job: ConnectorSyncJob): Promise<void> {
    this.connectorSyncJobs.set(job.id, job);
  }

  async getConnectorSyncJob(id: string): Promise<ConnectorSyncJob | undefined> {
    return this.connectorSyncJobs.get(id);
  }

  async claimNextConnectorSyncJob(workerId: string): Promise<ConnectorSyncJob | undefined> {
    const now = new Date();
    const job = Array.from(this.connectorSyncJobs.values())
      .filter(item => item.status === 'queued' && item.attempts < item.max_attempts && new Date(item.scheduled_for) <= now)
      .sort((a, b) => b.priority - a.priority || a.scheduled_for.localeCompare(b.scheduled_for) || a.created_at.localeCompare(b.created_at))[0];
    if (!job) return undefined;
    const timestamp = now.toISOString();
    const claimed: ConnectorSyncJob = {
      ...job,
      status: 'running',
      attempts: job.attempts + 1,
      worker_id: workerId,
      locked_at: timestamp,
      started_at: job.started_at ?? timestamp,
      updated_at: timestamp,
    };
    this.connectorSyncJobs.set(claimed.id, claimed);
    return claimed;
  }

  async completeConnectorSyncJob(id: string, result: unknown): Promise<void> {
    const job = this.connectorSyncJobs.get(id);
    if (!job) return;
    const now = new Date().toISOString();
    this.connectorSyncJobs.set(id, {
      ...job,
      status: 'complete',
      completed_at: now,
      updated_at: now,
      locked_at: undefined,
      result,
      error: undefined,
    });
    if (job.external_account_id) {
      const account = this.externalAccounts.get(job.external_account_id);
      if (account) this.externalAccounts.set(account.id, { ...account, last_synced_at: now, updated_at: now });
    }
  }

  async failConnectorSyncJob(id: string, error: string): Promise<void> {
    const job = this.connectorSyncJobs.get(id);
    if (!job) return;
    const retryable = job.attempts < job.max_attempts;
    this.connectorSyncJobs.set(id, {
      ...job,
      status: retryable ? 'queued' : 'failed',
      locked_at: undefined,
      worker_id: undefined,
      updated_at: new Date().toISOString(),
      error,
    });
  }

  async createWebhookEvent(event: WebhookEvent): Promise<void> {
    this.webhookEvents.set(event.id, event);
  }

  async listWebhookEvents(input: { userId?: string; organizationId?: string; limit?: number; type?: string }): Promise<WebhookEvent[]> {
    return Array.from(this.webhookEvents.values())
      .filter(event => input.userId == null || event.user_id === input.userId)
      .filter(event => input.organizationId == null || event.organization_id === input.organizationId)
      .filter(event => input.type == null || event.type === input.type)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, Math.min(Math.max(input.limit ?? 50, 1), 200));
  }

  async createOtpChallenge(challenge: OtpChallenge): Promise<void> {
    this.otpChallenges.set(challenge.id, challenge);
  }

  async consumeOtpChallenge(email: string, codeHash: string): Promise<boolean> {
    const now = Date.now();
    const matched = Array.from(this.otpChallenges.values()).some(challenge => (
      challenge.email === email && challenge.code_hash === codeHash && new Date(challenge.expires_at).getTime() > now
    ));
    if (matched) {
      for (const [id, challenge] of this.otpChallenges) {
        if (challenge.email === email) this.otpChallenges.delete(id);
      }
    }
    return matched;
  }

  async createGoal(goal: Goal): Promise<Goal> {
    this.goals.set(goal.id, goal);
    return goal;
  }

  async getGoal(id: string): Promise<Goal | undefined> {
    return this.goals.get(id);
  }

  async listGoals(userId: string, organizationIds?: Set<string>): Promise<Goal[]> {
    return Array.from(this.goals.values())
      .filter(goal => goal.user_id === userId && isAllowedOrganization(goal.organization_id, organizationIds))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async updateGoal(id: string, patch: Partial<Goal>): Promise<Goal | undefined> {
    const existing = this.goals.get(id);
    if (!existing) return undefined;
    const updated: Goal = { ...existing, ...patch, id: existing.id, user_id: existing.user_id, updated_at: new Date().toISOString() };
    this.goals.set(id, updated);
    return updated;
  }

  async deleteGoal(id: string): Promise<boolean> {
    return this.goals.delete(id);
  }

  async exportUserData(userId: string, organizationId?: string, requestId?: string): Promise<DataExportResult> {
    const sourceIds = Array.from(this.sources.values())
      .filter(source => source.user_id === userId && (organizationId == null || source.organization_id === organizationId))
      .map(source => source.id);
    const observations = await this.getUserObservations(userId, organizationId ? new Set([organizationId]) : undefined);
    const analyses = Array.from(this.analyses.values())
      .filter(analysis => analysis.user_id === userId && (organizationId == null || analysis.organization_id === organizationId));
    const geneticJobs = Array.from(this.geneticJobs.values())
      .filter(job => job.user_id === userId && (organizationId == null || job.organization_id === organizationId));
    const connectorSyncJobs = Array.from(this.connectorSyncJobs.values())
      .filter(job => job.user_id === userId && (organizationId == null || job.organization_id === organizationId));
    const externalAccounts = Array.from(this.externalAccounts.values())
      .filter(account => account.user_id === userId && (organizationId == null || account.organization_id === organizationId));
    const goals = Array.from(this.goals.values())
      .filter(goal => goal.user_id === userId && (organizationId == null || goal.organization_id === organizationId));
    return {
      user_id: userId,
      organization_id: organizationId,
      exported_at: new Date().toISOString(),
      receipt_id: createId('export_receipt'),
      request_id: requestId,
      format: 'json',
      counts: {
        sources: sourceIds.length,
        observations: observations.length,
        analyses: analyses.length,
        dashboard_specs: analyses.length,
        genetic_jobs: geneticJobs.length,
        connector_sync_jobs: connectorSyncJobs.length,
        external_accounts: externalAccounts.length,
        goals: goals.length,
      },
      data: {
        sources: await this.getSources(sourceIds),
        observations,
        analyses,
        genetic_jobs: geneticJobs,
        connector_sync_jobs: connectorSyncJobs,
        external_accounts: externalAccounts,
        goals,
      },
      retention_note: 'Export includes currently retained tenant-scoped data visible to this API store. Raw encrypted payload binaries are referenced by source metadata rather than embedded.',
    };
  }

  async tombstoneUserData(userId: string, organizationId?: string): Promise<TombstoneResult> {
    const deletedAt = new Date().toISOString();
    const sourceIds = Array.from(this.sources.values())
      .filter(source => source.user_id === userId && (organizationId == null || source.organization_id === organizationId))
      .map(source => source.id);
    let observations = 0;
    for (const sourceId of sourceIds) {
      observations += this.observations.get(sourceId)?.length ?? 0;
      this.observations.delete(sourceId);
      this.sourcePayloads.delete(sourceId);
      this.sources.delete(sourceId);
      for (const depth of ['compact', 'full_dbsnp'] as const) {
        this.geneticCheckpoints.delete(geneticCheckpointObjectKey(sourceId, depth));
        this.geneticAnnotationArtifacts.delete(geneticAnnotationObjectKey(sourceId, depth));
      }
    }
    let analyses = 0;
    for (const [id, analysis] of this.analyses) {
      if (analysis.user_id === userId && (organizationId == null || analysis.organization_id === organizationId)) {
        this.analyses.delete(id);
        this.analysisArtifacts.delete(`analyses/${id}/full-analysis.json`);
        analyses += 1;
      }
    }
    let goals = 0;
    for (const [id, goal] of this.goals) {
      if (goal.user_id === userId && (organizationId == null || goal.organization_id === organizationId)) {
        this.goals.delete(id);
        goals += 1;
      }
    }
    return {
      user_id: userId,
      organization_id: organizationId,
      deleted_at: deletedAt,
      sources: sourceIds.length,
      observations,
      analyses,
      dashboard_specs: analyses,
      goals,
      receipt_id: createId('delete_receipt'),
      retention_note: 'Tenant-scoped data was tombstoned or removed from the active API store. Downstream object lifecycle cleanup may run asynchronously.',
      affected_source_ids: sourceIds,
    };
  }

  async readiness(): Promise<{ ok: boolean; durable: boolean; checks: Record<string, boolean | string> }> {
    return {
      ok: true,
      durable: false,
      checks: {
        store: 'memory',
        durable: false,
        migrations: 'not_applicable',
      },
    };
  }
}

function resultRequestsGeneticReanalysis(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const raw = (result as Record<string, unknown>).raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const consumer = (raw as Record<string, unknown>).consumer_genetics;
  return Boolean(consumer && typeof consumer === 'object' && !Array.isArray(consumer)
    && (consumer as Record<string, unknown>).reanalysis_recommended === true);
}

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

// Object-storage key (and in-memory map key) for a genetics pipeline checkpoint.
// Namespaced by source and annotation depth so re-analysis at a different depth
// does not collide with a stored checkpoint from a prior depth.
export function geneticCheckpointObjectKey(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined): string {
  return `genetic-checkpoints/${sourceId}/${annotationDepth ?? 'compact'}.json`;
}

// Object-storage key for the cached dbSNP-annotated VCF, keyed by source and
// annotation depth (compact and full_dbsnp produce different annotations).
export function geneticAnnotationObjectKey(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined): string {
  return `genetic-annotations/${sourceId}/${annotationDepth ?? 'compact'}.annotated.vcf.gz`;
}

function isAllowedOrganization(resourceOrganizationId: string | undefined, organizationIds?: Set<string>): boolean {
  if (!organizationIds || organizationIds.size === 0) return true;
  return resourceOrganizationId != null && organizationIds.has(resourceOrganizationId);
}

function idempotencyMapKey(key: string, method: string, route: string, subject: string): string {
  return `${subject}:${method}:${route}:${key}`;
}

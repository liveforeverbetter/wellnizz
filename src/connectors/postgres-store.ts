import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';
import { getPool } from '../db/pool.js';
import { createId, geneticCheckpointObjectKey, geneticAnnotationObjectKey } from '../store.js';
import { configuredPayloadStore, payloadKey, S3PayloadStore, type PayloadStore, type SignedPayloadUpload } from './payload-store.js';
import type { AnalysisListQuery, HealthStore, IdempotencyRecord } from '../store.js';
import type {
  AnalysisResult, ConnectorSyncJob, DataExportResult, ExternalAccount, GeneticAnalysisJob,
  GeneticsAnnotationDepth, Goal, NormalizedObservation, ProviderToken, RawSourceReference, TombstoneResult, WebhookEvent,
} from '../types.js';

const SCHEMA = 'health_api';

// Plain-Postgres implementation of HealthStore. Tenant isolation is enforced in
// each query (user_id / organization_id predicates) rather than by RLS, since
// this connects as an application role. Payload binaries live in a separate
// object store (filesystem or S3), keyed by payload_object_key on the source row.
export class PostgresHealthStore implements HealthStore {
  private readonly pool: pg.Pool;
  private readonly payloads: PayloadStore;
  private readonly transaction = new AsyncLocalStorage<{ client: pg.PoolClient; rollback: Array<() => Promise<void>> }>();

  constructor(pool: pg.Pool = getPool(), payloads: PayloadStore = configuredPayloadStore()) {
    this.pool = pool;
    this.payloads = payloads;
  }

  async withTransaction<T>(work: () => Promise<T>, isolationKey?: string): Promise<T> {
    if (this.transaction.getStore()) return work();
    const client = await this.pool.connect();
    // A checked-out client can emit an async 'error' if the connection drops
    // mid-transaction (e.g. a DB failover or a slow/large write). Without a
    // listener, Node rethrows it as an uncaught exception and crashes the worker.
    // Log it instead; the in-flight query/commit rejects and the caller's
    // transient-retry wrapper handles the retry.
    const onClientError = (error: unknown) => {
      console.warn(JSON.stringify({ ts: new Date().toISOString(), event: 'pg_client_error', message: error instanceof Error ? error.message : String(error) }));
    };
    client.on('error', onClientError);
    const context = { client, rollback: [] as Array<() => Promise<void>> };
    try {
      await client.query('begin');
      if (isolationKey) await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [isolationKey]);
      const result = await this.transaction.run(context, work);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      for (const cleanup of context.rollback.reverse()) await cleanup().catch(() => undefined);
      throw error;
    } finally {
      client.removeListener('error', onClientError);
      client.release();
    }
  }

  async saveSource(source: RawSourceReference, observations: NormalizedObservation[], payload?: Buffer, existingPayloadObjectKey?: string): Promise<void> {
    const organizationId = requireOrganizationId(source.organization_id, source.id);
    source.storage_mode = 'durable';
    const payloadObjectKey = existingPayloadObjectKey ?? (payload ? payloadKey(source, organizationId) : undefined);
    await this.withTransaction(async () => {
      if (payload && payloadObjectKey && !existingPayloadObjectKey) {
        const existingSource = await this.rows(`select payload_object_key from ${SCHEMA}.sources where id=$1`, [source.id]);
        await this.payloads.upload(payloadObjectKey, payload, source.content_type ?? 'application/octet-stream');
        if (existingSource.length === 0) this.transaction.getStore()?.rollback.push(() => this.payloads.remove(payloadObjectKey));
      }
      await this.query(
        `insert into ${SCHEMA}.sources (id, user_id, organization_id, category, provider, filename, content_type, byte_length, provenance, payload_object_key, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10, now())
         on conflict (id) do update set
           category=excluded.category, provider=excluded.provider, filename=excluded.filename,
           content_type=excluded.content_type, byte_length=excluded.byte_length, provenance=excluded.provenance,
           payload_object_key=coalesce(excluded.payload_object_key, ${SCHEMA}.sources.payload_object_key), updated_at=now()`,
        [
          source.id, source.user_id, organizationId, source.category, source.provider ?? null,
          source.filename ?? null, source.content_type ?? null, source.byte_length,
          toJson({ received_at: source.received_at, storage_mode: 'durable', upload_status: source.upload_status ?? 'complete' }),
          payloadObjectKey ?? null,
        ],
      );
      await this.query(`delete from ${SCHEMA}.observations where source_id=$1`, [source.id]);
      for (const observation of observations) {
        await this.query(
          `insert into ${SCHEMA}.observations (id, source_id, user_id, organization_id, type, marker, value, unit, observed_at, raw)
           values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb)`,
          [
            observation.id, observation.source_id, observation.user_id,
            requireOrganizationId(observation.organization_id, observation.id),
            observation.type, observation.name,
            toJson(observation.value ?? null), observation.unit ?? null, observation.observed_at ?? null,
            toJson(observation),
          ],
        );
      }
    });
  }

  async getSource(id: string): Promise<RawSourceReference | undefined> {
    return (await this.getSources([id]))[0];
  }

  async getSources(ids: string[]): Promise<RawSourceReference[]> {
    if (ids.length === 0) return [];
    const rows = await this.rows(`select * from ${SCHEMA}.sources where id = any($1::text[]) and deleted_at is null`, [ids]);
    const byId = new Map(rows.map(row => [String(row.id), sourceFromRow(row)]));
    return ids.map(id => byId.get(id)).filter((source): source is RawSourceReference => Boolean(source));
  }

  async getSourcesForUser(ids: string[], userId: string): Promise<RawSourceReference[]> {
    return (await this.getSources(ids)).filter(source => source.user_id === userId);
  }

  async getSourcesForUserAndOrganization(ids: string[], userId: string, organizationId?: string): Promise<RawSourceReference[]> {
    return (await this.getSourcesForUser(ids, userId)).filter(source => organizationId == null || source.organization_id === organizationId);
  }

  async listSourcesForUser(userId: string, organizationIds?: Set<string>): Promise<RawSourceReference[]> {
    const rows = await this.rows(
      `select * from ${SCHEMA}.sources where user_id=$1 and deleted_at is null ${orgClause(organizationIds, 2)}`,
      [userId, ...orgParams(organizationIds)],
    );
    return rows.map(sourceFromRow);
  }

  async getSourcePayload(id: string): Promise<Buffer | undefined> {
    const key = await this.sourcePayloadKey(id);
    return key ? this.payloads.download(key) : undefined;
  }

  async writeSourcePayloadToFile(id: string, destination: string): Promise<boolean> {
    const key = await this.sourcePayloadKey(id);
    return key ? this.payloads.writeToFile(key, destination) : false;
  }

  // Full, uncompacted analysis artifact. Written once by the WGS worker; the
  // 1 GB API server retrieves it by streaming to a file
  // (writeAnalysisArtifactToFile), never buffering the whole blob in-process.
  private analysisArtifactKey(analysisId: string): string {
    return `analyses/${analysisId}/full-analysis.json`;
  }

  async saveAnalysisArtifact(analysisId: string, body: Buffer, contentType = 'application/json'): Promise<{ object_key: string; bytes: number; storage: string }> {
    const object_key = this.analysisArtifactKey(analysisId);
    await this.payloads.upload(object_key, body, contentType);
    return { object_key, bytes: body.byteLength, storage: this.payloads.driver };
  }

  async writeAnalysisArtifactToFile(analysisId: string, destination: string): Promise<boolean> {
    return this.payloads.writeToFile(this.analysisArtifactKey(analysisId), destination);
  }

  async getAnalysisArtifactSize(analysisId: string): Promise<number | undefined> {
    return this.payloads.size(this.analysisArtifactKey(analysisId));
  }

  // Dedicated gene/rsID slice-index artifact, kept out of the analysis row so
  // routine reads/writes stay small; loaded to a file on demand by /genetic-slice.
  private analysisSliceArtifactKey(analysisId: string): string {
    return `analyses/${analysisId}/genetic-slice-index.json`;
  }

  async saveAnalysisSliceArtifact(analysisId: string, body: Buffer): Promise<void> {
    await this.payloads.upload(this.analysisSliceArtifactKey(analysisId), body, 'application/json');
  }

  async writeAnalysisSliceArtifactToFile(analysisId: string, destination: string): Promise<boolean> {
    return this.payloads.writeToFile(this.analysisSliceArtifactKey(analysisId), destination);
  }

  // Signed direct-download URL for the full analysis, so the client fetches it
  // straight from object storage and the API never buffers it. Returns
  // undefined on non-S3 deployments; the HTTP layer streams from disk instead.
  async createAnalysisArtifactDownload(analysisId: string): Promise<{ download_url: string; expires_in_seconds: number } | undefined> {
    if (!(this.payloads instanceof S3PayloadStore)) return undefined;
    if ((await this.payloads.size(this.analysisArtifactKey(analysisId))) === undefined) return undefined;
    return this.payloads.createSignedPayloadDownload(this.analysisArtifactKey(analysisId));
  }

  // Kept outside HealthStore because in-memory and filesystem deployments do
  // not offer a safe public object-storage endpoint. The HTTP layer feature
  // detects these methods and only enables this flow for S3-compatible stores.
  directPayloadUploadsEnabled(): boolean {
    return this.payloads instanceof S3PayloadStore;
  }

  async createSignedPayloadUpload(objectKey: string, contentType?: string): Promise<SignedPayloadUpload> {
    if (!(this.payloads instanceof S3PayloadStore)) {
      throw new Error('Direct genetics uploads require STORAGE_DRIVER=s3.');
    }
    return this.payloads.createSignedPayloadUpload(objectKey, contentType);
  }

  async uploadedPayloadSize(objectKey: string): Promise<number | undefined> {
    return this.payloads.size(objectKey);
  }

  async getObservations(sourceIds: string[]): Promise<NormalizedObservation[]> {
    if (sourceIds.length === 0) return [];
    const rows = await this.rows(`select * from ${SCHEMA}.observations where source_id = any($1::text[]) and deleted_at is null`, [sourceIds]);
    return rows.map(observationFromRow);
  }

  async getUserObservations(userId: string, organizationIds?: Set<string>): Promise<NormalizedObservation[]> {
    const rows = await this.rows(
      `select * from ${SCHEMA}.observations where user_id=$1 and deleted_at is null ${orgClause(organizationIds, 2)}`,
      [userId, ...orgParams(organizationIds)],
    );
    return rows.map(observationFromRow);
  }

  async saveAnalysis(result: AnalysisResult): Promise<void> {
    const organizationId = requireOrganizationId(result.organization_id, result.id);
    await this.withTransaction(async () => {
      await this.query(
        `insert into ${SCHEMA}.analyses (id, user_id, organization_id, source_ids, result, updated_at)
         values ($1,$2,$3,$4::text[],$5::jsonb, now())
         on conflict (id) do update set source_ids=excluded.source_ids, result=excluded.result, updated_at=now()`,
        [result.id, result.user_id, organizationId, result.source_ids, toJson(result)],
      );
      await this.query(
        `insert into ${SCHEMA}.dashboard_specs (id, analysis_id, user_id, organization_id, spec, updated_at)
         values ($1,$2,$3,$4,$5::jsonb, now())
         on conflict (id) do update set spec=excluded.spec, updated_at=now()`,
        [result.dashboard_spec.id, result.id, result.user_id, organizationId, toJson(result.dashboard_spec)],
      );
    });
  }

  async getAnalysis(id: string): Promise<AnalysisResult | undefined> {
    const rows = await this.rows(`select result from ${SCHEMA}.analyses where id=$1 and deleted_at is null`, [id]);
    return rows[0]?.result as AnalysisResult | undefined;
  }

  async getAnalysesForUser(ids: string[], userId: string, organizationIds?: Set<string>): Promise<AnalysisResult[]> {
    const idFilter = ids.length > 0 ? 'and id = any($2::text[])' : '';
    const params: unknown[] = ids.length > 0 ? [userId, ids] : [userId];
    const rows = await this.rows(
      `select result from ${SCHEMA}.analyses where user_id=$1 and deleted_at is null ${idFilter} ${orgClause(organizationIds, params.length + 1)}`,
      [...params, ...orgParams(organizationIds)],
    );
    const analyses = rows.map(row => row.result as AnalysisResult);
    if (ids.length === 0) return analyses;
    const byId = new Map(analyses.map(analysis => [analysis.id, analysis]));
    return ids.map(id => byId.get(id)).filter((analysis): analysis is AnalysisResult => Boolean(analysis));
  }

  async listAnalysisSummaries(userId: string, organizationIds: Set<string> | undefined, query: AnalysisListQuery): Promise<{ analyses: AnalysisResult[]; total: number }> {
    // Filter, order, and limit in SQL, and drop the heavy normalized_observations
    // array from the returned blob. Previously the /analyses list loaded every
    // full analysis blob for the user into memory, so a user with large genetics
    // or multimodal analyses paid a multi-second (timeout-prone) load per call.
    const filters: string[] = ['user_id=$1', 'deleted_at is null'];
    const params: unknown[] = [userId];
    if (query.modality != null) { params.push(query.modality); filters.push(`result->>'modality' = $${params.length}`); }
    if (query.since != null) { params.push(query.since); filters.push(`result->>'created_at' >= $${params.length}`); }
    const org = orgClause(organizationIds, params.length + 1);
    const filterSql = `${filters.join(' and ')} ${org}`;
    const scopedParams = [...params, ...orgParams(organizationIds)];

    const rows = await this.rows(
      `select result - 'normalized_observations' as result from ${SCHEMA}.analyses
       where ${filterSql}
       order by result->>'created_at' desc
       limit $${scopedParams.length + 1}`,
      [...scopedParams, Math.max(1, query.limit)],
    );
    const countRows = await this.rows(
      `select count(*)::int as total from ${SCHEMA}.analyses where ${filterSql}`,
      scopedParams,
    );
    return {
      analyses: rows.map(row => row.result as AnalysisResult),
      total: Number(countRows[0]?.total ?? rows.length),
    };
  }

  async getIdempotencyRecord(key: string, method: string, route: string, subject: string): Promise<IdempotencyRecord | undefined> {
    const rows = await this.rows(
      `select * from ${SCHEMA}.idempotency_keys where key=$1 and method=$2 and route=$3 and subject=$4`,
      [key, method, route, subject],
    );
    const row = rows[0];
    return row ? {
      key: String(row.key), method: String(row.method), route: String(row.route), subject: String(row.subject),
      status: Number(row.status), body: row.body, created_at: iso(row.created_at)!,
    } : undefined;
  }

  async saveIdempotencyRecord(record: IdempotencyRecord): Promise<void> {
    await this.query(
      `insert into ${SCHEMA}.idempotency_keys (key, method, route, subject, status, body, created_at)
       values ($1,$2,$3,$4,$5,$6::jsonb, coalesce($7::timestamptz, now()))
       on conflict (subject, method, route, key) do update set status=excluded.status, body=excluded.body`,
      [record.key, record.method, record.route, record.subject, record.status, toJson(record.body), record.created_at ?? null],
    );
  }

  async createGeneticAnalysisJob(job: GeneticAnalysisJob): Promise<void> {
    await this.query(
      `insert into ${SCHEMA}.genetic_analysis_jobs
        (id, user_id, organization_id, analysis_id, source_id, annotation_depth, status, stage, progress_pct, progress_message, last_progress_at, reanalysis_recommended, reanalysis_reason, attempts, max_attempts, priority, worker_id, locked_at, started_at, completed_at, error, result, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb, coalesce($23::timestamptz, now()), coalesce($24::timestamptz, now()))`,
      [
        job.id, job.user_id, requireOrganizationId(job.organization_id, job.id), job.analysis_id, job.source_id,
        job.annotation_depth ?? 'compact', job.status, job.stage ?? 'queued', job.progress_pct ?? 0, job.progress_message ?? null,
        job.last_progress_at ?? null, job.reanalysis_recommended ?? false, job.reanalysis_reason ?? null,
        job.attempts, job.max_attempts, job.priority, job.worker_id ?? null, job.locked_at ?? null,
        job.started_at ?? null, job.completed_at ?? null, job.error ?? null, toJson(job.result ?? null),
        job.created_at ?? null, job.updated_at ?? null,
      ],
    );
  }

  async getGeneticAnalysisJob(id: string): Promise<GeneticAnalysisJob | undefined> {
    const rows = await this.rows(`select * from ${SCHEMA}.genetic_analysis_jobs where id=$1`, [id]);
    return rows[0] ? jobFromRow(rows[0]) : undefined;
  }

  async claimNextGeneticAnalysisJob(workerId: string): Promise<GeneticAnalysisJob | undefined> {
    const rows = await this.rows(
      `with candidate as (
         select id from ${SCHEMA}.genetic_analysis_jobs
         where status='queued' and attempts < max_attempts
         order by priority desc, created_at asc
         for update skip locked limit 1
       )
       update ${SCHEMA}.genetic_analysis_jobs job
       set status='running', attempts=job.attempts+1, worker_id=$1, locked_at=now(),
           stage='preparing', progress_pct=5, progress_message='Preparing the uploaded genome for analysis.', last_progress_at=now(),
           started_at=coalesce(job.started_at, now()), updated_at=now(), error=null
       from candidate where job.id=candidate.id returning job.*`,
      [workerId],
    );
    return rows[0] ? jobFromRow(rows[0]) : undefined;
  }

  async updateGeneticAnalysisJobProgress(
    id: string,
    progress: { stage: import('../types.js').GeneticAnalysisJobStage; progress_pct: number; progress_message?: string },
  ): Promise<void> {
    await this.query(
      `update ${SCHEMA}.genetic_analysis_jobs
       set stage=$2, progress_pct=greatest(progress_pct, greatest(0, least(100, $3))), progress_message=$4,
           last_progress_at=now(), updated_at=now()
       where id=$1`,
      [id, progress.stage, Math.round(progress.progress_pct), progress.progress_message ?? null],
    );
  }

  async completeGeneticAnalysisJob(id: string, result: unknown): Promise<void> {
    await this.query(
      `update ${SCHEMA}.genetic_analysis_jobs
       set status='complete', stage='complete', progress_pct=100,
           progress_message='Analysis complete. Interpreted results are ready.', last_progress_at=now(),
           completed_at=now(), updated_at=now(), locked_at=null, result=$2::jsonb, error=null
           , reanalysis_recommended=coalesce(($2::jsonb #>> '{raw,consumer_genetics,reanalysis_recommended}')::boolean, false)
           , reanalysis_reason=case
               when coalesce(($2::jsonb #>> '{raw,consumer_genetics,reanalysis_recommended}')::boolean, false)
               then 'A raw or incomplete genetic score can be upgraded when a compatible calibration or score-registry release becomes available.'
               else null end
       where id=$1`,
      [id, toJson(result ?? null)],
    );
  }

  async failGeneticAnalysisJob(id: string, error: string, options?: { retryable?: boolean }): Promise<void> {
    const resolvedRetryable = options?.retryable !== undefined;
    await this.query(
      `update ${SCHEMA}.genetic_analysis_jobs
       set status = case when ${resolvedRetryable ? '$3::boolean' : 'attempts < max_attempts'} then 'queued' else 'failed' end,
           stage = case when ${resolvedRetryable ? '$3::boolean' : 'attempts < max_attempts'} then 'retry_queued' else 'failed' end,
           progress_message = case when ${resolvedRetryable ? '$3::boolean' : 'attempts < max_attempts'}
             then 'This attempt failed and has been queued for retry.'
             else 'Analysis attempts are exhausted. The source can be reanalyzed after the reported issue is corrected.' end,
           last_progress_at=now(),
           reanalysis_recommended = not (${resolvedRetryable ? '$3::boolean' : 'attempts < max_attempts'}),
           reanalysis_reason = case when not (${resolvedRetryable ? '$3::boolean' : 'attempts < max_attempts'}) then $2 else null end,
           updated_at=now(), locked_at=null, worker_id=null, error=$2 where id=$1`,
      resolvedRetryable ? [id, error, options!.retryable!] : [id, error],
    );
  }

  async requeueGeneticAnalysisJob(id: string): Promise<void> {
    await this.query(
      `update ${SCHEMA}.genetic_analysis_jobs
       set status='queued', stage='queued', progress_pct=0,
           progress_message='Waiting for the dedicated WGS worker.',
           attempts=greatest(0, attempts-1), locked_at=null, worker_id=null, updated_at=now()
       where id=$1 and status='running'`,
      [id],
    );
  }

  async resetStaleGeneticAnalysisJobs(staleMinutes = 30): Promise<number> {
    const rows = await this.rows(
      `update ${SCHEMA}.genetic_analysis_jobs
       set status='queued', stage='queued', progress_pct=0,
           progress_message='Waiting for the dedicated WGS worker.',
           attempts=greatest(0, attempts-1), locked_at=null, worker_id=null, updated_at=now()
       where status='running' and locked_at < now() - ($1 || ' minutes')::interval
       returning id`,
      [String(staleMinutes)],
    );
    return rows.length;
  }

  // Genetics pipeline checkpoint. Lives in durable object storage (not the DB)
  // so a Postgres-side failure that blocks completeGeneticAnalysisJob/saveAnalysis
  // cannot also lose the completed compute. The compacted result is bounded, so
  // buffering it here is safe on the WGS worker.
  async saveGeneticAnalysisCheckpoint(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined, result: unknown): Promise<void> {
    const body = Buffer.from(JSON.stringify(result ?? null));
    await this.payloads.upload(geneticCheckpointObjectKey(sourceId, annotationDepth), body, 'application/json');
  }

  async getGeneticAnalysisCheckpoint(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined): Promise<unknown | undefined> {
    const body = await this.payloads.download(geneticCheckpointObjectKey(sourceId, annotationDepth));
    if (!body) return undefined;
    try {
      return JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      return undefined;
    }
  }

  async clearGeneticAnalysisCheckpoint(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined): Promise<void> {
    await this.payloads.remove(geneticCheckpointObjectKey(sourceId, annotationDepth));
  }

  // Cache of the dbSNP-annotated VCF. Streamed to/from object storage so the
  // multi-hundred-MB artifact is never buffered in the process.
  async saveGeneticAnnotationArtifact(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined, filePath: string): Promise<void> {
    await this.payloads.uploadFile(geneticAnnotationObjectKey(sourceId, annotationDepth), filePath, 'application/gzip');
  }

  async getGeneticAnnotationArtifactToFile(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined, destination: string): Promise<boolean> {
    return this.payloads.writeToFile(geneticAnnotationObjectKey(sourceId, annotationDepth), destination);
  }

  async clearGeneticAnnotationArtifact(sourceId: string, annotationDepth: GeneticsAnnotationDepth | undefined): Promise<void> {
    await this.payloads.remove(geneticAnnotationObjectKey(sourceId, annotationDepth));
  }

  async upsertExternalAccount(account: ExternalAccount): Promise<ExternalAccount> {
    const organizationId = requireOrganizationId(account.organization_id, account.id);
    const rows = await this.rows(
      `insert into ${SCHEMA}.external_accounts (id, user_id, organization_id, provider, external_user_id, status, last_synced_at, metadata, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb, coalesce($9::timestamptz, now()), now())
       on conflict (user_id, organization_id, provider, external_user_id) do update set
         status=excluded.status,
         last_synced_at=coalesce(excluded.last_synced_at, ${SCHEMA}.external_accounts.last_synced_at),
         metadata=${SCHEMA}.external_accounts.metadata || excluded.metadata,
         updated_at=now()
       returning *`,
      [
        account.id, account.user_id, organizationId, account.provider, account.external_user_id,
        account.status, account.last_synced_at ?? null, toJson(account.metadata ?? {}), account.created_at ?? null,
      ],
    );
    return externalAccountFromRow(rows[0]!);
  }

  async listExternalAccountsForUser(userId: string, organizationIds?: Set<string>): Promise<ExternalAccount[]> {
    const rows = await this.rows(
      `select * from ${SCHEMA}.external_accounts where user_id=$1 ${orgClause(organizationIds, 2)} order by updated_at desc`,
      [userId, ...orgParams(organizationIds)],
    );
    return rows.map(externalAccountFromRow);
  }

  async saveProviderToken(token: ProviderToken): Promise<ProviderToken> {
    const rows = await this.rows(
      `insert into ${SCHEMA}.provider_tokens
        (id, external_account_id, user_id, organization_id, provider, provider_external_user_id, access_token_encrypted, refresh_token_encrypted, scope, token_type, expires_at, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, coalesce($12::timestamptz, now()), now())
       on conflict (provider, provider_external_user_id) do update set
         external_account_id=excluded.external_account_id, user_id=excluded.user_id, organization_id=excluded.organization_id,
         access_token_encrypted=excluded.access_token_encrypted, refresh_token_encrypted=excluded.refresh_token_encrypted,
         scope=excluded.scope, token_type=excluded.token_type, expires_at=excluded.expires_at, updated_at=now()
       returning *`,
      [
        token.id, token.external_account_id, token.user_id, requireOrganizationId(token.organization_id, token.id),
        token.provider, token.provider_external_user_id, token.access_token_encrypted ?? null, token.refresh_token_encrypted ?? null,
        token.scope ?? null, token.token_type ?? null, token.expires_at ?? null, token.created_at ?? null,
      ],
    );
    return providerTokenFromRow(rows[0]!);
  }

  async getProviderTokenByExternalUser(provider: string, providerExternalUserId: string): Promise<ProviderToken | undefined> {
    const rows = await this.rows(
      `select * from ${SCHEMA}.provider_tokens where provider=$1 and provider_external_user_id=$2 limit 1`,
      [provider, providerExternalUserId],
    );
    return rows[0] ? providerTokenFromRow(rows[0]) : undefined;
  }

  async createConnectorSyncJob(job: ConnectorSyncJob): Promise<void> {
    await this.query(
      `insert into ${SCHEMA}.connector_sync_jobs
        (id, user_id, organization_id, provider, external_account_id, scheduled_for, status, attempts, max_attempts, priority, worker_id, locked_at, started_at, completed_at, error, result, request, created_at, updated_at)
       values ($1,$2,$3,$4,$5, coalesce($6::timestamptz, now()), $7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb, coalesce($18::timestamptz, now()), coalesce($19::timestamptz, now()))`,
      [
        job.id, job.user_id, requireOrganizationId(job.organization_id, job.id), job.provider, job.external_account_id ?? null,
        job.scheduled_for ?? null, job.status, job.attempts, job.max_attempts, job.priority, job.worker_id ?? null,
        job.locked_at ?? null, job.started_at ?? null, job.completed_at ?? null, job.error ?? null,
        toJson(job.result ?? null), toJson(job.request ?? {}), job.created_at ?? null, job.updated_at ?? null,
      ],
    );
  }

  async getConnectorSyncJob(id: string): Promise<ConnectorSyncJob | undefined> {
    const rows = await this.rows(`select * from ${SCHEMA}.connector_sync_jobs where id=$1`, [id]);
    return rows[0] ? connectorJobFromRow(rows[0]) : undefined;
  }

  async claimNextConnectorSyncJob(workerId: string): Promise<ConnectorSyncJob | undefined> {
    const rows = await this.rows(
      `with candidate as (
         select id from ${SCHEMA}.connector_sync_jobs
         where status='queued' and attempts < max_attempts and scheduled_for <= now()
         order by priority desc, scheduled_for asc, created_at asc
         for update skip locked limit 1
       )
       update ${SCHEMA}.connector_sync_jobs job
       set status='running', attempts=job.attempts+1, worker_id=$1, locked_at=now(),
           started_at=coalesce(job.started_at, now()), updated_at=now()
       from candidate where job.id=candidate.id returning job.*`,
      [workerId],
    );
    return rows[0] ? connectorJobFromRow(rows[0]) : undefined;
  }

  async completeConnectorSyncJob(id: string, result: unknown): Promise<void> {
    const job = await this.getConnectorSyncJob(id);
    if (!job) return;
    await this.query(
      `update ${SCHEMA}.connector_sync_jobs set status='complete', completed_at=now(), updated_at=now(), locked_at=null, result=$2::jsonb, error=null where id=$1`,
      [id, toJson(result ?? null)],
    );
    if (job.external_account_id) {
      await this.query(
        `update ${SCHEMA}.external_accounts set last_synced_at=now(), updated_at=now() where id=$1`,
        [job.external_account_id],
      );
    }
  }

  async failConnectorSyncJob(id: string, error: string): Promise<void> {
    await this.query(
      `update ${SCHEMA}.connector_sync_jobs
       set status = case when attempts < max_attempts then 'queued' else 'failed' end,
           updated_at=now(), locked_at=null, worker_id=null, error=$2 where id=$1`,
      [id, error],
    );
  }

  async createWebhookEvent(event: WebhookEvent): Promise<void> {
    await this.query(
      `insert into ${SCHEMA}.webhook_events (id, type, user_id, organization_id, subject_id, request_id, data, created_at)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb, coalesce($8::timestamptz, now()))`,
      [event.id, event.type, event.user_id ?? null, event.organization_id ?? null, event.subject_id ?? null, event.request_id ?? null, toJson(event.data ?? {}), event.created_at ?? null],
    );
  }

  async listWebhookEvents(input: { userId?: string; organizationId?: string; limit?: number; type?: string }): Promise<WebhookEvent[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (input.userId) { params.push(input.userId); conditions.push(`user_id=$${params.length}`); }
    if (input.organizationId) { params.push(input.organizationId); conditions.push(`organization_id=$${params.length}`); }
    if (input.type) { params.push(input.type); conditions.push(`type=$${params.length}`); }
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
    const rows = await this.rows(`select * from ${SCHEMA}.webhook_events ${where} order by created_at desc limit ${limit}`, params);
    return rows.map(webhookEventFromRow);
  }

  async createOtpChallenge(challenge: import('../types.js').OtpChallenge): Promise<void> {
    // Opportunistically clear this email's expired challenges so the table stays small.
    await this.query(`delete from ${SCHEMA}.auth_otp_codes where email=$1 and expires_at <= now()`, [challenge.email]);
    await this.query(
      `insert into ${SCHEMA}.auth_otp_codes (id, email, code_hash, expires_at, created_at)
       values ($1,$2,$3,$4::timestamptz, coalesce($5::timestamptz, now()))`,
      [challenge.id, challenge.email, challenge.code_hash, challenge.expires_at, challenge.created_at ?? null],
    );
  }

  async consumeOtpChallenge(email: string, codeHash: string): Promise<boolean> {
    const deleted = await this.query(
      `delete from ${SCHEMA}.auth_otp_codes where email=$1 and code_hash=$2 and expires_at > now() returning id`,
      [email, codeHash],
    );
    if ((deleted.rowCount ?? 0) === 0) return false;
    // A correct code invalidates any other outstanding codes for the email.
    await this.query(`delete from ${SCHEMA}.auth_otp_codes where email=$1`, [email]);
    return true;
  }

  async createGoal(goal: Goal): Promise<Goal> {
    await this.query(
      `insert into ${SCHEMA}.goals (id, user_id, organization_id, title, metric, target_value, target_unit, target_direction, due_date, status, note, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, coalesce($12::timestamptz, now()), coalesce($13::timestamptz, now()))`,
      [
        goal.id, goal.user_id, requireOrganizationId(goal.organization_id, goal.id), goal.title, goal.metric ?? null,
        goal.target_value ?? null, goal.target_unit ?? null, goal.target_direction ?? null, goal.due_date ?? null,
        goal.status, goal.note ?? null, goal.created_at ?? null, goal.updated_at ?? null,
      ],
    );
    return goal;
  }

  async getGoal(id: string): Promise<Goal | undefined> {
    const rows = await this.rows(`select * from ${SCHEMA}.goals where id=$1 and deleted_at is null`, [id]);
    return rows[0] ? goalFromRow(rows[0]) : undefined;
  }

  async listGoals(userId: string, organizationIds?: Set<string>): Promise<Goal[]> {
    const rows = await this.rows(
      `select * from ${SCHEMA}.goals where user_id=$1 and deleted_at is null ${orgClause(organizationIds, 2)} order by created_at desc`,
      [userId, ...orgParams(organizationIds)],
    );
    return rows.map(goalFromRow);
  }

  async updateGoal(id: string, patch: Partial<Goal>): Promise<Goal | undefined> {
    const columns = ['title', 'metric', 'target_value', 'target_unit', 'target_direction', 'due_date', 'status', 'note'] as const;
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const column of columns) {
      if (patch[column] !== undefined) {
        params.push(patch[column]);
        sets.push(`${column}=$${params.length}`);
      }
    }
    sets.push('updated_at=now()');
    const rows = await this.rows(`update ${SCHEMA}.goals set ${sets.join(', ')} where id=$1 and deleted_at is null returning *`, params);
    return rows[0] ? goalFromRow(rows[0]) : undefined;
  }

  async deleteGoal(id: string): Promise<boolean> {
    const result = await this.query(`update ${SCHEMA}.goals set deleted_at=now() where id=$1 and deleted_at is null`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async exportUserData(userId: string, organizationId?: string, requestId?: string): Promise<DataExportResult> {
    const orgId = requireOrganizationId(organizationId, userId);
    const [sourceRows, observationRows, analysisRows, geneticRows, connectorRows, accountRows, goalRows] = await Promise.all([
      this.rows(`select * from ${SCHEMA}.sources where user_id=$1 and organization_id=$2 and deleted_at is null`, [userId, orgId]),
      this.rows(`select * from ${SCHEMA}.observations where user_id=$1 and organization_id=$2 and deleted_at is null`, [userId, orgId]),
      this.rows(`select result from ${SCHEMA}.analyses where user_id=$1 and organization_id=$2 and deleted_at is null`, [userId, orgId]),
      this.rows(`select * from ${SCHEMA}.genetic_analysis_jobs where user_id=$1 and organization_id=$2`, [userId, orgId]),
      this.rows(`select * from ${SCHEMA}.connector_sync_jobs where user_id=$1 and organization_id=$2`, [userId, orgId]),
      this.rows(`select * from ${SCHEMA}.external_accounts where user_id=$1 and organization_id=$2`, [userId, orgId]),
      this.rows(`select * from ${SCHEMA}.goals where user_id=$1 and organization_id=$2 and deleted_at is null`, [userId, orgId]),
    ]);
    const sources = sourceRows.map(sourceFromRow);
    const observations = observationRows.map(observationFromRow);
    const analyses = analysisRows.map(row => row.result as AnalysisResult);
    const geneticJobs = geneticRows.map(jobFromRow);
    const connectorSyncJobs = connectorRows.map(connectorJobFromRow);
    const externalAccounts = accountRows.map(externalAccountFromRow);
    const goals = goalRows.map(goalFromRow);
    return {
      user_id: userId, organization_id: orgId, exported_at: new Date().toISOString(),
      receipt_id: createId('export_receipt'), request_id: requestId, format: 'json',
      counts: {
        sources: sources.length, observations: observations.length, analyses: analyses.length,
        dashboard_specs: analyses.length, genetic_jobs: geneticJobs.length,
        connector_sync_jobs: connectorSyncJobs.length, external_accounts: externalAccounts.length, goals: goals.length,
      },
      data: { sources, observations, analyses, genetic_jobs: geneticJobs, connector_sync_jobs: connectorSyncJobs, external_accounts: externalAccounts, goals },
      retention_note: 'Export includes currently retained tenant-scoped rows. Raw encrypted payload binaries are referenced by source metadata rather than embedded.',
    };
  }

  async tombstoneUserData(userId: string, organizationId?: string): Promise<TombstoneResult> {
    const orgId = requireOrganizationId(organizationId, userId);
    const now = new Date().toISOString();
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const sources = await client.query(`update ${SCHEMA}.sources set deleted_at=now(), updated_at=now() where user_id=$1 and organization_id=$2 and deleted_at is null returning id`, [userId, orgId]);
      const observations = await client.query(`update ${SCHEMA}.observations set deleted_at=now() where user_id=$1 and organization_id=$2 and deleted_at is null returning id`, [userId, orgId]);
      const analyses = await client.query(`update ${SCHEMA}.analyses set deleted_at=now(), updated_at=now() where user_id=$1 and organization_id=$2 and deleted_at is null returning id`, [userId, orgId]);
      const dashboards = await client.query(`update ${SCHEMA}.dashboard_specs set deleted_at=now(), updated_at=now() where user_id=$1 and organization_id=$2 and deleted_at is null returning id`, [userId, orgId]);
      const goals = await client.query(`update ${SCHEMA}.goals set deleted_at=now(), updated_at=now() where user_id=$1 and organization_id=$2 and deleted_at is null returning id`, [userId, orgId]);
      await client.query('commit');
      // Actively delete the full-analysis genomic artifacts from object storage
      // rather than relying on bucket lifecycle, since they sit under a separate
      // key prefix. Best-effort: the DB tombstone is the source of truth, and
      // lifecycle remains the backstop, so a transient object-store error here
      // must not fail the deletion receipt.
      for (const row of analyses.rows) {
        for (const objectKey of [this.analysisArtifactKey(String(row.id)), this.analysisSliceArtifactKey(String(row.id))]) {
          try {
            await this.payloads.remove(objectKey);
          } catch (error) {
            console.warn(JSON.stringify({
              ts: new Date().toISOString(),
              event: 'analysis_artifact_tombstone_cleanup_failed',
              analysis_id: String(row.id),
              object_key: objectKey,
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        }
      }
      // Delete any genetics checkpoints for the tombstoned sources so completed
      // genomic compute is not left behind in object storage after deletion.
      for (const row of sources.rows) {
        for (const depth of ['compact', 'full_dbsnp'] as const) {
          for (const objectKey of [geneticCheckpointObjectKey(String(row.id), depth), geneticAnnotationObjectKey(String(row.id), depth)]) {
            try {
              await this.payloads.remove(objectKey);
            } catch (error) {
              console.warn(JSON.stringify({
                ts: new Date().toISOString(),
                event: 'genetic_artifact_tombstone_cleanup_failed',
                source_id: String(row.id),
                object_key: objectKey,
                error: error instanceof Error ? error.message : String(error),
              }));
            }
          }
        }
      }
      return {
        user_id: userId, organization_id: orgId, deleted_at: now,
        sources: sources.rowCount ?? 0, observations: observations.rowCount ?? 0, analyses: analyses.rowCount ?? 0,
        dashboard_specs: dashboards.rowCount ?? 0, goals: goals.rowCount ?? 0,
        receipt_id: createId('delete_receipt'),
        retention_note: 'Tenant-scoped rows were tombstoned. Private object-storage lifecycle cleanup may run asynchronously.',
        affected_source_ids: sources.rows.map(row => String(row.id)),
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async readiness(): Promise<{ ok: boolean; durable: boolean; checks: Record<string, boolean | string> }> {
    const checks: Record<string, boolean | string> = { store: 'postgres', durable: true };
    try {
      await this.query('select 1');
      checks.connection = true;
      const probe = await this.query(`select count(*) from ${SCHEMA}.schema_migrations`);
      checks.migrations = Number(probe.rows[0]?.count ?? 0) > 0;
      checks.applied_migration_count = String(probe.rows[0]?.count ?? 0);
      for (const table of ['sources', 'genetic_analysis_jobs', 'connector_sync_jobs', 'webhook_events'] as const) {
        await this.query(`select 1 from ${SCHEMA}.${table} limit 1`);
        checks[table] = true;
      }
      checks.schema = true;
    } catch (error) {
      checks.schema = false;
      checks.schema_error = error instanceof Error ? error.message : String(error);
    }
    const payload = await this.payloads.readiness();
    checks.payload_store = payload.ok;
    checks.payload_detail = payload.detail;
    return {
      ok: checks.schema === true && checks.migrations === true && payload.ok,
      durable: true,
      checks,
    };
  }

  private async rows(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
    const result = await this.query(sql, params);
    return result.rows as Array<Record<string, unknown>>;
  }

  private async query(sql: string, params?: unknown[]) {
    return (this.transaction.getStore()?.client ?? this.pool).query(sql, params);
  }

  private async sourcePayloadKey(id: string): Promise<string | undefined> {
    const rows = await this.rows(`select payload_object_key from ${SCHEMA}.sources where id=$1 and deleted_at is null`, [id]);
    return stringField(rows[0] ?? null, 'payload_object_key');
  }
}

// ---- row mappers (shared shape with the prior store; timestamptz -> ISO) ----

function sourceFromRow(row: Record<string, unknown>): RawSourceReference {
  const provenance = objectField(row.provenance);
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    organization_id: String(row.organization_id),
    category: row.category as RawSourceReference['category'],
    provider: stringField(row, 'provider'),
    filename: stringField(row, 'filename'),
    content_type: stringField(row, 'content_type'),
    received_at: typeof provenance.received_at === 'string' ? provenance.received_at : iso(row.created_at)!,
    byte_length: Number(row.byte_length ?? 0),
    storage_mode: 'durable',
    upload_status: provenance.upload_status === 'pending' ? 'pending' : 'complete',
  };
}

function observationFromRow(row: Record<string, unknown>): NormalizedObservation {
  const raw = objectField(row.raw);
  return {
    id: String(row.id),
    source_id: String(row.source_id),
    user_id: String(row.user_id),
    organization_id: String(row.organization_id),
    category: raw.category as NormalizedObservation['category'],
    type: String(row.type),
    name: String(row.marker ?? raw.name ?? row.type),
    value: typeof row.value === 'number' ? row.value : typeof raw.value === 'number' ? raw.value : undefined,
    unit: stringField(row, 'unit') ?? (typeof raw.unit === 'string' ? raw.unit : undefined),
    observed_at: iso(row.observed_at) ?? (typeof raw.observed_at === 'string' ? raw.observed_at : undefined),
    provider: typeof raw.provider === 'string' ? raw.provider : undefined,
    raw: raw.raw ?? raw,
  };
}

function jobFromRow(row: Record<string, unknown>): GeneticAnalysisJob {
  return {
    id: String(row.id), user_id: String(row.user_id), organization_id: String(row.organization_id),
    analysis_id: String(row.analysis_id), source_id: String(row.source_id),
    annotation_depth: row.annotation_depth === 'full_dbsnp' ? 'full_dbsnp' : 'compact',
    status: row.status as GeneticAnalysisJob['status'],
    stage: stringField(row, 'stage') as GeneticAnalysisJob['stage'], progress_pct: Number(row.progress_pct ?? 0),
    progress_message: stringField(row, 'progress_message'), last_progress_at: iso(row.last_progress_at),
    reanalysis_recommended: row.reanalysis_recommended === true, reanalysis_reason: stringField(row, 'reanalysis_reason'),
    attempts: Number(row.attempts ?? 0), max_attempts: Number(row.max_attempts ?? 3), priority: Number(row.priority ?? 0),
    worker_id: stringField(row, 'worker_id'), locked_at: iso(row.locked_at), started_at: iso(row.started_at),
    completed_at: iso(row.completed_at), error: stringField(row, 'error'), result: row.result,
    created_at: iso(row.created_at)!, updated_at: iso(row.updated_at)!,
  };
}

function connectorJobFromRow(row: Record<string, unknown>): ConnectorSyncJob {
  return {
    id: String(row.id), user_id: String(row.user_id), organization_id: String(row.organization_id),
    provider: String(row.provider), external_account_id: stringField(row, 'external_account_id'),
    scheduled_for: iso(row.scheduled_for)!, status: row.status as ConnectorSyncJob['status'],
    attempts: Number(row.attempts ?? 0), max_attempts: Number(row.max_attempts ?? 5), priority: Number(row.priority ?? 0),
    worker_id: stringField(row, 'worker_id'), locked_at: iso(row.locked_at), started_at: iso(row.started_at),
    completed_at: iso(row.completed_at), error: stringField(row, 'error'), result: row.result,
    request: objectField(row.request), created_at: iso(row.created_at)!, updated_at: iso(row.updated_at)!,
  };
}

function externalAccountFromRow(row: Record<string, unknown>): ExternalAccount {
  return {
    id: String(row.id), user_id: String(row.user_id), organization_id: String(row.organization_id),
    provider: String(row.provider), external_user_id: String(row.external_user_id),
    status: row.status as ExternalAccount['status'], last_synced_at: iso(row.last_synced_at),
    metadata: objectField(row.metadata), created_at: iso(row.created_at)!, updated_at: iso(row.updated_at)!,
  };
}

function providerTokenFromRow(row: Record<string, unknown>): ProviderToken {
  return {
    id: String(row.id), external_account_id: String(row.external_account_id), user_id: String(row.user_id),
    organization_id: String(row.organization_id), provider: String(row.provider),
    provider_external_user_id: String(row.provider_external_user_id),
    access_token_encrypted: stringField(row, 'access_token_encrypted'),
    refresh_token_encrypted: stringField(row, 'refresh_token_encrypted'),
    scope: stringField(row, 'scope'), token_type: stringField(row, 'token_type'), expires_at: iso(row.expires_at),
    created_at: iso(row.created_at)!, updated_at: iso(row.updated_at)!,
  };
}

function goalFromRow(row: Record<string, unknown>): Goal {
  return {
    id: String(row.id), user_id: String(row.user_id), organization_id: stringField(row, 'organization_id'),
    title: String(row.title ?? ''), metric: stringField(row, 'metric'),
    target_value: row.target_value == null ? undefined : Number(row.target_value),
    target_unit: stringField(row, 'target_unit'),
    target_direction: stringField(row, 'target_direction') as Goal['target_direction'],
    due_date: stringField(row, 'due_date'), status: (stringField(row, 'status') as Goal['status']) ?? 'active',
    note: stringField(row, 'note'), created_at: iso(row.created_at)!, updated_at: iso(row.updated_at)!,
  };
}

function webhookEventFromRow(row: Record<string, unknown>): WebhookEvent {
  return {
    id: String(row.id), type: row.type as WebhookEvent['type'], user_id: stringField(row, 'user_id'),
    organization_id: stringField(row, 'organization_id'), subject_id: stringField(row, 'subject_id'),
    request_id: stringField(row, 'request_id'), data: objectField(row.data), created_at: iso(row.created_at)!,
  };
}

// ---- helpers ----

function requireOrganizationId(value: string | undefined, id: string): string {
  if (!value) throw new Error(`organization_id is required for the durable Postgres store: ${id}`);
  return value;
}

// Build an `and organization_id = any($n::text[])` clause when org scoping applies.
function orgClause(organizationIds: Set<string> | undefined, paramIndex: number): string {
  return organizationIds && organizationIds.size > 0 ? `and organization_id = any($${paramIndex}::text[])` : '';
}

function orgParams(organizationIds: Set<string> | undefined): unknown[] {
  return organizationIds && organizationIds.size > 0 ? [Array.from(organizationIds)] : [];
}

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function iso(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function objectField(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(row: Record<string, unknown> | null, key: string): string | undefined {
  const value = row?.[key];
  return typeof value === 'string' && value ? value : undefined;
}

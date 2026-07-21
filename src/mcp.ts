import { runHealthAnalysis, queryHealthContext, summarizeAnalysis } from './core/analysis.js';
import { buildHealthContext } from './core/health-context.js';
import { buildHealthTrends } from './core/trends.js';
import { buildRecommendations } from './core/recommendations.js';
import { buildActionPlan } from './core/action-plan.js';
import { createPrivateDashboardLink } from './core/dashboard-links.js';
import { getDesignSystem } from './core/design-systems.js';
import { getDesignImplementation } from './core/design-implementation.js';
import { findProviders, type ProviderModality } from './core/providers.js';
import { enrichAnalysisWithGeneticPipeline } from './core/genetic-analysis.js';
import { buildSourceReference, decodeImportBuffer, normalizeImportedFile, type FileImportInput } from './core/normalization.js';
import { geneticUploadPayloadKey, type SignedPayloadUpload } from './connectors/payload-store.js';
import { buildOAuthUrl } from './connectors/wearables.js';
import { searchLabs } from './connectors/labs.js';
import { listWgsProviders, getWgsProvider } from './connectors/wgs-providers.js';
import { StripeBillingService, stripeBillingConfig } from './billing.js';
import { capabilitiesCatalog } from './capabilities.js';
import {
  hasScope,
  isBillingAdmin,
  isEndpointEnabled,
  requireEndpointAccess,
  requireResourceAccess,
  requireScope,
  requireUserAccess,
  resolveOrganizationId,
  type AuthConfig,
  type AuthContext,
} from './auth.js';
import { endpointByMcpTool } from './endpoints.js';
import { toolInputSchemas } from './schemas.js';
import { SERVICE_VERSION } from './version.js';
import { createId, type HealthStore } from './store.js';
import type { GeneticsAnnotationDepth, OAuthUrlRequest, ProviderId, RawSourceReference } from './types.js';

type JsonRpcRequest = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
};

export async function handleMcpRequest(request: unknown, store: HealthStore, auth: AuthContext, config: AuthConfig, requestId?: string, baseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:8787'): Promise<unknown> {
  const rpc = request as JsonRpcRequest;
  try {
    const result = await handleRpc(String(rpc.method ?? ''), rpc.params ?? {}, store, auth, config, baseUrl);
    return { jsonrpc: '2.0', id: rpc.id ?? null, result };
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id: rpc.id ?? null,
      error: mcpError(error, requestId),
    };
  }
}

async function handleRpc(method: string, params: Record<string, unknown>, store: HealthStore, auth: AuthContext, config: AuthConfig, baseUrl: string): Promise<unknown> {
  if (method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'wellnizz-api', version: SERVICE_VERSION },
      capabilities: { tools: {} },
    };
  }
  if (method === 'notifications/initialized') return {};
  if (method === 'tools/list') {
    return {
      tools: availableMcpTools(auth, config),
    };
  }
  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? params.arguments as Record<string, unknown>
      : {};
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(await callTool(name, args, store, auth, config, baseUrl), null, 2),
      }],
    };
  }
  if (legacyToolNames().has(method)) {
    return callTool(method, params, store, auth, config, baseUrl);
  }
  throw new McpToolError(-32601, `Unknown MCP method: ${method}`, 'unknown_method', `Use tools/list then tools/call with a listed tool name.`);
}

async function callTool(method: string, params: Record<string, unknown>, store: HealthStore, auth: AuthContext, config: AuthConfig, baseUrl: string): Promise<unknown> {
  if (method === 'upload_health_data') {
    requireMcpTool(auth, config, method);
    requireScope(auth, 'health:data:write');
    const input = params as unknown as FileImportInput;
    requireUserAccess(auth, input.user_id);
    input.organization_id = resolveOrganizationId(auth, config, input.organization_id);
    const payload = decodeImportBuffer(input);
    const text = input.category === 'genetics' ? '' : payload.toString('utf8');
    const source = buildSourceReference(input, payload);
    const observations = normalizeImportedFile(source, text);
    await store.saveSource(source, observations, input.category === 'genetics' ? payload : undefined);
    return { source, normalized_observations: observations };
  }

  if (method === 'start_genetics_upload') {
    requireMcpTool(auth, config, method);
    requireScope(auth, 'health:data:write');
    const input = params as { user_id: string; organization_id?: string; filename: string; byte_length: number; content_type?: string; provider?: string };
    requireUserAccess(auth, input.user_id);
    const organizationId = resolveOrganizationId(auth, config, input.organization_id);
    if (!organizationId) throw new Error('organization_id is required for direct genetics uploads.');
    const filename = validatedDirectGeneticsFilename(input.filename);
    const byteLength = validatedDirectGeneticsBytes(input.byte_length);
    const directStore = directGeneticsUploadStore(store);
    if (!directStore) throw new Error('Direct genetics upload is unavailable on this deployment. Configure S3-compatible object storage.');
    const source: RawSourceReference = {
      id: createId('src'), user_id: input.user_id, organization_id: organizationId,
      category: 'genetics', provider: input.provider, filename,
      content_type: input.content_type || directGeneticsContentType(filename),
      received_at: new Date().toISOString(), byte_length: byteLength,
      storage_mode: 'durable', upload_status: 'pending',
    };
    const objectKey = geneticUploadPayloadKey(source, organizationId);
    const upload = await directStore.createSignedPayloadUpload(objectKey, source.content_type);
    await store.saveSource(source, normalizeImportedFile(source, ''), undefined, objectKey);
    return directGeneticsUploadSession(source, upload);
  }

  if (method === 'complete_genetics_upload') {
    requireMcpTool(auth, config, method);
    requireScope(auth, 'health:data:write');
    const input = params as { source_id: string; user_id: string; organization_id?: string };
    requireUserAccess(auth, input.user_id);
    const organizationId = resolveOrganizationId(auth, config, input.organization_id);
    if (!organizationId) throw new Error('organization_id is required for direct genetics uploads.');
    const source = await store.getSource(input.source_id);
    if (!source || source.category !== 'genetics') throw new Error('Genetics upload session not found.');
    requireResourceAccess(auth, config, { userId: source.user_id, organizationId: source.organization_id });
    if (source.user_id !== input.user_id || source.organization_id !== organizationId) throw new Error('Access denied.');
    const directStore = directGeneticsUploadStore(store);
    if (!directStore) throw new Error('Direct genetics upload is unavailable on this deployment. Configure S3-compatible object storage.');
    const objectKey = geneticUploadPayloadKey(source, organizationId);
    const byteLength = await directStore.uploadedPayloadSize(objectKey);
    if (!byteLength) throw new Error('The direct upload is not available yet. Finish the upload before completing it.');
    source.byte_length = validatedDirectGeneticsBytes(byteLength);
    source.upload_status = 'complete';
    const observations = normalizeImportedFile(source, '');
    await store.saveSource(source, observations, undefined, objectKey);
    return { source, normalized_observations: observations };
  }

  if (method === 'connect_health_source') {
    requireMcpTool(auth, config, method);
    requireScope(auth, 'health:connections:write');
    return buildOAuthUrl(params.provider as ProviderId, params as unknown as OAuthUrlRequest);
  }

  if (method === 'run_health_analysis') {
    requireMcpTool(auth, config, method);
    requireScope(auth, 'health:data:write');
    const input = params as unknown as { user_id: string; organization_id?: string; source_ids: string[]; profile?: { age?: number; sex?: 'male' | 'female' }; annotation_depth?: GeneticsAnnotationDepth };
    requireUserAccess(auth, input.user_id);
    const organizationId = resolveOrganizationId(auth, config, input.organization_id);
    const sources = await store.getSourcesForUserAndOrganization(input.source_ids, input.user_id, organizationId);
    if (sources.length !== input.source_ids.length) throw new Error('One or more source_ids were not found for this user.');
    const annotationDepth = normalizeMcpAnnotationDepth(input.annotation_depth);
    if (annotationDepth === 'full_dbsnp' && !sources.some(source => source.category === 'genetics')) {
      throw new McpToolError(-32602, 'annotation_depth is only valid when source_ids includes a genetics source.', 'invalid_annotation_depth', 'Include a genetics source or omit annotation_depth.');
    }
    await enforceMcpFullDbsnpAccess(auth, config, organizationId, annotationDepth);
    const baseAnalysis = runHealthAnalysis(input.user_id, sources, await store.getObservations(input.source_ids), input.profile, organizationId, { annotation_depth: annotationDepth });
    if (requiresQueuedGeneticPreSave(sources)) await store.saveAnalysis(baseAnalysis);
    const result = await enrichAnalysisWithGeneticPipeline(baseAnalysis, sources, store, { annotation_depth: annotationDepth });
    await store.saveAnalysis(result);
    return result;
  }

  const scopedAnalysis = {
    derive_biomarkers: { modality: 'biomarkers' as const, operation: 'derive' as const },
    analyze_biomarkers: { modality: 'biomarkers' as const, operation: 'analyze' as const },
    analyze_wearables: { modality: 'wearables' as const, operation: 'analyze' as const },
    analyze_genetics: { modality: 'genetics' as const, operation: 'analyze' as const },
  }[method];
  if (scopedAnalysis) {
    requireMcpTool(auth, config, method);
    requireScope(auth, 'health:data:write');
    const input = params as unknown as { user_id: string; organization_id?: string; source_ids: string[]; profile?: { age?: number; sex?: 'male' | 'female' }; annotation_depth?: GeneticsAnnotationDepth };
    requireUserAccess(auth, input.user_id);
    const organizationId = resolveOrganizationId(auth, config, input.organization_id);
    const sources = await store.getSourcesForUserAndOrganization(input.source_ids, input.user_id, organizationId);
    if (sources.length !== input.source_ids.length) throw new Error('One or more source_ids were not found for this user.');
    if (sources.some(source => source.category !== scopedAnalysis.modality)) {
      throw new Error(`All source_ids must reference ${scopedAnalysis.modality} sources.`);
    }
    const annotationDepth = normalizeMcpAnnotationDepth(input.annotation_depth);
    if (annotationDepth === 'full_dbsnp' && scopedAnalysis.modality !== 'genetics') {
      throw new McpToolError(-32602, 'annotation_depth is only valid for genetics analyses.', 'invalid_annotation_depth', 'Call analyze_genetics for full dbSNP annotation.');
    }
    await enforceMcpFullDbsnpAccess(auth, config, organizationId, annotationDepth);
    const baseAnalysis = runHealthAnalysis(
      input.user_id,
      sources,
      await store.getObservations(input.source_ids),
      input.profile,
      organizationId,
      { ...scopedAnalysis, annotation_depth: annotationDepth },
    );
    if (requiresQueuedGeneticPreSave(sources)) await store.saveAnalysis(baseAnalysis);
    const result = await enrichAnalysisWithGeneticPipeline(baseAnalysis, sources, store, { annotation_depth: annotationDepth });
    await store.saveAnalysis(result);
    return result;
  }

  if (method === 'query_health_context') {
    requireMcpTool(auth, config, method);
    requireScope(auth, 'health:data:read');
    const input = params as unknown as { user_id: string; organization_id?: string; query: string; analysis_ids?: string[] };
    requireUserAccess(auth, input.user_id);
    const organizationId = resolveOrganizationId(auth, config, input.organization_id);
    const organizationIds = organizationId ? new Set([organizationId]) : auth.organizationIds;
    const analyses = await store.getAnalysesForUser(input.analysis_ids ?? [], input.user_id, organizationIds);
    return queryHealthContext(await store.getUserObservations(input.user_id, organizationIds), analyses, input.query);
  }

  if (method === 'get_health_context') {
    requireMcpTool(auth, config, method);
    requireScope(auth, 'health:data:read');
    const input = params as unknown as { user_id: string; organization_id?: string; analysis_ids?: string[]; max_findings?: number };
    requireUserAccess(auth, input.user_id);
    const organizationId = resolveOrganizationId(auth, config, input.organization_id);
    const organizationIds = organizationId ? new Set([organizationId]) : auth.organizationIds;
    return buildHealthContext({
      userId: input.user_id,
      organizationId,
      observations: await store.getUserObservations(input.user_id, organizationIds),
      analyses: await store.getAnalysesForUser(input.analysis_ids ?? [], input.user_id, organizationIds),
      maxFindings: input.max_findings,
    });
  }

  if (method === 'get_dashboard_spec' || method === 'create_dashboard_spec') {
    requireMcpTool(auth, config, method);
    requireScope(auth, 'health:data:read');
    const analysis = await store.getAnalysis(String(params.analysis_id ?? ''));
    if (!analysis) throw new Error('Analysis not found.');
    requireResourceAccess(auth, config, { userId: analysis.user_id, organizationId: analysis.organization_id });
    return analysis.dashboard_spec;
  }

  if (method === 'get_design_implementation') {
    requireMcpTool(auth, config, method);
    requireScope(auth, 'health:data:read');
    const designId = typeof params.design_id === 'string' ? params.design_id.trim() : 'meridian';
    const implementation = await getDesignImplementation(designId, baseUrl);
    if (!implementation) throw new Error('Design implementation not found. Use design_id "aperture" or "meridian".');
    return implementation;
  }

  if (method === 'create_private_dashboard_link') {
    requireMcpTool(auth, config, method);
    requireScope(auth, 'health:data:read');
    const analysisId = typeof params.analysis_id === 'string' ? params.analysis_id.trim() : '';
    const designId = typeof params.design_id === 'string' ? params.design_id.trim() : '';
    if (!analysisId) throw new Error('analysis_id is required.');
    if (!designId) throw new Error('design_id is required. Choose one from GET /design/systems.');
    const analysis = await store.getAnalysis(analysisId);
    if (!analysis) throw new Error('Analysis not found.');
    requireResourceAccess(auth, config, { userId: analysis.user_id, organizationId: analysis.organization_id });
    const design = getDesignSystem(designId);
    if (!design) throw new Error('Unknown design_id. Choose one from GET /design/systems.');
    return createPrivateDashboardLink({
      analysisId: analysis.id,
      dashboardSpec: analysis.dashboard_spec,
      design,
      expiresInDays: params.expires_in_days as number | undefined,
      secret: config.apiKeySecret ?? config.serviceAccountSecret,
      baseUrl,
      requireHttps: config.requireHttps,
    });
  }

  if (method === 'list_analyses') {
    requireMcpTool(auth, config, method);
    requireScope(auth, 'health:data:read');
    const input = params as unknown as { user_id: string; organization_id?: string; modality?: string; limit?: number };
    requireUserAccess(auth, input.user_id);
    const organizationId = resolveOrganizationId(auth, config, input.organization_id);
    const organizationIds = organizationId ? new Set([organizationId]) : auth.organizationIds;
    const analyses = (await store.getAnalysesForUser([], input.user_id, organizationIds))
      .filter(analysis => input.modality == null || analysis.modality === input.modality)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const limited = analyses.slice(0, clampMcpLimit(input.limit));
    return { analyses: limited.map(summarizeAnalysis), count: limited.length, total: analyses.length };
  }

  if (method === 'list_sources') {
    requireMcpTool(auth, config, method);
    requireScope(auth, 'health:data:read');
    const input = params as unknown as { user_id: string; organization_id?: string; category?: string; limit?: number };
    requireUserAccess(auth, input.user_id);
    const organizationId = resolveOrganizationId(auth, config, input.organization_id);
    const organizationIds = organizationId ? new Set([organizationId]) : auth.organizationIds;
    const sources = (await store.listSourcesForUser(input.user_id, organizationIds))
      .filter(source => input.category == null || source.category === input.category)
      .sort((a, b) => b.received_at.localeCompare(a.received_at));
    const limited = sources.slice(0, clampMcpLimit(input.limit));
    return { sources: limited, count: limited.length, total: sources.length };
  }

  if (method === 'get_recommendations') {
    requireMcpTool(auth, config, method);
    requireScope(auth, 'health:data:read');
    const analysis = await store.getAnalysis(String(params.analysis_id ?? ''));
    if (!analysis) throw new Error('Analysis not found.');
    requireResourceAccess(auth, config, { userId: analysis.user_id, organizationId: analysis.organization_id });
    return buildRecommendations(analysis);
  }

  if (method === 'get_action_plan') {
    requireMcpTool(auth, config, method);
    requireScope(auth, 'health:data:read');
    const analysis = await store.getAnalysis(String(params.analysis_id ?? ''));
    if (!analysis) throw new Error('Analysis not found.');
    requireResourceAccess(auth, config, { userId: analysis.user_id, organizationId: analysis.organization_id });
    return buildActionPlan(analysis);
  }

  if (method === 'find_providers') {
    requireMcpTool(auth, config, method);
    requireScope(auth, 'health:data:read');
    return findProviders({
      modalities: Array.isArray(params.modality) ? (params.modality as ProviderModality[]) : undefined,
      type: typeof params.type === 'string' ? params.type : undefined,
      region: typeof params.region === 'string' ? params.region : undefined,
      lab_provider: params.lab_provider === 'quest' || params.lab_provider === 'synlab' || params.lab_provider === 'all' ? params.lab_provider : undefined,
      postal_code: typeof params.postal_code === 'string' ? params.postal_code : undefined,
      city: typeof params.city === 'string' ? params.city : undefined,
      country: typeof params.country === 'string' ? params.country : undefined,
      lat: typeof params.lat === 'number' ? params.lat : undefined,
      lon: typeof params.lon === 'number' ? params.lon : undefined,
      radius_miles: typeof params.radius_miles === 'number' ? params.radius_miles : undefined,
    });
  }

  if (method === 'get_health_trends') {
    requireMcpTool(auth, config, method);
    requireScope(auth, 'health:data:read');
    const input = params as unknown as { user_id: string; organization_id?: string; markers?: string[]; modality?: 'biomarkers' | 'wearables'; window_days?: number };
    requireUserAccess(auth, input.user_id);
    const organizationId = resolveOrganizationId(auth, config, input.organization_id);
    const organizationIds = organizationId ? new Set([organizationId]) : auth.organizationIds;
    const [observations, sources] = await Promise.all([
      store.getUserObservations(input.user_id, organizationIds),
      store.listSourcesForUser(input.user_id, organizationIds),
    ]);
    return buildHealthTrends({ userId: input.user_id, organizationId, observations, sources, options: { markers: input.markers, modality: input.modality, windowDays: input.window_days } });
  }

  if (method === 'find_nearby_labs') {
    requireMcpTool(auth, config, method);
    requireScope(auth, 'health:labs:read');
    return { results: await searchLabs(params as any) };
  }

  if (method === 'list_wgs_providers') {
    requireMcpTool(auth, config, method);
    requireScope(auth, 'health:data:read');
    const type = typeof params.type === 'string' ? params.type : 'all';
    const region = typeof params.region === 'string' ? params.region : undefined;
    return { providers: listWgsProviders({ type, region }) };
  }

  if (method === 'list_capabilities') {
    requireMcpTool(auth, config, method);
    requireScope(auth, 'health:data:read');
    return capabilitiesCatalog({
      fullDbsnpConfigured: process.env.HEALTH_ANALYSIS_FULL_DBSNP_ENABLED === 'true'
        && Boolean(process.env.HEALTH_ANALYSIS_DBSNP_GRCH37_PATH),
    });
  }

  throw new McpToolError(-32602, `Unknown MCP tool: ${method}`, 'unknown_tool', 'Call tools/list and use one of the returned tool names.');
}

function availableMcpTools(auth: AuthContext, config: AuthConfig): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return [
    'upload_health_data',
    'start_genetics_upload',
    'complete_genetics_upload',
    'connect_health_source',
    'list_capabilities',
    'run_health_analysis',
    'derive_biomarkers',
    'analyze_biomarkers',
    'analyze_wearables',
    'analyze_genetics',
    'query_health_context',
    'get_health_context',
    'get_dashboard_spec',
    'get_design_implementation',
    'create_private_dashboard_link',
    'list_analyses',
    'list_sources',
    'get_recommendations',
    'get_action_plan',
    'get_health_trends',
    'find_providers',
    'find_nearby_labs',
    'list_wgs_providers',
  ].filter(tool => {
    const endpoint = endpointByMcpTool(mcpEndpointTool(tool));
    if (!endpoint) return false;
    if (!isEndpointEnabled(auth, config, endpoint.id)) return false;
    return endpoint.scopes.every(scope => hasScope(auth, scope));
  }).map(tool => ({
    name: tool,
    description: directGeneticsToolDescription(tool) ?? endpointByMcpTool(mcpEndpointTool(tool))?.description ?? tool,
    inputSchema: toolInputSchemas[tool] ?? { type: 'object', additionalProperties: true },
  }));
}

function requireMcpTool(auth: AuthContext, config: AuthConfig, tool: string): void {
  const endpoint = endpointByMcpTool(mcpEndpointTool(tool));
  if (!endpoint) throw new Error(`Unknown MCP tool: ${tool}`);
  requireEndpointAccess(auth, config, endpoint.id);
}

function legacyToolNames(): Set<string> {
  return new Set(['upload_health_data', 'start_genetics_upload', 'complete_genetics_upload', 'connect_health_source', 'list_capabilities', 'run_health_analysis', 'derive_biomarkers', 'analyze_biomarkers', 'analyze_wearables', 'analyze_genetics', 'query_health_context', 'get_health_context', 'get_dashboard_spec', 'create_dashboard_spec', 'get_design_implementation', 'create_private_dashboard_link', 'list_analyses', 'list_sources', 'get_recommendations', 'get_action_plan', 'get_health_trends', 'find_providers', 'find_nearby_labs', 'list_wgs_providers']);
}

function mcpEndpointTool(tool: string): string {
  if (tool === 'create_dashboard_spec') return 'get_dashboard_spec';
  // HTTP direct uploads intentionally use the existing imports.file grant so
  // deployed scoped keys do not need to be reissued merely to bypass a proxy.
  if (tool === 'start_genetics_upload' || tool === 'complete_genetics_upload') return 'upload_health_data';
  return tool;
}

function directGeneticsToolDescription(tool: string): string | undefined {
  if (tool === 'start_genetics_upload') return 'Create a private direct-upload session for VCF, SNP-array, or 23andMe-style raw genetics data. PUT the file to the returned signed URL; it bypasses the API server and CDN.';
  if (tool === 'complete_genetics_upload') return 'Verify a completed direct genetics upload and mark its source ready for genetics or ancestry analysis.';
  return undefined;
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

function validatedDirectGeneticsFilename(filename: string): string {
  const value = filename.trim().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160);
  if (!/\.(vcf|txt|tsv|csv|snp|raw)(\.gz)?$/i.test(value)) {
    throw new Error('Genetics uploads must be VCF/VCF.GZ or a SNP-array raw export (.txt, .tsv, .csv, .snp, or .raw; optional .gz).');
  }
  return value;
}

function directGeneticsContentType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.gz')) return 'application/gzip';
  if (lower.endsWith('.vcf')) return 'text/vcf';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.tsv')) return 'text/tab-separated-values';
  return 'text/plain';
}

function validatedDirectGeneticsBytes(value: number): number {
  const maxBytes = Number(process.env.MAX_GENETICS_UPLOAD_BYTES ?? 512 * 1024 * 1024);
  if (!Number.isFinite(value) || value <= 0) throw new Error('byte_length must be a positive number.');
  if (value > maxBytes) throw new Error(`Genetics upload exceeds the configured ${Math.round(maxBytes / (1024 * 1024))} MB limit.`);
  return Math.floor(value);
}

function directGeneticsUploadSession(source: RawSourceReference, upload: SignedPayloadUpload): Record<string, unknown> {
  return {
    source_id: source.id,
    status: 'uploading',
    source,
    upload: {
      protocol: 's3-presigned-put', url: upload.upload_url, method: upload.method,
      headers: upload.headers, expires_in_seconds: upload.expires_in_seconds,
      object: { bucket_name: upload.bucket_name, object_key: upload.object_key, content_type: source.content_type },
    },
    finalize: { method: 'POST', endpoint: '/mcp', tool: 'complete_genetics_upload', body: { source_id: source.id, user_id: source.user_id, organization_id: source.organization_id } },
  };
}

function clampMcpLimit(limit: unknown): number {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) return 50;
  return Math.min(Math.floor(value), 200);
}

function requiresQueuedGeneticPreSave(sources: Array<{ category: string }>): boolean {
  const mode = process.env.HEALTH_ANALYSIS_EXECUTION_MODE ?? process.env.GENOMIC_ANALYSIS_EXECUTION_MODE;
  return mode === 'queue' && sources.some(source => source.category === 'genetics');
}

function normalizeMcpAnnotationDepth(value: unknown): GeneticsAnnotationDepth | undefined {
  if (value == null || value === '') return undefined;
  if (value === 'compact' || value === 'full_dbsnp') return value;
  throw new McpToolError(-32602, 'annotation_depth must be "compact" or "full_dbsnp".', 'invalid_annotation_depth', 'Use compact or full_dbsnp.');
}

async function enforceMcpFullDbsnpAccess(
  auth: AuthContext,
  authConfig: AuthConfig,
  organizationId: string | undefined,
  annotationDepth: GeneticsAnnotationDepth | undefined,
): Promise<void> {
  if (annotationDepth !== 'full_dbsnp') return;
  if (process.env.HEALTH_ANALYSIS_FULL_DBSNP_ENABLED !== 'true' || !process.env.HEALTH_ANALYSIS_DBSNP_GRCH37_PATH) {
    throw new McpToolError(-32003, 'Full dbSNP annotation is not provisioned on this deployment.', 'full_dbsnp_unavailable', 'Use compact annotation or ask the operator to configure the GRCh37 dbSNP worker reference.');
  }
  if (isBillingAdmin(auth, authConfig)) return;
  const billingConfig = stripeBillingConfig();
  if (billingConfig) {
    if (!organizationId) throw new McpToolError(-32602, 'organization_id is required for hosted full dbSNP annotation.', 'organization_required', 'Include organization_id in the tool arguments.');
    try {
      await new StripeBillingService(billingConfig).assertFullDbsnpAccess(auth.userId, organizationId);
    } catch (error) {
      throw new McpToolError(-32004, error instanceof Error ? error.message : 'Full dbSNP billing eligibility could not be verified.', 'full_dbsnp_billing_required', 'Add a valid payment method and active eligible subscription, then retry.');
    }
  }
}

class McpToolError extends Error {
  constructor(
    public code: number,
    message: string,
    public reason: string,
    public fix: string,
  ) {
    super(message);
  }
}

function mcpError(error: unknown, requestId?: string) {
  if (error instanceof McpToolError) {
    return {
      code: error.code,
      message: error.message,
      data: { code: error.reason, fix: error.fix, docs_url: '/.well-known/health-agent.json', request_id: requestId },
    };
  }
  return {
    code: -32000,
    message: error instanceof Error ? error.message : String(error),
    data: {
      code: 'tool_error',
      cause: error instanceof Error ? error.name : 'Error',
      fix: 'Check the tool arguments, token scopes, enabled endpoint claims, and organization_id.',
      docs_url: '/.well-known/health-agent.json',
      request_id: requestId,
    },
  };
}

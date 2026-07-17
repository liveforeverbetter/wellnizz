import type { AuthScope } from './auth.js';

export type EndpointId =
  | 'imports.file'
  | 'genetics.uploads.create'
  | 'genetics.uploads.complete'
  | 'capabilities.read'
  | 'pricing.read'
  | 'billing.subscription.read'
  | 'billing.checkout.create'
  | 'billing.portal.create'
  | 'api_keys.create'
  | 'webhooks.read'
  | 'connections.start'
  | 'connections.callback'
  | 'connections.auth_url'
  | 'connections.token'
  | 'connections.refresh'
  | 'connections.sync'
  | 'connections.jobs.read'
  | 'analyses.create'
  | 'analyses.read'
  | 'analyses.list'
  | 'analyses.recommendations.read'
  | 'analyses.action_plan.read'
  | 'sources.list'
  | 'sources.read'
  | 'trends.read'
  | 'biomarkers.derive'
  | 'biomarkers.analyze'
  | 'wearables.analyze'
  | 'genetics.analyze'
  | 'genetics.ancestry.create'
  | 'genetics.jobs.read'
  | 'design_implementation.read'
  | 'dashboard_specs.read'
  | 'dashboard_links.create'
  | 'health_context.read'
  | 'goals.create'
  | 'goals.list'
  | 'goals.read'
  | 'goals.update'
  | 'goals.delete'
  | 'retest_reminders.read'
  | 'query.create'
  | 'providers.search'
  | 'labs.search'
  | 'wgs_providers.list'
  | 'wgs_providers.read'
  | 'data.export'
  | 'data.delete';

export interface EndpointDefinition {
  id: EndpointId;
  method: 'GET' | 'POST';
  path: string;
  category: string;
  scopes: AuthScope[];
  description: string;
  mcpTool?: string;
}

/**
 * Read-only operations that expose or compute data for the authenticated user.
 *
 * These are deliberately separate from operations that merely happen to use a
 * read scope. Exporting data, issuing keys, and starting ancestry computation
 * can disclose data, create authority, or consume meaningful compute, so they
 * remain explicit endpoint grants.
 */
export const DEFAULT_USER_DATA_READ_ENDPOINTS: ReadonlySet<EndpointId> = new Set([
  'webhooks.read',
  'analyses.read',
  'analyses.list',
  'analyses.recommendations.read',
  'analyses.action_plan.read',
  'sources.list',
  'sources.read',
  'trends.read',
  'genetics.jobs.read',
  'design_implementation.read',
  'dashboard_specs.read',
  'health_context.read',
  'goals.list',
  'goals.read',
  'retest_reminders.read',
  'query.create',
]);

export const ENDPOINTS: EndpointDefinition[] = [
  {
    id: 'capabilities.read',
    method: 'GET',
    path: '/capabilities',
    category: 'capabilities',
    scopes: ['health:data:read'],
    mcpTool: 'list_capabilities',
    description: 'List supported wellness data modalities, providers, setup requirements, and normalized outputs.',
  },
  {
    id: 'pricing.read',
    method: 'GET',
    path: '/pricing',
    category: 'pricing',
    scopes: ['health:data:read'],
    description: 'List public pricing tiers, rate limits, quotas, and caching behavior.',
  },
  {
    id: 'billing.subscription.read',
    method: 'GET',
    path: '/billing/subscription',
    category: 'billing',
    scopes: ['health:data:read'],
    description: 'Read the authenticated workspace’s hosted billing status and current subscription tier.',
  },
  {
    id: 'billing.checkout.create',
    method: 'POST',
    path: '/billing/checkout',
    category: 'billing',
    scopes: ['health:data:read'],
    description: 'Create a Stripe-hosted Checkout session after the introductory hosted request allowance, with a required payment method for a Standard, Builder, or Growth subscription.',
  },
  {
    id: 'billing.portal.create',
    method: 'POST',
    path: '/billing/portal',
    category: 'billing',
    scopes: ['health:data:read'],
    description: 'Create a Stripe Billing Portal session for the authenticated workspace.',
  },
  {
    id: 'api_keys.create',
    method: 'POST',
    path: '/api-keys',
    category: 'api_keys',
    scopes: ['health:data:read'],
    description: 'Issue a scoped bearer API key for an authenticated user or organization.',
  },
  {
    id: 'webhooks.read',
    method: 'GET',
    path: '/webhook-events',
    category: 'webhooks',
    scopes: ['health:data:read'],
    description: 'Read completion events for imports, analyses, wearable syncs, exports, and deletion receipts.',
  },
  {
    id: 'connections.start',
    method: 'POST',
    path: '/connections/wearables/start',
    category: 'connections',
    scopes: ['health:connections:write'],
    description: 'Start a generic wearables connection flow for a supported source provider.',
  },
  {
    id: 'connections.callback',
    method: 'POST',
    path: '/connections/wearables/callback',
    category: 'connections',
    scopes: ['health:connections:write'],
    description: 'Complete a generic wearables OAuth callback and register the connected account.',
  },
  {
    id: 'imports.file',
    method: 'POST',
    path: '/imports/file',
    category: 'imports',
    scopes: ['health:data:write'],
    mcpTool: 'upload_health_data',
    description: 'Upload small biomarker, wearable, behavioral, or genetic text data. NEVER use this endpoint for VCF/VCF.GZ or large SNP/23andMe files; use POST /genetics/uploads and its signed PUT URL because this endpoint traverses Cloudflare and has a request-body limit.',
  },
  {
    id: 'genetics.uploads.create',
    method: 'POST',
    path: '/genetics/uploads',
    category: 'genetics',
    scopes: ['health:data:write'],
    description: 'Create a private direct-upload session for VCF, SNP-array, or 23andMe-style raw genetics data. The file body bypasses the API server and CDN.',
  },
  {
    id: 'genetics.uploads.complete',
    method: 'POST',
    path: '/genetics/uploads/:id/complete',
    category: 'genetics',
    scopes: ['health:data:write'],
    description: 'Verify the directly uploaded genetic file, mark the genetics source complete, and make it eligible for queued analysis.',
  },
  {
    id: 'connections.auth_url',
    method: 'POST',
    path: '/connections/:provider/auth-url',
    category: 'connections',
    scopes: ['health:connections:write'],
    mcpTool: 'connect_health_source',
    description: 'Build an OAuth authorization URL for WHOOP or Oura. (Google Health Connect connects via the mobile bridge through /connections/wearables/start.)',
  },
  {
    id: 'connections.token',
    method: 'POST',
    path: '/connections/:provider/token',
    category: 'connections',
    scopes: ['health:connections:write'],
    description: 'Exchange a provider OAuth code for provider tokens.',
  },
  {
    id: 'connections.refresh',
    method: 'POST',
    path: '/connections/:provider/refresh',
    category: 'connections',
    scopes: ['health:connections:write'],
    description: 'Exchange a provider refresh token for a fresh access token (WHOOP) so long-running syncs do not expire.',
  },
  {
    id: 'connections.sync',
    method: 'POST',
    path: '/api/v1/sdk/users/:user_id/sync',
    category: 'connections',
    scopes: ['health:connections:write'],
    description: 'Push user-authorized Google Health Connect readings through the stable ForeverBetter mobile SDK envelope.',
  },
  {
    id: 'connections.jobs.read',
    method: 'GET',
    path: '/connections/wearables/jobs/:id',
    category: 'connections',
    scopes: ['health:connections:write'],
    description: 'Read queued wearable sync job status.',
  },
  {
    id: 'analyses.create',
    method: 'POST',
    path: '/analyses',
    category: 'analyses',
    scopes: ['health:data:write'],
    mcpTool: 'run_health_analysis',
    description: 'Run a health analysis from uploaded source IDs.',
  },
  {
    id: 'analyses.read',
    method: 'GET',
    path: '/analyses/:id',
    category: 'analyses',
    scopes: ['health:data:read'],
    description: 'Read a stored analysis result for the authenticated user.',
  },
  {
    id: 'analyses.list',
    method: 'GET',
    path: '/analyses',
    category: 'analyses',
    scopes: ['health:data:read'],
    mcpTool: 'list_analyses',
    description: 'List stored analyses for the authenticated user with optional modality, since, and limit filters.',
  },
  {
    id: 'analyses.recommendations.read',
    method: 'GET',
    path: '/analyses/:id/recommendations',
    category: 'analyses',
    scopes: ['health:data:read'],
    mcpTool: 'get_recommendations',
    description: 'Read prioritized, de-duplicated action items derived from a stored analysis.',
  },
  {
    id: 'analyses.action_plan.read',
    method: 'GET',
    path: '/analyses/:id/action-plan',
    category: 'analyses',
    scopes: ['health:data:read'],
    mcpTool: 'get_action_plan',
    description: 'Build a customized action plan (lifestyle interventions + an evidence-graded supplement stack) mapped from a stored analysis, cross-referenced against the user\'s logged supplements and medications.',
  },
  {
    id: 'sources.list',
    method: 'GET',
    path: '/sources',
    category: 'imports',
    scopes: ['health:data:read'],
    mcpTool: 'list_sources',
    description: 'List uploaded source documents for the authenticated user with optional category, since, and limit filters.',
  },
  {
    id: 'sources.read',
    method: 'GET',
    path: '/sources/:id',
    category: 'imports',
    scopes: ['health:data:read'],
    description: 'Read a single uploaded source with its normalized observations.',
  },
  {
    id: 'trends.read',
    method: 'POST',
    path: '/users/:user_id/trends',
    category: 'health_context',
    scopes: ['health:data:read'],
    mcpTool: 'get_health_trends',
    description: 'Compute longitudinal biomarker and wearable trends (direction, delta, and status) across all uploads for a user.',
  },
  {
    id: 'biomarkers.derive',
    method: 'POST',
    path: '/biomarkers/derive',
    category: 'biomarkers',
    scopes: ['health:data:write'],
    mcpTool: 'derive_biomarkers',
    description: 'Calculate supported derived biomarkers from existing uploaded lab sources.',
  },
  {
    id: 'biomarkers.analyze',
    method: 'POST',
    path: '/biomarkers/analyze',
    category: 'biomarkers',
    scopes: ['health:data:write'],
    mcpTool: 'analyze_biomarkers',
    description: 'Interpret direct and derived biomarker results from existing uploaded lab sources.',
  },
  {
    id: 'wearables.analyze',
    method: 'POST',
    path: '/wearables/analyze',
    category: 'wearables',
    scopes: ['health:data:write'],
    mcpTool: 'analyze_wearables',
    description: 'Analyze sleep, recovery, activity, and cardiovascular observations from wearable sources.',
  },
  {
    id: 'genetics.analyze',
    method: 'POST',
    path: '/genetics/analyze',
    category: 'genetics',
    scopes: ['health:data:write'],
    mcpTool: 'analyze_genetics',
    description: 'Start a genetics-only analysis for uploaded VCF, WGS, or SNP-array sources.',
  },
  {
    id: 'genetics.ancestry.create',
    method: 'POST',
    path: '/genetics/ancestry',
    category: 'genetics',
    scopes: ['health:data:read'],
    description: 'Prepare ancestry analysis for an uploaded genetic source and return reference-panel setup requirements or ancestry proportions when the ancestry worker is configured.',
  },
  {
    id: 'genetics.jobs.read',
    method: 'GET',
    path: '/genetics/jobs/:id',
    category: 'genetics',
    scopes: ['health:data:read'],
    description: 'Read queued WGS/SNP-array analysis job status.',
  },
  {
    id: 'design_implementation.read',
    method: 'GET',
    path: '/design/systems/:id/implementation',
    category: 'design_systems',
    scopes: ['health:data:read'],
    mcpTool: 'get_design_implementation',
    description: 'Get the exact production Meridian dashboard HTML, CSS, JavaScript, binary asset URLs, component map, and API bindings so an agent can build the corresponding app.',
  },
  {
    id: 'dashboard_specs.read',
    method: 'GET',
    path: '/dashboard-specs/:analysis_id',
    category: 'dashboard_specs',
    scopes: ['health:data:read'],
    mcpTool: 'get_dashboard_spec',
    description: 'Read a dashboard-ready JSON spec for an analysis.',
  },
  {
    id: 'dashboard_links.create',
    method: 'POST',
    path: '/dashboard-links',
    category: 'dashboard_specs',
    scopes: ['health:data:read'],
    mcpTool: 'create_private_dashboard_link',
    description: 'Create an expiring, private-by-possession hosted dashboard URL for an analysis and selected design system.',
  },
  {
    id: 'goals.create',
    method: 'POST',
    path: '/users/:user_id/goals',
    category: 'goals',
    scopes: ['health:data:write'],
    description: 'Create a health goal (target metric, direction, value, and optional due date) for a user.',
  },
  {
    id: 'goals.list',
    method: 'GET',
    path: '/users/:user_id/goals',
    category: 'goals',
    scopes: ['health:data:read'],
    description: 'List a user\'s health goals with status.',
  },
  {
    id: 'goals.read',
    method: 'GET',
    path: '/goals/:id',
    category: 'goals',
    scopes: ['health:data:read'],
    description: 'Read a single health goal.',
  },
  {
    id: 'goals.update',
    method: 'POST',
    path: '/goals/:id',
    category: 'goals',
    scopes: ['health:data:write'],
    description: 'Update a health goal (target, due date, status, or note).',
  },
  {
    id: 'goals.delete',
    method: 'POST',
    path: '/goals/:id/delete',
    category: 'goals',
    scopes: ['health:data:write'],
    description: 'Delete a health goal.',
  },
  {
    id: 'retest_reminders.read',
    method: 'GET',
    path: '/users/:user_id/retest-reminders',
    category: 'reminders',
    scopes: ['health:data:read'],
    description: 'Compute retest reminders (due, upcoming, or current) from the freshest data per modality against a cadence.',
  },
  {
    id: 'query.create',
    method: 'POST',
    path: '/query',
    category: 'query',
    scopes: ['health:data:read'],
    mcpTool: 'query_health_context',
    description: 'Query normalized observations and derived interpretations.',
  },
  {
    id: 'health_context.read',
    method: 'POST',
    path: '/users/:user_id/health-context',
    category: 'health_context',
    scopes: ['health:data:read'],
    mcpTool: 'get_health_context',
    description: 'Read a bounded multimodal health context object for apps and agents.',
  },
  {
    id: 'providers.search',
    method: 'GET',
    path: '/providers',
    category: 'providers',
    scopes: ['health:data:read'],
    mcpTool: 'find_providers',
    description: 'Find where to get wellness data across modalities in one call: pass modality=genetics,biomarkers,wearables to get WGS/genetic-testing providers, nearby lab draw sites (with a location), and supported wearable integrations. Results are grouped by modality.',
  },
  {
    id: 'labs.search',
    method: 'GET',
    path: '/labs/search',
    category: 'labs',
    scopes: ['health:labs:read'],
    mcpTool: 'find_nearby_labs',
    description: 'Find Quest and SYNLAB patient service centers near a user-selected area. Returns real locations via partner APIs when available, with locator handoff fallback.',
  },
  {
    id: 'wgs_providers.list',
    method: 'GET',
    path: '/wgs-providers',
    category: 'genetics',
    scopes: ['health:data:read'],
    mcpTool: 'list_wgs_providers',
    description: 'List whole genome sequencing (WGS), exome, and SNP array providers with pricing, turnaround, data formats, and regional availability.',
  },
  {
    id: 'wgs_providers.read',
    method: 'GET',
    path: '/wgs-providers/:id',
    category: 'genetics',
    scopes: ['health:data:read'],
    description: 'Get details for a specific genetic testing provider by id.',
  },
  {
    id: 'data.export',
    method: 'POST',
    path: '/users/:user_id/data/export',
    category: 'data',
    scopes: ['health:data:read'],
    description: 'Export tenant-scoped user data and return a portability receipt.',
  },
  {
    id: 'data.delete',
    method: 'POST',
    path: '/users/:user_id/data/delete',
    category: 'data',
    scopes: ['health:data:write'],
    description: 'Tombstone tenant-scoped user data for deletion/export workflows.',
  },
];

export const ENDPOINT_IDS = new Set<string>(ENDPOINTS.map(endpoint => endpoint.id));

export const ENDPOINT_CLAIM_ALIASES = new Map<string, EndpointId>([
  ['imports_file', 'imports.file'],
  ['upload_health_data', 'imports.file'],
  ['capabilities_read', 'capabilities.read'],
  ['list_capabilities', 'capabilities.read'],
  ['pricing_read', 'pricing.read'],
  ['api_keys_create', 'api_keys.create'],
  ['create_api_key', 'api_keys.create'],
  ['webhooks_read', 'webhooks.read'],
  ['webhook_events_read', 'webhooks.read'],
  ['connections_start', 'connections.start'],
  ['wearables_start', 'connections.start'],
  ['start_wearables_connection', 'connections.start'],
  ['connections_callback', 'connections.callback'],
  ['wearables_callback', 'connections.callback'],
  ['complete_wearables_connection', 'connections.callback'],
  ['connections_auth_url', 'connections.auth_url'],
  ['connect_health_source', 'connections.auth_url'],
  ['connections_token', 'connections.token'],
  ['connections_refresh', 'connections.refresh'],
  ['refresh_connection_token', 'connections.refresh'],
  ['connections_sync', 'connections.sync'],
  ['wearables_sync', 'connections.sync'],
  ['sync_wearables', 'connections.sync'],
  ['connections_jobs_read', 'connections.jobs.read'],
  ['wearables_jobs_read', 'connections.jobs.read'],
  ['wearable_sync_jobs_read', 'connections.jobs.read'],
  ['analyses_create', 'analyses.create'],
  ['run_health_analysis', 'analyses.create'],
  ['analyses_read', 'analyses.read'],
  ['analyses_list', 'analyses.list'],
  ['list_analyses', 'analyses.list'],
  ['analyses_recommendations_read', 'analyses.recommendations.read'],
  ['recommendations_read', 'analyses.recommendations.read'],
  ['get_recommendations', 'analyses.recommendations.read'],
  ['sources_list', 'sources.list'],
  ['list_sources', 'sources.list'],
  ['sources_read', 'sources.read'],
  ['trends_read', 'trends.read'],
  ['get_health_trends', 'trends.read'],
  ['health_trends_read', 'trends.read'],
  ['biomarkers_derive', 'biomarkers.derive'],
  ['derive_biomarkers', 'biomarkers.derive'],
  ['biomarkers_analyze', 'biomarkers.analyze'],
  ['analyze_biomarkers', 'biomarkers.analyze'],
  ['wearables_analyze', 'wearables.analyze'],
  ['analyze_wearables', 'wearables.analyze'],
  ['genetics_analyze', 'genetics.analyze'],
  ['analyze_genetics', 'genetics.analyze'],
  ['genetics_ancestry_create', 'genetics.ancestry.create'],
  ['ancestry_analysis_create', 'genetics.ancestry.create'],
  ['run_ancestry_analysis', 'genetics.ancestry.create'],
  ['genetics_jobs_read', 'genetics.jobs.read'],
  ['genetic_analysis_jobs_read', 'genetics.jobs.read'],
  ['dashboard_specs_read', 'dashboard_specs.read'],
  ['get_dashboard_spec', 'dashboard_specs.read'],
  ['create_dashboard_spec', 'dashboard_specs.read'],
  ['dashboard_links_create', 'dashboard_links.create'],
  ['create_private_dashboard_link', 'dashboard_links.create'],
  ['query_create', 'query.create'],
  ['query_health_context', 'query.create'],
  ['health_context_read', 'health_context.read'],
  ['get_health_context', 'health_context.read'],
  ['goals_create', 'goals.create'],
  ['create_goal', 'goals.create'],
  ['goals_list', 'goals.list'],
  ['list_goals', 'goals.list'],
  ['goals_read', 'goals.read'],
  ['goals_update', 'goals.update'],
  ['update_goal', 'goals.update'],
  ['goals_delete', 'goals.delete'],
  ['delete_goal', 'goals.delete'],
  ['retest_reminders_read', 'retest_reminders.read'],
  ['get_retest_reminders', 'retest_reminders.read'],
  ['labs_search', 'labs.search'],
  ['find_nearby_labs', 'labs.search'],
  ['wgs_providers_list', 'wgs_providers.list'],
  ['wgs_providers_read', 'wgs_providers.read'],
  ['list_wgs_providers', 'wgs_providers.list'],
  ['data_export', 'data.export'],
  ['export_user_data', 'data.export'],
  ['data_delete', 'data.delete'],
  ['delete_user_data', 'data.delete'],
]);

export function normalizeEndpointId(value: string): EndpointId | undefined {
  if (ENDPOINT_IDS.has(value)) return value as EndpointId;
  return ENDPOINT_CLAIM_ALIASES.get(value);
}

export function endpointById(id: EndpointId): EndpointDefinition {
  const endpoint = ENDPOINTS.find(item => item.id === id);
  if (!endpoint) throw new Error(`Unknown endpoint id: ${id}`);
  return endpoint;
}

export function endpointByMcpTool(tool: string): EndpointDefinition | undefined {
  return ENDPOINTS.find(endpoint => endpoint.mcpTool === tool);
}

export function endpointCatalog(enabledEndpointIds?: Set<string>) {
  const endpointItems = ENDPOINTS
    .filter(endpoint => enabledEndpointIds == null || enabledEndpointIds.size === 0 || enabledEndpointIds.has(endpoint.id))
    .map(endpoint => ({
      id: endpoint.id,
      claim_aliases: endpointClaimAliases(endpoint),
      method: endpoint.method,
      path: endpoint.path,
      category: endpoint.category,
      scopes: endpoint.scopes,
      mcp_tool: endpoint.mcpTool,
      description: endpoint.description,
    }));

  return {
    service: 'foreverbetter-api',
    public: [
      'GET /health',
      'GET /ready',
      'GET /endpoints',
      'GET /capabilities',
      'GET /pricing',
      'GET /design/systems',
      'GET /design/systems/:id',
      'GET /design/systems/:id/implementation',
      'GET /dashboards/private/:token',
      'GET /.well-known/health-agent.json',
      'POST /auth/otp/start',
      'POST /auth/otp/verify',
    ],
    protected: endpointItems,
    mcp: {
      endpoint: 'POST /mcp',
      tools: endpointItems.filter(endpoint => endpoint.mcp_tool).map(endpoint => ({
        name: endpoint.mcp_tool,
        endpoint_id: endpoint.id,
        scopes: endpoint.scopes,
        description: endpoint.description,
      })),
    },
  };
}

function endpointClaimAliases(endpoint: EndpointDefinition): string[] {
  const aliases = Array.from(ENDPOINT_CLAIM_ALIASES.entries())
    .filter(([, id]) => id === endpoint.id)
    .map(([alias]) => alias);
  return [endpoint.id, ...aliases];
}

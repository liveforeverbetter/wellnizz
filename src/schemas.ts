import { ENDPOINTS } from './endpoints.js';
import { SERVICE_VERSION } from './version.js';
import type { X402PublicConfig } from './x402.js';

type JsonSchema = Record<string, unknown>;

// Descriptions for infrastructure/auth routes that aren't in the scoped ENDPOINTS
// registry. Every other operation's description is sourced from ENDPOINTS so the
// spec, the /endpoints catalog, and the MCP tools stay in sync.
const INFRA_OPERATION_DESCRIPTIONS: Record<string, string> = {
  'GET /health': 'Liveness probe. Returns 200 whenever the process is running; does not check dependencies.',
  'GET /ready': 'Readiness probe. Returns 200 only when durable storage, authentication, email delivery configuration, and database migrations are healthy. Used by load balancers and orchestrators.',
  'GET /version': 'Service version and build metadata.',
  'GET /endpoints': 'Machine-readable catalog of every endpoint with its method, path, required scopes, and MCP tool name.',
  'GET /.well-known/health-agent.json': 'Agent discovery manifest: base URL, auth requirements, available endpoints, and MCP tool list, so an autonomous agent can self-configure.',
  'GET /.well-known/x402.json': 'Machine-readable x402 v2 networks, facilitators, route templates, prices, and payer-scoped identity behavior.',
  'GET /openapi.json': 'This OpenAPI 3.1 specification, generated from the same schema source the service validates requests against.',
  'GET /design/systems': 'List curated design-token sets for health & wellness UIs, inspired by well-known apps. Public reference data - no auth required.',
  'GET /design/systems/{}': 'Get a design system\'s full tokens (color, typography, spacing, radii, elevation, motion, components) plus a ready-to-paste DESIGN.md. Public reference data.',
  'GET /design/systems/{}/implementation': 'Get a full public design-system handoff: component source, declarations, prompts, tokens, templates, UI kits, manifest, and binary asset URLs. Meridian also includes its existing production dashboard package and bindings.',
  'POST /auth/otp/start': 'Send an 8-digit email sign-in code so a person can authorize an agent without a password.',
  'POST /auth/otp/verify': 'Verify an emailed one-time code and return an access token scoped to that user.',
  'POST /sandbox/sessions': 'Create a short-lived, synthetic-only sandbox session and return a complete multimodal demo result without persisting data.',
  'POST /sandbox/hero': 'Re-run the deterministic, non-persistent synthetic demo using a sandbox session token.',
  'POST /mcp': 'Model Context Protocol (MCP) JSON-RPC endpoint: handles initialize, tools/list, and tools/call over the same capabilities as the REST API.',
  'POST /analyses/{}/rerun': 'Re-run a stored analysis against its existing sources, producing a fresh analysis result and dashboard spec.',
};

function normalizeOpenApiPath(path: string): string {
  // Collapse both :param and {param} to a placeholder so ENDPOINTS paths
  // (/analyses/:id/...) match OpenAPI paths (/analyses/{id}/...).
  return path.replace(/(:[a-zA-Z_]+|\{[a-zA-Z_]+\})/g, '{}');
}

function operationDescriptionLookup(): Map<string, string> {
  const map = new Map<string, string>();
  for (const endpoint of ENDPOINTS) {
    map.set(`${endpoint.method} ${normalizeOpenApiPath(endpoint.path)}`, endpoint.description);
  }
  for (const [key, description] of Object.entries(INFRA_OPERATION_DESCRIPTIONS)) map.set(key, description);
  return map;
}

// Attach a description to every operation that lacks one, so the API reference
// shows what each endpoint actually does.
function attachOperationDescriptions(paths: Record<string, Record<string, unknown>>): void {
  const lookup = operationDescriptionLookup();
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!operation || typeof operation !== 'object') continue;
      const op = operation as { description?: string };
      if (op.description) continue;
      const description = lookup.get(`${method.toUpperCase()} ${normalizeOpenApiPath(path)}`);
      if (description) op.description = description;
    }
  }
}

function attachX402Operations(paths: Record<string, Record<string, unknown>>, x402?: X402PublicConfig): void {
  if (!x402?.enabled) return;
  for (const route of x402.routes) {
    const pathEntry = Object.entries(paths).find(([path]) => normalizeOpenApiPath(path) === normalizeOpenApiPath(route.path));
    const operation = pathEntry?.[1]?.[route.method.toLowerCase()];
    if (!operation || typeof operation !== 'object') continue;
    const paidOperation = operation as Record<string, unknown> & { responses?: Record<string, unknown> };
    paidOperation.security = [{ bearerAuth: [] }, { x402: [] }];
    paidOperation.responses = {
      ...(paidOperation.responses ?? {}),
      402: {
        description: 'Payment required. Choose a Base, Polygon, or Solana option from the PAYMENT-REQUIRED header and retry with PAYMENT-SIGNATURE.',
        headers: {
          'PAYMENT-REQUIRED': {
            description: 'Base64-encoded x402 v2 PaymentRequired object.',
            schema: { type: 'string' },
          },
        },
        content: { 'application/json': { schema: ref('X402PaymentRequired') } },
      },
    };
    paidOperation['x-x402'] = {
      price_usd: route.price_usd,
      endpoint_id: route.endpoint_id,
      networks: x402.networks,
      payment_header: x402.payment_header,
      settlement_header: x402.payment_response_header,
      bazaar_dynamic_routes: x402.bazaar.dynamic_routes,
    };
    // x402scan discovers paid operations through this interoperable OpenAPI extension.
    // Keep x-x402 above for existing Wellnizz clients.
    paidOperation['x-payment-info'] = {
      price: { mode: 'fixed', currency: 'USD', amount: route.price_usd.replace(/^\$/, '') },
      protocols: [{ x402: {} }],
    };
  }
}

const sourceCategory = { type: 'string', enum: ['genetics', 'biomarkers', 'wearables', 'behavioral'] };
const userId = { type: 'string', minLength: 1 };
const organizationId = { type: 'string', minLength: 1 };

export const toolInputSchemas: Record<string, JsonSchema> = {
  upload_health_data: {
    type: 'object',
    description: 'Small imports only. NEVER use for VCF/VCF.GZ or large SNP/23andMe files; use start_genetics_upload instead.',
    additionalProperties: false,
    required: ['category'],
    properties: {
      user_id: userId,
      organization_id: organizationId,
      category: sourceCategory,
      filename: { type: 'string' },
      content_type: { type: 'string' },
      provider: { type: 'string' },
      text: { type: 'string' },
      data_base64: { type: 'string' },
    },
    oneOf: [{ required: ['text'] }, { required: ['data_base64'] }],
  },
  start_genetics_upload: {
    type: 'object',
    additionalProperties: false,
    required: ['user_id', 'organization_id', 'filename', 'byte_length'],
    properties: {
      user_id: userId,
      organization_id: organizationId,
      filename: { type: 'string', minLength: 5, description: 'VCF/VCF.GZ or SNP-array raw export (.txt, .tsv, .csv, .snp, .raw; optional .gz).' },
      byte_length: { type: 'number', minimum: 1 },
      content_type: { type: 'string' },
      provider: { type: 'string' },
    },
  },
  complete_genetics_upload: {
    type: 'object',
    additionalProperties: false,
    required: ['source_id', 'user_id', 'organization_id'],
    properties: { source_id: { type: 'string', minLength: 1 }, user_id: userId, organization_id: organizationId },
  },
  connect_health_source: {
    type: 'object',
    additionalProperties: false,
    required: ['provider', 'client_id', 'redirect_uri'],
    properties: {
      provider: { type: 'string', enum: ['whoop', 'oura'] },
      client_id: { type: 'string', minLength: 1 },
      redirect_uri: { type: 'string', minLength: 1 },
      state: { type: 'string' },
      scopes: { type: 'array', items: { type: 'string' } },
    },
  },
  list_capabilities: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
  get_design_implementation: {
    type: 'object',
    additionalProperties: false,
    properties: {
      design_id: { type: 'string', enum: ['aperture', 'meridian'], default: 'meridian', description: 'The full public design-system handoff to retrieve. Returns exact source files, tokens, components, templates, UI kits, binary asset URLs, and (for Meridian) production dashboard bindings.' },
    },
  },
  get_health_context: {
    type: 'object',
    additionalProperties: false,
    required: ['user_id'],
    properties: {
      user_id: userId,
      organization_id: organizationId,
      analysis_ids: { type: 'array', items: { type: 'string' } },
      max_findings: { type: 'number', minimum: 1, maximum: 50 },
    },
  },
  create_private_dashboard_link: dashboardLinkCreateSchema(),
  run_health_analysis: {
    type: 'object',
    additionalProperties: false,
    required: ['source_ids'],
    properties: {
      user_id: userId,
      organization_id: organizationId,
      source_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
      annotation_depth: {
        type: 'string',
        enum: ['compact', 'full_dbsnp'],
        default: 'compact',
        description: 'Genetics only. compact uses the bundled ClinVar-derived reference; full_dbsnp requires the provisioned paid hosted capability or explicit self-hosted setup.',
      },
      profile: {
        type: 'object',
        additionalProperties: false,
        properties: {
          age: { type: 'number' },
          sex: { type: 'string', enum: ['male', 'female'] },
        },
      },
    },
  },
  derive_biomarkers: scopedAnalysisInputSchema(),
  analyze_biomarkers: scopedAnalysisInputSchema(),
  analyze_wearables: scopedAnalysisInputSchema(),
  analyze_genetics: scopedAnalysisInputSchema(),
  query_health_context: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      user_id: userId,
      organization_id: organizationId,
      query: { type: 'string', minLength: 1 },
      analysis_ids: { type: 'array', items: { type: 'string' } },
    },
  },
  get_dashboard_spec: {
    type: 'object',
    additionalProperties: false,
    required: ['analysis_id'],
    properties: {
      analysis_id: { type: 'string', minLength: 1 },
    },
  },
  find_nearby_labs: {
    type: 'object',
    additionalProperties: false,
    properties: {
      provider: { type: 'string', enum: ['quest', 'synlab', 'all'] },
      postal_code: { type: 'string' },
      city: { type: 'string' },
      country: { type: 'string' },
      lat: { type: 'number' },
      lon: { type: 'number' },
      radius_miles: { type: 'number', minimum: 1, maximum: 250 },
    },
  },
  find_providers: {
    type: 'object',
    additionalProperties: false,
    properties: {
      modality: { type: 'array', items: { type: 'string', enum: ['genetics', 'biomarkers', 'wearables'] }, description: 'Modalities to search. Defaults to all.' },
      type: { type: 'string', enum: ['wgs', 'snp_array', 'exome'] },
      region: { type: 'string' },
      lab_provider: { type: 'string', enum: ['quest', 'synlab', 'all'] },
      postal_code: { type: 'string' },
      city: { type: 'string' },
      country: { type: 'string' },
      lat: { type: 'number' },
      lon: { type: 'number' },
      radius_miles: { type: 'number', minimum: 1, maximum: 250 },
    },
  },
  list_wgs_providers: {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: { type: 'string', enum: ['wgs', 'snp_array', 'exome', 'sequencing', 'all'] },
      region: { type: 'string' },
    },
  },
  list_analyses: {
    type: 'object',
    additionalProperties: false,
    required: ['user_id'],
    properties: {
      user_id: userId,
      organization_id: organizationId,
      modality: { type: 'string', enum: ['genetics', 'biomarkers', 'wearables', 'behavioral', 'multimodal'] },
      limit: { type: 'number', minimum: 1, maximum: 200 },
    },
  },
  list_sources: {
    type: 'object',
    additionalProperties: false,
    required: ['user_id'],
    properties: {
      user_id: userId,
      organization_id: organizationId,
      category: sourceCategory,
      limit: { type: 'number', minimum: 1, maximum: 200 },
    },
  },
  get_recommendations: {
    type: 'object',
    additionalProperties: false,
    required: ['analysis_id'],
    properties: {
      analysis_id: { type: 'string', minLength: 1 },
    },
  },
  get_action_plan: {
    type: 'object',
    additionalProperties: false,
    required: ['analysis_id'],
    properties: {
      analysis_id: { type: 'string', minLength: 1 },
    },
  },
  get_health_trends: {
    type: 'object',
    additionalProperties: false,
    required: ['user_id'],
    properties: {
      user_id: userId,
      organization_id: organizationId,
      markers: { type: 'array', items: { type: 'string' } },
      modality: { type: 'string', enum: ['biomarkers', 'wearables'] },
      window_days: { type: 'number', minimum: 1 },
    },
  },
};

export function openApiDocument(baseUrl = 'http://localhost:8787', x402?: X402PublicConfig) {
  const doc = {
    openapi: '3.1.0',
    info: {
      title: 'Wellnizz API',
      version: SERVICE_VERSION,
      description: 'Wellnizz API and MCP-compatible service for genetics, biomarkers, wearables, lab discovery, dashboard specs, action plans, and hosted billing.',
      'x-guidance': 'Use /openapi.json to discover the API. For a payable operation, make the exact request without credentials, select a compatible option from PAYMENT-REQUIRED, then retry unchanged with PAYMENT-SIGNATURE. x402 payments create a payer-scoped private workspace; do not send user_id or organization_id. Use GET /.well-known/x402.json for the live route and price catalog.',
    },
    servers: [{ url: baseUrl }],
    security: [{ bearerAuth: [] }],
    paths: {
      '/health': { get: simpleOperation('Health check', false) },
      '/ready': { get: simpleOperation('Readiness check', false) },
      '/ready/details': { get: simpleOperation('Administrative dependency and storage readiness diagnostics') },
      '/version': { get: simpleOperation('Version metadata', false) },
      '/endpoints': { get: simpleOperation('Endpoint catalog', false) },
      '/.well-known/health-agent.json': { get: simpleOperation('Agent manifest', false) },
      '/.well-known/x402.json': { get: simpleOperation('x402 payment route discovery', false) },
      '/openapi.json': { get: simpleOperation('OpenAPI schema', false) },
      '/capabilities': { get: simpleOperation('Capability registry', false) },
      '/pricing': { get: simpleOperation('Pricing, limits, and caching policy', false) },
      '/billing/subscription': { get: simpleOperation('Read hosted billing status for the authenticated workspace') },
      '/billing/checkout': { post: createdOperationWithBody('Create Stripe Checkout session', billingCheckoutSchema()) },
      '/billing/portal': { post: createdOperationWithBody('Create Stripe Billing Portal session', billingPortalSchema()) },
      '/billing/stripe/webhook': { post: operationWithBody('Receive verified Stripe subscription webhook', { type: 'object', additionalProperties: true }, false) },
      '/design/systems': { get: simpleOperation('List design systems for health UIs', false) },
      '/design/systems/{id}': { get: simpleOperation('Get a design system with tokens + DESIGN.md', false) },
      '/design/systems/{id}/implementation': { get: simpleOperation('Get the complete public design-system handoff and implementation bindings for an agent-built app', false) },
      '/auth/otp/start': { post: operationWithBody('Start email OTP', authOtpStartSchema(), false) },
      '/auth/otp/verify': { post: operationWithBody('Verify email OTP', authOtpVerifySchema(), false) },
      '/agent-login/start': { post: operationWithBody('Start explicit browser approval for a named agent', { type: 'object', additionalProperties: false, properties: { agent_name: { type: 'string', maxLength: 80 } } }, false) },
      '/agent-login/request': { get: simpleOperation('Read the safe display details for an agent approval request', false) },
      '/agent-login/status': { get: simpleOperation('Poll agent approval with the private X-Agent-Login-Secret header', false) },
      '/agent-login/confirm': { post: operationWithBody('Approve or deny a pending agent authorization', { type: 'object', additionalProperties: false, required: ['session_code', 'access_token', 'decision'], properties: { session_code: { type: 'string' }, access_token: { type: 'string' }, decision: { type: 'string', enum: ['approve', 'deny'] } } }, false) },
      '/sandbox/sessions': { post: operationWithBody('Start synthetic sandbox session', { type: 'object', additionalProperties: false, properties: {} }, false) },
      '/sandbox/hero': { post: operationWithBody('Run synthetic multimodal demo', { type: 'object', additionalProperties: false, properties: {} }) },
      '/api-keys': { post: createdOperationWithBody('Issue scoped API key', apiKeyCreateSchema()) },
      '/imports/file': { post: createdOperationWithBody('Upload wellness data', toolInputSchemas.upload_health_data, ref('SourceImportResult')) },
      '/genetics/uploads': { post: createdOperationWithBody('Start a resumable direct-to-storage genetics upload', geneticsUploadInitSchema()) },
      '/genetics/uploads/{id}/complete': { post: createdOperationWithBody('Finalize a direct-to-storage genetics upload', geneticsUploadCompleteSchema()) },
      '/sources': {
        get: listOperation('List uploaded sources for a user', [
          { name: 'user_id', description: 'User whose sources to list (defaults to the token subject).' },
          { name: 'organization_id', description: 'Restrict to a single organization.' },
          { name: 'category', description: 'Filter by category: biomarkers, wearables, genetics, behavioral.' },
          { name: 'since', description: 'ISO timestamp lower bound on received_at.' },
          { name: 'limit', description: 'Max results (1-200, default 50).' },
        ], ref('SourceList')),
      },
      '/sources/{id}': { get: simpleOperation('Read a source and its normalized observations', true, ref('SourceDetail')) },
      '/webhook-events': { get: simpleOperation('Read webhook event log', true, ref('WebhookEventList')) },
      '/connections/wearables/start': { post: operationWithBody('Start generic wearables connection', wearablesConnectionStartSchema()) },
      '/connections/wearables/status': { get: simpleOperation('Read persisted wearable connection status') },
      '/connections/wearables/callback': { post: operationWithBody('Complete generic wearables connection', wearablesConnectionCallbackSchema()) },
      '/connections/{provider}/auth-url': { post: operationWithBody('Build provider OAuth URL', toolInputSchemas.connect_health_source) },
      '/connections/{provider}/token': { post: operationWithBody('Exchange provider OAuth code', oauthTokenSchema()) },
      '/connections/{provider}/refresh': { post: operationWithBody('Refresh a provider access token', oauthRefreshSchema()) },
      '/api/v1/sdk/users/{user_id}/sync': { post: operationWithBody('Push Google Health Connect readings from the Wellnizz mobile SDK', healthConnectSdkSchema()) },
      '/connections/wearables/jobs/{id}': { get: simpleOperation('Read queued wearable sync job status') },
      '/analyses': {
        get: listOperation('List analyses for a user', [
          { name: 'user_id', description: 'User whose analyses to list (defaults to the token subject).' },
          { name: 'organization_id', description: 'Restrict to a single organization.' },
          { name: 'modality', description: 'Filter by modality: biomarkers, wearables, genetics, multimodal.' },
          { name: 'since', description: 'ISO timestamp lower bound on created_at.' },
          { name: 'limit', description: 'Max results (1-200, default 50).' },
        ], ref('AnalysisList')),
        post: createdOperationWithBody('Run multimodal health analysis', toolInputSchemas.run_health_analysis, ref('AnalysisResult')),
      },
      '/analyses/{id}': { get: simpleOperation('Read analysis', true, ref('AnalysisResult')) },
      '/analyses/{id}/recommendations': { get: simpleOperation('Read prioritized recommendations for an analysis', true, ref('RecommendationsResult')) },
      '/analyses/{id}/action-plan': { get: simpleOperation('Build a customized action plan (interventions + evidence-graded supplement stack) for an analysis', true, ref('ActionPlan')) },
      '/analyses/{id}/rerun': { post: createdOperationWithBody('Re-run a stored analysis on its existing sources', { type: 'object', additionalProperties: false, properties: {} }, ref('AnalysisResult')) },
      '/biomarkers/derive': { post: createdOperationWithBody('Calculate derived biomarkers', toolInputSchemas.derive_biomarkers, ref('AnalysisResult')) },
      '/biomarkers/analyze': { post: createdOperationWithBody('Analyze biomarker results', toolInputSchemas.analyze_biomarkers, ref('AnalysisResult')) },
      '/wearables/analyze': { post: createdOperationWithBody('Analyze wearable observations', toolInputSchemas.analyze_wearables, ref('AnalysisResult')) },
      '/genetics/analyze': { post: createdOperationWithBody('Start genetics analysis', toolInputSchemas.analyze_genetics, ref('AnalysisResult')) },
      '/genetics/ancestry': { post: operationWithBody('Run ancestry analysis setup/projection', ancestryAnalysisSchema(), true, ref('AncestryResult')) },
      '/genetics/jobs/{id}': { get: simpleOperation('Read queued genetic analysis job status', true, ref('GeneticJob')) },
      '/dashboard-specs/{analysis_id}': { get: simpleOperation('Read dashboard spec', true, ref('DashboardSpec')) },
      '/dashboard-links': { post: dashboardLinkOperation() },
      '/dashboards/private/{token}': { get: htmlOperation('Open an expiring private dashboard', 'The rendered dashboard HTML. The signed URL grants access until it expires.') },
      '/users/{user_id}/health-context': { post: operationWithBody('Read unified health context', healthContextSchema(), true, ref('HealthContext')) },
      '/users/{user_id}/trends': { post: operationWithBody('Compute longitudinal biomarker and wearable trends', trendsBodySchema(), true, ref('TrendsResult')) },
      '/users/{user_id}/retest-reminders': { get: simpleOperation('Compute retest reminders per modality', true, ref('RetestReminderList')) },
      '/users/{user_id}/goals': {
        get: simpleOperation('List a user\'s health goals', true, ref('GoalList')),
        post: createdOperationWithBody('Create a health goal', goalCreateSchema(), ref('Goal')),
      },
      '/goals/{id}': {
        get: simpleOperation('Read a health goal', true, ref('Goal')),
        post: operationWithBody('Update a health goal', goalUpdateSchema(), true, ref('Goal')),
      },
      '/goals/{id}/delete': { post: simpleOperation('Delete a health goal') },
      '/query': { post: operationWithBody('Query health context', toolInputSchemas.query_health_context, true, ref('QueryResult')) },
      '/providers': {
        get: listOperation('Find providers across modalities (genetics, biomarkers/labs, wearables)', [
          { name: 'modality', description: 'Comma-separated modalities to search: genetics, biomarkers, wearables. Defaults to all.' },
          { name: 'type', description: 'Genetics filter: wgs, snp_array, or exome.' },
          { name: 'region', description: 'Genetics filter, e.g. Europe or North America.' },
          { name: 'postal_code', description: 'Lab locator: search draw sites near this postal code.' },
          { name: 'city', description: 'Lab locator: search draw sites near this city.' },
          { name: 'country', description: 'Lab locator: country code for the search.' },
          { name: 'lat', description: 'Lab locator: latitude.' },
          { name: 'lon', description: 'Lab locator: longitude.' },
          { name: 'radius_miles', description: 'Lab locator: search radius (default 25).' },
        ]),
      },
      '/labs/search': { get: simpleOperation('Find nearby labs') },
      '/wgs-providers': { get: simpleOperation('List WGS and genetic testing providers') },
      '/wgs-providers/{id}': { get: simpleOperation('Get a specific genetic testing provider') },
      '/users/{user_id}/data/export': { post: operationWithBody('Export user data', exportUserDataSchema()) },
      '/users/{user_id}/data/delete': { post: operationWithBody('Tombstone user data', deleteUserDataSchema()) },
      '/mcp': { post: operationWithBody('MCP JSON-RPC endpoint', { type: 'object', additionalProperties: true }) },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        x402: {
          type: 'apiKey',
          in: 'header',
          name: 'PAYMENT-SIGNATURE',
          description: 'x402 v2 payment payload. Request the route without credentials first to receive PAYMENT-REQUIRED options.',
        },
      },
      schemas: {
        FileImportInput: toolInputSchemas.upload_health_data,
        RunHealthAnalysisInput: toolInputSchemas.run_health_analysis,
        ScopedAnalysisInput: toolInputSchemas.analyze_biomarkers,
        QueryInput: toolInputSchemas.query_health_context,
        HealthContextInput: toolInputSchemas.get_health_context,
        DashboardSpecInput: toolInputSchemas.get_dashboard_spec,
        ApiKeyCreateInput: apiKeyCreateSchema(),
        X402PaymentRequired: {
          type: 'object',
          required: ['x402Version', 'resource', 'accepts'],
          properties: {
            x402Version: { type: 'integer', const: 2 },
            error: { type: 'string' },
            resource: { type: 'object', additionalProperties: true },
            accepts: { type: 'array', items: { type: 'object', additionalProperties: true } },
            extensions: { type: 'object', additionalProperties: true },
          },
        },
        ...responseSchemas(),
      },
    },
    'x-endpoints': ENDPOINTS,
  };
  attachOperationDescriptions(doc.paths as unknown as Record<string, Record<string, unknown>>);
  attachX402Operations(doc.paths as unknown as Record<string, Record<string, unknown>>, x402);
  (doc as Record<string, unknown>)['x-x402'] = x402 ?? { enabled: false, version: 2 };
  return doc;
}

function scopedAnalysisInputSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['source_ids'],
    properties: {
      user_id: userId,
      organization_id: organizationId,
      source_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
      annotation_depth: {
        type: 'string',
        enum: ['compact', 'full_dbsnp'],
        default: 'compact',
        description: 'Genetics only. compact uses the bundled ClinVar-derived reference; full_dbsnp requires the provisioned paid hosted capability or explicit self-hosted setup.',
      },
      profile: {
        type: 'object',
        additionalProperties: false,
        properties: {
          age: { type: 'number' },
          sex: { type: 'string', enum: ['male', 'female'] },
        },
      },
    },
  };
}

function apiKeyCreateSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', description: 'Display name for the key.' },
      user_id: userId,
      organization_id: organizationId,
      tier: { type: 'string', enum: ['free', 'builder', 'growth', 'enterprise'], default: 'free', description: 'free is self-serve for personal use. Paid tiers require an admin token.' },
      intended_use: { type: 'string', enum: ['personal_agent', 'mobile_sync', 'app_platform_service'], default: 'personal_agent', description: 'personal_agent keys act for one person. mobile_sync creates a non-expiring, upload-only device credential for Wellnizz Connect. Products serving other users need app_platform_service on the builder tier or higher.' },
      scopes: {
        type: 'array',
        description: 'Defaults to the standard personal grant set when omitted.',
        items: { type: 'string', enum: ['health:data:read', 'health:data:write', 'health:connections:write', 'health:labs:read', 'health:admin'] },
      },
      enabled_endpoints: {
        type: 'array',
        description: 'Defaults to the standard personal endpoint grants when omitted.',
        items: { type: 'string' },
      },
      expires_in_days: { type: 'number', minimum: 1, maximum: 730, default: 365 },
    },
  };
}

function billingCheckoutSchema(): JsonSchema {
  return {
    type: 'object', additionalProperties: false, required: ['tier', 'activation_source'],
    properties: {
      tier: { type: 'string', enum: ['standard', 'builder', 'growth'] },
      organization_id: organizationId,
      activation_source: { type: 'string', enum: ['wearable', 'biomarkers', 'genetics', 'health_connect', 'request_limit'], description: 'The source of the billing decision. Hosted Checkout is normally shown once the introductory request allowance is exhausted.' },
    },
  };
}

function billingPortalSchema(): JsonSchema {
  return {
    type: 'object', additionalProperties: false,
    properties: { organization_id: organizationId },
  };
}

function ancestryAnalysisSchema(): JsonSchema {
  return {
    type: 'object',
    required: ['source_id'],
    additionalProperties: false,
    properties: {
      user_id: userId,
      organization_id: organizationId,
      source_id: { type: 'string', minLength: 1 },
      reference_panel: { type: 'string', enum: ['1000_genomes_phase3'], default: '1000_genomes_phase3' },
      resolution: { type: 'string', enum: ['continental', 'regional', 'sub_population'], default: 'continental' },
    },
  };
}

function wearablesConnectionStartSchema(): JsonSchema {
  return {
    type: 'object',
    // client_id and redirect_uri are required for OAuth providers (WHOOP, Oura) and
    // unused for mobile-bridge providers (Health Connect); the handler enforces
    // them per provider.
    required: ['user_id', 'source_provider'],
    additionalProperties: false,
    properties: {
      user_id: userId,
      organization_id: organizationId,
      source_provider: { type: 'string', enum: ['whoop', 'oura', 'health_connect'] },
      client_id: { type: 'string', minLength: 1 },
      redirect_uri: { type: 'string', minLength: 1 },
      state: { type: 'string' },
      scopes: { type: 'array', items: { type: 'string' } },
    },
  };
}

function wearablesConnectionCallbackSchema(): JsonSchema {
  return {
    type: 'object',
    // code/client_id/client_secret/redirect_uri are required for OAuth providers
    // (WHOOP, Oura) and unused for mobile-bridge providers (Health Connect); the handler
    // enforces them per provider.
    required: ['user_id', 'source_provider'],
    additionalProperties: false,
    properties: {
      user_id: userId,
      organization_id: organizationId,
      source_provider: { type: 'string', enum: ['whoop', 'oura', 'health_connect'] },
      code: { type: 'string' },
      client_id: { type: 'string' },
      client_secret: { type: 'string' },
      redirect_uri: { type: 'string' },
      external_user_id: { type: 'string' },
    },
  };
}

function healthContextSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      organization_id: organizationId,
      analysis_ids: { type: 'array', items: { type: 'string' } },
      max_findings: { type: 'number', minimum: 1, maximum: 50 },
    },
  };
}

function ref(name: string): JsonSchema {
  return { $ref: `#/components/schemas/${name}` };
}

function successResponse(description: string, schema?: JsonSchema) {
  return {
    description,
    content: { 'application/json': { schema: schema ?? ref('JsonObject') } },
  };
}

function errorResponse(description: string) {
  return { description, content: { 'application/problem+json': { schema: ref('ProblemDetails') } } };
}

function simpleOperation(summary: string, protectedRoute = true, responseSchema?: JsonSchema) {
  return {
    summary,
    security: protectedRoute ? [{ bearerAuth: [] }] : [],
    responses: {
      200: successResponse('OK', responseSchema),
      401: errorResponse('Unauthorized'),
      403: errorResponse('Forbidden'),
    },
  };
}

function listOperation(summary: string, params: Array<{ name: string; description: string }>, responseSchema?: JsonSchema) {
  return {
    ...simpleOperation(summary, true, responseSchema),
    parameters: params.map(param => ({
      name: param.name,
      in: 'query',
      required: false,
      schema: { type: 'string' },
      description: param.description,
    })),
  };
}

function goalCreateSchema(): JsonSchema {
  return {
    type: 'object',
    required: ['title'],
    additionalProperties: false,
    properties: {
      organization_id: organizationId,
      title: { type: 'string', minLength: 1 },
      metric: { type: 'string', description: 'Marker or domain the goal targets, e.g. apob or body_fat_percent.' },
      target_value: { type: 'number' },
      target_unit: { type: 'string' },
      target_direction: { type: 'string', enum: ['decrease', 'increase', 'maintain'] },
      due_date: { type: 'string', description: 'ISO date the user is aiming for.' },
      note: { type: 'string' },
    },
  };
}

function goalUpdateSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1 },
      metric: { type: 'string' },
      target_value: { type: 'number' },
      target_unit: { type: 'string' },
      target_direction: { type: 'string', enum: ['decrease', 'increase', 'maintain'] },
      due_date: { type: 'string' },
      status: { type: 'string', enum: ['active', 'achieved', 'archived'] },
      note: { type: 'string' },
    },
  };
}

function trendsBodySchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      organization_id: organizationId,
      markers: { type: 'array', items: { type: 'string' } },
      modality: { type: 'string', enum: ['biomarkers', 'wearables'] },
      window_days: { type: 'number', minimum: 1 },
    },
  };
}

function operationWithBody(summary: string, schema: JsonSchema | undefined, protectedRoute = true, responseSchema?: JsonSchema) {
  return {
    ...simpleOperation(summary, protectedRoute, responseSchema),
    requestBody: schema ? {
      required: true,
      content: {
        'application/json': { schema },
      },
    } : undefined,
  };
}

function createdOperationWithBody(summary: string, schema: JsonSchema, responseSchema?: JsonSchema) {
  return {
    ...operationWithBody(summary, schema),
    responses: {
      201: successResponse('Created', responseSchema),
      400: errorResponse('Invalid request or source modality'),
      401: errorResponse('Unauthorized'),
      403: errorResponse('Forbidden'),
      404: errorResponse('Source not found'),
    },
  };
}

function dashboardLinkOperation() {
  const operation = createdOperationWithBody('Create an expiring private dashboard URL', dashboardLinkCreateSchema(), ref('DashboardLinkResult'));
  return {
    ...operation,
    responses: {
      ...operation.responses,
      503: errorResponse('Private dashboard links are not configured'),
    },
  };
}

function htmlOperation(summary: string, description: string) {
  return {
    summary,
    security: [],
    parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
    responses: {
      200: { description, content: { 'text/html': { schema: { type: 'string' } } } },
      404: errorResponse('Dashboard link not found or expired'),
    },
  };
}

function dashboardLinkCreateSchema(): JsonSchema {
  return {
    type: 'object',
    required: ['analysis_id', 'design_id'],
    additionalProperties: false,
    properties: {
      analysis_id: { type: 'string', description: 'Analysis whose dashboard snapshot will be rendered.' },
      design_id: { type: 'string', description: 'A design ID from GET /design/systems.' },
      expires_in_days: { type: 'integer', minimum: 1, maximum: 90, default: 30 },
    },
  };
}

function authOtpStartSchema(): JsonSchema {
  return {
    type: 'object',
    required: ['email'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', format: 'email', description: 'Email address of the person authorizing access.' },
    },
  };
}

function authOtpVerifySchema(): JsonSchema {
  return {
    type: 'object',
    required: ['email', 'token'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', format: 'email', description: 'Email address the code was sent to.' },
      token: { type: 'string', description: 'The 8-digit code from the sign-in email.' },
    },
  };
}

function oauthTokenSchema(): JsonSchema {
  return {
    type: 'object',
    required: ['code', 'client_id', 'client_secret', 'redirect_uri'],
    additionalProperties: false,
    properties: {
      code: { type: 'string' },
      client_id: { type: 'string' },
      client_secret: { type: 'string' },
      redirect_uri: { type: 'string' },
    },
  };
}

function oauthRefreshSchema(): JsonSchema {
  return {
    type: 'object',
    required: ['refresh_token', 'client_id', 'client_secret'],
    additionalProperties: false,
    properties: {
      refresh_token: { type: 'string', minLength: 1 },
      client_id: { type: 'string', minLength: 1 },
      client_secret: { type: 'string', minLength: 1 },
      scopes: { type: 'array', items: { type: 'string' } },
    },
  };
}

function geneticsUploadInitSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['user_id', 'organization_id', 'filename', 'byte_length'],
    properties: {
      user_id: userId,
      organization_id: organizationId,
      filename: { type: 'string', minLength: 5 },
      byte_length: { type: 'number', minimum: 1 },
      content_type: { type: 'string' },
      provider: { type: 'string' },
    },
  };
}

function geneticsUploadCompleteSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['user_id', 'organization_id'],
    properties: { user_id: userId, organization_id: organizationId },
  };
}

function healthConnectSdkSchema(): JsonSchema {
  return {
    type: 'object',
    required: ['provider', 'data'],
    additionalProperties: false,
    properties: {
      provider: { type: 'string', enum: ['health_connect'] },
      sdkVersion: { type: 'string' },
      syncTimestamp: { type: 'string', format: 'date-time' },
      data: {
        type: 'object',
        additionalProperties: false,
        properties: {
          records: { type: 'array', items: { type: 'object', additionalProperties: true } },
          sleep: { type: 'array', items: { type: 'object', additionalProperties: true } },
          workouts: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
    },
  };
}

function deleteUserDataSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      organization_id: organizationId,
    },
  };
}

function exportUserDataSchema(): JsonSchema {
  return deleteUserDataSchema();
}

function responseSchemas(): Record<string, JsonSchema> {
  const timestamp = { type: 'string', format: 'date-time' };
  const stringArray = { type: 'array', items: { type: 'string' } };
  const source = {
    type: 'object', additionalProperties: false,
    required: ['id', 'user_id', 'category', 'received_at', 'byte_length', 'storage_mode'],
    properties: {
      id: { type: 'string' }, user_id: userId, organization_id: organizationId,
      category: sourceCategory, filename: { type: 'string' }, content_type: { type: 'string' },
      provider: { type: 'string' }, received_at: timestamp, byte_length: { type: 'integer', minimum: 0 },
      storage_mode: { type: 'string', enum: ['memory', 'durable'] },
      upload_status: { type: 'string', enum: ['pending', 'complete'] },
    },
  };
  const observation = {
    type: 'object', additionalProperties: false,
    required: ['id', 'user_id', 'source_id', 'category', 'type', 'name'],
    properties: {
      id: { type: 'string' }, user_id: userId, organization_id: organizationId, source_id: { type: 'string' },
      category: sourceCategory, type: { type: 'string' }, name: { type: 'string' }, value: { type: 'number' },
      unit: { type: 'string' }, observed_at: timestamp, provider: { type: 'string' }, raw: {},
    },
  };
  const provenance = {
    type: 'object', additionalProperties: false,
    required: ['source_ids', 'source_categories', 'source_type', 'engine', 'generated_at'],
    properties: {
      source_ids: stringArray,
      source_categories: { type: 'array', items: sourceCategory },
      source_type: { type: 'string', enum: ['direct', 'derived', 'combined', 'queued', 'setup_required', 'failed'] },
      engine: { type: 'string' }, generated_at: timestamp,
    },
  };
  const interpretation = {
    type: 'object', additionalProperties: false,
    required: ['id', 'user_id', 'analysis_id', 'category', 'type', 'title', 'provenance'],
    properties: {
      id: { type: 'string' }, user_id: userId, organization_id: organizationId, analysis_id: { type: 'string' },
      category: { type: 'string', enum: ['genetics', 'biomarkers', 'wearables', 'behavioral', 'multimodal'] },
      type: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' }, score: { type: 'number' },
      summary: { type: 'string' }, action: { type: 'string' }, provenance, raw: {},
    },
  };
  const dashboardCard = {
    type: 'object', additionalProperties: false, required: ['id', 'title', 'category'],
    properties: {
      id: { type: 'string' }, title: { type: 'string' }, category: { type: 'string' }, score: { type: 'number' },
      status: { type: 'string' }, summary: { type: 'string' }, action: { type: 'string' }, value: { type: 'number' },
      unit: { type: 'string' }, target: { type: 'object', additionalProperties: false, properties: { min: { type: 'number' }, max: { type: 'number' } } },
      visualization: { type: 'string', enum: ['range', 'score', 'status'] }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      provenance,
    },
  };
  const dashboardSpec = {
    type: 'object', additionalProperties: false,
    required: ['schema_version', 'id', 'user_id', 'analysis_id', 'generated_at', 'cards', 'coverage', 'quality', 'sections', 'provenance'],
    properties: {
      schema_version: { type: 'string', const: '1.0' }, id: { type: 'string' }, user_id: userId,
      organization_id: organizationId, analysis_id: { type: 'string' }, generated_at: timestamp,
      cards: { type: 'array', items: dashboardCard },
      coverage: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['modality', 'present', 'source_count', 'finding_count'],
        properties: { modality: sourceCategory, present: { type: 'boolean' }, source_count: { type: 'integer' }, finding_count: { type: 'integer' }, latest_received_at: timestamp },
      } },
      quality: {
        type: 'object', additionalProperties: false, required: ['status', 'usable', 'warnings', 'freshness'],
        properties: {
          status: { type: 'string', enum: ['complete', 'partial', 'empty'] }, usable: { type: 'boolean' }, warnings: stringArray,
          freshness: { type: 'array', items: {
            type: 'object', additionalProperties: false, required: ['modality', 'status', 'threshold_days'],
            properties: { modality: sourceCategory, status: { type: 'string', enum: ['fresh', 'stale', 'missing', 'unknown'] }, threshold_days: { type: 'integer' }, latest_received_at: timestamp, age_days: { type: 'integer' } },
          } },
        },
      },
      sections: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['id', 'title', 'category', 'card_ids'],
        properties: { id: { type: 'string' }, title: { type: 'string' }, category: { type: 'string' }, card_ids: stringArray },
      } },
      provenance: {
        type: 'object', additionalProperties: false, required: ['source_ids', 'storage_mode', 'clinical_boundary'],
        properties: { source_ids: stringArray, storage_mode: { type: 'string', enum: ['memory', 'durable'] }, clinical_boundary: { type: 'string' } },
      },
    },
  };
  const analysis = {
    type: 'object', additionalProperties: false,
    required: ['id', 'user_id', 'created_at', 'source_ids', 'raw_source_references', 'normalized_observations', 'derived_interpretations', 'dashboard_spec'],
    properties: {
      id: { type: 'string' }, user_id: userId, organization_id: organizationId,
      modality: { type: 'string', enum: ['genetics', 'biomarkers', 'wearables', 'behavioral', 'multimodal'] },
      operation: { type: 'string', enum: ['analyze', 'derive'] }, created_at: timestamp, source_ids: stringArray,
      raw_source_references: { type: 'array', items: source }, normalized_observations: { type: 'array', items: observation },
      derived_interpretations: { type: 'array', items: interpretation }, dashboard_spec: dashboardSpec,
      healthspan_score: { type: 'number' }, domain_scores: { type: 'object', additionalProperties: { type: 'number' } },
      job: { type: 'object', additionalProperties: true },
    },
  };
  const recommendation = {
    type: 'object', additionalProperties: false, required: ['title', 'category', 'priority', 'action', 'provenance'],
    properties: {
      title: { type: 'string' }, category: { type: 'string' }, priority: { type: 'string', enum: ['high', 'medium', 'low', 'info'] },
      status: { type: 'string' }, score: { type: 'number' }, rationale: { type: 'string' }, action: { type: 'string' },
      provenance: { type: 'object', additionalProperties: false, required: ['analysis_id', 'source_ids', 'engine'], properties: { analysis_id: { type: 'string' }, source_ids: stringArray, engine: { type: 'string' } } },
    },
  };
  const goal = {
    type: 'object', additionalProperties: false, required: ['id', 'user_id', 'title', 'status', 'created_at', 'updated_at'],
    properties: {
      id: { type: 'string' }, user_id: userId, organization_id: organizationId, title: { type: 'string' }, metric: { type: 'string' },
      target_value: { type: 'number' }, target_unit: { type: 'string' }, target_direction: { type: 'string', enum: ['decrease', 'increase', 'maintain'] },
      due_date: { type: 'string' }, status: { type: 'string', enum: ['active', 'achieved', 'archived'] }, note: { type: 'string' }, created_at: timestamp, updated_at: timestamp,
    },
  };
  return {
    JsonObject: { type: 'object', additionalProperties: true },
    ProblemDetails: {
      type: 'object', additionalProperties: true, required: ['type', 'title', 'status', 'detail'],
      properties: { type: { type: 'string' }, title: { type: 'string' }, status: { type: 'integer' }, detail: { type: 'string' }, instance: { type: 'string' }, request_id: { type: 'string' } },
    },
    RawSourceReference: source,
    NormalizedObservation: observation,
    DerivedInterpretation: interpretation,
    DashboardSpec: dashboardSpec,
    DashboardLinkResult: {
      type: 'object', additionalProperties: false,
      required: ['dashboard_url', 'analysis_id', 'design', 'visibility', 'expires_at', 'sharing'],
      properties: {
        dashboard_url: { type: 'string', format: 'uri', description: 'Bearer URL for the exact dashboard snapshot. Keep it private unless the user chooses to share it.' },
        analysis_id: { type: 'string' },
        design: {
          type: 'object', additionalProperties: false, required: ['id', 'name', 'layout'],
          properties: { id: { type: 'string' }, name: { type: 'string' }, layout: { type: 'object', additionalProperties: true } },
        },
        visibility: { type: 'string', const: 'private_by_possession' },
        expires_at: timestamp,
        sharing: {
          type: 'object', additionalProperties: false, required: ['default', 'optional', 'note'],
          properties: { default: { type: 'string', const: 'private' }, optional: { type: 'boolean', const: true }, note: { type: 'string' } },
        },
      },
    },
    AnalysisResult: analysis,
    SourceImportResult: {
      type: 'object', additionalProperties: false, required: ['source', 'normalized_observations', 'warnings'],
      properties: { source, normalized_observations: { type: 'array', items: observation }, warnings: stringArray },
    },
    SourceList: { type: 'object', additionalProperties: false, required: ['sources', 'count', 'total'], properties: { sources: { type: 'array', items: source }, count: { type: 'integer' }, total: { type: 'integer' } } },
    SourceDetail: { type: 'object', additionalProperties: false, required: ['source', 'normalized_observations'], properties: { source, normalized_observations: { type: 'array', items: observation } } },
    AnalysisList: {
      type: 'object', additionalProperties: false, required: ['analyses', 'count', 'total'],
      properties: { analyses: { type: 'array', items: { type: 'object', additionalProperties: true, required: ['id', 'created_at', 'source_ids', 'interpretation_count'], properties: { id: { type: 'string' }, created_at: timestamp, source_ids: stringArray, interpretation_count: { type: 'integer' } } } }, count: { type: 'integer' }, total: { type: 'integer' } },
    },
    RecommendationsResult: {
      type: 'object', additionalProperties: false, required: ['analysis_id', 'user_id', 'generated_at', 'count', 'recommendations', 'protocols'],
      properties: { analysis_id: { type: 'string' }, user_id: userId, organization_id: organizationId, generated_at: timestamp, healthspan_score: { type: 'number' }, count: { type: 'integer' }, recommendations: { type: 'array', items: recommendation }, protocols: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'name', 'focus', 'domains', 'items'], properties: { id: { type: 'string', enum: ['core', 'optimize', 'maintain'] }, name: { type: 'string' }, focus: { type: 'string' }, domains: stringArray, items: { type: 'array', items: recommendation } } } } },
    },
    ActionPlan: {
      type: 'object', additionalProperties: false, required: ['analysis_id', 'user_id', 'generated_at', 'status', 'summary', 'interventions', 'supplements', 'cautions', 'evidence_key', 'sources', 'disclaimer', 'provenance'],
      properties: { analysis_id: { type: 'string' }, user_id: userId, organization_id: organizationId, generated_at: timestamp, status: { type: 'string', enum: ['ready', 'processing', 'setup_required', 'failed'] }, summary: { type: 'string' }, interventions: { type: 'array', items: { type: 'object', additionalProperties: true } }, supplements: { type: 'array', items: { type: 'object', additionalProperties: true } }, cautions: stringArray, evidence_key: { type: 'object', additionalProperties: { type: 'string' } }, sources: { type: 'array', items: { type: 'object', additionalProperties: true } }, disclaimer: { type: 'string' }, provenance: { type: 'object', additionalProperties: true } },
    },
    HealthContext: {
      type: 'object', additionalProperties: false, required: ['user_id', 'generated_at', 'coverage', 'counts', 'priority_findings', 'modality_contexts', 'data_gaps', 'provenance'],
      properties: { user_id: userId, organization_id: organizationId, generated_at: timestamp, latest_analysis_id: { type: 'string' }, coverage: { type: 'array', items: { type: 'object', additionalProperties: true } }, counts: { type: 'object', additionalProperties: { type: 'integer' } }, priority_findings: { type: 'array', items: { type: 'object', additionalProperties: true } }, modality_contexts: { type: 'object', additionalProperties: true }, data_gaps: { type: 'array', items: { type: 'object', additionalProperties: true } }, provenance: { type: 'object', additionalProperties: true } },
    },
    TrendsResult: {
      type: 'object', additionalProperties: false, required: ['user_id', 'generated_at', 'marker_count', 'improving', 'worsening', 'stable', 'markers'],
      properties: { user_id: userId, organization_id: organizationId, generated_at: timestamp, window_days: { type: 'integer' }, marker_count: { type: 'integer' }, improving: { type: 'integer' }, worsening: { type: 'integer' }, stable: { type: 'integer' }, markers: { type: 'array', items: { type: 'object', additionalProperties: true, required: ['marker', 'name', 'modality', 'trend', 'first', 'latest', 'points'], properties: { marker: { type: 'string' }, name: { type: 'string' }, modality: sourceCategory, trend: { type: 'string', enum: ['improving', 'worsening', 'stable', 'baseline'] }, first: { type: 'number' }, latest: { type: 'number' }, points: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['value', 'observed_at', 'source_id'], properties: { value: { type: 'number' }, observed_at: timestamp, source_id: { type: 'string' } } } } } } } },
    },
    QueryResult: { type: 'object', additionalProperties: false, required: ['query', 'matches'], properties: { query: { type: 'string' }, matches: { type: 'array', items: { oneOf: [observation, interpretation] } } } },
    AncestryResult: ancestryResponseSchema(timestamp, stringArray),
    GeneticJob: { type: 'object', additionalProperties: true, required: ['id', 'analysis_id', 'source_id', 'user_id', 'status', 'attempts', 'max_attempts', 'created_at', 'updated_at'], properties: { id: { type: 'string' }, analysis_id: { type: 'string' }, source_id: { type: 'string' }, user_id: userId, status: { type: 'string', enum: ['queued', 'running', 'complete', 'failed'] }, attempts: { type: 'integer' }, max_attempts: { type: 'integer' }, created_at: timestamp, updated_at: timestamp } },
    Goal: goal,
    GoalList: { type: 'object', additionalProperties: false, required: ['goals'], properties: { goals: { type: 'array', items: goal } } },
    RetestReminderList: { type: 'object', additionalProperties: false, required: ['user_id', 'generated_at', 'reminders'], properties: { user_id: userId, organization_id: organizationId, generated_at: timestamp, reminders: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['category', 'cadence_days', 'status', 'reason'], properties: { category: sourceCategory, metric: { type: 'string' }, last_observed_at: timestamp, cadence_days: { type: 'integer' }, next_due_at: timestamp, days_until_due: { type: 'integer' }, status: { type: 'string', enum: ['due', 'upcoming', 'ok', 'never_tested'] }, reason: { type: 'string' } } } } } },
    WebhookEventList: { type: 'object', additionalProperties: false, required: ['events'], properties: { events: { type: 'array', items: { type: 'object', additionalProperties: true, required: ['id', 'type', 'data', 'created_at'], properties: { id: { type: 'string' }, type: { type: 'string' }, data: { type: 'object', additionalProperties: true }, created_at: timestamp } } } } },
  };
}

function ancestryResponseSchema(timestamp: JsonSchema, stringArray: JsonSchema): JsonSchema {
  return {
    type: 'object', additionalProperties: false,
    required: ['schema_version', 'id', 'user_id', 'source_id', 'status', 'reference_panel', 'proportion_unit', 'method', 'resolution', 'summary', 'ancestry', 'haplogroups', 'quality', 'methodology', 'generated_at'],
    properties: {
      schema_version: { type: 'string', const: '1.0' }, id: { type: 'string' }, user_id: userId, organization_id: organizationId, source_id: { type: 'string' },
      status: { type: 'string', enum: ['complete', 'low_confidence', 'setup_required', 'failed'] }, reference_panel: { type: 'string', const: '1000_genomes_phase3' }, proportion_unit: { type: 'string', const: 'percent' },
      method: { type: 'object', additionalProperties: false, required: ['id', 'version', 'execution'], properties: { id: { type: 'string', const: 'curated_aim_maximum_likelihood' }, version: { type: 'string', const: '1.0' }, execution: { type: 'string', const: 'synchronous' } } },
      resolution: { type: 'string', enum: ['continental', 'regional', 'sub_population'] }, summary: { type: 'string' },
      ancestry: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['region', 'proportion', 'confidence'], properties: { region: { type: 'string' }, sub_region: { type: 'string' }, population: { type: 'string' }, proportion: { type: 'number', minimum: 0, maximum: 100 }, range: { type: 'object', additionalProperties: false, required: ['low', 'high'], properties: { low: { type: 'number' }, high: { type: 'number' } } }, confidence: { type: 'string', enum: ['high', 'medium', 'low', 'trace'] }, coordinates: { type: 'object', additionalProperties: false, required: ['lat', 'lon'], properties: { lat: { type: 'number' }, lon: { type: 'number' } } }, countries: stringArray } } },
      haplogroups: { type: 'object', additionalProperties: false, properties: { maternal: { type: 'object', additionalProperties: true }, paternal: { type: 'object', additionalProperties: true } } },
      geographic_map: { type: 'object', additionalProperties: false, required: ['regions'], properties: { regions: { type: 'array', items: { type: 'object', additionalProperties: true } } } },
      chromosome_breakdown: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['chromosome', 'proportions'], properties: { chromosome: { type: 'string' }, proportions: { type: 'object', additionalProperties: { type: 'number' } } } } },
      quality: { type: 'object', additionalProperties: true, required: ['variant_count', 'marker_count', 'matched_markers', 'matched_proportion', 'compatible_for_projection', 'notes'], properties: { variant_count: { type: 'integer' }, marker_count: { type: 'integer' }, matched_markers: { type: 'integer' }, matched_proportion: { type: 'number', minimum: 0, maximum: 100 }, compatible_for_projection: { type: 'boolean' }, notes: stringArray } },
      methodology: { type: 'object', additionalProperties: false, required: ['algorithm', 'reference_panel', 'reference_populations', 'marker_source', 'limitations'], properties: { algorithm: { type: 'string' }, reference_panel: { type: 'string' }, reference_populations: { type: 'string' }, marker_source: { type: 'string' }, limitations: stringArray } },
      generated_at: timestamp,
    },
  };
}

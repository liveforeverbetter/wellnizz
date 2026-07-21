import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeader, ServerResponse } from 'node:http';
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  type HTTPAdapter,
  type HTTPRequestContext,
  type HTTPResponseInstructions,
  type HTTPTransportContext,
  type RouteConfig,
} from '@x402/core/http';
import { x402ResourceServer } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { bazaarResourceServerExtension, declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { createFacilitatorConfig as createCdpFacilitatorConfig } from '@coinbase/x402';
import type { Network } from '@x402/core/types';
import type { AuthContext, AuthScope } from './auth.js';
import { billingEnabled } from './billing.js';
import type { EndpointId } from './endpoints.js';

export const X402_NETWORKS = {
  base: 'eip155:8453',
  polygon: 'eip155:137',
  solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
} as const;

const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';

export type X402NetworkName = keyof typeof X402_NETWORKS;

export interface X402Config {
  enabled: true;
  publicBaseUrl: string;
  facilitatorUrls: string[];
  facilitatorAuthHeaders: Record<string, Record<string, string>>;
  cdpApiKeyId?: string;
  cdpApiKeySecret?: string;
  networks: Array<{ name: X402NetworkName; id: Network; payTo: string }>;
  prices: Record<string, string>;
}

interface X402RouteSpec {
  key: string;
  method: 'GET' | 'POST';
  path: string;
  endpointId: EndpointId;
  scopes: AuthScope[];
  defaultPrice: string;
  description: string;
  tags: string[];
  discovery: Parameters<typeof declareDiscoveryExtension>[0];
}

export interface X402PublicRoute {
  method: 'GET' | 'POST';
  path: string;
  endpoint_id: EndpointId;
  price_usd: string;
  description: string;
}

export interface X402PublicConfig {
  enabled: boolean;
  version: 2;
  payment_header: 'PAYMENT-SIGNATURE';
  payment_response_header: 'PAYMENT-RESPONSE';
  networks: Array<{ name: X402NetworkName; caip2: string }>;
  facilitators: string[];
  routes: X402PublicRoute[];
  identity: string;
  bazaar: { enabled: boolean; dynamic_routes: boolean };
}

export interface X402ExecutionResult {
  handled: boolean;
}

export type X402RouteHandler = (auth: AuthContext, response: ServerResponse) => Promise<void>;
export type X402AtomicExecutor = <T>(work: () => Promise<T>) => Promise<T>;

class X402Rollback extends Error {
  constructor(
    readonly reason: 'handler_response' | 'settlement_rejected',
    readonly response?: unknown,
  ) {
    super(reason);
  }
}

const ROUTES: X402RouteSpec[] = [
  {
    key: 'providers', method: 'GET', path: '/providers', endpointId: 'providers.search', scopes: ['health:data:read'], defaultPrice: '$0.005',
    description: 'Find labs, wearable integrations, and genetics providers across modalities and regions.', tags: ['health', 'providers', 'discovery'],
    discovery: {
      input: { modalities: 'biomarkers,genetics', region: 'US' },
      inputSchema: {
        properties: {
          modalities: { type: 'string', description: 'Comma-separated modalities: biomarkers, wearables, genetics, or behavioral.' },
          type: { type: 'string', description: 'Optional genetics provider type such as wgs, exome, or snp_array.' },
          region: { type: 'string', description: 'Optional country or service region.' },
        },
      },
      output: { example: { genetics: { providers: [] }, biomarkers: { locations: [] }, wearables: { providers: [] } } },
    },
  },
  {
    key: 'labs.search', method: 'GET', path: '/labs/search', endpointId: 'labs.search', scopes: ['health:labs:read'], defaultPrice: '$0.005',
    description: 'Find nearby supported lab collection locations or official locator handoffs.', tags: ['health', 'labs', 'locations'],
    discovery: {
      input: { provider: 'all', postal_code: '10001', radius_miles: 25 },
      inputSchema: {
        properties: {
          provider: { type: 'string', enum: ['quest', 'synlab', 'all'], description: 'Lab network to search.' },
          postal_code: { type: 'string', description: 'Postal code near the user.' },
          city: { type: 'string', description: 'City near the user.' },
          country: { type: 'string', description: 'Country code or country name.' },
          radius_miles: { type: 'number', description: 'Search radius in miles.' },
        },
      },
      output: { example: { results: [] } },
    },
  },
  {
    key: 'imports.file', method: 'POST', path: '/imports/file', endpointId: 'imports.file', scopes: ['health:data:write'], defaultPrice: '$0.02',
    description: 'Import biomarker, wearable, behavioral, or genetics data into the paying wallet private workspace.', tags: ['health', 'import', 'multimodal'],
    discovery: {
      bodyType: 'json',
      input: { category: 'biomarkers', filename: 'labs.csv', text: 'marker,value,unit\nldl,98,mg/dL' },
      inputSchema: {
        properties: {
          category: { type: 'string', enum: ['biomarkers', 'wearables', 'genetics', 'behavioral'], description: 'Wellness data modality.' },
          filename: { type: 'string', description: 'Original filename when available.' },
          content_type: { type: 'string', description: 'MIME type when available.' },
          provider: { type: 'string', description: 'Source provider or device.' },
          text: { type: 'string', description: 'UTF-8 payload. Use data_base64 instead for binary data.' },
          data_base64: { type: 'string', description: 'Base64-encoded payload.' },
        },
        required: ['category'],
      },
      output: { example: { source: { id: 'src_...', category: 'biomarkers' }, normalized_observations: [] } },
    },
  },
  {
    key: 'analyses.create', method: 'POST', path: '/analyses', endpointId: 'analyses.create', scopes: ['health:data:write'], defaultPrice: '$0.05',
    description: 'Run a multimodal analysis over source IDs owned by the paying wallet.', tags: ['health', 'analysis', 'longevity'],
    discovery: {
      bodyType: 'json',
      input: { source_ids: ['src_...'], profile: { age: 42, sex: 'female' } },
      inputSchema: {
        properties: {
          source_ids: { type: 'array', items: { type: 'string' }, description: 'Source IDs returned by paid or authenticated imports.' },
          profile: { type: 'object', description: 'Optional age and biological sex used for reference ranges.' },
        },
        required: ['source_ids'],
      },
      output: { example: { id: 'an_...', status: 'complete', dashboard_spec: { cards: [] } } },
    },
  },
  ...(['biomarkers/derive', 'biomarkers/analyze', 'wearables/analyze', 'genetics/analyze'] as const).map((route): X402RouteSpec => {
    const endpointId = route.replace('/', '.') as EndpointId;
    const genetics = route.startsWith('genetics');
    return {
      key: endpointId,
      method: 'POST',
      path: `/${route}`,
      endpointId,
      scopes: ['health:data:write'],
      defaultPrice: genetics ? '$0.10' : '$0.05',
      description: `Run the ${route.replace('/', ' ')} operation over source IDs owned by the paying wallet.`,
      tags: ['health', route.split('/')[0], 'analysis'],
      discovery: {
        bodyType: 'json',
        input: { source_ids: ['src_...'] },
        inputSchema: { properties: { source_ids: { type: 'array', items: { type: 'string' }, description: 'Source IDs in the paying wallet workspace.' } }, required: ['source_ids'] },
        output: { example: { id: 'an_...', status: 'complete', findings: [] } },
      },
    };
  }),
  {
    key: 'analyses.read', method: 'GET', path: '/analyses/:id', endpointId: 'analyses.read', scopes: ['health:data:read'], defaultPrice: '$0.005',
    description: 'Read an analysis owned by the paying wallet.', tags: ['health', 'analysis', 'results'],
    discovery: {
      pathParams: { id: 'an_...' },
      pathParamsSchema: { properties: { id: { type: 'string', description: 'Analysis ID.' } }, required: ['id'] },
      output: { example: { id: 'an_...', status: 'complete', findings: [] } },
    },
  },
  {
    key: 'analyses.recommendations.read', method: 'GET', path: '/analyses/:id/recommendations', endpointId: 'analyses.recommendations.read', scopes: ['health:data:read'], defaultPrice: '$0.01',
    description: 'Generate recommendations from an analysis owned by the paying wallet.', tags: ['health', 'recommendations', 'longevity'],
    discovery: {
      pathParams: { id: 'an_...' },
      pathParamsSchema: { properties: { id: { type: 'string', description: 'Analysis ID.' } }, required: ['id'] },
      output: { example: { analysis_id: 'an_...', recommendations: [] } },
    },
  },
  {
    key: 'analyses.action_plan.read', method: 'GET', path: '/analyses/:id/action-plan', endpointId: 'analyses.action_plan.read', scopes: ['health:data:read'], defaultPrice: '$0.02',
    description: 'Build a prioritized action plan from an analysis owned by the paying wallet.', tags: ['health', 'action-plan', 'longevity'],
    discovery: {
      pathParams: { id: 'an_...' },
      pathParamsSchema: { properties: { id: { type: 'string', description: 'Analysis ID.' } }, required: ['id'] },
      output: { example: { analysis_id: 'an_...', summary: '...', interventions: [] } },
    },
  },
  {
    key: 'sources.read', method: 'GET', path: '/sources/:id', endpointId: 'sources.read', scopes: ['health:data:read'], defaultPrice: '$0.005',
    description: 'Read a normalized source owned by the paying wallet.', tags: ['health', 'source', 'normalized-data'],
    discovery: {
      pathParams: { id: 'src_...' },
      pathParamsSchema: { properties: { id: { type: 'string', description: 'Source ID.' } }, required: ['id'] },
      output: { example: { source: { id: 'src_...' }, normalized_observations: [] } },
    },
  },
  {
    key: 'dashboard_specs.read', method: 'GET', path: '/dashboard-specs/:analysisId', endpointId: 'dashboard_specs.read', scopes: ['health:data:read'], defaultPrice: '$0.01',
    description: 'Get a renderer-neutral custom dashboard specification for an analysis owned by the paying wallet.', tags: ['health', 'dashboard', 'visualization'],
    discovery: {
      pathParams: { analysisId: 'an_...' },
      pathParamsSchema: { properties: { analysisId: { type: 'string', description: 'Analysis ID.' } }, required: ['analysisId'] },
      output: { example: { analysis_id: 'an_...', cards: [], provenance: { source_ids: [] } } },
    },
  },
  {
    key: 'query.create', method: 'POST', path: '/query', endpointId: 'query.create', scopes: ['health:data:read'], defaultPrice: '$0.01',
    description: 'Ask a grounded question across wellness data and analyses owned by the paying wallet.', tags: ['wellness', 'query', 'agent'],
    discovery: {
      bodyType: 'json',
      input: { query: 'What should I prioritize this week?', analysis_ids: ['an_...'] },
      inputSchema: {
        properties: {
          query: { type: 'string', description: 'Question to answer from the wallet-owned health context.' },
          analysis_ids: { type: 'array', items: { type: 'string' }, description: 'Optional analysis IDs to focus on.' },
        },
        required: ['query'],
      },
      output: { example: { answer: '...', evidence: [] } },
    },
  },
  {
    key: 'genetics.ancestry.create', method: 'POST', path: '/genetics/ancestry', endpointId: 'genetics.ancestry.create', scopes: ['health:data:read'], defaultPrice: '$0.10',
    description: 'Generate ancestry proportions and map data from a genetics source owned by the paying wallet.', tags: ['health', 'genetics', 'ancestry'],
    discovery: {
      bodyType: 'json',
      input: { source_id: 'src_...', resolution: 'regional' },
      inputSchema: {
        properties: {
          source_id: { type: 'string', description: 'Genetics source ID returned by an import.' },
          resolution: { type: 'string', enum: ['continental', 'regional', 'sub_population'], description: 'Requested ancestry resolution.' },
        },
        required: ['source_id'],
      },
      output: { example: { status: 'complete', ancestry: [], geographic_map: { regions: [] } } },
    },
  },
];

export class X402ConfigurationError extends Error {}

export class X402GatewayError extends Error {
  constructor(public readonly status: 502 | 503, message: string) {
    super(message);
  }
}

export function loadX402Config(env: NodeJS.ProcessEnv = process.env): X402Config | undefined {
  if (!billingEnabled(env) || env.X402_ENABLED !== 'true') return undefined;
  const publicBaseUrl = requiredUrl(env.X402_PUBLIC_BASE_URL ?? env.PUBLIC_BASE_URL, 'X402_PUBLIC_BASE_URL or PUBLIC_BASE_URL');
  const facilitatorUrls = commaList(env.X402_FACILITATOR_URLS)
    .map(url => requiredUrl(url, 'X402_FACILITATOR_URLS'));
  if (facilitatorUrls.length === 0) throw new X402ConfigurationError('X402_FACILITATOR_URLS is required when BILLING_ENABLED=true and X402_ENABLED=true.');

  const names = (commaList(env.X402_NETWORKS).length > 0 ? commaList(env.X402_NETWORKS) : ['base', 'polygon', 'solana']) as string[];
  const unknown = names.filter(name => !(name in X402_NETWORKS));
  if (unknown.length > 0) throw new X402ConfigurationError(`Unsupported X402_NETWORKS value(s): ${unknown.join(', ')}.`);
  const evmPayTo = env.X402_EVM_PAY_TO?.trim();
  const solanaPayTo = env.X402_SOLANA_PAY_TO?.trim();
  const networks = Array.from(new Set(names)).map(name => {
    const networkName = name as X402NetworkName;
    const payTo = networkName === 'solana' ? solanaPayTo : evmPayTo;
    if (!payTo) throw new X402ConfigurationError(`${networkName === 'solana' ? 'X402_SOLANA_PAY_TO' : 'X402_EVM_PAY_TO'} is required for ${networkName}.`);
    if (networkName !== 'solana' && !/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new X402ConfigurationError('X402_EVM_PAY_TO must be a 20-byte 0x-prefixed address.');
    if (networkName === 'solana' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payTo)) throw new X402ConfigurationError('X402_SOLANA_PAY_TO must be a base58 Solana address.');
    return { name: networkName, id: X402_NETWORKS[networkName], payTo };
  });

  const prices = parsePrices(env.X402_ROUTE_PRICES);
  const facilitatorAuthHeaders = parseFacilitatorAuthHeaders(env.X402_FACILITATOR_AUTH_HEADERS);
  const cdpApiKeyId = env.CDP_API_KEY_ID?.trim();
  const cdpApiKeySecret = env.CDP_API_KEY_SECRET?.trim();
  if (facilitatorUrls.includes(CDP_FACILITATOR_URL) && (!cdpApiKeyId || !cdpApiKeySecret)) {
    throw new X402ConfigurationError('CDP_API_KEY_ID and CDP_API_KEY_SECRET are required when the CDP mainnet facilitator is configured.');
  }
  return { enabled: true, publicBaseUrl, facilitatorUrls, facilitatorAuthHeaders, cdpApiKeyId, cdpApiKeySecret, networks, prices };
}

export class X402Gateway {
  private readonly httpServer: x402HTTPResourceServer;
  private readonly payerByAdapter = new WeakMap<HTTPAdapter, string>();
  private ready?: Promise<void>;

  constructor(private readonly config: X402Config) {
    const clients = config.facilitatorUrls.map(url => {
      if (url === CDP_FACILITATOR_URL) {
        return new HTTPFacilitatorClient(createCdpFacilitatorConfig(config.cdpApiKeyId, config.cdpApiKeySecret));
      }
      return new HTTPFacilitatorClient({
        url,
        createAuthHeaders: async () => {
          const headers = config.facilitatorAuthHeaders[url] ?? {};
          return { verify: headers, settle: headers, supported: headers, bazaar: headers };
        },
      });
    });
    const resourceServer = new x402ResourceServer(clients);
    if (config.networks.some(network => network.name !== 'solana')) resourceServer.register('eip155:*', new ExactEvmScheme());
    if (config.networks.some(network => network.name === 'solana')) resourceServer.register('solana:*', new ExactSvmScheme());
    resourceServer.registerExtension(bazaarResourceServerExtension);
    resourceServer.onAfterVerify(async context => {
      const transport = context.transportContext as HTTPTransportContext | undefined;
      const payer = context.result.payer;
      if (transport?.request.adapter && payer) this.payerByAdapter.set(transport.request.adapter, payer);
    });
    this.httpServer = new x402HTTPResourceServer(resourceServer, buildRouteConfig(config));
  }

  describe(): X402PublicConfig {
    return describeX402(this.config);
  }

  async probe(): Promise<{ ok: boolean; networks: string[]; facilitators: number; detail?: string }> {
    try {
      await this.ensureReady();
      return { ok: true, networks: this.config.networks.map(network => network.id), facilitators: this.config.facilitatorUrls.length };
    } catch (error) {
      return {
        ok: false,
        networks: this.config.networks.map(network => network.id),
        facilitators: this.config.facilitatorUrls.length,
        detail: error instanceof Error ? error.message : 'x402 facilitator initialization failed.',
      };
    }
  }

  matches(req: IncomingMessage): boolean {
    if (hasCredential(req.headers)) return false;
    const context = requestContext(req, this.config.publicBaseUrl);
    return this.httpServer.requiresPayment(context);
  }

  async execute(
    req: IncomingMessage,
    res: ServerResponse,
    handler: X402RouteHandler,
    atomic: X402AtomicExecutor = work => work(),
  ): Promise<X402ExecutionResult> {
    if (!this.matches(req)) return { handled: false };
    await this.ensureReady();
    const context = requestContext(req, this.config.publicBaseUrl);
    let result;
    try {
      result = await this.httpServer.processHTTPRequest(context);
    } catch (error) {
      throw new X402GatewayError(502, `x402 payment verification failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    if (result.type === 'no-payment-required') return { handled: false };
    if (result.type === 'payment-error') {
      writeInstructions(res, result.response);
      return { handled: true };
    }

    const payer = this.payerByAdapter.get(context.adapter);
    if (!payer) throw new X402GatewayError(502, 'The x402 facilitator verified the payment without returning a payer identity.');
    const spec = matchRoute(context.method, context.path);
    if (!spec) throw new X402GatewayError(503, 'The x402 route is not configured.');
    const auth = x402AuthContext(payer, result.paymentRequirements.network, spec);
    // A verified write can finish before a facilitator settlement response is
    // received. Derive a stable idempotency key from the signed payment so the
    // same payment can be retried safely without duplicating imports or analyses.
    if (context.method.toUpperCase() === 'POST' && !req.headers['idempotency-key'] && context.paymentHeader) {
      req.headers['idempotency-key'] = `x402:${createHash('sha256').update(context.paymentHeader).digest('hex')}`;
    }
    const buffered = new BufferedResponse();
    let settlementHeaders: Record<string, string> = {};
    try {
      await atomic(async () => {
        await handler(auth, buffered.asServerResponse());
        if (!buffered.ended) {
          throw new X402GatewayError(502, 'The paid endpoint did not produce a complete response.');
        }
        if (buffered.statusCode < 200 || buffered.statusCode >= 400) {
          throw new X402Rollback('handler_response');
        }

        const transport: HTTPTransportContext = {
          request: context,
          responseBody: buffered.body,
          responseHeaders: buffered.stringHeaders,
        };
        let settlement;
        try {
          settlement = await this.httpServer.processSettlement(
            result.paymentPayload,
            result.paymentRequirements,
            result.declaredExtensions,
            transport,
          );
        } catch (error) {
          throw new X402GatewayError(502, `x402 settlement failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
        if (!settlement.success) throw new X402Rollback('settlement_rejected', settlement.response);
        settlementHeaders = settlement.headers;
      });
    } catch (error) {
      if (error instanceof X402Rollback && error.reason === 'handler_response') {
        await result.cancellationDispatcher.cancel({ reason: 'handler_failed', responseStatus: buffered.statusCode }).catch(() => undefined);
        buffered.flush(res);
        return { handled: true };
      }
      if (error instanceof X402Rollback && error.reason === 'settlement_rejected') {
        writeInstructions(res, error.response as Parameters<typeof writeInstructions>[1]);
        return { handled: true };
      }
      await result.cancellationDispatcher.cancel({ reason: 'handler_threw', error }).catch(() => undefined);
      throw error;
    }
    buffered.flush(res, {
      ...settlementHeaders,
      'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, EXTENSION-RESPONSES',
    });
    return { handled: true };
  }

  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.httpServer.initialize().catch(error => {
        this.ready = undefined;
        throw new X402GatewayError(503, `x402 facilitator initialization failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      });
    }
    return this.ready;
  }
}

export function describeX402(config?: X402Config): X402PublicConfig {
  return {
    enabled: Boolean(config),
    version: 2,
    payment_header: 'PAYMENT-SIGNATURE',
    payment_response_header: 'PAYMENT-RESPONSE',
    networks: config?.networks.map(network => ({ name: network.name, caip2: network.id })) ?? [],
    facilitators: config?.facilitatorUrls ?? [],
    routes: config ? ROUTES.map(route => ({
      method: route.method,
      path: route.path,
      endpoint_id: route.endpointId,
      price_usd: priceFor(config, route),
      description: route.description,
    })) : [],
    identity: 'Payer-scoped private workspace. One EVM address shares an identity across Base and Polygon; Solana addresses are separate.',
    bazaar: { enabled: Boolean(config), dynamic_routes: true },
  };
}

function buildRouteConfig(config: X402Config): Record<string, RouteConfig> {
  return Object.fromEntries(ROUTES.map(route => [
    `${route.method} ${route.path}`,
    {
      accepts: config.networks.map(network => ({
        scheme: 'exact',
        network: network.id,
        payTo: network.payTo,
        price: priceFor(config, route),
      })),
      description: route.description,
      mimeType: 'application/json',
      serviceName: 'ForeverBetter API',
      tags: route.tags.slice(0, 5),
      extensions: declareDiscoveryExtension(route.discovery),
      unpaidResponseBody: async () => ({
        contentType: 'application/json',
        body: {
          type: 'https://app.wellnizz.com/problems/payment-required',
          title: 'Payment Required',
          status: 402,
          detail: 'Send a valid x402 PAYMENT-SIGNATURE header or authenticate with a ForeverBetter API key.',
          endpoint_id: route.endpointId,
          price: priceFor(config, route),
        },
      }),
    },
  ]));
}

function x402AuthContext(payer: string, network: string, route: X402RouteSpec): AuthContext {
  const namespace = network.startsWith('eip155:') ? 'eip155' : network.split(':', 1)[0];
  const normalizedPayer = namespace === 'eip155' ? payer.toLowerCase() : payer;
  const id = createHash('sha256').update(`${namespace}:${normalizedPayer}`).digest('hex').slice(0, 32);
  const userId = `x402_user_${id}`;
  const organizationId = `org_x402_${id}`;
  return {
    subject: `x402:${namespace}:${id}`,
    userId,
    scopes: new Set(route.scopes),
    enabledEndpoints: new Set([route.endpointId]),
    organizationIds: new Set([organizationId]),
    claims: {
      sub: `x402:${namespace}:${id}`,
      user_id: userId,
      organization_id: organizationId,
      token_type: 'x402',
      x402_network: network,
      x402_payer: normalizedPayer,
    },
    mode: 'x402',
  };
}

function requestContext(req: IncomingMessage, publicBaseUrl: string): HTTPRequestContext {
  const original = new URL(req.url ?? '/', publicBaseUrl);
  const path = original.pathname.startsWith('/v1/') ? original.pathname.slice(3) : original.pathname;
  const canonicalUrl = new URL(`${path}${original.search}`, publicBaseUrl).toString();
  const adapter = new NodeRequestAdapter(req, path, canonicalUrl);
  return { adapter, path, method: req.method ?? 'GET', paymentHeader: adapter.getHeader('payment-signature') };
}

class NodeRequestAdapter implements HTTPAdapter {
  constructor(private readonly req: IncomingMessage, private readonly path: string, private readonly canonicalUrl: string) {}
  getHeader(name: string): string | undefined {
    const value = this.req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }
  getMethod(): string { return this.req.method ?? 'GET'; }
  getPath(): string { return this.path; }
  getUrl(): string { return this.canonicalUrl; }
  getAcceptHeader(): string { return this.getHeader('accept') ?? 'application/json'; }
  getUserAgent(): string { return this.getHeader('user-agent') ?? ''; }
  getQueryParams(): Record<string, string | string[]> {
    const values: Record<string, string | string[]> = {};
    const url = new URL(this.canonicalUrl);
    for (const key of new Set(url.searchParams.keys())) {
      const all = url.searchParams.getAll(key);
      values[key] = all.length === 1 ? all[0] : all;
    }
    return values;
  }
  getQueryParam(name: string): string | string[] | undefined { return this.getQueryParams()[name]; }
}

class BufferedResponse {
  statusCode = 200;
  ended = false;
  body = Buffer.alloc(0);
  private readonly headers = new Map<string, OutgoingHttpHeader>();

  get stringHeaders(): Record<string, string> {
    return Object.fromEntries(Array.from(this.headers.entries()).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)]));
  }

  asServerResponse(): ServerResponse {
    const self = this;
    return {
      get statusCode() { return self.statusCode; },
      set statusCode(value: number) { self.statusCode = value; },
      get headersSent() { return false; },
      get writableEnded() { return self.ended; },
      setHeader(name: string, value: OutgoingHttpHeader) { self.headers.set(name.toLowerCase(), value); return this; },
      getHeader(name: string) { return self.headers.get(name.toLowerCase()); },
      getHeaders() { return Object.fromEntries(self.headers); },
      hasHeader(name: string) { return self.headers.has(name.toLowerCase()); },
      removeHeader(name: string) { self.headers.delete(name.toLowerCase()); },
      writeHead(statusCode: number, statusMessageOrHeaders?: string | Record<string, OutgoingHttpHeader>, maybeHeaders?: Record<string, OutgoingHttpHeader>) {
        self.statusCode = statusCode;
        const headers = typeof statusMessageOrHeaders === 'string' ? maybeHeaders : statusMessageOrHeaders;
        for (const [name, value] of Object.entries(headers ?? {})) if (value !== undefined) self.headers.set(name.toLowerCase(), value);
        return this;
      },
      write(chunk: unknown) { self.append(chunk); return true; },
      end(chunk?: unknown) { if (chunk !== undefined) self.append(chunk); self.ended = true; return this; },
    } as unknown as ServerResponse;
  }

  flush(res: ServerResponse, extraHeaders: Record<string, string> = {}): void {
    const headers = { ...Object.fromEntries(this.headers), ...extraHeaders };
    res.writeHead(this.statusCode, headers);
    res.end(this.body.length > 0 ? this.body : undefined);
  }

  private append(chunk: unknown): void {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.body = Buffer.concat([this.body, next]);
  }
}

function writeInstructions(res: ServerResponse, instructions: HTTPResponseInstructions): void {
  res.writeHead(instructions.status, instructions.headers);
  if (instructions.body === undefined) { res.end(); return; }
  if (typeof instructions.body === 'string' || Buffer.isBuffer(instructions.body)) { res.end(instructions.body); return; }
  res.end(JSON.stringify(instructions.body, null, 2));
}

function matchRoute(method: string, path: string): X402RouteSpec | undefined {
  return ROUTES.find(route => route.method === method.toUpperCase() && routeRegex(route.path).test(path));
}

function routeRegex(path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[a-zA-Z_][a-zA-Z0-9_]*/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

function priceFor(config: X402Config, route: X402RouteSpec): string {
  return config.prices[route.key] ?? config.prices[`${route.method} ${route.path}`] ?? route.defaultPrice;
}

function hasCredential(headers: IncomingHttpHeaders): boolean {
  return Boolean(headers.authorization || headers['x-foreverbetter-api-key']);
}

function commaList(value: string | undefined): string[] {
  return (value ?? '').split(',').map(item => item.trim()).filter(Boolean);
}

function requiredUrl(value: string | undefined, name: string): string {
  if (!value) throw new X402ConfigurationError(`${name} is required when BILLING_ENABLED=true and X402_ENABLED=true.`);
  let url: URL;
  try { url = new URL(value); } catch { throw new X402ConfigurationError(`${name} must contain valid absolute URL values.`); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname))) {
    throw new X402ConfigurationError(`${name} must use HTTPS outside localhost.`);
  }
  return value.replace(/\/$/, '');
}

function parsePrices(value: string | undefined): Record<string, string> {
  if (!value) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new X402ConfigurationError('X402_ROUTE_PRICES must be valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new X402ConfigurationError('X402_ROUTE_PRICES must be a JSON object.');
  const prices: Record<string, string> = {};
  for (const [key, price] of Object.entries(parsed)) {
    if (typeof price !== 'string' || !/^\$(?:0\.\d*[1-9]\d*|[1-9]\d*(?:\.\d+)?)$/.test(price)) {
      throw new X402ConfigurationError(`Invalid x402 price for ${key}; use a positive dollar string such as $0.01.`);
    }
    prices[key] = price;
  }
  return prices;
}

function parseFacilitatorAuthHeaders(value: string | undefined): Record<string, Record<string, string>> {
  if (!value) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new X402ConfigurationError('X402_FACILITATOR_AUTH_HEADERS must be valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new X402ConfigurationError('X402_FACILITATOR_AUTH_HEADERS must map facilitator URLs to header objects.');
  const result: Record<string, Record<string, string>> = {};
  for (const [url, headers] of Object.entries(parsed)) {
    const normalizedUrl = requiredUrl(url, 'X402_FACILITATOR_AUTH_HEADERS key');
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new X402ConfigurationError(`Facilitator auth headers for ${url} must be an object.`);
    result[normalizedUrl] = Object.fromEntries(Object.entries(headers).map(([name, header]) => {
      if (typeof header !== 'string') throw new X402ConfigurationError(`Facilitator auth header ${name} for ${url} must be a string.`);
      return [name, header];
    }));
  }
  return result;
}

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { loadAuthConfig } from '../src/auth.js';
import { createHealthApiServer } from '../src/http.js';
import { HealthApiStore } from '../src/store.js';
import { X402Gateway, X402_NETWORKS, describeX402, loadX402Config, type X402Config } from '../src/x402.js';

const EVM_PAYER = '0x2222222222222222222222222222222222222222';
const EVM_PAY_TO = '0x1111111111111111111111111111111111111111';
const SOLANA_PAYER = 'So11111111111111111111111111111111111111112';
const SOLANA_PAY_TO = '11111111111111111111111111111111';

test('x402 config requires explicit facilitators and payout addresses', () => {
  assert.equal(loadX402Config({ X402_ENABLED: 'false' }), undefined);
  assert.equal(loadX402Config({ BILLING_ENABLED: 'false', X402_ENABLED: 'true' }), undefined);
  assert.throws(() => loadX402Config({ BILLING_ENABLED: 'true', X402_ENABLED: 'true', PUBLIC_BASE_URL: 'https://api.example.test' }), /FACILITATOR_URLS/);
  assert.throws(() => loadX402Config({
    BILLING_ENABLED: 'true', X402_ENABLED: 'true', PUBLIC_BASE_URL: 'https://api.example.test', X402_FACILITATOR_URLS: 'https://facilitator.example.test',
  }), /X402_EVM_PAY_TO/);
  assert.throws(() => loadX402Config({
    BILLING_ENABLED: 'true', X402_ENABLED: 'true',
    PUBLIC_BASE_URL: 'https://api.example.test',
    X402_FACILITATOR_URLS: 'https://api.cdp.coinbase.com/platform/v2/x402',
    X402_NETWORKS: 'base',
    X402_EVM_PAY_TO: EVM_PAY_TO,
  }), /CDP_API_KEY_ID and CDP_API_KEY_SECRET/);

  const config = loadX402Config({
    BILLING_ENABLED: 'true',
    X402_ENABLED: 'true',
    PUBLIC_BASE_URL: 'https://api.example.test',
    X402_FACILITATOR_URLS: 'https://facilitator.example.test/',
    X402_FACILITATOR_AUTH_HEADERS: '{"https://facilitator.example.test/":{"authorization":"Bearer facilitator-token"}}',
    X402_NETWORKS: 'base,polygon,solana',
    X402_EVM_PAY_TO: EVM_PAY_TO,
    X402_SOLANA_PAY_TO: SOLANA_PAY_TO,
    X402_ROUTE_PRICES: '{"query.create":"$0.025"}',
  });
  assert.deepEqual(config?.facilitatorUrls, ['https://facilitator.example.test']);
  assert.equal(config?.facilitatorAuthHeaders['https://facilitator.example.test']?.authorization, 'Bearer facilitator-token');
  assert.deepEqual(config?.networks.map(network => network.id), [X402_NETWORKS.base, X402_NETWORKS.polygon, X402_NETWORKS.solana]);
  assert.equal(describeX402(config).routes.find(route => route.endpoint_id === 'query.create')?.price_usd, '$0.025');
});

test('x402 offers Bazaar-discoverable routes and settles successful wallet-scoped requests', async () => {
  const facilitator = fakeFacilitator();
  await listen(facilitator.server);
  const facilitatorAddress = facilitator.server.address() as AddressInfo;
  const apiConfig: X402Config = {
    enabled: true,
    publicBaseUrl: 'https://api.example.test',
    facilitatorUrls: [`http://127.0.0.1:${facilitatorAddress.port}`],
    facilitatorAuthHeaders: {},
    networks: [
      { name: 'base', id: X402_NETWORKS.base, payTo: EVM_PAY_TO },
      { name: 'polygon', id: X402_NETWORKS.polygon, payTo: EVM_PAY_TO },
      { name: 'solana', id: X402_NETWORKS.solana, payTo: SOLANA_PAY_TO },
    ],
    prices: {},
  };
  const auth = loadAuthConfig({
    NODE_ENV: 'test', AUTH_MODE: 'disabled', API_KEY_JWT_SECRET: 'test-secret',
    PUBLIC_BASE_URL: apiConfig.publicBaseUrl, REQUIRE_HTTPS: 'false',
  });
  const api = createHealthApiServer(undefined, { auth, x402: new X402Gateway(apiConfig) });
  await listen(api);
  const address = api.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const discovery = await fetch(`${base}/.well-known/x402.json`).then(response => response.json());
    assert.equal(discovery.enabled, true);
    assert.deepEqual(discovery.networks.map((network: any) => network.name), ['base', 'polygon', 'solana']);
    assert.ok(discovery.routes.some((route: any) => route.path === '/analyses/:id/action-plan'));

    const openApi = await fetch(`${base}/openapi.json`).then(response => response.json());
    assert.deepEqual(openApi.paths['/analyses/{id}/action-plan'].get.security, [{ bearerAuth: [] }, { x402: [] }]);
    assert.ok(openApi.paths['/analyses/{id}/action-plan'].get.responses['402']);
    assert.equal(openApi.paths['/analyses/{id}/action-plan'].get['x-x402'].price_usd, '$0.02');
    assert.deepEqual(openApi.paths['/analyses/{id}/action-plan'].get['x-payment-info'], {
      price: { mode: 'fixed', currency: 'USD', amount: '0.02' },
      protocols: [{ x402: {} }],
    });
    assert.match(openApi.info['x-guidance'], /PAYMENT-REQUIRED/);

    const manifest = await fetch(`${base}/.well-known/health-agent.json`).then(response => response.json());
    assert.equal(manifest.payments.x402.enabled, true);
    assert.match(manifest.payments.note, /never charged/i);

    const providerChallenge = await fetch(`${base}/providers`);
    assert.equal(providerChallenge.status, 402);
    const providerRequired = paymentRequired(providerChallenge);
    assert.match(JSON.stringify(providerRequired), /Wellnizz API/);
    assert.deepEqual(providerRequired.accepts.map(option => option.network), [X402_NETWORKS.base, X402_NETWORKS.polygon, X402_NETWORKS.solana]);
    assert.equal(providerRequired.resource.url, 'https://api.example.test/providers');
    assert.equal((providerRequired.extensions?.bazaar as any).info.input.method, 'GET');

    const providers = await paidFetch(`${base}/providers`, providerRequired, X402_NETWORKS.base, EVM_PAYER);
    assert.equal(providers.response.status, 200);
    assert.ok(providers.body.genetics.length > 0);
    assert.equal(decodePaymentResponseHeader(providers.response.headers.get('payment-response')!).success, true);

    const dynamicChallenge = await fetch(`${base}/analyses/an_example/action-plan`);
    const dynamicRequired = paymentRequired(dynamicChallenge);
    const bazaar = dynamicRequired.extensions?.bazaar as any;
    assert.equal(bazaar.routeTemplate, '/analyses/:id/action-plan');
    assert.deepEqual(bazaar.info.input.pathParams, { id: 'an_example' });

    const importBody = {
      category: 'biomarkers', filename: 'labs.csv', content_type: 'text/csv',
      text: 'marker,value,unit\nApoB,118,mg/dL\n',
    };
    const imported = await paidJson(base, '/imports/file', 'POST', importBody, X402_NETWORKS.base, EVM_PAYER);
    assert.equal(imported.response.status, 201);
    assert.match(imported.body.source.user_id, /^x402_user_/);
    assert.match(imported.body.source.organization_id, /^org_x402_/);

    // Retrying the same signed payment and POST body replays the stored result.
    const importedRetry = await paidJson(base, '/imports/file', 'POST', importBody, X402_NETWORKS.base, EVM_PAYER);
    assert.equal(importedRetry.response.status, 201);
    assert.equal(importedRetry.body.source.id, imported.body.source.id);

    // The same EVM wallet maps to one private identity on both Base and Polygon.
    const sourceRead = await paidJson(base, `/sources/${imported.body.source.id}`, 'GET', undefined, X402_NETWORKS.polygon, EVM_PAYER);
    assert.equal(sourceRead.response.status, 200);
    assert.equal(sourceRead.body.source.user_id, imported.body.source.user_id);

    // A different wallet namespace cannot buy access to someone else's source.
    const denied = await paidJson(base, `/sources/${imported.body.source.id}`, 'GET', undefined, X402_NETWORKS.solana, SOLANA_PAYER);
    assert.equal(denied.response.status, 403);
    assert.equal(denied.response.headers.get('payment-response'), null);

    const apiKeyBypass = await fetch(`${base}/providers`, { headers: { authorization: 'Bearer existing-api-key' } });
    assert.equal(apiKeyBypass.status, 200);
    assert.equal(apiKeyBypass.headers.get('payment-required'), null);
    assert.equal(facilitator.settlements, 4);
  } finally {
    await close(api);
    await close(facilitator.server);
  }
});

test('x402 rolls back paid writes when settlement is rejected', async () => {
  const facilitator = fakeFacilitator({ settleSuccess: false });
  await listen(facilitator.server);
  const facilitatorAddress = facilitator.server.address() as AddressInfo;
  const config: X402Config = {
    enabled: true,
    publicBaseUrl: 'https://api.example.test',
    facilitatorUrls: [`http://127.0.0.1:${facilitatorAddress.port}`],
    facilitatorAuthHeaders: {},
    networks: [{ name: 'base', id: X402_NETWORKS.base, payTo: EVM_PAY_TO }],
    prices: {},
  };
  const auth = loadAuthConfig({
    NODE_ENV: 'test', AUTH_MODE: 'disabled', API_KEY_JWT_SECRET: 'test-secret',
    PUBLIC_BASE_URL: config.publicBaseUrl, REQUIRE_HTTPS: 'false',
  });
  let attemptedSourceId = '';
  class ObservedStore extends HealthApiStore {
    override async saveSource(...args: Parameters<HealthApiStore['saveSource']>): Promise<void> {
      attemptedSourceId = args[0].id;
      await super.saveSource(...args);
    }
  }
  const store = new ObservedStore();
  const api = createHealthApiServer(store, { auth, x402: new X402Gateway(config) });
  await listen(api);
  const address = api.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const body = {
      category: 'biomarkers', filename: 'labs.csv', content_type: 'text/csv',
      text: 'marker,value,unit\nApoB,118,mg/dL\n',
    };
    const challenge = await fetch(`${base}/imports/file`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const paid = await paidFetch(`${base}/imports/file`, paymentRequired(challenge), X402_NETWORKS.base, EVM_PAYER, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(paid.response.status, 402);
    assert.ok(attemptedSourceId);
    assert.equal(await store.getSource(attemptedSourceId), undefined, 'rejected settlement must roll back the imported source');
  } finally {
    await close(api);
    await close(facilitator.server);
  }
});

function fakeFacilitator(options: { settleSuccess?: boolean } = {}) {
  let settlements = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/supported') {
      return json(res, 200, {
        kinds: [
          { x402Version: 2, scheme: 'exact', network: X402_NETWORKS.base, extra: {} },
          { x402Version: 2, scheme: 'exact', network: X402_NETWORKS.polygon, extra: {} },
          { x402Version: 2, scheme: 'exact', network: X402_NETWORKS.solana, extra: { feePayer: SOLANA_PAY_TO } },
        ],
        extensions: ['bazaar'],
        signers: {},
      });
    }
    const request = await readJson(req);
    const network = request.paymentRequirements.network;
    const payer = String((request.paymentPayload.payload as Record<string, unknown>).payer);
    if (req.url === '/verify') return json(res, 200, { isValid: true, payer });
    if (req.url === '/settle') {
      settlements += 1;
      if (options.settleSuccess === false) {
        return json(res, 200, {
          success: false,
          errorReason: 'payment already used',
          payer,
          transaction: '',
          network,
        });
      }
      return json(res, 200, {
        success: true,
        payer,
        transaction: `tx_${settlements}`,
        network,
        amount: request.paymentRequirements.amount,
        extensions: { bazaar: { status: 'success' } },
      });
    }
    json(res, 404, { error: 'not found' });
  });
  return { server, get settlements() { return settlements; } };
}

async function paidJson(base: string, path: string, method: 'GET' | 'POST', body: unknown, network: string, payer: string) {
  const init: RequestInit = {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const challenge = await fetch(`${base}${path}`, init);
  assert.equal(challenge.status, 402, await challenge.text());
  return paidFetch(`${base}${path}`, paymentRequired(challenge), network, payer, init);
}

async function paidFetch(url: string, required: PaymentRequired, network: string, payer: string, init: RequestInit = {}) {
  const accepted = required.accepts.find(option => option.network === network);
  assert.ok(accepted, `No payment option for ${network}`);
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: { payer },
    extensions: required.extensions,
  };
  const headers = new Headers(init.headers);
  headers.set('payment-signature', encodePaymentSignatureHeader(payload));
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

function paymentRequired(response: Response): PaymentRequired {
  const header = response.headers.get('payment-required');
  assert.ok(header, 'PAYMENT-REQUIRED header missing');
  return decodePaymentRequiredHeader(header);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function listen(server: import('node:http').Server): Promise<void> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
}

async function close(server: import('node:http').Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

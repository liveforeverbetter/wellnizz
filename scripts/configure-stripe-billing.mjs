#!/usr/bin/env node
/**
 * Creates or reconciles the ForeverBetter API Stripe catalog.
 *
 * Run where STRIPE_SECRET_KEY is available. It emits one JSON object so a
 * deployment command can consume generated IDs without printing credentials.
 */

const api = 'https://api.stripe.com/v1';
const webhookUrl = 'https://api.foreverbetter.xyz/billing/stripe/webhook';
const returnUrl = 'https://api.foreverbetter.xyz/dashboard';
const productKey = 'foreverbetter-api';
const compatibleProductKeys = new Set([productKey, 'longevity-api']);
const secret = process.env.STRIPE_SECRET_KEY;
if (!secret) throw new Error('STRIPE_SECRET_KEY is required.');

const plans = [
  { id: 'standard', name: 'Standard', amount: 999, description: 'Personal longevity agent, MCP, wearable connections, and managed cloud analysis.' },
  { id: 'builder', name: 'Builder', amount: 2499, description: 'Commercial longevity-agent prototypes, webhooks, and production workflows.' },
  { id: 'growth', name: 'Growth', amount: 4900, description: 'Highest self-serve tier for production multi-agent and multi-workspace automation.' },
];
const events = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];

async function stripe(path, params, method = 'POST') {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(params ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Stripe ${method} ${path} failed: ${body?.error?.message ?? response.status}`);
  return body;
}

async function list(path) {
  return stripe(path, undefined, 'GET');
}

const products = await list('/products?active=true&limit=100');
const prices = {};
const planProducts = {};
for (const plan of plans) {
  let product = products.data?.find(item => compatibleProductKeys.has(item.metadata?.foreverbetter_product)
    && item.metadata?.foreverbetter_tier === plan.id);
  if (!product) {
    product = await stripe('/products', {
      name: `ForeverBetter API - ${plan.name}`,
      description: plan.description,
      'metadata[foreverbetter_product]': productKey,
      'metadata[foreverbetter_tier]': plan.id,
    });
  } else if (product.metadata?.foreverbetter_product !== productKey
    || product.name !== `ForeverBetter API - ${plan.name}`
    || product.description !== plan.description) {
    product = await stripe(`/products/${encodeURIComponent(product.id)}`, {
      name: `ForeverBetter API - ${plan.name}`,
      description: plan.description,
      'metadata[foreverbetter_product]': productKey,
    });
  }
  planProducts[plan.id] = product.id;
  const result = await list(`/prices?active=true&product=${encodeURIComponent(product.id)}&type=recurring&limit=100`);
  let price = result.data?.find(item => item.currency === 'usd'
    && item.unit_amount === plan.amount
    && item.recurring?.interval === 'month'
    && item.metadata?.foreverbetter_tier === plan.id);
  if (!price) {
    price = await stripe('/prices', {
      product: product.id,
      currency: 'usd',
      unit_amount: String(plan.amount),
      'recurring[interval]': 'month',
      nickname: plan.name,
      'metadata[foreverbetter_tier]': plan.id,
      'metadata[foreverbetter_product]': productKey,
    });
  } else if (price.metadata?.foreverbetter_product !== productKey) {
    price = await stripe(`/prices/${encodeURIComponent(price.id)}`, {
      'metadata[foreverbetter_product]': productKey,
    });
  }
  prices[plan.id] = price.id;
}

const portalParams = {
  default_return_url: returnUrl,
  'business_profile[headline]': 'Manage your ForeverBetter API plan.',
  'features[customer_update][enabled]': 'true',
  'features[customer_update][allowed_updates][0]': 'email',
  'features[invoice_history][enabled]': 'true',
  'features[payment_method_update][enabled]': 'true',
  'features[subscription_cancel][enabled]': 'true',
  'features[subscription_cancel][mode]': 'at_period_end',
  'features[subscription_update][enabled]': 'true',
  'features[subscription_update][default_allowed_updates][0]': 'price',
  'features[subscription_update][proration_behavior]': 'create_prorations',
  'features[subscription_update][products][0][product]': planProducts.standard,
  'features[subscription_update][products][0][prices][0]': prices.standard,
  'features[subscription_update][products][1][product]': planProducts.builder,
  'features[subscription_update][products][1][prices][0]': prices.builder,
  'features[subscription_update][products][2][product]': planProducts.growth,
  'features[subscription_update][products][2][prices][0]': prices.growth,
};
const configuredPortalId = process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID;
if (configuredPortalId) portalParams.active = 'true';
const portal = configuredPortalId
  ? await stripe(`/billing_portal/configurations/${encodeURIComponent(configuredPortalId)}`, portalParams)
  : await stripe('/billing_portal/configurations', portalParams);

let webhookSecret;
const configuredWebhookId = process.env.STRIPE_WEBHOOK_ENDPOINT_ID;
let webhookId = configuredWebhookId;
if (configuredWebhookId) {
  await stripe(`/webhook_endpoints/${encodeURIComponent(configuredWebhookId)}`, webhookParams());
} else {
  const endpoints = await list('/webhook_endpoints?limit=100');
  const existing = endpoints.data?.find(item => item.url === webhookUrl
    && compatibleProductKeys.has(item.metadata?.foreverbetter_product));
  if (existing) {
    webhookId = existing.id;
    await stripe(`/webhook_endpoints/${encodeURIComponent(webhookId)}`, webhookParams());
    if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error('Existing ForeverBetter webhook found. Set STRIPE_WEBHOOK_ENDPOINT_ID and STRIPE_WEBHOOK_SECRET, then rerun.');
  } else {
    const webhook = await stripe('/webhook_endpoints', webhookParams());
    webhookId = webhook.id;
    webhookSecret = webhook.secret;
  }
}

// This script's earlier catalog shape used one product with three monthly
// prices, which Stripe's portal rejects. It was created during setup, has no
// subscriptions, and can be cleanly archived after the replacement catalog is
// configured.
for (const legacyProduct of products.data?.filter(item => compatibleProductKeys.has(item.metadata?.foreverbetter_product) && !item.metadata?.foreverbetter_tier) ?? []) {
  const legacyPrices = await list(`/prices?active=true&product=${encodeURIComponent(legacyProduct.id)}&limit=100`);
  for (const legacyPrice of legacyPrices.data ?? []) await stripe(`/prices/${encodeURIComponent(legacyPrice.id)}`, { active: 'false' });
  await stripe(`/products/${encodeURIComponent(legacyProduct.id)}`, { active: 'false' });
}

console.log(JSON.stringify({
  product_ids: planProducts,
  price_standard: prices.standard,
  price_builder: prices.builder,
  price_growth: prices.growth,
  portal_configuration_id: portal.id,
  webhook_endpoint_id: webhookId,
  webhook_secret: webhookSecret,
}));

function webhookParams() {
  const params = {
    url: webhookUrl,
    description: 'ForeverBetter API hosted billing',
    'metadata[foreverbetter_product]': productKey,
  };
  for (const [index, event] of events.entries()) params[`enabled_events[${index}]`] = event;
  return params;
}

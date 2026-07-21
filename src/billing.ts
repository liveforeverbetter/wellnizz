import { createHmac, timingSafeEqual } from 'node:crypto';
import { getPool } from './db/pool.js';
import { HOSTED_INTRODUCTORY_REQUEST_LIMIT, tierById, type PricingTierId } from './pricing.js';

const STRIPE_API = 'https://api.stripe.com/v1';
const ACTIVE_STATUSES = new Set(['active', 'trialing']);
const CHECKOUT_TIERS: PricingTierId[] = ['standard', 'builder', 'growth'];

export interface BillingSubscription {
  user_id: string;
  organization_id: string;
  tier: PricingTierId;
  status: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  stripe_price_id: string;
  current_period_end?: string;
  cancel_at_period_end: boolean;
}

export interface HostedIntroductoryUsage {
  limit: number;
  used: number;
  remaining: number;
  payment_required: boolean;
}

interface HostedIntroductoryRequestResult extends HostedIntroductoryUsage {
  allowed: boolean;
}

export interface StripeBillingConfig {
  secretKey: string;
  webhookSecret: string;
  priceIds: Record<'standard' | 'builder' | 'growth', string>;
  returnUrl: string;
  portalConfigurationId?: string;
}

/**
 * A self-hoster must explicitly opt into any revenue collection surface.
 * Credentials alone must never activate Stripe or x402 payments.
 */
export function billingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BILLING_ENABLED === 'true';
}

export function stripeBillingConfig(env: NodeJS.ProcessEnv = process.env): StripeBillingConfig | undefined {
  if (!billingEnabled(env)) return undefined;
  const secretKey = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  const standard = env.STRIPE_PRICE_STANDARD;
  const builder = env.STRIPE_PRICE_BUILDER;
  const growth = env.STRIPE_PRICE_GROWTH;
  if (!secretKey || !webhookSecret || !standard || !builder || !growth) return undefined;
  return {
    secretKey,
    webhookSecret,
    priceIds: { standard, builder, growth },
    returnUrl: env.STRIPE_BILLING_RETURN_URL ?? 'https://app.wellnizz.com/dashboard',
    portalConfigurationId: env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID,
  };
}

export class StripeBillingService {
  constructor(private readonly config: StripeBillingConfig = requiredStripeBillingConfig()) {}

  async subscriptionFor(userId: string, organizationId: string): Promise<BillingSubscription | undefined> {
    const result = await getPool().query(
      `select * from health_api.billing_subscriptions
       where user_id=$1 and organization_id=$2
       order by updated_at desc limit 1`,
      [userId, organizationId],
    );
    return result.rows[0] ? subscriptionFromRow(result.rows[0]) : undefined;
  }

  async activeTierFor(userId: string, organizationId: string): Promise<PricingTierId | undefined> {
    const subscription = await this.subscriptionFor(userId, organizationId);
    return subscription && ACTIVE_STATUSES.has(subscription.status) ? subscription.tier : undefined;
  }

  /**
   * Full dbSNP is a paid, reference-heavy operation. Stripe Checkout always
   * collects a reusable payment method, but verify the customer/subscription
   * state again at the expensive-operation boundary instead of trusting an API
   * key's cached tier claim.
   */
  async assertFullDbsnpAccess(userId: string, organizationId: string): Promise<PricingTierId> {
    const subscription = await this.subscriptionFor(userId, organizationId);
    if (!subscription || !ACTIVE_STATUSES.has(subscription.status)) {
      throw new BillingError(402, 'Full dbSNP annotation requires an active paid hosted subscription. Add a payment method and choose an eligible plan.');
    }
    const tier = tierById(subscription.tier);
    const quota = tier?.monthly_quotas.full_dbsnp_jobs;
    if (!tier || quota === 0) {
      throw new BillingError(403, 'Full dbSNP annotation is not included in this hosted plan. Choose Builder, Growth, or Enterprise.');
    }
    if (!await this.customerHasPaymentMethod(subscription.stripe_customer_id, subscription.stripe_subscription_id)) {
      throw new BillingError(402, 'Full dbSNP annotation requires a valid payment method on file. Update billing details and try again.');
    }
    return subscription.tier;
  }

  async introductoryUsageFor(userId: string, organizationId: string): Promise<HostedIntroductoryUsage> {
    const result = await getPool().query(
      `select requests_used from health_api.hosted_introductory_usage
       where user_id=$1 and organization_id=$2`,
      [userId, organizationId],
    );
    return hostedIntroductoryUsage(Number(result.rows[0]?.requests_used ?? 0));
  }

  /**
   * Atomically reserve one of the hosted evaluation requests. The update's
   * predicate is the enforcement boundary: concurrent requests cannot exceed
   * the allowance, and the count survives process restarts and deployments.
   */
  async consumeIntroductoryRequest(userId: string, organizationId: string): Promise<HostedIntroductoryRequestResult> {
    const result = await getPool().query(
      `insert into health_api.hosted_introductory_usage (user_id, organization_id, requests_used)
       values ($1, $2, 1)
       on conflict (user_id, organization_id) do update
         set requests_used = health_api.hosted_introductory_usage.requests_used + 1,
             updated_at = now()
         where health_api.hosted_introductory_usage.requests_used < $3
       returning requests_used`,
      [userId, organizationId, HOSTED_INTRODUCTORY_REQUEST_LIMIT],
    );
    if (result.rows[0]) return { ...hostedIntroductoryUsage(Number(result.rows[0].requests_used)), allowed: true };
    return { ...(await this.introductoryUsageFor(userId, organizationId)), allowed: false };
  }

  async createCheckoutSession(input: { userId: string; organizationId: string; email?: string; tier: PricingTierId; activationSource: BillingActivationSource }): Promise<{ url: string }> {
    if (!CHECKOUT_TIERS.includes(input.tier as (typeof CHECKOUT_TIERS)[number])) {
      throw new BillingError(400, 'Choose Standard, Builder, or Growth for hosted Checkout.');
    }
    const existing = await this.subscriptionFor(input.userId, input.organizationId);
    if (existing && ACTIVE_STATUSES.has(existing.status)) {
      throw new BillingError(409, 'A hosted subscription already exists. Use the billing portal to change or cancel it.');
    }
    const customerId = existing?.stripe_customer_id ?? await this.createCustomer(input);
    const priceId = this.config.priceIds[input.tier as 'standard' | 'builder' | 'growth'];
    const returnUrl = this.config.returnUrl.replace(/\/$/, '');
    const checkout = new URLSearchParams({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: `${input.userId}:${input.organizationId}`,
      success_url: `${returnUrl}?checkout=success`,
      cancel_url: `${returnUrl}?checkout=cancelled`,
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      // Collect a reusable payment method now. Checkout keeps its supported
      // wallets available, then begins the subscription with no charge today.
      payment_method_collection: 'always',
      'metadata[user_id]': input.userId,
      'metadata[organization_id]': input.organizationId,
      'metadata[tier]': input.tier,
      'metadata[activation_source]': input.activationSource,
      'subscription_data[metadata][user_id]': input.userId,
      'subscription_data[metadata][organization_id]': input.organizationId,
      'subscription_data[metadata][tier]': input.tier,
      'subscription_data[metadata][activation_source]': input.activationSource,
    });
    const session = await this.request('/checkout/sessions', checkout);
    if (typeof session.url !== 'string') throw new BillingError(502, 'Stripe did not return a Checkout URL.');
    return { url: session.url };
  }

  async createPortalSession(input: { userId: string; organizationId: string }): Promise<{ url: string }> {
    const subscription = await this.subscriptionFor(input.userId, input.organizationId);
    if (!subscription?.stripe_customer_id) throw new BillingError(404, 'No hosted Stripe subscription was found for this workspace.');
    const params = new URLSearchParams({
      customer: subscription.stripe_customer_id,
      return_url: this.config.returnUrl,
    });
    if (this.config.portalConfigurationId) params.set('configuration', this.config.portalConfigurationId);
    const session = await this.request('/billing_portal/sessions', params);
    if (typeof session.url !== 'string') throw new BillingError(502, 'Stripe did not return a billing portal URL.');
    return { url: session.url };
  }

  async processWebhook(rawBody: Buffer, signature: string | undefined): Promise<void> {
    if (!verifyStripeSignature(rawBody, signature, this.config.webhookSecret)) throw new BillingError(401, 'Invalid Stripe webhook signature.');
    const event = JSON.parse(rawBody.toString('utf8')) as StripeEvent;
    if (!event.id || !event.type || !event.data?.object) throw new BillingError(400, 'Malformed Stripe webhook event.');
    const inserted = await getPool().query(
      `insert into health_api.billing_webhook_events (stripe_event_id, type, payload)
       values ($1,$2,$3::jsonb) on conflict (stripe_event_id) do nothing returning stripe_event_id`,
      [event.id, event.type, JSON.stringify(event)],
    );
    if (inserted.rowCount === 0) return;
    try {
      const object = event.data.object;
      if (event.type === 'checkout.session.completed' && typeof object.subscription === 'string') {
        await this.syncSubscription(object.subscription, objectRecord(object.metadata));
      } else if (event.type.startsWith('customer.subscription.')) {
        await this.saveSubscription(object);
      } else if ((event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') && typeof object.subscription === 'string') {
        await this.syncSubscription(object.subscription, objectRecord(object.metadata));
      }
      await getPool().query('update health_api.billing_webhook_events set processed_at=now() where stripe_event_id=$1', [event.id]);
    } catch (error) {
      await getPool().query('update health_api.billing_webhook_events set error=$2 where stripe_event_id=$1', [event.id, error instanceof Error ? error.message : String(error)]);
      throw error;
    }
  }

  private async createCustomer(input: { userId: string; organizationId: string; email?: string }): Promise<string> {
    const form = new URLSearchParams({
      'metadata[user_id]': input.userId,
      'metadata[organization_id]': input.organizationId,
    });
    if (input.email) form.set('email', input.email);
    const customer = await this.request('/customers', form);
    if (typeof customer.id !== 'string') throw new BillingError(502, 'Stripe did not return a customer ID.');
    return customer.id;
  }

  private async customerHasPaymentMethod(customerId: string, subscriptionId: string): Promise<boolean> {
    const customer = await this.request(`/customers/${encodeURIComponent(customerId)}`);
    const invoiceSettings = objectRecord(customer.invoice_settings);
    if (typeof invoiceSettings?.default_payment_method === 'string' || typeof invoiceSettings?.default_source === 'string') return true;
    const subscription = await this.request(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
    return typeof subscription.default_payment_method === 'string' || typeof subscription.default_source === 'string';
  }

  private async syncSubscription(id: string, fallbackMetadata?: Record<string, unknown>): Promise<void> {
    const subscription = await this.request(`/subscriptions/${encodeURIComponent(id)}`);
    await this.saveSubscription(subscription, fallbackMetadata);
  }

  private async saveSubscription(subscription: Record<string, unknown>, fallbackMetadata?: Record<string, unknown>): Promise<void> {
    const metadata = objectRecord(subscription.metadata) ?? fallbackMetadata ?? {};
    const userId = stringValue(metadata.user_id);
    const organizationId = stringValue(metadata.organization_id);
    const tier = stringValue(metadata.tier);
    const customerId = stringValue(subscription.customer);
    const subscriptionId = stringValue(subscription.id);
    const status = stringValue(subscription.status);
    const firstItem = objectRecord(arrayValue(objectRecord(subscription.items)?.data)[0]);
    const priceId = stringValue(objectRecord(firstItem?.price)?.id);
    if (!userId || !organizationId || !customerId || !subscriptionId || !status || !priceId || !isCheckoutTier(tier)) {
      throw new BillingError(400, 'Stripe subscription is missing Wellnizz subscription metadata.');
    }
    await getPool().query(
      `insert into health_api.billing_subscriptions
        (stripe_subscription_id, stripe_customer_id, stripe_price_id, user_id, organization_id, tier, status, current_period_end, cancel_at_period_end, raw)
       values ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8),$9,$10::jsonb)
       on conflict (stripe_subscription_id) do update set
         stripe_customer_id=excluded.stripe_customer_id, stripe_price_id=excluded.stripe_price_id,
         tier=excluded.tier, status=excluded.status, current_period_end=excluded.current_period_end,
         cancel_at_period_end=excluded.cancel_at_period_end, raw=excluded.raw, updated_at=now()`,
      [subscriptionId, customerId, priceId, userId, organizationId, tier, status, Number(subscription.current_period_end) || null, Boolean(subscription.cancel_at_period_end), JSON.stringify(subscription)],
    );
  }

  private async request(path: string, form?: URLSearchParams): Promise<Record<string, unknown>> {
    const response = await fetch(`${STRIPE_API}${path}`, {
      method: form ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${this.config.secretKey}`,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form?.toString(),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new BillingError(502, stringValue(objectRecord(body.error)?.message) ?? 'Stripe request failed.');
    return body;
  }
}

export type BillingActivationSource = 'wearable' | 'biomarkers' | 'genetics' | 'health_connect' | 'request_limit';

export class BillingError extends Error {
  constructor(public readonly status: 400 | 401 | 402 | 403 | 404 | 409 | 502 | 503, message: string) { super(message); }
}

function requiredStripeBillingConfig(): StripeBillingConfig {
  const config = stripeBillingConfig();
  if (!config) throw new BillingError(503, 'Hosted billing is not configured. Set Stripe secrets and price IDs first.');
  return config;
}

export function verifyStripeSignature(body: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const values = header.split(',').map(part => part.trim().split('=', 2));
  const timestamp = values.find(([key]) => key === 't')?.[1];
  const signatures = values.filter(([key, value]) => key === 'v1' && value).map(([, value]) => value!);
  if (!timestamp || signatures.length === 0 || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body.toString('utf8')}`).digest('hex');
  const wanted = Buffer.from(expected, 'hex');
  return signatures.some(signature => {
    const received = Buffer.from(signature, 'hex');
    return received.length === wanted.length && timingSafeEqual(received, wanted);
  });
}

function subscriptionFromRow(row: Record<string, unknown>): BillingSubscription {
  return {
    user_id: String(row.user_id), organization_id: String(row.organization_id), tier: String(row.tier) as PricingTierId,
    status: String(row.status), stripe_customer_id: String(row.stripe_customer_id), stripe_subscription_id: String(row.stripe_subscription_id),
    stripe_price_id: String(row.stripe_price_id), current_period_end: row.current_period_end ? new Date(String(row.current_period_end)).toISOString() : undefined,
    cancel_at_period_end: Boolean(row.cancel_at_period_end),
  };
}

export function hostedIntroductoryUsage(requestsUsed: number): HostedIntroductoryUsage {
  const used = Math.max(0, Math.min(HOSTED_INTRODUCTORY_REQUEST_LIMIT, Math.floor(Number.isFinite(requestsUsed) ? requestsUsed : 0)));
  const remaining = Math.max(0, HOSTED_INTRODUCTORY_REQUEST_LIMIT - used);
  return {
    limit: HOSTED_INTRODUCTORY_REQUEST_LIMIT,
    used,
    remaining,
    payment_required: remaining === 0,
  };
}

type StripeEvent = { id?: string; type?: string; data?: { object?: Record<string, unknown> } };
function objectRecord(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined; }
function isCheckoutTier(value: string | undefined): value is 'standard' | 'builder' | 'growth' {
  return Boolean(value && CHECKOUT_TIERS.includes(value as (typeof CHECKOUT_TIERS)[number]));
}

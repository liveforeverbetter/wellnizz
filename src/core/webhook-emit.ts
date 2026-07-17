import { createHmac, randomUUID } from 'node:crypto';
import type { HealthStore } from '../store.js';
import type { WebhookEvent, WebhookEventType } from '../types.js';
import { SERVICE_VERSION } from '../version.js';

// Shared outbound webhook emission. Persists the event, then best-effort delivers
// it to HEALTH_API_WEBHOOK_URL. Used by both the HTTP layer and background
// workers so completion/update events are emitted from a single code path.
export async function emitWebhookEvent(
  store: HealthStore,
  type: WebhookEventType,
  input: {
    userId?: string;
    organizationId?: string;
    subjectId?: string;
    requestId?: string;
    data: Record<string, unknown>;
  },
): Promise<WebhookEvent> {
  const event: WebhookEvent = {
    id: `evt_${randomUUID()}`,
    type,
    user_id: input.userId,
    organization_id: input.organizationId,
    subject_id: input.subjectId,
    request_id: input.requestId,
    data: input.data,
    created_at: new Date().toISOString(),
  };
  await store.createWebhookEvent(event);
  deliverWebhookEvent(event).catch(() => undefined);
  return event;
}

export async function deliverWebhookEvent(event: WebhookEvent): Promise<void> {
  const url = process.env.HEALTH_API_WEBHOOK_URL;
  if (!url) return;
  const body = JSON.stringify(event);
  const secret = process.env.HEALTH_API_WEBHOOK_SECRET;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': `foreverbetter-api-webhooks/${SERVICE_VERSION}`,
    'x-foreverbetter-event-id': event.id,
    'x-foreverbetter-event-type': event.type,
  };
  if (secret) {
    headers['x-foreverbetter-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  }
  await fetch(url, { method: 'POST', headers, body });
}

export function validateWebhookDeliveryConfig(env: NodeJS.ProcessEnv = process.env): void {
  const value = env.HEALTH_API_WEBHOOK_URL?.trim();
  if (!value) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('HEALTH_API_WEBHOOK_URL must be a valid absolute URL.');
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (env.NODE_ENV === 'production' && url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('HEALTH_API_WEBHOOK_URL must use HTTPS in production outside localhost.');
  }
  if (env.NODE_ENV === 'production' && (env.HEALTH_API_WEBHOOK_SECRET?.length ?? 0) < 32) {
    throw new Error('HEALTH_API_WEBHOOK_SECRET must contain at least 32 characters when a production webhook URL is configured.');
  }
}

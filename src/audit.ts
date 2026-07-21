import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import type { AuthContext } from './auth.js';
import { traceContext } from './tracing.js';

export type AuditOutcome = 'success' | 'denied' | 'error';

export interface AuditRecord {
  ts: string;
  service: 'wellnizz-api';
  outcome: AuditOutcome;
  method?: string;
  route: string;
  status: number;
  subject?: string;
  user_id?: string;
  trace_id: string;
  ip_hash: string;
  error?: string;
  synthetic?: boolean;
  persisted?: boolean;
  dropped_before?: number;
}

type AuditSink = (event: AuditRecord) => Promise<void> | void;

const DEFAULT_QUEUE_SIZE = 1000;
const queue: AuditRecord[] = [];
let flushing = false;
let dropped = 0;
let sink: AuditSink = event => {
  console.log(JSON.stringify(event));
};

export function auditEvent(
  req: IncomingMessage,
  outcome: AuditOutcome,
  details: {
    route: string;
    status: number;
    auth?: AuthContext;
    error?: string;
    synthetic?: boolean;
    persisted?: boolean;
  },
): void {
  const event: AuditRecord = {
    ts: new Date().toISOString(),
    service: 'wellnizz-api',
    outcome,
    method: req.method,
    route: sanitizeRoute(details.route),
    status: details.status,
    subject: details.auth?.subject,
    user_id: details.auth?.userId,
    trace_id: traceContext(req).trace_id,
    ip_hash: hashIp(clientIp(req), process.env.AUDIT_IP_HASH_SALT ?? 'dev-audit-salt'),
    error: details.error,
    synthetic: details.synthetic,
    persisted: details.persisted,
  };
  enqueueAuditEvent(event);
}

export function configureAuditSink(nextSink: AuditSink): void {
  sink = nextSink;
}

export function flushAuditEvents(): Promise<void> {
  return flushQueue();
}

export function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const hops = forwarded.split(',').map(hop => hop.trim()).filter(Boolean);
    return hops.at(-1) ?? 'unknown';
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 24);
}

function sanitizeRoute(route: string): string {
  return route.split('?')[0] || '/';
}

function enqueueAuditEvent(event: AuditRecord): void {
  const maxQueueSize = Number(process.env.AUDIT_QUEUE_MAX ?? DEFAULT_QUEUE_SIZE);
  if (queue.length >= maxQueueSize) {
    dropped += 1;
    return;
  }
  if (dropped > 0) {
    event.dropped_before = dropped;
    dropped = 0;
  }
  queue.push(event);
  if (!flushing) {
    flushing = true;
    setImmediate(() => {
      void flushQueue();
    });
  }
}

async function flushQueue(): Promise<void> {
  try {
    while (queue.length > 0) {
      const event = queue.shift()!;
      await sink(event);
    }
  } catch (error) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      service: 'wellnizz-api',
      outcome: 'error',
      route: 'audit_sink',
      status: 500,
      error: error instanceof Error ? error.message : String(error),
    }));
  } finally {
    flushing = false;
    if (queue.length > 0) {
      flushing = true;
      setImmediate(() => {
        void flushQueue();
      });
    }
  }
}

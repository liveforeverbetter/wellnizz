export interface StoreRetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const TRANSIENT_CODES = new Set([
  '08000', '08001', '08003', '08004', '08006', '08007', '08P01',
  '40001', '40P01', '53300', '53400', '55P03', '57P01', '57P02',
  '57P03', '58030', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT',
]);

const TRANSIENT_MESSAGES = [
  'connection terminated',
  'connection timeout',
  'connection refused',
  'database system is in recovery mode',
  'server closed the connection unexpectedly',
  'remaining connection slots are reserved',
  'socket hang up',
  'timeout expired',
];

export async function retryTransientStoreOperation<T>(
  operation: () => Promise<T>,
  options: StoreRetryOptions = {},
): Promise<T> {
  const maxAttempts = positiveInteger(options.maxAttempts, 60);
  const initialDelayMs = positiveInteger(options.delayMs, 5_000);
  const maxDelayMs = positiveInteger(options.maxDelayMs, 15_000);
  const sleep = options.sleep ?? wait;

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientStoreError(error)) throw error;
      const delayMs = Math.min(maxDelayMs, initialDelayMs * attempt);
      options.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }
}

export function isTransientStoreError(error: unknown): boolean {
  const code = errorCode(error);
  if (code && TRANSIENT_CODES.has(code)) return true;
  const message = errorMessage(error).toLowerCase();
  return TRANSIENT_MESSAGES.some(fragment => message.includes(fragment));
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code.toUpperCase() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

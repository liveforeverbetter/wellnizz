import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTransientStoreError, retryTransientStoreOperation } from '../src/core/store-retry.js';

test('retries PostgreSQL recovery errors until the write succeeds', async () => {
  let calls = 0;
  const retries: number[] = [];
  const result = await retryTransientStoreOperation(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('the database system is in recovery mode'), { code: '57P03' });
    return 'saved';
  }, {
    maxAttempts: 4,
    delayMs: 1,
    sleep: async () => undefined,
    onRetry: (_error, attempt) => retries.push(attempt),
  });

  assert.equal(result, 'saved');
  assert.equal(calls, 3);
  assert.deepEqual(retries, [1, 2]);
});

test('does not retry non-transient store failures', async () => {
  let calls = 0;
  await assert.rejects(
    retryTransientStoreOperation(async () => {
      calls++;
      throw new Error('invalid analysis payload');
    }, {
      maxAttempts: 5,
      sleep: async () => undefined,
    }),
    /invalid analysis payload/,
  );
  assert.equal(calls, 1);
});

test('recognizes connection and recovery failures as transient', () => {
  assert.equal(isTransientStoreError(Object.assign(new Error('recovery'), { code: '57P03' })), true);
  assert.equal(isTransientStoreError(new Error('Connection terminated due to connection timeout')), true);
  assert.equal(isTransientStoreError(new Error('schema validation failed')), false);
});

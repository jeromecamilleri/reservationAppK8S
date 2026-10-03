import test from 'node:test';
import assert from 'node:assert/strict';
import { retryUntilReady } from '../src/retry.js';

test('retries with bounded exponential delays until operation succeeds', async () => {
  let calls = 0;
  const delays = [];
  const value = await retryUntilReady(async () => {
    calls += 1;
    if (calls < 4) throw new Error('temporarily unavailable');
    return 'ready';
  }, {
    initialDelayMs: 10,
    maxDelayMs: 25,
    sleep: async (ms) => delays.push(ms),
  });

  assert.equal(value, 'ready');
  assert.deepEqual(delays, [10, 20, 25]);
});

test('stops retrying when aborted', async () => {
  const controller = new AbortController();
  await assert.rejects(retryUntilReady(async () => {
    controller.abort(new Error('shutdown'));
    throw new Error('temporarily unavailable');
  }, { signal: controller.signal, sleep: async () => {} }), /shutdown/);
});

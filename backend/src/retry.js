export function retryUntilReady(operation, {
  initialDelayMs = 1000,
  maxDelayMs = 15000,
  signal,
  onRetry = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  return (async () => {
    let attempt = 0;
    while (!signal?.aborted) {
      try {
        return await operation();
      } catch (error) {
        attempt += 1;
        const delayMs = Math.min(initialDelayMs * (2 ** (attempt - 1)), maxDelayMs);
        onRetry(error, attempt, delayMs);
        await sleep(delayMs, signal);
      }
    }
    throw signal.reason || new Error('Retry operation aborted');
  })();
}

export function abortableSleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

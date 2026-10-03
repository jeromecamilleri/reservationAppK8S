const baseUrl = (process.env.LOAD_URL || 'http://192.168.122.1:8080').replace(/\/$/, '');
const concurrency = Number(process.env.CONCURRENCY || 60);
const durationSeconds = Number(process.env.DURATION_SECONDS || 180);
const endpoint = `${baseUrl}/api/events`;

if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 500) throw new Error('CONCURRENCY must be 1..500');
if (!Number.isInteger(durationSeconds) || durationSeconds < 10 || durationSeconds > 3600) throw new Error('DURATION_SECONDS must be 10..3600');

const startedAt = Date.now();
const deadline = startedAt + durationSeconds * 1000;
let completed = 0;
let successful = 0;
let failed = 0;
let active = 0;
let intervalSuccess = 0;
let intervalFailed = 0;
const totalErrors = new Map();
const intervalErrors = new Map();
const latencies = [];

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function recordError(key, sample) {
  for (const errors of [totalErrors, intervalErrors]) {
    const entry = errors.get(key) || { count: 0, sample };
    entry.count += 1;
    errors.set(key, entry);
  }
}

function formatErrors(errors) {
  return [...errors.entries()]
    .map(([key, entry]) => `${key}=${entry.count}${entry.sample ? ` (ex: ${entry.sample})` : ''}`)
    .join(', ');
}

async function worker() {
  while (Date.now() < deadline) {
    const start = performance.now();
    active += 1;
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
      await response.arrayBuffer();
      if (response.ok) {
        successful += 1;
        intervalSuccess += 1;
      } else {
        failed += 1;
        intervalFailed += 1;
        recordError(`HTTP ${response.status} ${response.statusText}`.trim(), response.headers.get('retry-after') ? `Retry-After ${response.headers.get('retry-after')}s` : '');
      }
    } catch (error) {
      failed += 1;
      intervalFailed += 1;
      const causeCodes = error.cause?.errors?.map((cause) => cause.code).filter(Boolean).join(',');
      const causeCode = error.cause?.code || causeCodes;
      recordError(causeCode || error.name || 'FetchError', error.cause?.message || error.message);
    } finally {
      active -= 1;
      completed += 1;
      latencies.push(performance.now() - start);
    }
  }
}

console.log(`Charge GET ${endpoint}: ${concurrency} clients pendant ${durationSeconds}s`);
const reporter = setInterval(() => {
  const elapsed = (Date.now() - startedAt) / 1000;
  const breakdown = formatErrors(intervalErrors);
  console.log(`${elapsed.toFixed(0)}s | ${intervalSuccess} OK, ${intervalFailed} erreurs / 5s${breakdown ? ` [${breakdown}]` : ''} | p95 ${percentile(latencies.slice(-1000), 0.95).toFixed(0)}ms | en vol ${active}`);
  intervalSuccess = 0;
  intervalFailed = 0;
  intervalErrors.clear();
}, 5000);

await Promise.all(Array.from({ length: concurrency }, () => worker()));
clearInterval(reporter);
const elapsedSeconds = (Date.now() - startedAt) / 1000;
console.log(`Terminé: ${completed} requêtes en ${elapsedSeconds.toFixed(1)}s, ${successful} OK, ${failed} erreurs, ${(completed / elapsedSeconds).toFixed(1)} req/s, latence moyenne ${(latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length)).toFixed(0)}ms, p95 ${percentile(latencies, 0.95).toFixed(0)}ms.`);
if (totalErrors.size) console.log(`Détail des erreurs: ${formatErrors(totalErrors)}`);
if (failed > 0) process.exitCode = 1;

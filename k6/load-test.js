import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const writeLatency = new Trend('write_latency', true);
const readLatency = new Trend('read_latency', true);
const healthLatency = new Trend('health_latency', true);
const cpuLoadStarted = new Counter('cpu_load_started');
const testMode = __ENV.TEST_MODE || 'api';
const loadProfile = __ENV.LOAD_PROFILE || 'standard';
const baseURL = __ENV.BASE_URL || 'http://127.0.0.1:18080';

function envPositiveInt(name, fallback, maximum) {
  if (!__ENV[name]) return fallback;
  const value = Number(__ENV[name]);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

const cpuWorkers = envPositiveInt('CPU_WORKERS', 2, 64);
const cpuDurationSeconds = envPositiveInt('CPU_DURATION_SECONDS', 30, 300);
const cpuLoadRequests = envPositiveInt('CPU_LOAD_REQUESTS', 10, 100);
// Conservative defaults remain compatible with the previously published API image.
// Raise them only after deploying the current server version with expanded limits.
const maximumDBWorkers = envPositiveInt('MAXIMUM_DB_WORKERS', 50, 200);
const maximumCPUWorkers = envPositiveInt('MAXIMUM_CPU_WORKERS', 64, 256);
const maximumDurationSeconds = envPositiveInt('MAXIMUM_DURATION_SECONDS', 300, 600);

const profiles = {
  standard: {
    stages: [{ duration: '15s', target: 10 }, { duration: '30s', target: 10 }, { duration: '15s', target: 0 }],
    readsPerIteration: 1,
    valuePaddingBytes: 0,
    sleepSeconds: 0.2,
  },
  stress: {
    stages: [{ duration: '30s', target: 20 }, { duration: '2m', target: 20 }, { duration: '30s', target: 0 }],
    readsPerIteration: 2,
    valuePaddingBytes: 256,
    sleepSeconds: 0.1,
  },
  maximum: {
    stages: [{ duration: '1m', target: 250 }, { duration: '8m', target: 500 }, { duration: '1m', target: 0 }],
    readsPerIteration: 10,
    valuePaddingBytes: 900,
    sleepSeconds: 0,
  },
};

const profile = profiles[loadProfile];

if (!['api', 'health', 'cpu-load'].includes(testMode)) {
  throw new Error(`TEST_MODE must be "api", "health" or "cpu-load", got "${testMode}"`);
}
if (!profile) {
  throw new Error(`LOAD_PROFILE must be "standard", "stress" or "maximum", got "${loadProfile}"`);
}
if (loadProfile === 'maximum' && testMode !== 'api') {
  throw new Error('LOAD_PROFILE=maximum requires TEST_MODE=api');
}

export const options = {
  scenarios: testMode === 'cpu-load'
    ? { cpu_load: { executor: 'per-vu-iterations', vus: 1, iterations: cpuLoadRequests, maxDuration: '30s' } }
    : { api: { executor: 'ramping-vus', startVUs: 1, stages: profile.stages, gracefulRampDown: '10s' } },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
    ...(testMode === 'cpu-load' ? { cpu_load_started: ['count>=1'] } : {}),
  },
};

export function setup() {
  if (loadProfile !== 'maximum') return;
  if (__ENV.ENABLE_DESTRUCTIVE_LOAD !== 'true') {
    throw new Error('LOAD_PROFILE=maximum requires ENABLE_DESTRUCTIVE_LOAD=true');
  }

  const options = {
    headers: { 'Content-Type': 'application/json' },
    responseCallback: http.expectedStatuses(202),
  };
  const databaseLoad = http.post(
    `${baseURL}/api/v1/load`,
    JSON.stringify({ workers: maximumDBWorkers, duration_seconds: maximumDurationSeconds, value_size_bytes: 900 }),
    options,
  );
  if (databaseLoad.status !== 202) {
    throw new Error(`database load endpoint returned ${databaseLoad.status}: ${databaseLoad.body}`);
  }
  const cpuLoad = http.post(
    `${baseURL}/api/v1/cpu-load`,
    JSON.stringify({ workers: maximumCPUWorkers, duration_seconds: maximumDurationSeconds }),
    options,
  );
  if (cpuLoad.status !== 202) {
    throw new Error(`CPU load endpoint returned ${cpuLoad.status}: ${cpuLoad.body}`);
  }
}

export default function () {
  if (testMode === 'cpu-load') {
    const response = http.post(
      `${baseURL}/api/v1/cpu-load`,
      JSON.stringify({ workers: cpuWorkers, duration_seconds: cpuDurationSeconds }),
      {
        headers: { 'Content-Type': 'application/json' },
        responseCallback: http.expectedStatuses(202, 409),
        tags: { endpoint: 'cpu-load' },
      },
    );
    if (response.status === 202) cpuLoadStarted.add(1);
    check(response, { 'CPU load is accepted or already running': (result) => result.status === 202 || result.status === 409 });
    return;
  }

  if (testMode === 'health') {
    const health = http.get(`${baseURL}/healthz`, { tags: { endpoint: 'health' } });
    healthLatency.add(health.timings.duration);
    check(health, { 'healthz returns 200': (response) => response.status === 200 });
    sleep(profile.sleepSeconds);
    return;
  }

  const payload = JSON.stringify({ value: `load-test-vu-${__VU}-iter-${__ITER}-${'x'.repeat(profile.valuePaddingBytes)}` });
  const write = http.post(`${baseURL}/api/v1/records`, payload, { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'write' } });
  writeLatency.add(write.timings.duration);
  check(write, { 'POST returns 201': (response) => response.status === 201 });

  for (let readNumber = 0; readNumber < profile.readsPerIteration; readNumber += 1) {
    const read = http.get(`${baseURL}/api/v1/records`, { tags: { endpoint: 'read' } });
    readLatency.add(read.timings.duration);
    check(read, { 'GET returns 200': (response) => response.status === 200, 'GET has items': (response) => Array.isArray(response.json('items')) });
  }
  sleep(profile.sleepSeconds);
}

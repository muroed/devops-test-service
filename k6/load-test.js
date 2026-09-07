import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const writeLatency = new Trend('write_latency', true);
const readLatency = new Trend('read_latency', true);
const healthLatency = new Trend('health_latency', true);
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
};

const profile = profiles[loadProfile];

if (!['api', 'health', 'cpu-load'].includes(testMode)) {
  throw new Error(`TEST_MODE must be "api", "health" or "cpu-load", got "${testMode}"`);
}
if (!profile) {
  throw new Error(`LOAD_PROFILE must be "standard" or "stress", got "${loadProfile}"`);
}

export const options = {
  scenarios: testMode === 'cpu-load'
    ? { cpu_load: { executor: 'per-vu-iterations', vus: 1, iterations: 1, maxDuration: '10s' } }
    : { api: { executor: 'ramping-vus', startVUs: 1, stages: profile.stages, gracefulRampDown: '10s' } },
  thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<500'] },
};

export default function () {
  if (testMode === 'cpu-load') {
    const response = http.post(
      `${baseURL}/api/v1/cpu-load`,
      JSON.stringify({ workers: cpuWorkers, duration_seconds: cpuDurationSeconds }),
      { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'cpu-load' } },
    );
    check(response, { 'CPU load starts with 202': (result) => result.status === 202 });
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

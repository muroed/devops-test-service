import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const writeLatency = new Trend('write_latency', true);
const readLatency = new Trend('read_latency', true);
const healthLatency = new Trend('health_latency', true);
const testMode = __ENV.TEST_MODE || 'api';

if (!['api', 'health'].includes(testMode)) {
  throw new Error(`TEST_MODE must be "api" or "health", got "${testMode}"`);
}

export const options = {
  scenarios: {
    api: { executor: 'ramping-vus', startVUs: 1, stages: [{ duration: '15s', target: 10 }, { duration: '30s', target: 10 }, { duration: '15s', target: 0 }], gracefulRampDown: '10s' },
  },
  thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<500'] },
};

const baseURL = __ENV.BASE_URL || 'http://127.0.0.1:18080';

export default function () {
  if (testMode === 'health') {
    const health = http.get(`${baseURL}/healthz`, { tags: { endpoint: 'health' } });
    healthLatency.add(health.timings.duration);
    check(health, { 'healthz returns 200': (response) => response.status === 200 });
    sleep(0.2);
    return;
  }

  const payload = JSON.stringify({ value: `load-test-vu-${__VU}-iter-${__ITER}` });
  const write = http.post(`${baseURL}/api/v1/records`, payload, { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'write' } });
  writeLatency.add(write.timings.duration);
  check(write, { 'POST returns 201': (response) => response.status === 201 });

  const read = http.get(`${baseURL}/api/v1/records`, { tags: { endpoint: 'read' } });
  readLatency.add(read.timings.duration);
  check(read, { 'GET returns 200': (response) => response.status === 200, 'GET has items': (response) => Array.isArray(response.json('items')) });
  sleep(0.2);
}

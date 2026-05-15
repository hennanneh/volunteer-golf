// Soak test: low constant load for 1 hour to detect slow-growing problems
// (memory leaks, file handle leaks, data.json bloat, log rotation behavior).
// Watch droplet metrics (free -h, pm2 monit) during this run.
// Run: BASE_URL=http://<test-droplet-ip>:3001 k6 run soak.js

import http from 'k6/http';
import { sleep, check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3001';

export const options = {
  scenarios: {
    background: {
      executor: 'constant-arrival-rate',
      rate: 5,                // 5 requests / second sustained
      timeUnit: '1s',
      duration: '1h',
      preAllocatedVUs: 20,
      maxVUs: 50,
    },
  },
  thresholds: {
    'http_req_duration': ['p(95)<1500'],
    'http_req_failed': ['rate<0.02'],
  },
};

export default function () {
  const r = http.get(`${BASE_URL}/api/data`);
  check(r, { '200': (x) => x.status === 200 });
}

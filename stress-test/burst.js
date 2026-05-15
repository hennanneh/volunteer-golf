// Burst test: simulate tournament-morning rush — 300 users opening the site
// within 60 seconds, holding for 2 minutes, then ramping down.
// Goal: catch cold-cache misses, connection saturation, broadcast storms.
// Run: BASE_URL=http://<test-droplet-ip>:3001 k6 run burst.js

import http from 'k6/http';
import { sleep, check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3001';

export const options = {
  scenarios: {
    rush: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '60s', target: 300 },  // ramp up
        { duration: '2m',  target: 300 },  // hold
        { duration: '60s', target: 0 },    // ramp down
      ],
    },
  },
  thresholds: {
    'http_req_duration': ['p(95)<3000', 'p(99)<5000'],
    'http_req_failed': ['rate<0.10'],
  },
};

export default function () {
  // Most users hit index then api/data
  const r1 = http.get(`${BASE_URL}/`);
  check(r1, { 'index 200': (r) => r.status === 200 });
  const r2 = http.get(`${BASE_URL}/api/data`);
  check(r2, { 'api 200': (r) => r.status === 200 });
  sleep(30 + Math.random() * 60);
}

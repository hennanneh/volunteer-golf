// Smoke test: realistic mix of 280 viewers + 20 captains for 5 minutes.
// Goal: confirm baseline server behavior under normal tournament-day load.
// Run: BASE_URL=http://<test-droplet-ip>:3001 k6 run smoke.js

import http from 'k6/http';
import { sleep, check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3001';

export const options = {
  scenarios: {
    viewers:  { executor: 'constant-vus', vus: 280, duration: '5m', exec: 'viewer'  },
    captains: { executor: 'constant-vus', vus: 20,  duration: '5m', exec: 'captain' },
  },
  thresholds: {
    'http_req_duration{name:viewer-get}':  ['p(95)<1500'],
    'http_req_duration{name:captain-get}': ['p(95)<1500'],
    'http_req_duration{name:captain-post}':['p(95)<3000'],
    'http_req_failed': ['rate<0.05'],
  },
};

export function viewer() {
  const r = http.get(`${BASE_URL}/api/data`, { tags: { name: 'viewer-get' } });
  check(r, { 'viewer 200': (r) => r.status === 200 });
  sleep(15 + Math.random() * 15);
}

export function captain() {
  const r = http.get(`${BASE_URL}/api/data`, { tags: { name: 'captain-get' } });
  if (r.status !== 200) { sleep(5); return; }
  const data = r.json();
  sleep(20 + Math.random() * 30);
  // Touch a volunteer's notes to simulate an edit
  if (data.volunteers && data.volunteers.length > 0) {
    const v = data.volunteers[Math.floor(Math.random() * data.volunteers.length)];
    v.notes = 'stress-test ' + Date.now();
  }
  data.dataReadAt = data.serverNow || Date.now();
  const p = http.post(`${BASE_URL}/api/data`, JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'captain-post' },
  });
  check(p, { 'captain POST ok or stale': (r) => r.status === 200 || r.status === 409 });
  sleep(10);
}

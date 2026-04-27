// utils.js — small helpers shared by all scenario flows.

import http from 'k6/http';
import { sleep } from 'k6';
import { CONFIG } from './config.js';

// Random integer in [min, max] inclusive.
export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Random think-time, in seconds, like a real user pausing on a page.
export function thinkTime() {
  const ms = randInt(CONFIG.THINK_MIN_MS, CONFIG.THINK_MAX_MS);
  sleep(ms / 1000);
}

// Soft kill switch — VUs check this every iteration and bail out if tripped.
// Host a tiny static file (e.g. on S3) you can flip to "STOP" to drain a run.
let lastKillCheck = 0;
let killed = false;
export function shouldAbort() {
  if (killed) return true;
  if (!CONFIG.KILL_SWITCH_URL) return false;

  const now = Date.now();
  // Re-check at most every 10s per VU so the kill switch host doesn't get
  // hammered.
  if (now - lastKillCheck < 10000) return false;
  lastKillCheck = now;

  const r = http.get(CONFIG.KILL_SWITCH_URL, {
    timeout: '2s',
    tags: { name: 'kill_switch' },
  });
  if (r.status === 200 && r.body && String(r.body).trim().indexOf('STOP') === 0) {
    killed = true;
    return true;
  }
  return false;
}

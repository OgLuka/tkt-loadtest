// ====================================================================
// tkt.ge concert onsale load test
// --------------------------------------------------------------------
// Three scenarios run in parallel to model the real onsale shape:
//
//   landing_spike   ramp 0 -> PEAK_VUS, parallel batch of 7 calls
//                   the real homepage issues (Shows/Pinned, Stories,
//                   Events/Top, Events/Day, Cavea/Movies, 2x Railway)
//   event_spike     ramp 0 -> PEAK_VUS/3, /Shows/new for the concert
//   released_buyers constant arrival rate post-queue:
//                   /Events/Map (initial) -> SignalR hub negotiate ->
//                   WSS hold for browse window -> /Booking/choose-seat ->
//                   /v2/orders/checkout/details
//
// Run a SINGLE node:
//   k6 run -e API_BASE=https://gateway.tkt.ge \
//          -e EVENT_ITEM_ID=31411 -e EVENT_MAP_ID=464919 \
//          -e PEAK_VUS=30000 \
//          loadtest.js
//
// Run distributed across N EC2 nodes: see ./run.sh
//
// IMPORTANT — production safety:
//   * Coordinate with hosting/WAF, CDN, queue provider BEFORE running.
//     This will look like a DDoS otherwise.
//   * Allowlist the X-Loadtest-Run header value at the WAF so the test
//     is not rate-limited mid-run.
//   * The script INTENTIONALLY does not submit payment. The flow stops
//     at /v2/orders/checkout/details. Do not extend it to hit the PSP
//     unless you have a sandbox key.
//   * Run during the lowest-traffic window your analytics show.
//   * Have the kill switch URL ready (set KILL_SWITCH_URL).
// ====================================================================

import { runLanding, runEventPage } from './lib/landing.js';
import { runBuyer } from './lib/buyer.js';
import { CONFIG } from './lib/config.js';

// k6 references scenario entry-points by name on the main module, so we
// re-export here as named functions.
export function landing() { runLanding(); }
export function eventPage() { runEventPage(); }
export function buyer() { runBuyer(); }

// Per-node peak: divide your global target by NODE_COUNT.
const PEAK = CONFIG.PEAK_VUS;
const EVENT_PEAK = Math.max(100, Math.floor(PEAK / 3));
// Buyer rate is split across nodes too — only one node should run the
// buyer scenario or each node should run its share of the total rate.
const BUYER_RATE = Math.max(
  1,
  Math.floor(CONFIG.BUYER_RATE_PER_MIN / CONFIG.NODE_COUNT),
);

export const options = {
  // Don't reuse VU iterations after a failure — each "user" is fresh.
  noVUConnectionReuse: false,
  discardResponseBodies: true, // big perf win when not asserting body
  insecureSkipTLSVerify: false,

  // Tags that show up in every metric — useful for splitting in Grafana.
  tags: {
    run_id: CONFIG.RUN_ID,
    node_id: CONFIG.NODE_ID,
  },

  scenarios: {
    // -------- 1. landing-page spike (the unprotected surface) --------
    landing_spike: {
      executor: 'ramping-vus',
      exec: 'landing',
      startVUs: 0,
      stages: [
        { duration: `${CONFIG.RAMP_UP_SEC}s`, target: PEAK },
        { duration: `${CONFIG.HOLD_SEC}s`, target: PEAK },
        { duration: `${CONFIG.RAMP_DOWN_SEC}s`, target: 0 },
      ],
      gracefulRampDown: '10s',
      tags: { scenario: 'landing_spike' },
    },

    // -------- 2. shared event-link spike -----------------------------
    // Smaller cohort hitting /Shows/new for the concert directly, the way
    // a user clicking a shared link in Telegram/FB would.
    event_spike: {
      executor: 'ramping-vus',
      exec: 'eventPage',
      startVUs: 0,
      // Start 30s later so we get a clean signal on landing first, then
      // see the event-page traffic stack on top.
      startTime: '30s',
      stages: [
        { duration: `${CONFIG.RAMP_UP_SEC}s`, target: EVENT_PEAK },
        { duration: `${CONFIG.HOLD_SEC}s`, target: EVENT_PEAK },
        { duration: `${CONFIG.RAMP_DOWN_SEC}s`, target: 0 },
      ],
      gracefulRampDown: '10s',
      tags: { scenario: 'event_spike' },
    },

    // -------- 3. released buyers (post-queue) ------------------------
    // Constant-arrival-rate decouples VU count from request rate.
    // Even if individual buyers take 60s, we still spawn `rate` per minute.
    released_buyers: {
      executor: 'constant-arrival-rate',
      exec: 'buyer',
      rate: BUYER_RATE,
      timeUnit: '1m',
      duration: `${CONFIG.RAMP_UP_SEC + CONFIG.HOLD_SEC + CONFIG.RAMP_DOWN_SEC}s`,
      // Pre-allocate enough VUs for the slowest expected buyer journey.
      // A buyer browses the seatmap for up to SEATMAP_BROWSE_MAX_S seconds
      // before locking, so VUs ~= rate/min * (browse_max + checkout) / 60.
      preAllocatedVUs: Math.max(
        50,
        Math.ceil((BUYER_RATE * (CONFIG.SEATMAP_BROWSE_MAX_S + 30)) / 60),
      ),
      maxVUs: Math.max(
        200,
        Math.ceil((BUYER_RATE * (CONFIG.SEATMAP_BROWSE_MAX_S + 30)) / 60) * 2,
      ),
      tags: { scenario: 'released_buyers' },
    },
  },

  // -------- pass/fail thresholds ------------------------------------
  // If any of these break, k6 exits non-zero — useful for CI gating.
  // Tune to match your SLO. These are starting points for a ticketing
  // site under spike load (degraded but functional).
  thresholds: {
    // Overall request error rate. Excludes seat conflicts (those are
    // tracked separately as buyer_seat_locks_conflict).
    http_req_failed: ['rate<0.02'],

    // Homepage batch — should be snappy because most should be cached.
    'http_req_duration{name:home_pinned}': ['p(95)<800', 'p(99)<2000'],
    'http_req_duration{name:home_events_top}': ['p(95)<1000', 'p(99)<2500'],
    'http_req_duration{name:home_events_day}': ['p(95)<1000', 'p(99)<2500'],

    // Event detail page — DB read for one show.
    'http_req_duration{name:event_detail_direct}': ['p(95)<1500', 'p(99)<4000'],
    'http_req_duration{name:event_detail_from_landing}': ['p(95)<1500', 'p(99)<4000'],

    // Seatmap — large response, the read-heavy hotspot.
    'http_req_duration{name:seatmap_map}': ['p(95)<2500', 'p(99)<6000'],

    // Hub negotiate — quick, just allocates a connectionId.
    'http_req_duration{name:hub_negotiate}': ['p(95)<800', 'p(99)<2000'],

    // Choose-seat — write path, lock contention hotspot. Looser SLO.
    'http_req_duration{name:choose_seat}': ['p(95)<2500', 'p(99)<6000'],

    // Checkout details — should be cheap, just looks up the order.
    'http_req_duration{name:checkout_details}': ['p(95)<1500', 'p(99)<4000'],

    // SignalR handshake completion time after the WS upgrade.
    buyer_hub_handshake_ms: ['p(95)<2000'],

    // Buyer funnel must produce real checkouts even under spike.
    buyer_checkouts_reached: ['count>0'],
  },

  // Output to a file in addition to whatever --out you pass on CLI.
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

// Default function never runs because every scenario has its own exec.
// k6 still requires it to exist.
export default function () {}

// handleSummary writes a JSON summary file alongside the run, easy to ship
// to S3 after a distributed run for cross-node aggregation.
export function handleSummary(data) {
  return {
    stdout: textSummary(data),
    [`./results/summary-${CONFIG.RUN_ID}-node${CONFIG.NODE_ID}.json`]:
      JSON.stringify(data, null, 2),
  };
}

// Tiny inline text summary so we don't pull a 3rd-party module.
function textSummary(data) {
  const m = data.metrics;
  const fmt = (n) => (n === undefined ? '-' : n.toFixed ? n.toFixed(2) : String(n));
  const lines = [];
  lines.push(`\n=== tkt.ge load test summary (run ${CONFIG.RUN_ID}, node ${CONFIG.NODE_ID}) ===`);
  lines.push(`  http_reqs:           ${fmt(m.http_reqs && m.http_reqs.values.count)}`);
  lines.push(`  http_req_failed:     ${fmt(m.http_req_failed && m.http_req_failed.values.rate * 100)}%`);
  lines.push(`  http_req_duration:   p95=${fmt(m.http_req_duration && m.http_req_duration.values['p(95)'])}ms p99=${fmt(m.http_req_duration && m.http_req_duration.values['p(99)'])}ms`);
  lines.push(`  seat_locks_attempt:  ${fmt(m.buyer_seat_locks_attempted && m.buyer_seat_locks_attempted.values.count)}`);
  lines.push(`  seat_locks_success:  ${fmt(m.buyer_seat_locks_succeeded && m.buyer_seat_locks_succeeded.values.count)}`);
  lines.push(`  seat_locks_conflict: ${fmt(m.buyer_seat_locks_conflict && m.buyer_seat_locks_conflict.values.count)}`);
  lines.push(`  checkouts_reached:   ${fmt(m.buyer_checkouts_reached && m.buyer_checkouts_reached.values.count)}`);
  lines.push(`  hub_connects:        ${fmt(m.buyer_hub_connects && m.buyer_hub_connects.values.count)}`);
  lines.push(`  hub_messages:        ${fmt(m.buyer_hub_messages && m.buyer_hub_messages.values.count)}`);
  lines.push(`  hub_handshake_ms:    p95=${fmt(m.buyer_hub_handshake_ms && m.buyer_hub_handshake_ms.values['p(95)'])}ms`);
  lines.push('');
  return lines.join('\n');
}

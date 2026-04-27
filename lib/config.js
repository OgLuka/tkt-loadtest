// config.js — env-driven configuration for the tkt.ge load test.
//
// Override at runtime with `-e KEY=value` on the k6 CLI, e.g.
//   k6 run -e API_BASE=https://gateway.tkt.ge -e PEAK_VUS=20000 loadtest.js

const env = (key, fallback) => (__ENV[key] !== undefined ? __ENV[key] : fallback);
const num = (key, fallback) => Number(env(key, fallback));

export const CONFIG = {
  // ---- target hosts ----
  // Web origin (Referer / Origin header value, identifies traffic to WAF).
  ORIGIN: env('ORIGIN', 'https://tkt.ge'),
  // The API gateway — every real call we observed goes here.
  API_BASE: env('API_BASE', 'https://gateway.tkt.ge'),
  // SignalR hub host — the seatmap pushes live availability updates via
  // ASP.NET SignalR. Negotiate over HTTPS, then upgrade to WSS.
  SOCKET_BASE: env('SOCKET_BASE', 'https://socket.tkt.ge'),
  // Same host but ws scheme — derived in code, exposed here for override.
  SOCKET_WS_BASE: env('SOCKET_WS_BASE', 'wss://socket.tkt.ge'),
  // API key carried on every call (query param, sometimes also as header).
  // Replace with a load-test-specific key if the team can mint one — that
  // makes filtering test traffic in logs trivial.
  API_KEY: env('API_KEY', '7d8d34d1-e9af-4897-9f0f-5c36c179be77'),

  // ---- the concert under test ----
  // Item id used by /Shows/new (the show / event detail page).
  // Default points at the *test* event so a fresh `k6 run loadtest.js`
  // never accidentally hits a real show. Override with -e EVENT_ITEM_ID=...
  EVENT_ITEM_ID: env('EVENT_ITEM_ID', '501108'),
  // Category passed alongside itemId. tkt.ge uses 'Show' for some pages
  // and 'Event' for others; the test event uses 'Event'.
  EVENT_CATEGORY: env('EVENT_CATEGORY', 'Event'),
  // Map id used by /Events/Map and the seat selection. MUST be the map
  // id that belongs to EVENT_ITEM_ID — set explicitly per run with
  // -e EVENT_MAP_ID=...
  EVENT_MAP_ID: env('EVENT_MAP_ID', '464919'),
  // Date used by /Events/Day on the homepage; defaults to today UTC.
  TODAY: env('TODAY', new Date().toISOString().slice(0, 10)),

  // ---- distributed run ----
  NODE_ID: env('NODE_ID', '1'),
  NODE_COUNT: num('NODE_COUNT', 1),

  // ---- load shape (per node) ----
  PEAK_VUS: num('PEAK_VUS', 30000),
  RAMP_UP_SEC: num('RAMP_UP_SEC', 60),
  HOLD_SEC: num('HOLD_SEC', 180),
  RAMP_DOWN_SEC: num('RAMP_DOWN_SEC', 30),
  BUYER_RATE_PER_MIN: num('BUYER_RATE_PER_MIN', 200),

  // ---- safety ----
  KILL_SWITCH_URL: env('KILL_SWITCH_URL', ''),
  RUN_ID: env('RUN_ID', `run-${Date.now()}`),

  // ---- behaviour tuning ----
  THINK_MIN_MS: num('THINK_MIN_MS', 2000),
  THINK_MAX_MS: num('THINK_MAX_MS', 8000),
  // How long a buyer sits on the seatmap before clicking a seat.
  SEATMAP_BROWSE_MIN_S: num('SEATMAP_BROWSE_MIN_S', 20),
  SEATMAP_BROWSE_MAX_S: num('SEATMAP_BROWSE_MAX_S', 90),
  // How often the frontend polls /Events/Map while the user is on the
  // seatmap. Real frontend appears to poll every ~5s; matching that gives
  // the most realistic load on the map endpoint.
  SEATMAP_POLL_INTERVAL_S: num('SEATMAP_POLL_INTERVAL_S', 5),
};

// Headers a real browser sends to gateway.tkt.ge — copied from devtools
// curl. The User-Agent identifies test traffic so it can be filtered in
// logs and allowlisted at the WAF.
export function makeHeaders(extra = {}) {
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'ka-GE;ka',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Origin: CONFIG.ORIGIN,
    Referer: `${CONFIG.ORIGIN}/`,
    'User-Agent': `tkt-loadtest/1.0 (+authorized; run=${CONFIG.RUN_ID}; node=${CONFIG.NODE_ID})`,
    'X-Loadtest-Run': CONFIG.RUN_ID,
    'X-Loadtest-Node': CONFIG.NODE_ID,
    ...extra,
  };
}

// Helper: build "https://gateway.tkt.ge/<path>?api_key=...&<extra>".
// Hand-rolled because k6's JS runtime (Sobek) does not ship WHATWG URL.
export function withApiKey(path, params) {
  const parts = [`api_key=${encodeURIComponent(CONFIG.API_KEY)}`];
  if (params) {
    for (const k in params) {
      const v = params[k];
      if (v !== undefined && v !== null && v !== '') {
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
      } else if (v === '') {
        parts.push(`${encodeURIComponent(k)}=`); // preserve explicit empty
      }
    }
  }
  const sep = path.indexOf('?') >= 0 ? '&' : '?';
  return `${CONFIG.API_BASE}${path.startsWith('/') ? '' : '/'}${path}${sep}${parts.join('&')}`;
}

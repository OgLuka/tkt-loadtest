// buyer.js — post-queue buyer flow against the real tkt.ge stack.
//
// One iteration simulates a single buyer released from the third-party
// queue onto the booking flow:
//
//   1. GET /Events/Map?mapId=... — initial seatmap snapshot (REST)
//   2. POST socket.tkt.ge/maphub/negotiate?negotiateVersion=1 — get a
//      SignalR connectionId.
//   3. Open WSS to socket.tkt.ge/maphub?id=<connectionId> and send the
//      SignalR JSON handshake. The hub pushes live availability deltas
//      while the user looks at the map.
//   4. Sit on the map for SEATMAP_BROWSE_MIN_S..MAX_S seconds. The WS
//      stays open the whole time; this is the realistic shape of an
//      onsale fanout.
//   5. POST /Booking/choose-seat with a seatId+ticketTypeId picked from
//      the parsed map — the real lock contention point.
//   6. GET /v2/orders/checkout/details?orderKey=... using the orderKey
//      returned from choose-seat. Stop here. No payment.
//
// We do NOT model the third-party queue itself — buyers are released into
// this flow at the rate the queue would release them (BUYER_RATE_PER_MIN).

import http from 'k6/http';
import ws from 'k6/ws';
import { check, group } from 'k6';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { CONFIG, makeHeaders, withApiKey } from './config.js';
import { randInt, shouldAbort } from './utils.js';

// SignalR JSON protocol record-separator. Every message must end with this.
const RS = String.fromCharCode(0x1e);

// Custom metrics — funnel visibility separate from raw HTTP timings.
const seatLocksAttempted = new Counter('buyer_seat_locks_attempted');
const seatLocksSucceeded = new Counter('buyer_seat_locks_succeeded');
const seatLocksConflict = new Counter('buyer_seat_locks_conflict');
const checkoutsReached = new Counter('buyer_checkouts_reached');
const mapParseTime = new Trend('buyer_map_parse_ms');
const mapBytes = new Trend('buyer_map_bytes');
const hubConnects = new Counter('buyer_hub_connects');
const hubMessages = new Counter('buyer_hub_messages');
const hubHandshakeMs = new Trend('buyer_hub_handshake_ms');

export function runBuyer() {
  if (shouldAbort()) return;

  // ---- 1. fetch the seatmap (initial load) ----------------------------
  let mapResp, freeSeats;
  group('seatmap_initial', function () {
    mapResp = http.get(
      withApiKey('/Events/Map', {
        mapId: CONFIG.EVENT_MAP_ID,
        orderKey: '',
        onlyAccessCodeSeats: 'false',
      }),
      {
        headers: makeHeaders(),
        tags: { name: 'seatmap_map' },
        // Map response is large (60k seats); keep it as text so we can parse.
        responseType: 'text',
      },
    );
    if (mapResp.body) mapBytes.add(String(mapResp.body).length);
    if (
      !check(mapResp, {
        'seatmap 2xx': (r) => r.status >= 200 && r.status < 300,
      })
    ) {
      return;
    }
    const t0 = Date.now();
    freeSeats = parseFreeSeats(mapResp.body);
    mapParseTime.add(Date.now() - t0);
  });
  if (!freeSeats || !freeSeats.length) return;

  // ---- 2. SignalR negotiate -------------------------------------------
  // POST /maphub/negotiate?negotiateVersion=1 with empty body. Returns
  // { connectionId, negotiateVersion, availableTransports: [...] } or in
  // some SignalR versions { connectionToken, connectionId, ... }.
  let connectionId = null;
  group('hub_negotiate', function () {
    const r = http.post(
      `${CONFIG.SOCKET_BASE}/maphub/negotiate?negotiateVersion=1`,
      null,
      {
        headers: makeHeaders({
          'Content-Type': 'text/plain;charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        }),
        tags: { name: 'hub_negotiate' },
        responseType: 'text',
      },
    );
    if (
      check(r, {
        'negotiate 2xx': (res) => res.status >= 200 && res.status < 300,
      })
    ) {
      try {
        const body = r.json();
        // SignalR Core: prefer connectionToken (used in URL since v1+),
        // fall back to connectionId for older clients.
        connectionId = body.connectionToken || body.connectionId || null;
      } catch (_) { /* ignore */ }
    }
  });

  // ---- 3. open the SignalR WebSocket and hold it through browse ------
  // The hub pushes seat availability deltas while the user is on the map.
  // We hold the connection for SEATMAP_BROWSE_MIN_S..MAX_S seconds.
  const browseSeconds = randInt(
    CONFIG.SEATMAP_BROWSE_MIN_S,
    CONFIG.SEATMAP_BROWSE_MAX_S,
  );

  if (connectionId) {
    const wsUrl = `${CONFIG.SOCKET_WS_BASE}/maphub?id=${encodeURIComponent(connectionId)}`;
    const wsRes = ws.connect(
      wsUrl,
      {
        headers: {
          Origin: CONFIG.ORIGIN,
          'User-Agent': makeHeaders()['User-Agent'],
        },
        tags: { name: 'seatmap_hub_ws' },
      },
      function (socket) {
        const openedAt = Date.now();
        let handshakeAcked = false;
        hubConnects.add(1);

        socket.on('open', function () {
          // SignalR JSON handshake — must be terminated with 0x1E.
          socket.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS);
        });

        socket.on('message', function (data) {
          hubMessages.add(1);
          if (!handshakeAcked) {
            // First server frame is the handshake response: "{}".
            handshakeAcked = true;
            hubHandshakeMs.add(Date.now() - openedAt);
          }
          // Server pings come as {"type":6}. SignalR JSON ping responses
          // are not strictly required for short-lived connections, but
          // sending one back keeps the connection healthy if the hub
          // enforces client keep-alive.
          if (typeof data === 'string' && data.indexOf('"type":6') !== -1) {
            socket.send('{"type":6}' + RS);
          }
        });

        socket.on('error', function (e) {
          // Don't fail the iteration on transient ws errors.
          console.warn('hub ws error: ' + (e && e.error ? e.error() : e));
        });

        socket.setTimeout(function () { socket.close(); }, browseSeconds * 1000);
      },
    );
    check(wsRes, { 'hub ws 101': (r) => r && r.status === 101 });
  } else {
    // Fallback: no negotiation — just sleep through the browse window so
    // the buyer arrival rate stays correct even if the hub is degraded.
    sleep(browseSeconds);
  }
  if (shouldAbort()) return;

  // ---- 3. choose-seat (the lock) --------------------------------------
  // Real frontend sends:
  //   POST /Booking/choose-seat?api_key=...
  //   { "seats":[{"quantity":1,"seatId":<int>,"ticketTypeId":<int>}],
  //     "accessCode": null }
  //
  // 70% of buyers target a "hot" subset (smallest-capacity / front-row
  // sections) to model realistic contention; 30% pick from anywhere.
  // Sort ascending by available qty so the first slice is the scarcest
  // tickets — they're the ones that should fight for locks under spike.
  const sorted = freeSeats.slice().sort(function (a, b) {
    return a.availableQty - b.availableQty;
  });
  const hotCutoff = Math.max(1, Math.min(sorted.length, Math.ceil(sorted.length * 0.2)));
  const pool = Math.random() < 0.7 ? sorted.slice(0, hotCutoff) : sorted;
  const pick = pool[randInt(0, pool.length - 1)];
  const ticketTypeId = pickTicketType(pick);

  let orderKey = null;
  group('choose_seat', function () {
    seatLocksAttempted.add(1);
    const r = http.post(
      withApiKey('/Booking/choose-seat'),
      JSON.stringify({
        seats: [{ quantity: 1, seatId: pick.seatId, ticketTypeId: ticketTypeId }],
        accessCode: null,
      }),
      {
        headers: makeHeaders({
          'Content-Type': 'application/json',
          api_key: CONFIG.API_KEY,
          // Frontend literally sends the string "undefined" — keep parity
          // so the test traffic is indistinguishable shape-wise.
          authorization: 'undefined',
        }),
        tags: { name: 'choose_seat' },
        responseType: 'text',
      },
    );

    const ok = r.status >= 200 && r.status < 300;
    if (!ok) {
      // 409/410-ish = seat already taken. Common under onsale spike — we
      // count it separately so it doesn't pollute the error rate.
      if (r.status === 409 || r.status === 410 || r.status === 400) {
        seatLocksConflict.add(1);
      }
      return;
    }
    seatLocksSucceeded.add(1);
    try {
      const body = r.json();
      orderKey =
        (body && (body.orderKey || body.OrderKey || (body.data && body.data.orderKey))) ||
        null;
    } catch (_) {
      orderKey = null;
    }
  });
  if (!orderKey) return;

  // ---- 4. checkout details -------------------------------------------
  group('checkout', function () {
    const r = http.get(
      withApiKey('/v2/orders/checkout/details', {
        orderKey: orderKey,
        eventHubBookingId: '',
      }),
      { headers: makeHeaders(), tags: { name: 'checkout_details' } },
    );
    if (check(r, { 'checkout details 2xx': (res) => res.status < 400 })) {
      checkoutsReached.add(1);
    }
  });

  // We DO NOT submit payment from the load test. Doing so would either
  // hit a real PSP or require a sandbox key that we should not embed in
  // the script. Reaching the checkout-details call is the correct stop
  // point for a load test of the booking surface.
}

// ---- helpers -----------------------------------------------------------

// Parse the /Events/Map response into an array of lockable entries.
//
// Real schema (verified against gateway.tkt.ge):
//   {
//     "mapId": ...,
//     "mapSvg": "<base64>",
//     "sections": [...],
//     "seats": [
//       {
//         "seatId": 82809412,
//         "seatName": "Star Ring",
//         "ticketTypeIds": "1800044,1800048",   // CSV string, not array
//         "status": 0,                           // 0 == free
//         "quantityAvailable": 13810,            // tickets left in bucket
//         "quantityCommited": 0,
//         ...
//       }, ...
//     ]
//   }
//
// Each entry can be a single assigned seat (small quantity) or a GA bucket
// (quantity in the thousands). The lock body shape is identical either
// way: { quantity:1, seatId, ticketTypeId }.
function parseFreeSeats(body) {
  if (!body) return [];
  let parsed;
  try {
    parsed = typeof body === 'string' ? JSON.parse(body) : body;
  } catch (_) {
    return [];
  }
  const list = parsed && parsed.seats;
  if (!Array.isArray(list) || !list.length) return [];

  const out = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s) continue;

    // status 0 is "free" in this API; anything else means held/sold/blocked.
    if (Number(s.status) !== 0) continue;
    const avail = Number(s.quantityAvailable || 0);
    if (avail <= 0) continue;

    const seatId = Number(s.seatId);
    if (!seatId) continue;

    // ticketTypeIds is a CSV string. Real frontend lets the user pick one
    // of the offered types; for the load test we keep all valid ids and
    // pick randomly per iteration so the load distributes across types.
    const ttIds = String(s.ticketTypeIds || '')
      .split(',')
      .map(function (t) { return Number(String(t).trim()); })
      .filter(function (t) { return t > 0; });
    if (!ttIds.length) continue;

    out.push({
      seatId: seatId,
      ticketTypeIds: ttIds,
      availableQty: avail,
      name: s.seatName || '',
    });
  }
  return out;
}

// Pick one ticketTypeId from the entry's offered types — random so a
// section that offers two prices gets load on both.
function pickTicketType(entry) {
  const ids = entry.ticketTypeIds;
  return ids[randInt(0, ids.length - 1)];
}

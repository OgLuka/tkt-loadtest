// landing.js — public-surface flows (no queue protection in front).
//
// runLanding(): what a browser does when first loading https://tkt.ge/
//   Mirrors the 7 parallel calls observed in devtools:
//     /Shows/Pinned, /Stories, /Events/Top, /Events/Day, Cavea/Movies,
//     and two Railway availability-calendar calls.
//   These are all fired effectively in parallel by the browser, so we
//   batch them — that is what stresses the gateway, not seven serial GETs.
//
// runEventPage(): what happens when a user clicks the concert card or
//   opens a shared concert link. Hits /Shows/new?itemId=...&category=Show.
//   No redirect to follow here in the API call itself — the queue redirect
//   is on the WEB layer (https://tkt.ge/event/...), not on gateway.tkt.ge.

import http from 'k6/http';
import { check, group } from 'k6';
import { CONFIG, makeHeaders, withApiKey } from './config.js';
import { thinkTime, shouldAbort } from './utils.js';

export function runLanding() {
  if (shouldAbort()) return;

  group('landing', function () {
    const headers = makeHeaders();

    // Real frontend issues these effectively in parallel. http.batch
    // matches that — one network "wave" of seven GETs per VU.
    const responses = http.batch([
      ['GET', withApiKey('/Shows/Pinned'), null, { headers: headers, tags: { name: 'home_pinned' } }],
      ['GET', withApiKey('/Stories'), null, { headers: headers, tags: { name: 'home_stories' } }],
      ['GET', withApiKey('/Events/Top'), null, { headers: headers, tags: { name: 'home_events_top' } }],
      ['GET', withApiKey('/Events/Day', { date: CONFIG.TODAY }), null, { headers: headers, tags: { name: 'home_events_day' } }],
      ['GET', withApiKey('/integrations/api/Cavea/Movies'), null, {
        headers: makeHeaders({ 'x-api-key': CONFIG.API_KEY }),
        tags: { name: 'home_cavea_movies' },
      }],
      ['GET', withApiKey('/integrations/api/GeorgianRailway/Availability/availability-calendar', {
        fromStationCode: '57151',
        toStationCode: '56014',
      }), null, {
        headers: makeHeaders({ api_key: CONFIG.API_KEY }),
        tags: { name: 'home_rail_calendar_a' },
      }],
      ['GET', withApiKey('/integrations/api/GeorgianRailway/Availability/availability-calendar', {
        fromStationCode: '56014',
        toStationCode: '57151',
      }), null, {
        headers: makeHeaders({ api_key: CONFIG.API_KEY }),
        tags: { name: 'home_rail_calendar_b' },
      }],
    ]);

    // Sanity check on the most important call — listing the homepage shows.
    check(responses[0], { 'shows pinned 2xx': (r) => r.status >= 200 && r.status < 300 });

    thinkTime();

    // 50% of landing visitors click into the featured concert card. We
    // model that here so the landing scenario also drives event-detail
    // load proportionally to homepage traffic.
    if (Math.random() < 0.5) {
      const r = http.get(
        withApiKey('/Shows/new', { itemId: CONFIG.EVENT_ITEM_ID, category: 'Show' }),
        { headers: headers, tags: { name: 'event_detail_from_landing' } },
      );
      check(r, { 'event detail 2xx': (res) => res.status >= 200 && res.status < 300 });
    }
  });
}

export function runEventPage() {
  if (shouldAbort()) return;

  group('event_page', function () {
    const headers = makeHeaders();

    // Direct hit (e.g. someone shared the link in a Telegram channel).
    const r = http.get(
      withApiKey('/Shows/new', { itemId: CONFIG.EVENT_ITEM_ID, category: 'Show' }),
      { headers: headers, tags: { name: 'event_detail_direct' } },
    );
    check(r, { 'event detail 2xx': (res) => res.status >= 200 && res.status < 300 });

    thinkTime();
  });
}

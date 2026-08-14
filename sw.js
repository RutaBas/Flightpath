"use strict";

/* Service worker — cache-first app shell. Copied from
   games/_recipes/pwa-shell/sw.js.txt.

   Every shipped file is listed explicitly. Flightpath generates its boards on
   the device and keeps state in localStorage, so once the shell is cached the
   game is fully playable with no network at all — including starting a new
   level, which is real generation, not a lookup.

   CACHE_VERSION IS UNIQUE TO THIS GAME AND MUST BE BUMPED ON EVERY DEPLOY THAT
   CHANGES A PRECACHED FILE. Two games sharing a cache name on one origin serve
   each other's files; forgetting to bump means an installed player keeps the
   old shell forever and never sees the fix.

     flightpath-v1  2026-08-13  first shipped UI (steps 6 + 7)
     flightpath-v3  2026-08-13  meta-layer mounted: js/meta/*, levels, par,
                                meta-config, meta-ui — all new files, so an
                                un-bumped cache would have served the old
                                index.html and none of them
     flightpath-v4  2026-08-13  ladder grew to 7 tiers: js/levels.js re-baked
                                (280 rows), meta-config, par, meta-ui and the
                                home CSS all changed. Tiers 1-5 are byte-for-byte
                                the same rows, but the FILE changed, so every
                                installed player must be served the new one
     flightpath-v5  2026-08-13  campaign scaled to 7 x 500 = 3,500 levels.
                                js/levels.js re-baked and re-encoded (packed
                                base36, 8.9KB -> 22.1KB for 12.5x the levels),
                                meta-config gates rescaled, meta-ui level map
                                chunked, js/meta/progress.js re-vendored with
                                aggregate counters
     flightpath-v8  2026-08-13  daily rotation escalates across all 7 tiers
                                (Mon easiest, Sun Airspace Closed); frozen
                                dailies now pin their tier as well as their
                                board (fp:dailyboards v2); persistent "?" help
                                control on home and every meta header

   Anything missing from PRECACHE 404s OFFLINE ONLY — which passes every test
   run at a desk. Install to the home screen and switch on airplane mode before
   calling this done. */

var CACHE_VERSION = "flightpath-v8";

/* index.html, walked top to bottom. Google Fonts is deliberately absent: it is
   cross-origin, is never intercepted below, and the stack falls back to
   system-ui when it is unreachable. */
var PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/style.css",

  // the verified logic core, in load order
  "./js/rng.js",
  "./js/board.js",
  "./js/solver.js",
  "./js/generator.js",

  /* The shared meta-layer, vendored into js/meta/ by games/_shared/sync.js.
     A service worker cannot serve ../_shared/ — it is outside this scope — so
     these MUST be listed here or the whole campaign/daily/records layer 404s
     the moment the network goes away, and only then. */
  "./js/meta/store.js",
  "./js/meta/rng.js",
  "./js/meta/progress.js",
  "./js/meta/daily.js",
  "./js/meta/records.js",
  "./js/meta/rank.js",
  "./js/meta/index.js",

  // the app layer
  "./js/history.js",
  "./js/timer.js",
  "./js/storage.js",
  "./js/sound.js",
  "./js/celebrate.js",
  "./js/gestures.js",
  "./js/tap-guard.js",
  "./js/art.js",
  "./js/par.js",
  "./js/levels.js",
  "./js/meta-config.js",
  "./js/game.js",
  "./js/meta-ui.js",
  "./js/ui.js",

  // icons
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function (c) { return c.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return k === CACHE_VERSION ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  /* Cross-origin (the webfonts) is a progressive enhancement. Never intercept
     it — a font CDN hiccup must not block a game load. */
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req)
        .then(function (res) {
          if (res && res.ok && res.type === "basic") {
            var copy = res.clone();
            caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); });
          }
          return res;
        })
        .catch(function () {
          /* An offline navigation still gets the shell — without this, a cold
             launch of the installed app on a plane shows the browser error
             page instead of the game. */
          if (req.mode === "navigate") return caches.match("./index.html");
          return new Response("", { status: 504, statusText: "offline" });
        });
    })
  );
});

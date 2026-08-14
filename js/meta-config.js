"use strict";

/* Mounts the shared meta-layer for FLIGHTPATH.

   The library is games/_shared/meta, vendored into js/meta/ by
   `node games/_shared/sync.js flightpath`. NEVER edit js/meta/* — edit the
   shared copy and re-sync. Nothing about progression is implemented here: this
   file is a config object, one star rule, and one migration.

   WHAT IS MOUNTED
     · progress   the 5-tier campaign ladder, 40 levels each, with Gridlock
                  gated behind 100 cleared levels
     · daily      one board per UTC day, streak, freezes, replay calendar
     · records    per-tier best / average / improvement trend
     · rank       the local rank badge, from par-relative curves

   KEY PREFIX — "fpm", NOT "fp", AND THAT IS DELIBERATE.
   The game already stores fp:save / fp:progress / fp:seen through js/storage.js
   (the save-migration recipe), and that store keeps its slot versions in
   fp:__schema. MetaStore keeps ITS versions in "<prefix>:__schema". Mounting
   the library under "fp" would put two independent schema maps at the same key,
   each writing the whole object, and they would silently clobber each other's
   version numbers — which is exactly the failure the versioned-slot pattern
   exists to prevent. Separate prefixes, no shared keys, one migration to carry
   the old data across. Store.clearAll() in js/storage.js wipes both.

   TIME NEVER TAKES A STAR HERE. starsFor() below ignores `par` entirely, so
   par is a pace reference on the win screen and the x-axis of the rank curve —
   nothing more. See js/par.js. */

var Meta = (function () {

  /* The ladder, exactly as signed off at the design gate (design-brief.md,
     L3 · Airspace). Grid sizes are carried for the UI; the generator owns the
     real ones and js/game.js reads them from it, so these are labels, not a
     second source of truth. */
  var TIER_DEFS = [
    {
      key: "clear", name: "Clear Skies", grid: "4×5", tier: 1, levels: 40,
      par: function (n) { return FPLevels.parFor("clear", n); }
    },
    {
      key: "light", name: "Light Traffic", grid: "5×6", tier: 2, levels: 40,
      par: function (n) { return FPLevels.parFor("light", n); }
    },
    {
      key: "holding", name: "Holding", grid: "6×7", tier: 3, levels: 40,
      par: function (n) { return FPLevels.parFor("holding", n); }
    },
    {
      key: "stacked", name: "Stacked", grid: "6×8", tier: 4, levels: 40,
      par: function (n) { return FPLevels.parFor("stacked", n); }
    },
    {
      key: "gridlock", name: "Gridlock", grid: "7×9", tier: 5, levels: 40,
      par: function (n) { return FPLevels.parFor("gridlock", n); },
      /* The one gate on the ladder. 100 distinct levels cleared — two and a
         half tiers — before the hardest airspace opens. */
      requires: { cleared: 100 }
    }
  ];

  /* THE STAR RULE. Settled at intake, not open at the design gate: three stars
     for a clean clear, two for one slip OR one hint, one for clearing it.
     `par` is accepted and ignored — a player who sits and thinks for ten
     minutes keeps all three stars. */
  function starsFor(res) {
    var blemishes = (res.hints || 0) + (res.mistakes || 0);
    if (blemishes === 0) return 3;
    if (blemishes === 1) return 2;
    return 1;
  }

  /* Rank curves, par-relative and honest about it: rank.js reports
     source:"local", because these model "fast for this tier" rather than a real
     population. Anchored on the tier's mid-ladder par (level 20). */
  var curves = {};
  TIER_DEFS.forEach(function (t) {
    var mid = FPLevels.parFor(t.key, 20) || 60000;
    curves[t.key] = [
      [Math.round(mid * 0.35), 3],
      [Math.round(mid * 0.55), 12],
      [Math.round(mid * 0.80), 30],
      [Math.round(mid * 1.00), 50],
      [Math.round(mid * 1.45), 75],
      [Math.round(mid * 2.30), 94]
    ];
  });

  var meta = GameMeta.create({
    id: "flightpath",
    prefix: "fpm",
    tiers: TIER_DEFS,
    curves: curves,
    starsFor: starsFor,
    daily: {
      /* Difficulty rotation, Sunday first. Easier at the start of the week,
         congested by the weekend — and Gridlock only on Saturday, so the
         hardest airspace is an event rather than a wall you hit on a Tuesday.
         The daily is NOT gated on the campaign: a daily win never writes to the
         ladder, and the ladder never unlocks a daily. */
      tierByDow: ["holding", "clear", "light", "light", "holding", "stacked", "gridlock"],
      /* Miss a day and a freeze is spent instead of the streak resetting.
         Earned by keeping it going, capped at three. */
      freezes: { max: 3, earnEvery: 7 },
      /* Nothing before the day the meta-layer shipped is playable, so the
         calendar greys out the past rather than offering boards that never
         existed. */
      firstDay: "2026-08-13"
    }
  });

  meta.tierDefs = TIER_DEFS;
  meta.starsFor = starsFor;

  meta.tierByKey = function (key) {
    for (var i = 0; i < TIER_DEFS.length; i++) if (TIER_DEFS[i].key === key) return TIER_DEFS[i];
    return null;
  };

  /* The generator's 1-based tier index for a tier key — the one place the
     ladder's names meet the logic core's numbering. */
  meta.tierIndex = function (key) {
    var d = meta.tierByKey(key);
    return d ? d.tier : 1;
  };

  /* ------------------------------------------------------------- migration

     Players from the pre-meta build have fp:progress — { stars: {1..200: n},
     cleanRun, lastLevel } written by js/storage.js, on a GLOBAL 1..200 level
     numbering. The library stores per-tier ladders, so the numbers have to be
     re-homed: level 47 becomes light #7.

     store.migrate() is idempotent and records its version even when the source
     data is absent, so this runs exactly once per install either way, and a
     throw inside it is caught by the library and leaves the slot alone. */
  function migrateLegacy() {
    var store = meta.store;

    store.migrate("progress", 1, function (existing) {
      if (existing) return undefined;                       // already mounted
      var old = store.getRaw("fp:progress", null);
      if (!old || !old.stars) return undefined;             // nothing to carry

      var state = {
        v: 1, tiers: {}, totalStars: 0, solvedCount: 0, clearedCount: 0,
        openedTiers: []
      };

      Object.keys(old.stars).forEach(function (k) {
        var globalLevel = parseInt(k, 10);
        if (!(globalLevel >= 1 && globalLevel <= 200)) return;
        var stars = Math.max(1, Math.min(3, old.stars[k] | 0));
        var tierIdx = Math.floor((globalLevel - 1) / 40);    // 0-based
        var def = TIER_DEFS[tierIdx];
        if (!def) return;
        var n = ((globalLevel - 1) % 40) + 1;

        var t = state.tiers[def.key] || (state.tiers[def.key] = { unlocked: 1, levels: {} });
        t.levels[n] = { stars: stars, bestMs: 0, plays: 1 };
        if (t.unlocked < n + 1 && n + 1 <= def.levels) t.unlocked = n + 1;

        state.totalStars += stars;
        state.solvedCount += 1;
        state.clearedCount += 1;
      });

      if (!state.clearedCount) return undefined;

      /* Seed openedTiers from what the carried-over totals already satisfy, so
         the first win after an update does not announce "GRIDLOCK UNLOCKED"
         for a tier the player opened last week. */
      TIER_DEFS.forEach(function (def) {
        if (!def.requires) return;
        var r = def.requires;
        var ok = (!r.cleared || state.clearedCount >= r.cleared) &&
                 (!r.solved || state.solvedCount >= r.solved) &&
                 (!r.stars || state.totalStars >= r.stars);
        if (ok) state.openedTiers.push(def.key);
      });

      return state;
    });

    /* Re-read what the migration wrote: the live Progress object was built from
       a blank state before this ran. */
    meta.progress.state = store.get("progress", null) || meta.progress.state;
  }

  migrateLegacy();

  return meta;
})();

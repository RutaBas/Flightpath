"use strict";

/* Mounts the shared meta-layer for FLIGHTPATH.

   The library is games/_shared/meta, vendored into js/meta/ by
   `node games/_shared/sync.js flightpath`. NEVER edit js/meta/* — edit the
   shared copy and re-sync. Nothing about progression is implemented here: this
   file is a config object, one star rule, and one migration.

   WHAT IS MOUNTED
     · progress   the campaign ladder — 7 tiers x 500 levels, three of them
                  gated on cumulative clears. Sizes and gates are config, not
                  constants; see LADDER below.
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

  /* ============================ THE LADDER ==============================

     THE ONLY PLACE A TIER'S DISPLAY NAME EXISTS. Nothing else in the game —
     no storage key, no level-table key, no save, no rank curve, no par lookup —
     ever sees a name; they all key off `key`, which is permanent. Renaming
     "Ground Stop" is editing one string on one line here, and it cannot
     invalidate a single save.

     Everything structural (the generator's tier index, the grid, the level
     count) is READ from the baked table's ORDER, which was written from the
     generator's own band table at bake time. So this list carries exactly two
     decisions: what a tier is called, and what it takes to open it. Adding a
     tier is one row here plus one row in scripts/build-levels.js.

     THE GATES. Cumulative clears across the whole ladder, not per tier, so a
     player who bounces between tiers still makes progress toward the top. The
     numbers live on the three rows below and nowhere else. */
  var LADDER = [
    { key: "clear", name: "Clear Skies" },
    { key: "light", name: "Light Traffic" },
    { key: "holding", name: "Holding" },
    { key: "stacked", name: "Stacked" },
    /* THE GATES, one line each and nothing else reads these numbers — retune
       them here. Scaled with the ladder: at 40 levels a tier 100/150/200 was
       36-71% of a 280-level game; at 500 a tier the same numbers would be 7-21%
       of 3,500 and every gate would fall open in the first tier and a half.
       250/500/750 is half a tier, one and a half tiers, and a bit over two. */
    { key: "gridlock", name: "Gridlock", requires: { cleared: 250 } },
    { key: "groundstop", name: "Ground Stop", requires: { cleared: 500 } },
    { key: "closed", name: "Airspace Closed", requires: { cleared: 750 } }
  ];

  var TIER_DEFS = LADDER.map(function (t) {
    var spec = FPLevels.specFor(t.key);
    if (!spec) throw new Error("flightpath: no baked levels for tier '" + t.key + "'");
    return {
      key: t.key,
      name: t.name,
      grid: spec.w + "×" + spec.h,          // from the generator's own band table
      tier: spec.tier,                       // the generator's 1-based index
      levels: FPLevels.LEVELS_PER_TIER,
      requires: t.requires,
      /* The tier's REPRESENTATIVE par — a fallback for anything that needs a
         number before a board exists. The real par of a real board is computed
         from its grade the moment js/game.js builds it, and js/ui.js passes
         that exact value into recordWin, so this default is never what a
         result is measured against. Par cannot take a star either way. */
      par: (function (key) {
        return function () { return FPLevels.parFor(key); };
      })(t.key)
    };
  });

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
     population. Anchored on the tier's median par, baked with the table. */
  var curves = {};
  TIER_DEFS.forEach(function (t) {
    var mid = FPLevels.parFor(t.key) || 60000;
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

  /* Ladder-wide totals, DERIVED — never a literal. Every "x / 3500" and
     "y / 10500" on a stats screen reads these, so growing the ladder moves
     them without anyone having to remember. A hard-coded total in a stats
     panel is the classic way a bigger ladder ships half-wired — this has
     already been 200/600, then 280/840. */
  meta.totalLevels = function () { return TIER_DEFS.length * FPLevels.LEVELS_PER_TIER; };
  meta.totalStars = function () { return meta.totalLevels() * 3; };

  /* ------------------------------------------------------------- migration

     Players from the pre-meta build have fp:progress — { stars: {1..200: n},
     cleanRun, lastLevel } written by js/storage.js, on a GLOBAL 1..200 level
     numbering. The library stores per-tier ladders, so the numbers have to be
     re-homed: level 47 becomes light #7.

     THE 200 AND THE 40 BELOW ARE HISTORY, NOT TOTALS. The pre-meta build
     shipped five tiers of forty, so a legacy save can only ever name levels
     1-200 and can only ever land in the first five tiers. They must NOT be
     updated when the ladder grows — raising them would start mapping numbers
     that build never wrote. Every live total is derived from the config.

     Note that level table v2 re-laid the ramp (40 levels a tier -> 500), so a
     carried-over star sits at the same tier and number but a different board.
     Nothing shipped to a player before v2, so this is a theoretical case; it is
     recorded here rather than discovered later.

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

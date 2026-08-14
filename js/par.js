"use strict";

/* Par time — ONE formula, every consumer.

   The campaign reads par out of the baked level table (js/levels.js); the daily
   computes it at runtime from the board the date generated. Both numbers come
   out of `parMs()` below, so the same board is worth the same par wherever it
   is played. That is the whole reason this is its own file: a par that
   disagreed with itself would make one board mean two different things.

   WHAT PAR IS NOT, IN THIS GAME.

   Flightpath's stars are mistakes and hints ONLY — 3 = cleared with no blocked
   taps and no hints, 2 = one slip or one hint, 1 = cleared — and elapsed time
   is explicitly not scored (design-brief.md stage 7, SPEC.md "Scoring").
   `Meta.starsFor` in js/meta-config.js ignores `par` entirely, so par CANNOT
   take a star here, by construction rather than by calibration.

   So par is a pace reference: the "you were quick" line on the win screen, the
   x-axis of the rank curve, and the shape the records panel compares against.
   It still has to be honest, and it still has to be FORGIVING — the recipe's
   warning is that a target taken from the solver's floor plays far too hard.
   The solver clears a tier-5 board in about 20 rounds of instantaneous tapping;
   a human reads the lane first.

   THE MODEL

     par = (arrows x SEC_PER_ARROW[tier] + depth x SEC_PER_ROUND + SCAN) x SLACK

   · arrows        every arrow is at least one decision and one tap.
   · SEC_PER_ARROW rises with the tier because the same tap costs more thought
                   on a congested board — more lanes cross it, and more of them
                   are shut.
   · depth         the number of rounds is how far ahead you have to plan; each
                   extra round is a re-scan of the board.
   · SCAN          a flat opening cost: reading the shape before the first tap.
   · SLACK         2.2x headroom on top of an unhurried pace, so a player can
                   put the phone down mid-level and still land under par. */

(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FPPar = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  /* Seconds of unhurried play per arrow, by tier. Not a straight line: the step
     from Holding to Stacked is where walls and bottleneck rounds arrive
     together, so it is the biggest one. */
  var SEC_PER_ARROW = {
    clear: 1.10,       // 4x5 — nearly everything is free on sight
    light: 1.20,       // 5x6 — real ordering appears
    holding: 1.45,     // 6x7 — first walls
    stacked: 1.75,     // 6x8 — walls plus width-1 rounds
    gridlock: 2.00,    // 7x9 — long rays, dense traps

    /* The top two tiers are the SAME 63 cells as gridlock — the grid cannot
       grow without breaking the 44px tap floor — so what rises is not the
       amount of tapping but the amount of looking before each tap. Their bands
       gate minRoundWidth to exactly 1 with a forced run of 10+ (tier 6) and 16+
       (tier 7): stretches where the whole board offers ONE legal move and the
       player has to find it. Every one of those taps is a full board scan, and
       the per-arrow figure is what pays for it.

       Keyed by tier KEY, never by display name — the names are a one-line
       change in js/meta-config.js and must never reach a lookup. */
    groundstop: 2.20,  // 7x9 — long forced runs; one legal move at a time
    closed: 2.40       // 7x9 — the longest runs, and almost every blocker is a plane
  };

  var SEC_PER_ROUND = 2.0;   // each planning round is a fresh read of the board
  var SCAN_SEC = 6.0;        // opening look at the shape
  var SLACK = 2.2;           // forgiveness, deliberately generous

  /* metrics is a solver grade() object (or anything carrying arrows/depth). */
  function parMs(tierKey, metrics) {
    var m = metrics || {};
    var arrows = m.arrows || 0;
    var depth = m.depth || 0;
    var per = SEC_PER_ARROW[tierKey];
    if (!per) per = SEC_PER_ARROW.holding;
    var sec = (arrows * per + depth * SEC_PER_ROUND + SCAN_SEC) * SLACK;
    /* Rounded to the nearest second: par is shown as m:ss, and a par that
       carried milliseconds would render one way and compare another. */
    return Math.round(sec) * 1000;
  }

  /* For the daily and for any replay: grade the live board and price it. The
     caller passes the solver's grade so this file never runs a solve itself. */
  function parForGrade(tierKey, grade) { return parMs(tierKey, grade); }

  function fmt(ms) {
    var s = Math.round((ms || 0) / 1000);
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }

  return {
    parMs: parMs,
    parForGrade: parForGrade,
    fmt: fmt,
    SEC_PER_ARROW: SEC_PER_ARROW,
    SEC_PER_ROUND: SEC_PER_ROUND,
    SCAN_SEC: SCAN_SEC,
    SLACK: SLACK
  };
});

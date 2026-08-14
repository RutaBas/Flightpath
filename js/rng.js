"use strict";

/* Seeded RNG — mulberry32 + FNV-1a string hashing.
   COPIED from games/_recipes/seeded-rng/rng.js.txt. Do not "improve" it here;
   fix the recipe and re-copy.

   Source: games/_shared/meta/rng.js, itself lifted from potion-vials/src/rng.js,
   which had the best-documented version of the pair that was duplicated across
   nine games.

   Why the string hash matters: level seeds are derived from names like
   "flightpath|t3|s47|a12". Feeding a raw counter into mulberry32 gives
   neighbouring levels visibly similar grids, because mulberry32's first output
   is a nearly linear function of its seed. Running the name through an
   avalanching hash first makes "...-47" and "...-48" diverge completely.

   FLIGHTPATH SEEDING RULES (recipe gotchas 1 and 2, both load-bearing here):
     1. Never hand mulberry32 a raw counter. Always build a STRING.
     2. Never form a seed by ADDING level and retry attempt. The generator
        retries by bumping an attempt counter; if levels were seeded at a fixed
        stride the two strides alias and a whole level table silently collapses
        into duplicates. flightpath's generator therefore always hashes
        `"flightpath|t" + tier + "|s" + seed + "|a" + attempt` as ONE string —
        see js/generator.js attemptSeed(). Different (seed, attempt) pairs can
        never meet, because the separators make the string injective.

   The UMD wrapper is what lets the same file run under node (for the generator
   test harness and build-levels scripts) and in the browser. Keep it — a
   generator you cannot exercise headlessly cannot be solver-gated. */

(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FlightpathRng = api;   // TODO resolved: namespaced, nothing else in-game owns `Rng`
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* FNV-1a, then a murmur3 finalising avalanche. */
  function hashSeed(str) {
    var h = 2166136261 >>> 0;
    str = String(str);
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= h >>> 16;
    h = Math.imul(h, 2246822507) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 3266489909) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
  }

  /* Accepts a number (used directly) or a string (hashed first).
     Prefer strings: "<game>|<tier>|<n>" is readable in a bug report and
     avalanches properly. */
  function makeRng(seedOrString) {
    var s = typeof seedOrString === "number" ? seedOrString >>> 0 : hashSeed(seedOrString);
    return mulberry32(s);
  }

  function randInt(rng, n) {
    return (rng() * n) | 0;
  }

  /* Fisher-Yates, in place, returns the same array. */
  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = randInt(rng, i + 1);
      var t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  return {
    mulberry32: mulberry32,
    hashSeed: hashSeed,
    makeRng: makeRng,
    randInt: randInt,
    shuffle: shuffle
  };
});

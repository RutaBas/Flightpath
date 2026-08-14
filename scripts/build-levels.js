"use strict";

/* FLIGHTPATH — bake the level table.  node scripts/build-levels.js

   Writes js/levels.js: 7 tiers x 500 levels, PACKED.

   WHY A BAKED TABLE AND NOT A SEED PER LEVEL

   "level N uses seed N" is the obvious thing and it is wrong. The generator is
   gated on an EXACT tier band, so every board it returns is legal — but inside
   that band the spread is wide, and seed order is random within it. A raw seed
   order hands you level 3 at the top of the band and level 400 at the bottom;
   the tier gets harder and nothing inside it does.

   So: generate a large certified pool per tier, grade every candidate with the
   solver's OWN effort metric, sort the pool by it, and lay the levels along an
   eased quantile ramp through that pool. Difficulty then rises monotonically
   inside every tier by construction, measured rather than hoped for.

     q(n)  = ((n - 1) / (LEVELS_PER_TIER - 1)) ^ 1.15
     index = round(q(n) x (pool - 1))

   The 1.15 exponent leans the first fifth of every tier toward the easy end of
   the band — a new tier is a new grid or a new structure, so it should
   introduce itself before it tests you — then climbs to the top by the last
   level.

   THE POOL IS 5x THE LADDER. At 500 levels a tier, a pool of 500-ish would
   have the quantile picking the same candidate repeatedly and the ramp would
   flat-spot; 2500 keeps consecutive levels on genuinely different boards. The
   number of DISTINCT efforts in each pool is printed below, because that, not
   the pool size, is what actually bounds the ramp's resolution.

   WHAT IS STORED, AND WHAT IS NOT

     seed    the argument to generate(seed, tier). Two levels never share one.
     effort  the solver's composite difficulty, x10 as an integer.

   Par is NOT stored. It used to be, and it cost 2 bytes a level to carry a
   number that can be recomputed exactly: js/game.js already has the graded
   board in hand the moment a level is built, so FPPar.parForGrade() gives the
   real par for the real board. The alternative — fitting par from effort — was
   measured and rejected: a per-tier least-squares fit is out by up to 40s on
   Airspace Closed, which is 10% of a seven-minute par. One representative par
   per tier IS baked (the ladder's median) for the rank curve and for any UI
   that needs a number before a board exists.

   NEVER REGENERATE THIS AND SHIP IT SILENTLY once players have progress. The
   table is committed output; re-baking re-lays every level. v2 did exactly
   that — 40 levels a tier to 500 — and it was only safe because nothing had
   shipped. Bump TABLE_VERSION if it ever moves again. */

const fs = require("fs");
const path = require("path");

const Board = require("../js/board.js");
const Solver = require("../js/solver.js");
const Generator = require("../js/generator.js");
const FPPar = require("../js/par.js");

/* v2 — 500 levels a tier (was 40). Re-laying the ramp over 500 steps moves
   every level's position, so the boards behind tier N level M are NOT the ones
   v1 shipped. Acceptable exactly once, because nothing has reached a player
   yet. After this, treat the table as immutable. */
const TABLE_VERSION = 2;
const LEVELS_PER_TIER = 500;
/* The pool must be comfortably larger than the ladder or the eased quantile
   starts picking the same candidate twice and the ramp flat-spots. 5x. */
const POOL_TARGET = 2500;
const SEED_CAP = 200000;      // hard stop on the candidate search
const EASE = 1.15;

/* Tier KEYS are permanent: they are the identity the meta-layer persists, and
   they are the only thing js/levels.js knows about a tier. Display names live
   in js/meta-config.js and appear NOWHERE in this file or its output, so a
   rename is a one-line change that cannot invalidate a save.

   APPEND-ONLY. New tiers go on the END of this list and nowhere else. */
const TIERS = [
  { key: "clear", tier: 1 },
  { key: "light", tier: 2 },
  { key: "holding", tier: 3 },
  { key: "stacked", tier: 4 },
  { key: "gridlock", tier: 5 },
  { key: "groundstop", tier: 6 },
  { key: "closed", tier: 7 }
];

/* Every board ever accepted, keyed by its serialization, so a duplicate can
   never be selected twice — not within a tier and not across tiers. */
const seenBoards = new Set();

function buildPool(spec) {
  const pool = [];
  let seed = 1;
  let dupes = 0;
  let dead = 0;
  while (pool.length < POOL_TARGET && seed <= SEED_CAP) {
    const res = Generator.generate(seed, spec.tier);
    seed++;
    if (!res.board) { dead++; continue; }

    const key = Board.key(res.board);
    if (seenBoards.has(key)) { dupes++; continue; }
    seenBoards.add(key);

    pool.push({
      seed: res.seed,
      effort: res.grade.effort,
      depth: res.grade.depth,
      arrows: res.grade.arrows,
      par: FPPar.parMs(spec.key, res.grade)
    });
  }
  /* Sort by the solver's own effort; depth then seed break ties so the table is
     a pure function of the inputs. */
  pool.sort((a, b) => (a.effort - b.effort) || (a.depth - b.depth) || (a.seed - b.seed));
  return { pool, dupes, dead, seedsTried: seed - 1 };
}

function selectRamp(pool) {
  const out = [];
  const used = new Set();
  for (let n = 1; n <= LEVELS_PER_TIER; n++) {
    const q = Math.pow((n - 1) / (LEVELS_PER_TIER - 1), EASE);
    let idx = Math.round(q * (pool.length - 1));
    /* Monotone and distinct: a rounding collision walks forward, never back,
       so the ramp can never dip. */
    while (used.has(idx) && idx < pool.length - 1) idx++;
    while (used.has(idx) && idx > 0) idx--;
    used.add(idx);
    out.push(pool[idx]);
  }
  return out;
}

/* ------------------------------------------------------------- packing ----

   Two fixed-width base36 strings per tier, no separators:

     seeds    `w` chars each (3 while seeds stay under 46,656, else 4)
     efforts  2 chars each — the DELTA from the previous level, x10. The ramp
              is sorted ascending, so deltas are small non-negative integers;
              2 base36 chars hold up to 1295, i.e. a jump of 129.5 effort,
              which is wider than any tier's whole band. Asserted below.

   Fixed width means a lookup is a substring and a parseInt — no split, no
   array of 3,500 objects, and nothing decoded at startup at all. */
function pack(chosen) {
  const maxSeed = chosen.reduce((m, c) => Math.max(m, c.seed), 0);
  const w = maxSeed < Math.pow(36, 3) ? 3 : 4;
  let s = "";
  for (const c of chosen) {
    const t = c.seed.toString(36);
    if (t.length > w) throw new Error("seed " + c.seed + " does not fit " + w + " base36 chars");
    s += "0".repeat(w - t.length) + t;
  }

  const e10 = chosen.map((c) => Math.round(c.effort * 10));
  let e = "";
  let maxDelta = 0;
  for (let i = 1; i < e10.length; i++) {
    const d = e10[i] - e10[i - 1];
    if (d < 0) throw new Error("effort dips at level " + (i + 1) + " — the ramp is not monotone");
    if (d > maxDelta) maxDelta = d;
    if (d >= 36 * 36) throw new Error("effort delta " + d + " overflows 2 base36 chars");
    const t = d.toString(36);
    e += (t.length === 1 ? "0" : "") + t;
  }
  return { w, s, e, e0: e10[0], maxDelta };
}

/* --------------------------------------------------------------- bake ---- */

const table = {};
const stats = [];
const t00 = Date.now();

for (const spec of TIERS) {
  const t0 = Date.now();
  const { pool, dupes, dead, seedsTried } = buildPool(spec);
  if (pool.length < LEVELS_PER_TIER) {
    console.error("FATAL: tier " + spec.key + " only certified " + pool.length + " boards");
    process.exit(1);
  }
  const chosen = selectRamp(pool);
  const packed = pack(chosen);

  const pars = chosen.map((c) => c.par).sort((a, b) => a - b);
  const parMid = pars[Math.floor(pars.length / 2)];

  table[spec.key] = Object.assign({}, packed, { par: parMid });

  const distinctPool = new Set(pool.map((c) => Math.round(c.effort * 10))).size;
  const distinctRamp = new Set(chosen.map((c) => Math.round(c.effort * 10))).size;
  const at = (n) => chosen[n - 1].effort.toFixed(1);

  stats.push({ key: spec.key, pool: pool.length, distinctPool, distinctRamp });

  console.log(
    spec.key.padEnd(11) +
    " pool " + String(pool.length) +
    " (" + String(distinctPool).padStart(4) + " distinct efforts, " +
    String(seedsTried).padStart(5) + " seeds, " + dupes + " dup, " + dead + " dead)" +
    "   L1 " + at(1).padStart(6) + "  L100 " + at(100).padStart(6) +
    "  L250 " + at(250).padStart(6) + "  L400 " + at(400).padStart(6) +
    "  L500 " + at(500).padStart(6) +
    "   ramp uses " + String(distinctRamp).padStart(3) + " distinct" +
    "   par mid " + FPPar.fmt(parMid) +
    "   " + ((Date.now() - t0) / 1000).toFixed(1) + "s"
  );
}

/* --------------------------------------------------------------- emit ---- */

const L = [];
const p = (s) => L.push(s);

p('"use strict";');
p("");
p("/* GENERATED by scripts/build-levels.js — do not edit by hand.");
p("");
p("   " + (TIERS.length * LEVELS_PER_TIER) + " levels: " + TIERS.length +
  " tiers x " + LEVELS_PER_TIER + ", packed.");
p("");
p("   PACK[key] holds two fixed-width base36 strings and no separators:");
p("     s   seeds, `w` chars each — the argument to generate(seed, tier). The");
p("         board is rebuilt on device from this number, never shipped as data,");
p("         and is identical everywhere because generation is deterministic.");
p("     e   effort DELTAS x10, 2 chars each, against e0. The ramp is sorted");
p("         ascending so every delta is >= 0; that is what makes it packable,");
p("         and it is also the guarantee that difficulty never dips inside a");
p("         tier. Reading it back is a substring and a parseInt.");
p("     par ONE representative par for the tier (the ladder's median), for the");
p("         rank curve and for any label needed before a board exists. The");
p("         exact par of an actual board is FPPar.parForGrade() on its grade,");
p("         which js/game.js has in hand the moment the level is built — so no");
p("         per-level par is stored and none is approximated.");
p("");
p("   Nothing is decoded at startup. Seeds are read on demand; a tier's effort");
p("   array is built the first time that tier is asked for one, and cached.");
p("");
p("   ORDER is the ladder's spine: tier KEY (the persisted identity), the");
p("   generator's 1-based tier index, and the grid, all read from the");
p("   generator's own band table at bake time. js/meta-config.js merges display");
p("   names onto it, so nothing here changes when a tier is renamed — and a");
p("   rename cannot reach a storage key, because no name is stored anywhere.");
p("");
p("   COMMITTED OUTPUT. v2 re-laid every level (40 a tier -> 500), which was");
p("   only safe because nothing had shipped. Bump the version if it moves. */");
p("");
p("(function (root, factory) {");
p("  var api = factory();");
p('  if (typeof module !== "undefined" && module.exports) module.exports = api;');
p("  else root.FPLevels = api;");
p('})(typeof globalThis !== "undefined" ? globalThis : this, function () {');
p("");
p("  var VERSION = " + TABLE_VERSION + ";");
p("  var LEVELS_PER_TIER = " + LEVELS_PER_TIER + ";");
p("");
p("  var ORDER = [");
TIERS.forEach((spec, i) => {
  const band = Generator.tierFor(spec.tier);
  p('    { key: "' + spec.key + '", tier: ' + spec.tier +
    ", w: " + band.w + ", h: " + band.h + " }" + (i < TIERS.length - 1 ? "," : ""));
});
p("  ];");
p("");
p("  /* Baked " + new Date().toISOString().slice(0, 10) +
  " — pool " + POOL_TARGET + " per tier, ramp exponent " + EASE + ". */");
p("  var PACK = {");
TIERS.forEach((spec, i) => {
  const t = table[spec.key];
  p("    " + spec.key + ": {");
  p("      w: " + t.w + ", e0: " + t.e0 + ", par: " + t.par + ",");
  p('      s: "' + t.s + '",');
  p('      e: "' + t.e + '"');
  p("    }" + (i < TIERS.length - 1 ? "," : ""));
});
p("  };");
p("");
p("  /* Effort arrays are built once per tier, on first use, and cached. A tier");
p("     nobody opens is never decoded at all. */");
p("  var effortCache = {};");
p("");
p("  function efforts(tierKey) {");
p("    var hit = effortCache[tierKey];");
p("    if (hit) return hit;");
p("    var pk = PACK[tierKey];");
p("    if (!pk) return null;");
p("    var out = new Array(LEVELS_PER_TIER);");
p("    var acc = pk.e0;");
p("    out[0] = acc / 10;");
p("    for (var i = 1; i < LEVELS_PER_TIER; i++) {");
p("      acc += parseInt(pk.e.substr((i - 1) * 2, 2), 36);");
p("      out[i] = acc / 10;");
p("    }");
p("    effortCache[tierKey] = out;");
p("    return out;");
p("  }");
p("");
p("  /* O(1): a substring and a parseInt. No decode, no allocation. */");
p("  function seedFor(tierKey, level) {");
p("    var pk = PACK[tierKey];");
p("    var n = (level | 0) - 1;");
p("    if (!pk || n < 0 || n >= LEVELS_PER_TIER) return 0;");
p("    return parseInt(pk.s.substr(n * pk.w, pk.w), 36);");
p("  }");
p("");
p("  function effortFor(tierKey, level) {");
p("    var e = efforts(tierKey);");
p("    var n = (level | 0) - 1;");
p("    if (!e || n < 0 || n >= LEVELS_PER_TIER) return 0;");
p("    return e[n];");
p("  }");
p("");
p("  /* The tier's representative par. NOT this level's par: the exact one comes");
p("     from the graded board (js/par.js parForGrade), which the game has as soon");
p("     as it builds the level. This is for the rank curve and for labels drawn");
p("     before any board exists. */");
p("  function parFor(tierKey) {");
p("    var pk = PACK[tierKey];");
p("    return pk ? pk.par : 0;");
p("  }");
p("");
p("  function entry(tierKey, level) {");
p("    var seed = seedFor(tierKey, level);");
p("    if (!seed) return null;");
p("    return { seed: seed, effort: effortFor(tierKey, level), par: parFor(tierKey) };");
p("  }");
p("");
p("  function specFor(tierKey) {");
p("    for (var i = 0; i < ORDER.length; i++) if (ORDER[i].key === tierKey) return ORDER[i];");
p("    return null;");
p("  }");
p("");
p("  /* Every level in the ladder — what a totals line divides by, so nothing");
p("     has to hard-code a tier count. */");
p("  function totalLevels() { return ORDER.length * LEVELS_PER_TIER; }");
p("");
p("  return {");
p("    VERSION: VERSION,");
p("    LEVELS_PER_TIER: LEVELS_PER_TIER,");
p("    ORDER: ORDER,");
p("    PACK: PACK,");
p("    entry: entry,");
p("    seedFor: seedFor,");
p("    effortFor: effortFor,");
p("    parFor: parFor,");
p("    specFor: specFor,");
p("    totalLevels: totalLevels");
p("  };");
p("});");
p("");

const out = path.join(__dirname, "..", "js", "levels.js");
const before = fs.existsSync(out) ? fs.statSync(out).size : 0;
fs.writeFileSync(out, L.join("\n"), "utf8");
const after = fs.statSync(out).size;

console.log("\nwrote js/levels.js — " + (TIERS.length * LEVELS_PER_TIER) + " levels, " +
  seenBoards.size + " distinct boards certified across all pools");
console.log("size " + before + " B -> " + after + " B  (" +
  (after / (TIERS.length * LEVELS_PER_TIER)).toFixed(1) + " B/level)");
console.log("bake wall clock " + ((Date.now() - t00) / 1000).toFixed(1) + "s");

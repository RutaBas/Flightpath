"use strict";

/* FLIGHTPATH — bake the level table.  node scripts/build-levels.js

   Writes js/levels.js: 5 tiers x 40 levels, each stored as [seed, effort, par].

   WHY A BAKED TABLE AND NOT A SEED PER LEVEL

   "level N uses seed N" is the obvious thing and it is wrong. The generator is
   gated on an EXACT tier band, so every board it returns is legal — but inside
   that band the spread is wide: in Clear Skies the measured effort runs 52 to
   92, and a raw seed order hands you level 3 at 91 and level 40 at 54. The
   ladder then has no ramp at all; it has noise. The tier gets harder, and
   within a tier nothing does.

   So: generate a large certified pool per tier, grade every candidate with the
   solver's OWN effort metric, sort the pool by it, and lay the 40 levels along
   a ramp through that pool. Difficulty then rises monotonically inside every
   tier by construction, measured rather than hoped for.

   THE RAMP is an eased quantile through the pool:

     q(n)  = ((n - 1) / 39) ^ 1.15          n = 1..40
     index = round(q(n) x (pool - 1))

   The 1.15 exponent leans the first third of every tier toward the easy end of
   the band — a new tier is a new grid size and a new mechanic, so the first few
   levels should introduce it rather than test it — and then climbs to the top
   of the band by level 40. A straight linear quantile would spend levels 1-5 of
   Gridlock at effort 200+, which is the whole tier's difficulty arriving on the
   first tap.

   NEVER REGENERATE THIS WITH DIFFERENT PARAMETERS AND SHIP IT SILENTLY.
   The table is committed output. Re-running with a changed pool size, a changed
   ramp or a changed generator re-eases levels players have already cleared, and
   their stars stop meaning what they meant — the seeded-rng recipe's rule 4.
   If it must change, bump TABLE_VERSION and say so in the release note. */

const fs = require("fs");
const path = require("path");

const Board = require("../js/board.js");
const Solver = require("../js/solver.js");
const Generator = require("../js/generator.js");
const FPPar = require("../js/par.js");

const TABLE_VERSION = 1;
const LEVELS_PER_TIER = 40;
const POOL_TARGET = 400;      // certified candidates per tier before selection
const SEED_CAP = 60000;       // hard stop on the candidate search
const EASE = 1.15;

/* Tier keys and their generator tier index. Names live in js/meta-config.js;
   this file only needs the mapping. */
const TIERS = [
  { key: "clear", tier: 1 },
  { key: "light", tier: 2 },
  { key: "holding", tier: 3 },
  { key: "stacked", tier: 4 },
  { key: "gridlock", tier: 5 }
];

/* Every board ever accepted, keyed by its serialization, so a duplicate can
   never be selected twice — not within a tier and not across tiers. */
const seenBoards = new Set();

function buildPool(spec) {
  const pool = [];
  let seed = 1;
  let dupes = 0;
  while (pool.length < POOL_TARGET && seed <= SEED_CAP) {
    const res = Generator.generate(seed, spec.tier);
    seed++;
    if (!res.board) continue;

    const key = Board.key(res.board);
    if (seenBoards.has(key)) { dupes++; continue; }
    seenBoards.add(key);

    pool.push({
      seed: res.seed,
      effort: res.grade.effort,
      depth: res.grade.depth,
      arrows: res.grade.arrows,
      walls: res.grade.walls,
      key: key,
      par: FPPar.parMs(spec.key, res.grade)
    });
  }
  /* Sort by the solver's own effort; depth then seed break ties so the table is
     a pure function of the inputs. */
  pool.sort((a, b) => (a.effort - b.effort) || (a.depth - b.depth) || (a.seed - b.seed));
  return { pool, dupes, seedsTried: seed - 1 };
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

const report = [];
const table = {};

for (const spec of TIERS) {
  const t0 = Date.now();
  const { pool, dupes, seedsTried } = buildPool(spec);
  if (pool.length < LEVELS_PER_TIER) {
    console.error("FATAL: tier " + spec.key + " only certified " + pool.length + " boards");
    process.exit(1);
  }
  const chosen = selectRamp(pool);

  table[spec.key] = chosen.map((c) => [c.seed, Math.round(c.effort * 10) / 10, c.par]);

  report.push({
    key: spec.key,
    pool: pool.length,
    seedsTried,
    dupes,
    ms: Date.now() - t0,
    band: [pool[0].effort, pool[pool.length - 1].effort],
    at1: chosen[0],
    at20: chosen[19],
    at40: chosen[39]
  });

  console.log(
    spec.key.padEnd(9) +
    " pool " + String(pool.length).padStart(3) +
    " from " + String(seedsTried).padStart(5) + " seeds" +
    "  effort L1 " + chosen[0].effort.toFixed(1) +
    " / L20 " + chosen[19].effort.toFixed(1) +
    " / L40 " + chosen[39].effort.toFixed(1) +
    "   par " + FPPar.fmt(chosen[0].par) + " -> " + FPPar.fmt(chosen[39].par) +
    "   " + (Date.now() - t0) + "ms"
  );
}

/* --------------------------------------------------------------- emit ---- */

const lines = [];
lines.push('"use strict";');
lines.push("");
lines.push("/* GENERATED by scripts/build-levels.js — do not edit by hand.");
lines.push("");
lines.push("   200 levels: 5 tiers x 40, each [seed, effort, parMs].");
lines.push("");
lines.push("   · seed    the argument to FlightpathGenerator.generate(seed, tier). The board");
lines.push("             is rebuilt on device from this number, never shipped as data, and is");
lines.push("             identical everywhere because generation is deterministic.");
lines.push("   · effort  the solver's own composite difficulty for that board, measured at");
lines.push("             bake time. Levels are laid along an eased quantile ramp through a");
lines.push("             certified pool, so effort rises monotonically within every tier.");
lines.push("   · parMs   js/par.js, computed from the same grade. Forgiving by design, and");
lines.push("             it cannot cost a star — Flightpath scores mistakes and hints only.");
lines.push("");
lines.push("   COMMITTED OUTPUT. Re-baking with a different pool, ramp or generator changes");
lines.push("   levels players have already cleared. Bump the version if it ever must move. */");
lines.push("");
lines.push("(function (root, factory) {");
lines.push("  var api = factory();");
lines.push('  if (typeof module !== "undefined" && module.exports) module.exports = api;');
lines.push("  else root.FPLevels = api;");
lines.push('})(typeof globalThis !== "undefined" ? globalThis : this, function () {');
lines.push("");
lines.push("  var VERSION = " + TABLE_VERSION + ";");
lines.push("  var LEVELS_PER_TIER = " + LEVELS_PER_TIER + ";");
lines.push("");
lines.push("  /* Baked " + new Date().toISOString().slice(0, 10) +
           " — pool " + POOL_TARGET + " per tier, ramp exponent " + EASE + ". */");
lines.push("  var TABLE = {");
for (const spec of TIERS) {
  lines.push("    " + spec.key + ": [");
  const rows = table[spec.key];
  for (let i = 0; i < rows.length; i += 4) {
    const chunk = rows.slice(i, i + 4)
      .map((r) => "[" + r[0] + "," + r[1] + "," + r[2] + "]").join(", ");
    lines.push("      " + chunk + (i + 4 < rows.length ? "," : ""));
  }
  lines.push("    ]" + (spec.key === TIERS[TIERS.length - 1].key ? "" : ","));
}
lines.push("  };");
lines.push("");
lines.push("  function entry(tierKey, level) {");
lines.push("    var rows = TABLE[tierKey];");
lines.push("    if (!rows) return null;");
lines.push("    var r = rows[(level | 0) - 1];");
lines.push("    return r ? { seed: r[0], effort: r[1], par: r[2] } : null;");
lines.push("  }");
lines.push("");
lines.push("  function seedFor(tierKey, level) {");
lines.push("    var e = entry(tierKey, level);");
lines.push("    return e ? e.seed : 0;");
lines.push("  }");
lines.push("");
lines.push("  function parFor(tierKey, level) {");
lines.push("    var e = entry(tierKey, level);");
lines.push("    return e ? e.par : 0;");
lines.push("  }");
lines.push("");
lines.push("  return {");
lines.push("    VERSION: VERSION,");
lines.push("    LEVELS_PER_TIER: LEVELS_PER_TIER,");
lines.push("    TABLE: TABLE,");
lines.push("    entry: entry,");
lines.push("    seedFor: seedFor,");
lines.push("    parFor: parFor");
lines.push("  };");
lines.push("});");
lines.push("");

fs.writeFileSync(path.join(__dirname, "..", "js", "levels.js"), lines.join("\n"), "utf8");
console.log("\nwrote js/levels.js — " + (TIERS.length * LEVELS_PER_TIER) + " levels, " +
  seenBoards.size + " distinct boards certified across all pools");

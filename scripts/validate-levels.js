"use strict";

/* FLIGHTPATH — validate the baked level table.  node scripts/validate-levels.js

   Runs over EVERY level in the baked table, not a sample. A level table is shipped data: if one
   row rebuilds a board that no longer certifies, that level is unplayable on
   every device at once and nothing at runtime will tell you.

   What it proves, per level:
     1. the baked seed regenerates a board at all (no exhausted attempt budget)
     2. the board is structurally valid
     3. the solver certifies it clears with no deadlock, from scratch
     4. the board grades INSIDE the tier's exact band — the same gate the
        generator applied, re-run independently here
     5. the recorded effort matches what the solver measures now
     6. par is the value js/par.js computes for that graded board
   And across the whole table:
     7. no two levels produce an identical board (compared by key, not hash)
     8. effort rises monotonically within every tier — the ramp is real

   The tier list comes from the table's own ORDER, so a new tier is covered the
   moment it is baked; there is no list here to forget to extend. */

const Board = require("../js/board.js");
const Solver = require("../js/solver.js");
const Generator = require("../js/generator.js");
const FPPar = require("../js/par.js");
const FPLevels = require("../js/levels.js");

/* Derived from the baked table's own ORDER, so adding a tier needs no edit
   here and this gate can never quietly skip one. Display names are NOT read —
   they live only in js/meta-config.js, and a rename must not touch this file
   or its verdict. Tiers are identified by key, as they are everywhere data is
   persisted. */
const TIERS = FPLevels.ORDER.map((o) => ({ key: o.key, tier: o.tier }));

let pass = 0, fail = 0;
const failures = [];
function check(cond, msg) {
  if (cond) { pass++; return true; }
  fail++;
  if (failures.length < 20) failures.push(msg);
  return false;
}

const boards = new Map();          // board key -> "tier #n"
const ramp = {};

console.log("== FLIGHTPATH LEVEL TABLE ==================================================");
console.log("   table version " + FPLevels.VERSION + ", " +
  (TIERS.length * FPLevels.LEVELS_PER_TIER) + " levels\n");

for (const spec of TIERS) {
  const band = Generator.tierFor(spec.tier);
  const efforts = [];
  const runs = [];
  const pars = [];
  let worstAttempts = 0;

  for (let n = 1; n <= FPLevels.LEVELS_PER_TIER; n++) {
    const entry = FPLevels.entry(spec.key, n);
    const where = spec.key + " #" + n;

    if (!check(!!entry, where + ": no table row")) continue;

    const res = Generator.generate(entry.seed, spec.tier);
    if (!check(!!res.board, where + ": seed " + entry.seed + " did not generate")) continue;
    worstAttempts = Math.max(worstAttempts, res.attempts);

    check(Board.validate(res.board).ok, where + ": board failed validate()");

    /* Certified from scratch, knowing nothing about how it was built. */
    const solved = Solver.solve(res.board);
    check(solved.solved, where + ": solver could not clear it");
    check(solved.stuck.length === 0, where + ": " + solved.stuck.length + " arrows deadlock");

    const g = Solver.grade(res.board);
    const inBand = (v, b) => v >= b[0] && v <= b[1];
    check(inBand(g.arrows, band.arrows), where + ": arrows " + g.arrows + " outside " + band.arrows);
    check(inBand(g.walls, band.walls), where + ": walls " + g.walls + " outside " + band.walls);
    check(inBand(g.depth, band.depth), where + ": depth " + g.depth + " outside " + band.depth);
    check(inBand(g.effort, band.effort), where + ": effort " + g.effort + " outside " + band.effort);
    check(inBand(g.minRoundWidth, band.minRoundWidth),
      where + ": minRoundWidth " + g.minRoundWidth + " outside " + band.minRoundWidth);
    /* Only tiers 6+ declare forcedRun — the longest stretch of consecutive
       rounds offering exactly ONE legal tap. It is what makes the top two
       tiers harder on a grid that cannot grow, so it is gated, not decorative.
       Tiers 1-5 have no such band and are unaffected. */
    if (band.forcedRun) {
      var run = Generator.longestForcedRun(g);
      check(inBand(run, band.forcedRun),
        where + ": forcedRun " + run + " outside " + band.forcedRun);
      runs.push(run);
    }
    check(res.board.w === band.w && res.board.h === band.h,
      where + ": grid " + res.board.w + "x" + res.board.h + " != " + band.w + "x" + band.h);

    /* The packed effort decodes back to what the solver measures now. This is
       the check that catches a mis-packed delta chain: an error anywhere in the
       string shifts every level after it. */
    check(Math.abs(g.effort - entry.effort) < 0.06,
      where + ": packed effort " + entry.effort + " != measured " + g.effort);

    /* Par is no longer stored per level — it is computed from this grade, so
       what is verified is that the live computation gives a sane, forgiving
       number for the board that was actually built. */
    const par = FPPar.parForGrade(spec.key, g);
    check(par > 0 && par < 15 * 60000, where + ": par " + par + " out of range");
    pars.push(par);

    const key = Board.key(res.board);
    if (boards.has(key)) check(false, where + ": IDENTICAL board to " + boards.get(key));
    else { boards.set(key, where); pass++; }

    efforts.push(g.effort);
  }

  /* The ramp: monotone non-decreasing within the tier. */
  let dips = 0;
  for (let i = 1; i < efforts.length; i++) if (efforts[i] < efforts[i - 1]) dips++;
  check(dips === 0, spec.key + ": effort dips " + dips + " times inside the tier");

  ramp[spec.key] = efforts;
  const at = (n) => efforts[n - 1].toFixed(1).padStart(6);
  const distinct = new Set(efforts.map((e) => Math.round(e * 10))).size;
  console.log(
    (spec.key + " (t" + spec.tier + ")").padEnd(16) +
    " L1" + at(1) + "  L100" + at(100) + "  L250" + at(250) +
    "  L400" + at(400) + "  L500" + at(500) +
    "  band " + band.effort[0] + "-" + band.effort[1] +
    "  distinct " + String(distinct).padStart(3) +
    "  par " + FPPar.fmt(Math.min.apply(null, pars)) + "-" + FPPar.fmt(Math.max.apply(null, pars)) +
    "  worst " + String(worstAttempts).padStart(4) + " att" +
    (runs.length ? "  run " + Math.min.apply(null, runs) + "-" + Math.max.apply(null, runs) : "")
  );
}

console.log("\ndistinct boards: " + boards.size + " of " + (TIERS.length * FPLevels.LEVELS_PER_TIER));
console.log("checks run: " + (pass + fail) + "   passed: " + pass + "   failed: " + fail);
if (failures.length) {
  console.log("\nfirst failures:");
  failures.forEach((f) => console.log("  " + f));
}
console.log(fail ? "RESULT: RED" : "RESULT: GREEN — every baked level regenerates, certifies and is unique.");
process.exit(fail ? 1 : 0);

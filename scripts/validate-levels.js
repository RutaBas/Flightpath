"use strict";

/* FLIGHTPATH — validate the baked level table.  node scripts/validate-levels.js

   Runs over ALL 200 levels, not a sample. A level table is shipped data: if one
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
     8. effort rises monotonically within every tier — the ramp is real */

const Board = require("../js/board.js");
const Solver = require("../js/solver.js");
const Generator = require("../js/generator.js");
const FPPar = require("../js/par.js");
const FPLevels = require("../js/levels.js");

const TIERS = [
  { key: "clear", tier: 1, name: "Clear Skies" },
  { key: "light", tier: 2, name: "Light Traffic" },
  { key: "holding", tier: 3, name: "Holding" },
  { key: "stacked", tier: 4, name: "Stacked" },
  { key: "gridlock", tier: 5, name: "Gridlock" }
];

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
    check(res.board.w === band.w && res.board.h === band.h,
      where + ": grid " + res.board.w + "x" + res.board.h + " != " + band.w + "x" + band.h);

    check(Math.abs(g.effort - entry.effort) < 0.06,
      where + ": baked effort " + entry.effort + " != measured " + g.effort);
    check(entry.par === FPPar.parMs(spec.key, g),
      where + ": baked par " + entry.par + " != " + FPPar.parMs(spec.key, g));
    check(entry.par > 0 && entry.par < 15 * 60000, where + ": par out of range");

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
  console.log(
    spec.name.padEnd(14) +
    " L1 " + efforts[0].toFixed(1).padStart(6) +
    "   L20 " + efforts[19].toFixed(1).padStart(6) +
    "   L40 " + efforts[39].toFixed(1).padStart(6) +
    "   band " + band.effort[0] + "-" + band.effort[1] +
    "   par " + FPPar.fmt(FPLevels.parFor(spec.key, 1)) + " → " + FPPar.fmt(FPLevels.parFor(spec.key, 40)) +
    "   worst rebuild " + worstAttempts + " attempt" + (worstAttempts === 1 ? "" : "s")
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

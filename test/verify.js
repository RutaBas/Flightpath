"use strict";
/* FLIGHTPATH — independent verification harness.

   ADVERSARIAL GATE. Written top to bottom without importing anything from
   test/logic.test.js or test/lib/*. Every oracle in this file (board decoding,
   ray scanning, freeness, greedy closure, exhaustive state-space search,
   grading, RNG) is re-implemented here from SPEC.md so that a shared bug
   cannot hide in both the shipped code and its test.

   The only things imported from js/ are the artefacts under audit:
     board.js      serialize/deserialize/clone (the thing being checked)
     solver.js     isFree/freeSet/solve/grade/hint (the thing being checked)
     generator.js  generate/sweep/TIERS       (the thing being checked)

   Run:  node games/flightpath/test/verify.js
   Exit: 0 only if every check is PASS. */

var path = require("path");
var fs = require("fs");
var child = require("child_process");

var JS = path.join(__dirname, "..", "js");
var Board = require(path.join(JS, "board.js"));
var Solver = require(path.join(JS, "solver.js"));
var Generator = require(path.join(JS, "generator.js"));

/* =====================================================================
   0. HARNESS PLUMBING
   ===================================================================== */

var results = [];
var failures = [];

function check(name, ok, detail) {
  results.push({ name: name, ok: !!ok, detail: detail || "" });
  if (!ok) failures.push(name + " :: " + (detail || ""));
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  |  " + detail : ""));
}
function note(msg) { console.log("      " + msg); }
var currentSection = "?";
function section(title) {
  currentSection = title;
  console.log("");
  console.log("== " + title + " " + new Array(Math.max(2, 74 - title.length)).join("="));
}
/* Each section runs inside part(): a section that THROWS becomes a recorded
   FAIL and the rest of the harness still runs, so a broken build produces a
   full report instead of a stack trace three checks in. */
function part(fn) {
  var where = currentSection;
  try { fn(); }
  catch (e) {
    check("[" + where + "] threw before finishing", false,
      (e && e.message ? e.message : String(e)) +
      " @ " + ((e && e.stack ? e.stack.split("\n")[1] : "").trim()));
  }
}

/* My own seeded RNG — splitmix32. Deliberately NOT js/rng.js (mulberry32 +
   FNV-1a), so harness sampling cannot correlate with generator sampling. */
function myRng(seedStr) {
  var s = 0x9e3779b9 >>> 0;
  var str = String(seedStr);
  for (var i = 0; i < str.length; i++) {
    s = (s ^ str.charCodeAt(i)) >>> 0;
    s = Math.imul(s, 0x85ebca6b) >>> 0;
    s = (s ^ (s >>> 13)) >>> 0;
  }
  return function () {
    s = (s + 0x9e3779b9) | 0;
    var z = s >>> 0;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return ((z ^ (z >>> 15)) >>> 0) / 4294967296;
  };
}
function ri(rand, n) { return Math.min(n - 1, Math.floor(rand() * n)); }
function pick(rand, arr) { return arr[ri(rand, arr.length)]; }

function median(a) {
  var s = a.slice().sort(function (x, y) { return x - y; });
  var n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function mn(a) { return a.reduce(function (p, c) { return c < p ? c : p; }, Infinity); }
function mx(a) { return a.reduce(function (p, c) { return c > p ? c : p; }, -Infinity); }
function f1(x) { return Math.round(x * 10) / 10; }

/* =====================================================================
   1. MY MODEL — independent decoding, geometry and logic
   =====================================================================

   Representation: { w, h, g } where g is a plain Array of single characters
   in row-major order, one of:
       "."  sky            "-"  masked open
       "#"  wall           "N"/"E"/"S"/"W"  arrow

   Nothing here shares a line with js/board.js or js/solver.js. Coordinates are
   handled as (x, y) pairs and stepped one cell at a time; y grows downward. */

var MY_DIRS = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
var MY_ARROWS = "NESW";

/* My own parser for the FP1 wire format, written from the SPEC's description
   of the encoding rather than from board.js's deserialize(). Throws on
   anything it does not recognise. */
function myDecode(str) {
  if (typeof str !== "string") throw new Error("myDecode: not a string");
  var semi1 = str.indexOf(";");
  if (semi1 < 0) throw new Error("myDecode: no separator");
  if (str.slice(0, semi1) !== "FP1") throw new Error("myDecode: bad magic");
  var rest = str.slice(semi1 + 1).split(";");
  if (rest.length !== 3) throw new Error("myDecode: wrong field count");
  var w = Number(rest[0]), h = Number(rest[1]), body = rest[2];
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    throw new Error("myDecode: bad dims");
  }
  if (body.length !== w * h) throw new Error("myDecode: body length mismatch");
  var g = new Array(w * h);
  for (var i = 0; i < body.length; i++) {
    var c = body[i];
    if (".-#".indexOf(c) < 0 && MY_ARROWS.indexOf(c) < 0) {
      throw new Error("myDecode: bad char " + c);
    }
    g[i] = c;
  }
  return { w: w, h: h, g: g };
}
function myEncode(m) { return "FP1;" + m.w + ";" + m.h + ";" + m.g.join(""); }
function myBody(m) { return m.g.join(""); }
function myClone(m) { return { w: m.w, h: m.h, g: m.g.slice() }; }

/* Bridge: take the board object under audit, ask IT to serialize, then decode
   with MY parser. Every downstream oracle therefore runs on my own decoding of
   the shipped encoding, not on the shipped in-memory arrays. */
function fromBoard(b) { return myDecode(Board.serialize(b)); }

function myIsArrow(c) { return MY_ARROWS.indexOf(c) >= 0; }
function myArrowCells(m) {
  var out = [];
  for (var i = 0; i < m.g.length; i++) if (myIsArrow(m.g[i])) out.push(i);
  return out;
}
function myArrowCount(m) { return myArrowCells(m).length; }
function myWallCount(m) {
  var n = 0;
  for (var i = 0; i < m.g.length; i++) if (m.g[i] === "#") n++;
  return n;
}

/* My ray scan, walked in (x, y). Returns the list of traversed cells and the
   first blocker (an arrow or a wall) or -1. Sky never blocks. */
function myRay(m, i) {
  var c = m.g[i];
  if (!myIsArrow(c)) return { cells: [], blocker: -1 };
  var step = MY_DIRS[c];
  var x = i % m.w;
  var y = Math.floor(i / m.w);
  var cells = [];
  var blocker = -1;
  for (;;) {
    x = x + step[0];
    y = y + step[1];
    if (x < 0 || y < 0 || x > m.w - 1 || y > m.h - 1) break;
    var j = y * m.w + x;
    cells.push(j);
    var v = m.g[j];
    if (blocker < 0 && (v === "#" || myIsArrow(v))) blocker = j;
  }
  return { cells: cells, blocker: blocker };
}
function myFree(m, i) {
  if (!myIsArrow(m.g[i])) return false;
  return myRay(m, i).blocker < 0;
}
function myFreeSet(m) {
  var out = [];
  for (var i = 0; i < m.g.length; i++) if (myFree(m, i)) out.push(i);
  return out;
}
/* Geometric distance to the edge — how many cells the ray covers. */
function myRayLen(m, i) {
  var c = m.g[i];
  if (!myIsArrow(c)) return 0;
  var x = i % m.w, y = Math.floor(i / m.w);
  if (c === "N") return y;
  if (c === "S") return m.h - 1 - y;
  if (c === "W") return x;
  return m.w - 1 - x;
}

/* My greedy closure, written independently: repeatedly lift the whole free
   set. Returns rounds, terminal model and solvability. */
function myClosure(m) {
  var work = myClone(m);
  var rounds = [];
  for (;;) {
    var free = myFreeSet(work);
    if (!free.length) break;
    rounds.push(free.slice());
    for (var k = 0; k < free.length; k++) work.g[free[k]] = "-";
    if (rounds.length > m.g.length + 4) throw new Error("closure did not terminate");
  }
  return {
    rounds: rounds,
    depth: rounds.length,
    terminal: work,
    terminalBody: myBody(work),
    solved: myArrowCount(work) === 0,
    remaining: myArrowCount(work)
  };
}

/* myForcedRun(widths) — the longest streak of CONSECUTIVE width-1 rounds.

   SPEC.md: "the longest streak of consecutive width-1 rounds, where only one
   arrow on the whole board is legal". Written from that sentence; the shipped
   generator.longestForcedRun() is NEVER called by this harness, it is only
   ever compared against. Deliberately a different shape of loop (scan for the
   start of a run, then count it) so a shared off-by-one is unlikely. */
function myForcedRun(widths) {
  var best = 0;
  var i = 0;
  while (i < widths.length) {
    if (widths[i] !== 1) { i++; continue; }
    var j = i;
    while (j < widths.length && widths[j] === 1) j++;
    if (j - i > best) best = j - i;
    i = j;
  }
  return best;
}

/* My grade, transcribed from SPEC.md's effort formula, not from solver.js. */
function myGrade(m) {
  var cl = myClosure(m);
  var arrows = myArrowCells(m);
  var n = arrows.length;
  var rayTotal = 0, maxRay = 0;
  for (var a = 0; a < n; a++) {
    var L = myRayLen(m, arrows[a]);
    rayTotal += L;
    if (L > maxRay) maxRay = L;
  }
  var meanRay = n ? rayTotal / n : 0;
  var startFree = myFreeSet(m).length;
  var trap = n ? (n - startFree) / n : 0;
  var minW = 0;
  for (var r = 0; r < cl.rounds.length; r++) {
    var wid = cl.rounds[r].length;
    if (minW === 0 || wid < minW) minW = wid;
  }
  var bottleneck = minW > 0 ? 1 / minW : 0;
  var effort = 10 * cl.depth + 18 * bottleneck + 25 * trap + 2 * meanRay + 0.6 * n;
  var widths = [];
  for (var rw = 0; rw < cl.rounds.length; rw++) widths.push(cl.rounds[rw].length);
  return {
    arrows: n,
    walls: myWallCount(m),
    depth: cl.depth,
    minRoundWidth: minW,
    roundWidths: widths,
    forcedRun: myForcedRun(widths),
    trapFraction: trap,
    meanRay: meanRay,
    maxRay: maxRay,
    effort: Math.round(effort * 10) / 10,
    solved: cl.solved,
    stuckCount: cl.remaining
  };
}

/* My exhaustive state-space oracle. DFS over EVERY legal single tap in EVERY
   order, memoised on the body string. Answers three separate questions:
     solvable       does some maximal play empty the board?
     terminalCount  how many distinct dead-end states exist?
     terminals      the dead-end bodies themselves.
   Move generation goes through myRay, so it shares nothing with solver.js. */
function myExhaustive(m, cap) {
  var limit = cap === undefined ? 300000 : cap;
  var memo = new Map();
  var terminals = new Set();
  var states = 0;
  var truncated = false;

  function rec(model) {
    var k = myBody(model);
    if (memo.has(k)) return memo.get(k);
    if (states >= limit) { truncated = true; return false; }
    states++;
    var moves = myFreeSet(model);
    var solvable;
    if (!moves.length) {
      terminals.add(k);
      solvable = myArrowCount(model) === 0;
    } else {
      solvable = false;
      for (var i = 0; i < moves.length; i++) {
        var next = myClone(model);
        next.g[moves[i]] = "-";
        if (rec(next)) solvable = true;
        if (truncated) break;
      }
    }
    memo.set(k, solvable);
    return solvable;
  }

  var solvable = rec(myClone(m));
  return {
    solvable: solvable,
    states: states,
    terminalCount: terminals.size,
    terminals: Array.from(terminals),
    truncated: truncated
  };
}

/* Randomized legal play under my own rules: tap a uniformly random free arrow
   until nothing is free. */
function myRandomPlay(m, rand) {
  var work = myClone(m);
  var taps = 0;
  for (;;) {
    var free = myFreeSet(work);
    if (!free.length) break;
    var p = free[ri(rand, free.length)];
    work.g[p] = "-";
    taps++;
    if (taps > m.g.length + 4) throw new Error("random play did not terminate");
  }
  return { cleared: myArrowCount(work) === 0, remaining: myArrowCount(work), taps: taps, terminalBody: myBody(work) };
}

/* Build a Board object from my model, so I can feed my own random boards to
   the code under audit without going through the generator. */
function toBoard(m) {
  var b = Board.createBoard(m.w, m.h, {});
  for (var i = 0; i < m.g.length; i++) {
    var c = m.g[i];
    if (c === ".") { b.mask[i] = 0; b.cells[i] = Board.OPEN; continue; }
    b.mask[i] = 1;
    if (c === "-") { b.cells[i] = Board.OPEN; }
    else if (c === "#") { b.cells[i] = Board.WALL; }
    else { b.cells[i] = MY_ARROWS.indexOf(c); }
  }
  return b;
}

/* Random board of my own making. Mostly unsolvable by design — that is the
   point: the solver has to be right about boards nobody curated. */
function randomModel(rand, opts) {
  var o = opts || {};
  var w = o.w || 3 + ri(rand, 5);          /* 3..7 */
  var h = o.h || 3 + ri(rand, 7);          /* 3..9 */
  var skyP = o.skyP === undefined ? 0.12 * rand() : o.skyP;
  var wallP = o.wallP === undefined ? 0.15 * rand() : o.wallP;
  var arrowP = o.arrowP === undefined ? 0.2 + 0.65 * rand() : o.arrowP;
  var g = new Array(w * h);
  var arrows = 0;
  for (var i = 0; i < w * h; i++) {
    if (rand() < skyP) { g[i] = "."; continue; }
    if (rand() < wallP) { g[i] = "#"; continue; }
    if (rand() < arrowP && (o.maxArrows === undefined || arrows < o.maxArrows)) {
      g[i] = MY_ARROWS[ri(rand, 4)];
      arrows++;
      continue;
    }
    g[i] = "-";
  }
  return { w: w, h: h, g: g };
}

/* ------------------------------------------------------------- THE CONTRACT

   SPEC.md's tier table plus the gated bands, transcribed HERE BY HAND so the
   generator's own TIERS constant is checked against the contract rather than
   against itself. If someone widens a band in js/generator.js, check 0a goes
   red — the harness does not read the band it is meant to be policing.

   Sources, all authoritative and read directly:
     grid / arrows / walls / depth   SPEC.md tier table (lines 93-101)
     minRoundWidth                   SPEC.md: tier 4 "gated to 1-2"; tiers 6-7
                                     pinned at 1 (SPEC.md "minRoundWidth is
                                     useless as a discriminator up here")
     effort                          SPEC.md: "[190,285] / [286,352] /
                                     [353,520]" for T5/T6/T7; T1-T4 from the
                                     generator's measured windows
     forcedRun                       SPEC.md: opt-in, "absent from tiers 1-5";
                                     T6 [10,99], T7 [16,99]

   forcedRun: null means the tier MUST NOT declare the band at all — that is
   the "tiers 1-5 are provably unchanged" claim, asserted rather than assumed. */
var CONTRACT = [
  { tier: 1, w: 4, h: 5, arrows: [10, 14], walls: [0, 0], depth: [3, 4],
    minRoundWidth: [1, 99], effort: [52, 92], forcedRun: null },
  { tier: 2, w: 5, h: 6, arrows: [16, 22], walls: [0, 0], depth: [4, 6],
    minRoundWidth: [1, 99], effort: [72, 118], forcedRun: null },
  { tier: 3, w: 6, h: 7, arrows: [24, 32], walls: [0, 2], depth: [6, 9],
    minRoundWidth: [1, 99], effort: [100, 156], forcedRun: null },
  { tier: 4, w: 6, h: 8, arrows: [32, 42], walls: [2, 4], depth: [9, 13],
    minRoundWidth: [1, 2], effort: [140, 200], forcedRun: null },
  { tier: 5, w: 7, h: 9, arrows: [44, 58], walls: [3, 6], depth: [13, 26],
    minRoundWidth: [1, 99], effort: [190, 285], forcedRun: null },
  { tier: 6, w: 7, h: 9, arrows: [42, 56], walls: [3, 6], depth: [21, 28],
    minRoundWidth: [1, 1], effort: [286, 352], forcedRun: [10, 99] },
  { tier: 7, w: 7, h: 9, arrows: [42, 58], walls: [1, 4], depth: [29, 46],
    minRoundWidth: [1, 1], effort: [353, 520], forcedRun: [16, 99] }
];
var NT = CONTRACT.length;          /* 7 — every loop below is driven by this */
var NEW_TIERS = [6, 7];

/* Golden numbers captured from the LAST GREEN RUN of this harness, taken
   before tiers 6 and 7 existed, over seeds 1..150. SPEC.md claims tiers 1-5
   are "provably unchanged" by the tier 6/7 work; these frozen values are how
   that claim is actually tested, rather than by re-reading the new code and
   agreeing with it. Any drift in the tier 1-5 sampler moves one of these. */
var GOLDEN_1_TO_5 = [
  { tier: 1, effort: [56.2, 73.6, 85.9], depth: [3, 4], arrows: [10, 14], walls: [0, 0] },
  { tier: 2, effort: [75.7, 96.6, 111.3], depth: [4, 6], arrows: [16, 22], walls: [0, 0] },
  { tier: 3, effort: [107.8, 123.3, 148.9], depth: [6, 9], arrows: [24, 32], walls: [0, 2] },
  { tier: 4, effort: [142, 165.5, 191.4], depth: [9, 13], arrows: [32, 41], walls: [2, 4] },
  { tier: 5, effort: [193.4, 211.2, 260.3], depth: [13, 19], arrows: [44, 54], walls: [3, 6] }
];

/* Sampling budget, stated up front. Tier 7 accepts ~1.7% of candidates, so it
   is ~20 ms per board against ~0.2 ms for tier 1; the counts below are the
   SAME for every tier (no silent thinning) and the wall clock is reported at
   the end so any future thinning is visible. */
var SEEDS_SOUNDNESS = 40, SEEDS_PLAY = 12, SEEDS_UNGATED = 40,
    SEEDS_STATS = 150, SEEDS_DETERMINISM = 20, SEEDS_VARIETY = 300,
    SEEDS_HINT = 20, SEEDS_SERIAL = 30;

var T_START = Date.now();

console.log("FLIGHTPATH — independent verification harness");
console.log("node " + process.version + "   " + new Date().toISOString());
console.log("boards under audit come from js/generator.js; every oracle below is written in this file.");
console.log("tiers under audit: 1.." + NT + " (tiers " + NEW_TIERS.join(" and ") +
  " are new; every check below runs over ALL " + NT + ", no tier is skipped).");
console.log("seeds per tier: soundness " + SEEDS_SOUNDNESS + ", play " + SEEDS_PLAY +
  ", ungated " + SEEDS_UNGATED + ", stats " + SEEDS_STATS + ", determinism " +
  SEEDS_DETERMINISM + ", variety " + SEEDS_VARIETY + ", hint " + SEEDS_HINT +
  ", serialization " + SEEDS_SERIAL + " — identical for every tier.");

/* =====================================================================
   CHECK 0 — THE BANDS THEMSELVES
   ===================================================================== */
section("0. THE CONTRACT — the shipped bands are the ones SPEC.md declares");

part(function () {
  var T = Generator.TIERS;
  var bad = [];
  if (T.length !== NT) bad.push("TIERS.length " + T.length + " != " + NT);
  for (var i = 0; i < Math.min(T.length, NT); i++) {
    var c = CONTRACT[i], s = T[i];
    function band(name) {
      var a = c[name], b = s[name];
      if (!a) return;
      if (!b || b[0] !== a[0] || b[1] !== a[1]) {
        bad.push("T" + c.tier + "." + name + " shipped " + JSON.stringify(b) +
          " != contract " + JSON.stringify(a));
      }
    }
    if (s.tier !== c.tier) bad.push("T" + c.tier + " tier field " + s.tier);
    if (s.w !== c.w || s.h !== c.h) {
      bad.push("T" + c.tier + " grid " + s.w + "x" + s.h + " != " + c.w + "x" + c.h);
    }
    if (s.w > 7) bad.push("T" + c.tier + " grid width " + s.w + " breaks the 7-column tap floor");
    band("arrows"); band("walls"); band("depth"); band("minRoundWidth"); band("effort");
    if (c.forcedRun === null) {
      if (s.forcedRun !== undefined) {
        bad.push("T" + c.tier + " declares forcedRun " + JSON.stringify(s.forcedRun) +
          " but the contract says tiers 1-5 must NOT be gated on it");
      }
    } else {
      band("forcedRun");
    }
  }
  for (var t = 1; t <= NT; t++) {
    try { Generator.tierFor(t); } catch (e) { bad.push("tierFor(" + t + ") threw: " + e.message); }
  }
  var threwOnUnknown = false;
  try { Generator.tierFor(NT + 1); } catch (e) { threwOnUnknown = true; }
  if (!threwOnUnknown) bad.push("tierFor(" + (NT + 1) + ") did not throw");

  note("tiers shipped: " + T.length + "; grids " + T.map(function (x) { return x.w + "x" + x.h; }).join(" "));
  note("forcedRun declared on: " + T.filter(function (x) { return x.forcedRun; })
    .map(function (x) { return "T" + x.tier + JSON.stringify(x.forcedRun); }).join(" ") +
    "   (absent on T1-T5, as the contract requires)");
  if (bad.length) note("CONTRACT BREACHES: " + JSON.stringify(bad.slice(0, 6)));
  check("0a shipped TIERS match the hand-transcribed contract band for band",
    bad.length === 0, (NT * 7) + " band comparisons, " + bad.length + " breaches");
});

/* =====================================================================
   CHECK 1 — SOUNDNESS AGAINST GROUND TRUTH
   ===================================================================== */
section("1. SOUNDNESS — isFree never claims a blocked arrow is launchable");

part(function () {
  var rand = myRng("flightpath|verify|soundness|v1");
  var boards = [];

  /* 3000 random boards of my own construction... */
  for (var s = 0; s < 3000; s++) boards.push(randomModel(rand));
  /* ...plus every generated board across all five tiers. */
  var genCount = 0;
  for (var t = 1; t <= NT; t++) {
    for (var seed = 1; seed <= SEEDS_SOUNDNESS; seed++) {
      var r = Generator.generate(seed, t);
      if (r.board) { boards.push(fromBoard(r.board)); genCount++; }
    }
  }

  var disagreements = 0;    /* isFree vs my scanner, either direction */
  var unsoundClaims = 0;    /* the fatal kind: claimed free, actually blocked */
  var deductions = 0;       /* every free/blocked verdict compared */
  var freeClaims = 0;       /* every "this arrow is launchable" claim */
  var states = 0;           /* board positions examined, incl. mid-solve */
  var violations = [];
  var rayMismatch = 0;
  var truthModeViolations = 0;
  var truthModeBoards = 0;

  for (var bi = 0; bi < boards.length; bi++) {
    var model = boards[bi];
    var board = toBoard(model);

    /* checkAgainstTruth mode with the known answer supplied by MY closure. */
    var mine = myClosure(model);
    var ct = Solver.checkAgainstTruth(board, { solvable: mine.solved });
    truthModeBoards++;
    if (!ct.sound) {
      truthModeViolations += ct.violations.length;
      if (violations.length < 5) {
        violations.push({ kind: "checkAgainstTruth", key: myEncode(model), v: ct.violations });
      }
    }

    /* Walk the board through its whole solve, one round at a time, and at
       EVERY intermediate state compare the shipped isFree against my scanner
       for every single cell. */
    var work = myClone(model);
    var liveBoard = Board.clone(board);
    for (;;) {
      states++;
      var free = [];
      for (var i = 0; i < work.g.length; i++) {
        var theirs = Solver.isFree(liveBoard, i);
        var truth = myFree(work, i);
        deductions++;
        if (theirs) freeClaims++;
        if (theirs !== truth) {
          disagreements++;
          if (theirs && !truth) unsoundClaims++;
          if (violations.length < 5) {
            violations.push({
              kind: theirs ? "UNSOUND: claimed-free-but-blocked" : "missed-free-arrow",
              key: myEncode(work), idx: i
            });
          }
        }
        /* rayCells geometry must match my walk too */
        if (myIsArrow(work.g[i])) {
          var theirRay = Solver.rayCells(liveBoard, i).join(",");
          var myR = myRay(work, i).cells.join(",");
          if (theirRay !== myR) rayMismatch++;
        }
        if (truth) free.push(i);
      }
      if (!free.length) break;
      for (var k = 0; k < free.length; k++) {
        work.g[free[k]] = "-";
        liveBoard.cells[free[k]] = Board.OPEN;
      }
    }
  }

  note("boards scanned: " + boards.length + " (" + (boards.length - genCount) +
    " random + " + genCount + " generated)");
  note("board states examined incl. mid-solve: " + states);
  note("freeness deductions compared against my scanner: " + deductions);
  note("  of which 'this arrow is launchable' claims: " + freeClaims);
  note("rayCells geometry comparisons mismatching: " + rayMismatch);
  note("checkAgainstTruth boards: " + truthModeBoards + ", violations reported: " + truthModeViolations);
  note("disagreements with my scanner: " + disagreements +
    " (of which UNSOUND 'claimed free but blocked': " + unsoundClaims + ")");
  if (violations.length) note("FIRST VIOLATIONS: " + JSON.stringify(violations.slice(0, 3)));

  check("1a isFree agrees with independent scanner on every deduction",
    disagreements === 0,
    deductions + " deductions, " + freeClaims + " free-claims, " + disagreements +
    " disagreements, " + unsoundClaims + " unsound claims");
  check("1b rayCells geometry matches an independent (x,y) walk",
    rayMismatch === 0, rayMismatch + " mismatches");
  check("1c solve(checkAgainstTruth) reports zero violations over all boards",
    truthModeViolations === 0, truthModeBoards + " boards in ground-truth mode");
});

/* =====================================================================
   CHECK 2 — THE NO-BRICK GUARANTEE
   ===================================================================== */
section("2. NO-BRICK — monotone removal, confluence, one terminal state");

part(function () {
  var rand = myRng("flightpath|verify|confluence|v1");

  /* --- 2a exhaustive state-space search vs the fast solver -------------- */
  var N_SMALL = 500;
  var solvableAgree = 0, verdictMismatch = 0, terminalMismatch = 0;
  var nonConfluent = 0, truncated = 0;
  var totalStates = 0, solvableCount = 0, unsolvableCount = 0;
  var worstStates = 0;
  var firstBad = null;

  for (var s = 0; s < N_SMALL; s++) {
    var m = randomModel(rand, {
      w: 3 + ri(rand, 2), h: 3 + ri(rand, 3),
      arrowP: 0.35 + 0.5 * rand(), wallP: 0.1 * rand(), skyP: 0.12 * rand(),
      maxArrows: 10
    });
    var ex = myExhaustive(m, 200000);
    if (ex.truncated) { truncated++; continue; }
    totalStates += ex.states;
    if (ex.states > worstStates) worstStates = ex.states;

    var board = toBoard(m);
    var res = Solver.solve(board);
    if (res.solved) solvableCount++; else unsolvableCount++;

    if (ex.solvable !== res.solved) {
      verdictMismatch++;
      if (!firstBad) firstBad = { key: myEncode(m), exhaustive: ex.solvable, solver: res.solved };
    } else solvableAgree++;

    if (ex.terminalCount !== 1) {
      nonConfluent++;
      if (!firstBad) firstBad = { key: myEncode(m), terminals: ex.terminals.slice(0, 3) };
    }
    /* the single terminal state must be exactly the one the closure lands on */
    var solverTerminal = Board.serialize(res.terminal).split(";")[3];
    if (ex.terminals.indexOf(solverTerminal) < 0) {
      terminalMismatch++;
      if (!firstBad) firstBad = { key: myEncode(m), solverTerminal: solverTerminal, oracle: ex.terminals };
    }
  }

  note("small boards searched exhaustively: " + (N_SMALL - truncated) +
    " (truncated/skipped: " + truncated + ")");
  note("states expanded by the oracle: " + totalStates + " (worst single board: " + worstStates + ")");
  note("oracle verdicts: solvable " + solvableCount + " / unsolvable " + unsolvableCount +
    "  — a mix, so agreement is not vacuous");
  if (firstBad) note("FIRST DISAGREEMENT: " + JSON.stringify(firstBad));

  check("2a exhaustive search agrees with the greedy closure on solvability",
    verdictMismatch === 0, solvableAgree + " boards agreed, " + verdictMismatch + " mismatched");
  check("2b every board has exactly ONE terminal state (confluence)",
    nonConfluent === 0, (N_SMALL - truncated) + " boards, " + nonConfluent + " with >1 terminal");
  check("2c closure's terminal state IS that unique terminal",
    terminalMismatch === 0, terminalMismatch + " mismatches");

  /* --- 2d hammer certified boards with long randomized legal play ------- */
  var PLAY_ORDERS = 24;
  var plays = 0, playFails = 0, distinctTerminals = 0, taps = 0;
  var certified = [];
  for (var t = 1; t <= NT; t++) {
    for (var seed = 1; seed <= SEEDS_PLAY; seed++) {
      var r = Generator.generate(seed, t);
      if (r.board) certified.push({ tier: t, seed: seed, m: fromBoard(r.board) });
    }
  }
  var playBad = null;
  for (var ci = 0; ci < certified.length; ci++) {
    var cm = certified[ci].m;
    var termSet = new Set();
    for (var p = 0; p < PLAY_ORDERS; p++) {
      var play = myRandomPlay(cm, rand);
      plays++;
      taps += play.taps;
      termSet.add(play.terminalBody);
      if (!play.cleared) {
        playFails++;
        if (!playBad) playBad = { tier: certified[ci].tier, seed: certified[ci].seed, remaining: play.remaining };
      }
    }
    if (termSet.size !== 1) distinctTerminals++;
  }
  note("certified boards hammered: " + certified.length + " x " + PLAY_ORDERS +
    " random legal orders = " + plays + " playthroughs, " + taps + " taps");
  if (playBad) note("FIRST BRICKED PLAY: " + JSON.stringify(playBad));
  check("2d randomized legal play always clears a certified board",
    playFails === 0, plays + " playthroughs, " + playFails + " left arrows behind");
  check("2e every play order on a certified board reaches the same terminal",
    distinctTerminals === 0, certified.length + " boards, " + distinctTerminals + " with >1 terminal");

  /* --- 2f deliberately unsolvable fixtures ----------------------------- */
  var FIXTURES = [
    { name: "two arrows facing each other", s: "FP1;3;1;E-W", solvable: false },
    { name: "arrow pointing into a wall", s: "FP1;3;1;E-#", solvable: false },
    { name: "4-cycle of arrows around a square", s: "FP1;2;2;ESWN", solvable: false },
    { name: "arrow behind a wall column, both dirs blocked", s: "FP1;3;3;#E#---#-#", solvable: false },
    { name: "mutual block N/S", s: "FP1;1;3;S-N", solvable: false },
    { name: "long-range facing pair across sky", s: "FP1;5;1;E..-W", solvable: false },
    { name: "chain of 4, clears in 4 rounds", s: "FP1;5;1;EEEE-", solvable: true },
    { name: "single edge arrow pointing out", s: "FP1;2;1;-E", solvable: true },
    { name: "arrow flying over sky", s: "FP1;4;1;E..-", solvable: true },
    { name: "arrow flying over a wall is blocked", s: "FP1;4;1;E-#-", solvable: false }
  ];
  var fixBad = [];
  for (var fi = 0; fi < FIXTURES.length; fi++) {
    var fx = FIXTURES[fi];
    var fm = myDecode(fx.s);
    var fex = myExhaustive(fm);
    var fres = Solver.solve(toBoard(fm));
    var ok = fex.solvable === fx.solvable && fres.solved === fx.solvable &&
      fex.terminalCount === 1;
    if (!ok) {
      fixBad.push(fx.name + " expected solvable=" + fx.solvable +
        " oracle=" + fex.solvable + " solver=" + fres.solved + " terminals=" + fex.terminalCount);
    }
    /* the solver must also survive being TOLD the truth */
    var ctf = Solver.checkAgainstTruth(toBoard(fm), { solvable: fx.solvable });
    if (!ctf.sound) fixBad.push(fx.name + " checkAgainstTruth: " + ctf.message);
  }
  note("hand-built fixtures: " + FIXTURES.length + " (6 unsolvable, 4 solvable, incl. facing pairs, a cycle, walls and sky)");
  if (fixBad.length) note("FIXTURE FAILURES: " + JSON.stringify(fixBad));
  check("2f solver and oracle agree on hand-built deadlocks and clears",
    fixBad.length === 0, FIXTURES.length + " fixtures, " + fixBad.length + " disagreements");

  /* --- 2g monotonicity itself: removing an arrow never un-frees one ----- */
  var monoChecks = 0, monoBreaks = 0;
  for (var q = 0; q < 400; q++) {
    var mm = randomModel(rand, { arrowP: 0.5 });
    var before = myFreeSet(mm);
    var arrows = myArrowCells(mm);
    if (!arrows.length) continue;
    var victim = arrows[ri(rand, arrows.length)];
    var after = myClone(mm);
    after.g[victim] = "-";
    var afterFree = new Set(myFreeSet(after));
    for (var z = 0; z < before.length; z++) {
      if (before[z] === victim) continue;
      monoChecks++;
      if (!afterFree.has(before[z])) monoBreaks++;
    }
  }
  note("free-set monotonicity: " + monoChecks + " (arrow, removal) pairs re-checked after a removal");
  check("2g removal is monotone — a free arrow stays free",
    monoBreaks === 0, monoBreaks + " arrows lost freeness after a removal");
});

/* =====================================================================
   CHECK 3 — GATE NECESSARY
   ===================================================================== */
section("3. GATE NECESSARY — ungated boards on the same shapes fail constantly");

part(function () {
  var rand = myRng("flightpath|verify|gate-necessary|v1");
  var lines = [];
  var allUnsolvable = 0, allOffBand = 0, allBoards = 0, allFine = 0;
  var perTierOk = true;

  for (var t = 1; t <= NT; t++) {
    var spec = Generator.tierFor(t);
    var unsolvable = 0, offBand = 0, fine = 0, n = 0;
    for (var seed = 1; seed <= SEEDS_UNGATED; seed++) {
      var r = Generator.generate(seed, t);
      if (!r.board) continue;
      var base = fromBoard(r.board);
      /* Same shape, same walls, same arrow POSITIONS — only the directions are
         re-rolled at random. This is exactly "what the generator would emit if
         the solver gate were removed". */
      for (var k = 0; k < 5; k++) {
        var m = myClone(base);
        for (var i = 0; i < m.g.length; i++) {
          if (myIsArrow(m.g[i])) m.g[i] = MY_ARROWS[ri(rand, 4)];
        }
        n++;
        var g = myGrade(m);
        if (!g.solved) { unsolvable++; continue; }
        var band = Generator.accepts(spec, toBoard(m), Solver.grade(toBoard(m)));
        if (!band.ok) offBand++; else fine++;
      }
    }
    allBoards += n; allUnsolvable += unsolvable; allOffBand += offBand; allFine += fine;
    var badFrac = (unsolvable + offBand) / n;
    lines.push("tier " + t + ": " + n + " ungated boards -> unsolvable " +
      (100 * unsolvable / n).toFixed(1) + "%, solvable-but-off-band " +
      (100 * offBand / n).toFixed(1) + "%, would-have-passed " +
      (100 * fine / n).toFixed(1) + "%");
    if (!(unsolvable / n > 0)) perTierOk = false;
  }
  lines.forEach(note);
  note("overall: " + allBoards + " ungated boards, " +
    (100 * allUnsolvable / allBoards).toFixed(1) + "% deadlock, " +
    (100 * (allUnsolvable + allOffBand) / allBoards).toFixed(1) + "% rejected by the gate");

  check("3a ungated random-direction boards deadlock at a nonzero rate in EVERY tier",
    perTierOk, lines.join(" ; "));
  check("3b the gate rejects the large majority of ungated boards (not theatre)",
    (allUnsolvable + allOffBand) / allBoards > 0.9,
    ((100 * (allUnsolvable + allOffBand)) / allBoards).toFixed(2) + "% rejected, " +
    allFine + "/" + allBoards + " would have slipped through");
});

/* =====================================================================
   CHECK 4 — GATE SUFFICIENT
   ===================================================================== */
section("4. GATE SUFFICIENT — every emitted board re-derived from its own string");

var TIER_STATS = [];

part(function () {
  var SEEDS = SEEDS_STATS;
  var totalBoards = 0, dead = 0;
  var notSolvable = 0, gradeMismatch = 0, specBandFail = 0, tierBandFail = 0;
  var orderInvalid = 0, forcedRunFail = 0, widthsMismatch = 0;
  var firstBad = null;

  for (var t = 1; t <= NT; t++) {
    var spec = Generator.tierFor(t);
    var sp = CONTRACT[t - 1];
    var efforts = [], depths = [], arrows = [], walls = [], minW = [], runs = [];
    var keys = [], models = [], attempts = [];
    var worstAttempts = 0, candidates = 0, rejects = {};

    for (var seed = 1; seed <= SEEDS; seed++) {
      var r = Generator.generate(seed, t);
      if (!r.board) { dead++; continue; }
      totalBoards++;
      attempts.push(r.attempts);
      if (r.attempts > worstAttempts) worstAttempts = r.attempts;
      candidates += r.attempts;
      for (var rk in r.rejects) rejects[rk] = (rejects[rk] || 0) + r.rejects[rk];

      /* re-derive EVERYTHING from the serialized string, ignoring r.grade */
      var str = Board.serialize(r.board);
      var m = myDecode(str);
      var g = myGrade(m);

      if (!g.solved) {
        notSolvable++;
        if (!firstBad) firstBad = { tier: t, seed: seed, key: str, remaining: g.stuckCount };
      }
      /* the shipped grade must equal mine */
      var their = Solver.grade(r.board);
      if (their.arrows !== g.arrows || their.walls !== g.walls || their.depth !== g.depth ||
          their.minRoundWidth !== g.minRoundWidth || Math.abs(their.effort - g.effort) > 0.1001 ||
          their.maxRay !== g.maxRay) {
        gradeMismatch++;
        if (!firstBad) firstBad = { tier: t, seed: seed, mine: g, theirs: their };
      }
      /* SPEC.md's own table, transcribed by hand in this file */
      if (m.w !== sp.w || m.h !== sp.h ||
          g.arrows < sp.arrows[0] || g.arrows > sp.arrows[1] ||
          g.walls < sp.walls[0] || g.walls > sp.walls[1] ||
          g.depth < sp.depth[0] || g.depth > sp.depth[1]) {
        specBandFail++;
        if (!firstBad) firstBad = { tier: t, seed: seed, key: str, grade: g, spec: sp };
      }
      /* the generator's own declared band, re-checked from my metrics */
      if (g.effort < spec.effort[0] || g.effort > spec.effort[1] ||
          g.minRoundWidth < spec.minRoundWidth[0] || g.minRoundWidth > spec.minRoundWidth[1]) {
        tierBandFail++;
        if (!firstBad) firstBad = { tier: t, seed: seed, key: str, grade: g, band: spec };
      }
      /* the construction order the generator hands out must be legal play,
         replayed under MY rules */
      if (r.constructionOrder) {
        var work = myClone(m);
        var ok = true;
        for (var oi = 0; oi < r.constructionOrder.length; oi++) {
          var idx = r.constructionOrder[oi];
          if (!myFree(work, idx)) { ok = false; break; }
          work.g[idx] = "-";
        }
        if (!ok || myArrowCount(work) !== 0) {
          orderInvalid++;
          if (!firstBad) firstBad = { tier: t, seed: seed, key: str, reason: "constructionOrder illegal" };
        }
      }

      /* forcedRun: gated only on tiers that declare it, but MEASURED on every
         tier so the distributions can be compared. */
      if (sp.forcedRun) {
        if (g.forcedRun < sp.forcedRun[0] || g.forcedRun > sp.forcedRun[1]) {
          forcedRunFail++;
          if (!firstBad) {
            firstBad = { tier: t, seed: seed, key: str, forcedRun: g.forcedRun, band: sp.forcedRun };
          }
        }
      }
      /* my round-width sequence must equal the shipped one — forcedRun is
         derived from it, so a divergence here would poison the new gate */
      if ((their.roundWidths || []).join(",") !== g.roundWidths.join(",")) {
        widthsMismatch++;
        if (!firstBad) firstBad = { tier: t, seed: seed, key: str, reason: "roundWidths differ" };
      }

      efforts.push(g.effort); depths.push(g.depth); arrows.push(g.arrows);
      walls.push(g.walls); minW.push(g.minRoundWidth); runs.push(g.forcedRun);
      keys.push(str); models.push(m);
    }

    TIER_STATS.push({
      tier: t, n: efforts.length, efforts: efforts, depths: depths,
      arrows: arrows, walls: walls, minW: minW, runs: runs,
      keys: keys, models: models, attempts: attempts, worstAttempts: worstAttempts,
      candidates: candidates, rejects: rejects
    });
    note("tier " + t + ": " + efforts.length + "/" + SEEDS + " seeds produced a board; " +
      "arrows " + mn(arrows) + "-" + mx(arrows) + " (spec " + sp.arrows.join("-") + "), " +
      "walls " + mn(walls) + "-" + mx(walls) + " (spec " + sp.walls.join("-") + "), " +
      "depth " + mn(depths) + "-" + mx(depths) + " (spec " + sp.depth.join("-") + "), " +
      "forcedRun " + mn(runs) + "-" + mx(runs) + " (median " + median(runs) +
      (sp.forcedRun ? ", GATED " + sp.forcedRun.join("-") : ", not gated") + "), " +
      "worst " + worstAttempts + " attempts of a " + Generator.tierFor(t).attempts + " budget");
  }
  if (firstBad) note("FIRST BAD BOARD: " + JSON.stringify(firstBad));

  var expected = NT * SEEDS_STATS;
  check("4a generate() never returns a dead seed across " + expected + " calls",
    dead === 0 && totalBoards === expected,
    totalBoards + "/" + expected + " boards produced, " + dead + " seeds exhausted their attempt budget");
  check("4b every emitted board is solvable when re-solved from its own string",
    notSolvable === 0, totalBoards + " boards re-solved independently, " + notSolvable + " unsolvable");
  check("4c my grade matches the shipped grade on every emitted board",
    gradeMismatch === 0, gradeMismatch + " mismatches over " + totalBoards + " boards");
  check("4d every emitted board sits inside SPEC.md's tier table",
    specBandFail === 0, specBandFail + " boards outside the spec table");
  check("4e every emitted board sits inside its declared effort/bottleneck band",
    tierBandFail === 0, tierBandFail + " boards outside the declared band");
  check("4f the generator's constructionOrder is legal play under my own rules",
    orderInvalid === 0, orderInvalid + " illegal orders");
  check("4g my roundWidths sequence matches the shipped grade's on every board",
    widthsMismatch === 0, widthsMismatch + " sequences differed over " + totalBoards + " boards");
  check("4h every tier-6/7 board sits inside its declared forcedRun band",
    forcedRunFail === 0,
    "T6 gate " + JSON.stringify(CONTRACT[5].forcedRun) + ", T7 gate " +
    JSON.stringify(CONTRACT[6].forcedRun) + " — " + forcedRunFail + " boards outside");

  /* Tiers 1-5 must be BIT-FOR-BIT what they were before tiers 6/7 landed. */
  var goldBad = [];
  for (var gi = 0; gi < GOLDEN_1_TO_5.length; gi++) {
    var G = GOLDEN_1_TO_5[gi];
    var st = TIER_STATS[gi];
    if (!st) { goldBad.push("T" + G.tier + " missing"); continue; }
    var got = [f1(mn(st.efforts)), f1(median(st.efforts)), f1(mx(st.efforts))];
    if (got[0] !== G.effort[0] || got[1] !== G.effort[1] || got[2] !== G.effort[2]) {
      goldBad.push("T" + G.tier + " effort " + JSON.stringify(got) + " != golden " + JSON.stringify(G.effort));
    }
    if (mn(st.depths) !== G.depth[0] || mx(st.depths) !== G.depth[1]) {
      goldBad.push("T" + G.tier + " depth " + mn(st.depths) + "-" + mx(st.depths) +
        " != golden " + G.depth.join("-"));
    }
    if (mn(st.arrows) !== G.arrows[0] || mx(st.arrows) !== G.arrows[1]) {
      goldBad.push("T" + G.tier + " arrows " + mn(st.arrows) + "-" + mx(st.arrows));
    }
    if (mn(st.walls) !== G.walls[0] || mx(st.walls) !== G.walls[1]) {
      goldBad.push("T" + G.tier + " walls " + mn(st.walls) + "-" + mx(st.walls));
    }
  }
  note("tier 1-5 regression vs the last green run BEFORE tiers 6/7 existed: " +
    (goldBad.length ? JSON.stringify(goldBad) : "all 20 frozen values identical"));
  check("4i tiers 1-5 are unchanged — 20 frozen effort/depth/arrow/wall values still exact",
    goldBad.length === 0, goldBad.length + " drifted");
});

/* =====================================================================
   CHECK 5 — GRADING IS REAL
   ===================================================================== */
section("5. GRADING — tiers actually separate");

part(function () {
  var medians = [], maxes = [], ok = true, detail = [];
  for (var i = 0; i < TIER_STATS.length; i++) {
    var st = TIER_STATS[i];
    var med = median(st.efforts);
    medians.push(med); maxes.push(mx(st.efforts));
    note("tier " + st.tier + " effort  min " + f1(mn(st.efforts)) + "  median " + f1(med) +
      "  max " + f1(mx(st.efforts)) + "   |  depth median " + median(st.depths) +
      "  minRoundWidth " + mn(st.minW) + "-" + mx(st.minW) +
      "  forcedRun median " + median(st.runs));
  }
  for (var t = 1; t < TIER_STATS.length; t++) {
    var pass = medians[t] > maxes[t - 1];
    detail.push("med(T" + (t + 1) + ")=" + f1(medians[t]) + (pass ? " > " : " !> ") +
      "max(T" + t + ")=" + f1(maxes[t - 1]));
    if (!pass) ok = false;
  }
  check("5a each tier's MEDIAN effort exceeds the previous tier's MAXIMUM", ok, detail.join("; "));

  /* ---- 5b-pre: is separation ARITHMETIC, or merely unobserved? ---------

     Up to tier 5 the grid separated the tiers and cross-tier rejection was
     structural. Tiers 5, 6 and 7 are ALL 7x9, so that crutch is gone and
     SPEC.md instead claims two disjoint axes (effort and depth). I check that
     claim per PAIR rather than believing the sentence: for every pair of
     tiers, which gated bands are actually disjoint? One disjoint band is
     sufficient to make cross-acceptance arithmetically impossible. */
  var pairLines = [], pairsWithNoDisjointBand = [];
  var BANDS = ["arrows", "walls", "depth", "minRoundWidth", "effort"];
  function disjoint(a, b) { return a[1] < b[0] || b[1] < a[0]; }
  for (var pa = 0; pa < NT; pa++) {
    for (var pb = pa + 1; pb < NT; pb++) {
      var A = CONTRACT[pa], B = CONTRACT[pb];
      var dis = [];
      if (A.w !== B.w || A.h !== B.h) dis.push("grid");
      for (var bn = 0; bn < BANDS.length; bn++) {
        if (disjoint(A[BANDS[bn]], B[BANDS[bn]])) dis.push(BANDS[bn]);
      }
      if (A.forcedRun && B.forcedRun && disjoint(A.forcedRun, B.forcedRun)) dis.push("forcedRun");
      if (!dis.length) pairsWithNoDisjointBand.push("T" + A.tier + "/T" + B.tier);
      if (A.w === B.w && A.h === B.h) {
        pairLines.push("T" + A.tier + "/T" + B.tier + " (same grid) disjoint on: " +
          (dis.length ? dis.join("+") : "NOTHING"));
      }
    }
  }
  pairLines.forEach(note);
  note("depth windows T5 " + JSON.stringify(CONTRACT[4].depth) + " and T6 " +
    JSON.stringify(CONTRACT[5].depth) + " OVERLAP on [21,26] — so SPEC.md's " +
    "\"two disjoint axes\" is only true of the effort axis for that pair; effort " +
    "alone is what makes T5/T6 arithmetically impossible to confuse.");
  check("5b-pre every pair of tiers is separated by at least one DISJOINT gated band",
    pairsWithNoDisjointBand.length === 0,
    (NT * (NT - 1) / 2) + " tier pairs, " + pairsWithNoDisjointBand.length +
    " with no disjoint band" + (pairsWithNoDisjointBand.length ?
      ": " + pairsWithNoDisjointBand.join(",") : ""));

  /* A board certified for tier N must not pass tier M's gate, M != N. */
  var crossPass = 0, crossTested = 0, firstCross = null;
  var metricOnlyOverlap = 0, metricOnlySameGrid = 0;
  for (var a = 0; a < TIER_STATS.length; a++) {
    var sa = TIER_STATS[a];
    for (var k = 0; k < sa.keys.length; k++) {
      var b = Board.deserialize(sa.keys[k]);
      var g = Solver.grade(b);
      for (var mI = 1; mI <= NT; mI++) {
        if (mI === sa.tier) continue;
        crossTested++;
        var spec = Generator.tierFor(mI);
        if (Generator.accepts(spec, b, g).ok) {
          crossPass++;
          if (!firstCross) firstCross = { certifiedTier: sa.tier, alsoAccepted: mI, key: sa.keys[k] };
        }
        /* informational: would the METRICS alone (ignoring grid size) match?
           This is the number that matters now that T5/T6/T7 share a grid —
           for those pairs it is not "informational" at all, it IS the gate. */
        var mg = myGrade(myDecode(sa.keys[k]));
        var metricFit = mg.arrows >= spec.arrows[0] && mg.arrows <= spec.arrows[1] &&
            mg.walls >= spec.walls[0] && mg.walls <= spec.walls[1] &&
            mg.depth >= spec.depth[0] && mg.depth <= spec.depth[1] &&
            mg.effort >= spec.effort[0] && mg.effort <= spec.effort[1] &&
            mg.minRoundWidth >= spec.minRoundWidth[0] && mg.minRoundWidth <= spec.minRoundWidth[1] &&
            (!spec.forcedRun ||
              (mg.forcedRun >= spec.forcedRun[0] && mg.forcedRun <= spec.forcedRun[1]));
        if (metricFit) {
          metricOnlyOverlap++;
          if (spec.w === Board.deserialize(sa.keys[k]).w && spec.h === Board.deserialize(sa.keys[k]).h) {
            metricOnlySameGrid++;
          }
        }
      }
    }
  }
  note("cross-tier acceptance tests: " + crossTested + "; boards accepted by a foreign tier: " + crossPass);
  note("foreign-tier matches on METRICS ALONE, grid ignored: " + metricOnlyOverlap +
    " (of which same-grid, i.e. not saved by the grid check at all: " + metricOnlySameGrid + ")");
  if (firstCross) note("FIRST CROSS-ACCEPT: " + JSON.stringify(firstCross));
  check("5b a board certified for tier N is rejected by every other tier's gate",
    crossPass === 0, crossTested + " (board, foreign tier) pairs, " + crossPass + " accepted");
  check("5b2 no board matches a foreign SAME-GRID tier's bands even with the grid check removed",
    metricOnlySameGrid === 0,
    "T5/T6/T7 all 7x9; " + metricOnlySameGrid + " same-grid metric matches (the grid gate " +
    "cannot help these pairs, so this is the real separation test)");

  /* Effort must be monotone in each axis, as the spec claims. */
  var monoFail = [];
  var base = { depth: 6, minRoundWidth: 3, trapFraction: 0.5, meanRay: 3, arrows: 25 };
  function e(o) {
    var x = Object.assign({}, base, o);
    return Solver.effortOf(x);
  }
  if (!(e({ depth: 7 }) > e({}))) monoFail.push("depth");
  if (!(e({ trapFraction: 0.7 }) > e({}))) monoFail.push("trapFraction");
  if (!(e({ meanRay: 4 }) > e({}))) monoFail.push("meanRay");
  if (!(e({ arrows: 30 }) > e({}))) monoFail.push("arrows");
  if (!(e({ minRoundWidth: 1 }) > e({}))) monoFail.push("minRoundWidth-tighter-is-harder");
  if (!(e({ minRoundWidth: 6 }) < e({}))) monoFail.push("minRoundWidth-looser-is-easier");
  note("effort monotonicity probes around " + JSON.stringify(base) + " -> effort " + e({}));
  check("5c effort is strictly monotone in every axis the spec names",
    monoFail.length === 0, monoFail.length ? "broken on: " + monoFail.join(",") : "6/6 axes");

  /* Depth must be the thing that separates: assert depth bands are ordered. */
  var depthOrdered = true, dl = [];
  for (var d = 0; d < TIER_STATS.length; d++) {
    dl.push("T" + (d + 1) + " " + mn(TIER_STATS[d].depths) + "-" + mx(TIER_STATS[d].depths));
    if (d > 0 && !(median(TIER_STATS[d].depths) > median(TIER_STATS[d - 1].depths))) depthOrdered = false;
  }
  check("5d observed depth ranges are strictly ordered by tier", depthOrdered, dl.join(", "));
});

/* =====================================================================
   CHECK 6 — DETERMINISM AND VARIETY
   ===================================================================== */
section("6. DETERMINISM AND VARIETY");

part(function () {
  /* --- 6a same process, repeated calls ------------------------------- */
  var sameProcess = 0, sameProcessBad = 0, sameProcessDead = 0;
  function ser(r) { return r && r.board ? Board.serialize(r.board) : "DEAD"; }
  for (var t = 1; t <= NT; t++) {
    for (var seed = 1; seed <= SEEDS_DETERMINISM; seed++) {
      var a = Generator.generate(seed, t);
      var b = Generator.generate(seed, t);
      sameProcess++;
      if (ser(a) === "DEAD") sameProcessDead++;
      if (ser(a) !== ser(b)) sameProcessBad++;
    }
  }
  check("6a generate(seed,tier) is stable within a process",
    sameProcessBad === 0 && sameProcessDead === 0,
    sameProcess + " repeat calls, " + sameProcessBad + " differed, " +
    sameProcessDead + " dead seeds");

  /* --- 6b fresh process, no shell pipe ------------------------------- */
  var genPath = path.join(JS, "generator.js").replace(/\\/g, "/");
  var boardPath = path.join(JS, "board.js").replace(/\\/g, "/");
  var code =
    "var G=require(" + JSON.stringify(genPath) + ");" +
    "var B=require(" + JSON.stringify(boardPath) + ");" +
    "var out=[];for(var t=1;t<=" + NT + ";t++){for(var s=1;s<=" + SEEDS_DETERMINISM + ";s++){var r=G.generate(s,t);" +
    "out.push(r.board?B.serialize(r.board):'DEAD');}}" +
    "process.stdout.write(out.join('|'));";
  var childOut = child.execFileSync(process.execPath, ["-e", code], {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024
  });
  var childKeys = childOut.split("|");
  var mineKeys = [];
  for (var t2 = 1; t2 <= NT; t2++) {
    for (var s2 = 1; s2 <= SEEDS_DETERMINISM; s2++) {
      var rr = Generator.generate(s2, t2);
      mineKeys.push(ser(rr));
    }
  }
  var crossProcessBad = 0, firstDiff = null;
  for (var i = 0; i < mineKeys.length; i++) {
    if (mineKeys[i] !== childKeys[i]) {
      crossProcessBad++;
      if (!firstDiff) firstDiff = { i: i, mine: mineKeys[i], child: childKeys[i] };
    }
  }
  if (firstDiff) note("FIRST CROSS-PROCESS DIFF: " + JSON.stringify(firstDiff));
  check("6b identical boards from a FRESH node process (100 boards)",
    crossProcessBad === 0 && childKeys.length === mineKeys.length,
    childKeys.length + " boards compared, " + crossProcessBad + " differed");

  /* --- 6c variety across 300 seeds per tier --------------------------

     Wall-layout variety needs the right statistic, and "most layouts are
     distinct" is NOT it. Tier 7's wall band is [1, 4] and its modal draw is a
     SINGLE wall on a 63-cell grid: 184 of 300 boards carry one wall, so at
     most 63 layouts exist for them and collisions are forced by the pigeonhole
     principle, not by a lazy generator. Tier 3 is the same story at [0, 2].

     So each wall-count bucket is compared against its own BIRTHDAY
     EXPECTATION — the distinct count uniform random placement would produce,
     C * (1 - (1 - 1/C)^n) with C = the number of possible layouts at that
     wall count. A generator that always parks the wall in the same corner
     lands far below that expectation and still fails; one that samples
     uniformly sits on it. Measured: tier 7's 1-wall bucket gives 61 distinct
     against an expectation of 59.7 (and all 63 cells are used at least once),
     which is why its 176 total layouts is correct behaviour, not a defect.

     Asserted per tier: (a) every wall count in the band occurs, (b) walls
     appear in at least half the cells of the grid across the sample,
     (c) multi-wall boards are near-all distinct, (d) every bucket reaches 60%
     of its birthday expectation. */
  function birthdayExpect(C, n) {
    if (C <= 1) return 1;
    return C * (1 - Math.pow(1 - 1 / C, n));
  }
  function layoutsAvailable(cells, k) {
    var c = 1;
    for (var j = 0; j < k; j++) c = c * (cells - j) / (j + 1);
    return c;
  }
  var SEEDS = SEEDS_VARIETY;
  var varietyOk = true;
  var varietyBad = [];
  for (var t3 = 1; t3 <= NT; t3++) {
    var spec = Generator.tierFor(t3);
    var keys = new Set(), masks = new Set(), wallLayouts = new Set(), dirMixes = new Set();
    var arrowLayouts = new Set(), walledLayouts = new Set();
    var wallCounts = {}, bucketSets = {}, wallCellsUsed = new Set();
    var multiWall = 0, multiWallSet = new Set();
    var n = 0, walled = 0;
    for (var s3 = 1; s3 <= SEEDS; s3++) {
      var r = Generator.generate(s3, t3);
      if (!r.board) continue;
      n++;
      var m = myDecode(Board.serialize(r.board));
      keys.add(myBody(m));
      var mask = "", wallStr = "", arrowStr = "", nw = 0;
      var mix = { N: 0, E: 0, S: 0, W: 0 };
      for (var i2 = 0; i2 < m.g.length; i2++) {
        var c = m.g[i2];
        mask += c === "." ? "0" : "1";
        wallStr += c === "#" ? "#" : ".";
        arrowStr += myIsArrow(c) ? "a" : ".";
        if (c === "#") { nw++; wallCellsUsed.add(i2); }
        if (myIsArrow(c)) mix[c]++;
      }
      wallCounts[nw] = (wallCounts[nw] || 0) + 1;
      if (!bucketSets[nw]) bucketSets[nw] = new Set();
      bucketSets[nw].add(wallStr);
      masks.add(mask); wallLayouts.add(wallStr); arrowLayouts.add(arrowStr);
      if (nw > 0) { walled++; walledLayouts.add(wallStr); }
      if (nw >= 2) { multiWall++; multiWallSet.add(wallStr); }
      dirMixes.add(mix.N + "/" + mix.E + "/" + mix.S + "/" + mix.W);
    }
    /* every wall count the tier allows must actually occur */
    var countsCovered = true;
    for (var wc = spec.walls[0]; wc <= spec.walls[1]; wc++) {
      if (!wallCounts[wc]) countsCovered = false;
    }
    /* every bucket must reach 60% of the distinct count uniform placement
       would give — the test a fixed-position placer fails */
    var bucketOk = true, bucketLine = [];
    var cellCount = spec.w * spec.h;
    for (var bk in bucketSets) {
      var k = Number(bk);
      if (k === 0) continue;
      var nk = wallCounts[k], dk = bucketSets[bk].size;
      var ek = birthdayExpect(layoutsAvailable(cellCount, k), nk);
      bucketLine.push(k + "w: " + dk + "/" + nk + " distinct vs " + ek.toFixed(1) + " expected");
      if (dk < 0.6 * ek) bucketOk = false;
    }
    var wallsPossible = spec.walls[1] > 0;
    var wallOk = wallsPossible
      ? (countsCovered && walled > 0 && bucketOk &&
         wallCellsUsed.size >= 0.5 * cellCount &&
         (multiWall === 0 || multiWallSet.size >= 0.85 * multiWall))
      : (countsCovered && wallLayouts.size === 1 && walled === 0 && wallCellsUsed.size === 0);
    var lineOk = n === SEEDS && keys.size === n && masks.size > 20 &&
      arrowLayouts.size > n * 0.8 && dirMixes.size > 20 && wallOk;
    if (!lineOk) { varietyOk = false; varietyBad.push("T" + t3); }
    note("tier " + t3 + " over " + n + " seeds: distinct boards " + keys.size +
      ", masks " + masks.size + ", arrow layouts " + arrowLayouts.size +
      ", direction mixes " + dirMixes.size);
    note("        walls " + JSON.stringify(wallCounts) +
      (wallsPossible
        ? " | " + bucketLine.join("; ") + " | wall cells used " + wallCellsUsed.size +
          "/" + cellCount + " | multi-wall layouts " + multiWallSet.size + "/" + multiWall
        : " (tier is wall-free by spec)") +
      (lineOk ? "" : "   <-- FAILS"));
  }
  check("6c " + SEEDS_VARIETY + " seeds per tier give distinct boards, masks, arrow layouts, wall layouts and direction mixes",
    varietyOk, varietyBad.length ? "tiers failing variety: " + varietyBad.join(",") : "all " + NT + " tiers varied on every axis");
});

/* =====================================================================
   CHECK 7 — HINT SAFETY
   ===================================================================== */
section("7. HINT SAFETY — a hint must never cost a life");

part(function () {
  var rand = myRng("flightpath|verify|hint|v1");
  var boards = [];
  for (var s = 0; s < 600; s++) boards.push(randomModel(rand));
  for (var t = 1; t <= NT; t++) {
    for (var seed = 1; seed <= SEEDS_HINT; seed++) {
      var r = Generator.generate(seed, t);
      if (r.board) boards.push(fromBoard(r.board));
    }
  }

  var hints = 0, blockedHints = 0, missedHints = 0, badRay = 0, states = 0;
  var firstBad = null;

  for (var bi = 0; bi < boards.length; bi++) {
    var work = myClone(boards[bi]);
    for (;;) {
      states++;
      var h = Solver.hint(toBoard(work));
      hints++;
      var truthFree = myFreeSet(work);
      if (h.found) {
        if (!myFree(work, h.idx)) {
          blockedHints++;
          if (!firstBad) firstBad = { kind: "BLOCKED HINT", key: myEncode(work), idx: h.idx, reason: h.reason };
        }
        /* the ray the hint advertises must be the real one */
        var real = myRay(work, h.idx).cells.join(",");
        if ((h.ray || []).join(",") !== real) {
          badRay++;
          if (!firstBad) firstBad = { kind: "BAD HINT RAY", key: myEncode(work), idx: h.idx };
        }
      } else if (truthFree.length > 0) {
        missedHints++;
        if (!firstBad) firstBad = { kind: "MISSED HINT", key: myEncode(work), free: truthFree };
      }
      if (!truthFree.length) break;
      /* advance one random legal tap, so hints are audited mid-solve too */
      var p = truthFree[ri(rand, truthFree.length)];
      work.g[p] = "-";
    }
  }

  note("boards: " + boards.length + " (600 random + 100 generated); mid-solve states audited: " + states);
  note("hint() calls: " + hints + "; blocked suggestions: " + blockedHints +
    "; missed (said none while a free arrow existed): " + missedHints + "; wrong ray: " + badRay);
  if (firstBad) note("FIRST BAD HINT: " + JSON.stringify(firstBad));
  check("7a hint never names a blocked arrow, at any point mid-solve",
    blockedHints === 0, hints + " hint calls audited, " + blockedHints + " named a blocked arrow");
  check("7b hint never claims deadlock while a provably free arrow exists",
    missedHints === 0, missedHints + " false deadlocks");
  check("7c the ray a hint advertises is the real ray", badRay === 0, badRay + " wrong rays");
});

/* =====================================================================
   CHECK 8 — SERIALIZATION ROUND-TRIP AND CORRUPTION
   ===================================================================== */
section("8. SERIALIZATION");

part(function () {
  var rand = myRng("flightpath|verify|serial|v1");
  var trips = 0, tripBad = 0, decodeBad = 0;
  var firstBad = null;
  var models = [];
  for (var s = 0; s < 500; s++) models.push(randomModel(rand));
  for (var t = 1; t <= NT; t++) {
    for (var seed = 1; seed <= SEEDS_SERIAL; seed++) {
      var r = Generator.generate(seed, t);
      if (r.board) models.push(fromBoard(r.board));
    }
  }
  for (var i = 0; i < models.length; i++) {
    var str = myEncode(models[i]);
    var b = Board.deserialize(str);
    var again = Board.serialize(b);
    trips++;
    if (again !== str) {
      tripBad++;
      if (!firstBad) firstBad = { in: str, out: again };
    }
    var b2 = Board.deserialize(again);
    if (!Board.equals(b, b2)) decodeBad++;
    /* clone must not alias */
    var cl = Board.clone(b);
    cl.cells[0] = Board.WALL;
    if (b.cells[0] === Board.WALL && models[i].g[0] !== "#") decodeBad++;
  }
  note("round-trips: " + trips + " boards (500 random + 150 generated)");
  if (firstBad) note("FIRST ROUND-TRIP FAILURE: " + JSON.stringify(firstBad));
  check("8a serialize(deserialize(s)) === s for every board", tripBad === 0,
    trips + " round-trips, " + tripBad + " lost information");
  check("8b deserialize is stable and clone does not alias", decodeBad === 0,
    decodeBad + " failures");

  var good = "FP1;3;2;E-#N.-";
  var CORRUPT = [
    ["truncated body", "FP1;3;2;E-#N."],
    ["overlong body", "FP1;3;2;E-#N.--"],
    ["empty body", "FP1;3;2;"],
    ["bad magic", "FP2;3;2;E-#N.-"],
    ["no magic", "3;2;E-#N.-"],
    ["missing field", "FP1;3;E-#N.-"],
    ["extra field", "FP1;3;2;E-#N.-;x"],
    ["bad cell char", "FP1;3;2;E-#X.-"],
    ["lowercase dir", "FP1;3;2;e-#N.-"],
    ["non-numeric width", "FP1;x;2;E-#N.-"],
    ["zero height", "FP1;3;0;"],
    ["negative width", "FP1;-3;2;E-#N.-"],
    ["dims that do not match body", "FP1;2;3;E-#N.-x"],
    ["empty string", ""],
    ["whitespace", "   "],
    ["number instead of string", 12345]
  ];
  var accepted = [];
  for (var c = 0; c < CORRUPT.length; c++) {
    var threw = false;
    try { Board.deserialize(CORRUPT[c][1]); } catch (e) { threw = true; }
    if (!threw) accepted.push(CORRUPT[c][0]);
  }
  note("corruption cases tried: " + CORRUPT.length + "; silently accepted: " + accepted.length +
    (accepted.length ? " (" + accepted.join(", ") + ")" : ""));
  check("8c every corrupted/truncated string is REJECTED, never silently decoded",
    accepted.length === 0, CORRUPT.length + " corruption classes");

  /* a valid-but-different string must decode to a genuinely different board */
  var b1 = Board.deserialize(good);
  var b2b = Board.deserialize("FP1;3;2;W-#N.-");
  check("8d a one-character change decodes to a different board",
    !Board.equals(b1, b2b) && Board.key(b1) !== Board.key(b2b), "E vs W at cell 0");
});

/* =====================================================================
   CHECK 9 — HAND-CRAFTED UNIT CASES (the trickiest logic in THIS game)
   ===================================================================== */
section("9. HAND-CRAFTED CASES — sky, edges, walls, forced order");

part(function () {
  var cases = [];

  /* (i) An edge arrow pointing off the board has an EMPTY ray and must be free
         even when the whole rest of the board is packed with walls. This is the
         boundary case where an off-by-one in the ray walk shows up. */
  cases.push({
    name: "(i) edge arrow pointing out has an empty ray and is free",
    got: Solver.isFree(toBoard(myDecode("FP1;3;3;##N######")), 2) === true &&
         Solver.rayCells(toBoard(myDecode("FP1;3;3;##N######")), 2).length === 0 &&
         myFree(myDecode("FP1;3;3;##N######"), 2) === true,
    want: true
  });

  /* (ii) Sky does NOT block, a wall does — the same geometry, one character
          different, opposite verdicts. This is the rule most easily fumbled. */
  var overSky = myDecode("FP1;4;1;E..-");
  var overWall = myDecode("FP1;4;1;E-#-");
  cases.push({
    name: "(ii) an arrow flies over sky but not over a wall",
    got: Solver.isFree(toBoard(overSky), 0) === true &&
         Solver.isFree(toBoard(overWall), 0) === false &&
         Solver.solve(toBoard(overSky)).solved === true &&
         Solver.solve(toBoard(overWall)).solved === false,
    want: true
  });

  /* (iii) A forced width-1 round: exactly one arrow is launchable at each step
           and the depth must come out as the full chain length. Row of four
           E-arrows in a 5-wide row: only the rightmost can go, then the next.
           depth must be 4 and every round width 1. */
  var chain = myDecode("FP1;5;1;EEEE-");
  var chainGrade = Solver.grade(toBoard(chain));
  var myChain = myGrade(chain);
  cases.push({
    name: "(iii) a forced chain grades depth 4 with every round width 1",
    got: chainGrade.depth === 4 && chainGrade.minRoundWidth === 1 &&
         chainGrade.maxRoundWidth === 1 && chainGrade.trapFraction === 0.75 &&
         myChain.depth === 4 && myChain.minRoundWidth === 1 &&
         Solver.solve(toBoard(chain)).order.join(",") === "3,2,1,0",
    want: true,
    detail: "depth=" + chainGrade.depth + " minW=" + chainGrade.minRoundWidth +
            " trap=" + chainGrade.trapFraction + " order=" +
            Solver.solve(toBoard(chain)).order.join(",")
  });

  /* (iv) Two arrows facing each other across the whole board deadlock, and the
          hint must SAY so rather than name one of them. A bad hint here costs
          a life on a board that is already lost. */
  var dead = myDecode("FP1;5;1;E---W");
  var dh = Solver.hint(toBoard(dead));
  cases.push({
    name: "(iv) facing pair: solver says deadlock and hint refuses to name a cell",
    got: Solver.solve(toBoard(dead)).solved === false && dh.found === false &&
         dh.idx === -1 && dh.done === false && (dh.stuck || []).length === 2 &&
         myExhaustive(dead).solvable === false,
    want: true,
    detail: "hint.found=" + dh.found + " idx=" + dh.idx + " stuck=" + (dh.stuck || []).length
  });

  /* (v) An empty board is won, not stuck: hint must report done. */
  var empty = myDecode("FP1;2;2;--.-");
  var eh = Solver.hint(toBoard(empty));
  cases.push({
    name: "(v) an empty board reports done, not deadlock",
    got: eh.found === false && eh.done === true &&
         Solver.solve(toBoard(empty)).solved === true &&
         Solver.grade(toBoard(empty)).effort === 0,
    want: true
  });

  var bad = 0;
  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    if (c.got !== c.want) bad++;
    check("9" + "abcde"[i] + " " + c.name, c.got === c.want, c.detail || "");
  }
});

/* =====================================================================
   CHECK 10 — THE forcedRun GATE (new in tiers 6 and 7)
   ===================================================================== */
section("10. forcedRun — the new opt-in band");

part(function () {
  var rand = myRng("flightpath|verify|forcedrun|v1");

  /* ---- 10a my forcedRun vs the shipped one, on boards with known widths.
     Hand-built round-width sequences first, so the reference values are
     arithmetic rather than another program's output. */
  var UNIT = [
    { widths: [], want: 0 },
    { widths: [3], want: 0 },
    { widths: [1], want: 1 },
    { widths: [1, 1, 1, 1], want: 4 },
    { widths: [2, 1, 1, 3, 1], want: 2 },
    { widths: [1, 2, 1, 1, 1, 2, 1], want: 3 },
    { widths: [5, 4, 3], want: 0 },
    { widths: [1, 1, 5, 1, 1, 1], want: 3 },
    { widths: [1, 1, 1, 2], want: 3 }
  ];
  var unitBad = [];
  for (var u = 0; u < UNIT.length; u++) {
    var mineU = myForcedRun(UNIT[u].widths);
    var theirsU = Generator.longestForcedRun({ roundWidths: UNIT[u].widths });
    if (mineU !== UNIT[u].want || theirsU !== UNIT[u].want) {
      unitBad.push(JSON.stringify(UNIT[u].widths) + " want " + UNIT[u].want +
        " mine " + mineU + " shipped " + theirsU);
    }
  }
  note("hand-computed width sequences: " + UNIT.length +
    " (incl. empty, no-ones, all-ones, run broken at the end, two runs of different length)");
  if (unitBad.length) note("UNIT FAILURES: " + JSON.stringify(unitBad));
  check("10a forcedRun is correct on hand-computed round-width sequences",
    unitBad.length === 0, UNIT.length + " sequences, " + unitBad.length + " wrong");

  /* ---- 10b on real boards: my closure's widths -> my forcedRun, against the
     shipped one fed by the shipped grade. Two independent paths end to end. */
  var boards = [];
  for (var s = 0; s < 600; s++) boards.push(randomModel(rand, { arrowP: 0.45 + 0.4 * rand() }));
  for (var t = 1; t <= NT; t++) {
    for (var seed = 1; seed <= 10; seed++) {
      var r = Generator.generate(seed, t);
      if (r.board) boards.push(fromBoard(r.board));
    }
  }
  var frBad = 0, frCompared = 0, nonZero = 0, maxSeen = 0, firstFr = null;
  for (var bi = 0; bi < boards.length; bi++) {
    var m = boards[bi];
    var mineG = myGrade(m);
    var theirG = Solver.grade(toBoard(m));
    var theirRun = Generator.longestForcedRun(theirG);
    frCompared++;
    if (mineG.forcedRun !== theirRun) {
      frBad++;
      if (!firstFr) {
        firstFr = { key: myEncode(m), mine: mineG.forcedRun, shipped: theirRun,
          myWidths: mineG.roundWidths, theirWidths: theirG.roundWidths };
      }
    }
    if (mineG.forcedRun > 0) nonZero++;
    if (mineG.forcedRun > maxSeen) maxSeen = mineG.forcedRun;
  }
  note("boards compared: " + frCompared + " (600 random + " + (NT * 10) +
    " generated); nonzero forcedRun on " + nonZero + " of them, longest run seen " + maxSeen);
  if (firstFr) note("FIRST forcedRun DISAGREEMENT: " + JSON.stringify(firstFr));
  check("10b my forcedRun equals the shipped one on every board",
    frBad === 0, frCompared + " boards, " + frBad + " disagreements");

  /* ---- 10c the gate is NON-VACUOUS: drive accepts() through a synthetic
     spec that gates ONLY forcedRun, and confirm it accepts exactly when my
     independently computed run is in band. If the shipped gate were dropped,
     this goes red because rejections stop happening. */
  var wide = { arrows: [0, 999], walls: [0, 999], depth: [0, 999],
    minRoundWidth: [1, 999], effort: [0, 99999] };
  var gateTested = 0, gateWrong = 0, gateAccepts = 0, gateRejects = 0;
  for (var q = 0; q < boards.length; q++) {
    var mq = boards[q];
    var bq = toBoard(mq);
    var gq = Solver.grade(bq);
    if (!gq.solved) continue;
    var myRun = myGrade(mq).forcedRun;
    for (var k = 0; k <= 4; k++) {
      var spec = {
        w: mq.w, h: mq.h, arrows: wide.arrows, walls: wide.walls, depth: wide.depth,
        minRoundWidth: wide.minRoundWidth, effort: wide.effort, forcedRun: [k, k]
      };
      var got = Generator.accepts(spec, bq, gq).ok;
      var want = myRun === k;
      gateTested++;
      if (got) gateAccepts++; else gateRejects++;
      if (got !== want) gateWrong++;
    }
  }
  note("synthetic forcedRun gate probes: " + gateTested + " (accepted " + gateAccepts +
    ", rejected " + gateRejects + ") — both outcomes occur, so the gate is not vacuous");
  check("10c accepts() honours forcedRun exactly when my own value is in band",
    gateWrong === 0 && gateAccepts > 0 && gateRejects > 0,
    gateWrong + " wrong verdicts of " + gateTested);

  /* ---- 10d tiers 1-5 are provably UNGATED on forcedRun. Compare accepts()
     against my own re-implementation of accepts WITHOUT the forcedRun branch,
     over raw candidates (accepted and rejected alike), and count how many of
     those boards WOULD have been rejected if a tier-6 style band applied —
     which is what makes the comparison meaningful rather than trivially true. */
  function acceptsNoForcedRun(spec, board, g) {
    if (board.w !== spec.w || board.h !== spec.h) return false;
    if (!g.solved || g.stuckCount !== 0) return false;
    function inb(v, b) { return v >= b[0] && v <= b[1]; }
    return inb(g.arrows, spec.arrows) && inb(g.walls, spec.walls) &&
      inb(g.depth, spec.depth) && inb(g.minRoundWidth, spec.minRoundWidth) &&
      inb(g.effort, spec.effort);
  }
  var candTested = 0, candDiff = 0, wouldFailT6Band = 0, acceptedRaw = 0;
  for (var t5 = 1; t5 <= 5; t5++) {
    var spec5 = Generator.tierFor(t5);
    for (var a5 = 0; a5 < 300; a5++) {
      var rng5 = require(path.join(JS, "rng.js"))
        .makeRng(Generator.attemptSeed(9000 + a5, t5, a5));
      var cand = Generator.buildCandidate(spec5, rng5);
      if (!cand) continue;
      var g5 = Solver.grade(cand.board);
      var shipped = Generator.accepts(spec5, cand.board, g5).ok;
      var mineNo = acceptsNoForcedRun(spec5, cand.board, g5);
      candTested++;
      if (shipped) acceptedRaw++;
      if (shipped !== mineNo) candDiff++;
      var run5 = myGrade(myDecode(Board.serialize(cand.board))).forcedRun;
      if (run5 < 10) wouldFailT6Band++;
    }
  }
  note("tier 1-5 raw candidates graded: " + candTested + " (" + acceptedRaw +
    " accepted); " + wouldFailT6Band + " of them have forcedRun < 10, i.e. would " +
    "be REJECTED if tier 6's band applied — so 'identical verdicts' is a real result");
  check("10d tiers 1-5 verdicts are identical with the forcedRun branch removed",
    candDiff === 0, candTested + " candidates, " + candDiff + " verdict differences");

  /* ---- 10e the forcedRun distributions actually rise with tier, as SPEC.md
     claims (medians T5 10 / T6 17 / T7 25). Report measured values. */
  var runLine = [], runsOrdered = true;
  for (var ti = 0; ti < TIER_STATS.length; ti++) {
    var st = TIER_STATS[ti];
    runLine.push("T" + st.tier + " median " + median(st.runs) + " (" + mn(st.runs) + "-" + mx(st.runs) + ")");
  }
  runLine.forEach(function (x) { note("forcedRun " + x); });
  var m5 = median(TIER_STATS[4].runs), m6 = median(TIER_STATS[5].runs), m7 = median(TIER_STATS[6].runs);
  if (!(m6 > m5 && m7 > m6)) runsOrdered = false;
  check("10e forcedRun medians rise strictly across the top three tiers",
    runsOrdered, "T5 " + m5 + " < T6 " + m6 + " < T7 " + m7);

  /* ---- 10f is the SHIPPED gate load-bearing, or is it implied by the bands
     that already ran? "A new check that cannot fail is not a check" applies to
     the gate itself, not only to my tests. Measured from the generator's own
     rejection counters over the tier-6/7 candidate stream in check 4. */
  var inertLines = [], measured = 0, frRejTotal = 0;
  for (var ni = 0; ni < NEW_TIERS.length; ni++) {
    var st6 = TIER_STATS[NEW_TIERS[ni] - 1];
    var rj = st6.rejects || {};
    var frRej = rj.forcedRun || 0;
    frRejTotal += frRej;
    var totRej = 0;
    for (var rkk in rj) totRej += rj[rkk];
    measured += st6.candidates;
    inertLines.push("T" + st6.tier + ": " + st6.candidates + " candidates, " + totRej +
      " rejected (depth " + (rj.depth || 0) + ", effort " + (rj.effort || 0) +
      ", build " + (rj.build || 0) + "), forcedRun rejected " + frRej);
  }
  inertLines.forEach(note);
  note((frRejTotal === 0 ? "FINDING (not a defect, but do not call this gate " +
    "load-bearing): " : "the ") + "forcedRun " +
    "band rejected " + frRejTotal + " of " + measured + " candidates. Every candidate that already " +
    "cleared depth+effort also satisfied it, so removing the gate would change no " +
    "shipped board — mutant M1 confirmed exactly that. forcedRun is a real, correctly " +
    "computed DESCRIPTIVE metric (medians " + m5 + "/" + m6 + "/" + m7 +
    "), not an active filter on this sampler.");
  note("forcedRun also does NOT separate T6 from T7 by itself: observed T6 " +
    mn(TIER_STATS[5].runs) + "-" + mx(TIER_STATS[5].runs) + " overlaps T7 " +
    mn(TIER_STATS[6].runs) + "-" + mx(TIER_STATS[6].runs) +
    ", and the declared bands [10,99] and [16,99] overlap by construction. " +
    "Separation is carried by effort, as check 5b-pre shows.");
  check("10f the forcedRun band's marginal contribution is measured, not assumed",
    measured > 1000,
    measured + " tier-6/7 candidates observed; forcedRun rejections: " + frRejTotal +
    (frRejTotal === 0 ? " (gate currently INERT — implied by depth+effort)" : " (gate is active)"));
});

/* =====================================================================
   VERDICT
   ===================================================================== */
section("VERDICT");

var passed = results.filter(function (r) { return r.ok; }).length;
console.log("tiers audited: 1.." + NT + " (no tier skipped)   wall clock: " +
  ((Date.now() - T_START) / 1000).toFixed(1) + "s");
console.log("checks run: " + results.length + "   passed: " + passed + "   failed: " + failures.length);
if (failures.length) {
  console.log("");
  console.log("FAILURES:");
  failures.forEach(function (f) { console.log("  - " + f); });
  console.log("");
  console.log("RESULT: RED — the pipeline must not proceed.");
  process.exit(1);
}
console.log("RESULT: GREEN — all " + results.length + " checks passed.");
process.exit(0);

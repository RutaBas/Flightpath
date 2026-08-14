"use strict";
/* One IIFE per logic file — matches BULLPEN / STRATA module style. */
(function (root) {

/* FLIGHTPATH — solver / deduction engine.

   Pure logic. No DOM, no randomness, no I/O. The same file powers the hint
   button, auto-solve, the generator's gate and the harness's soundness proof,
   so every line has to be defensible.

   THE RULE
     Tapping an arrow launches it in its direction. It leaves the board IFF
     every cell along its ray — from the next cell up to and off the edge — is
     free of arrows and walls. Open cells and unmasked sky do not block.

   THE CONTRACT
     A deduction is only ever made when it is PROVEN. isFree(board, i) scans
     the WHOLE ray before it may return true. There is no heuristic, no
     short-circuit that could return true early, and no cache of freeness:
     freeness is a function of live board contents, and a cache is exactly the
     thing that goes stale mid-solve. Geometry (which cells a ray covers) is
     recomputed each call too — rays are at most 8 cells, the saving is not
     worth a correctness risk.

   THE TECHNIQUE LADDER (weakest first — this IS the difficulty axis)
     Flightpath has one atomic deduction ("this ray is clear, therefore this
     arrow is provably launchable") and gets its difficulty from how deeply
     those deductions have to be CHAINED, not from a menu of tricks. So the
     ladder here is the round structure of the greedy closure:

       round 1        arrows free with nothing removed — no lookahead at all.
       round 2..d     arrows that become free only after every arrow in an
                      earlier round has gone. Round k requires the player to
                      see a chain of length k.
       width-1 round  a round where exactly ONE arrow on the whole board is
                      launchable: a forced move that must be FOUND. This is the
                      hardest single thing the puzzle asks for.

     `depth` is the length of the longest dependency chain and `minRoundWidth`
     is the tightest bottleneck; `grade` combines them with the trap and ray
     terms into `effort`. See the effort comment for the exact formula and why
     it is monotone in each term.

   MONOTONICITY (the spec's central claim, which this file relies on)
     Removing an arrow only ever empties a cell, so a ray that is clear stays
     clear: the free set can only GROW. The rewriting system is therefore
     confluent and the terminal state is order-independent, which is why the
     greedy closure — take the entire free set as one round, repeat — is not a
     heuristic but a decision procedure. exhaustive() below is the independent
     oracle that PROVES this on small boards rather than assuming it; the test
     suite runs the two against each other on thousands of random boards,
     solvable and not. */

var isNode = typeof module !== "undefined" && module.exports;
var Board = isNode ? require("./board.js") : root.FlightpathBoard;

var OPEN = Board.OPEN;
var WALL = Board.WALL;
var DELTA = Board.DELTA;
var isArrow = Board.isArrow;

/* ------------------------------------------------------------------- rays */

/* rayCells(board, i, dirOverride)
     The in-grid cells the arrow at i would traverse, nearest first, from the
     next cell up to the edge. The final step off the board is not a cell, so
     an edge arrow pointing outward has an EMPTY ray — and is therefore always
     free. Sky cells ARE included: an arrow flies over them, and the player's
     eye still travels across them, so they count for meanRay/maxRay.

     dirOverride lets the generator ask "what would a d-facing arrow at i
     cover?" for a cell that is currently empty. */
function rayCells(board, i, dirOverride) {
  var d = dirOverride === undefined || dirOverride === null ? board.cells[i] : dirOverride;
  if (!isArrow(d)) return [];
  var w = board.w, h = board.h;
  var x = i % w, y = (i / w) | 0;
  var dx = DELTA[d][0], dy = DELTA[d][1];
  var out = [];
  for (;;) {
    x += dx; y += dy;
    if (x < 0 || y < 0 || x >= w || y >= h) break;
    out.push(y * w + x);
  }
  return out;
}

function rayLength(board, i, dirOverride) {
  var d = dirOverride === undefined || dirOverride === null ? board.cells[i] : dirOverride;
  if (!isArrow(d)) return 0;
  var w = board.w, h = board.h;
  var x = i % w, y = (i / w) | 0;
  if (d === 0) return y;
  if (d === 2) return h - 1 - y;
  if (d === 3) return x;
  return w - 1 - x;
}

/* ---------------------------------------------------------------- freeness */

/* isFree(board, i)
     TRUE iff i holds an arrow AND every cell of its ray is free of arrows and
     walls.

     SOUNDNESS NOTE — deliberately no early exit. The loop visits every cell of
     the ray on every call, including after it has already seen a blocker, so
     that a `true` return is only ever produced by a complete scan. (A `false`
     could safely short-circuit; not short-circuiting costs at most 7 array
     reads and removes the whole class of "returned true before finishing"
     bugs.) Nothing is memoised: freeness depends on live contents. */
function isFree(board, i) {
  var v = board.cells[i];
  if (!isArrow(v)) return false;
  var ray = rayCells(board, i);
  var blocked = false;
  for (var k = 0; k < ray.length; k++) {
    var c = board.cells[ray[k]];
    if (c === WALL || isArrow(c)) blocked = true;
  }
  return !blocked;
}

/* The first blocker along the ray, or -1. Explanatory only — never used to
   decide freeness, so it may short-circuit. */
function firstBlocker(board, i) {
  var ray = rayCells(board, i);
  for (var k = 0; k < ray.length; k++) {
    var c = board.cells[ray[k]];
    if (c === WALL || isArrow(c)) return ray[k];
  }
  return -1;
}

/* An INDEPENDENT re-implementation of the blocked test, written in x/y walk
   form rather than via rayCells, used only by checkAgainstTruth. Two code
   paths that must agree; if they ever disagree, one of them is wrong and the
   harness gets told. Do not refactor these two into one function — the
   duplication is the point. */
function blockedIndependent(board, i) {
  var v = board.cells[i];
  if (!isArrow(v)) return { arrow: false, blocked: true, at: -1 };
  var w = board.w, h = board.h;
  var x = i % w;
  var y = Math.floor(i / w);
  var step = DELTA[v];
  var at = -1;
  var cx = x, cy = y;
  while (true) {
    cx = cx + step[0];
    cy = cy + step[1];
    if (cx < 0 || cx > w - 1) break;
    if (cy < 0 || cy > h - 1) break;
    var j = cy * w + cx;
    var val = board.cells[j];
    if (val === WALL || (val >= 0 && val <= 3)) { if (at < 0) at = j; }
  }
  return { arrow: true, blocked: at >= 0, at: at };
}

/* freeSet(board) -> ascending indices of every currently-free arrow.
   Ascending order makes solve() deterministic. */
function freeSet(board) {
  var out = [];
  for (var i = 0; i < board.cells.length; i++) if (isFree(board, i)) out.push(i);
  return out;
}

/* --------------------------------------------------------------- the solve */

/* solve(board, opts) -> { solved, rounds, roundCount, order, stuck, ... }

     rounds      array of rounds; each round is the ENTIRE free set at that
                 moment, as an ascending array of indices. Every arrow in a
                 round is simultaneously free, so the player may tap them in
                 any order within the round (monotonicity).
     roundCount  rounds.length — the `depth` metric.
     order       the flat removal order (rounds concatenated). One valid
                 clearing sequence; by confluence, any other order that only
                 taps free arrows reaches the same terminal state.
     stuck       arrows still on the board at the terminal state, with the
                 blocker that pins each one.
     solved      stuck.length === 0.

   opts.checkAgainstTruth  ground-truth mode — see checkAgainstTruth(). When
                 set, EVERY arrow this solve declares free is re-verified by
                 the independent scanner before it is removed, and any
                 disagreement (or any disagreement with a supplied known-good
                 clearing order) is recorded in result.violations. Off by
                 default so the generator's hot loop pays nothing. */
function solve(board, opts) {
  var o = opts || {};
  var truth = o.checkAgainstTruth;
  var work = Board.clone(board);
  var rounds = [];
  var order = [];
  var violations = [];
  var totalArrows = Board.countArrows(board);
  var guard = 0;

  for (;;) {
    var free = freeSet(work);
    if (free.length === 0) break;

    if (truth) {
      for (var f = 0; f < free.length; f++) {
        var chk = blockedIndependent(work, free[f]);
        if (!chk.arrow || chk.blocked) {
          violations.push({
            kind: "claimed-free-but-blocked",
            idx: free[f],
            round: rounds.length,
            blockerAt: chk.at,
            explain: "solver put cell " + free[f] + " in round " + rounds.length +
              ", independent scan says its ray is blocked at " + chk.at
          });
        }
      }
    }

    rounds.push(free.slice());
    for (var k = 0; k < free.length; k++) {
      order.push(free[k]);
      work.cells[free[k]] = OPEN;
    }

    /* Each round removes at least one arrow, so this can never spin. The
       guard exists so a corrupted board cannot hang a caller. */
    if (++guard > totalArrows + 2) break;
  }

  var stuck = [];
  for (var i = 0; i < work.cells.length; i++) {
    if (isArrow(work.cells[i])) {
      stuck.push({ idx: i, dir: work.cells[i], blockedBy: firstBlocker(work, i) });
    }
  }

  var res = {
    solved: stuck.length === 0,
    rounds: rounds,
    roundCount: rounds.length,
    order: order,
    stuck: stuck,
    stuckCount: stuck.length,
    arrows: totalArrows,
    terminal: work
  };
  if (truth) {
    res.violations = violations.concat(truthViolations(board, res, truth));
    res.sound = res.violations.length === 0;
  }
  return res;
}

/* Replay a removal order against a fresh copy, tapping strictly in that order
   and refusing any tap that is not provably free. Returns how far it got.
   This is what makes a "known-good order" checkable rather than trusted. */
function replay(board, order) {
  var work = Board.clone(board);
  for (var k = 0; k < order.length; k++) {
    var i = order[k];
    if (!isArrow(work.cells[i])) {
      return { ok: false, at: k, idx: i, reason: "no arrow at cell " + i };
    }
    if (!isFree(work, i)) {
      return { ok: false, at: k, idx: i, reason: "cell " + i + " was blocked when the order tapped it" };
    }
    work.cells[i] = OPEN;
  }
  return {
    ok: true,
    cleared: Board.countArrows(work) === 0,
    remaining: Board.countArrows(work),
    terminal: work
  };
}

function truthViolations(board, res, truth) {
  var out = [];
  if (truth === true) {
    /* "this board is asserted solvable" */
    if (!res.solved) {
      out.push({
        kind: "certified-board-not-solved",
        explain: "caller asserted the board is solvable; greedy closure stalled with " +
          res.stuck.length + " arrow(s) left"
      });
    }
    return out;
  }
  if (truth && truth.order) {
    var rp = replay(board, truth.order);
    if (!rp.ok) {
      out.push({
        kind: "truth-order-invalid",
        at: rp.at,
        idx: rp.idx,
        explain: "the supplied ground-truth order is not legal play: " + rp.reason
      });
    } else if (rp.cleared && !res.solved) {
      out.push({
        kind: "solvable-board-reported-stuck",
        explain: "ground truth clears the board but the greedy closure stalled with " +
          res.stuck.length + " arrow(s) left — the closure is incomplete"
      });
    } else if (!rp.cleared && res.solved) {
      out.push({
        kind: "truth-order-incomplete",
        remaining: rp.remaining,
        explain: "solver cleared the board but the supplied order left " + rp.remaining +
          " arrow(s); the order is partial, not a soundness failure"
      });
    }
    if (truth.solvable === false && res.solved) {
      out.push({
        kind: "unsolvable-board-reported-solved",
        explain: "ground truth says this board cannot be cleared, solver cleared it"
      });
    }
  } else if (truth && truth.solvable !== undefined) {
    if (truth.solvable !== res.solved) {
      out.push({
        kind: "solvability-disagrees-with-truth",
        truth: truth.solvable,
        solver: res.solved,
        explain: "ground truth solvable=" + truth.solvable + ", solver solved=" + res.solved
      });
    }
  }
  return out;
}

/* checkAgainstTruth(board, truth)
     Ground-truth mode as a standalone call. `truth` is either
       true                  — the board is asserted solvable;
       { order: [...] }      — a known-good clearing order (validated by
                               replay, not trusted);
       { solvable: bool }    — the known answer, e.g. from exhaustive().
     Returns { sound, violations, message, result }. `sound` false means the
     solver made a claim the ground truth contradicts, which is a bug in the
     solver — that is the whole point of the mode. */
function checkAgainstTruth(board, truth) {
  var res = solve(board, { checkAgainstTruth: truth === undefined ? true : truth });
  var v = res.violations || [];
  return {
    sound: v.length === 0,
    violations: v,
    result: res,
    message: v.length === 0
      ? "sound"
      : "SOUNDNESS BUG: " + v.length + " deduction(s) contradicted the ground truth."
  };
}

/* ------------------------------------------------------------------ grading */

/* grade(board) -> order-independent metrics.

     arrows          arrow count.
     depth           number of rounds in the greedy closure = the longest
                     dependency chain = how far ahead the player must plan.
     minRoundWidth   smallest round size. 1 means that at some point exactly
                     ONE arrow on the whole board was launchable.
     meanRoundWidth  arrows / depth, reported for context.
     trapFraction    share of arrows blocked at the START — how fast a naive
                     tapper bleeds lives.
     meanRay/maxRay  cells traversed per launch, averaged / worst, over the
                     starting board — how far the eye must travel to verify.
     effort          composite, see below.
     solved/stuck    the closure's verdict. An unsolved board still grades, but
                     its depth only counts the rounds that actually happened,
                     and the generator rejects it anyway.

   THE EFFORT FORMULA

     effort = 10*depth
            + 18*bottleneck        where bottleneck = 1 / minRoundWidth
            + 25*trapFraction
            +  2*meanRay
            + 0.6*arrows

   Why these terms, in the order they matter:

     depth (x10) is the dominant axis. It is the only metric that measures
       CHAINING — the thing that actually makes a Flightpath board hard. One
       extra round is worth ~10 points, more than any other single step.
     bottleneck (x18 on 1/minRoundWidth) is a hazard multiplier, not a size
       term. It ranges over (0, 1]: a width-1 round contributes the full 18, a
       width-2 round 9, a width-6 round 3. Using the RECIPROCAL is what makes
       effort DECREASING in minRoundWidth, i.e. increasing in tightness, which
       is the direction difficulty runs.
     trapFraction (x25) ranges 0..1 and is the lives axis: how many of the
       arrows on screen punish a tap right now.
     meanRay (x2) is the verification cost per tap. It grows with grid size and
       tops out around 8, so it contributes ~0..16.
     arrows (x0.6) is raw size — deliberately the WEAKEST term, so that a big
       shallow board cannot out-score a small deep one. 20 extra arrows are
       worth 12 points, i.e. barely more than one extra round of depth.

   MONOTONICITY OF THE FORMULA (the property the harness can check):
     effort is non-decreasing in depth, trapFraction, meanRay and arrows, and
     non-increasing in minRoundWidth. Every coefficient is positive and every
     term enters linearly (bottleneck through a positive, decreasing function
     of minRoundWidth), so no term can cancel another. Making a board strictly
     harder on one axis while holding the rest fixed always strictly raises
     effort.

   Empty board: every term is 0 and effort is 0. */
var EFFORT_WEIGHTS = {
  depth: 10,
  bottleneck: 18,
  trapFraction: 25,
  meanRay: 2,
  arrows: 0.6
};

function effortOf(m) {
  var bottleneck = m.minRoundWidth > 0 ? 1 / m.minRoundWidth : 0;
  var e = EFFORT_WEIGHTS.depth * m.depth
    + EFFORT_WEIGHTS.bottleneck * bottleneck
    + EFFORT_WEIGHTS.trapFraction * m.trapFraction
    + EFFORT_WEIGHTS.meanRay * m.meanRay
    + EFFORT_WEIGHTS.arrows * m.arrows;
  return Math.round(e * 10) / 10;
}

function grade(board, opts) {
  var res = solve(board, opts);
  var arrows = Board.arrowIndices(board);
  var n = arrows.length;

  var rayTotal = 0;
  var maxRay = 0;
  for (var a = 0; a < n; a++) {
    var len = rayLength(board, arrows[a]);
    rayTotal += len;
    if (len > maxRay) maxRay = len;
  }
  var meanRay = n ? rayTotal / n : 0;

  var startFree = freeSet(board).length;
  var trapFraction = n ? (n - startFree) / n : 0;

  var minRoundWidth = 0;
  var maxRoundWidth = 0;
  for (var r = 0; r < res.rounds.length; r++) {
    var wid = res.rounds[r].length;
    if (minRoundWidth === 0 || wid < minRoundWidth) minRoundWidth = wid;
    if (wid > maxRoundWidth) maxRoundWidth = wid;
  }

  var m = {
    arrows: n,
    walls: Board.countWalls(board),
    depth: res.roundCount,
    minRoundWidth: minRoundWidth,
    maxRoundWidth: maxRoundWidth,
    meanRoundWidth: res.roundCount ? Math.round((n / res.roundCount) * 100) / 100 : 0,
    roundWidths: res.rounds.map(function (x) { return x.length; }),
    trapFraction: n ? Math.round(((n - startFree) / n) * 1000) / 1000 : 0,
    startFree: startFree,
    meanRay: Math.round(meanRay * 1000) / 1000,
    maxRay: maxRay,
    solved: res.solved,
    stuckCount: res.stuck.length
  };
  /* effort uses the unrounded trapFraction/meanRay for stability */
  m.effort = effortOf({
    depth: m.depth,
    minRoundWidth: m.minRoundWidth,
    trapFraction: trapFraction,
    meanRay: meanRay,
    arrows: n
  });
  return m;
}

/* -------------------------------------------------------------------- hint */

/* hint(board) -> one PROVABLY free arrow, or an explanation of why there is
   none. Never names a blocked arrow: the chosen index is re-verified with a
   fresh full-ray isFree() immediately before it is returned, so even a bug in
   the ranking below cannot produce a blocked suggestion.

   Choice policy (deterministic): among free arrows, prefer the one that
   unblocks the most currently-blocked arrows — that is the move that opens the
   board up — tie-broken by the lowest index. */
function hint(board) {
  var free = freeSet(board);
  var arrows = Board.arrowIndices(board);

  if (free.length === 0) {
    if (arrows.length === 0) {
      return { found: false, done: true, idx: -1, reason: "The board is already clear." };
    }
    var stuck = [];
    for (var s = 0; s < arrows.length; s++) {
      var b = firstBlocker(board, arrows[s]);
      stuck.push({
        idx: arrows[s],
        dir: board.cells[arrows[s]],
        dirName: Board.DIR_NAMES[board.cells[arrows[s]]],
        blockedBy: b,
        blockerKind: b < 0 ? "none" : (board.cells[b] === WALL ? "wall" : "arrow")
      });
    }
    return {
      found: false,
      done: false,
      idx: -1,
      stuck: stuck,
      reason: "Deadlock: all " + arrows.length + " remaining arrow(s) are blocked, so no " +
        "tap can be proven safe. This board cannot be cleared from here."
    };
  }

  /* how many blocked arrows does removing candidate c unblock? */
  var blockedArrows = [];
  for (var q = 0; q < arrows.length; q++) {
    if (!isFree(board, arrows[q])) blockedArrows.push(arrows[q]);
  }

  var best = -1;
  var bestUnlocks = -1;
  for (var f = 0; f < free.length; f++) {
    var cand = free[f];
    var unlocks = 0;
    for (var t = 0; t < blockedArrows.length; t++) {
      var ray = rayCells(board, blockedArrows[t]);
      for (var y = 0; y < ray.length; y++) {
        if (ray[y] === cand) { unlocks++; break; }
      }
    }
    if (unlocks > bestUnlocks) { bestUnlocks = unlocks; best = cand; }
  }

  /* Final proof gate: re-scan the whole ray. If this ever fails, refuse to
     name any cell rather than name a blocked one. */
  if (best < 0 || !isFree(board, best)) {
    for (var z = 0; z < free.length; z++) {
      if (isFree(board, free[z])) { best = free[z]; bestUnlocks = 0; break; }
    }
    if (best < 0 || !isFree(board, best)) {
      return { found: false, done: false, idx: -1, reason: "No move can be proven safe." };
    }
  }

  var dir = board.cells[best];
  var rayNow = rayCells(board, best);
  return {
    found: true,
    idx: best,
    x: best % board.w,
    y: (best / board.w) | 0,
    dir: dir,
    dirName: Board.DIR_NAMES[dir],
    ray: rayNow,
    rayLength: rayNow.length,
    unlocks: bestUnlocks,
    freeCount: free.length,
    reason: "The " + Board.DIR_NAMES[dir] + " arrow at (" + (best % board.w) + "," +
      (((best / board.w) | 0)) + ") has " + rayNow.length +
      " cell(s) ahead of it and every one of them is empty, so it flies off."
  };
}

/* --------------------------------------------- independent oracle (proof) */

/* exhaustive(board, opts) — the INDEPENDENT decision procedure the greedy
   closure is checked against. Depth-first over every reachable state, tapping
   ONE legal arrow at a time in every possible order, memoised on the board
   key. Exponential, so it is for small boards only (the tests cap arrows at
   ~12, i.e. <= 4096 states).

   It answers three things the greedy closure asserts but cannot prove about
   itself:
     solvable    is SOME sequence of legal taps able to empty the board?
     confluent   do ALL maximal sequences end in the SAME terminal state?
     terminals   how many distinct terminal states exist (1 iff confluent).

   If the spec's monotonicity claim holds, terminals === 1 always, and
   solvable === solve(board).solved always. If either ever fails, the claim is
   wrong and the design has to be revisited — which is why this is in the
   shipped file and not only in the test. */
function exhaustive(board, opts) {
  var o = opts || {};
  var cap = o.maxStates === undefined ? 400000 : o.maxStates;
  var memo = new Map();
  var terminals = new Set();
  var visited = 0;
  var truncated = false;

  function keyOf(cells) {
    var s = "";
    for (var i = 0; i < cells.length; i++) {
      var v = cells[i];
      s += v === OPEN ? "-" : (v === WALL ? "#" : String(v));
    }
    return s;
  }

  function rec(cells) {
    var k = keyOf(cells);
    var hit = memo.get(k);
    if (hit !== undefined) return hit;
    if (visited >= cap) { truncated = true; return false; }
    visited++;

    var probe = { w: board.w, h: board.h, mask: board.mask, cells: cells };
    /* Move generation deliberately goes through blockedIndependent, NOT
       freeSet: the oracle must not share a code path with the thing it is
       auditing, or an agreement between them proves nothing. */
    var moves = [];
    for (var mi = 0; mi < cells.length; mi++) {
      var mv = blockedIndependent(probe, mi);
      if (mv.arrow && !mv.blocked) moves.push(mi);
    }
    var solvable;
    if (moves.length === 0) {
      terminals.add(k);
      solvable = Board.countArrows(probe) === 0;
    } else {
      solvable = false;
      for (var m = 0; m < moves.length; m++) {
        var next = new Int8Array(cells);
        next[moves[m]] = OPEN;
        if (rec(next)) solvable = true;
        if (truncated) break;
      }
    }
    memo.set(k, solvable);
    return solvable;
  }

  var solvable = rec(new Int8Array(board.cells));
  return {
    solvable: solvable,
    states: visited,
    terminalCount: terminals.size,
    confluent: terminals.size === 1,
    terminals: Array.from(terminals),
    truncated: truncated
  };
}

/* Randomized legal play: tap uniformly random FREE arrows until none is free.
   Under confluence this must always reach the same terminal state as solve().
   `rand` is any () -> [0,1) function, so the caller supplies the seeded one. */
function randomPlay(board, rand) {
  var work = Board.clone(board);
  var taps = [];
  for (;;) {
    var free = freeSet(work);
    if (free.length === 0) break;
    var pick = free[Math.min(free.length - 1, (rand() * free.length) | 0)];
    taps.push(pick);
    work.cells[pick] = OPEN;
  }
  return {
    cleared: Board.countArrows(work) === 0,
    remaining: Board.countArrows(work),
    taps: taps,
    terminal: work,
    terminalKey: Board.key(work)
  };
}

var API = {
  rayCells: rayCells,
  rayLength: rayLength,
  isFree: isFree,
  firstBlocker: firstBlocker,
  blockedIndependent: blockedIndependent,
  freeSet: freeSet,
  solve: solve,
  replay: replay,
  grade: grade,
  hint: hint,
  checkAgainstTruth: checkAgainstTruth,
  exhaustive: exhaustive,
  randomPlay: randomPlay,
  effortOf: effortOf,
  EFFORT_WEIGHTS: EFFORT_WEIGHTS
};

root.FlightpathSolver = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);

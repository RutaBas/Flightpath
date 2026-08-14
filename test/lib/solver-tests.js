"use strict";
/* (a) monotonicity / confluence, (b) soundness. */

var H = require("./harness.js");
var Board = H.Board, Solver = H.Solver, Gen = H.Gen, Rng = H.Rng;

/* ------------------------------------------------------------ board model */

function testBoardModel() {
  H.section("board model + encoding");
  var b = Board.createBoard(4, 3, {});
  b.cells[0] = Board.N; b.cells[5] = Board.WALL; b.cells[7] = Board.W; b.mask[11] = 0;
  var s = Board.serialize(b);
  H.ok(s === "FP1;4;3;N----#-W---.", "serialize is the documented format (" + s + ")");
  H.ok(Board.serialize(Board.deserialize(s)) === s, "serialize/deserialize round-trips");
  H.ok(Board.equals(b, Board.deserialize(s)), "deserialize reproduces an equal board");
  var c = Board.clone(b);
  c.cells[0] = Board.OPEN;
  H.ok(b.cells[0] === Board.N, "clone is deep — mutating the copy leaves the original alone");
  H.ok(Board.hash(b) === Board.hash(Board.deserialize(s)), "hash is stable across a round-trip");
  H.ok(Board.hash(b) !== Board.hash(c), "hash changes when a cell changes");
  H.ok(Board.validate(b).ok, "validate accepts a well-formed board");
  var bad = Board.clone(b); bad.cells[11] = Board.WALL;
  H.ok(!Board.validate(bad).ok, "validate rejects a wall sitting in open sky");
  var e = Board.createBoard(3, 3, {});
  H.ok(Board.countArrows(e) === 0 && Solver.solve(e).solved, "an empty board is trivially solved");
}

/* ------------------------------------------------------- (b) ray soundness */

function testRayGeometry() {
  H.section("(b) ray geometry and isFree soundness");
  var b = Board.deserialize("FP1;3;3;---------");
  b.cells[4] = Board.N;
  H.ok(JSON.stringify(Solver.rayCells(b, 4)) === "[1]", "N ray from the middle is [1]");
  b.cells[4] = Board.S;
  H.ok(JSON.stringify(Solver.rayCells(b, 4)) === "[7]", "S ray from the middle is [7]");
  b.cells[4] = Board.E;
  H.ok(JSON.stringify(Solver.rayCells(b, 4)) === "[5]", "E ray from the middle is [5]");
  b.cells[4] = Board.W;
  H.ok(JSON.stringify(Solver.rayCells(b, 4)) === "[3]", "W ray from the middle is [3]");

  var edge = Board.deserialize("FP1;3;3;N--------");
  H.ok(Solver.rayCells(edge, 0).length === 0, "an edge arrow pointing out has an empty ray");
  H.ok(Solver.isFree(edge, 0), "...and is therefore free");

  var over = Board.deserialize("FP1;3;1;E.-");
  H.ok(Solver.isFree(over, 0), "sky does not block — an arrow flies over it");

  var wall = Board.deserialize("FP1;3;1;E#-");
  H.ok(!Solver.isFree(wall, 0), "a wall blocks");
  var far = Board.deserialize("FP1;4;1;E--#");
  H.ok(!Solver.isFree(far, 0), "a blocker at the FAR end of the ray still blocks (full scan)");
  var face = Board.deserialize("FP1;2;1;EW");
  H.ok(!Solver.isFree(face, 0) && !Solver.isFree(face, 1), "two arrows facing each other are both stuck");
}

/* isFree vs an independently written scan, plus hint discipline, over many
   random boards AND every intermediate state of their solve. */
function testSoundnessRandom(samples) {
  H.section("(b) isFree vs independent brute-force scan, and hint discipline");
  var rng = Rng.makeRng("flightpath|test|soundness");
  var checkedCells = 0, checkedHints = 0, states = 0, disagreements = 0, badHints = 0;

  for (var t = 0; t < samples; t++) {
    var b = H.randomSmallBoard(rng, { wMax: 5, hMax: 5, maxArrows: 12 });
    var work = Board.clone(b);
    for (;;) {
      states++;
      var arrows = Board.arrowIndices(work);
      for (var a = 0; a < arrows.length; a++) {
        var i = arrows[a];
        var mine = Solver.isFree(work, i);
        var theirs = !Solver.blockedIndependent(work, i).blocked;
        checkedCells++;
        if (mine !== theirs) {
          disagreements++;
          if (disagreements === 1) {
            H.stop("isFree disagrees with the independent scan",
              Board.toAscii(work) + "\n  cell " + i + " isFree=" + mine + " independent=" + theirs);
          }
        }
      }
      var hint = Solver.hint(work);
      checkedHints++;
      if (hint.found) {
        if (Solver.blockedIndependent(work, hint.idx).blocked) {
          badHints++;
          if (badHints === 1) {
            H.stop("hint named a BLOCKED arrow",
              Board.toAscii(work) + "\n  hint idx " + hint.idx);
          }
        }
      } else if (arrows.length > 0) {
        /* refusing to hint is only allowed when nothing at all is free */
        if (Solver.freeSet(work).length !== 0) {
          badHints++;
          H.stop("hint refused while a provably free arrow existed", Board.toAscii(work));
        }
      }
      var free = Solver.freeSet(work);
      if (!free.length) break;
      work.cells[free[Rng.randInt(rng, free.length)]] = Board.OPEN;
    }
  }
  H.info("boards=" + samples + " intermediate states=" + states +
    " arrow-freeness checks=" + checkedCells + " hint calls=" + checkedHints);
  H.ok(disagreements === 0, "isFree agreed with the independent scan on every check");
  H.ok(badHints === 0, "hint never named a blocked arrow and never refused a provable move");
}

/* -------------------------------------------- (a) exhaustive vs the closure */

function testExhaustiveAgreement(samples) {
  H.section("(a) exhaustive state-space search vs the greedy closure");
  var rng = Rng.makeRng("flightpath|test|exhaustive");
  var solvable = 0, unsolvable = 0, disagree = 0, nonConfluent = 0;
  var terminalMismatch = 0, truncated = 0, totalStates = 0, maxStates = 0;

  function check(b, label) {
    var ex = Solver.exhaustive(b, { maxStates: 300000 });
    if (ex.truncated) { truncated++; return; }
    totalStates += ex.states;
    if (ex.states > maxStates) maxStates = ex.states;
    var res = Solver.solve(b);
    if (ex.solvable) solvable++; else unsolvable++;
    if (ex.solvable !== res.solved) {
      disagree++;
      if (disagree === 1) {
        H.stop("exhaustive search and greedy closure DISAGREE on solvability — " +
          "SPEC.md's monotonicity claim is false",
          label + "\n" + Board.toAscii(b) + "\n  exhaustive.solvable=" + ex.solvable +
          " greedy.solved=" + res.solved);
      }
    }
    if (!ex.confluent) {
      nonConfluent++;
      if (nonConfluent === 1) {
        H.stop("the rewriting system is NOT confluent: " + ex.terminalCount +
          " distinct terminal states — a board could be bricked by bad play",
          label + "\n" + Board.toAscii(b));
      }
    } else if (ex.terminals[0] !== H.cellsKey(res.terminal.cells)) {
      terminalMismatch++;
      if (terminalMismatch === 1) {
        H.stop("the closure's terminal state differs from the exhaustive one",
          label + "\n" + Board.toAscii(b));
      }
    }
  }

  /* hand-built deadlocks: the two shapes SPEC.md calls out */
  check(Board.deserialize("FP1;2;1;EW"), "two arrows facing each other");
  check(Board.deserialize("FP1;3;1;E#W"), "arrows pointing into a wall from both sides");
  check(Board.deserialize("FP1;3;3;-S---#---"), "arrow pointing into a wall, no way out");
  check(Board.deserialize("FP1;2;2;SEWN"), "a four-arrow cycle");
  check(Board.deserialize("FP1;3;3;-S-E-W-N-"), "a pinwheel of four");

  for (var t = 0; t < samples; t++) {
    check(H.randomSmallBoard(rng, { wMax: 4, hMax: 4, maxArrows: 9 }), "random small board #" + t);
  }
  /* half the sample deliberately from SOLVABLE constructions, so agreement is
     tested on both answers rather than only on deadlock */
  var built = 0;
  for (var s = 0; s < samples; s++) {
    var cand = Gen.buildCandidate(H.TINY_SPEC, Rng.makeRng("flightpath|tiny|" + s));
    if (!cand) continue;
    built++;
    check(cand.board, "reverse-constructed tiny board #" + s);
  }

  H.info("boards checked=" + (solvable + unsolvable) + " (solvable=" + solvable +
    ", unsolvable=" + unsolvable + ", constructed=" + built + ", truncated=" + truncated + ")");
  H.info("states explored=" + totalStates + " worst single board=" + maxStates);
  H.ok(solvable > 100 && unsolvable > 100,
    "the sample contains plenty of BOTH solvable and unsolvable boards");
  H.ok(disagree === 0, "exhaustive search and greedy closure agree on solvability, every board");
  H.ok(nonConfluent === 0, "every board is confluent — exactly one terminal state exists");
  H.ok(terminalMismatch === 0, "the closure's terminal state is the exhaustive one");
}

/* Randomised legal play must always reach the same terminal state. */
function testRandomPlay(boards, playsEach) {
  H.section("(a) randomised legal play always lands on the same terminal state");
  var rng = Rng.makeRng("flightpath|test|play");
  var mismatch = 0, notCleared = 0, plays = 0;
  for (var i = 0; i < boards.length; i++) {
    var b = boards[i];
    var expect = Board.key(Solver.solve(b).terminal);
    for (var p = 0; p < playsEach; p++) {
      var r = Solver.randomPlay(b, rng);
      plays++;
      if (r.terminalKey !== expect) mismatch++;
      if (!r.cleared) notCleared++;
    }
  }
  H.info("certified boards=" + boards.length + " random plays=" + plays);
  H.ok(mismatch === 0, "every random legal play reached the closure's terminal state");
  H.ok(notCleared === 0, "every random legal play CLEARED a certified board (no bricking)");
}

/* ---------------------------------------------- ground-truth mode has teeth */

function testGroundTruth() {
  H.section("ground-truth mode (checkAgainstTruth)");
  var cand = Gen.buildCandidate(H.TINY_SPEC, Rng.makeRng("flightpath|truth|1"));
  H.ok(!!cand, "built a tiny board to check truth mode against");
  var good = Solver.checkAgainstTruth(cand.board, { order: cand.order });
  H.ok(good.sound, "the construction order is legal play and the solver agrees: " + good.message);

  var lie = Solver.checkAgainstTruth(cand.board, { solvable: false });
  H.ok(!lie.sound && lie.violations.length > 0,
    "a FALSE ground truth is caught (mode has teeth): " + (lie.violations[0] || {}).kind);

  var bogus = Solver.checkAgainstTruth(cand.board, { order: cand.order.slice().reverse() });
  H.ok(!bogus.sound, "an illegal 'known-good' order is rejected, not trusted: " +
    (bogus.violations[0] || {}).kind);

  var dead = Board.deserialize("FP1;2;1;EW");
  var deadChk = Solver.checkAgainstTruth(dead, true);
  H.ok(!deadChk.sound, "asserting a deadlocked board is solvable is caught");
  var h = Solver.hint(dead);
  H.ok(!h.found && h.stuck && h.stuck.length === 2 && /Deadlock/.test(h.reason),
    "hint explains a deadlock instead of guessing: " + h.reason);
}

/* --------------------------------------------------------- effort monotone */

function testEffortMonotone() {
  H.section("effort formula is monotone in every documented term");
  var base = { depth: 6, minRoundWidth: 3, trapFraction: 0.4, meanRay: 2, arrows: 24 };
  var e0 = Solver.effortOf(base);
  function bump(k, v) { var c = Object.assign({}, base); c[k] = v; return Solver.effortOf(c); }
  H.ok(bump("depth", 7) > e0, "effort increases with depth");
  H.ok(bump("trapFraction", 0.5) > e0, "effort increases with trapFraction");
  H.ok(bump("meanRay", 3) > e0, "effort increases with meanRay");
  H.ok(bump("arrows", 25) > e0, "effort increases with arrow count");
  H.ok(bump("minRoundWidth", 2) > e0, "effort increases as minRoundWidth TIGHTENS");
  H.ok(bump("minRoundWidth", 4) < e0, "effort decreases as minRoundWidth loosens");
  H.ok(Solver.effortOf({ depth: 0, minRoundWidth: 0, trapFraction: 0, meanRay: 0, arrows: 0 }) === 0,
    "an empty board costs 0 effort");
  H.info("one extra round = " + (bump("depth", 7) - e0).toFixed(1) +
    " pts; ten extra arrows = " + (bump("arrows", 34) - e0).toFixed(1) +
    " pts (depth deliberately dominates size)");
}

module.exports = {
  testBoardModel: testBoardModel,
  testRayGeometry: testRayGeometry,
  testSoundnessRandom: testSoundnessRandom,
  testExhaustiveAgreement: testExhaustiveAgreement,
  testRandomPlay: testRandomPlay,
  testGroundTruth: testGroundTruth,
  testEffortMonotone: testEffortMonotone
};

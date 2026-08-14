"use strict";
/* Shared assertions, statistics and random-board helpers for the flightpath
   logic tests. No DOM, node only. */

var path = require("path");
var JS = path.join(__dirname, "..", "..", "js");
var Board = require(path.join(JS, "board.js"));
var Solver = require(path.join(JS, "solver.js"));
var Gen = require(path.join(JS, "generator.js"));
var Rng = require(path.join(JS, "rng.js"));

var state = { pass: 0, fail: 0, failures: [], stopped: null };

function section(name) {
  console.log("\n=== " + name + " " + "=".repeat(Math.max(0, 62 - name.length)));
}

function ok(cond, msg) {
  if (cond) { state.pass++; return true; }
  state.fail++;
  state.failures.push(msg);
  console.log("  FAIL: " + msg);
  return false;
}

/* A disagreement that falsifies the spec, not a normal test failure. */
function stop(msg, detail) {
  state.stopped = { msg: msg, detail: detail };
  state.fail++;
  state.failures.push("STOP: " + msg);
  console.log("\n!!! STOP — " + msg);
  if (detail) console.log(detail);
}

function info(msg) { console.log("  " + msg); }

function pct(arr, p) {
  if (!arr.length) return NaN;
  var s = arr.slice().sort(function (a, b) { return a - b; });
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
function mean(arr) {
  if (!arr.length) return NaN;
  var t = 0;
  for (var i = 0; i < arr.length; i++) t += arr[i];
  return t / arr.length;
}
function stdev(arr) {
  if (arr.length < 2) return 0;
  var m = mean(arr), t = 0;
  for (var i = 0; i < arr.length; i++) t += (arr[i] - m) * (arr[i] - m);
  return Math.sqrt(t / (arr.length - 1));
}
function spread(arr) {
  return "min=" + Math.min.apply(null, arr) + " p25=" + pct(arr, 0.25) +
    " med=" + pct(arr, 0.5) + " p75=" + pct(arr, 0.75) +
    " max=" + Math.max.apply(null, arr) + " mean=" + (Math.round(mean(arr) * 100) / 100);
}
function pearson(xs, ys) {
  var mx = mean(xs), my = mean(ys), num = 0, dx = 0, dy = 0;
  for (var i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) * (xs[i] - mx);
    dy += (ys[i] - my) * (ys[i] - my);
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

/* The same cell encoding solver.exhaustive() memoises on, so a terminal state
   from the exhaustive search can be compared with one from the greedy closure. */
function cellsKey(cells) {
  var s = "";
  for (var i = 0; i < cells.length; i++) {
    var v = cells[i];
    s += v === Board.OPEN ? "-" : (v === Board.WALL ? "#" : String(v));
  }
  return s;
}

/* A random SMALL board — deliberately unconstrained, so most come out
   deadlocked. That is the point: the exhaustive/greedy agreement has to hold
   on unsolvable boards too, not just on generated ones. */
function randomSmallBoard(rng, opts) {
  var o = opts || {};
  var w = (o.w || 2) + Rng.randInt(rng, (o.wMax || 4) - (o.w || 2) + 1);
  var h = (o.h || 2) + Rng.randInt(rng, (o.hMax || 4) - (o.h || 2) + 1);
  var n = w * h;
  var b = Board.createBoard(w, h, {});
  var i;
  var masked = [];
  for (i = 0; i < n; i++) {
    b.mask[i] = rng() < (o.maskProb === undefined ? 0.85 : o.maskProb) ? 1 : 0;
    if (b.mask[i]) masked.push(i);
  }
  if (masked.length < 2) { b.mask[0] = 1; masked = [0]; }
  Rng.shuffle(masked, rng);
  var walls = Rng.randInt(rng, Math.min(3, masked.length));
  var cursor = 0;
  for (i = 0; i < walls; i++) b.cells[masked[cursor++]] = Board.WALL;
  var room = masked.length - cursor;
  var maxA = o.maxArrows === undefined ? 10 : o.maxArrows;
  var arrows = Math.min(room, 1 + Rng.randInt(rng, Math.max(1, Math.min(maxA, room))));
  for (i = 0; i < arrows; i++) b.cells[masked[cursor++]] = Rng.randInt(rng, 4);
  return b;
}

/* Small SOLVABLE boards, via the generator's own reverse construction with a
   deliberately loose spec (no band), so the agreement sample is not all
   deadlock. */
var TINY_SPEC = {
  tier: 0, name: "tiny", w: 4, h: 4,
  arrows: [5, 9], walls: [0, 2], depth: [1, 99],
  minRoundWidth: [1, 99], effort: [-1e9, 1e9], sky: [0, 3],
  aim: [2, 6], bias: { block: [0.5, 2.2], ray: [-0.3, 0.6] }, attempts: 1
};

module.exports = {
  Board: Board, Solver: Solver, Gen: Gen, Rng: Rng,
  state: state, section: section, ok: ok, stop: stop, info: info,
  pct: pct, mean: mean, stdev: stdev, spread: spread, pearson: pearson,
  cellsKey: cellsKey, randomSmallBoard: randomSmallBoard, TINY_SPEC: TINY_SPEC
};

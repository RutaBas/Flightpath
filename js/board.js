"use strict";
/* One IIFE per logic file — matches BULLPEN / STRATA module style. */
(function (root) {

/* FLIGHTPATH — board model and encoding.

   Pure data. No DOM, no randomness, no I/O. Runs under node and in a page.

   A board is { w, h, mask, cells }:

     mask[i]   1 if cell i is part of the playable shape, 0 if it is OPEN SKY.
               Sky is not a blocker and is not a place anything can sit; arrows
               fly straight over it. The shape may be irregular.
     cells[i]  one of
                 OPEN (-1)  masked, empty, blocks nothing
                 WALL (-2)  masked, immovable, blocks every ray forever
                 0..3       an arrow pointing N, E, S, W

   INVARIANT: mask[i] === 0  =>  cells[i] === OPEN. Sky can never hold anything.
   validate() enforces it; the generator and deserialize both maintain it.

   Direction numbering is fixed by the spec: 0=N, 1=E, 2=S, 3=W. DELTA is in
   (dx, dy) with y growing DOWNWARD (row-major grid, row 0 at the top).

   ENCODING
     serialize -> "FP1;w;h;<body>", one character per cell in row-major order:
       '.'  sky (mask 0)
       '-'  masked open
       '#'  wall
       'N' 'E' 'S' 'W'  arrow
     Compact, diffable, readable in a bug report. deserialize is its exact
     inverse; serialize(deserialize(s)) === s is a test.

   DUPLICATE DETECTION
     key(board)   -> the serialized string. Two boards are the same board iff
                     their keys match (shape, walls, arrows and directions all
                     ride in the string). Use this in a Set/Map.
     hash(board)  -> uint32 of the key, for cheap bucketing. Hashes can collide;
                     equals and key cannot. A duplicate check must ultimately
                     compare keys, not hashes. */

var isNode = typeof module !== "undefined" && module.exports;
var Rng = isNode ? require("./rng.js") : root.FlightpathRng;

var OPEN = -1;
var WALL = -2;

var N = 0, E = 1, S = 2, W = 3;
var DIRS = [N, E, S, W];
var DIR_NAMES = ["N", "E", "S", "W"];
var DIR_CHARS = ["N", "E", "S", "W"];
/* (dx, dy), y increases downward. */
var DELTA = [[0, -1], [1, 0], [0, 1], [-1, 0]];

function isArrow(v) { return v >= 0 && v <= 3; }
function isWall(v) { return v === WALL; }

/* ------------------------------------------------------------ construction */

/* createBoard(w, h, opts)
     opts.mask   optional array of 0/1, length w*h (default: all 1)
     opts.cells  optional array of cell values (default: all OPEN)
   Always returns fresh typed arrays; nothing is shared with the caller. */
function createBoard(w, h, opts) {
  var o = opts || {};
  var n = w * h;
  var mask = new Uint8Array(n);
  var cells = new Int8Array(n);
  var i;
  for (i = 0; i < n; i++) {
    mask[i] = o.mask ? (o.mask[i] ? 1 : 0) : 1;
    cells[i] = o.cells ? o.cells[i] : OPEN;
    if (!mask[i]) cells[i] = OPEN;
  }
  return { w: w, h: h, mask: mask, cells: cells };
}

function clone(board) {
  return {
    w: board.w,
    h: board.h,
    mask: new Uint8Array(board.mask),
    cells: new Int8Array(board.cells)
  };
}

/* --------------------------------------------------------------- accessors */

function idx(board, x, y) { return y * board.w + x; }
function xOf(board, i) { return i % board.w; }
function yOf(board, i) { return (i / board.w) | 0; }
function xy(board, i) { return { x: i % board.w, y: (i / board.w) | 0 }; }
function inBounds(board, x, y) { return x >= 0 && y >= 0 && x < board.w && y < board.h; }
function inMask(board, i) { return board.mask[i] === 1; }

function arrowIndices(board) {
  var out = [];
  for (var i = 0; i < board.cells.length; i++) if (isArrow(board.cells[i])) out.push(i);
  return out;
}
function countArrows(board) {
  var n = 0;
  for (var i = 0; i < board.cells.length; i++) if (isArrow(board.cells[i])) n++;
  return n;
}
function countWalls(board) {
  var n = 0;
  for (var i = 0; i < board.cells.length; i++) if (board.cells[i] === WALL) n++;
  return n;
}
function countMasked(board) {
  var n = 0;
  for (var i = 0; i < board.mask.length; i++) if (board.mask[i]) n++;
  return n;
}
function countSky(board) { return board.mask.length - countMasked(board); }

/* -------------------------------------------------------------- validation */

/* Structural sanity only — says nothing about solvability. */
function validate(board) {
  var errs = [];
  if (!board || typeof board.w !== "number" || typeof board.h !== "number") {
    return { ok: false, errors: ["not a board"] };
  }
  var n = board.w * board.h;
  if (board.w <= 0 || board.h <= 0) errs.push("non-positive dimension");
  if (board.mask.length !== n) errs.push("mask length " + board.mask.length + " != " + n);
  if (board.cells.length !== n) errs.push("cells length " + board.cells.length + " != " + n);
  var lim = Math.min(n, board.cells.length);
  for (var i = 0; i < lim; i++) {
    var v = board.cells[i];
    if (v !== OPEN && v !== WALL && !isArrow(v)) errs.push("cell " + i + " has bad value " + v);
    if (!board.mask[i] && v !== OPEN) errs.push("cell " + i + " is sky but holds " + v);
  }
  return { ok: errs.length === 0, errors: errs };
}

/* ---------------------------------------------------------------- encoding */

function cellChar(board, i) {
  if (!board.mask[i]) return ".";
  var v = board.cells[i];
  if (v === WALL) return "#";
  if (isArrow(v)) return DIR_CHARS[v];
  return "-";
}

function serialize(board) {
  var body = "";
  for (var i = 0; i < board.cells.length; i++) body += cellChar(board, i);
  return "FP1;" + board.w + ";" + board.h + ";" + body;
}

function deserialize(str) {
  var parts = String(str).split(";");
  if (parts.length !== 4 || parts[0] !== "FP1") throw new Error("bad board string: " + str);
  var w = parseInt(parts[1], 10);
  var h = parseInt(parts[2], 10);
  var body = parts[3];
  if (!(w > 0) || !(h > 0)) throw new Error("bad board dimensions: " + str);
  if (body.length !== w * h) {
    throw new Error("board body length " + body.length + " != " + (w * h));
  }
  var board = createBoard(w, h, {});
  for (var i = 0; i < body.length; i++) {
    var c = body.charAt(i);
    if (c === ".") { board.mask[i] = 0; board.cells[i] = OPEN; continue; }
    board.mask[i] = 1;
    if (c === "-") { board.cells[i] = OPEN; continue; }
    if (c === "#") { board.cells[i] = WALL; continue; }
    var d = DIR_CHARS.indexOf(c);
    if (d < 0) throw new Error("bad cell char at index " + i + " in " + str);
    board.cells[i] = d;
  }
  return board;
}

/* ------------------------------------------------ identity / dedupe helpers */

function key(board) { return serialize(board); }

function hash(board) { return Rng.hashSeed(key(board)); }

function equals(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.w !== b.w || a.h !== b.h) return false;
  if (a.cells.length !== b.cells.length) return false;
  for (var i = 0; i < a.cells.length; i++) {
    if (a.mask[i] !== b.mask[i]) return false;
    if (a.cells[i] !== b.cells[i]) return false;
  }
  return true;
}

/* Structural fingerprint that IGNORES arrow directions — used by the variety
   check to prove the shape and the wall/arrow layout vary, not just the
   letters printed on the arrows. */
function shapeKey(board) {
  var s = "";
  for (var i = 0; i < board.cells.length; i++) {
    if (!board.mask[i]) { s += "."; continue; }
    if (board.cells[i] === WALL) { s += "#"; continue; }
    s += isArrow(board.cells[i]) ? "a" : "-";
  }
  return board.w + "x" + board.h + ":" + s;
}

/* Fingerprint of the playable shape alone (mask only). */
function maskKey(board) {
  var s = "";
  for (var i = 0; i < board.mask.length; i++) s += board.mask[i] ? "1" : "0";
  return board.w + "x" + board.h + ":" + s;
}

/* --------------------------------------------------------------- debugging */

function toAscii(board) {
  var out = [];
  for (var y = 0; y < board.h; y++) {
    var line = "";
    for (var x = 0; x < board.w; x++) line += cellChar(board, y * board.w + x);
    out.push(line);
  }
  return out.join("\n");
}

var API = {
  OPEN: OPEN,
  WALL: WALL,
  N: N, E: E, S: S, W: W,
  DIRS: DIRS,
  DIR_NAMES: DIR_NAMES,
  DIR_CHARS: DIR_CHARS,
  DELTA: DELTA,
  isArrow: isArrow,
  isWall: isWall,
  createBoard: createBoard,
  clone: clone,
  idx: idx,
  xOf: xOf,
  yOf: yOf,
  xy: xy,
  inBounds: inBounds,
  inMask: inMask,
  arrowIndices: arrowIndices,
  countArrows: countArrows,
  countWalls: countWalls,
  countMasked: countMasked,
  countSky: countSky,
  validate: validate,
  serialize: serialize,
  deserialize: deserialize,
  key: key,
  hash: hash,
  equals: equals,
  shapeKey: shapeKey,
  maskKey: maskKey,
  toAscii: toAscii
};

root.FlightpathBoard = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);

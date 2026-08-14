"use strict";
/* One IIFE per logic file — matches BULLPEN / STRATA module style. */
(function (root) {

/* FLIGHTPATH — board generation, gated by the solver.

   The order of operations is not negotiable. A candidate is only a level once
   solve()/grade() — run from scratch on the finished board, knowing nothing
   about how it was built — says it clears with no deadlock AND lands inside
   the requested tier's exact band. Nothing here nudges a board to fit a tier;
   the solver is the arbiter and anything it will not certify is thrown away.

   THE APPROACH — reverse construction (solvable BY CONSTRUCTION).

     1. Shape. Carve `sky` cells out of the tier's w x h rectangle, keeping the
        masked region 4-connected. Sky is not a blocker; it is where arrows
        fly over nothing.
     2. Walls, before any arrow. Walls are permanent blockers and must be on
        the board while arrows are being placed, or the construction guarantee
        is void.
     3. Arrows, in REVERSE removal order. Place the arrow that will leave LAST
        first. Every newly placed arrow must have a ray clear of everything
        already on the board (walls + earlier-placed arrows).

        Why that certifies solvability: let the placement order be a1..an.
        When ak was placed, its ray was clear of {walls, a1..a(k-1)}. So on the
        finished board, remove an, then a(n-1), ... down to a1: at the moment
        ak is tapped the only things left are walls and a1..ak, which is
        exactly the configuration its ray was checked against. Every tap is
        legal. Therefore reverse(placement) is a valid clearing order and the
        board can never deadlock. That order is returned as
        `constructionOrder`, and the solver REPLAYS it as an independent
        certificate — it is validated, not trusted.

     4. Re-grade from scratch and gate. Construction proves only that SOME
        order exists; it says nothing about depth, bottlenecks or traps, which
        are whatever fell out. grade() re-derives every metric and the
        candidate is DISCARDED unless it is inside the target band. The match
        is exact-band, never "at least this hard": a tier-1 board that grades
        tier-3 is a bug, not a bonus, and is rejected.

   THE SEARCH BIAS (proposal distribution only — never the gate)

     Uniformly random reverse construction makes SHALLOW boards: measured over
     800 raw candidates on the largest grid the median depth was 7 and the maximum 13, against
     a tier-5 band of 13+. The reason is structural. Depth is the longest chain
     in the "is blocked by" DAG, and depth only grows when a new arrow lands on
     the ray of a currently-FREE arrow: that pushes the free arrow from round 1
     to round 2 and shifts everything already depending on it up by one.
     Scattering blockers across many different arrows makes the board WIDE, not
     deep.

     So construction maintains the partial board's exact round numbers
     incrementally (round[p] = 1 + max round of the arrows on p's ray) and,
     from those, ripple[p] — how far a +1 bump to p actually travels, following
     only UNIQUE-max blocker edges. A candidate cell c then lengthens the
     longest chain iff some free arrow whose ray crosses c has ripple already
     reaching the current depth. That test is exact, not a heuristic; the
     obvious approximation (the whole dependent closure) over-estimates and was
     measured to stall the chain for 30+ consecutive placements.

     Each attempt samples a target depth from the tier's aim range and runs two
     phases: while the partial depth is under target, chain-lengthening
     placements get weight (1 + 20)^blockBias; once at target, they get 0.02 so
     the board fills out sideways instead. Depth during construction is
     monotone non-decreasing (adding a blocker never lowers a round), which is
     what makes "grow, then coast" a controllable process.

     None of this is trusted. It only decides WHICH boards get proposed; every
     proposal faces the same unmodified gate.

   SEEDING (recipe gotchas 1 and 2)
     Every attempt draws from makeRng(attemptSeed(seed, tier, attempt)) where
     attemptSeed builds ONE string, "flightpath|t3|s47|a12". Level and attempt
     are hashed together, never added, so the level stride cannot alias the
     retry stride and collapse a table into duplicates. The separators make the
     string injective in (tier, seed, attempt). */

var isNode = typeof module !== "undefined" && module.exports;
var Board = isNode ? require("./board.js") : root.FlightpathBoard;
var Solver = isNode ? require("./solver.js") : root.FlightpathSolver;
var Rng = isNode ? require("./rng.js") : root.FlightpathRng;

var makeRng = Rng.makeRng;
var randInt = Rng.randInt;
var shuffle = Rng.shuffle;

var OPEN = Board.OPEN;
var WALL = Board.WALL;

/* --------------------------------------------------------------- the bands */

/* Tier bands. Grid / arrows / walls / depth come straight from SPEC.md's
   table; the rest makes the "notes" column checkable, plus an effort window
   measured from the generator's own output.

   The effort windows overlap slightly at the tails (a small deep board can
   cost as much as a large shallow one — that is real, not an artefact), but
   every tier's MEDIAN effort sits above the previous tier's MAXIMUM, measured
   over 800 candidates per tier: 74 / 95 / 126 / 160 / 216 against maxima of
   87 / 112 / 149 / 190. Tier identity is never ambiguous regardless, because
   the grid size differs per tier and is gated first.

     arrows/walls/depth   inclusive [min, max], from SPEC.md
     minRoundWidth        inclusive [min, max] on the tightest bottleneck.
                          Tier 4's "bottleneck rounds of width 1-2" is [1, 2];
                          other tiers accept anything.
     effort               inclusive [min, max] composite window
     sky                  inclusive [min, max] carved cells (shape variety)
     aim                  depth the proposal distribution steers toward; a
                          sub-range of `depth`, never wider than it. NOT a gate
     bias                 proposal exponents, NOT a gate:
                            block [lo, hi]  weight on chain lengthening
                            ray   [lo, hi]  weight on ray length
     attempts             per-call attempt budget; generate() always returns */
var TIERS = [
  {
    tier: 1, name: "tier-1", w: 4, h: 5,
    arrows: [10, 14], walls: [0, 0], depth: [3, 4],
    minRoundWidth: [1, 99], effort: [52, 92], sky: [0, 3],
    aim: [3, 4], bias: { block: [0.6, 2.0], ray: [-0.4, 0.4] }, attempts: 400
  },
  {
    tier: 2, name: "tier-2", w: 5, h: 6,
    arrows: [16, 22], walls: [0, 0], depth: [4, 6],
    minRoundWidth: [1, 99], effort: [72, 118], sky: [0, 5],
    aim: [4, 6], bias: { block: [0.8, 2.4], ray: [-0.3, 0.5] }, attempts: 400
  },
  {
    tier: 3, name: "tier-3", w: 6, h: 7,
    arrows: [24, 32], walls: [0, 2], depth: [6, 9],
    minRoundWidth: [1, 99], effort: [100, 156], sky: [0, 8],
    aim: [6, 9], bias: { block: [1.0, 2.8], ray: [-0.2, 0.6] }, attempts: 500
  },
  {
    tier: 4, name: "tier-4", w: 6, h: 8,
    arrows: [32, 42], walls: [2, 4], depth: [9, 13],
    minRoundWidth: [1, 2], effort: [140, 200], sky: [0, 10],
    aim: [9, 13], bias: { block: [1.4, 3.2], ray: [-0.1, 0.7] }, attempts: 800
  },
  {
    tier: 5, name: "tier-5", w: 7, h: 9,
    arrows: [44, 58], walls: [3, 6], depth: [13, 26],
    minRoundWidth: [1, 99], effort: [190, 285], sky: [0, 10],
    aim: [14, 20], bias: { block: [1.8, 3.6], ray: [0.0, 0.9] }, attempts: 1200
  }
];

/* tierFor(n) — tiers are 1-BASED, matching SPEC.md's table. */
function tierFor(n) {
  var t = TIERS[(n | 0) - 1];
  if (!t) throw new Error("flightpath: unknown tier " + n + " (tiers are 1..5)");
  return t;
}

/* ------------------------------------------------------------------ seeding */

/* ONE string, never an addition. See the seeding note in the header. */
function attemptSeed(seed, tier, attempt) {
  return "flightpath|t" + tier + "|s" + seed + "|a" + attempt;
}

function levelSeed(levelNumber) {
  return "flightpath|level|" + levelNumber;
}

function dailySeed(dateKey) {
  return "flightpath|daily|" + dateKey;
}

/* --------------------------------------------------------------- the shape */

function maskedConnected(mask, w, h) {
  var n = w * h;
  var start = -1;
  var total = 0;
  for (var i = 0; i < n; i++) if (mask[i]) { total++; if (start < 0) start = i; }
  if (total === 0) return false;
  var seen = new Uint8Array(n);
  var stack = [start];
  seen[start] = 1;
  var count = 0;
  while (stack.length) {
    var c = stack.pop();
    count++;
    var x = c % w, y = (c / w) | 0;
    if (x > 0 && mask[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack.push(c - 1); }
    if (x < w - 1 && mask[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack.push(c + 1); }
    if (y > 0 && mask[c - w] && !seen[c - w]) { seen[c - w] = 1; stack.push(c - w); }
    if (y < h - 1 && mask[c + w] && !seen[c + w]) { seen[c + w] = 1; stack.push(c + w); }
  }
  return count === total;
}

/* Carve `skyTarget` cells, border-first so shapes read as a silhouette rather
   than swiss cheese, never breaking 4-connectivity. Returns how many were
   actually carved (may fall short if every remaining candidate disconnects). */
function carveSky(mask, w, h, skyTarget, rng) {
  if (skyTarget <= 0) return 0;
  var order = [];
  for (var i = 0; i < w * h; i++) order.push(i);
  shuffle(order, rng);
  order.sort(function (a, b) {
    var ad = Math.min(a % w, w - 1 - (a % w), (a / w) | 0, h - 1 - ((a / w) | 0));
    var bd = Math.min(b % w, w - 1 - (b % w), (b / w) | 0, h - 1 - ((b / w) | 0));
    return ad - bd;
  });
  var carved = 0;
  for (var q = 0; q < order.length && carved < skyTarget; q++) {
    var c = order[q];
    if (!mask[c]) continue;
    mask[c] = 0;
    if (!maskedConnected(mask, w, h)) { mask[c] = 1; continue; }
    carved++;
  }
  return carved;
}

/* ----------------------------------------------------- reverse construction */

/* Is a d-facing arrow at cell c launchable on the CURRENT partial board?
   Full scan, the same predicate the solver uses, no early exit. */
function rayClear(board, c, d) {
  var ray = Solver.rayCells(board, c, d);
  var blocked = false;
  for (var k = 0; k < ray.length; k++) {
    var v = board.cells[ray[k]];
    if (v === WALL || Board.isArrow(v)) blocked = true;
  }
  return !blocked;
}

/* Build one candidate. Returns { board, order, ... } where `order` is a
   clearing order (the reverse of the placement order), or null if
   construction stalled short of the tier's arrow minimum. */
function buildCandidate(spec, rng) {
  var w = spec.w, h = spec.h, n = w * h;
  var i, k, r, c, d, p, q;

  var arrowTarget = spec.arrows[0] + randInt(rng, spec.arrows[1] - spec.arrows[0] + 1);
  var wallTarget = spec.walls[0] + randInt(rng, spec.walls[1] - spec.walls[0] + 1);
  var aimDepth = spec.aim[0] + randInt(rng, spec.aim[1] - spec.aim[0] + 1);

  var skyRoom = n - arrowTarget - wallTarget;
  var skyCap = Math.max(0, Math.min(spec.sky[1], skyRoom));
  var skyMin = Math.min(spec.sky[0], skyCap);
  var skyTarget = skyMin + (skyCap > skyMin ? randInt(rng, skyCap - skyMin + 1) : 0);

  var board = Board.createBoard(w, h, {});
  carveSky(board.mask, w, h, skyTarget, rng);

  var masked = [];
  for (i = 0; i < n; i++) if (board.mask[i]) masked.push(i);
  if (masked.length < arrowTarget + wallTarget) return null;

  /* 2. walls first — blockers for the whole construction */
  var wallSlots = shuffle(masked.slice(), rng);
  for (k = 0; k < wallTarget; k++) board.cells[wallSlots[k]] = WALL;

  /* 3. arrows, in reverse removal order */
  var blockBias = spec.bias.block[0] + rng() * (spec.bias.block[1] - spec.bias.block[0]);
  var rayBias = spec.bias.ray[0] + rng() * (spec.bias.ray[1] - spec.bias.ray[0]);

  /* coverList[cell] = the placed arrows whose ray crosses `cell`, i.e. exactly
     the arrows that an arrow placed at `cell` would block. Purely geometric,
     so it never goes stale. */
  var coverList = [];
  for (i = 0; i < n; i++) coverList.push(null);

  /* round[cell] = the exact greedy round of the arrow at `cell` on the CURRENT
     partial board (0 = no arrow). Maintained incrementally: a new arrow starts
     at round 1, and everything it blocks is raised to at least 2, propagating
     up the chain. Rounds are monotone non-decreasing during construction. */
  var round = new Int32Array(n);
  var placement = [];
  var depth = 0;

  function raise(cell, value) {
    if (round[cell] >= value) return;
    round[cell] = value;
    if (value > depth) depth = value;
    var deps = coverList[cell];
    if (!deps) return;
    for (var z = 0; z < deps.length; z++) raise(deps[z], value + 1);
  }

  var ripple = new Int32Array(n);
  var critParent = new Int32Array(n);
  var freeRipple = new Int32Array(n);
  var byRound = [];

  for (var placed = 0; placed < arrowTarget; placed++) {
    /* --- ripple[]: how far a +1 bump actually travels.

       round[q] = 1 + max round over the arrows on q's ray. Raising ONE blocker
       p by one therefore only raises q if p is the UNIQUE blocker sitting at
       round[q]-1; if a second blocker is also there, q stays pinned. So follow
       only those unique-max ("critical") edges, and the depth after blocking a
       free arrow p is exactly max(depth, ripple[p] + 1).

       An earlier version used the whole dependent closure instead, which
       over-estimates the gain and was measured to stall the chain: depth
       flatlined for 30+ consecutive placements because the generator kept
       blocking arrows whose dependents had a second, equally deep blocker. */
    byRound.length = 0;
    for (k = 0; k < placement.length; k++) {
      byRound.push(placement[k]);
      ripple[placement[k]] = round[placement[k]];
      critParent[placement[k]] = -1;
    }
    byRound.sort(function (a, b) { return round[b] - round[a]; });
    for (k = 0; k < placement.length; k++) {
      q = placement[k];
      var qray = Solver.rayCells(board, q);
      var want = round[q] - 1;
      var found = -1, nfound = 0;
      for (r = 0; r < qray.length; r++) {
        if (Board.isArrow(board.cells[qray[r]]) && round[qray[r]] === want) {
          found = qray[r];
          nfound++;
        }
      }
      critParent[q] = nfound === 1 ? found : -1;
    }
    for (k = 0; k < byRound.length; k++) {
      q = byRound[k];
      var pp = critParent[q];
      if (pp >= 0 && ripple[pp] < ripple[q]) ripple[pp] = ripple[q];
    }

    /* --- freeRipple[cell]: the deepest reach among the FREE arrows a blocker
       dropped on `cell` would pin. Only round-1 arrows can be pushed deeper. */
    freeRipple.fill(0);
    for (k = 0; k < placement.length; k++) {
      p = placement[k];
      if (round[p] !== 1) continue;
      var pray = Solver.rayCells(board, p);
      for (r = 0; r < pray.length; r++) {
        if (freeRipple[pray[r]] < ripple[p]) freeRipple[pray[r]] = ripple[p];
      }
    }

    var growing = depth < aimDepth;
    var cands = [];
    var weights = [];
    var total = 0;
    for (var ci = 0; ci < masked.length; ci++) {
      c = masked[ci];
      if (board.cells[c] !== OPEN) continue;
      /* exact: placing here lengthens the longest chain iff it pins a free
         arrow whose critical ripple already reaches the current depth. */
      var gain = depth > 0 && freeRipple[c] >= depth ? 1 : 0;
      for (d = 0; d < 4; d++) {
        if (!rayClear(board, c, d)) continue;
        var len = Solver.rayLength(board, c, d);
        var wgt;
        if (growing) {
          /* An arrow with a ZERO-length ray (on an edge, pointing out) can
             never be blocked by anything, so making one the head of the chain
             caps the depth permanently — measured: depth flatlined at 8 for
             the last 35 of 48 placements. Penalise len 0 hard while growing.
             blockBias is the tier's appetite for depth: at 0.6 a chain-growing
             placement is ~6x more likely, at 3.6 it is ~4000x. */
          wgt = Math.pow(1 + 20 * gain, blockBias) * Math.pow(1 + len, rayBias) *
            (len === 0 ? 0.02 : 1);
        } else {
          /* coasting: fill sideways, and make overshooting the aim rare but
             not impossible (the gate, not this, decides acceptance). */
          wgt = (gain ? 0.02 : 1) * Math.pow(1 + len, rayBias);
        }
        if (!(wgt > 0)) wgt = 1e-9;
        cands.push(c * 4 + d);
        weights.push(wgt);
        total += wgt;
      }
    }
    if (cands.length === 0) break;

    var roll = rng() * total;
    var pick = cands.length - 1;
    for (var z2 = 0; z2 < cands.length; z2++) {
      roll -= weights[z2];
      if (roll <= 0) { pick = z2; break; }
    }
    var cell = (cands[pick] / 4) | 0;
    var dir = cands[pick] % 4;

    board.cells[cell] = dir;
    round[cell] = 1;
    if (depth < 1) depth = 1;
    var nray = Solver.rayCells(board, cell, dir);
    for (r = 0; r < nray.length; r++) {
      if (!coverList[nray[r]]) coverList[nray[r]] = [];
      coverList[nray[r]].push(cell);
    }
    var blocked = coverList[cell];
    if (blocked) for (var b = 0; b < blocked.length; b++) raise(blocked[b], 2);
    placement.push(cell);
  }

  if (placement.length < spec.arrows[0]) return null;

  return {
    board: board,
    order: placement.slice().reverse(),
    blockBias: blockBias,
    rayBias: rayBias,
    aimDepth: aimDepth,
    constructionDepth: depth
  };
}

/* ---------------------------------------------------------------- the gate */

function inBand(v, band) { return v >= band[0] && v <= band[1]; }

/* accepts(spec, board, g) — EXACT band match for the tier that was asked for.
   Returns { ok, reason }. Nothing here knows how the board was built. */
function accepts(spec, board, g) {
  if (board.w !== spec.w || board.h !== spec.h) return { ok: false, reason: "grid" };
  if (!g.solved) return { ok: false, reason: "unsolved" };
  if (g.stuckCount !== 0) return { ok: false, reason: "stuck" };
  if (!inBand(g.arrows, spec.arrows)) return { ok: false, reason: "arrows" };
  if (!inBand(g.walls, spec.walls)) return { ok: false, reason: "walls" };
  if (!inBand(g.depth, spec.depth)) return { ok: false, reason: "depth" };
  if (!inBand(g.minRoundWidth, spec.minRoundWidth)) return { ok: false, reason: "minRoundWidth" };
  if (!inBand(g.effort, spec.effort)) return { ok: false, reason: "effort" };
  return { ok: true, reason: "" };
}

/* ------------------------------------------------------------------ public */

/* generate(seed, tierIndex, opts)
     -> { board, grade, tier, seed, attempts, constructionOrder, key, hash, ... }
     -> { board: null, reason, attempts, rejects } when the budget runs out.
        NEVER throws for an exhausted budget and never loops forever.

   Deterministic: the same (seed, tierIndex) always yields the same board; the
   attempt loop is a pure function of the seed string. tierIndex is 1-based.

     opts.maxAttempts  override the tier's budget
     opts.verifyTruth  default true — run the solver in ground-truth mode
                       against the construction order before accepting. Belt
                       and braces: a board that passed the band gate but fails
                       its own certificate is dropped AND reported. */
function generate(seed, tierIndex, opts) {
  var o = opts || {};
  var spec = tierFor(tierIndex);
  var maxAttempts = o.maxAttempts === undefined ? spec.attempts : o.maxAttempts;
  var verifyTruth = o.verifyTruth === false ? false : true;

  var rejects = {
    build: 0, grid: 0, unsolved: 0, stuck: 0, arrows: 0, walls: 0,
    depth: 0, minRoundWidth: 0, effort: 0, truth: 0
  };
  var soundnessFailures = [];

  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    var rng = makeRng(attemptSeed(seed, spec.tier, attempt));
    var cand = buildCandidate(spec, rng);
    if (!cand) { rejects.build++; continue; }

    /* Independent re-grade: grade() re-runs the whole closure on the finished
       board and knows nothing about the construction. */
    var g = Solver.grade(cand.board);
    var verdict = accepts(spec, cand.board, g);
    if (!verdict.ok) { rejects[verdict.reason]++; continue; }

    if (verifyTruth) {
      var truth = Solver.checkAgainstTruth(cand.board, { order: cand.order });
      if (!truth.sound) {
        rejects.truth++;
        soundnessFailures.push({
          attempt: attempt,
          key: Board.key(cand.board),
          violations: truth.violations
        });
        continue;
      }
    }

    return {
      board: cand.board,
      grade: g,
      tier: spec.tier,
      tierName: spec.name,
      seed: seed,
      attempts: attempt + 1,
      rejects: rejects,
      constructionOrder: cand.order,
      solveOrder: Solver.solve(cand.board).order,
      key: Board.key(cand.board),
      hash: Board.hash(cand.board),
      bias: { block: cand.blockBias, ray: cand.rayBias, aimDepth: cand.aimDepth },
      soundnessFailures: soundnessFailures
    };
  }

  return {
    board: null,
    grade: null,
    tier: spec.tier,
    tierName: spec.name,
    seed: seed,
    attempts: maxAttempts,
    rejects: rejects,
    soundnessFailures: soundnessFailures,
    hitRate: 0,
    reason: "attempt budget exhausted (" + maxAttempts + ") for tier " + spec.tier +
      "; the band was never hit for this seed. Dominant rejection: " +
      Object.keys(rejects).sort(function (a, b) { return rejects[b] - rejects[a]; })[0] +
      " (" + JSON.stringify(rejects) + "). If this is not rare, the band is " +
      "wrong — report the measured hit rate and propose a corrected band rather " +
      "than widening this one silently."
  };
}

/* sweep(tierIndex, seeds, opts) — empirical acceptance measurement, so the
   per-tier hit rate and the depth/effort spread are MEASURED rather than
   assumed. `hitRate` counts candidates, not calls: accepted / candidates is
   the true per-attempt probability. */
function sweep(tierIndex, seeds, opts) {
  var o = opts || {};
  var spec = tierFor(tierIndex);
  var maxAttempts = o.maxAttempts === undefined ? spec.attempts : o.maxAttempts;
  var start = o.startSeed === undefined ? 1 : o.startSeed;
  var out = {
    tier: spec.tier, seeds: seeds, calls: 0, solvedCalls: 0, deadSeeds: [],
    candidates: 0, accepted: 0, rejects: null, grades: [], attempts: [],
    keys: [], results: []
  };
  var rejects = {};
  for (var s = 0; s < seeds; s++) {
    var r = generate(start + s, tierIndex, {
      maxAttempts: maxAttempts, verifyTruth: o.verifyTruth
    });
    out.calls++;
    out.candidates += r.attempts;
    for (var k in r.rejects) rejects[k] = (rejects[k] || 0) + r.rejects[k];
    if (r.board) {
      out.solvedCalls++;
      out.accepted++;
      out.grades.push(r.grade);
      out.attempts.push(r.attempts);
      out.keys.push(r.key);
      if (o.keepBoards) out.results.push(r);
    } else {
      out.deadSeeds.push(start + s);
    }
  }
  out.rejects = rejects;
  out.hitRate = out.candidates ? out.accepted / out.candidates : 0;
  out.callSuccessRate = out.calls ? out.solvedCalls / out.calls : 0;
  return out;
}

var API = {
  TIERS: TIERS,
  tierFor: tierFor,
  attemptSeed: attemptSeed,
  levelSeed: levelSeed,
  dailySeed: dailySeed,
  generate: generate,
  sweep: sweep,
  accepts: accepts,
  buildCandidate: buildCandidate,
  carveSky: carveSky,
  maskedConnected: maskedConnected,
  rayClear: rayClear
};

root.FlightpathGenerator = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);

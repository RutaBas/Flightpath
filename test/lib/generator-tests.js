"use strict";
/* (c) exact-band tier match, (d) variety, (e) seed quality, plus determinism
   and the "no dead seeds" guarantee. */

var H = require("./harness.js");
var Board = H.Board, Solver = H.Solver, Gen = H.Gen, Rng = H.Rng;

/* Runs one sweep per tier and keeps the boards for the later checks. */
function sweepTiers(seedsPerTier) {
  H.section("(c) generator sweep: acceptance, exact-band match, distributions");
  var out = [];
  for (var t = 1; t <= 5; t++) {
    var spec = Gen.tierFor(t);
    var t0 = Date.now();
    var sw = Gen.sweep(t, seedsPerTier, { startSeed: 1, keepBoards: true });
    var ms = Date.now() - t0;

    var depths = sw.grades.map(function (g) { return g.depth; });
    var efforts = sw.grades.map(function (g) { return g.effort; });
    var arrows = sw.grades.map(function (g) { return g.arrows; });
    var mrw = sw.grades.map(function (g) { return g.minRoundWidth; });
    var trap = sw.grades.map(function (g) { return g.trapFraction; });
    var mray = sw.grades.map(function (g) { return g.meanRay; });

    console.log("\n  tier " + t + "  " + spec.w + "x" + spec.h +
      "   accepted " + sw.solvedCalls + "/" + sw.calls + " seeds" +
      "   hit rate " + (sw.hitRate * 100).toFixed(1) + "% of candidates" +
      "   avg attempts " + (sw.candidates / sw.calls).toFixed(2) +
      "   " + ms + "ms");
    console.log("    depth   " + H.spread(depths) + "   band [" + spec.depth + "]");
    console.log("    effort  " + H.spread(efforts) + "   band [" + spec.effort + "]");
    console.log("    arrows  " + H.spread(arrows) + "   minRoundWidth " + H.spread(mrw));
    console.log("    trap    " + H.spread(trap) + "   meanRay " + H.spread(mray));
    var rej = Object.keys(sw.rejects).filter(function (k) { return sw.rejects[k] > 0; })
      .map(function (k) { return k + "=" + sw.rejects[k]; }).join(" ");
    console.log("    rejected: " + (rej || "nothing"));

    H.ok(sw.deadSeeds.length === 0,
      "tier " + t + ": no dead seeds (" + sw.solvedCalls + "/" + sw.calls + " within budget " +
      spec.attempts + ")");
    H.ok(sw.hitRate > 0.01,
      "tier " + t + ": band is practically generateable (hit rate " +
      (sw.hitRate * 100).toFixed(1) + "% > 1%)");
    out.push({ tier: t, spec: spec, sweep: sw, depths: depths, efforts: efforts });
  }
  return out;
}

function testExactBand(sweeps) {
  H.section("(c) every accepted board is inside its OWN tier's exact band");
  var outOfBand = 0, wrongTier = 0, unsound = 0, encoding = 0, checked = 0;
  for (var s = 0; s < sweeps.length; s++) {
    var spec = sweeps[s].spec;
    var results = sweeps[s].sweep.results;
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      checked++;
      /* re-grade from scratch, from the SERIALIZED board, so nothing the
         generator computed can leak into the verdict */
      var fresh = Board.deserialize(Board.key(r.board));
      if (Board.key(fresh) !== r.key) encoding++;
      var g = Solver.grade(fresh);
      if (!Gen.accepts(spec, fresh, g).ok) {
        outOfBand++;
        if (outOfBand === 1) {
          console.log("    out of band: tier " + spec.tier + " " + JSON.stringify(g));
        }
      }
      if (!g.solved || g.stuckCount !== 0) unsound++;
      /* and NOT inside any other tier's band — a tier-1 board must not be a
         tier-3 board */
      for (var t2 = 1; t2 <= 5; t2++) {
        if (t2 === spec.tier) continue;
        if (Gen.accepts(Gen.tierFor(t2), fresh, g).ok) wrongTier++;
      }
    }
  }
  H.info("re-graded " + checked + " certified boards from their serialized form");
  H.ok(encoding === 0, "every board survives a serialize/deserialize round-trip");
  H.ok(unsound === 0, "every certified board is fully solved by the closure, nothing stuck");
  H.ok(outOfBand === 0, "every certified board re-grades INSIDE its own tier's exact band");
  H.ok(wrongTier === 0, "no certified board also satisfies a different tier's band");

  /* the gate must actually reject: a tier-1 board offered as tier 3 */
  var t1 = sweeps[0].sweep.results[0];
  var g1 = Solver.grade(t1.board);
  H.ok(!Gen.accepts(Gen.tierFor(3), t1.board, g1).ok,
    "a tier-1 board is REJECTED when offered against tier 3's band (" +
    Gen.accepts(Gen.tierFor(3), t1.board, g1).reason + ")");
  var t5 = sweeps[4].sweep.results[0];
  var g5 = Solver.grade(t5.board);
  H.ok(!Gen.accepts(Gen.tierFor(1), t5.board, g5).ok,
    "a tier-5 board is REJECTED when offered against tier 1's band (" +
    Gen.accepts(Gen.tierFor(1), t5.board, g5).reason + ")");
}

function testTierSeparation(sweeps) {
  H.section("(c) tiers are genuinely separated by the solver's own metrics");
  for (var i = 1; i < sweeps.length; i++) {
    var lo = sweeps[i - 1], hi = sweeps[i];
    var loMax = Math.max.apply(null, lo.efforts);
    var hiMed = H.pct(hi.efforts, 0.5);
    var loMedD = H.pct(lo.depths, 0.5), hiMedD = H.pct(hi.depths, 0.5);
    H.ok(hiMed > loMax,
      "tier " + hi.tier + " median effort (" + hiMed + ") exceeds tier " + lo.tier +
      " MAXIMUM effort (" + loMax + ")");
    H.ok(hiMedD >= loMedD,
      "tier " + hi.tier + " median depth (" + hiMedD + ") >= tier " + lo.tier +
      " median depth (" + loMedD + ")");
  }
}

function testDeterminism() {
  H.section("determinism and bounded termination");
  var a = Gen.generate(77, 3);
  var b = Gen.generate(77, 3);
  H.ok(a.board && b.board && a.key === b.key, "generate(77, 3) is reproducible");
  H.ok(a.attempts === b.attempts, "...including the number of attempts it took");
  var c = Gen.generate(77, 4);
  H.ok(c.board && c.key !== a.key, "the same seed on a different tier gives a different board");
  var starved = Gen.generate(5, 5, { maxAttempts: 1 });
  H.ok(starved.board === null ? typeof starved.reason === "string" : true,
    "an exhausted budget returns a reason instead of throwing or looping");
  var impossible = Gen.generate(1, 5, { maxAttempts: 0 });
  H.ok(impossible.board === null && impossible.attempts === 0,
    "a zero budget terminates immediately: " + impossible.reason);
  var threw = false;
  try { Gen.generate(1, 9); } catch (e) { threw = true; }
  H.ok(threw, "an unknown tier throws rather than silently picking one");
}

/* ------------------------------------------------------------- (d) variety */

function testVariety(sweeps) {
  H.section("(d) variety: distinct boards, and varying shape / walls / directions");
  for (var s = 0; s < sweeps.length; s++) {
    var spec = sweeps[s].spec;
    var results = sweeps[s].sweep.results;
    var keys = {}, shapes = {}, masks = {}, wallSets = {}, dirMixes = {}, arrowCounts = {};
    var wallCells = {}, wallCounts = {}, wallBoards = 0;
    var nFrac = [];
    var dirTotals = [0, 0, 0, 0];
    for (var i = 0; i < results.length; i++) {
      var b = results[i].board;
      keys[Board.key(b)] = 1;
      shapes[Board.shapeKey(b)] = 1;
      masks[Board.maskKey(b)] = 1;
      arrowCounts[Solver.grade(b).arrows] = 1;
      var walls = [];
      var counts = [0, 0, 0, 0];
      for (var c = 0; c < b.cells.length; c++) {
        if (b.cells[c] === Board.WALL) walls.push(c);
        if (Board.isArrow(b.cells[c])) { counts[b.cells[c]]++; dirTotals[b.cells[c]]++; }
      }
      if (walls.length) { wallSets[walls.join(",")] = 1; wallBoards++; }
      for (var q = 0; q < walls.length; q++) wallCells[walls[q]] = 1;
      wallCounts[walls.length] = 1;
      dirMixes[counts.join(",")] = 1;
      var tot = counts[0] + counts[1] + counts[2] + counts[3];
      nFrac.push(tot ? counts[0] / tot : 0);
    }
    var n = results.length;
    var nk = Object.keys(keys).length;
    var nsh = Object.keys(shapes).length;
    var nm = Object.keys(masks).length;
    var nw = Object.keys(wallSets).length;
    var nwc = Object.keys(wallCells).length;
    var nwn = Object.keys(wallCounts).length;
    var wallCoverage = nwc / (spec.w * spec.h);
    var nd = Object.keys(dirMixes).length;
    var na = Object.keys(arrowCounts).length;
    console.log("\n  tier " + spec.tier + " over " + n + " boards:");
    console.log("    distinct board keys      " + nk + "/" + n);
    console.log("    distinct layouts (dirs ignored) " + nsh + "/" + n);
    console.log("    distinct mask shapes     " + nm);
    console.log("    distinct wall layouts    " + nw + "/" + wallBoards +
      " walled boards; " + nwc + " distinct cells ever walled (" +
      (wallCoverage * 100).toFixed(0) + "% of grid); " + nwn + " wall counts used");
    console.log("    distinct direction mixes " + nd + "   arrow counts used " + na);
    console.log("    direction totals N/E/S/W " + dirTotals.join("/") +
      "   sd of N-share " + H.stdev(nFrac).toFixed(3));

    H.ok(nk === n, "tier " + spec.tier + ": every seed produced a DISTINCT board");
    H.ok(nsh >= n * 0.95, "tier " + spec.tier + ": layouts vary, not just arrow letters (" +
      nsh + "/" + n + ")");
    H.ok(nm >= 3 || spec.sky[1] === 0, "tier " + spec.tier + ": board shape varies (" +
      nm + " distinct masks)");
    /* Wall variety cannot be measured against the board count: a tier whose
       band allows 1 wall has only w*h possible layouts, so collisions are
       expected by the birthday bound and are not a generator fault. Measure it
       against the walled boards and against how much of the grid walls reach. */
    if (spec.walls[1] === 0) {
      H.ok(nw === 0 && wallBoards === 0,
        "tier " + spec.tier + ": a wall-free tier really has no walls");
    } else {
      H.ok(nw >= wallBoards * 0.5, "tier " + spec.tier + ": wall layouts vary (" +
        nw + " distinct across " + wallBoards + " walled boards)");
      H.ok(wallCoverage >= 0.5, "tier " + spec.tier + ": walls reach across the grid (" +
        (wallCoverage * 100).toFixed(0) + "% of cells have held one)");
      H.ok(nwn >= 2, "tier " + spec.tier + ": the number of walls varies (" + nwn + " values)");
    }
    H.ok(nd >= n * 0.3, "tier " + spec.tier + ": direction mix varies (" + nd + " distinct)");
    H.ok(na >= 2, "tier " + spec.tier + ": arrow count varies (" + na + " values)");
    H.ok(Math.min.apply(null, dirTotals) > 0, "tier " + spec.tier + ": all four directions used");
    H.ok(H.stdev(nFrac) > 0.01, "tier " + spec.tier + ": the direction mix is not fixed");
  }
}

/* ---------------------------------------------------------- (e) seed quality */

function testSeeding() {
  H.section("(e) seed quality: avalanche, no addition, no stride aliasing");

  /* 1. consecutive level seeds must not be near-linear.
     The detector is Pearson r against the level number plus the mean absolute
     step between consecutive seeds (1/3 for independent uniforms, ~0 for a
     near-linear generator). It is calibrated on a deliberately near-linear
     sequence first, so a green result here means something. */
  var xs = [], hashed = [], linear = [];
  for (var n = 1; n <= 500; n++) {
    xs.push(n);
    hashed.push(Rng.makeRng(Gen.levelSeed(n))());
    linear.push((n * 0.0017) % 1);
  }
  function meanStep(v) {
    var t = 0;
    for (var i = 1; i < v.length; i++) t += Math.abs(v[i] - v[i - 1]);
    return t / (v.length - 1);
  }
  var rHashed = H.pearson(xs, hashed);
  var rLinear = H.pearson(xs, linear);
  H.info("Pearson r vs level number: hashed " + rHashed.toFixed(4) +
    ", calibration (deliberately linear) " + rLinear.toFixed(4));
  H.info("mean |step| between consecutive seeds: hashed " + meanStep(hashed).toFixed(4) +
    " (1/3 = independent), calibration " + meanStep(linear).toFixed(4));
  H.ok(Math.abs(rLinear) > 0.9 && meanStep(linear) < 0.05,
    "the detector flags a genuinely near-linear sequence, so this test has teeth");
  H.ok(Math.abs(rHashed) < 0.1, "hashed level seeds are not near-linear (|r| < 0.1)");
  H.ok(meanStep(hashed) > 0.28,
    "consecutive level seeds jump across the range (mean step " +
    meanStep(hashed).toFixed(3) + ")");

  /* The property that actually matters is at the BOARD level: neighbouring
     levels must look no more alike than unrelated ones. */
  function hamming(a, b) {
    var d = 0;
    for (var i = 0; i < a.length; i++) if (a.charAt(i) !== b.charAt(i)) d++;
    return d;
  }
  var boards = [];
  for (var L = 1; L <= 40; L++) boards.push(Gen.generate(L, 2).key.split(";")[3]);
  var adj = [], far = [];
  for (var j = 1; j < boards.length; j++) adj.push(hamming(boards[j - 1], boards[j]));
  for (var k2 = 0; k2 + 17 < boards.length; k2++) far.push(hamming(boards[k2], boards[k2 + 17]));
  H.info("board cell-difference: adjacent levels " + H.mean(adj).toFixed(2) +
    "/30, distant levels " + H.mean(far).toFixed(2) + "/30");
  H.ok(H.mean(adj) > H.mean(far) * 0.9,
    "adjacent levels differ as much as unrelated ones — no seed-neighbour echo");

  /* 2. level and attempt are hashed TOGETHER as one string, never added */
  var src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "..", "js", "generator.js"), "utf8");
  H.ok(/flightpath\|t/.test(src) && /attemptSeed/.test(src),
    "attemptSeed builds one delimited string");
  H.ok(Gen.attemptSeed(1, 2, 3) !== Gen.attemptSeed(3, 2, 1),
    "attemptSeed is not symmetric in (seed, attempt) — addition would collide here");
  var seen = {}, collisions = 0;
  for (var s = 0; s < 200; s++) {
    for (var a = 0; a < 40; a++) {
      var k = Rng.hashSeed(Gen.attemptSeed(s, 3, a));
      if (seen[k]) collisions++;
      seen[k] = 1;
    }
  }
  H.info("(seed, attempt) hash collisions over 8000 pairs: " + collisions);
  H.ok(collisions <= 12, "no systematic collision between level stride and retry stride");

  /* 3. stride aliasing: level tables built at a fixed stride must not collapse */
  var strides = [1, 7, 13, 64, 256, 1000];
  for (var si = 0; si < strides.length; si++) {
    var K = strides[si];
    var ks = {}, count = 0, dead = 0;
    for (var L = 0; L < 40; L++) {
      var r = Gen.generate(1000 + L * K, 2);
      if (!r.board) { dead++; continue; }
      ks[r.key] = 1;
      count++;
    }
    H.ok(Object.keys(ks).length === count && dead === 0,
      "stride " + K + ": " + Object.keys(ks).length + "/" + count +
      " distinct boards, " + dead + " dead seeds");
  }
}

module.exports = {
  sweepTiers: sweepTiers,
  testExactBand: testExactBand,
  testTierSeparation: testTierSeparation,
  testDeterminism: testDeterminism,
  testVariety: testVariety,
  testSeeding: testSeeding
};

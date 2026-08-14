"use strict";
/* FLIGHTPATH — logic core test suite.  node test/logic.test.js [seedsPerTier]

   What it proves, in the order SPEC.md needs it proved:

     (a) MONOTONICITY / CONFLUENCE. An exhaustive DFS over every reachable
         state of small boards, compared with the greedy closure. They must
         agree on solvability for every board, including deliberately
         deadlocked ones, and every board must have exactly ONE terminal
         state. A disagreement would falsify SPEC.md's central claim, so the
         suite STOPS and says so rather than papering over it.
     (b) SOUNDNESS. isFree against an independently written brute-force scan,
         on every intermediate state of thousands of solves; hint never names
         a blocked arrow; ground-truth mode catches a planted lie.
     (c) EXACT-BAND TIER MATCH. Every generated board re-graded from its
         serialized form and required to sit in its own tier's band and no
         other tier's.
     (d) VARIETY. Hundreds of seeds per tier: distinct boards, and varying
         shape, wall placement and direction mix.
     (e) SEED QUALITY. Consecutive level seeds are not near-linear, level and
         attempt are hashed together as one string, and fixed-stride level
         tables do not collapse into duplicates.

   Exits non-zero if anything fails. */

var H = require("./lib/harness.js");
var ST = require("./lib/solver-tests.js");
var GT = require("./lib/generator-tests.js");

var SEEDS = Number(process.argv[2] || 300);
var t0 = Date.now();

console.log("FLIGHTPATH logic core — " + SEEDS + " seeds per tier");

ST.testBoardModel();
ST.testRayGeometry();
ST.testEffortMonotone();
ST.testSoundnessRandom(1200);
ST.testExhaustiveAgreement(1500);
ST.testGroundTruth();

var sweeps = GT.sweepTiers(SEEDS);
GT.testExactBand(sweeps);
GT.testTierSeparation(sweeps);
GT.testVariety(sweeps);
GT.testDeterminism();
GT.testSeeding();

/* certified boards, played randomly — the "cannot be bricked" claim end to end */
var certified = [];
for (var s = 0; s < sweeps.length; s++) {
  var rs = sweeps[s].sweep.results;
  for (var i = 0; i < Math.min(20, rs.length); i++) certified.push(rs[i].board);
}
ST.testRandomPlay(certified, 20);

H.section("summary");
console.log("  passed " + H.state.pass + ", failed " + H.state.fail +
  ", " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
if (H.state.stopped) {
  console.log("\n  *** STOPPED: " + H.state.stopped.msg);
  console.log("  *** This contradicts SPEC.md. Do not ship; the design needs revisiting.");
}
if (H.state.fail) {
  console.log("\n  failures:");
  H.state.failures.forEach(function (f) { console.log("   - " + f); });
  process.exit(1);
}
console.log("  ALL GREEN");

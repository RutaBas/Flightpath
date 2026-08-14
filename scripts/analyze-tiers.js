"use strict";

/* FLIGHTPATH — structural feasibility sweep for tiers ABOVE Gridlock.
   node scripts/analyze-tiers.js <mode>

   WHY THIS EXISTS

   The grid is capped. Measured in Chrome at 375x667 (iPhone SE) the board area
   is 359x485, so 7 columns gives a 44.8px tile and only 9 rows fit; 8 columns
   gives 39.4px and a 10th row drops under 44px. Boards must be identical on
   every device, so the SE binds: 7 columns AND 9 rows, full stop. Tier 5
   (Gridlock) is already 7x9. Any tier 6 has to be harder STRUCTURALLY.

   So this script does not propose anything. It measures the frontier of each
   structural lever on a fixed 7x9 (and 6x8 for contrast) and prints what is
   actually reachable, with acceptance rates, so a band can be written from
   numbers instead of from hope. Nothing here is shipped; it reads the
   generator's own buildCandidate/grade/generate and writes no files.

   MODES
     frontier   how deep can a 7x9 board go, as a function of the aim/bias
                knobs, and what does the raw (ungated) grade distribution look
                like at each setting
     levers     walls, arrows, rayBias, sky — each pushed alone
     push       rayBias past anything the shipped tiers use, with TAIL
                probabilities, plus the ceiling hunt with every knob at its
                depth-friendliest
     bottleneck how many width-1 rounds, and how long a CONSECUTIVE run of
                them, is achievable; plus trapFraction's ceiling
     effort     the effort ceiling and which terms are still moving up there
     bands      acceptance / attempts / distribution for candidate tier bands
                injected into the generator's own TIERS table and run through
                the unmodified gate
     final      the bands AS SHIPPED in js/generator.js over a large seed set,
                plus the separation and cross-tier exclusivity properties
     audit      an INDEPENDENT closure, written here from SPEC.md, checks that
                every tier-6/7 board really clears and really grades as claimed
                (test/verify.js only covers tiers 1-5)
     all        every mode above, in order

   METRICS BEYOND grade(): from grade().roundWidths this script derives
     w1count  how many rounds have width 1
     w1run    the LONGEST run of consecutive width-1 rounds — a run of forced
              single moves is the hardest thing this game can ask
   Neither is a gate anywhere unless a proposed band says so. */

const path = require("path");
const Board = require(path.join(__dirname, "..", "js", "board.js"));
const Solver = require(path.join(__dirname, "..", "js", "solver.js"));
const Gen = require(path.join(__dirname, "..", "js", "generator.js"));
const Rng = require(path.join(__dirname, "..", "js", "rng.js"));

const MODE = (process.argv[2] || "all").toLowerCase();
const N = parseInt(process.argv[3] || "0", 10) || 0;

/* ------------------------------------------------------------------ stats */

function sorted(a) { return a.slice().sort((x, y) => x - y); }
function pct(a, p) {
  if (!a.length) return NaN;
  const s = sorted(a);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
}
function mn(a) { return a.length ? Math.min.apply(null, a) : NaN; }
function mx(a) { return a.length ? Math.max.apply(null, a) : NaN; }
function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN; }
function f1(x) { return Number.isFinite(x) ? x.toFixed(1) : "-"; }
function f2(x) { return Number.isFinite(x) ? x.toFixed(2) : "-"; }
function f3(x) { return Number.isFinite(x) ? x.toFixed(3) : "-"; }
function pad(s, n) { return String(s).padEnd(n); }
function lpad(s, n) { return String(s).padStart(n); }

function hist(a, lo, hi) {
  const counts = {};
  a.forEach((v) => { counts[v] = (counts[v] || 0) + 1; });
  const out = [];
  for (let v = lo; v <= hi; v++) if (counts[v]) out.push(v + ":" + counts[v]);
  return out.join(" ");
}

/* longest run of consecutive width-1 rounds, and total width-1 rounds */
function widthOnes(roundWidths) {
  let run = 0, best = 0, total = 0;
  for (let i = 0; i < roundWidths.length; i++) {
    if (roundWidths[i] === 1) { run++; total++; if (run > best) best = run; }
    else run = 0;
  }
  return { w1run: best, w1count: total };
}

function section(t) {
  console.log("\n" + "=".repeat(78));
  console.log(t);
  console.log("=".repeat(78));
}

/* --------------------------------------------------------- the raw probe */

/* Build `n` candidates from a spec skeleton with NO band gate at all, so the
   raw reachable frontier is visible rather than the post-gate survivors. */
function probe(label, over, n) {
  const spec = Object.assign({
    tier: 99, name: "probe", w: 7, h: 9,
    arrows: [44, 58], walls: [3, 6], sky: [0, 10],
    aim: [14, 20], bias: { block: [1.8, 3.6], ray: [0.0, 0.9] }
  }, over);

  const r = {
    label, spec, n, buildFail: 0, unsolved: 0,
    depth: [], effort: [], arrows: [], walls: [], minW: [], w1run: [], w1count: [],
    trap: [], meanRay: [], maxRay: [], ms: 0
  };
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const rng = Rng.makeRng("fp|probe|" + label + "|" + i);
    const c = Gen.buildCandidate(spec, rng);
    if (!c) { r.buildFail++; continue; }
    const g = Solver.grade(c.board);
    if (!g.solved || g.stuckCount !== 0) { r.unsolved++; continue; }
    const w1 = widthOnes(g.roundWidths);
    r.depth.push(g.depth);
    r.effort.push(g.effort);
    r.arrows.push(g.arrows);
    r.walls.push(g.walls);
    r.minW.push(g.minRoundWidth);
    r.w1run.push(w1.w1run);
    r.w1count.push(w1.w1count);
    r.trap.push(g.trapFraction);
    r.meanRay.push(g.meanRay);
    r.maxRay.push(g.maxRay);
  }
  r.ms = Date.now() - t0;
  return r;
}

const ROW_HEAD =
  pad("setting", 30) + lpad("built", 6) + lpad("bfail", 6) +
  lpad("dep p50", 8) + lpad("p90", 5) + lpad("max", 5) +
  lpad("eff p50", 8) + lpad("max", 6) +
  lpad("minW", 5) + lpad("w1run", 6) + lpad("trap", 6) + lpad("mRay", 6) + lpad("arr", 5);

function row(r) {
  return pad(r.label, 30) +
    lpad(r.depth.length, 6) + lpad(r.buildFail, 6) +
    lpad(pct(r.depth, 50), 8) + lpad(pct(r.depth, 90), 5) + lpad(mx(r.depth), 5) +
    lpad(f1(pct(r.effort, 50)), 8) + lpad(f1(mx(r.effort)), 6) +
    lpad(pct(r.minW, 50), 5) + lpad(pct(r.w1run, 50) + "/" + mx(r.w1run), 6) +
    lpad(f2(pct(r.trap, 50)), 6) + lpad(f1(pct(r.meanRay, 50)), 6) +
    lpad(pct(r.arrows, 50), 5);
}

/* -------------------------------------------------------------- mode: frontier */

function modeFrontier() {
  section("A. DEPTH FRONTIER on 7x9 — how deep can reverse construction actually go");
  console.log("raw candidates, NO band gate. 'bfail' = construction stalled short of the arrow floor.");
  console.log("baseline row is tier 5's own construction knobs (aim 14-20, block 1.8-3.6).\n");
  console.log(ROW_HEAD);
  const n = N || 400;

  const rows = [];
  rows.push(probe("T5 baseline", {}, n));
  const aims = [[14, 20], [18, 22], [20, 26], [24, 30], [28, 36], [34, 44], [40, 55]];
  aims.forEach((a) => {
    rows.push(probe("aim " + a[0] + "-" + a[1] + " blk 1.8-3.6", { aim: a }, n));
  });
  const blocks = [[3.0, 4.5], [4.0, 6.0], [6.0, 8.0], [8.0, 12.0]];
  blocks.forEach((b) => {
    rows.push(probe("aim 28-36 blk " + b[0] + "-" + b[1], { aim: [28, 36], bias: { block: b, ray: [0.0, 0.9] } }, n));
  });
  rows.forEach((r) => console.log(row(r)));

  section("A2. same sweep at 6x8 (tier 4's grid) — is depth grid-bound or knob-bound?");
  console.log(ROW_HEAD);
  const r68 = [];
  r68.push(probe("6x8 T4 baseline", { w: 6, h: 8, arrows: [32, 42], walls: [2, 4], aim: [9, 13], bias: { block: [1.4, 3.2], ray: [-0.1, 0.7] } }, n));
  [[14, 20], [20, 28], [28, 40]].forEach((a) => {
    r68.push(probe("6x8 aim " + a[0] + "-" + a[1], { w: 6, h: 8, arrows: [32, 42], walls: [2, 4], aim: a, bias: { block: [4, 6], ray: [0, 0.9] } }, n));
  });
  r68.forEach((r) => console.log(row(r)));

  section("A3. arrow-count interaction at 7x9 with a high depth aim");
  console.log("63 cells. arrows+walls must fit, and depth <= arrows is a hard arithmetic ceiling.");
  console.log(ROW_HEAD);
  const rA = [];
  [[36, 44], [44, 52], [44, 58], [50, 58], [54, 60], [56, 63]].forEach((a) => {
    rA.push(probe("arrows " + a[0] + "-" + a[1], { arrows: a, aim: [28, 36], bias: { block: [4, 6], ray: [0, 0.9] } }, n));
  });
  rA.forEach((r) => console.log(row(r)));
  return rows.concat(r68, rA);
}

/* ---------------------------------------------------------------- mode: levers */

function modeLevers() {
  section("B. WALLS — how many walls before construction collapses (7x9, deep aim)");
  console.log(ROW_HEAD);
  const n = N || 400;
  const rw = [];
  [[3, 6], [6, 8], [8, 10], [10, 12], [12, 15], [15, 18]].forEach((wl) => {
    rw.push(probe("walls " + wl[0] + "-" + wl[1], {
      walls: wl, arrows: [44, 52], aim: [24, 32], bias: { block: [4, 6], ray: [0, 0.9] }
    }, n));
  });
  rw.forEach((r) => console.log(row(r)));

  section("B2. RAY BIAS — can meanRay/maxRay be pushed (long lanes = eye travel)");
  console.log(ROW_HEAD);
  const rr = [];
  [[-0.5, 0.0], [0.0, 0.9], [1.0, 2.0], [2.0, 3.5], [3.5, 5.0]].forEach((rb) => {
    rr.push(probe("ray " + rb[0] + "-" + rb[1], {
      aim: [24, 32], bias: { block: [4, 6], ray: rb }
    }, n));
  });
  rr.forEach((r) => console.log(row(r)));
  console.log("\nmeanRay detail (p50 / max) and maxRay (p50 / max):");
  rr.forEach((r) => console.log("  " + pad(r.label, 24) +
    " meanRay " + f2(pct(r.meanRay, 50)) + " / " + f2(mx(r.meanRay)) +
    "   maxRay " + pct(r.maxRay, 50) + " / " + mx(r.maxRay)));

  section("B3. SKY — does carving cells help or hurt at the top end");
  console.log(ROW_HEAD);
  const rs = [];
  [[0, 0], [0, 10], [4, 10], [8, 14]].forEach((sk) => {
    rs.push(probe("sky " + sk[0] + "-" + sk[1], {
      sky: sk, arrows: [40, 50], aim: [24, 32], bias: { block: [4, 6], ray: [0, 0.9] }
    }, n));
  });
  rs.forEach((r) => console.log(row(r)));
  return rw.concat(rr, rs);
}

/* ------------------------------------------------------------------ mode: push

   The A-sweep says aim/blockBias saturate: median depth sticks at 9-10 and the
   max at ~20 no matter how hard they are pushed. The B2-sweep says rayBias is
   the lever that actually moves depth, because a chain can only be extended by
   dropping a blocker ON the current head's ray — a head with a zero-length ray
   (edge cell pointing out) can never be blocked and caps the chain forever. So
   this mode pushes rayBias past anything the shipped tiers use and prints TAIL
   probabilities, which is what an acceptance rate actually is. */

function tail(a, v) { return a.length ? a.filter((x) => x >= v).length / a.length : 0; }

function pushRow(r) {
  return pad(r.label, 26) + lpad(r.depth.length, 6) +
    lpad(pct(r.depth, 50), 6) + lpad(pct(r.depth, 90), 5) + lpad(mx(r.depth), 5) +
    lpad(f1(100 * tail(r.depth, 18)), 7) + lpad(f1(100 * tail(r.depth, 20)), 7) +
    lpad(f1(100 * tail(r.depth, 22)), 7) + lpad(f1(100 * tail(r.depth, 25)), 7) +
    lpad(f1(pct(r.effort, 50)), 7) + lpad(f1(mx(r.effort)), 7) +
    lpad(f1(100 * tail(r.effort, 286)), 8) +
    lpad(pct(r.w1run, 50) + "/" + mx(r.w1run), 7) + lpad(f2(pct(r.trap, 50)), 6);
}

const PUSH_HEAD = pad("setting", 26) + lpad("built", 6) + lpad("d50", 6) + lpad("d90", 5) +
  lpad("dmax", 5) + lpad("%d>=18", 7) + lpad(">=20", 7) + lpad(">=22", 7) + lpad(">=25", 7) +
  lpad("eff50", 7) + lpad("effmax", 7) + lpad("%e>=286", 8) + lpad("w1run", 7) + lpad("trap", 6);

function modePush() {
  section("A4. RAY BIAS PUSHED — the lever that actually moves depth (7x9)");
  console.log("tail columns are PERCENT of built candidates at or above that depth/effort,");
  console.log("i.e. the per-candidate acceptance a band gated there would see.\n");
  const n = N || 600;
  console.log(PUSH_HEAD);
  const rows = [];
  [[0.0, 0.9], [2.0, 3.5], [3.5, 5.0], [5.0, 7.0], [7.0, 10.0], [10.0, 14.0]].forEach((rb) => {
    rows.push(probe("ray " + rb[0] + "-" + rb[1], {
      aim: [24, 32], sky: [0, 10], bias: { block: [4, 6], ray: rb }
    }, n));
  });
  rows.forEach((r) => console.log(pushRow(r)));

  section("A5. rayBias 5-7 crossed with sky, arrows and walls");
  console.log(PUSH_HEAD);
  const rows2 = [];
  [[0, 0], [0, 4], [0, 10]].forEach((sk) => {
    rows2.push(probe("sky " + sk[0] + "-" + sk[1], {
      aim: [24, 32], sky: sk, bias: { block: [4, 6], ray: [5, 7] }
    }, n));
  });
  [[34, 44], [40, 50], [44, 52], [44, 58]].forEach((ar) => {
    rows2.push(probe("arrows " + ar[0] + "-" + ar[1], {
      arrows: ar, aim: [24, 32], sky: [0, 6], bias: { block: [4, 6], ray: [5, 7] }
    }, n));
  });
  [[3, 6], [5, 8], [7, 10]].forEach((wl) => {
    rows2.push(probe("walls " + wl[0] + "-" + wl[1], {
      walls: wl, arrows: [40, 50], aim: [24, 32], sky: [0, 6], bias: { block: [4, 6], ray: [5, 7] }
    }, n));
  });
  rows2.forEach((r) => console.log(pushRow(r)));

  section("A6. best-of combinations, larger sample");
  console.log(PUSH_HEAD);
  const rows3 = [];
  const combos = [
    ["ray7-10 a40-50 sky0-6", { arrows: [40, 50], aim: [24, 32], sky: [0, 6], bias: { block: [4, 6], ray: [7, 10] } }],
    ["ray7-10 a44-58 sky0-6", { arrows: [44, 58], aim: [24, 32], sky: [0, 6], bias: { block: [4, 6], ray: [7, 10] } }],
    ["ray5-9 a40-52 aim30-40", { arrows: [40, 52], aim: [30, 40], sky: [0, 6], bias: { block: [5, 8], ray: [5, 9] } }],
    ["ray6-10 a40-52 w5-8", { arrows: [40, 52], walls: [5, 8], aim: [26, 36], sky: [0, 6], bias: { block: [5, 8], ray: [6, 10] } }],
    ["ray8-12 a44-56 aim28-38", { arrows: [44, 56], aim: [28, 38], sky: [0, 6], bias: { block: [5, 8], ray: [8, 12] } }]
  ];
  combos.forEach(([label, over]) => rows3.push(probe(label, over, (N || 600) * 2)));
  rows3.forEach((r) => console.log(pushRow(r)));
  rows3.forEach((r) => console.log("  " + pad(r.label, 26) + " depth hist: " + hist(r.depth, 0, 60)));

  section("A7. CEILING HUNT — every knob simultaneously at its depth-friendliest");
  console.log("A serpentine chain (a column of N-facing arrows, then a column of W/S-facing");
  console.log("arrows hanging off its foot, and so on) reaches depth ~= arrow count, so the");
  console.log("STRUCTURAL ceiling on 7x9 is near 60. Anything short of that is a limit of the");
  console.log("PROPOSAL DISTRIBUTION, not of the grid. This section finds where the sampler stops.\n");
  console.log(PUSH_HEAD);
  const rows4 = [];
  const big = (N || 600) * 4;
  const extreme = [
    ["w0-0 a34-44 ray7-10", { walls: [0, 0], arrows: [34, 44], aim: [30, 40], sky: [0, 0], bias: { block: [5, 8], ray: [7, 10] } }],
    ["w0-2 a40-50 ray7-10", { walls: [0, 2], arrows: [40, 50], aim: [30, 40], sky: [0, 0], bias: { block: [5, 8], ray: [7, 10] } }],
    ["w0-0 a50-58 ray7-10", { walls: [0, 0], arrows: [50, 58], aim: [34, 46], sky: [0, 0], bias: { block: [5, 8], ray: [7, 10] } }],
    ["w0-0 a44-56 ray12-18", { walls: [0, 0], arrows: [44, 56], aim: [34, 46], sky: [0, 0], bias: { block: [6, 10], ray: [12, 18] } }],
    ["w0-0 a44-56 blk12-20", { walls: [0, 0], arrows: [44, 56], aim: [34, 46], sky: [0, 0], bias: { block: [12, 20], ray: [8, 12] } }],
    /* Walls turned out to be an ANTI-lever for depth (B/A5 above): every wall
       truncates lanes, so fewer cells have a clear ray and the chain dies
       sooner. These rows ask whether a high rayBias buys the walls back. */
    ["w1-3 a44-56 ray12-18", { walls: [1, 3], arrows: [44, 56], aim: [34, 46], sky: [0, 0], bias: { block: [6, 10], ray: [12, 18] } }],
    ["w2-4 a44-56 ray12-18", { walls: [2, 4], arrows: [44, 56], aim: [34, 46], sky: [0, 0], bias: { block: [6, 10], ray: [12, 18] } }],
    ["w3-6 a44-56 ray12-18", { walls: [3, 6], arrows: [44, 56], aim: [34, 46], sky: [0, 0], bias: { block: [6, 10], ray: [12, 18] } }],
    ["w0-0 a44-56 sky0-6", { walls: [0, 0], arrows: [44, 56], aim: [34, 46], sky: [0, 6], bias: { block: [6, 10], ray: [12, 18] } }],
    ["w0-2 a44-56 sky0-6", { walls: [0, 2], arrows: [44, 56], aim: [34, 46], sky: [0, 6], bias: { block: [6, 10], ray: [12, 18] } }]
  ];
  extreme.forEach(([label, over]) => rows4.push(probe(label, over, big)));
  rows4.forEach((r) => console.log(pushRow(r)));
  rows4.forEach((r) => console.log("  " + pad(r.label, 26) + " depth hist: " + hist(r.depth, 0, 63)));
  let dbest = rows4[0];
  rows4.forEach((r) => { if (mx(r.depth) > mx(dbest.depth)) dbest = r; });
  console.log("\n  deepest board seen anywhere in A7: depth " + mx(dbest.depth) +
    " (" + dbest.label + "), against a structural ceiling near the arrow count.");
  console.log("  P(depth>=22) " + f2(100 * tail(dbest.depth, 22)) + "%   P(>=25) " +
    f2(100 * tail(dbest.depth, 25)) + "%   P(>=28) " + f2(100 * tail(dbest.depth, 28)) +
    "%   P(>=32) " + f2(100 * tail(dbest.depth, 32)) + "%");
  console.log("  ms per candidate: " + f2(dbest.ms / big) + " (" + dbest.ms + "ms for " + big + ")");
  return rows.concat(rows2, rows3, rows4);
}

/* ------------------------------------------------------------ mode: bottleneck */

function modeBottleneck() {
  section("C. BOTTLENECK — width-1 rounds and consecutive runs of forced moves");
  console.log("w1count = rounds of width 1; w1run = longest CONSECUTIVE run of them.");
  console.log("mean round width is arrows/depth, so deep+small is the only way to get runs.\n");
  const n = N || 400;
  const settings = [
    ["T5 baseline", {}],
    ["aim 20-26 a44-58", { aim: [20, 26], bias: { block: [4, 6], ray: [0, 0.9] } }],
    ["aim 24-32 a44-52", { aim: [24, 32], arrows: [44, 52], bias: { block: [4, 6], ray: [0, 0.9] } }],
    ["aim 28-36 a40-48", { aim: [28, 36], arrows: [40, 48], bias: { block: [4, 6], ray: [0, 0.9] } }],
    ["aim 30-40 a34-42", { aim: [30, 40], arrows: [34, 42], bias: { block: [6, 8], ray: [0, 0.9] } }],
    ["aim 34-44 a28-36", { aim: [34, 44], arrows: [28, 36], bias: { block: [6, 8], ray: [0, 0.9] } }]
  ];
  console.log(pad("setting", 22) + lpad("built", 6) + lpad("dep p50", 8) + lpad("max", 5) +
    lpad("w1cnt p50", 10) + lpad("max", 5) + lpad("w1run p50", 10) + lpad("p90", 5) + lpad("max", 5) +
    lpad("minW=1 %", 10) + lpad("trap p50", 9) + lpad("max", 6));
  const out = [];
  settings.forEach(([label, over]) => {
    const r = probe(label, over, n);
    out.push(r);
    const pct1 = 100 * r.minW.filter((v) => v === 1).length / (r.minW.length || 1);
    console.log(pad(label, 22) + lpad(r.depth.length, 6) + lpad(pct(r.depth, 50), 8) + lpad(mx(r.depth), 5) +
      lpad(pct(r.w1count, 50), 10) + lpad(mx(r.w1count), 5) +
      lpad(pct(r.w1run, 50), 10) + lpad(pct(r.w1run, 90), 5) + lpad(mx(r.w1run), 5) +
      lpad(f1(pct1), 10) + lpad(f3(pct(r.trap, 50)), 9) + lpad(f3(mx(r.trap)), 6));
  });

  section("C2. w1run distribution for the best setting found above");
  let best = out[0];
  out.forEach((r) => { if (mx(r.w1run) > mx(best.w1run)) best = r; });
  console.log("best by max w1run: " + best.label);
  console.log("  w1run histogram : " + hist(best.w1run, 0, 30));
  console.log("  w1count histogram: " + hist(best.w1count, 0, 40));
  console.log("  depth histogram : " + hist(best.depth, 0, 60));
  console.log("  trapFraction p50/p90/max: " + f3(pct(best.trap, 50)) + " / " +
    f3(pct(best.trap, 90)) + " / " + f3(mx(best.trap)));
  return out;
}

/* ---------------------------------------------------------------- mode: effort */

function modeEffort() {
  section("D. EFFORT CEILING — what the composite can actually reach, and from where");
  console.log("effort = 10*depth + 18*(1/minRoundWidth) + 25*trap + 2*meanRay + 0.6*arrows");
  console.log("term contributions are printed for the single highest-effort board of each setting.\n");
  const n = N || 400;
  const settings = [
    ["T5 baseline", {}],
    ["aim 20-26", { aim: [20, 26], bias: { block: [4, 6], ray: [0, 0.9] } }],
    ["aim 24-32 a44-52", { aim: [24, 32], arrows: [44, 52], bias: { block: [4, 6], ray: [0, 0.9] } }],
    ["aim 28-36 a44-58", { aim: [28, 36], bias: { block: [4, 6], ray: [0, 0.9] } }],
    ["aim 28-36 ray 2-3.5", { aim: [28, 36], bias: { block: [4, 6], ray: [2, 3.5] } }],
    ["aim 34-44 a40-50", { aim: [34, 44], arrows: [40, 50], bias: { block: [6, 8], ray: [0, 0.9] } }]
  ];
  console.log(pad("setting", 22) + lpad("built", 6) + lpad("eff p50", 8) + lpad("p90", 7) +
    lpad("max", 7) + lpad("dep@max", 8) + lpad("minW@max", 9) + lpad("trap@max", 9) + lpad("arr@max", 8));
  settings.forEach(([label, over]) => {
    const r = probe(label, over, n);
    let bi = 0;
    r.effort.forEach((e, i) => { if (e > r.effort[bi]) bi = i; });
    console.log(pad(label, 22) + lpad(r.depth.length, 6) + lpad(f1(pct(r.effort, 50)), 8) +
      lpad(f1(pct(r.effort, 90)), 7) + lpad(f1(mx(r.effort)), 7) +
      lpad(r.depth[bi], 8) + lpad(r.minW[bi], 9) + lpad(f2(r.trap[bi]), 9) + lpad(r.arrows[bi], 8));
    console.log("    terms at max: 10*depth=" + f1(10 * r.depth[bi]) +
      "  18/minW=" + f1(18 / r.minW[bi]) + "  25*trap=" + f1(25 * r.trap[bi]) +
      "  2*meanRay=" + f1(2 * r.meanRay[bi]) + "  0.6*arrows=" + f1(0.6 * r.arrows[bi]));
  });
}

/* ----------------------------------------------------------------- mode: bands */

/* Inject a candidate spec as a temporary tier and run the UNMODIFIED gate on
   it via Generator.generate, so acceptance is measured through exactly the
   code the game ships. Returns per-seed attempts + accepted grades. */
function measureBand(spec, seeds, opts) {
  const o = opts || {};
  Gen.TIERS.push(spec);
  const idx = Gen.TIERS.length;
  spec.tier = idx;
  const t0 = Date.now();
  const res = {
    label: spec.name, spec, seeds, dead: [], attempts: [], candidates: 0,
    depth: [], effort: [], arrows: [], walls: [], minW: [], w1run: [], w1count: [],
    trap: [], meanRay: [], maxRay: [], keys: [], rejects: {}, ms: 0
  };
  for (let s = 1; s <= seeds; s++) {
    const r = Gen.generate(s, idx, { maxAttempts: o.maxAttempts });
    res.candidates += r.attempts;
    for (const k in r.rejects) res.rejects[k] = (res.rejects[k] || 0) + r.rejects[k];
    if (!r.board) { res.dead.push(s); continue; }
    const g = r.grade;
    const w1 = widthOnes(g.roundWidths);
    res.attempts.push(r.attempts);
    res.depth.push(g.depth); res.effort.push(g.effort); res.arrows.push(g.arrows);
    res.walls.push(g.walls); res.minW.push(g.minRoundWidth);
    res.w1run.push(w1.w1run); res.w1count.push(w1.w1count);
    res.trap.push(g.trapFraction); res.meanRay.push(g.meanRay); res.maxRay.push(g.maxRay);
    res.keys.push(r.key);
  }
  res.ms = Date.now() - t0;
  res.hitRate = res.candidates ? res.attempts.length / res.candidates : 0;
  res.callRate = res.attempts.length / seeds;
  Gen.TIERS.pop();
  return res;
}

function reportBand(r) {
  console.log("\n--- " + r.label + "  (" + r.spec.w + "x" + r.spec.h + ")");
  console.log("  band: arrows " + JSON.stringify(r.spec.arrows) + " walls " + JSON.stringify(r.spec.walls) +
    " depth " + JSON.stringify(r.spec.depth) + " minRoundWidth " + JSON.stringify(r.spec.minRoundWidth) +
    " effort " + JSON.stringify(r.spec.effort) +
    (r.spec.w1run ? " w1run " + JSON.stringify(r.spec.w1run) : ""));
  console.log("  seeds " + r.seeds + "  solved " + r.attempts.length + "/" + r.seeds +
    " (" + f1(100 * r.callRate) + "% of calls)  dead seeds: " + (r.dead.length ? r.dead.join(",") : "none"));
  console.log("  acceptance " + f2(100 * r.hitRate) + "% per candidate  (" +
    r.attempts.length + " accepted / " + r.candidates + " candidates)   " + r.ms + "ms");
  console.log("  attempts: mean " + f1(avg(r.attempts)) + "  p50 " + pct(r.attempts, 50) +
    "  p90 " + pct(r.attempts, 90) + "  worst " + mx(r.attempts) + " / budget " + r.spec.attempts);
  console.log("  depth   min " + mn(r.depth) + " p50 " + pct(r.depth, 50) + " max " + mx(r.depth) +
    "   effort min " + f1(mn(r.effort)) + " p50 " + f1(pct(r.effort, 50)) + " max " + f1(mx(r.effort)));
  console.log("  minW " + mn(r.minW) + "-" + mx(r.minW) + "   w1run p50 " + pct(r.w1run, 50) +
    " max " + mx(r.w1run) + "   trap p50 " + f3(pct(r.trap, 50)) +
    "   meanRay p50 " + f2(pct(r.meanRay, 50)) + "   arrows " + mn(r.arrows) + "-" + mx(r.arrows));
  console.log("  depth hist : " + hist(r.depth, 0, 60));
  console.log("  w1run hist : " + hist(r.w1run, 0, 40));
  console.log("  distinct boards: " + new Set(r.keys).size + "/" + r.keys.length);
  const rj = Object.keys(r.rejects).filter((k) => r.rejects[k])
    .sort((a, b) => r.rejects[b] - r.rejects[a])
    .map((k) => k + " " + r.rejects[k]).join(", ");
  console.log("  rejections : " + rj);
}

/* Separation: median effort of each tier above the previous tier's maximum,
   and NO board accepted by a foreign tier's gate. Measured, not asserted. */
function separation(stats) {
  section("F. SEPARATION — median(T n) > max(T n-1), and no cross-tier acceptance");
  const names = stats.map((s) => s.label);
  for (let i = 0; i < stats.length; i++) {
    console.log("  " + pad(names[i], 14) + " effort min " + lpad(f1(mn(stats[i].effort)), 6) +
      "  median " + lpad(f1(pct(stats[i].effort, 50)), 6) +
      "  max " + lpad(f1(mx(stats[i].effort)), 6) +
      "   depth " + mn(stats[i].depth) + "-" + mx(stats[i].depth));
  }
  let ok = true;
  for (let i = 1; i < stats.length; i++) {
    const med = pct(stats[i].effort, 50), prevMax = mx(stats[i - 1].effort);
    const pass = med > prevMax;
    if (!pass) ok = false;
    console.log("  median(" + names[i] + ")=" + f1(med) + (pass ? " >  " : " !> ") +
      "max(" + names[i - 1] + ")=" + f1(prevMax) + (pass ? "   OK" : "   FAIL"));
  }
  console.log("  separation property: " + (ok ? "HOLDS" : "BROKEN"));
  return ok;
}

function crossTier(stats, specs) {
  let cross = 0, tested = 0;
  const firsts = [];
  stats.forEach((st, a) => {
    st.keys.forEach((k) => {
      const b = Board.deserialize(k);
      const g = Solver.grade(b);
      specs.forEach((sp, m) => {
        if (m === a) return;
        tested++;
        if (Gen.accepts(sp, b, g).ok) {
          cross++;
          if (firsts.length < 5) firsts.push({ from: st.label, alsoIn: sp.name, key: k });
        }
      });
    });
  });
  console.log("  cross-tier acceptance: " + cross + " of " + tested + " (board, foreign tier) pairs");
  firsts.forEach((f) => console.log("    CROSS: " + f.from + " also accepted by " + f.alsoIn));
  return cross === 0;
}

/* ------------------------------------------------------------------- runner */

function modeBands() {
  section("E. CANDIDATE BANDS — run through the generator's own unmodified gate");
  const seeds = N || 300;

  /* Tier 5 as it ships, measured on the same seed set for comparison. */
  const t5 = Gen.tierFor(5);
  const t5spec = JSON.parse(JSON.stringify(t5));
  t5spec.name = "T5 gridlock";
  const r5 = measureBand(t5spec, seeds);
  reportBand(r5);

  /* Separation is engineered on TWO disjoint axes at once, so cross-tier
     acceptance is impossible by arithmetic rather than by luck:
       effort  T5 [190,285]  T6 [286,352]  T7 [353,520]
       depth   T5 [13, 26]   T6 [21, 28]   T7 [29, 46]
     effort ~= 10*depth + 73 at this altitude (18 for minW=1, ~20 for trap
     0.8, ~5 for meanRay 2.5, ~30 for 50 arrows), which is where the two
     windows above were cut. */
  const cands = [];

  /* T6 variants — the wall question. B/A5/A7 all say walls LOWER depth, so
     three wall settings are measured rather than assumed. */
  const T6BASE = {
    w: 7, h: 9, arrows: [42, 56], depth: [21, 28],
    minRoundWidth: [1, 1], effort: [286, 352], sky: [0, 6], forcedRun: [6, 99],
    aim: [28, 38], bias: { block: [6, 10], ray: [12, 18] }, attempts: 2000
  };
  cands.push(Object.assign({ name: "T6-a walls 3-6", walls: [3, 6] }, T6BASE));
  cands.push(Object.assign({ name: "T6-b walls 2-5", walls: [2, 5] }, T6BASE));
  cands.push(Object.assign({ name: "T6-c walls 0-3", walls: [0, 3] }, T6BASE));
  /* "more walls than Gridlock" is the intuitive lever. Measured, not assumed. */
  cands.push(Object.assign({ name: "T6-d walls 4-7", walls: [4, 7] }, T6BASE));
  cands.push(Object.assign({ name: "T6-e walls 6-9", walls: [6, 9] }, T6BASE));

  const T7BASE = {
    w: 7, h: 9, arrows: [42, 58], depth: [29, 46],
    minRoundWidth: [1, 1], effort: [353, 520], sky: [0, 6], forcedRun: [12, 99],
    aim: [34, 46], bias: { block: [6, 10], ray: [12, 18] }, attempts: 6000
  };
  cands.push(Object.assign({ name: "T7-a walls 3-6", walls: [3, 6] }, T7BASE));
  cands.push(Object.assign({ name: "T7-b walls 1-4", walls: [1, 4] }, T7BASE));
  cands.push(Object.assign({ name: "T7-c walls 0-2", walls: [0, 2] }, T7BASE));
  cands.push(Object.assign({ name: "T7-d walls 2-5", walls: [2, 5] }, T7BASE));

  const out = [r5];
  cands.forEach((c) => { const r = measureBand(c, seeds); reportBand(r); out.push(r); });
  return out;
}

/* ----------------------------------------------------------------- mode: audit

   test/verify.js hard-codes `for (t = 1; t <= 5)` and a hand-transcribed
   SPEC_TIERS of length 5, so tiers 6 and 7 are NOT covered by it and I was
   asked not to edit test/. This mode is the stopgap: an INDEPENDENT closure,
   written here from SPEC.md's rules and calling nothing from js/solver.js,
   re-derives depth / round widths / trap / rays straight from the serialized
   string and must agree with the shipped grade on every emitted board. It is
   not a substitute for the harness — it is written by the same hand as the
   thing it checks — but it does catch a board that does not actually clear. */

function auditDecode(str) {
  const parts = str.split(";");
  const w = parseInt(parts[1], 10), h = parseInt(parts[2], 10);
  return { w, h, g: parts[3].split("") };
}
const A_DIRS = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

/* my own ray scan: from the next cell to off the edge; "." (sky) and "-" do
   not block; "#" and any arrow do. */
function auditRay(m, i) {
  const c = m.g[i];
  const d = A_DIRS[c];
  if (!d) return null;
  let x = (i % m.w) + d[0], y = Math.floor(i / m.w) + d[1];
  const cells = [];
  while (x >= 0 && y >= 0 && x < m.w && y < m.h) {
    cells.push(y * m.w + x);
    x += d[0]; y += d[1];
  }
  return cells;
}
function auditFree(m, i) {
  const ray = auditRay(m, i);
  if (!ray) return false;
  for (const k of ray) {
    const v = m.g[k];
    if (v === "#" || A_DIRS[v]) return false;
  }
  return true;
}
function auditClosure(m) {
  const work = { w: m.w, h: m.h, g: m.g.slice() };
  const widths = [];
  let removed = 0, startFree = -1;
  for (;;) {
    const free = [];
    for (let i = 0; i < work.g.length; i++) if (auditFree(work, i)) free.push(i);
    if (startFree < 0) startFree = free.length;
    if (!free.length) break;
    widths.push(free.length);
    free.forEach((i) => { work.g[i] = "-"; });
    removed += free.length;
  }
  let left = 0;
  for (let i = 0; i < work.g.length; i++) if (A_DIRS[work.g[i]]) left++;
  let arrows = 0, rayTotal = 0, maxRay = 0;
  for (let i = 0; i < m.g.length; i++) {
    if (!A_DIRS[m.g[i]]) continue;
    arrows++;
    const len = auditRay(m, i).length;
    rayTotal += len;
    if (len > maxRay) maxRay = len;
  }
  return {
    solved: left === 0, stuck: left, depth: widths.length, widths,
    arrows, removed, startFree,
    trap: arrows ? (arrows - startFree) / arrows : 0,
    meanRay: arrows ? rayTotal / arrows : 0, maxRay
  };
}

function modeAudit() {
  const seeds = N || 300;
  section("J. INDEPENDENT AUDIT of tiers 6 and 7 (verify.js only covers 1-5)");
  console.log("closure re-implemented in this file from SPEC.md; js/solver.js is not called.\n");
  let boards = 0, notSolved = 0, mismatch = 0, offBand = 0;
  const firstBad = [];
  [6, 7].forEach((t) => {
    const spec = Gen.tierFor(t);
    let n = 0, dead = 0;
    for (let s = 1; s <= seeds; s++) {
      const res = Gen.generate(s, t);
      if (!res.board) { dead++; continue; }
      n++; boards++;
      const m = auditDecode(Board.serialize(res.board));
      const mine = auditClosure(m);
      const theirs = Solver.grade(res.board);
      if (!mine.solved) {
        notSolved++;
        if (firstBad.length < 3) firstBad.push({ why: "does not clear", tier: t, seed: s, stuck: mine.stuck });
      }
      if (mine.depth !== theirs.depth || mine.arrows !== theirs.arrows ||
          mine.maxRay !== theirs.maxRay ||
          Math.abs(mine.trap - theirs.trapFraction) > 0.002 ||
          Math.abs(mine.meanRay - theirs.meanRay) > 0.002 ||
          Math.min.apply(null, mine.widths) !== theirs.minRoundWidth) {
        mismatch++;
        if (firstBad.length < 3) firstBad.push({ why: "grade mismatch", tier: t, seed: s, mine, theirs });
      }
      /* and the band, re-checked against my own numbers */
      const myRun = widthOnes(mine.widths).w1run;
      if (mine.depth < spec.depth[0] || mine.depth > spec.depth[1] ||
          mine.arrows < spec.arrows[0] || mine.arrows > spec.arrows[1] ||
          myRun < spec.forcedRun[0] || myRun > spec.forcedRun[1]) {
        offBand++;
        if (firstBad.length < 3) firstBad.push({ why: "off band", tier: t, seed: s, depth: mine.depth, run: myRun });
      }
    }
    console.log("  tier " + t + ": " + n + " boards audited, " + dead + " dead seeds");
  });
  firstBad.forEach((b) => console.log("  BAD: " + JSON.stringify(b)));
  console.log("  boards " + boards + " | not solved by MY closure: " + notSolved +
    " | grade mismatches: " + mismatch + " | off their own band by MY numbers: " + offBand);
  console.log("  audit: " + (notSolved + mismatch + offBand === 0 ? "CLEAN" : "FAILURES ABOVE"));
}

/* ----------------------------------------------------------------- mode: final

   Measures the bands EXACTLY AS THEY SIT IN js/generator.js — nothing is
   injected here — over a large seed set, then checks the two properties the
   ladder has to satisfy: median(Tn) > max(Tn-1), and no board accepted by a
   foreign tier's gate. */
function modeFinal() {
  const seeds = N || 1000;
  section("G. SHIPPED BANDS — tiers 5, 6, 7 as written in js/generator.js");
  console.log(seeds + " seeds per tier, generated through the unmodified gate.\n");
  const stats = [];
  [5, 6, 7].forEach((t) => {
    const spec = Gen.tierFor(t);
    const r = {
      label: spec.name, spec, seeds, dead: [], attempts: [], candidates: 0,
      depth: [], effort: [], arrows: [], walls: [], minW: [], w1run: [], w1count: [],
      trap: [], meanRay: [], maxRay: [], keys: [], rejects: {}, ms: 0
    };
    const t0 = Date.now();
    for (let s = 1; s <= seeds; s++) {
      const g0 = Gen.generate(s, t);
      r.candidates += g0.attempts;
      for (const k in g0.rejects) r.rejects[k] = (r.rejects[k] || 0) + g0.rejects[k];
      if (!g0.board) { r.dead.push(s); continue; }
      const g = g0.grade;
      const w1 = widthOnes(g.roundWidths);
      r.attempts.push(g0.attempts);
      r.depth.push(g.depth); r.effort.push(g.effort); r.arrows.push(g.arrows);
      r.walls.push(g.walls); r.minW.push(g.minRoundWidth);
      r.w1run.push(w1.w1run); r.w1count.push(w1.w1count);
      r.trap.push(g.trapFraction); r.meanRay.push(g.meanRay); r.maxRay.push(g.maxRay);
      r.keys.push(g0.key);
    }
    r.ms = Date.now() - t0;
    r.hitRate = r.candidates ? r.attempts.length / r.candidates : 0;
    r.callRate = r.attempts.length / seeds;
    reportBand(r);
    console.log("  trap min/p50/max " + f3(mn(r.trap)) + "/" + f3(pct(r.trap, 50)) + "/" + f3(mx(r.trap)) +
      "   meanRay " + f2(mn(r.meanRay)) + "/" + f2(pct(r.meanRay, 50)) + "/" + f2(mx(r.meanRay)) +
      "   walls " + mn(r.walls) + "-" + mx(r.walls));
    console.log("  cost: " + r.ms + "ms total, " + f2(r.ms / seeds) + "ms per level, " +
      f3(r.ms / r.candidates) + "ms per candidate");
    stats.push(r);
  });

  separation(stats);
  section("H. CROSS-TIER — no board may satisfy another tier's band");
  const allSpecs = [1, 2, 3, 4, 5, 6, 7].map((t) => Gen.tierFor(t));
  const idxOf = { "tier-5": 4, "tier-6": 5, "tier-7": 6 };
  let cross = 0, tested = 0;
  const firsts = [];
  stats.forEach((st) => {
    const own = idxOf[st.label];
    st.keys.forEach((k) => {
      const b = Board.deserialize(k);
      const g = Solver.grade(b);
      allSpecs.forEach((sp, m) => {
        if (m === own) return;
        tested++;
        if (Gen.accepts(sp, b, g).ok) {
          cross++;
          if (firsts.length < 5) firsts.push(st.label + " also accepted by " + sp.name + " : " + k);
        }
      });
    });
  });
  console.log("  " + tested + " (board, foreign tier) pairs tested across all 7 bands; accepted: " + cross);
  firsts.forEach((f) => console.log("    CROSS: " + f));
  console.log("  cross-tier exclusivity: " + (cross === 0 ? "HOLDS" : "BROKEN"));

  section("I. WHAT ACTUALLY CHANGES FROM TIER TO TIER");
  console.log(pad("", 12) + lpad("depth p50", 10) + lpad("effort p50", 11) +
    lpad("forcedRun", 11) + lpad("trap", 7) + lpad("meanRay", 9) + lpad("arrows", 8) + lpad("walls", 7));
  stats.forEach((r) => {
    console.log(pad(r.label, 12) + lpad(pct(r.depth, 50), 10) + lpad(f1(pct(r.effort, 50)), 11) +
      lpad(pct(r.w1run, 50), 11) + lpad(f2(pct(r.trap, 50)), 7) + lpad(f2(pct(r.meanRay, 50)), 9) +
      lpad(pct(r.arrows, 50), 8) + lpad(pct(r.walls, 50), 7));
  });
  return stats;
}

console.log("FLIGHTPATH — tier feasibility sweep   node " + process.version);
console.log("grid is CAPPED at 7 wide x 9 tall (measured, iPhone SE 375x667). Nothing below grows it.");

if (MODE === "frontier" || MODE === "all") modeFrontier();
if (MODE === "levers" || MODE === "all") modeLevers();
if (MODE === "push" || MODE === "all") modePush();
if (MODE === "bottleneck" || MODE === "all") modeBottleneck();
if (MODE === "effort" || MODE === "all") modeEffort();
if (MODE === "bands" || MODE === "all") modeBands();
if (MODE === "final" || MODE === "all") modeFinal();
if (MODE === "audit" || MODE === "all") modeAudit();

module.exports = { probe, measureBand, widthOnes, separation, crossTier, pct, mn, mx, avg };

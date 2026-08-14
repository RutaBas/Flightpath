"use strict";

/* FLIGHTPATH — game controller. NO DOM IN THIS FILE.

   Everything here is state plus transitions over a board, so the verified logic
   core (board.js / solver.js / generator.js, none of which this file touches)
   stays headlessly testable and the hint can call the real solver rather than a
   UI-side reimplementation. js/ui.js owns every element, animation and screen;
   it asks this module what happened and paints it.

   NO PROGRESSION LIVES HERE EITHER. Stars, unlocks, streaks, records and the
   level ladder are the shared meta-layer's job (js/meta/*, configured in
   js/meta-config.js). This file knows how to build and play ONE board, and
   reports what happened; js/ui.js hands that to Meta.recordWin() in exactly one
   place. What a level IS comes from the baked table (js/levels.js).

   THE RULE, once: a tap on an arrow launches it iff every cell along its ray to
   the edge holds no arrow and no wall. A tap on a blocked arrow leaves the
   board unchanged and spends a life. Clear every arrow to win; reach zero lives
   to lose.

   MISTAKES ARE COUNTED HERE, FROM THE BOARD — an actually-attempted tap on an
   arrow the solver says is blocked. Never from a button press. */

var FPGame = (function (root) {

  var Board = root.FlightpathBoard;
  var Solver = root.FlightpathSolver;
  var Generator = root.FlightpathGenerator;

  var LIVES = 3;                 // three lives per level
  var HINTS = 3;                 // hints per level; the first one costs a star

  /* --------------------------------------------------------- generation -- */

  /* Deterministic: a seed always yields the same board. generate() never throws
     and never loops forever — it returns { board: null } if a seed's attempt
     budget runs out. A salted retry keeps the seed string injective rather than
     nudging the tier band. */
  function build(seed, tierIndex) {
    var res = Generator.generate(seed, tierIndex);
    for (var salt = 1; !res.board && salt <= 4; salt++) {
      res = Generator.generate(String(seed) + "|r" + salt, tierIndex);
    }
    return res;
  }

  /* -------------------------------------------------------------- state -- */

  function makeHistory(state) {
    return new History({
      limit: 120,
      apply: function (op) {
        if (op.t === "set") { state.board.cells[op.i] = op.prev; return; }
        if (op.t === "multi") {
          for (var a = op.changes.length - 1; a >= 0; a--) {
            state.board.cells[op.changes[a].i] = op.changes[a].prev;
          }
        }
      }
    });
  }

  function newState(fields) {
    var state = {
      mode: fields.mode,               // "level" | "daily" | "free"
      tierKey: fields.tierKey,
      tierIndex: fields.tierIndex,
      level: fields.level || 0,        // 1..40 within the tier, campaign only
      dateKey: fields.dateKey || "",   // daily only
      seed: fields.seed,
      board: fields.board,
      startStr: Board.serialize(fields.board),
      par: fields.par || 0,
      grade: fields.grade || null,
      lives: LIVES,
      mistakes: 0,
      hints: 0,
      elapsed: 0,
      over: null,                      // null | "win" | "lose"
      lastBlock: null,                 // { idx, blocker } — the tap that ended it
      armHint: !!fields.armHint
    };
    state.hist = makeHistory(state);
    return state;
  }

  /* A campaign level: identity is (tierKey, level), the seed comes from the
     baked table, and par comes from the same row so the ladder and the daily
     price a board the same way. */
  function createLevel(tierKey, level, opts) {
    opts = opts || {};
    var seed = FPLevels.seedFor(tierKey, level);
    if (!seed) return null;
    var tierIndex = Meta.tierIndex(tierKey);
    var res = build(seed, tierIndex);
    if (!res.board) return null;
    return newState({
      mode: "level", tierKey: tierKey, tierIndex: tierIndex, level: level,
      seed: seed, board: res.board, grade: res.grade,
      /* Par is computed from the board that was actually built, exactly as the
         daily does — the table stores no per-level par, and nothing here has to
         trust an approximation. Same function, same grade, same answer. */
      par: FPPar.parForGrade(tierKey, res.grade), armHint: opts.armHint
    });
  }

  /* The daily: identity is the UTC date key, the seed is derived from the date
     (never from a counter), and par is computed live from the graded board by
     the same js/par.js the table was baked with.

     opts.boardStr replays a FROZEN past daily — see js/ui.js, which stores the
     board alongside the result so a generator change can never make the
     calendar show a board that is no longer what was played that day. */
  function createDaily(dateKey, tierKey, opts) {
    opts = opts || {};
    var tierIndex = Meta.tierIndex(tierKey);
    var board = null, grade = null;
    var seed = Generator.dailySeed(dateKey);
    if (opts.boardStr) {
      try { board = Board.deserialize(opts.boardStr); } catch (e) { board = null; }
      if (board) grade = Solver.grade(board);
    }
    if (!board) {
      var res = build(seed, tierIndex);
      if (!res.board) return null;
      board = res.board;
      grade = res.grade;
    }
    return newState({
      mode: "daily", tierKey: tierKey, tierIndex: tierIndex, dateKey: dateKey,
      seed: seed, board: board, grade: grade,
      par: FPPar.parForGrade(tierKey, grade), armHint: opts.armHint
    });
  }

  /* Rebuild the same board from its own start string — no regeneration, so a
     restart is instant and identical. */
  function restart(state, opts) {
    opts = opts || {};
    return newState({
      mode: state.mode, tierKey: state.tierKey, tierIndex: state.tierIndex,
      level: state.level, dateKey: state.dateKey, seed: state.seed,
      board: Board.deserialize(state.startStr), grade: state.grade,
      par: state.par, armHint: opts.armHint
    });
  }

  /* ------------------------------------------------------------ the tap -- */

  /* tap(state, i) -> one of
       { type:"none" }
       { type:"launch",  idx, dir, ray, remaining, won }
       { type:"blocked", idx, dir, blocker, ray, lives, lost }

     `ray` on a blocked tap is the prefix of the lane up to and including the
     blocker: that is the span the UI lights up, because it is the reason the
     tap failed and the player paid a life to learn it. */
  function tap(state, i) {
    if (!state || state.over) return { type: "none" };
    var v = state.board.cells[i];
    if (!Board.isArrow(v)) return { type: "none" };

    if (Solver.isFree(state.board, i)) {
      state.hist.pushSet(i, v);            // prev captured BEFORE the mutation
      state.board.cells[i] = Board.OPEN;
      var remaining = Board.countArrows(state.board);
      if (remaining === 0) state.over = "win";
      return {
        type: "launch",
        idx: i,
        dir: v,
        ray: Solver.rayCells(state.board, i, v),
        remaining: remaining,
        won: remaining === 0
      };
    }

    /* Blocked: the board is unchanged and it costs a life. */
    var blocker = Solver.firstBlocker(state.board, i);
    var full = Solver.rayCells(state.board, i);
    var upTo = [];
    for (var k = 0; k < full.length; k++) {
      upTo.push(full[k]);
      if (full[k] === blocker) break;
    }
    state.mistakes++;
    state.lives--;
    state.lastBlock = { idx: i, blocker: blocker };
    if (state.lives <= 0) { state.lives = 0; state.over = "lose"; }
    return {
      type: "blocked",
      idx: i,
      dir: v,
      blocker: blocker,
      ray: upTo,
      lives: state.lives,
      lost: state.over === "lose"
    };
  }

  /* --------------------------------------------------------------- undo -- */

  /* Puts the last launched arrow back. It does NOT refund a life and does NOT
     lower the mistake count, so undo can never buy back a star.

     It is safe to be generous with it because removal is monotone (SPEC.md
     fact 1): an arrow that was free stays free, the free set only grows, and
     the terminal state is the same whatever order you tap in. A player can
     therefore never be bricked by a bad order — undo is a convenience, not a
     rescue. */
  function undo(state) {
    if (!state || state.over) return null;
    var changed = state.hist.undo();
    if (!changed || !changed.op || changed.op.t !== "set") return null;
    return { idx: changed.op.i, dir: state.board.cells[changed.op.i] };
  }

  function canUndo(state) { return !!state && !state.over && state.hist.canUndo(); }

  /* --------------------------------------------------------------- hint -- */

  /* Straight through to the real solver: the next provable deduction from the
     CURRENT board, never a lookup of a stored answer. solver.hint() re-verifies
     the cell it names with a fresh full-ray scan, so a hint can never cost a
     life. Only a hint that actually found something is charged. */
  function hint(state) {
    if (!state || state.over) return { found: false, reason: "The level is over." };
    if (state.hints >= HINTS) {
      return { found: false, exhausted: true, reason: "No hints left on this level." };
    }
    var h = Solver.hint(state.board);
    if (h.found) state.hints++;
    return h;
  }

  function hintsLeft(state) { return Math.max(0, HINTS - (state ? state.hints : 0)); }

  /* -------------------------------------------------------------- stats -- */

  /* The same rule the meta-layer applies (Meta.starsFor) — kept here only so
     the board screen can show what a clear is currently worth WITHOUT the win
     handler having a second opinion. Meta remains the one that records it. */
  function stars(state) {
    var slips = state.mistakes + state.hints;
    if (slips === 0) return 3;
    if (slips === 1) return 2;
    return 1;
  }

  function remaining(state) { return Board.countArrows(state.board); }
  function freeCount(state) { return Solver.freeSet(state.board).length; }

  /* Every arrow still stuck, with the blocker pinning it — the fail screen's
     reveal. Explanatory only; nothing here decides freeness. */
  function blockedLanes(state) {
    var out = [];
    var arrows = Board.arrowIndices(state.board);
    for (var k = 0; k < arrows.length; k++) {
      var i = arrows[k];
      if (Solver.isFree(state.board, i)) continue;
      var b = Solver.firstBlocker(state.board, i);
      if (b < 0) continue;
      out.push({ idx: i, blocker: b, kind: state.board.cells[b] === Board.WALL ? "wall" : "arrow" });
    }
    return out;
  }

  /* --------------------------------------------------------------- save -- */

  function toSave(state, elapsedMs) {
    return {
      mode: state.mode,
      tierKey: state.tierKey,
      level: state.level,
      dateKey: state.dateKey,
      seed: state.seed,
      par: state.par,
      board: Board.serialize(state.board),
      start: state.startStr,
      lives: state.lives,
      mistakes: state.mistakes,
      hints: state.hints,
      elapsed: elapsedMs || 0,
      ops: state.hist.toJSON()
    };
  }

  /* Returns null for anything unusable — a save that cannot be turned back into
     a board is discarded, never half-restored. */
  function fromSave(save) {
    if (!save || !save.board || !save.tierKey) return null;
    var board, start;
    try {
      board = Board.deserialize(save.board);
      start = save.start ? String(save.start) : Board.serialize(board);
      Board.deserialize(start);
    } catch (e) { return null; }
    if (!Board.validate(board).ok) return null;
    if (!Meta.tierByKey(save.tierKey)) return null;
    if (Board.countArrows(board) === 0) return null;   // a finished win is not resumable

    var state = {
      mode: save.mode || "level",
      tierKey: save.tierKey,
      tierIndex: Meta.tierIndex(save.tierKey),
      level: save.level || 0,
      dateKey: save.dateKey || "",
      seed: save.seed,
      board: board,
      startStr: start,
      par: save.par || 0,
      grade: null,
      lives: typeof save.lives === "number" ? Math.max(0, Math.min(LIVES, save.lives)) : LIVES,
      mistakes: save.mistakes || 0,
      hints: save.hints || 0,
      elapsed: save.elapsed || 0,
      over: null,
      lastBlock: null,
      armHint: false
    };
    if (state.lives <= 0) return null;                 // nor is a finished loss
    state.hist = makeHistory(state);
    state.hist.fromJSON(Array.isArray(save.ops) ? save.ops : []);
    return state;
  }

  return {
    LIVES: LIVES, HINTS: HINTS,
    createLevel: createLevel, createDaily: createDaily, restart: restart,
    tap: tap, undo: undo, canUndo: canUndo,
    hint: hint, hintsLeft: hintsLeft,
    stars: stars, remaining: remaining, freeCount: freeCount,
    blockedLanes: blockedLanes,
    toSave: toSave, fromSave: fromSave
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

if (typeof module !== "undefined" && module.exports) module.exports = FPGame;

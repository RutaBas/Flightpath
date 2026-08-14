"use strict";

/* Undo — an op log of inverse operations. Copied from
   games/_recipes/undo-history/history.js.txt.

   THE MODEL
   Every mutation pushes an op describing how to REVERSE it — the previous
   value, not the new one. Undo pops and applies. No forward replay, no
   re-running the rules, so undo cannot itself trigger a launch or a win.

   FLIGHTPATH ONLY USES `set`: one launched arrow, one cell, one previous
   direction. `multi` and `bulk` are kept because the recipe's shape is what a
   later feature (a "clear the lane" power, a restart-with-undo) would need,
   and because the save format is versioned around this shape.

   WHAT UNDO COSTS HERE — decided deliberately, per the recipe's warning:
   NOTHING. Undo does not refund a spent life and does not lower the mistake
   count, so it cannot buy back a star. It is legitimate to be generous with it
   because removal in this game is monotone (SPEC.md fact 1): an arrow that was
   free stays free, so the player can never be bricked by a bad order and undo
   is a convenience, never a rescue. */

var History = (function () {

  function History(opts) {
    if (!(this instanceof History)) return new History(opts);
    opts = opts || {};
    this.ops = [];
    this.limit = opts.limit || 200;   // bounded: an unbounded log blows the
    this.apply = opts.apply;          // localStorage quota and fails the SAVE
  }

  History.prototype.push = function (op) {
    this.ops.push(op);
    if (this.ops.length > this.limit) this.ops.shift();
    return op;
  };

  History.prototype.pushSet = function (i, prev) {
    return this.push({ t: "set", i: i, prev: prev });
  };

  History.prototype.pushMulti = function (changes) {
    if (!changes || !changes.length) return null;
    if (changes.length === 1) return this.pushSet(changes[0].i, changes[0].prev);
    return this.push({ t: "multi", changes: changes.slice() });
  };

  History.prototype.pushBulk = function (snapshot) {
    return this.push({ t: "bulk", prev: snapshot });
  };

  History.prototype.canUndo = function () { return this.ops.length > 0; };
  History.prototype.depth = function () { return this.ops.length; };
  History.prototype.clear = function () { this.ops.length = 0; };
  History.prototype.peek = function () { return this.ops[this.ops.length - 1] || null; };

  /* Returns what changed so the caller can repaint only those cells, or null
     when there is nothing to undo. */
  History.prototype.undo = function () {
    var op = this.ops.pop();
    if (!op) return null;
    if (this.apply) this.apply(op);

    if (op.t === "set") return { cells: [op.i], op: op };
    if (op.t === "multi") {
      var cells = [];
      /* Backwards: two ops touching one cell must unwind in reverse or the
         earlier `prev` wins. */
      for (var a = op.changes.length - 1; a >= 0; a--) cells.push(op.changes[a].i);
      return { cells: cells, op: op };
    }
    if (op.t === "bulk") return { bulk: true, op: op };
    return null;
  };

  /* Serialise for the save. Ops stay plain JSON — a typed array in a bulk
     snapshot would come back from JSON.parse as {"0":1,...}. */
  History.prototype.toJSON = function () { return this.ops; };
  History.prototype.fromJSON = function (ops) {
    this.ops = Array.isArray(ops) ? ops : [];
  };

  return History;
})();

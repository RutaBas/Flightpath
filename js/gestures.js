"use strict";

/* Grid board gestures — copied from games/_recipes/pointer-gestures/gestures.js.txt
   and reduced to the TAP path only, because Flightpath is a tap-only game.

   WHAT WAS KEPT
     - Pointer Events, not touch events, so mouse and stylus work for free.
     - setPointerCapture on the BOARD, not the tile. Without it a pointer that
       leaves the starting tile stops delivering pointermove and the press
       visual never clears.
     - onPress(cell, on) for the pressed visual, cleared on every exit path.

   WHAT WAS DROPPED, AND WHAT REPLACED IT
     The swipe path and its `swiped` latch are gone — there is no swipe in this
     game. The problem the latch solved (one gesture must not resolve into a
     move the player did not ask for) still exists here in a different form: a
     tap in Flightpath can cost a LIFE, so a drag that wanders off the tile
     must not fire. So the recipe's distance threshold is reused as a CANCEL
     slop instead of a swipe trigger: move further than `slop` px, or release
     over a different cell, and nothing fires. That is standard button
     behaviour and the only safe reading of an ambiguous gesture in a game
     where a wrong tap is punished. */

var Gestures = (function () {

  /* attach(el, opts) -> detach function

     opts:
       cellFromEvent(e)  required. Map a pointer event to your cell, or null.
       slop              px of movement that cancels the tap. Pass a function
                         of tile size — a fixed pixel value is wrong on both a
                         small phone and a large tablet.
       onTap(cell)       release, still on the same cell, inside the slop
       onPress(cell,on)  press-visual toggle; called with true then false
       enabled()         return false to ignore input (mid-animation, game over)
       sameCell(a,b)     equality test for cells; defaults to strict === */
  function attach(el, opts) {
    opts = opts || {};
    var cellFromEvent = opts.cellFromEvent;
    var enabled = opts.enabled || function () { return true; };
    var noop = function () {};
    var onTap = opts.onTap || noop;
    var onPress = opts.onPress || noop;
    var sameCell = opts.sameCell || function (a, b) { return a === b; };

    var down = null;   // { cell, x, y, dead }

    function slop() {
      return typeof opts.slop === "function" ? opts.slop() : (opts.slop || 24);
    }

    function release() {
      if (down) onPress(down.cell, false);
      down = null;
    }

    function onDown(e) {
      if (!enabled()) return;
      if (e.button !== undefined && e.button !== 0) return;
      var cell = cellFromEvent(e);
      if (cell === null || cell === undefined) return;
      down = { cell: cell, x: e.clientX, y: e.clientY, dead: false };
      onPress(cell, true);
      /* Capture on the board, not the tile: otherwise a pointer that leaves
         the starting tile stops delivering move/up here. */
      try { el.setPointerCapture(e.pointerId); } catch (x) {}
      e.preventDefault();
    }

    function onMove(e) {
      if (!down || down.dead) return;
      var dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.sqrt(dx * dx + dy * dy) < slop()) return;
      /* Wandered too far — kill the press visual but keep the record, so the
         following pointerup cannot be read as a tap either. */
      onPress(down.cell, false);
      down.dead = true;
    }

    function onUp(e) {
      if (!down) return;
      var cell = down.cell;
      var dead = down.dead;
      onPress(cell, false);
      down = null;
      if (dead) return;
      if (!enabled()) return;
      /* Released over a different cell? Not a tap. */
      var over = cellFromEvent(e);
      if (over === null || over === undefined || !sameCell(over, cell)) return;
      onTap(cell);
    }

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", release);

    return function detach() {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", release);
      release();
    };
  }

  return { attach: attach };
})();

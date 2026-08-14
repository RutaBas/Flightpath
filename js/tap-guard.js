"use strict";

/* ios-tap-hygiene — the JS half, copied from
   games/_recipes/ios-tap-hygiene/tap-guard.js.txt. CSS cannot cover these three.

   Called once from UI.init(), after the DOM exists. */

var TapGuard = (function () {

  function install(opts) {
    opts = opts || {};

    /* 1. Pinch / gesture zoom. Safari fires these proprietary events; nothing
          in CSS stops them. */
    document.addEventListener("gesturestart", function (e) { e.preventDefault(); });
    document.addEventListener("gesturechange", function (e) { e.preventDefault(); });

    /* 2. Double-tap zoom belt-and-braces. touch-action:manipulation covers
          every element that has it, but a fast double tap on the gap BETWEEN
          tiles (the board bed) can still zoom.

          touchend, not touchstart: cancelling at start would eat legitimate
          fast taps, and in Flightpath fast repeated tapping IS the mechanic.
          Preventing the default on touchend only suppresses the synthesised
          click; the pointerdown/pointerup pair the board listens to is
          unaffected. */
    var lastTouch = 0;
    document.addEventListener("touchend", function (e) {
      var now = Date.now();
      if (now - lastTouch <= 300) e.preventDefault();
      lastTouch = now;
    }, { passive: false });

    /* 3. Long-press context menu — -webkit-touch-callout:none does not cover
          a long press on an SVG tile. */
    document.addEventListener("contextmenu", function (e) {
      if (opts.allowContextMenu) return;
      e.preventDefault();
    });
  }

  return { install: install };
})();

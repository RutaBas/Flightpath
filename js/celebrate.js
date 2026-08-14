"use strict";

/* Win celebration + the reduced-motion gate that wraps it. Copied from
   games/_recipes/celebration-and-motion/celebrate.js.txt; the particle shape
   and colours are Flightpath's own (design-screens.html: 8x3px slivers in the
   signal-lamp amber, smoke grey, complete green).

   The blanket CSS rule that stops decorative ambience lives at the bottom of
   css/style.css — the JS gate here is only half of it. */

var Celebrate = (function () {

  /* Queried live, never cached at load: iOS lets the setting change while the
     app is open, and a cached value strands a player mid-session. */
  function reduced() {
    return !!(window.matchMedia &&
              window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  /* Flightpath's own palette, as CSS custom-property names. */
  var COLORS = ["--accent", "--dom", "--ok", "--accent"];

  function confetti(host, opts) {
    opts = opts || {};
    if (reduced()) return;              // the gate — no particles at all
    if (!host) return;

    var colors = opts.colors || COLORS;
    var count = opts.count || 46;
    var w = window.innerWidth, h = window.innerHeight;
    var ox = opts.x === undefined ? w * 0.5 : opts.x;
    var oy = opts.y === undefined ? h * 0.42 : opts.y;

    for (var k = 0; k < count; k++) {
      (function (k) {
        var p = document.createElement("i");
        var len = 6 + Math.random() * 7;
        p.style.position = "absolute";
        p.style.width = len + "px";
        p.style.height = "3px";
        p.style.background = "var(" + colors[k % colors.length] + ")";
        p.style.left = (ox + (Math.random() - 0.5) * 120) + "px";
        p.style.top = (oy + (Math.random() - 0.5) * 60) + "px";
        p.style.opacity = "0.9";
        host.appendChild(p);

        /* Wind-tunnel drift: the spread is wider horizontally than it is tall,
           so the burst reads as air moving down the section rather than a
           firework. */
        var dx = (Math.random() - 0.5) * w * 1.05;
        var dy = h * (0.30 + Math.random() * 0.55);
        var rot = (Math.random() - 0.5) * 720;
        var dur = 900 + Math.random() * 700;

        var anim = p.animate(
          [{ transform: "translate(0,0) rotate(0deg)", opacity: 0.95 },
           { transform: "translate(" + dx + "px," + dy + "px) rotate(" + rot + "deg)", opacity: 0 }],
          { duration: dur, easing: "cubic-bezier(.2,.6,.4,1)", fill: "forwards" }
        );
        /* Remove on finish, not on a timeout: a backgrounded tab does not run
           animations, so a setTimeout fires while the particles are frozen
           on-screen and they vanish in place when the player returns. */
        anim.onfinish = function () { if (p.parentNode) p.remove(); };
      })(k);
    }
  }

  /* Run fn after ms, or immediately when motion is reduced. Used for the star
     landings and the win reveal, which would otherwise wait out animations the
     player has asked not to see.

     Reduced motion still gets the sound, the stars and the screen change — only
     the movement is cut. */
  function after(ms, fn) {
    if (reduced()) { fn(); return null; }
    return setTimeout(fn, ms);
  }

  /* A one-shot Web Animation with ONE code path for the caller:
       - `done` is always called EXACTLY once, whether the animation ran, was
         cancelled, was refused by the browser, or never started because motion
         is reduced. The caller must never call `done` itself.
       - Returns the Animation, or null when nothing was scheduled.

     The once-only latch is load-bearing. Callers cancel a `fill: forwards`
     animation from inside `done` (otherwise the finished transform sticks and
     the recycled tile stays off-screen), and cancelling re-entrantly fires
     `oncancel` — which without the latch would run the completion handler a
     second time and, on the winning tap, fire the whole win sequence twice. */
  function animate(el, frames, options, done) {
    var fired = false;
    function fire() { if (fired) return; fired = true; if (done) done(); }
    if (!el) { fire(); return null; }
    if (reduced()) { fire(); return null; }
    var a;
    try { a = el.animate(frames, options); }
    catch (e) { fire(); return null; }
    a.onfinish = fire;
    a.oncancel = fire;
    return a;
  }

  return { reduced: reduced, confetti: confetti, after: after, animate: animate };
})();

"use strict";

/* Elapsed time. Copied from games/_recipes/timer-and-pause/timer.js.txt.

   IN FLIGHTPATH THE CLOCK IS NEVER SHOWN DURING PLAY AND NEVER COSTS A STAR.
   It is recorded for stats only (design-brief.md, stage 7: "No timer is
   displayed; elapsed time is recorded for stats only and never costs a star").
   That is exactly why it still has to be right: a wrong time is written to the
   record and stays wrong forever, and nobody is watching it during play to
   notice. `onTick` is left unused — nothing repaints — so the interval never
   starts and the clock is pure wall-clock arithmetic.

   THE MODEL
     base    — ms banked from previous running stretches
     startMs — wall-clock time the current stretch began, or 0 when stopped
     elapsed() = base + (startMs ? now - startMs : 0)

   Deliberately NOT a counter incremented by setInterval: a backgrounded iOS
   tab does not run the interval, and an accumulated clock silently loses
   minutes. */

var Timer = (function () {

  function Timer(opts) {
    if (!(this instanceof Timer)) return new Timer(opts);
    opts = opts || {};
    this.base = 0;
    this.startMs = 0;
    this.onTick = opts.onTick || null;   // repaint only; unused in this game
    this.every = opts.every || 250;
    this.handle = null;
    this.now = opts.now || function () { return Date.now(); };
  }

  Timer.prototype.elapsed = function () {
    return this.base + (this.startMs ? this.now() - this.startMs : 0);
  };

  Timer.prototype.running = function () { return !!this.startMs; };

  Timer.prototype.start = function () {
    if (this.startMs) return;            // idempotent: a double start would
    this.startMs = this.now();           // otherwise drop a whole stretch
    this._paint();
  };

  Timer.prototype.stop = function () {
    if (!this.startMs) return;
    this.base += this.now() - this.startMs;
    this.startMs = 0;
    this._paint(true);
  };

  Timer.prototype.reset = function (toMs) {
    this.base = toMs || 0;
    this.startMs = 0;
    this._paint(true);
  };

  /* Restore from a save; resumes STOPPED, so call start() when the board is
     interactive again. */
  Timer.prototype.restore = function (ms) { this.reset(ms || 0); };

  Timer.prototype._paint = function (once) {
    var self = this;
    if (this.handle) { clearInterval(this.handle); this.handle = null; }
    if (!this.onTick) return;
    this.onTick(this.elapsed());
    if (once || !this.startMs) return;
    this.handle = setInterval(function () {
      self.onTick(self.elapsed());
    }, this.every);
  };

  Timer.prototype.destroy = function () {
    if (this.handle) { clearInterval(this.handle); this.handle = null; }
  };

  /* isPlaying() must be false on menus, modals and the win/fail screens, or the
     clock runs while the player reads the how-to.
     pagehide as well as visibilitychange: iOS can kill a backgrounded web app
     without ever firing visibilitychange, and the unbanked stretch is lost. */
  Timer.attach = function (timer, isPlaying, onAutoPause) {
    function hide() {
      if (document.hidden) {
        if (timer.running()) { timer.stop(); if (onAutoPause) onAutoPause(); }
      } else if (isPlaying() && !timer.running()) {
        timer.start();
      }
    }
    function leave() { if (timer.running()) timer.stop(); }

    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", leave);
    return function detach() {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", leave);
    };
  };

  return Timer;
})();

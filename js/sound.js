"use strict";

/* Sound — WebAudio synthesis, iOS unlock, haptics, mute persistence.

   Structure copied from games/_recipes/audio-engine/sound.js.txt (lazy context,
   mute persistence, HAPTIC table keyed to S, unlock() from the first gesture).

   TWO DELIBERATE DEPARTURES FROM THE RECIPE, both for audition fidelity:

   1. The synthesis primitives here are `osc` / `nz` / `click` copied VERBATIM
      from design-sound.html, not the recipe's `tone` / `noise`. They differ in
      the envelope (exponential ramp up from 0.0001 rather than a linear ramp
      from 0) and in the noise buffer (flat, not decay-shaped). The recipe's
      instruction is that what ships must be what was auditioned; re-typing the
      tone table onto different primitives would ship something else. The
      recipe's own warning still holds and is why the ramps exist at all: never
      set gain directly, and exponentialRampToValueAtTime cannot target 0.

   2. The tone table is a CUSTOM MIX picked event by event across the three
      auditioned sets, per design-brief.md stage 6 — launch from C (Chamber
      Tone, the warmest, because it is heard 20-50 times a level), blocked and
      out-of-lives from B (Relay, mechanical, so a mistake is unmistakable),
      section clear from A (Airflow, the airiest, so the payoff has room).

   THE TABLE IS NOT MINE TO SUBSTITUTE. Keep the one-line comment per moment;
   it is what stops a later edit from quietly flattening the set.

   HAPTICS ARE INDEPENDENT OF MUTE — a player with the phone silent still gets
   8ms on a launch and 18ms on a blocked tap, which is what keeps the game
   readable without audio. navigator.vibrate is a no-op on iOS Safari today;
   harmless to keep, and it works on Android. */

var Sound = (function () {

  var MUTE_KEY = "fp:muted";        // unique to Flightpath
  var HAPTIC_KEY = "fp:haptics";

  var ctx = null;
  var enabled = true;
  var hapticsOn = true;

  try { enabled = localStorage.getItem(MUTE_KEY) !== "1"; } catch (e) {}
  try { hapticsOn = localStorage.getItem(HAPTIC_KEY) !== "0"; } catch (e) {}

  /* Built lazily on the first gesture: iOS refuses to start a context outside
     a user interaction, and one created too early stays permanently suspended
     even after the player taps. */
  function ac() {
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    } catch (e) { return null; }
  }

  /* --- primitives, verbatim from design-sound.html ---------------------- */

  function osc(o) {
    o = o || {};
    var C = ac(); if (!C) return;
    var type = o.type || "sine";
    var f0 = o.f0, f1 = o.f1 || null;
    var t0 = o.t0 || 0, dur = o.dur === undefined ? 0.2 : o.dur;
    var vol = o.vol === undefined ? 0.15 : o.vol;
    var detune = o.detune || 0, curve = o.curve || "exp";
    var t = C.currentTime + t0;
    var g = C.createGain(), s = C.createOscillator();
    s.type = type; s.detune.value = detune;
    s.frequency.setValueAtTime(f0, t);
    if (f1) {
      if (curve === "exp") s.frequency.exponentialRampToValueAtTime(f1, t + dur);
      else s.frequency.linearRampToValueAtTime(f1, t + dur);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(g); g.connect(C.destination);
    s.start(t); s.stop(t + dur + 0.03);
  }

  function nz(o) {
    o = o || {};
    var C = ac(); if (!C) return;
    var t0 = o.t0 || 0, dur = o.dur === undefined ? 0.2 : o.dur;
    var f0 = o.f0 === undefined ? 800 : o.f0, f1 = o.f1 || null;
    var q = o.q === undefined ? 1.2 : o.q;
    var vol = o.vol === undefined ? 0.12 : o.vol;
    var type = o.type || "bandpass";
    var t = C.currentTime + t0;
    var n = Math.max(1, Math.floor(C.sampleRate * dur));
    var buf = C.createBuffer(1, n, C.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    var s = C.createBufferSource(); s.buffer = buf;
    var b = C.createBiquadFilter();
    b.type = type; b.Q.value = q;
    b.frequency.setValueAtTime(f0, t);
    if (f1) b.frequency.exponentialRampToValueAtTime(f1, t + dur);
    var g = C.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.03, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(b); b.connect(g); g.connect(C.destination);
    s.start(t); s.stop(t + dur + 0.03);
  }

  function click(t0, vol) {
    nz({ t0: t0 || 0, dur: 0.012, f0: 2600, q: 0.7, vol: vol === undefined ? 0.16 : vol, type: "highpass" });
  }

  /* --- the moments — the signed-off custom mix, verbatim ---------------- */

  var S = {
    /* an arrow is released and gone: two sines lifting an octave, the second
       detuned +9 cents so they beat against each other (set C, Chamber Tone) */
    launch: function () {
      osc({ type: "sine", f0: 660, f1: 1320, dur: 0.26, vol: 0.10 });
      osc({ type: "sine", f0: 660, f1: 1320, dur: 0.26, vol: 0.06, detune: 9 });
    },

    /* the LAST arrow off the board, just before the win fires: the identical
       launch synthesis — same shape, same durations, same volumes, same +9
       cent detune — with both voices a fifth higher. design-brief.md stage 6
       asks for "launch tone, pitched up" here; this is that tone pitched, not
       a different sound. */
    launchLast: function () {
      osc({ type: "sine", f0: 990, f1: 1980, dur: 0.26, vol: 0.10 });
      osc({ type: "sine", f0: 990, f1: 1980, dur: 0.26, vol: 0.06, detune: 9 });
    },

    /* the lane was shut and it cost a life: a two-pulse relay buzz with a
       filtered contact burst, so a mistake is unmistakable (set B, Relay) */
    blocked: function () {
      osc({ type: "square", f0: 148, dur: 0.06, vol: 0.15 });
      osc({ type: "square", f0: 148, t0: 0.1, dur: 0.07, vol: 0.13 });
      nz({ t0: 0, dur: 0.05, f0: 260, q: 1.4, vol: 0.08 });
    },

    /* section clear — the biggest moment in the game: three swells opening up,
       then the chamber settling (set A, Airflow). Held back for real wins only. */
    win: function () {
      var swells = [0, 0.15, 0.3];
      var tone = [440, 554, 659], top = [880, 1108, 1318];
      for (var i = 0; i < swells.length; i++) {
        nz({ t0: swells[i], dur: 0.5, f0: 700 + i * 520, f1: 1500 + i * 900, q: 1.3, vol: 0.10 });
        osc({ type: "sine", f0: tone[i], f1: top[i], t0: swells[i], dur: 0.55, vol: 0.06 });
      }
      nz({ t0: 0.5, dur: 0.7, f0: 2400, f1: 600, q: 0.9, vol: 0.06 });
    },

    /* out of lives: four squares stepping down, then the fan spinning to a
       stop with one contact click (set B, Relay) */
    fail: function () {
      var f = [420, 330, 250, 186];
      for (var i = 0; i < f.length; i++) {
        osc({ type: "square", f0: f[i], t0: i * 0.11, dur: 0.09, vol: 0.12 });
      }
      osc({ type: "triangle", f0: 96, t0: 0.46, dur: 0.5, vol: 0.14 });
      click(0.46, 0.1);
    }
  };

  /* Haptic patterns, keyed to the same names as S, per design-brief.md. */
  var HAPTIC = {
    launch: 8,
    launchLast: 8,
    blocked: 18,
    win: [0, 18, 60, 18, 60, 42],
    fail: 220
  };

  function play(name) {
    var fn = S[name];
    if (fn && enabled) { try { fn(); } catch (e) {} }
    buzz(name);          // haptics ride alongside, independent of mute
  }

  function buzz(name) {
    if (!hapticsOn) return;
    var p = HAPTIC[name];
    if (p && navigator.vibrate) { try { navigator.vibrate(p); } catch (e) {} }
  }

  function setEnabled(v) {
    enabled = !!v;
    try { localStorage.setItem(MUTE_KEY, enabled ? "0" : "1"); } catch (e) {}
    if (enabled) ac();
  }
  function isEnabled() { return enabled; }

  function setHaptics(v) {
    hapticsOn = !!v;
    try { localStorage.setItem(HAPTIC_KEY, hapticsOn ? "1" : "0"); } catch (e) {}
  }
  function hasHaptics() { return hapticsOn; }

  /* Called from the FIRST touch handler, never from init(): a context created
     outside a user gesture stays suspended and the game is silent until a
     reload that happens to race differently. */
  function unlock() { if (enabled) ac(); }

  return {
    play: play, buzz: buzz, unlock: unlock,
    setEnabled: setEnabled, isEnabled: isEnabled,
    setHaptics: setHaptics, hasHaptics: hasHaptics,
    osc: osc, nz: nz, click: click
  };
})();

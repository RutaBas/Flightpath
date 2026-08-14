"use strict";

/* Persistence that survives an update. Copied from
   games/_recipes/save-migration/storage.js.txt.

   VERSIONED SAVE SLOTS FROM DAY ONE. The in-progress board is written by the
   game itself as a serialized FP1 string plus counters; with no version field,
   a later shape change (a second board layer, per-cell state, a different undo
   op) would hand render() something it cannot draw, on every launch, forever —
   and the player cannot clear it. A slot with no migration path is DISCARDED
   rather than passed through: losing one board is bad, a game that will not
   open is worse.

   SLOTS
     save      the in-progress board (level, FP1 strings, lives, counters, undo ops)
     progress  stars per level + the clean-run streak
     seen      one-off notices already acknowledged (the how-to)

   Sound deliberately keeps its own two keys (fp:muted, fp:haptics) inside this
   same prefix, per the audio-engine recipe — one source of truth for the mute
   state, and clearAll() still finds them because everything is namespaced. */

var Store = (function () {

  var P = "fp:";               // unique to Flightpath, trailing colon kept

  var K = {
    save: "save",
    progress: "progress",       // LEGACY — the meta-layer owns progression now
    seen: "seen",
    dailyboards: "dailyboards"
  };

  /* Bump the entry whose SHAPE changed and add a migration below. Never bump
     on a value change. */
  var VERSION = {
    save: 2,                    // gained mode/tierKey/dateKey when the meta-layer landed
    progress: 1,
    seen: 1,
    dailyboards: 1
  };

  var SCHEMA = "__schema";

  /* ------------------------------------------------------------- backing --
     Safari in private mode exposes localStorage and throws on setItem, so a
     write probe is the only reliable detection. The game stays playable when
     persistence is unavailable — it just forgets. */
  var backing = (function () {
    try {
      if (typeof localStorage === "undefined" || !localStorage) return memoryStore();
      var probe = "__probe__";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return localStorage;
    } catch (e) { return memoryStore(); }
  })();

  function memoryStore() {
    var map = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
      setItem: function (k, v) { map[k] = String(v); },
      removeItem: function (k) { delete map[k]; },
      key: function (i) { return Object.keys(map)[i]; },
      get length() { return Object.keys(map).length; }
    };
  }

  /* ----------------------------------------------------------------- raw -- */
  function get(key, fallback) {
    try {
      var raw = backing.getItem(P + key);
      if (raw === null || raw === undefined) return fallback;
      var v = JSON.parse(raw);
      return v === null || v === undefined ? fallback : v;
    } catch (e) {
      return fallback;          // corrupt JSON reads as "no save", never a throw
    }
  }

  function set(key, value) {
    try { backing.setItem(P + key, JSON.stringify(value)); return true; }
    catch (e) { return false; } // quota or private mode — the caller keeps playing
  }

  function remove(key) {
    try { backing.removeItem(P + key); } catch (e) {}
  }

  /* -------------------------------------------------------------- schema -- */
  function schema() { return get(SCHEMA, {}) || {}; }

  function versionOf(slot) {
    var s = schema();
    if (s[slot]) return s[slot];
    /* Nothing stored at all -> new player, already current. Data stored with no
       version -> baseline shape, which is v1 by definition. */
    return backing.getItem(P + slot) === null ? VERSION[slot] : 1;
  }

  function stampVersion(slot, v) {
    var s = schema();
    s[slot] = v;
    set(SCHEMA, s);
  }

  /* --------------------------------------------------------- migrations --
     One entry per shape change, keyed by the version it PRODUCES. They run in
     order, so a v1 save with migrations 2 and 3 ends up at v3.

     Rules: never delete an old migration; each must be total (any plausible
     old value, including one half-written by a save interrupted by a tab
     close, returns something valid or throws — a throw discards the slot,
     which is the safe outcome).

     Shipping shapes, for whoever writes the next migration:
       save (v2)   { mode:"level"|"daily"|"free", tierKey, level, dateKey, seed,
                     par, board:"FP1;...", start:"FP1;...", lives, mistakes,
                     hints, elapsed, ops:[{t:"set",i,prev}] }
       save (v1)   { level:1..200 global, board, start, lives, mistakes, hints,
                     elapsed, ops }  — migrated to v2 below
       progress    LEGACY. { stars:{ "<globalLevel>": 1|2|3 }, cleanRun, lastLevel }
                   The shared meta-layer owns progression now and carries this
                   across once in js/meta-config.js (prefix "fpm"). Left in place
                   deliberately: it is the migration's source, and deleting it
                   would make that migration unrepeatable.
       seen        { howto:true }
       dailyboards { "YYYY-MM-DD": "FP1;..." } — solved dailies frozen so a
                   replay is the board that was actually played that day */
  var MIGRATIONS = {
    save: {
      /* v1 -> v2. The pre-meta build identified a level by a GLOBAL 1..200
         number and had no mode, tier key, seed or par. The meta-layer ladders
         per tier, so an in-progress board saved by the old build has to be
         re-homed: level 47 becomes light #7. The board itself is untouched —
         it is still an FP1 string, and the whole point of this migration is
         that a player mid-level through an update keeps that exact board.

         Total by construction: anything unrecognisable throws or returns a
         shape fromSave() will reject, and a rejected save is discarded rather
         than half-restored. */
      2: function (old) {
        var TIER_KEYS = ["clear", "light", "holding", "stacked", "gridlock"];
        var g = parseInt(old && old.level, 10);
        if (!(g >= 1 && g <= 200)) throw new Error("unmappable legacy level");
        var tierKey = TIER_KEYS[Math.floor((g - 1) / 40)];
        return {
          mode: "level",
          tierKey: tierKey,
          level: ((g - 1) % 40) + 1,
          dateKey: "",
          seed: 0,                    // unknown for a legacy save; only restart needs it
          par: 0,
          board: old.board,
          start: old.start,
          lives: old.lives,
          mistakes: old.mistakes || 0,
          hints: old.hints || 0,
          elapsed: old.elapsed || 0,
          ops: Array.isArray(old.ops) ? old.ops : []
        };
      }
    },
    progress: {},
    seen: {},
    dailyboards: {}
  };

  function migrateSlot(slot) {
    var from = versionOf(slot);
    var to = VERSION[slot];
    if (from === to) return true;

    /* Written by a NEWER build than this one (two tabs across a deploy, or a
       rollback). Do not downgrade; leave it for the newer build. */
    if (from > to) return false;

    var value = get(slot, undefined);
    if (value === undefined) { stampVersion(slot, to); return true; }

    for (var v = from + 1; v <= to; v++) {
      var fn = MIGRATIONS[slot] && MIGRATIONS[slot][v];
      if (!fn) {
        remove(slot);
        stampVersion(slot, to);
        return false;           // discard beats guess
      }
      try {
        value = fn(value, v - 1);
      } catch (e) {
        remove(slot);
        stampVersion(slot, to);
        return false;
      }
    }
    set(slot, value);
    stampVersion(slot, to);
    return true;
  }

  /* Call ONCE at startup, before anything reads a save. Returns the slots that
     were discarded — if "save" is in there, tell the player. */
  function init() {
    var discarded = [];
    for (var slot in VERSION) {
      if (!Object.prototype.hasOwnProperty.call(VERSION, slot)) continue;
      if (!migrateSlot(slot)) discarded.push(slot);
    }
    return discarded;
  }

  /* --------------------------------------------------------------- board -- */
  function loadSave() { return get(K.save, null); }
  function saveBoard(state) { return set(K.save, state); }
  function clearSave() { remove(K.save); }

  /* ------------------------------------------------------------ progress -- */
  function defaultProgress() {
    return { stars: {}, cleanRun: 0, lastLevel: 0 };
  }
  /* Merged over defaults so a key added in a later build appears for existing
     players without needing a migration at all. */
  function loadProgress() {
    var p = get(K.progress, null) || {};
    var d = defaultProgress();
    for (var k in d) {
      if (Object.prototype.hasOwnProperty.call(d, k) &&
          !Object.prototype.hasOwnProperty.call(p, k)) p[k] = d[k];
    }
    if (!p.stars || typeof p.stars !== "object") p.stars = {};
    return p;
  }
  function saveProgress(p) { return set(K.progress, p); }

  /* ---------------------------------------------------------------- seen -- */
  function seen(name) {
    var s = get(K.seen, {}) || {};
    return !!s[name];
  }
  function markSeen(name) {
    var s = get(K.seen, {}) || {};
    s[name] = true;
    return set(K.seen, s);
  }

  /* Wipe this game only — the prefix scan is why every key is namespaced.
     BOTH prefixes: the game's own "fp:" and the meta-layer's "fpm:" (which is a
     separate prefix precisely so their two __schema maps cannot collide — see
     js/meta-config.js). Scanning only "fp:" would leave every star and streak
     behind after a reset, which reads as the reset not working. */
  function clearAll() {
    var doomed = [];
    try {
      for (var i = 0; i < backing.length; i++) {
        var k = backing.key(i);
        if (k && (k.indexOf(P) === 0 || k.indexOf("fpm:") === 0)) doomed.push(k);
      }
    } catch (e) { return; }
    for (var j = 0; j < doomed.length; j++) {
      try { backing.removeItem(doomed[j]); } catch (e) {}
    }
  }

  return {
    init: init,
    get: get, set: set, remove: remove,
    loadSave: loadSave, saveBoard: saveBoard, clearSave: clearSave,
    loadProgress: loadProgress, saveProgress: saveProgress,
    seen: seen, markSeen: markSeen,
    clearAll: clearAll,
    K: K, VERSION: VERSION
  };
})();

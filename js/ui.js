"use strict";

/* FLIGHTPATH — screens, board rendering, input and animation.

   This file owns the DOM for the BOARD and the four game screens. It never
   decides a rule (js/game.js asks the verified solver) and it never decides
   progression (js/meta-config.js mounts the shared meta-layer). The level map,
   daily calendar and records panel live in js/meta-ui.js — a different job,
   kept in a different file.

   ONE WIN HANDLER. winSequence() is the only place in the game that calls
   Meta.recordWin(), and it passes the mistake count straight from the board
   state, where it was incremented by an actually-attempted blocked tap.

   Layout follows the board-layout recipe: tile size is DERIVED from the
   measured box, never hardcoded, and recomputed on resize, on orientationchange
   (deferred 100ms, because iOS reports stale dimensions during a rotation) and
   on document.fonts.ready. The 44px tap floor is why the hardest tier is 7 wide
   and grows downward. */

var UI = (function (root) {

  var Board = root.FlightpathBoard;
  var Solver = root.FlightpathSolver;

  /* Must match css/style.css: --gap and --bpad. The geometry maths and the
     stylesheet have to agree or the fx overlay drifts off the tiles. */
  var GAP = 5;
  var PAD = 8;
  var MAX_TILE = 64;
  var DELTA = Board.DELTA;               // (dx, dy), y down; 0=N 1=E 2=S 3=W

  var G = {
    screen: null,
    state: null,
    els: [],
    tile: 48,
    busy: false,           // an animation owns the board; input is refused
    detach: null,
    timer: null,
    warnedSaveFail: false,
    fxTimer: null
  };

  /* ------------------------------------------------------------- helpers -- */

  function $(id) { return document.getElementById(id); }
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }

  function fmtTime(ms) {
    var s = Math.floor((ms || 0) / 1000);
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2200);
  }

  function showScreen(name) {
    G.screen = name;
    ["home", "game", "win", "fail", "meta"].forEach(function (n) {
      $("s-" + n).hidden = (n !== name);
    });
    window.scrollTo(0, 0);
  }

  /* ONE help control, one handler, one overlay. Rendered into the home title
     row and into every meta-screen header; the in-game pause menu and the
     settings block on the records screen call the same openHowTo(). There is
     no second copy of the content anywhere. */
  function helpButton(id, cls) {
    return '<button class="helpbtn' + (cls ? " " + cls : "") + '" type="button" data-help="1"' +
      (id ? ' id="' + id + '"' : "") +
      ' aria-label="How to play">?</button>';
  }

  /* The settings control. Inline SVG rather than the ⚙ glyph, which renders as
     anything from a cog to a colour emoji depending on font fallback.

     Sliders, not a cog: a cog needs its teeth to read, and at 19px on a dark
     ground the teeth collapse into a ring of dots that looks like a sun — which
     is exactly what the first attempt did. Three sliders stay legible at any
     size and say "settings" just as plainly. */
  function gearButton(id) {
    return '<button class="helpbtn infoot" type="button" id="' + id + '" aria-label="Settings">' +
      '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" ' +
        'stroke="currentColor" stroke-width="1.9" stroke-linecap="round">' +
        '<path d="M3 7h12M19 7h2M3 12h4M11 12h10M3 17h9M16 17h5"/>' +
        '<circle cx="17" cy="7" r="2.1"/><circle cx="9" cy="12" r="2.1"/><circle cx="14" cy="17" r="2.1"/>' +
      "</svg></button>";
  }

  function bindHelp(host) {
    if (!host) return;
    var list = host.querySelectorAll('[data-help]');
    for (var i = 0; i < list.length; i++) {
      list[i].addEventListener("click", function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        Sound.unlock();
        openHowTo(false);
      });
    }
  }

  function tierName(key) {
    var d = Meta.tierByKey(key);
    return d ? d.name : key;
  }

  /* ---------------------------------------------------------------- save -- */

  function saveGame() {
    if (!G.state || G.state.over) return;
    var ok = Store.saveBoard(FPGame.toSave(G.state, G.timer.elapsed()));
    /* A failed write is silent — quota, or Safari private mode. Checked once
       per session, or you never learn that saves stopped working. */
    if (!ok && !G.warnedSaveFail) {
      G.warnedSaveFail = true;
      toast("THIS BROWSER WON'T LET THE GAME SAVE");
    }
  }

  /* A solved daily must always replay as the board that was actually played
     that day. The daily-puzzle recipe's warning: if the board is derived live
     and the generator ever changes, the calendar shows a board nobody solved.
     So the first time a date is opened its board is frozen here, bounded to the
     last 90 days so the slot cannot grow without limit. */
  function frozenDaily(dateKey) {
    var m = Store.get("dailyboards", {}) || {};
    var v = m[dateKey];
    if (!v) return null;
    /* v1 entries were a bare board string; storage.js migrates them, but be
       tolerant in case one is written by an older tab mid-deploy. */
    return typeof v === "string" ? { b: v, t: null } : v;
  }
  function freezeDaily(dateKey, boardStr, tierKey) {
    var m = Store.get("dailyboards", {}) || {};
    if (m[dateKey]) return;                 // never move a board already pinned
    m[dateKey] = { b: boardStr, t: tierKey || null };
    var keys = Object.keys(m).sort();
    while (keys.length > 90) { delete m[keys.shift()]; }
    Store.set("dailyboards", m);
  }

  /* Which tier a given date is played at. A date that has already been opened
     or solved keeps the tier it had; only a date nobody has touched picks up
     the current rotation. That is what makes the rotation safe to change. */
  function dailyTier(plan) {
    var frozen = frozenDaily(plan.dateKey);
    if (frozen && frozen.t) return frozen.t;
    var entry = Meta.daily.entry(plan.dateKey);
    if (entry && entry.tier) return entry.tier;
    return plan.tier;
  }

  /* ============================================================== HOME ==== */

  /* Where "Play" goes: the first unplayed level in the first unlocked tier. */
  function nextTarget() {
    for (var i = 0; i < Meta.tierDefs.length; i++) {
      var def = Meta.tierDefs[i];
      if (!Meta.progress.isTierUnlocked(def.key)) continue;
      var n = Meta.progress.nextLevel(def.key);
      var lv = Meta.progress.level(def.key, n);
      if (!lv.plays) return { tierKey: def.key, level: n };
    }
    return { tierKey: Meta.tierDefs[0].key, level: 1 };
  }

  function renderHome() {
    var home = Meta.home();
    var save = Store.loadSave();
    var resumable = save && FPGame.fromSave(save);
    var target = nextTarget();

    var ctaLabel, ctaSub;
    if (resumable) {
      ctaLabel = "Continue";
      ctaSub = resumable.mode === "daily"
        ? "DAILY · " + resumable.dateKey
        : tierName(resumable.tierKey).toUpperCase() + " · LEVEL " + resumable.level;
    } else {
      ctaLabel = home.clearedCount ? "Play" : "Start";
      ctaSub = tierName(target.tierKey).toUpperCase() + " · LEVEL " + target.level;
    }

    var rows = home.tiers.map(function (t, i) {
      var def = Meta.tierByKey(t.key);
      /* O(1) per tier. This used to build the tier's whole level map and count
         it — one object per level, on every home render. At 500 levels a tier
         that is 3,500 allocations to produce seven pairs of numbers, on a paint
         that happens on every back-out and every resize. The counters are kept
         incrementally by the library (progress.tierTotals). */
      var agg = Meta.progress.tierTotals(t.key);
      var done = agg.cleared, stars = agg.stars;
      var maxStars = t.levels * 3;
      var cur = t.unlocked && !resumable && t.key === target.tierKey;
      var gate = t.gate && t.gate.length ? t.gate[0] : null;

      /* Each row carries its own progress — a bar plus a star tally — so the
         row height is paying for information rather than padding. A LOCKED tier
         shows how far along its unlock requirement is, which makes the gate read
         as something you are progressing toward rather than a closed door. */
      var pct = t.unlocked
        ? (t.levels ? (done / t.levels) * 100 : 0)
        : (gate && gate.need ? Math.min(100, (gate.have / gate.need) * 100) : 0);
      var tally = t.unlocked
        ? "★ <b>" + stars + "</b>/" + maxStars
        : (gate ? gate.have + "/" + gate.need + " cleared to open" : "locked");

      return '<button class="tier' + (cur ? " cur" : "") + (t.unlocked ? "" : " locked") +
        '" type="button" data-tier="' + t.key + '">' +
        '<span class="num mono">' + (i + 1 < 10 ? "0" : "") + (i + 1) + "</span>" +
        '<span class="nm">' + t.name + '<span class="sub"> · ' + def.grid + "</span></span>" +
        '<span class="pr">' + (t.unlocked ? done + "/" + t.levels : Art.lock()) + "</span>" +
        '<span class="meter">' +
          '<span class="bar"><i style="width:' + pct.toFixed(1) + '%"></i></span>' +
          '<span class="tally mono">' + tally + "</span>" +
        "</span>" +
        "</button>";
    }).join("");

    var d = home.daily;
    /* No leading separator: the streak note sits on its own line under "Daily",
       where a dangling "·" reads as a typo rather than a divider. */
    var streakTxt = d.solvedToday
      ? "solved today"
      : (d.streak > 0 && !d.dead
          ? d.streak + " day streak"
          : "play today");
    var streakCls = d.dead || (!d.streak && !d.solvedToday) ? "streak cold" : "streak";

    $("s-home").innerHTML =
      Art.flowBG() +
      /* The layer distributes its slack into the ladder — see .tiers in
         css/style.css. `scroll` is insurance for a short viewport. */
      '<div class="layer scroll">' +
        /* Spacers are classed, not inline-styled, so a short viewport can trim
           them in CSS — see the max-height:700px block in css/style.css. With
           seven tiers the ladder needs every pixel on an SE. */
        '<div class="hgap hgap-a"></div>' +
        /* The help control rides ON the title plate, anchored to its right edge.
           It cannot sit BESIDE the plate: "FLIGHTPATH" needs ~291px and even a
           390px screen only leaves 75px of gutter, so a 44px button each side
           (88px) would squeeze the signed-off lockup at every phone width. On
           the plate it costs no vertical space at all and is always visible. */
        '<div class="plate">' +
          '<p class="word">FLIGHTPATH</p>' +
          '<div class="rule"></div>' +
          '<p class="kicker">AERO TEST SECTION<span class="lamp"></span>No. ' +
            (home.clearedCount + 1) + "</p>" +
        "</div>" +
        '<div class="hgap hgap-b"></div>' +
        '<button class="cta" id="btn-play" type="button">' + ctaLabel +
          "<small>" + ctaSub + "</small></button>" +
        '<div class="hgap hgap-c"></div>' +
        '<div class="tiers">' + rows + "</div>" +
        /* Help sits in the footer beside Daily and Stats. It is icon-only and
           fixed at 44px so the two labelled buttons keep the width they need —
           "Daily · play today" does not fit in a third of the row. */
        '<div class="homefoot">' +
          '<button class="ghost" id="btn-daily" type="button">Daily ' +
            '<span class="' + streakCls + '">' + streakTxt + "</span></button>" +
          '<button class="ghost" id="btn-stats" type="button">Stats</button>' +
          helpButton("home-help", "infoot") +
          gearButton("home-settings") +
        "</div>" +
      "</div>";

    $("btn-play").addEventListener("click", function () {
      Sound.unlock();
      if (resumable) { resume(); return; }
      startLevel(target.tierKey, target.level);
    });
    bindHelp($("s-home"));
    $("home-settings").addEventListener("click", openSettings);
    $("btn-daily").addEventListener("click", function () { Sound.unlock(); MetaUI.openCalendar(); });
    $("btn-stats").addEventListener("click", function () { Sound.unlock(); MetaUI.openRecords(); });

    Array.prototype.forEach.call($("s-home").querySelectorAll(".tier"), function (b) {
      b.addEventListener("click", function () {
        Sound.unlock();
        /* A locked tier still opens its map: the gate is shown there as
           progress with a bar, which is a target rather than a wall. */
        MetaUI.openLevelMap(b.getAttribute("data-tier"));
      });
    });

    showScreen("home");
  }

  /* ============================================================== BOARD === */

  function cellInner(b, i) {
    if (!b.mask[i]) return Art.sky();
    var v = b.cells[i];
    if (v === Board.WALL) return Art.wall();
    if (Board.isArrow(v)) return Art.tile(v);
    return Art.open();
  }

  function paintCell(i) {
    var b = G.state.board;
    var e = G.els[i];
    if (!e) return;
    var v = b.cells[i];
    e.className = "cell" + (!b.mask[i] ? " sky" : "") + (Board.isArrow(v) ? " arrow" : "");
    e.innerHTML = Art.cellSVG(cellInner(b, i));
    e.style.transform = "";
    e.style.opacity = "";
    e.style.zIndex = "";
    if (Board.isArrow(v)) {
      e.setAttribute("aria-label", "arrow pointing " +
        ({ N: "up", E: "right", S: "down", W: "left" })[Board.DIR_NAMES[v]]);
    } else {
      e.removeAttribute("aria-label");
    }
  }

  function buildBoard() {
    var b = G.state.board;
    var host = $("board");
    host.innerHTML = "";
    G.els = new Array(b.cells.length);
    for (var i = 0; i < b.cells.length; i++) {
      var c = el("div", "cell");
      c.setAttribute("data-i", String(i));
      c.setAttribute("role", "gridcell");
      G.els[i] = c;
      host.appendChild(c);
      paintCell(i);
    }
    layoutBoard();
  }

  /* Derived from the MEASURED box, capped on both axes, so the board can never
     exceed its container. */
  function fitTile(b, availW, availH) {
    var tw = Math.floor((availW - 2 * PAD - (b.w - 1) * GAP) / b.w);
    var th = Math.floor((availH - 2 * PAD - (b.h - 1) * GAP) / b.h);
    return Math.max(22, Math.min(tw, th, MAX_TILE));
  }

  function boardPixelSize(b, tile) {
    return {
      w: b.w * tile + (b.w - 1) * GAP + 2 * PAD,
      h: b.h * tile + (b.h - 1) * GAP + 2 * PAD
    };
  }

  function layoutBoard() {
    if (!G.state) return;
    var b = G.state.board;
    var wrap = $("s-game").querySelector(".boardwrap");
    var availW = wrap.clientWidth;
    var availH = wrap.clientHeight;
    if (availW <= 0 || availH <= 0) return;      // hidden screen: nothing to measure

    var tile = fitTile(b, availW, availH);
    G.tile = tile;

    var host = $("board");
    host.style.setProperty("--tile", tile + "px");
    host.style.gridTemplateColumns = "repeat(" + b.w + ", " + tile + "px)";

    var size = boardPixelSize(b, tile);
    var fx = $("board-fx");
    fx.setAttribute("viewBox", "0 0 " + size.w + " " + size.h);
    fx.setAttribute("width", size.w);
    fx.setAttribute("height", size.h);
  }

  function centreOf(b, i, tile) {
    var x = i % b.w, y = (i / b.w) | 0;
    return {
      x: PAD + x * (tile + GAP) + tile / 2,
      y: PAD + y * (tile + GAP) + tile / 2
    };
  }

  /* ------------------------------------------------------------ overlay --- */

  function clearFx() {
    if (G.fxTimer) { clearTimeout(G.fxTimer); G.fxTimer = null; }
    $("board-fx").innerHTML = "";
  }

  function fx(html, ms) {
    var f = $("board-fx");
    f.innerHTML = html;
    if (G.fxTimer) clearTimeout(G.fxTimer);
    G.fxTimer = setTimeout(function () { f.innerHTML = ""; G.fxTimer = null; }, ms || 900);
  }

  /* =============================================================== HUD ==== */

  function renderHearts(burnIndex) {
    var h = "";
    for (var k = 0; k < FPGame.LIVES; k++) {
      var spent = k >= G.state.lives;
      var svg = Art.heart(spent);
      if (burnIndex === k) svg = svg.replace('class="heart gone"', 'class="heart gone burning"');
      h += svg;
    }
    $("hearts").innerHTML = h;
  }

  function updateHUD(burnIndex) {
    var st = G.state;
    $("hud-tier").textContent = st.mode === "daily"
      ? "DAILY · " + tierName(st.tierKey).toUpperCase()
      : tierName(st.tierKey).toUpperCase();
    $("hud-level").textContent = st.mode === "daily" ? st.dateKey : "LEVEL " + st.level;
    renderHearts(burnIndex);
  }

  function updateStatus(msg, warn) {
    var s = $("status");
    if (msg) {
      s.textContent = msg;
      s.classList.toggle("warn", !!warn);
      return;
    }
    s.classList.remove("warn");
    var left = FPGame.remaining(G.state);
    var free = FPGame.freeCount(G.state);
    s.textContent = left + " IN THE SECTION · " + free + " CAN GO NOW";
  }

  function updateTools() {
    $("hint-k").textContent = FPGame.hintsLeft(G.state) + " LEFT";
    $("btn-hint").disabled = FPGame.hintsLeft(G.state) === 0;
    $("btn-undo").disabled = !FPGame.canUndo(G.state);
  }

  /* ============================================================ PLAYING === */

  function startLevel(tierKey, level, opts) {
    var state = FPGame.createLevel(tierKey, level, opts || {});
    if (!state) { toast("COULDN'T BUILD THAT LEVEL"); return; }
    Store.clearSave();
    beginPlay(state);
  }

  /* Building a daily is not free at the top of the rotation: measured over a
     year of real dates, Sunday's Airspace Closed board averages 28.5ms and
     worst-cased 99ms on a desktop, so a few hundred ms on a phone. Doing that
     synchronously on the tap leaves the calendar sitting there looking broken.

     So the screen switches FIRST, with the tier named and the board area
     saying what it is doing, and the build happens on the next frame. The cost
     is unchanged; what changes is that the tap is acknowledged immediately. */
  function startDaily(dateKey, opts) {
    var plan = Meta.daily.plan(dateKey);
    var o = opts || {};
    var frozen = frozenDaily(plan.dateKey);
    var tierKey = dailyTier(plan);
    o.boardStr = frozen ? frozen.b : null;

    showPending("DAILY · " + tierName(tierKey).toUpperCase(), plan.dateKey);

    var build = function () {
      var state = FPGame.createDaily(plan.dateKey, tierKey, o);
      if (!state) { toast("COULDN'T BUILD THAT DAY'S BOARD"); renderHome(); return; }
      freezeDaily(plan.dateKey, state.startStr, tierKey);
      Store.clearSave();
      beginPlay(state);
      if (Meta.daily.isSolved(plan.dateKey)) {
        toast("ALREADY SOLVED · REPLAY WON'T CHANGE THE STREAK");
      }
    };
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(function () { setTimeout(build, 0); });
    } else {
      setTimeout(build, 0);
    }
  }

  /* The board screen, dressed but empty, while a board is generated. */
  function showPending(tierLabel, sub) {
    G.state = null;
    showScreen("game");
    $("game-bg").innerHTML = Art.plainBG();
    $("board").innerHTML = "";
    $("board-fx").innerHTML = "";
    $("hud-tier").textContent = tierLabel;
    $("hud-level").textContent = sub;
    $("hearts").innerHTML = "";
    $("status").textContent = "BUILDING THE SECTION…";
    $("btn-hint").disabled = true;
    $("btn-undo").disabled = true;
  }

  function resume() {
    var save = Store.loadSave();
    var state = save && FPGame.fromSave(save);
    if (!state) { toast("THAT BOARD COULDN'T BE RESTORED"); Store.clearSave(); renderHome(); return; }
    beginPlay(state, save.elapsed || 0);
  }

  function beginPlay(state, elapsed) {
    G.state = state;
    showScreen("game");
    $("game-bg").innerHTML = Art.plainBG();
    buildBoard();
    updateHUD();
    updateStatus();
    updateTools();
    clearFx();
    G.busy = false;
    G.timer.restore(elapsed || state.elapsed || 0);
    G.timer.start();
    saveGame();
    if (!Store.seen("howto")) { openHowTo(true); }
    else if (state.armHint) { state.armHint = false; Celebrate.after(320, doHint); }
  }

  function isPlaying() {
    return G.screen === "game" && G.state && !G.state.over && $("overlay").hidden;
  }

  /* ------------------------------------------------------------- the tap -- */

  function onTap(i) {
    if (G.busy || !G.state || G.state.over) return;
    Sound.unlock();
    var ev = FPGame.tap(G.state, i);
    if (ev.type === "none") return;
    /* Save the moment the board changes, not when the animation ends: iOS can
       kill a backgrounded app inside those 150-300ms, and a life spent on a
       blocked tap the save never saw would come back for free. */
    saveGame();
    if (ev.type === "launch") return doLaunch(ev);
    return doBlocked(ev);
  }

  function doLaunch(ev) {
    var b = G.state.board;
    var e = G.els[ev.idx];
    var tile = G.tile;
    var len = Solver.rayLength(b, ev.idx, ev.dir);
    var dist = (len + 1.2) * (tile + GAP);
    var dx = DELTA[ev.dir][0] * dist;
    var dy = DELTA[ev.dir][1] * dist;
    var horiz = DELTA[ev.dir][0] !== 0;
    var smear = horiz ? "scaleX(1.35) scaleY(.86)" : "scaleY(1.35) scaleX(.86)";

    /* The last arrow gets the launch tone pitched up, then a brief hold before
       the win fires — design-brief.md stage 6. */
    Sound.play(ev.won ? "launchLast" : "launch");
    clearFx();
    G.busy = true;
    e.style.zIndex = "4";

    var anim = null;
    var finish = function () {
      /* The launch fills forwards so the tile does not flash back into place
         one frame before it is repainted; cancel it here or the recycled cell
         keeps the finished transform. Celebrate.animate guarantees this handler
         runs exactly once, so the cancel cannot re-enter it. */
      if (anim) { try { anim.cancel(); } catch (x) {} }
      paintCell(ev.idx);
      G.busy = false;
      updateStatus();
      updateTools();
      if (ev.won) { winSequence(); return; }
    };

    /* Celebrate.animate calls `finish` itself under reduced motion (gone
       immediately, no movement) — never call it here as well. */
    anim = Celebrate.animate(e, [
      { transform: "translate(0,0)", opacity: 1, offset: 0 },
      { transform: "translate(" + (dx * 0.16) + "px," + (dy * 0.16) + "px) " + smear, opacity: 1, offset: 0.2 },
      { transform: "translate(" + dx + "px," + dy + "px)", opacity: 0, offset: 1 }
    ], { duration: 150, easing: "cubic-bezier(.2,.8,.3,1)", fill: "forwards" }, finish);
  }

  function doBlocked(ev) {
    var b = G.state.board;
    var tile = G.tile;

    Sound.play("blocked");
    G.busy = true;

    /* THE MOST IMPORTANT FEEDBACK IN THE GAME. A blocked tap costs a life, so
       it has to show its reasoning: the tile that blocked you lights up in the
       mistake colour, and the shut lane is drawn from the arrow to it. */
    var blocked = G.els[ev.blocker];
    if (blocked) {
      blocked.classList.remove("blocker");
      void blocked.offsetWidth;                 // restart the animation
      blocked.classList.add("blocker");
      setTimeout(function () { blocked.classList.remove("blocker"); }, 340);
    }
    var a = centreOf(b, ev.idx, tile);
    var z = centreOf(b, ev.blocker, tile);
    fx(Art.lane(a, z, true) + Art.blockMark(z, tile * 0.52, true), 900);

    /* 4px lateral shake on the arrow that could not leave. */
    Celebrate.animate(G.els[ev.idx], [
      { transform: "translateX(0)" }, { transform: "translateX(-4px)" },
      { transform: "translateX(4px)" }, { transform: "translateX(-3px)" },
      { transform: "translateX(0)" }
    ], { duration: 220, easing: "linear" });

    updateHUD(G.state.lives);        // the heart that just burned out
    var kind = b.cells[ev.blocker] === Board.WALL ? "A WALL" : "AN ARROW";
    updateStatus(kind + " IS IN THAT LANE · " + G.state.lives + " LIVES LEFT", true);
    updateTools();

    /* Input stays locked for the length of the shake — short enough not to feel
       laggy at tapping speed, long enough that a reflex second tap cannot spend
       another life on the same misread lane. */
    Celebrate.after(280, function () {
      G.busy = false;
      if (ev.lost) { failSequence(); return; }
      updateStatus();
    });
  }

  /* ---------------------------------------------------------------- hint -- */

  function doHint() {
    if (!G.state || G.state.over || G.busy) return;
    Sound.unlock();
    var h = FPGame.hint(G.state);
    if (!h.found) {
      toast(h.exhausted ? "NO HINTS LEFT ON THIS LEVEL" : "NO MOVE CAN BE PROVEN SAFE");
      return;
    }
    /* The solver has re-scanned this arrow's whole ray, so a hint can never
       cost a life. Draw the proof: the lane, clear all the way off the board. */
    var b = G.state.board;
    var tile = G.tile;
    var a = centreOf(b, h.idx, tile);
    var len = Solver.rayLength(b, h.idx, h.dir);
    var z = {
      x: a.x + DELTA[h.dir][0] * (len + 0.75) * (tile + GAP),
      y: a.y + DELTA[h.dir][1] * (len + 0.75) * (tile + GAP)
    };
    fx(Art.clearLane(a, z), 1900);
    var e = G.els[h.idx];
    e.classList.add("hinted");
    setTimeout(function () { e.classList.remove("hinted"); }, 1900);
    Sound.buzz("launch");
    updateTools();
    updateStatus("THIS LANE IS CLEAR ALL THE WAY OUT");
    Celebrate.after(1900, function () { if (isPlaying()) updateStatus(); });
    saveGame();
  }

  /* ---------------------------------------------------------------- undo -- */

  function doUndo() {
    if (!G.state || G.state.over || G.busy) return;
    Sound.unlock();
    var u = FPGame.undo(G.state);
    if (!u) { toast("NOTHING TO PUT BACK"); return; }
    clearFx();
    paintCell(u.idx);
    Celebrate.animate(G.els[u.idx], [
      { transform: "scale(.6)", opacity: 0 },
      { transform: "scale(1)", opacity: 1 }
    ], { duration: 160, easing: "cubic-bezier(.2,.8,.3,1)" });
    updateStatus();
    updateTools();
    saveGame();
    /* Undo refunds no life and clears no mistake — it cannot buy a star back.
       It is only ever a convenience, because removal is monotone and the player
       could not have been bricked anyway. */
  }

  /* ============================================================== WIN ===== */

  /* THE SINGLE WIN HANDLER. Everything the meta-layer knows about this result
     enters through the one Meta.recordWin() call below. */
  function winSequence() {
    /* Bank the time BEFORE anything async — a time read after the celebration
       includes the celebration. */
    G.timer.stop();
    var ms = G.timer.elapsed();
    var st = G.state;

    Store.clearSave();

    var res = Meta.recordWin({
      mode: st.mode,                 // "level" | "daily" | "free"
      tier: st.tierKey,
      level: st.level,
      dateKey: st.dateKey,
      ms: ms,
      hints: st.hints,
      mistakes: st.mistakes,         // from the BOARD: attempted blocked taps
      par: st.par
    });

    Sound.play("win");
    var box = $("boardbox").getBoundingClientRect();
    Celebrate.confetti($("fx"), { x: box.left + box.width / 2, y: box.top + box.height * 0.45 });

    Celebrate.after(340, function () { renderWin(res, ms); });
  }

  function row(k, v, cls) {
    return '<div class="row"><span class="k">' + k + '</span><span class="v ' + (cls || "") + '">' + v + "</span></div>";
  }

  function renderWin(res, ms) {
    var st = G.state;
    var stars = res.stars || FPGame.stars(st);
    var isDaily = st.mode === "daily";
    var def = Meta.tierByKey(st.tierKey);

    var starHTML = "";
    for (var k = 0; k < 3; k++) starHTML += Art.star(k < stars, "pending");

    /* Campaign extras: tier progress and the next level. */
    var tail = "";
    var nextLabel = "Ladder", nextSub = "BACK TO THE LADDER", nextFn = renderHome;

    if (isDaily) {
      var dres = res.daily || {};
      tail =
        row("STREAK", (dres.streak || 0) + (dres.streak === 1 ? " day" : " days"),
            dres.alreadySolved ? "" : "good") +
        (dres.alreadySolved ? row("REPLAY", "streak unchanged", "") : "") +
        row("DAILY BOARD", st.dateKey, "");
      nextLabel = "Calendar";
      nextSub = "DAILY · " + st.dateKey;
      nextFn = function () { MetaUI.openCalendar(); };
    } else {
      var done = Meta.progress.tierTotals(st.tierKey).cleared;
      var pct = Math.round((done / def.levels) * 100);
      tail =
        row(def.name.toUpperCase() + " PROGRESS", done + " / " + def.levels, "") +
        '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
        ((res.progress && res.progress.unlockedTiers && res.progress.unlockedTiers.length)
          ? row("OPENED", tierName(res.progress.unlockedTiers[0]).toUpperCase(), "warn") : "");

      if (st.level < def.levels) {
        nextLabel = "Next level";
        nextSub = def.name.toUpperCase() + " · LEVEL " + (st.level + 1);
        nextFn = function () { startLevel(st.tierKey, st.level + 1); };
      } else {
        var idx = Meta.tierDefs.indexOf(def);
        var nd = Meta.tierDefs[idx + 1];
        if (nd && Meta.progress.isTierUnlocked(nd.key)) {
          nextLabel = "Next tier";
          nextSub = nd.name.toUpperCase() + " · LEVEL 1";
          nextFn = function () { startLevel(nd.key, 1); };
        }
      }
    }

    var recs = res.records || null;
    var bestLine = recs
      ? (recs.isNewBest
          ? row("BEST TIME", recs.deltaMs ? "new best · −" + fmtTime(recs.deltaMs) : "new best", "good")
          : row("BEST TIME", fmtTime(recs.bestMs), ""))
      : "";
    var rankLine = res.rankPercentile
      ? row("RANK", res.rankPercentile.label, "warn") : "";

    $("s-win").innerHTML =
      Art.plainBG() +
      '<div class="layer scroll" style="justify-content:center">' +
        '<div class="banner">' +
          '<p class="big">' + (isDaily ? "DAILY CLEAR" : "SECTION CLEAR") + "</p>" +
          '<p class="small">' + def.name.toUpperCase() +
            (isDaily ? " · " + st.dateKey : " · LEVEL " + st.level) + "</p>" +
        "</div>" +
        '<div class="stars" id="win-stars">' + starHTML + "</div>" +
        '<div class="stats">' +
          row("BLOCKED TAPS", st.mistakes, st.mistakes === 0 ? "good" : "warn") +
          row("HINTS USED", st.hints, st.hints === 0 ? "good" : "warn") +
          row("LIVES LEFT", st.lives + " of " + FPGame.LIVES, "") +
          '<div class="row"><span class="k">TIME</span>' +
            '<span class="v" style="color:var(--dim)">' + fmtTime(ms) +
            " · par " + FPPar.fmt(st.par) + " · not scored</span></div>" +
          '<div class="hr"></div>' +
          bestLine + rankLine + tail +
        "</div>" +
        '<button class="cta" id="win-next" type="button">' + nextLabel +
          "<small>" + nextSub + "</small></button>" +
        '<div class="btnrow">' +
          '<button class="ghost" id="win-share" type="button">Share</button>' +
          '<button class="ghost" id="win-home" type="button">Ladder</button>' +
        "</div>" +
      "</div>";

    showScreen("win");

    /* Stars land ONE AT A TIME. All three at once and the result reads as a
       popup rather than something earned. */
    var nodes = $("win-stars").querySelectorAll(".star");
    for (var s = 0; s < nodes.length; s++) {
      (function (node, k) {
        Celebrate.after(160 + k * 260, function () {
          node.classList.remove("pending");
          node.classList.add("land");
        });
      })(nodes[s], s);
    }

    $("win-next").addEventListener("click", function () { Sound.unlock(); nextFn(); });
    $("win-home").addEventListener("click", function () { Sound.unlock(); renderHome(); });
    $("win-share").addEventListener("click", function () { Sound.unlock(); share(stars, ms); });
  }

  /* Spoiler-free: the result, never the board. */
  function share(stars, ms) {
    var st = G.state;
    var pips = "";
    for (var k = 0; k < 3; k++) pips += k < stars ? "★" : "☆";
    var txt = "Flightpath · " + tierName(st.tierKey) +
      (st.mode === "daily" ? " daily " + st.dateKey : " " + st.level) + "\n" +
      pips + "  ·  " + st.mistakes + " blocked  ·  " + fmtTime(ms);
    if (navigator.share) { navigator.share({ text: txt }).catch(function () {}); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast("COPIED"); }, function () {});
      return;
    }
    toast("SHARING ISN'T AVAILABLE HERE");
  }

  /* ============================================================== FAIL ==== */

  function failSequence() {
    G.timer.stop();
    Store.clearSave();
    Sound.play("fail");
    Celebrate.after(260, renderFail);
  }

  function renderFail() {
    var st = G.state;
    var b = st.board;
    var lanes = FPGame.blockedLanes(st);
    var last = st.lastBlock;

    var cells = "";
    for (var i = 0; i < b.cells.length; i++) {
      cells += '<div class="cell' + (!b.mask[i] ? " sky" : "") + '">' + Art.cellSVG(cellInner(b, i)) + "</div>";
    }

    $("s-fail").innerHTML =
      Art.plainBG() +
      '<div class="layer scroll">' +
        '<div class="hud">' +
          '<button class="chev" id="fail-back" type="button" aria-label="Back to the ladder">' +
            Art.chevronLeft() + "</button>" +
          '<div class="hudmid"><div class="t mono">' + tierName(st.tierKey).toUpperCase() +
            '</div><div class="l">' + (st.mode === "daily" ? st.dateKey : "LEVEL " + st.level) + "</div></div>" +
          '<div class="hearts">' + Art.heart(1) + Art.heart(1) + Art.heart(1) + "</div>" +
        "</div>" +
        '<div class="banner" style="margin:var(--s2) 0 var(--s3)">' +
          '<p class="big" style="font-size:25px;color:var(--err)">OUT OF LIVES</p>' +
          '<p class="small">THE LANES THAT WERE SHUT</p>' +
        "</div>" +
        '<div class="boardwrap">' +
          '<div class="boardbox" id="fail-box">' +
            '<div class="board" id="fail-board" style="opacity:.62">' + cells + "</div>" +
            '<svg id="fail-fx" aria-hidden="true"></svg>' +
          "</div>" +
        "</div>" +
        '<p class="mono" style="text-align:center;font-size:10px;color:var(--dim);letter-spacing:.1em;' +
          'margin:var(--s3) auto 0;max-width:32ch;line-height:1.7">' +
          (last ? "YOUR LAST TAP RAN INTO THE MARKED TILE. CLEAR THAT ONE FIRST AND THE LANE OPENS."
                : "EVERY MARKED LANE WAS SHUT BY THE TILE AT ITS END.") + "</p>" +
        '<div style="margin-top:auto">' +
          '<button class="cta" id="fail-retry" type="button">Run it again' +
            "<small>SAME SECTION · " + FPGame.LIVES + " LIVES</small></button>" +
          '<div class="btnrow">' +
            '<button class="ghost" id="fail-home" type="button">Ladder</button>' +
            '<button class="ghost" id="fail-hint" type="button">Hint next time</button>' +
          "</div>" +
        "</div>" +
      "</div>";

    showScreen("fail");

    /* Size the revealed board the way the live one is sized, then draw every
       lane that was shut — faintly for all of them, at full strength for the
       tap that ended the run. The player leaves knowing why. */
    var wrap = $("s-fail").querySelector(".boardwrap");
    var tile = fitTile(b, wrap.clientWidth, wrap.clientHeight);
    var host = $("fail-board");
    host.style.setProperty("--tile", tile + "px");
    host.style.gridTemplateColumns = "repeat(" + b.w + ", " + tile + "px)";
    var size = boardPixelSize(b, tile);
    var svg = $("fail-fx");
    svg.setAttribute("viewBox", "0 0 " + size.w + " " + size.h);
    svg.setAttribute("width", size.w);
    svg.setAttribute("height", size.h);

    var marks = "";
    for (var k = 0; k < lanes.length; k++) {
      var strong = last && lanes[k].idx === last.idx;
      marks += Art.lane(centreOf(b, lanes[k].idx, tile), centreOf(b, lanes[k].blocker, tile), strong);
    }
    if (last) {
      marks += Art.lane(centreOf(b, last.idx, tile), centreOf(b, last.blocker, tile), true) +
               Art.blockMark(centreOf(b, last.blocker, tile), tile * 0.52, true);
    }
    svg.innerHTML = marks;

    $("fail-back").addEventListener("click", function () { Sound.unlock(); renderHome(); });
    $("fail-home").addEventListener("click", function () { Sound.unlock(); renderHome(); });
    $("fail-retry").addEventListener("click", function () {
      Sound.unlock();
      beginPlay(FPGame.restart(st));
    });
    $("fail-hint").addEventListener("click", function () {
      Sound.unlock();
      beginPlay(FPGame.restart(st, { armHint: true }));
    });
  }

  /* ============================================================ OVERLAYS == */

  function closeOverlay() {
    $("overlay").hidden = true;
    $("overlay").innerHTML = "";
    if (isPlaying()) G.timer.start();
  }

  function openOverlay(html) {
    G.timer.stop();                 // the clock never runs behind a modal
    var o = $("overlay");
    o.innerHTML = '<div class="sheet scrollable">' + html + "</div>";
    o.hidden = false;
    return o;
  }

  /* The one rule, on first launch. Never blocks a returning player: shown once,
     recorded in the `seen` slot, and reachable from the records screen and the
     pause menu. */
  function openHowTo(firstRun) {
    var lane = function (cells) {
      return '<div class="board" style="--tile:38px;grid-template-columns:repeat(4,38px)">' +
        cells.map(function (c) { return '<div class="cell">' + Art.cellSVG(c) + "</div>"; }).join("") +
        "</div>";
    };
    var clear = lane([Art.tile(1), Art.open(), Art.open(), Art.open()]);
    var shut = lane([Art.tile(1), Art.open(), Art.wall(), Art.open()]);

    openOverlay(
      "<h2>ONE RULE</h2>" +
      "<p>An arrow leaves only if its <b>whole lane is clear</b> — every cell ahead of it, all the way off the board.</p>" +
      '<div class="demo">' + clear + "</div>" +
      '<p class="dim">Clear lane · tap it and it goes.</p>' +
      '<div class="demo">' + shut + "</div>" +
      '<p class="dim">Something in the lane · the tap is refused, and the tile that blocked you lights up.</p>' +
      '<div class="hr" style="margin:var(--s3) 0"></div>' +
      '<p class="dim"><b>Walls never move.</b> Open sky is flown over.</p>' +
      '<p class="dim"><b>A blocked tap costs a life.</b> Three lives; spend the last one and the level fails — ' +
        "but you can run the same board again straight away.</p>" +
      '<p class="dim"><b>Stars come from mistakes and hints only.</b> ' +
        "Three for a clean clear, two for one slip or one hint, one for clearing it. " +
        "Time is recorded but never scored — think as long as you like.</p>" +
      '<button class="cta" id="howto-ok" type="button">' + (firstRun ? "Start flying" : "Got it") + "</button>"
    );
    $("howto-ok").addEventListener("click", function () {
      Sound.unlock();
      Store.markSeen("howto");
      closeOverlay();
      if (G.state && G.state.armHint) { G.state.armHint = false; Celebrate.after(240, doHint); }
    });
  }

  /* SETTINGS. One definition, opened from the home footer and from the records
     screen's settings row; the in-game pause menu carries the same two toggles
     inline so you never have to leave a board to mute it. Sound and haptics are
     independent on purpose — the phone can still tap back with the volume off,
     which is the only feedback you get on a blocked tap in a silent room. */
  function openSettings() {
    Sound.unlock();
    function label() {
      var s = $("set-sound"), h = $("set-haptics");
      if (s) s.textContent = "Sound · " + (Sound.isEnabled() ? "on" : "off");
      if (h) h.textContent = "Haptics · " + (Sound.hasHaptics() ? "on" : "off");
    }
    openOverlay(
      "<h2>SETTINGS</h2>" +
      '<div class="stack">' +
        '<button class="ghost" id="set-sound" type="button">Sound · ' +
          (Sound.isEnabled() ? "on" : "off") + "</button>" +
        '<button class="ghost" id="set-haptics" type="button">Haptics · ' +
          (Sound.hasHaptics() ? "on" : "off") + "</button>" +
        '<button class="ghost" id="set-howto" type="button">How to play</button>' +
      "</div>" +
      '<p class="dim" style="margin-top:var(--s3)">Both are remembered between sessions. ' +
        "Haptics work independently of sound, so the phone can still tap back with the volume down.</p>" +
      '<button class="cta" id="set-ok" type="button" style="margin-top:var(--s3)">Done</button>'
    );
    $("set-sound").addEventListener("click", function () {
      Sound.setEnabled(!Sound.isEnabled());
      label();
      if (Sound.isEnabled()) Sound.play("launch");   // hear what you just turned on
    });
    $("set-haptics").addEventListener("click", function () {
      Sound.setHaptics(!Sound.hasHaptics());
      label();
      if (Sound.hasHaptics()) Sound.buzz("launch");
    });
    $("set-howto").addEventListener("click", function () { closeOverlay(); openHowTo(false); });
    $("set-ok").addEventListener("click", closeOverlay);
  }

  function openMenu() {
    Sound.unlock();
    var st = G.state;
    openOverlay(
      "<h2>PAUSED</h2>" +
      '<p class="dim">' + tierName(st.tierKey).toUpperCase() + " · " +
        (st.mode === "daily" ? st.dateKey : "LEVEL " + st.level) + " · " +
        FPGame.remaining(st) + " ARROWS LEFT</p>" +
      '<div class="stack">' +
        '<button class="ghost" id="m-sound" type="button">Sound · ' + (Sound.isEnabled() ? "on" : "off") + "</button>" +
        '<button class="ghost" id="m-haptics" type="button">Haptics · ' + (Sound.hasHaptics() ? "on" : "off") + "</button>" +
        '<button class="ghost" id="m-howto" type="button">How to play</button>' +
        '<button class="ghost" id="m-restart" type="button">Restart this level</button>' +
        '<button class="ghost" id="m-home" type="button">Back to the ladder</button>' +
      "</div>" +
      '<button class="cta" id="m-resume" type="button" style="margin-top:var(--s3)">Resume</button>'
    );
    $("m-resume").addEventListener("click", closeOverlay);
    $("m-sound").addEventListener("click", function () {
      Sound.setEnabled(!Sound.isEnabled());
      $("m-sound").textContent = "Sound · " + (Sound.isEnabled() ? "on" : "off");
    });
    $("m-haptics").addEventListener("click", function () {
      Sound.setHaptics(!Sound.hasHaptics());
      $("m-haptics").textContent = "Haptics · " + (Sound.hasHaptics() ? "on" : "off");
    });
    $("m-howto").addEventListener("click", function () { closeOverlay(); openHowTo(false); });
    $("m-restart").addEventListener("click", function () {
      closeOverlay();
      beginPlay(FPGame.restart(G.state));
      toast("BOARD RESET · " + FPGame.LIVES + " LIVES");
    });
    $("m-home").addEventListener("click", function () {
      saveGame();
      closeOverlay();
      renderHome();
    });
  }

  /* ============================================================== INIT ==== */

  function relayout() {
    if (G.busy) return;              // never resize the board mid-animation
    if (G.screen === "game" && G.state) { layoutBoard(); clearFx(); }
  }

  function init() {
    TapGuard.install();

    var discarded = Store.init();

    G.timer = new Timer();
    Timer.attach(G.timer, isPlaying, function () { /* auto-paused in background */ });

    /* The meta screens get a narrow contract, so js/meta-ui.js never reaches
       into the board controller. */
    MetaUI.setContext({
      show: function (html) {
        $("s-meta").innerHTML = html;
        showScreen("meta");
        bindHelp($("s-meta"));          // every meta header carries the same "?"
        return $("s-meta");
      },
      helpButton: helpButton,
      /* So the calendar labels a date with the tier it will ACTUALLY be played
         at — the frozen one for a date already opened, today's rotation for a
         date nobody has touched. */
      dailyTier: function (plan) { return dailyTier(plan); },
      close: function () { renderHome(); },
      startLevel: startLevel,
      startDaily: startDaily,
      toast: toast,
      howto: function () { openHowTo(false); }
    });

    /* Board input: tap only. The recipe's swipe path is dropped; its distance
       threshold survives as a cancel slop, because a tap here can cost a life
       and a wandering drag must not fire one. */
    G.detach = Gestures.attach($("board"), {
      enabled: function () { return !G.busy && !!G.state && !G.state.over && $("overlay").hidden; },
      slop: function () { return Math.max(14, G.tile * 0.45); },
      cellFromEvent: function (e) {
        var host = $("board");
        var r = host.getBoundingClientRect();
        var b = G.state.board;
        var step = G.tile + GAP;
        var cx = Math.floor((e.clientX - r.left - PAD) / step);
        var cy = Math.floor((e.clientY - r.top - PAD) / step);
        if (cx < 0 || cy < 0 || cx >= b.w || cy >= b.h) return null;
        var i = cy * b.w + cx;
        if (!b.mask[i] || !Board.isArrow(b.cells[i])) return null;
        return i;
      },
      onPress: function (i, on) {
        var e = G.els[i];
        if (e) e.classList.toggle("press", on);
      },
      onTap: onTap
    });

    $("btn-hint").addEventListener("click", doHint);
    $("btn-undo").addEventListener("click", doUndo);
    $("btn-menu").addEventListener("click", openMenu);
    $("btn-back").addEventListener("click", function () {
      Sound.unlock();
      saveGame();
      renderHome();
    });
    $("btn-back").innerHTML = Art.chevronLeft();

    /* When to recompute — board-layout recipe. */
    window.addEventListener("resize", function () {
      if (G.screen === "game") relayout(); else if (G.screen === "home") renderHome();
    });
    /* iOS reports stale dimensions during a rotation, so resize alone lands on
       the pre-rotation size. */
    window.addEventListener("orientationchange", function () { setTimeout(relayout, 100); });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { relayout(); });
    }

    /* iOS kills backgrounded web apps without firing unload. */
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) saveGame();
    });
    window.addEventListener("pagehide", function () { saveGame(); });

    renderHome();

    if (discarded.indexOf("save") >= 0) toast("YOUR LAST BOARD COULDN'T BE RESTORED");
  }

  /* `probe` is a test seam: it drives the same handlers the buttons and the
     board do, so a headless smoke run can play a level end to end without
     synthesising pointer events. Nothing in the app calls it. */
  return {
    init: init, G: G,
    probe: {
      tap: onTap, hint: doHint, undo: doUndo,
      start: startLevel, daily: startDaily, home: renderHome,
      levelMap: function (k) { MetaUI.openLevelMap(k); },
      calendar: function () { MetaUI.openCalendar(); },
      records: function () { MetaUI.openRecords(); }
    }
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", UI.init);
} else {
  UI.init();
}

/* Service worker registration — pwa-shell recipe. On `load` so the install does
   not compete with the first paint; the silent catch is deliberate, since a
   failed registration (file:// URL, private browsing, no https) must never
   break the game — it only means no offline mode. */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  });
}

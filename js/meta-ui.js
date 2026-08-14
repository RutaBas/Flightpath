"use strict";

/* FLIGHTPATH — the meta-layer screens: level map, daily calendar, records.

   Kept out of js/ui.js on purpose. The board controller has one job (build a
   board, take taps, animate, save) and this has another (draw what the shared
   meta-layer already knows). Mixing them is how a 600-line UI becomes 1,600.

   EVERY NUMBER ON THESE SCREENS COMES FROM js/meta/* VIA js/meta-config.js.
   Nothing here counts stars, decides an unlock, computes a streak or averages a
   time — it reads Meta.progress / Meta.daily / Meta.records / Meta.rank and
   renders. If a screen wants a number the library does not expose, the fix is
   in the library, not a local tally.

   ctx is injected by UI.init so this file never reaches into the board
   controller: { show, close, startLevel, startDaily, toast, refreshHome }. */

var MetaUI = (function () {

  var ctx = null;
  function setContext(c) { ctx = c; }

  /* --------------------------------------------------------------- bits -- */

  function fmt(ms) {
    if (!ms) return "—";
    var s = Math.round(ms / 1000);
    var m = Math.floor(s / 60), r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }

  function header(title, sub) {
    return '<div class="hud metahud">' +
      '<button class="chev" data-act="back" type="button" aria-label="Back">' + Art.chevronLeft() + "</button>" +
      '<div class="hudmid"><div class="t mono">' + sub + '</div><div class="l">' + title + "</div></div>" +
      '<div style="width:44px"></div>' +
      "</div>";
  }

  /* Star pips, the win screen's vocabulary at map size. */
  function pips(n) {
    var out = "";
    for (var k = 0; k < 3; k++) out += Art.star(k < n, "pip");
    return '<span class="pips">' + out + "</span>";
  }

  /* ----------------------------------------------------------- level map --

     500 LEVELS A TIER, RENDERED 50 AT A TIME. Numbered tiles, star pips, lock
     state — and a locked TIER shown as progress, never as a wall: the gate card
     says how many more clears it wants and draws the bar, so a locked tier
     reads as a target.

     The chunking is not decoration. 500 <button>s per tier is ~2,500 DOM nodes
     built on a screen the player opens constantly, and every one of them is
     thrown away on the next open. Ten section headers plus one expanded section
     is ~300 nodes and the same information. The section holding the next
     playable level is the one open by default, so the common case — "where was
     I" — needs no taps at all.

     Scroll position is preserved across a section change, because re-rendering
     the panel and dropping the player back at the top of a 500-level ladder is
     its own small hostility. */
  var SECTION = 50;
  var openSection = {};    // tierKey -> section index currently expanded

  function sectionOf(level) { return Math.floor((level - 1) / SECTION); }

  function levelMap(tierKey) {
    var def = Meta.tierByKey(tierKey);
    var open = Meta.progress.isTierUnlocked(tierKey);
    var gate = Meta.progress.tierGate(tierKey);
    var recs = Meta.records.get(tierKey);

    /* Aggregates, not a 500-object map. */
    var agg = Meta.progress.tierTotals(tierKey);
    var got = agg.cleared, stars = agg.stars;

    var sections = Math.ceil(def.levels / SECTION);
    var current = openSection[tierKey];
    if (current === undefined) current = sectionOf(Meta.progress.nextLevel(tierKey));
    if (current < 0) current = 0;
    if (current > sections - 1) current = sections - 1;
    openSection[tierKey] = current;

    var gateHTML = "";
    if (!open && gate && gate.length) {
      var g = gate[0];
      var gpct = Math.min(100, Math.round((g.have / g.need) * 100));
      gateHTML =
        '<div class="gatecard">' +
          '<div class="row"><span class="k">' + def.name.toUpperCase() + " OPENS AT " + g.need +
            ' CLEARED</span><span class="v warn">' + g.have + " / " + g.need + "</span></div>" +
          '<div class="bar"><i style="width:' + gpct + '%"></i></div>' +
          '<p class="dim mono" style="margin:8px 0 0;font-size:9.5px;letter-spacing:.1em">' +
            (g.need - g.have) + " MORE LEVELS ANYWHERE ON THE LADDER</p>" +
        "</div>";
    }

    /* Only the expanded section is materialised — mapFor's range form, so the
       library allocates 50 rows rather than 500. */
    var first = current * SECTION + 1;
    var rows = Meta.progress.mapFor(tierKey, first, SECTION);

    var tiles = rows.map(function (r) {
      var cls = "lvl";
      if (!r.unlocked) cls += " locked";
      if (r.played) cls += " done";
      if (r.stars === 3) cls += " perfect";
      return '<button class="' + cls + '" type="button" data-level="' + r.level +
        '" ' + (r.unlocked ? "" : "disabled") + ">" +
        '<span class="n mono">' + r.level + "</span>" +
        (r.unlocked ? pips(r.stars) : '<span class="lk">' + Art.lock() + "</span>") +
        "</button>";
    }).join("");

    /* Section headers carry their own progress so a collapsed section is still
       informative — you can see where you stopped without opening it. */
    var bars = "";
    for (var sIdx = 0; sIdx < sections; sIdx++) {
      var lo = sIdx * SECTION + 1;
      var hi = Math.min(def.levels, lo + SECTION - 1);
      var done = 0;
      var srows = Meta.progress.mapFor(tierKey, lo, hi - lo + 1);
      for (var q = 0; q < srows.length; q++) if (srows[q].played) done++;
      var spct = Math.round((done / (hi - lo + 1)) * 100);
      bars +=
        '<button class="sect' + (sIdx === current ? " on" : "") + '" type="button" data-sect="' + sIdx + '">' +
          '<span class="rng mono">' + lo + "–" + hi + "</span>" +
          '<span class="bar"><i style="width:' + spct + '%"></i></span>' +
          '<span class="cnt mono">' + done + "</span>" +
        "</button>" +
        (sIdx === current ? '<div class="lvlgrid">' + tiles + "</div>" : "");
    }

    return {
      html:
        Art.plainBG() +
        '<div class="layer scroll" id="map-scroll">' +
          header(def.name.toUpperCase(), "LEVEL MAP · " + def.grid) +
          '<div class="stats" style="margin-bottom:var(--s3)">' +
            '<div class="row"><span class="k">CLEARED</span><span class="v">' + got + " / " + def.levels + "</span></div>" +
            '<div class="bar"><i style="width:' + Math.round((got / def.levels) * 100) + '%"></i></div>' +
            '<div class="row"><span class="k">STARS</span><span class="v warn">' + stars + " / " + (def.levels * 3) + "</span></div>" +
            '<div class="row"><span class="k">BEST TIME</span><span class="v">' + fmt(recs.bestMs) + "</span></div>" +
          "</div>" +
          gateHTML +
          '<div class="sections">' + bars + "</div>" +
          '<div style="height:12px"></div>' +
        "</div>",
      bind: function (host) {
        host.querySelectorAll("[data-level]").forEach(function (b) {
          b.addEventListener("click", function () {
            var n = parseInt(b.getAttribute("data-level"), 10);
            if (!Meta.progress.isUnlocked(tierKey, n)) return;
            ctx.startLevel(tierKey, n);
          });
        });
        host.querySelectorAll("[data-sect]").forEach(function (b) {
          b.addEventListener("click", function () {
            var next = parseInt(b.getAttribute("data-sect"), 10);
            var scroller = host.querySelector("#map-scroll");
            var keep = scroller ? scroller.scrollTop : 0;
            openSection[tierKey] = next;
            var again = openLevelMap(tierKey);
            var s2 = again.querySelector("#map-scroll");
            /* Keep the eye where it was. Collapsing a section above shortens
               the page, so clamp rather than restore blindly. */
            if (s2) s2.scrollTop = Math.min(keep, Math.max(0, s2.scrollHeight - s2.clientHeight));
          });
        });
      }
    };
  }

  /* ------------------------------------------------------------ calendar --
     Month grid. Solved days carry their stars, past days are replayable, the
     future is dimmed. Day boundary is UTC because the library says so — one
     "today" for everyone, which is the only version that survives a
     leaderboard. */
  var calMonth = null;   // ms timestamp of the month being viewed

  function calendar() {
    var view = calMonth == null ? Date.now() : calMonth;
    var cal = Meta.daily.calendar(view);
    var streak = Meta.daily.currentStreak();
    var stats = Meta.daily.stats();
    var plan = Meta.daily.plan();
    var MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY",
      "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
    var DOW = ["S", "M", "T", "W", "T", "F", "S"];

    var cells = "";
    for (var pad = 0; pad < cal.days[0].dow; pad++) cells += '<span class="day pad"></span>';
    cal.days.forEach(function (d) {
      var cls = "day";
      if (d.solved) cls += " solved";
      if (d.isToday) cls += " today";
      if (!d.playable) cls += " future";
      cells += '<button class="' + cls + '" type="button" data-day="' + d.dateKey + '" ' +
        (d.playable ? "" : "disabled") + '>' +
        '<span class="dom mono">' + d.dom + "</span>" +
        (d.solved ? '<span class="dot"></span>' : "") + "</button>";
    });

    var todayTier = Meta.tierByKey(plan.tier);
    var solvedToday = Meta.daily.isSolved(plan.dateKey);

    return {
      html:
        Art.plainBG() +
        '<div class="layer scroll">' +
          header("DAILY", "ONE BOARD A DAY · UTC") +
          '<div class="stats" style="margin-bottom:var(--s3)">' +
            '<div class="row"><span class="k">STREAK</span><span class="v ' +
              (streak.dead ? "" : "good") + '">' + streak.streak + " day" + (streak.streak === 1 ? "" : "s") +
              (streak.atRisk && !solvedToday ? " · at risk" : "") + "</span></div>" +
            '<div class="row"><span class="k">BEST STREAK</span><span class="v">' + stats.best + "</span></div>" +
            '<div class="row"><span class="k">FREEZES</span><span class="v">' + streak.freezes + " of 3</span></div>" +
            '<div class="row"><span class="k">SOLVED</span><span class="v">' + stats.solved + "</span></div>" +
          "</div>" +
          '<button class="cta" data-act="today" type="button">' +
            (solvedToday ? "Replay today" : "Play today's board") +
            "<small>" + (todayTier ? todayTier.name.toUpperCase() : "DAILY") + " · " + plan.dateKey + "</small></button>" +
          '<div class="calhead">' +
            '<button class="calnav" data-act="prev" type="button" aria-label="Previous month">‹</button>' +
            '<span class="mono">' + MONTHS[cal.month] + " " + cal.year + "</span>" +
            '<button class="calnav" data-act="next" type="button" aria-label="Next month">›</button>' +
          "</div>" +
          '<div class="dowrow mono">' + DOW.map(function (d) { return "<span>" + d + "</span>"; }).join("") + "</div>" +
          '<div class="calgrid">' + cells + "</div>" +
          '<p class="dim mono" style="text-align:center;font-size:9px;letter-spacing:.12em;margin:var(--s3) 0 0">' +
            "A SOLVED DAY KEEPS ITS BOARD · REPLAYS DO NOT CHANGE THE STREAK</p>" +
          '<div style="height:12px"></div>' +
        "</div>",
      bind: function (host) {
        var t = host.querySelector('[data-act="today"]');
        if (t) t.addEventListener("click", function () { ctx.startDaily(plan.dateKey); });
        var prev = host.querySelector('[data-act="prev"]');
        var next = host.querySelector('[data-act="next"]');
        if (prev) prev.addEventListener("click", function () {
          var d = new Date(calMonth == null ? Date.now() : calMonth);
          calMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15);
          openCalendar();
        });
        if (next) next.addEventListener("click", function () {
          var d = new Date(calMonth == null ? Date.now() : calMonth);
          calMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 15);
          openCalendar();
        });
        host.querySelectorAll("[data-day]").forEach(function (b) {
          b.addEventListener("click", function () {
            ctx.startDaily(b.getAttribute("data-day"));
          });
        });
      }
    };
  }

  /* ------------------------------------------------------------- records --
     Per-tier best, average and improvement trend, plus the rank badge. Every
     derived stat has a zero-wins branch: a fresh player must never be shown
     "Best 0:00 · Average NaN", which reads as broken rather than empty. */
  function records() {
    var totals = Meta.progress.totals();
    var dstats = Meta.daily.stats();

    var rows = Meta.tierDefs.map(function (def) {
      var r = Meta.records.get(def.key);
      var trend = Meta.records.trend(def.key);
      if (!r.wins) {
        return '<div class="stats reccard">' +
          '<div class="row"><span class="k">' + def.name.toUpperCase() + "</span>" +
            '<span class="v" style="color:var(--dim)">not flown yet</span></div>' +
          '<p class="dim mono" style="margin:6px 0 0;font-size:9px;letter-spacing:.1em">' +
            def.grid + " · CLEAR ONE TO START A RECORD</p></div>";
      }
      var trendHTML = trend.enough
        ? '<span class="v ' + (trend.improving ? "good" : "warn") + '">' +
            (trend.improving ? "▼ " : "▲ ") + fmt(Math.abs(trend.trendMs)) + "</span>"
        : '<span class="v" style="color:var(--dim)">needs more runs</span>';
      return '<div class="stats reccard">' +
        '<div class="row"><span class="k">' + def.name.toUpperCase() + '</span><span class="v">' +
          r.wins + " win" + (r.wins === 1 ? "" : "s") + "</span></div>" +
        '<div class="row"><span class="k">BEST</span><span class="v good">' + fmt(r.bestMs) + "</span></div>" +
        '<div class="row"><span class="k">AVERAGE</span><span class="v">' + fmt(r.avgMs) + "</span></div>" +
        '<div class="row"><span class="k">LAST ' + r.recent.length + '</span><span class="v">' + fmt(r.recentAvgMs) + "</span></div>" +
        '<div class="row"><span class="k">TREND</span>' + trendHTML + "</div>" +
      "</div>";
    }).join("");

    /* One saturated block on this screen, and it is the badge. */
    var bestTier = null, bestMs = 0;
    Meta.tierDefs.forEach(function (d) {
      var r = Meta.records.get(d.key);
      if (r.bestMs && (!bestMs || r.bestMs < bestMs)) { bestMs = r.bestMs; bestTier = d; }
    });
    var badge = bestTier ? Meta.rank.percentile(bestTier.key, bestMs) : null;

    return {
      html:
        Art.plainBG() +
        '<div class="layer scroll">' +
          header("RECORDS", "HOW YOU ARE FLYING") +
          (badge
            ? '<div class="badge"><span class="mono lbl">RANK · ' + bestTier.name.toUpperCase() + "</span>" +
              '<span class="big">' + badge.label + "</span>" +
              '<span class="mono lbl">' + fmt(bestMs) + " BEST · LOCAL CURVE</span></div>"
            : '<div class="badge quiet"><span class="mono lbl">RANK</span>' +
              '<span class="big">UNRANKED</span>' +
              '<span class="mono lbl">CLEAR A LEVEL TO BE PLACED</span></div>') +
          '<div class="stats" style="margin-bottom:var(--s3)">' +
            /* Derived from the config, never a literal — the ladder grows. */
            '<div class="row"><span class="k">LEVELS CLEARED</span><span class="v">' +
              totals.clearedCount + " / " + Meta.totalLevels() + "</span></div>" +
            '<div class="row"><span class="k">STARS</span><span class="v warn">' +
              totals.totalStars + " / " + Meta.totalStars() + "</span></div>" +
            '<div class="row"><span class="k">DAILIES SOLVED</span><span class="v">' + dstats.solved + "</span></div>" +
            '<div class="row"><span class="k">BEST STREAK</span><span class="v">' + dstats.best + "</span></div>" +
          "</div>" +
          rows +
          '<div class="stats reccard">' +
            '<div class="row"><span class="k">SETTINGS</span><span class="v" style="color:var(--dim)">tap to change</span></div>' +
            '<div class="stack" style="margin-top:10px">' +
              '<button class="ghost" data-act="sound" type="button">Sound · ' + (Sound.isEnabled() ? "on" : "off") + "</button>" +
              '<button class="ghost" data-act="haptics" type="button">Haptics · ' + (Sound.hasHaptics() ? "on" : "off") + "</button>" +
              '<button class="ghost" data-act="howto" type="button">How to play</button>' +
            "</div>" +
          "</div>" +
          '<div style="height:12px"></div>' +
        "</div>",
      bind: function (host) {
        var s = host.querySelector('[data-act="sound"]');
        if (s) s.addEventListener("click", function () {
          Sound.setEnabled(!Sound.isEnabled());
          s.textContent = "Sound · " + (Sound.isEnabled() ? "on" : "off");
        });
        var h = host.querySelector('[data-act="haptics"]');
        if (h) h.addEventListener("click", function () {
          Sound.setHaptics(!Sound.hasHaptics());
          h.textContent = "Haptics · " + (Sound.hasHaptics() ? "on" : "off");
        });
        var ht = host.querySelector('[data-act="howto"]');
        if (ht) ht.addEventListener("click", function () { ctx.howto(); });
      }
    };
  }

  /* ---------------------------------------------------------------- open -- */

  function open(panel) {
    var host = ctx.show(panel.html);
    var back = host.querySelector('[data-act="back"]');
    if (back) back.addEventListener("click", function () { ctx.close(); });
    panel.bind(host);
    return host;
  }

  function openLevelMap(tierKey) { return open(levelMap(tierKey)); }
  function openCalendar() { return open(calendar()); }
  function openRecords() { return open(records()); }

  return {
    setContext: setContext,
    openLevelMap: openLevelMap,
    openCalendar: openCalendar,
    openRecords: openRecords,
    fmt: fmt
  };
})();

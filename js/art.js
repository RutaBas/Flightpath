"use strict";

/* FLIGHTPATH — the drawn vocabulary, lifted directly from design-screens.html
   (the signed-off mockups) rather than redrawn. Every string here is markup;
   nothing in this file touches the document.

   THE THREE THINGS THE DESIGN HANGS ON, and where they live:

   1. ONE ARROW MOTIF IN FOUR ROTATIONS. tile() draws exactly one shape — a
      smoke streamline with an amber head — and rotates it by ROT[dir]. There
      is no second arrow shape anywhere in this file, and the arrowhead is
      --accent in all four rotations, so colour never carries direction.

   2. A WALL READS AS PERMANENT. wall() is a different material entirely:
      a lighter hatched block with a bolted inner frame, no streamline and no
      arrowhead. Nothing on it points anywhere.

   3. THE BLOCKED TAP SHOWS ITS REASONING. The tile face carries class
      "facefill" so the UI can light the blocking tile in the mistake colour
      (css/style.css, .cell.blocker .facefill), and lane() draws the shut lane
      with the blocker ringed and crossed — the same overlay the fail screen
      uses to reveal why the level was lost. */

var Art = (function () {

  var C = {
    ground: "#1a1e21", panel: "#242a2e", cell: "#2e353a", ink: "#e3e8e6",
    dim: "#8d9a97", dom: "#c3ccc8", accent: "#c2853c", err: "#a35c50", ok: "#6f9188"
  };

  /* 0=N, 1=E, 2=S, 3=W — the spec's numbering. The motif is drawn pointing
     EAST, so east is the zero rotation. */
  var ROT = [-90, 0, 90, 180];

  /* Presentation-only RNG for the background streamlines. Deliberately not the
     game's seeded rng: nothing drawn here may influence a board. */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* -------------------------------------------------------------- tiles -- */

  function tileFace() {
    return '<rect class="facefill" x="1.5" y="1.5" width="45" height="45" rx="8" fill="' + C.cell +
           '" stroke="' + C.dom + '" stroke-opacity=".16"/>';
  }

  /* The one motif: three streamlines and one amber head, pointing east. */
  function motif() {
    return tileFace() +
      '<path d="M7 24h20" stroke="' + C.dom + '" stroke-width="2.4" stroke-linecap="round" opacity=".55"/>' +
      '<path d="M12 17.5h12" stroke="' + C.dom + '" stroke-width="1.6" stroke-linecap="round" opacity=".3"/>' +
      '<path d="M12 30.5h12" stroke="' + C.dom + '" stroke-width="1.6" stroke-linecap="round" opacity=".3"/>' +
      '<path d="M29 15.5 38.5 24 29 32.5" fill="none" stroke="' + C.accent +
      '" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>';
  }

  function tile(dir) {
    return '<g transform="rotate(' + ROT[dir] + ' 24 24)">' + motif() + '</g>';
  }

  function wall() {
    var hatch = "";
    for (var i = 0; i < 5; i++) {
      hatch += '<path d="M' + (6 + i * 9) + ' 42 L' + (20 + i * 9) + ' 6" stroke="' + C.dim +
               '" stroke-width="2.6" opacity=".5"/>';
    }
    return '<rect x="1.5" y="1.5" width="45" height="45" rx="8" fill="#3a4247" stroke="' + C.dom +
           '" stroke-opacity=".22"/>' + hatch +
           '<rect x="6" y="6" width="36" height="36" rx="4" fill="none" stroke="' + C.dim +
           '" stroke-width="2" opacity=".7"/>';
  }

  /* A masked-but-empty cell: part of the shape, holds nothing. */
  function open() {
    return '<rect x="3" y="3" width="42" height="42" rx="8" fill="none" stroke="' + C.dim +
           '" stroke-opacity=".22" stroke-dasharray="3 4"/>';
  }

  /* Open sky is drawn as nothing at all — arrows fly over it. */
  function sky() { return ""; }

  function cellSVG(inner) {
    return '<svg viewBox="0 0 48 48" aria-hidden="true">' + inner + "</svg>";
  }

  /* -------------------------------------------------------------- chrome -- */

  function heart(spent) {
    return '<svg class="heart' + (spent ? " gone" : "") + '" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 21s-8-5.2-8-11a4.6 4.6 0 018-3 4.6 4.6 0 018 3c0 5.8-8 11-8 11z" fill="' +
      (spent ? C.dim : C.err) + '"/></svg>';
  }

  function star(filled, cls) {
    return '<svg class="star ' + (cls || "") + '" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.5 6.1 20.6l1.2-6.5L2.5 9.5l6.6-.9z" fill="' +
      (filled ? C.accent : "none") + '" stroke="' + (filled ? C.accent : C.dim) +
      '" stroke-width="1.6" stroke-linejoin="round" opacity="' + (filled ? 1 : 0.45) + '"/></svg>';
  }

  function chevronLeft() {
    return '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M15 5l-7 7 7 7" fill="none" stroke="' + C.ink +
      '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function lock() {
    return '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">' +
      '<rect x="4" y="10" width="16" height="11" rx="2.5" fill="none" stroke="' + C.dim + '" stroke-width="2"/>' +
      '<path d="M8 10V7a4 4 0 018 0v3" fill="none" stroke="' + C.dim + '" stroke-width="2"/></svg>';
  }

  /* --------------------------------------------------- home background ---
     The anchor-derived treatment, built from the game's OWN motif: smoke
     streamlines with arrowheads drifting through a framed test section. Not a
     flat fill — design-brief.md stage 7. */
  function flowBG() {
    var rnd = mulberry32(77), s = "";
    for (var i = 0; i < 15; i++) {
      var y = 24 + i * 54 + rnd() * 16;
      var amp = 8 + rnd() * 14;
      var o = (0.07 + rnd() * 0.10).toFixed(3);
      s += '<path d="M-20 ' + y + ' C 90 ' + (y - amp) + ', 220 ' + (y + amp) + ', 410 ' + (y - amp * 0.5) +
           '" fill="none" stroke="' + C.dom + '" stroke-width="' + (0.8 + rnd() * 1.3).toFixed(1) +
           '" opacity="' + o + '"/>';
      if (i % 2 === 0) {
        var x = 60 + rnd() * 230, yy = y - amp * 0.35;
        s += '<path d="M' + x + " " + (yy - 6) + " l7 6 -7 6" + '" fill="none" stroke="' + C.accent +
             '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="' +
             (0.13 + rnd() * 0.13).toFixed(3) + '"/>';
      }
    }
    s += '<rect x="16" y="96" width="358" height="640" fill="none" stroke="' + C.dom +
         '" stroke-width="1" opacity=".09"/>';
    for (var t = 0; t < 26; t++) {
      s += '<line x1="16" y1="' + (100 + t * 24) + '" x2="' + (t % 4 ? 21 : 28) + '" y2="' + (100 + t * 24) +
           '" stroke="' + C.dom + '" stroke-width="1" opacity=".13"/>';
    }
    return '<svg class="bgl" viewBox="0 0 390 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' +
      '<defs><radialGradient id="fpvig" cx=".5" cy=".34" r=".78">' +
      '<stop offset="0" stop-color="#232a2e"/><stop offset="1" stop-color="#151819"/></radialGradient></defs>' +
      '<rect width="390" height="800" fill="url(#fpvig)"/>' + s + "</svg>";
  }

  /* The quiet in-game ground: the same streamlines, far weaker, so the board
     stays the dominant element by a wide margin. */
  function plainBG() {
    var s = "";
    for (var i = 0; i < 10; i++) {
      s += '<path d="M-10 ' + (40 + i * 84) + ' C 120 ' + (34 + i * 84) + ', 250 ' + (48 + i * 84) +
           ', 400 ' + (38 + i * 84) + '" fill="none" stroke="' + C.dom + '" stroke-width="1" opacity=".05"/>';
    }
    return '<svg class="bgl" viewBox="0 0 390 800" preserveAspectRatio="none" aria-hidden="true">' +
      '<rect width="390" height="800" fill="' + C.ground + '"/>' + s + "</svg>";
  }

  /* ---------------------------------------------------------- lane marks --
     Board-pixel coordinates; the caller supplies a centre() for a cell index.
     `strong` is the lane the player just paid a life for; the faint form is
     used on the fail screen for every other lane that was shut. */
  function lane(a, z, strong) {
    var op = strong ? 0.95 : 0.4;
    var w = strong ? 3 : 2;
    return '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + z.x + '" y2="' + z.y +
      '" stroke="' + C.err + '" stroke-width="' + w + '" stroke-dasharray="5 5" opacity="' + op + '"/>';
  }

  function blockMark(z, r, strong) {
    var op = strong ? 1 : 0.45;
    return '<circle cx="' + z.x + '" cy="' + z.y + '" r="' + r + '" fill="none" stroke="' + C.err +
      '" stroke-width="3" opacity="' + op + '"/>' +
      '<path d="M' + (z.x - r * 0.38) + " " + (z.y - r * 0.38) + " L" + (z.x + r * 0.38) + " " + (z.y + r * 0.38) +
      " M" + (z.x + r * 0.38) + " " + (z.y - r * 0.38) + " L" + (z.x - r * 0.38) + " " + (z.y + r * 0.38) +
      '" stroke="' + C.err + '" stroke-width="3.4" stroke-linecap="round" opacity="' + op + '"/>';
  }

  /* The hint's proof, drawn in the complete colour: the whole lane it just
     scanned, clear all the way off the board. */
  function clearLane(a, z) {
    return '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + z.x + '" y2="' + z.y +
      '" stroke="' + C.ok + '" stroke-width="3" stroke-linecap="round" stroke-dasharray="2 7" opacity=".9"/>' +
      '<circle cx="' + z.x + '" cy="' + z.y + '" r="4" fill="' + C.ok + '" opacity=".9"/>';
  }

  return {
    C: C, ROT: ROT,
    tile: tile, wall: wall, open: open, sky: sky, cellSVG: cellSVG, motif: motif,
    heart: heart, star: star, chevronLeft: chevronLeft, lock: lock,
    flowBG: flowBG, plainBG: plainBG,
    lane: lane, blockMark: blockMark, clearLane: clearLane
  };
})();

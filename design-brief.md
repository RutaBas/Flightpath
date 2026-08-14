# Flightpath — design brief

Status: **SIGNED OFF — the design gate is closed.** Direction, ladder, screens and sound
set are all chosen (2026-08-13). UI work is unblocked.

Companion files: `design-moodboard.html` (round 1, live — the boards are tappable),
then `design-screens.html` and `design-sound.html` (round 2, once a direction is picked).
Logic contract: `SPEC.md`.

---

## 0. What the design has to carry

Flightpath is a tap-away arrow puzzle. Three things follow from the mechanic, and the
visual design lives or dies on them:

1. **Direction must be unmistakable at a glance.** The entire puzzle is "which way is
   this pointing and what is in front of it." Four rotations of one motif — never four
   different shapes, never colour as the direction cue. A player scanning a 7×9 board
   must never have to *think* about which way a tile faces.
2. **A wall must read as permanent.** Walls never move. If a wall looks like just
   another tile, the player will tap it and feel cheated. Different silhouette,
   different material, no arrowhead anywhere on it.
3. **The blocked tap has to feel fair.** It costs a life, so the game must *show* why:
   the tile that blocked you lights up. A shake with no explanation reads as the game
   being arbitrary. This is the single most important piece of feedback in the game.

A fourth, quieter one: boards run up to 7 columns of 45px tiles, so the board fills
nearly the whole width of a 390px phone. The chrome has to be slim.

---

## Stage 1 · Concept anchor

Four candidates are live on the moodboard; **one gets chosen in round 1.** Everything
below must be answerable with "because it's [the anchor]."

- **A · Wind Tunnel, 1935** — "Flightpath feels like reading smoke streams in an
  aerodynamics test chamber." Dark chamber, pale smoke lines, one amber signal lamp.
  Instrument-panel precision.
- **B · Rooftop Pigeon Loft** — "Flightpath feels like a rooftop loft on race morning."
  Limewash and zinc, leg-ring blue, birds released one basket at a time. Warm, homely,
  a bit weathered.
- **C · Kite Field, Overcast** — "Flightpath feels like a kite field under flat grey
  light." Sea-grey sky, faded ripstop nylon, lines all straining different ways. Airy
  and calm.
- **D · Night Mail Depot, 1928** — "Flightpath feels like a night mail depot." Ink-blue
  night, canvas sacks, airmail chevrons, route stamps. Nocturnal and mechanical.

_Chosen: **A · Wind Tunnel, 1935.** "Flightpath feels like reading smoke streams in an
aerodynamics test chamber."_

## Stage 2 · Colour

Every direction carries a ground (never pure white or black), a dominant for the tile
motif, an accent reserved for tappable/active things, a mistake colour, and a complete
colour. Full hex values with roles are on the moodboard.

Hard requirement: every text/background pair clears **WCAG AA 4.5:1**, checked with a
contrast script before the UI ships, and stays legible in direct sun. Two of the four
directions are dark grounds and two are light — worth picking partly on which you would
rather look at on a phone at night.

Direction is never encoded by colour: an arrow's colour is constant and only its
rotation changes. Colour is reserved for state (tappable, blocked, complete).

_Chosen — the shipping palette:_

| Token | Hex | Role | Contrast |
|---|---|---|---|
| `--ground` | `#1a1e21` | chamber dark — page ground | — |
| `--panel` | `#242a2e` | board bed | — |
| `--cell` | `#2e353a` | tile face | — |
| `--ink` | `#e3e8e6` | primary text | 13.2:1 on ground |
| `--dim` | `#8d9a97` | labels, secondary text | 6.4:1 on ground |
| `--dom` | `#c3ccc8` | smoke — the streamline motif | — |
| `--accent` | `#c2853c` | signal lamp — arrowheads, tappable, primary CTA | — |
| `--err` | `#a35c50` | blocked lane, spent life | — |
| `--ok` | `#6f9188` | complete, streak, progress | — |

Both text pairs clear WCAG AA 4.5:1 with margin. Direction is never carried by colour —
the arrowhead is `--accent` in all four rotations.

## Stage 3 · Typography

One display face plus one text face per direction, both Google Fonts, never the system
sans default. None of these four pairings is used anywhere else in the portfolio
(checked against all 15 existing games).

- A · Archivo 800 + Martian Mono
- B · Bitter 700 + Karla
- C · Gabarito 700 + DM Sans
- D · Bebas Neue + Work Sans

_Chosen: **Archivo 800 + Martian Mono.** Archivo carries the title plate and headings;
Martian Mono every label, level number and stat — wide instrument lettering that keeps
tabular figures from shimmering._

## Stage 4 · Spacing & depth

Shared across all directions, so it is not part of the pick:

- Scale **4 / 8 / 16 / 24 / 32**, used everywhere; no eyeballed padding.
- **The board caps at 7 columns**, and that number is measured rather than assumed. At a
  390px viewport with 12px layer padding, 8px board padding and 5px gutters, the usable
  inner width is 350px: a tile lands at **54px at 6 columns, 46px at 7, and 39px at 8**.
  Eight columns breaks the 44px tap floor, so the hardest tier grows downward (7×9) rather
  than sideways. Caught in the screen mockups, before any UI existed.
- **One material per direction**, applied to every raised element: A is matte
  instrument panel, B is soft weathered card, C is smooth rounded nylon, D is hard
  stamped crate. Every tile gets a pressed state on touch — a 40ms scale to 0.94 —
  because a tap that costs a life must feel like it registered.

## Stage 5 · Motion language

One personality per direction, stated on the moodboard and demonstrated by tapping:

| | personality | launch | blocked |
|---|---|---|---|
| A | snappy, linear | 150ms, released and gone, one-frame smear | 4px lateral shake |
| B | soft, bouncy | 300ms, one flap then an arc | bate — flutter in place |
| C | smooth drift | 380ms with sway, tail trailing | line goes taut, tug back |
| D | mechanical | 200ms, stamped then slides on a rail | hard 3px stop, no bounce |

Touchpoints in all four: tap/select, launch, blocked, screen transitions, win, fail.
Everything gates behind `prefers-reduced-motion`.

_Chosen: **snappy, linear** — 150ms cubic-bezier(.2,.8,.3,1). An arrow is not drifted away,
it is released and gone, leaving a one-frame smear. Blocked: a 4px lateral shake with the
blocking tile pulsing `--err` for 300ms. All of it behind `prefers-reduced-motion`._

## Stage 6 · Feedback & juice

Proportional — the small stuff stays small so the win has somewhere to go.

| Moment | Visual | Motion | Sound | Haptic |
|---|---|---|---|---|
| **arrow launches** | tile leaves along its lane | the direction's launch motion | one short launch tone | 8ms |
| **blocked tap** | **the blocking tile lights in the mistake colour** — this is the part that makes it fair — plus a heart burns out | the direction's blocked motion | one low blocked tone | 18ms |
| **last arrow** | brief hold before the win fires | — | launch tone, pitched up | 8ms |
| **level complete** | full celebration: particles in the direction's palette, board clears, stars land one at a time | the biggest sequence in the game | 3-note win phrase | short pattern |
| **out of lives** | board dims, remaining blocked lanes are revealed | slow settle, no shake | one falling tone | one long buzz |

Revealing the blocked lanes on failure is deliberate — the player learns why they lost
rather than just being told they did.

_Sound set chosen: **a custom mix**, picked event by event from the three candidate sets
rather than taking one wholesale. The reasoning is sound: the launch is heard 20–50 times a
level so it takes the warmest, softest tone, while the two failure sounds take the
mechanical set so a mistake is unmistakable, and the win takes the airiest so it has the
most room. Exact synthesis, to be pasted verbatim into `js/sound.js`:_

| Event | From | Synthesis |
|---|---|---|
| **launch** | C · Chamber Tone | two sines 660→1320Hz over 260ms, vol .10 and .06, the second detuned +9 cents so they beat |
| **blocked** | B · Relay | square 148Hz for 60ms, again at +100ms for 70ms, vol .15/.13, plus a 50ms bandpass noise burst at 260Hz Q1.4 vol .08 |
| **section clear** | A · Airflow | three swells at 0/150/300ms — bandpass noise 700/1220/1740 → 1500/2400/3300Hz, Q1.3, 500ms, vol .10 — each with a sine 440/554/659 → 880/1108/1318Hz, 550ms, vol .06; then a 700ms noise tail 2400→600Hz vol .06 |
| **out of lives** | B · Relay | squares 420/330/250/186Hz, 90ms each at 110ms intervals, vol .12; then triangle 96Hz at 460ms for 500ms vol .14, plus a click |

Haptics ride alongside and are independent of the mute toggle: 8ms on launch, 18ms on
blocked, a short pattern on the win, one long buzz on the fail.

## Stage 7 · Screens & layout

- **Home / start** — title lockup (a real lockup per direction, not plain type), one
  primary action, and the tier ladder, all above the fold at 390px. Background is a
  **real anchor-derived treatment built from the game's own elements** — flow lines for
  A, loft grid and feather marks for B, drifting kites for C, route postmarks for D —
  not a flat fill. Translucent panels sit behind any text that crosses a busy area.
- **In-game HUD** — slim: tier + level, hearts, hint, undo, menu. Nothing else. The
  board is the dominant element by a wide margin. No timer is displayed; elapsed time
  is recorded for stats only and never costs a star.
- **Win screen** — the payoff, most polish: stars earned, lives left, hints used,
  best-yet marker, streak, share, next level.
- **Fail screen** — this game can be lost, so it gets a real screen: what blocked you,
  lives spent, retry, and back to the ladder. Never a dead end and never scolding.

_Confirmed in round 2 via `design-screens.html`: **approved as shown**, all four screens —
home, in-game, win and out-of-lives — with no changes requested._

## Stage 8 · App-store extras

Real icon set drawn from the chosen direction's tile motif, theme + splash colour in
the manifest, the three iOS meta tags, safe-area insets for notch and home bar,
pull-to-refresh and text-selection disabled on the board, offline play via the service
worker, and a first-launch how-to that shows the one rule — *an arrow leaves only if
its whole lane is clear* — and never blocks a returning player.

---

## Difficulty ladder

Five tiers, mapped to solver-measured planning depth (see `SPEC.md`), not board size.
Three candidates on the moodboard:

- **L1 · Flight stages** — Taxi · Takeoff · Climb · Cruise · Ceiling
- **L2 · Wind scale** — Still Air · Light Breeze · Fresh Wind · Half Gale · Full Gale
- **L3 · Airspace** — Clear Skies · Light Traffic · Holding · Stacked · Gridlock

_Chosen: **L3 · Airspace.** Clear Skies · Light Traffic · Holding · Stacked · Gridlock —
the one ladder that describes what the board is literally doing, since the later tiers
really are more congested and more stacked up._

| Tier | Name | Grid | Levels | Gate |
|---|---|---|---|---|
| 1 | Clear Skies | 4×5 | 40 | open |
| 2 | Light Traffic | 5×6 | 40 | open |
| 3 | Holding | 6×7 | 40 | open |
| 4 | Stacked | 6×8 | 40 | open |
| 5 | Gridlock | 7×9 | 40 | requires 100 levels cleared |

---

## Scoring (settled at intake, not up for design)

No time pressure. **3 stars** = cleared with no blocked taps and no hints; **2** = one
slip or one hint; **1** = cleared. Three lives per level; spending the last one fails
the level. Mistakes are counted from the board — an actually-attempted blocked tap —
never from a button press.

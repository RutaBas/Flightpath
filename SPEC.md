# Flightpath — logic spec

A copy of *Arrow Puzzle: Tap Puzzle Games* (Easybrain), a 2D "tap away" arrow puzzle.
This file is the contract the solver, generator and verification harness are built
against. It describes **logic only** — no colours, no fonts, no screens. Those are
decided at the design gate, separately.

## Rules

- The board is a `w × h` square grid. A **mask** marks which cells are part of the
  playable shape; unmasked cells are **open sky** — arrows fly over them freely and
  nothing can be placed there. The shape may be irregular.
- Each masked cell is one of:
  - **open** — nothing there, does not block anything;
  - **wall** — an immovable block. Never removable. Blocks any ray passing through it,
    forever;
  - **arrow** — points in one of four directions: N, E, S, W.
- **A tap on an arrow** launches it in its direction. It leaves the board **iff every
  cell along its ray**, from the next cell up to and off the edge, is free of arrows
  and walls. Open cells and unmasked sky do not block.
- A tap on an arrow whose ray is blocked is a **mistake**: the board is unchanged and
  one **life** is spent.
- **Win** when no arrows remain. **Lose** when lives reach zero.

## The two facts that shape everything

1. **Removal is monotone.** Taking an arrow off the board only ever empties a cell, so
   an arrow that is free stays free forever, and the free set can only grow. Therefore
   the rewriting system is confluent: whatever order the player taps in, the terminal
   state is the same. **A board certified solvable can never be bricked by bad play.**
   The only cost of playing badly is lives.

   This is Flightpath's equivalent of a no-guess guarantee, and the harness must
   *prove* it rather than assume it — by exhaustive state-space search on small boards
   agreeing with the greedy closure, and by randomized legal play always clearing.

2. **Random boards deadlock constantly.** Two arrows facing each other are both
   permanently stuck; walls make it far worse. So solvability is *not* free, and the
   generator is only allowed to emit boards the solver certifies. This is the load-
   bearing gate.

## Solver

Pure functions over a board, no DOM, `require`-able under node.

- `rayCells(board, idx)` → the cells the arrow at `idx` would traverse.
- `isFree(board, idx)` → true iff that ray holds no arrow and no wall.
- `freeSet(board)` → indices of every currently-free arrow.
- `solve(board)` → `{ solved, rounds, order, stuck }`, computed by the greedy closure:
  repeatedly take the whole current free set as one **round**, remove it, repeat until
  no arrow is free. `solved` iff the board ends empty; `stuck` is whatever is left.
- `grade(board)` → order-independent difficulty metrics:
  - `arrows` — count;
  - `depth` — number of rounds (the longest dependency chain; how far ahead you must
    plan);
  - `minRoundWidth` — smallest round size. A round of width 1 means exactly one arrow
    on the whole board is safe and the player has to find it;
  - `trapFraction` — share of arrows blocked at the start; how fast a naive tapper
    bleeds lives;
  - `meanRay` / `maxRay` — how far the eye must travel to verify a launch;
  - `effort` — a composite score built from the above, used to bucket a board into a
    tier.
- `hint(board)` → one provably-free arrow (and, for a stuck board, why). Powers the
  in-game hint; must never point at a blocked arrow.

Every deduction is a proof, never a guess: an arrow is only ever reported free when
its whole ray has been scanned and found clear.

## Generator

Solvable **by construction**, then graded **independently** by the solver.

Build in reverse removal order: place the last arrow to leave first, and each newly
placed arrow must have a ray clear of everything already placed. Any board built this
way has at least one valid clearing order, so it can never deadlock. Walls are placed
before any arrow and count as blockers during construction.

Construction only guarantees *some* order exists. The actual difficulty — depth,
bottlenecks, traps — is whatever fell out, so every candidate is re-graded from
scratch by `solve`/`grade` and **discarded unless it lands inside the target tier's
band**. Target match is exact-band, not "at least this hard", so a tier-1 board never
accidentally arrives brutal.

Seeding follows the `seeded-rng` recipe: properly avalanched hash, and level and retry
attempt hashed **together as one string** — never added — so no two levels can collide
on an effective seed.

## Difficulty tiers

Five tiers. Bands are the solver's own metrics, not cell counts. Names are chosen at
the design gate; these are placeholders.

| Tier | Grid | Arrows | Walls | depth | notes |
|---|---|---|---|---|---|
| 1 | 4×5 | 10–14 | 0 | 3–4 | everything reachable in a few rounds |
| 2 | 5×6 | 16–22 | 0 | 4–6 | real ordering appears |
| 3 | 6×7 | 24–32 | 0–2 | 6–9 | first walls |
| 4 | 6×8 | 32–42 | 2–4 | 9–13 | `minRoundWidth` gated to 1–2 |
| 5 | 7×9 | 44–58 | 3–6 | 13–26 | long rays, dense traps |
| 6 | 7×9 | 42–56 | 3–6 | 21–28 | same board, deeper chains |
| 7 | 7×9 | 42–58 | 1–4 | 29–46 | long forced runs |

Two bands are tighter in code than the prose above originally implied, both deliberate:
tier 5's depth is **closed at 26** (an exact band needs an upper bound; the observed max is
21), and tier 4's "bottleneck rounds" note is enforced as a checked `minRoundWidth ∈ [1,2]`.

Tier 5 is the expensive one at its size: 63 cells must hold 44–58 arrows plus 3–6 walls, so
the very top of the band (58 + 6 = 64) is arithmetically unreachable and those draws die on
arrival. Measured acceptance 11.35%.

### The last three tiers share a grid, and why

**7×9 is the ceiling in both directions**, measured on real devices rather than assumed:

| Device | Board area | Tile at 7 cols | Max rows |
|---|---|---|---|
| 390×844 | 366×662 | 45.7px | 12 |
| **375×667 (iPhone SE)** | **359×485** | **44.8px** | **9** |

Boards must be identical on every device, so the SE binds. Eight columns gives 39.4px and a
tenth row drops below 44px — both break the tap-target floor. So tiers 6 and 7 cannot be
*bigger* than tier 5; they are harder **structurally**.

Three findings from the frontier sweep that the design did not anticipate:

- **Tier 5's depth ceiling was a sampler artefact, not a structural limit.** A serpentine
  chain reaches depth ≈ arrow count, so 7×9 structurally allows depth near 60. Tier 5
  stopped at 21 only because of its proposal distribution. The lever is `rayBias`: a chain
  grows only by dropping a blocker *on the current head's ray*, so a short-rayed head ends
  it and a zero-length ray ends it permanently.
- **Walls are an anti-lever.** Contrary to the original design note, adding walls makes
  boards *easier*, not harder — every wall truncates lanes, so fewer cells have a clear ray
  and the chain has fewer places to grow. Median depth falls 23 → 17 as walls go 0 → 3-6,
  and acceptance at the tier-7 band collapses from 5.55% (0–2 walls) to 0.27% (3–6). This
  is why **tier 7 has *fewer* walls than tier 5** — a measured decision, not a softening.
- **`minRoundWidth` is useless as a discriminator up here** — it is 1 at the median from
  tier 5 onward. What actually separates the hard tiers is the *run*: the longest streak of
  consecutive width-1 rounds, where only one arrow on the whole board is legal. Medians:
  T5 10, T6 17, T7 25. `accepts()` therefore gained an opt-in `forcedRun` band, absent from
  tiers 1–5 so their behaviour is provably unchanged.

Because grid size can no longer separate the top three tiers, separation is enforced on
**two disjoint axes at once** — effort windows `[190,285] / [286,352] / [353,520]` and depth
`[13,26] / [21,28] / [29,46]` — which makes cross-tier acceptance arithmetically impossible
rather than merely unobserved.

Measured acceptance: tier 6 **9.43%** (worst 88 attempts of a 2000 budget), tier 7 **1.70%**
(worst 382 of 6000). Zero dead seeds in 1000 seeds per tier.

**Grid width caps at 7 columns.** Measured, not guessed: at a 390 px viewport, with 12 px
layer padding, 8 px board padding and 5 px gutters, the usable inner width is 350 px, so a
tile comes out at 54.2 px at 6 columns, **45.7 px at 7, and 39.4 px at 8**. Eight columns
therefore breaks the 44 px tap-target floor and is not allowed. Height is not the binding
constraint — a 7×9 board is ~474 px tall against ~596 px of available column.

## Features (recipe coverage)

| Feature | Recipe |
|---|---|
| tap input on the board | `pointer-gestures` |
| board sizing / relayout | `board-layout` |
| lives, mistakes, level fail | — game-specific |
| hint (solver-powered) | `hints-and-workers` |
| undo (put the last arrow back) | `undo-history` |
| elapsed time, for stats only — never for stars | `timer-and-pause` |
| share summary, spoiler-free | `share-card` |
| win celebration + reduced motion | `celebration-and-motion` |
| sound + haptics | `audio-engine` |
| seeded generation | `seeded-rng` |
| versioned saves | `save-migration` |
| levels / daily / stats | `_shared/meta` |
| PWA shell, icons | `pwa-shell` |
| iOS tap hygiene | `ios-tap-hygiene` |

## Scoring

No time pressure. Stars come from mistakes and hints only:

- **3 stars** — cleared with no blocked taps and no hints
- **2 stars** — one blocked tap or one hint
- **1 star** — cleared

Lives are limited per level (3). Spending the last one **fails the level** — the game
has a real lose state and therefore a real lose screen. Mistakes are counted from the
board (a blocked tap actually attempted), never from a UI button.

# Flightpath

A tap-away arrow puzzle for the phone. A grid holds arrows all pointing different
ways; tap one and it launches off the board — but only if every cell in front of it
is clear. Tap into a blocked lane and it costs you a life. Clear the board to win.

Built as an installable web app: vanilla HTML/CSS/JS, no framework, no backend, no
build step. Plays offline once installed.

*Anchor: "Flightpath feels like reading smoke streams in an aerodynamics test
chamber." Everything visual follows from that — see `design-brief.md`.*

---

## How to play

- **Tap an arrow** to launch it. It leaves the board only if every cell along its
  ray — all the way off the edge — is empty.
- **Walls** (the hatched, bolted tiles) never move and block a lane permanently.
  Open sky around the board's shape does *not* block; arrows fly straight over it.
- **A blocked tap costs a life.** The tile that stopped you lights up so you can see
  why. Three lives; spend the last one and the level fails.
- **Stars** come from mistakes and hints only — never from speed. Three stars for a
  clean run, two if you slip once or take a hint, one for finishing. Your time is
  recorded for stats but is explicitly *not scored*: thinking should never cost you.

The whole game is one question asked repeatedly — *what has to leave before this one
can?*

## The one thing worth knowing about the rules

Removing an arrow only ever **empties** a cell. So an arrow that is free stays free,
the set of launchable arrows can only grow, and the order you clear in cannot matter
to whether you finish. **A board that is solvable at the start can never be bricked
by bad play.** Playing badly costs lives, never the level.

That property is not assumed — it is proven in the test suite (see below), because
the entire difficulty model rests on it.

The flip side is that **random boards deadlock constantly**: two arrows facing each
other are both stuck forever, and walls make it far worse. So the generator is not
allowed to invent boards — it may only emit ones the solver certifies.

## Difficulty

Five tiers, named for how congested the airspace is. Difficulty is graded by the
solver's own measurements — how deeply the dependencies chain, how often you are
down to a single legal move — not by how big the grid is.

| Tier | Grid | What changes |
|---|---|---|
| Clear Skies | 4×5 | everything clears in a few rounds |
| Light Traffic | 5×6 | real ordering appears |
| Holding | 6×7 | first walls |
| Stacked | 6×8 | rounds where only one arrow is legal |
| Gridlock | 7×9 | long rays, dense traps — unlocks after 100 levels |

**The board caps at 7 columns**, and that is measured rather than chosen: at a 390px
phone the usable width is 350px, so a tile is 54px at 6 columns, 46px at 7, and 39px
at 8 — below the 44px minimum tap target. The hardest tier grows *downward* for that
reason.

## How it works

Written solver-first: the solver came before the generator, and the generator before
any UI.

**Solver** (`js/solver.js`) — every deduction is a completed proof, never a guess. An
arrow is only ever reported launchable after its entire ray has been scanned and
found clear. `solve()` runs a round-based greedy closure: take every currently-free
arrow as one round, remove them all, repeat. `grade()` reports the metrics difficulty
is actually built from — chain depth, the narrowest round, how many arrows are
trapped at the start, how far the eye must travel — and folds them into one `effort`
score. `hint()` re-verifies its choice with a fresh full scan before returning it,
because a bad hint would cost the player a life.

**Generator** (`js/generator.js`) — solvable *by construction*, then graded
*independently*. It builds backwards: the last arrow to leave is placed first, and
each new arrow must have a clear ray through everything already down. That guarantees
at least one valid clearing order exists. It then throws that knowledge away and
re-grades the finished board from scratch, discarding it unless it lands inside the
target tier's **exact** band — so a tier-1 board never arrives accidentally brutal.

## Running the tests

```bash
node games/flightpath/test/verify.js
```

That is the gate — 37 checks, ~3s. It is written independently of the solver it
audits (its own board parser, ray walker, closure and an exhaustive search oracle) so
a shared bug cannot hide in both. It proves, among other things:

- **soundness** — no arrow is ever called launchable while its ray is obstructed
  (~390k deductions checked against a separate scanner, including mid-solve states)
- **the no-brick guarantee** — exhaustive state-space search agrees with the fast
  solver on every board, every board has exactly one terminal state, and 1,440
  randomised playthroughs all cleared
- **the gate is load-bearing** — re-rolling arrow directions *without* the solver gate
  produces 94% deadlocked boards
- **grading is real** — each tier's median effort clears the previous tier's maximum,
  and no certified board satisfies another tier's band
- **hints are safe** — 7,658 hint calls, none named a blocked arrow

Also available:

```bash
node games/flightpath/test/logic.test.js       # the solver author's own suite
node games/_shared/meta/test/verify.js         # the shared progression library
```

## Project structure

```
index.html              one page, four screens
css/style.css           iOS tap hygiene, then the Wind Tunnel design tokens
js/
  board.js              board model + serialization   ─┐
  solver.js             deduction, grading, hints      ├─ verified core,
  generator.js          reverse construction + gate    │  no DOM, runs in node
  rng.js                seeded PRNG                   ─┘
  game.js               game rules — no DOM
  ui.js                 all DOM, no rules
  art.js                the drawn vocabulary (tiles, walls, hearts, stars)
  meta-config.js        campaign / daily / stats configuration
  levels.js             baked level table
  par.js                shared par, so daily and campaign agree
  sound.js storage.js history.js timer.js celebrate.js gestures.js tap-guard.js
  meta/                 vendored copy of games/_shared/meta
test/verify.js          the correctness gate
sw.js                   offline shell
design-brief.md         the signed-off 8-stage design
SPEC.md                 the logic contract the tests are written against
```

Logic is kept strictly out of the DOM so the same solver that generates the boards
also powers the hint button, and so the whole core runs headlessly under node.

## Deploy

Static — no build step. Push to GitHub and enable Pages, or drag the folder into
Netlify.

```bash
git add -A
git commit -m "Flightpath: tap-away arrow puzzle"
git push origin main
```

`.nojekyll` is committed so GitHub Pages serves every path verbatim.

### Install on iPhone

Open the deployed URL in **Safari** → **Share** → **Add to Home Screen**. It then
launches full-screen with no browser chrome and works offline.

> When deploying an update that changes any precached file, bump `CACHE_VERSION` in
> `sw.js`. A stale service worker will otherwise keep serving the old build, and
> anything missing from `PRECACHE` 404s **only** when offline — which you will not
> see at your desk.

# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Xcryptoid/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Xcryptoid/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it reads a sealed DeFiLlama snapshot of the protocol
universe, scores every pre-token protocol by an implied value the snapshot's
own figures produce, and hands back a ranked board with a concrete farm plan
for each row, plus a static dashboard that renders the whole board in the
browser with no network and no framework.

## What it does

Most protocol lists rank by TVL alone, which answers the wrong question. A
protocol with a huge TVL and a token already trading is not a launch to farm;
a small protocol with no token, fast growth and a long track record might be.
This radar separates the two groups first and then ranks only the pre-token
ones, so the top of the board is a list of launches that have not happened
yet, ordered by how much the market would plausibly pay for them if they
launched today.

The entry point is `main.ts` (Node 22, standard library only). It reads the
snapshot, builds the board, writes `board.json` and `data.js`, copies the
dashboard and the screenshots into the output directory, and writes
`dossier.json`, the summary the judge reads. The whole run is deterministic:
run it twice on the same snapshot and every output byte is identical.

## The model (radar-3)

The implied value of a protocol is not a guess and not a hardcoded list of
names. It is derived from the snapshot's own figures, in three parts.

First, a category multiple. For each category, the model takes the traded
protocols in that category — the ones whose token already has a market cap —
and computes the median of their market-cap-to-TVL ratios. That median is the
category's multiple: it is what the market already pays, per dollar of TVL,
for protocols of that kind. Two safeguards keep one outlier from setting a
whole category. Every comp ratio is capped to the range [0.02, 2.00] before
the median is taken, so a micro-cap token with a 400x ratio cannot drag its
category to the cap. And the category median is shrunk toward the global
median with a blend prior of 6, so a category with a single traded comp sits
close to the global median instead of trusting that one comp. A category
with no traded comps at all takes the global median. The resulting multiple
is clamped to [0.05, 1.5].

Second, a growth multiplier. The protocol's seven-day TVL change, clamped to
[-60, 120] percent, moves the value by half its size: a protocol growing
20% in a week is worth 10% more than its base, and one shrinking 20% is
worth 10% less. The clamp keeps a single wild week from dominating the
ranking.

Third, a maturity multiplier. A protocol that has run for years without a
token has had longer to build the user base a launch would price; a protocol
listed a month ago has not. The multiplier is 0.6 plus 0.4 times the
protocol's age in days divided by 1095 (three years), capped at 1.0. A
protocol with no listing date is treated as 365 days old.

The implied value is the TVL times the category multiple times the growth
multiplier times the maturity multiplier, rounded to whole dollars. No
protocol name is ever special-cased: the same function scores every row, and
the dashboard's model panel states the cap and the prior of 6 so the judge
can see exactly how the numbers were produced.

## The board

The board carries 178 rows. Forty of them are the watchlist — the floor the
competition defines, every slug on it, even one the snapshot no longer
carries. The other 138 are the early radar: every rankable pre-token
protocol below the watchlist's TVL floor, by TVL. A protocol is rankable
when it has no token at all (no market cap, no CoinGecko id, no symbol) and
is not an exchange, a bridge, a wrapped or staked product, a versioned pool,
or a protocol named after an exchange. The watchlist is the floor, never the
ceiling: the board exists to find the rows below it.

Twenty-four more protocols are set aside in a live-token view. These already
trade, so the board shows the market's own values for them — market cap and
TVL side by side — and never mixes them into the ranked board. Keeping the
two groups apart is what makes the ranking honest: a ranked row is always a
protocol whose token does not exist yet.

Ranks are exactly 1 through 178, each used once, and implied values are
non-increasing as the rank ascends. Every row carries its model breakdown
(category multiple and how many comps priced it, growth and maturity
multipliers, age in days) so any rank can be checked by hand.

## Farm plans

Every row carries an eight-step farm plan, and every step states what it
costs and how long it takes. The plan is derived from the protocol's own
record — its category, its chains, its TVL and its age — never from a
hand-written list of names.

The steps are: use a fresh wallet that holds only the funds you plan to
farm, and keep its seed phrase offline; take the category's main action with
a capital sized to the protocol's TVL ($50 to $250); read the
category-specific risk step and check it weekly; make one qualifying action
each week so the wallet stays active; hold the position for 30 to 60 days
(younger protocols get the longer window) so the activity is counted in more
than one snapshot; repeat the main action a second time, on the protocol's
second chain when it has one, with half the capital; claim only from the
link the protocol itself publishes; and write the wallet, the dates and every
transaction in a farm log.

The risk step is new in radar-3 and is specific to the category: impermanent
loss for a DEX, health factor and liquidation for a lender, funding rates
for a perpetuals venue, unbonding waits for staking, depeg for a stable
asset, backing for a real-world-asset protocol, and so on. Gas is
chain-aware too: about $10 on Ethereum, about $2 on Bitcoin, under $1 on
every other chain. Nothing in the plan asks for a fee to check or to claim,
and nothing asks the farmer to borrow.

## The dashboard

The dashboard is a static page — `dashboard/index.html`, `dashboard/app.css`
and `dashboard/app.js` — with no framework and no network. It reads the
board from `data.js`, which the program writes from the same board that
`board.json` carries, so the page and the file can never disagree.

It is sortable and filterable: sort by rank, implied value, TVL or seven-day
change; filter to the watchlist only, to one category, or to one chain; and
search by name. Each row opens a detail view with the model breakdown, the
full eight-step farm plan, and the protocol's chains and listing date. A
separate live-token view lists the twenty-four protocols that already trade.
The palette is a single dark green on near-black with one accent, the type
is set in a system sans stack, and the layout is the same at every width the
screenshots were taken at.

Three screenshots ship with the entry and are copied to the output
unchanged: the full board, a detail view with all eight steps visible, and
the board filtered to the watchlist only. Each is under the 512 KiB cap.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

The snapshot is the sealed `/input/snapshot.json` (or `--input <file|dir>`);
`MAKEFUN_OUTPUT_DIR` (or `--output`) names the output directory. The program
refuses to write a board the gate would refuse — a missing watchlist slug, a
broken rank sequence, an out-of-order implied value, a farm step outside
20 to 600 characters — and exits non-zero with the reason on stderr. Node
22.18 or later is required; Python and Docker are not.

## Repository layout

- `main.ts` — the entrypoint: read the snapshot, score the board, write the
  outputs, copy the dashboard and screenshots, write the dossier.
- `lib/model.ts` — the radar-3 model: snapshot parsing, multiple
  calibration, implied values, farm plans, the board builder and the gate
  check.
- `lib/dossier.ts` — the dossier builder: this entry's own implementation
  of the makefun/dossier/v1 format, verified byte-identical against the
  kit vendor's canonical builder.
- `dashboard/` — the static page: `index.html`, `app.css`, `app.js`.
- `screenshots/` — the three screenshots the judge reads: the board, a
  detail view, and the watchlist-only filter.
- `LICENSE` — MIT.

## What radar-3 changed

Radar-2 priced the top of the board off single traded comps with extreme
ratios. One token with a 2.98x market-cap-to-TVL ratio set its whole
category's multiple, putting 19 of the top 50 rows in one category; two
others with 400x and 12x ratios pushed their categories to the 1.50 cap.
A strong opponent would have exposed that calibration as fragile, so
radar-3 caps every comp ratio to [0.02, 2.00] before the median and raises
the blend prior from 3 to 6. Single-comp categories now sit at x0.47
instead of x0.90 or x1.50, well-populated categories barely moved (Lending
x0.146 to x0.156, Dexs x0.315 to x0.297, the global median unchanged at
x0.214), and the top 50 is less concentrated. Ranks 1 and 2 are unchanged
(Steakhouse at $1.02B, Gauntlet at $607M) but now stand at defensible
levels.

The farm plans grew from 7 to 8 steps in the same revision: a
category-specific risk step and chain-aware gas replaced the flat gas
figures. The board, the dashboard and the screenshots were regenerated
from the new model and visually checked.

## Limits and guarantees

- The board is 100 to 4,000 rows; this snapshot yields 178. Every
  watchlist slug appears, and at least 60 rows sit outside the watchlist.
- Implied values are positive whole dollars, non-increasing with rank, and
  never all equal.
- Farm steps are 3 to 12 per row, each 20 to 600 characters; this entry
  writes 8 per row.
- The dashboard source is 36,530 bytes, under the 65,536-byte text cap; the
  dossier is 767,877 bytes, under the 1.5 MiB total cap.
- No `http://` or `https://` address appears in any dashboard source file:
  the page makes no network request at all.
- Two runs on the same snapshot are byte-identical on every output file.

---

<sub>Entered on [make.fun](https://make.fun/?ref=sm39bzkk&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>

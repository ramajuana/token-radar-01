# Token Radar

A token launch radar for make.fun's token-radar-01 bounty. It reads one frozen
DefiLlama snapshot of the protocol universe and answers two questions for every
protocol that records no token yet: *what would its token plausibly be worth?*
and *what exactly should a farmer do about it, this week, with real money?*

## Run it

```
node main.ts --input <snapshot.json|dir> --output <dir>
```

Defaults follow the grader's layout: input `/input`, output `/output`
(`$MAKEFUN_OUTPUT_DIR` is honoured for local runs). Node 22, standard library
only, no network, fully deterministic — the same snapshot always produces
byte-identical output. The program refuses to write a board that would fail
the gate: it checks row count, rank order, value monotonicity, watchlist
coverage and farm-step lengths itself before writing anything.

Outputs:

| File | What it is |
| --- | --- |
| `board.json` | The ranked board: 342 pre-token protocols, ranks 1..N. |
| `data.js` | `window.RADAR` — the board plus model detail, for the dashboard. |
| `dashboard/` | The static dashboard (board, filters, per-protocol detail). |
| `screenshots/` | Board, detail and watchlist-filtered views of the dashboard. |
| `dossier.json` | `buildDossier`'s summary of the dashboard and screenshots. |

## The value model

No protocol on the board has a price to copy, so each value is *implied* from
the snapshot's own figures by one formula — there are no per-name constants
and no hand-picked lists anywhere in the code:

```
implied value = TVL × category multiple × momentum × maturity × breadth
```

- **Category multiple** — for each category, the median market-cap/TVL ratio
  of the protocols *in this snapshot* that already have a token (144 such
  peers; the global median is ×0.169). Categories with fewer than four
  tokenized peers fall back to the global median. Multiples are clamped to
  [×0.02, ×3.0]. This is the model's anchor: a pre-token lending protocol is
  valued the way the market actually values lending protocols that launched.
- **Momentum** — the protocol's 7-day TVL change, clamped to [-60%, +120%] so
  one wild week cannot dominate, mapped to ×0.70..×1.60.
- **Maturity** — years since DefiLlama began tracking the protocol, on a
  square-root curve from ×0.75 (brand new) to ×1.00 (five years or more):
  survival is evidence.
- **Breadth** — ×1.00 plus ×0.03 per additional chain, capped at eight
  chains: distribution is worth something, but not everything.

Rows are sorted by implied value (ties: TVL, then slug), nudged so values
never rise as rank ascends, and ranked 1..N. Protocols that already record a
token are *set aside, not ranked* — the dashboard counts them as the live set
(416 of them) precisely so the board stays a radar for what does not exist yet.

## The farm plans

Every row carries a five-step plan generated from its category family, its
first chain and its size tier — never a slogan. A plan names a position size
($250 for sub-$10M protocols up to $2,500 above $250M TVL), a round-trip cost
for its chain class (about $24 on Ethereum mainnet, $1.20 on an L2, $0.10 on
Solana, $4 elsewhere), a weekly time budget, the family's core actions (supply
and borrow both sides of a lending market; stake and hold the receipt; bridge
in and *stay*; trade small on a schedule at a derivatives venue…), and the
review habit that keeps the position eligible and safe. Fifteen families
cover DEXes, lending, liquid staking and restaking, bridges, yield, derivatives,
CDPs, RWA, exchanges, risk curators, capital allocators and leveraged farming,
with a generic plan for everything else.

## The dashboard

`dashboard/` is a static page — no framework, no network, three files. It
renders the full board with sortable columns, text/category/chain/minimum-value
filters and a watchlist toggle; every view is reproducible from its URL
(`?watchlist=1`, `?cat=Lending`, `?p=<slug>` opens a protocol's detail), and
every protocol has a detail view showing its stats, the four factors behind
its implied value with the arithmetic spelled out, and its numbered farm plan.
The header states the model in plain language and the derived category
multiples are one click away, because a radar whose numbers you cannot audit
is just a list.

## Layout

```
main.ts               entry point: IO, gate self-check, dossier
lib/model.ts          the value model, farm-plan generator, data payload
vendor/makefun-board.ts  make.fun's dossier library (the scorer's own copy)
dashboard/            index.html, app.css, app.js
screenshots/          1-board.jpg, 2-detail.jpg, 3-filtered.jpg (1440×900)
```

---
name: markov-2-hedge-fund-method
description: Markov 2.0 (corrected) regime model for any ticker. Same core as v1 (states -> transition matrix -> stickiness -> signal -> matrix-power forecasts -> optional HMM) with three documented flaws fixed — FIX 1 stride sampling (non-overlapping windows, shown side-by-side vs the legacy overlapping matrix), FIX 2 programmatic label verification, FIX 3 two explicit modes (FILTER gates an existing strategy, STANDALONE trades the differential). Walk-forward proof reports win rate, profit factor, max drawdown, and an equity-curve image with a before-fix vs after-fix comparison.
---

# markov-2-hedge-fund-method

Install location: `~/.claude/skills/markov-2-hedge-fund-method/`.
Upgraded ("2.0 / corrected") version of the original Markov hedge fund method.

## Invocation

Natural language, e.g.:

- "run markov-2 on SPY"
- "run markov-2 on AAPL standalone mode"
- "run markov-2 on BTC-USD with a 60-day window and enhanced states"

To run:
cd ~/.claude/skills/markov-2-hedge-fund-method uv run python -m markov2.run --ticker SPY --years 10 --window 20 --threshold 0.05 --mode filter [--enhanced] [--no-hmm]


Defaults: `SPY`, 10 years, 20-bar window, +/-5% threshold, FILTER mode.

## The method

1. **States** — 20-day cumulative return >= +5% = BULL, <= -5% = BEAR, else SIDEWAYS.
2. **Transition matrix** — count state->state transitions, normalise rows; the
   diagonal is stickiness.
3. **Signal** — P(bull next) - P(bear next). Sign = direction, magnitude = conviction.
4. **Multi-day forecasts** by matrix powers; convergence to the stationary
   distribution marks the horizon beyond which forecasts carry no signal.
5. **Hidden Markov cross-check (optional)** — fit an HMM with no hand-made labels
   and report agreement with the threshold labels (agreement = green light).

## The three fixes (this is what makes it 2.0)

- **FIX 1 — stride sampling.** Overlapping 20-day windows share 19 bars and fake
  persistence on the diagonal. The skill builds BOTH the overlapping (legacy) and
  the stride-sampled (non-overlapping, stride = window) matrices and prints them
  side by side; only the stride-sampled one is statistically honest.
- **FIX 2 — label verification.** Before any matrix is shown, the state mapping is
  programmatically checked against three known-character segments (famous bull /
  crash / flat periods on real data, or synthetic equivalents). A bull/bear swap
  is caught before it reaches you.
- **FIX 3 — two explicit modes.** FILTER (default): the regime gates an existing
  strategy — long only when the signal clears +threshold, short below, flat in
  chop; your strategy stays yours, Markov decides WHEN it may act. STANDALONE:
  trade the bull-minus-bear differential directly, size scaled to |signal| up to a cap.

## Optional enhanced states

`--enhanced` splits each directional regime by volatility (ATR) + relative volume,
so "bear and violent" != "bear and asleep" (6 states instead of 3).

## Proof, not promises

The demo runs SPY 10y walk-forward (re-estimated every step, never tested on data
the matrix has learned from) and reports win rate, profit factor, max drawdown,
Sharpe, and an equity-curve image with before-fix vs after-fix curves.

> Backtests flatter. The fixed matrix shows uglier, truer numbers — those are the
> only ones worth trading.

## Dependencies

`uv`-managed Python 3.12 venv: `numpy`, `pandas`, `scikit-learn`, `matplotlib`,
`yfinance` (live data; falls back to a clearly-flagged synthetic series if the
network blocks Yahoo), and optional `hmmlearn`.

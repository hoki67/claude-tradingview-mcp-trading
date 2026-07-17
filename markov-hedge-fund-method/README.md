# Markov Hedge Fund Method 2.0 (corrected)

Regime model for any ticker: states → transition matrix → stickiness → signal →
matrix-power forecasts → optional Hidden Markov cross-check. This is the **2.0 /
corrected** version, with three documented flaws of the original method fixed.

## The three fixes

- **FIX 1 — stride sampling.** Overlapping rolling windows share `window-1` bars
  and fake persistence on the diagonal. Both matrices (overlapping/legacy and
  stride-sampled/honest) are computed and shown side by side; only the
  stride-sampled one is statistically honest.
- **FIX 2 — label verification.** The state mapping (BEAR/SIDEWAYS/BULL) is
  programmatically checked against known-character segments before any matrix is
  shown, so a bull/bear swap can't reach the user.
- **FIX 3 — two explicit modes.** FILTER gates an existing strategy (long only
  when the signal clears +threshold, short below, flat in chop); STANDALONE
  trades the bull-minus-bear differential directly, size scaled to |signal|.

## Contents

```
python-skill/      Claude Code skill — honest walk-forward backtest + HMM
  SKILL.md
  pyproject.toml
  markov2/         observable Markov engine (states, transition, verify,
                   modes, backtest, hmm_mode, data, run)
tradingview/
  markov2_strategy.pine      single-timeframe strategy() with all three fixes
  markov2_mtf_strategy.pine  request.security variant — matrix on a higher
                             timeframe, trades on the chart timeframe
```

## Running the Python skill

Needs [uv](https://docs.astral.sh/uv/). From `python-skill/`:

```bash
uv venv --python 3.12 .venv
uv pip install "numpy>=1.26" "pandas>=2.0" "scikit-learn>=1.4" "matplotlib>=3.8" "yfinance>=0.2"
uv pip install "hmmlearn>=0.3"   # optional HMM layer
uv run python -m markov2.run --ticker SPY --years 10 --mode filter
```

Flags: `--ticker`, `--years`, `--window`, `--threshold`, `--mode {filter,standalone}`,
`--enhanced` (vol + relative-volume states), `--no-hmm`.

If the network blocks Yahoo Finance, the loader falls back to a clearly-flagged
synthetic series so the engine still demonstrates end to end; on an unrestricted
host it pulls real data.

## TradingView strategies

Paste either `.pine` file into the Pine Editor → Add to Chart → open the Strategy
Tester. Defaults: 20-bar window, σ=1.1 (adaptive vol-scaled threshold), FILTER
mode, 0.03% commission, no leverage. The MTF variant estimates the matrix on a
higher timeframe (default Daily) via `request.security` (non-repainting on
historical bars via `lookahead_off`) and trades on the chart timeframe.

> Backtests flatter. The fixed matrix shows uglier, truer numbers — those are the
> only ones worth trading.

"""Walk-forward backtest. Never scores on data the matrix has already learned
from — the transition matrix is re-estimated from past-only labels at every step.

Reports win rate, profit factor, max drawdown, Sharpe, and the equity curve, for
both the legacy overlapping matrix (before fix) and the stride-sampled one
(after fix), so the cost of the autocorrelation flaw is visible.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .transition import build_matrix, signal_from_matrix
from .modes import position_for_mode


def _metrics(strat_rets: np.ndarray) -> dict:
    sr = np.asarray(strat_rets, dtype=float)
    nonzero = sr[sr != 0.0]
    wins = nonzero[nonzero > 0]
    losses = nonzero[nonzero < 0]

    win_rate = float(len(wins) / len(nonzero)) if len(nonzero) else float("nan")
    gross_win = float(wins.sum())
    gross_loss = float(-losses.sum())
    profit_factor = float(gross_win / gross_loss) if gross_loss > 0 else float("inf")

    std = sr.std(ddof=1) if len(sr) > 1 else 0.0
    sharpe = float(sr.mean() / std * np.sqrt(252)) if std > 0 else float("nan")

    equity = (1.0 + sr).cumprod()
    running_max = np.maximum.accumulate(equity)
    drawdown = (equity - running_max) / running_max
    max_dd = float(drawdown.min()) if len(drawdown) else float("nan")

    return {
        "win_rate": win_rate,
        "profit_factor": profit_factor,
        "max_drawdown": max_dd,
        "sharpe": sharpe,
        "n_active": int(len(nonzero)),
        "n_steps": int(len(sr)),
        "equity": equity,
    }


def walk_forward(
    close: pd.Series,
    labels: pd.Series,
    stride: int,
    mode: str = "filter",
    min_train: int = 252,
    n_states: int = 3,
    **mode_kw,
) -> dict:
    """Walk forward day-by-day. At each step build the matrix from PAST labels
    only (sampled at `stride`), read the current state, derive the signal, take
    the position for `mode`, and earn the next day's return."""
    daily = close.pct_change().dropna()
    common = labels.index.intersection(daily.index)
    labels = labels.loc[common]
    daily = daily.loc[common]

    if len(labels) < min_train + 30:
        return {"win_rate": float("nan"), "profit_factor": float("nan"),
                "max_drawdown": float("nan"), "sharpe": float("nan"),
                "n_active": 0, "n_steps": 0, "equity": np.array([1.0])}

    strat = []
    for t in range(min_train, len(labels) - 1):
        P_t = build_matrix(labels.iloc[:t], n_states=n_states, stride=stride)
        state = int(labels.iloc[t])
        sig = signal_from_matrix(P_t, state)
        pos = position_for_mode(sig, mode, **mode_kw)
        strat.append(pos * float(daily.iloc[t + 1]))

    return _metrics(np.array(strat, dtype=float))


def compare_fixes(close: pd.Series, labels: pd.Series, window: int,
                  mode: str = "filter", **mode_kw) -> dict:
    """Run walk-forward both ways: stride=1 (overlapping/legacy) and
    stride=window (non-overlapping/honest)."""
    before = walk_forward(close, labels, stride=1, mode=mode, **mode_kw)
    after = walk_forward(close, labels, stride=window, mode=mode, **mode_kw)
    return {"before_fix": before, "after_fix": after}

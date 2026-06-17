"""State labelling — price-only (default) and enhanced (vol + relative volume).

Default rule: 20-day cumulative return >= +5% -> BULL, <= -5% -> BEAR, else
SIDEWAYS. Canonical mapping is monotonic in return (BEAR=0, SIDEWAYS=1, BULL=2)
so the bull/bear-swap display bug from v1 cannot recur silently — FIX 2 verifies
it anyway.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import BEAR, SIDEWAYS, BULL, STATES


def cumulative_return(close: pd.Series, window: int = 20) -> pd.Series:
    """Trailing `window`-bar cumulative return."""
    return close.pct_change(window)


def label_price_states(close: pd.Series, window: int = 20, threshold: float = 0.05) -> pd.Series:
    """Price-only state labels from trailing cumulative return.

    >= +threshold -> BULL, <= -threshold -> BEAR, else SIDEWAYS.
    """
    ret = cumulative_return(close, window)
    labels = pd.Series(SIDEWAYS, index=close.index, dtype=int)
    labels[ret >= threshold] = BULL
    labels[ret <= -threshold] = BEAR
    return labels.dropna()


def _atr(high: pd.Series, low: pd.Series, close: pd.Series, window: int = 14) -> pd.Series:
    prev_close = close.shift(1)
    tr = pd.concat(
        [(high - low), (high - prev_close).abs(), (low - prev_close).abs()], axis=1
    ).max(axis=1)
    return tr.rolling(window).mean()


def label_enhanced_states(
    df: pd.DataFrame,
    window: int = 20,
    threshold: float = 0.05,
    random_state: int = 42,
) -> pd.Series:
    """Enhanced states: keep the BULL/BEAR/SIDEWAYS direction from price, but
    split each directional regime by volatility + relative volume so that
    'bear and violent' != 'bear and asleep'.

    Returns integer labels 0..5:
        0 BEAR-calm    1 BEAR-violent
        2 SIDEWAYS-calm 3 SIDEWAYS-violent
        4 BULL-calm    5 BULL-violent
    The 'violent' split is a per-direction median split on a vol*relvol score,
    which keeps the mapping interpretable (no opaque cluster ids).
    """
    close = df["Close"]
    base = label_price_states(close, window, threshold)

    atr = _atr(df["High"], df["Low"], close, 14)
    atr_pct = (atr / close)
    rel_vol = df["Volume"] / df["Volume"].rolling(window).mean()
    score = (atr_pct.rank(pct=True) + rel_vol.rank(pct=True)) / 2.0
    score = score.reindex(base.index)

    out = pd.Series(index=base.index, dtype=int)
    for direction in (BEAR, SIDEWAYS, BULL):
        mask = base == direction
        if mask.sum() == 0:
            continue
        med = score[mask].median()
        violent = (score[mask] > med).astype(int)
        out[mask] = direction * 2 + violent
    return out.dropna()


ENHANCED_STATES = [
    "BEAR-calm", "BEAR-violent",
    "SIDEWAYS-calm", "SIDEWAYS-violent",
    "BULL-calm", "BULL-violent",
]

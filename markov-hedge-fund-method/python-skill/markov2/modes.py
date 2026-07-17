"""FIX 3 — two explicit position modes.

FILTER (default): the regime GATES an existing strategy. The user's base signal
stays theirs; Markov 2.0 only decides WHEN it is allowed to act — long when the
Markov signal clears +threshold, short when it clears -threshold, flat in chop.

STANDALONE: trade the bull-minus-bear differential DIRECTLY, position size scaled
to |signal| and capped.
"""

from __future__ import annotations

import numpy as np


def filter_position(signal: float, base_signal: float = 1.0, threshold: float = 0.10) -> float:
    """Gate `base_signal` (default = long) by the Markov regime signal.

    Returns the gated position in {-|base|, 0, +|base|}.
    """
    if signal > threshold:
        return abs(base_signal)        # regime says bull -> allow the long
    if signal < -threshold:
        return -abs(base_signal)       # regime says bear -> allow the short
    return 0.0                          # chop -> stand aside


def standalone_position(signal: float, scale: float = 0.5, cap: float = 1.0) -> float:
    """Size proportional to conviction |signal|, capped at +/-cap."""
    raw = signal / scale
    return float(np.clip(raw, -cap, cap))


def position_for_mode(signal: float, mode: str, **kw) -> float:
    if mode == "standalone":
        return standalone_position(
            signal, scale=kw.get("scale", 0.5), cap=kw.get("cap", 1.0)
        )
    return filter_position(
        signal, base_signal=kw.get("base_signal", 1.0), threshold=kw.get("threshold", 0.10)
    )

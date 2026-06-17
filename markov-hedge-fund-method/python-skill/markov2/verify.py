"""FIX 2 — label verification.

Before any matrix/table/chart is shown, programmatically prove the state mapping
is correct by feeding the labeller three segments of KNOWN character and checking
the labels come back as expected. If real historical data is available we test
three famous regimes (a bull run, a crash, a flat stretch); otherwise we test
three synthetic segments of unambiguous character. Either way, a bull/bear swap
in the mapping is caught here and never reaches the user.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import BEAR, SIDEWAYS, BULL, STATES
from .states import label_price_states

# Famous, unambiguous regimes for real-data verification (start, end, expected).
KNOWN_PERIODS = [
    ("2017-01-01", "2017-12-31", BULL, "2017 low-vol bull grind"),
    ("2020-02-19", "2020-03-23", BEAR, "2020 COVID crash"),
    ("2015-04-01", "2015-07-31", SIDEWAYS, "mid-2015 flat stretch"),
]


def _synthetic_segment(kind: str, n: int = 120) -> pd.Series:
    """Deterministic price segment of known character."""
    rng = np.random.default_rng(0)
    if kind == "bull":
        drift = 0.004
    elif kind == "bear":
        drift = -0.006
    else:
        drift = 0.0
    rets = drift + rng.normal(0, 0.004, n)
    idx = pd.bdate_range("2000-01-01", periods=n)
    return pd.Series(100 * np.cumprod(1 + rets), index=idx)


def verify_mapping(
    close: pd.Series | None = None,
    window: int = 20,
    threshold: float = 0.05,
) -> dict:
    """Return a verification report. `passed` is True only if every checked
    segment's MODE label matches its expected regime.
    """
    checks = []

    real_ok = False
    if close is not None and len(close) > window + 5:
        # Label the FULL series once, then slice each known period out of it.
        # (Labelling a short segment in isolation leaves its first `window` bars
        # as NaN-return -> SIDEWAYS default, which buried the COVID crash under
        # SIDEWAYS and made FIX 2 fail at every threshold.)
        full_labels = label_price_states(close, window, threshold)
        for start, end, expected, name in KNOWN_PERIODS:
            seg = close.loc[(close.index >= start) & (close.index <= end)]
            if len(seg) < window + 5:
                continue
            labels = full_labels.loc[(full_labels.index >= start) & (full_labels.index <= end)]
            if len(labels) == 0:
                continue
            got = int(labels.mode().iloc[0])
            checks.append({
                "segment": name, "expected": STATES[expected],
                "got": STATES[got], "ok": got == expected, "source": "real",
            })
            real_ok = True

    if not real_ok:
        for kind, expected in (("bull", BULL), ("bear", BEAR), ("flat", SIDEWAYS)):
            seg = _synthetic_segment(kind)
            labels = label_price_states(seg, window, threshold)
            got = int(labels.mode().iloc[0]) if len(labels) else -1
            checks.append({
                "segment": f"synthetic {kind}", "expected": STATES[expected],
                "got": STATES[got] if got >= 0 else "NONE",
                "ok": got == expected, "source": "synthetic",
            })

    passed = all(c["ok"] for c in checks) and len(checks) > 0
    return {"passed": passed, "checks": checks}

"""Data loading. Tries yfinance; on network failure (e.g. a sandbox host
allowlist) falls back to a deterministic synthetic OHLCV series so the skill
still demonstrates end-to-end. The fallback is clearly flagged as synthetic.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def _synthetic_ohlcv(ticker: str, years: int) -> pd.DataFrame:
    """Deterministic regime-switching OHLCV, seeded from the ticker name so a
    given ticker always yields the same series."""
    n = int(years * 252)
    seed = abs(hash(ticker)) % (2**32)
    rng = np.random.default_rng(seed)

    # Slowly switching drift to create genuine (non-overlap) regime persistence.
    drift = 0.0003
    rets = np.empty(n)
    for i in range(n):
        if rng.random() < 0.01:  # ~quarterly regime flips
            drift = rng.choice([0.0010, 0.0, -0.0012])
        rets[i] = drift + rng.normal(0, 0.011)

    close = 100 * np.cumprod(1 + rets)
    idx = pd.bdate_range(end=pd.Timestamp.today().normalize(), periods=n)
    close = pd.Series(close, index=idx)
    high = close * (1 + np.abs(rng.normal(0, 0.004, n)))
    low = close * (1 - np.abs(rng.normal(0, 0.004, n)))
    vol = pd.Series(rng.lognormal(16, 0.4, n), index=idx).round()
    return pd.DataFrame({"Open": close.shift(1).fillna(close.iloc[0]),
                         "High": high, "Low": low, "Close": close, "Volume": vol})


def load_ohlcv(ticker: str, years: int = 10) -> tuple[pd.DataFrame, str]:
    """Return (df, source) where source is 'yfinance' or 'synthetic-fallback'."""
    try:
        import yfinance as yf
        end = pd.Timestamp.now(tz="UTC").normalize()
        start = end - pd.DateOffset(years=years)
        df = yf.download(ticker, start=start.strftime("%Y-%m-%d"),
                         end=end.strftime("%Y-%m-%d"), progress=False, auto_adjust=True)
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        if not df.empty and "Close" in df.columns:
            return df, "yfinance"
    except Exception:
        pass
    return _synthetic_ohlcv(ticker, years), "synthetic-fallback"

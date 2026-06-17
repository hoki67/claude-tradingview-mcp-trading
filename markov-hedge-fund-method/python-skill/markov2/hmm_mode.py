"""Optional Hidden Markov mode — no hand-made labels.

Fits a Gaussian HMM on returns, then reports how often the HMM's regime ranking
agrees with the threshold labels. High agreement is the green light that the
hand-drawn thresholds aren't fooling you.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import BEAR, SIDEWAYS, BULL


def fit_hmm(returns: pd.Series, n_components: int = 3, random_state: int = 42):
    """Fit a Gaussian HMM on daily returns. Returns (model, hidden_states) or
    (None, None) if hmmlearn is unavailable."""
    try:
        from hmmlearn import hmm
    except ImportError:
        return None, None

    X = returns.dropna().to_numpy().reshape(-1, 1)
    model = hmm.GaussianHMM(
        n_components=n_components, covariance_type="diag",
        n_iter=200, random_state=random_state,
    )
    model.fit(X)
    return model, model.predict(X)


def hmm_vs_threshold_agreement(returns: pd.Series, price_labels: pd.Series) -> dict:
    """Map HMM states to BEAR/SIDEWAYS/BULL by their mean return, align to the
    threshold labels, and report agreement fraction."""
    model, hidden = fit_hmm(returns, n_components=3)
    if model is None:
        return {"available": False}

    means = np.array([model.means_[k][0] for k in range(model.n_components)])
    order = np.argsort(means)              # lowest..highest mean
    state_to_regime = {int(order[0]): BEAR, int(order[1]): SIDEWAYS, int(order[2]): BULL}

    hidden = pd.Series(hidden, index=returns.dropna().index).map(state_to_regime)
    common = hidden.index.intersection(price_labels.index)
    if len(common) == 0:
        return {"available": True, "agreement": float("nan"), "n": 0}
    agree = (hidden.loc[common] == price_labels.loc[common]).mean()
    return {
        "available": True,
        "agreement": float(agree),
        "n": int(len(common)),
        "hmm_means": means[order].tolist(),
    }

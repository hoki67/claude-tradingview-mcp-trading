"""Transition matrices, stickiness, signal, and forecasts.

FIX 1 lives here: build_matrix supports `stride`. With stride=1 you get the
legacy OVERLAPPING matrix (consecutive daily labels share window-1 days, which
fakes persistence on the diagonal). With stride=window you get the honest
STRIDE-SAMPLED matrix built from NON-overlapping windows.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import BEAR, BULL


def build_matrix(labels: pd.Series, n_states: int = 3, stride: int = 1) -> np.ndarray:
    """MLE transition matrix from a label sequence sampled every `stride` bars.

    stride=1     -> overlapping (legacy, statistically dishonest)
    stride=window-> non-overlapping windows (FIX 1, honest)
    """
    arr = labels.to_numpy()[::stride]
    counts = np.zeros((n_states, n_states), dtype=float)
    for a, b in zip(arr[:-1], arr[1:]):
        counts[int(a), int(b)] += 1.0
    row_sums = counts.sum(axis=1, keepdims=True)
    row_sums[row_sums == 0] = 1.0
    return counts / row_sums


def stickiness(P: np.ndarray) -> np.ndarray:
    """The diagonal — probability a regime persists to the next window."""
    return np.diag(P).copy()


def stationary_distribution(P: np.ndarray) -> np.ndarray:
    """Left eigenvector of P for eigenvalue 1, normalised to sum to 1."""
    eigvals, eigvecs = np.linalg.eig(P.T)
    idx = np.argmin(np.abs(eigvals - 1.0))
    vec = np.abs(np.real(eigvecs[:, idx]))
    s = vec.sum()
    return vec / s if s else vec


def n_step(P: np.ndarray, n: int) -> np.ndarray:
    """Chapman-Kolmogorov: P^n."""
    return np.linalg.matrix_power(P, n)


def signal_from_matrix(P: np.ndarray, current_state: int) -> float:
    """P(bull next) - P(bear next) given the current state.

    Sign = direction, magnitude = conviction. Only valid for the 3-state
    price model where columns are [BEAR, SIDEWAYS, BULL].
    """
    return float(P[current_state, BULL] - P[current_state, BEAR])


def steps_to_converge(P: np.ndarray, tol: float = 1e-3, max_steps: int = 200) -> int:
    """How many matrix powers until every row is within `tol` of the stationary
    distribution — i.e. the horizon beyond which a forecast carries no signal.
    """
    pi = stationary_distribution(P)
    Pn = P.copy()
    for k in range(1, max_steps + 1):
        if np.max(np.abs(Pn - pi[None, :])) < tol:
            return k
        Pn = Pn @ P
    return max_steps

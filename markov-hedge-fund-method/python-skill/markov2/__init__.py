"""Markov 2.0 — Hedge Fund Method (corrected).

Observable Markov regime model with three documented fixes over v1:
  FIX 1 — stride sampling (non-overlapping windows) to kill autocorrelation.
  FIX 2 — programmatic label verification against known-character segments.
  FIX 3 — two explicit modes: FILTER (gate a strategy) and STANDALONE.
"""
__version__ = "2.0.0"

# Canonical state ordering: monotonic in return so signal = P[:,BULL]-P[:,BEAR].
BEAR, SIDEWAYS, BULL = 0, 1, 2
STATES = ["BEAR", "SIDEWAYS", "BULL"]

"""Markov 2.0 CLI — fetch -> verify labels -> both matrices -> forecast ->
walk-forward (before vs after fix) -> equity-curve image.

Usage:
    uv run python -m markov2.run --ticker SPY --years 10 \
        --window 20 --threshold 0.05 --mode filter [--enhanced] [--no-hmm]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from . import STATES, BEAR, SIDEWAYS, BULL
from .data import load_ohlcv
from .states import label_price_states, label_enhanced_states, ENHANCED_STATES
from .transition import (
    build_matrix, stickiness, stationary_distribution, n_step,
    signal_from_matrix, steps_to_converge,
)
from .verify import verify_mapping
from .backtest import compare_fixes
from .hmm_mode import hmm_vs_threshold_agreement

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def _print_matrix(title: str, P: np.ndarray, names: list[str]) -> None:
    print(f"\n{title}")
    hdr = "".join(f"{n[:9]:>11s}" for n in names)
    corner = "from\\to"
    print(f"{corner:>16s}{hdr}")
    for i, name in enumerate(names):
        row = "".join(f"{P[i, j]*100:10.2f}%" for j in range(len(names)))
        print(f"{name:>16s}{row}")


def _fmt(x, pct=False):
    if x is None or (isinstance(x, float) and not np.isfinite(x)):
        return "inf" if x == float("inf") else "n/a"
    return f"{x*100:.2f}%" if pct else f"{x:.3f}"


def _equity_image(before, after, ticker, source, mode) -> Path | None:
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception as exc:  # noqa: BLE001
        print(f"  (equity image skipped — matplotlib unavailable: {exc})")
        return None

    fig, ax = plt.subplots(figsize=(10, 5.5))
    ax.plot(before["equity"], label=f"before fix (overlapping)  Sharpe={_fmt(before['sharpe'])}",
            color="#c0392b", lw=1.6, alpha=0.85)
    ax.plot(after["equity"], label=f"after fix (stride-sampled)  Sharpe={_fmt(after['sharpe'])}",
            color="#1f77b4", lw=1.9)
    ax.axhline(1.0, color="#888", lw=0.8, ls="--")
    ax.set_title(f"Markov 2.0 walk-forward equity — {ticker} ({mode} mode, {source})")
    ax.set_xlabel("walk-forward step"); ax.set_ylabel("equity (start = 1.0)")
    ax.legend(loc="upper left"); ax.grid(alpha=0.25)
    fig.tight_layout()
    out = DATA_DIR / f"equity_{ticker.replace('-', '_')}_{mode}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=120); plt.close(fig)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(prog="markov-2-hedge-fund-method")
    ap.add_argument("--ticker", default="SPY")
    ap.add_argument("--years", type=int, default=10)
    ap.add_argument("--window", type=int, default=20)
    ap.add_argument("--threshold", type=float, default=0.05)
    ap.add_argument("--mode", choices=["filter", "standalone"], default="filter")
    ap.add_argument("--enhanced", action="store_true", help="Use enhanced vol+volume states")
    ap.add_argument("--no-hmm", action="store_true")
    args = ap.parse_args()

    print("=" * 68)
    print(f" Markov 2.0 — Hedge Fund Method (corrected)")
    print(f" ticker={args.ticker} years={args.years} window={args.window} "
          f"threshold=+/-{args.threshold*100:.0f}% mode={args.mode}")
    print("=" * 68)

    df, source = load_ohlcv(args.ticker, args.years)
    close = df["Close"].dropna()
    tag = "LIVE Yahoo data" if source == "yfinance" else \
          "SYNTHETIC FALLBACK (live fetch blocked — numbers illustrative only)"
    print(f"\nData: {len(close)} bars | {close.index.min().date()} -> "
          f"{close.index.max().date()} | source: {tag}")

    # ---- FIX 2: verify labels BEFORE showing any matrix ----
    vr = verify_mapping(close if source == "yfinance" else None,
                        args.window, args.threshold)
    print("\n[FIX 2] Label verification (self-check before display):")
    for c in vr["checks"]:
        flag = "OK " if c["ok"] else "FAIL"
        print(f"  [{flag}] {c['segment']:<26s} expected {c['expected']:<9s} got {c['got']}")
    if not vr["passed"]:
        print("  ! Label mapping FAILED verification — aborting before showing bad data.")
        return 2
    print("  -> mapping verified: BEAR/SIDEWAYS/BULL are correctly assigned.")

    # ---- labels ----
    if args.enhanced:
        labels = label_enhanced_states(df, args.window, args.threshold)
        names = ENHANCED_STATES
        n_states = 6
        print(f"\nStates: ENHANCED (6) — direction split by volatility + relative volume.")
    else:
        labels = label_price_states(close, args.window, args.threshold)
        names = STATES
        n_states = 3
        print(f"\nStates: PRICE-ONLY (3).")

    # ---- FIX 1: both matrices side by side ----
    P_over = build_matrix(labels, n_states=n_states, stride=1)
    P_stride = build_matrix(labels, n_states=n_states, stride=args.window)
    _print_matrix(f"[FIX 1] OVERLAPPING matrix (legacy, stride=1) — DISHONEST",
                  P_over, names)
    _print_matrix(f"[FIX 1] STRIDE-SAMPLED matrix (stride={args.window}) — HONEST",
                  P_stride, names)
    print("\n  ! WARNING: overlapping windows share window-1 bars and FAKE the")
    print("    diagonal. Only the stride-sampled matrix is statistically honest.")

    s_over, s_stride = stickiness(P_over), stickiness(P_stride)
    print("\nStickiness (diagonal) — overlapping vs stride-sampled:")
    for i, nm in enumerate(names):
        print(f"  {nm:>16s}: {s_over[i]*100:6.2f}%  ->  {s_stride[i]*100:6.2f}%")

    if n_states == 3:
        pi = stationary_distribution(P_stride)
        print("\nStationary distribution (long-run mix, stride-sampled):")
        for i, nm in enumerate(names):
            print(f"  {nm:>9s}: {pi[i]*100:.2f}%")

        print("\nSignal P(bull)-P(bear) by current state (stride-sampled matrix):")
        for i, nm in enumerate(names):
            print(f"  in {nm:>9s}: {signal_from_matrix(P_stride, i):+.3f}")

        k = steps_to_converge(P_stride)
        print(f"\nMulti-day forecast: rows converge to the stationary distribution "
              f"in ~{k} windows.\n  Beyond that horizon the forecast carries no signal.")

    # ---- FIX 3 + proof: walk-forward before vs after ----
    print(f"\n[FIX 3] Mode = {args.mode.upper()} "
          + ("(regime gates a long-base strategy)" if args.mode == "filter"
             else "(trade the differential, size ~ |signal|)"))
    print("\nWalk-forward proof (re-estimated every step, no lookahead):")
    cmp = compare_fixes(close, labels, args.window, mode=args.mode, n_states=n_states) \
        if n_states == 3 else None

    img = None
    if cmp is not None:
        b, a = cmp["before_fix"], cmp["after_fix"]
        print(f"  {'metric':<16s}{'before fix':>14s}{'after fix':>14s}")
        print(f"  {'win rate':<16s}{_fmt(b['win_rate'], True):>14s}{_fmt(a['win_rate'], True):>14s}")
        print(f"  {'profit factor':<16s}{_fmt(b['profit_factor']):>14s}{_fmt(a['profit_factor']):>14s}")
        print(f"  {'max drawdown':<16s}{_fmt(b['max_drawdown'], True):>14s}{_fmt(a['max_drawdown'], True):>14s}")
        print(f"  {'sharpe':<16s}{_fmt(b['sharpe']):>14s}{_fmt(a['sharpe']):>14s}")
        print(f"  {'active steps':<16s}{b['n_active']:>14d}{a['n_active']:>14d}")
        img = _equity_image(b, a, args.ticker, source, args.mode)
        if img:
            print(f"\nEquity-curve image: {img}")
    else:
        print("  (walk-forward comparison runs on the 3-state price model; "
              "enhanced mode shows matrices only.)")

    # ---- optional HMM cross-check ----
    if not args.no_hmm and n_states == 3:
        print("\nHidden Markov cross-check (no hand-made labels):")
        rep = hmm_vs_threshold_agreement(close.pct_change().dropna(), labels)
        if not rep.get("available"):
            print("  hmmlearn unavailable — skipped (observable model unaffected).")
        elif rep["n"] == 0:
            print("  no overlapping samples to compare.")
        else:
            print(f"  HMM vs threshold-label agreement: {rep['agreement']*100:.1f}% "
                  f"over {rep['n']} bars.")
            print("  (high agreement = green light: the thresholds aren't fooling you.)")

    print("\n" + "-" * 68)
    print(' Backtests flatter. The fixed matrix shows uglier, truer numbers —')
    print(' those are the only ones worth trading.')
    print("-" * 68)
    return 0


if __name__ == "__main__":
    sys.exit(main())

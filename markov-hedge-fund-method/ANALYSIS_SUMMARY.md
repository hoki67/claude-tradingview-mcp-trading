# Markov Hedge Fund Method — Analyse-Zusammenfassung

_Stand: 2026-06-17_

Zusammenfassung der Analysen rund um das „Hedge Fund Markov Method"-Framework
(Roan / @RohOnChain) und seinen Vergleich gegen VStop und Buy & Hold.

## 1. Untersuchte Komponenten

- **Python-Skill v1** (`markov-hedge-fund-method`, installiert 2026-06-05) — Regime-Labels
  (Bull/Bear/Sideways) aus 20-Tage-Rollrendite → Übergangsmatrix → stationäre Verteilung
  → walk-forward-Backtest.
- **Markov 2.0** (v2) — korrigierte Fassung: Python-Skill (`markov-2-hedge-fund-method`)
  **+** zwei TradingView-Strategien (`markov2_strategy.pine`, `markov2_mtf_strategy.pine`).
- **Gegenspieler:** VStop (Trendfolge) und Buy & Hold.

## 2. Die drei „Fixes" von v2

- **FIX 1 — Stride-Sampling.** Überlappende 20-Tage-Fenster teilen 19 Bars und täuschen
  Persistenz vor. Wichtigster Einzelbefund (SPY 10y):

  | Übergang   | overlapping (legacy) | ehrlich (stride) |
  |------------|----------------------|------------------|
  | BULL→BULL  | 90,9 %               | **47,6 %** (≈ 51 % stationär) |
  | BEAR→BEAR  | 87,7 %               | 26,1 %           |
  | SIDE→SIDE  | 72,0 %               | 33,3 %           |

  → Das 20-Tage-Regime ist **kaum „sticky"**; die vermeintliche Vorhersagekraft war
  Autokorrelation aus überlappenden Fenstern.
- **FIX 2 — Label-Verifikation** (prüft 2017 Bull / 2020 Crash / 2015 Flat gegen erwartete Regimes).
- **FIX 3 — zwei Modi:** FILTER (Regime gated eine Strategie) und STANDALONE (handelt das
  Bull-minus-Bear-Differential, Größe ~ |Signal|).

## 3. Beim Testen gefundene & behobene Skill-Bugs

Der v2-Skill war auf echten Daten **unbenutzbar**. Drei Fixes (Commit `e3b0301`, PR #1):

- **`verify.py`** — labelte jedes bekannte Segment isoliert; bei `window=20` blieben die
  ersten 20 Bars NaN→SIDEWAYS, wodurch der COVID-Crash unter SIDEWAYS verschwand. FIX 2
  schlug dadurch bei **jedem** Threshold fehl → Abbruch auf **jedem** echten Ticker.
  Fix: volle Kursreihe labeln, dann Perioden herausschneiden.
- **`run.py`** — fehlendes `data/`-Verzeichnis → PNG-Crash. Fix: `makedirs(exist_ok=True)`.
- **`states.py`** — fester ±5 %-Threshold für SPY-Daily viel zu hoch (2017-Median nur +1,7 %).
  Ergänzt: `label_price_states_adaptive` mit vol-skaliertem Threshold
  `stdev(logret, volW)·√window·σ` (Pine-2.0-Parität) → ein Regelwerk für ruhige Indizes
  und 3×-ETFs ohne Per-Symbol-Tuning.

## 4. Vergleich (7 Symbole, walk-forward, gleiche Engine, ein Regelwerk)

Setup: SPY/QQQ/MSFT/NVDA (unleveraged) + TQQQ/SPXL/SOXL (leveraged), 10y daily,
gemeinsame Engine `pos × next-day-return` (keine Kosten, kein TP/SL → isoliert die
Signalgüte). Adaptiver Markov-Threshold (σ·√win·1,1), VStop(20, 3) fix — kein Per-Symbol-Tuning.
Skript: `python-skill/compare_methods.py` (im installierten Skill).

**Median über alle 7 Symbole:**

| Metrik | B&H | VStop | Markov standalone | Markov FILTER | Markov gated VStop |
|--------|-----|-------|-------------------|---------------|--------------------|
| Sharpe | **0,82** | 0,74 | **0,00** | 0,15 | 0,68 |
| MAR    | **0,51** | 0,50 | −0,02 | −0,00 | 0,31 |

**Leveraged-Median (Hebel-Effekt):** VStop MAR **0,50** > B&H 0,43 (TQQQ sogar 0,80 vs 0,43).

### Befunde
1. **Markov 2.0 standalone ist wertlos** (Median-Sharpe 0,00) — direkte Folge von FIX 1.
2. **Markov als Filter verschlechtert VStop** (0,68 < 0,74 Sharpe; 0,31 < 0,50 MAR).
3. **VStop schlägt B&H nur bei gehebelten Underlyings** (Drawdown-Kontrolle bei 3×);
   unleveraged führt Buy & Hold knapp.

## 5. Pine-v2 ↔ Python-v2 Cross-Check (Logik-Ebene)

Komponentenweise **deckungsgleich**: adaptiver Threshold, rollingReturn, stride-Matrix,
Signal `P(bull)−P(bear)`, FILTER- und STANDALONE-Modi inkl. Defaults identisch.
Unterschiede: (a) State-Index invertiert (Pine 0=Bull / Python 0=Bear — kosmetisch,
beide intern konsistent), (b) Ausführungs-Engine (Pine: diskrete Orders, 0,03 % Kommission,
Resize bei |Δ|>0,10). → Unser kostenloser Test ist der **Bestcase für Markov**; mit
Pine-Kosten/Resize wäre Markov standalone noch schlechter → Fazit ist **konservativ**.

## Kernfazit

**Markov 2.0 bringt — eigenständig wie als Filter — keinen Mehrwert** gegenüber simplem
VStop (gehebelt) bzw. Buy & Hold (unleveraged). Das Edge der Methode beruhte auf einem
Sampling-Artefakt, das FIX 1 sichtbar macht. Reiner träger VStop bleibt das Mittel der Wahl
für gehebelte Trendmärkte; bei ungehebelten Indizes ist Halten schwer zu schlagen.

## Vorbehalte & offene Punkte

- Vergleich ohne Kosten/TP/SL (Signal-Test); VStop(20, 3) un-optimiert; Fenster 2016–26
  ist bullenlastig.
- **Offen:** Stresstest über langes Fenster (ab 2000, inkl. 2000/2008-Bärenmärkte) und eine
  Engine mit Kosten + TP/SL — würde VStop seinen Drawdown-Vorteil ausspielen lassen und
  Markov fair in Krisen testen.
- **Offen:** numerischer Per-Bar-Signal-Match Pine ↔ Python via TradingView (Logik-Match
  gilt als ausreichend).

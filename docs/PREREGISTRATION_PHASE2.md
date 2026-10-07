# Aethelgard Phase 2 pre-registration (written 2026-10-07, before any Phase 2 data was obtained or analysed)

Status: FROZEN when committed. Nothing below may be changed after data arrives. Gates D, H and F, the cost views A, B, B-stress (spread x1.5) and C, and the harness conventions are exactly those in PREREGISTRATION_PHASE1B.md (sections 5 to 8, Amendment A). This file only adds what is new.

## 1. Why Phase 2 exists, and its hard limits
Phase 1 and 1b ended in category D. Phase 2 tests only the two leads that survived with the least evidence against them, on better data, once each. Trial count: 405 + 2 = 407, so the Bonferroni bar stays z(1 - 0.05/407) = 3.67 (one-sided, daily-aggregated net t).
Stop rule: if neither hypothesis passes, strategy search stops. No third hypothesis is registered. No new strategy search starts until at least 12 months of new data exist. Any new idea after that gets its own pre-registration.
Diagnostics on the 982 live trades (Appendix A of the report) are descriptive and are not trials.

## 2. Data requirements (must be stated before testing; if not met, the hypothesis is NOT run)
H-A needs bid and ask quotes (or M1 bid bars with ask spread) for US500, US100 and US30 cash-index CFDs from at least 2018-01-01 to 2024-12-31 (development) and from 2025-01-01 onward (sealed holdout). Source and feed name are recorded before any test. Because a different feed from XM will have different prices and spreads, results are reported on (a) the feed's own bid/ask and (b) XM's recorded spread applied to the same bars. Session times use America/New_York for the 09:30 cash open, with daylight-saving transitions handled by timezone rules.
If fewer than 5 years of development data are obtained, H-A is declared UNTESTABLE, not tested on the short sample.

## 3. H-A: US cash-index opening-range breakout (frozen copy of Phase 1b H01)
Rationale: price discovery at the cash open concentrates order flow, and an early directional break of the first range may persist for hours. In Phase 1b the pooled 6-index version was +0.084R gross, +0.031R net (B), 866 trades, t = 0.69, and was not confirmatory.
Rules (unchanged from H01 range=15 tp=2.0): opening range = first 15 minutes after 09:30 New York; entry at the next bar open after the first M15 close beyond the range within 120 minutes; stop at the opposite side of the range, trade skipped if the stop distance is outside 0.5 to 3 x ATR(14, M15); target 2R; time stop 26 bars; one trade per instrument per day; spread filter 8% of the stop.
Universe: US500, US100, US30 pooled, chosen in advance as the US cash-open group. No instrument is dropped or re-selected after seeing results (in Phase 1b US500 was the best of six, which is selection, not a finding).
Registered neighbours for Gate D item 7 are the already-registered range=30 and tp=1.0 variants. No other variants.
Required extras: report long and short separately; compare with a random-direction null (5,000 shuffles) and with buy-and-hold exposure over the same hours; report gross, spread, swap, net, net at x1.5, view C.
Power note: per-trade SD is about 1.3R. With roughly 5,000 trades, the standard error of mean R is about 0.018R, so t = 3.67 needs about +0.066R net before allowing for correlation between indices, and Gate D item 2 needs +0.08R net. A true edge near the Phase 1b +0.03R cannot pass. That is accepted: a result below the bar is reported as not confirmed, not as a near miss.
Outcome rules: Gate D on the development period. Only if passed, the holdout is opened once (Gate H). Otherwise H-A is retired.

## 4. H-B: overnight index drift (frozen from Phase 1 P1-03)
Rationale: equity indices have historically earned most of their return outside regular hours; a long overnight position collects it. Phase 1 gross t = 5.05 (per trade, overlapping, discovery), net -0.007R after XM costs.
Rules: long only, 6 cash indices (US30, US500, US100, GER40, UK100, JP225), buy at 20:00 UTC on H1 bars and hold 17 hours (P1-03). Neighbour: buy 21:00, hold 16 (P1-01). No other variants.
This is long equity exposure, not a market-neutral edge. It is judged against holding the index over the same hours net of identical costs.
Costs: views A, B, B-stress, C, plus view V = the real overnight financing and spread of a named candidate venue, to be recorded from the venue's published figures before testing. If no venue with lower financing than XM exists, H-B is declared NOT TESTABLE.
Because H-B was found in development data, the development period is discovery only. The confirmatory test is the sealed holdout (2025-01-01 onward), opened once, with the parameters above, on view V. Pass condition: Gate H as written in Phase 1b section 7.

## 5. AI role (not a trial)
No AI model chooses direction, stops or size in any hypothesis. If a hypothesis passes, a shadow log may record an AI risk-on/risk-off rating for each signal before its outcome is known. It affects nothing and is evaluated only after at least 100 shadow signals by a rule written beforehand.

## 6. Expected failure modes (recorded now)
Feed differences between providers; daylight-saving mistakes around the US/European clock changes; long-only drift mistaken for a breakout edge; cost views that differ between XM and the new venue; holdout being reused; instruments being dropped after the fact. Any of these found later is reported, not fixed silently.

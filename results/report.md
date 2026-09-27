# Burnscope report

Analyzed at **2026-01-11T00:00:00Z** · alert profile **Google SRE workbook** (`google-sre`) · minimum window coverage 50%

## Summary

| SLO | Objective | Burn rate | Budget used | Remaining | State | Firing |
|---|---|---|---|---|---|---|
| `checkout` | 99.90% | 1.58x | 52.57% | 47.43% | **BURNING** | 2/4 |

## `checkout` — BURNING

Checkout API availability.

| Metric | Value |
|---|---|
| Objective | 99.90% (error budget 0.100%) |
| Error rate | 0.158% |
| Burn rate | 1.58x (sustainable is 1x) |
| Window | 2026-01-01 → 2026-01-31 (10d of 30d, 33.33% elapsed) |
| Budget used | 52.57% |
| Budget remaining | 47.43% |
| Projected remaining at window end | 0.00% |
| Projected exhaustion | 2026-01-20T00:32:20.290Z (9d 32m from now) |
| Series matched | 1 good, 1 bad |
| Intervals measured | 240 |

### Observations

- Error rate 0.158% against a 99.90% objective (budget 0.1%).
- Burn rate over the SLO window is 1.58x (faster than sustainable).
- 52.57% of the budget consumed after 33.33% of the window has elapsed; 47.43% remaining.
- Projected exhaustion in 9d 32m at the current rate.
- 2 of 4 rules firing (1 page and 1 ticket): fast-burn-page, long-burn-ticket

### Multi-window multi-burn-rate alerts

| Rule | Severity | Long | Short | Threshold | Long burn | Short burn | Status |
|---|---|---|---|---|---|---|---|
| `fast-burn-page` | page | 1h | 5m | 14.4x | 20x | 20x | **FIRING**
| `medium-burn-page` | page | 6h | 30m | 6x | 4.58x | 20x | clear
| `slow-burn-ticket` | ticket | 1d | 2h | 3x | 2.27x | 10.75x | clear
| `long-burn-ticket` | ticket | 3d | 6h | 1x | 1.76x | 4.58x | **FIRING**

- Page the on-call: at this rate 2% of the budget is gone in one hour.
- Open a ticket: the budget is being consumed faster than it replenishes.

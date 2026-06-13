# Meridian — Personal Fork

This is a personal fork of [yunus-0x/meridian](https://github.com/yunus-0x/meridian). For full documentation — setup, config reference, REPL commands, Telegram, HiveMind — see the [upstream README](https://github.com/yunus-0x/meridian/blob/experimental/README.md).

---

## What's different

This fork diverges from the source with the following modifications:

### Sharia-compliant (halal) screening filter

Tokens are pre-filtered against Islamic finance principles before the LLM sees any candidates. The filter checks the Jupiter ChainInsight narrative and the token's linked Twitter/website — not the name or symbol — against patterns for:

- **Adult content** — explicit/NSFW material
- **Gambling (Maysir)** — casinos, gacha, raffles, lottery-backed tokens
- **Excessive speculation (Gharar)** — perpetual futures platforms, leverage products, synthetic positions
- **Interest-bearing lending (Riba)** — lending protocols, flash loans, collateralized debt positions
- **Drugs** — cannabis-culture tokens

Halal rejections appear in the `Rejected:` section of the screening cycle report alongside other filter drops. Narratives are cached permanently to disk (`narrative-cache.json`) to avoid redundant API calls on the same mint.

Controlled by the `halalFilter` config flag (default `true`). Set to `false` in `user-config.json` to disable.

### Unified screening pipeline

`getTopCanditatesWithAllSources` replaces the single-source `getTopCandidates`. It queries all three Meteora categories (`new`, `top`, `trending`) with pagination, runs the GMGN discovery pass in parallel, deduplicates by pool address, scores and truncates to the top N, then enriches each surviving candidate with fresh DLMM metrics and token info in a single pass. A unified filter block then applies all rejection criteria once across both sources. The `get_top_candidates` tool exposed to the LLM routes through the same function.

GMGN fee data (`gmgn_total_fee_sol`) is reused across sources — Meteora candidates whose token also appeared in the GMGN pass inherit the fee from the batch instead of making a redundant API call.

### Percentage-based range sizing

The `minBinsBelow` / `maxBinsBelow` / `defaultBinsBelow` config system is replaced with two percentage fields:

| Field | Default | Meaning |
|---|---|---|
| `defaultDownsidePct` | `60` | Range extends this % below current price |
| `defaultUpsidePct` | `0` | Range extends this % above current price (`0` = single-sided SOL) |

`MIN_SAFE_BINS_BELOW` is now `10` (down from `35`).

### LLM bypass for CLOSE and CLAIM

The management cycle executes `close_position` and `claim_fees` directly via the tool executor — no LLM round-trip. The LLM is only invoked for `INSTRUCTION` actions (custom per-position conditions that require evaluation). This eliminates latency and token cost for the common case.

### Direction-aware out-of-range wait

Two separate thresholds replace the single `outOfRangeWaitMinutes`:

| Field | Default | Applies when |
|---|---|---|
| `outOfRangeWaitMinutesAbove` | `5` | Price moved above range (fast exit) |
| `outOfRangeWaitMinutesBelow` | `60` | Price dropped below range (more patience) |

### Bin array clamping

Instead of hard-failing when a requested deploy range spans uninitialized bin arrays, the range is automatically shrunk to only cover initialized arrays and deployment proceeds. The active bin's own array being uninitialized is still a hard error.

### Position-count-scaled deploy size

`computeDeployAmount` takes the current open position count and adds `pos × 0.1` to `positionSizePct`, so each additional open position slightly increases the deploy size (compounding acceleration up to `maxPositions - 1`).

### Deploy cooldown for PnL peak tracking

Fresh deploys skip peak and trailing-TP checks for the first 60 seconds (`PNL_DEPLOY_COOLDOWN_MS`). This prevents false signals from the unreliable PnL readings that occur immediately after a position is opened.

### Trailing TP peak reset on negative PnL

When a trailing take-profit fires (price drops from peak by `trailingDropPct`) but the current position PnL is negative, the position is **not** closed. Instead the peak is reset to zero and trailing is deactivated — the position must reach the trigger threshold (`trailingTriggerPct`, default 2%) again before trailing TP can fire. This prevents closing a position at a loss just because it briefly touched a small gain before reversing.

### ATH filter now works for Meteora-sourced pools

`athFilterPct` was previously a no-op for Meteora-sourced candidates because `price_vs_ath_pct` was only populated by the GMGN discovery path. The enrichment loop now fetches ATH price from GMGN's `/v1/token/info` endpoint for every Meteora-only candidate (same endpoint already called for fee data — no extra API key required). The computed `price_vs_ath_pct` is stored on the pool object and evaluated by the unified filter the same way GMGN-sourced pools are.

### Additional exit controls

| Field | Default | Description |
|---|---|---|
| `binUtilSlEnabled` | `true` | Bin-utilization stop-loss |
| `binUtilSlMinPnl` | `0` | SL only fires when PnL < `-N`% (0 = always) |
| `maxLossHoldMinutes` | `60` | Close at a loss after X minutes — catches slow bleeders |

### Additional screening filters

| Field | Default | Description |
|---|---|---|
| `halalFilter` | `true` | Block non-halal tokens based on narrative and social links |
| `athFilterPct` | `null` | Only deploy if price is at least N% below ATH |
| `maxVolatilityToDeploy` | `null` | Block pools above this volatility |
| `minFeeChangePct` | `-50` | Reject pools where fee momentum fell more than N% |
| `minVolumeChangePct` | `null` | Reject declining-volume pools |
| `maxPriceChange1hPct` | `null` | Reject pump tops by 1h price change |

### Chart indicator additions

| Field | Default | Description |
|---|---|---|
| `minDipPct` | `25` | Require at least N% pullback from recent high before entry |
| `dipLookbackCandles` | `36` | Lookback window for dip check |
| `bearCandleFilter` | `true` | Block entry on small bearish candle in moderate-pump range |
| `rsiMomentum` | `55` | Minimum RSI for momentum confirmation |
| `rsiFloor` | `16` | RSI floor (oversold guard) |


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

GMGN fee data (`gmgn_total_fee_sol`) is reused across sources — Meteora candidates whose token also appeared in the GMGN pass inherit the fee from the batch instead of making a redundant API call. Pool-health fields that were previously `null` for GMGN-sourced candidates (`active_pct`, `unique_traders`, `swap_count`, `organic_score`) are now populated from the Meteora discovery API response fetched during enrichment, enabling consistent signal snapshots and filter analysis across both sources.

### Meteora Zap SDK (zap in and zap out)

This fork integrates `@meteora-ag/zap-sdk` for atomic double-sided operations, controlled by `config.api.meteoraZapEnabled`.

**Zap in** — when `meteoraZapEnabled=true` and `activeBinsAbove > 0`, deploy goes through `executeMeteoraZapDeploy` which calls `getZapInDlmmDirectParams` and `buildZapInDlmmTransaction`. The SDK handles the SOL→base token swap and liquidity addition in a single atomic transaction set — no separate pre-swap step needed.

**Zap out** — when `meteoraZapEnabled=true` and a position closes, `executeMeteoraAtomicZapOutClose` is attempted before the standard close path. It removes liquidity and swaps the base token back to SOL in one atomic transaction via `zap.zapOut()`. Falls back to standard close + Jupiter auto-swap if the atomic close fails.

**LP Agent relay for close** — at the fork point (`771928a`), close used `shouldUseLpAgentRelay()` (configurable via `lpAgentRelayEnabled`). This fork adds `shouldUseLpAgentRelayForClose()` which always returns false, disabling the relay close path regardless of config. The relay wraps its close transaction with a SOL transfer that `assertNoInitializeBinArrayInstructions` mistakes for a bin-array init instruction, causing otherwise-valid closes to be rejected.

### Pre-deploy SOL→base token swap

When `meteoraZapEnabled=false` and `upside_pct > 0`, the bot manually swaps SOL to the base token before deploying to cover the upper bins:

```
percentX         = activeBinsAbove / totalBins
solForX          = finalAmountY × percentX × 1.10   # 10% excess for slippage headroom
effectiveAmountY = finalAmountY - solForX             # SOL reserved for lower bins
```

The Meteora SDK receives `xReceived × 10/11` as `maxDepositXAmount` — its on-chain ceiling equals exactly what the wallet holds. The ~9% surplus stays in the wallet and is auto-swapped back to SOL after close. `upside_pct = 0` short-circuits to `activeBinsAbove = 0` before bin-ID math to prevent rounding from requesting a spurious 1-bin-above range and triggering an unintended swap.

### Position memory

`position-memory.js` maintains `position-memory.json` — a per-position enriched history separate from `lessons.json` and `pool-memory.json`. Every position is tracked from open to close with three layers of data:

- **Entry snapshot** (`recordPositionEntry`) — captured at deploy: bin range, bin step, strategy, volatility, fee/TVL ratio, mcap, and a full `signal_snapshot` containing the entry-time chart indicators (RSI, supertrend, Bollinger Bands at 5m and 15m)
- **Live snapshots** (`appendSnapshot`) — appended each management cycle: PnL, in-range state, active bin, unclaimed fees, OOR minutes, position age
- **Exit snapshot** (`recordPositionExit`) — captured at close: final PnL in USD and SOL, total fees earned, total minutes in range, and a second `signal_snapshot` with exit-time indicators (same fields prefixed `exit_`)

At close, two additional computed fields are added:

- **Bin utilization** — `bins_crossed / bins_deployed` across all active bin observations during the position's lifetime, with direction (`above` / `below` / `none`)
- **Exit reason** — normalized from the freeform close string to a structured type: `STOP_LOSS`, `TRAILING_TP`, `TAKE_PROFIT`, `OUT_OF_RANGE`, `LOW_YIELD`, `MAX_LOSS_HOLD`, `MANUAL`

The indicator snapshots (`fetchIndicatorSnapshot`) fetch RSI, supertrend direction/value, and Bollinger Bands (upper/mid/lower) at both 5m and 15m. Entry indicators are always fetched using the on-chain `baseMint` resolved inside `deployPosition()`, so they are accurate even when the LLM passes a wrong mint. All 24 indicator fields are included in `PERFORMANCE_SIGNAL_FIELDS` so they also propagate to `lessons.json`.

### Auto-populate smart wallets from top LPers

`addTopLPersFromCandidates()` in `tools/study.js` runs the top-LPer study across all current screening candidates in parallel and adds any newly discovered LPer wallets to `smart-wallets.json`. Wallets already tracked are skipped via a `seen` set to avoid duplicates.

### Ghost position detection, auto-close, and untracked recovery

**Ghost positions** — when a deploy transaction fails mid-way (position account created but liquidity not added), the resulting zero-value on-chain position is now detected and closed automatically. `tools/pnl.js` sets `deposits_missing=true` when the Meteora PnL API has no deposit history **and** prices are available (distinguishing a ghost from a transient API outage; `pnl_pct_suspicious` fires on either condition). Rule 0 in `getDeterministicCloseRule` fires when `deposits_missing=true` and `total_value_true_usd < $1` and `age_minutes >= 5`. The value and age checks are critical — real deposits can take 5-10+ minutes to index, so a legitimate position briefly shows `deposits_missing=true` while still holding its full liquidity.

**Untracked positions** — when a deploy succeeds on-chain but the executor errors before `trackPosition()`, the position appears as `?/SOL` and is invisible to peak tracking and trailing TP. The management cycle now runs a recovery pass after loading positions: any on-chain position not in `state.json` with `total_value_true_usd > $1` is automatically registered via `trackPosition()` with its creation time backfilled from `meteora.createdAt`. The PnL deploy cooldown check also falls back to `position.age_minutes` when `deployed_at` is absent, so a recovered 90-minute-old position is not treated as brand-new. `trackPosition()` accepts an optional `deployed_at` parameter for callers that backdate registration.

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

Two separate thresholds replace the single `outOfRangeWaitMinutes`. `markOutOfRange` records `out_of_range_direction` (`above`/`below`) in `state.json` to track which side the position exited from:

| Field | Default | Applies when |
|---|---|---|
| `outOfRangeWaitMinutesAbove` | `5` | Price moved above range (fast exit) |
| `outOfRangeWaitMinutesBelow` | `60` | Price dropped below range (more patience) |

### Bin array clamping

Instead of hard-failing when a requested deploy range spans uninitialized bin arrays, the range is automatically shrunk to only cover initialized arrays and deployment proceeds. The active bin's own array being uninitialized is still a hard error.

### Position-count-scaled deploy size

`computeDeployAmount` now accepts a `pos` (current open position count) parameter and uses `positionSizePct + pos × 0.1` as the effective percentage. As more positions are open the wallet balance is smaller (SOL is tied up as LP), so a higher percentage compensates, keeping the absolute deploy amount roughly uniform across all positions up to `maxPositions - 1`.

### Deploy cooldown for PnL peak tracking

Fresh deploys skip peak and trailing-TP checks for the first 60 seconds (`PNL_DEPLOY_COOLDOWN_MS`). This prevents false signals from the unreliable PnL readings that occur immediately after a position is opened.

### Trailing TP peak reset on negative PnL

When a trailing take-profit fires (price drops from peak by `trailingDropPct`) but the current position PnL is negative, the position is **not** closed. Instead the peak is reset to zero and trailing is deactivated — the position must reach the trigger threshold (`trailingTriggerPct`, default 2%) again before trailing TP can fire. This prevents closing a position at a loss just because it briefly touched a small gain before reversing.

### ATH filter now works for Meteora-sourced pools

`athFilterPct` was previously a no-op for Meteora-sourced candidates because `price_vs_ath_pct` was only populated by the GMGN discovery path. The enrichment loop now fetches ATH price from GMGN's `/v1/token/info` endpoint for every Meteora-only candidate (same endpoint already called for fee data — no extra API key required). The computed `price_vs_ath_pct` is stored on the pool object and evaluated by the unified filter the same way GMGN-sourced pools are.

### Additional exit controls

| Field | Default | Description |
|---|---|---|
| `maxLossHoldMinutes` | `60` | Close at a loss after X minutes — catches slow bleeders |

### Additional screening filters

| Field | Default | Description |
|---|---|---|
| `maxVolatilityToDeploy` | `null` | Block pools above this volatility |
| `minFeeChangePct` | `-50` | Reject pools where fee momentum fell more than N% |
| `minVolumeChangePct` | `null` | Reject declining-volume pools |
| `maxPriceChange1hPct` | `null` | Reject pump tops by 1h price change |

### Consolidated entry-conditions gate

All price-action and indicator entry checks — candle-body, dip-from-high, bear-candle momentum, negative drift, extreme-entry, `no_falling_knife`, and the Volatility Gatekeeper (below) — are evaluated together by a single `checkEntryConditions(poolAddress, mint)` in `tools/chart-indicators.js`, instead of being scattered across separate filter blocks in `screening.js` and `dlmm.js`. One OHLCV fetch and one indicator-preset fetch cover every candle-based and RSI/supertrend-based sub-check; results are cached per pool for **60 seconds** (`ENTRY_CONDITIONS_TTL_MS`) — short enough that a deploy which follows screening by more than about a minute always re-checks against fresh candles, while same-cycle reuse still avoids refetching. `checkDipFromHigh` logs candle-freshness telemetry (`candle_freshness` log tag) on every run — latest candle timestamp, staleness in minutes, and the worst-body candle's own timestamp — for diagnosing OHLCV feed lag.

It's called from two places with the same effect: once per candidate inside `getTopCandidates()`, and again inside `deployPosition()` right before the transaction is built. The second call is what matters for staged-signal deploys that skip a fresh screening pass entirely — without it, a signal captured minutes earlier could deploy against since-changed price action with no gate at all.

| Field | Default | Description |
|---|---|---|
| `minDipPct` | `0` (disabled) | Require at least N% pullback from recent high before entry |
| `dipLookbackCandles` | `36` | Lookback window (× 5m candles) for dip-high calculation |
| `bigCandleWindow` | `20` | Candle-body check lookback (× 5m candles); `0` disables |
| `bigCandleMaxBodyPct` | `15` | Block entry if any candle body in the window exceeds this % — standalone gate, no dip requirement needed |
| `bearCandleFilter` | `true` | Block entry when the last 5m candle is flat/bearish in a moderate-pump range — stale momentum guard |
| `negativeDriftFilter` | `true` | Reject pools where 1h price change is in `[negativeDriftP1hMin, negativeDriftP1hMax)` — slow bleeders with no momentum |
| `negativeDriftP1hMin` | `-5` | Lower bound of the negative drift window |
| `negativeDriftP1hMax` | `0` | Upper bound of the negative drift window (exclusive) |
| `extremeEntryFilterEnabled` | `false` | Block extreme 1h pump/dump entries when RSI is stretched and 5m supertrend agrees |
| `extremeEntryPumpP1hPct` | `15` | Absolute 1h move threshold for the pump side of the extreme entry filter |
| `extremeEntryDumpP1hPct` | `25` | Absolute 1h move threshold for the dump side of the extreme entry filter |
| `rsiMomentum` | `55` | Minimum RSI for `supertrend_or_momentum` confirmation |
| `rsiFloor` | `16` | RSI floor for `dip_entry` — blocks freefall entries where ST is bullish but RSI is oversold |

Pump and dump sides use separate thresholds because they behave differently: the tighter pump-side bound catches overbought-grind stop-losses, while dip-buys in the dump side's wider 15–25% range are historically net profitable and would be wrongly blocked by a single shared, lower threshold.

**Observe-only blocking toggles** — `bearCandleBlocking`, `negativeDriftBlocking`, and `fallingKnifeBlocking` (all default `true`) are decoupled from the `*Filter`/`*Enabled` flags above. The `*Filter` flags control whether a check runs at all; the blocking toggles control whether a *failing* check actually rejects the candidate, or just gets logged under the `entry_observe` tag and left to pass through. Set a blocking toggle to `false` to gather fresh hit/miss data on a filter before trusting it to reject deploys again.

The `no_falling_knife` exit rule (fires when ST flips bearish or RSI reaches overbought) is implemented via `checkLastCandleMomentum` in `tools/chart-indicators.js`. Its indicator fetch (RSI/supertrend) is shared with the Volatility Gatekeeper below — the fetch runs whenever *either* `config.indicators.enabled` or `volatilityGatekeeperEnabled` is on, but falling-knife and extreme-entry themselves stay explicitly gated on `config.indicators.enabled` so disabling that flag doesn't silently reactivate them as a side effect of the gatekeeper's own fetch.

### Screening block window

`runScreeningCycle()` now skips screening entirely (no candidate fetch, no deploys) during a configured local-hour window, computed from UTC plus a fixed offset — it wraps past midnight when `screenBlockStartHour > screenBlockEndHour`.

| Field | Default | Description |
|---|---|---|
| `screenBlockStartHour` | `23` | Local hour screening blocking begins |
| `screenBlockEndHour` | `2` | Local hour screening blocking ends |
| `screenBlockTimezoneOffsetHours` | `7` | Offset added to UTC hour to compute "local" hour |

The default window (23:00–02:00 local) was chosen from a backtest over Jun 28–30 position data, which showed that window had the worst win rate and the largest stop-losses of any period in the sample.

### Closed-position archive (`state_closed.json`)

Closed positions are now moved out of `state.json` into a separate `state_closed.json` on close (`recordClose`, `recordRebalance`, and `syncOpenPositions`' auto-close path all route through `archiveClosedPosition()` in `state.js`). `state.json` stays small and isn't rewritten in full on every PnL tick as position count grows over the bot's lifetime. Lifetime totals (`closedCount`, `totalFeesClaimedAllTime`) are kept on the live `state.json` so `getStateSummary()` doesn't need to scan the archive. `getTrackedPosition()` checks `state.json` first and falls back to `state_closed.json`, so closed-position lookups (e.g. from the dashboard or PnL history) are unaffected.

### SOL mode PnL computation fix

In SOL mode (`config.management.solMode = true`), `getClosedPnlValue` and `getClosedPnlPct` now compute PnL directly from the on-chain Meteora position flows:

```
pnl_sol = (allTimeWithdrawals.total.sol + allTimeFees.total.sol) - allTimeDeposits.total.sol
pnl_pct = pnl_sol / allTimeDeposits.total.sol × 100
```

The previous path used `pnlSol` from the Meteora API, which derives SOL value from USD amounts divided by spot price at query time. This produces wildly wrong results when the base token has crashed in USD terms (the API reports a large USD loss and converts it to SOL at the current low price, giving a SOL PnL far more negative than the real on-chain balance change). Falls back to the API-reported value only when on-chain deposit data is unavailable.

### PnL poller deduplication

The PnL poller has always triggered `runManagementCycle()` when an exit condition fires. What changed: the deduplication mechanism switched from a single global timestamp (`_pollTriggeredAt`, cooled for one `managementIntervalMin`) to a per-position `Set` (`_pollTriggeredPositions`). The set entry is cleared in a `.finally()` callback when the management run completes, so different positions can trigger independent cycles without one blocking another.

The poller also skips positions within `PNL_DEPLOY_COOLDOWN_MS` (60 seconds of `deployed_at`) — matching the main management cycle — to avoid false exits from unreliable immediately-post-deploy PnL reads.

### Low-yield exit refinements

**Rule 5 (low yield) in `getDeterministicCloseRule`** now only fires when `totalPositions >= maxPositions`. Below capacity, low-yield positions are kept — the yield floor is an at-capacity tiebreaker, not a universal eviction rule.

**Low-yield check in `updatePnlAndCheckExits`** (state.js, called by the PnL poller) now requires `pnl_pct > 0`. A position already at a loss won't be closed solely because fee yield is below the floor.

**Low-yield pool cooldown removed** — upstream applied a 4-hour pool cooldown in `pool-memory.js` whenever a position closed with reason `"low yield"`. This fork removes that cooldown; normal OOR-based cooldowns still apply.

### Pool memory no longer gates deployment

The screener prompt no longer treats pool memory as a blocking signal. The upstream rule "Past losses or problems → strong skip signal" has been replaced: pool memory history (win rate, prior losses, deploy count) is context only — it does not override a candidate that passed all system filters. If only one candidate survives screening, it is evaluated on its own merits and deployed if it passes; the old rule that said to skip lone candidates by default is removed.

### DLMM position simulator

`tools/simulator.js` estimates position performance without RPC or SDK calls — pure math against the Meteora REST API.

- **`simulatePosition`** — computes IL, fee income, and net PnL for a hypothetical position given a price path and hold time. Uses current pool price and pool config.
- **`replayPosition`** — walks historical OHLCV candles fetched from the Meteora pool API, simulating in-range time, fee accumulation, and IL to reconstruct how a position would have performed over a past window.

Both functions use strategy-weighted bin distributions matching the SDK (bid_ask vs spot) to estimate how liquidity is distributed across bins at each price point.

### PVP filter made configurable

The screener prompt's PVP block previously always warned against pools where another mint shares the exact same symbol with meaningful TVL and trading activity. This behavior is now gated on `config.screening.avoidPvpSymbols`. When `avoidPvpSymbols` is false, PVP rivals are allowed — the screener is instructed to pick the stronger variant by volume, smart wallets, and fee metrics rather than skipping both.

### Reliability fixes

- **Telegram fetch timeout** — `postTelegram`/`postTelegramRaw` in `telegram.js` had no timeout on their `fetch()` calls (unlike the `getUpdates` polling loop, which already used `AbortSignal.timeout`). A hung connection on `sendMessage`/`editMessageText` during a management cycle could leave `_managementBusy` stuck `true` indefinitely, silently skipping every management cron tick until the OS eventually killed the socket. Both now abort after 15s and fail into the existing `catch`, so a hung Telegram call degrades to a logged error instead of stalling the bot.
- **Settings-menu keyboard bug** — the Telegram inline settings menu's "Risk" page passed `toggleButton("trailingTakeProfit", ...)` directly into the keyboard rows array instead of wrapping it in `[]`, producing a `reply_markup.inline_keyboard` that wasn't an array-of-arrays and made Telegram reject the edit with a 400. Fixed in `index.js`'s `renderSettingsMenu()`.

### Volatility Gatekeeper

`tools/volatility-gatekeeper.js` classifies each candidate's market regime (based on [this article](https://x.com/Stakepanda/status/2073484002183258532)) into `compression`, `expansion`, or `exhaustion`, using price-action signals computed directly off OHLCV — real prior-range breakout, volume-spike authenticity, reversal/rejection wicks, range rotation vs. a midpoint, VWAP deviation, and round-number proximity — combined with the existing RSI/supertrend/1h-change fields from `checkEntryConditions()`.

It's wired into `checkEntryConditions()` in `tools/chart-indicators.js` as an allow-list gate: only `compression` and `exhaustion` classified as `sharp_flush` + `dump` are allowed to deploy; everything else (including `expansion`, despite its high raw win rate — a few large losses hid behind it) is blocked. This reuses the same OHLCV fetch and RSI/supertrend fetch already done for the other entry checks, so it adds no extra API calls. Reasoning and regime are attached under `checks.volatilityGatekeeper` in the entry-conditions result.

Config flags: `volatilityGatekeeperEnabled` (default `true`) and `volatilityGatekeeperBlocking` (default `true`, set `false` to log matches under `entry_observe` without rejecting).

The module can also classify pump-side exhaustion and suggest a distribute-side range, but that path is marked `actionable: false` — this bot only supports single-sided SOL deploys below the active price (see "Deploy Range Model" in `CLAUDE.md`), so selling into strength above price isn't implementable yet.

### On-chain swap-quote valuation for held base-token balance

`tools/pnl.js` now values a position's token-X (base token) holdings — both the LP balance and unclaimed fees — using the DLMM pool's own on-chain swap quote (`pool.swapQuote()`, via a short-lived cached `DLMM.create()` instance per pool) instead of Jupiter's aggregated reference price. This is the same mechanism the atomic zap-out close actually swaps through, so the live "sell now" value matches what a real close would realize, including this specific pool's liquidity depth, rather than diverging from a generic reference price. Falls back to the Jupiter-price calculation if the on-chain quote call fails. Cost basis is unaffected — deposits stay Meteora-ledger-sourced since a deploy is a plain SOL transfer with no valuation ambiguity.

### Dashboard rewritten as a React/Vite app

`dashboard/frontend/` is a new TypeScript React 19 + Vite 8 + Tailwind 4 app that replaces the hand-written `dashboard/public/app.js`/`style.css`. It builds to `dashboard/public/assets/` (see `vite.config.ts`'s `outDir`), which `dashboard/server.js` continues to serve statically — the Express/WebSocket API is unchanged. Components mirror the old tabs: `SummaryCards`, `OpenPositionsTable`, `ClosedPositionsTable`, `PnlCalendar`, `SnapshotPanel`, `BinRangeBar`, `Header`, `Tabs`. Run `npm run dev` inside `dashboard/frontend/` for a hot-reloading dev server (proxies `/api` and `/ws` to `localhost:3001`), or `npm run build` to regenerate the static bundle consumed by `dashboard/server.js`.

`dashboard/server.js` watches `state.json`, `state_closed.json`, and `position-memory.json` with `chokidar` and re-broadcasts current positions and history to connected WebSocket clients (debounced 500ms) whenever any of them change, plus a 30s heartbeat to keep clients' "last synced" display fresh even when nothing changed.


# Meridian

**Autonomous Meteora DLMM liquidity management agent for Solana, powered by LLMs.**

**Links:** [Website](https://agentmeridian.xyz) | [Telegram](https://t.me/agentmeridian) | [X](https://x.com/meridian_agent)

---

## What's different

This is my own fork. It diverges from the source with the following modifications:

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


---

## What it does

- **Screens pools** — continuously scans Meteora DLMM pools against configurable thresholds (fee/TVL ratio, organic score, holder count, market cap, bin step, etc.) to surface high-quality opportunities
- **Manages positions** — opens, monitors, and closes LP positions autonomously; decides to STAY, CLOSE, or REDEPLOY based on live PnL, yield, and range data
- **Claims fees** — tracks unclaimed fees per position and claims when thresholds are met
- **Learns from performance** — studies top LPers in target pools, saves structured lessons, and evolves screening thresholds based on closed position history
- **Monitors any wallet** — look up open DLMM positions and top LPers for any Solana wallet or pool address
- **Telegram chat** — full agent chat via Telegram, plus cycle reports and out-of-range alerts sent automatically

---

## How it works

Meridian runs a **ReAct agent loop** — each cycle the LLM reasons over live data, calls tools, and acts. Two specialized agents run on independent cron schedules:

| Agent | Default interval | Role |
|---|---|---|
| **Hunter Alpha** | Every 30 min | Pool screening — finds and deploys into the best candidate |
| **Healer Alpha** | Every 10 min | Position management — evaluates each open position and acts |

A third **health check** runs hourly to summarize portfolio state.

### Agent harness

Meridian's agent harness is the runtime wrapper around every autonomous cycle. It gives both **main** and **experimental** agents the same control loop: load live state, inject relevant memory, expose only role-appropriate tools, execute tool calls, and return a readable cycle report.

The harness also keeps a structured decision log in `decision-log.json` for deployments, closes, skips, and no-deploy outcomes. Each entry records the actor, pool or position, summary, reason, key risks, metrics, and rejected alternatives. Recent decisions are injected back into the system prompt and are available through `get_recent_decisions`, so the agent can answer "why did you deploy?", "why did you close?", or "why did you skip?" without guessing after the fact.

**Data sources used by the agents:**
- `@meteora-ag/dlmm` SDK — on-chain position data, active bin, deploy/close transactions
- Meteora DLMM PnL API — position yield, fee accrual, PnL
- Wallet RPC — SOL and token balances
- Pool screening API — fee/TVL ratios, volume, organic scores, holder counts

Agents are powered via **OpenRouter** and can be swapped for any compatible model by changing `managementModel` / `screeningModel` in `user-config.json`.

---

## Requirements

- Node.js 18+
- [OpenRouter](https://openrouter.ai) API key
- Solana wallet (base58 private key)
- Telegram bot token (optional, for notifications)

---

## Setup

**1. Clone the repo**

```bash
git clone <repo-url>
cd dlmm-agent
```

**2. Install dependencies**

```bash
npm install
```

**3. Create `.env`**

```env
OPENROUTER_API_KEY=sk-or-...
WALLET_PRIVATE_KEY=your_base58_private_key
HELIUS_API_KEY=your_helius_key         # for wallet balance lookups
TELEGRAM_BOT_TOKEN=123456:ABC...       # optional
LPAGENT_API_KEY=lpagent_...            # optional, for study_top_lpers / get_top_lpers
DRY_RUN=true                           # set false for live trading
```

> **RPC**: defaults to `https://pump.helius-rpc.com` (no key needed). Override with `RPC_URL=` in `.env`.

Optional encrypted `.env` flow:

```bash
cp .env .env.raw
printf "replace-with-a-long-local-key\n" > .envrypt
npm run env:encrypt
```

Meridian loads envrypt-style encrypted values automatically. Keep `.env.raw` and `.envrypt` local; both are gitignored.

**4. Copy the example config**

```bash
cp user-config.example.json user-config.json
```

**5. Run**

```bash
npm run dev    # dry run — no on-chain transactions
npm start      # live mode
```

On startup Meridian fetches your wallet balance, open positions, and the top pool candidates, then begins autonomous cycles immediately.

### Run with PM2

PM2 is supported and is the recommended way to keep Telegram control online on a VPS:

```bash
npm install
npm run pm2:start
pm2 save
```

To update an existing PM2 install:

```bash
git pull
npm install
npm run pm2:restart
```

If the process restarts repeatedly after an update, inspect the app error first:

```bash
npm run pm2:logs
```

Most post-update PM2 crashes are app startup errors, commonly from skipping `npm install` after `package-lock.json` changed, starting PM2 from the wrong directory, or missing `.env` / `user-config.json` values. Avoid `nohup`; it runs outside PM2 and can leave Telegram polling in a duplicate unmanaged process.

---

## Config reference

All fields are optional — defaults shown. Edit `user-config.json`.

| Field | Default | Description |
|---|---|---|
| `walletKey` | — | Base58-encoded private key of the trading wallet |
| `rpcUrl` | — | Solana RPC endpoint URL |
| `dryRun` | `true` | Simulate all transactions without submitting |
| `deployAmountSol` | `0.5` | SOL to deploy per new position |
| `maxPositions` | `3` | Maximum concurrent open positions |
| `minSolToOpen` | `0.55` | Minimum wallet SOL balance before opening a new position |
| `managementIntervalMin` | `10` | How often the management agent runs (minutes) |
| `screeningIntervalMin` | `30` | How often the screening agent runs (minutes) |
| `managementModel` | `openrouter/healer-alpha` | LLM model for position management |
| `screeningModel` | `openrouter/hunter-alpha` | LLM model for pool screening |
| `generalModel` | `openrouter/healer-alpha` | LLM model for REPL chat and `/learn` |
| `minFeeActiveTvlRatio` | `0.05` | Minimum fee/active-TVL ratio (5%) |
| `minTvl` | `10000` | Minimum pool TVL in USD |
| `maxTvl` | `150000` | Maximum pool TVL in USD |
| `minOrganic` | `65` | Minimum organic score (0–100) |
| `minHolders` | `500` | Minimum token holder count |
| `timeframe` | `5m` | Candle timeframe used in screening |
| `category` | `trending` | Pool category filter for screening |
| `takeProfitPct` | `5` | Close position when PnL reaches this % threshold |
| `outOfRangeWaitMinutes` | `30` | Minutes a position can be out of range before alerting / acting |

---

## REPL commands

After startup, an interactive prompt is available. The prompt shows a live countdown to the next management and screening cycle.

```
[manage: 8m 12s | screen: 24m 3s]
>
```

| Command | Description |
|---|---|
| `1`, `2`, `3` ... | Deploy into that numbered pool from the current candidates list |
| `auto` | Let the agent pick the best pool and deploy automatically |
| `/status` | Refresh and display wallet balance and open positions |
| `/candidates` | Re-screen and display the current top pool candidates |
| `/learn` | Study top LPers across all current candidate pools and save lessons |
| `/learn <pool_address>` | Study top LPers from a specific pool address |
| `<wallet_address>` | Ask the agent to check any wallet's positions or a pool's top LPers |
| `/thresholds` | Show current screening thresholds and closed-position performance stats |
| `/evolve` | Trigger threshold evolution from performance data (requires 5+ closed positions) |
| `/stop` | Graceful shutdown |
| `<anything else>` | Free-form chat — ask the agent questions, request actions, analyze pools |

Free-form chat persists session history (last 10 exchanges), so you can have a continuous conversation: `"what do you think of pool #2?"`, `"close all positions"`, `"how much have we earned today?"`.

---

## Telegram

**Setup:**

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token
2. Add `TELEGRAM_BOT_TOKEN=<token>` to your `.env`
3. Set the exact Telegram chat and allowed controller user IDs in `.env`

Meridian no longer auto-registers the first chat for safety. You must set:

```env
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<target chat id>
TELEGRAM_ALLOWED_USER_IDS=<comma-separated Telegram user ids allowed to control the bot>
```

Security notes:
- If `TELEGRAM_CHAT_ID` is not set, inbound Telegram control is ignored.
- If the target chat is a group/supergroup and `TELEGRAM_ALLOWED_USER_IDS` is empty, inbound control is ignored.
- Notifications still go to the configured chat, but command/control is limited to the allowed user IDs.

**Notifications sent:**
- After every management cycle: full agent report (reasoning + decisions)
- After every screening cycle: full agent report (what it found, whether it deployed)
- When a position goes out of range past `outOfRangeWaitMinutes`
- On deploy: pair, amount, position address, tx hash
- On close: pair and PnL

You can also chat with the agent via Telegram using the same free-form interface as the REPL: `"check wallet 7tB8..."`, `"who are the top LPers in pool ABC..."`, `"close all positions"`, etc. Only explicitly allowed Telegram user IDs can issue commands.

### Jupiter swap fee (referral)

Every token swap the agent makes (auto-swap base→SOL after a close/claim, manual `swap_token`) goes through **Jupiter Ultra**. Jupiter's referral program lets a referral wallet collect a small fee, expressed in **basis points (bps)** — `1 bps = 0.01%`, so `50 bps = 0.5%`. Meridian ships with this enabled by default.

**Settings** (env only — *not* in `user-config.json`):

| Env var | Default | Description |
|---|---|---|
| `JUPITER_REFERRAL_ACCOUNT` | built-in account | A **Jupiter referral account** (not just any wallet). Create one on the Jupiter referral dashboard (`referral.jup.ag`) — it generates a referral account and the per-token fee accounts that actually collect the fee. Paste that referral account address here to collect the fee yourself. |
| `JUPITER_REFERRAL_FEE_BPS` | `50` | Fee in basis points. **Jupiter Ultra requires 50–255 bps** — values outside that range (or `0`) are ignored and the swap runs with no referral fee. |

```bash
# .env — collect the referral fee on your own Jupiter referral account
JUPITER_REFERRAL_ACCOUNT=<your-jupiter-referral-account>
JUPITER_REFERRAL_FEE_BPS=50
```

**To turn the referral off**, just remove/blank it — set `JUPITER_REFERRAL_ACCOUNT=` (empty) **or** `JUPITER_REFERRAL_FEE_BPS=0`. Either one drops the referral and the swap proceeds at Jupiter's normal rate. The referral is also silently dropped if the fee is below `50`, above `255`, or the account isn't a valid Solana address (`tools/wallet.js#getJupiterReferralParams`). **`50` is the minimum Jupiter allows and the Meridian default.**

> If you leave the referral enabled on the **built-in default account**, the fee goes toward **Meridian server maintenance** (HiveMind, Agent Meridian API, hosting). Override `JUPITER_REFERRAL_ACCOUNT` with your own Jupiter referral account to collect it yourself instead, or disable it entirely as above. Either way, on new tokens (<24h) it's the same 0.5% Jupiter charges regardless — so leaving the default on costs you nothing extra there.

> **Why 50 bps is effectively free on new tokens.** Jupiter's own platform fee already varies by pair — and for **new tokens (within 24h of token age) Jupiter charges 50 bps (0.5%)** on its UI regardless. So on those tokens the swap costs the same 0.5% **whether or not you attach a referral** — adding the referral just redirects that fee to your wallet instead of leaving it at Jupiter's default. (Jupiter's full platform-fee schedule: `0` bps buying Jupiter tokens / pegged LST-LST & stable-stable, `2` SOL-stable, `5` LST-stable, `10` everything else, `50` new tokens <24h.)

---

## How it learns

Meridian accumulates structured knowledge in `lessons.json` with two components:

### Lessons (`/learn`)

Running `/learn` triggers the agent to call `study_top_lpers` on each top candidate pool. It analyzes the on-chain behavior of the best-performing LPs in those pools — hold duration, entry/exit timing, scalping vs. holding patterns, win rates — and saves 4–8 concrete, actionable lessons. Cross-pool patterns are weighted more heavily since they generalize better.

Saved lessons are injected into subsequent agent cycles as part of the system context, improving decision quality over time.

### Threshold evolution (`/evolve`)

After at least 5 positions have been closed, `/evolve` analyzes the performance record (win rate, average PnL, fee yields) and adjusts the screening thresholds in `user-config.json` accordingly. Changes take effect immediately — no restart needed. The rationale for each change is printed to the console.

Use `/thresholds` to see current values alongside performance stats.

---

## HiveMind

Meridian includes a collective intelligence layer called **HiveMind**. By default it uses Agent Meridian at `https://api.agentmeridian.xyz` with the built-in public key, so agents can register, pull shared lessons/presets, and push learning events without a separate registration flow.

**What you get:**
- Shared lessons from other Meridian agents
- Strategy presets and crowd performance context
- Role-aware lessons injected into future screener/manager prompts when `hiveMindPullMode` is `auto`

**What you share:**
- Lessons from `lessons.json`
- Closed-position performance events: pool, pool name, base mint, strategy, close reason, PnL, fees, and hold time
- Agent heartbeat metadata: agent ID, version, timestamp, and basic capability flags
- **Private keys and wallet balances are never sent**

HiveMind failures are non-blocking. If Agent Meridian is unavailable, the agent logs a warning and keeps running.

### Setup

No manual HiveMind registration command is required for the shared Agent Meridian setup. `agentId` is generated automatically on startup if it is missing.

To use a private HiveMind API key, check the Telegram announcement channel and set it as `hiveMindApiKey`.

Relevant config fields:

```json
{
  "agentId": "",
  "hiveMindUrl": "",
  "hiveMindApiKey": "",
  "hiveMindPullMode": "auto"
}
```

Blank `hiveMindUrl` and `hiveMindApiKey` values intentionally fall back to the Agent Meridian defaults. Set `hiveMindPullMode` to `manual` if you do not want shared lessons and presets pulled automatically.

### Disable

There is currently no empty-string disable path for HiveMind; blank values fall back to the built-in Agent Meridian defaults. A true off switch should be implemented as an explicit config flag before documenting HiveMind as disabled by clearing fields.

---

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous trading agent carries real financial risk — you can lose funds. Always start with `npm run dev` (dry run) to verify behavior before going live. Never deploy more capital than you can afford to lose. This is not financial advice.

The authors are not responsible for any losses incurred through use of this software.

# Meridian - Project Guide

Autonomous Meteora DLMM liquidity-provider agent on Solana. This repo is a personal fork of `yunus-0x/meridian`; see `README.md` for the fork delta.

Use this as the fast-start guide for future coding sessions. For deeper historical analysis, also read `.claude/memory/MEMORY.md` and its linked memory files.

---

## Runtime Shape

```
index.js              Main process: cron cycles, REPL, Telegram polling, dashboard bootstrap
agent.js              OpenAI/OpenRouter-compatible ReAct loop and role-based tool filtering
prompt.js             System prompts for SCREENER, MANAGER, and GENERAL
config.js             Loads .env, user-config.json, gmgn-config.json; exports live config
state.js              state.json position registry: ranges, OOR timestamps, notes, peaks/troughs
position-memory.js    Enriched per-position entry/exit history
pool-memory.js        Per-pool deploy history, notes, cooldowns, rolling snapshots
lessons.js            Closed-position performance records and threshold evolution
decision-log.js       Deploy/close/no-deploy reasoning history
signal-tracker.js     Staged deploy signals captured before position creation
signal-weights.js     Darwinian signal weighting
strategy-library.js   Saved LP strategy presets
telegram.js           Telegram polling, commands, notifications, inline controls
briefing.js           Daily Telegram HTML briefing
hivemind.js           Optional Agent Meridian collective-intelligence sync
logger.js             Daily agent logs and action JSONL audit trail

tools/
  definitions.js      OpenAI-format tool schemas shown to the LLM
  executor.js         Tool dispatch, protected-tool safety checks, config updates, notifications
  screening.js        Unified Meteora + GMGN candidate discovery/enrichment/filtering
  dlmm.js             Meteora DLMM deploy, close, claim, position, PnL logic
  pnl.js              RPC/Meteora/Jupiter PnL computation helpers
  wallet.js           SOL/token balances and Jupiter swaps
  token.js            Jupiter token info, holders, narratives
  gmgn.js             GMGN discovery and enrichment
  chart-indicators.js Indicator fetches and entry/exit confirmation
  halal-filter.js     Narrative/link halal screening
  study.js            Top LPer study via LPAgent API
  simulator.js        Pure-math DLMM position simulator (no RPC/SDK)

dashboard/
  server.js           Express + WebSocket dashboard
  routes/api.js       Dashboard REST API over live positions/history/pool memory
  public/             Static dashboard UI
```

---

## PM2 / Live Ops

The bot is normally run with PM2 from `ecosystem.config.cjs`.

- PM2 may not be on this shell's PATH, but logs are available under `/home/ubuntu/.pm2/logs/`.
- App logs are in `logs/agent-YYYY-MM-DD.log`.
- Tool audit logs are in `logs/actions-YYYY-MM-DD.jsonl`.
- PM2 stdout/stderr logs of interest:
  - `/home/ubuntu/.pm2/logs/meridian-out.log`
  - `/home/ubuntu/.pm2/logs/meridian-error.log`
  - `/home/ubuntu/.pm2/pm2.log`
- Do not read `/home/ubuntu/.pm2/dump.pm2` unless explicitly approved; it may contain process environment secrets.
- `watch: true` is enabled. Editing watched files can restart the live agent. `ignore_watch` currently excludes `node_modules`, `logs`, `*.json`, `.git`, `.claude`, `scripts`, `docs`, and `dashboard`; it does not exclude `CLAUDE.md`.

Recent live snapshot from logs on 2026-06-26:

- One live process was observed: `node /home/ubuntu/meridian/index.js`.
- PM2 restarted repeatedly around 17:05-17:08 Asia/Shanghai due to watched file changes.
- Active position observed: `Chameleon-SOL`, position `3UxYeZqY...`, pool `Gaxi5m3a...`, deployed with `2 SOL`.
- Management cycles were choosing `STAY` and skipping the LLM.
- Screening continued because capacity remained (`1/5 positions` in logs).
- Frequent warnings were `PNL_WARN ... depositsMissing=true`; intermittent external errors included Telegram fetch failures and one Helius 502.

---

## Agent Roles

Role tool access is defined in `agent.js`.

| Role | Purpose | Notes |
|------|---------|-------|
| `SCREENER` | Find and deploy new positions | Uses deploy/search/token-analysis tools. |
| `MANAGER` | Manage open positions | Close/claim/swap/PnL tools; deterministic closes often bypass the LLM. |
| `GENERAL` | Chat/manual commands | Intent-based tool narrowing; falls back to broad read/action set. |

If adding a tool:

1. Add schema in `tools/definitions.js`.
2. Add implementation mapping in `tools/executor.js` `toolMap`.
3. Add to `MANAGER_TOOLS`, `SCREENER_TOOLS`, or `INTENT_TOOLS` in `agent.js`.
4. If it mutates on-chain or sensitive state, add it to `WRITE_TOOLS`/`PROTECTED_TOOLS` in `tools/executor.js`.

Important: `tools/definitions.js` is evaluated at module load and is visible to the LLM independently of `prompt.js`. If model behavior seems to follow stale rules, inspect tool descriptions too.

---

## Config System

`config.js` reads flat JSON from `user-config.json` plus `gmgn-config.json` and applies selected values to `process.env` if env vars are absent.

Runtime config changes go through the `update_config` tool:

- Mutates the live `config` object.
- Persists to `user-config.json` or `gmgn-config.json`.
- Restarts cron jobs when schedule intervals change.
- Redacts sensitive keys in logs (`gmgnApiKey`, `hiveMindApiKey`, `publicApiKey`).

Core config sections:

| Section | Examples |
|---------|----------|
| `risk` | `maxPositions`, `maxDeployAmount`, `allowMultiplePositionsPerToken` |
| `screening` | TVL/mcap/volume/holders/binStep/organic/ATH/fee-change/halal filters |
| `gmgn` | GMGN API key, rank/enrichment filters, KOL/smart-degen thresholds |
| `management` | claim, OOR, SL/TP, trailing TP, max loss hold |
| `strategy` | `strategy`, `defaultDownsidePct`, `defaultUpsidePct` |
| `schedule` | management/screening/health intervals |
| `llm` | per-role models, temperature, max tokens/steps |
| `pnl` | RPC PnL source and poller settings |
| `indicators` | entry/exit indicator presets and RSI/candle filters |

`computeDeployAmount(walletSol, pos = 0)` uses:

```
deployable = max(0, walletSol - gasReserve)
dynamic = deployable * (positionSizePct + min(pos, maxPositions - 1) * 0.1)
result = clamp(dynamic, floor=deployAmountSol, ceil=maxDeployAmount)
```

---

## Screening Pipeline

The primary screener entrypoint is misspelled in code and should be used as-is:

`getTopCanditatesWithAllSources()` in `tools/screening.js`.

High-level flow:

1. Fetch Meteora discovery pages across `new`, `top`, and `trending`.
2. Run GMGN discovery in parallel.
3. Deduplicate by pool address.
4. Score and truncate candidates.
5. Enrich with fresh Meteora DLMM metrics, GMGN token fee/ATH data, OKX/Jupiter token data, holders, indicators, memory, and halal narrative checks where configured.
6. Apply unified rejection filters once across both sources.
7. Return candidates to the LLM through `get_top_candidates`.

Common rejection filters include bin step, TVL, mcap, volume, holders, organic score, top-holder concentration, bot-holder concentration, fee/active-TVL, global token fees, ATH distance, fee momentum, volume momentum, 1h pump-top, launchpad allow/block lists, halal checks, pool/token cooldowns, and indicator checks.

---

## Deploy Range Model

This fork no longer uses volatility-derived `bins_below` as the primary range model.

Current behavior:

- `downside_pct` and `upside_pct` are primary.
- Defaults are `config.strategy.defaultDownsidePct` and `config.strategy.defaultUpsidePct`.
- Default fork behavior is commonly `60%` downside and `0%` upside, which creates single-sided SOL ranges.
- `bins_below`/`bins_above` are accepted for manual/legacy calls but should not be used by the screener.
- `MIN_SAFE_BINS_BELOW` is `10`.
- `upside_pct = 0` explicitly forces `bins_above = 0` to avoid accidental token-X pre-swaps from bin-boundary rounding.
- Range is clamped to initialized bin arrays; the active bin's own array being uninitialized remains a hard error.

Do not reintroduce the old `minBinsBelow`/`maxBinsBelow` volatility formula without intentionally changing the fork's strategy.

---

## Protected Tool Safety

Protected tools in `tools/executor.js`: `deploy_position`, `claim_fees`, `close_position`, `swap_token`, `self_update`.

Deploy safety checks include:

- `bin_step` must be within configured screening range.
- Only single-sided SOL deploys are supported: positive `amount_y`/`amount_sol`, `amount_x = 0`.
- `downside_pct` must be between 0 and 100; `upside_pct` must be >= 0.
- Fresh position scan must be below `maxPositions`.
- Duplicate pool is blocked.
- Duplicate base token is blocked authoritatively in `tools/dlmm.js` using on-chain `tokenXMint`, unless `allowMultiplePositionsPerToken` is true.
- Wallet SOL must cover deploy amount plus `gasReserve`.
- Pool and base mint cooldowns are enforced from memory.
- Indicator pre-check runs inside `deployPosition()` using the real on-chain base mint.

After a successful close, executor auto-swaps remaining base token back to SOL unless `skip_swap` is passed. After deploy, executor also tries to swap any leftover base token value back to SOL.

---

## Management Cycle

`runManagementCycle()` in `index.js`:

1. Fetches live positions.
2. Updates PnL/range state and memory snapshots.
3. Applies deterministic close/claim/stay rules.
4. Executes `close_position` and `claim_fees` directly through `executeTool()` without an LLM round trip.
5. Uses the MANAGER LLM only for custom per-position `INSTRUCTION` actions.
6. Triggers screening when capacity remains.

Deterministic close rules include stop-loss, take-profit, pumped-far-above-range, direction-aware OOR timeout, low-yield-at-max-positions, max-loss-hold, and trailing TP.

Fresh deploys skip some peak/trailing checks during `PNL_DEPLOY_COOLDOWN_MS` (1 minute) because early PnL reads can be unreliable.

---

## State and Data Files

Do not assume JSON files are safe to edit while PM2 is running. They are ignored by PM2 watch, but the live process may write them.

| File | Purpose |
|------|---------|
| `state.json` | Position registry and recent events |
| `position-memory.json` | Enriched per-position entry/exit records |
| `pool-memory.json` | Flat map of pool address to deploys/snapshots/notes/cooldowns |
| `lessons.json` | Lessons plus performance records |
| `decision-log.json` | Recent decision records |
| `token-blacklist.json` | Permanently blocked token mints |
| `dev-blocklist.json` | Blocked deployers/devs |
| `smart-wallets.json` | Tracked wallets |
| `strategy-library.json` | Strategy presets |
| `narrative-cache.json` | Persistent token narrative cache |

For performance analysis, do not use `peak_pnl_pct` as exit PnL. Prefer close records in `logs/agent-YYYY-MM-DD.log`, then `position-memory.json`, then `lessons.json`, then last matching pool-memory snapshot. See `.claude/memory/data-reference.md` for extraction patterns.

---

## Dashboard

The dashboard is a separate Express/WebSocket app in `dashboard/`.

- `dashboard/server.js` serves static UI and `/api` routes.
- Default port is `3001` via `DASHBOARD_PORT`.
- `dashboard/routes/api.js` reads live state/memory files and calls `getMyPositions()` when RPC is available.
- Historical positions prefer `position-memory.json`, then fall back to `lessons.json`.
- Old PM2 stderr logs show prior `EADDRINUSE :::3001` loops, so check port ownership before starting another dashboard process.

---

## Telegram

Telegram polling and notifications live in `telegram.js`, with command handling in `index.js`.

Common commands handled directly:

| Command | Action |
|---------|--------|
| `/positions` | List open positions |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set per-position instruction/note |

Recent logs show intermittent `TELEGRAM_ERROR Poll error: fetch failed`; treat these as external/network symptoms unless persistent.

---

## Models

- Default model comes from `LLM_MODEL` or per-role config.
- Current defaults in code: management/general `openrouter/healer-alpha`, screening `openrouter/hunter-alpha`.
- Logs may show user-config overrides such as `MiniMax-M2.7`.
- OpenAI-compatible local servers are supported with `LLM_BASE_URL` and `LLM_API_KEY`.
- Provider fallback on transient 502/503/529 uses `stepfun/step-3.5-flash:free`.
- Some providers reject `system` role or `tool_choice=required`; `agent.js` has compatibility retries for those cases.

---

## Performance Notes

From `.claude/memory/bot-performance-jun2026.md` and `.claude/memory/big-losses-jun-2026.md`:

- The strategy is fee-driven. Many positions lose on price movement; fees are the profit engine.
- OOR timeout exits were a major loss driver in June analysis.
- Historical sweet spot was short holds, especially 5-60 minutes excluding the OOR timeout cluster.
- $100k-$600k mcap and bin step 100 performed best in the June sample.
- Pump-top entries with very high RSI and bullish short-term supertrend were harmful.
- Bearish-supertrend dip entries were not automatically bad; blocking all bearish entries would remove a historical edge.

Treat these as empirical findings, not hard-coded truth. Re-check against current data before tuning strategy.

---

## Known Issues / Watch Items

- `lessons.js evolveThresholds()` has historically referenced stale keys (`maxVolatility`, `minFeeTvlRatio`). Verify before relying on threshold evolution.
- `get_wallet_positions` is available to GENERAL intents but not MANAGER/SCREENER role sets.
- Some PnL ticks can be marked suspicious when deposits are missing; do not build exit logic from suspicious ticks without checking `tools/pnl.js` behavior.
- `getTopCanditatesWithAllSources` is misspelled; keep imports consistent unless doing a repo-wide rename.
- PM2 watch can restart on documentation or temp-file changes outside `ignore_watch`.

---

## Verification

Main syntax check:

```bash
npm run test:syntax
```

Targeted scripts:

```bash
npm run test:screen
npm run test:agent
```

Dashboard:

```bash
cd dashboard
npm start
```

Use network/RPC/API commands carefully in live mode. Set `DRY_RUN=true` or use CLI `--dry-run` when testing deploy/close flows without on-chain transactions.

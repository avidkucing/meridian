# Meteora DLMM API Reference

**Base URL:** `https://dlmm.datapi.meteora.ag`
**Swagger:** https://dlmm.datapi.meteora.ag/swagger-ui

> Last verified: 2026-04-05

---

## Endpoints

### 1. GET `/positions/{poolAddress}/pnl`
Returns PnL data for positions in a pool.

**Query params:**
- `user` — wallet address (required)
- `status` — `"open"` or `"closed"`
- `pageSize` — e.g. `100`
- `page` — e.g. `1`

**Key response fields (per position in `positions[]`):**

| Field | Type | Description |
|-------|------|-------------|
| `positionAddress` | string | Position account address |
| `pnlUsd` | string | Realized/unrealized PnL in USD |
| `pnlPctChange` | string | PnL percentage change |
| `pnlSol` | number | PnL in SOL |
| `pnlSolPctChange` | number | PnL percentage in SOL |
| `feePerTvl24h` | string | Fee/TVL ratio (24h) |
| `isOutOfRange` | boolean | Position is out of range |
| `isClosed` | boolean | Position is closed |
| `lowerBinId` | number | Lower bin ID |
| `upperBinId` | number | Upper bin ID |
| `poolActiveBinId` | number | Pool's current active bin |
| `poolActivePrice` | string | Pool's current price |
| `minPrice` / `maxPrice` | string | Position price range |
| `createdAt` | number | Unix timestamp |
| `closedAt` | number | Unix timestamp (closed positions) |
| `unrealizedPnl` | object | See UnrealizedPnL below |
| `allTimeDeposits` | object | See AmountTotals below |
| `allTimeWithdrawals` | object | See AmountTotals below |
| `allTimeFees` | object | See AmountTotals below |

**Also returns (top-level):**
- `tokenX` — token X mint address
- `tokenY` — token Y mint address
- `tokenXPrice` / `tokenYPrice` — current prices (as strings)
- `solPrice` — current SOL price in USD
- `rewardTokenX` / `rewardTokenY` — reward token mint addresses
- `rewardTokenXPrice` / `rewardTokenYPrice` — reward token prices
- `totalCount` — total positions
- `page`, `pageSize`, `hasNext` — pagination

---

### 2. ~~GET `/api/pools/{poolAddress}/positions/{owner}`~~ — **DEAD (404)**

This endpoint no longer exists. Use `/portfolio/open?user={owner}` instead (see below).

---

### 3. ~~GET `/api/positions/{owner}`~~ — **DEAD (404)**

This endpoint no longer exists. Use `/portfolio/open?user={owner}` instead (see below).

---

### 4. GET `/pools/{poolAddress}`
Returns pool info (reserve amounts, bin step, current price).

> **Note:** The correct URL has **no `/api/` prefix** — `/api/pools/{pool}` returns 404.

**Key fields:**

| Field | Notes |
|-------|-------|
| `address` | Pool address (not `pool_address`) |
| `reserve_x` / `reserve_y` | Reserve account addresses |
| `current_price` | Current pool price |
| `tvl` | Total value locked |
| `pool_config.bin_step` | Bin step (nested under `pool_config`, not top-level) |
| `pool_config.base_fee_pct` | Base fee percentage |
| `token_x` / `token_y` | Full token objects (address, name, symbol, price, holders, etc.) |
| `token_x_amount` / `token_y_amount` | Raw token amounts in reserves |
| `volume` | Object with `30m`, `1h`, `2h`, `4h`, `12h`, `24h` keys |
| `fees` | Object with same time windows |
| `fee_tvl_ratio` | Object with same time windows |
| `apr` / `apy` | Annualized return estimates |
| `name` | Pool name (e.g. `"SOL-USDC"`) |

> **Missing from docs (no longer present):** `fee_owner`, `status` — these fields do not exist in actual responses.

---

### 5. GET `/portfolio/open?user={owner}` *(undocumented but primary positions endpoint)*
Returns all open positions for a wallet across all pools. **This is what the code uses for `getMyPositions()`.**

**Query params:**
- `user` — wallet address (required)

**Top-level response:**
- `pools[]` — array of pool objects
- `totalCount`, `page`, `pageSize`, `hasNext`
- `total` — aggregate portfolio value
- `solPrice`

**Per-pool object in `pools[]`:**

| Field | Description |
|-------|-------------|
| `poolAddress` | Pool address |
| `tokenXMint` / `tokenYMint` | Token mint addresses |
| `tokenX` / `tokenY` | Token symbols |
| `tokenXIcon` / `tokenYIcon` | Icon URLs |
| `binStep` | Pool bin step |
| `baseFee` | Base fee % |
| `balances` | Current position USD value |
| `balancesSol` | Current position SOL value |
| `unclaimedFees` | Unclaimed fees in USD |
| `unclaimedFeesSol` | Unclaimed fees in SOL |
| `feePerTvl24h` | Fee/TVL ratio (24h) |
| `pnl` | PnL in USD |
| `pnlSol` | PnL in SOL |
| `pnlPctChange` | PnL % (USD) |
| `pnlSolPctChange` | PnL % (SOL) |
| `totalDeposit` / `totalDepositSol` | All-time deposits |
| `openPositionCount` | Number of open positions in this pool |
| `listPositions` | Array of position account addresses |
| `outOfRange` | Boolean — any position OOR |
| `positionsOutOfRange` | Array of OOR position addresses |
| `poolPrice` | Current price |
| `rewardX` / `rewardY` | Reward token info |
| `poolStateUpdatedAtSlot` / `poolStateUpdatedAtBlockTime` | Freshness |

---

### 6. GET `/pools?query={query}` *(search)*
Search pools by name or token symbol/mint.

**Query params:**
- `query` — search string (name, symbol, or mint address)
- `page_size` — results per page (default 10)
- `page` — page number

**Response:** `{ total, pages, current_page, page_size, data[] }` where each item in `data` is the same schema as endpoint 4 (`/pools/{address}`).

---

### 7. GET `/pools/{poolAddress}/ohlcv` *(OHLCV candles)*
Returns price candles for a pool.

**Query params:**
- `timeframe` — allowed: `5m`, `30m`, `1h`, `2h`, `4h`, `12h`, `24h` (default: `24h`)
- `start_time` — unix timestamp in seconds (optional). If omitted, inferred from timeframe.
- `end_time` — unix timestamp in seconds (optional). If omitted, defaults to now.

**Response:**
```json
{
  "start_time": 1234567890,
  "end_time": 1234567890,
  "timeframe": "1h",
  "data": [
    { "timestamp": 1234567890, "timestamp_str": "2026-04-04T16:00:00+00:00",
      "open": 0.001, "high": 0.002, "low": 0.0009, "close": 0.0015, "volume": 4683.07 }
  ]
}
```

---

### 8. GET `/pools/groups?query={query}` *(pool pairs grouped)*
Returns token pairs grouped by mint combination — useful for comparing all pools for a given pair.

**Query params:**
- `query` — pair name (e.g. `"SOL-USDC"`, `"BONK"`) or mint address

**Response:** `{ total, pages, current_page, page_size, data[] }` where each group has:

| Field | Description |
|-------|-------------|
| `group_name` | Pair name (e.g. `"SOL-USDC"`) |
| `lexical_order_mints` | Canonical `mintA-mintB` key |
| `token_x` / `token_y` | Mint addresses |
| `pool_count` | Number of pools in this pair |
| `total_tvl` | Aggregate TVL |
| `total_volume` | Aggregate volume |
| `max_fee_tvl_ratio` | Highest fee/TVL ratio across pools |
| `has_farm` | Farm available |

> Groups do NOT nest the individual pools. To get pools within a pair, use `/pools?query=` and filter by mint.

---

### 9. GET `/stats/protocol_metrics`
Returns protocol-wide aggregate stats.

**Response fields:** `total_tvl`, `volume_24h`, `fee_24h`, `total_volume`, `total_fees`, `total_pools`

---

## Shared Object Schemas

### `AmountTotals`
```json
{
  "tokenX": { "amount": "string", "amountSol": "string", "usd": "string" },
  "tokenY": { "amount": "string", "amountSol": "string", "usd": "string" },
  "total": { "sol": "string", "usd": "string" }
}
```

### `UnrealizedPnL`
All keys verified from live responses:

| Field | Description |
|-------|-------------|
| `balances` | Total position value in USD (number) |
| `balancesSol` | Total position value in SOL (string) |
| `balanceTokenX` | `{ amount, usd, amountSol }` — token X holdings |
| `balanceTokenY` | `{ amount, usd, amountSol }` — token Y holdings |
| `unclaimedFeeTokenX` | `{ amount, usd, amountSol }` — unclaimed fees in token X |
| `unclaimedFeeTokenY` | `{ amount, usd, amountSol }` — unclaimed fees in token Y |
| `unclaimedRewardTokenX` | `{ amount, usd, amountSol }` — unclaimed rewards |
| `unclaimedRewardTokenY` | `{ amount, usd, amountSol }` — unclaimed rewards |

---

## Notes

- **Endpoints 2 & 3** (`/api/pools/{pool}/positions/{owner}` and `/api/positions/{owner}`) **return 404** — they are dead.
- **Endpoint 4** URL is `/pools/{pool}` — the `/api/` prefix does NOT work.
- **Primary positions flow in code:** `GET /portfolio/open?user=` → then `GET /positions/{pool}/pnl` per pool for bin data.
- **For raw token amounts:** `unrealizedPnl.balanceTokenX.amount` / `balanceTokenY.amount` (from endpoint 1).
- **For PnL percentages:** `pnlSol` / `pnlSolPctChange` / `pnlUsd` / `pnlPctChange` (from endpoint 1 or portfolio).
- Endpoint 1 returns price data at top level (`tokenXPrice`, `tokenYPrice`, `solPrice`).
- Single-sided SOL positions have `balanceTokenX.amount = "0"` and `balanceTokenY.amount = initial SOL deposited`.

# Jupiter Price API V3

Reference documentation for the Jupiter Price API, used to fetch real-time USD prices for Solana tokens.

---

## Overview

The Jupiter Price API V3 is the authoritative source for token pricing across Jupiter platforms and integrator ecosystems. It aggregates swap data across all Solana DEXs and applies reliability heuristics to filter manipulated or unreliable prices.

The same data powers jup.ag and major Solana wallet applications.

### Core Problems Addressed

| Problem | Description |
|---|---|
| Price manipulation | Wash trading and circular swaps that artificially inflate valuations |
| Liquidity fragmentation | Prices spread across multiple protocols with varying depth |
| Low-liquidity tokens | Pricing unreliability in shallow trading pools |

### Pricing Methodology

Prices are derived from **last swapped price across all transactions**, anchored to reliable base tokens like SOL. Beyond last-swap pricing, the API applies multiple heuristics:

- Asset origin and launch mechanics
- Liquidity metrics and market behavior patterns
- Holder distribution analytics
- Trading activity signals
- Organic Score evaluation

Tokens that fail reliability checks return `null` / are omitted from responses.

---

## Authentication

An API key from [portal.jup.ag](https://portal.jup.ag) is **optional** but recommended (higher rate limits). Pass it via the `x-api-key` request header.

```
x-api-key: <your-api-key>
```

---

## Endpoint

```
GET https://api.jup.ag/price/v3
```

### Query Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `ids` | string | Yes | Comma-separated token mint addresses. Max **50** per request. |

**Example:**
```
https://api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

---

## Response Schema

Returns a flat JSON object where each key is a token mint address (no `data` wrapper).

```json
{
  "<mint_address>": {
    "usdPrice": 80.00,
    "liquidity": 658180519.12,
    "createdAt": "2024-06-05T08:55:25.527Z",
    "blockId": 411524540,
    "decimals": 9,
    "priceChange24h": -3.04
  }
}
```

### Response Fields

| Field | Type | Nullable | Description |
|---|---|---|---|
| `usdPrice` | number | No | Current price in USD |
| `liquidity` | number | No | Total liquidity in USD across all pools |
| `createdAt` | string (ISO 8601) | No | Token creation/mint date |
| `blockId` | integer | Yes | Solana block ID when price was last computed |
| `decimals` | integer | No | Token decimal precision |
| `priceChange24h` | number | Yes | 24-hour percentage change |

### HTTP Status Codes

| Code | Meaning |
|---|---|
| `200` | Success |
| `400` | Bad request (e.g. missing `ids` parameter) |
| `401` | Invalid API key |
| `429` | Rate limit exceeded |
| `500` | Internal server error |

---

## Key Limitations

- **Max 50 tokens per request** — batch larger sets into multiple calls.
- **No historical data** — only current prices are available.
- **7-day activity requirement** — tokens with no trades in the last 7 days return no price.
- **Reliability filter** — tokens failing heuristic checks are omitted (no price returned). This is intentional to protect against inaccurate data.

---

## Usage Examples

### Single Token — curl

```bash
curl -H "x-api-key: YOUR_API_KEY" \
  "https://api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112"
```

### Batch Query — JavaScript

```js
const SOL_MINT  = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function getTokenPrices(mints) {
  const ids = mints.join(",");
  const res = await fetch(`https://api.jup.ag/price/v3?ids=${ids}`, {
    headers: { "x-api-key": process.env.JUPITER_API_KEY },
  });
  // response is a flat object: { [mint]: { usdPrice, ... } }
  return await res.json();
}

const prices = await getTokenPrices([SOL_MINT, USDC_MINT]);
console.log(prices);
```

### Portfolio Value Calculation — JavaScript

```js
async function getPortfolioValue(holdings) {
  // holdings: [{ mint, amount }]
  const mints = holdings.map(h => h.mint);
  const prices = await getTokenPrices(mints);

  return holdings.reduce((total, { mint, amount }) => {
    const price = prices[mint]?.usdPrice;
    if (price === undefined) {
      console.warn(`No price available for ${mint}`);
      return total;
    }
    return total + price * amount;
  }, 0);
}
```

### Python

```python
import requests

API_KEY = "YOUR_API_KEY"
MINTS   = [
    "So11111111111111111111111111111111111111112",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
]

resp = requests.get(
    "https://api.jup.ag/price/v3",
    params={"ids": ",".join(MINTS)},
    headers={"x-api-key": API_KEY},
)
resp.raise_for_status()
# response is a flat dict: { mint: { usdPrice, ... } }
data = resp.json()

for mint, info in data.items():
    print(f"{mint}: ${info['usdPrice']} ({info['priceChange24h']:+.2f}%)")
```

---

## Error Handling

- **Missing token in response** — token has no trades in 7+ days, failed reliability heuristics, or the mint address is invalid. All cases result in the key being silently omitted. Check `prices[mint] === undefined` and treat as unavailable.
- **`blockId` is null** — price exists but block metadata is unavailable; `usdPrice` is still valid.
- **`priceChange24h` is null** — insufficient history to compute 24h change.

---

## V3 vs V2

| | V2 | V3 |
|---|---|---|
| Price fields | Multiple ambiguous fields | Single `usdPrice` |
| Reliability filtering | Basic | Multi-heuristic (organic score, holder distribution, etc.) |
| Liquidity field | No | Yes |
| Recommended | No (deprecated) | Yes |

---

## Common Token Mints

| Token | Mint Address |
|---|---|
| SOL | `So11111111111111111111111111111111111111112` |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |

---

## References

- [Price API Overview](https://dev.jup.ag/docs/price)
- [How to Get Token Price (Guide)](https://dev.jup.ag/docs/guides/how-to-get-token-price)
- [API Reference](https://dev.jup.ag/docs/api-reference/price)
- [API Key Portal](https://portal.jup.ag)

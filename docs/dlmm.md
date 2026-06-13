# Meteora DLMM — Complete Reference

> Source: [docs.meteora.ag](https://docs.meteora.ag/overview/products/dlmm/what-is-dlmm)  
> Inspired by Trader Joe's Liquidity Book.

---

## Table of Contents

1. [What is DLMM?](#1-what-is-dlmm)
2. [Core Concepts](#2-core-concepts)
3. [Bin Structure & Pricing](#3-bin-structure--pricing)
4. [Liquidity Shapes](#4-liquidity-shapes)
5. [Fee System](#5-fee-system)
6. [Fee Calculation — Deep Dive](#6-fee-calculation--deep-dive)
7. [Key Formulas](#7-key-formulas)
8. [Farming Rewards](#8-farming-rewards)
9. [Strategies & Use Cases](#9-strategies--use-cases)

---

## 1. What is DLMM?

**Dynamic Liquidity Market Maker (DLMM)** organizes liquidity into discrete price **bins**, enabling:

- **Zero-slippage swaps** within a single bin (constant-sum pricing per bin)
- **Dynamic fees** that rise with volatility to protect LPs from impermanent loss
- **Precise capital concentration** — deposit only at the price ranges you want

### Key Benefits

| Benefit | Description |
|---------|-------------|
| High Capital Efficiency | Tokens concentrated at market price reduce price impact and increase volume capture |
| Flexible Strategy | LPs choose liquidity shape based on risk tolerance and market condition |
| Higher Fee Capture | Single-sided liquidity supported; fees scale with market volatility |
| Dynamic Fees | Variable fee component offsets impermanent loss during volatile periods |

---

## 2. Core Concepts

### Concentrated Liquidity
LPs specify price ranges. Only liquidity in the **active bin** earns trading fees — idle out-of-range liquidity earns nothing. This is especially effective for stablecoin pairs (e.g., USDC/USDT) where price stays in a narrow band like $0.99–$1.01.

### Active Bin
There can only be **one active bin at any point in time**. It is the bin containing the current market price and holds both token X and token Y.

- **Bins to the left** of active: hold only token Y (quote token)
- **Bins to the right** of active: hold only token X (base token)
- **Active bin**: holds both; earns fees

When a swap exhausts reserves in the active bin, the price shifts to the adjacent bin (right for buys, left for sells).

### Composition Factor
Each bin has a composition factor `c`, representing the percentage of the bin's liquidity that is token Y:

```
y = c · L
x = (L / P) · (1 - c)
```

Where `L` = bin liquidity, `P` = bin price constant (Δy/Δx).

---

## 3. Bin Structure & Pricing

### Bin Step
The **bin step** is the price increment between two consecutive bins, expressed in basis points (1 bp = 0.01%). Set by the pool creator at deployment.

**Example** — SOL/USDC pool with 25 bp bin step:
```
Bin N:   $20.00
Bin N+1: $20.05  (× 1.0025)
Bin N+2: $20.10  (× 1.0025)
```

### Price Formula
```
price = (1 + bin_step / BASIS_POINT_MAX) ^ active_id

BASIS_POINT_MAX = 10,000
```

The system uses **Q64.64 fixed-point arithmetic** internally.

### Constant-Sum Pricing per Bin
Within a single bin, DLMM uses a constant-sum model (unlike the constant-product `x*y=k` used across bins):

```
P · x + y = L
```

This allows **zero slippage** for swaps that stay within one bin.

---

## 4. Liquidity Shapes

When adding liquidity, LPs choose a distribution shape across bins:

### Spot
Uniform distribution across the selected range. Suitable for any market condition. Best for passive LPs who don't want to rebalance frequently.

### Curve
Bell-curve distribution — concentrates liquidity toward the center of the range. Maximizes fee capture in stable/low-volatility markets but increases impermanent loss risk and requires rebalancing.

### Bid-Ask
Inverse-curve distribution — concentrates at the extremes of the range. Good for volatile assets, DCA strategies, and capturing price swings. Requires active monitoring.

### Spot Subcategories (by bin width)

| Variant | Bin Count | Best For |
|---------|-----------|----------|
| Spot-Concentrated | 1–3 bins | Stablecoin pairs; max capital efficiency, high IL risk |
| Spot-Spread | 20–30 bins | Intraday volatility; requires daily monitoring |
| Spot-Wide | ~50 bins | Passive LPs; lower IL risk, lower capital efficiency |

---

## 5. Fee System

### Total Swap Fee
```
f_s = f_b + f_v
```

| Component | Name | Description |
|-----------|------|-------------|
| `f_b` | Base Fee | Minimum fee per swap; set at pool creation |
| `f_v` | Variable Fee | Dynamic component; scales with real-time volatility |

### Protocol Cut
- **Standard pools**: protocol takes **5%** of the total swap fee
- **Launch pools**: protocol takes **20%** (configurable via `protocol_share`, max 2500 bp)

### Fee Distribution
Fees are distributed **per-bin** across all bins crossed during a swap. LPs must **manually claim** accumulated fees.

---

## 6. Fee Calculation — Deep Dive

### Base Fee Formula
```
f_b = B · s · 10 · 10^(base_fee_power_factor)
```

- `B` = Base Factor (amplifies adjustments)
- `s` = Bin Step (in basis points)
- `base_fee_power_factor` = typically 0

### Variable Fee Formula
```
f_v(k) = A · (v_a(k) · s)^2
```

- `A` = Variable Fee Control Parameter (market-specific scaling)
- `v_a(k)` = Volatility Accumulator at swap step `k`
- `s` = Bin Step

### Volatility Accumulator
Tracks how many bins the active price crosses during a swap:

```
v_a(k) = v_r + |i_r - (activeID + k)|
```

- `v_r` = Volatility Reference
- `i_r` = Reference bin ID

**Decay behavior** (prevents fee manipulation via rapid micro-transactions):

| Condition | Behavior |
|-----------|----------|
| `t < t_f` (high-frequency) | `v_r` maintained at current value |
| `t_f ≤ t < t_d` (spaced) | Decays: `v_r = R · v_a` |
| `t ≥ t_d` (extended inactivity) | Resets to 0 |

### Fee Cap
```
MAX_FEE_RATE = 100,000,000
```
Total fee rate is capped at this value.

### Composition Fee
An additional fee applies when deposits shift the active bin's composition:
```
composition_fee = swap_amount · total_fee_rate / FEE_PRECISION^2
```

---

## 7. Key Formulas

### Technical Constants

| Constant | Value |
|----------|-------|
| `BASIS_POINT_MAX` | 10,000 |
| `MAX_FEE_RATE` | 100,000,000 |
| `OFFSET` | 99,999,999,999 |
| `SCALE` | 100,000,000,000 |

### Price Impact (Slippage Bounds)
Two directional formulas bound the minimum acceptable price per swap using spot price and max slippage in basis points:

- **Buy direction**: min price = `spot_price · (1 - slippage_bps / BASIS_POINT_MAX)`
- **Sell direction**: max price = `spot_price · (1 + slippage_bps / BASIS_POINT_MAX)`

### Liquidity Share
When depositing into a bin:
```
shares = deposit_amount / total_bin_liquidity · total_shares
```

If the bin is empty, the depositor receives shares equal to the raw liquidity deposited.

---

## 8. Farming Rewards

### How It Works
- No LP token staking required — rewards flow automatically
- Only **active bin liquidity** earns rewards (same rule as fees)
- Out-of-range positions earn **nothing**

### Distribution
- Rewards are distributed at a **fixed linear rate** (e.g., 50,000 USDC over 28 days = ~0.020667 USDC/sec)
- When a swap crosses multiple bins, rewards split **equally** across all crossed bins, then proportionally by liquidity share within each bin
- If the active bin has no liquidity, rewards **accumulate** (undistributed) until someone provides liquidity there

### Claiming
- Manual claim required
- Rewards are **not compounded** automatically

### Example
```
Farm: 50,000 USDC over 28 days
Rate: 50,000 / (28 × 86,400) ≈ 0.020667 USDC/sec

10 days with no active liquidity:
Accumulated = 0.020667 × 10 × 86,400 ≈ 17,856 USDC
(waiting to be claimed by whoever provides active liquidity)
```

---

## 9. Strategies & Use Cases

### Choosing a Strategy

| Strategy | Shape | Best Market | Rebalance Frequency | IL Risk |
|----------|-------|-------------|---------------------|---------|
| Spot | Uniform | Any | Low | Low–Medium |
| Curve | Bell curve | Stable / low-vol | Medium | Medium–High |
| Bid-Ask | Inverse curve | Volatile / DCA | High | Variable |

### Bin Step Selection
- **Smaller bin step** → finer price granularity, more volume captured, smaller range
- **Larger bin step** → wider range, less granular, better for volatile assets

Bin step is correlated with base fee — pools with larger bin steps typically charge higher base fees.

### Single-Sided Liquidity
DLMM supports depositing only one token (tokenX-only or tokenY-only), useful when:
- You want exposure to only one side of the pair
- You're range-trading above or below the current price
- You want to replicate a limit-order-like position

### Dollar-Cost Averaging (DCA)
Use **Bid-Ask** shape with a range above or below current price to accumulate a token as price moves through your bins — effectively automating DCA.

---

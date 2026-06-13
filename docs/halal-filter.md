# Halal Filter — Sharia Compliance for Meteora DLMM

Source: *Crypto Yield Farming: Can the mechanics address Sharia principles?*  
Shariyah Review Bureau, September 2021 (preliminary research, not a fatwa).

---

## Structural Verdict: Meteora DLMM is Likely Compliant

The paper distinguishes two yield farming models:

| Model | Income Source | Sharia Status |
|-------|--------------|---------------|
| **Lending platforms** (Compound, Aave, Maker) | Interest on loans | **Haram — Riba** |
| **DEX liquidity mining** (Uniswap, Meteora) | Trading fees from swaps | **Potentially halal** |

Meteora DLMM satisfies the structural conditions for a halal DEX pool:

1. **Returns are not guaranteed** — LP bears impermanent loss risk. ✓  
2. **LP gets a percentage share**, not a fixed token amount — avoids Qard (loan) structure. ✓  
3. **Fee income comes from real trading activity** (swap fees), not from lending with interest. ✓  
4. **LP tokens represent actual pool ownership** (Shirkat al-Milk — joint ownership). ✓  

The paper states: *"transaction fees are permissible to earn for LP providers"* on DEXs, because traders are being provided a platform and the LP is central to that infrastructure.

---

## The One Filter We Must Apply: Token Sharia Compliance

The paper's first and most critical condition:

> **"The tokens must be Sharia compliant."**

The structural compliance of Meteora DLMM does NOT extend to haram token pairs. If the base token itself represents a haram business, providing liquidity to it is not permissible.

---

## Implementation

### Where it runs
`tools/screening.js` → `getTopCanditatesWithAllSources()` — inside the unified filter block, **before the LLM sees any candidates**.

### What signals are checked
- **Jupiter ChainInsight narrative** — plain English description of what the token does (`/v1/chaininsight/narrative/{mint}`)
- **Twitter handle** — from Jupiter assets search API (`t.twitter`)
- **Website URL** — from Jupiter assets search API (`t.website`)

**Name and symbol are intentionally NOT checked** — too many false positives (e.g. a token named "Casino" could be a parody; a token whose narrative explicitly describes casino mechanics is the real problem).

### Config key
```json
{ "halalFilter": true }
```
Default: `true` (enabled). To disable: `update_config` with `{ "halalFilter": false }`.

---

## Blocked Categories and Patterns

All patterns match against the concatenated string: `narrative + " " + twitter + " " + website`.

### Adult content
| Pattern | Catches |
|---------|---------|
| `/hentai/i` | anime adult content |
| `/porn(?:ograph)?/i` | explicit content |
| `/\bnsfw\b/i` | NSFW-labelled projects |
| `/\berotic\b/i` | erotic themes |
| `/adult content/i` | explicit labelling |
| `/onlyfans?/i` | OnlyFans-model tokens |
| `/strip(?:tease\|club)/i` | strip club themes |

### Gambling (Maysir)
Context-anchored to avoid flagging tokens that merely mention gambling as a data source or reference:

| Pattern | Catches | Avoids |
|---------|---------|--------|
| `/\bcasino\b/i` | casino platform tokens | — |
| `/gambl(?:ing\|e)/i` | gambling mechanics | — |
| `/\bgacha\b/i` | gacha draw mechanics | — |
| `/\braffle\b/i` | raffle tokens | — |
| `/fees\b.{0,40}lottery/i` | "fees fund a lottery" | — |
| `/lottery\b.{0,30}draws?/i` | "lottery draws for holders" | games with optional lottery events |
| `/hourly lottery/i` | frequent lottery distributions | — |
| `/holders?.{0,40}lottery draws?/i` | "holders enter lottery draws" | — |

Standalone `/lottery/` was dropped — false positives on game tokens that use lottery as one of many promotional features.

### Riba (interest-based lending)
| Pattern | Catches |
|---------|---------|
| `/lending protocol/i` | explicit lending platforms |
| `/borrow.{0,20}interest/i` | borrow-and-pay-interest mechanics |
| `/interest[- ]bearing/i` | interest-bearing instruments |
| `/flash loan/i` | flash loan protocols |
| `/over[- ]collateral/i` | over-collateralised lending |

### Drugs
| Pattern | Catches |
|---------|---------|
| `/420 cannabis/i` | intentional cannabis culture branding |
| `/cannabis culture/i` | same |
| `/\bmarijuana\b/i` | explicit marijuana references |

---

## Validation

Filter was backtested against 313 historical token narratives. After removing false positives:
- 11 true non-halal tokens confirmed blocked
- No false positives on legitimate meme/game/DeFi tokens

Key false positive fixes:
- `prediction market` — dropped entirely (LOBSTER uses PM as data feed; not its own mechanic)
- standalone `lottery` — replaced with context-anchored patterns (KINS game uses lottery promotionally)

---

## Key Quotes from the Paper

> *"Since the yield in yield farming on lending platforms is created through lending contracts, the yield is Riba."* (p.14)

> *"Since the traders are coming onto a platform and are being provided the space and platform to trade tokens, this permits a fee for the transaction to use the DEX. The transaction fees are permissible to earn for LP providers."* (p.16)

> *"For the liquidity mining to be Sharia compliant: (1) The tokens must be Sharia compliant. (2) The return must not be guaranteed. (3) The Liquidity Provider must get a percentage share of the liquidity pool and not a specific amount."* (p.15)

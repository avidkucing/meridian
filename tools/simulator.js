// tools/simulator.js
// DLMM position simulator — two functions:
//   simulatePosition  – OOR PnL for a hypothetical position (uses current pool price)
//   replayPosition    – walks historical OHLCV candles to simulate IL + fees over time
//
// Pure math — fetches pool metadata from the Meteora REST API only (no RPC, no SDK).

const METEORA_POOLS_API = "https://dlmm.datapi.meteora.ag/pools";

// ── Pool metadata ───────────────────────────────────────────────
async function fetchPoolInfo(poolAddress) {
  const res = await fetch(`${METEORA_POOLS_API}/${poolAddress}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Meteora pool API ${res.status}: ${body.slice(0, 120)}`);
  }
  const data = await res.json();
  const binStep = data?.pool_config?.bin_step;
  const currentPrice = data?.current_price;
  if (!binStep || !currentPrice) {
    throw new Error(`Pool API missing bin_step or current_price for ${poolAddress}`);
  }
  return {
    bin_step: binStep,
    current_price: currentPrice,
    base_fee_pct: data.pool_config?.base_fee_pct ?? 0,
    dynamic_fee_pct: data.dynamic_fee_pct ?? 0,
    tvl: data.tvl ?? 0,
    fees: data.fees ?? {},
    volume: data.volume ?? {},
    name: data.name ?? null,
    token_x_symbol: data.token_x?.symbol ?? "X",
    token_y_symbol: data.token_y?.symbol ?? "Y",
  };
}

// ── OHLCV candles ───────────────────────────────────────────────
async function fetchOhlcv(poolAddress, timeframe, startTime, endTime) {
  const url = `${METEORA_POOLS_API}/${poolAddress}/ohlcv?timeframe=${timeframe}&start_time=${startTime}&end_time=${endTime}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OHLCV API ${res.status}: ${body.slice(0, 120)}`);
  }
  const data = await res.json();
  return data.data ?? [];
}

// ── Strategy weight ─────────────────────────────────────────────
// Mirrors the DLMM SDK helpers used by deployPosition():
//   spot    -> toWeightSpotBalanced
//   curve   -> bid side ascending, ask side descending
//   bid_ask -> bid side descending, ask side ascending
function strategyWeight(relIdx, binsBelow, binsAbove, strategy) {
  if (relIdx <= 0) {
    const offsetFromMin = relIdx + binsBelow; // min bin = 0, active bin = binsBelow
    switch (strategy) {
      case "curve":   return offsetFromMin + 1;
      case "bid_ask": return binsBelow - offsetFromMin + 1;
      case "spot":
      default:        return 1;
    }
  }

  switch (strategy) {
    case "curve":   return binsAbove - relIdx + 1;
    case "bid_ask": return relIdx;
    case "spot":
    default:        return 1;
  }
}

function sideCapitalSplit(binsBelow, binsAbove) {
  if (binsAbove <= 0) return { lower: 1, upper: 0 };

  // deployPosition swaps roughly bins_above / total_bins of the SOL budget into X,
  // with a 10% wallet-side buffer. Normalize the capital that actually reaches LP.
  const percentX = binsAbove / Math.max(binsBelow + binsAbove, 1);
  const lowerBudget = Math.max(0, 1 - percentX * 1.10);
  const upperBudget = percentX;
  const deployed = lowerBudget + upperBudget;
  return deployed > 0
    ? { lower: lowerBudget / deployed, upper: upperBudget / deployed }
    : { lower: 1, upper: 0 };
}

// ── Build normalised bin list ───────────────────────────────────
// Returns bins with .sol (for bid/lower side) or .tokens (for ask/upper side)
// normalized to 1 unit of deployed position value at entry.
function buildBins(binsBelow, binsAbove, binStep, P_active, strategy) {
  const r = 1 + binStep / 10_000;
  const bins = [];

  // The real SDK includes the active bin on the bid/Y side when amountY is present.
  for (let i = binsBelow; i >= 0; i--)
    bins.push({ relIdx: -i, side: "lower", price: P_active * Math.pow(r, -i) });
  for (let i = 1; i <= binsAbove; i++)
    bins.push({ relIdx: +i, side: "upper", price: P_active * Math.pow(r, i) });

  for (const bin of bins) {
    bin.weight = strategyWeight(bin.relIdx, binsBelow, binsAbove, strategy);
  }

  const split = sideCapitalSplit(binsBelow, binsAbove);
  const lowerBins = bins.filter(b => b.side === "lower");
  const upperBins = bins.filter(b => b.side === "upper");
  const lowerWeight = lowerBins.reduce((s, b) => s + b.weight, 0) || lowerBins.length || 1;

  // SDK ask-side token amounts are proportional to weight / bin_price. The sum of
  // token amounts is the X budget, whose entry SOL value is upper / P_active.
  const upperWeightPerPrice = upperBins.reduce((s, b) => s + b.weight / b.price, 0) || 1;

  for (const bin of lowerBins) {
    bin.sol    = split.lower * bin.weight / lowerWeight;
    bin.tokens = 0;
  }
  for (const bin of upperBins) {
    bin.sol    = 0;
    bin.tokens = (split.upper / P_active) * ((bin.weight / bin.price) / upperWeightPerPrice);
  }

  return bins;
}

// ── Position value at an arbitrary price P ──────────────────────
// Constant-sum DLMM mechanics: bin holdings depend only on P vs P_bin.
//
//   Lower bin at P_k:  holds SOL  if P > P_k  (not yet reached from above)
//                      holds X    if P ≤ P_k  (SOL used to buy tokens as price fell through)
//
//   Upper bin at P_k:  holds X    if P < P_k  (not yet reached from below)
//                      holds SOL  if P ≥ P_k  (tokens sold for SOL as price rose through)
//
// Path-independent: works for any exit price without needing to track history.
// (Oscillations within range earn fees but don't change the holding structure at equilibrium.)
function positionValue(bins, P) {
  let value = 0;
  for (const bin of bins) {
    if (bin.side === "lower") {
      if (P > bin.price) value += bin.sol;               // still holds SOL
      else               value += (bin.sol / bin.price) * P; // holds X, worth P now
    } else {
      if (P < bin.price) value += bin.tokens * P;        // still holds X, worth P now
      else               value += bin.tokens * bin.price; // holds SOL received when X sold at P_k
    }
  }
  return value;
}

function round(v, d) { const f = 10 ** d; return Math.round(v * f) / f; }

function resolveEntryPrice({ entry_price, candles, binStep, deploy_active_bin, first_snapshot_active_bin, first_snapshot_ts, candleSec }) {
  if (entry_price != null) {
    const parsed = Number(entry_price);
    if (Number.isFinite(parsed) && parsed > 0) {
      // getPriceOfBinByBinId stores raw token units in position-memory, while the
      // OHLCV API may decimal-adjust by token mint. Preserve the stored entry bin
      // price but auto-correct obvious powers-of-10 scale mismatches.
      const refPrice = candles[0]?.open;
      if (refPrice > 0) {
        const logRatio = Math.log10(parsed / refPrice);
        return Math.abs(logRatio) > 1
          ? parsed * Math.pow(10, -Math.round(logRatio))
          : parsed;
      }
      return parsed;
    }
  }

  if (
    deploy_active_bin != null &&
    first_snapshot_active_bin != null &&
    first_snapshot_ts != null
  ) {
    const snapTs = Math.floor(new Date(first_snapshot_ts).getTime() / 1000);
    const snapCandle = candles.find(c => snapTs >= c.timestamp && snapTs < c.timestamp + candleSec);
    if (snapCandle?.close > 0) {
      const r = 1 + binStep / 10_000;
      return snapCandle.close * Math.pow(r, deploy_active_bin - first_snapshot_active_bin);
    }
  }

  return candles[0].open;
}

function priceAtTimestampInCandle(candle, timestampSec, candleSec) {
  if (!candle || candle.open <= 0 || candle.close <= 0 || timestampSec == null) return candle?.close;
  const fraction = Math.min(1, Math.max(0, (timestampSec - candle.timestamp) / candleSec));
  return candle.open + fraction * (candle.close - candle.open);
}

// ── simulatePosition ────────────────────────────────────────────
//
// Input
//   pool_address    – Meteora DLMM pool address (base58)
//   bins_below_pct  – downside price coverage % (e.g. 60 = covers −60%)
//   bins_above_pct  – upside price coverage %  (default 0 = single-sided SOL)
//   strategy        – 'spot' | 'curve' | 'bid_ask'
//
// Output
//   oor_above.pnl_pct  – % PnL if price immediately pumps past upper bin
//   oor_below.pnl_pct  – % PnL if price immediately dumps past lower bin
//
export async function simulatePosition({
  pool_address,
  bins_below_pct,
  bins_above_pct = 0,
  strategy = "spot",
}) {
  if (bins_below_pct == null) throw new Error("bins_below_pct is required");
  if (bins_below_pct >= 100)  throw new Error("bins_below_pct must be < 100");

  const pool = await fetchPoolInfo(pool_address);
  const { bin_step, current_price: P_active } = pool;
  const r = 1 + bin_step / 10_000;
  const lnR = Math.log(r);

  const binsBelow = bins_below_pct > 0
    ? Math.max(1, Math.round(-Math.log(1 - bins_below_pct / 100) / lnR)) : 0;
  const binsAbove = bins_above_pct > 0
    ? Math.max(1, Math.round(Math.log(1 + bins_above_pct / 100) / lnR))  : 0;

  if (binsBelow + binsAbove === 0) throw new Error("Coverage percentages produce 0 bins");

  const P_min = P_active * Math.pow(r, -binsBelow);
  const P_max = P_active * Math.pow(r,  binsAbove);
  const bins  = buildBins(binsBelow, binsAbove, bin_step, P_active, strategy);

  const oorAboveTotal = positionValue(bins, P_max * 1.0001); // just above range
  const oorBelowTotal = positionValue(bins, P_min * 0.9999); // just below range

  const totalSolLower     = bins.filter(b => b.side === "lower").reduce((s, b) => s + b.sol, 0);
  const totalSolEquivUpper = bins.filter(b => b.side === "upper").reduce((s, b) => s + b.tokens * P_active, 0);
  const actualDownsidePct = round((1 - P_min / P_active) * 100, 2);
  const actualUpsidePct   = round((P_max / P_active - 1)  * 100, 2);

  return {
    pool: pool_address,
    pool_name: pool.name,
    token_x: pool.token_x_symbol,
    token_y: pool.token_y_symbol,
    bin_step,
    active_price: P_active,
    strategy,
    bins_below: binsBelow,
    bins_above: binsAbove,
    downside_coverage_pct: actualDownsidePct,
    upside_coverage_pct:   actualUpsidePct,
    price_range: { min: P_min, max: P_max, active: P_active },
    initial_allocation: {
      pct_lower: round(totalSolLower * 100, 1),
      pct_upper: round(totalSolEquivUpper * 100, 1),
    },
    oor_above: {
      description: `Price pumps past ${actualUpsidePct}% upper bound — all upper-bin tokens sold`,
      pnl_pct: round((oorAboveTotal - 1) * 100, 2),
    },
    oor_below: {
      description: `Price dumps past ${actualDownsidePct}% lower bound — all SOL converted to tokens`,
      pnl_pct: round((oorBelowTotal - 1) * 100, 2),
    },
  };
}

// ── replayPosition ──────────────────────────────────────────────
//
// Replays a historical position using OHLCV candles to simulate IL + fees,
// then compares against the real recorded outcome.
//
// Input — mirrors position-memory.json fields:
//   pool_address   – pool address
//   strategy       – 'spot' | 'curve' | 'bid_ask'
//   bins_below     – exact bin count from entry.bin_range.bins_below
//   bins_above     – exact bin count from entry.bin_range.bins_above
//   bin_step       – from entry.bin_step
//   entry_time     – ISO string or unix ms (entry.deployed_at)
//   exit_time      – ISO string or unix ms (exit.closed_at)
//   entry_tvl      – pool TVL in USD at entry (entry.signal_snapshot.tvl)
//   fee_pct        – pool base fee % (entry.signal_snapshot.fee_pct)
//   // optional, for comparison output:
//   real_pnl_pct   – exit.pnl_pct
//   real_fees_usd  – exit.fees_earned_usd
//   initial_value_usd – entry.initial_value_usd
//
export async function replayPosition({
  pool_address,
  strategy = "spot",
  bins_below,
  bins_above,
  bin_step,
  entry_time,
  exit_time,
  entry_tvl,          // pool TVL in USD at entry
  entry_fee_window,   // signal_snapshot.fee_window — historical fees in observation window
  entry_volume,       // signal_snapshot.volume     — historical volume in same window
  entry_price       = null, // position-memory entry.entry_price; preferred over candle open
  deploy_active_bin = null, // optional fallback anchor
  first_snapshot_active_bin = null,
  first_snapshot_ts = null,
  // optional comparison fields
  real_pnl_pct      = null,
  real_fees_usd     = null,
  initial_value_usd = null,
}) {
  const entryTs = Math.floor(new Date(entry_time).getTime() / 1000);
  const exitTs  = Math.ceil(new Date(exit_time).getTime() / 1000);

  // Fetch pool (for metadata + base_fee_pct) and OHLCV concurrently
  const durationMin = (exitTs - entryTs) / 60;
  const timeframe   = durationMin <= 360 ? "5m" : "30m";
  const [pool, candles] = await Promise.all([
    fetchPoolInfo(pool_address),
    fetchOhlcv(pool_address, timeframe, entryTs, exitTs),
  ]);
  if (!candles.length) throw new Error(`No OHLCV candles for this window (${new Date(entry_time).toISOString()} → ${new Date(exit_time).toISOString()})`);

  // Historical effective rate from signal snapshot (fee_window and volume are from the same
  // observation period, so their ratio = base + dynamic as it was at position entry time).
  // Fall back to current pool fees/volume if snapshot data not provided.
  const baseRate = pool.base_fee_pct / 100;
  let effectiveFeeRate = baseRate;
  if (entry_fee_window != null && entry_volume > 0) {
    effectiveFeeRate = entry_fee_window / entry_volume;
  } else {
    for (const tf of ["1h", "2h", "4h", "12h", "24h"]) {
      const v = pool.volume?.[tf] ?? 0;
      const f = pool.fees?.[tf]   ?? 0;
      if (v > 0 && f > 0) { effectiveFeeRate = f / v; break; }
    }
  }
  const dynamicRate = Math.max(0, effectiveFeeRate - baseRate);

  // Per-candle dynamic fee weight: dynamic fee ∝ (bins_crossed)²
  // bins_crossed estimated from OHLCV high/low range.
  const r    = 1 + bin_step / 10_000;
  const lnR  = Math.log(r);
  for (const c of candles) {
    c.bins_crossed = (c.high > 0 && c.low > 0 && c.high >= c.low)
      ? Math.log(c.high / c.low) / lnR
      : 0;
  }
  // Volume-weighted sum of bins² — normalisation so dynamic fees integrate to dynamicRate × totalVol / tvl
  const totalVol     = candles.reduce((s, c) => s + (c.volume ?? 0), 0);
  const vwBinsSq     = candles.reduce((s, c) => s + (c.volume ?? 0) * c.bins_crossed ** 2, 0);

  const candleMinutes = timeframe === "5m" ? 5 : 30;
  const candleSec = candleMinutes * 60;
  const P_entry = resolveEntryPrice({
    entry_price,
    candles,
    binStep: bin_step,
    deploy_active_bin,
    first_snapshot_active_bin,
    first_snapshot_ts,
    candleSec,
  });
  const exitCandle = candles.find(c => exitTs >= c.timestamp && exitTs < c.timestamp + candleSec);
  const P_exit  = priceAtTimestampInCandle(exitCandle, exitTs, candleSec) ?? candles[candles.length - 1].close;
  const P_min   = P_entry * Math.pow(r, -bins_below);
  const P_max   = P_entry * Math.pow(r,  bins_above);
  const bins    = buildBins(bins_below, bins_above, bin_step, P_entry, strategy);
  const tvl     = entry_tvl ?? pool.tvl ?? 0;

  // Strategy-aware fee weight: for each candle, sum the bin weights that were actually swept.
  // This makes bid_ask earn more when price hits the edges (high weight) and less near center.
  // For spot (uniform weight=1), weightFactor always equals 1 — matches the old formula.
  const numBins     = bins_below + bins_above;
  const totalWeight = bins.reduce((s, b) => s + b.weight, 0);
  const weightByIdx = new Map(bins.map(b => [b.relIdx, b.weight]));
  for (const c of candles) {
    if (!c.high || !c.low || c.high < c.low) { c.weightFactor = 1; continue; }
    const lowRel  = Math.ceil( Math.log(c.low  / P_entry) / lnR);
    const highRel = Math.floor(Math.log(c.high / P_entry) / lnR);
    const lo = Math.max(lowRel,  -bins_below);
    const hi = Math.min(highRel,  bins_above);
    let sumW = 0, count = 0;
    for (let k = lo; k <= hi; k++) { sumW += weightByIdx.get(k) ?? 0; count++; }
    c.weightFactor = (count > 0 && totalWeight > 0)
      ? (sumW * numBins) / (totalWeight * count)
      : 1;
  }

  let cumFeeRatio  = 0;
  let minutesInRange = 0;

  const timeline = candles.map(candle => {
    const isExitCandle = candle.timestamp <= exitTs && exitTs < candle.timestamp + candleSec;
    const P       = isExitCandle ? priceAtTimestampInCandle(candle, exitTs, candleSec) : candle.close;
    const inRange = P >= P_min && P <= P_max;
    const valRatio = positionValue(bins, P);

    if (inRange && tvl > 0) {
      const wf         = candle.weightFactor ?? 1;
      const baseFee    = (candle.volume / tvl) * baseRate * wf;
      const dynamicFee = (vwBinsSq > 0 && totalVol > 0)
        ? (dynamicRate * totalVol / tvl) * (candle.volume * candle.bins_crossed ** 2 / vwBinsSq) * wf
        : 0;
      cumFeeRatio += baseFee + dynamicFee;
      minutesInRange += candleMinutes;
    }

    return {
      time:            candle.timestamp_str,
      price:           P,
      is_exit_candle:  isExitCandle,
      price_vs_entry:  round((P / P_entry - 1) * 100, 2),
      in_range:        inRange,
      bins_crossed:    round(candle.bins_crossed, 1),
      il_pct:          round((valRatio - 1) * 100, 2),
      cum_fee_pct:     round(cumFeeRatio * 100, 3),
      total_pct:       round((valRatio - 1 + cumFeeRatio) * 100, 2),
    };
  });

  const finalVal    = positionValue(bins, P_exit);
  const il_pct      = round((finalVal - 1) * 100, 2);
  const fee_pct_sim = round(cumFeeRatio * 100, 3);
  const total_pct   = round(il_pct + fee_pct_sim, 2);

  const result = {
    pool: pool_address,
    strategy,
    bins_below,
    bins_above,
    bin_step,
    timeframe,
    candle_count: candles.length,
    duration_min: round(durationMin, 0),
    minutes_in_range: minutesInRange,
    fee_rates: {
      base_pct:      round(baseRate * 100, 3),
      dynamic_pct:   round(dynamicRate * 100, 3),
      effective_pct: round(effectiveFeeRate * 100, 3),
    },

    prices: {
      entry: P_entry,
      exit:  P_exit,
      entry_source: entry_price != null ? "entry_price" : (deploy_active_bin != null ? "snapshot_active_bin" : "first_candle_open"),
      min:   P_min,
      max:   P_max,
      change_pct: round((P_exit / P_entry - 1) * 100, 2),
    },

    simulated: {
      il_pct,
      fee_pct:   fee_pct_sim,
      total_pct,
    },

    timeline,
  };

  // Attach real outcome for comparison if provided
  if (real_pnl_pct != null) {
    const error_pct = round(total_pct - real_pnl_pct, 2);
    result.real = { pnl_pct: real_pnl_pct, fees_usd: real_fees_usd, initial_value_usd };
    result.error = {
      sim_vs_real_pct: error_pct,
      note: Math.abs(error_pct) < 1 ? "close" : Math.abs(error_pct) < 3 ? "ok" : "large — check fee_pct or tvl",
    };
  }

  return result;
}

// ── analyzeExits ────────────────────────────────────────────────
//
// Simulates a position over entry → actual_exit + extend_hours to answer:
//   1. Was the actual exit optimal, too early, or too late?
//   2. What signals preceded the peak and the drawdown?
//
// Same inputs as replayPosition plus:
//   actual_exit_time  – ISO string of real close time
//   extend_hours      – how many hours to simulate past the exit (default 6)
//
export async function analyzeExits({
  pool_address,
  strategy = "spot",
  bins_below,
  bins_above,
  bin_step,
  entry_time,
  actual_exit_time,
  extend_hours = 6,
  entry_tvl,
  entry_fee_window,
  entry_volume,
  real_pnl_pct = null,
  entry_price = null,
  deploy_active_bin = null,
  first_snapshot_active_bin = null,
  first_snapshot_ts = null,
}) {
  const entryTs     = Math.floor(new Date(entry_time).getTime() / 1000);
  const actualExitTs = Math.floor(new Date(actual_exit_time).getTime() / 1000);
  const extendedExitTs = actualExitTs + extend_hours * 3600;

  const timeframe = "5m";

  const [pool, candles] = await Promise.all([
    fetchPoolInfo(pool_address),
    fetchOhlcv(pool_address, timeframe, entryTs, extendedExitTs),
  ]);
  if (!candles.length) throw new Error(`No OHLCV candles for ${pool_address}`);

  const baseRate = pool.base_fee_pct / 100;
  let effectiveFeeRate = baseRate;
  if (entry_fee_window != null && entry_volume > 0) {
    effectiveFeeRate = entry_fee_window / entry_volume;
  } else {
    for (const tf of ["1h", "2h", "4h", "12h", "24h"]) {
      const v = pool.volume?.[tf] ?? 0;
      const f = pool.fees?.[tf]   ?? 0;
      if (v > 0 && f > 0) { effectiveFeeRate = f / v; break; }
    }
  }
  const dynamicRate = Math.max(0, effectiveFeeRate - baseRate);

  const r = 1 + bin_step / 10_000;
  const lnR = Math.log(r);
  const candleMinutes = timeframe === "5m" ? 5 : 30;
  const candleSec     = candleMinutes * 60;
  for (const c of candles) {
    c.bins_crossed = (c.high > 0 && c.low > 0 && c.high >= c.low)
      ? Math.log(c.high / c.low) / lnR : 0;
  }
  const totalVol = candles.reduce((s, c) => s + (c.volume ?? 0), 0);
  const vwBinsSq = candles.reduce((s, c) => s + (c.volume ?? 0) * c.bins_crossed ** 2, 0);

  // Resolve entry price: prefer stored entry_price, then derive from first snapshot
  // active bin, then fall back to candles[0].open (least accurate).
  const P_entry = resolveEntryPrice({
    entry_price,
    candles,
    binStep: bin_step,
    deploy_active_bin,
    first_snapshot_active_bin,
    first_snapshot_ts,
    candleSec,
  });
  const P_min   = P_entry * Math.pow(r, -bins_below);
  const P_max   = P_entry * Math.pow(r,  bins_above);
  const bins    = buildBins(bins_below, bins_above, bin_step, P_entry, strategy);
  const tvl     = entry_tvl ?? pool.tvl ?? 0;

  const numBins     = bins_below + bins_above;
  const totalWeight = bins.reduce((s, b) => s + b.weight, 0);
  const weightByIdx = new Map(bins.map(b => [b.relIdx, b.weight]));
  for (const c of candles) {
    if (!c.high || !c.low || c.high < c.low) { c.weightFactor = 1; continue; }
    const lowRel  = Math.ceil( Math.log(c.low  / P_entry) / lnR);
    const highRel = Math.floor(Math.log(c.high / P_entry) / lnR);
    const lo = Math.max(lowRel,  -bins_below);
    const hi = Math.min(highRel,  bins_above);
    let sumW = 0, count = 0;
    for (let k = lo; k <= hi; k++) { sumW += weightByIdx.get(k) ?? 0; count++; }
    c.weightFactor = (count > 0 && totalWeight > 0)
      ? (sumW * numBins) / (totalWeight * count)
      : 1;
  }

  let cumFeeRatio = 0;
  let wasInRange = true;
  let firstOorTs = null;
  let firstOorDir = null;

  const timeline = candles.map(candle => {
    const isActualExit = candle.timestamp <= actualExitTs && actualExitTs < candle.timestamp + candleSec;
    const isPast = candle.timestamp > actualExitTs;

    // For the actual exit candle, interpolate price at the moment of exit rather than
    // using candle.close (end-of-candle price), which can be far from the real exit price
    // during volatile 5m candles (e.g. a dump that covers 30%+ within one candle).
    let P = candle.close;
    if (isActualExit && candle.open > 0 && candle.close > 0) {
      const fraction = Math.min(1, Math.max(0, (actualExitTs - candle.timestamp) / candleSec));
      P = candle.open + fraction * (candle.close - candle.open);
    }

    const inRange  = P >= P_min && P <= P_max;
    const valRatio = positionValue(bins, P);

    if (inRange && tvl > 0) {
      const wf         = candle.weightFactor ?? 1;
      const baseFee    = (candle.volume / tvl) * baseRate * wf;
      const dynamicFee = (vwBinsSq > 0 && totalVol > 0)
        ? (dynamicRate * totalVol / tvl) * (candle.volume * candle.bins_crossed ** 2 / vwBinsSq) * wf
        : 0;
      cumFeeRatio += baseFee + dynamicFee;
    }

    // Track first OOR event
    if (!inRange && wasInRange && firstOorTs == null) {
      firstOorTs  = candle.timestamp_str;
      firstOorDir = P > P_max ? "above" : "below";
    }
    wasInRange = inRange;

    // How far through the range is the price (0=lower bound, 1=upper bound)
    const rangePct = round(((P - P_min) / (P_max - P_min)) * 100, 1);

    // Fee velocity: fee yield per minute this candle
    const feeVelocity = inRange && tvl > 0
      ? round(((candle.volume / tvl) * effectiveFeeRate) / candleMinutes * 100, 4)
      : 0;

    const ilPct    = round((valRatio - 1) * 100, 2);
    const feePct   = round(cumFeeRatio * 100, 3);
    const totalPct = round(ilPct + feePct, 2);

    return {
      time:           candle.timestamp_str,
      ts:             candle.timestamp,
      price:          P,
      price_vs_entry: round((P / P_entry - 1) * 100, 2),
      range_pct:      Math.max(0, Math.min(100, rangePct)), // 0=at lower, 100=at upper
      in_range:       inRange,
      bins_crossed:   round(candle.bins_crossed, 1),
      fee_vel_pct_pm: feeVelocity,  // fee % per minute
      il_pct:         ilPct,
      cum_fee_pct:    feePct,
      total_pct:      totalPct,
      is_actual_exit: isActualExit,
      is_past_exit:   isPast,
    };
  });

  // Find peak total_pct within the full window (before and after actual exit)
  const peak = timeline.reduce((best, c) => c.total_pct > best.total_pct ? c : best, timeline[0]);
  const actualExitCandle = timeline.find(c => c.is_actual_exit) ?? timeline.find(c => !c.is_past_exit);
  const endCandle = timeline[timeline.length - 1];

  // Verdict
  // A position is "exit_too_early" if the peak AFTER exit is meaningfully better than
  // the exit itself (>2% improvement), regardless of where the end lands — because
  // a trailing TP or manual exit at the peak would have been achievable.
  const exitTotalPct = actualExitCandle?.total_pct ?? 0;
  let verdict;
  if (!actualExitCandle) {
    verdict = "unknown";
  } else if (peak.ts <= actualExitTs) {
    verdict = "exit_too_late";     // peak was before or at actual exit
  } else if (peak.total_pct > exitTotalPct + 2) {
    verdict = "exit_too_early";    // peak after exit was 2%+ better — holding would have helped
  } else if (endCandle.total_pct > exitTotalPct) {
    verdict = "exit_too_early";    // still climbing at end of extended window
  } else {
    verdict = "exit_was_optimal";  // no meaningful recovery window existed after exit
  }

  // Signals: what was happening in the 3 candles before the actual exit?
  const exitIdx = timeline.findIndex(c => c.is_actual_exit);
  const preExit = exitIdx > 0 ? timeline.slice(Math.max(0, exitIdx - 3), exitIdx) : [];
  const signals = {
    price_trend_pre_exit:  preExit.length >= 2
      ? (preExit[preExit.length - 1].price > preExit[0].price ? "rising" : "falling") : null,
    fee_vel_trend_pre_exit: preExit.length >= 2
      ? (preExit[preExit.length - 1].fee_vel_pct_pm > preExit[0].fee_vel_pct_pm ? "accelerating" : "decelerating") : null,
    range_position_at_exit: actualExitCandle?.range_pct ?? null,
    first_oor: firstOorTs ? { time: firstOorTs, direction: firstOorDir } : null,
  };

  return {
    pool: pool_address,
    pool_name: pool.name,
    strategy,
    bins_below,
    bins_above,
    bin_step,
    timeframe,
    prices: { entry: P_entry, min: P_min, max: P_max },
    fee_rates: {
      base_pct:      round(baseRate * 100, 3),
      dynamic_pct:   round(dynamicRate * 100, 3),
      effective_pct: round(effectiveFeeRate * 100, 3),
    },
    actual_exit: {
      time:     actualExitCandle?.time ?? actual_exit_time,
      total_pct: actualExitCandle?.total_pct ?? null,
      real_pnl_pct: real_pnl_pct ?? null,
    },
    peak: {
      time:      peak.time,
      total_pct: peak.total_pct,
      minutes_after_entry: round((peak.ts - entryTs) / 60, 0),
    },
    extended_end: {
      time:      endCandle.time,
      total_pct: endCandle.total_pct,
    },
    verdict,
    signals,
    timeline,
  };
}

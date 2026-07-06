/**
 * Volatility Gatekeeper — classifies a candidate's market regime and suggests
 * a DLMM range shape, based on:
 * https://x.com/Stakepanda/status/2073484002183258532
 *
 * Core idea from the article: the mistake isn't picking the "wrong" DLMM
 * strategy, it's using the same strategy across every regime. Split the
 * market into three modes and match the range shape to the mode:
 *
 *   Compression / Chop      — price ranging, volatility falling, steady volume.
 *                              Tight Curve/Spot around active price is the
 *                              fee-farming zone.
 *   Expansion / Breakout    — price trending hard, wide candles, volume spike
 *                              with continuation. Tight ranges get run over;
 *                              go wider (bid_ask) or sit out.
 *   Exhaustion / Reversion  — after a strong move, price overextends (RSI
 *                              extreme + reversal signal). One-sided ladders
 *                              turn the position into a planned accumulate
 *                              (dump) or distribute (pump) order.
 *
 * Two layers:
 *   1. computeCandleSignals(candles) / fetchRegimeSignals(poolAddress) — pure
 *      price-action analysis directly off OHLCV: real prior-range breakout,
 *      volume spike + authenticity, reversal/rejection candles, active-range
 *      rotation, VWAP deviation, and round-number proximity. No indicator API
 *      dependency.
 *   2. classifyVolatilityRegime(pool, opts) — combines those candle signals
 *      with the existing screening/entry pipeline's RSI/p1h fields (from
 *      tools/chart-indicators.js's checkEntryConditions) into one of the
 *      three regimes.
 *
 * Deliberately out of scope (by request): Curve-vs-Spot strategy selection,
 * fee-APR-vs-inventory-risk weighing, the article's 40/30/20/10 capital
 * allocation bucket system, and market-wide context (SOL/BTC correlation,
 * news/narrative rotation). Those need portfolio-level or external-data
 * plumbing this module doesn't have.
 *
 * Advisory only: it returns a suggested strategy/range shape and reasoning,
 * it does not deploy anything and does not decide pass/fail on its own.
 *
 * Important limitation: this bot currently only supports single-sided SOL
 * deploys placed *below* the active price (config.strategy.defaultUpsidePct
 * defaults to 0 — see CLAUDE.md "Protected Tool Safety"). The article's
 * Exhaustion-on-a-pump case ("deploy token-side liquidity above price to sell
 * into strength") would require an upside-only deploy mode this bot doesn't
 * have yet. The classifier still reports that case for visibility, but flags
 * it as `actionable: false` until that deploy mode exists.
 */

import { log } from "../logger.js";

const METEORA_OHLCV_BASE = "https://dlmm.datapi.meteora.ag/pools";
const HEADERS = { "User-Agent": "Mozilla/5.0" }; // API 403s without a UA

const REGIME = Object.freeze({
  COMPRESSION: "compression",
  EXPANSION: "expansion",
  EXHAUSTION: "exhaustion",
});

function numeric(value) {
  // Number(null) === 0 and Number("") === 0 in JS — both would otherwise silently
  // read as a real "0" (e.g. maximally-oversold RSI) instead of "data unavailable".
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ─── Candle-level signal computation (pure, no fetch) ───────────────

/**
 * Real prior-range breakout: does the latest candle's close sit above the
 * highest high, or below the lowest low, of the N candles *before* it —
 * as opposed to just a big candle body, which can happen inside a wide
 * range without ever actually breaking it.
 */
function detectRangeBreakout(candles, lookback) {
  if (candles.length < 2) return { brokeAbove: false, brokeBelow: false, priorHigh: null, priorLow: null };
  const latest = candles[candles.length - 1];
  const prior = candles.slice(Math.max(0, candles.length - 1 - lookback), candles.length - 1);
  if (!prior.length) return { brokeAbove: false, brokeBelow: false, priorHigh: null, priorLow: null };
  const priorHigh = Math.max(...prior.map((c) => c.high ?? c.close));
  const priorLow = Math.min(...prior.map((c) => c.low ?? c.close));
  return {
    brokeAbove: latest.close > priorHigh,
    brokeBelow: latest.close < priorLow,
    priorHigh,
    priorLow,
  };
}

/**
 * Volume spike + "is volume real". A spike is the latest candle's volume vs
 * the rolling average of the prior window. "Real" volume is a rough
 * authenticity check: total volume isn't ~zero, and isn't so concentrated in
 * one candle that it looks like a single wash-trade/bot burst rather than
 * organic activity spread across the window.
 */
function detectVolumeSignals(candles, lookback) {
  if (candles.length < 2) return { isSpike: false, spikeRatio: null, isReal: null, avgVolume: null, latestVolume: null };
  const latest = candles[candles.length - 1];
  const window = candles.slice(Math.max(0, candles.length - 1 - lookback), candles.length - 1);
  const volumes = window.map((c) => numeric(c.volume) ?? 0);
  const totalVolume = volumes.reduce((a, b) => a + b, 0) + (numeric(latest.volume) ?? 0);
  const avgVolume = volumes.length ? volumes.reduce((a, b) => a + b, 0) / volumes.length : null;
  const latestVolume = numeric(latest.volume);
  const spikeRatio = avgVolume != null && avgVolume > 0 && latestVolume != null ? latestVolume / avgVolume : null;
  const maxSingleCandle = Math.max(...volumes, latestVolume ?? 0);
  const concentration = totalVolume > 0 ? maxSingleCandle / totalVolume : null;
  return {
    isSpike: spikeRatio != null && spikeRatio >= 3,
    spikeRatio,
    // "not real" when volume is negligible, or one candle carries the vast
    // majority of the whole window's volume (looks like a single burst, not
    // sustained/organic activity).
    isReal: totalVolume > 0 && (concentration == null || concentration < 0.7),
    avgVolume,
    latestVolume,
  };
}

/**
 * Reversal / rejection candle — a real "failed continuation" check, as
 * opposed to just an RSI reading. Looks at the single biggest-move candle in
 * the window and checks whether it (or the very next candle) shows a wick
 * that rejects the extreme: a long wick opposite the candle's own close
 * direction is the classic "tried to go further, got rejected" pattern.
 */
function detectReversalCandle(candles, lookback) {
  if (candles.length < 2) return { hasRejection: false, direction: null, wickRatio: null };
  const window = candles.slice(Math.max(0, candles.length - lookback));
  if (!window.length) return { hasRejection: false, direction: null, wickRatio: null };

  let biggest = null;
  let biggestMove = -Infinity;
  for (const c of window) {
    if (!(c.open > 0)) continue;
    const move = Math.abs(c.close - c.open) / c.open;
    if (move > biggestMove) {
      biggestMove = move;
      biggest = c;
    }
  }
  if (!biggest) return { hasRejection: false, direction: null, wickRatio: null };

  const bodyHigh = Math.max(biggest.open, biggest.close);
  const bodyLow = Math.min(biggest.open, biggest.close);
  const body = bodyHigh - bodyLow;
  const upperWick = (biggest.high ?? bodyHigh) - bodyHigh;
  const lowerWick = bodyLow - (biggest.low ?? bodyLow);
  const wasUp = biggest.close >= biggest.open;

  // A rejection on an up-candle is a long UPPER wick (tried to go higher,
  // got sold back down); on a down-candle it's a long LOWER wick (tried to
  // go lower, got bought back up). "Long" = wick at least as big as the body.
  const relevantWick = wasUp ? upperWick : lowerWick;
  const wickRatio = body > 0 ? relevantWick / body : (relevantWick > 0 ? Infinity : 0);
  const hasRejection = wickRatio >= 1;

  return {
    hasRejection,
    direction: wasUp ? "pump" : "dump",
    wickRatio: Number.isFinite(wickRatio) ? wickRatio : null,
  };
}

/**
 * Active-range rotation — proxy for "the active bin keeps rotating inside a
 * range" without raw bin-crossing history: count how many times the close
 * price crosses back and forth over the window's own midpoint. High
 * crossing count = bouncing around inside a range (compression); low count
 * = drifted mostly one direction (trending, not chop).
 */
function detectRangeRotation(candles, lookback) {
  const window = candles.slice(Math.max(0, candles.length - lookback));
  if (window.length < 3) return { crossings: null, rotating: null };
  const highs = window.map((c) => c.high ?? c.close);
  const lows = window.map((c) => c.low ?? c.close);
  const mid = (Math.max(...highs) + Math.min(...lows)) / 2;
  let crossings = 0;
  let above = window[0].close >= mid;
  for (const c of window.slice(1)) {
    const nowAbove = c.close >= mid;
    if (nowAbove !== above) crossings++;
    above = nowAbove;
  }
  // Roughly: crossing the midpoint at least every ~6 candles reads as rotating.
  return { crossings, rotating: crossings >= Math.floor(window.length / 6) };
}

/**
 * VWAP over the window and how far the latest close sits from it.
 */
function detectVwap(candles, lookback) {
  const window = candles.slice(Math.max(0, candles.length - lookback));
  if (!window.length) return { vwap: null, deviationPct: null };
  let pv = 0, v = 0;
  for (const c of window) {
    const typical = ((c.high ?? c.close) + (c.low ?? c.close) + c.close) / 3;
    const vol = numeric(c.volume) ?? 0;
    pv += typical * vol;
    v += vol;
  }
  if (v <= 0) return { vwap: null, deviationPct: null };
  const vwap = pv / v;
  const latestClose = window[window.length - 1].close;
  const deviationPct = vwap > 0 ? ((latestClose - vwap) / vwap) * 100 : null;
  return { vwap, deviationPct };
}

/**
 * Rough "near a round number" check for psychological-level proximity.
 * Normalizes price to a 1-10 mantissa (independent of how many leading
 * zeros a memecoin price has) and checks distance to the nearest of
 * 1/2/2.5/5/10, since those are the levels people actually anchor on.
 */
function detectRoundNumber(price, tolerancePct = 3) {
  if (!(price > 0)) return { isNear: false, nearestLevel: null, distancePct: null };
  const exponent = Math.floor(Math.log10(price));
  const mantissa = price / 10 ** exponent;
  const levels = [1, 2, 2.5, 5, 10];
  let nearest = levels[0];
  let nearestDist = Infinity;
  for (const lvl of levels) {
    const dist = Math.abs(mantissa - lvl) / lvl;
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = lvl;
    }
  }
  const distancePct = nearestDist * 100;
  return {
    isNear: distancePct <= tolerancePct,
    nearestLevel: nearest * 10 ** exponent,
    distancePct,
  };
}

/**
 * Run every candle-based signal off one already-fetched OHLCV array. Pure,
 * no network calls — mirrors the prefetchedCandles pattern already used by
 * checkDipFromHigh/checkLastCandleMomentum in tools/chart-indicators.js so a
 * caller that already has candles doesn't pay for a second fetch.
 *
 * @param {Array<{open,high,low,close,volume}>} candles
 * @param {object} [opts]
 * @param {number} [opts.lookback=36] - candle window for breakout/volume/rotation/VWAP (36×5m = 3h)
 * @param {number} [opts.roundNumberTolerancePct=3]
 */
export function computeCandleSignals(candles, opts = {}) {
  const { lookback = 36, roundNumberTolerancePct = 3 } = opts;
  const clean = (candles || []).filter((c) => c?.open > 0 && c?.close > 0);
  if (clean.length < 2) return null;

  const latestClose = clean[clean.length - 1].close;
  return {
    candleCount: clean.length,
    rangeBreakout: detectRangeBreakout(clean, lookback),
    volume: detectVolumeSignals(clean, lookback),
    reversal: detectReversalCandle(clean, lookback),
    rotation: detectRangeRotation(clean, lookback),
    vwap: detectVwap(clean, lookback),
    roundNumber: detectRoundNumber(latestClose, roundNumberTolerancePct),
  };
}

/**
 * Fetch OHLCV for a pool and compute all candle signals in one call.
 * @param {string} poolAddress
 * @param {object} [opts] - see computeCandleSignals; also accepts endTime (unix seconds, defaults to now)
 */
export async function fetchRegimeSignals(poolAddress, opts = {}) {
  const { lookback = 36, endTime = null } = opts;
  const nowSec = endTime ?? Math.floor(Date.now() / 1000);
  const endTs = Math.floor(nowSec / 300) * 300;
  const startTs = endTs - Math.ceil(lookback * 300 * 1.5); // 1.5x buffer for gaps, matches existing convention
  const url = `${METEORA_OHLCV_BASE}/${poolAddress}/ohlcv?timeframe=5m&start_time=${startTs}&end_time=${endTs}`;

  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`OHLCV fetch ${res.status}`);
    const json = await res.json();
    const candles = json.data ?? [];
    return computeCandleSignals(candles, opts);
  } catch (error) {
    log("indicators_warn", `volatility-gatekeeper: OHLCV fetch failed for ${poolAddress.slice(0, 8)}: ${error.message}`);
    return null;
  }
}

// ─── Regime classification ──────────────────────────────────────────

/**
 * Classify a single enriched pool candidate into a volatility regime.
 *
 * @param {object} pool - enriched candidate from screening.js, after
 *   checkEntryConditions() has populated pool.entry_conditions / rsi_5m /
 *   rsi_15m / st_dir_5m / st_dir_15m.
 * @param {object} [candleSignals] - output of computeCandleSignals()/fetchRegimeSignals().
 *   Optional — falls back to the coarser worstBodyPct-only checks if omitted,
 *   so existing callers that only pass `pool` keep working.
 * @param {object} [opts]
 * @param {number} [opts.exhaustionP1hPct=20] - abs 1h move considered a "strong move" for exhaustion.
 *   Backtested against 193 closed positions (2026-07-03..05): at 40 (the original guess), exhaustion
 *   never fired at all — this bot's real RSI-extreme entries cluster around 20-32% 1h moves, not 40%+.
 *   At 20, dump-side exhaustion (RSI oversold after a drop) was the single best-performing regime in
 *   the sample (+0.0108 SOL/position avg, n=10), while pump-side exhaustion was net negative and isn't
 *   actionable anyway (this bot has no upside-only/sell-into-strength deploy mode).
 * @param {number} [opts.expansionP1hPct=20] - abs 1h move considered a breakout in progress
 * @param {number} [opts.rsiOverbought=80]
 * @param {number} [opts.rsiOversold=20]
 * @param {number} [opts.bigCandleMaxBodyPct=15] - matches config.indicators.bigCandleMaxBodyPct default
 * @returns {{
 *   regime: "compression"|"expansion"|"exhaustion",
 *   direction: "pump"|"dump"|null - sign of the 1h move (null when p1h is unavailable or ~flat).
 *     Set on every regime, not just exhaustion, since callers backtesting/aggregating results
 *     otherwise have to re-derive it from signals.p1h themselves each time.
 *   confidence: "low"|"medium"|"high",
 *   suggested_strategy: "spot"|"bid_ask",
 *   suggested_range: string,
 *   actionable: boolean,
 *   reasoning: string[],
 *   signals: object,
 * }}
 */
export function classifyVolatilityRegime(pool, candleSignals = null, opts = {}) {
  const {
    exhaustionP1hPct = 20,
    expansionP1hPct = 20,
    rsiOverbought = 80,
    rsiOversold = 20,
    bigCandleMaxBodyPct = 15,
  } = opts;

  const p1h = numeric(pool.price_change_1h);
  const volatility = numeric(pool.volatility);
  const rsi15 = numeric(pool.rsi_15m);
  const rsi5 = numeric(pool.rsi_5m);
  const st5 = pool.st_dir_5m ?? null;
  const st15 = pool.st_dir_15m ?? null;
  const candleCheck = pool.entry_conditions?.checks?.candle ?? null;
  const worstBodyPct = numeric(candleCheck?.worstBodyPct);
  const dropPct = numeric(candleCheck?.dropPct); // negative = below recent high

  const breakout = candleSignals?.rangeBreakout ?? null;
  const volumeSig = candleSignals?.volume ?? null;
  const reversal = candleSignals?.reversal ?? null;
  const rotation = candleSignals?.rotation ?? null;
  const vwap = candleSignals?.vwap ?? null;
  const roundNumber = candleSignals?.roundNumber ?? null;

  const signals = {
    p1h, volatility, rsi15, rsi5, st5, st15, worstBodyPct, dropPct,
    breakout, volume: volumeSig, reversal, rotation, vwap, roundNumber,
  };
  const reasoning = [];

  const isPump = p1h != null && p1h > 0;
  const isDump = p1h != null && p1h < 0;
  const direction = isPump ? "pump" : isDump ? "dump" : null;
  const rsiExtremeOverbought = rsi15 != null && rsi15 >= rsiOverbought;
  const rsiExtremeOversold = rsi15 != null && rsi15 <= rsiOversold;
  const strongMove = p1h != null && Math.abs(p1h) >= exhaustionP1hPct;
  const moderateMove = p1h != null && Math.abs(p1h) >= expansionP1hPct;
  const bigCandle = worstBodyPct != null && worstBodyPct >= bigCandleMaxBodyPct;

  // ── Exhaustion / Reversion ──────────────────────────────────────
  // Two distinct triggers, backtested separately against 193 closed positions
  // (2026-07-03..05) because they behave very differently:
  //
  // (a) Sharp-flush exhaustion — a strong 1h move already happened AND RSI is
  //     at an extreme in that direction. The article's "price overextends,
  //     late traders chase" case. Dump-side was the single best-performing
  //     regime in the backtest (+0.0108 SOL/position avg, n=10) — a real
  //     flush that's already snapped back some. A real reversal/rejection
  //     candle (detectReversalCandle) in the matching direction raises
  //     confidence — this is the article's "failed continuation" check,
  //     not just an RSI reading.
  //
  // (b) Stalled/grinding exhaustion — RSI already at a harder extreme (past
  //     rsiHardOversold/rsiHardOverbought) with NO confirming sharp move.
  //     This is a materially different, riskier case: 3 of the 5 worst
  //     compression-bucket losses in the same backtest were exactly this —
  //     RSI 12.35/22.86/94.73 with only an 4-15% 1h move — and they were only
  //     visible once RSI-alone was checked, because the original AND-gated
  //     rule buried them in "compression" where they looked calm. This is
  //     the article's "dangerous if price never mean-reverts" case: RSI has
  //     been extreme for a while without the market actually flushing/topping
  //     yet, so there's no confirmation the move is actually over.
  const rsiHardOversold = rsi15 != null && rsi15 <= (rsiOversold - 5);
  const rsiHardOverbought = rsi15 != null && rsi15 >= (rsiOverbought + 10);
  const sharpFlush = strongMove && ((isPump && rsiExtremeOverbought) || (isDump && rsiExtremeOversold));
  const stalledExtreme = !sharpFlush && ((isPump && rsiHardOverbought) || (isDump && rsiHardOversold));

  if (sharpFlush || stalledExtreme) {
    const direction = isPump ? "pump" : "dump";
    const reversalConfirms = reversal?.hasRejection && reversal.direction === direction;

    if (sharpFlush) {
      reasoning.push(`Strong 1h move (${p1h.toFixed(1)}%) with RSI-15m at an extreme (${rsi15.toFixed(1)}) — matches "price overextends" after a ${direction}.`);
    } else {
      reasoning.push(`RSI-15m at a hard extreme (${rsi15.toFixed(1)}) without a confirming sharp 1h move (${p1h.toFixed(1)}%) — a stalled/grinding ${direction}, not a confirmed flush. Article: "dangerous if price never mean-reverts."`);
    }
    if (reversal) {
      reasoning.push(reversalConfirms
        ? `Reversal/rejection candle confirms failed continuation (wick ${reversal.wickRatio?.toFixed(1)}x body) — "failed continuation after a strong move."`
        : `No confirming rejection candle found yet — reversal not yet visible in price action, only in the oscillator.`);
    }
    if (isDump) {
      reasoning.push("Article: deploy quote-side (SOL) liquidity below price to accumulate the token gradually. This bot's single-sided-below-price default deploy already does exactly this.");
    } else {
      reasoning.push("Article: deploy token-side liquidity above price to sell into strength gradually. This bot only supports single-sided SOL below price today — this direction is not actionable without an upside-only deploy mode.");
    }

    let confidence;
    if (sharpFlush) {
      const strong = rsi15 != null && (rsi15 >= 90 || rsi15 <= 10);
      confidence = strong && reversalConfirms ? "high" : strong || reversalConfirms ? "medium" : "medium";
    } else {
      confidence = reversalConfirms ? "medium" : "low";
    }

    return {
      regime: REGIME.EXHAUSTION,
      direction,
      confidence,
      suggested_strategy: "spot",
      suggested_range: isDump ? "one-sided ladder below price (accumulate)" : "one-sided ladder above price (distribute)",
      actionable: isDump && sharpFlush,
      exhaustion_type: sharpFlush ? "sharp_flush" : "stalled_extreme",
      reasoning,
      signals,
    };
  }

  // ── Expansion / Breakout ─────────────────────────────────────────
  // Trending hard right now. Three ways in, checked independently since any
  // one of them alone matches the article's description:
  //  - a real prior-range breakout (close beyond the actual prior N-candle
  //    high/low — not just a big candle body inside an already-wide range)
  //  - a volume spike that's also real (not one concentrated burst) — "volume
  //    spike with directional continuation"
  //  - the coarser big-candle-body / moderate-1h-move fallback when no OHLCV
  //    candle signals were supplied
  const realBreakout = breakout != null && (breakout.brokeAbove || breakout.brokeBelow);
  const realVolumeSpike = volumeSig != null && volumeSig.isSpike && volumeSig.isReal;

  if (realBreakout || realVolumeSpike || bigCandle || (moderateMove && !rsiExtremeOverbought && !rsiExtremeOversold)) {
    if (realBreakout) {
      reasoning.push(`Close broke ${breakout.brokeAbove ? "above" : "below"} the prior ${candleSignals?.candleCount ?? "?"}-candle range (prior high ${breakout.priorHigh}, low ${breakout.priorLow}) — "candle closes outside the prior range."`);
    }
    if (realVolumeSpike) {
      reasoning.push(`Volume spike (${volumeSig.spikeRatio.toFixed(1)}x average) that reads as real, not a single concentrated burst — "volume spike with directional continuation."`);
    } else if (volumeSig != null && volumeSig.isSpike && !volumeSig.isReal) {
      reasoning.push(`Volume spike detected but concentrated in one candle — looks like a single burst, not sustained volume. Not counted as confirming expansion on its own.`);
    }
    if (bigCandle) reasoning.push(`Big realized candle body (${worstBodyPct.toFixed(1)}% >= ${bigCandleMaxBodyPct}%) — "multiple bins get crossed quickly."`);
    if (moderateMove) reasoning.push(`1h move ${p1h.toFixed(1)}% without an RSI extreme — still trending, not yet exhausted.`);
    reasoning.push("Article: tight Curve/Spot risks getting converted into the weaker side of the pair. Prefer wider bid_ask, reduced size, or wait for a new range to form.");

    const confirmCount = [realBreakout, realVolumeSpike, bigCandle, moderateMove].filter(Boolean).length;
    return {
      regime: REGIME.EXPANSION,
      direction,
      confidence: confirmCount >= 3 ? "high" : confirmCount === 2 ? "medium" : "low",
      suggested_strategy: "bid_ask",
      suggested_range: "wider range, reduced size, or skip",
      actionable: true,
      reasoning,
      signals,
    };
  }

  // ── Compression / Chop ───────────────────────────────────────────
  // No breakout, no real volume spike, no big candle, no strong move. When
  // candle signals are available, also check for real supporting evidence of
  // chop rather than just "nothing else matched": the range is rotating
  // (active-bin-style back-and-forth) and price is sitting near VWAP rather
  // than drifting away from it.
  if (rotation?.rotating) reasoning.push(`Price crossed the recent range's midpoint ${rotation.crossings} times — "active bin keeps rotating inside a range."`);
  if (vwap?.deviationPct != null) reasoning.push(`Price is ${vwap.deviationPct >= 0 ? "+" : ""}${vwap.deviationPct.toFixed(1)}% from VWAP — "${Math.abs(vwap.deviationPct) < 3 ? "respecting VWAP" : "drifting from VWAP"}."`);
  if (roundNumber?.isNear) reasoning.push(`Price sits within ${roundNumber.distancePct.toFixed(1)}% of a round level (~${roundNumber.nearestLevel}) — a level traders may anchor on.`);
  reasoning.push("No strong 1h move, no real breakout, no confirmed volume spike, no oversized candle — price reads as ranging/chop, the article's fee-farming zone.");
  if (volatility != null) reasoning.push(`volatility=${volatility}`);

  const chopEvidence = [rotation?.rotating, vwap != null && Math.abs(vwap.deviationPct ?? 100) < 3].filter(Boolean).length;
  return {
    regime: REGIME.COMPRESSION,
    direction,
    confidence: chopEvidence >= 2 ? "high" : p1h != null && Math.abs(p1h) < 5 ? "medium" : "low",
    suggested_strategy: "spot",
    suggested_range: "tight range around active price",
    actionable: true,
    reasoning,
    signals,
  };
}

export { REGIME as VOLATILITY_REGIME };

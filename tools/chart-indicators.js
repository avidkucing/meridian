import { config } from "../config.js";
import { log } from "../logger.js";

const DEFAULT_INTERVALS = ["5_MINUTE"];
const DEFAULT_CANDLES = 298;

function getApiBase() {
  return String(config.api.url || "https://api.agentmeridian.xyz/api").replace(/\/+$/, "");
}

function getHeaders() {
  const headers = {};
  if (config.api.publicApiKey) headers["x-api-key"] = config.api.publicApiKey;
  return headers;
}

function normalizeIntervals(intervals) {
  const list = Array.isArray(intervals) ? intervals : DEFAULT_INTERVALS;
  return list
    .map((value) => String(value || "").trim().toUpperCase())
    .filter((value) => value === "5_MINUTE" || value === "15_MINUTE");
}

function safeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildSignalSummary(payload) {
  const latest = payload?.latest || {};
  const candle = latest?.candle || {};
  const previousCandle = latest?.previousCandle || {};
  const rsi = safeNum(latest?.rsi?.value);
  const bollinger = latest?.bollinger || {};
  const supertrend = latest?.supertrend || {};
  const fibonacciLevels = latest?.fibonacci?.levels || {};
  return {
    close: safeNum(candle.close),
    previousClose: safeNum(previousCandle.close),
    rsi,
    lowerBand: safeNum(bollinger.lower),
    middleBand: safeNum(bollinger.middle),
    upperBand: safeNum(bollinger.upper),
    supertrendValue: safeNum(supertrend.value),
    supertrendDirection: String(supertrend.direction || "unknown"),
    supertrendBreakUp: !!latest?.states?.supertrendBreakUp,
    supertrendBreakDown: !!latest?.states?.supertrendBreakDown,
    fib50: safeNum(fibonacciLevels["0.500"]),
    fib618: safeNum(fibonacciLevels["0.618"]),
    fib786: safeNum(fibonacciLevels["0.786"]),
  };
}

function evaluatePreset(side, preset, payload) {
  const summary = buildSignalSummary(payload);
  const oversold = Number(config.indicators.rsiOversold ?? 30);
  const overbought = Number(config.indicators.rsiOverbought ?? 80);
  const rsiFloor = Number(config.indicators.rsiFloor ?? 16);
  const close = summary.close;
  const previousClose = summary.previousClose;
  const lowerBand = summary.lowerBand;
  const upperBand = summary.upperBand;
  const rsi = summary.rsi;
  const isBullish = summary.supertrendDirection === "bullish";
  const isBearish = summary.supertrendDirection === "bearish";
  const crossedUp = (level) =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose < level &&
    close >= level;
  const crossedDown = (level) =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose > level &&
    close <= level;

  switch (preset) {
    case "supertrend_break":
      return side === "entry"
        ? {
            confirmed: summary.supertrendBreakUp || (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue),
            reason: summary.supertrendBreakUp ? "Supertrend flipped bullish" : "Price is above bullish Supertrend",
            signal: summary,
          }
        : {
            confirmed: summary.supertrendBreakDown || (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue),
            reason: summary.supertrendBreakDown ? "Supertrend flipped bearish" : "Price is below bearish Supertrend",
            signal: summary,
          };
    case "rsi_reversal":
      return side === "entry"
        ? {
            confirmed: rsi != null && rsi <= oversold,
            reason: `RSI ${rsi ?? "n/a"} <= oversold ${oversold}`,
            signal: summary,
          }
        : {
            confirmed: rsi != null && rsi >= overbought,
            reason: `RSI ${rsi ?? "n/a"} >= overbought ${overbought}`,
            signal: summary,
          };
    case "bollinger_reversion":
      return side === "entry"
        ? {
            confirmed: close != null && lowerBand != null && close <= lowerBand,
            reason: `Close ${close ?? "n/a"} <= lower band ${lowerBand ?? "n/a"}`,
            signal: summary,
          }
        : {
            confirmed: close != null && upperBand != null && close >= upperBand,
            reason: `Close ${close ?? "n/a"} >= upper band ${upperBand ?? "n/a"}`,
            signal: summary,
          };
    case "rsi_plus_supertrend":
      return side === "entry"
        ? {
            confirmed:
              (rsi != null && rsi <= oversold) &&
              (summary.supertrendBreakUp || isBullish),
            reason: `RSI oversold with bullish Supertrend context`,
            signal: summary,
          }
        : {
            confirmed:
              (rsi != null && rsi >= overbought) &&
              (summary.supertrendBreakDown || isBearish),
            reason: `RSI overbought with bearish Supertrend context`,
            signal: summary,
          };
    case "supertrend_or_rsi":
      return side === "entry"
        ? {
            confirmed:
              summary.supertrendBreakUp ||
              (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue) ||
              (rsi != null && rsi <= oversold),
            reason: "Supertrend bullish confirmation or RSI oversold",
            signal: summary,
          }
        : {
            confirmed:
              summary.supertrendBreakDown ||
              (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue) ||
              (rsi != null && rsi >= overbought),
            reason: "Supertrend bearish confirmation or RSI overbought",
            signal: summary,
          };
    case "supertrend_or_momentum":
      return side === "entry"
        ? {
            confirmed:
              summary.supertrendBreakUp ||
              ((isBullish || !isBearish) && close != null && summary.supertrendValue != null && close >= summary.supertrendValue) ||
              (rsi != null && rsi > Number(config.indicators.rsiMomentum ?? 55)),
            reason: isBullish
              ? "Bullish Supertrend confirmed"
              : `RSI ${rsi ?? "n/a"} > momentum threshold ${config.indicators.rsiMomentum ?? 55}`,
            signal: summary,
          }
        : {
            confirmed:
              summary.supertrendBreakDown ||
              (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue),
            reason: "Supertrend turned bearish",
            signal: summary,
          };
    case "bb_plus_rsi":
      return side === "entry"
        ? {
            confirmed:
              close != null &&
              lowerBand != null &&
              close <= lowerBand &&
              rsi != null &&
              rsi <= oversold,
            reason: "Close at/below lower band with RSI oversold",
            signal: summary,
          }
        : {
            confirmed:
              close != null &&
              upperBand != null &&
              close >= upperBand &&
              rsi != null &&
              rsi >= overbought,
            reason: "Close at/above upper band with RSI overbought",
            signal: summary,
          };
    case "fibo_reclaim":
      return side === "entry"
        ? {
            confirmed:
              crossedUp(summary.fib618) ||
              crossedUp(summary.fib50) ||
              crossedUp(summary.fib786),
            reason: "Price reclaimed a key Fibonacci level",
            signal: summary,
          }
        : {
            confirmed:
              crossedUp(summary.fib618) ||
              crossedUp(summary.fib50),
            reason: "Price reclaimed a key Fibonacci level upward",
            signal: summary,
          };
    case "fibo_reject":
      return side === "entry"
        ? {
            confirmed:
              crossedDown(summary.fib618) ||
              crossedDown(summary.fib50),
            reason: "Price rejected from a key Fibonacci level",
            signal: summary,
          }
        : {
            confirmed:
              crossedDown(summary.fib618) ||
              crossedDown(summary.fib50) ||
              crossedDown(summary.fib786),
            reason: "Price rejected below a key Fibonacci level",
            signal: summary,
          };
    case "no_falling_knife":
      // Block entry when RSI is oversold AND ST is bearish — oversold-but-falling pattern
      // that historically continues to dump (52% win, -0.33% avg vs 69%/+0.57% baseline).
      // Allows entry when RSI is not deeply oversold OR the trend is still bullish.
      // Exit: ST flips bearish or RSI reaches overbought.
      return side === "entry"
        ? {
            confirmed: rsi == null || rsi >= oversold || isBullish,
            reason:
              rsi != null && rsi < oversold && isBearish
                ? `Falling knife blocked: RSI ${rsi.toFixed(1)} < ${oversold} with bearish ST`
                : rsi != null
                ? `RSI ${rsi.toFixed(1)} ${rsi >= oversold ? ">=" : "<"} ${oversold} | ST ${summary.supertrendDirection}`
                : "RSI unavailable — allowing entry",
            signal: summary,
          }
        : {
            confirmed:
              summary.supertrendBreakDown ||
              (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue) ||
              (rsi != null && rsi >= overbought),
            reason: summary.supertrendBreakDown
              ? "Supertrend flipped bearish"
              : `RSI ${rsi?.toFixed(1)} >= overbought ${overbought}`,
            signal: summary,
          };
    case "dip_entry":
      // Enter when ST is bearish OR RSI is above the floor (>= rsiFloor, default 16).
      // Blocks freefall entries: ST bullish + RSI < floor = token in freefall, not a dip.
      // Exit when price recovers: ST flips bullish or RSI reaches overbought.
      return side === "entry"
        ? {
            confirmed:
              isBearish ||
              summary.supertrendBreakDown ||
              (rsi != null && rsi >= rsiFloor),
            reason:
              isBearish || summary.supertrendBreakDown
                ? `Supertrend bearish — entering on correction`
                : `RSI ${rsi?.toFixed(1)} >= floor ${rsiFloor} — not in freefall`,
            signal: summary,
          }
        : {
            confirmed:
              summary.supertrendBreakUp ||
              (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue) ||
              (rsi != null && rsi >= overbought),
            reason: summary.supertrendBreakUp
              ? "Supertrend flipped bullish — exit dip position"
              : `RSI ${rsi?.toFixed(1)} >= overbought ${overbought} — recovery complete`,
            signal: summary,
          };
    case "pump_retrace":
      // Enter when price is extended/overbought — expecting retrace back into range.
      // Designed for single-sided SOL (bins_above=0) where bins sit below current price.
      return side === "entry"
        ? {
            confirmed:
              (isBearish || summary.supertrendBreakDown) ||
              (rsi != null && rsi >= overbought),
            reason: isBearish || summary.supertrendBreakDown
              ? "Supertrend bearish — price cooling from pump"
              : `RSI ${rsi ?? "n/a"} >= overbought ${overbought}`,
            signal: summary,
          }
        : {
            confirmed:
              summary.supertrendBreakUp ||
              (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue),
            reason: "Supertrend flipped bullish — exit retrace position",
            signal: summary,
          };
    default:
      return {
        confirmed: false,
        reason: `Unknown preset ${preset}`,
        signal: summary,
      };
  }
}

const METEORA_OHLCV_BASE = "https://dlmm.datapi.meteora.ag/pools";

/**
 * Check whether the current price has dipped at least minDipPct% below
 * the highest close seen in the last dipLookbackCandles × 5-minute candles.
 *
 * Used as a pre-deploy gate: only enter when the token has genuinely pulled
 * back from a recent high, not at the peak.
 *
 * @param {string} poolAddress  - Meteora pool address
 * @param {object} opts
 * @param {number} opts.minDipPct           - Required % drop from high (default 10)
 * @param {number} opts.dipLookbackCandles  - Candles to look back for the high (default 20)
 * @returns {{ confirmed, dropPct, recentHigh, currentClose, nCandles, reason }}
 */
/**
 * Block entry when the last completed 5m candle is a small bearish candle
 * AND the 1h price change is in the "moderate pump" range (default 0–30%).
 *
 * Pattern: token pumped moderately but the last bar is flat/red → momentum
 * already faded, likely entering at a stale top.
 *
 * endTs is snapped to the 5m candle boundary so the fetch result is stable
 * across multiple screening runs within the same candle window (cache-friendly).
 *
 * @param {string} poolAddress
 * @param {number} p1hPct        - price_change_1h from signal snapshot (%)
 * @param {object} opts
 * @param {number} opts.maxBodyPct - max candle body % to qualify as "small" (default 3)
 * @param {number} opts.p1hMin     - lower p1h bound to apply filter (default 0)
 * @param {number} opts.p1hMax     - upper p1h bound to apply filter (default 30)
 * @returns {{ confirmed, reason, bodyPct, direction }}
 */
export async function checkLastCandleMomentum(poolAddress, p1hPct, {
  maxBodyPct = 3,
  p1hMin     = 0,
  p1hMax     = 30,
} = {}) {
  const p1h = parseFloat(p1hPct) || 0;
  if (p1h <= p1hMin || p1h >= p1hMax) {
    return { confirmed: true, reason: `p1h ${p1h.toFixed(1)}% outside filter range (${p1hMin}–${p1hMax}%)` };
  }

  // Snap to 5m candle grid — stable cache key within the same candle window
  const nowSec  = Math.floor(Date.now() / 1000);
  const endTs   = Math.floor(nowSec / 300) * 300;
  const startTs = endTs - 6 * 300;

  const url = `${METEORA_OHLCV_BASE}/${poolAddress}/ohlcv?timeframe=5m&start_time=${startTs}&end_time=${endTs}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OHLCV fetch ${res.status} for pool ${poolAddress.slice(0, 8)}`);

  const json    = await res.json();
  const candles = (json.data ?? []).filter(c => c?.open > 0 && c?.close > 0);
  if (!candles.length) throw new Error(`No candles for momentum check on ${poolAddress.slice(0, 8)}`);

  const last      = candles[candles.length - 1];
  const bodyPct   = Math.abs(last.close - last.open) / last.open * 100;
  const isNotBull = !(last.close > last.open); // flat or bearish — matches historical analysis
  const dir       = last.close > last.open ? "bullish" : last.close < last.open ? "bearish" : "flat";

  if (isNotBull && bodyPct < maxBodyPct) {
    return {
      confirmed: false,
      reason:    `last candle ${dir} ${bodyPct.toFixed(2)}% body with p1h ${p1h.toFixed(1)}% — stale pump, no momentum`,
      bodyPct,
      direction: dir,
    };
  }

  return {
    confirmed: true,
    reason:    `last candle ${dir} ${bodyPct.toFixed(2)}% body — momentum ok`,
    bodyPct,
    direction: dir,
  };
}

export async function checkDipFromHigh(poolAddress, {
  minDipPct          = 25,
  dipLookbackCandles = 36,
} = {}) {
  if (!minDipPct || minDipPct <= 0) {
    return { confirmed: true, reason: "Dip check disabled (minDipPct=0)", dropPct: null };
  }

  // Fetch enough candles: request 1.5× the lookback window to account for gaps
  const endTs   = Math.floor(Date.now() / 1000);
  const startTs = endTs - Math.ceil(dipLookbackCandles * 5 * 60 * 1.5);
  const url     = `${METEORA_OHLCV_BASE}/${poolAddress}/ohlcv?timeframe=5m&start_time=${startTs}&end_time=${endTs}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`OHLCV fetch ${res.status} for pool ${poolAddress.slice(0, 8)}`);

  const json    = await res.json();
  const candles = (json.data ?? []).filter(c => c?.close > 0);
  if (candles.length < 2) throw new Error(`Too few candles (${candles.length}) for dip check`);

  const recent       = candles.slice(-dipLookbackCandles);
  const currentClose = recent[recent.length - 1].close;
  const recentHigh   = Math.max(...recent.map(c => c.high ?? c.close));
  const dropPct      = (currentClose - recentHigh) / recentHigh * 100; // negative = below high

  const confirmed = dropPct <= -minDipPct;
  return {
    confirmed,
    dropPct:      +dropPct.toFixed(2),
    recentHigh,
    currentClose,
    nCandles:     recent.length,
    reason: confirmed
      ? `Price is ${Math.abs(dropPct).toFixed(1)}% below ${recent.length}-candle high ✓ (need ≥${minDipPct}%)`
      : `Price is only ${Math.abs(dropPct).toFixed(1)}% below ${recent.length}-candle high — need ≥${minDipPct}% dip before entering`,
  };
}

export async function fetchChartIndicatorsForMint(
  mint,
  {
    interval,
    candles = config.indicators.candles ?? DEFAULT_CANDLES,
    rsiLength = config.indicators.rsiLength ?? 2,
    refresh = false,
  } = {},
) {
  const normalizedInterval = String(interval || "15_MINUTE").trim().toUpperCase();
  const search = new URLSearchParams({
    interval: normalizedInterval,
    candles: String(candles),
    rsiLength: String(rsiLength),
  });
  if (refresh) search.set("refresh", "1");

  const res = await fetch(`${getApiBase()}/chart-indicators/${mint}?${search.toString()}`, {
    headers: getHeaders(),
  });
  const text = await res.text().catch(() => "");
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    throw new Error(payload?.error || `chart indicators ${res.status}`);
  }
  return payload;
}

export async function confirmIndicatorPreset({
  mint,
  side,
  preset = side === "entry" ? config.indicators.entryPreset : config.indicators.exitPreset,
  intervals = config.indicators.intervals,
  refresh = false,
  enabled = config.indicators.enabled,
  requireAllIntervals = config.indicators.requireAllIntervals,
} = {}) {
  if (!enabled || !mint || !preset) {
    return { enabled: false, confirmed: true, reason: "Indicators disabled or not configured", intervals: [] };
  }

  const targets = normalizeIntervals(intervals);
  if (targets.length === 0) {
    return { enabled: false, confirmed: true, reason: "No indicator intervals configured", intervals: [] };
  }

  const results = [];
  for (const interval of targets) {
    try {
      const payload = await fetchChartIndicatorsForMint(mint, { interval, refresh });
      const evaluation = evaluatePreset(side, preset, payload);
      results.push({
        interval,
        ok: true,
        confirmed: !!evaluation.confirmed,
        reason: evaluation.reason,
        signal: evaluation.signal,
        latest: payload?.latest || null,
      });
    } catch (error) {
      log("indicators_warn", `Indicator fetch failed for ${mint.slice(0, 8)} ${interval}: ${error.message}`);
      results.push({
        interval,
        ok: false,
        confirmed: null,
        reason: error.message,
        signal: null,
        latest: null,
      });
    }
  }

  const successful = results.filter((entry) => entry.ok);
  if (successful.length === 0) {
    return {
      enabled: true,
      confirmed: true,
      skipped: true,
      preset,
      side,
      reason: "Indicator API unavailable; falling back to existing logic",
      intervals: results,
    };
  }

  const requireAll = !!requireAllIntervals;
  const confirmed = requireAll
    ? successful.every((entry) => entry.confirmed)
    : successful.some((entry) => entry.confirmed);

  return {
    enabled: true,
    confirmed,
    skipped: false,
    preset,
    side,
    requireAllIntervals: requireAll,
    reason: confirmed
      ? `${preset} confirmed on ${successful.filter((entry) => entry.confirmed).map((entry) => entry.interval).join(", ")}`
      : `${preset} not confirmed on ${successful.map((entry) => entry.interval).join(", ")}`,
    intervals: results,
  };
}

/**
 * technical-analysis.js — RSI, support/resistance, and other indicators
 * Uses Meteora OHLCV API for real on-chain price data.
 */

const METEORA_OHLCV_BASE = "https://dlmm.datapi.meteora.ag/pools";

/**
 * Fetch OHLCV candles for a pool from Meteora.
 * @param {string} poolAddress - Pool address
 * @param {string} timeframe - Candle interval: "5m", "30m", "1h", "2h", "4h", "12h", "24h" (default: "5m")
 * @param {number|null} startTime - Unix timestamp in seconds for range start (optional)
 * @param {number|null} endTime - Unix timestamp in seconds for range end (optional)
 * @returns {Array} Array of candles with { time, open, high, low, close, volume }
 * @note Without start_time/end_time, API returns ~10 candles covering a default window based on timeframe.
 *       Use start_time + end_time to get a specific range (can return more than 10 candles).
 */
export async function fetchOHLCV({ poolAddress, timeframe = "5m", startTime = null, endTime = null }) {
  let url = `${METEORA_OHLCV_BASE}/${poolAddress}/ohlcv?timeframe=${timeframe}`;
  if (startTime != null) url += `&start_time=${startTime}`;
  if (endTime != null) url += `&end_time=${endTime}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`OHLCV API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const rawCandles = data.data || [];

  return rawCandles.map((c) => ({
    time: c.timestamp || c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

/**
 * Calculate RSI (Relative Strength Index) for a given period.
 * Auto-adapts period when insufficient candles are available.
 * @param {Array} candles - Array of candles with close prices
 * @param {number} period - RSI period (default: 14, adapts if fewer candles)
 * @returns {Object} { rsi: number, overbought: boolean, oversold: boolean, history: Array }
 */
export function calculateRSI(candles, period = 14) {
  // Adaptive period: need at least period+1 candles
  const adaptivePeriod = Math.min(period, candles.length - 1);
  if (adaptivePeriod < 2) {
    throw new Error(`Need at least 3 candles to calculate RSI. Got ${candles.length}`);
  }
  if (adaptivePeriod < period) {
    period = adaptivePeriod;
  }

  const closes = candles.map((c) => c.close);
  const changes = [];

  // Calculate price changes
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  // Calculate initial average gain and loss
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) {
      avgGain += changes[i];
    } else {
      avgLoss += Math.abs(changes[i]);
    }
  }

  avgGain /= period;
  avgLoss /= period;

  // RSI history
  const rsiHistory = [];

  // First RSI value
  let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  let rsi = 100 - 100 / (1 + rs);
  rsiHistory.push({ index: period, rsi: parseFloat(rsi.toFixed(2)) });

  // Calculate subsequent RSI values using smoothed averages
  for (let i = period; i < changes.length; i++) {
    const change = changes[i];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi = 100 - 100 / (1 + rs);

    rsiHistory.push({ index: period + i, rsi: parseFloat(rsi.toFixed(2)) });
  }

  const currentRSI = rsiHistory[rsiHistory.length - 1]?.rsi || 50;

  return {
    rsi: currentRSI,
    overbought: currentRSI >= 70,
    oversold: currentRSI <= 30,
    history: rsiHistory,
    interpretation: getRSIInterpretation(currentRSI),
  };
}

/**
 * Get human-readable interpretation of RSI value.
 */
function getRSIInterpretation(rsi) {
  if (rsi >= 80) return "EXTREMELY OVERBOUGHT — Strong reversal likely, consider taking profits";
  if (rsi >= 70) return "OVERBOUGHT — Price may reverse downward soon";
  if (rsi >= 60) return "BULLISH MOMENTUM — Strong uptrend but approaching overbought";
  if (rsi >= 40) return "NEUTRAL — No extreme momentum";
  if (rsi >= 30) return "BEARISH MOMENTUM — Strong downtrend but approaching oversold";
  if (rsi >= 20) return "OVERSOLD — Price may bounce upward soon";
  return "EXTREMELY OVERSOLD — Strong bounce likely, potential accumulation zone";
}

/**
 * Identify major support and resistance levels from OHLCV data.
 * Adapted for Meteora's 10-candle limit — uses lowest/highest prices
 * and volume-weighted nodes instead of unreliable swing detection.
 * @param {Array} candles - Array of candles (min 5, typically 10)
 * @param {Object} options - Configuration
 * @returns {Object} { supports: Array, resistances: Array, currentPrice: number }
 */
export function identifySupportResistance(candles, options = {}) {
  const {
    volumeThreshold = 1.2, // Volume multiplier for significant levels
  } = options;

  if (candles.length < 5) {
    throw new Error(`Need at least 5 candles for support/resistance analysis. Got ${candles.length}`);
  }

  const currentPrice = candles[candles.length - 1].close;

  // ── Method 1: Window Low/High (always exists) ──────────
  // With only 10 candles, swing detection is unreliable.
  // The lowest low and highest high are the most concrete levels.
  const lowestLow = Math.min(...candles.map(c => c.low));
  const highestHigh = Math.max(...candles.map(c => c.high));

  // ── Method 2: Volume-weighted price clusters ───────────
  // Group candles into bins to find where volume clustered
  const priceRange = highestHigh - lowestLow;
  const binCount = Math.max(5, Math.min(10, candles.length));
  const binSize = priceRange / binCount || currentPrice * 0.01;

  const priceBins = [];
  for (let i = 0; i < binCount; i++) {
    const binLow = lowestLow + i * binSize;
    const binHigh = binLow + binSize;
    const candlesInBin = candles.filter(c => c.close >= binLow && (c.close < binHigh || (i === binCount - 1 && c.close <= binHigh)));
    if (candlesInBin.length > 0) {
      const totalVolume = candlesInBin.reduce((s, c) => s + c.volume, 0);
      priceBins.push({
        price: (binLow + binHigh) / 2,
        low: binLow,
        high: binHigh,
        volume: totalVolume,
        touches: candlesInBin.length,
      });
    }
  }

  const avgVolume = candles.reduce((sum, c) => sum + c.volume, 0) / candles.length;
  const highVolumeNodes = priceBins
    .filter((bin) => bin.volume > avgVolume * volumeThreshold)
    .sort((a, b) => b.volume - a.volume);

  // ── Build support and resistance lists ──────────────────
  const supports = [];
  const resistances = [];

  // Lowest low is always a support (price bounced from here)
  const lowestDistPct = ((currentPrice - lowestLow) / currentPrice) * 100;
  supports.push({
    price: lowestLow,
    distancePct: parseFloat(lowestDistPct.toFixed(2)),
    strength: Math.max(1, candles.filter(c => Math.abs(c.low - lowestLow) / lowestLow < 0.002).length),
    method: "window_low",
  });

  // Highest high is always a resistance
  const highestDistPct = ((highestHigh - currentPrice) / currentPrice) * 100;
  resistances.push({
    price: highestHigh,
    distancePct: parseFloat(highestDistPct.toFixed(2)),
    strength: Math.max(1, candles.filter(c => Math.abs(c.high - highestHigh) / highestHigh < 0.002).length),
    method: "window_high",
  });

  // Add high-volume nodes as additional levels
  for (const node of highVolumeNodes) {
    const distPct = ((node.price - currentPrice) / currentPrice) * 100;
    const level = {
      price: node.price,
      distancePct: parseFloat(distPct.toFixed(2)),
      strength: node.touches,
      method: "volume_cluster",
    };
    if (node.price < currentPrice * 0.998) {
      supports.push(level);
    } else if (node.price > currentPrice * 1.002) {
      resistances.push(level);
    }
  }

  // Sort by relevance and cluster nearby levels
  const clusteredSupports = clusterLevels(
    supports.filter(s => s.price < currentPrice * 0.998).sort((a, b) => b.price - a.price),
    0.005
  );
  const clusteredResistances = clusterLevels(
    resistances.filter(r => r.price > currentPrice * 1.002).sort((a, b) => a.price - b.price),
    0.005
  );

  const majorSupport = clusteredSupports.length > 0 ? clusteredSupports[0] : null;
  const majorResistance = clusteredResistances.length > 0 ? clusteredResistances[0] : null;

  return {
    currentPrice,
    majorSupport: majorSupport ? {
      price: majorSupport.price,
      distancePct: parseFloat(((currentPrice - majorSupport.price) / currentPrice * 100).toFixed(2)),
      strength: majorSupport.strength,
      method: majorSupport.method,
    } : null,
    majorResistance: majorResistance ? {
      price: majorResistance.price,
      distancePct: parseFloat(((majorResistance.price - currentPrice) / currentPrice * 100).toFixed(2)),
      strength: majorResistance.strength,
      method: majorResistance.method,
    } : null,
    supports: clusteredSupports.slice(0, 3).map((s) => ({
      price: s.price,
      distancePct: parseFloat(((currentPrice - s.price) / currentPrice * 100).toFixed(2)),
      strength: s.strength,
      method: s.method,
    })),
    resistances: clusteredResistances.slice(0, 3).map((r) => ({
      price: r.price,
      distancePct: parseFloat(((r.price - currentPrice) / currentPrice * 100).toFixed(2)),
      strength: r.strength,
      method: r.method,
    })),
  };
}

/**
 * Cluster nearby price levels to avoid duplicates.
 */
function clusterLevels(levels, thresholdPct) {
  if (levels.length === 0) return [];

  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const clusters = [];
  let currentCluster = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = currentCluster[0];
    const curr = sorted[i];
    const diffPct = Math.abs(curr.price - prev.price) / prev.price;

    if (diffPct <= thresholdPct) {
      // Merge into existing cluster
      currentCluster.push(curr);
    } else {
      // Finalize current cluster and start new one
      clusters.push(mergeCluster(currentCluster));
      currentCluster = [curr];
    }
  }

  // Don't forget the last cluster
  if (currentCluster.length > 0) {
    clusters.push(mergeCluster(currentCluster));
  }

  return clusters.sort((a, b) => (b.strength || 0) - (a.strength || 0));
}

/**
 * Merge a cluster of price levels into a single representative level.
 */
function mergeCluster(cluster) {
  const avgPrice = cluster.reduce((sum, l) => sum + l.price, 0) / cluster.length;
  const totalTouches = cluster.reduce((sum, l) => sum + (l.touches || 0), 0);
  const totalStrength = cluster.reduce((sum, l) => sum + (l.strength || 0), 0);
  const maxVolume = Math.max(...cluster.map((l) => l.volume || 0));

  return {
    price: parseFloat(avgPrice.toFixed(6)),
    touches: totalTouches,
    strength: totalStrength,
    volume: maxVolume,
    type: cluster[0].type,
    method: cluster[0].method,
    clusterSize: cluster.length,
  };
}

/**
 * Complete technical analysis for a pool.
 * Combines RSI, support/resistance, and volume analysis.
 * @param {string} poolAddress - Pool address
 * @param {string} timeframe - Candle timeframe (default: "5m")
 * @returns {Object} Complete analysis
 */
export async function analyzePool({ poolAddress, timeframe = "5m", supertrendPeriod = 10, supertrendMultiplier = 3 }) {
  // Fetch ~50 candles with explicit time range (same as calculateBinsFromTA)
  const endTime = Math.floor(Date.now() / 1000);
  const tfSeconds = { "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400 };
  const seconds = (tfSeconds[timeframe] || 300) * 50;
  const startTime = endTime - seconds;

  const candles = await fetchOHLCV({ poolAddress, timeframe, startTime, endTime });

  // MACD needs slowPeriod(26) + signalPeriod(9) = 35 candles minimum
  if (candles.length < 35) {
    throw new Error(`Need at least 35 candles for full analysis. Got ${candles.length}`);
  }

  // Calculate RSI
  const rsiData = calculateRSI(candles, 14);

  // Calculate Bollinger Bands
  const bbData = calculateBollingerBands(candles, 20, 2);

  // Calculate Supertrend
  const stData = calculateSupertrend(candles, supertrendPeriod, supertrendMultiplier);

  // Calculate MACD
  const macdData = calculateMACD(candles);

  // Identify support/resistance
  const srData = identifySupportResistance(candles);

  // Volume analysis
  const avgVolume = candles.reduce((sum, c) => sum + c.volume, 0) / candles.length;
  const recentVolume = candles.slice(-5).reduce((sum, c) => sum + c.volume, 0) / 5;
  const volumeTrend = recentVolume > avgVolume * 1.2 ? "INCREASING" : recentVolume < avgVolume * 0.8 ? "DECREASING" : "STABLE";

  // Price trend
  const price5Ago = candles[candles.length - 5].close;
  const priceChange5m = ((srData.currentPrice - price5Ago) / price5Ago * 100).toFixed(2);

  return {
    pool: poolAddress,
    timeframe,
    timestamp: new Date().toISOString(),
    currentPrice: srData.currentPrice,
    rsi: {
      value: rsiData.rsi,
      status: rsiData.overbought ? "OVERBOUGHT" : rsiData.oversold ? "OVERSOLD" : "NEUTRAL",
      interpretation: rsiData.interpretation,
    },
    bollingerBands: {
      upperBand: bbData.upperBand,
      middleBand: bbData.middleBand,
      lowerBand: bbData.lowerBand,
      percentB: bbData.percentB,
      bandwidth: bbData.bandwidth,
      position: bbData.position,
      interpretation: bbData.interpretation,
    },
    supertrend: {
      value: stData.value,
      direction: stData.direction,
      trend: stData.trend,
      distancePct: stData.distancePct,
      flipped: stData.flipped,
      period: supertrendPeriod,
      multiplier: supertrendMultiplier,
      interpretation: stData.interpretation,
    },
    macd: {
      macdLine: macdData.macdLine,
      signalLine: macdData.signalLine,
      histogram: macdData.histogram,
      crossover: macdData.crossover,
      trend: macdData.trend,
      diverging: macdData.diverging,
      interpretation: macdData.interpretation,
    },
    support: srData.supports.slice(0, 3).map((s, i) => ({
      level: i + 1,
      price: s.price,
      distancePct: s.distancePct,
      strength: s.strength,
    })),
    resistance: srData.resistances.slice(0, 3).map((r, i) => ({
      level: i + 1,
      price: r.price,
      distancePct: r.distancePct,
      strength: r.strength,
    })),
    volume: {
      trend: volumeTrend,
      recentAvg: parseFloat(avgVolume.toFixed(2)),
      vsAverage: ((recentVolume / avgVolume - 1) * 100).toFixed(1) + "%",
    },
    priceAction: {
      change5m: priceChange5m + "%",
    },
  };
}

/**
 * Format analysis results for display or LLM consumption.
 */
export function formatAnalysis(analysis) {
  const lines = [
    `📊 Technical Analysis — ${analysis.timeframe} Timeframe`,
    `💰 Current Price: ${analysis.currentPrice}`,
    ``,
    `📈 RSI (14): ${analysis.rsi.value}`,
    `   Status: ${analysis.rsi.status}`,
    `   ${analysis.rsi.interpretation}`,
    ``,
    `📊 Bollinger Bands (20, 2):`,
    `   Upper: ${analysis.bollingerBands.upperBand}`,
    `   Middle: ${analysis.bollingerBands.middleBand}`,
    `   Lower: ${analysis.bollingerBands.lowerBand}`,
    `   %B: ${analysis.bollingerBands.percentB}%`,
    `   Bandwidth: ${analysis.bollingerBands.bandwidth}%`,
    `   Position: ${analysis.bollingerBands.position}`,
    `   ${analysis.bollingerBands.interpretation}`,
    ``,
    `📈 Supertrend (${analysis.supertrend.period}, ${analysis.supertrend.multiplier}):`,
    `   Value: ${analysis.supertrend.value}`,
    `   Direction: ${analysis.supertrend.direction} (${analysis.supertrend.trend})`,
    `   Distance: ${analysis.supertrend.distancePct}%`,
    `   Flipped: ${analysis.supertrend.flipped ? "YES — recent reversal!" : "No"}`,
    `   ${analysis.supertrend.interpretation}`,
    ``,
    `📊 MACD (12, 26, 9):`,
    `   MACD Line: ${analysis.macd.macdLine}`,
    `   Signal: ${analysis.macd.signalLine}`,
    `   Histogram: ${analysis.macd.histogram}`,
    `   Crossover: ${analysis.macd.crossover === "NONE" ? "None" : analysis.macd.crossover}`,
    `   Trend: ${analysis.macd.trend} ${analysis.macd.diverging ? "(diverging)" : ""}`,
    `   ${analysis.macd.interpretation}`,
    ``,
    `🔻 Support Levels:`,
  ];

  for (const s of analysis.support) {
    lines.push(`   S${s.level}: ${s.price} (${s.distancePct}% below, strength: ${s.strength})`);
  }

  if (analysis.support.length === 0) {
    lines.push(`   No strong support detected`);
  }

  lines.push(``);
  lines.push(`🔺 Resistance Levels:`);

  for (const r of analysis.resistance) {
    lines.push(`   R${r.level}: ${r.price} (${r.distancePct}% above, strength: ${r.strength})`);
  }

  if (analysis.resistance.length === 0) {
    lines.push(`   No strong resistance detected`);
  }

  lines.push(``);
  lines.push(`📊 Volume: ${analysis.volume.trend} (${analysis.volume.vsAverage} vs avg)`);
  lines.push(`📉 Price Change (5 candles): ${analysis.priceAction.change5m}`);

  return lines.join("\n");
}

/**
 * Calculate Bollinger Bands for a given period and standard deviation multiplier.
 * Bollinger Bands consist of:
 * - Middle Band: Simple Moving Average (SMA)
 * - Upper Band: SMA + (standard deviation * multiplier)
 * - Lower Band: SMA - (standard deviation * multiplier)
 * 
 * @param {Array} candles - Array of candles with close prices
 * @param {number} period - SMA period (default: 20)
 * @param {number} stdDevMultiplier - Standard deviation multiplier (default: 2)
 * @returns {Object} { upperBand, middleBand, lowerBand, bandwidth, percentB, position, history: Array }
 */
export function calculateBollingerBands(candles, period = 20, stdDevMultiplier = 2) {
  if (candles.length < period) {
    throw new Error(`Need at least ${period} candles to calculate Bollinger Bands. Got ${candles.length}`);
  }

  const closes = candles.map((c) => c.close);
  const history = [];

  // Calculate Bollinger Bands for each complete window
  for (let i = period - 1; i < closes.length; i++) {
    // Extract window
    const window = closes.slice(i - period + 1, i + 1);

    // Calculate SMA (middle band)
    const sma = window.reduce((sum, price) => sum + price, 0) / period;

    // Calculate standard deviation
    const squaredDiffs = window.map((price) => Math.pow(price - sma, 2));
    const variance = squaredDiffs.reduce((sum, sq) => sum + sq, 0) / period;
    const stdDev = Math.sqrt(variance);

    // Calculate bands
    const upperBand = sma + (stdDev * stdDevMultiplier);
    const lowerBand = sma - (stdDev * stdDevMultiplier);

    // Calculate %B (position within bands)
    const currentPrice = closes[i];
    const percentB = ((currentPrice - lowerBand) / (upperBand - lowerBand)) * 100;

    // Calculate bandwidth (volatility measure)
    const bandwidth = ((upperBand - lowerBand) / sma) * 100;

    // Determine position
    let position = "MIDDLE";
    if (currentPrice >= upperBand) {
      position = "ABOVE_UPPER";
    } else if (currentPrice <= lowerBand) {
      position = "BELOW_LOWER";
    } else if (percentB >= 80) {
      position = "NEAR_UPPER";
    } else if (percentB <= 20) {
      position = "NEAR_LOWER";
    }

    history.push({
      index: i,
      upperBand: parseFloat(upperBand.toFixed(8)),
      middleBand: parseFloat(sma.toFixed(8)),
      lowerBand: parseFloat(lowerBand.toFixed(8)),
      percentB: parseFloat(percentB.toFixed(2)),
      bandwidth: parseFloat(bandwidth.toFixed(2)),
      position,
    });
  }

  const latest = history[history.length - 1];

  return {
    upperBand: latest.upperBand,
    middleBand: latest.middleBand,
    lowerBand: latest.lowerBand,
    bandwidth: latest.bandwidth,
    percentB: latest.percentB,
    position: latest.position,
    currentPrice: closes[closes.length - 1],
    interpretation: getBollingerInterpretation(latest.position, latest.percentB, latest.bandwidth),
    history,
  };
}

/**
 * Calculate MACD (Moving Average Convergence Divergence).
 * MACD = EMA(fast) - EMA(slow)
 * Signal = EMA(MACD, signalPeriod)
 * Histogram = MACD - Signal
 * 
 * @param {Array} candles - Array of candles with close prices
 * @param {number} fastPeriod - Fast EMA period (default: 12)
 * @param {number} slowPeriod - Slow EMA period (default: 26)
 * @param {number} signalPeriod - Signal line EMA period (default: 9)
 * @returns {Object} { macdLine, signalLine, histogram, crossover, trend, history: Array }
 */
export function calculateMACD(candles, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (candles.length < slowPeriod + signalPeriod) {
    throw new Error(`Need at least ${slowPeriod + signalPeriod} candles for MACD. Got ${candles.length}`);
  }

  const closes = candles.map((c) => c.close);

  // EMA helper — returns array same length as input, with null padding for warm-up
  function calcEMA(data, period) {
    const k = 2 / (period + 1);
    const result = [];
    if (data.length < period) return data.map(() => null);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period; // SMA seed
    for (let i = 0; i < period - 1; i++) result.push(null);
    result.push(ema);
    for (let i = period; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
      result.push(ema);
    }
    return result;
  }

  const emaFast = calcEMA(closes, fastPeriod);
  const emaSlow = calcEMA(closes, slowPeriod);

  // MACD line (align by slowPeriod start)
  const macdLine = [];
  const startIdx = slowPeriod - 1;
  for (let i = startIdx; i < closes.length; i++) {
    macdLine.push(emaFast[i] - emaSlow[i]);
  }

  // Signal line (EMA of MACD)
  const signalLineValues = calcEMA(macdLine, signalPeriod);
  const histogram = [];
  const history = [];

  for (let i = 0; i < macdLine.length; i++) {
    const signalVal = signalLineValues[i];
    if (signalVal == null) continue; // skip warm-up period

    const macdVal = macdLine[i];
    const histVal = macdVal - signalVal;

    histogram.push(histVal);

    // Detect crossovers
    const prevHist = histogram.length > 1 ? histogram[histogram.length - 2] : 0;
    let crossover = "NONE";
    if (prevHist < 0 && histVal > 0) crossover = "BULLISH";
    else if (prevHist > 0 && histVal < 0) crossover = "BEARISH";

    // Trend
    const trend = histVal > 0 ? "BULLISH" : "BEARISH";

    history.push({
      index: startIdx + i,
      macdLine: parseFloat(macdVal.toFixed(8)),
      signalLine: parseFloat(signalVal.toFixed(8)),
      histogram: parseFloat(histVal.toFixed(8)),
      crossover,
      trend,
    });
  }

  const latest = history[history.length - 1];
  const prev = history.length > 1 ? history[history.length - 2] : null;

  return {
    macdLine: latest.macdLine,
    signalLine: latest.signalLine,
    histogram: latest.histogram,
    crossover: latest.crossover,
    trend: latest.trend,
    diverging: prev ? Math.abs(latest.histogram) > Math.abs(prev.histogram) : false,
    interpretation: getMACDInterpretation(latest.trend, latest.crossover, latest.histogram, prev),
    history,
  };
}

/**
 * Get human-readable interpretation of MACD.
 */
function getMACDInterpretation(trend, crossover, histogram, prev) {
  if (crossover === "BULLISH") {
    return `MACD BULLISH CROSSOVER — MACD crossed above signal line, potential long signal`;
  }
  if (crossover === "BEARISH") {
    return `MACD BEARISH CROSSOVER — MACD crossed below signal line, potential exit signal`;
  }
  if (trend === "BULLISH") {
    return `MACD BULLISH — Above signal line, momentum positive${histogram > 0.0000001 ? " (diverging)" : " (converging)"}`;
  }
  return `MACD BEARISH — Below signal line, momentum negative${histogram < -0.0000001 ? " (diverging)" : " (converging)"}`;
}

/**
 * Calculate Supertrend for a given ATR period and multiplier.
 * Supertrend uses ATR to create a trailing stop that flips between bullish and bearish.
 * - Bullish: price above supertrend line (green)
 * - Bearish: price below supertrend line (red)
 * 
 * @param {Array} candles - Array of candles with { high, low, close }
 * @param {number} period - ATR period (default: 10)
 * @param {number} multiplier - ATR multiplier (default: 3)
 * @returns {Object} { value, direction, trend, history: Array }
 */
export function calculateSupertrend(candles, period = 10, multiplier = 3) {
  if (candles.length < period + 1) {
    throw new Error(`Need at least ${period + 1} candles to calculate Supertrend. Got ${candles.length}`);
  }

  const history = [];

  // Calculate ATR
  function calcATR(candles, period, upToIndex) {
    let sum = 0;
    const start = Math.max(1, upToIndex - period + 1);
    for (let i = start; i <= upToIndex; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      sum += tr;
    }
    return sum / Math.min(period, upToIndex);
  }

  // Supertrend tracking variables
  let supertrend = [];
  let direction = []; // 1 = bullish (price above), -1 = bearish (price below)

  for (let i = 1; i < candles.length; i++) {
    const atr = calcATR(candles, period, i);
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const upperBand = hl2 + (multiplier * atr);
    const lowerBand = hl2 - (multiplier * atr);

    if (i === 1) {
      supertrend[i] = { upper: upperBand, lower: lowerBand, value: lowerBand };
      direction[i] = 1; // default bullish
    } else {
      const prev = supertrend[i - 1];
      const prevDir = direction[i - 1];

      // Update upper/lower bands based on direction
      let finalUpper, finalLower;
      if (upperBand < prev.upper || prevDir === -1) {
        finalUpper = upperBand;
      } else {
        finalUpper = prev.upper;
      }
      if (lowerBand > prev.lower || prevDir === 1) {
        finalLower = lowerBand;
      } else {
        finalLower = prev.lower;
      }

      // Determine direction
      let newDir;
      if (prevDir === 1) {
        newDir = candles[i].close < finalLower ? -1 : 1;
      } else {
        newDir = candles[i].close > finalUpper ? 1 : -1;
      }

      // Set supertrend value based on direction
      const stValue = newDir === 1 ? finalLower : finalUpper;
      supertrend[i] = { upper: finalUpper, lower: finalLower, value: stValue };
      direction[i] = newDir;
    }
  }

  // Build history (skip first candle where ATR isn't ready)
  const startIdx = period;
  for (let i = startIdx; i < candles.length; i++) {
    if (!supertrend[i]) continue;
    history.push({
      index: i,
      value: parseFloat(supertrend[i].value.toFixed(8)),
      direction: direction[i] === 1 ? "BULLISH" : "BEARISH",
      price: candles[i].close,
      distancePct: parseFloat(((candles[i].close - supertrend[i].value) / candles[i].close * 100).toFixed(2)),
    });
  }

  const latest = history[history.length - 1];
  const prev = history.length > 1 ? history[history.length - 2] : null;

  // Detect flip
  const flipped = prev && latest.direction !== prev.direction;

  return {
    value: latest.value,
    direction: latest.direction,
    trend: latest.direction === "BULLISH" ? "UPTREND" : "DOWNTREND",
    price: latest.price,
    distancePct: latest.distancePct,
    flipped,
    interpretation: getSupertrendInterpretation(latest.direction, latest.distancePct, flipped),
    history,
  };
}

/**
 * Get human-readable interpretation of Supertrend.
 */
function getSupertrendInterpretation(direction, distancePct, flipped) {
  if (flipped) {
    if (direction === "BULLISH") {
      return `SUPERTREND FLIPPED BULLISH — Price crossed above Supertrend, potential long signal`;
    }
    return `SUPERTREND FLIPPED BEARISH — Price crossed below Supertrend, potential short/exit signal`;
  }
  if (direction === "BULLISH") {
    return `SUPERTREND BULLISH — Price above Supertrend (${distancePct}% above), uptrend intact`;
  }
  return `SUPERTREND BEARISH — Price below Supertrend (${Math.abs(distancePct)}% below), downtrend intact`;
}

/**
 * Get human-readable interpretation of Bollinger Bands position.
 */
function getBollingerInterpretation(position, percentB, bandwidth) {
  let volatilityNote = "";
  if (bandwidth < 2) {
    volatilityNote = " | LOW VOLATILITY — Squeeze detected, breakout imminent";
  } else if (bandwidth > 10) {
    volatilityNote = " | HIGH VOLATILITY — Wide bands, strong trend";
  }

  switch (position) {
    case "ABOVE_UPPER":
      return `PRICE ABOVE UPPER BAND — Strong breakout momentum, potential reversal or continuation${volatilityNote}`;
    case "BELOW_LOWER":
      return `PRICE BELOW LOWER BAND — Strong breakdown momentum, potential reversal or continuation${volatilityNote}`;
    case "NEAR_UPPER":
      return `NEAR UPPER BAND (%B: ${percentB.toFixed(1)}) — Approaching overbought territory${volatilityNote}`;
    case "NEAR_LOWER":
      return `NEAR LOWER BAND (%B: ${percentB.toFixed(1)}) — Approaching oversold territory${volatilityNote}`;
    default:
      return `WITHIN BANDS (%B: ${percentB.toFixed(1)}) — Normal price action, no extreme momentum${volatilityNote}`;
  }
}

/**
 * Calculate optimal bin range based on technical analysis.
 * Uses support levels to set bins_below and resistance levels for bins_above.
 *
 * @param {string} poolAddress - Pool address
 * @param {number} binStep - Pool's bin step
 * @param {Object} options - Configuration
 * @returns {Object} { bins_below, bins_above, price_range_pct, reasoning, rsi, support, resistance }
 */
export async function calculateBinsFromTA({ poolAddress, binStep, options = {} }) {
  const {
    timeframe = "5m",
    useSupportLevel = true, // Use major support for bins_below
    useResistanceLevel = true, // Use resistance for bins_above
    rsiAdjustOverbought = true, // Reduce range if RSI overbought
    rsiAdjustOversold = true, // Expand range if RSI oversold
    singleSidedSol = false, // Force bins_above=0 for SOL-only positions
  } = options;

  // Fetch candles with start_time/end_time to get ~50 candles instead of 10
  const endTime = Math.floor(Date.now() / 1000);
  const tfSeconds = { "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400 };
  const seconds = (tfSeconds[timeframe] || 300) * 50;
  const startTime = endTime - seconds;

  const candles = await fetchOHLCV({ poolAddress, timeframe, startTime, endTime });
  const rsiData = calculateRSI(candles, 14);
  const srData = identifySupportResistance(candles);
  const currentPrice = srData.currentPrice;

  // ── Calculate bins_below ──────────────────────────────────
  let binsBelow = 0;
  let belowReasoning = "";

  if (useSupportLevel && srData.majorSupport && srData.majorSupport.strength >= 2) {
    // Use major support level as the bottom of range
    const supportPrice = srData.majorSupport.price;
    const distancePct = ((currentPrice - supportPrice) / currentPrice) * 100;
    const binStepPct = binStep / 100;
    binsBelow = Math.floor(distancePct / binStepPct);
    belowReasoning = `Based on major support at ${supportPrice} (${distancePct.toFixed(1)}% below, strength: ${srData.majorSupport.strength})`;
  } else {
    belowReasoning = "No strong support detected — bins_below = 0";
  }

  // Adjust for RSI conditions
  if (rsiAdjustOverbought && rsiData.overbought) {
    // RSI overbought - price likely to drop, expand below range
    const expansionFactor = rsiData.rsi >= 80 ? 1.5 : 1.25;
    binsBelow = Math.ceil(binsBelow * expansionFactor);
    belowReasoning += ` | RSI ${rsiData.rsi} (overbought) — expanded ${expansionFactor}x`;
  }

  if (rsiAdjustOversold && rsiData.oversold) {
    // RSI oversold - price likely to bounce, can tighten below
    const tightenFactor = 0.75;
    binsBelow = Math.ceil(binsBelow * tightenFactor);
    belowReasoning += ` | RSI ${rsiData.rsi} (oversold) — tightened for bounce play`;
  }

  // ── Calculate bins_above ──────────────────────────────────
  let binsAbove = 0;
  let aboveReasoning = "";

  if (useResistanceLevel && srData.majorResistance && srData.majorResistance.strength >= 2) {
    // Use resistance as the top of range
    const resistancePrice = srData.majorResistance.price;
    const distancePct = ((resistancePrice - currentPrice) / currentPrice) * 100;
    const binStepPct = binStep / 100;
    binsAbove = Math.floor(distancePct / binStepPct);
    aboveReasoning = `Based on resistance at ${resistancePrice} (${distancePct.toFixed(1)}% above, strength: ${srData.majorResistance.strength})`;
  } else {
    aboveReasoning = "No strong resistance detected — bins_above = 0";
  }

  // Adjust for RSI conditions
  if (rsiAdjustOverbought && rsiData.overbought) {
    // RSI overbought - reduce above range (expecting reversal)
    binsAbove = Math.max(0, Math.ceil(binsAbove * 0.5));
    aboveReasoning += ` | RSI ${rsiData.rsi} (overbought) — reduced above range`;
  }

  if (rsiAdjustOversold && rsiData.oversold) {
    // RSI oversold - expand above range (expecting bounce)
    binsAbove = Math.ceil(binsAbove * 1.5);
    aboveReasoning += ` | RSI ${rsiData.rsi} (oversold) — expanded for bounce`;
  }

  // ── Calculate total range percentage ──────────────────────
  const binStepPct = binStep / 100;

  // ── Enforce single-sided SOL constraint ───────────────────
  if (singleSidedSol) {
    binsAbove = 0;
    aboveReasoning = "Force 0 — singleSidedSol=true (SOL-only deploy)";
  }

  const belowRangePct = binsBelow * binStepPct;
  const aboveRangePct = binsAbove * binStepPct;
  const totalRangePct = (binsBelow + binsAbove) * binStepPct;

  // ── Safety checks ─────────────────────────────────────────
  const { config } = await import("../config.js");
  const maxTotalBins = 1400; // DLMM protocol limit
  const totalBins = binsBelow + binsAbove;

  if (totalBins > maxTotalBins) {
    // Scale down proportionally
    const scale = maxTotalBins / totalBins;
    binsBelow = Math.floor(binsBelow * scale);
    binsAbove = Math.floor(binsAbove * scale);
    aboveReasoning += ` | Scaled down to respect ${maxTotalBins} bin limit`;
  }

  return {
    bins_below: binsBelow,
    bins_above: binsAbove,
    price_range: {
      below_pct: parseFloat(belowRangePct.toFixed(2)),
      above_pct: parseFloat(aboveRangePct.toFixed(2)),
      total_pct: parseFloat(totalRangePct.toFixed(2)),
    },
    rsi: {
      value: rsiData.rsi,
      status: rsiData.overbought ? "OVERBOUGHT" : rsiData.oversold ? "OVERSOLD" : "NEUTRAL",
    },
    support: srData.majorSupport ? {
      price: srData.majorSupport.price,
      distance_pct: parseFloat(srData.majorSupport.distancePct),
      strength: srData.majorSupport.strength,
    } : null,
    resistance: srData.majorResistance ? {
      price: srData.majorResistance.price,
      distance_pct: parseFloat(srData.majorResistance.distancePct),
      strength: srData.majorResistance.strength,
    } : null,
    reasoning: {
      below: belowReasoning,
      above: aboveReasoning,
    },
    bin_step: binStep,
    total_bins: binsBelow + binsAbove,
  };
}

/**
 * Format bin range calculation for display.
 */
export function formatBinRange(binRange) {
  const lines = [
    `🎯 Bin Range Calculation (TA-Based)`,
    ``,
    `📊 Technical Indicators:`,
    `   RSI: ${binRange.rsi.value} (${binRange.rsi.status})`,
    ``,
  ];

  if (binRange.support) {
    lines.push(`🔻 Major Support: ${binRange.support.price} (${binRange.support.distance_pct}% below, strength: ${binRange.support.strength})`);
  }

  if (binRange.resistance) {
    lines.push(`🔺 Major Resistance: ${binRange.resistance.price} (${binRange.resistance.distance_pct}% above, strength: ${binRange.resistance.strength})`);
  }

  lines.push(``);
  lines.push(`🎯 Recommended Bin Range:`);
  lines.push(`   Bins Below: ${binRange.bins_below} (${binRange.price_range.below_pct}% range)`);
  lines.push(`   Bins Above: ${binRange.bins_above} (${binRange.price_range.above_pct}% range)`);
  lines.push(`   Total Bins: ${binRange.total_bins} (${binRange.price_range.total_pct}% range)`);
  lines.push(`   Bin Step: ${binRange.bin_step}`);
  lines.push(``);
  lines.push(`💡 Reasoning:`);
  lines.push(`   Below: ${binRange.reasoning.below}`);
  lines.push(`   Above: ${binRange.reasoning.above}`);

  return lines.join("\n");
}

/**
 * lose-analysis.js — Post-mortem analysis for a losing position.
 *
 * Takes a pool-memory deploy entry, fetches:
 * 1. The pre-entry candles the screener saw (30m supertrend for `spot_in_a_pump`)
 * 2. The candles during the position lifetime (5m granularity)
 * 3. Produces a diagnosis + prevention recommendations
 */

import { fetchOHLCV } from "./technical-analysis.js";
import { calculateSupertrend } from "./technical-analysis.js";
import { log } from "../logger.js";

const METEORA_POOL_INFO = "https://dlmm.datapi.meteora.ag/pools";

/**
 * Analyze a losing position from pool-memory.json.
 *
 * @param {Object} poolMemoryItem  — the full pool-memory entry object (e.g. pool-memory[key])
 * @param {Object} deployEntry    — the specific deploy object from poolMemoryItem.deploys[]
 * @param {string} poolAddress    — the pool address (key in pool-memory.json)
 * @param {Object} userConfig     — user-config.json for strategy/timeframe info
 * @returns {Promise<Object>}     — structured analysis report
 */
export async function analyzeLosingPosition({ poolMemoryItem, deployEntry, poolAddress, userConfig }) {
  const {
    closed_at,
    pnl_pct,
    pnl_usd,
    minutes_held,
    close_reason,
    strategy: deployStrategy,
    volatility_at_deploy,
  } = deployEntry;

  if (!closed_at || !poolMemoryItem?.snapshots?.length) {
    return { error: "No snapshots or close data available for this deploy." };
  }

  const poolName = poolMemoryItem.name || "Unknown";
  const closedAt = new Date(closed_at);

  // ── 1. Fetch pre-entry candles (what the screener saw) ──────
  // Use the strategy's actual entry_signal timeframe, not the user's screening timeframe
  const entrySignalTimeframe = userConfig?.entry_signal_timeframe || userConfig?.timeframe || "30m";
  const tfSeconds = { "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "24h": 86400 };
  const entryCandleSeconds = tfSeconds[entrySignalTimeframe] || 1800;

  // Estimate deploy time from closed_at - minutes_held (deployed_at is null in pool-memory)
  const estimatedDeployTs = Math.floor(closedAt.getTime() / 1000) - (minutes_held * 60);
  const preEntryEndTs = estimatedDeployTs;
  const preEntryStartTs = preEntryEndTs - (entryCandleSeconds * 50); // 50 candles for reliable supertrend

  let entryCandles = [];
  let entrySupertrend = null;
  let entryDiagnosis = "";

  log("lose-analysis", `Fetching entry candles: ${new Date(preEntryStartTs*1000).toISOString()} → ${new Date(preEntryEndTs*1000).toISOString()} (${entrySignalTimeframe})`);

  try {
    entryCandles = await fetchOHLCV({
      poolAddress,
      timeframe: entrySignalTimeframe,
      startTime: preEntryStartTs,
      endTime: preEntryEndTs,
    });

    if (entryCandles.length >= 3) {
      entrySupertrend = calculateSupertrend(entryCandles);
      entryDiagnosis = buildEntryDiagnosis(entryCandles, entrySupertrend, deployStrategy, userConfig);
    }
  } catch (e) {
    log("lose-analysis", `Failed to fetch pre-entry candles: ${e.message}`);
    entryDiagnosis = "Could not fetch pre-entry candle data.";
  }

  // ── 2. Fetch position-lifetime candles (5m granularity) ─────
  const positionStartTs = preEntryEndTs;
  const positionEndTs = Math.floor(closedAt.getTime() / 1000);

  let positionCandles = [];
  let positionDiagnosis = "";

  try {
    positionCandles = await fetchOHLCV({
      poolAddress,
      timeframe: "5m",
      startTime: positionStartTs,
      endTime: positionEndTs,
    });

    if (positionCandles.length >= 3) {
      positionDiagnosis = buildPositionDiagnosis(positionCandles, deployEntry, poolMemoryItem);
    }
  } catch (e) {
    log("lose-analysis", `Failed to fetch position candles: ${e.message}`);
    positionDiagnosis = "Could not fetch position-lifetime candle data.";
  }

  // ── 3. Prevention recommendations ──────────────────────────
  const prevention = buildPrevention(entryCandles, entrySupertrend, positionCandles, deployEntry, poolMemoryItem, userConfig);

  return {
    pool_address: poolAddress,
    pool_name: poolName,
    close_time: closed_at,
    pnl_pct,
    pnl_usd,
    minutes_held,
    close_reason,
    strategy: deployStrategy,
    volatility_at_deploy,
    entry_analysis: {
      timeframe: entrySignalTimeframe,
      candles_fetched: entryCandles.length,
      candles: entryCandles.map(compactCandle),
      supertrend: entrySupertrend ? {
        direction: entrySupertrend.direction,
        trend: entrySupertrend.trend,
        flipped: entrySupertrend.flipped,
        lastFlipDirection: entrySupertrend.lastFlipDirection,
        value: entrySupertrend.value,
        distancePct: entrySupertrend.distancePct,
      } : null,
      diagnosis: entryDiagnosis,
    },
    position_analysis: {
      candles_fetched: positionCandles.length,
      key_candles: positionCandles.map(compactCandle),
      diagnosis: positionDiagnosis,
    },
    prevention,
  };
}

/**
 * Build diagnosis of the entry conditions.
 */
function buildEntryDiagnosis(candles, supertrend, deployStrategy, userConfig) {
  const parts = [];
  const first = candles[0];
  const last = candles[candles.length - 1];
  const priceChangePct = ((last.close - first.open) / first.open * 100).toFixed(2);

  // Check if supertrend was actually flipped at entry time
  if (supertrend) {
    const flipDir = supertrend.lastFlipDirection;
    if (flipDir === "BULLISH") {
      parts.push(`✅ Last supertrend flip was BULLISH — signal present.`);
    } else if (flipDir === "BEARISH") {
      parts.push(`❌ Last supertrend flip was BEARISH — entry taken against signal.`);
    } else {
      parts.push(`⚠️ No flip detected in lookback window — direction=${supertrend.direction} but no recent trend change.`);
    }
    parts.push(`   Supertrend: ${supertrend.trend}, direction=${supertrend.direction}, lastFlip=${flipDir ?? "none"}, value=${supertrend.value}`);
  }

  // Price action during entry window
  parts.push(`Price moved ${priceChangePct > 0 ? "+" : ""}${priceChangePct}% across ${candles.length} ${userConfig?.timeframe || "30m"} candles before deploy.`);

  // Volatility context
  const candles_range = (candles[candles.length - 1].time - candles[0].time) / 3600;
  const avgVolume = candles.reduce((s, c) => s + c.volume, 0) / candles.length;
  const recentVol = candles.slice(-3).reduce((s, c) => s + c.volume, 0) / 3;
  const volChange = ((recentVol / avgVolume - 1) * 100).toFixed(0);

  parts.push(`Volume trend: ${volChange > 0 ? "+" : ""}${volChange}% (recent vs avg) — ${volChange > 20 ? "accelerating" : volChange < -20 ? "drying up" : "stable"}.`);

  // Check for extended move
  const highestHigh = Math.max(...candles.map(c => c.high));
  const lowestLow = Math.min(...candles.map(c => c.low));
  const candleRangePct = ((highestHigh - lowestLow) / lowestLow * 100).toFixed(2);

  parts.push(`Candle range: ${candleRangePct}% (high ${highestHigh} → low ${lowestLow}).`);

  if (parseFloat(candleRangePct) > 20) {
    parts.push(`⚠️ EXTENDED MOVE: Price already ran ${candleRangePct}% in the entry window. Entry may have been late.`);
  }

  // Consecutive green candles
  let consecutiveGreen = 0;
  let maxGreen = 0;
  for (const c of candles) {
    if (c.close > c.open) { consecutiveGreen++; maxGreen = Math.max(maxGreen, consecutiveGreen); }
    else { consecutiveGreen = 0; }
  }
  if (maxGreen >= 4) {
    parts.push(`⚠️ ${maxGreen} consecutive green candles — pump was already mature at entry.`);
  }

  return parts.join("\n");
}

/**
 * Diagnose what happened during the position lifetime.
 */
function buildPositionDiagnosis(candles, deployEntry, poolMemoryItem) {
  const parts = [];
  if (candles.length < 2) return "Insufficient candle data.";

  const first = candles[0];
  const last = candles[candles.length - 1];
  const totalChangePct = ((last.close - first.open) / first.open * 100).toFixed(2);

  parts.push(`Price moved ${totalChangePct > 0 ? "+" : ""}${totalChangePct}% over ${candles.length} 5m candles (${(candles.length * 5)} minutes covered).`);

  // Find the crash candle
  let maxDropIdx = -1;
  let maxDropPct = 0;
  for (let i = 1; i < candles.length; i++) {
    const drop = ((candles[i].close - candles[i - 1].close) / candles[i - 1].close * 100);
    if (drop < maxDropPct) {
      maxDropPct = drop;
      maxDropIdx = i;
    }
  }

  if (maxDropIdx > 0) {
    const crashCandle = candles[maxDropIdx];
    const crashTs = new Date(crashCandle.time * 1000);
    parts.push(`🔻 Largest single-candle drop: ${maxDropPct.toFixed(2)}% at ${crashTs.toISOString()}.`);
    parts.push(`   Candle: open=${crashCandle.open}, high=${crashCandle.high}, low=${crashCandle.low}, close=${crashCandle.close}, volume=${crashCandle.volume}`);

    // Volume spike on crash?
    const avgVol = candles.reduce((s, c) => s + c.volume, 0) / candles.length;
    const volSpike = ((crashCandle.volume / avgVol - 1) * 100).toFixed(0);
    parts.push(`   Volume on crash candle: ${volSpike > 0 ? "+" : ""}${volSpike}% vs average — ${parseFloat(volSpike) > 100 ? "massive sell-off volume" : "normal volume (dump without panic)"}`);
  }

  // Trend phases
  let peakCandle = candles[0];
  let peakIdx = 0;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].high > peakCandle.high) { peakCandle = candles[i]; peakIdx = i; }
  }

  const peakPct = ((peakCandle.high - first.open) / first.open * 100).toFixed(2);
  const fromPeakPct = ((last.close - peakCandle.high) / peakCandle.high * 100).toFixed(2);
  const peakTs = new Date(peakCandle.time * 1000);

  parts.push(`📈 Peak at +${peakPct}% (${peakTs.toISOString()}, candle ${peakIdx + 1}/${candles.length}).`);
  parts.push(`📉 From peak to close: ${fromPeakPct}%.`);

  // How many candles were declining after peak?
  const declineCandles = candles.length - peakIdx;
  parts.push(`Decline phase: ${declineCandles} candles (${declineCandles * 5} minutes) of downtrend after peak.`);

  // Slow bleed analysis
  let downCandles = 0;
  let upCandles = 0;
  for (let i = 1; i < candles.length; i++) {
    const change = ((candles[i].close - candles[i - 1].close) / candles[i - 1].close * 100);
    if (change < 0) downCandles++; else upCandles++;
  }
  const downRatio = (downCandles / (candles.length - 1) * 100).toFixed(0);
  if (downRatio >= 60 && maxDropPct > -10) {
    parts.push(`🩸 SLOW BLEED: ${downRatio}% of candles declined with no single crash — ${downCandles} down vs ${upCandles} up.`);
  }

  const reason = (deployEntry.close_reason || "").toLowerCase();
  if (reason.includes("out of range")) {
    const dir = reason.includes("below") ? "below range (price dropped)" : reason.includes("above") ? "above range (price pumped)" : "unknown direction";
    parts.push(`🚪 OOR EXIT: Position closed because price went ${dir} — trailing TP was active but OOR timer forced the exit.`);
  }
  const isGenuineTrailing = reason.includes("peak") && reason.includes("dropped");
  if (isGenuineTrailing && deployEntry.pnl_pct < 0) {
    parts.push(`🔒 TRAILING TP LOCKED LOSS: Trailing stop triggered and exited at ${deployEntry.pnl_pct}% loss — position never recovered to breakeven.`);
  } else if ((reason.includes("trailing tp") || reason.includes("trailing")) && !reason.includes("out of range") && deployEntry.pnl_pct < 0) {
    parts.push(`🔒 TRAILING TP EXIT (vague reason): Close reason says "${deployEntry.close_reason}" but lacks peak/dropped details — LLM may have labeled this. Actual exit cause could be different.`);
  }

  // Compare to pool-memory snapshots
  const snapshots = poolMemoryItem.snapshots || [];
  const posStart = deployEntry.closed_at ? new Date(deployEntry.closed_at).getTime() : null;
  // We don't have deploy time in this context easily, use snapshots as proxy

  return parts.join("\n");
}

/**
 * Build prevention recommendations.
 */
function buildPrevention(entryCandles, entrySupertrend, positionCandles, deployEntry, poolMemoryItem, userConfig) {
  const recommendations = [];

  // Entry-signal issues
  const flipDir = entrySupertrend?.lastFlipDirection;
  if (flipDir !== "BULLISH") {
    recommendations.push({
      category: "ENTRY_SIGNAL",
      severity: "HIGH",
      issue: flipDir === "BEARISH"
        ? `Entry taken after last supertrend flip was BEARISH`
        : `Entry taken with no bullish supertrend flip (direction=${entrySupertrend?.direction ?? "?"})`,
      fix: "Enforce hard rule: require lastFlipDirection=BULLISH before any deploy. Add this as a pre-deploy gate in the screening flow.",
    });
  }

  // Late entry / extended move — check both net change AND candle range
  if (entryCandles.length >= 3) {
    const first = entryCandles[0];
    const last = entryCandles[entryCandles.length - 1];
    const runPct = ((last.close - first.open) / first.open * 100);
    const maxAllowed = userConfig?.maxPreEntryChangePct ?? 15;

    if (runPct > maxAllowed) {
      recommendations.push({
        category: "ENTRY_TIMING",
        severity: "HIGH",
        issue: `Price already moved +${runPct.toFixed(1)}% across entry window — late entry into mature pump`,
        fix: `Max pre-entry price-change is ${maxAllowed}%. Skip if price moved beyond that in the lookback window. Wait for a pullback + re-flip instead of chasing.`,
      });
    }

    // Extended range detection — high-to-low range matters even if net change is small
    const highestHigh = Math.max(...entryCandles.map(c => c.high));
    const lowestLow = Math.min(...entryCandles.map(c => c.low));
    const rangePct = ((highestHigh - lowestLow) / lowestLow * 100);
    const maxRangeAllowed = userConfig?.maxPreEntryRangePct ?? 20;

    if (rangePct > maxRangeAllowed && runPct <= maxAllowed) {
      recommendations.push({
        category: "ENTRY_TIMING",
        severity: "HIGH",
        issue: `Price range was ${rangePct.toFixed(1)}% (high ${highestHigh} → low ${lowestLow}) but net change only ${runPct.toFixed(1)}% — extended range means entry was late; price already did its move and is just ranging`,
        fix: `Max pre-entry candle-range is ${maxRangeAllowed}%. When range is high but net change is low, the pump already happened — wait for a clean breakout + re-flip instead of entering at the top of a stalled move.`,
      });
    }
  }

  // Consecutive green candles = mature pump
  let maxGreen = 0;
  let consec = 0;
  for (const c of entryCandles) {
    if (c.close > c.open) { consec++; maxGreen = Math.max(maxGreen, consec); }
    else { consec = 0; }
  }
  if (maxGreen >= 4) {
    recommendations.push({
      category: "PUMP_MATURITY",
      severity: "MEDIUM",
      issue: `${maxGreen} consecutive green candles before entry — pump was extended`,
      fix: "Add consecutive-candle counter to entry signal. Skip if >3 consecutive same-direction candles. Wait for at least 1 pullback candle before deploying.",
    });
  }

  // Volatility mismatch
  const vol = deployEntry.volatility_at_deploy;
  if (vol && vol > 8) {
    recommendations.push({
      category: "VOLATILITY",
      severity: "MEDIUM",
      issue: `High volatility (${vol}%) at deploy — price swings exceeded range protection`,
      fix: "Add volatility-based range scaling: for vol >8%, widen bins or reduce deploy size. Consider skip threshold for vol >12%.",
    });
  }

  // Crash pattern during position
  if (positionCandles.length >= 3) {
    let maxDrop = 0;
    for (let i = 1; i < positionCandles.length; i++) {
      const drop = ((positionCandles[i].close - positionCandles[i - 1].close) / positionCandles[i - 1].close * 100);
      if (drop < maxDrop) maxDrop = drop;
    }

    if (maxDrop < -10) {
      recommendations.push({
        category: "CRASH_DETECTION",
        severity: "HIGH",
        issue: `Single-candle crash of ${maxDrop.toFixed(1)}% during position — no emergency exit triggered`,
        fix: "Add real-time crash detection: if 5m candle drops >10%, immediately evaluate close. Current trailing TP only checks PnL % but doesn't react to speed of decline.",
      });
    }

    // Slow bleed detection — sustained downtrend without a single dramatic crash
    // Criteria: no single candle drops >10%, but position still loses >5%
    if (maxDrop > -10 && deployEntry.pnl_pct < -5) {
      // Count candles going down more than up
      let downCandles = 0;
      let upCandles = 0;
      let cumulativeDown = 0;
      for (let i = 1; i < positionCandles.length; i++) {
        const change = ((positionCandles[i].close - positionCandles[i - 1].close) / positionCandles[i - 1].close * 100);
        if (change < 0) { downCandles++; cumulativeDown += change; }
        else { upCandles++; }
      }
      const downRatio = downCandles / (positionCandles.length - 1);
      if (downRatio >= 0.6) {
        recommendations.push({
          category: "SLOW_BLEED",
          severity: "HIGH",
          issue: `Slow bleed: ${Math.round(downRatio * 100)}% of candles declined, no single crash candle but position lost ${deployEntry.pnl_pct}% — death by a thousand cuts`,
          fix: "Add underwater PnL checkpoint: if position is below -X% for N consecutive candles with no recovery, force close. E.g., if pnl < -5% and 3+ candles all red → exit before it gets worse.",
        });
      }
    }
  }

  // Trailing TP locking in losses — only flag when trailing TP was the actual cause
  // A genuine trailing TP exit contains "peak → current (dropped)" from state.js
  // Close reasons like "Out of range" or vague "Trailing TP exit" from the LLM are not pure trailing exits
  const reason = (deployEntry.close_reason || "").toLowerCase();
  const isGenuineTrailing = reason.includes("peak") && reason.includes("dropped");
  if (isGenuineTrailing && deployEntry.pnl_pct < 0) {
    recommendations.push({
      category: "TRAILING_TP_LOSS",
      severity: "HIGH",
      issue: `Trailing TP locked in a ${deployEntry.pnl_pct}% loss — trail activated on a losing position and exited underwater`,
      fix: "Add minimum-profit gate to trailing TP: don't activate trail until position is at least +X% in profit, or set a higher breakeven floor. A trailing stop on a losing position is just a slower stop-loss.",
    });
  } else if ((reason.includes("trailing tp") || reason.includes("trailing")) && !reason.includes("out of range") && deployEntry.pnl_pct < 0) {
    recommendations.push({
      category: "VAGUE_EXIT_REASON",
      severity: "MEDIUM",
      issue: `Close reason "${deployEntry.close_reason}" mentions trailing TP but lacks peak/dropped details — likely LLM-crafted rather than system-detected exit`,
      fix: "LLM should use the exact exit reason from the system. Review the position action flow to ensure the close reason reflects the actual trigger (OOR, SL, low yield, etc.) rather than a generic label.",
    });
  }

  // OOR exit — position closed because price left the bin range
  const isOOR = reason.includes("out of range");
  if (isOOR) {
    const oorDir = reason.includes("below") ? "below" : reason.includes("above") ? "above" : "unknown";
    recommendations.push({
      category: "OOR_EXIT",
      severity: "HIGH",
      issue: `Position closed because price went out of range (${oorDir}) — trailing TP was likely active but OOR timer forced the exit`,
      fix: "Review bin range width vs volatility at entry. If OOR exits are frequent, widen ranges or reduce deploy size for volatile pools. Consider that trailing TP + OOR combo can trap positions — trailing needs profit but OOR forces exit regardless.",
    });
  }

  // Pool memory repeat offender — only if losses share a consistent root cause
  if (poolMemoryItem.deploys && poolMemoryItem.deploys.length >= 3) {
    const deploys = poolMemoryItem.deploys;
    const losses = deploys.filter(d => d.pnl_pct < 0);
    const lossRate = losses.length / deploys.length;

    // Need at least 3 deploys AND >50% loss rate to analyze
    if (lossRate > 0.5) {
      // Semantic bucketing of close reasons — normalize variants like
      // "Trailing TP: Out of range" vs "⚡ Trailing TP: Low yield"
      function bucketReason(reason) {
        if (!reason) return "unknown";
        const r = reason.toLowerCase();
        if (r.includes("low yield") || r.includes("fee/tvl")) return "low_yield";
        if (r.includes("out of range")) return "out_of_range";
        if (r.includes("rule 3") || r.includes("above range") || r.includes("pumped")) return "pumped_oor";
        if (r.includes("stop loss") || r.includes("rule 1")) return "stop_loss";
        if (r.includes("slow bleed") || r.includes("1c")) return "slow_bleed";
        if (r.includes("rule 2") || r.includes("take profit")) return "take_profit";
        if (r.includes("crash") || r.includes("1b")) return "crash";
        if (r.includes("trailing tp") || r.includes("trailing")) return "trailing";
        if (r.includes("ta_exit")) return "ta_exit";
        if (r.includes("out of range") || r.includes("oor")) return "oor";
        if (r.includes("slow bleed")) return "slow_bleed";
        if (r.includes("agent decision") || r === "exit" || r === "unknown") return "vague";
        return "other";
      }

      // Group losses by semantic bucket
      const bucketMap = new Map();
      for (const l of losses) {
        const bucket = bucketReason(l.close_reason);
        bucketMap.set(bucket, (bucketMap.get(bucket) || 0) + 1);
      }

      // Find dominant failure mode
      let dominantBucket = null;
      let dominantCount = 0;
      for (const [bucket, count] of bucketMap) {
        if (count > dominantCount) {
          dominantCount = count;
          dominantBucket = bucket;
        }
      }

      const patternStrength = dominantCount / losses.length;

      // Only recommend cooldown if there's a consistent failure pattern
      // (≥2/3 of losses share the same root cause)
      if (patternStrength >= 0.67 && dominantCount >= 2) {
        const reasons = [...bucketMap.entries()].map(([b, c]) => `${b}×${c}`).join(", ");
        recommendations.push({
          category: "POOL_COOLDOWN",
          severity: "HIGH",
          issue: `${poolMemoryItem.name} has ${(lossRate * 100).toFixed(0)}% loss rate across ${deploys.length} deploys — ${dominantCount}/${losses.length} losses share same root cause: "${dominantBucket}" (breakdown: ${reasons})`,
          fix: `Cooldown this pool for 24h. The repeated "${dominantBucket}" pattern suggests a structural mismatch with the current strategy, not random variance.`,
        });
      } else if (lossRate >= 0.75 && deploys.length >= 4) {
        // Very high loss rate with diverse failure modes → pool may be unsuitable
        const reasons = [...bucketMap.entries()].map(([b, c]) => `${b}×${c}`).join(", ");
        recommendations.push({
          category: "POOL_REVIEW",
          severity: "MEDIUM",
          issue: `${poolMemoryItem.name} has ${(lossRate * 100).toFixed(0)}% loss rate across ${deploys.length} deploys with diverse failure modes`,
          fix: `No single dominant failure pattern (breakdown: ${reasons}). Review pool characteristics — may be inherently unsuitable for current strategy.`,
        });
      }
      // Otherwise: mixed results or insufficient sample — variance is expected
    }
  }

  if (recommendations.length === 0) {
    recommendations.push({
      category: "GENERAL",
      severity: "LOW",
      issue: "No specific pattern identified — may be normal market variance",
      fix: "Review after more data points. Consider this a cost of doing business if within expected loss parameters.",
    });
  }

  return recommendations;
}

/**
 * Compact candle for display (remove redundant fields).
 */
function compactCandle(c) {
  return {
    time: new Date(c.time * 1000).toISOString(),
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
    v: c.volume,
  };
}

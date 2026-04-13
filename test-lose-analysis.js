import fs from "fs";
import { analyzeLosingPosition } from "./tools/lose-analysis.js";

const poolMemory = JSON.parse(fs.readFileSync("./pool-memory.json", "utf8"));
const userConfig = JSON.parse(fs.readFileSync("./user-config.json", "utf8"));
// Harry's strategy uses 5m entry signal — override config for accurate reconstruction
userConfig.entry_signal_timeframe = "5m";

// Accept pool address as CLI arg, default to Harry-SOL
const poolKey = process.argv[2] || "GcDQjXZBTUAD93KuucoVj3okgGxrSgDxps7AsSZFGx9M";
const poolItem = poolMemory[poolKey];
if (!poolItem) { console.error(`Pool not found: ${poolKey}`); process.exit(1); }

// Accept optional min USD loss threshold (default -1 to capture >$1 losses)
const minLossUsd = parseFloat(process.argv[3] ?? "-1");
const losingDeploy = poolItem.deploys.filter(d => d.pnl_pct < 0 && (d.pnl_usd ?? -Infinity) <= minLossUsd).sort((a,b) => a.pnl_usd - b.pnl_usd)[0];
if (!losingDeploy) { console.error(`No qualifying losing deploy found for pool ${poolKey}`); process.exit(1); }

console.log(`Pool: ${poolItem.name} (${poolKey})`);
console.log(`PnL: ${losingDeploy.pnl_pct}% ($${losingDeploy.pnl_usd})`);
console.log(`Held: ${losingDeploy.minutes_held}m`);
console.log(`Reason: ${losingDeploy.close_reason}`);
console.log("");

const result = await analyzeLosingPosition({
  poolMemoryItem: poolItem,
  deployEntry: losingDeploy,
  poolAddress: poolKey,
  userConfig,
});

console.log("═══ REPORT ═══\n");
console.log(`Pool: ${result.pool_name} (${result.pool_address.slice(0,12)}...)`);
console.log(`PnL: ${result.pnl_pct}% ($${result.pnl_usd}) | Held: ${result.minutes_held}m`);
console.log(`Close: ${result.close_reason}`);
console.log("");

// Entry
console.log("── ENTRY (what screener saw) ──");
console.log(`Timeframe: ${result.entry_analysis.timeframe} | Candles: ${result.entry_analysis.candles_fetched}`);
if (result.entry_analysis.candles.length > 0) {
  for (const c of result.entry_analysis.candles) {
    const bar = c.c >= c.o ? "🟢" : "🔴";
    const chg = (((c.c - c.o) / c.o) * 100).toFixed(2);
    console.log(`  ${bar} ${c.time.slice(11,16)}  O:${c.o} C:${c.c} (${chg>0?"+":""}${chg}%)  Vol:${c.v.toFixed(0)}`);
  }
}
if (result.entry_analysis.supertrend) {
  const st = result.entry_analysis.supertrend;
  console.log(`\n  Supertrend: ${st.trend} | ${st.direction} | Flipped: ${st.flipped ? "✅" : "❌"} | lastFlip=${st.lastFlipDirection ?? "none"}`);
  console.log(`  Last candle: ${result.entry_analysis.candles[result.entry_analysis.candles.length-1].c >= result.entry_analysis.candles[result.entry_analysis.candles.length-1].o ? "🟢" : "🔴"}`);
}
console.log(`\n  Diagnosis:\n${result.entry_analysis.diagnosis}`);

// Position
console.log("\n── POSITION (what happened) ──");
if (result.position_analysis.key_candles.length > 0) {
  const candles = result.position_analysis.key_candles;
  const show = new Set();
  for (let i = 0; i < Math.min(5, candles.length); i++) show.add(i);
  for (let i = Math.max(0, candles.length - 5); i < candles.length; i++) show.add(i);
  for (let i = 1; i < candles.length; i++) {
    const d = ((candles[i].c - candles[i-1].c) / candles[i-1].c * 100);
    if (Math.abs(d) > 3) show.add(i);
  }
  for (const i of [...show].sort((a,b) => a-b)) {
    const c = candles[i];
    const chg = ((c.c - c.o) / c.o * 100).toFixed(2);
    const prevD = i > 0 ? ((c.c - candles[i-1].c) / candles[i-1].c * 100).toFixed(2) : "0";
    const bar = c.c >= c.o ? "🟢" : "🔴";
    const mark = Math.abs(parseFloat(prevD)) > 3 ? " 🔥" : "";
    console.log(`  ${bar} ${c.time.slice(11,16)}${mark}  O:${c.o} C:${c.c} (${chg>0?"+":""}${chg}%)  Δ=${prevD>0?"+":""}${prevD}%  Vol:${c.v.toFixed(0)}`);
  }
}
console.log(`\n  Diagnosis:\n${result.position_analysis.diagnosis}`);

// Prevention
console.log("\n── PREVENTION ──");
for (const rec of result.prevention) {
  const icon = rec.severity === "HIGH" ? "🔴" : rec.severity === "MEDIUM" ? "🟡" : "🟢";
  console.log(`  ${icon} [${rec.severity}] ${rec.category}`);
  console.log(`     Issue: ${rec.issue}`);
  console.log(`     Fix:   ${rec.fix}`);
  console.log("");
}

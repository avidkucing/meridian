import fs from "fs";
import { analyzeLosingPosition } from "./tools/lose-analysis.js";

const poolMemory = JSON.parse(fs.readFileSync("./pool-memory-losing.json", "utf8"));
const userConfig = JSON.parse(fs.readFileSync("./user-config.json", "utf8"));
userConfig.entry_signal_timeframe = "5m";

const results = [];

for (const poolKey of Object.keys(poolMemory)) {
  const poolItem = poolMemory[poolKey];
  if (!poolItem.deploys || poolItem.deploys.length === 0) continue;

  const losingDeploys = poolItem.deploys
    .filter(d => d.pnl_pct < 0)
    .sort((a, b) => a.pnl_usd - b.pnl_usd);

  for (const losingDeploy of losingDeploys) {
    const result = await analyzeLosingPosition({
      poolMemoryItem: poolItem,
      deployEntry: losingDeploy,
      poolAddress: poolKey,
      userConfig,
    });

    results.push(result);
    console.log(`${poolItem.name} | PnL: ${result.pnl_pct}% ($${result.pnl_usd}) | Held: ${result.minutes_held}m`);
  }
}

fs.writeFileSync("./test-lose-analysis.json", JSON.stringify(results, null, 2), "utf8");
console.log(`\nWrote ${results.length} analyses to test-lose-analysis.json`);

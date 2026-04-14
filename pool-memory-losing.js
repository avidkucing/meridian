import fs from "fs";

const MIN_LOSS_USD = parseFloat(process.argv[2] ?? "1");
const INPUT = "./pool-memory.json";
const OUTPUT = "./pool-memory-losing.json";

if (isNaN(MIN_LOSS_USD) || MIN_LOSS_USD <= 0) {
  console.error("Usage: node extract-losing.js <min_loss_usd>");
  console.error("  Extracts losing deploys with loss >= $<min_loss_usd> into pool-memory-losing.json");
  process.exit(1);
}

const poolMemory = JSON.parse(fs.readFileSync(INPUT, "utf8"));
const losing = {};
let totalPools = 0;
let totalDeploys = 0;

for (const key of Object.keys(poolMemory)) {
  const pool = poolMemory[key];
  if (!pool.deploys || pool.deploys.length === 0) continue;

  const losingDeploys = pool.deploys.filter(d => d.pnl_pct < 0 && (d.pnl_usd ?? -Infinity) <= -MIN_LOSS_USD);
  if (losingDeploys.length === 0) continue;

  losing[key] = { ...pool, deploys: losingDeploys };
  totalPools++;
  totalDeploys += losingDeploys.length;
}

fs.writeFileSync(OUTPUT, JSON.stringify(losing, null, 2), "utf8");
console.log(`Extracted ${totalDeploys} losing deploys (>= $${MIN_LOSS_USD}) across ${totalPools} pools → ${OUTPUT}`);

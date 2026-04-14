import fs from "fs";

const DAYS = parseInt(process.argv[2], 10);
if (!DAYS || DAYS < 1) {
  console.error("Usage: node clean-pool-memory.js <days>");
  console.error("  Removes deploy entries older than N days from pool-memory.json");
  process.exit(1);
}

const PATH = "./pool-memory.json";
const poolMemory = JSON.parse(fs.readFileSync(PATH, "utf8"));
const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;

let totalRemoved = 0;
let poolsCleaned = 0;

for (const key of Object.keys(poolMemory)) {
  const pool = poolMemory[key];
  if (!pool.deploys || pool.deploys.length === 0) continue;

  const before = pool.deploys.length;
  pool.deploys = pool.deploys.filter(d => {
    if (!d.closed_at) return false;
    return new Date(d.closed_at).getTime() >= cutoff;
  });

  const removed = before - pool.deploys.length;
  totalRemoved += removed;
  if (removed > 0) poolsCleaned++;
}

fs.writeFileSync(PATH, JSON.stringify(poolMemory, null, 2), "utf8");
console.log(`Cleaned ${totalRemoved} old deploys across ${poolsCleaned} pools (kept last ${DAYS} days)`);

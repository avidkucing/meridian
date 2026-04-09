/**
 * pool-liquidity.js — Fetch and display existing liquidity across pool bins.
 * Shows the real volume profile: where other LPs have placed their SOL.
 */

import { normalizeMint } from "./wallet.js";
import { Connection, PublicKey } from "@solana/web3.js";

// Lazy SDK loader
let _DLMM = null;
async function getDLMM() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
  }
  return _DLMM;
}

// Lazy connection — mirrors dlmm.js pattern
let _connection = null;
function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
  return _connection;
}

const poolCache = new Map();

async function getPool(poolAddress) {
  const key = poolAddress.toString();
  if (!poolCache.has(key)) {
    const DLMM = await getDLMM();
    const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
    poolCache.set(key, pool);
  }
  return poolCache.get(key);
}

setInterval(() => poolCache.clear(), 5 * 60 * 1000);

/**
 * Fetch the current liquidity distribution across all bins in the pool.
 * Shows where other LPs have placed their SOL — the real volume profile.
 *
 * @param {string} pool_address - Pool address
 * @param {number} rangeBelow - Bins below active to include (default: 50)
 * @param {number} rangeAbove - Bins above active to include (default: 50)
 * @returns {Object} { activeBinId, binStep, currentPrice, bins: Array, summary }
 */
export async function getPoolLiquidity({ pool_address, rangeBelow = 50, rangeAbove = 50 }) {
  pool_address = normalizeMint(pool_address);
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();
  const activeBinId = activeBin.binId;
  const binStep = pool.lbPair.binStep;
  const currentPrice = pool.fromPricePerLamport(Number(activeBin.price));

  const minBinId = activeBinId - rangeBelow;
  const maxBinId = activeBinId + rangeAbove;

  // Fetch bin arrays for the range — SDK returns Bin[] with liquidity data
  const binsLiquidity = await pool.getBinsBetweenLowerAndUpperBound(minBinId, maxBinId);

  const solDecimals = pool.lbPair.tokenYDecimals;
  const lamportsPerSol = Math.pow(10, solDecimals);

  let totalSol = 0;
  let maxBinSol = 0;
  let maxBinIdResult = null;

  const bins = binsLiquidity.map((bin) => {
    const solAmount = bin.amountY / lamportsPerSol;
    const price = pool.fromPricePerLamport(Number(bin.price));
    totalSol += solAmount;
    if (solAmount > maxBinSol) {
      maxBinSol = solAmount;
      maxBinIdResult = bin.binId;
    }
    return {
      binId: bin.binId,
      price: parseFloat(price.toFixed(8)),
      sol: parseFloat(solAmount.toFixed(4)),
      amountX: bin.amountX,
      amountY: bin.amountY,
      isActive: bin.binId === activeBinId,
    };
  });

  // Sort by bin ID (price ascending)
  bins.sort((a, b) => a.binId - b.binId);

  const activeBinData = bins.find((b) => b.isActive);
  const belowActive = bins.filter((b) => b.binId < activeBinId);
  const aboveActive = bins.filter((b) => b.binId > activeBinId);
  const solBelow = belowActive.reduce((s, b) => s + b.sol, 0);
  const solAbove = aboveActive.reduce((s, b) => s + b.sol, 0);

  return {
    pool_address,
    activeBinId,
    binStep,
    currentPrice: parseFloat(currentPrice.toFixed(8)),
    bins,
    summary: {
      totalSol: parseFloat(totalSol.toFixed(4)),
      activeBin: activeBinData ? { binId: activeBinId, sol: activeBinData.sol } : null,
      maxLiquidityBin: maxBinIdResult ? { binId: maxBinIdResult, sol: parseFloat(maxBinSol.toFixed(4)) } : null,
      solBelow: parseFloat(solBelow.toFixed(4)),
      solAbove: parseFloat(solAbove.toFixed(4)),
      pctBelowActive: totalSol > 0 ? parseFloat((solBelow / totalSol * 100).toFixed(2)) : 0,
      pctAboveActive: totalSol > 0 ? parseFloat((solAbove / totalSol * 100).toFixed(2)) : 0,
      emptyBins: bins.filter((b) => b.sol === 0).length,
      range: { minBinId, maxBinId, rangeBelow, rangeAbove },
    },
  };
}

/**
 * Format pool liquidity profile for display.
 */
export function formatPoolLiquidity(data) {
  const lines = [
    `💧 Pool Liquidity Profile — ${data.pool_address.slice(0, 8)}`,
    ``,
    `Current Price: ${data.currentPrice} | Bin Step: ${data.binStep}`,
    `Active Bin: ${data.activeBinId}`,
    ``,
    `📊 Total Liquidity in Range: ${data.summary.totalSol} SOL`,
    `   🔻 Below active (${data.summary.pctBelowActive}%): ${data.summary.solBelow} SOL`,
    `   🔺 Above active (${data.summary.pctAboveActive}%): ${data.summary.solAbove} SOL`,
    ``,
  ];

  if (data.summary.maxLiquidityBin) {
    lines.push(`   Max liquidity bin: ${data.summary.maxLiquidityBin.binId} (${data.summary.maxLiquidityBin.sol} SOL)`);
  }

  if (data.summary.activeBin) {
    lines.push(`   Active bin: ${data.summary.activeBin.binId} (${data.summary.activeBin.sol} SOL)`);
  }

  lines.push(`   Empty bins: ${data.summary.emptyBins}/${data.bins.length}`);
  lines.push(``);
  lines.push(`📋 Distribution (${data.bins.length} bins):`);
  lines.push(`   Bin ID  |  Price      |  SOL       |  %`);
  lines.push(`   --------|-------------|------------|--------`);

  // Show top 5 bins by liquidity
  const topBins = [...data.bins].filter((b) => b.sol > 0).sort((a, b) => b.sol - a.sol).slice(0, 5);
  for (const bin of topBins) {
    const marker = bin.isActive ? " ◀ ACTIVE" : bin.binId === data.summary.maxLiquidityBin?.binId ? " ◀ MAX" : "";
    const pct = data.summary.totalSol > 0 ? (bin.sol / data.summary.totalSol * 100).toFixed(2) : "0.00";
    lines.push(`   ${String(bin.binId).padStart(6)} | ${String(bin.price).padStart(11)} | ${bin.sol.toFixed(4).padStart(10)} | ${pct}%${marker}`);
  }

  return lines.join("\n");
}

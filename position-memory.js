/**
 * Position Memory — per-position enriched history with bin utilization.
 *
 * Stores in position-memory.json keyed by position address:
 *   - entry snapshot (captured at deploy)
 *   - exit snapshot (captured at close)
 *   - bin utilization metrics
 *   - normalized exit reason
 *   - live snapshots accumulated during the position's lifetime
 *
 * Coexists with lessons.json (learning) and pool-memory.json (pool-level).
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const FILE = repoPath("position-memory.json");

// ─── Persistence ────────────────────────────────────────────────

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { positions: {} };
  }
}

function save(db) {
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

// ─── Entry ──────────────────────────────────────────────────────

/**
 * Record the entry snapshot when a position is deployed.
 * Called from index.js after trackPosition().
 *
 * @param {Object} data - Position entry data
 * @param {string} data.position - Position address
 * @param {string} data.pool - Pool address
 * @param {string} data.pool_name - Pair name
 * @param {Object} data.tracked - Full tracked position from state.json
 * @param {Object} data.signal_snapshot - Entry market signal snapshot
 */
export function recordPositionEntry({ position, pool, pool_name, tracked, signal_snapshot, entry_price }) {
  const db = load();
  db.positions[position] = {
    position,
    pool,
    pool_name,
    entry: {
      deployed_at: tracked.deployed_at,
      active_bin: tracked.active_bin_at_deploy,
      bin_range: tracked.bin_range,
      bin_step: tracked.bin_step,
      volatility: tracked.volatility,
      fee_tvl_ratio: tracked.fee_tvl_ratio,
      organic_score: tracked.organic_score,
      initial_value_usd: tracked.initial_value_usd,
      signal_snapshot: signal_snapshot || null,
      entry_mcap: tracked.entry_mcap ?? null,
      entry_tvl: tracked.entry_tvl ?? null,
      entry_volume: tracked.entry_volume ?? null,
      strategy: tracked.strategy ?? null,
      entry_price: entry_price ?? null,
    },
    exit: null,
    bin_utilization: null,
    exit_reason: null,
    snapshots: [],
  };
  save(db);
}

// ─── Snapshots ─────────────────────────────────────────────────

/**
 * Append a live snapshot to the position's snapshot array.
 * Called from pool-memory.js recordPositionSnapshot() — every management cycle.
 *
 * @param {string} position_address
 * @param {Object} snapshot - { ts, pnl_pct, pnl_usd, in_range, active_bin, unclaimed_fees_usd, minutes_out_of_range, age_minutes }
 */
export function appendSnapshot(position_address, snapshot) {
  const db = load();
  const pos = db.positions[position_address];
  if (!pos || pos.exit) return; // don't append after closed
  pos.snapshots.push({
    ts: new Date().toISOString(),
    pnl_pct: snapshot.pnl_pct ?? null,
    pnl_usd: snapshot.pnl_usd ?? null,
    in_range: snapshot.in_range ?? null,
    active_bin: snapshot.active_bin ?? null,
    unclaimed_fees_usd: snapshot.unclaimed_fees_usd ?? null,
    minutes_out_of_range: snapshot.minutes_out_of_range ?? null,
    age_minutes: snapshot.age_minutes ?? null,
  });
  save(db);
}

// ─── Exit ───────────────────────────────────────────────────────

/**
 * Normalize freeform close_reason to structured exit_reason.type.
 * Mirrors the logic used in pool-memory.js isOorCloseReason / isAdjustedWinRateExcludedReason.
 */
function normalizeExitReason(reason, action) {
  if (action && action !== "NO_ACTION") return action; // already structured

  const text = String(reason || "").toLowerCase();
  if (text.includes("stop loss"))   return "STOP_LOSS";
  if (text.includes("trailing"))    return "TRAILING_TP";
  if (text.includes("take profit")) return "TAKE_PROFIT";
  if (text.includes("out of range") || text.includes("oor") || text.includes("pumped far above")) return "OUT_OF_RANGE";
  if (text.includes("low yield"))   return "LOW_YIELD";
  if (text.includes("max loss hold")) return "MAX_LOSS_HOLD";
  return "MANUAL";
}

/**
 * Compute bin utilization from entry, exit, and snapshot data.
 */
function computeBinUtilization(entry, exit, snapshots) {
  if (!entry?.bin_range || !entry?.active_bin || !exit?.active_bin) return null;

  const total_range = entry.bin_range.max - entry.bin_range.min; // bins deployed
  if (!total_range) return null;

  // All observed active bins
  const observedBins = [
    entry.active_bin,
    exit.active_bin,
    ...(snapshots || []).map((s) => s.active_bin).filter(Boolean),
  ];

  const max_bin = Math.max(...observedBins);
  const min_bin = Math.min(...observedBins);
  const bins_crossed = max_bin - min_bin;
  const utilization_pct = Math.round((bins_crossed / total_range) * 10000) / 100; // 2dp

  const entryBin = entry.active_bin;
  const exitBin = exit.active_bin;
  const direction =
    exitBin > entryBin ? "above" : exitBin < entryBin ? "below" : "none";

  return {
    bins_deployed: total_range,
    bins_crossed,
    max_bin,
    min_bin,
    utilization_pct,
    direction,
  };
}

/**
 * Record the exit snapshot when a position is closed.
 * Called from state.js recordClose().
 *
 * @param {string} position_address
 * @param {string} reason - The detailed freeform reason string
 * @param {string} action - The structured action from updatePnlAndCheckExits (or null)
 * @param {Object} exit_data - { active_bin, pnl_pct, pnl_usd, final_value_usd, fees_earned_usd, minutes_in_range, minutes_held, signal_snapshot }
 */
export function recordPositionExit(position_address, reason, action, exit_data) {
  const db = load();
  const pos = db.positions[position_address];
  if (!pos) {
    log("position_memory_warn", `No entry found for ${position_address} when closing`);
    return;
  }

  const authoritativeInitialUsd = Number(exit_data.initial_value_usd);
  if (Number.isFinite(authoritativeInitialUsd) && authoritativeInitialUsd > 0) {
    pos.entry.initial_value_usd = authoritativeInitialUsd;
  }
  const authoritativeInitialSol = Number(exit_data.initial_value_sol);
  if (Number.isFinite(authoritativeInitialSol) && authoritativeInitialSol > 0) {
    pos.entry.initial_value_sol = authoritativeInitialSol;
  }

  pos.exit = {
    closed_at: new Date().toISOString(),
    active_bin: exit_data.active_bin ?? null,
    pnl_pct: exit_data.pnl_pct ?? null,
    peak_pnl_pct: exit_data.peak_pnl_pct ?? null,
    trough_pnl_pct: exit_data.trough_pnl_pct ?? null,
    pnl_usd: exit_data.pnl_usd ?? null,
    pnl_sol: exit_data.pnl_sol ?? null,
    initial_value_usd: Number.isFinite(authoritativeInitialUsd) && authoritativeInitialUsd > 0 ? authoritativeInitialUsd : null,
    initial_value_sol: exit_data.initial_value_sol ?? null,
    final_value_usd: exit_data.final_value_usd ?? null,
    final_value_sol: exit_data.final_value_sol ?? null,
    fees_earned_usd: exit_data.fees_earned_usd ?? null,
    fees_earned_sol: exit_data.fees_earned_sol ?? null,
    minutes_in_range: exit_data.minutes_in_range ?? null,
    minutes_held: exit_data.minutes_held ?? null,
    signal_snapshot: exit_data.signal_snapshot || null,
  };

  pos.exit_reason = {
    type: normalizeExitReason(reason, action),
    detail: reason || "agent decision",
  };

  pos.bin_utilization = computeBinUtilization(pos.entry, pos.exit, pos.snapshots);

  save(db);
}

/**
 * Patch the already-recorded exit with the ground-truth on-chain SOL delta.
 * Called from tools/executor.js after the full close sequence — including any
 * leftover-token auto-swap — has finished, since that swap happens after
 * recordPositionExit() already ran and can't be known at that point.
 *
 * @param {string} position_address
 * @param {{ sol_delta: number|null, tx_count: number, failed_count: number }} onchain
 */
export function updatePositionExitOnchain(position_address, onchain) {
  const db = load();
  const pos = db.positions[position_address];
  if (!pos || !pos.exit) {
    log("position_memory_warn", `No exit record found for ${position_address} when patching on-chain PnL`);
    return;
  }
  pos.exit.onchain_pnl_sol = onchain?.sol_delta ?? null;
  pos.exit.onchain_tx_count = onchain?.tx_count ?? null;
  pos.exit.onchain_partial = (onchain?.failed_count ?? 0) > 0;
  pos.exit.onchain_reclaimable_rent_sol = onchain?.reclaimable_rent_sol ?? null;
  save(db);
}

// ─── Reads ─────────────────────────────────────────────────────

/**
 * Get the full position memory record.
 */
export function getPositionMemory(position_address) {
  const db = load();
  return db.positions[position_address] || null;
}

/**
 * Get all position memory records.
 */
export function getAllPositionMemory() {
  const db = load();
  return db.positions;
}

/**
 * Dashboard REST API — powers the Meridian web dashboard.
 *
 * Reads existing state files directly (no duplicated business logic):
 *   - Open positions:   state.json  (tracked positions)
 *   - Historical perf:  lessons.json (closed position records)
 *   - Pool snapshots:  pool-memory.json  (pool-memory.js getPoolMemory)
 */

import express from "express";
import fs from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getMyPositions } from "../../tools/dlmm.js";
import { getPoolMemory } from "../../pool-memory.js";

const __dirname2 = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname2, "..", "..");

// ─── Helpers ────────────────────────────────────────────────────

function round(v, d = 2) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null;
}

function repoPath(name) {
  return join(ROOT, name);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(repoPath(file), "utf8"));
  } catch {
    return null;
  }
}

function enrichWithState(positions) {
  const state = readJson("state.json");
  if (!state?.positions) return positions;

  return positions.map((p) => {
    const tracked = state.positions[p.position];
    return {
      ...p,
      entry_snapshot: tracked
        ? {
            active_bin_at_deploy: tracked.active_bin_at_deploy,
            bin_step:             tracked.bin_step,
            volatility:           tracked.volatility,
            fee_tvl_ratio:        tracked.fee_tvl_ratio,
            initial_fee_tvl_24h:  tracked.initial_fee_tvl_24h,
            organic_score:        tracked.organic_score,
            price_vs_ath_pct:     tracked.price_vs_ath_pct,
            initial_value_usd:    tracked.initial_value_usd,
            initial_value_sol:    tracked.initial_value_sol ?? null,
            entry_mcap:           tracked.entry_mcap,
            entry_tvl:            tracked.entry_tvl,
            entry_volume:         tracked.entry_volume,
            entry_holders:        tracked.entry_holders,
            signal_snapshot:       tracked.signal_snapshot,
            deployed_at:           tracked.deployed_at,
            bin_range:            tracked.bin_range,
            strategy:              tracked.strategy,
          }
        : null,
      out_of_range_since:       tracked?.out_of_range_since ?? null,
      out_of_range_direction:   tracked?.out_of_range_direction ?? null,
      total_fees_claimed_usd:   tracked?.total_fees_claimed_usd ?? 0,
      rebalance_count:          tracked?.rebalance_count ?? 0,
      notes:                    tracked?.notes ?? [],
      bin_utilization:          computeBinUtil(p),
    };
  });
}

function computeBinUtil(p) {
  const deployed = (p.upper_bin ?? 0) - (p.lower_bin ?? 0);
  if (!deployed || !p.active_bin || !p.active_bin_at_deploy) return null;
  const crossed = Math.abs(p.active_bin - p.active_bin_at_deploy);
  return {
    bins_deployed: deployed,
    bins_crossed: crossed,
    utilization_pct: Math.round((crossed / deployed) * 10000) / 100,
    direction: p.active_bin > p.active_bin_at_deploy ? "above"
             : p.active_bin < p.active_bin_at_deploy ? "below" : "none",
  };
}

// ─── Routes ─────────────────────────────────────────────────────

export const router = express.Router();

// GET /api/positions/current
// Returns open positions with PnL and entry snapshots.
// Tries RPC-based getMyPositions first; falls back to state.json directly
// so the dashboard always shows open positions even without wallet credentials.
export async function getCurrentPositions() {
  try {
    const result = await getMyPositions({ force: true, silent: true });
    if (Array.isArray(result?.positions) && result.positions.length > 0) {
      return enrichWithState(result.positions);
    }
  } catch { /* RPC unavailable */ }

  // Fallback: read tracked-but-not-closed positions directly from state.json
  const state = readJson("state.json");
  if (!state?.positions) return [];

  const open = Object.values(state.positions).filter((p) => !p.closed);
  return open.map((p) => ({
    position:           p.position,
    pool:              p.pool,
    pair:              p.pool_name || "?/?",
    base_mint:         p.base_mint || null,
    lower_bin:         p.bin_range?.min ?? null,
    upper_bin:         p.bin_range?.max ?? null,
    active_bin:        p.active_bin_at_deploy ?? null,
    in_range:          null,        // requires RPC to determine
    unclaimed_fees_usd: p.total_fees_claimed_usd ?? 0,
    total_value_usd:    null,        // requires RPC to compute
    pnl_usd:            null,
    pnl_sol:            null,
    pnl_pct:            null,
    pnl_pct_suspicious: false,
    fee_per_tvl_24h:    null,
    age_minutes:        p.deployed_at
      ? Math.floor((Date.now() - new Date(p.deployed_at).getTime()) / 60000)
      : null,
    minutes_out_of_range: 0,
    entry_snapshot: {
      active_bin_at_deploy: p.active_bin_at_deploy,
      bin_step:             p.bin_step,
      volatility:           p.volatility,
      fee_tvl_ratio:        p.fee_tvl_ratio,
      initial_fee_tvl_24h:  p.initial_fee_tvl_24h,
      organic_score:        p.organic_score,
      price_vs_ath_pct:     p.price_vs_ath_pct,
      initial_value_usd:    p.initial_value_usd,
            initial_value_sol:    p.initial_value_sol ?? null,
      entry_mcap:          p.entry_mcap,
      entry_tvl:           p.entry_tvl,
      entry_volume:        p.entry_volume,
      entry_holders:       p.entry_holders,
      signal_snapshot:      p.signal_snapshot,
      deployed_at:         p.deployed_at,
      bin_range:           p.bin_range,
      strategy:            p.strategy,
    },
    out_of_range_since:    p.out_of_range_since ?? null,
    out_of_range_direction: p.out_of_range_direction ?? null,
    total_fees_claimed_usd: p.total_fees_claimed_usd ?? 0,
    rebalance_count:        p.rebalance_count ?? 0,
    notes:                  p.notes ?? [],
    bin_utilization:  computeBinUtil(p),
  }));
}

router.get("/positions/current", async (_req, res) => {
  try {
    const positions = await getCurrentPositions();
    res.json({ ok: true, count: positions.length, positions });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/positions/history
// Reads from position-memory.json (new enriched records with bin utilization).
// Falls back to lessons.json for positions closed before this feature was added.
export async function getPositionHistory() {
  const posMem = readJson("position-memory.json")?.positions || {};
  const lessons = readJson("lessons.json")?.performance || [];

  // Build a map from position-memory.json
  const byAddr = {};
  for (const [addr, pos] of Object.entries(posMem)) {
    if (!pos.exit) continue; // skip open positions
    byAddr[addr] = pos;
  }

  const entries = [];

  // First: all position-memory records (enriched with bin_utilization + exit_reason)
  for (const [, pos] of Object.entries(byAddr)) {
    const pmFeesUsd   = round(pos.exit?.fees_earned_usd) ?? 0;
    const pmFinalUsd  = round(pos.exit?.final_value_usd);
    const pmInitUsd   = round(pos.entry?.initial_value_usd);
    const pmPnlUsd    = round(pos.exit?.pnl_usd);
    const pmFeesSol   = round(pos.exit?.fees_earned_sol, 6);
    const pmFinalSol  = round(pos.exit?.final_value_sol, 6);
    const pmInitSol   = round(pos.entry?.initial_value_sol ?? pos.exit?.initial_value_sol, 6);
    const pmPnlSol    = round(pos.exit?.pnl_sol, 6);

    entries.push({
      position:          pos.position,
      pool:              pos.pool,
      pool_name:         pos.pool_name,
      strategy:          pos.entry?.strategy,
      bin_range:         pos.entry?.bin_range,
      bin_step:          pos.entry?.bin_step,
      volatility:        pos.entry?.volatility,
      fee_tvl_ratio:     pos.entry?.fee_tvl_ratio,
      organic_score:     pos.entry?.organic_score,
      amount_sol:        pmInitSol,
      amount_x:          null,
      fees_earned_usd:   pmFeesUsd,
      fees_earned_sol:   pmFeesSol,
      pnl_usd:           pmPnlUsd,
      pnl_sol:           pmPnlSol,
      pnl_pct:           round(pos.exit?.pnl_pct),
      final_value_usd:   pmFinalUsd,
      final_value_sol:   pmFinalSol,
      initial_value_usd: pmInitUsd,
      initial_value_sol: pmInitSol,
      minutes_in_range:   pos.exit?.minutes_in_range,
      minutes_held:       pos.exit?.minutes_held,
      close_reason:       pos.exit_reason?.detail ?? null,
      exit_reason_type:   pos.exit_reason?.type ?? null,
      bin_utilization:     pos.bin_utilization ?? null,
      range_efficiency:   pos.exit?.minutes_held > 0
                            ? Math.round(((pos.exit?.minutes_in_range ?? 0) / pos.exit?.minutes_held) * 10000) / 100
                            : null,
      entry_snapshot: {
        active_bin_at_deploy: pos.entry?.active_bin,
        bin_step:            pos.entry?.bin_step,
        volatility:          pos.entry?.volatility,
        fee_tvl_ratio:       pos.entry?.fee_tvl_ratio,
        organic_score:       pos.entry?.organic_score,
        initial_value_usd:   pos.entry?.initial_value_usd,
        initial_value_sol:   pos.entry?.initial_value_sol ?? pos.exit?.initial_value_sol,
        signal_snapshot:     pos.entry?.signal_snapshot,
        deployed_at:         pos.entry?.deployed_at,
        bin_range:           pos.entry?.bin_range,
        strategy:            pos.entry?.strategy,
      },
      exit_signal_snapshot:  pos.exit?.signal_snapshot ?? null,
      deployed_at:        pos.entry?.deployed_at,
      closed_at:          pos.exit?.closed_at,
      trough_pnl_pct: (() => {
        if (pos.exit?.trough_pnl_pct != null) return round(pos.exit.trough_pnl_pct, 4);
        if (!pos.snapshots?.length) return null;
        const vals = pos.snapshots.map(s => s.pnl_pct).filter(v => v != null && Number.isFinite(v));
        return vals.length ? round(Math.min(...vals), 4) : null;
      })(),
      peak_pnl_pct: (() => {
        if (pos.exit?.peak_pnl_pct != null) return round(pos.exit.peak_pnl_pct, 4);
        if (!pos.snapshots?.length) return null;
        const vals = pos.snapshots.map(s => s.pnl_pct).filter(v => v != null && Number.isFinite(v));
        return vals.length ? round(Math.max(...vals), 4) : null;
      })(),
    });
  }

  // Then: lessons.json entries not already in position-memory.json
  const seen = new Set(Object.keys(byAddr));
  for (const p of lessons) {
    if (seen.has(p.position)) continue;
    seen.add(p.position);
    entries.push({
      position:          p.position,
      pool:              p.pool,
      pool_name:         p.pool_name,
      strategy:          p.strategy,
      bin_range:         p.bin_range,
      bin_step:           p.bin_step,
      volatility:         p.volatility,
      fee_tvl_ratio:      p.fee_tvl_ratio,
      organic_score:      p.organic_score,
      amount_sol:         round(p.amount_sol),
      amount_x:           round(p.amount_x),
      fees_earned_usd:    round(p.fees_earned_usd),
      fees_earned_sol:    round(p.fees_earned_sol),
      fee_earned_pct:     round(p.fee_earned_pct),
      pnl_usd:            round(p.pnl_usd),
      pnl_sol:            round(p.pnl_sol ?? (p.amount_sol != null && p.pnl_pct != null ? Number(p.amount_sol) * Number(p.pnl_pct) / 100 : null), 6),
      pnl_pct:            round(p.pnl_pct),
      final_value_usd:    round(p.final_value_usd),
      final_value_sol:    round(p.final_value_sol, 6),
      initial_value_usd:  round(p.initial_value_usd),
      initial_value_sol:  round(p.initial_value_sol ?? p.amount_sol, 6),
      minutes_in_range:   p.minutes_in_range,
      minutes_held:       p.minutes_held,
      close_reason:       p.close_reason,
      exit_reason_type:   null,
      bin_utilization:     null,
      range_efficiency:   p.range_efficiency,
      entry_snapshot: {
        active_bin_at_deploy: null,
        bin_step:            p.bin_step,
        volatility:          p.volatility,
        fee_tvl_ratio:       p.fee_tvl_ratio,
        organic_score:       p.organic_score,
        initial_value_usd:   p.initial_value_usd,
        initial_value_sol:   p.initial_value_sol ?? p.amount_sol,
        signal_snapshot:     p.signal_snapshot,
        deployed_at:         p.deployed_at,
        bin_range:           p.bin_range,
        strategy:            p.strategy,
      },
      deployed_at:        p.deployed_at,
      closed_at:          p.closed_at ?? p.recorded_at,
      trough_pnl_pct:     null,
      peak_pnl_pct:       null,
    });
  }

  // Sort newest first
  entries.sort((a, b) => (b.closed_at || "").localeCompare(a.closed_at || ""));
  return entries;
}

router.get("/positions/history", async (_req, res) => {
  try {
    const entries = await getPositionHistory();
    res.json({ ok: true, count: entries.length, positions: entries });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/pools/:pool/memory
// Returns pool-memory snapshots for a given pool
router.get("/pools/:pool/memory", async (req, res) => {
  try {
    const { pool } = req.params;
    const memory = await getPoolMemory({ pool_address: pool });
    res.json({ ok: true, pool, snapshots: memory.snapshots || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/health
// Basic health check
router.get("/health", async (_req, res) => {
  let wallet = null;
  try {
    const { getWallet } = await import("../../tools/wallet.js");
    wallet = getWallet().publicKey.toString();
  } catch { /* wallet not available */ }

  res.json({
    ok: true,
    uptime: process.uptime(),
    ts: Date.now(),
    wallet,
    dashboard_port: process.env.DASHBOARD_PORT || 3001,
  });
});

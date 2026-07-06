import type { CurrentPosition, EntrySnapshot, HistoryPosition } from "../types";
import { fmt, fmtAge, signed, signedSol, usd, sol } from "./format";

export type Field = [label: string, value: string | null];

function d(v: unknown): string | null {
  return v != null && v !== "" ? String(v) : null;
}
function pct(v: unknown, decimals = 2): string | null {
  return v != null ? Number(v).toFixed(decimals) + "%" : null;
}

// Mirrors buildExpandedRow/buildHistoryExpandedRow's entryFields in the old app.js.
export function buildEntryFields(
  entry: EntrySnapshot | null | undefined,
  opts: { deployedAt?: string | null; strategy?: string | null } = {},
): Field[] {
  const es = entry ?? {};
  const ess = (es.signal_snapshot ?? {}) as Record<string, unknown>;
  const deployedAt = opts.deployedAt ?? es.deployed_at;

  const fields: Field[] = [
    ["Deployed At", deployedAt ? new Date(deployedAt).toLocaleString() : null],
    ["Strategy", d(opts.strategy ?? es.strategy)],
    ["Initial Value USD", usd(es.initial_value_usd)],
    ["Initial Value SOL", sol(es.initial_value_sol)],
    ["Active Bin", d(es.active_bin_at_deploy)],
    ["Bin Step", d(es.bin_step)],
    ["Volatility", d(es.volatility)],
    ["Fee/TVL", es.fee_tvl_ratio != null ? es.fee_tvl_ratio.toFixed(3) : null],
    ["Organic Score", d(ess.organic_score ?? es.organic_score)],
    ["MCAP", usd(ess.mcap as number)],
    ["TVL", usd(ess.tvl as number)],
    ["Volume", usd(ess.volume as number)],
    ["Holders", d(ess.holder_count)],
    ["Token Age", ess.token_age_hours != null ? `${ess.token_age_hours}h` : null],
    ["Launchpad", d(ess.launchpad)],
    ["vs ATH", pct(ess.price_vs_ath_pct)],
    ["vs Local ATH", pct(ess.local_price_vs_ath_pct)],
    ["Price 1h", ess.price_change_1h != null ? Number(ess.price_change_1h).toFixed(1) + "%" : null],
    ["RSI 5m", ess.rsi_5m != null ? Number(ess.rsi_5m).toFixed(1) : null],
    ["ST 5m", d(ess.st_dir_5m)],
    ["RSI 15m", ess.rsi_15m != null ? Number(ess.rsi_15m).toFixed(1) : null],
    ["ST 15m", d(ess.st_dir_15m)],
    ["Bot Holders", pct(ess.bot_holders_pct)],
    ["Top 10%", pct(ess.top10_holders_pct)],
    ["Smart Wallets", d(ess.smart_wallets_count)],
    ["Net Buyers 1h", d(ess.net_buyers_1h)],
    ["Fee %", pct(ess.fee_pct)],
    ["Fee Window", ess.fee_window != null ? fmt(ess.fee_window as number) + " SOL" : null],
    [
      "Bin Range",
      es.bin_range ? `${es.bin_range.bins_below ?? 0}/${es.bin_range.bins_above ?? 0} bins` : null,
    ],
  ];
  return fields.filter(([, v]) => v != null);
}

// Mirrors buildHistoryExpandedRow's exitFields.
export function buildExitFields(p: HistoryPosition): Field[] {
  const exs = (p.exit_signal_snapshot ?? {}) as Record<string, unknown>;

  const fields: Field[] = [
    ["Closed At", p.closed_at ? new Date(p.closed_at).toLocaleString() : null],
    ["Hold Time", p.minutes_held != null ? fmtAge(p.minutes_held) : null],
    ["Final Value USD", usd(p.final_value_usd)],
    ["Final Value SOL", sol(p.final_value_sol)],
    ["Fees Earned USD", usd(p.fees_earned_usd)],
    ["Fees Earned SOL", sol(p.fees_earned_sol)],
    ["PnL", p.pnl_pct != null ? `${signed(p.pnl_pct)} / ${signedSol(p.pnl_sol) ?? "—"}` : null],
    [
      "PnL (on-chain)",
      p.onchain_pnl_sol != null
        ? `${
            p.initial_value_sol && p.initial_value_sol > 0
              ? signed((p.onchain_pnl_sol / p.initial_value_sol) * 100) + " / "
              : ""
          }${signedSol(p.onchain_pnl_sol)}${p.onchain_partial ? " (partial)" : ""}`
        : null,
    ],
    ["Max DD", p.trough_pnl_pct != null ? p.trough_pnl_pct.toFixed(2) + "%" : null],
    ["Peak PnL", signed(p.peak_pnl_pct)],
    ["Range Eff.", p.range_efficiency != null ? p.range_efficiency.toFixed(1) + "%" : null],
    ["MCAP at Exit", usd(exs.mcap as number)],
    ["TVL at Exit", usd(exs.tvl as number)],
    ["Volume at Exit", usd(exs.volume as number)],
    ["Organic Score", d(exs.organic_score)],
    ["vs ATH", pct(exs.price_vs_ath_pct)],
    ["Price 1h", exs.price_change_1h != null ? Number(exs.price_change_1h).toFixed(1) + "%" : null],
    [
      "RSI 5m",
      exs.rsi_exit_5m != null
        ? Number(exs.rsi_exit_5m).toFixed(1)
        : exs.rsi_5m != null
          ? Number(exs.rsi_5m).toFixed(1)
          : null,
    ],
    ["ST 5m", d(exs.st_dir_exit_5m ?? exs.st_dir_5m)],
    [
      "RSI 15m",
      exs.rsi_exit_15m != null
        ? Number(exs.rsi_exit_15m).toFixed(1)
        : exs.rsi_15m != null
          ? Number(exs.rsi_15m).toFixed(1)
          : null,
    ],
    ["ST 15m", d(exs.st_dir_exit_15m ?? exs.st_dir_15m)],
    ["Holders", d(exs.holder_count)],
    ["Smart Wallets", d(exs.smart_wallets_count)],
    ["Close Reason", d(p.close_reason)],
  ];
  return fields.filter(([, v]) => v != null);
}

// For the Open Positions expanded row (buildExpandedRow) — entry snapshot only, plus live PnL.
export function buildOpenLiveFields(p: CurrentPosition): Field[] {
  const fields: Field[] = [
    ["Value", usd(p.total_value_usd)],
    ["Unclaimed Fees", usd(p.unclaimed_fees_usd)],
    ["PnL", p.pnl_pct != null ? `${signed(p.pnl_pct)} / ${signedSol(p.pnl_sol) ?? "—"}` : null],
    ["Fee/TVL 24h", p.fee_per_tvl_24h != null ? `${p.fee_per_tvl_24h.toFixed(2)}%` : null],
    ["Age", fmtAge(p.age_minutes)],
    [
      "Out of Range",
      p.minutes_out_of_range && p.minutes_out_of_range > 0
        ? `${fmtAge(p.minutes_out_of_range)}${p.out_of_range_direction ? ` (${p.out_of_range_direction})` : ""}`
        : null,
    ],
    ["Rebalances", p.rebalance_count ? String(p.rebalance_count) : null],
  ];
  return fields.filter(([, v]) => v != null);
}

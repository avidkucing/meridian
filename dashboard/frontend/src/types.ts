export interface BinRange {
  min?: number | null;
  max?: number | null;
  bins_below?: number | null;
  bins_above?: number | null;
}

export interface BinUtilization {
  bins_deployed: number;
  bins_crossed: number;
  utilization_pct: number | null;
  direction: "above" | "below" | "none";
}

export interface EntrySnapshot {
  active_bin_at_deploy?: number | null;
  bin_step?: number | null;
  volatility?: number | null;
  fee_tvl_ratio?: number | null;
  initial_fee_tvl_24h?: number | null;
  organic_score?: number | null;
  price_vs_ath_pct?: number | null;
  initial_value_usd?: number | null;
  initial_value_sol?: number | null;
  entry_mcap?: number | null;
  entry_tvl?: number | null;
  entry_volume?: number | null;
  entry_holders?: number | null;
  signal_snapshot?: Record<string, unknown> | null;
  deployed_at?: string | null;
  bin_range?: BinRange | null;
  strategy?: string | null;
}

export interface CurrentPosition {
  position: string;
  pool: string;
  pair: string;
  base_mint?: string | null;
  lower_bin?: number | null;
  upper_bin?: number | null;
  active_bin?: number | null;
  in_range: boolean | null;
  unclaimed_fees_usd?: number | null;
  total_value_usd?: number | null;
  pnl_usd?: number | null;
  pnl_sol?: number | null;
  pnl_pct?: number | null;
  pnl_pct_suspicious?: boolean;
  fee_per_tvl_24h?: number | null;
  age_minutes?: number | null;
  minutes_out_of_range?: number;
  entry_snapshot?: EntrySnapshot | null;
  out_of_range_since?: string | null;
  out_of_range_direction?: "above" | "below" | null;
  total_fees_claimed_usd?: number;
  rebalance_count?: number;
  notes?: string[];
  bin_utilization?: BinUtilization | null;
  strategy?: string | null;
}

export interface HistoryPosition {
  position: string;
  pool: string;
  pool_name: string;
  strategy?: string | null;
  bin_range?: BinRange | null;
  bin_step?: number | null;
  volatility?: number | null;
  fee_tvl_ratio?: number | null;
  organic_score?: number | null;
  amount_sol?: number | null;
  amount_x?: number | null;
  fees_earned_usd?: number | null;
  fees_earned_sol?: number | null;
  pnl_usd?: number | null;
  pnl_sol?: number | null;
  pnl_pct?: number | null;
  final_value_usd?: number | null;
  final_value_sol?: number | null;
  initial_value_usd?: number | null;
  initial_value_sol?: number | null;
  minutes_in_range?: number | null;
  minutes_held?: number | null;
  close_reason?: string | null;
  exit_reason_type?: string | null;
  bin_utilization?: BinUtilization | null;
  range_efficiency?: number | null;
  entry_snapshot?: EntrySnapshot | null;
  exit_signal_snapshot?: Record<string, unknown> | null;
  deployed_at?: string | null;
  closed_at?: string | null;
  onchain_pnl_sol?: number | null;
  onchain_tx_count?: number | null;
  onchain_partial?: boolean;
  onchain_reclaimable_rent_sol?: number | null;
  trough_pnl_pct?: number | null;
  peak_pnl_pct?: number | null;
}

export interface HealthInfo {
  wallet: string | null;
  [key: string]: unknown;
}

export type OutcomeFilter = "all" | "win" | "loss" | "other";

export interface HistoryFilterState {
  outcome: OutcomeFilter;
  minPnl: string;
  maxPnl: string;
}

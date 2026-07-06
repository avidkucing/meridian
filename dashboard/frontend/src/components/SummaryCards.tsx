import { Wallet, Coins, TrendingUp, Layers, Archive, Target } from "lucide-react";
import type { CurrentPosition, HistoryPosition } from "../types";
import { usd } from "../lib/format";

interface SummaryCardsProps {
  currentPositions: CurrentPosition[];
  historyPositions: HistoryPosition[];
}

function Card({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Wallet;
  label: string;
  value: string;
  tone?: "green" | "red";
}) {
  const toneClass = tone === "green" ? "text-green" : tone === "red" ? "text-red" : "text-text";
  return (
    <div className="rounded-xl border border-border bg-surface p-5 transition-colors hover:border-accent/40">
      <div className="mb-3 flex items-center gap-2 text-text-dim">
        <Icon size={14} />
        <span className="text-[11px] uppercase tracking-wide">{label}</span>
      </div>
      <div className={`text-xl font-semibold font-mono tabular-nums ${toneClass}`}>{value}</div>
    </div>
  );
}

export function SummaryCards({ currentPositions, historyPositions }: SummaryCardsProps) {
  const totalValue = currentPositions.reduce((s, p) => s + (p.total_value_usd || 0), 0);
  const totalFees = currentPositions.reduce((s, p) => s + (p.unclaimed_fees_usd || 0), 0);
  const totalPnl = currentPositions.reduce((s, p) => s + (p.pnl_usd || 0), 0);

  const withPct = historyPositions.filter((p) => p.pnl_pct != null);
  const wins = withPct.filter((p) => (p.pnl_pct ?? 0) > 0).length;
  const winRate = withPct.length ? (wins / withPct.length) * 100 : 0;

  return (
    <section className="grid grid-cols-2 gap-4 px-8 pt-8 sm:grid-cols-3 lg:grid-cols-6 xl:grid-cols-6">
      <Card icon={Wallet} label="Total Value" value={usd(totalValue) ?? "—"} />
      <Card icon={Coins} label="Unclaimed Fees" value={usd(totalFees) ?? "—"} />
      <Card
        icon={TrendingUp}
        label="Combined PnL"
        value={usd(totalPnl) ?? "—"}
        tone={totalPnl > 0 ? "green" : totalPnl < 0 ? "red" : undefined}
      />
      <Card icon={Layers} label="Open Positions" value={String(currentPositions.length)} />
      <Card icon={Archive} label="Closed Positions" value={String(historyPositions.length)} />
      <Card icon={Target} label="Win Rate" value={withPct.length ? `${winRate.toFixed(1)}%` : "—"} />
    </section>
  );
}

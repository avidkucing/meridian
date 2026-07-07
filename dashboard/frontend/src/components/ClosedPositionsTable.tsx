import { Fragment, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { HistoryPosition, HistoryFilterState, OutcomeFilter } from "../types";
import { exitTypeClass, fmtAge, fmtBinUtil, fmtDatetime, fmtExitType, pnlClass, trimAddr } from "../lib/format";
import { SnapshotPanel } from "./SnapshotPanel";
import { buildEntryFields, buildExitFields } from "../lib/snapshotFields";

const PAGE_SIZE = 50;

const OUTCOME_TABS: { id: OutcomeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "win", label: "Wins" },
  { id: "loss", label: "Losses" },
  { id: "other", label: "Other" },
];

export function ClosedPositionsTable({ positions }: { positions: HistoryPosition[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<HistoryFilterState>({ outcome: "all", minPnl: "", maxPnl: "" });

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const filtered = useMemo(() => {
    return positions.filter((p) => {
      const pnlPct = p.pnl_pct ?? 0;
      if (filter.outcome === "win" && pnlPct <= 0) return false;
      if (filter.outcome === "loss" && pnlPct >= 0) return false;
      if (filter.outcome === "other" && pnlPct !== 0) return false;
      if (filter.minPnl !== "" && pnlPct < parseFloat(filter.minPnl)) return false;
      if (filter.maxPnl !== "" && pnlPct > parseFloat(filter.maxPnl)) return false;
      return true;
    });
  }, [positions, filter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const pageItems = filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);

  function setOutcome(outcome: OutcomeFilter) {
    setFilter((f) => ({ ...f, outcome }));
    setPage(0);
  }

  const hasRange = filter.minPnl !== "" || filter.maxPnl !== "";

  return (
    <div className="px-8 py-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-text-dim">
          {filtered.length === positions.length ? `${positions.length} closed` : `${filtered.length} of ${positions.length} closed`}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-border">
            {OUTCOME_TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setOutcome(t.id)}
                className={`px-2.5 py-1 text-xs transition-colors ${
                  filter.outcome === t.id ? "bg-accent text-bg" : "bg-surface text-text-dim hover:text-text"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <input
              type="number"
              placeholder="Min %"
              value={filter.minPnl}
              onChange={(e) => {
                setFilter((f) => ({ ...f, minPnl: e.target.value }));
                setPage(0);
              }}
              className="w-20 rounded-md border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
            />
            <span className="text-text-mute">—</span>
            <input
              type="number"
              placeholder="Max %"
              value={filter.maxPnl}
              onChange={(e) => {
                setFilter((f) => ({ ...f, maxPnl: e.target.value }));
                setPage(0);
              }}
              className="w-20 rounded-md border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
            />
            {hasRange && (
              <button
                onClick={() => {
                  setFilter((f) => ({ ...f, minPnl: "", maxPnl: "" }));
                  setPage(0);
                }}
                className="rounded-md border border-border px-2 py-1 text-xs text-text-dim hover:text-red"
              >
                ✕ Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {!filtered.length ? (
        <div className="rounded-lg border border-border py-16 text-center text-sm text-text-dim">
          {positions.length ? "No positions match filters" : "No closed positions yet"}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[1100px] border-separate border-spacing-0 text-left text-xs">
            <thead>
              <tr className="text-text-dim">
                {["Pair", "PnL", "PnL (on-chain)", "Max DD", "Hold", "Range Eff.", "Util %", "Opened", "Closed", "Exit Type", "Close Reason"].map(
                  (h) => (
                    <th key={h} className="border-b border-border bg-surface px-4 py-3 font-medium">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {pageItems.map((p) => {
                const isOpen = expanded.has(p.position);
                const pnlPct = p.pnl_pct ?? 0;
                const onchainSol = p.onchain_pnl_sol;
                const onchainPct = onchainSol != null && p.initial_value_sol ? (onchainSol / p.initial_value_sol) * 100 : null;
                const dd = p.trough_pnl_pct;
                return (
                  <Fragment key={p.position}>
                    <tr onClick={() => toggle(p.position)} className="cursor-pointer transition-colors hover:bg-surface">
                      <td className="border-b border-border px-4 py-3.5">
                        <div className="font-medium text-text">{p.pool_name || "?/?"}</div>
                        <div className="font-mono text-[11px] text-text-mute" title={p.pool}>
                          {trimAddr(p.pool)}
                        </div>
                        {p.strategy && (
                          <span className="mt-0.5 inline-block rounded bg-surface-2 px-1.5 py-0.5 text-[9px] text-text-dim">
                            {p.strategy}
                          </span>
                        )}
                      </td>
                      <td className={`border-b border-border px-4 py-3.5 tabular-nums ${pnlClass(pnlPct)}`}>
                        <div>
                          {pnlPct >= 0 ? "+" : ""}
                          {pnlPct.toFixed(2)}%
                        </div>
                        <div className="text-[11px] opacity-80">
                          {p.pnl_sol != null ? `${p.pnl_sol >= 0 ? "+" : ""}${p.pnl_sol.toFixed(4)} SOL` : "—"}
                        </div>
                      </td>
                      <td className={`border-b border-border px-4 py-3.5 tabular-nums ${onchainPct != null ? pnlClass(onchainPct) : "text-text-mute"}`}>
                        {onchainPct != null && onchainSol != null ? (
                          <>
                            <div>
                              {onchainPct >= 0 ? "+" : ""}
                              {onchainPct.toFixed(2)}%
                            </div>
                            <div className="text-[11px] opacity-80">
                              {onchainSol >= 0 ? "+" : ""}
                              {onchainSol.toFixed(4)} SOL
                              {p.onchain_partial ? " (partial)" : ""}
                            </div>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className={`border-b border-border px-4 py-3.5 tabular-nums ${dd != null && dd < 0 ? "text-red" : "text-text-dim"}`}>
                        {dd != null ? `${dd.toFixed(2)}%` : "—"}
                      </td>
                      <td className="border-b border-border px-4 py-3.5 tabular-nums">{fmtAge(p.minutes_held)}</td>
                      <td className="border-b border-border px-4 py-3.5 tabular-nums">
                        {p.range_efficiency != null ? `${p.range_efficiency.toFixed(0)}%` : "—"}
                      </td>
                      <td className="border-b border-border px-4 py-3.5 tabular-nums">{fmtBinUtil(p.bin_utilization)}</td>
                      <td className="whitespace-nowrap border-b border-border px-4 py-3.5 text-[11px]">
                        {fmtDatetime(p.deployed_at)}
                      </td>
                      <td className="whitespace-nowrap border-b border-border px-4 py-3.5 text-[11px]">
                        {fmtDatetime(p.closed_at)}
                      </td>
                      <td className={`border-b border-border px-4 py-3.5 ${exitTypeClass(p.exit_reason_type)}`}>{fmtExitType(p.exit_reason_type)}</td>
                      <td className="border-b border-border px-4 py-3.5">
                        <div className="flex items-center gap-2">
                          <span className="max-w-[160px] truncate text-text-dim" title={p.close_reason ?? undefined}>
                            {p.close_reason || "—"}
                          </span>
                          <ChevronDown size={13} className={`shrink-0 text-text-dim transition-transform ${isOpen ? "rotate-180" : ""}`} />
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={11} className="p-0">
                          <SnapshotPanel
                            pool={p.pool}
                            panels={[
                              { title: "Entry Snapshot", fields: buildEntryFields(p.entry_snapshot) },
                              { title: "Exit Snapshot", fields: buildExitFields(p) },
                            ]}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="mt-3 flex items-center justify-center gap-3 text-xs text-text-dim">
          <button
            disabled={clampedPage === 0}
            onClick={() => setPage(clampedPage - 1)}
            className="rounded-md border border-border px-3 py-1 disabled:opacity-30 enabled:hover:text-accent"
          >
            ← Prev
          </button>
          <span>
            {clampedPage * PAGE_SIZE + 1}–{Math.min((clampedPage + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <button
            disabled={clampedPage >= totalPages - 1}
            onClick={() => setPage(clampedPage + 1)}
            className="rounded-md border border-border px-3 py-1 disabled:opacity-30 enabled:hover:text-accent"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

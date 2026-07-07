import { Fragment, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { CurrentPosition } from "../types";
import { fmt, fmtAge, fmtBinUtil, pnlClass, signed, trimAddr } from "../lib/format";
import { BinRangeBar } from "./BinRangeBar";
import { SnapshotPanel } from "./SnapshotPanel";
import { buildEntryFields, buildOpenLiveFields } from "../lib/snapshotFields";

function copyAddr(e: React.MouseEvent, addr: string) {
  e.stopPropagation();
  navigator.clipboard.writeText(addr).catch(() => {});
}

export function OpenPositionsTable({ positions }: { positions: CurrentPosition[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  if (!positions.length) {
    return <div className="px-6 py-16 text-center text-sm text-text-dim">No open positions.</div>;
  }

  return (
    <div className="overflow-x-auto px-8 py-6">
      <table className="w-full min-w-[900px] border-separate border-spacing-0 text-left text-xs">
        <thead>
          <tr className="text-text-dim">
            {["Pair", "Value", "PnL", "Fees", "Fee/TVL", "Age", "OOR", "Range", "Util %", ""].map((h) => (
              <th key={h} className="border-b border-border px-4 py-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const isOpen = expanded.has(p.position);
            const pnl = p.pnl_usd ?? 0;
            const pnlPct = p.pnl_pct ?? 0;
            const oor = p.minutes_out_of_range ?? 0;
            return (
              <Fragment key={p.position}>
                <tr
                  key={p.position}
                  onClick={() => toggle(p.position)}
                  className="cursor-pointer transition-colors hover:bg-surface"
                >
                  <td className="border-b border-border px-4 py-3.5">
                    <div className="font-medium text-text">{p.pair || "?/?"}</div>
                    <div
                      className="font-mono text-[11px] text-text-mute hover:text-accent"
                      onClick={(e) => copyAddr(e, p.pool)}
                      title={p.pool}
                    >
                      {trimAddr(p.pool)}
                    </div>
                  </td>
                  <td className="border-b border-border px-4 py-3.5 tabular-nums">${fmt(p.total_value_usd)}</td>
                  <td className={`border-b border-border px-4 py-3.5 tabular-nums ${pnlClass(pnl)}`}>
                    <div>{pnl >= 0 ? "+" : ""}${fmt(pnl)}</div>
                    <div className="text-[11px] opacity-80">{signed(pnlPct)}</div>
                  </td>
                  <td className="border-b border-border px-4 py-3.5 tabular-nums text-yellow">
                    ${fmt(p.unclaimed_fees_usd)}
                  </td>
                  <td className="border-b border-border px-4 py-3.5 tabular-nums">
                    {p.fee_per_tvl_24h != null ? `${p.fee_per_tvl_24h.toFixed(2)}%` : "—"}
                  </td>
                  <td className="border-b border-border px-4 py-3.5 tabular-nums">{fmtAge(p.age_minutes)}</td>
                  <td className={`border-b border-border px-4 py-3.5 tabular-nums ${oor > 0 ? "text-red" : "text-green"}`}>
                    {oor > 0 ? fmtAge(oor) : "in range"}
                  </td>
                  <td className="border-b border-border px-4 py-3.5">
                    <BinRangeBar lowerBin={p.lower_bin} upperBin={p.upper_bin} activeBin={p.active_bin} />
                  </td>
                  <td className="border-b border-border px-4 py-3.5 tabular-nums">
                    {fmtBinUtil(p.bin_utilization)}
                  </td>
                  <td className="border-b border-border px-4 py-3.5">
                    <ChevronDown
                      size={14}
                      className={`text-text-dim transition-transform ${isOpen ? "rotate-180" : ""}`}
                    />
                  </td>
                </tr>
                {isOpen && (
                  <tr key={`${p.position}-panel`}>
                    <td colSpan={10} className="p-0">
                      <SnapshotPanel
                        pool={p.pool}
                        panels={[
                          {
                            title: "Entry Snapshot",
                            fields: buildEntryFields(p.entry_snapshot, {
                              deployedAt: p.entry_snapshot?.deployed_at,
                              strategy: p.strategy ?? p.entry_snapshot?.strategy,
                            }),
                          },
                          { title: "Live", fields: buildOpenLiveFields(p) },
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
  );
}

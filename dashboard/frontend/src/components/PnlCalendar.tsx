import { Fragment, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { HistoryPosition } from "../types";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKS = 6;

interface DayStat {
  count: number;
  wins: number;
  sumSol: number;
}

function dayStatsByDate(positions: HistoryPosition[]): Map<string, DayStat> {
  const byDay = new Map<string, DayStat>();
  for (const p of positions) {
    if (p.onchain_pnl_sol == null || !p.closed_at) continue;
    const day = p.closed_at.slice(0, 10);
    const d = byDay.get(day) ?? { count: 0, wins: 0, sumSol: 0 };
    d.count += 1;
    if (p.onchain_pnl_sol > 0) d.wins += 1;
    d.sumSol += p.onchain_pnl_sol;
    byDay.set(day, d);
  }
  return byDay;
}

export function PnlCalendar({ positions }: { positions: HistoryPosition[] }) {
  const [monthOffset, setMonthOffset] = useState(0);

  const byDay = useMemo(() => dayStatsByDate(positions), [positions]);

  const now = new Date();
  const viewDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1));
  const year = viewDate.getUTCFullYear();
  const month = viewDate.getUTCMonth();

  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const startDow = firstOfMonth.getUTCDay();
  const gridStart = new Date(Date.UTC(year, month, 1 - startDow));
  const todayStr = new Date().toISOString().slice(0, 10);

  let daysWithDataThisMonth = 0;
  let monthSumSol = 0;

  const weeks = Array.from({ length: WEEKS }, (_, w) => {
    let weekDaysWithData = 0;
    let weekSumSol = 0;
    const days = Array.from({ length: 7 }, (_, dow) => {
      const cellDate = new Date(gridStart.getTime() + (w * 7 + dow) * 86400000);
      const cellStr = cellDate.toISOString().slice(0, 10);
      const inMonth = cellDate.getUTCMonth() === month;
      const stat = byDay.get(cellStr);
      if (stat && inMonth) {
        daysWithDataThisMonth++;
        weekDaysWithData++;
        monthSumSol += stat.sumSol;
        weekSumSol += stat.sumSol;
      }
      return {
        date: cellDate.getUTCDate(),
        cellStr,
        inMonth,
        isToday: cellStr === todayStr,
        stat,
      };
    });
    return { days, weekDaysWithData, weekSumSol };
  });

  return (
    <div className="px-8 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setMonthOffset((o) => o - 1)}
            className="rounded-md border border-border p-1.5 text-text-dim hover:text-accent"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="min-w-[180px] text-center text-lg font-bold tracking-wide">
            {MONTH_NAMES[month].toUpperCase()} {year}
          </span>
          <button
            onClick={() => setMonthOffset((o) => o + 1)}
            className="rounded-md border border-border p-1.5 text-text-dim hover:text-accent"
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <span className="text-xs text-text-dim">
          Monthly stats: {daysWithDataThisMonth} day{daysWithDataThisMonth === 1 ? "" : "s"} ·{" "}
          <span className={monthSumSol >= 0 ? "text-green" : "text-red"}>
            {monthSumSol >= 0 ? "+" : ""}
            {monthSumSol.toFixed(4)} SOL
          </span>
        </span>
      </div>

      <div className="grid grid-cols-8 overflow-hidden rounded-lg border border-border">
        {DOW.map((d) => (
          <div key={d} className="border-b border-border bg-surface px-2 py-2 text-center text-[11px] text-text-dim">
            {d}
          </div>
        ))}
        <div className="border-b border-border bg-surface px-2 py-2 text-center text-[11px] text-text-dim">Week</div>

        {weeks.map((week, wi) => (
          <Fragment key={wi}>
            {week.days.map((day) => {
              const winRate = day.stat ? (day.stat.wins / day.stat.count) * 100 : null;
              const bg = !day.stat
                ? day.inMonth
                  ? ""
                  : "bg-bg text-text-mute"
                : day.stat.sumSol >= 0
                  ? "bg-green/10"
                  : "bg-red/10";
              return (
                <div
                  key={day.cellStr}
                  className={`relative min-h-[100px] border-b border-r border-border p-2 text-xs last:border-r-0 ${bg} ${
                    day.isToday ? "outline outline-2 -outline-offset-2 outline-accent" : ""
                  }`}
                >
                  <div className="text-[11px] text-text-dim">{day.date}</div>
                  {day.stat && (
                    <div className="mt-4 text-center">
                      <div className="text-[10px] text-text-dim">
                        {day.stat.count} position{day.stat.count === 1 ? "" : "s"}
                      </div>
                      <div className={`mt-0.5 text-base font-bold tabular-nums ${day.stat.sumSol >= 0 ? "text-green" : "text-red"}`}>
                        {day.stat.sumSol >= 0 ? "+" : ""}
                        {day.stat.sumSol.toFixed(4)} SOL
                      </div>
                      <div className="text-[10px] text-text-dim">{winRate?.toFixed(1)}%</div>
                    </div>
                  )}
                </div>
              );
            })}
            <div
              key={`week-${wi}`}
              className="flex flex-col items-center justify-center gap-0.5 border-b border-border bg-surface px-2 py-2 text-center text-xs text-text-dim last:border-b-0"
            >
              <div className="font-semibold text-text">Week {wi + 1}</div>
              <div>
                {week.weekDaysWithData} day{week.weekDaysWithData === 1 ? "" : "s"}
              </div>
              {week.weekDaysWithData > 0 && (
                <div className={week.weekSumSol >= 0 ? "text-green" : "text-red"}>
                  {week.weekSumSol >= 0 ? "+" : ""}
                  {week.weekSumSol.toFixed(4)} SOL
                </div>
              )}
            </div>
          </Fragment>
        ))}
      </div>

      <p className="mt-3 text-[11px] text-text-dim">
        On-chain PnL only — days with no closed positions carrying on-chain data are left blank.
      </p>
    </div>
  );
}

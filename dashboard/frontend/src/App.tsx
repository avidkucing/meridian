import { useCallback, useEffect, useState } from "react";
import { Header } from "./components/Header";
import { SummaryCards } from "./components/SummaryCards";
import { Tabs } from "./components/Tabs";
import { OpenPositionsTable } from "./components/OpenPositionsTable";
import { ClosedPositionsTable } from "./components/ClosedPositionsTable";
import { PnlCalendar } from "./components/PnlCalendar";
import { fetchCurrentPositions, fetchHealth, fetchHistoryPositions } from "./lib/api";
import { useLivePositions } from "./lib/useWebSocket";
import type { CurrentPosition, HistoryPosition } from "./types";

type TabId = "current" | "history" | "calendar";

const TABS: { id: TabId; label: string }[] = [
  { id: "current", label: "Open Positions" },
  { id: "history", label: "Closed Positions" },
  { id: "calendar", label: "PnL Calendar" },
];

function App() {
  const [tab, setTab] = useState<TabId>("current");
  const [wallet, setWallet] = useState<string | null>(null);
  const [restCurrent, setRestCurrent] = useState<CurrentPosition[]>([]);
  const [restHistory, setRestHistory] = useState<HistoryPosition[]>([]);
  const live = useLivePositions();

  const refreshAll = useCallback(async () => {
    const [current, history, health] = await Promise.all([
      fetchCurrentPositions().catch(() => []),
      fetchHistoryPositions().catch(() => []),
      fetchHealth().catch(() => null),
    ]);
    setRestCurrent(current);
    setRestHistory(history);
    if (health?.wallet) setWallet(health.wallet);
  }, []);

  useEffect(() => {
    refreshAll();
    const poll = window.setInterval(refreshAll, 30_000);
    return () => window.clearInterval(poll);
  }, [refreshAll]);

  // Prefer live WebSocket data once it has actually delivered something; fall back to REST.
  const currentPositions = live.currentPositions.length ? live.currentPositions : restCurrent;
  const historyPositions = live.historyPositions.length ? live.historyPositions : restHistory;
  const lastSync = live.lastSync;

  return (
    <div className="min-h-screen bg-bg">
      <Header wallet={wallet} wsStatus={live.status} lastSync={lastSync} onRefresh={refreshAll} />
      <SummaryCards currentPositions={currentPositions} historyPositions={historyPositions} />
      <div className="mt-8">
        <Tabs
          tabs={TABS.map((t) => ({
            ...t,
            count: t.id === "current" ? currentPositions.length : t.id === "history" ? historyPositions.length : undefined,
          }))}
          active={tab}
          onChange={(id) => setTab(id as TabId)}
        />
      </div>
      {tab === "current" && <OpenPositionsTable positions={currentPositions} />}
      {tab === "history" && <ClosedPositionsTable positions={historyPositions} />}
      {tab === "calendar" && <PnlCalendar positions={historyPositions} />}
    </div>
  );
}

export default App;

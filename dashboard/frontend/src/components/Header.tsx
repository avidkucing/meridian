import { RefreshCw } from "lucide-react";
import type { WsStatus } from "../lib/useWebSocket";
import { trimAddr } from "../lib/format";

interface HeaderProps {
  wallet: string | null;
  wsStatus: WsStatus;
  lastSync: Date | null;
  onRefresh: () => void;
}

const STATUS_STYLES: Record<WsStatus, { dot: string; label: string }> = {
  connected: { dot: "bg-green", label: "Live" },
  connecting: { dot: "bg-yellow animate-pulse", label: "Connecting…" },
  disconnected: { dot: "bg-text-mute", label: "Disconnected" },
  error: { dot: "bg-red", label: "Error" },
};

export function Header({ wallet, wsStatus, lastSync, onRefresh }: HeaderProps) {
  const s = STATUS_STYLES[wsStatus];
  return (
    <header className="sticky top-0 z-20 glass border-b border-border">
      <div className="flex items-center justify-between px-8 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-accent-2">
            <span className="text-sm font-bold text-bg">M</span>
          </div>
          <div className="flex items-baseline gap-2">
            <h1 className="text-base font-semibold tracking-tight">Meridian</h1>
            <span className="text-xs text-text-dim">DLMM Agent</span>
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs text-text-dim">
          {wallet && (
            <span className="rounded-md border border-border bg-surface px-2 py-1 font-mono" title={wallet}>
              {trimAddr(wallet, 4)}
            </span>
          )}
          <div className="flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${s.dot}`} />
            <span>{s.label}</span>
          </div>
          <span className="hidden sm:inline">
            {lastSync ? `synced ${lastSync.toLocaleTimeString()}` : "never synced"}
          </span>
          <button
            onClick={onRefresh}
            className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-text transition-colors hover:border-accent hover:text-accent"
          >
            <RefreshCw size={13} />
            Refresh
          </button>
        </div>
      </div>
    </header>
  );
}

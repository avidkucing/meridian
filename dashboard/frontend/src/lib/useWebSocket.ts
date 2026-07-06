import { useEffect, useRef, useState, useCallback } from "react";
import type { CurrentPosition, HistoryPosition } from "../types";

export type WsStatus = "connecting" | "connected" | "disconnected" | "error";

interface WsState {
  status: WsStatus;
  currentPositions: CurrentPosition[];
  historyPositions: HistoryPosition[];
  lastSync: Date | null;
}

interface WsMessage {
  event: "positions:update" | "positions:history" | "heartbeat";
  data: unknown;
  ts: number;
}

/**
 * Live WebSocket feed for open/closed positions, mirroring the old
 * app.js connectWS()/onmessage behavior. Falls back to nothing special on
 * disconnect — the parent still has REST fetches for the initial load and
 * manual refresh.
 */
export function useLivePositions() {
  const [state, setState] = useState<WsState>({
    status: "connecting",
    currentPositions: [],
    historyPositions: [],
    lastSync: null,
  });
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
    }
    if (reconnectTimer.current) {
      window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => setState((s) => ({ ...s, status: "connected" }));

    ws.onmessage = (evt) => {
      const msg: WsMessage = JSON.parse(evt.data);
      if (msg.event === "positions:update") {
        setState((s) => ({ ...s, currentPositions: msg.data as CurrentPosition[], lastSync: new Date() }));
      } else if (msg.event === "positions:history") {
        setState((s) => ({ ...s, historyPositions: msg.data as HistoryPosition[], lastSync: new Date() }));
      } else if (msg.event === "heartbeat") {
        setState((s) => ({ ...s, lastSync: new Date() }));
      }
    };

    ws.onclose = () => {
      setState((s) => ({ ...s, status: "disconnected" }));
      reconnectTimer.current = window.setTimeout(connect, 5000);
    };

    ws.onerror = () => setState((s) => ({ ...s, status: "error" }));
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
    };
  }, [connect]);

  return state;
}

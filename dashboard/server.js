/**
 * Meridian Dashboard — Express + WebSocket server
 *
 * Exposes:
 *   GET  /api/positions/current  — live open positions with PnL
 *   GET  /api/positions/history — closed positions with exit snapshots
 *   GET  /api/pools/:pool/memory — pool-memory snapshots
 *   GET  /api/health            — server health + wallet pubkey
 *   WS   /ws                    — real-time position broadcasts
 */

import express from "express";
import cors from "cors";
import { createServer as makeHttpServer } from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import chokidar from "chokidar";
import { router as apiRouter } from "./routes/api.js";

// ─── Env ────────────────────────────────────────────────────────
const PORT        = process.env.DASHBOARD_PORT || 3001;
const __dirname2  = dirname(fileURLToPath(import.meta.url));
const isDev       = process.env.NODE_ENV !== "production";

// ─── App ────────────────────────────────────────────────────────
const app    = express();
const server = makeHttpServer(app);

app.use(cors());
app.use(express.json());

// Static files — no-cache headers so browser always fetches fresh on reload
app.use(express.static(join(__dirname2, "public"), {
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  },
}));

app.use("/api", apiRouter);

// SPA fallback
app.get("*", (_req, res) => {
  res.sendFile(join(__dirname2, "public", "index.html"));
});

// ─── Hot reload ─────────────────────────────────────────────────
// Watch route and public files in dev mode; changes to public/ are
// picked up automatically by the browser (no-cache headers).
// Route changes require a PM2 restart, but we log the change so you know.
if (isDev) {
  const watcher = chokidar.watch(
    [join(__dirname2, "routes"), join(__dirname2, "public")],
    { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 } }
  );

  watcher.on("all", (event, filePath) => {
    const isRoute = filePath.includes("/routes/");
    console.log(`[hot-reload] ${event}: ${filePath}`);
    if (isRoute) {
      console.log("[hot-reload] Route file changed — restart PM2 to apply (or Ctrl+C to exit and re-run)");
    }
    // For public files: browser will get fresh version on next request (no-cache already set)
  });

  watcher.on("error", (err) => console.error("[hot-reload] watcher error:", err));
}

// ─── WebSocket ──────────────────────────────────────────────────
const wss    = new WebSocketServer({ server, path: "/ws" });
const clients = new Set();

function broadcast(event, data) {
  const payload = JSON.stringify({ event, data, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

export function emitPositionsUpdate(positions) { broadcast("positions:update", positions); }
export function emitHistoryUpdate(history)       { broadcast("positions:history", history); }
export function emitHeartbeat()                   { broadcast("heartbeat", { ts: Date.now() }); }

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));

  // Send current state immediately on connect
  import("./routes/api.js").then(({ getCurrentPositions, getPositionHistory }) => {
    getCurrentPositions().then((positions) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event: "positions:update", data: positions, ts: Date.now() }));
    });
    getPositionHistory().then((history) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event: "positions:history", data: history, ts: Date.now() }));
    });
  });
});

// ─── Start ──────────────────────────────────────────────────────
export function createServer() {
  if (server.listening) {
    console.log(`[dashboard] already listening on http://localhost:${PORT}`);
    return server;
  }
  server.listen(PORT, () => {
    console.log(`[dashboard] listening on http://localhost:${PORT}`);
    console.log(`[dashboard] WebSocket on ws://localhost:${PORT}/ws`);
    if (isDev) console.log(`[dashboard] hot-reload on (Ctrl+Shift+R for frontend, restart for route changes)`);
  });
  return server;
}

// Only auto-start when run directly
const isDirectRun = process.argv[1]?.endsWith("dashboard/server.js");
if (isDirectRun) {
  createServer();
}

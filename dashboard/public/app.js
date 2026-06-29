/**
 * Meridian Dashboard — Frontend Logic
 *
 * Architecture:
 *   - REST: initial load + manual refresh
 *   - WebSocket: live position updates pushed from server
 *   - Falls back to 30s polling if WS unavailable
 */

// ─── State ────────────────────────────────────────────────────────

let currentPositions = [];
let historyPositions = [];
let wsConnected = false;
let activeTab = "current";
let expandedRows = new Set();
let ws = null;
let pollTimer = null;
let syncTimer = null;
let lastSync = null;

// History filters + pagination
let historyFilter = { outcome: "all", minPnl: "", maxPnl: "" };
let historyPage = 0;
const HISTORY_PAGE_SIZE = 50;

// ─── Init ─────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  connectWS();
  refreshAll();
  startPolling();
  // Clear any stale intervals before setting new ones (prevents MaxListenersExceeded on refresh)
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(updateSyncTime, 10_000);
});

// ─── WebSocket ────────────────────────────────────────────────────

let wsReconnectTimer = null;

function connectWS() {
  // Close any existing connection before creating a new one
  if (ws) {
    ws.onclose = null;   // suppress auto-reconnect on intentional close
    ws.onerror = null;
    ws.close();
    ws = null;
  }
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    wsConnected = true;
    setWsDot("connected");
    console.log("[ws] connected");
  };

  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.event === "positions:update") {
      currentPositions = msg.data || [];
      renderCurrentPositions();
      updateSummary();
      lastSync = new Date();
      updateSyncTime();
    } else if (msg.event === "positions:history") {
      historyPositions = msg.data || [];
      renderHistoryPositions();
      updateSummary();
    } else if (msg.event === "heartbeat") {
      lastSync = new Date();
      updateSyncTime();
    }
  };

  ws.onclose = () => {
    wsConnected = false;
    setWsDot("disconnected");
    console.log("[ws] disconnected — retrying in 5s");
    wsReconnectTimer = setTimeout(connectWS, 5000);
  };

  ws.onerror = () => {
    setWsDot("error");
  };
}

function setWsDot(state) {
  const dot = document.getElementById("ws-dot");
  dot.className = "status-dot " + (state === "connected" ? "connected" : state === "error" ? "error" : "");
  dot.title = state === "connected" ? "WebSocket connected" : "WebSocket disconnected";
}

// ─── Polling (fallback) ────────────────────────────────────────────

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshAll, 30_000);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
}

// ─── Data Fetch ───────────────────────────────────────────────────

async function refreshAll() {
  await Promise.all([fetchCurrentPositions(), fetchHistoryPositions(), fetchWallet()]);
  updateSyncTime();
}

async function fetchCurrentPositions() {
  try {
    const res = await fetch("/api/positions/current");
    const json = await res.json();
    if (json.ok) {
      currentPositions = json.positions || [];
      renderCurrentPositions();
      updateSummary();
    }
  } catch (e) {
    console.error("[api] current positions error:", e);
  }
}

async function fetchHistoryPositions() {
  try {
    const res = await fetch("/api/positions/history");
    const json = await res.json();
    if (json.ok) {
      historyPositions = json.positions || [];
      renderHistoryPositions();
      updateSummary();
    }
  } catch (e) {
    console.error("[api] history error:", e);
  }
}

async function fetchWallet() {
  try {
    const res = await fetch("/api/health");
    const json = await res.json();
    if (json.ok && json.wallet) {
      const badge = document.getElementById("wallet-badge");
      badge.textContent = trimAddr(json.wallet);
      badge.title = json.wallet;
    }
  } catch (e) {
    console.error("[api] health error:", e);
  }
}

// ─── Summary Cards ────────────────────────────────────────────────

function updateSummary() {
  const totalValue = currentPositions.reduce((s, p) => s + (p.total_value_usd || 0), 0);
  const totalFees  = currentPositions.reduce((s, p) => s + (p.unclaimed_fees_usd || 0), 0);
  const totalPnl   = currentPositions.reduce((s, p) => s + (p.pnl_usd || 0), 0);

  setMetric("m-total-value", `${fmt(totalValue)}`);
  setMetric("m-total-fees",  `${fmt(totalFees)}`);
  const pnlEl = document.getElementById("m-total-pnl");
  pnlEl.textContent = `${totalPnl >= 0 ? "+" : ""}${fmt(totalPnl)}`;
  pnlEl.className = "metric-value " + pnlClass(totalPnl);

  document.getElementById("m-open-count").textContent = currentPositions.length;

  const closedCount = historyPositions.length;
  document.getElementById("m-closed-count").textContent = closedCount;

  const winners = historyPositions.filter(p => (p.pnl_pct ?? 0) > 0).length;
  const losers  = historyPositions.filter(p => (p.pnl_pct ?? 0) < 0).length;
  const decided = winners + losers;
  const winRate = decided > 0 ? ((winners / decided) * 100).toFixed(0) + "%" : "—";
  const wrEl = document.getElementById("m-win-rate");
  wrEl.textContent = winRate;
  wrEl.className = "metric-value";
}

function setMetric(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
}

// ─── Current Positions Table ──────────────────────────────────────

function renderCurrentPositions() {
  const tbody = document.getElementById("current-tbody");
  const count = document.getElementById("current-count");
  if (!tbody) return;

  count.textContent = `${currentPositions.length} position${currentPositions.length !== 1 ? "s" : ""}`;

  if (!currentPositions.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No open positions</td></tr>';
    return;
  }

  tbody.innerHTML = currentPositions.map(p => buildCurrentRow(p)).join("");

  // Re-attach click handlers for expand buttons
  tbody.querySelectorAll(".expand-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const pos = btn.dataset.pos;
      toggleExpand(pos, "current");
    });
  });

  // Click row to expand
  tbody.querySelectorAll("tr[data-pos]").forEach(row => {
    row.addEventListener("click", () => toggleExpand(row.dataset.pos, "current"));
  });
}

function buildCurrentRow(p) {
  const pnl = p.pnl_usd ?? 0;
  const pnlPct = p.pnl_pct ?? 0;
  const fees = p.unclaimed_fees_usd ?? 0;
  const inRange = p.in_range;
  const age = p.age_minutes;
  const oor = p.minutes_out_of_range;
  const expanded = expandedRows.has("current_" + p.position);

  return `
    <tr class="${expanded ? "expanded" : ""}" data-pos="${p.position}">
      <td>
        <div class="pair-cell">${esc(p.pair || "?/?")}</div>
        <div class="pool-cell copy-addr" onclick="copyAddr(event,'${esc(p.pool)}')" title="${esc(p.pool)}">${trimAddr(p.pool)}</div>
        ${p.strategy ? `<span class="tag tag-strategy-${p.strategy}">${p.strategy}</span>` : ""}
      </td>
      <td class="num">$${fmt(p.total_value_usd)}</td>
      <td class="num ${pnlClass(pnl)}">
        <div>${pnl >= 0 ? "+" : ""}$${fmt(pnl)}</div>
        <div style="font-size:10px;color:var(--text-dim)">${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%</div>
      </td>
      <td class="num fee-cell">$${fmt(fees)}</td>
      <td class="num">${p.fee_per_tvl_24h != null ? p.fee_per_tvl_24h.toFixed(2) + "%" : "—"}</td>
      <td class="num">${age != null ? fmtAge(age) : "—"}</td>
      <td class="num ${oor > 0 ? "oor-badge" : "in-range-badge"}">${oor > 0 ? fmtAge(oor) : (inRange ? "in" : "OOR")}</td>
      <td>
        ${buildBinBar(p)}
      </td>
      <td class="num">${fmtBinUtil(p.bin_utilization)}</td>
      <td>
        <button class="expand-btn" data-pos="${p.position}">${expanded ? "▲" : "▼"} Snapshot</button>
      </td>
    </tr>
    ${expanded ? buildExpandedRow(p) : ""}
  `;
}

// ─── History Filters ──────────────────────────────────────────────

function getFilteredHistory() {
  return historyPositions.filter(p => {
    const pnlPct = p.pnl_pct ?? 0;
    if (historyFilter.outcome === "win"   && pnlPct <= 0)  return false;
    if (historyFilter.outcome === "loss"  && pnlPct >= 0)  return false;
    if (historyFilter.outcome === "other" && pnlPct !== 0) return false;
    if (historyFilter.minPnl !== "" && pnlPct < parseFloat(historyFilter.minPnl)) return false;
    if (historyFilter.maxPnl !== "" && pnlPct > parseFloat(historyFilter.maxPnl)) return false;
    return true;
  });
}

function setOutcomeFilter(outcome) {
  historyFilter.outcome = outcome;
  historyPage = 0;
  document.querySelectorAll(".filter-pills .pill").forEach(p =>
    p.classList.toggle("active", p.dataset.outcome === outcome)
  );
  renderHistoryPositions();
}

function applyFilters() {
  historyFilter.minPnl = document.getElementById("filter-pnl-min").value;
  historyFilter.maxPnl = document.getElementById("filter-pnl-max").value;
  const hasRange = historyFilter.minPnl !== "" || historyFilter.maxPnl !== "";
  document.getElementById("filter-clear").style.display = hasRange ? "" : "none";
  historyPage = 0;
  renderHistoryPositions();
}

function clearFilters() {
  historyFilter.minPnl = "";
  historyFilter.maxPnl = "";
  document.getElementById("filter-pnl-min").value = "";
  document.getElementById("filter-pnl-max").value = "";
  document.getElementById("filter-clear").style.display = "none";
  historyPage = 0;
  renderHistoryPositions();
}

// ─── History Positions Table ──────────────────────────────────────

function renderHistoryPositions() {
  const tbody = document.getElementById("history-tbody");
  const count = document.getElementById("history-count");
  const paginationEl = document.getElementById("history-pagination");
  if (!tbody) return;

  const filtered = getFilteredHistory();
  const total = historyPositions.length;
  const totalPages = Math.max(1, Math.ceil(filtered.length / HISTORY_PAGE_SIZE));
  historyPage = Math.min(historyPage, totalPages - 1);

  const start = historyPage * HISTORY_PAGE_SIZE;
  const page = filtered.slice(start, start + HISTORY_PAGE_SIZE);

  count.textContent = filtered.length === total
    ? `${total} closed`
    : `${filtered.length} of ${total} closed`;

  if (!filtered.length) {
    const msg = historyPositions.length ? "No positions match filters" : "No closed positions yet";
    tbody.innerHTML = `<tr><td colspan="12" class="empty-state">${msg}</td></tr>`;
    if (paginationEl) paginationEl.innerHTML = "";
    return;
  }

  tbody.innerHTML = page.map(p => buildHistoryRow(p)).join("");

  tbody.querySelectorAll(".expand-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleExpand(btn.dataset.pos, "history");
    });
  });

  tbody.querySelectorAll("tr[data-pos]").forEach(row => {
    row.addEventListener("click", () => toggleExpand(row.dataset.pos, "history"));
  });

  // Pagination controls
  if (paginationEl) {
    if (totalPages <= 1) {
      paginationEl.innerHTML = "";
    } else {
      const from = start + 1;
      const to = Math.min(start + HISTORY_PAGE_SIZE, filtered.length);
      paginationEl.innerHTML = `
        <button class="page-btn" onclick="goPage(${historyPage - 1})" ${historyPage === 0 ? "disabled" : ""}>← Prev</button>
        <span class="page-info">${from}–${to} of ${filtered.length}</span>
        <button class="page-btn" onclick="goPage(${historyPage + 1})" ${historyPage >= totalPages - 1 ? "disabled" : ""}>Next →</button>
      `;
    }
  }
}

function goPage(page) {
  historyPage = page;
  renderHistoryPositions();
  document.getElementById("tab-history")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function buildHistoryRow(p) {
  const pnlPct = p.pnl_pct ?? 0;
  const pnlUsd = p.pnl_usd;
  const pnlSol = p.pnl_sol;
  const expanded = expandedRows.has("history_" + p.position);
  const dd = p.trough_pnl_pct;

  return `
    <tr class="${expanded ? "expanded" : ""}" data-pos="${p.position}">
      <td>
        <div class="pair-cell">${esc(p.pool_name || "?/?")}</div>
        <div class="pool-cell copy-addr" onclick="copyAddr(event,'${esc(p.pool)}')" title="${esc(p.pool)}">${trimAddr(p.pool)}</div>
        ${p.strategy ? `<span class="tag tag-strategy-${p.strategy}">${p.strategy}</span>` : ""}
      </td>
      <td class="num ${pnlClass(pnlPct)}">${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%</td>
      <td class="num ${pnlClass(pnlUsd ?? 0)}">${pnlUsd != null ? (pnlUsd >= 0 ? "+$" : "-$") + fmt(Math.abs(pnlUsd)) : "—"}</td>
      <td class="num ${pnlClass(pnlSol ?? 0)}">${pnlSol != null ? (pnlSol >= 0 ? "+" : "") + Number(pnlSol).toFixed(4) : "—"}</td>
      <td class="num ${dd != null && dd < 0 ? "pnl-neg" : "pnl-zero"}">${dd != null ? dd.toFixed(2) + "%" : "—"}</td>
      <td class="num">${p.minutes_held != null ? fmtAge(p.minutes_held) : "—"}</td>
      <td class="num">${p.range_efficiency != null ? p.range_efficiency.toFixed(0) + "%" : "—"}</td>
      <td class="num">${fmtBinUtil(p.bin_utilization)}</td>
      <td class="num" style="white-space:nowrap;font-size:11px">${p.deployed_at ? fmtDatetime(p.deployed_at) : "—"}</td>
      <td class="num" style="white-space:nowrap;font-size:11px">${p.closed_at ? fmtDatetime(p.closed_at) : "—"}</td>
      <td>${fmtExitType(p.exit_reason_type)}</td>
      <td>
        <span class="${p.close_reason ? "closed-badge" : ""}">${esc(p.close_reason || "—")}</span>
        <button class="expand-btn" data-pos="${p.position}" style="margin-left:6px">${expanded ? "▲" : "▼"}</button>
      </td>
    </tr>
    ${expanded ? buildHistoryExpandedRow(p) : ""}
  `;
}

// ─── Expanded Row (History: entry + exit side by side) ───────────

function buildHistoryExpandedRow(p) {
  const es = p.entry_snapshot || {};
  const ess = es.signal_snapshot || {};
  const exs = p.exit_signal_snapshot || {};

  function d(v) { return v != null && v !== "" ? v : null; }
  function usd(v) { return v != null ? "$" + fmt(v) : null; }
  function sol(v) { return v != null ? Number(v).toFixed(4) + " SOL" : null; }
  function signedUsd(v) { return v != null ? (v >= 0 ? "+$" : "-$") + fmt(Math.abs(v)) : null; }
  function signedSol(v) { return v != null ? (v >= 0 ? "+" : "") + Number(v).toFixed(4) + " SOL" : null; }
  function pct(v, decimals = 2) { return v != null ? Number(v).toFixed(decimals) + "%" : null; }
  function signed(v, decimals = 2) { return v != null ? (v >= 0 ? "+" : "") + Number(v).toFixed(decimals) + "%" : null; }

  const entryFields = [
    ["Deployed At",    p.deployed_at ? new Date(p.deployed_at).toLocaleString() : null],
    ["Strategy",       d(p.strategy || es.strategy)],
    ["Initial Value USD", usd(es.initial_value_usd)],
    ["Initial Value SOL", sol(es.initial_value_sol)],
    ["Active Bin",     d(es.active_bin_at_deploy)],
    ["Bin Step",       d(es.bin_step)],
    ["Volatility",     d(es.volatility)],
    ["Fee/TVL",        es.fee_tvl_ratio != null ? es.fee_tvl_ratio.toFixed(3) : null],
    ["Organic Score",  d(ess.organic_score ?? es.organic_score)],
    ["MCAP",           usd(ess.mcap)],
    ["TVL",            usd(ess.tvl)],
    ["Volume",         usd(ess.volume)],
    ["Holders",        d(ess.holder_count)],
    ["Token Age",      ess.token_age_hours != null ? ess.token_age_hours + "h" : null],
    ["Launchpad",      d(ess.launchpad)],
    ["vs ATH",         pct(ess.price_vs_ath_pct)],
    ["vs Local ATH",   pct(ess.local_price_vs_ath_pct)],
    ["Price 1h",       ess.price_change_1h != null ? Number(ess.price_change_1h).toFixed(1) + "%" : null],
    ["RSI 5m",         ess.rsi_5m != null ? Number(ess.rsi_5m).toFixed(1) : null],
    ["ST 5m",          d(ess.st_dir_5m)],
    ["RSI 15m",        ess.rsi_15m != null ? Number(ess.rsi_15m).toFixed(1) : null],
    ["ST 15m",         d(ess.st_dir_15m)],
    ["Bot Holders",    pct(ess.bot_holders_pct)],
    ["Top 10%",        pct(ess.top10_holders_pct)],
    ["Smart Wallets",  d(ess.smart_wallets_count)],
    ["Net Buyers 1h",  d(ess.net_buyers_1h)],
    ["Fee %",          pct(ess.fee_pct)],
    ["Fee Window",     ess.fee_window != null ? fmt(ess.fee_window) + " SOL" : null],
    ["Bin Range",      es.bin_range ? es.bin_range.bins_below + "/" + (es.bin_range.bins_above ?? 0) + " bins" : null],
  ].filter(([, v]) => v != null);

  const exitFields = [
    ["Closed At",      p.closed_at ? new Date(p.closed_at).toLocaleString() : null],
    ["Hold Time",      p.minutes_held != null ? fmtAge(p.minutes_held) : null],
    ["Final Value USD", usd(p.final_value_usd)],
    ["Final Value SOL", sol(p.final_value_sol)],
    ["Fees Earned USD", usd(p.fees_earned_usd)],
    ["Fees Earned SOL", sol(p.fees_earned_sol)],
    ["PnL USD",        signedUsd(p.pnl_usd)],
    ["PnL SOL",        signedSol(p.pnl_sol)],
    ["PnL %",          signed(p.pnl_pct)],
    ["Max DD",         p.trough_pnl_pct != null ? p.trough_pnl_pct.toFixed(2) + "%" : null],
    ["Peak PnL",       signed(p.peak_pnl_pct)],
    ["Range Eff.",     p.range_efficiency != null ? p.range_efficiency.toFixed(1) + "%" : null],
    ["MCAP at Exit",   usd(exs.mcap)],
    ["TVL at Exit",    usd(exs.tvl)],
    ["Volume at Exit", usd(exs.volume)],
    ["Organic Score",  d(exs.organic_score)],
    ["vs ATH",         pct(exs.price_vs_ath_pct)],
    ["Price 1h",       exs.price_change_1h != null ? Number(exs.price_change_1h).toFixed(1) + "%" : null],
    ["RSI 5m",         exs.rsi_exit_5m != null ? Number(exs.rsi_exit_5m).toFixed(1) : (exs.rsi_5m != null ? Number(exs.rsi_5m).toFixed(1) : null)],
    ["ST 5m",          d(exs.st_dir_exit_5m ?? exs.st_dir_5m)],
    ["RSI 15m",        exs.rsi_exit_15m != null ? Number(exs.rsi_exit_15m).toFixed(1) : (exs.rsi_15m != null ? Number(exs.rsi_15m).toFixed(1) : null)],
    ["ST 15m",         d(exs.st_dir_exit_15m ?? exs.st_dir_15m)],
    ["Holders",        d(exs.holder_count)],
    ["Smart Wallets",  d(exs.smart_wallets_count)],
    ["Close Reason",   d(p.close_reason)],
  ].filter(([, v]) => v != null);

  const mkGrid = (fields) => fields.map(([label, value]) => `
    <div class="snap-field">
      <span class="snap-label">${label}</span>
      <span class="snap-value">${esc(String(value))}</span>
    </div>
  `).join("");

  return `
    <tr class="expanded-row">
      <td colspan="10">
        <div class="snapshot-cards-row">
          <div class="snapshot-card">
            <div class="snapshot-title">Entry Snapshot</div>
            <div class="snapshot-grid">${mkGrid(entryFields)}</div>
          </div>
          <div class="snapshot-card">
            <div class="snapshot-title">Exit Snapshot</div>
            <div class="snapshot-grid">${mkGrid(exitFields)}</div>
          </div>
        </div>
      </td>
    </tr>
  `;
}

// ─── Expanded Row (Current: entry snapshot) ───────────────────────

function buildExpandedRow(p) {
  const snap = p.entry_snapshot || {};
  const ss = snap.signal_snapshot || {};

  function d(v) { return v != null && v !== "" ? v : null; }
  function usd(v) { return v != null ? "$" + fmt(v) : null; }
  function pct(v) { return v != null ? Number(v).toFixed(2) + "%" : null; }

  const fields = [
    ["Deployed At",   p.deployed_at ? new Date(p.deployed_at).toLocaleString() : null],
    ["Strategy",      d(p.strategy || snap.strategy)],
    ["Initial Value", usd(snap.initial_value_usd)],
    ["Active Bin",    d(snap.active_bin_at_deploy)],
    ["Bin Step",      d(snap.bin_step)],
    ["Volatility",    d(snap.volatility)],
    ["Fee/TVL",       snap.fee_tvl_ratio != null ? snap.fee_tvl_ratio.toFixed(3) : null],
    ["Organic Score", d(ss.organic_score ?? snap.organic_score)],
    ["MCAP",          usd(ss.mcap)],
    ["TVL",           usd(ss.tvl)],
    ["Volume",        usd(ss.volume)],
    ["Holders",       d(ss.holder_count)],
    ["Token Age",     ss.token_age_hours != null ? ss.token_age_hours + "h" : null],
    ["Launchpad",     d(ss.launchpad)],
    ["vs ATH",        pct(ss.price_vs_ath_pct)],
    ["vs Local ATH",  pct(ss.local_price_vs_ath_pct)],
    ["Price 1h",      ss.price_change_1h != null ? Number(ss.price_change_1h).toFixed(1) + "%" : null],
    ["RSI 5m",        ss.rsi_5m != null ? Number(ss.rsi_5m).toFixed(1) : null],
    ["ST 5m",         d(ss.st_dir_5m)],
    ["RSI 15m",       ss.rsi_15m != null ? Number(ss.rsi_15m).toFixed(1) : null],
    ["ST 15m",        d(ss.st_dir_15m)],
    ["Bot Holders",   pct(ss.bot_holders_pct)],
    ["Top 10%",       pct(ss.top10_holders_pct)],
    ["Smart Wallets", d(ss.smart_wallets_count)],
    ["Net Buyers 1h", d(ss.net_buyers_1h)],
    ["Fee %",         pct(ss.fee_pct)],
    ["Bin Range",     snap.bin_range ? snap.bin_range.bins_below + "/" + (snap.bin_range.bins_above ?? 0) + " bins" : null],
  ].filter(([, v]) => v != null);

  const gridHtml = fields.map(([label, value]) => `
    <div class="snap-field">
      <span class="snap-label">${label}</span>
      <span class="snap-value">${esc(String(value))}</span>
    </div>
  `).join("");

  return `
    <tr class="expanded-row">
      <td colspan="9">
        <div class="snapshot-card">
          <div class="snapshot-title">Entry Snapshot</div>
          <div class="snapshot-grid">${gridHtml}</div>
        </div>
      </td>
    </tr>
  `;
}


function toggleExpand(posKey, tab) {
  const fullKey = tab + "_" + posKey;
  if (expandedRows.has(fullKey)) {
    expandedRows.delete(fullKey);
  } else {
    expandedRows.add(fullKey);
  }
  if (tab === "current") renderCurrentPositions();
  else renderHistoryPositions();
}

// ─── Bin Range Bar ────────────────────────────────────────────────

function buildBinBar(p) {
  const lower = p.lower_bin;
  const upper = p.upper_bin;
  const active = p.active_bin;

  if (lower == null || upper == null || active == null) {
    return `<span class="neutral">—</span>`;
  }

  const inRange = active >= lower && active <= upper;
  const totalRange = upper - lower || 1;
  const activeOffset = Math.max(0, Math.min(1, (active - lower) / totalRange));

  const markerLeft = (activeOffset * 100).toFixed(1);

  const statusClass = inRange ? "in-range-badge" : "oor-badge";
  const statusText = inRange ? "in range" : "OOR";

  return `
    <div class="bin-bar">
      <div class="bin-range-fill">
        <div class="bin-range-marker" style="left:${markerLeft}%"></div>
      </div>
      <span class="${statusClass}" style="font-size:10px;white-space:nowrap">${statusText}</span>
    </div>
  `;
}

// ─── Tab Switching ─────────────────────────────────────────────────

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === "tab-" + tab));
}

// ─── Modal ────────────────────────────────────────────────────────

function openModal(title, bodyHtml) {
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-body").innerHTML = bodyHtml;
  document.getElementById("snapshot-modal").classList.add("open");
}

function closeModal() {
  document.getElementById("snapshot-modal").classList.remove("open");
}

// ─── Copy Address ────────────────────────────────────────────────

function copyAddr(event, addr) {
  event.stopPropagation();
  if (!addr) return;
  navigator.clipboard.writeText(addr).then(() => {
    const el = event.currentTarget;
    const prev = el.textContent;
    el.textContent = "copied!";
    el.classList.add("copy-flash");
    setTimeout(() => {
      el.textContent = prev;
      el.classList.remove("copy-flash");
    }, 1000);
  }).catch(() => {});
}

// ─── Utilities ────────────────────────────────────────────────────

function fmtBinUtil(util) {
  if (!util) return "—";
  return util.utilization_pct.toFixed(1) + "%";
}

function fmtExitType(type) {
  if (!type) return "—";
  const cls = type === "MANUAL" ? "" : type === "STOP_LOSS" ? "negative" : type === "TRAILING_TP" ? "positive" : type === "OUT_OF_RANGE" ? "oor-badge" : type === "LOW_YIELD" ? "fee-cell" : "";
  return `<span class="${cls}">${type}</span>`;
}

function fmt(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (Math.abs(v) >= 1_000)     return (v / 1_000).toFixed(2) + "K";
  return v.toFixed(2);
}

function fmtDatetime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const mo = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${mo}/${day} ${hh}:${mm}`;
}

function fmtAge(minutes) {
  if (minutes == null || minutes < 0) return "—";
  if (minutes < 60)  return minutes + "m";
  if (minutes < 1440) return Math.floor(minutes / 60) + "h";
  return (minutes / 1440).toFixed(1) + "d";
}

function pnlClass(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "pnl-zero";
  return n > 0 ? "pnl-pos" : "pnl-neg";
}

function pnlClassSimple(n) {
  if (n > 0) return "positive";
  if (n < 0) return "negative";
  return "neutral";
}

function trimAddr(addr) {
  if (!addr || typeof addr !== "string") return "—";
  return addr.length > 16 ? addr.slice(0, 6) + "…" + addr.slice(-4) : addr;
}

function esc(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function updateSyncTime() {
  const el = document.getElementById("sync-time");
  if (!el) return;
  if (!lastSync) {
    el.textContent = "never synced";
    return;
  }
  const secs = Math.floor((Date.now() - lastSync.getTime()) / 1000);
  if (secs < 5) el.textContent = "just now";
  else if (secs < 60) el.textContent = secs + "s ago";
  else el.textContent = Math.floor(secs / 60) + "m ago";
}

// syncTimer is set in DOMContentLoaded handler above

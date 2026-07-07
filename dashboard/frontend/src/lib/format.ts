import type { BinUtilization } from "../types";

export function fmt(v: number | null | undefined, decimals = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: 0 });
}

export function usd(v: number | null | undefined): string | null {
  if (v == null) return null;
  return "$" + fmt(v);
}

export function sol(v: number | null | undefined, decimals = 4): string | null {
  if (v == null) return null;
  return Number(v).toFixed(decimals) + " SOL";
}

export function signed(v: number | null | undefined, decimals = 2): string | null {
  if (v == null) return null;
  return (v >= 0 ? "+" : "") + Number(v).toFixed(decimals) + "%";
}

export function signedSol(v: number | null | undefined, decimals = 4): string | null {
  if (v == null) return null;
  return (v >= 0 ? "+" : "") + Number(v).toFixed(decimals) + " SOL";
}

export function signedUsd(v: number | null | undefined): string | null {
  if (v == null) return null;
  return (v >= 0 ? "+$" : "-$") + fmt(Math.abs(v));
}

export function pnlClass(v: number | null | undefined): string {
  if (v == null || v === 0) return "text-text-dim";
  return v > 0 ? "text-green" : "text-red";
}

export function fmtAge(minutes: number | null | undefined): string {
  if (minutes == null) return "—";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function fmtDatetime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function trimAddr(addr: string | null | undefined, chars = 4): string {
  if (!addr) return "—";
  return `${addr.slice(0, chars)}…${addr.slice(-chars)}`;
}

export function fmtBinUtil(u: BinUtilization | null | undefined): string {
  if (!u || u.utilization_pct == null) return "—";
  const dirTag = u.direction && u.direction !== "none" ? ` ${u.direction}` : "";
  return `${u.utilization_pct.toFixed(0)}%${dirTag}`;
}

export function fmtExitType(type: string | null | undefined): string {
  if (!type) return "—";
  return type
    .toLowerCase()
    .split("_")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

export function exitTypeClass(type: string | null | undefined): string {
  switch (type) {
    case "STOP_LOSS":
    case "MAX_LOSS_HOLD":
      return "text-red";
    case "TRAILING_TP":
    case "TAKE_PROFIT":
      return "text-green";
    case "OUT_OF_RANGE":
      return "text-yellow";
    case "LOW_YIELD":
      return "text-accent-2";
    default:
      return "";
  }
}

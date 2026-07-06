import type { CurrentPosition, HistoryPosition, HealthInfo } from "../types";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function fetchCurrentPositions(): Promise<CurrentPosition[]> {
  const json = await getJson<{ ok: boolean; positions: CurrentPosition[] }>("/api/positions/current");
  return json.positions ?? [];
}

export async function fetchHistoryPositions(): Promise<HistoryPosition[]> {
  const json = await getJson<{ ok: boolean; positions: HistoryPosition[] }>("/api/positions/history");
  return json.positions ?? [];
}

export async function fetchHealth(): Promise<HealthInfo> {
  return getJson<HealthInfo>("/api/health");
}

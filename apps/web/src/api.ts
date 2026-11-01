import type {
  CurrentEnergyResponse,
  DailyBalanceResponse,
  DailyBalancesResponse,
  HistoryResponse,
  MetaResponse,
  RangeBalanceResponse,
  WeatherResponse,
} from "@hef/energy-domain";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { accept: "application/json" } });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `HTTP ${response.status}`, response.status);
  }
  return (await response.json()) as T;
}

export const api = {
  meta: (signal?: AbortSignal) => getJson<MetaResponse>("/api/meta", signal),
  current: (signal?: AbortSignal) => getJson<CurrentEnergyResponse>("/api/energy/current", signal),
  history: (date: string, signal?: AbortSignal) =>
    getJson<HistoryResponse>(`/api/energy/history?date=${date}&bucketMinutes=5`, signal),
  balance: (date: string, signal?: AbortSignal) =>
    getJson<DailyBalanceResponse>(`/api/energy/balance?date=${date}`, signal),
  dailyBalances: (days: number, signal?: AbortSignal) =>
    getJson<DailyBalancesResponse>(`/api/energy/balance/daily?days=${days}`, signal),
  weather: (signal?: AbortSignal) => getJson<WeatherResponse>("/api/weather", signal),
  range: (from: string, to: string, signal?: AbortSignal) =>
    getJson<RangeBalanceResponse>(`/api/energy/balance/range?from=${from}&to=${to}`, signal),
};

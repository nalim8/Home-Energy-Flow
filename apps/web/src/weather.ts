import type { IconName } from "./components/Icon";

/** Beschreibung und Symbol eines WMO-Wettercodes (wie von Open-Meteo geliefert) */
export function describeWeather(code: number, isDay = true): { label: string; icon: IconName } {
  if (code <= 1) return { label: code === 0 ? "Klar" : "Überwiegend klar", icon: isDay ? "sun" : "moon" };
  if (code === 2) return { label: "Teilweise bewölkt", icon: isDay ? "cloudSun" : "cloud" };
  if (code === 3) return { label: "Bedeckt", icon: "cloud" };
  if (code === 45 || code === 48) return { label: "Nebel", icon: "fog" };
  if (code >= 51 && code <= 57) return { label: "Nieselregen", icon: "rain" };
  if (code >= 61 && code <= 67) return { label: code >= 66 ? "Gefrierender Regen" : "Regen", icon: "rain" };
  if (code >= 71 && code <= 77) return { label: "Schnee", icon: "snow" };
  if (code >= 80 && code <= 82) return { label: "Regenschauer", icon: "rain" };
  if (code === 85 || code === 86) return { label: "Schneeschauer", icon: "snow" };
  if (code >= 95) return { label: code === 95 ? "Gewitter" : "Gewitter mit Hagel", icon: "storm" };
  return { label: "Unbekannt", icon: "cloud" };
}

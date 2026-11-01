export const wToKw = (watts: number): number => watts / 1000;

export const whToKwh = (wattHours: number): number => wattHours / 1000;

const wFormat = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
const kwhFormat = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const percentFormat = new Intl.NumberFormat("de-DE", { style: "percent", maximumFractionDigits: 0 });

/** Leistung (W) als „3.200 W“ */
export const formatPower = (watts: number): string => `${wFormat.format(watts)} W`;

/** Energie (Wh) als „12,4 kWh“ */
export const formatEnergy = (wattHours: number): string => `${kwhFormat.format(whToKwh(wattHours))} kWh`;

/** Anteil (0–1) als „78 %“ */
export const formatRatio = (ratio: number): string => percentFormat.format(ratio);

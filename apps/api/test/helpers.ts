import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnergySnapshot } from "@hef/energy-domain";
import { loadConfig, type Config } from "../src/config.js";

/** Projektwurzel ohne config.json, damit Tests keine echten Zugangsdaten lesen */
const EMPTY_ROOT = join(tmpdir(), "hef-test-root");

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ LOG_LEVEL: "fatal", APP_TIMEZONE: "Europe/Berlin", ...overrides }, EMPTY_ROOT);
}

export function snapshot(overrides: Partial<EnergySnapshot> = {}): EnergySnapshot {
  return {
    timestamp: "2026-06-21T10:00:00.000Z",
    pvPowerW: 3200,
    householdPowerW: 1100,
    batteryPowerW: 1700,
    batterySocPercent: 78,
    gridPowerW: 400,
    gridDirection: "export",
    source: "demo",
    ...overrides,
  };
}

export const silentLogger = { info() {}, warn() {}, error() {} };

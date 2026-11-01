import type { EnergySnapshot } from "@hef/energy-domain";
import { z } from "zod";

const watts = z.number().finite();

/** Prüft Provider-Daten, bevor sie gespeichert oder ausgeliefert werden. */
export const energySnapshotSchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  pvPowerW: watts.min(0),
  householdPowerW: watts.min(0),
  batteryPowerW: watts,
  batterySocPercent: z.number().min(0).max(100),
  gridPowerW: watts.min(0),
  gridDirection: z.enum(["import", "export", "idle"]),
  source: z.enum(["sungrow-cloud", "sungrow-modbus", "demo"]),
}) satisfies z.ZodType<EnergySnapshot>;

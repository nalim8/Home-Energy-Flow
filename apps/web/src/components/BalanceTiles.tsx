import type { EnergyBalance } from "@hef/energy-domain";
import { formatEnergy, formatRatio } from "../format";

/** Kennzahlen der Tagesbilanz. Energie in kWh, Quoten in Prozent. */
export function BalanceTiles({ balance }: { balance: EnergyBalance }) {
  const tiles = [
    { label: "Erzeugung", value: formatEnergy(balance.pvWh), hint: "PV-Ertrag" },
    { label: "Verbrauch", value: formatEnergy(balance.householdWh), hint: "Haushalt" },
    { label: "Netzbezug", value: formatEnergy(balance.gridImportWh), hint: "aus dem Netz" },
    { label: "Einspeisung", value: formatEnergy(balance.gridExportWh), hint: "ins Netz" },
    {
      label: "Autarkie",
      value: balance.autarkyRate === null ? "–" : formatRatio(balance.autarkyRate),
      hint: "Verbrauch ohne Netzbezug",
    },
    {
      label: "Eigenverbrauch",
      value: balance.selfConsumptionRate === null ? "–" : formatRatio(balance.selfConsumptionRate),
      hint: "PV-Strom selbst genutzt",
    },
  ];

  return (
    <dl className="balance-tiles">
      {tiles.map((t) => (
        <div key={t.label} className="tile">
          <dt>{t.label}</dt>
          <dd className="tile-value">{t.value}</dd>
          <dd className="tile-hint">{t.hint}</dd>
        </div>
      ))}
    </dl>
  );
}

import { sumBalances, type RangeBalanceResponse } from "@hef/energy-domain";
import { useEffect, useState } from "react";
import { api } from "../api";
import { formatDate, formatMonth, shiftDate } from "../format";
import { useRemoteData } from "../hooks";
import { BalanceTiles } from "./BalanceTiles";
import { Icon } from "./Icon";
import { PeriodChart, type PeriodItem } from "./PeriodChart";

type Preset = "7d" | "30d" | "month" | "year" | "custom";

const PRESETS: { key: Preset; label: string }[] = [
  { key: "7d", label: "7 Tage" },
  { key: "30d", label: "30 Tage" },
  { key: "month", label: "Monat" },
  { key: "year", label: "Jahr" },
  { key: "custom", label: "Eigener" },
];

/** Höchstens so viele Tage fragt die API pro Zeitraum ab */
const MAX_DAYS = 366;
/** Ab dieser Länge zeigt das Diagramm Monate statt Tage */
const MONTHLY_FROM_DAYS = 62;
const STORAGE_KEY = "hef.period";

interface Range {
  from: string;
  to: string;
}

function presetRange(preset: Exclude<Preset, "custom">, today: string): Range {
  switch (preset) {
    case "7d":
      return { from: shiftDate(today, -6), to: today };
    case "30d":
      return { from: shiftDate(today, -29), to: today };
    case "month":
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case "year":
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

/** Reihenfolge korrigieren, nicht in die Zukunft und höchstens MAX_DAYS lang */
function normalize({ from, to }: Range, today: string): Range {
  let [a, b] = from <= to ? [from, to] : [to, from];
  if (b > today) b = today;
  if (a > b) a = b;
  const earliest = shiftDate(b, 1 - MAX_DAYS);
  return { from: a < earliest ? earliest : a, to: b };
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

function lastDayOfMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function loadStored(): { preset: Preset; custom?: Range } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as { preset: Preset; custom?: Range }) : null;
  } catch {
    return null;
  }
}

function store(value: { preset: Preset; custom: Range }) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ohne Speicher gilt beim nächsten Besuch wieder die Voreinstellung
  }
}

/** Ab etwa zwei Monaten werden Tage zu Monaten zusammengefasst, sonst wären die Balken zu schmal. */
function toItems(days: RangeBalanceResponse["days"]): { items: PeriodItem[]; monthly: boolean } {
  if (days.length < MONTHLY_FROM_DAYS) {
    const label = days.length <= 10 ? "short" : "dayMonth";
    return {
      monthly: false,
      items: days.map((d) => ({ key: d.date, label: formatDate(d.date, label), title: formatDate(d.date, "short"), balance: d.balance })),
    };
  }
  const months = new Map<string, RangeBalanceResponse["days"]>();
  for (const d of days) months.set(d.date.slice(0, 7), [...(months.get(d.date.slice(0, 7)) ?? []), d]);
  return {
    monthly: true,
    items: [...months].map(([month, list]) => ({
      key: month,
      label: formatMonth(month, "short"),
      title: formatMonth(month, "long"),
      balance: sumBalances(list.map((d) => d.balance)),
    })),
  };
}

interface Props {
  today: string;
  retentionDays: number;
  selectedDate: string;
  onSelectDate: (date: string) => void;
}

/** Bilanz und Tages- bzw. Monatswerte eines wählbaren Zeitraums */
export function PeriodSection({ today, retentionDays, selectedDate, onSelectDate }: Props) {
  const [preset, setPreset] = useState<Preset>(() => loadStored()?.preset ?? "7d");
  const [custom, setCustom] = useState<Range>(() => loadStored()?.custom ?? presetRange("30d", today));
  useEffect(() => store({ preset, custom }), [preset, custom]);

  const range = normalize(preset === "custom" ? custom : presetRange(preset, today), today);
  const includesToday = range.to === today;

  // Solange nachgeladen wird, häufiger aktualisieren. Das Backend lädt höchstens alle
  // 5 Minuten eine Portion nach; öfter zu fragen würde nur den ganzen Zeitraum neu berechnen.
  const [backfilling, setBackfilling] = useState(false);
  const data = useRemoteData(
    `range-${range.from}-${range.to}`,
    (s) => api.range(range.from, range.to, s),
    backfilling ? 60_000 : includesToday ? 5 * 60_000 : null,
  );
  useEffect(() => setBackfilling(data.data?.backfilling ?? false), [data.data]);

  const selectMonth = (month: string) => {
    const end = lastDayOfMonth(month);
    setCustom({ from: `${month}-01`, to: end > today ? today : end });
    setPreset("custom");
  };

  const chart = data.data ? toItems(data.data.days) : null;
  const daysWithData = data.data?.days.filter((d) => d.balance.sampleCount > 0).length ?? 0;
  const oldestKept = shiftDate(today, 1 - retentionDays);

  return (
    <section className="card" aria-labelledby="period-title">
      <div className="card-header">
        <h2 id="period-title">Zeitraum</h2>
        <div className="segmented" role="group" aria-label="Zeitraum wählen">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" aria-pressed={preset === p.key} onClick={() => setPreset(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {preset === "custom" && (
        <div className="range-inputs">
          <label>
            Von
            <input
              type="date"
              value={range.from}
              max={today}
              onChange={(e) => e.target.value && setCustom(normalize({ from: e.target.value, to: range.to }, today))}
            />
          </label>
          <label>
            Bis
            <input
              type="date"
              value={range.to}
              max={today}
              onChange={(e) => e.target.value && setCustom(normalize({ from: range.from, to: e.target.value }, today))}
            />
          </label>
        </div>
      )}

      <p className="range-summary">
        {formatDate(range.from, "short")} – {formatDate(range.to, "short")} {range.to.slice(0, 4)} · {daysBetween(range.from, range.to)} Tage
      </p>

      {data.data && chart ? (
        <>
          <BalanceTiles balance={data.data.total} />
          <PeriodChart
            items={chart.items}
            caption={chart.monthly ? "Erzeugung und Verbrauch je Monat" : "Erzeugung und Verbrauch je Tag"}
            selectedKey={chart.monthly ? undefined : selectedDate}
            onSelect={chart.monthly ? selectMonth : onSelectDate}
          />
          {data.data.backfilling && (
            <p className="chart-note">
              <Icon name="clock" size={14} /> Fehlende Werte werden aus der Datenquelle nachgeladen, die Ansicht aktualisiert sich.
            </p>
          )}
          {!data.data.backfilling && daysWithData < data.data.days.length && (
            <p className="chart-note note-warning">
              <Icon name="alert" size={14} /> Messwerte für {daysWithData} von {data.data.days.length} Tagen
              {range.from < oldestKept && ` – Werte älter als ${retentionDays} Tage werden nicht gespeichert (RETENTION_DAYS)`}.
            </p>
          )}
          {chart.monthly && <p className="chart-note">Klick auf einen Monat zeigt dessen Tage.</p>}
        </>
      ) : (
        <LoadState error={data.error} />
      )}
    </section>
  );
}

function LoadState({ error }: { error: string | null }) {
  if (error) {
    return (
      <p className="status status-critical" role="alert">
        <Icon name="alert" size={16} /> {error}
      </p>
    );
  }
  return <div className="skeleton" aria-label="Lade" />;
}

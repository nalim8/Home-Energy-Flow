import type { CurrentEnergyResponse, MetaResponse } from "@hef/energy-domain";
import { useState } from "react";
import { api } from "./api";
import { BalanceTiles } from "./components/BalanceTiles";
import { EnergyFlow } from "./components/EnergyFlow";
import { FreshnessBadge } from "./components/FreshnessBadge";
import { HistorySection } from "./components/HistorySection";
import { HouseSupply } from "./components/HouseSupply";
import { Icon } from "./components/Icon";
import { PeriodSection } from "./components/PeriodSection";
import { WeatherCard } from "./components/WeatherCard";
import { formatDate, formatTime, shiftDate, todayIn } from "./format";
import { useNow, useRemoteData } from "./hooks";

const SOURCE_LABELS: Record<MetaResponse["source"], string> = {
  demo: "Demo-Daten (synthetisch)",
  "sungrow-cloud": "Sungrow iSolarCloud API",
  "sungrow-modbus": "Sungrow Modbus TCP",
};

export function App() {
  const meta = useRemoteData("meta", api.meta, 60_000);
  if (!meta.data) {
    return (
      <main className="page page-centered">
        {meta.error ? (
          <p className="status status-critical" role="alert">
            <Icon name="off" size={16} /> Backend nicht erreichbar: {meta.error}
          </p>
        ) : (
          <p className="status status-muted">Lade …</p>
        )}
      </main>
    );
  }
  return <Dashboard meta={meta.data} />;
}

function Dashboard({ meta }: { meta: MetaResponse }) {
  const timeZone = meta.timezone;
  const today = todayIn(timeZone);
  const [selectedDate, setSelectedDate] = useState(today);
  const isToday = selectedDate === today;
  useNow(); // „vor 12 s“ sekündlich aktualisieren

  const refreshMs = Math.min(30, Math.max(5, Math.round(meta.pollIntervalSeconds / 2))) * 1000;
  const current = useRemoteData("current", api.current, refreshMs);
  const history = useRemoteData(`history-${selectedDate}`, (s) => api.history(selectedDate, s), isToday ? 60_000 : null);
  const balance = useRemoteData(`balance-${selectedDate}`, (s) => api.balance(selectedDate, s), isToday ? 60_000 : null);

  // Open-Meteo rechnet stündlich neu, das Backend puffert 30 Minuten
  const weather = useRemoteData("weather", api.weather, 15 * 60_000);
  const forecast = weather.data?.available ? weather.data.hourly : undefined;

  const lastSuccess = current.data?.poll.lastSuccessAt;

  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          <img src="/favicon.svg" width={36} height={36} alt="" />
          <div>
            <h1>Home Energy Flow</h1>
            <p className="subtitle">Energiefluss im Einfamilienhaus · PV, Speicher und Netz</p>
          </div>
        </div>
        <FreshnessBadge current={current.data} apiError={current.data ? null : current.error} timeZone={timeZone} />
      </header>

      {meta.demo && (
        <p className="banner" role="note">
          <strong>Demo-Modus:</strong> Alle Werte sind synthetisch erzeugt und stammen nicht von einer realen Anlage.
        </p>
      )}

      {current.data && <PollProblem current={current.data} />}

      <main className="layout">
        <div className="column">
          <section className="card card-flow" aria-labelledby="flow-title">
            <h2 id="flow-title">Aktueller Energiefluss</h2>
            <EnergyFlow snapshot={current.data?.snapshot ?? null} status={current.data?.freshness.status ?? "unavailable"} />
            {current.data?.flows && <HouseSupply flows={current.data.flows} />}
          </section>

          <WeatherCard weather={weather.data} error={weather.error} today={today} />
        </div>

        <div className="column">
          <section className="card" aria-labelledby="balance-title">
            <div className="card-header">
              <h2 id="balance-title">Tagesbilanz</h2>
              <DateNav date={selectedDate} today={today} onChange={setSelectedDate} />
            </div>
            {balance.data ? (
              <>
                <BalanceTiles balance={balance.data.balance} />
                <CoverageNote coveredSeconds={balance.data.balance.coveredSeconds} isToday={isToday} />
              </>
            ) : (
              <LoadState error={balance.error} />
            )}
          </section>

          <PeriodSection today={today} retentionDays={meta.retentionDays} selectedDate={selectedDate} onSelectDate={setSelectedDate} />
        </div>

        <section className="card card-wide" aria-labelledby="history-title">
          <h2 id="history-title">Verlauf · {formatDate(selectedDate)}</h2>
          {history.data ? <HistorySection history={history.data} forecast={forecast} /> : <LoadState error={history.error} />}
        </section>
      </main>

      <footer className="footer">
        <span>Quelle: {SOURCE_LABELS[meta.source]}</span>
        <span>Abrufintervall: {meta.pollIntervalSeconds} s</span>
        <span>Zeitzone: {timeZone}</span>
        {lastSuccess && <span>Letzter erfolgreicher Abruf: {formatTime(lastSuccess, timeZone)} Uhr</span>}
      </footer>
    </div>
  );
}

function DateNav({ date, today, onChange }: { date: string; today: string; onChange: (date: string) => void }) {
  return (
    <div className="date-nav">
      <button type="button" className="icon-button" onClick={() => onChange(shiftDate(date, -1))} aria-label="Vorheriger Tag">
        <Icon name="chevronLeft" size={18} />
      </button>
      <input
        type="date"
        value={date}
        max={today}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        aria-label="Datum wählen"
      />
      <button
        type="button"
        className="icon-button"
        onClick={() => onChange(shiftDate(date, 1))}
        disabled={date >= today}
        aria-label="Nächster Tag"
      >
        <Icon name="chevronRight" size={18} />
      </button>
      {date !== today && (
        <button type="button" className="text-button" onClick={() => onChange(today)}>
          Heute
        </button>
      )}
    </div>
  );
}

/** Weist darauf hin, wenn die Bilanz nur einen Teil des Tages abdeckt. */
function CoverageNote({ coveredSeconds, isToday }: { coveredSeconds: number; isToday: boolean }) {
  const hours = coveredSeconds / 3600;
  if (isToday) return <p className="chart-note">Bisheriger Tagesverlauf, abgedeckt sind {hours.toLocaleString("de-DE", { maximumFractionDigits: 1 })} h.</p>;
  if (hours >= 23) return null;
  return (
    <p className="chart-note note-warning">
      <Icon name="alert" size={14} /> Unvollständige Daten: nur {hours.toLocaleString("de-DE", { maximumFractionDigits: 1 })} h des
      Tages erfasst.
    </p>
  );
}

/** Erklärt, warum keine aktuellen Werte vorliegen, und bietet ggf. die Anmeldung an. */
function PollProblem({ current }: { current: CurrentEnergyResponse }) {
  const { poll, freshness } = current;
  if (poll.lastErrorCode === "auth_required") {
    return (
      <p className="banner banner-warning" role="alert">
        <Icon name="alert" size={16} />
        <span>
          <strong>Sungrow ist nicht autorisiert.</strong> <a href="/auth/sungrow/login">Bei iSolarCloud anmelden</a>, um
          die Messwerte deiner Anlage zu laden.
        </span>
      </p>
    );
  }
  if (!poll.lastError || freshness.status === "live") return null;
  return (
    <p className="banner banner-warning" role="alert">
      <Icon name="alert" size={16} />
      <span>
        <strong>Abruf fehlgeschlagen:</strong> {poll.lastError}
      </span>
    </p>
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

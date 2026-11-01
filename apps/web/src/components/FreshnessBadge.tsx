import type { CurrentEnergyResponse } from "@hef/energy-domain";
import { formatAge, formatTime } from "../format";
import { Icon } from "./Icon";

interface Props {
  current: CurrentEnergyResponse | null;
  /** Fehler beim Laden der eigenen API (nicht des Providers) */
  apiError: string | null;
  timeZone: string;
}

/** Zeigt, ob die angezeigten Werte aktuell sind – immer mit Symbol und Text. */
export function FreshnessBadge({ current, apiError, timeZone }: Props) {
  if (apiError) {
    return (
      <span className="status status-critical" role="status">
        <Icon name="off" size={16} /> Backend nicht erreichbar
      </span>
    );
  }
  if (!current) return <span className="status status-muted">Lade …</span>;

  const { freshness, snapshot, poll } = current;
  const measuredAt = snapshot ? `Messung ${formatTime(snapshot.timestamp, timeZone)} Uhr` : null;

  if (freshness.status === "live") {
    return (
      <span className="status status-good" role="status" title={measuredAt ?? undefined}>
        <span className="live-dot" aria-hidden="true" />
        Live · {formatAge(freshness.ageSeconds ?? 0)}
      </span>
    );
  }

  const reason = poll.lastError ? `Letzter Abruf fehlgeschlagen: ${poll.lastError}` : undefined;
  if (freshness.status === "stale") {
    return (
      <span className="status status-warning" role="status" title={reason}>
        <Icon name="alert" size={16} /> Veraltet · {formatAge(freshness.ageSeconds ?? 0)}
      </span>
    );
  }
  return (
    <span className="status status-critical" role="status" title={reason}>
      <Icon name="off" size={16} /> Keine Messwerte
    </span>
  );
}

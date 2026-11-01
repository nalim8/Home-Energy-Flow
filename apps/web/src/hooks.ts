import { useEffect, useRef, useState } from "react";

export interface RemoteData<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * Lädt Daten und aktualisiert sie optional periodisch. Bei einem Fehler bleibt
 * der letzte erfolgreiche Stand sichtbar; der Fehler wird zusätzlich gemeldet.
 * `key` wechselt die Ressource (z. B. ein anderes Datum) und verwirft alte Daten.
 */
export function useRemoteData<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  refreshMs: number | null = null,
): RemoteData<T> {
  const [state, setState] = useState<RemoteData<T> & { key: string }>({
    key,
    data: null,
    error: null,
    loading: true,
  });
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;

    const run = async () => {
      controller = new AbortController();
      try {
        const data = await loadRef.current(controller.signal);
        if (active) setState({ key, data, error: null, loading: false });
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        setState((prev) => ({ key, data: prev.key === key ? prev.data : null, error: message, loading: false }));
      }
      if (active && refreshMs !== null) timer = setTimeout(run, document.hidden ? refreshMs * 4 : refreshMs);
    };

    void run();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [key, refreshMs]);

  // Während ein neuer Schlüssel lädt, keine Daten des alten anzeigen
  if (state.key !== key) return { data: null, error: null, loading: true };
  return state;
}

/** Breite eines Elements, aktualisiert bei Größenänderungen */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Aktuelle Uhrzeit, sekündlich aktualisiert – für „vor 12 s“-Anzeigen */
export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

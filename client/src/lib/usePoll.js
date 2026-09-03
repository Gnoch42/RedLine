import { useCallback, useEffect, useRef, useState } from 'react';

// While the tab is in the background we still poll, just rarely: never stopping
// outright means an embedded or backgrounded view can't get stuck on stale data.
const HIDDEN_INTERVAL_MS = 30000;

/**
 * Near-real-time by polling (spec §3): simpler to reason about than sockets at
 * committee scale.
 */
export function usePoll(fetcher, { deps = [], intervalMs = 4000, enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const lastLoadRef = useRef(0);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!enabled) return;
    if (!quiet) setLoading(true);
    lastLoadRef.current = Date.now();
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  useEffect(() => {
    if (!enabled) {
      setData(null);
      return undefined;
    }
    let cancelled = false;
    setData(null);
    load();

    const tick = () => {
      if (cancelled) return;
      const stale = Date.now() - lastLoadRef.current >= HIDDEN_INTERVAL_MS;
      if (document.visibilityState === 'visible' || stale) load({ quiet: true });
    };
    const timer = setInterval(tick, intervalMs);
    // Coming back to the tab should feel instant, not wait for the next tick.
    document.addEventListener('visibilitychange', tick);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, intervalMs, enabled]);

  return { data, error, loading, refresh: () => load({ quiet: true }) };
}

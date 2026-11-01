'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ChangeEvent, ChangeTopic } from '@velnox/shared';
import { refreshSecondsInBrowser } from '@/lib/refresh-preference';

/** What one part of a screen wants to hear about. */
export interface ChangeInterest {
  topics: readonly ChangeTopic[];
  /** Clusters on screen, whose live status the stream keeps read while open. */
  clusters?: readonly string[];
}

type Listener = (event: ChangeEvent) => void;

interface ChangeStream {
  subscribe(interest: ChangeInterest, listener: Listener): () => void;
  /** True while the stream is open and delivering; false means fall back to polling. */
  streaming: boolean;
}

const ChangeStreamContext = createContext<ChangeStream | null>(null);

/** A stream the browser gave up on (refused, say) is tried again after this. */
const RETRY_AFTER_CLOSE_MS = 60_000;
/** A stream reconnecting by itself still counts as open for this long. */
const RECONNECT_GRACE_MS = 10_000;
/** The intervals the API accepts for keeping live status read; anything else watches nothing. */
const LIVE_REFRESH = [2, 5, 10, 30, 60];
const MAX_CLUSTERS = 200;

/**
 * One "something changed" stream per tab (ADR-059), shared by every part of the
 * screen that wants one: the page, and the running-jobs bar beside it.
 *
 * It opens only while something is subscribed and the tab is visible, asks for
 * the union of what the subscribers want, and reopens when that changes — on
 * navigation, typically. It carries no data: a subscriber that hears of a
 * change reads its data the way it always has.
 */
export function ChangesProvider({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<number, { interest: ChangeInterest; listener: Listener }>());
  const nextId = useRef(0);
  const [query, setQuery] = useState('');
  const [streaming, setStreaming] = useState(false);

  const recompute = useCallback(() => {
    const topics = new Set<string>();
    const clusters = new Set<string>();
    for (const { interest } of entries.current.values()) {
      for (const topic of interest.topics) topics.add(topic);
      for (const cluster of interest.clusters ?? []) clusters.add(cluster);
    }
    if (topics.size === 0) return setQuery('');
    const params = new URLSearchParams({ topics: [...topics].sort().join(',') });
    const refresh = refreshSecondsInBrowser();
    if (clusters.size > 0 && LIVE_REFRESH.includes(refresh)) {
      params.set('clusters', [...clusters].sort().slice(0, MAX_CLUSTERS).join(','));
      params.set('refresh', String(refresh));
    }
    // The same string as before is no change of state, so no reconnect.
    setQuery(params.toString());
  }, []);

  const subscribe = useCallback(
    (interest: ChangeInterest, listener: Listener) => {
      const id = nextId.current++;
      entries.current.set(id, { interest, listener });
      recompute();
      return () => {
        entries.current.delete(id);
        recompute();
      };
    },
    [recompute],
  );

  useEffect(() => {
    if (!query) return;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let grace: ReturnType<typeof setTimeout> | null = null;

    const clearGrace = () => {
      if (grace !== null) clearTimeout(grace);
      grace = null;
    };

    const close = () => {
      clearGrace();
      source?.close();
      source = null;
      setStreaming(false);
    };

    const open = () => {
      if (source || document.visibilityState !== 'visible') return;
      if (retry !== null) clearTimeout(retry);
      retry = null;

      const opened = new EventSource(`/api/v1/changes?${query}`);
      source = opened;
      opened.addEventListener('ready', () => {
        clearGrace();
        setStreaming(true);
      });
      opened.addEventListener('change', (message) => {
        let event: ChangeEvent;
        try {
          event = JSON.parse((message as MessageEvent<string>).data) as ChangeEvent;
        } catch {
          return;
        }
        for (const { interest, listener } of entries.current.values()) {
          if (interest.topics.includes(event.topic)) listener(event);
        }
      });
      opened.onerror = () => {
        if (opened.readyState === EventSource.CLOSED) {
          // Refused — signed out, say. Polling takes over; the stream is tried
          // again later, and a signed-out screen's next poll goes to sign-in.
          close();
          retry = setTimeout(open, RETRY_AFTER_CLOSE_MS);
          return;
        }
        // Reconnecting by itself, as it does when the API ends a stream on
        // schedule. Polling takes over only if that does not come back soon.
        if (grace === null) grace = setTimeout(() => setStreaming(false), RECONNECT_GRACE_MS);
      };
    };

    const onVisibility = () => (document.visibilityState === 'visible' ? open() : close());

    open();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (retry !== null) clearTimeout(retry);
      close();
    };
  }, [query]);

  const value = useMemo(() => ({ subscribe, streaming }), [subscribe, streaming]);
  return <ChangeStreamContext.Provider value={value}>{children}</ChangeStreamContext.Provider>;
}

/** While the stream is open, a screen still re-reads this often, for what it does not signal. */
export const STREAMING_FALLBACK_MS = 60_000;

export interface RefreshOn extends ChangeInterest {
  /** Ignore inventory changes on clusters other than `clusters`. */
  onlyTheseClusters?: boolean;
}

/**
 * Call `refresh` when something it shows changes, at most once per
 * `intervalMs` — the viewer's own refresh setting, which stays the ceiling.
 *
 * Without `on`, or while no stream is open, it is the interval it always was.
 * With a stream open it re-reads only on a change, plus once a minute for what
 * no change signals (a name edited by someone else, say). Nothing runs in a
 * hidden tab; coming back re-reads once. `enabled: false` stops everything —
 * see useAutoRefresh for why that matters.
 */
export function useRefreshOn(
  refresh: () => void,
  intervalMs: number,
  enabled: boolean,
  on?: RefreshOn,
): void {
  const stream = useContext(ChangeStreamContext);
  const streaming = Boolean(on && stream?.streaming);
  const latest = useRef(refresh);
  latest.current = refresh;
  const last = useRef(0);

  const topics = on?.topics.join(',') ?? '';
  const clusters = on?.clusters?.join(',') ?? '';
  const onlyThese = on?.onlyTheseClusters === true;
  const subscribe = stream?.subscribe;

  // The interval: the fallback while streaming, the whole mechanism otherwise.
  useEffect(() => {
    if (!enabled) return;
    const period = streaming ? Math.max(intervalMs, STREAMING_FALLBACK_MS) : intervalMs;
    const run = () => {
      last.current = Date.now();
      latest.current();
    };

    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      if (timer === null) timer = setInterval(run, period);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        run();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs, enabled, streaming]);

  // The changes.
  useEffect(() => {
    if (!enabled || !subscribe || !topics) return;
    const onScreen = clusters ? clusters.split(',') : [];
    let pending: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = subscribe(
      { topics: topics.split(',') as ChangeTopic[], clusters: onScreen },
      (event) => {
        if (
          onlyThese &&
          event.topic === 'inventory' &&
          event.clusterId !== null &&
          !onScreen.includes(event.clusterId)
        ) {
          return;
        }
        if (pending !== null) return;
        // At most once per interval: the first change at once, a burst after it
        // gathered into one re-read at the end of the interval.
        const wait = Math.max(0, last.current + intervalMs - Date.now());
        pending = setTimeout(() => {
          pending = null;
          if (document.visibilityState !== 'visible') return;
          last.current = Date.now();
          latest.current();
        }, wait);
      },
    );
    return () => {
      unsubscribe();
      if (pending !== null) clearTimeout(pending);
    };
  }, [enabled, subscribe, topics, clusters, onlyThese, intervalMs]);
}

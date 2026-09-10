'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet, type ApiFailure } from '@/lib/client-api';

/**
 * One GET, loaded when the component mounts.
 *
 * The Server management panels each read one endpoint and are mounted the
 * moment their tab is selected, so this is the whole of their data layer. Kept
 * as a hook rather than repeated three times because the loading and failure
 * states are the part that gets forgotten, and forgetting them is how a panel
 * ends up rendering an empty table while a request is still in flight.
 *
 * `state` is explicit rather than inferred from `data === null`: "loading" and
 * "loaded, and there is nothing" are different things to show.
 */
export type ResourceState<T> =
  | { state: 'loading'; data: null; error: null }
  | { state: 'ready'; data: T; error: null }
  | { state: 'failed'; data: null; error: ApiFailure };

export function useApiResource<T>(path: string): ResourceState<T> & { reload: () => void } {
  const [result, setResult] = useState<ResourceState<T>>({
    state: 'loading',
    data: null,
    error: null,
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setResult({ state: 'loading', data: null, error: null });

    void apiGet<T>(path).then((response) => {
      // The tab may have been switched, or the window closed, while this was in
      // flight. Setting state then is a warning in development and a leak in
      // principle.
      if (!live) return;

      setResult(
        response.ok
          ? { state: 'ready', data: response.data, error: null }
          : { state: 'failed', data: null, error: response.error },
      );
    });

    return () => {
      live = false;
    };
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { ...result, reload };
}

import { useCallback, useEffect, useRef, useState } from 'react';

export const STATUS = {
  LOADING: 'loading',
  SUCCESS: 'success',
  ERROR: 'error',
};

/**
 * Generic async data hook exposing a clear loading -> success | error state
 * machine with a manual reload, mirroring useHealth. Keeps fetching out of
 * components. `fetcher` is re-invoked whenever `deps` change; wrap it in
 * useCallback or pass a stable deps array to avoid fetch loops.
 */
export function useApi(fetcher, deps = []) {
  const [status, setStatus] = useState(STATUS.LOADING);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const mounted = useRef(true);
  // Monotonic request id: only the newest request may write state, so a slow
  // earlier response can never overwrite (or flicker) a newer one.
  const requestId = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const myRequest = ++requestId.current;
    setStatus(STATUS.LOADING);
    setError(null);
    try {
      const json = await fetcher();
      if (!mounted.current || myRequest !== requestId.current) return;
      setData(json);
      setStatus(STATUS.SUCCESS);
    } catch (e) {
      if (!mounted.current || myRequest !== requestId.current) return;
      setError(e);
      setStatus(STATUS.ERROR);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    load();
  }, [load]);

  return { status, data, error, reload: load, setData, STATUS };
}

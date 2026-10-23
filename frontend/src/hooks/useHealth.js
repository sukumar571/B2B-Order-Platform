import { useCallback, useEffect, useState } from 'react';
import { fetchHealth } from '../services/api.js';

const STATUS = {
  LOADING: 'loading',
  SUCCESS: 'success',
  ERROR: 'error',
};

/**
 * Fetches the backend health endpoint and exposes a clear status machine:
 * loading -> success | error, with a manual retry. Keeps data-fetching out of
 * components (docs/architecture.md §1 frontend layering).
 */
export function useHealth() {
  const [status, setStatus] = useState(STATUS.LOADING);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setStatus(STATUS.LOADING);
    setError(null);
    try {
      const json = await fetchHealth();
      setData(json);
      setStatus(STATUS.SUCCESS);
    } catch (e) {
      setError(e.message || 'Failed to reach the API');
      setStatus(STATUS.ERROR);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { status, data, error, retry: load, STATUS };
}

export { STATUS };

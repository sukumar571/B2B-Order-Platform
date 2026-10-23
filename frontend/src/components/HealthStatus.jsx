import { STATUS } from '../hooks/useHealth.js';

/**
 * Presentational component that renders the three required states for the
 * health check: loading, success, and failure. Kept dumb/pure so it is easy to
 * unit test with React Testing Library (docs/requirements.md C-08).
 */
export default function HealthStatus({ status, data, error, onRetry }) {
  if (status === STATUS.LOADING) {
    return (
      <div className="health health--loading" role="status" aria-live="polite">
        <span className="health__dot health__dot--pending" aria-hidden="true" />
        <p className="health__text">Checking API connection…</p>
      </div>
    );
  }

  if (status === STATUS.SUCCESS) {
    return (
      <div className="health health--success" role="status">
        <span className="health__dot health__dot--ok" aria-hidden="true" />
        <p className="health__title">API connected — {data?.status ?? 'ok'}</p>
        <dl className="health__meta">
          <div>
            <dt>Uptime</dt>
            <dd>{data?.uptimeSeconds ?? 0}s</dd>
          </div>
          <div>
            <dt>Server time</dt>
            <dd>{data?.timestamp ? new Date(data.timestamp).toLocaleTimeString() : '—'}</dd>
          </div>
        </dl>
      </div>
    );
  }

  return (
    <div className="health health--error" role="alert">
      <span className="health__dot health__dot--err" aria-hidden="true" />
      <p className="health__title">Cannot reach the API</p>
      <p className="health__text">{error || 'Unknown error'}</p>
      <button type="button" className="health__retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

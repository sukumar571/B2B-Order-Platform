import { STATUS } from '../hooks/useApi.js';

/** Reusable presentation of the four data-fetch states + a validation summary. */

export function LoadingState({ label = 'Loading…' }) {
  return (
    <div className="state state--loading" role="status" aria-live="polite">
      <span className="state__dot" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  const message = error?.message || 'Something went wrong.';
  return (
    <div className="state state--error" role="alert">
      <p className="state__title">Could not load data</p>
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="btn btn--secondary" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title = 'Nothing here yet', hint }) {
  return (
    <div className="state state--empty">
      <p className="state__title">{title}</p>
      {hint ? <p>{hint}</p> : null}
    </div>
  );
}

/**
 * Renders loading/error/empty automatically; otherwise calls children(data).
 * `children` MUST be a render-prop function — plain JSX children would be
 * evaluated by the page before the data exists (data is still null then).
 */
export function DataBoundary({ status, data, error, onRetry, emptyTitle, children }) {
  if (status === STATUS.LOADING) return <LoadingState />;
  if (status === STATUS.ERROR) return <ErrorState error={error} onRetry={onRetry} />;
  const items = Array.isArray(data?.data) ? data.data : null;
  if (items && items.length === 0) return <EmptyState title={emptyTitle || 'No results found'} />;
  if (typeof children !== 'function') {
    throw new Error('DataBoundary expects a render-prop function as children');
  }
  return children(data);
}

/** Maps a backend 400 VALIDATION_ERROR `details` ({field: message}) to a list. */
export function ValidationErrors({ error }) {
  const details = error?.details;
  if (!details || typeof details !== 'object') return null;
  const entries = Object.entries(details);
  if (entries.length === 0) return null;
  return (
    <ul className="form__errors" role="alert">
      {entries.map(([field, msg]) => (
        <li key={field}>
          <strong>{field}</strong>: {String(msg)}
        </li>
      ))}
    </ul>
  );
}

/**
 * Full backend rejection summary for forms: the human-readable message is
 * always shown (409 DUPLICATE_SKU / INSUFFICIENT_STOCK, 401, 403 carry no
 * field details) plus any per-field validation list.
 */
export function FormProblem({ error }) {
  if (!error) return null;
  return (
    <>
      <p className="form__message form__message--error" role="alert">
        {error.message || 'The request was rejected.'}
      </p>
      <ValidationErrors error={error} />
    </>
  );
}

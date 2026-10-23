import { useCallback, useMemo, useState } from 'react';
import { fetchAuditLogs } from '../services/api.js';
import { useApi } from '../hooks/useApi.js';
import { useAuth } from '../context/AuthContext.jsx';
import { DataBoundary } from '../components/States.jsx';
import AuditOutcomeBadge from '../components/AuditOutcomeBadge.jsx';
import {
  AUDIT_ACTION_VALUES,
  AUDIT_ENTITY_TYPE_VALUES,
  AUDIT_OUTCOME_VALUES,
  AUDIT_OUTCOME_LABELS,
  actionLabel,
} from '../constants/auditStatus.js';
import { totalPages, pageSummary } from '../utils/pagination.js';

const PAGE_SIZE = 25;

function formatStamp(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

/**
 * The audit trail viewer (FR-AUD-03). ADMIN-only — the route guard is a UX hint;
 * the server rejects a non-admin with 403 before any data is read. This is a
 * READ-ONLY surface: the trail is append-only at the database level, so there is
 * no edit/delete affordance anywhere in this page (or the API). Filters map
 * 1:1 onto the validated query params the endpoint accepts; a blank filter is
 * simply omitted so we never send an empty enum the strict schema would reject.
 */
export default function AuditLogsPage() {
  const { token } = useAuth();
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({
    action: '',
    entity_type: '',
    outcome: '',
    from: '',
    to: '',
  });

  const params = useMemo(() => {
    const p = { page, limit: PAGE_SIZE };
    for (const [k, v] of Object.entries(filters)) if (v) p[k] = v;
    return p;
  }, [page, filters]);

  const fetcher = useCallback(() => fetchAuditLogs(params, token), [params, token]);
  const { status, data, error, reload } = useApi(fetcher, [fetcher]);

  function setFilter(key, value) {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  }

  return (
    <main className="page page--wide">
      <header className="page__header">
        <h1 className="page__title">Audit trail</h1>
        <p className="page__subtitle">
          Every recorded business and security event, newest first. History is append-only and
          cannot be modified or deleted.
        </p>
      </header>

      <div className="toolbar audit-filters">
        <label className="toolbar__toggle">
          Action
          <select value={filters.action} onChange={(e) => setFilter('action', e.target.value)}>
            <option value="">All</option>
            {AUDIT_ACTION_VALUES.map((a) => (
              <option key={a} value={a}>
                {actionLabel(a)}
              </option>
            ))}
          </select>
        </label>
        <label className="toolbar__toggle">
          Entity
          <select
            value={filters.entity_type}
            onChange={(e) => setFilter('entity_type', e.target.value)}
          >
            <option value="">All</option>
            {AUDIT_ENTITY_TYPE_VALUES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="toolbar__toggle">
          Outcome
          <select value={filters.outcome} onChange={(e) => setFilter('outcome', e.target.value)}>
            <option value="">All</option>
            {AUDIT_OUTCOME_VALUES.map((o) => (
              <option key={o} value={o}>
                {AUDIT_OUTCOME_LABELS[o]}
              </option>
            ))}
          </select>
        </label>
        <label className="toolbar__toggle">
          From
          <input
            type="date"
            value={filters.from}
            onChange={(e) => setFilter('from', e.target.value)}
          />
        </label>
        <label className="toolbar__toggle">
          To
          <input type="date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} />
        </label>
      </div>

      <DataBoundary
        status={status}
        data={data}
        error={error}
        onRetry={reload}
        emptyTitle="No matching audit events"
      >
        {(result) => (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Entity</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.map((ev) => (
                    <tr key={ev.id}>
                      <td>{formatStamp(ev.created_at)}</td>
                      <td>
                        {ev.actor_name || ev.actor_email || ev.actor_role || 'system'}
                        {ev.actor_role ? <span className="muted"> · {ev.actor_role}</span> : null}
                      </td>
                      <td title={ev.action}>{actionLabel(ev.action)}</td>
                      <td className="mono">
                        {ev.entity_type}
                        {ev.entity_id ? ` #${ev.entity_id}` : ''}
                      </td>
                      <td>
                        <AuditOutcomeBadge outcome={ev.outcome} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {result.meta && totalPages(result.meta) > 1 ? (
              <nav className="pagination" aria-label="Pagination">
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={result.meta.page <= 1}
                  onClick={() => setPage((n) => n - 1)}
                >
                  ← Prev
                </button>
                <span className="pagination__info">
                  {pageSummary(result.meta, 'event', 'events')}
                </span>
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={result.meta.page >= totalPages(result.meta)}
                  onClick={() => setPage((n) => n + 1)}
                >
                  Next →
                </button>
              </nav>
            ) : null}
          </>
        )}
      </DataBoundary>
    </main>
  );
}

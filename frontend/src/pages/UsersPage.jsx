import { useCallback, useMemo, useState } from 'react';
import { fetchUsers, updateUser } from '../services/api.js';
import { useApi } from '../hooks/useApi.js';
import { useAuth } from '../context/AuthContext.jsx';
import { DataBoundary } from '../components/States.jsx';
import Dialog from '../components/Dialog.jsx';
import { totalPages, pageSummary } from '../utils/pagination.js';

const PAGE_SIZE = 25;
// Canonical DB role values (backend/src/constants/roles.js) — 'agent' is the
// ORDER_MANAGER alias used across this app.
const ROLE_OPTIONS = ['admin', 'agent', 'customer'];

function roleLabel(role) {
  return role === 'agent' ? 'order_manager' : role;
}

/**
 * Administrative user management (Phase 9 — "audit … administrative user
 * changes"). ADMIN only, enforced server-side. The ONLY mutable fields are role
 * and active status — the same surface the PATCH endpoint accepts; email,
 * name and password are out of scope here by design and are never editable
 * (registration/self-service own identity). A change and its audit row commit
 * together, so the trail always shows who moved whom and when. The server also
 * refuses self-demotion/self-deactivation (409) to prevent an admin stranding
 * the last privileged account — surfaced inline, never silently swallowed.
 */
export default function UsersPage() {
  const { token, user: me } = useAuth();
  const [page, setPage] = useState(1);
  const [feedback, setFeedback] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [confirmRow, setConfirmRow] = useState(null); // row pending a deactivation

  const params = useMemo(() => ({ page, limit: PAGE_SIZE }), [page]);
  const fetcher = useCallback(() => fetchUsers(params, token), [params, token]);
  const { status, data, error, reload, setData } = useApi(fetcher, [fetcher]);

  async function patch(row, body) {
    setBusyId(row.id);
    setFeedback(null);
    try {
      const res = await updateUser(row.id, body, token);
      const updated = res.data ?? res;
      setData((prev) => ({
        ...prev,
        data: prev.data.map((u) => (u.id === updated.id ? { ...u, ...updated } : u)),
      }));
      setFeedback({ kind: 'success', text: `Updated ${updated.email}.` });
    } catch (err) {
      setFeedback({ kind: 'error', text: err.message || 'The change was rejected.' });
    } finally {
      setBusyId(null);
    }
  }

  const isSelf = (row) => me && String(me.id) === String(row.id);

  return (
    <main className="page page--wide">
      <header className="page__header">
        <h1 className="page__title">Users</h1>
        <p className="page__subtitle">
          Change a role or active status. Every change is recorded in the append-only audit trail;
          you cannot demote or deactivate your own account.
        </p>
      </header>

      {feedback ? (
        <p className={`flash flash--${feedback.kind}`} role="status">
          {feedback.text}
        </p>
      ) : null}

      <DataBoundary
        status={status}
        data={data}
        error={error}
        onRetry={reload}
        emptyTitle="No users"
      >
        {(result) => (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th aria-label="actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.map((u) => (
                    <tr key={u.id}>
                      <td>
                        {u.name}
                        {isSelf(u) ? <span className="badge badge--ok">You</span> : null}
                      </td>
                      <td className="mono">{u.email}</td>
                      <td>
                        <select
                          aria-label={`Role for ${u.email}`}
                          value={u.role}
                          disabled={busyId === u.id || isSelf(u)}
                          onChange={(e) => patch(u, { role: e.target.value })}
                        >
                          {ROLE_OPTIONS.map((r) => (
                            <option key={r} value={r}>
                              {roleLabel(r)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <span className={`badge badge--${u.is_active ? 'ok' : 'inactive'}`}>
                          {u.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="actions">
                        <button
                          type="button"
                          className="btn btn--small btn--secondary"
                          disabled={busyId === u.id || isSelf(u)}
                          onClick={() =>
                            u.is_active ? setConfirmRow(u) : patch(u, { is_active: true })
                          }
                        >
                          {busyId === u.id ? 'Working…' : u.is_active ? 'Deactivate' : 'Activate'}
                        </button>
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
                  {pageSummary(result.meta, 'user', 'users')}
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

      <Dialog
        open={Boolean(confirmRow)}
        tone="danger"
        title="Deactivate this user?"
        confirmLabel={busyId === confirmRow?.id ? 'Working…' : 'Deactivate'}
        cancelLabel="Cancel"
        onClose={() => setConfirmRow(null)}
        onConfirm={async () => {
          const row = confirmRow;
          setConfirmRow(null);
          if (row) await patch(row, { is_active: false });
        }}
      >
        {confirmRow
          ? `Deactivating ${confirmRow.email} blocks them from signing in. Their existing orders and audit history are preserved. This is reversible.`
          : ''}
      </Dialog>
    </main>
  );
}

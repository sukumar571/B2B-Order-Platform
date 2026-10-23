import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchOrders, updateOrderStatus } from '../services/api.js';
import { useApi } from '../hooks/useApi.js';
import { useAuth } from '../context/AuthContext.jsx';
import { DataBoundary } from '../components/States.jsx';
import OrderStatusBadge from '../components/OrderStatusBadge.jsx';
import { NEXT_STATUS, statusLabel } from '../constants/orderStatus.js';

const PAGE_SIZE = 20;

/**
 * Order processing console for ADMIN / ORDER_MANAGER staff (the agent role).
 * Lists every order newest-first and exposes the single legal forward transition
 * for each — pending→confirmed→processing→shipped→delivered — via
 * PATCH /api/orders/:id/status. The backend is authoritative: an illegal move or
 * a shipment whose reservation is no longer intact returns 409, surfaced inline
 * rather than silently. Reaching 'shipped' is when the reserved stock is
 * consumed exactly once, so this button is the fulfilment checkpoint.
 */
export default function OrderProcessingPage() {
  const { token } = useAuth();
  const [page, setPage] = useState(1);
  const [feedback, setFeedback] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const params = useMemo(() => ({ page, limit: PAGE_SIZE }), [page]);
  const fetcher = useCallback(() => fetchOrders(params, token), [params, token]);
  const { status, data, error, reload, setData } = useApi(fetcher, [fetcher]);

  async function advance(order) {
    const target = NEXT_STATUS[order.status];
    if (!target) return;
    setBusyId(order.id);
    setFeedback(null);
    try {
      const updated = await updateOrderStatus(order.id, target, token);
      // Swap the refreshed order into the cached list without a full refetch.
      setData((prev) => ({
        ...prev,
        data: prev.data.map((o) =>
          o.id === updated.id ? { ...o, ...updated, items: o.items } : o
        ),
      }));
      setFeedback({ kind: 'success', text: `Order #${order.id} → ${statusLabel(target)}.` });
    } catch (err) {
      setFeedback({ kind: 'error', text: err.message || 'The transition was rejected.' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="page page--wide">
      <header className="page__header">
        <h1 className="page__title">Order processing</h1>
        <p className="page__subtitle">
          Advance each order along the lifecycle. Shipping converts the reservation into fulfilled
          stock once — it cannot be undone here.
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
        emptyTitle="No orders to process"
      >
        {(result) => (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Customer</th>
                    <th>Status</th>
                    <th className="num">Total</th>
                    <th aria-label="actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.map((o) => {
                    const target = NEXT_STATUS[o.status];
                    return (
                      <tr key={o.id}>
                        <td className="mono">#{o.id}</td>
                        <td className="mono">{o.customer_id}</td>
                        <td>
                          <OrderStatusBadge status={o.status} />
                        </td>
                        <td className="num">₹ {o.grand_total}</td>
                        <td className="actions">
                          {target ? (
                            <button
                              type="button"
                              className="btn btn--small"
                              onClick={() => advance(o)}
                              disabled={busyId !== null}
                            >
                              {busyId === o.id ? 'Working…' : `Advance → ${statusLabel(target)}`}
                            </button>
                          ) : (
                            <span className="muted">No further action</span>
                          )}{' '}
                          <Link to={`/orders/${o.id}`} className="btn btn--small btn--secondary">
                            View
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {result.meta && result.meta.total > PAGE_SIZE ? (
              <nav className="pagination" aria-label="Pagination">
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={result.meta.page <= 1}
                  onClick={() => setPage((n) => n - 1)}
                >
                  ← Prev
                </button>
                <span className="pagination__info">Page {result.meta.page}</span>
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={result.meta.page * PAGE_SIZE >= result.meta.total}
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

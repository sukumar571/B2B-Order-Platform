import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchOrders } from '../services/api.js';
import { useApi } from '../hooks/useApi.js';
import { useAuth } from '../context/AuthContext.jsx';
import { DataBoundary } from '../components/States.jsx';
import OrderStatusBadge from '../components/OrderStatusBadge.jsx';
import { statusLabel, ORDER_STATUS_VALUES } from '../constants/orderStatus.js';
import { totalPages, pageSummary } from '../utils/pagination.js';

const PAGE_SIZE = 20;

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

/**
 * Order history (FR-ORD listing). Customers see only their own orders — the
 * backend scopes GET /api/orders by the bearer identity, so this page never
 * sends or trusts a customer id. Staff see every order and can filter by status
 * and jump into the processing view. Money is the server-snapshotted figure.
 */
export default function OrderHistoryPage() {
  const { token, role } = useAuth();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const isCustomer = role === 'customer';

  const params = useMemo(() => {
    const p = { page, limit: PAGE_SIZE };
    if (!isCustomer && statusFilter) p.status = statusFilter;
    return p;
  }, [page, statusFilter, isCustomer]);

  const fetcher = useCallback(() => fetchOrders(params, token), [params, token]);
  const { status, data, error, reload } = useApi(fetcher, [fetcher]);

  return (
    <main className="page page--wide">
      <header className="page__header page__header--row">
        <div>
          <h1 className="page__title">{isCustomer ? 'My orders' : 'Orders'}</h1>
          <p className="page__subtitle">
            {isCustomer
              ? 'Every order you have placed, with the prices captured at the time.'
              : 'All customer orders — newest first.'}
          </p>
        </div>
        {isCustomer ? null : (
          <label className="toolbar__toggle">
            Status
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All</option>
              {ORDER_STATUS_VALUES.map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s)}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      <DataBoundary
        status={status}
        data={data}
        error={error}
        onRetry={reload}
        emptyTitle="No orders yet"
      >
        {(result) => (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Placed</th>
                    {!isCustomer ? <th>Customer</th> : null}
                    <th>Status</th>
                    <th className="num">Total</th>
                    <th aria-label="actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.map((o) => (
                    <tr key={o.id}>
                      <td className="mono">#{o.id}</td>
                      <td>{formatDate(o.created_at)}</td>
                      {!isCustomer ? <td className="mono">{o.customer_id}</td> : null}
                      <td>
                        <OrderStatusBadge status={o.status} />
                      </td>
                      <td className="num">₹ {o.grand_total}</td>
                      <td className="actions">
                        <Link to={`/orders/${o.id}`} className="btn btn--small btn--secondary">
                          View
                        </Link>
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
                  {pageSummary(result.meta, 'order', 'orders')}
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

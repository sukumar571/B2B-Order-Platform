import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { fetchDashboard, fetchOrderSummary } from '../services/api.js';
import { useApi } from '../hooks/useApi.js';
import { useAuth } from '../context/AuthContext.jsx';
import { DataBoundary } from '../components/States.jsx';
import OrderStatusBadge from '../components/OrderStatusBadge.jsx';
import AuditOutcomeBadge from '../components/AuditOutcomeBadge.jsx';
import { ORDER_STATUS_VALUES } from '../constants/orderStatus.js';
import { actionLabel } from '../constants/auditStatus.js';
import { formatMoney } from '../constants/invoiceStatus.js';

/**
 * Business dashboard (Phase 9 — FR-AUD/FR-RPT). One surface, two audiences:
 *
 *  - ADMIN          → GET /api/reports/dashboard (order metrics + audit feed)
 *  - ORDER_MANAGER  → GET /api/reports/order-summary (the SAME order metrics,
 *                     but NO who-did-what audit history — that stays admin-only
 *                     per FR-AUD-03; the role gate is enforced server-side, this
 *                     split is only about which endpoint the right role calls).
 *
 * Honesty rules baked into the backend payload and shown verbatim here: every
 * figure is a stored count/sum, order value is BOOKED DEMAND (never revenue —
 * the platform takes no payment), and low-stock is an instantaneous snapshot.
 * Nothing here estimates or fabricates a number.
 */

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

function formatDay(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
}

// 'booked_order_value' → 'Booked order value' — a readable heading for each
// metric-definition key returned by the report payload.
function metricLabel(key) {
  return String(key)
    .split('_')
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function StatCard({ label, value, hint, tone }) {
  return (
    <section className={`statcard${tone ? ` statcard--${tone}` : ''}`}>
      <p className="statcard__label">{label}</p>
      <p className="statcard__value">{value}</p>
      {hint ? <p className="statcard__hint">{hint}</p> : null}
    </section>
  );
}

function windowLabel(window) {
  if (!window) return 'All time';
  if (window.days) return `Last ${window.days} days`;
  if (window.from && window.to) return `${formatDay(window.from)} – ${formatDay(window.to)}`;
  if (window.from) return `Since ${formatDay(window.from)}`;
  if (window.to) return `Up to ${formatDay(window.to)}`;
  return 'All time';
}

export default function DashboardPage() {
  const { token, role } = useAuth();
  const isAdmin = role === 'admin';

  // The two endpoints share an identical metrics envelope; only the admin one
  // embeds the audit activity feed. We pick the fetcher strictly by role so an
  // order manager never even requests the admin payload (which it could not get).
  const fetcher = useCallback(
    () => (isAdmin ? fetchDashboard({}, token) : fetchOrderSummary({}, token)),
    [isAdmin, token]
  );
  const { status, data, error, reload } = useApi(fetcher, [fetcher]);

  return (
    <main className="page page--wide">
      <header className="page__header page__header--row">
        <div>
          <h1 className="page__title">{isAdmin ? 'Admin dashboard' : 'Operations dashboard'}</h1>
          <p className="page__subtitle">
            {isAdmin
              ? 'Order, stock and activity metrics for the whole platform.'
              : 'Order and stock metrics — the audit activity feed is admin-only.'}
          </p>
        </div>
      </header>

      <DataBoundary status={status} data={data} error={error} onRetry={reload}>
        {(envelope) => {
          const d = envelope.data;
          const totals = d.totals || {};
          const byStatus = d.orders_by_status || {};
          const recentOrders = d.recent_orders || [];
          const audit = d.audit || null;
          const defs = d.metric_definitions || {};
          const lowStockCount = d.low_stock?.count ?? 0;

          return (
            <>
              <p className="dash__window">
                Measured window: <strong>{windowLabel(d.window)}</strong> · figures are live
                snapshots of stored data, generated {formatDate(d.generated_at)}.
              </p>

              <div className="statgrid">
                <StatCard
                  label="Total orders"
                  value={totals.total_orders ?? 0}
                  hint={defs.total_orders}
                />
                <StatCard
                  label="Active orders"
                  value={totals.active_orders ?? 0}
                  hint={`${totals.cancelled_orders ?? 0} cancelled in window`}
                />
                <StatCard
                  label="Booked order value"
                  value={formatMoney(totals.booked_order_value ?? '0.00')}
                  tone="money"
                  hint="Not revenue — see definitions below"
                />
                <StatCard
                  label="Low-stock products"
                  value={lowStockCount}
                  tone={lowStockCount > 0 ? 'warn' : undefined}
                  hint={defs.low_stock_products}
                />
                {isAdmin ? (
                  <StatCard
                    label="Audit events recorded"
                    value={audit?.total_events ?? 0}
                    hint="Total rows in the append-only trail"
                  />
                ) : null}
              </div>

              {lowStockCount > 0 ? (
                <div className="dash__alert" role="alert">
                  <strong>{lowStockCount}</strong>{' '}
                  {lowStockCount === 1 ? 'product is' : 'products are'} at or below their low-stock
                  threshold.{' '}
                  <Link to="/inventory" className="dash__alert-link">
                    Review inventory
                  </Link>
                </div>
              ) : null}

              <section className="card dash__section" aria-labelledby="status-heading">
                <h2 id="status-heading" className="card__title">
                  Orders by status
                </h2>
                <ul className="statusbars">
                  {ORDER_STATUS_VALUES.map((s) => {
                    const count = byStatus[s] ?? 0;
                    const max = Math.max(1, ...ORDER_STATUS_VALUES.map((k) => byStatus[k] ?? 0));
                    return (
                      <li key={s} className="statusbars__row">
                        <span className="statusbars__label">
                          <OrderStatusBadge status={s} />
                        </span>
                        <span className="statusbars__track" aria-hidden="true">
                          <span
                            className="statusbars__fill"
                            style={{ width: `${Math.round((count / max) * 100)}%` }}
                          />
                        </span>
                        <span className="statusbars__count">{count}</span>
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section className="card dash__section" aria-labelledby="recent-orders-heading">
                <h2 id="recent-orders-heading" className="card__title">
                  Recent orders
                </h2>
                {recentOrders.length === 0 ? (
                  <p className="muted">No orders recorded yet.</p>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Order</th>
                          <th>Placed</th>
                          <th>Status</th>
                          <th className="num">Total</th>
                          <th aria-label="actions">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recentOrders.map((o) => (
                          <tr key={o.id}>
                            <td className="mono">#{o.id}</td>
                            <td>{formatDate(o.created_at)}</td>
                            <td>
                              <OrderStatusBadge status={o.status} />
                            </td>
                            <td className="num">{formatMoney(o.grand_total)}</td>
                            <td className="actions">
                              <Link
                                to={`/orders/${o.id}`}
                                className="btn btn--small btn--secondary"
                              >
                                View
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {isAdmin ? (
                <section className="card dash__section" aria-labelledby="activity-heading">
                  <h2 id="activity-heading" className="card__title">
                    Recent activity
                  </h2>
                  <p className="muted">
                    Newest audit events from the append-only trail. Read-only — no one can edit
                    history.
                  </p>
                  {(audit?.recent_activity || []).length === 0 ? (
                    <p className="muted">No audit events recorded yet.</p>
                  ) : (
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
                          {audit.recent_activity.map((ev) => (
                            <tr key={ev.id}>
                              <td>{formatDate(ev.created_at)}</td>
                              <td>
                                {ev.actor_name ||
                                  ev.actor_email ||
                                  (ev.actor_role ? ev.actor_role : 'system')}
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
                  )}
                  <p className="dash__link">
                    <Link to="/audit" className="btn btn--small btn--secondary">
                      Open full audit trail
                    </Link>
                  </p>
                </section>
              ) : null}

              <section className="hint dash__defs" aria-labelledby="defs-heading">
                <p className="hint__title" id="defs-heading">
                  What these metrics mean (and do not)
                </p>
                <ul className="dash__defs-list">
                  {Object.entries(defs).map(([key, text]) => (
                    <li key={key}>
                      <strong>{metricLabel(key)}</strong>: {text}
                    </li>
                  ))}
                </ul>
              </section>
            </>
          );
        }}
      </DataBoundary>
    </main>
  );
}

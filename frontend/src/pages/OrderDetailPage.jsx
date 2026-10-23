import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchOrder, cancelOrder } from '../services/api.js';
import { useApi, STATUS } from '../hooks/useApi.js';
import { useAuth } from '../context/AuthContext.jsx';
import { LoadingState, ErrorState, FormProblem } from '../components/States.jsx';
import OrderStatusBadge from '../components/OrderStatusBadge.jsx';
import {
  FULFILMENT_CHAIN,
  chainIndex,
  isCancellable,
  statusLabel,
} from '../constants/orderStatus.js';

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

/** Read-only progress timeline; the current state is highlighted, cancelled shows a banner. */
function Timeline({ status }) {
  const idx = chainIndex(status);
  if (status === 'cancelled') {
    return (
      <p className="order-cancelled-note">
        This order was cancelled — it left the fulfilment chain.
      </p>
    );
  }
  return (
    <ol className="order-timeline">
      {FULFILMENT_CHAIN.map((s, i) => {
        const cls = i < idx ? 'done' : i === idx ? 'current' : 'todo';
        return (
          <li key={s} className={`order-timeline__step order-timeline__step--${cls}`}>
            <span className="order-timeline__dot" aria-hidden="true" />
            <span className="order-timeline__label">{statusLabel(s)}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Order detail (GET /api/orders/:id). The customer's items, unit prices and
 * totals are the historical SNAPSHOT captured at order time — editing a catalog
 * product later can never change them (AC-ORD-06). A cancellable order offers a
 * reason-gated cancel (POST /:id/cancel) that releases the reservation exactly
 * once server-side. Access is ownership-scoped by the backend (foreign order →
 * 404), so nothing here leaks another customer's data.
 */
export default function OrderDetailPage() {
  const { id } = useParams();
  const { token } = useAuth();
  const fetcher = useCallback(() => fetchOrder(id, token), [id, token]);
  const { status, data: order, error, reload, setData } = useApi(fetcher, [fetcher]);

  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  async function submitCancel(e) {
    e.preventDefault();
    setBusy(true);
    setActionError(null);
    try {
      const updated = await cancelOrder(id, reason, token);
      setData(updated);
      setCancelling(false);
      setReason('');
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  }

  if (status === STATUS.LOADING) return <LoadingState label="Loading order…" />;
  if (status === STATUS.ERROR) {
    return (
      <main className="page">
        <ErrorState error={error} onRetry={reload} />
        <Link to="/orders" className="btn btn--secondary detail__back">
          ← Back to orders
        </Link>
      </main>
    );
  }

  const items = order.items ?? [];
  const cancellable = isCancellable(order.status);

  return (
    <main className="page page--wide">
      <header className="page__header">
        <p className="hero__eyebrow">
          Order #{order.id} · placed {formatDate(order.created_at)}
        </p>
        <h1 className="page__title">
          Order summary <OrderStatusBadge status={order.status} />
        </h1>
      </header>

      <section className="card" aria-label="order progress">
        <h2 className="card__title">Progress</h2>
        <Timeline status={order.status} />
        {order.status === 'cancelled' && order.cancellation_reason ? (
          <p className="order-cancelled-reason">Reason: {order.cancellation_reason}</p>
        ) : null}
      </section>

      {actionError ? (
        <div role="alert" className="cart__action-error">
          <FormProblem error={actionError} />
        </div>
      ) : null}

      <section className="card" aria-label="order items">
        <h2 className="card__title">Items</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th className="num">Qty</th>
                <th className="num">Unit price</th>
                <th className="num">Line total</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td>{it.product_name}</td>
                  <td className="num">{it.quantity}</td>
                  <td className="num">₹ {it.unit_price}</td>
                  <td className="num">₹ {it.line_total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="cart__totals order-totals">
          <div className="cart__total-row">
            <span>Subtotal</span>
            <span>₹ {order.subtotal}</span>
          </div>
          <div className="cart__total-row">
            <span>Tax</span>
            <span>₹ {order.tax_total}</span>
          </div>
          <div className="cart__total-row cart__total-row--grand">
            <span>Grand total</span>
            <span>₹ {order.grand_total}</span>
          </div>
        </div>
      </section>

      {cancellable ? (
        <section className="card" aria-label="cancel order">
          {cancelling ? (
            <form className="form" onSubmit={submitCancel} aria-label="cancel order form">
              <label htmlFor="cancel-reason">Reason for cancellation</label>
              <textarea
                id="cancel-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                required
                minLength={3}
              />
              <div className="cart__actions">
                <button type="submit" className="btn" disabled={busy || reason.trim().length < 3}>
                  {busy ? 'Cancelling…' : 'Confirm cancellation'}
                </button>
                <button
                  type="button"
                  className="btn btn--link"
                  onClick={() => setCancelling(false)}
                  disabled={busy}
                >
                  Keep order
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => setCancelling(true)}
            >
              Cancel this order
            </button>
          )}
        </section>
      ) : null}

      <div className="order-detail__nav">
        <Link to="/orders" className="btn btn--secondary detail__back">
          ← Back to orders
        </Link>
        {order.status === 'shipped' || order.status === 'delivered' ? (
          <Link to={`/orders/${order.id}/invoice`} className="btn btn--secondary">
            View invoice
          </Link>
        ) : null}
        <Link to="/products" className="btn">
          Continue shopping
        </Link>
      </div>
    </main>
  );
}

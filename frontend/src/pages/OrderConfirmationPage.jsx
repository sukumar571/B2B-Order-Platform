import { useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchOrder } from '../services/api.js';
import { useApi, STATUS } from '../hooks/useApi.js';
import { useAuth } from '../context/AuthContext.jsx';
import { LoadingState, ErrorState } from '../components/States.jsx';
import OrderStatusBadge from '../components/OrderStatusBadge.jsx';

/**
 * Post-checkout confirmation (AC-ORD-01). Rendered after a successful
 * POST /api/orders; it re-fetches the persisted order so the figures shown are
 * the authoritative, server-priced snapshot — never a client-side echo. The
 * banner proves the order was reserved atomically; the customer is routed here
 * by id so refreshing or re-sharing the link replays the same view.
 */
export default function OrderConfirmationPage() {
  const { id } = useParams();
  const { token } = useAuth();
  const fetcher = useCallback(() => fetchOrder(id, token), [id, token]);
  const { status, data: order, error, reload } = useApi(fetcher, [fetcher]);

  if (status === STATUS.LOADING) return <LoadingState label="Confirming your order…" />;
  if (status === STATUS.ERROR) {
    return (
      <main className="page">
        <ErrorState error={error} onRetry={reload} />
        <Link to="/orders" className="btn btn--secondary detail__back">
          View my orders
        </Link>
      </main>
    );
  }

  const items = order.items ?? [];

  return (
    <main className="page">
      <section className="card order-confirmation" aria-live="polite">
        <p className="order-confirmation__check" aria-hidden="true">
          ✓
        </p>
        <h1 className="page__title">Thank you — your order is placed.</h1>
        <p className="page__subtitle">
          Order <strong>#{order.id}</strong> is now <OrderStatusBadge status={order.status} /> and
          your stock has been reserved. Availability was verified again on the server at checkout.
        </p>

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
          <div className="cart__total-row cart__total-row--grand">
            <span>Grand total</span>
            <span>₹ {order.grand_total}</span>
          </div>
        </div>

        <div className="cart__actions">
          <Link to={`/orders/${order.id}`} className="btn">
            View order details
          </Link>
          <Link to="/orders" className="btn btn--secondary">
            My orders
          </Link>
          <Link to="/products" className="btn btn--link">
            Continue shopping
          </Link>
        </div>
      </section>
    </main>
  );
}

import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  fetchCart,
  updateCartItem,
  removeCartItem,
  clearCart,
  placeOrder,
} from '../services/api.js';
import { useApi, STATUS } from '../hooks/useApi.js';
import { useAuth } from '../context/AuthContext.jsx';
import CartItemRow from '../components/CartItemRow.jsx';
import { LoadingState, ErrorState, EmptyState, FormProblem } from '../components/States.jsx';
import { newIdempotencyKey } from '../utils/uuid.js';

/**
 * The customer's cart. Every price and total comes from the server
 * (GET/POST/PATCH/DELETE /api/cart*). Local actions re-set state from the
 * full updated cart the API returns, so the UI can never drift from the
 * authoritative, live-priced figures. A quantity that exceeds stock, or a
 * product that became inactive, is reported back by the backend and shown
 * inline — a cart never reserves stock.
 */
export default function CartPage() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const fetcher = useCallback(() => fetchCart(token), [token]);
  const { status, data: cart, error, reload, setData } = useApi(fetcher, [token]);
  const [actionError, setActionError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [placing, setPlacing] = useState(false);
  // One key per checkout attempt; a retry of the SAME attempt reuses it so the
  // backend replays the first order instead of creating a duplicate.
  const [orderKey, setOrderKey] = useState(() => newIdempotencyKey());

  async function run(label, fn, id) {
    setActionError(null);
    setBusyId(id);
    try {
      const updated = await fn();
      setData(updated);
    } catch (err) {
      setActionError({ label, err });
    } finally {
      setBusyId(null);
    }
  }

  const changeQuantity = (item, quantity) =>
    run(
      `Updating ${item.product_name}`,
      () => updateCartItem(item.id, { quantity }, token),
      item.id
    );
  const remove = (item) =>
    run(`Removing ${item.product_name}`, () => removeCartItem(item.id, token), item.id);

  // Checkout: POST /api/orders with an empty body orders the cart. Stock is
  // re-verified and reserved atomically on the server; on success the cart is
  // emptied server-side too, so we route straight to the confirmation view.
  async function checkout() {
    setActionError(null);
    setPlacing(true);
    try {
      const order = await placeOrder({}, token, orderKey);
      navigate(`/orders/${order.id}/confirmation`);
    } catch (err) {
      setActionError({ label: 'Placing your order', err });
      // A rejected request frees the idempotency key for a genuinely new order;
      // only a network ambiguity should reuse it, so mint a fresh one for the
      // next deliberate attempt.
      setOrderKey(newIdempotencyKey());
    } finally {
      setPlacing(false);
    }
  }
  const empty = () =>
    run(
      'Emptying cart',
      async () => {
        await clearCart(token);
        return {
          ...(cart || {}),
          items: [],
          subtotal: '0.00',
          tax_total: '0.00',
          grand_total: '0.00',
        };
      },
      'clear'
    );

  if (status === STATUS.LOADING) return <LoadingState label="Loading your cart…" />;
  if (status === STATUS.ERROR)
    return (
      <main className="page">
        <ErrorState error={error} onRetry={reload} />
      </main>
    );

  const items = cart?.items ?? [];

  return (
    <main className="page">
      <header className="page__header">
        <h1 className="page__title">Your cart</h1>
        <p className="hero__eyebrow">Prices and totals are calculated on the server.</p>
      </header>

      {actionError ? (
        <div className="cart__action-error" role="alert">
          <p className="form__message form__message--error">{actionError.label} failed:</p>
          <FormProblem error={actionError.err} />
        </div>
      ) : null}

      {items.length === 0 ? (
        <section className="card">
          <EmptyState
            title="Your cart is empty"
            hint="Browse the catalog and add products to order them."
          />
          <p className="cart__browse">
            <Link to="/products" className="btn">
              Browse products
            </Link>
          </p>
        </section>
      ) : (
        <>
          <section className="card cart__list">
            {items.map((item) => (
              <CartItemRow
                key={item.id}
                item={item}
                busy={busyId === item.id}
                onQuantityChange={(q) => changeQuantity(item, q)}
                onRemove={() => remove(item)}
              />
            ))}
          </section>

          <section className="card cart__summary" aria-label="cart summary">
            <div className="cart__totals">
              <div className="cart__total-row">
                <span>Subtotal</span>
                <span>₹ {cart.subtotal}</span>
              </div>
              <div className="cart__total-row">
                <span>Tax</span>
                <span>₹ {cart.tax_total}</span>
              </div>
              <div className="cart__total-row cart__total-row--grand">
                <span>Grand total</span>
                <span>₹ {cart.grand_total}</span>
              </div>
            </div>
            <p className="cart__note">
              Adding to your cart does <strong>not</strong> reserve stock — availability is verified
              again when you place the order.
            </p>
            <div className="cart__actions">
              <Link to="/products" className="btn btn--secondary">
                Continue shopping
              </Link>
              <button
                type="button"
                className="btn btn--link"
                onClick={empty}
                disabled={busyId !== null}
              >
                {busyId === 'clear' ? 'Emptying…' : 'Empty cart'}
              </button>
            </div>
            <div className="cart__checkout">
              <button
                type="button"
                className="btn btn--primary"
                onClick={checkout}
                disabled={placing || busyId !== null}
                aria-label="place order"
              >
                {placing ? 'Placing order…' : `Place order · ₹ ${cart.grand_total}`}
              </button>
              <p className="cart__note">
                Placing the order re-checks availability and reserves stock atomically on the server
                — a cart alone never does.
              </p>
            </div>
          </section>
        </>
      )}
    </main>
  );
}

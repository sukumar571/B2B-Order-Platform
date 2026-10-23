/**
 * One cart line: live server-derived price, quantity controls, remove action,
 * the line total, and availability messaging.
 *
 * Quantity is always sent to the backend as an ABSOLUTE value (PATCH sets it);
 * the +/- buttons just compute the neighbour. The client shows the server's
 * `available_now`/`stock_warning`/`unavailable` flags — it never trusts or
 * sends prices, and a warning here does NOT mean stock was reserved (a cart is
 * not a reservation; checkout re-verifies under a row lock).
 */
export default function CartItemRow({ item, onQuantityChange, onRemove, busy }) {
  const setQty = (n) => onQuantityChange(Math.max(1, n));

  return (
    <div className="cart-item" data-testid={`cart-item-${item.id}`}>
      <div className="cart-item__main">
        <p className="cart-item__name">{item.product_name}</p>
        <p className="cart-item__sku">{item.sku}</p>
        {!item.is_active ? (
          <p className="cart-item__flag cart-item__flag--danger" role="alert">
            No longer available — remove this line to continue.
          </p>
        ) : item.stock_warning ? (
          <p className="cart-item__flag cart-item__flag--warn" role="alert">
            Only {item.available_now} in stock (you asked for {item.quantity}). Availability is
            re-checked when you place the order.
          </p>
        ) : null}
      </div>

      <div className="cart-item__qty" role="group" aria-label="quantity controls">
        <button
          type="button"
          className="btn btn--secondary btn--small"
          onClick={() => setQty(item.quantity - 1)}
          disabled={busy || item.quantity <= 1}
          aria-label="decrease quantity"
        >
          −
        </button>
        <input
          className="cart-item__qty-input"
          value={item.quantity}
          onChange={(e) => setQty(Number(e.target.value) || 1)}
          inputMode="numeric"
          min="1"
          aria-label={`quantity for ${item.product_name}`}
        />
        <button
          type="button"
          className="btn btn--secondary btn--small"
          onClick={() => setQty(item.quantity + 1)}
          disabled={busy}
          aria-label="increase quantity"
        >
          +
        </button>
      </div>

      <div className="cart-item__money">
        <p className="cart-item__unit">₹ {item.unit_price} ea.</p>
        <p className="cart-item__total">
          <strong>₹ {item.line_total}</strong>
        </p>
      </div>

      <button
        type="button"
        className="btn btn--link"
        onClick={onRemove}
        disabled={busy}
        aria-label={`remove ${item.product_name}`}
      >
        Remove
      </button>
    </div>
  );
}

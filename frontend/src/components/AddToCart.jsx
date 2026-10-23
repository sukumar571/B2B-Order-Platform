import { useState } from 'react';
import { addCartItem } from '../services/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Link } from 'react-router-dom';
import { FormProblem } from './States.jsx';

/**
 * "Add to cart" control for a single product. The submitted body carries only
 * { product_id, quantity } — never a price/total or an owner id. The backend
 * re-reads the live price and current stock; a 409 INSUFFICIENT_STOCK or a 404
 * (inactive/unavailable product) is surfaced right below the button.
 */
export default function AddToCart({ productId, onAdded }) {
  const { token, isAuthenticated } = useAuth();
  const [quantity, setQuantity] = useState('1');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleAdd(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const cart = await addCartItem({ product_id: productId, quantity: Number(quantity) }, token);
      setDone(true);
      if (onAdded) onAdded(cart);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!isAuthenticated) {
    return (
      <p className="cart__signin" role="note">
        <Link to="/login">Log in</Link> to add items to your cart.
      </p>
    );
  }

  return (
    <form className="add-to-cart" onSubmit={handleAdd} aria-label="add to cart form">
      <label>
        Qty
        <input
          name="quantity"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          inputMode="numeric"
          min="1"
          className="add-to-cart__qty"
        />
      </label>
      <button type="submit" className="btn" disabled={busy}>
        {busy ? 'Adding…' : 'Add to cart'}
      </button>
      {done ? (
        <span className="add-to-cart__ok" role="status">
          Added ·{' '}
          <Link to="/cart" className="add-to-cart__link">
            View cart
          </Link>
        </span>
      ) : null}
      <FormProblem error={error} />
    </form>
  );
}

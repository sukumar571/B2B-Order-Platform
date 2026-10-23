import { Link, useParams } from 'react-router-dom';
import { fetchProduct } from '../services/api.js';
import { useApi } from '../hooks/useApi.js';
import { LoadingState, ErrorState } from '../components/States.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import AddToCart from '../components/AddToCart.jsx';

function Row({ label, children }) {
  return (
    <div className="detail__row">
      <dt className="detail__label">{label}</dt>
      <dd className="detail__value">{children}</dd>
    </div>
  );
}

/**
 * Product detail for a single catalog item, fetched live from
 * GET /api/products/:id. Inactive products return 404 to the public; an
 * ADMIN's token makes them visible (backend-enforced, not just UI).
 */
export default function ProductDetailPage() {
  const { id } = useParams();
  const { token, role } = useAuth();
  const {
    status,
    data: product,
    error,
    reload,
  } = useApi(() => fetchProduct(id, role === 'admin' ? token : undefined), [id, token, role]);

  if (status === 'loading') return <LoadingState label="Loading product…" />;
  if (status === 'error') {
    return (
      <main className="page">
        <ErrorState error={error} onRetry={reload} />
        <Link to="/products" className="btn btn--secondary detail__back">
          ← Back to products
        </Link>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="page__header">
        <p className="hero__eyebrow">{product.sku}</p>
        <h1 className="page__title">
          {product.name}
          {!product.is_active ? <span className="badge badge--inactive">Inactive</span> : null}
        </h1>
      </header>

      <section className="card">
        <dl className="detail">
          <Row label="Unit price">₹ {product.unit_price}</Row>
          <Row label="Tax rate">{product.tax_rate}%</Row>
          <Row label="Available stock">{`${product.available_stock}`}</Row>
          <Row label="Physical / reserved">{`${product.physical_quantity} / ${product.reserved_quantity}`}</Row>
          <Row label="Low-stock threshold">{product.low_stock_threshold}</Row>
          <Row label="Description">{product.description || <em>No description provided.</em>}</Row>
        </dl>
      </section>

      {product.is_active && role === 'customer' ? (
        <section className="card" aria-label="add to cart">
          <AddToCart productId={product.id} />
        </section>
      ) : null}

      <Link to="/products" className="btn btn--secondary detail__back">
        ← Back to products
      </Link>
    </main>
  );
}

import { useMemo, useState } from 'react';
import { fetchProducts, createProduct, updateProduct, fetchProduct } from '../services/api.js';
import { useApi } from '../hooks/useApi.js';
import { useAuth } from '../context/AuthContext.jsx';
import { DataBoundary } from '../components/States.jsx';
import ProductForm from '../components/ProductForm.jsx';
import { totalPages, pageSummary } from '../utils/pagination.js';

const PAGE_SIZE = 20;

/**
 * Admin product table with add/edit form and activate/deactivate controls.
 * Sends the ADMIN bearer token, so the backend returns inactive rows too
 * (active_only=false). Products are NEVER deleted — deactivation is the
 * archival path, and the API refuses to hard-remove referenced products.
 */
export default function AdminProductsPage() {
  const { token } = useAuth();
  const [page, setPage] = useState(1);
  const [editor, setEditor] = useState(null); // null | 'create' | product object
  const [feedback, setFeedback] = useState(null); // { kind, text }
  const [busy, setBusy] = useState(false);

  const params = useMemo(() => ({ active_only: false, page, limit: PAGE_SIZE }), [page]);
  const { status, data, error, reload } = useApi(
    () => fetchProducts(params, token),
    [params, token]
  );

  function notify(kind, text) {
    setFeedback({ kind, text });
  }

  async function handleCreate(body) {
    setBusy(true);
    try {
      await createProduct(body, token);
      setEditor(null);
      notify('success', `Product "${body.sku}" created.`);
      reload();
    } finally {
      setBusy(false);
    }
  }

  async function handleEdit(body) {
    setBusy(true);
    try {
      await updateProduct(editor.id, body, token);
      setEditor(null);
      notify('success', `Product "${body.sku}" updated.`);
      reload();
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(product) {
    setBusy(true);
    try {
      const nextActive = !product.is_active;
      await updateProduct(product.id, { is_active: nextActive }, token);
      notify(
        'success',
        nextActive
          ? `"${product.name}" reactivated.`
          : `"${product.name}" deactivated (archived — order history preserved).`
      );
      reload();
    } catch (err) {
      notify('error', err.message || 'Could not change product status.');
    } finally {
      setBusy(false);
    }
  }

  async function openEdit(id) {
    // Re-fetch the full row so the form starts from committed server state.
    const fresh = await fetchProduct(id, token);
    setEditor(fresh);
  }

  return (
    <main className="page page--wide">
      <header className="page__header page__header--row">
        <div>
          <h1 className="page__title">Admin · Products</h1>
          <p className="page__subtitle">
            Every catalog item, active or archived. Changes are validated and audited server-side.
          </p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => setEditor('create')}
          disabled={busy || editor !== null}
        >
          + Add product
        </button>
      </header>

      {feedback ? (
        <p
          className={`flash flash--${feedback.kind}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      ) : null}

      {editor ? (
        <section className="card" aria-label={editor === 'create' ? 'add product' : 'edit product'}>
          <h2 className="card__title">
            {editor === 'create' ? 'Add product' : `Edit ${editor.name}`}
          </h2>
          <ProductForm
            mode={editor === 'create' ? 'create' : 'edit'}
            initial={editor === 'create' ? undefined : editor}
            onSubmit={editor === 'create' ? handleCreate : handleEdit}
            onCancel={() => setEditor(null)}
          />
        </section>
      ) : null}

      <DataBoundary
        status={status}
        data={data}
        error={error}
        onRetry={reload}
        emptyTitle="No products yet — add one above"
      >
        {(result) => (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Name</th>
                    <th>Price</th>
                    <th>Available</th>
                    <th>Threshold</th>
                    <th>Status</th>
                    <th aria-label="actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.map((p) => (
                    <tr key={p.id}>
                      <td className="mono">{p.sku}</td>
                      <td>{p.name}</td>
                      <td className="num">₹ {p.unit_price}</td>
                      <td className="num">{p.available_stock}</td>
                      <td className="num">{p.low_stock_threshold}</td>
                      <td>
                        <span className={`badge badge--${p.is_active ? 'active' : 'inactive'}`}>
                          {p.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="actions">
                        <button
                          type="button"
                          className="btn btn--small"
                          onClick={() => openEdit(p.id)}
                          disabled={busy}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn--small btn--secondary"
                          onClick={() => toggleActive(p)}
                          disabled={busy}
                        >
                          {p.is_active ? 'Deactivate' : 'Activate'}
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
                  {pageSummary(result.meta, 'product', 'products')}
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

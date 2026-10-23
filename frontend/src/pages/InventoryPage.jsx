import { useMemo, useState } from 'react';
import { fetchInventory, fetchLowStock, adjustInventory } from '../services/api.js';
import { useApi } from '../hooks/useApi.js';
import { useAuth } from '../context/AuthContext.jsx';
import { DataBoundary } from '../components/States.jsx';
import InventoryAdjustForm from '../components/InventoryAdjustForm.jsx';
import { totalPages, pageSummary } from '../utils/pagination.js';

const PAGE_SIZE = 20;

/**
 * Inventory table (ADMIN / ORDER_MANAGER — enforced by the backend) with a
 * low-stock filter and an inline stock-adjustment form. Adjustments go to
 * PATCH /api/inventory/:id, which applies them transactionally with an audit
 * record and a ledger movement on the server.
 */
export default function InventoryPage() {
  const { token, user } = useAuth();
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [adjusting, setAdjusting] = useState(null); // inventory row being adjusted
  const [feedback, setFeedback] = useState(null);

  const params = useMemo(() => ({ page, limit: PAGE_SIZE }), [page]);
  const fetcher = lowStockOnly ? fetchLowStock : fetchInventory;
  const { status, data, error, reload } = useApi(
    () => fetcher(params, token),
    [fetcher, params, token]
  );

  async function handleAdjust(body) {
    // Throws on failure; InventoryAdjustForm displays backend validation
    // details, so we only surface the success path here.
    const res = await adjustInventory(adjusting.product_id, body, token);
    const signed =
      res.movement.quantity_delta > 0
        ? `+${res.movement.quantity_delta}`
        : `${res.movement.quantity_delta}`;
    setAdjusting(null);
    setFeedback({
      kind: 'success',
      text: `${adjusting.name}: ${signed} applied — available now ${res.movement.available_after}.`,
    });
    reload();
  }

  return (
    <main className="page page--wide">
      <header className="page__header page__header--row">
        <div>
          <h1 className="page__title">Inventory</h1>
          <p className="page__subtitle">
            Live stock for {user?.name || 'staff'} · low stock means available ≤ threshold (default
            20).
          </p>
        </div>
        <label className="toolbar__toggle">
          <input
            type="checkbox"
            checked={lowStockOnly}
            onChange={(e) => {
              setLowStockOnly(e.target.checked);
              setPage(1);
            }}
          />
          Low-stock only
        </label>
      </header>

      {feedback ? (
        <p className={`flash flash--${feedback.kind}`} role="status">
          {feedback.text}
        </p>
      ) : null}

      {adjusting ? (
        <section className="card" aria-label="stock adjustment">
          <h2 className="card__title">Adjust stock — {adjusting.name}</h2>
          <p className="page__subtitle">
            Available {adjusting.available_quantity} · physical {adjusting.physical_quantity} ·
            reserved {adjusting.reserved_quantity} · threshold {adjusting.low_stock_threshold}
          </p>
          <InventoryAdjustForm onSubmit={handleAdjust} onCancel={() => setAdjusting(null)} />
        </section>
      ) : null}

      <DataBoundary
        status={status}
        data={data}
        error={error}
        onRetry={reload}
        emptyTitle={
          lowStockOnly ? 'No products are below their threshold right now' : 'No inventory rows yet'
        }
      >
        {(result) => (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Product</th>
                    <th className="num">Physical</th>
                    <th className="num">Reserved</th>
                    <th className="num">Available</th>
                    <th className="num">Threshold</th>
                    <th>Status</th>
                    <th aria-label="actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.map((r) => (
                    <tr key={r.product_id}>
                      <td className="mono">{r.sku}</td>
                      <td>
                        {r.name}
                        {!r.is_active ? (
                          <span className="badge badge--inactive">Inactive</span>
                        ) : null}
                      </td>
                      <td className="num">{r.physical_quantity}</td>
                      <td className="num">{r.reserved_quantity}</td>
                      <td className="num">{r.available_quantity}</td>
                      <td className="num">{r.low_stock_threshold}</td>
                      <td>
                        {r.is_low_stock ? (
                          <span className="badge badge--low">Low stock</span>
                        ) : (
                          <span className="badge badge--ok">Healthy</span>
                        )}
                      </td>
                      <td className="actions">
                        {user?.role === 'admin' ? (
                          <button
                            type="button"
                            className="btn btn--small"
                            onClick={() => setAdjusting(r)}
                            disabled={adjusting !== null}
                          >
                            Adjust
                          </button>
                        ) : (
                          <span className="muted">View only</span>
                        )}
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
                <span className="pagination__info">{pageSummary(result.meta, 'row', 'rows')}</span>
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

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchProducts } from '../services/api.js';
import { useApi } from '../hooks/useApi.js';
import { DataBoundary } from '../components/States.jsx';
import { totalPages, pageSummary } from '../utils/pagination.js';

const SORT_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'price', label: 'Price' },
  { value: 'sku', label: 'SKU' },
  { value: 'available', label: 'Stock available' },
  { value: 'created_at', label: 'Newest' },
];

/**
 * Public product listing with search, sorting and pagination.
 * Data always comes from GET /api/products — there is no hardcoded array.
 * The backend defaults to active-only products for every caller.
 */
export default function ProductsPage() {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('name');
  const [order, setOrder] = useState('asc');
  const [page, setPage] = useState(1);

  const params = useMemo(
    () => ({ search: search || undefined, sort, order, page, limit: 12 }),
    [search, sort, order, page]
  );

  const { status, data, error, reload } = useApi(() => fetchProducts(params), [params]);

  function applySearch(e) {
    e.preventDefault();
    setSearch(searchInput.trim());
    setPage(1);
  }

  const clearSearch = () => {
    setSearchInput('');
    setSearch('');
    setPage(1);
  };

  return (
    <main className="page page--wide">
      <header className="page__header">
        <h1 className="page__title">Products</h1>
        <p className="page__subtitle">Browse the live catalog served by the backend API.</p>
      </header>

      <form className="toolbar" onSubmit={applySearch}>
        <input
          className="toolbar__search"
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by name or SKU…"
          aria-label="Search products"
        />
        <button type="submit" className="btn">
          Search
        </button>
        {search ? (
          <button type="button" className="btn btn--secondary" onClick={clearSearch}>
            Clear
          </button>
        ) : null}
        <label className="toolbar__sort">
          Sort by
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              setPage(1);
            }}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => setOrder((o) => (o === 'asc' ? 'desc' : 'asc'))}
          aria-label={`Toggle sort direction (currently ${order})`}
        >
          {order === 'asc' ? '↑ Asc' : '↓ Desc'}
        </button>
      </form>

      <DataBoundary
        status={status}
        data={data}
        error={error}
        onRetry={reload}
        emptyTitle="No products match your search"
      >
        {(result) => (
          <>
            <ul className="product-grid">
              {result.data.map((p) => (
                <li key={p.id} className="product-card">
                  <Link to={`/products/${p.id}`} className="product-card__link">
                    <span className="product-card__sku">{p.sku}</span>
                    <span className="product-card__name">{p.name}</span>
                    <span className="product-card__price">₹ {p.unit_price}</span>
                    <span className="product-card__stock">
                      {Number(p.available_stock) > 0
                        ? `${p.available_stock} in stock`
                        : 'Out of stock'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>

            {result.meta ? (
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

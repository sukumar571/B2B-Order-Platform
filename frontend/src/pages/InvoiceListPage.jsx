import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchInvoices } from '../services/api.js';
import { useApi } from '../hooks/useApi.js';
import { useAuth } from '../context/AuthContext.jsx';
import { DataBoundary } from '../components/States.jsx';
import InvoiceStatusBadge from '../components/InvoiceStatusBadge.jsx';
import {
  INVOICE_STATUS_VALUES,
  invoiceStatusLabel,
  formatMoney,
} from '../constants/invoiceStatus.js';
import { totalPages, pageSummary } from '../utils/pagination.js';

const PAGE_SIZE = 20;

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
}

/**
 * Invoice list (FR-INV listing / GET /api/invoices). Customers see only their
 * own invoices — the backend scopes the query by the bearer identity, so this
 * page never sends or trusts a customer id. Staff see every invoice and may
 * filter by status. An invoice only exists once its order has shipped, so a
 * pre-shipment (or cancelled) order simply has no row here. Money is the
 * server-snapshotted figure and is rendered verbatim.
 */
export default function InvoiceListPage() {
  const { token, role } = useAuth();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const isCustomer = role === 'customer';

  const params = useMemo(() => {
    const p = { page, limit: PAGE_SIZE };
    if (!isCustomer && statusFilter) p.status = statusFilter;
    return p;
  }, [page, statusFilter, isCustomer]);

  const fetcher = useCallback(() => fetchInvoices(params, token), [params, token]);
  const { status, data, error, reload } = useApi(fetcher, [fetcher]);

  return (
    <main className="page page--wide">
      <header className="page__header page__header--row">
        <div>
          <h1 className="page__title">{isCustomer ? 'My invoices' : 'Invoices'}</h1>
          <p className="page__subtitle">
            {isCustomer
              ? 'Invoices for the orders you have placed that have shipped.'
              : 'Every issued invoice — newest first.'}
          </p>
        </div>
        {isCustomer ? null : (
          <label className="toolbar__toggle">
            Status
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All</option>
              {INVOICE_STATUS_VALUES.map((s) => (
                <option key={s} value={s}>
                  {invoiceStatusLabel(s)}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      <DataBoundary
        status={status}
        data={data}
        error={error}
        onRetry={reload}
        emptyTitle="No invoices yet"
      >
        {(result) => (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Issued</th>
                    {!isCustomer ? <th>Customer</th> : null}
                    <th>Order</th>
                    <th>Status</th>
                    <th className="num">Total</th>
                    <th aria-label="actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.map((inv) => (
                    <tr key={inv.id}>
                      <td className="mono">{inv.invoice_number}</td>
                      <td>{formatDate(inv.issued_date)}</td>
                      {!isCustomer ? <td>{inv.customer_name}</td> : null}
                      <td className="mono">#{inv.order_id}</td>
                      <td>
                        <InvoiceStatusBadge status={inv.status} />
                      </td>
                      <td className="num">{formatMoney(inv.grand_total)}</td>
                      <td className="actions">
                        <Link to={`/invoices/${inv.id}`} className="btn btn--small btn--secondary">
                          View
                        </Link>
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
                  {pageSummary(result.meta, 'invoice', 'invoices')}
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

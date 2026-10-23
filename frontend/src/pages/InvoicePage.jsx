import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchInvoice, fetchOrderInvoice, voidInvoice } from '../services/api.js';
import { useApi, STATUS } from '../hooks/useApi.js';
import { useAuth } from '../context/AuthContext.jsx';
import { LoadingState, ErrorState, FormProblem } from '../components/States.jsx';
import InvoiceStatusBadge from '../components/InvoiceStatusBadge.jsx';
import { canVoidInvoice, formatMoney } from '../constants/invoiceStatus.js';

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
}

/**
 * Printable invoice (FR-INV-03 / AC-INV-02). Renders the full document — the
 * distributor block, bill-to customer, invoice number/date/order reference,
 * the order's line items and the subtotal / tax / total — straight from the
 * server snapshot payload. Every figure is read-only: there is no client path
 * to alter a financial total or the ownership of the invoice (FR-INV-04).
 *
 * Print / Save-as-PDF uses the browser's native print (a `@media print`
 * stylesheet isolates the document) so NO PDF dependency is added (D-25). The
 * page is explicitly labelled a DEMONSTRATION document because this simulated
 * business has no established tax compliance.
 *
 * `by` selects the lookup key: an invoice id (default) or an order id (the
 * /orders/:orderId/invoice convenience route). Both hit an ownership-scoped
 * endpoint, so a foreign invoice 404s rather than leaking data.
 */
export default function InvoicePage({ by = 'invoice' }) {
  const params = useParams();
  const { token, role } = useAuth();
  const key = by === 'order' ? params.orderId : params.id;
  const isStaff = role === 'admin' || role === 'agent';

  const fetcher = useCallback(
    () => (by === 'order' ? fetchOrderInvoice(key, token) : fetchInvoice(key, token)),
    [by, key, token]
  );
  const { status, data: invoice, error, reload, setData } = useApi(fetcher, [fetcher]);

  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  async function submitVoid(e) {
    e.preventDefault();
    setBusy(true);
    setActionError(null);
    try {
      const updated = await voidInvoice(invoice.id, reason, token);
      setData(updated);
      setVoiding(false);
      setReason('');
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  }

  if (status === STATUS.LOADING) return <LoadingState label="Loading invoice…" />;
  if (status === STATUS.ERROR) {
    return (
      <main className="page">
        <ErrorState error={error} onRetry={reload} />
        <Link to="/invoices" className="btn btn--secondary detail__back no-print">
          ← Back to invoices
        </Link>
      </main>
    );
  }

  const items = invoice.items ?? [];
  const dist = invoice.distributor ?? {};
  const cust = invoice.customer ?? {};
  const voidable = isStaff && canVoidInvoice(invoice.status);

  return (
    <main className="page page--invoice">
      <div className="invoice-toolbar no-print">
        <Link to="/invoices" className="btn btn--secondary">
          ← Invoices
        </Link>
        <div className="invoice-toolbar__actions">
          <button type="button" className="btn" onClick={() => window.print()}>
            Print / Save as PDF
          </button>
        </div>
      </div>

      <article className="invoice-doc" aria-label="invoice document">
        {invoice.demo ? (
          <p className="invoice-demo-banner" role="note">
            {invoice.demo_notice}
          </p>
        ) : null}
        {invoice.status === 'voided' ? <div className="invoice-void-stamp">VOID</div> : null}

        <header className="invoice-doc__head">
          <div className="invoice-doc__brand">
            <h1 className="invoice-doc__company">{dist.name}</h1>
            <p className="invoice-doc__tagline">{dist.tagline}</p>
            {(dist.address_lines ?? []).map((line) => (
              <p key={line} className="invoice-doc__addr">
                {line}
              </p>
            ))}
            <p className="invoice-doc__addr">{dist.contact}</p>
            <p className="invoice-doc__tax">{dist.tax_registration}</p>
          </div>
          <div className="invoice-doc__meta">
            <p className="invoice-doc__title">INVOICE</p>
            <dl className="invoice-doc__meta-list">
              <div>
                <dt>Invoice no.</dt>
                <dd className="mono">{invoice.invoice_number}</dd>
              </div>
              <div>
                <dt>Issue date</dt>
                <dd>{formatDate(invoice.issued_date)}</dd>
              </div>
              <div>
                <dt>Order no.</dt>
                <dd className="mono">
                  <Link to={`/orders/${invoice.order_id}`} className="invoice-doc__orderlink">
                    #{invoice.order_id}
                  </Link>
                </dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <InvoiceStatusBadge status={invoice.status} />
                </dd>
              </div>
            </dl>
          </div>
        </header>

        <section className="invoice-doc__bill">
          <h2 className="invoice-doc__section-label">Bill to</h2>
          <address className="invoice-doc__customer">
            <strong>{cust.name}</strong>
            <br />
            {cust.email}
            <br />
            Customer ID: <span className="mono">#{cust.id}</span>
          </address>
        </section>

        <section className="invoice-doc__lines">
          <div className="table-wrap">
            <table className="table invoice-table">
              <thead>
                <tr>
                  <th>Item</th>
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
                    <td className="num">{formatMoney(it.unit_price)}</td>
                    <td className="num">{formatMoney(it.line_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="invoice-doc__totals">
            <div className="invoice-doc__total-row">
              <span>Subtotal</span>
              <span>{formatMoney(invoice.subtotal)}</span>
            </div>
            <div className="invoice-doc__total-row">
              <span>Tax</span>
              <span>{formatMoney(invoice.tax_total)}</span>
            </div>
            <div className="invoice-doc__total-row invoice-doc__total-row--grand">
              <span>Total due</span>
              <span>{formatMoney(invoice.grand_total)}</span>
            </div>
          </div>
        </section>

        {invoice.status === 'voided' && invoice.void_reason ? (
          <p className="invoice-doc__void-reason">
            Voided: {invoice.void_reason} ({formatDate(invoice.voided_at)})
          </p>
        ) : null}

        <footer className="invoice-doc__foot">
          <p>
            This invoice was generated automatically when order #{invoice.order_id} shipped. Amounts
            are the financial snapshot captured at order time and never recomputed from the live
            catalog.
          </p>
        </footer>
      </article>

      {voidable || actionError ? (
        <section className="card no-print" aria-label="void invoice">
          {actionError ? (
            <div role="alert" className="cart__action-error">
              <FormProblem error={actionError} />
            </div>
          ) : null}
          {voidable ? (
            voiding ? (
              <form className="form" onSubmit={submitVoid} aria-label="void invoice form">
                <label htmlFor="void-reason">Reason for voiding</label>
                <textarea
                  id="void-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  required
                  minLength={3}
                />
                <div className="cart__actions">
                  <button type="submit" className="btn" disabled={busy || reason.trim().length < 3}>
                    {busy ? 'Voiding…' : 'Confirm void'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--link"
                    onClick={() => setVoiding(false)}
                    disabled={busy}
                  >
                    Keep invoice
                  </button>
                </div>
              </form>
            ) : (
              <button type="button" className="btn btn--secondary" onClick={() => setVoiding(true)}>
                Void this invoice
              </button>
            )
          ) : null}
        </section>
      ) : null}
    </main>
  );
}

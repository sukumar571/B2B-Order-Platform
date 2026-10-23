import { invoiceStatusLabel } from '../constants/invoiceStatus.js';

/**
 * A coloured pill for an invoice status. Colour is presentational only; the
 * authoritative state always comes from the API response.
 */
export default function InvoiceStatusBadge({ status }) {
  return (
    <span className={`badge badge--invoice badge--invoice-${status}`}>
      {invoiceStatusLabel(status)}
    </span>
  );
}

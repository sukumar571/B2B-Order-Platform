import { statusLabel } from '../constants/orderStatus.js';

/**
 * A coloured pill for an order lifecycle status. Colour is presentational only;
 * the authoritative state always comes from the API response.
 */
export default function OrderStatusBadge({ status }) {
  return <span className={`badge badge--order badge--order-${status}`}>{statusLabel(status)}</span>;
}

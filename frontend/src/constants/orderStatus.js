/**
 * Order lifecycle presentation constants (Phase 7).
 *
 * These MIRROR the backend single-source-of-truth (backend/src/constants/orders.js)
 * purely for display: labels, badge colours, the one-step "advance" target and the
 * cancellable set. The UI never enforces anything — the API re-checks every
 * transition server-side and returns 409 for an illegal move — so this module is
 * only about what to render, not what is allowed.
 */

export const ORDER_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  PROCESSING: 'processing',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
};

export const ORDER_STATUS_VALUES = Object.values(ORDER_STATUS);

/** Human-readable label for each lifecycle state. */
export const STATUS_LABELS = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  processing: 'Processing',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

/** The single legal forward step from each state (terminals have none). */
export const NEXT_STATUS = {
  pending: 'confirmed',
  confirmed: 'processing',
  processing: 'shipped',
  shipped: 'delivered',
  delivered: null,
  cancelled: null,
};

/** Cancellation is only offered pre-shipment (pending/confirmed). */
export const CANCELLABLE_STATUSES = [ORDER_STATUS.PENDING, ORDER_STATUS.CONFIRMED];

/** Ordered chain used to render the progress timeline. */
export const FULFILMENT_CHAIN = [
  ORDER_STATUS.PENDING,
  ORDER_STATUS.CONFIRMED,
  ORDER_STATUS.PROCESSING,
  ORDER_STATUS.SHIPPED,
  ORDER_STATUS.DELIVERED,
];

export function isCancellable(status) {
  return CANCELLABLE_STATUSES.includes(status);
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

/**
 * Index of the current status within the fulfilment chain, or -1 for a
 * cancelled order (which is off the happy-path chain). Used by the timeline.
 */
export function chainIndex(status) {
  return FULFILMENT_CHAIN.indexOf(status);
}

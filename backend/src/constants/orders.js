'use strict';

/**
 * Order lifecycle vocabulary (Phase 7 — FR-ORD-07..11, decision D-24).
 *
 * State machine (docs/api-specification.md §2.4):
 *
 *   pending ─► confirmed ─► processing ─► shipped ─► delivered
 *      │           │
 *      └───────────┴──────────► cancelled   (a distinct operation, see below)
 *
 * - Forward transitions move ONE step along the chain (no skipping, no
 *   backwards edges). `delivered` and `cancelled` are terminal.
 * - Cancellation is a DISTINCT operation (POST /api/orders/:id/cancel), never a
 *   PATCH status value, and is legal only from `pending` or `confirmed` — i.e.
 *   strictly BEFORE the shipment that consumes stock. That is what guarantees a
 *   reservation can only ever be released once (see STOCK below).
 *
 * STOCK MODEL (docs/database-design.md §2.3, D-18) — `inventory`:
 *   physical_quantity  units on hand
 *   reserved_quantity  units claimed by live (pre-shipment) orders
 *   available_quantity = physical − reserved (GENERATED, the sellable figure)
 *
 *   order created            -> reserved += qty  (requires available >= qty)
 *   cancelled (pre-ship)     -> reserved -= qty  (release; available rises)
 *   SHIPPED (consumption)    -> physical -= qty AND reserved -= qty
 *                               (available is UNCHANGED — the units have
 *                                physically left the warehouse)
 *
 * Consumption happens exactly once, at `pending/confirmed → … → shipped`, and
 * cancellation is impossible from `shipped` onward, so a unit can never be
 * deducted twice. This file is the ONLY place that encodes those edges; the
 * service enforces them and the DB CHECKs are the last-line guard.
 */

const ORDER_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  PROCESSING: 'processing',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
};

const ORDER_STATUS_VALUES = Object.freeze(Object.values(ORDER_STATUS));

/** Legal PATCH /status forward edges (cancel is NOT among them). */
const FORWARD_TRANSITIONS = Object.freeze({
  [ORDER_STATUS.PENDING]: [ORDER_STATUS.CONFIRMED],
  [ORDER_STATUS.CONFIRMED]: [ORDER_STATUS.PROCESSING],
  [ORDER_STATUS.PROCESSING]: [ORDER_STATUS.SHIPPED],
  [ORDER_STATUS.SHIPPED]: [ORDER_STATUS.DELIVERED],
  [ORDER_STATUS.DELIVERED]: [],
  [ORDER_STATUS.CANCELLED]: [],
});

/** Statuses from which a live reservation exists and may be cancelled/released. */
const CANCELLABLE_STATUSES = Object.freeze([ORDER_STATUS.PENDING, ORDER_STATUS.CONFIRMED]);

/** The single status at which reserved stock is consumed (physical leaves). */
const CONSUMPTION_STATUS = ORDER_STATUS.SHIPPED;

/** True when `to` is a legal one-step forward move from `from`. */
function isLegalForward(from, to) {
  return Boolean(FORWARD_TRANSITIONS[from] && FORWARD_TRANSITIONS[from].includes(to));
}

/** True when an order in `from` may be cancelled. */
function isCancellable(from) {
  return CANCELLABLE_STATUSES.includes(from);
}

module.exports = {
  ORDER_STATUS,
  ORDER_STATUS_VALUES,
  FORWARD_TRANSITIONS,
  CANCELLABLE_STATUSES,
  CONSUMPTION_STATUS,
  isLegalForward,
  isCancellable,
};

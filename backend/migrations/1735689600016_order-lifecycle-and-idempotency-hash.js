'use strict';

/**
 * 16 — Phase 7 order lifecycle + idempotency request matching
 *
 * (a) Widens `orders.status` to the full lifecycle the order module enforces:
 *       pending → confirmed → processing → shipped → delivered, plus
 *       pending/confirmed → cancelled (see src/constants/orders.js). The prior
 *       domain had a single terminal `fulfilled`; shipment now consumes stock
 *       at `shipped` and `delivered` follows, so `fulfilled` is retired. The
 *       service owns the transition EDGES; this CHECK only bounds the value
 *       domain so an illegal string can never be committed.
 *
 * (b) Adds `idempotency_keys.request_hash` — a hex digest of the normalized
 *       order payload, stored with the claim so a REUSED key can be matched
 *       against the original request. Same key + different body → the service
 *       rejects with 409 IDEMPOTENCY_CONFLICT instead of silently replaying or
 *       double-charging (FR-ORD-06 request-matching rule). Nullable so existing
 *       rows stay valid.
 *
 * Fully reversible: the down script restores the original CHECK and drops the
 * column. Neither destroys order/idempotency data.
 */

const NEW_STATUSES = `('pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled')`;
const OLD_STATUSES = `('pending', 'confirmed', 'fulfilled', 'cancelled')`;

exports.up = (pgm) => {
  pgm.dropConstraint('orders', 'order_status_valid', { ifExists: true });
  pgm.addConstraint('orders', 'order_status_valid', { check: `status IN ${NEW_STATUSES}` });

  pgm.addColumn('idempotency_keys', {
    request_hash: { type: 'varchar(64)' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('idempotency_keys', 'request_hash', { ifExists: true });

  pgm.dropConstraint('orders', 'order_status_valid', { ifExists: true });
  pgm.addConstraint('orders', 'order_status_valid', { check: `status IN ${OLD_STATUSES}` });
};

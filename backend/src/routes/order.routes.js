'use strict';

const express = require('express');
const controller = require('../controllers/order.controller');
const invoiceController = require('../controllers/invoice.controller');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');

const router = express.Router();

// Every order endpoint is authenticated; role capabilities are declared per
// route and ownership is enforced in the service (docs/api-specification.md §2.4).

// Customer-only: placing an order reads the caller's own cart/lines and derives
// the customer id from the token.
router.post('/', authenticate, authorize('CUSTOMER'), controller.createOrder);

// Any authenticated role may LIST/READ, but a customer is scoped to their own
// orders in the service (staff see all). GET '/:id' is registered before the
// more specific sub-paths is not required — Express matches static segments
// ('items','status','cancel') independently of the ':id' param.
router.get('/', authenticate, controller.listOrders);
router.get('/:id', authenticate, controller.getOrder);
router.get('/:id/items', authenticate, controller.getOrderItems);
// Phase 8 — the invoice for an order (owned/scoped in the invoice service).
router.get('/:id/invoice', authenticate, invoiceController.getInvoiceByOrder);

// Staff only: administrative status progression. Customers CANNOT update order
// statuses (they may only cancel their own, below).
router.patch(
  '/:id/status',
  authenticate,
  authorize('ADMIN', 'ORDER_MANAGER'),
  controller.updateStatus
);

// Customer (own) or staff (any): cancellation is a DISTINCT operation that
// releases the reservation; ownership is enforced in the service.
router.post('/:id/cancel', authenticate, controller.cancelOrder);

module.exports = router;

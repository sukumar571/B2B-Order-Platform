'use strict';

const express = require('express');
const controller = require('../controllers/invoice.controller');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');

const router = express.Router();

// Every invoice endpoint is authenticated. Reads are open to any role but the
// SERVICE scopes a customer to invoices of their own orders (staff see all); a
// foreign invoice resolves to 404, never 403 — no existence leak (FR-INV-04).
router.get('/', authenticate, controller.listInvoices);
router.get('/:id', authenticate, controller.getInvoice);

// Staff only: voiding is the sole invoice write. It never alters totals — it
// flips status issued → voided and is audited, preserving the financial record.
router.post('/:id/void', authenticate, authorize('ADMIN', 'ORDER_MANAGER'), controller.voidInvoice);

module.exports = router;

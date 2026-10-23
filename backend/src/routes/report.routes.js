'use strict';

const express = require('express');
const controller = require('../controllers/report.controller');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');

const router = express.Router();

// The full dashboard is ADMIN-only (it embeds the audit activity feed).
router.get('/dashboard', authenticate, authorize('ADMIN'), controller.dashboard);

// Order managers get the same order/inventory metrics WITHOUT the audit feed —
// only the data their role is permitted to see (FR-AUD-03 keeps audit admin-only).
router.get(
  '/order-summary',
  authenticate,
  authorize('ADMIN', 'ORDER_MANAGER'),
  controller.orderSummary
);
router.get('/low-stock', authenticate, authorize('ADMIN', 'ORDER_MANAGER'), controller.lowStock);

module.exports = router;

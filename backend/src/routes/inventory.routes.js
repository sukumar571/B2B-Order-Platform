'use strict';

const express = require('express');
const controller = require('../controllers/inventory.controller');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');

const router = express.Router();

// Inventory visibility is staff-only (ADMIN + ORDER_MANAGER). Customers never
// see the physical/reserved breakdown — only the sellable figure on products.
router.get('/', authenticate, authorize('ADMIN', 'ORDER_MANAGER'), controller.list);
router.get('/low-stock', authenticate, authorize('ADMIN', 'ORDER_MANAGER'), controller.lowStock);

// Stock adjustments are ADMIN-only, transactional, and audited.
router.patch('/:id', authenticate, authorize('ADMIN'), controller.adjust);

module.exports = router;

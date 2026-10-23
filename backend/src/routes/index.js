'use strict';

const express = require('express');
const healthRoutes = require('./health.routes');
const authRoutes = require('./auth.routes');
const productRoutes = require('./product.routes');
const inventoryRoutes = require('./inventory.routes');
const cartRoutes = require('./cart.routes');
const orderRoutes = require('./order.routes');
const invoiceRoutes = require('./invoice.routes');
const auditRoutes = require('./audit.routes');
const reportRoutes = require('./report.routes');
const userRoutes = require('./user.routes');

const router = express.Router();

// All versioned API surface lives under /api.
router.use('/api', healthRoutes);
// Phase 4 — authentication & RBAC.
router.use('/api/auth', authRoutes);
// Phase 5 — product catalog & inventory.
router.use('/api/products', productRoutes);
router.use('/api/inventory', inventoryRoutes);
// Phase 6 — customer shopping cart (self-scoped, customer-only).
router.use('/api/cart', cartRoutes);
// Phase 7 — order management + transactional stock reservation.
router.use('/api/orders', orderRoutes);
// Phase 8 — invoices (generated on shipment; read-scoped; staff void).
router.use('/api/invoices', invoiceRoutes);
// Phase 9 — administrative user management, the audit trail, and dashboards.
router.use('/api/users', userRoutes);
router.use('/api/audit-logs', auditRoutes);
router.use('/api/reports', reportRoutes);

module.exports = router;

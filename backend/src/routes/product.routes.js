'use strict';

const express = require('express');
const controller = require('../controllers/product.controller');
const { authenticate, optionalAuthenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');

const router = express.Router();

// Public browse (active products only). optionalAuthenticate recognizes an
// ADMIN bearer token so staff can additionally list/view inactive catalog items
// — but never rejects an anonymous request.
router.get('/', optionalAuthenticate, controller.list);
router.get('/:id', optionalAuthenticate, controller.detail);

// Modifications are ADMIN-only (FR-CAT; "customers cannot modify products").
router.post('/', authenticate, authorize('ADMIN'), controller.create);
router.patch('/:id', authenticate, authorize('ADMIN'), controller.update);

module.exports = router;

'use strict';

const express = require('express');
const controller = require('../controllers/cart.controller');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');

const router = express.Router();

// Every cart endpoint is CUSTOMER-only and self-scoped: there is NO cart id or
// customer id in the URL — the caller's cart is derived exclusively from the
// authenticated token (docs/api-specification.md §2.3). Admins/agents do not
// shop, so they are excluded here (403).
router.use(authenticate, authorize('CUSTOMER'));

router.get('/', controller.getCart);
router.post('/items', controller.addItem);
router.patch('/items/:itemId', controller.updateItem);
router.delete('/items/:itemId', controller.removeItem);
// DELETE '' (i.e. DELETE /api/cart) empties the cart. Registered AFTER the
// '/items/:itemId' route so it is not shadowed.
router.delete('/', controller.clearCart);

module.exports = router;

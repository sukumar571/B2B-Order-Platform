'use strict';

const express = require('express');
const controller = require('../controllers/user.controller');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');

const router = express.Router();

// Administrative user management is ADMIN-only. Every mutating change is
// audited transactionally by the service; account creation stays with the public
// CUSTOMER-only /api/auth/register flow (never here — FR-AUTH-05).
router.get('/', authenticate, authorize('ADMIN'), controller.listUsers);
router.get('/:id', authenticate, authorize('ADMIN'), controller.getUser);
router.patch('/:id', authenticate, authorize('ADMIN'), controller.updateUser);

module.exports = router;

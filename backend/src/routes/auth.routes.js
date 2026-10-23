'use strict';

const express = require('express');
const controller = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/authenticate');
const { requireSelf } = require('../middleware/authorize');
const { loginRateLimiter, registerRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// Sensitive endpoints are rate-limited per IP (R-08 brute-force defence).
router.post('/register', registerRateLimiter, controller.register);
router.post('/login', loginRateLimiter, controller.login);
router.post('/refresh', loginRateLimiter, controller.refresh);
router.post('/logout', controller.logout);

// Self-scoped: the identity comes only from the access token — a caller can
// never ask for someone else's profile (no id parameter exists to forge).
router.get('/me', authenticate, requireSelf, controller.me);

module.exports = router;

'use strict';

const express = require('express');
const controller = require('../controllers/audit.controller');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');

const router = express.Router();

// The audit trail is ADMIN-only and READ-ONLY (FR-AUD-02/03). Only a GET route
// is mounted — there is no POST/PUT/PATCH/DELETE anywhere in the API that can
// alter audit_logs, and the DB itself forbids UPDATE/DELETE via an append-only
// trigger. A non-admin is rejected by `authorize('ADMIN')` before the handler.
router.get('/', authenticate, authorize('ADMIN'), controller.listAuditLogs);

module.exports = router;

'use strict';

const auditService = require('../services/audit.service');
const { asyncHandler } = require('../middleware/asyncHandler');

/**
 * HTTP layer for the audit trail. READ-ONLY and ADMIN-only (enforced by route
 * middleware). There is intentionally NO create/update/delete handler: the trail
 * is written only inside business transactions and is append-only at the DB
 * level (FR-AUD-02), so nothing here can mutate history.
 */

/** GET /api/audit-logs — ADMIN only — 200 { data, meta }. */
const listAuditLogs = asyncHandler(async (req, res) => {
  res.status(200).json(await auditService.listForAdmin(req.query));
});

module.exports = { listAuditLogs };

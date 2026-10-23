'use strict';

const invoiceService = require('../services/invoice.service');
const { asyncHandler } = require('../middleware/asyncHandler');

/**
 * HTTP layer for invoices. Read scoping (customer → own, staff → all) and the
 * ownership 404-not-403 rule are enforced in the service from `req.user`; this
 * layer only maps HTTP ↔ service. There is deliberately NO endpoint that lets a
 * client set invoice totals or ownership — the only write is a staff void.
 */

/** GET /api/invoices — customer (own) / staff (all) — 200 {data, meta}. */
const listInvoices = asyncHandler(async (req, res) => {
  res.status(200).json(await invoiceService.listInvoices(req.user, req.query));
});

/** GET /api/invoices/:id — 200 full printable payload (ownership enforced). */
const getInvoice = asyncHandler(async (req, res) => {
  res.status(200).json(await invoiceService.getInvoice(req.user, req.params.id));
});

/** GET /api/orders/:id/invoice — 200 invoice for an order (convenience route). */
const getInvoiceByOrder = asyncHandler(async (req, res) => {
  res.status(200).json(await invoiceService.getInvoiceByOrder(req.user, req.params.id));
});

/** POST /api/invoices/:id/void — staff only — 200 voided invoice (row preserved). */
const voidInvoice = asyncHandler(async (req, res) => {
  res.status(200).json(await invoiceService.voidInvoice(req.user, req.params.id, req.body));
});

module.exports = {
  listInvoices,
  getInvoice,
  getInvoiceByOrder,
  voidInvoice,
};

'use strict';

const { z } = require('zod');
const { ApiError } = require('../utils/errors');
const { CART_MAX_LINE_QTY } = require('../constants/cart');
const { ORDER_STATUS, ORDER_STATUS_VALUES } = require('../constants/orders');
const { INVOICE_STATUS_VALUES } = require('../constants/invoices');
const { ROLE_VALUES } = require('../constants/roles');
const {
  AUDIT_ACTION_VALUES,
  AUDIT_ENTITY_TYPE_VALUES,
  AUDIT_OUTCOME_VALUES,
} = require('../constants/audit');

/**
 * Zod input validators shared by the auth and catalog layers
 * (docs/api-specification.md §4). Body schemas are .strict(): an unknown field
 * is rejected outright — public registration can never select a privileged
 * role (FR-AUTH-05) and product payloads can never smuggle arbitrary columns.
 * Query/path params are parsed and clamped here so repositories only ever see
 * validated, typed values (parameterized SQL, no interpolation — C-04).
 */

// Users table caps: email varchar(255), name varchar(120) — mirror them here.
const email = z
  .email({ message: 'A valid email address is required' })
  .max(255, { message: 'Email must not exceed 255 characters' })
  .transform((v) => v.toLowerCase().trim());

const name = z
  .string({ message: 'Name is required' })
  .trim()
  .min(1, { message: 'Name must not be blank' })
  .max(120, { message: 'Name must not exceed 120 characters' });

const password = z
  .string()
  .min(10, { message: 'Password must be at least 10 characters long' })
  .max(128, { message: 'Password must not exceed 128 characters' })
  .refine((v) => /[A-Za-z]/.test(v) && /[0-9]/.test(v), {
    message: 'Password must contain at least one letter and one digit',
  });

const registerSchema = z
  .object({
    email,
    password,
    name,
  })
  .strict();

const loginSchema = z
  .object({
    email,
    // No complexity rules on login — legacy/seed passwords must still parse.
    password: z.string().min(1, { message: 'Password is required' }).max(128),
  })
  .strict();

// ── Catalog & inventory (Phase 5) ─────────────────────────────────────────

// Products table caps: sku varchar(50), name varchar(160), description text.
const sku = z
  .string({ message: 'SKU is required' })
  .trim()
  .min(1, { message: 'SKU must not be blank' })
  .max(50, { message: 'SKU must not exceed 50 characters' });

const productName = z
  .string({ message: 'Product name is required' })
  .trim()
  .min(1, { message: 'Product name must not be blank' })
  .max(160, { message: 'Product name must not exceed 160 characters' });

const productDescription = z
  .string()
  .trim()
  .max(5000, { message: 'Description must not exceed 5000 characters' });

// Money arrives as a string like "19.99" (spec §1) or a JSON number; normalized
// to a 2-decimal decimal string. NUMERIC(12,2) ceiling: 9,999,999,999.99.
const money = (label) =>
  z
    .union([z.string(), z.number()], { message: `${label} must be a number` })
    .transform((v) => String(v).trim())
    .refine((s) => /^\d+(\.\d{1,2})?$/.test(s), {
      message: `${label} must be a non-negative number with up to 2 decimals`,
    })
    .refine((s) => Number(s) > 0, { message: `${label} must be greater than 0` })
    .refine((s) => Number(s) <= 9999999999.99, {
      message: `${label} exceeds the maximum allowed value`,
    });

const taxRate = z
  .union([z.string(), z.number()], { message: 'tax_rate must be a number' })
  .transform((v) => String(v).trim())
  .refine((s) => /^\d+(\.\d{1,2})?$/.test(s), { message: 'tax_rate must have up to 2 decimals' })
  .refine((s) => Number(s) >= 0 && Number(s) <= 100, {
    message: 'tax_rate must be between 0 and 100',
  });

// "0" / "false" / "1" / "true" / boolean → boolean (query strings arrive as text).
const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

// Clamped pagination shared by every list endpoint. Absent → default; a
// present-but-invalid value (e.g. limit=99999) fails closed → 400.
const page = z.coerce.number().int().min(1).default(1);
const limit = z.coerce.number().int().min(1).max(100).default(20);

// Positive bigint id from the route path.
const idParam = z.coerce.number().int().min(1);

const SORTABLE_PRODUCT_COLUMNS = {
  name: 'p.name',
  price: 'p.unit_price',
  sku: 'p.sku',
  created_at: 'p.created_at',
  available: 'available_quantity',
};

const productListQuerySchema = z
  .object({
    search: z.string().trim().max(200).optional(),
    sort: z.enum(Object.keys(SORTABLE_PRODUCT_COLUMNS)).default('name'),
    order: z.enum(['asc', 'desc']).default('asc'),
    active_only: boolish.default(true),
    page,
    limit,
  })
  .strict();

const inventoryListQuerySchema = z
  .object({
    search: z.string().trim().max(200).optional(),
    active_only: boolish.default(false),
    low_stock_only: boolish.default(false),
    page,
    limit,
  })
  .strict();

const productIdParamSchema = z.object({ id: idParam }).strict();

const createProductSchema = z
  .object({
    sku,
    name: productName,
    description: productDescription.default(''),
    unit_price: money('unit_price'),
    tax_rate: taxRate.default('0'),
    // Stock is seeded at creation only through the inventory row; default 0.
    initial_stock: z.coerce.number().int().min(0).max(2147483647).default(0),
    low_stock_threshold: z.coerce.number().int().min(0).max(2147483647).default(20),
    is_active: boolish.default(true),
  })
  .strict();

// PATCH: every field optional, but at least one must be present.
const updateProductSchema = z
  .object({
    sku: sku.optional(),
    name: productName.optional(),
    description: productDescription.optional(),
    unit_price: money('unit_price').optional(),
    tax_rate: taxRate.optional(),
    is_active: boolish.optional(),
    low_stock_threshold: z.coerce.number().int().min(0).max(2147483647).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

// PATCH /api/inventory/:id — a stock adjustment and/or a threshold change.
const updateInventorySchema = z
  .object({
    delta: z.coerce
      .number()
      .int()
      .refine((v) => v !== 0, {
        message: 'delta must be a non-zero integer',
      }),
    reason: z.string().trim().min(1, { message: 'reason is required' }).max(300),
    low_stock_threshold: z.coerce.number().int().min(0).max(2147483647).optional(),
  })
  .strict();

// ── Cart (Phase 6) ────────────────────────────────────────────────────────
// Cart endpoints are self-scoped: the owner is ALWAYS the authenticated user's
// id taken from the token (never a client-supplied customer/cart id — the
// strict schemas below reject such fields outright, closing the IDOR surface).

// Positive bigint id (product id / cart-item id) from a body or the path.
const positiveId = z.coerce.number().int().min(1);

// Quantity is a positive integer bounded by the documented per-line maximum
// (constants/cart.js — mirrored as a DB CHECK). A JSON number or numeric
// string both parse; anything < 1, fractional or > max fails closed → 400.
const cartQuantity = z.coerce
  .number()
  .int('quantity must be a whole number')
  .min(1, { message: 'quantity must be at least 1' })
  .max(CART_MAX_LINE_QTY, { message: `quantity must not exceed ${CART_MAX_LINE_QTY} per line` });

// POST /api/cart/items body.
const addCartItemSchema = z
  .object({
    product_id: positiveId,
    quantity: cartQuantity.default(1),
  })
  .strict();

// PATCH /api/cart/items/:itemId body — sets an ABSOLUTE quantity.
const updateCartItemSchema = z
  .object({
    quantity: cartQuantity,
  })
  .strict();

// Path param for a cart line.
const cartItemIdParamSchema = z.object({ itemId: positiveId }).strict();

// ── Orders (Phase 7) ──────────────────────────────────────────────────────
// The order owner is ALWAYS the authenticated customer id from the token; the
// body carries product ids + quantities only — never prices, totals or a
// customer id (the strict schemas below reject such fields outright). All money
// is recomputed server-side (docs/api-specification.md §2.4).

// A single requested line. Quantities reuse the documented per-line bound.
const orderItemSchema = z
  .object({
    product_id: positiveId,
    quantity: cartQuantity,
  })
  .strict();

// POST /api/orders body — either an explicit items[] or an EMPTY object meaning
// "order my cart". Prices/totals are NEVER accepted from the client.
const createOrderSchema = z
  .object({
    items: z.array(orderItemSchema).min(1).max(200).optional(),
  })
  .strict();

// Path param for an order.
const orderIdParamSchema = z.object({ id: positiveId }).strict();

// GET /api/orders query — status filter + (staff-only) customer filter + paging.
const orderListQuerySchema = z
  .object({
    status: z.enum(ORDER_STATUS_VALUES).optional(),
    customer_id: positiveId.optional(),
    page,
    limit,
  })
  .strict();

// PATCH /api/orders/:id/status — a forward move only. `cancelled` is deliberately
// excluded: cancellation is a distinct operation (POST /:id/cancel) so a
// reservation can never be released through the generic status endpoint.
const updateOrderStatusSchema = z
  .object({
    status: z.enum([
      ORDER_STATUS.CONFIRMED,
      ORDER_STATUS.PROCESSING,
      ORDER_STATUS.SHIPPED,
      ORDER_STATUS.DELIVERED,
      ORDER_STATUS.CANCELLED,
    ]),
  })
  .strict();

// POST /api/orders/:id/cancel body — a meaningful reason is required (FR-ORD-08,
// mirrored by the DB order_cancellation_reason_required CHECK).
const cancelOrderSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(3, { message: 'A cancellation reason of at least 3 characters is required' })
      .max(500, { message: 'Cancellation reason must not exceed 500 characters' }),
  })
  .strict();

// ── Invoices (Phase 8) ──────────────────────────────────────────────────────
// Invoices are read-only financial records for customers (own orders only) and
// staff (all). There is NO client path to set totals or ownership — a money or
// customer field in any invoice body is rejected outright by these strict
// schemas (FR-INV-04). The only invoice write is a staff VOID with a reason.

// GET /api/invoices query — status filter + (staff-only) customer filter + paging.
const invoiceListQuerySchema = z
  .object({
    status: z.enum(INVOICE_STATUS_VALUES).optional(),
    customer_id: positiveId.optional(),
    page,
    limit,
  })
  .strict();

// Path param for an invoice.
const invoiceIdParamSchema = z.object({ id: positiveId }).strict();

// POST /api/invoices/:id/void body — a meaningful reason is required; nothing
// else is accepted (a void never touches totals).
const voidInvoiceSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(3, { message: 'A void reason of at least 3 characters is required' })
      .max(500, { message: 'Void reason must not exceed 500 characters' }),
  })
  .strict();

// ── Audit & reports (Phase 9) ──────────────────────────────────────────────
// An ISO-8601 date ('YYYY-MM-DD') or timestamp bound for a range filter. A bare
// date is normalised to the start (from) or end (to) of that day in UTC so a
// date-only range still captures the whole final day. Anything unparseable → 400.
const dateBound = (endOfDay) =>
  z
    .string()
    .trim()
    .refine((s) => /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(s), {
      message: 'must be an ISO date (YYYY-MM-DD) or timestamp',
    })
    .refine((s) => !Number.isNaN(Date.parse(s.replace(' ', 'T'))), {
      message: 'invalid date',
    })
    .transform((s) => {
      const iso = s.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
        return endOfDay ? `${iso}T23:59:59.999Z` : `${iso}T00:00:00.000Z`;
      }
      return new Date(iso.replace(' ', 'T')).toISOString();
    });

// GET /api/audit-logs — ADMIN only. Every filter is optional; unknown params
// are rejected (strict) so a typo cannot silently widen the whole-trail read.
const auditListQuerySchema = z
  .object({
    actor_id: positiveId.optional(),
    action: z.enum(AUDIT_ACTION_VALUES).optional(),
    entity_type: z.enum(AUDIT_ENTITY_TYPE_VALUES).optional(),
    entity_id: positiveId.optional(),
    outcome: z.enum(AUDIT_OUTCOME_VALUES).optional(),
    from: dateBound(false).optional(),
    to: dateBound(true).optional(),
    page,
    limit,
  })
  .strict();

// GET /api/reports/* — an optional [from, to] window on order created_at.
// Absent → the service applies its documented default window.
const reportQuerySchema = z
  .object({
    from: dateBound(false).optional(),
    to: dateBound(true).optional(),
  })
  .strict();

// ── Users (Phase 9 — administrative changes, ADMIN only) ────────────────────
// Path param for a user.
const userIdParamSchema = z.object({ id: positiveId }).strict();

// GET /api/users query — optional role filter + paging.
const userListQuerySchema = z
  .object({
    role: z.enum(Object.values(ROLE_VALUES)).optional(),
    page,
    limit,
  })
  .strict();

// PATCH /api/users/:id — role and/or active status. There is deliberately NO
// password/email/name field: this is the admin provisioning/guardrail surface,
// not a profile editor. At least one field is required; the service adds a
// self-lockout guard (an admin cannot demote or disable their own account).
const updateUserSchema = z
  .object({
    role: z.enum(Object.values(ROLE_VALUES)).optional(),
    is_active: boolish.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

/**
 * Validate a payload; on failure throw a 400 VALIDATION_ERROR whose details
 * are a safe, field -> messages map (never echoes submitted secrets).
 */
function validateInput(schema, payload) {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  const details = {};
  for (const issue of result.error.issues) {
    const field = issue.path.length ? issue.path.join('.') : '_';
    if (!details[field]) details[field] = issue.message;
  }
  throw new ApiError(400, 'VALIDATION_ERROR', 'Request payload validation failed', details);
}

module.exports = {
  email,
  name,
  password,
  registerSchema,
  loginSchema,
  validateInput,
  // Catalog & inventory (Phase 5)
  SORTABLE_PRODUCT_COLUMNS,
  productListQuerySchema,
  inventoryListQuerySchema,
  productIdParamSchema,
  createProductSchema,
  updateProductSchema,
  updateInventorySchema,
  // Cart (Phase 6)
  CART_MAX_LINE_QTY,
  addCartItemSchema,
  updateCartItemSchema,
  cartItemIdParamSchema,
  // Orders (Phase 7)
  ORDER_STATUS,
  ORDER_STATUS_VALUES,
  orderItemSchema,
  createOrderSchema,
  orderIdParamSchema,
  orderListQuerySchema,
  updateOrderStatusSchema,
  cancelOrderSchema,
  // Invoices (Phase 8)
  invoiceListQuerySchema,
  invoiceIdParamSchema,
  voidInvoiceSchema,
  // Audit & reports (Phase 9)
  auditListQuerySchema,
  reportQuerySchema,
  // Users (Phase 9 — admin)
  userIdParamSchema,
  userListQuerySchema,
  updateUserSchema,
};

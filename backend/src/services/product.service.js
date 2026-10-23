'use strict';

const { withTransaction } = require('../db/pool');
const productRepo = require('../repositories/product.repository');
const inventoryRepo = require('../repositories/inventory.repository');
const { logAudit } = require('./audit.service');
const { ApiError } = require('../utils/errors');
const { ROLE_VALUES } = require('../constants/roles');
const {
  productListQuerySchema,
  productIdParamSchema,
  createProductSchema,
  updateProductSchema,
  validateInput,
} = require('../utils/validators');

/**
 * Product catalog domain logic (FR-CAT-01..04, FR-CAT-08).
 * Visibility rule: the public catalog shows ACTIVE products only; an
 * authenticated ADMIN may additionally list/view INACTIVE ones (soft-deleted
 * rows kept for order history — products are never physically deleted).
 */

function callerIsAdmin(user) {
  return Boolean(user) && user.role === ROLE_VALUES.ADMIN;
}

function pgCode(err) {
  return err && (err.code || (err.originalError && err.originalError.code));
}

/** GET /api/products */
async function list(query, user) {
  const q = validateInput(productListQuerySchema, query || {});
  // Non-admins are always confined to active products (fail-closed).
  const activeOnly = callerIsAdmin(user) ? q.active_only : true;
  const { rows, total } = await productRepo.listProducts({
    search: q.search,
    activeOnly,
    sortKey: q.sort,
    order: q.order,
    page: q.page,
    limit: q.limit,
  });
  return { data: rows, meta: { page: q.page, limit: q.limit, total } };
}

/** GET /api/products/:id — inactive products are hidden from non-admins (404). */
async function getById(rawId, user) {
  const { id } = validateInput(productIdParamSchema, { id: rawId });
  const product = await productRepo.findById(id);
  if (!product || (!product.is_active && !callerIsAdmin(user))) {
    throw ApiError.notFound('Product not found');
  }
  return { data: product };
}

/** POST /api/products — ADMIN only (enforced by route middleware). */
async function create(body, actor) {
  const input = validateInput(createProductSchema, body);
  let productId;
  try {
    productId = await withTransaction(async (client) => {
      const id = await productRepo.insert(client, {
        sku: input.sku,
        name: input.name,
        description: input.description,
        unitPrice: input.unit_price,
        taxRate: input.tax_rate,
        isActive: input.is_active,
      });
      await inventoryRepo.insertRow(client, {
        productId: id,
        physical: input.initial_stock,
        lowStockThreshold: input.low_stock_threshold,
      });
      await logAudit(client, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'PRODUCT_CREATED',
        entityType: 'product',
        entityId: id,
        details: {
          sku: input.sku,
          name: input.name,
          unit_price: input.unit_price,
          initial_stock: input.initial_stock,
          is_active: input.is_active,
        },
      });
      return id;
    });
  } catch (err) {
    if (pgCode(err) === '23505') {
      throw ApiError.conflict('DUPLICATE_SKU', 'A product with this SKU already exists');
    }
    throw err;
  }
  const product = await productRepo.findById(productId);
  return { data: product };
}

/** PATCH /api/products/:id — ADMIN only. Also the deactivation/archival path. */
async function update(rawId, body, actor) {
  const { id } = validateInput(productIdParamSchema, { id: rawId });
  const patch = validateInput(updateProductSchema, body);

  const existing = await productRepo.findById(id);
  if (!existing) throw ApiError.notFound('Product not found');

  const changedFields = Object.keys(patch);
  // An activation/deactivation is only meaningful when is_active actually
  // FLIPS; an edit that merely re-states the current value is an UPDATE.
  const isActivation = patch.is_active === true && existing.is_active === false;
  const isDeactivation = patch.is_active === false && existing.is_active === true;
  const auditAction = isActivation
    ? 'PRODUCT_ACTIVATED'
    : isDeactivation
      ? 'PRODUCT_DEACTIVATED'
      : 'PRODUCT_UPDATED';

  let updated;
  try {
    updated = await withTransaction(async (client) => {
      const row = await productRepo.update(client, id, patch);
      if (patch.low_stock_threshold !== undefined) {
        await inventoryRepo.setThreshold(client, id, patch.low_stock_threshold);
      }
      await logAudit(client, {
        actorId: actor.id,
        actorRole: actor.role,
        action: auditAction,
        entityType: 'product',
        entityId: id,
        details: { fields: changedFields },
      });
      return row;
    });
  } catch (err) {
    if (pgCode(err) === '23505') {
      throw ApiError.conflict('DUPLICATE_SKU', 'A product with this SKU already exists');
    }
    throw err;
  }
  void updated;
  // Re-read after commit so a threshold change made in the same txn is reflected.
  const product = await productRepo.findById(id);
  return { data: product };
}

module.exports = { list, getById, create, update, callerIsAdmin };

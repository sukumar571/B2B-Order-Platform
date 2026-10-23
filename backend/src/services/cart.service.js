'use strict';

const { withTransaction } = require('../db/pool');
const cartRepo = require('../repositories/cart.repository');
const { logAudit } = require('./audit.service');
const { ApiError } = require('../utils/errors');
const { CART_MAX_LINE_QTY } = require('../constants/cart');
const money = require('../utils/money');
const {
  addCartItemSchema,
  updateCartItemSchema,
  cartItemIdParamSchema,
  validateInput,
} = require('../utils/validators');

/**
 * Cart domain logic (FR-CART-01..05).
 *
 * SECURITY MODEL: the cart owner is ALWAYS `customerId` taken from the
 * validated access token — never from the request. The repository scopes every
 * query by that id, so one customer can neither read nor mutate another's cart
 * (AC-CART-05). A foreign item id simply isn't in the caller's cart → 404.
 *
 * CART ≠ RESERVATION (FR-CART-04 / D-23): adding/updating a line only READS
 * current `available_quantity` to reject an obviously-unfulfillable quantity.
 * It never locks or decrements stock. Availability is re-checked authoritatively
 * under a FOR UPDATE lock at order creation. Because stock can change after a
 * line is added, every read recomputes live prices/availability and flags lines
 * whose stored quantity now exceeds what is on hand (stock_warning) or whose
 * product went inactive (unavailable).
 *
 * Totals are computed SERVER-SIDE from live catalog prices — the browser is
 * never trusted with unit prices or subtotals (integer-cent math, D-09).
 */

/** Build the cart response (header + lines + server-derived totals). */
function serialize(cartId, rawLines) {
  const lines = rawLines.map((line) => {
    const computed = money.computeLine({
      unit_price: line.unit_price,
      tax_rate: line.tax_rate,
      quantity: line.quantity,
    });
    return {
      id: line.id,
      product_id: line.product_id,
      product_name: line.product_name,
      sku: line.sku,
      unit_price: computed.unit_price, // live, never client-supplied
      quantity: computed.quantity,
      line_total: computed.line_total,
      line_tax: computed.line_tax,
      available_now: line.available_now,
      // Became unavailable after being added, or over-sold since: surfaced so
      // the UI can warn, but never silently dropped from the cart.
      is_active: line.product_is_active,
      unavailable: !line.product_is_active,
      stock_warning: line.quantity > line.available_now,
      _lineTotalCents: computed._lineTotalCents,
      _lineTaxCents: computed._lineTaxCents,
    };
  });

  const summary = money.summarize(lines);
  return { id: String(cartId), items: summary.lines, ...totalsOnly(summary) };
}

function totalsOnly(summary) {
  return {
    subtotal: summary.subtotal,
    tax_total: summary.tax_total,
    grand_total: summary.grand_total,
  };
}

/** GET /api/cart */
async function getCart(customerId) {
  let existing = await cartRepo.findCart(customerId);
  if (!existing) {
    // Users provisioned outside registration may not have a cart row yet.
    await withTransaction((client) => cartRepo.ensureCart(client, customerId));
    existing = await cartRepo.findCart(customerId);
  }
  const lines = await cartRepo.findLines(customerId);
  return serialize(existing.id, lines);
}

/**
 * POST /api/cart/items — upsert merge (FR-CART-01). The merged (existing +
 * added) quantity is validated against the per-line max and current stock.
 */
async function addItem(customerId, body, actor) {
  const input = validateInput(addCartItemSchema, body);
  const { product_id: productId, quantity } = input;

  await withTransaction(async (client) => {
    const cartId = await cartRepo.ensureCart(client, customerId);

    const product = await cartRepo.loadProduct(client, productId);
    if (!product || !product.is_active) {
      // Inactive/unknown products cannot be added (FR-CART-02 / FR-CAT-08) —
      // 404 does not leak which archived ids exist.
      throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found or not available');
    }

    const current = await cartRepo.getLineQuantity(client, cartId, productId);
    const merged = (current || 0) + quantity;

    if (merged > CART_MAX_LINE_QTY) {
      throw ApiError.conflict(
        'CART_LINE_LIMIT_EXCEEDED',
        `A single cart line cannot exceed ${CART_MAX_LINE_QTY} units`,
        { product_id: String(productId), merged_quantity: merged, max_quantity: CART_MAX_LINE_QTY }
      );
    }
    // Reject a quantity that obviously exceeds what is currently sellable.
    // This is a courtesy check only — stock is locked/re-verified at order time.
    if (merged > product.available_stock) {
      throw ApiError.conflict('INSUFFICIENT_STOCK', 'Requested quantity exceeds available stock', {
        product_id: String(productId),
        requested: merged,
        available: product.available_stock,
      });
    }

    const row = await cartRepo.upsertItem(client, cartId, productId, quantity);
    await logAudit(client, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'CART_ITEM_ADDED',
      entityType: 'cart',
      entityId: cartId,
      details: { product_id: String(productId), added: quantity, line_quantity: row.quantity },
    });
    return row;
  });

  return getCart(customerId);
}

/**
 * PATCH /api/cart/items/:itemId — set an absolute quantity on one of the
 * caller's own lines. A foreign item id is not found in this cart → 404.
 */
async function updateItem(customerId, rawItemId, body, actor) {
  const { itemId } = validateInput(cartItemIdParamSchema, { itemId: rawItemId });
  const { quantity } = validateInput(updateCartItemSchema, body);

  await withTransaction(async (client) => {
    const cartId = await cartRepo.ensureCart(client, customerId);

    const item = await cartRepo.findItem(client, cartId, itemId);
    if (!item) throw new ApiError(404, 'CART_ITEM_NOT_FOUND', 'Cart item not found');

    const product = await cartRepo.loadProduct(client, item.product_id);
    if (!product || !product.is_active) {
      throw ApiError.conflict('PRODUCT_UNAVAILABLE', 'This product is no longer available', {
        product_id: String(item.product_id),
      });
    }
    if (quantity > product.available_stock) {
      throw ApiError.conflict('INSUFFICIENT_STOCK', 'Requested quantity exceeds available stock', {
        product_id: String(item.product_id),
        requested: quantity,
        available: product.available_stock,
      });
    }

    const row = await cartRepo.setItemQuantity(client, cartId, itemId, quantity);
    await logAudit(client, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'CART_ITEM_UPDATED',
      entityType: 'cart',
      entityId: cartId,
      details: { item_id: String(itemId), quantity: row.quantity },
    });
    return row;
  });

  return getCart(customerId);
}

/** DELETE /api/cart/items/:itemId */
async function removeItem(customerId, rawItemId, actor) {
  const { itemId } = validateInput(cartItemIdParamSchema, { itemId: rawItemId });

  await withTransaction(async (client) => {
    const cartId = await cartRepo.ensureCart(client, customerId);
    const deleted = await cartRepo.deleteItem(client, cartId, itemId);
    if (!deleted) throw new ApiError(404, 'CART_ITEM_NOT_FOUND', 'Cart item not found');
    await logAudit(client, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'CART_ITEM_REMOVED',
      entityType: 'cart',
      entityId: cartId,
      details: { item_id: String(itemId) },
    });
  });

  return getCart(customerId);
}

/** DELETE /api/cart — empty the caller's cart (FR-CART-05). */
async function clearCart(customerId, actor) {
  await withTransaction(async (client) => {
    const cartId = await cartRepo.ensureCart(client, customerId);
    const removed = await cartRepo.clearItems(client, cartId);
    await logAudit(client, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'CART_EMPTIED',
      entityType: 'cart',
      entityId: cartId,
      details: { removed_lines: removed },
    });
  });
}

module.exports = { getCart, addItem, updateItem, removeItem, clearCart, serialize };

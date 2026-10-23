'use strict';

const { withTransaction } = require('../db/pool');
const inventoryRepo = require('../repositories/inventory.repository');
const { logAudit } = require('./audit.service');
const { ApiError } = require('../utils/errors');
const {
  inventoryListQuerySchema,
  productIdParamSchema,
  updateInventorySchema,
  validateInput,
} = require('../utils/validators');

/**
 * Inventory domain logic (FR-CAT-05/06).
 * Stock adjustments are transactional: the inventory row is locked FOR UPDATE,
 * an append-only inventory_movements ledger row is written, and an audit_logs
 * record is created in the SAME transaction. The DB CHECKs (physical >= 0 and
 * available >= 0) are the final overselling guard; the service pre-checks them
 * too so it can return a clean 409 instead of leaking a raw constraint error.
 */

function pgCode(err) {
  return err && (err.code || (err.originalError && err.originalError.code));
}

function list(query, { forceLowStock = false } = {}) {
  const q = validateInput(inventoryListQuerySchema, query || {});
  return inventoryRepo
    .listInventory({
      search: q.search,
      activeOnly: q.active_only,
      lowStockOnly: forceLowStock || q.low_stock_only,
      page: q.page,
      limit: q.limit,
    })
    .then(({ rows, total }) => ({ data: rows, meta: { page: q.page, limit: q.limit, total } }));
}

/** GET /api/inventory/low-stock — convenience filter over the same table. */
function lowStock(query) {
  return list(query, { forceLowStock: true });
}

/**
 * PATCH /api/inventory/:id — ADMIN only. Applies a signed physical-stock delta
 * (and an optional low-stock threshold change) atomically, writing a movement
 * and an audit record.
 */
async function adjust(rawId, body, actor) {
  const { id: productId } = validateInput(productIdParamSchema, { id: rawId });
  const input = validateInput(updateInventorySchema, body);
  const { delta, reason } = input;

  let result;
  try {
    result = await withTransaction(async (client) => {
      // Serialize concurrent adjustments of the same SKU.
      const inv = await inventoryRepo.findByProductId(client, productId, { forUpdate: true });
      if (!inv) throw ApiError.notFound('Product not found');

      const nextPhysical = inv.physical_quantity + delta;
      const nextAvailable = inv.available_quantity + delta; // reserved unchanged
      if (nextPhysical < 0 || nextAvailable < 0) {
        throw ApiError.conflict(
          'INSUFFICIENT_STOCK',
          'Adjustment would make stock negative (physical or available)'
        );
      }

      const moved = await inventoryRepo.adjustPhysical(client, productId, delta);
      const movementType = delta > 0 ? 'stock_receipt' : 'manual_adjustment';
      await inventoryRepo.insertMovement(client, {
        productId,
        performedBy: actor.id,
        quantityDelta: delta,
        movementType,
        reason,
      });
      if (input.low_stock_threshold !== undefined) {
        await inventoryRepo.setThreshold(client, productId, input.low_stock_threshold);
      }
      await logAudit(client, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'STOCK_ADJUSTED',
        entityType: 'inventory',
        entityId: productId,
        details: {
          delta,
          movement_type: movementType,
          available_after: moved.available_quantity,
          reason,
        },
      });
      return { movementType, availableAfter: moved.available_quantity };
    });
  } catch (err) {
    // Defence-in-depth: a concurrent write that slips past the pre-check still
    // trips the DB CHECK (23514) and surfaces as the same clean 409.
    if (pgCode(err) === '23514') {
      throw ApiError.conflict(
        'INSUFFICIENT_STOCK',
        'Adjustment would make stock negative (physical or available)'
      );
    }
    throw err;
  }

  const inventory = await inventoryRepo.findByIdJoined(productId);
  return {
    data: inventory,
    movement: {
      quantity_delta: delta,
      movement_type: result.movementType,
      available_after: result.availableAfter,
      reason,
    },
  };
}

module.exports = { list, lowStock, adjust };

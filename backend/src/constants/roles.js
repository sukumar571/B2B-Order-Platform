'use strict';

/**
 * Role vocabulary (docs/database-design.md §2.1).
 * Lowercase values are what the `users.role` CHECK constraint stores;
 * uppercase names are the public/API aliases used in authorization calls.
 *
 * RBAC rule (FR-AUTH-05 / phase requirement): public registration can ONLY
 * produce CUSTOMER. ADMIN and ORDER_MANAGER are provisioned by an admin or
 * the controlled development seed.
 */

const ROLE_VALUES = {
  ADMIN: 'admin',
  ORDER_MANAGER: 'agent',
  CUSTOMER: 'customer',
};

const ROLE_ALIASES = {
  [ROLE_VALUES.ADMIN]: ROLE_VALUES.ADMIN,
  ADMIN: ROLE_VALUES.ADMIN,
  [ROLE_VALUES.ORDER_MANAGER]: ROLE_VALUES.ORDER_MANAGER,
  ORDER_MANAGER: ROLE_VALUES.ORDER_MANAGER,
  AGENT: ROLE_VALUES.ORDER_MANAGER,
  [ROLE_VALUES.CUSTOMER]: ROLE_VALUES.CUSTOMER,
  CUSTOMER: ROLE_VALUES.CUSTOMER,
};

const ROLE_VALUE_SET = new Set(Object.values(ROLE_VALUES));

/** Normalize any accepted role spelling to its canonical DB value. */
function normalizeRole(role) {
  return ROLE_ALIASES[String(role)] || null;
}

module.exports = { ROLE_VALUES, ROLE_ALIASES, ROLE_VALUE_SET, normalizeRole };

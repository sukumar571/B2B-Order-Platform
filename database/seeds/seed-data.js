'use strict';

/**
 * Development seed data for the B2B Order Management Platform.
 * Pure data module — no dependencies. Consumed by
 * backend/scripts/db/seed.js, which inserts it safely (skips when the
 * database already contains data; never overwrites or erases).
 *
 * All accounts share the DEV-ONLY password: Passw0rd!
 * (plaintext shown here for local testing convenience only — real passwords
 * are never stored; the seed script hashes it with bcrypt).
 *
 * ADMIN and ORDER_MANAGER accounts exist ONLY here (or via a future admin
 * process) — public registration can never produce them (FR-AUTH-05).
 */

const DEV_PASSWORD = 'Passw0rd!';

const users = [
  { email: 'admin@b2boms.test', name: 'Asha Admin', role: 'admin' },
  { email: 'agent@b2boms.test', name: 'Ravi Reseller', role: 'agent' },
  { email: 'customer@b2boms.test', name: 'Celes Retail', role: 'customer' },
  // Disabled account for exercising the ACCOUNT_DISABLED login path locally.
  { email: 'disabled@b2boms.test', name: 'Dana Deactivated', role: 'customer', is_active: false },
];

// inventory: { physical, reserved } — available is computed by the DB.
const products = [
  {
    sku: 'WIDGET-01',
    name: 'Industrial Widget 1000',
    description: 'Heavy-duty widget for assembly lines.',
    unit_price: '19.99',
    tax_rate: '7.50',
    is_active: true,
    inventory: { physical: 120, reserved: 0 },
  },
  {
    sku: 'WIDGET-02',
    name: 'Micro Widget Pro',
    description: 'Compact precision widget.',
    unit_price: '4.50',
    tax_rate: '7.50',
    is_active: true,
    inventory: { physical: 500, reserved: 0 },
  },
  {
    sku: 'GADGET-A',
    name: 'Smart Gadget Alpha',
    description: 'Connected gadget with LTE module.',
    unit_price: '129.00',
    tax_rate: '12.00',
    is_active: true,
    inventory: { physical: 40, reserved: 0 },
  },
  {
    sku: 'GADGET-B',
    name: 'Smart Gadget Beta',
    description: 'Cost-effective gadget, Wi-Fi only.',
    unit_price: '79.90',
    tax_rate: '12.00',
    is_active: true,
    inventory: { physical: 15, reserved: 0 },
  },
  {
    sku: 'CABLE-X5',
    name: 'Patch Cable X5 (pack of 10)',
    description: 'Cat6a patch cables, 0.5 m.',
    unit_price: '24.95',
    tax_rate: '0.00',
    is_active: true,
    inventory: { physical: 300, reserved: 0 },
  },
  {
    sku: 'LEGACY-01',
    name: 'Legacy Widget (discontinued)',
    description: 'Kept for order history; not sellable.',
    unit_price: '99.00',
    tax_rate: '7.50',
    is_active: false,
    inventory: { physical: 3, reserved: 0 },
  },
];

module.exports = { DEV_PASSWORD, users, products };

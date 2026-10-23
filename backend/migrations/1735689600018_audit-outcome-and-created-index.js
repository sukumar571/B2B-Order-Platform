'use strict';

/**
 * 18 — Phase 9 audit outcome + recent-events index
 *
 * (a) Adds `audit_logs.outcome` — every audit record now states whether the
 *       described attempt SUCCEEDED or FAILED ('success' | 'failure'). Business
 *       mutations that fail roll their whole transaction back (so no row is
 *       written at all) and are therefore recorded as 'success' on the ones that
 *       did commit; the 'failure' value exists for attempts that are meaningful
 *       WITHOUT a data change — a rejected login or a disabled-account attempt
 *       (FR-AUD-01) — which we record explicitly. NOT NULL DEFAULT 'success' so
 *       every pre-Phase-9 row stays valid without a data backfill.
 *
 * (b) Adds a plain `created_at` index. The existing audit indexes all lead with
 *       entity/actor/action; dashboard "recent activity" and the date-range
 *       filters ORDER BY / range-scan on created_at alone, so this index backs
 *       them (and the ADMIN `GET /api/audit-logs` default newest-first listing).
 *
 * Fully reversible: the down script drops just the index and the column. The
 * append-only BEFORE UPDATE trigger does not fire for ADD COLUMN (DDL backfills
 * via the column default, not a row UPDATE), so this migration is safe to apply
 * on a table whose rows are already write-protected.
 */
exports.up = (pgm) => {
  pgm.addColumn('audit_logs', {
    outcome: { type: 'varchar(16)', notNull: true, default: pgm.func("'success'") },
  });
  pgm.addConstraint('audit_logs', 'audit_outcome_valid', {
    check: `outcome IN ('success', 'failure')`,
  });

  pgm.createIndex('audit_logs', 'created_at', { name: 'audit_created_idx' });
};

exports.down = (pgm) => {
  pgm.dropIndex('audit_logs', 'created_at', { ifExists: true, name: 'audit_created_idx' });
  pgm.dropConstraint('audit_logs', 'audit_outcome_valid', { ifExists: true });
  pgm.dropColumn('audit_logs', 'outcome', { ifExists: true });
};

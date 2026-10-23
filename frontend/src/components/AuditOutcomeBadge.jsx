import { outcomeLabel } from '../constants/auditStatus.js';

/**
 * A coloured pill for an audit outcome. Colour is presentational only — the
 * authoritative success/failure value always comes from the API row. 'failure'
 * is reserved for security-relevant attempts that carry no data change (a
 * rejected login), never for a rolled-back business write.
 */
export default function AuditOutcomeBadge({ outcome }) {
  return (
    <span className={`badge badge--audit badge--audit-${outcome}`}>{outcomeLabel(outcome)}</span>
  );
}

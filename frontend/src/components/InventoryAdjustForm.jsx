import { useState } from 'react';
import { FormProblem } from './States.jsx';

/**
 * Stock adjustment form (signed delta + reason, optional threshold change).
 * Posting to /api/inventory/:id is transactional + audited on the backend.
 */
export default function InventoryAdjustForm({ productLabel, onSubmit, onCancel }) {
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [threshold, setThreshold] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const body = { delta: Number(delta), reason: reason.trim() };
    if (threshold !== '') body.low_stock_threshold = Number(threshold);
    try {
      await onSubmit(body);
      setDelta('');
      setReason('');
      setThreshold('');
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="form" onSubmit={handleSubmit} aria-label="stock adjustment form">
      {productLabel ? <p className="form__context">{productLabel}</p> : null}
      <div className="form__row">
        <label>
          Quantity change (+/-)
          <input
            name="delta"
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
            inputMode="numeric"
            placeholder="e.g. -20 or 50"
            required
          />
        </label>
        <label>
          New low-stock threshold (optional)
          <input
            name="threshold"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            inputMode="numeric"
          />
        </label>
      </div>
      <label>
        Reason
        <input
          name="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          maxLength={300}
        />
      </label>

      <FormProblem error={error} />

      <div className="form__actions">
        <button type="submit" className="btn" disabled={saving}>
          {saving ? 'Applying…' : 'Apply adjustment'}
        </button>
        {onCancel ? (
          <button type="button" className="btn btn--secondary" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

import { useState } from 'react';
import { FormProblem } from './States.jsx';

const EMPTY = {
  sku: '',
  name: '',
  description: '',
  unit_price: '',
  tax_rate: '0',
  initial_stock: '0',
  low_stock_threshold: '20',
  is_active: true,
};

/**
 * Add / edit product form. Controlled fields, submit → onSubmit(body) which
 * performs the API call and may throw a backend VALIDATION_ERROR (its field
 * details are surfaced). No hardcoded product data — this only POSTs/PATCHes.
 */
export default function ProductForm({ mode = 'create', initial, onSubmit, onCancel }) {
  const [values, setValues] = useState(initial ? { ...EMPTY, ...initial } : EMPTY);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  function set(field) {
    return (e) => {
      const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      setValues((prev) => ({ ...prev, [field]: v }));
    };
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const body = {
      sku: values.sku.trim(),
      name: values.name.trim(),
      description: values.description,
      unit_price: values.unit_price,
      tax_rate: values.tax_rate,
      is_active: Boolean(values.is_active),
    };
    if (mode === 'create') {
      body.initial_stock = Number(values.initial_stock) || 0;
      body.low_stock_threshold = Number(values.low_stock_threshold) || 0;
    } else if (values.low_stock_threshold !== undefined && values.low_stock_threshold !== '') {
      body.low_stock_threshold = Number(values.low_stock_threshold);
    }
    try {
      await onSubmit(body);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="form" onSubmit={handleSubmit} aria-label={`${mode} product form`}>
      <div className="form__row">
        <label>
          SKU
          <input name="sku" value={values.sku} onChange={set('sku')} required maxLength={50} />
        </label>
        <label>
          Name
          <input name="name" value={values.name} onChange={set('name')} required maxLength={160} />
        </label>
      </div>
      <label>
        Description
        <textarea
          name="description"
          value={values.description}
          onChange={set('description')}
          rows={3}
        />
      </label>
      <div className="form__row">
        <label>
          Unit price
          <input
            name="unit_price"
            value={values.unit_price}
            onChange={set('unit_price')}
            inputMode="decimal"
            required
          />
        </label>
        <label>
          Tax rate (%)
          <input
            name="tax_rate"
            value={values.tax_rate}
            onChange={set('tax_rate')}
            inputMode="decimal"
          />
        </label>
        {mode === 'create' ? (
          <label>
            Initial stock
            <input
              name="initial_stock"
              value={values.initial_stock}
              onChange={set('initial_stock')}
              inputMode="numeric"
            />
          </label>
        ) : null}
        <label>
          Low-stock threshold
          <input
            name="low_stock_threshold"
            value={values.low_stock_threshold}
            onChange={set('low_stock_threshold')}
            inputMode="numeric"
          />
        </label>
      </div>
      <label className="form__check">
        <input
          type="checkbox"
          name="is_active"
          checked={values.is_active}
          onChange={set('is_active')}
        />
        Active (visible in the catalog)
      </label>

      <FormProblem error={error} />

      <div className="form__actions">
        <button type="submit" className="btn" disabled={saving}>
          {saving ? 'Saving…' : mode === 'create' ? 'Create product' : 'Save changes'}
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

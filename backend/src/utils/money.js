'use strict';

/**
 * Money helpers (docs/decision-log.md D-09).
 *
 * All monetary values arrive from PostgreSQL as `NUMERIC` → JS strings
 * ("19.99"). We NEVER do float arithmetic on money. Every computation goes
 * through integer cents: parse the fixed 2-decimal string to cents, multiply by
 * an integer quantity, and round tax per line HALF-UP. BigInt is used for the
 * line/percent product so very large catalog prices × max quantity stay exact
 * (well beyond Number's 2^53 safe-integer window). Formatted back with
 * `fromCents()` — a plain 2-decimal string.
 *
 * `unit_price` NUMERIC(12,2) and `tax_rate` NUMERIC(5,2) are both produced by
 * pg as decimal strings; Zod already guarantees the 2-decimal shape on input.
 */

// Strict money string: non-negative, up to 2 decimals, e.g. "19.99" / "20" / "0.5".
const MONEY_RE = /^\d+(\.\d{1,2})?$/;

/** Parse a 2-decimal money string into integer cents. Throws on bad input. */
function toCents(value) {
  const s = String(value).trim();
  if (!MONEY_RE.test(s)) {
    throw new Error(`Invalid money value: "${value}"`);
  }
  const [whole, frac = ''] = s.split('.');
  const cents = (frac + '00').slice(0, 2);
  return Number(whole) * 100 + Number(cents);
}

/** Format integer cents back into a 2-decimal money string. */
function fromCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}${whole}.${frac}`;
}

/**
 * Round a BigInt quotient half-up (values here are always >= 0).
 * taxCents = roundHalfUpCents(value, divisor) where value/divisor is the exact
 * pre-rounded amount scaled by 100 already applied by the caller.
 */
function roundHalfUp(numerator, denominator) {
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  if (d <= 0n) throw new Error('denominator must be positive');
  // floor((n*2 + d) / (2d)) is exact half-up for non-negative n.
  return (n * 2n + d) / (2n * d);
}

/**
 * Compute one cart line from a live unit price, tax rate (percent) and an
 * integer quantity. Returns money strings plus the raw cent figures.
 *
 *   line_total (pre-tax)  = unit_price_cents * quantity
 *   line_tax   (half-up)  = round(line_total_cents * tax_rate_percent / 100)
 *
 * tax_rate "7.50" → 750 hundredths-of-a-percent, so:
 *   line_tax_cents = round(line_total_cents * 750 / 10000)
 * which matches the AC-CART-02 fixture (19.99 × 3 @ 7.5% → 59.97 / 4.50).
 */
function computeLine({ unit_price, tax_rate, quantity }) {
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1) {
    throw new Error(`Invalid quantity: ${quantity}`);
  }
  const unitCents = toCents(unit_price);
  const lineTotalCents = unitCents * qty;

  const rateStr = String(tax_rate).trim();
  if (!MONEY_RE.test(rateStr)) {
    throw new Error(`Invalid tax_rate: "${tax_rate}"`);
  }
  // tax_rate as hundredths of a percent (NUMERIC(5,2)): "7.50" → 750.
  const rateHundredths = toCents(rateStr);
  // line_tax_cents = half-up(lineTotalCents * rateHundredths / 10000). The
  // product is formed in BigInt: price ceiling × max qty × max rate exceeds
  // Number's 2^53 safe-integer window, so float would silently lose precision.
  const lineTaxCents = Number(roundHalfUp(BigInt(lineTotalCents) * BigInt(rateHundredths), 10000));

  return {
    unit_price: fromCents(unitCents),
    quantity: qty,
    line_total: fromCents(lineTotalCents),
    line_tax: fromCents(lineTaxCents),
    _lineTotalCents: lineTotalCents,
    _lineTaxCents: lineTaxCents,
  };
}

/**
 * Aggregate already-computed lines into cart totals. The invariant
 * grand_total = subtotal + tax_total holds to the cent because every figure is
 * an integer cent sum (D-09). Strips the internal cent fields from each line.
 */
function summarize(lines) {
  let subtotalCents = 0;
  let taxCents = 0;
  const clean = lines.map((line) => {
    subtotalCents += line._lineTotalCents;
    taxCents += line._lineTaxCents;
    const { _lineTotalCents, _lineTaxCents, ...rest } = line;
    void _lineTotalCents;
    void _lineTaxCents;
    return rest;
  });
  return {
    lines: clean,
    subtotal: fromCents(subtotalCents),
    tax_total: fromCents(taxCents),
    grand_total: fromCents(subtotalCents + taxCents),
  };
}

module.exports = { toCents, fromCents, computeLine, summarize };

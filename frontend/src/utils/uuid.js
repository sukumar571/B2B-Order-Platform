/**
 * Idempotency-key generator (Phase 7 / FR-ORD-06).
 *
 * Every POST /api/orders carries a client-generated, single-use UUID so a
 * double-click or a network retry replays the same order instead of creating a
 * second one. Modern browsers expose crypto.randomUUID(); jsdom (tests) and some
 * older engines may not, so fall back to an RFC-4122 v4 built from Math.random —
 * uniqueness of the key is what matters, not its entropy here.
 */
export function newIdempotencyKey() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += '-';
    } else if (i === 14) {
      out += '4';
    } else {
      const r = Math.floor(Math.random() * 16);
      // variant nibble (13th group) must be 8|9|a|b
      out += i === 19 ? hex[(r & 0x3) | 0x8] : hex[r];
    }
  }
  return out;
}

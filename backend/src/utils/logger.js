'use strict';

/**
 * Safe, minimal logger.
 * Never logs bodies for sensitive routes and never emits secret values
 * (requirements.md FR-AUD-05, NFR-01; risk-register R-06).
 * Structured, single-line JSON so later phases can swap in a real logger.
 */

// `cookie` is included for Phase 4: auth headers/cookies and every
// token/password/secret-shaped key are redacted (R-06, FR-AUD-05).
const SECRET_KEY_PATTERN =
  /(password|pass|token|secret|authorization|auth|jwt|otp|cvv|cookie|email)/i;

/** Recursively redact any key that looks like a secret. */
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

function write(level, message, meta) {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    message,
    ...(meta ? { meta: redact(meta) } : {}),
  });
  // no-console is disabled project-wide; the logger intentionally writes to stdout.
  console.log(line);
}

module.exports = {
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
  redact,
  // Exposed for unit testing.
  _SECRET_KEY_PATTERN: SECRET_KEY_PATTERN,
};

'use strict';
// Constant-time comparison for shared secrets in headers (Low, CWE-208).
// Both sides are hashed first so their lengths never leak either.
const crypto = require('crypto');

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

module.exports = { safeEqual };
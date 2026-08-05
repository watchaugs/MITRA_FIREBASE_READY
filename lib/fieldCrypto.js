'use strict';
/**
 * lib/fieldCrypto.js — Application-level field encryption for sensitive PII.
 *
 * Firestore encrypts data at rest on Google's side, but that protects against
 * stolen disks — NOT against someone who gains read access to the database
 * (leaked service-account key, insider, mis-set rule). For sensitive personal
 * data (esp. minors' data under the DPDP Act), encrypt the field VALUE before
 * it is written, so the stored value is meaningless without the app key.
 *
 * Algorithm: AES-256-GCM (authenticated encryption — tamper-evident).
 * Key: 32 bytes, supplied as base64 in env var FIELD_ENCRYPTION_KEY.
 *   Generate one with:
 *     node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Stored format (string):  v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 * Encrypted values are prefixed "v1:" so you can tell encrypted from plaintext
 * and migrate gradually.
 */

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const PREFIX = 'v1:';

function getKey() {
  const b64 = process.env.FIELD_ENCRYPTION_KEY;
  if (!b64) throw new Error('FIELD_ENCRYPTION_KEY not set');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY must be 32 bytes (base64)');
  return key;
}

/** Encrypt a string. Returns the "v1:..." envelope. Non-strings are JSON-stringified. */
function encrypt(plain) {
  if (plain == null) return plain;
  const text = typeof plain === 'string' ? plain : JSON.stringify(plain);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString('base64') + ':' + tag.toString('base64') + ':' + ct.toString('base64');
}

/** True if a value looks like one of our encrypted envelopes. */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Decrypt a "v1:..." envelope. If the value isn't encrypted, returns it unchanged. */
function decrypt(value) {
  if (!isEncrypted(value)) return value;
  const [, ivB64, tagB64, ctB64] = value.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/** Encrypt named fields on an object (returns a shallow copy). */
function encryptFields(obj, fields) {
  if (!obj) return obj;
  const out = { ...obj };
  for (const f of fields) if (out[f] != null && !isEncrypted(out[f])) out[f] = encrypt(out[f]);
  return out;
}

/** Decrypt named fields on an object (returns a shallow copy). */
function decryptFields(obj, fields) {
  if (!obj) return obj;
  const out = { ...obj };
  for (const f of fields) if (isEncrypted(out[f])) out[f] = decrypt(out[f]);
  return out;
}

module.exports = { encrypt, decrypt, isEncrypted, encryptFields, decryptFields };
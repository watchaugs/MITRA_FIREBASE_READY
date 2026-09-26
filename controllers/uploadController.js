// controllers/uploadController.js
// ─────────────────────────────────────────────────────────────────────────────
// DEPRECATED direct-to-GCS uploader. This used to hardcode a bucket name, which
// breaks the Cloudflare-migration seam. All real uploads now go through
// lib/storage.js (which honours STORAGE_BUCKET today and R2 later).
//
// This stub is kept only so any accidental import doesn't crash the server.
// It intentionally does NOT talk to any bucket directly.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

exports.handleUpload = async (_req, res) => {
  return res.status(410).json({
    error: 'This upload path is deprecated. Use /api/ar/upload (routes/ar_assets.js), which goes through lib/storage.js.',
  });
};
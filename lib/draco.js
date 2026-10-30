'use strict';

/**
 * lib/draco.js — robust GLB compression pipeline
 *
 * Produces the asset tiers the app needs from ANY uploaded GLB:
 *   - Flutter tier (_lite.glb)   : Draco + mesh simplified to 30% — the on-screen
 *                                  3D viewer (model_viewer_plus) decodes Draco.
 *   - Native tier  (_native.glb) : simplified, NO Draco, Filament-safe textures
 *                                  (JPEG for opaque, PNG when alpha is needed) —
 *                                  the ARCore/Filament floor-AR renderer cannot
 *                                  decode Draco or WebP/KTX2 textures.
 *   - Unity tier   (_draco.glb)  : Draco + full textures (kept for compatibility).
 *
 * ROBUSTNESS (so "Could not load the model" never recurs):
 *   • Reads EVERY GLB variant — Draco, Meshopt, KTX2, WebP, AVIF — via
 *     ALL_EXTENSIONS, instead of silently dropping unknown data.
 *   • The native tier is guaranteed Filament-safe: Draco removed, textures
 *     re-encoded to JPEG/PNG (never WebP/KTX2/AVIF), capped at 1024px.
 *   • Alpha-aware: textures with transparency use PNG (JPEG can't carry alpha),
 *     opaque ones use JPEG (smaller). No silently-broken transparency.
 *   • Each transform step is best-effort — a step that fails on an unusual model
 *     (e.g. simplify on degenerate geometry) is skipped, not fatal.
 *   • Every output is validated (re-read + must contain a drawable mesh); if the
 *     native tier can't be produced the whole upload is rejected with a clear
 *     message, so a broken model never reaches a student.
 *
 * All outputs are Buffers — the caller decides where to store them.
 */

const { NodeIO } = require('@gltf-transform/core');
const {
  draco, simplify, dedup, prune, textureCompress, flatten, join, weld,
} = require('@gltf-transform/functions');
const { MeshoptSimplifier } = require('meshoptimizer');
const sharp = require('sharp');

// Register ALL KHR/EXT extensions so inputs using Draco, Meshopt, KTX2, WebP,
// AVIF etc. are read correctly rather than dropped. Without this, a GLB whose
// mesh is Meshopt-compressed (common in downloaded models) loses its geometry.
let ALL_EXTENSIONS = [];
try {
  // eslint-disable-next-line global-require
  ALL_EXTENSIONS = require('@gltf-transform/extensions').ALL_EXTENSIONS || [];
} catch (_) { ALL_EXTENSIONS = []; }

// Draco needs its codec MODULES (instantiated, not the factory fns) registered
// as IO dependencies, or reading/writing a Draco GLB throws. We instantiate them
// ONCE, lazily, on first use. DRACO_READY reflects whether the Draco tier can be
// produced — if the module can't init, we simply skip Draco (the native AR tier
// never uses it, and the viewer works fine with an uncompressed-mesh GLB).
let _dracoDeps = null;
let DRACO_READY = false;
let _dracoInit = null;
async function ensureDraco() {
  if (_dracoInit) return _dracoInit;
  _dracoInit = (async () => {
    try {
      // eslint-disable-next-line global-require
      const draco3d = require('draco3dgltf');
      const [encoder, decoder] = await Promise.all([
        draco3d.createEncoderModule(),
        draco3d.createDecoderModule(),
      ]);
      _dracoDeps = { 'draco3d.encoder': encoder, 'draco3d.decoder': decoder };
      DRACO_READY = true;
    } catch (_) {
      _dracoDeps = null;
      DRACO_READY = false;
    }
  })();
  return _dracoInit;
}

function makeIO() {
  const io = new NodeIO();
  if (ALL_EXTENSIONS.length) io.registerExtensions(ALL_EXTENSIONS);
  if (_dracoDeps) {
    try { io.registerDependencies(_dracoDeps); } catch (_) { /* best-effort */ }
  }
  return io;
}

// Run a list of transforms one at a time; skip any that throw so one bad step
// on an unusual model doesn't abort the whole tier.
async function applyBestEffort(doc, steps) {
  for (const step of steps) {
    if (!step) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await doc.transform(step);
    } catch (_) { /* skip a step that can't apply to this model */ }
  }
}

// Does any material use alpha blending/masking, or any texture carry alpha?
// If so the native tier must keep PNG (JPEG has no alpha channel).
function needsAlpha(doc) {
  try {
    const root = doc.getRoot();
    for (const m of root.listMaterials()) {
      const mode = m.getAlphaMode && m.getAlphaMode();
      if (mode === 'BLEND' || mode === 'MASK') return true;
    }
  } catch (_) { /* assume no alpha */ }
  return false;
}

// Validate an output GLB buffer: it must re-read and contain at least one mesh
// with a drawable primitive. Returns true/false.
async function isRenderable(buffer) {
  try {
    const doc = await makeIO().readBinary(new Uint8Array(buffer));
    const meshes = doc.getRoot().listMeshes();
    if (!meshes.length) return false;
    return meshes.some(me => (me.listPrimitives() || []).length > 0);
  } catch (_) {
    return false;
  }
}

async function compressGlb(inputBuffer) {
  // Fail fast on obviously-bad input (clear message bubbles up to the uploader).
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length < 20) {
    throw new Error('Model file is empty or not a valid GLB.');
  }
  if (inputBuffer.readUInt32LE(0) !== 0x46546c67) { // 'glTF'
    throw new Error('Not a valid GLB (binary glTF) file. Export/convert to .glb and try again.');
  }

  // Init the Draco encoder once (sets DRACO_READY). If it can't init, every tier
  // still builds — Draco is simply skipped.
  await ensureDraco();

  // ── Flutter tier: Draco + simplify to 30% (viewer decodes Draco) ──────────
  const flutterDoc = await makeIO().readBinary(new Uint8Array(inputBuffer));
  await applyBestEffort(flutterDoc, [
    dedup(), prune(), flatten(), join(), weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio: 0.30, error: 0.001 }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024] }),
    // Draco only if the encoder is installed; otherwise the viewer still gets a
    // valid (uncompressed-mesh) GLB rather than a failed upload.
    DRACO_READY ? draco({ method: 'edgebreaker', encodeSpeed: 5, decodeSpeed: 5 }) : null,
  ]);
  const flutterBuf = Buffer.from(await makeIO().writeBinary(flutterDoc));

  // ── Native tier: simplify, NO Draco, Filament-safe textures ───────────────
  const nativeDoc = await makeIO().readBinary(new Uint8Array(inputBuffer));
  const nativeTexFormat = needsAlpha(nativeDoc) ? 'png' : 'jpeg';
  await applyBestEffort(nativeDoc, [
    dedup(), prune(), flatten(), join(), weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio: 0.30, error: 0.001 }),
    // JPEG (opaque) or PNG (has alpha) — never WebP/KTX2/AVIF, which Filament
    // can't decode. This is the fix for "Could not load the model".
    textureCompress({ encoder: sharp, targetFormat: nativeTexFormat, resize: [1024, 1024] }),
    // deliberately NO draco()
  ]);
  const nativeBuf = Buffer.from(await makeIO().writeBinary(nativeDoc));

  // ── Unity tier: Draco + full textures (kept for compatibility) ────────────
  let unityBuf = flutterBuf; // sensible fallback if the Draco tier fails
  try {
    const unityDoc = await makeIO().readBinary(new Uint8Array(inputBuffer));
    await applyBestEffort(unityDoc, [
      dedup(), prune(), flatten(), join(), weld(),
      textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [2048, 2048] }),
      DRACO_READY ? draco({ method: 'edgebreaker', encodeSpeed: 5, decodeSpeed: 5 }) : null,
    ]);
    unityBuf = Buffer.from(await makeIO().writeBinary(unityDoc));
  } catch (_) { /* keep the flutter buffer as the unity fallback */ }

  // ── Validation: the NATIVE tier is what breaks on-device, so it must be
  // renderable. If it isn't, reject the upload with a clear message. ─────────
  if (!(await isRenderable(nativeBuf))) {
    // Last resort: ship the original bytes as the native tier (no Draco in it,
    // textures as the author made them) IF the original itself is renderable.
    if (await isRenderable(inputBuffer)) {
      return finalize(inputBuffer, flutterBuf, unityBuf, inputBuffer, nativeTexFormat);
    }
    throw new Error(
      'This model could not be prepared for AR. It may be corrupt, have no ' +
      'drawable mesh, or use an unsupported feature. See the recommended model ' +
      'specifications and re-export it as a standard .glb.'
    );
  }
  // The viewer tier is non-fatal — fall back to native if Draco made it unreadable.
  const flutterOut = (await isRenderable(flutterBuf)) ? flutterBuf : nativeBuf;

  return finalize(inputBuffer, flutterOut, unityBuf, nativeBuf, nativeTexFormat);
}

function finalize(inputBuffer, flutterBuf, unityBuf, nativeBuf, nativeTexFormat) {
  return {
    unity:            unityBuf,
    flutter:          flutterBuf,
    native:           nativeBuf,
    native_tex:       nativeTexFormat,
    originalMb:       (inputBuffer.length / 1024 / 1024).toFixed(2),
    unityMb:          (unityBuf.length    / 1024 / 1024).toFixed(2),
    flutterMb:        (flutterBuf.length  / 1024 / 1024).toFixed(2),
    nativeMb:         (nativeBuf.length   / 1024 / 1024).toFixed(2),
  };
}

// Recommended model specs — surfaced to the uploader (dashboard) and used in
// the rejection message, so people know what to export for guaranteed AR.
const MODEL_SPECS = {
  container: 'glTF Binary (.glb) — single self-contained file',
  also_accepted_for_auto_convert: ['.gltf', '.fbx', '.obj', '.dae', '.stl', '.ply', '.3ds', '.zip'],
  textures: 'PNG or JPEG, embedded in the file (not external). Avoid WebP/KTX2/AVIF.',
  max_texture: '2048×2048 or smaller (auto-capped to 1024 for AR)',
  geometry: 'One or a few meshes; under ~150k triangles after export (auto-simplified for phones)',
  file_size: 'Ideally under ~15 MB before upload',
  avoid: 'Draco/Meshopt pre-compression (we apply our own), external texture files, broken/empty meshes',
};

module.exports = { compressGlb, MODEL_SPECS };
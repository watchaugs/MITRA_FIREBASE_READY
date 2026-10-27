'use strict';

/**
 * lib/draco.js — GLB compression pipeline
 *
 * Produces THREE asset tiers from a single uploaded GLB:
 *   - Unity tier   (_draco.glb)  : Draco-compressed mesh, full textures
 *   - Flutter tier (_lite.glb)   : Draco-compressed + mesh simplified to 30%
 *                                  (served to the on-screen 3D viewer, which
 *                                   decodes Draco)
 *   - Native tier  (_native.glb) : SAME simplification but NO Draco, so the
 *                                   native ARCore/Filament renderer (which does
 *                                   not decode Draco) can load it directly.
 *
 * All outputs stay as Buffers — caller decides where to store them.
 */

const { NodeIO }     = require('@gltf-transform/core');
const { draco, simplify, dedup, prune, textureCompress, flatten, join, weld } = require('@gltf-transform/functions');
const { MeshoptSimplifier } = require('meshoptimizer');
const sharp = require('sharp'); // encoder backend for texture compression

/**
 * @param {Buffer} inputBuffer  — raw bytes of the uploaded .glb
 * @returns {Promise<{ unity: Buffer, flutter: Buffer, originalMb: string, unityMb: string, flutterMb: string }>}
 */
async function compressGlb(inputBuffer) {
  const io = new NodeIO();

  // ── Unity tier: Draco only ────────────────────────────────────────────────
  const unityDoc = await io.readBinary(new Uint8Array(inputBuffer));
  await unityDoc.transform(
    dedup(),
    prune(),
    // ── Draw-call reduction (the budget-phone win) ──────────────────────────
    // Education models (e.g. a 300-part monument) arrive as hundreds of separate
    // meshes/materials → hundreds of draw calls that stall budget-phone GPUs.
    // flatten() collapses the node hierarchy, join() merges meshes that share a
    // material, weld() fuses duplicate vertices. Result: a handful of draw calls.
    flatten(),
    join(),
    weld(),
    // Compress textures to WebP, cap at 2048px. Usually a bigger size win than
    // mesh compression for education models.
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [2048, 2048] }),
    draco({ method: 'edgebreaker', encodeSpeed: 5, decodeSpeed: 5 })
  );
  const unityBuf = Buffer.from(await io.writeBinary(unityDoc));

  // ── Flutter tier: Draco + mesh simplification to 30% ─────────────────────
  const flutterDoc = await io.readBinary(new Uint8Array(inputBuffer));
  await flutterDoc.transform(
    dedup(),
    prune(),
    // Merge the fractured sub-meshes BEFORE simplifying, so simplify works on a
    // joined surface and the lite model renders in a few draw calls on 2GB phones.
    flatten(),
    join(),
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio: 0.30, error: 0.001 }),
    // Lite tier: smaller texture cap (1024px) since it targets low-end phones.
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024] }),
    draco({ method: 'edgebreaker', encodeSpeed: 5, decodeSpeed: 5 })
  );
  const flutterBuf = Buffer.from(await io.writeBinary(flutterDoc));

  // ── Native tier: same draw-call + simplify pipeline, but NO Draco ─────────
  // Native ar_flutter_plugin_2 / Filament cannot decode Draco, so the floor-AR
  // path needs an uncompressed-mesh GLB. Textures are still WebP-capped so it
  // stays reasonably small; only the Draco mesh codec is omitted.
  const nativeDoc = await io.readBinary(new Uint8Array(inputBuffer));
  await nativeDoc.transform(
    dedup(),
    prune(),
    flatten(),
    join(),
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio: 0.30, error: 0.001 }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024] })
    // deliberately NO draco()
  );
  const nativeBuf = Buffer.from(await io.writeBinary(nativeDoc));

  return {
    unity:      unityBuf,
    flutter:    flutterBuf,
    native:     nativeBuf,
    originalMb: (inputBuffer.length   / 1024 / 1024).toFixed(2),
    unityMb:    (unityBuf.length      / 1024 / 1024).toFixed(2),
    flutterMb:  (flutterBuf.length    / 1024 / 1024).toFixed(2),
    nativeMb:   (nativeBuf.length     / 1024 / 1024).toFixed(2),
  };
}

module.exports = { compressGlb };
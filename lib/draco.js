'use strict';

/**
 * lib/draco.js — GLB compression pipeline
 *
 * Produces two asset tiers from a single uploaded GLB:
 *   - Unity tier  (_draco.glb)  : Draco-compressed mesh, full textures
 *   - Flutter tier (_lite.glb)  : Draco-compressed + mesh simplified to 30%
 *
 * Both outputs stay as Buffers — caller decides where to store them.
 */

const { NodeIO }     = require('@gltf-transform/core');
const { draco, simplify, dedup, prune, textureCompress } = require('@gltf-transform/functions');
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
    simplify({ simplifier: MeshoptSimplifier, ratio: 0.30, error: 0.001 }),
    // Lite tier: smaller texture cap (1024px) since it targets low-end phones.
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024] }),
    draco({ method: 'edgebreaker', encodeSpeed: 5, decodeSpeed: 5 })
  );
  const flutterBuf = Buffer.from(await io.writeBinary(flutterDoc));

  return {
    unity:      unityBuf,
    flutter:    flutterBuf,
    originalMb: (inputBuffer.length   / 1024 / 1024).toFixed(2),
    unityMb:    (unityBuf.length      / 1024 / 1024).toFixed(2),
    flutterMb:  (flutterBuf.length    / 1024 / 1024).toFixed(2),
  };
}

module.exports = { compressGlb };
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
const { draco, simplify, dedup, prune } = require('@gltf-transform/functions');
const { MeshoptSimplifier } = require('meshoptimizer');

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
    draco({ method: 'edgebreaker', encodeSpeed: 5, decodeSpeed: 5 })
  );
  const unityBuf = Buffer.from(await io.writeBinary(unityDoc));

  // ── Flutter tier: Draco + mesh simplification to 30% ─────────────────────
  const flutterDoc = await io.readBinary(new Uint8Array(inputBuffer));
  await flutterDoc.transform(
    dedup(),
    prune(),
    simplify({ simplifier: MeshoptSimplifier, ratio: 0.30, error: 0.001 }),
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
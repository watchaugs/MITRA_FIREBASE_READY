// ═══════════════════════════════════════════════════════════════════════════
// lib/modelConvert.js — hardened server-side 3D model → GLB conversion
//
// Accepts artist formats (FBX / OBJ / DAE / STL / PLY / 3DS) and textured
// bundles (.zip of model + textures), converts them to a single .glb in memory
// using assimpjs (a WASM build of Assimp — no native binaries, distroless-safe),
// and hands the GLB back to the existing Draco pipeline.
//
// Exports:
//   needsConversion(ext)         → bool   (true for anything that isn't glb/gltf)
//   toGlb(buffer, originalName)  → Buffer (a .glb)
//
// SECURITY MODEL (why each guard exists):
//   • assimpjs runs in a WASM sandbox — no filesystem, no network, no native
//     code execution. A malicious model cannot escape it; the worst it can do is
//     burn CPU/RAM, which the limits below bound.
//   • Zip handling is the real attack surface (zip bombs, path traversal,
//     thousands of entries). We never write to disk — entries are read into
//     memory with hard caps on count, per-entry size, and total inflated size.
//   • Every input is size-checked BEFORE it reaches the WASM heap, so a crafted
//     file cannot OOM the Cloud Run instance.
//   • No entry name from the archive is ever used as a filesystem path.
//   • assimpjs is loaded once and reused; a conversion is wrapped in a timeout
//     so a pathological file cannot hang the request forever.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const path = require('path');

// ── Hard limits (tune via env; all have safe defaults) ──────────────────────
// Multer already caps the HTTP upload at 500 MB; these bound what we actually
// decompress / feed to WASM, which is where the real DoS risk lives.
const MAX_INPUT_BYTES      = intEnv('MODEL_MAX_INPUT_BYTES',      250 * 1024 * 1024); // 250 MB single model
const MAX_ZIP_ENTRIES      = intEnv('MODEL_MAX_ZIP_ENTRIES',      512);               // entry-count cap
const MAX_ZIP_ENTRY_BYTES  = intEnv('MODEL_MAX_ZIP_ENTRY_BYTES',  200 * 1024 * 1024); // per-file inflated cap
const MAX_ZIP_TOTAL_BYTES  = intEnv('MODEL_MAX_ZIP_TOTAL_BYTES',  400 * 1024 * 1024); // total inflated cap (zip-bomb guard)
const MAX_ZIP_RATIO        = intEnv('MODEL_MAX_ZIP_RATIO',        200);               // inflated/compressed ratio guard
const CONVERT_TIMEOUT_MS   = intEnv('MODEL_CONVERT_TIMEOUT_MS',   60 * 1000);         // per-conversion wall-clock cap

// Formats assimpjs can read and we allow. Anything else is rejected outright —
// an allow-list, never a deny-list.
const CONVERTIBLE_EXTS = new Set(['.fbx', '.obj', '.dae', '.stl', '.ply', '.3ds']);
// Already-GLB formats skip conversion entirely.
const PASSTHROUGH_EXTS = new Set(['.glb', '.gltf']);
// A bundle that may contain one convertible model plus its textures.
const ARCHIVE_EXTS     = new Set(['.zip']);

// Texture/aux extensions allowed to ride along inside a .zip. Everything else in
// the archive is ignored (not written, not fed to Assimp) — so an archive cannot
// smuggle an executable, a symlink, or a traversal payload into the pipeline.
const ALLOWED_AUX_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.bmp', '.tga', '.gif', '.webp', '.tif', '.tiff',
  '.mtl', '.bin',
]);

// ── Lazy, single-instance assimpjs loader ───────────────────────────────────
let _ajsPromise = null;
function loadAssimp() {
  if (!_ajsPromise) {
    // Required lazily so the module (and the whole route file) still loads even
    // if the optional dep isn't installed yet; the error surfaces only on use.
    const assimpjs = require('assimpjs');
    _ajsPromise = assimpjs().catch((err) => {
      _ajsPromise = null; // allow a later retry
      throw err;
    });
  }
  return _ajsPromise;
}

// ── Public: does this extension need converting? ────────────────────────────
function needsConversion(ext) {
  const e = normExt(ext);
  if (PASSTHROUGH_EXTS.has(e)) return false;
  return CONVERTIBLE_EXTS.has(e) || ARCHIVE_EXTS.has(e);
}

// ── Public: convert any supported input to a GLB Buffer ─────────────────────
async function toGlb(buffer, originalName) {
  if (!Buffer.isBuffer(buffer)) {
    throw new ConvertError('Internal: expected a Buffer');
  }
  if (buffer.length === 0) {
    throw new ConvertError('Empty file');
  }
  if (buffer.length > MAX_INPUT_BYTES) {
    throw new ConvertError(
      `File too large to convert (${mb(buffer.length)} MB > ${mb(MAX_INPUT_BYTES)} MB limit)`
    );
  }

  const ext = normExt(path.extname(String(originalName || '')));

  if (PASSTHROUGH_EXTS.has(ext)) {
    // Caller shouldn't route glb/gltf here, but be safe: return as-is.
    return buffer;
  }

  let fileList; // [{ name, data }] fed to assimpjs — names are synthetic/sanitised
  if (ARCHIVE_EXTS.has(ext)) {
    fileList = extractArchive(buffer);
  } else if (CONVERTIBLE_EXTS.has(ext)) {
    // Single model file. Give Assimp a clean, fixed name (never the user's).
    fileList = [{ name: `model${ext}`, data: buffer }];
  } else {
    throw new ConvertError(`Unsupported model format: ${ext || '(none)'}`);
  }

  if (fileList.length === 0) {
    throw new ConvertError('No convertible model found in the upload');
  }

  return withTimeout(runAssimp(fileList), CONVERT_TIMEOUT_MS, 'Model conversion timed out');
}

// ── assimpjs invocation (WASM sandbox) ──────────────────────────────────────
async function runAssimp(fileList) {
  const ajs = await loadAssimp();

  const list = new ajs.FileList();
  for (const f of fileList) {
    // data must be a Uint8Array view; never pass user text as a path.
    list.AddFile(f.name, new Uint8Array(f.data));
  }

  // 'glb2' = binary glTF 2.0. assimpjs picks the primary model by extension.
  const result = ajs.ConvertFileList(list, 'glb2');

  if (!result.IsSuccess()) {
    const detail = safeStr(result.GetErrorCode && result.GetErrorCode());
    throw new ConvertError(`Assimp could not parse the model${detail ? `: ${detail}` : ''}`);
  }
  if (result.FileCount() < 1) {
    throw new ConvertError('Conversion produced no output');
  }

  const out = result.GetFile(0);
  const bytes = out.GetContent(); // Uint8Array
  if (!bytes || bytes.length === 0) {
    throw new ConvertError('Conversion produced an empty GLB');
  }
  // Copy out of the WASM heap into a Node Buffer the rest of the pipeline owns.
  return Buffer.from(bytes);
}

// ── Hardened zip extraction (in memory, no disk, bomb/traversal guards) ──────
function extractArchive(zipBuffer) {
  const AdmZip = require('adm-zip');

  let zip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch (_) {
    throw new ConvertError('Could not read the .zip archive (corrupt or not a zip)');
  }

  const entries = zip.getEntries();
  if (entries.length === 0) {
    throw new ConvertError('The .zip archive is empty');
  }
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new ConvertError(
      `Archive has too many files (${entries.length} > ${MAX_ZIP_ENTRIES} limit)`
    );
  }

  const files = [];
  let totalInflated = 0;
  let primaryCount = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const rawName = entry.entryName || '';

    // ── Path-traversal guard ──
    // Reject absolute paths, drive letters, backslashes, and any ".." segment.
    // We never use these names as real paths, but rejecting keeps crafted
    // archives from reaching Assimp at all.
    if (
      rawName.includes('..') ||
      rawName.startsWith('/') ||
      rawName.startsWith('\\') ||
      /^[a-zA-Z]:/.test(rawName) ||
      rawName.includes('\0')
    ) {
      throw new ConvertError('Archive contains an unsafe file path');
    }

    const base = path.posix.basename(rawName.replace(/\\/g, '/'));
    const entryExt = normExt(path.extname(base));

    const isPrimary = CONVERTIBLE_EXTS.has(entryExt);
    const isAux     = ALLOWED_AUX_EXTS.has(entryExt);
    if (!isPrimary && !isAux) {
      // Silently skip anything that isn't a model or an allowed texture/aux
      // file — executables, nested zips, symlinks, etc. never get read.
      continue;
    }

    // ── Zip-bomb guards (declared sizes, checked before inflating) ──
    const declared = Number(entry.header && entry.header.size) || 0;      // inflated
    const compressed = Number(entry.header && entry.header.compressedSize) || 0;
    if (declared > MAX_ZIP_ENTRY_BYTES) {
      throw new ConvertError(
        `A file inside the archive is too large (${mb(declared)} MB > ${mb(MAX_ZIP_ENTRY_BYTES)} MB)`
      );
    }
    if (compressed > 0 && declared / compressed > MAX_ZIP_RATIO) {
      throw new ConvertError('Archive rejected (suspicious compression ratio — possible zip bomb)');
    }

    // Inflate this one entry. adm-zip returns a Buffer; verify the ACTUAL size
    // (a lying header is caught here) and keep a running total.
    let data;
    try {
      data = entry.getData();
    } catch (_) {
      throw new ConvertError(`Could not read "${base}" from the archive`);
    }
    if (data.length > MAX_ZIP_ENTRY_BYTES) {
      throw new ConvertError(
        `A file inside the archive is too large (${mb(data.length)} MB > ${mb(MAX_ZIP_ENTRY_BYTES)} MB)`
      );
    }
    totalInflated += data.length;
    if (totalInflated > MAX_ZIP_TOTAL_BYTES) {
      throw new ConvertError(
        `Archive contents too large once unpacked (> ${mb(MAX_ZIP_TOTAL_BYTES)} MB — possible zip bomb)`
      );
    }

    if (isPrimary) primaryCount++;

    // Feed Assimp the sanitised basename only (so .mtl/.obj and texture refs by
    // relative filename still resolve), never the archive's internal path.
    files.push({ name: base, data, primary: isPrimary });
  }

  const primaries = files.filter((f) => f.primary);
  if (primaries.length === 0) {
    throw new ConvertError(
      'No convertible model (.fbx/.obj/.dae/.stl/.ply/.3ds) found inside the .zip'
    );
  }
  if (primaries.length > 1) {
    throw new ConvertError(
      `The .zip contains ${primaries.length} models — upload one model per archive`
    );
  }

  // Order the primary first so assimpjs treats it as the root scene.
  return [primaries[0], ...files.filter((f) => !f.primary)].map(({ name, data }) => ({ name, data }));
}

// ── helpers ─────────────────────────────────────────────────────────────────
class ConvertError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ConvertError';
  }
}

function normExt(ext) {
  const e = String(ext || '').toLowerCase().trim();
  return e.startsWith('.') ? e : (e ? `.${e}` : '');
}

function intEnv(name, dflt) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(0);
}

function safeStr(v) {
  try {
    return String(v).slice(0, 200);
  } catch (_) {
    return '';
  }
}

function withTimeout(promise, ms, msg) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ConvertError(msg)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { toGlb, needsConversion, ConvertError };
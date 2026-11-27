'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// lib/appBuildFields.js — what a caller may write into an app_builds record
// (SEC-018). Both POST /api/app-builder/builds and POST /api/tenant/files use
// it. Everything else (status, build_status, published_at, created_by …) is
// set by the server, so a new record can never go live without "Publish".
//
// update_url is what the app's force-update screen opens, so it must be a
// Google Play link. logo_url must be https. Bad values → { error } (HTTP 400).
// ═══════════════════════════════════════════════════════════════════════════

const TEXT_FIELDS = ['app_name', 'state', 'version', 'version_name', 'platform',
  'primary_language', 'skin_name', 'sha'];
const FLAG_KEYS = ['ar', 'quiz', 'leaderboard', 'ads'];
const PLAY_HOST = 'play.google.com';

function httpsUrl(v) {
  try {
    const u = new URL(String(v));
    return u.protocol === 'https:' ? u : null;
  } catch (_) { return null; }
}

function cleanBuild(body) {
  const b = (body && typeof body === 'object') ? body : {};
  const out = {};
  for (const k of TEXT_FIELDS) {
    if (b[k] === undefined || b[k] === null) continue;
    if (typeof b[k] !== 'string' && typeof b[k] !== 'number') return { error: `"${k}" must be text` };
    out[k] = String(b[k]).trim().slice(0, 120);
  }
  if (b.theme_color !== undefined && b.theme_color !== null) {
    if (!/^#[0-9a-fA-F]{6}$/.test(String(b.theme_color))) return { error: 'theme_color must look like #6366f1' };
    out.theme_color = String(b.theme_color);
  }
  if (b.logo_url) {
    if (!httpsUrl(b.logo_url)) return { error: 'logo_url must be an https:// link' };
    out.logo_url = String(b.logo_url).slice(0, 500);
  } else if (b.logo_url === null) {
    out.logo_url = null;
  }
  if (b.update_url !== undefined && b.update_url !== null && b.update_url !== '') {
    const u = httpsUrl(b.update_url);
    if (!u || u.hostname !== PLAY_HOST) return { error: 'update_url must be a https://play.google.com/ link' };
    out.update_url = u.toString();
  }
  for (const k of ['min_supported_build', 'latest_build']) {
    if (b[k] === undefined || b[k] === null || b[k] === '') continue;
    const n = Number(b[k]);
    if (!Number.isInteger(n) || n < 1 || n > 1000000) return { error: `${k} must be a whole number` };
    out[k] = n;
  }
  if (b.feature_flags && typeof b.feature_flags === 'object') {
    out.feature_flags = {};
    for (const k of FLAG_KEYS) {
      if (typeof b.feature_flags[k] === 'boolean') out.feature_flags[k] = b.feature_flags[k];
    }
  }
  return { fields: out };
}

module.exports = { cleanBuild, PLAY_HOST };
'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// Content packs — new looks and content for the app WITHOUT a new APK.
//
// A pack is one JSON file: { "mitra_pack": 1, "type": "<type>", "data": {…} }.
// The app downloads the published packs in the background, checks each file's
// SHA-256, keeps a copy on the phone (works offline) and uses them from the
// next app start. Unpublishing a pack removes it from phones the same way.
//
// Types (the app's own drawing code uses the data; nothing here runs code):
//   theme       colours for the app themes, or a festival skin for all of them
//   hero_suit   hero colours, emblems, masks, new subject heroes, extra suit parts
//   chiku_look  Chiku recolours, outfit parts, hats / props
//   slides      the intro slides (replace, or add before / after the built-in ones)
//   strings     wording / translations (any key, any language, English too)
//   settings    numbers and switches the app reads (e.g. AR gesture-guide timing)
//   lottie      an animation that replaces a built-in one (splash, confetti…)
//
// Public:  GET /manifest   GET /file/:id/:version     (the app, before sign-in too)
// Admin:   GET /  POST /  PUT /:id  POST /:id/publish|unpublish|rollback
//          DELETE /:id  GET /template/:type           (perm_publish_apps)
// Packs carry looks and words only — nothing personal — so the public reads are
// safe; every write needs a signed-in admin.
// ═══════════════════════════════════════════════════════════════════════════
const router  = require('express').Router();
const crypto  = require('crypto');
const multer  = require('multer');
const { getFirestore } = require('../lib/firebase');
const storage = require('../lib/storage');
const { authenticate, requirePerm } = require('../middleware/auth');
const { sameState, isNational, unknownStates, UNKNOWN_STATE_MSG } = require('../lib/states');
const { parseTargetStates, canTouchTargets, scopedTargets, guardTargets, scopeState } = require('../lib/stateScope');
const log = require('../lib/logger');

const COLL = 'app_packs';
const MAX_BYTES = (parseInt(process.env.MAX_APP_PACK_MB, 10) || 3) * 1024 * 1024;
const TYPES = ['theme', 'hero_suit', 'chiku_look', 'slides', 'strings', 'settings', 'lottie'];
const THEME_KEYS = ['*', 'midnightSlate', 'deepForest', 'twilightPurple', 'warmCharcoal', 'abyssalBlue'];
const HERO_LAYERS = ['aura', 'ground', 'back', 'cape', 'body', 'glow', 'eyes', 'flash', 'shock', 'shock2', 'sparks', 'vflare', 'impact'];
const CHIKU_PARTS = ['vine', 'tail', 'legs', 'body', 'wave', 'ears', 'head', 'eyes', 'squint', 'smile', 'mouth_open', 'tongue', 'grip'];
const LOTTIE_SLOTS = [
  'assets/animations/splash_animation.json',
  'assets/animations/Confetti.json',
  'assets/lotties/waving_hands.json',
  'assets/lotties/Earth globe rotating with Seamless loop animation.lottie',
];
const HEX = /^#[0-9a-fA-F]{6}$/;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

// ── Pack checks: a bad pack is refused here, so phones only ever get good ones ──
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isSvg = (v) => isStr(v) && /^\s*<svg[\s>]/i.test(v) && /<\/svg>\s*$/i.test(v);
const textOk = (v) => isStr(v) || (isObj(v) && Object.values(v).every(isStr));

function checkPack(type, pack) {
  const errs = [];
  const need = (ok, msg) => { if (!ok) errs.push(msg); };
  need(isObj(pack), 'The file must be a JSON object');
  if (errs.length) return errs;
  need(pack.mitra_pack === 1, '"mitra_pack": 1 is missing');
  need(pack.type === type, `"type" in the file is "${pack.type}", but you chose "${type}"`);
  const d = pack.data;
  need(isObj(d), '"data" must be an object');
  if (errs.length) return errs;

  if (type === 'theme') {
    need(isObj(d.themes) && Object.keys(d.themes).length, 'data.themes is empty');
    for (const [k, t] of Object.entries(d.themes || {})) {
      need(THEME_KEYS.includes(k), `Unknown theme "${k}" (use ${THEME_KEYS.join(', ')})`);
      need(isObj(t), `themes.${k} must be an object`);
      if (!isObj(t)) continue;
      if (t.gradient !== undefined) need(Array.isArray(t.gradient) && t.gradient.length === 2 && t.gradient.every(c => HEX.test(c)), `themes.${k}.gradient must be two colours like "#1E293B"`);
      if (t.highlight !== undefined) need(HEX.test(t.highlight), `themes.${k}.highlight must be a colour like "#22D3EE"`);
      need(t.gradient !== undefined || t.highlight !== undefined, `themes.${k} changes nothing (add gradient and/or highlight)`);
    }
  }
  if (type === 'hero_suit') {
    (d.heroes || []).forEach((h, i) => {
      need(isObj(h) && isStr(h.subject) && h.subject.trim(), `heroes[${i}].subject is missing`);
      if (!isObj(h)) return;
      need(Array.isArray(h.keywords) && h.keywords.length && h.keywords.every(isStr), `heroes[${i}].keywords must list subject words, e.g. ["physics"]`);
      ['main', 'accent', 'skin', 'hair'].forEach(c => { if (h[c] !== undefined) need(HEX.test(h[c]), `heroes[${i}].${c} must be a colour like "#1D4ED8"`); });
    });
    need(d.heroes === undefined || Array.isArray(d.heroes), 'data.heroes must be a list');
    for (const [k, v] of Object.entries(d.emblems || {})) need(isStr(v) && v.includes('<'), `emblems.${k} must be SVG shapes`);
    for (const [k, v] of Object.entries(d.masks || {})) need(isStr(v) && /^[MmLlCcQqAaZzHhVvSsTt0-9 .,\-]+$/.test(v), `masks.${k} must be SVG path data (M… L… Z)`);
    (d.chunks || []).forEach((c, i) => {
      need(isObj(c) && HERO_LAYERS.includes(c.layer), `chunks[${i}].layer must be one of ${HERO_LAYERS.join(', ')}`);
      need(isObj(c) && isStr(c.svg) && c.svg.includes('<'), `chunks[${i}].svg must be SVG shapes`);
      if (isObj(c) && c.gender !== undefined) need(['any', 'boy', 'girl'].includes(c.gender), `chunks[${i}].gender must be any, boy or girl`);
    });
    need(d.heroes || d.emblems || d.masks || d.chunks, 'Nothing to change: add heroes, emblems, masks or chunks');
  }
  if (type === 'chiku_look') {
    for (const [k, v] of Object.entries(d.colors || {})) need(HEX.test(k) && HEX.test(v), `colors: "${k}" → "${v}" must both be colours like "#B5652A"`);
    for (const [k, v] of Object.entries(d.parts || {})) {
      need(CHIKU_PARTS.includes(k), `Unknown Chiku part "${k}" (use ${CHIKU_PARTS.join(', ')})`);
      need(isSvg(v), `parts.${k} must be a whole <svg …>…</svg> (viewBox "60 90 300 410")`);
    }
    ['head_extra', 'body_extra'].forEach(k => { if (d[k] !== undefined) need(isStr(d[k]) && d[k].includes('<'), `${k} must be SVG shapes`); });
    need(d.colors || d.parts || d.head_extra || d.body_extra, 'Nothing to change: add colors, parts, head_extra or body_extra');
  }
  if (type === 'slides') {
    need(['replace', 'append', 'prepend'].includes(d.mode || 'replace'), 'data.mode must be replace, append or prepend');
    need(Array.isArray(d.slides) && d.slides.length, 'data.slides is empty');
    (d.slides || []).forEach((s, i) => {
      need(isObj(s) && textOk(s.title) && textOk(s.body), `slides[${i}] needs a title and a body`);
      if (!isObj(s)) return;
      if (s.title_accent !== undefined) need(textOk(s.title_accent), `slides[${i}].title_accent must be text`);
      if (s.gradient !== undefined) need(Array.isArray(s.gradient) && s.gradient.length === 2 && s.gradient.every(c => HEX.test(c)), `slides[${i}].gradient must be two colours`);
      const v = s.visual || 'emoji';
      need(['emoji', 'heroes', 'cards', 'svg', 'lottie'].includes(v), `slides[${i}].visual must be emoji, heroes, cards, svg or lottie`);
      if (v === 'svg') need(isSvg(s.svg), `slides[${i}].svg must be a whole <svg>…</svg>`);
      if (v === 'lottie') need(isObj(s.lottie) && s.lottie.layers, `slides[${i}].lottie must be a Lottie animation (JSON)`);
    });
  }
  if (type === 'strings') {
    need(Object.keys(d).length, 'No languages in data');
    for (const [lang, m] of Object.entries(d)) {
      need(/^[a-z]{2,3}$/.test(lang), `"${lang}" is not a language code (en, hi, pa…)`);
      need(isObj(m) && Object.values(m).every(isStr), `data.${lang} must map keys to text`);
    }
  }
  if (type === 'settings') {
    need(Object.keys(d).length, 'No settings in data');
    for (const [k, v] of Object.entries(d)) need(['number', 'boolean', 'string'].includes(typeof v), `settings.${k} must be a number, true/false or text`);
  }
  if (type === 'lottie') {
    need(LOTTIE_SLOTS.includes(d.replaces), `data.replaces must be one of: ${LOTTIE_SLOTS.join(' | ')}`);
    need(isObj(d.animation) && Array.isArray(d.animation.layers), 'data.animation must be a Lottie animation (JSON with "layers")');
  }
  return errs;
}

const TEMPLATES = {
  theme: { mitra_pack: 1, type: 'theme', data: { themes: {
    '*': { gradient: ['#3B0A2A', '#1A0612'], highlight: '#FBBF24' },
    midnightSlate: { highlight: '#22D3EE' } } } },
  hero_suit: { mitra_pack: 1, type: 'hero_suit', data: {
    heroes: [{ subject: 'Physics', boy_name: 'Vidyut', girl_name: 'Vidyuta', main: '#B91C1C', accent: '#FACC15', emblem: 'bolt', mask: 'goggle', keywords: ['physics', 'bhautik'] }],
    emblems: {}, masks: {},
    chunks: [{ layer: 'body', min_level: 4, max_level: 4, gender: 'any', svg: '<path d="M176 92 L188 72 L200 88 L212 72 L224 92 Z" fill="#FACC15" stroke="#7C2D12" stroke-width="2"/>' }],
    replace_builtin_chunks: false } },
  chiku_look: { mitra_pack: 1, type: 'chiku_look', data: {
    colors: { '#B5652A': '#8B5A2B' },
    head_extra: '<path d="M140 214 Q186 168 232 214 Z" fill="#E11D48" stroke="#2A140A" stroke-width="2.5"/><circle cx="186" cy="182" r="7" fill="#FBBF24" stroke="#2A140A" stroke-width="2"/>' } },
  slides: { mitra_pack: 1, type: 'slides', data: { mode: 'append', slides: [
    { emoji: '🪔', title: { en: 'Happy Diwali,', hi: 'दीपावली की शुभकामनाएँ,' }, title_accent: { en: 'Light Up Learning', hi: 'सीखने को रोशन करें' },
      body: { en: 'Finish 3 lessons this week to unlock the festival hero suit!', hi: 'इस हफ़्ते 3 पाठ पूरे करें और त्योहार वाला हीरो सूट पाएँ!' },
      gradient: ['#3B0A2A', '#1A0612'], visual: 'emoji' }] } },
  strings: { mitra_pack: 1, type: 'strings', data: { en: { auth_skip: 'Skip' }, hi: { auth_skip: 'छोड़ें' } } },
  settings: { mitra_pack: 1, type: 'settings', data: { ar_gesture_hint_auto_times: 3, ar_gesture_hint_seconds: 8 } },
  lottie: { mitra_pack: 1, type: 'lottie', data: { replaces: 'assets/animations/Confetti.json', animation: { v: '5.7.4', fr: 30, ip: 0, op: 60, w: 400, h: 400, layers: [] } } },
};

// ── Public: the app's list of packs ─────────────────────────────────────────
let _cache = { at: 0, rows: null };
async function publishedRows() {
  if (_cache.rows && Date.now() - _cache.at < 60 * 1000) return _cache.rows;
  const snap = await getFirestore().collection(COLL).where('status', '==', 'published').limit(500).get();
  _cache = { at: Date.now(), rows: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  return _cache.rows;
}
const _dropCache = () => { _cache = { at: 0, rows: null }; };
const iso = (v) => (v && v.toDate ? v.toDate() : v ? new Date(v) : null);

router.get('/manifest', async (req, res) => {
  try {
    const state = String(req.query.state || '').trim();
    const build = parseInt(req.query.build, 10) || 0;
    const now = Date.now();
    const packs = (await publishedRows()).filter(p => {
      if (build && p.min_build && build < p.min_build) return false;
      if (build && p.max_build && build > p.max_build) return false;
      const end = iso(p.ends_at);
      if (end && end.getTime() < now) return false;           // event over
      const st = Array.isArray(p.target_states) ? p.target_states : [];
      if (st.length && !st.some(s => sameState(s, state))) return false;
      return true;
    }).map(p => ({
      id: p.id, type: p.type, version: p.version, sha256: p.sha256, size: p.size,
      url: `/api/app-packs/file/${encodeURIComponent(p.id)}/${p.version}`,
      wifi_only: !!p.wifi_only,
      starts_at: iso(p.starts_at) ? iso(p.starts_at).toISOString() : null,
      ends_at: iso(p.ends_at) ? iso(p.ends_at).toISOString() : null,
    }));
    res.set('Cache-Control', 'no-store');
    res.json({ packs });
  } catch (err) {
    log.error({ err: err.message }, 'app packs manifest failed');
    res.json({ packs: null }); // null = "couldn't tell": the app keeps what it has
  }
});

const _fileCache = new Map(); // `${id}@${version}` → Buffer (small, immutable)
router.get('/file/:id/:version', async (req, res) => {
  try {
    const id = String(req.params.id);
    const version = parseInt(req.params.version, 10);
    const row = (await publishedRows()).find(p => p.id === id);
    if (!row || row.version !== version) return res.status(404).json({ error: 'Pack not found' });
    const k = `${id}@${version}`;
    let buf = _fileCache.get(k);
    if (!buf) {
      buf = await storage.getBuffer(row.storage_key);
      if (_fileCache.size > 50) _fileCache.clear();
      _fileCache.set(k, buf);
    }
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=31536000, immutable'); // a version never changes
    res.set('ETag', `"${row.sha256}"`);
    res.send(buf);
  } catch (err) {
    log.error({ err: err.message }, 'app pack file failed');
    res.status(500).json({ error: 'Could not read pack' });
  }
});

// ── Admin ───────────────────────────────────────────────────────────────────
router.use(authenticate, requirePerm('perm_publish_apps'));
// A state publisher changes only packs aimed at their own state; all-India
// packs stay with national staff.
router.param('id', guardTargets(COLL));
const OUT_OF_STATE = (req) => ({ error: `Your account can only manage ${scopeState(req)}.` });

router.get('/template/:type', (req, res) => {
  const t = TEMPLATES[req.params.type];
  if (!t) return res.status(404).json({ error: 'Unknown type' });
  res.set('Content-Disposition', `attachment; filename="mitra_pack_${req.params.type}.json"`);
  res.json(t);
});

router.get('/', async (req, res) => {
  try {
    const snap = await getFirestore().collection(COLL).limit(500).get();
    const data = snap.docs.map(d => {
      const p = d.data();
      return { id: d.id, ...p, history: undefined,
        can_rollback: Array.isArray(p.history) && p.history.length > 0,
        updated_at: iso(p.updated_at), starts_at: iso(p.starts_at), ends_at: iso(p.ends_at) };
    }).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    res.json({ data, types: TYPES, lottie_slots: LOTTIE_SLOTS });
  } catch (err) {
    res.status(500).json({ error: 'Could not list packs' });
  }
});

// Targeting / timing fields shared by create and edit.
function metaFrom(body) {
  const out = {};
  if ('title' in body) out.title = String(body.title || '').slice(0, 120);
  if ('notes' in body) out.notes = String(body.notes || '').slice(0, 500);
  if ('min_build' in body) out.min_build = parseInt(body.min_build, 10) || 0;
  if ('max_build' in body) out.max_build = parseInt(body.max_build, 10) || 0;
  if ('wifi_only' in body) out.wifi_only = body.wifi_only === true || body.wifi_only === 'true';
  // Empty = every state ("All India" means the same).
  if ('target_states' in body) out.target_states = parseTargetStates(body.target_states).filter(s => !isNational(s));
  for (const k of ['starts_at', 'ends_at']) {
    if (!(k in body)) continue;
    const v = String(body[k] || '').trim();
    out[k] = v ? new Date(v) : null;
    if (out[k] && isNaN(out[k].getTime())) throw Object.assign(new Error(`${k} is not a date`), { status: 400 });
  }
  if (out.target_states && out.target_states.length) {
    const bad = unknownStates(out.target_states);
    if (bad.length) throw Object.assign(new Error(UNKNOWN_STATE_MSG(bad)), { status: 400 });
  }
  return out;
}

// Create a pack, or upload a new version of one (same id). New versions start
// as a draft unless "publish" is ticked; phones keep the published version until then.
router.post('/', upload.single('file'), async (req, res) => {
  try {
    const body = req.body || {};
    const id = String(body.id || '').trim().toLowerCase();
    const type = String(body.type || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{2,48}$/.test(id)) return res.status(400).json({ error: 'Pack id: 3-49 letters, digits, _ or - (e.g. diwali_theme)' });
    if (!TYPES.includes(type)) return res.status(400).json({ error: 'Pick a pack type' });
    const raw = req.file ? req.file.buffer : (body.content ? Buffer.from(String(body.content), 'utf8') : null);
    if (!raw || !raw.length) return res.status(400).json({ error: 'Choose a pack file (.json) or paste its content' });
    if (raw.length > MAX_BYTES) return res.status(413).json({ error: `Pack is larger than ${MAX_BYTES / 1048576} MB` });
    let pack;
    try { pack = JSON.parse(raw.toString('utf8').replace(/^﻿/, '')); }
    catch (e) { return res.status(400).json({ error: 'Not valid JSON: ' + e.message }); }
    const errs = checkPack(type, pack);
    if (errs.length) return res.status(400).json({ error: 'Pack has problems', problems: errs.slice(0, 20) });

    const buf = Buffer.from(JSON.stringify(pack), 'utf8'); // normalised (no BOM / whitespace)
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const db = getFirestore();
    const ref = db.collection(COLL).doc(id);
    const prev = await ref.get();
    const old = prev.exists ? prev.data() : null;
    if (old && old.type !== type) return res.status(400).json({ error: `Pack "${id}" is a ${old.type} pack; use another id` });
    if (old && old.sha256 === sha256) return res.status(400).json({ error: 'This file is the same as the current version' });
    if (scopeState(req) !== null) { // state publisher: own state's packs only
      if (old && !canTouchTargets(req, old.target_states)) return res.status(403).json(OUT_OF_STATE(req));
      const t = scopedTargets(req, 'target_states' in body ? body.target_states : (old ? old.target_states : []));
      if (!t) return res.status(403).json(OUT_OF_STATE(req));
      body.target_states = t;
    }

    const version = (old ? old.version || 0 : 0) + 1;
    const key = `app_packs/${id}/v${version}.json`;
    await storage.putRaw(buf, key, { contentType: 'application/json' });
    const publish = body.publish === true || body.publish === 'true';
    const meta = metaFrom(body);
    const stale = [];                       // files nothing points to any more
    if (old && old.pending) stale.push(old.pending.storage_key);
    if (!publish && old && old.status === 'published') {
      // Not published yet: phones stay on the live version; this one waits.
      await ref.set({ pending: { version, sha256, size: buf.length, storage_key: key },
        updated_at: new Date(), updated_by: req.user.id, ...meta }, { merge: true });
    } else {
      const all = old && old.status === 'published'
        ? [{ version: old.version, storage_key: old.storage_key, sha256: old.sha256, size: old.size }, ...(old.history || [])]
        : (old ? [...(old.history || [])] : []);
      if (old && old.status !== 'published') stale.push(old.storage_key);  // an unpublished draft is replaced
      stale.push(...all.slice(5).map(h => h.storage_key));
      await ref.set({
        type, version, sha256, size: buf.length, storage_key: key, pending: null,
        status: publish ? 'published' : 'draft',
        history: all.slice(0, 5), updated_at: new Date(), updated_by: req.user.id,
        ...(publish ? { published_at: new Date(), published_by: req.user.id } : {}),
        ...(old ? {} : { created_at: new Date(), created_by: req.user.id, title: id, target_states: [], wifi_only: false, min_build: 0, max_build: 0, starts_at: null, ends_at: null }),
        ...meta,
      }, { merge: true });
    }
    await Promise.all(stale.filter(Boolean).map(k => storage.delete(k).catch(() => {})));
    _dropCache();
    const status = publish ? 'published' : (old && old.status === 'published' ? 'published (new version waiting)' : 'draft');
    res.status(old ? 200 : 201).json({ id, version, status, sha256, size: buf.length });
  } catch (err) {
    log.error({ err: err.message }, 'app pack upload failed');
    res.status(err.status || 500).json({ error: err.message || 'Upload failed' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const ref = getFirestore().collection(COLL).doc(String(req.params.id));
    if (!(await ref.get()).exists) return res.status(404).json({ error: 'Pack not found' });
    const meta = metaFrom(req.body || {});
    if ('target_states' in meta && !canTouchTargets(req, meta.target_states)) return res.status(403).json(OUT_OF_STATE(req));
    await ref.set({ ...meta, updated_at: new Date(), updated_by: req.user.id }, { merge: true });
    _dropCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Save failed' });
  }
});

router.post('/:id/publish', async (req, res) => {
  try {
    const ref = getFirestore().collection(COLL).doc(String(req.params.id));
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Pack not found' });
    const p = snap.data();
    const upd = { status: 'published', published_at: new Date(), published_by: req.user.id, updated_at: new Date() };
    let stale = [];
    if (p.pending) {   // a new version waiting → it becomes the live version
      const all = p.status === 'published'
        ? [{ version: p.version, storage_key: p.storage_key, sha256: p.sha256, size: p.size }, ...(p.history || [])]
        : [...(p.history || [])];
      stale = all.slice(5).map(h => h.storage_key);
      Object.assign(upd, {
        version: p.pending.version, sha256: p.pending.sha256, size: p.pending.size, storage_key: p.pending.storage_key,
        history: all.slice(0, 5), pending: null,
      });
    }
    await ref.set(upd, { merge: true });
    await Promise.all(stale.filter(Boolean).map(k => storage.delete(k).catch(() => {})));
    _dropCache();
    res.json({ ok: true, version: upd.version || p.version });
  } catch (err) {
    res.status(500).json({ error: 'Publish failed' });
  }
});

router.post('/:id/unpublish', async (req, res) => {
  try {
    const ref = getFirestore().collection(COLL).doc(String(req.params.id));
    if (!(await ref.get()).exists) return res.status(404).json({ error: 'Pack not found' });
    await ref.set({ status: 'draft', updated_at: new Date(), updated_by: req.user.id }, { merge: true });
    _dropCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Unpublish failed' });
  }
});

// Back to the previous version (phones switch at their next refresh).
router.post('/:id/rollback', async (req, res) => {
  try {
    const ref = getFirestore().collection(COLL).doc(String(req.params.id));
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Pack not found' });
    const p = snap.data();
    const [back, ...rest] = p.history || [];
    if (!back) return res.status(400).json({ error: 'No earlier version' });
    // Keep version numbers increasing so phones notice the change.
    const version = Math.max(p.version || 0, (p.pending && p.pending.version) || 0) + 1;
    const buf = await storage.getBuffer(back.storage_key);
    const key = `app_packs/${snap.id}/v${version}.json`;
    await storage.putRaw(buf, key, { contentType: 'application/json' });
    await ref.set({ version, sha256: back.sha256, size: back.size, storage_key: key, history: rest, pending: null,
      updated_at: new Date(), updated_by: req.user.id, rolled_back_to: back.version }, { merge: true });
    // The replaced version, the restored copy's source and any waiting draft are no longer used.
    await Promise.all([p.storage_key, back.storage_key, p.pending && p.pending.storage_key]
      .filter(Boolean).map(k => storage.delete(k).catch(() => {})));
    _dropCache();
    res.json({ ok: true, version, restored: back.version });
  } catch (err) {
    log.error({ err: err.message }, 'app pack rollback failed');
    res.status(500).json({ error: 'Rollback failed' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const ref = getFirestore().collection(COLL).doc(String(req.params.id));
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Pack not found' });
    const p = snap.data();
    const keys = [p.storage_key, p.pending && p.pending.storage_key, ...(p.history || []).map(h => h.storage_key)].filter(Boolean);
    await ref.delete();
    await Promise.all(keys.map(k => storage.delete(k).catch(() => {})));
    _dropCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

router._checkPack = checkPack; // for tests
module.exports = router;

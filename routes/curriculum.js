/**
 * routes/curriculum.js — Curriculum Taxonomy CRUD + AR/Quiz Linking
 * GET /tree reads from Firestore. /ar-topics is the app's lesson feed and only
 * returns content that is published AND released (lib/release.js).
 */
'use strict';

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { getFirestore } = require('../lib/firebase');
const { authenticate, requirePerm } = require('../middleware/auth');
const { visibleInState, canAccessState, stateAliases } = require('../lib/stateScope');
const { isAppCaller, isReleased } = require('../lib/release');
const log = require('../lib/logger');
router.use(authenticate);

// ── GET / and /tree — Reads from Firestore curriculum collection ──────────────
async function getCurriculumNodes() {
  const db = getFirestore();
  let snap = null;
  try {
    snap = await db.collection('curriculum').get();
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load curriculum — showing placeholder content, check this error');
  }
  if (snap && !snap.empty) {
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  // Nothing added yet — return an empty tree (no invented chapters on students' phones).
  return [];
}

router.get('/', async (req, res) => {
  try {
    res.json(await getCurriculumNodes());
  } catch { res.status(500).json({ error: 'Failed to fetch curriculum' }); }
});

router.get('/tree', async (req, res) => {
  try {
    const nodes = await getCurriculumNodes();
    res.json({ success: true, nodes });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch curriculum', details: err.message });
  }
});


// GET /subjects/:state — REAL subject tiles for the app Home screen, derived
// from PUBLISHED AR assets (not the legacy `curriculum` node collection, which
// is empty). State-scoped with the alias map, so a Gujarat student sees the
// subjects that actually have content tagged for their state.
router.get('/subjects/:state', async (req, res) => {
  try {
    const db = getFirestore();
    const rawState = req.params.state || '';
    const want = new Set(stateAliases(rawState));
    const EMOJI = { science:'🔬', maths:'📐', mathematics:'📐', english:'📖',
      hindi:'📘', 'social science':'🌍', history:'📜', geography:'🗺️',
      biology:'🧬', physics:'⚛️', chemistry:'⚗️', 'computer science':'💻' };
    let snap;
    try {
      snap = await db.collection('ar_assets').where('status', '==', 'published').limit(1000).get();
    } catch (_) { return res.json({ success: true, subjects: [] }); }
    const bySubject = {};
    snap.docs.forEach(d => {
      const a = d.data();
      const ts = Array.isArray(a.target_states) ? a.target_states : [];
      const inState = !ts.length || ts.some(x => { for (const al of stateAliases(x)) if (want.has(al)) return true; return false; });
      if (!inState) return;
      const subj = String(a.subject || '').trim();
      if (!subj) return;
      bySubject[subj] = (bySubject[subj] || 0) + 1;
    });
    const subjects = Object.entries(bySubject).map(([name, count]) => ({
      name,
      emoji: EMOJI[name.toLowerCase()] || '📚',
      ar: count,
      ar_topics_count: count,
      progress: 0,
    }));
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ success: true, subjects });
  } catch (err) {
    res.status(500).json({ error: 'Failed to build subjects', details: err.message });
  }
});

router.post('/', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const { parent_id, node_type, name, icon = '📘', sort_order = 0 } = req.body;
    if (!node_type || !name) return res.status(400).json({ error: 'node_type and name required' });
    const db  = getFirestore();
    const id  = uuidv4();
    const doc = { parent_id: parent_id || null, node_type, name, icon, sort_order, is_active: true, created_by: req.user.id };
    await db.collection('curriculum').doc(id).set(doc);
    res.status(201).json({ id, ...doc });
  } catch { res.status(500).json({ error: 'Failed to create node' }); }
});

router.put('/:id', requirePerm('perm_edit_curriculum'), async (req, res, next) => {
  // '/:id' is declared before '/learning-settings', so Express sent the AR
  // watch-threshold save here and it failed with 500. Hand it on.
  if (req.params.id === 'learning-settings') return next();
  try {
    const { name, icon, sort_order, is_active } = req.body;
    const db = getFirestore();
    const updates = {};
    if (name !== undefined)       updates.name       = name;
    if (icon !== undefined)       updates.icon       = icon;
    if (sort_order !== undefined) updates.sort_order = sort_order;
    if (is_active !== undefined)  updates.is_active  = is_active;
    await db.collection('curriculum').doc(req.params.id).update(updates);
    res.json({ id: req.params.id, ...updates });
  } catch { res.status(500).json({ error: 'Failed to update node' }); }
});

router.delete('/:id', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('curriculum').doc(req.params.id).update({ is_active: false });
    res.json({ message: 'Node deactivated' });
  } catch { res.status(500).json({ error: 'Failed to delete node' }); }
});

// ── AR Topics ──────────────────────────────────────────────────────────────────
// Returns published AR assets as "topics" — what the Flutter app uses to
// display the lesson list and request the CDN URL for the GLB file.
// Is the requested state inside MITRA's approved territory? A state is
// "supported" once the dashboard has saved a curriculum for it.
async function _territorySupported(db, state) {
  const s = String(state || '').trim();
  if (!s) return true;
  try {
    const snap = await db.collection('curriculum_hierarchy').get();
    return snap.docs.some(d => {
      const h = d.data() || {};
      const a = String(h.state_name || '').trim().toLowerCase();
      const b = String(h.state_code || '').trim().toLowerCase();
      const want = s.toLowerCase();
      return a === want || b === want;
    });
  } catch (_) {
    return true;
  }
}

// ── Curriculum manifest (scaling cost-shield) ───────────────────────────────
// At lakhs of DAU, every student querying several collections per launch makes
// Firestore the biggest bill. Instead we build ONE compact JSON per state
// (classes → subjects → topics → released AR lessons + model URLs), cache it
// hard, and let the app read just this. Regenerated when an admin saves a
// state's curriculum; served with a long Cache-Control so repeat reads are free
// at the CDN/proxy. (Later: push the same JSON to R2 — format stays identical.)
// Bump when the manifest shape changes: cached copies with an older version
// are rebuilt on the next read instead of being served stale.
const MANIFEST_VERSION = 3; // v3: tree links decide a topic's AR lessons; lessons carry quiz_ids
async function buildStateManifest(db, stateCode, stateName) {
  const hDoc = await db.collection('curriculum_hierarchy').doc(stateCode).get();
  const structure = hDoc.exists ? (hDoc.data().structure || []) : [];
  // Published AR assets visible to this state, keyed for quick topic lookup.
  let assets = [];
  try {
    const aSnap = await db.collection('ar_assets').where('status', '==', 'published').limit(1000).get();
    assets = aSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(a => {
        const ts = Array.isArray(a.target_states) ? a.target_states : [];
        if (!ts.length) return true; // national
        // Alias-aware: a lesson tagged "GJ" matches a Gujarat manifest, and vice
        // versa, so code/name/case differences no longer hide content.
        const want = new Set([...stateAliases(stateName), ...stateAliases(stateCode)]);
        return ts.some(x => { for (const al of stateAliases(x)) if (want.has(al)) return true; return false; });
      });
  } catch (_) {}
  const nrm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const byId = new Map(assets.map(a => [a.id, a]));
  // Assets the admin placed on a topic in the Curriculum tree. Tree links win:
  // a placed asset shows only where it was linked, never again via its tags.
  const placed = new Set();
  structure.forEach(c => (c.subjects || []).forEach(sj => (sj.topics || []).forEach(t =>
    (t.ar_assets || []).forEach(x => { if (x && x.id) placed.add(x.id); }))));
  const tagMatched = (cls, subj, topic) => assets.filter(a => !placed.has(a.id) &&
    nrm(a.class_name) === nrm(cls) && nrm(a.subject) === nrm(subj) && nrm(a.topic) === nrm(topic));
  // A topic's lessons: its tree-linked assets (published + visible here) when it
  // has any; otherwise the tag match. quiz_ids = quizzes linked to that topic.
  const lessonsForTopic = (cls, subj, t) => {
    const explicit = (t.ar_assets || []).map(x => x && x.id).filter(Boolean);
    const list = explicit.length ? explicit.map(id => byId.get(id)).filter(Boolean) : tagMatched(cls, subj, t.topic);
    const quizIds = (t.quizzes || []).map(q => q && q.id).filter(Boolean);
    return list.map(a => toLesson(a, quizIds));
  };
  const lessonsFor = (cls, subj, topic) => tagMatched(cls, subj, topic).map(a => toLesson(a, []));
  const toLesson = (a, quizIds) => ({ id: a.id, title: a.title || a.topic || a.id, quiz_ids: quizIds,
                 flutter_url: a.flutter_url || null, native_url: a.native_url || null,
                 audio_url: a.audio_url || null,
                 // Multi-language narration { lang: url } + AAC fallback — the
                 // app reads these; they were never sent, so only the single
                 // audio_url ever played.
                 audios: a.audios || {}, audios_aac: a.audios_aac || {},
                 mind_url: a.mind_url || null, video_url: a.video_url || null,
                 chroma_enabled: a.chroma_enabled === true, chroma_color: a.chroma_color || null,
                 ar_mode: a.ar_mode || null });
  // Build the class/subject/topic tree from the saved hierarchy when one exists.
  let classes = structure.map(c => ({
    class_name: c.class_name,
    subjects: (c.subjects || []).map(sj => ({
      subject: sj.subject,
      topics: (sj.topics || []).map(t => ({
        topic: t.topic,
        ar_lessons: lessonsForTopic(c.class_name, sj.subject, t),
      })),
    })),
  }));

  // ── Auto-derive the tree from published assets when the hierarchy is missing/
  // empty, OR append any published asset whose class/subject/topic the saved
  // hierarchy doesn't yet cover. A state needs NO manual curriculum setup for
  // its content to reach students — the dashboard self-heals. ─────────────────
  const covered = new Set();
  for (const c of classes)
    for (const sj of c.subjects)
      for (const t of sj.topics)
        covered.add(nrm(c.class_name) + '|' + nrm(sj.subject) + '|' + nrm(t.topic));

  const tree = {};
  for (const a of assets) {
    if (placed.has(a.id)) continue; // already placed by a tree link
    const cls = (a.class_name || '').trim();
    const subj = (a.subject || '').trim();
    const top = (a.topic || '').trim();
    if (!cls || !subj || !top) continue;
    if (covered.has(nrm(cls) + '|' + nrm(subj) + '|' + nrm(top))) continue;
    tree[cls] = tree[cls] || {};
    tree[cls][subj] = tree[cls][subj] || new Set();
    tree[cls][subj].add(top);
  }

  for (const [cls, subjects] of Object.entries(tree)) {
    let classNode = classes.find(c => nrm(c.class_name) === nrm(cls));
    if (!classNode) { classNode = { class_name: cls, subjects: [] }; classes.push(classNode); }
    for (const [subj, topics] of Object.entries(subjects)) {
      let subjNode = classNode.subjects.find(s => nrm(s.subject) === nrm(subj));
      if (!subjNode) { subjNode = { subject: subj, topics: [] }; classNode.subjects.push(subjNode); }
      for (const top of topics) {
        if (!subjNode.topics.find(t => nrm(t.topic) === nrm(top))) {
          subjNode.topics.push({ topic: top, ar_lessons: lessonsFor(cls, subj, top) });
        }
      }
    }
  }

  return {
    version: MANIFEST_VERSION,
    state_code: stateCode,
    state_name: stateName || stateCode,
    generated_at: new Date().toISOString(),
    auto_derived: !structure.length,
    classes,
  };
}

// GET /manifest/:state — the app reads this ONCE per launch instead of querying
// several collections. Cached hard; recomputed only if no cached copy exists.
router.get('/manifest/:state', async (req, res) => {
  try {
    const db = getFirestore();
    const stateKey = req.params.state;
    // Serve a stored copy if present (written on publish); else build on demand.
    let manifest = null;
    try {
      const cached = await db.collection('curriculum_manifests').doc(stateKey).get();
      if (cached.exists && cached.data().version === MANIFEST_VERSION) manifest = cached.data();
    } catch (_) {}
    if (!manifest) {
      manifest = await buildStateManifest(db, stateKey, req.query.state_name || stateKey);
      try { await db.collection('curriculum_manifests').doc(stateKey).set(manifest); } catch (_) {}
    }
    res.set('Cache-Control', 'public, max-age=60'); // 1 min — content updates propagate quickly
    res.json(manifest);
  } catch (err) {
    log.error({ err: err.message }, 'manifest build failed');
    res.status(500).json({ error: 'Failed to build manifest' });
  }
});

router.get('/ar-topics', async (req, res) => {
  const db = getFirestore();
  let snap = null;
  try {
    snap = await db.collection('ar_assets').where('status', '==', 'published').limit(200).get();
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load AR topics — showing placeholder content, check this error');
  }
  if (snap && !snap.empty) {
    let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    rows     = visibleInState(rows, req.query.state); // geofence: national + requested state
    // Release control: students only get lessons that have been released for their state.
    if (isAppCaller(req)) rows = rows.filter(r => isReleased(r, req.query.state || req.user.state));
    const data = rows.map(r => ({
      id:         r.id,
      topic:      r.topic      || '',
      class_name: r.class_name || '',
      subject:    r.subject    || '',
      language:   r.language   || 'English',
      status:     r.status     || 'live',
      unity_url:  r.unity_url  || null,
      flutter_url:r.flutter_url|| null,
      mind_url:         r.mind_url         || null,
      audio_url:        r.audio_url        || null,
      audios:           r.audios           || {},
      audios_aac:       r.audios_aac       || {},
      target_image_url: r.target_image_url || null,
      video_url:        r.video_url        || null,
      chroma_enabled:   r.chroma_enabled   === true,
      chroma_color:     r.chroma_color     || null,
      ar_mode:          r.ar_mode          || null,
    }));
    // Rule 3 — "coming soon" teasers: append up to 5 scheduled (not-yet-live)
    // topics for this state so the app can show them greyed/locked, keeping
    // the student's interest alive. Name + lock only (no date exposed).
    try {
      let sSnap = await db.collection('ar_assets').where('status', '==', 'scheduled').limit(100).get();
      let srows = sSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      srows = visibleInState(srows, req.query.state);

      // On-read lazy auto-publish (zero scheduler, zero idle cost): any
      // scheduled topic whose reveal_date has passed is flipped to published
      // inside this request, so it goes live the next time the list is read.
      const now = Date.now();
      const revMs = (v) => (v && typeof v.toDate === 'function') ? v.toDate().getTime() : (v ? new Date(v).getTime() : null);
      const dueNow = srows.filter(r => { const t = revMs(r.reveal_date); return t != null && t <= now; });
      if (dueNow.length) {
        const batch = db.batch();
        for (const r of dueNow) {
          batch.update(db.collection('ar_assets').doc(r.id), { status: 'published', updated_at: new Date(), auto_published_at: new Date() });
        }
        await batch.commit();
        const dueIds = new Set(dueNow.map(r => r.id));
        srows = srows.filter(r => !dueIds.has(r.id));
        for (const r of dueNow) data.push({ ...r, status: 'published' });
      }

      const teasers = srows.slice(0, 5).map(r => ({
        id: r.id,
        topic: r.topic || '',
        class_name: r.class_name || '',
        subject: r.subject || '',
        language: r.language || 'English',
        status: 'scheduled',
        locked: true, // the app greys these and blocks opening them
      }));
      data.push(...teasers);
    } catch (_) {/* teasers are best-effort; never fail the main list */}
    // The app reads res.data['data'] — it was getting a bare array, so it always
    // fell back to its built-in demo list.
    return res.json({ data, total: data.length, territory_supported: true });
  }
  // No published AR assets yet — empty list. territory_supported tells the app
  // whether to say "coming soon" (true) or "not in your area yet" (false).
  const territory_supported = await _territorySupported(db, req.query.state);
  res.json({ data: [], total: 0, territory_supported });
});

// ── Learning rules (dashboard-configurable) ─────────────────────────────────
// Serves the app's learning gates: ar_watch_threshold (% of AR narration a
// student must hear before the quiz unlocks). Stored in curriculum_settings.
router.get('/learning-settings', async (req, res) => {
  try {
    const db = getFirestore();
    const doc = await db.collection('curriculum_settings').doc('rules').get();
    const d = doc.exists ? doc.data() : {};
    const n = Number(d.ar_watch_threshold);
    res.json({ ar_watch_threshold: (n >= 1 && n <= 100) ? n : 80 });
  } catch (_) {
    res.json({ ar_watch_threshold: 80 });
  }
});

router.put('/learning-settings', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const db = getFirestore();
    const n = Number(req.body?.ar_watch_threshold);
    if (!(n >= 1 && n <= 100)) return res.status(400).json({ error: 'ar_watch_threshold must be 1–100' });
    await db.collection('curriculum_settings').doc('rules')
      .set({ ar_watch_threshold: n, updated_by: req.user.id, updated_at: new Date() }, { merge: true });
    res.json({ success: true, ar_watch_threshold: n });
  } catch (err) {
    log.error({ err: err.message }, 'Failed to save learning settings');
    res.status(500).json({ error: 'Failed to save learning settings' });
  }
});

// ── State Hierarchy ────────────────────────────────────────────────────────────
router.post('/hierarchy', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const { state_code, structure } = req.body;
    if (!state_code) return res.status(400).json({ error: 'state_code required' });
    if (!canAccessState(req, req.body.state_name || state_code) && !canAccessState(req, state_code)) {
      return res.status(403).json({ error: 'Your account cannot edit this state\'s curriculum.' });
    }
    if (!Array.isArray(structure)) return res.status(400).json({ error: 'structure must be a list' });
    const db = getFirestore();
    await db.collection('curriculum_hierarchy').doc(state_code).set({ state_code, state_name: req.body.state_name || state_code, structure, updated_by: req.user?.id, updated_at: new Date() }, { merge: true });
    // Rebuild this state's cached manifest so the app's next read is instant and DB-free.
    try {
      const manifest = await buildStateManifest(db, state_code, req.body.state_name || state_code);
      await db.collection('curriculum_manifests').doc(state_code).set(manifest);
    } catch (e) { log.error({ err: e.message }, 'manifest regen after save failed (non-fatal)'); }
    res.json({ success: true, message: 'Hierarchy saved', state_code });
  } catch (err) {
    log.error({ err: err.message }, 'Failed to save curriculum hierarchy');
    res.status(500).json({ error: 'Failed to save hierarchy' });
  }
});

// ── Auto-match AR assets to curriculum topics by their tags ──────────────────
// An uploaded AR asset already carries class_name / subject / topic / target_states.
// We attach each live (non-app) asset to the matching topic in that state so the
// Curriculum page shows it automatically — no manual linking table needed.
const _norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
function _assetTargetsState(a, stateName, stateCode) {
  const ts = Array.isArray(a.target_states) ? a.target_states : [];
  if (!ts.length) return true;                       // national asset → every state
  const want = new Set([_norm(stateName), _norm(stateCode)]);
  return ts.some(t => want.has(_norm(t)));
}

// ── GET /hierarchy ─── every saved state (the Curriculum page loads this) ────
router.get('/hierarchy', async (req, res) => {
  try {
    const db = getFirestore();
    const snap = await db.collection('curriculum_hierarchy').get();

    // Load all AR assets once and index them by class|subject|topic for fast lookup.
    let assets = [];
    try {
      const aSnap = await db.collection('ar_assets').limit(1000).get();
      assets = aSnap.docs.map(d => ({ id: d.id, ...d.data() }))
                         .filter(a => a.status !== 'archived');   // archived/deleted never show
    } catch (e) { log.error({ err: e.message }, 'hierarchy: AR asset load failed (topics will show without assets)'); }

    const data = snap.docs.map(d => d.data())
      .filter(h => Array.isArray(h.structure) && h.structure.length)
      .filter(h => canAccessState(req, h.state_name || h.state_code) || canAccessState(req, h.state_code))
      .map(h => {
        const stateName = h.state_name || h.state_code;
        const structure = (h.structure || []).map(c => ({
          ...c,
          subjects: (c.subjects || []).map(sj => ({
            ...sj,
            topics: (sj.topics || []).map(t => {
              const matched = assets.filter(a =>
                _assetTargetsState(a, stateName, h.state_code) &&
                _norm(a.class_name) === _norm(c.class_name) &&
                _norm(a.subject)    === _norm(sj.subject) &&
                _norm(a.topic)      === _norm(t.topic)
              ).map(a => ({ id: a.id, title: a.title || a.original_name || a.topic || a.id, status: a.status || 'uploaded' }));
              // ar_assets = what the admin linked (saved). ar_auto = tag matches
              // NOT linked: shown in the app only while the topic has no links.
              // (They used to be merged into ar_assets, so ✕ never stuck.)
              const ar_assets = Array.isArray(t.ar_assets) ? t.ar_assets : [];
              const seen = new Set(ar_assets.map(x => x && x.id));
              const ar_auto = matched.filter(m => !seen.has(m.id));
              return { ...t, ar_assets, ar_auto, auto_live: ar_assets.length === 0 };
            }),
          })),
        }));
        return { state_code: h.state_code, state_name: stateName, structure,
                 updated_at: h.updated_at && h.updated_at.toDate ? h.updated_at.toDate().toISOString() : null };
      });
    res.json({ data, total: data.length });
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load curriculum hierarchies');
    res.status(500).json({ error: 'Failed to load curriculum' });
  }
});

router.get('/hierarchy/:stateCode', async (req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('curriculum_hierarchy').doc(req.params.stateCode).get();
    res.json(doc.exists ? doc.data().structure : []);
  } catch { res.json([]); }
});

// ── Topic picker + tree helpers (AR upload form, Narration Studio) ──────────
// Find (or create) class → subject → topic in a saved structure.
function _ensureTopic(structure, cls, subj, topic, create) {
  let c = structure.find(x => _norm(x.class_name) === _norm(cls));
  if (!c) { if (!create) return null; c = { class_name: cls, subjects: [] }; structure.push(c); }
  c.subjects = c.subjects || [];
  let sj = c.subjects.find(x => _norm(x.subject) === _norm(subj));
  if (!sj) { if (!create) return null; sj = { subject: subj, topics: [] }; c.subjects.push(sj); }
  sj.topics = sj.topics || [];
  let t = sj.topics.find(x => _norm(x.topic) === _norm(topic));
  if (!t) { if (!create) return null; t = { topic: String(topic).trim(), ar_assets: [], quizzes: [] }; sj.topics.push(t); }
  return t;
}
const _stateMatch = (h, wanted) => {
  const mine = new Set([...stateAliases(h.state_name || ''), ...stateAliases(h.state_code || '')]);
  return wanted.some(w => [...stateAliases(w)].some(a => mine.has(a)));
};
async function _saveHierarchyAndManifest(db, h, structure, userId) {
  await db.collection('curriculum_hierarchy').doc(h.state_code).set(
    { structure, updated_by: userId || null, updated_at: new Date() }, { merge: true });
  try {
    const manifest = await buildStateManifest(db, h.state_code, h.state_name || h.state_code);
    await db.collection('curriculum_manifests').doc(h.state_code).set(manifest);
  } catch (e) { log.error({ err: e.message }, 'manifest regen failed (non-fatal)'); }
}
const _canTouchCurriculum = (req, res, next) =>
  (req.user && (req.user.perm_edit_curriculum || req.user.perm_upload_unity || req.user.role === 'master_admin'))
    ? next() : res.status(403).json({ error: 'Forbidden' });

// GET /topics?class_name=&subject=&states=GJ,Maharashtra
// Topics of that class + subject from the saved Curriculum tree (only the given
// states when passed). → { data: [{ topic, states: [names] }] }
router.get('/topics', async (req, res) => {
  try {
    const cls = String(req.query.class_name || ''), subj = String(req.query.subject || '');
    if (!cls || !subj) return res.json({ data: [] });
    const wanted = String(req.query.states || '').split(',').map(s => s.trim()).filter(Boolean);
    const db = getFirestore();
    const snap = await db.collection('curriculum_hierarchy').get();
    const byTopic = new Map();
    snap.docs.forEach(d => {
      const h = d.data() || {};
      if (wanted.length && !_stateMatch(h, wanted)) return;
      const stateName = h.state_name || h.state_code;
      (h.structure || []).forEach(c => {
        if (_norm(c.class_name) !== _norm(cls)) return;
        (c.subjects || []).forEach(sj => {
          if (_norm(sj.subject) !== _norm(subj)) return;
          (sj.topics || []).forEach(t => {
            const k = _norm(t.topic);
            if (!k) return;
            const e = byTopic.get(k) || { topic: String(t.topic).trim(), states: [] };
            if (!e.states.includes(stateName)) e.states.push(stateName);
            byTopic.set(k, e);
          });
        });
      });
    });
    res.json({ data: [...byTopic.values()].sort((a, b) => a.topic.localeCompare(b.topic)) });
  } catch (e) { res.status(500).json({ error: 'Failed to load topics', detail: e.message }); }
});

// POST /topics { states:[codes|names], class_name, subject, topic }
// "+ New topic" from the upload form / Studio: adds it to each state's tree.
router.post('/topics', _canTouchCurriculum, async (req, res) => {
  try {
    const b = req.body || {};
    const topic = String(b.topic || '').trim();
    const states = Array.isArray(b.states) ? b.states.filter(Boolean) : [];
    if (!b.class_name || !b.subject || !topic) return res.status(400).json({ error: 'class_name, subject and topic are required' });
    if (!states.length) return res.status(400).json({ error: 'Pick at least one state — topics live in a state\'s curriculum tree' });
    const db = getFirestore();
    const snap = await db.collection('curriculum_hierarchy').get();
    const added = [], skipped = [];
    for (const want of states) {
      let doc = snap.docs.find(d => _stateMatch(d.data() || {}, [want]));
      let h = doc ? doc.data() : null;
      if (!h) { // state has no tree yet → start one keyed by its code
        const code = [...stateAliases(want)].find(a => a.length === 2) || String(want);
        h = { state_code: code.toUpperCase(), state_name: want.length > 2 ? want : code.toUpperCase(), structure: [] };
      }
      if (!canAccessState(req, h.state_name || h.state_code) && !canAccessState(req, h.state_code)) { skipped.push(want); continue; }
      const structure = Array.isArray(h.structure) ? h.structure : [];
      _ensureTopic(structure, b.class_name, b.subject, topic, true);
      if (!doc) await db.collection('curriculum_hierarchy').doc(h.state_code).set({ state_code: h.state_code, state_name: h.state_name }, { merge: true });
      await _saveHierarchyAndManifest(db, h, structure, req.user && req.user.id);
      added.push(h.state_name || h.state_code);
    }
    res.json({ message: 'Topic added', topic, added, skipped });
  } catch (e) { res.status(500).json({ error: 'Failed to add topic', detail: e.message }); }
});

// POST /apply-asset { asset_id } — "Save & Apply to Curriculum": link the asset
// to its tagged topic in the tree. State-targeted assets: each target state
// (topic created if missing). National assets: every state whose tree already
// has that class → subject → topic (nothing is created).
router.post('/apply-asset', _canTouchCurriculum, async (req, res) => {
  try {
    const db = getFirestore();
    const aDoc = await db.collection('ar_assets').doc(String((req.body || {}).asset_id || '')).get();
    if (!aDoc.exists) return res.status(404).json({ error: 'AR asset not found' });
    const a = { id: aDoc.id, ...aDoc.data() };
    if (!a.class_name || !a.subject || !a.topic) return res.status(400).json({ error: 'Asset needs Class, Subject and Topic tags' });
    const targets = Array.isArray(a.target_states) ? a.target_states.filter(Boolean) : [];
    const snap = await db.collection('curriculum_hierarchy').get();
    const linked = [];
    for (const d of snap.docs) {
      const h = d.data() || {};
      if (targets.length && !_stateMatch(h, targets)) continue;
      if (!canAccessState(req, h.state_name || h.state_code) && !canAccessState(req, h.state_code)) continue;
      const structure = Array.isArray(h.structure) ? h.structure : [];
      const t = _ensureTopic(structure, a.class_name, a.subject, a.topic, targets.length > 0);
      if (!t) continue;
      t.ar_assets = Array.isArray(t.ar_assets) ? t.ar_assets : [];
      if (!t.ar_assets.some(x => x && x.id === a.id)) t.ar_assets.push({ id: a.id, title: a.title || a.topic || a.id });
      await _saveHierarchyAndManifest(db, h, structure, req.user && req.user.id);
      linked.push(h.state_name || h.state_code);
    }
    res.json({ message: linked.length ? 'Linked in the curriculum tree' : 'No matching topic in any state tree', linked });
  } catch (e) { res.status(500).json({ error: 'Apply failed', detail: e.message }); }
});

// GET /asset-links-summary → { asset_id: { topics: n, states: [names] } }
// (tree links per asset — the AR list's "🌳 linked" badge)
router.get('/asset-links-summary', async (req, res) => {
  try {
    const db = getFirestore();
    const snap = await db.collection('curriculum_hierarchy').get();
    const out = {};
    snap.docs.forEach(d => {
      const h = d.data() || {};
      (h.structure || []).forEach(c => (c.subjects || []).forEach(sj => (sj.topics || []).forEach(t =>
        (t.ar_assets || []).forEach(x => {
          if (!x || !x.id) return;
          const e = out[x.id] || (out[x.id] = { topics: 0, states: [] });
          e.topics++;
          const sn = h.state_name || h.state_code;
          if (!e.states.includes(sn)) e.states.push(sn);
        }))));
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'Failed', detail: e.message }); }
});

// ── Export ──────────────────────────────────────────────────────────────────────
router.get('/export', requirePerm('perm_export_data'), async (req, res) => {
  res.json({ data: [], total: 0, exported_at: new Date().toISOString() });
});

// ── Quiz Links ──────────────────────────────────────────────────────────────────
router.post('/quiz-links', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const { node_id, quiz_id } = req.body;
    if (!node_id || !quiz_id) return res.status(400).json({ error: 'node_id and quiz_id required' });
    const db  = getFirestore();
    const id  = uuidv4();
    const doc = { id, node_id, quiz_id, created_by: req.user.id, created_at: new Date() };
    await db.collection('curriculum_quiz_links').doc(id).set(doc);
    res.status(201).json({ message: 'Quiz linked', link: doc });
  } catch (_) {
    res.status(500).json({ error: 'Failed to link quiz' });
  }
});

router.delete('/quiz-links/:id', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('curriculum_quiz_links').doc(req.params.id).delete();
    res.json({ message: 'Quiz link removed' });
  } catch (_) {
    res.status(500).json({ error: 'Failed to remove quiz link' });
  }
});

router.get('/quiz-links/:nodeId', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('curriculum_quiz_links')
      .where('node_id', '==', req.params.nodeId).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (_) {
    res.json([]);
  }
});

// ── AR Links ────────────────────────────────────────────────────────────────────
router.post('/ar-links', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const { curriculum_node_id, asset_id } = req.body;
    if (!curriculum_node_id || !asset_id) return res.status(400).json({ error: 'curriculum_node_id and asset_id required' });
    const db  = getFirestore();
    const id  = uuidv4();
    const doc = { id, curriculum_node_id, asset_id, created_by: req.user.id, created_at: new Date() };
    await db.collection('curriculum_ar_links').doc(id).set(doc);
    res.status(201).json({ message: 'AR asset linked', link: doc });
  } catch (_) {
    res.status(500).json({ error: 'Failed to link AR asset' });
  }
});

router.delete('/ar-links/:id', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('curriculum_ar_links').doc(req.params.id).delete();
    res.json({ message: 'AR link removed' });
  } catch (_) {
    res.status(500).json({ error: 'Failed to remove AR link' });
  }
});

router.get('/ar-links/:nodeId', async (req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('curriculum_ar_links')
      .where('curriculum_node_id', '==', req.params.nodeId).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (_) {
    res.json([]);
  }
});

// ── Content Schedule (Time-Lock Mechanism) ────────────────────────────────────
// The PDF architecture: the Flutter app downloads the full term schedule once.
// It checks the local clock against unlocks_at timestamps — no server ping needed.
// Dashboard admins POST the schedule; the app GETs it on first launch per term.

router.post('/schedule', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    // Body: { term, state_code, entries: [{ topic_id, class_name, subject, unlocks_at }] }
    const { term, state_code, entries } = req.body;
    if (!term || !Array.isArray(entries)) {
      return res.status(400).json({ error: 'term and entries[] required' });
    }
    const db  = getFirestore();
    const key = `${state_code || 'ALL'}_${term}`;
    await db.collection('content_schedules').doc(key).set({
      term, state_code: state_code || 'ALL', entries,
      published_by: req.user.id, published_at: new Date(),
    }, { merge: true });
    res.json({ success: true, key, entry_count: entries.length });
  } catch (err) {
    res.status(500).json({ error: 'Schedule save failed', detail: err.message });
  }
});

// GET /schedule/:stateCode/:term — Flutter app downloads this on first launch
router.get('/schedule/:stateCode/:term', async (req, res) => {
  try {
    const db  = getFirestore();
    const key = `${req.params.stateCode}_${req.params.term}`;
    const doc = await db.collection('content_schedules').doc(key).get();
    if (!doc.exists) {
      // Try the ALL fallback
      const fallback = await db.collection('content_schedules').doc(`ALL_${req.params.term}`).get();
      if (!fallback.exists) return res.json({ entries: [], term: req.params.term });
      return res.json(fallback.data());
    }
    res.json(doc.data());
  } catch (_) {
    res.json({ entries: [], term: req.params.term });
  }
});

module.exports = router;
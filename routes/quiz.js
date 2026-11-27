// ═══════════════════════════════════════════════════════════════════════
// routes/quiz.js — Quiz management
// Quizzes are stored in and served from Firestore.
// ═══════════════════════════════════════════════════════════════════════
'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { getFirestore } = require('../lib/firebase');
const { authenticate, requirePerm } = require('../middleware/auth');
// Student/teacher app tokens pass authenticate(); block them from staff-only routes.
const staffOnly = (req, res, next) => (['student', 'teacher'].includes(req.user?.role)
  ? res.status(403).json({ error: 'Dashboard staff only' }) : next());
const { visibleInState, parseTargetStates, canTouchTargets, scopedTargets, guardTargets, scopeState } = require('../lib/stateScope');
const { toName, sameState, unknownStates, UNKNOWN_STATE_MSG } = require('../lib/states');
const { isAppCaller, isReleased, cleanRelease, mergeStateRelease } = require('../lib/release');
const { stateScope, studentState, allowedQuizzes } = require('../lib/contentScope');
const { stripFields } = require('../lib/writeGuard');
const LIVE_STATUSES = new Set(['live', 'published']);
const log = require('../lib/logger');
const bhashini = require('../lib/bhashini');
const multer = require('multer');
const storage = require('../lib/storage');

// ── Question rounds ──────────────────────────────────────────────────────────
// A question is a normal MCQ unless `type` says otherwise:
//   picture  → options are captions (may be blank); option_images[i] is the
//              picture for option i; optional question_image. 2–4 options.
//   sequence → options are the steps in the RIGHT order (3–6); the app shuffles
//              them. correct_answer_index is always 0 (= the right order).
// Pictures are uploaded through POST /image and served like AR files.
// Express 4 doesn't catch a rejected async handler: the request would hang
// until the 60 s Hosting timeout. caught() hands the error to server.js's
// error handler, which answers with a JSON 500.
const caught = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const ROUND_TYPES = new Set(['picture', 'sequence']);
const QUIZ_IMG_RE = /^quizimg_[0-9a-f-]{36}\.(jpg|png|webp)$/;
const quizImgUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });
function cleanQuizImg(u) {
  const s = String(u || '').trim();
  const name = s.split('/').pop();
  if (!QUIZ_IMG_RE.test(name)) return '';
  if (s === `/api/ar/file/${name}`) return s;
  const pub = process.env.R2_PUBLIC_URL;
  if (pub && s === `${pub}/ar_assets/${name}`) return s;
  return '';
}
// Round fields to store with a question ({} for a plain MCQ). Throws a
// readable error when a round is incomplete.
function roundFields(q, n) {
  const type = ROUND_TYPES.has(q.type) ? q.type : null;
  if (!type) return {};
  const opts = Array.isArray(q.options) ? q.options.map(o => String(o ?? '').trim()) : [];
  if (type === 'sequence') {
    if (opts.length < 3 || opts.length > 6 || opts.some(o => !o)) {
      throw new Error(`Question ${n}: a sequence round needs 3 to 6 filled steps`);
    }
    return { type };
  }
  const imgs = (Array.isArray(q.option_images) ? q.option_images : []).map(cleanQuizImg);
  if (imgs.length < 2 || imgs.length > 4 || imgs.some(u => !u) || imgs.length !== opts.length) {
    throw new Error(`Question ${n}: a picture round needs 2 to 4 pictures, one per option`);
  }
  const out = { type, option_images: imgs };
  const qi = cleanQuizImg(q.question_image);
  if (qi) out.question_image = qi;
  return out;
}

// The 22 scheduled languages (+ common names). A quiz whose SUBJECT is one of
// these is a language lesson → never auto-translated (stays single-language).
const LANGUAGE_SUBJECTS = new Set([
  'english','hindi','bengali','bangla','gujarati','marathi','tamil','telugu','kannada',
  'malayalam','punjabi','odia','oriya','assamese','urdu','sanskrit','sindhi','nepali',
  'konkani','manipuri','meitei','bodo','santhali','santali','dogri','kashmiri','maithili',
  'grammar','language','languages','mother tongue','first language','second language','third language',
]);
function isLanguageSubject(subject) {
  return LANGUAGE_SUBJECTS.has(String(subject || '').trim().toLowerCase());
}
// Map a language display name → Bhashini code (extend as needed).
const LANG_NAME_TO_CODE = {
  english:'en', hindi:'hi', bengali:'bn', bangla:'bn', gujarati:'gu', marathi:'mr',
  tamil:'ta', telugu:'te', kannada:'kn', malayalam:'ml', punjabi:'pa', odia:'or', oriya:'or',
  assamese:'as', urdu:'ur', sanskrit:'sa', nepali:'ne', konkani:'kok', manipuri:'mni',
  bodo:'brx', santhali:'sat', santali:'sat', dogri:'doi', kashmiri:'ks', maithili:'mai', sindhi:'sd',
};
// "English" / "EN" / "en" → "en". Quizzes store the code; the dashboard shows the name.
function _langCode(v) {
  const s = String(v || '').trim().toLowerCase();
  return LANG_NAME_TO_CODE[s] || s;
}
// Kept exactly as written: {placeholders}, $maths$, codes like H2O, ALL-CAPS
// words (DNA) and numbers with a unit (5 kg, 37 °C). Plain numbers go to
// Bhashini as they are (it keeps digits). The old hidden-marker trick lost the
// numbers: Bhashini drops the invisible characters, so "Class 9" came back as
// "Class 0" and an option "206" as "0".
const _KEEP_RE = /(\{[^}]+\}|\$[^$]+\$|\b[A-Za-z]+\d[A-Za-z\d]*\b|\b[A-Z]{2,}\b|\d+(?:[.,]\d+)?\s?(?:%|kg|mg|km|cm|mm|ml|g|m|l|°[CF]?)(?![A-Za-z]))/g;
const _KEEP_ALL_RE = /(\{[^}]+\}|\$[^$]+\$|\b[A-Za-z]+\d[A-Za-z\d]*\b|\b[A-Z]{2,}\b|\d+(?:[.,]\d+)?(?:\s?(?:%|kg|mg|km|cm|mm|ml|g|m|l|°[CF]?)(?![A-Za-z]))?)/g;
const _numSig = (t) => (String(t).match(/\d+(?:[.,]\d+)?/g) || []).sort().join('|');
const _mark = (k) => `QZX${String.fromCharCode(65 + k)}XZQ`;
async function _tr(text, src, tgt) {
  const s = String(text || '');
  if (!s.trim()) return s;
  // Nothing but numbers / units / symbols (an option like "206"): keep as is.
  if (!/\p{L}/u.test(s.replace(_KEEP_ALL_RE, ''))) return s;
  const keep = s.match(_KEEP_RE) || [];
  if (keep.length <= 26) {
    let i = 0;
    const out = String(await bhashini.translate(keep.length ? s.replace(_KEEP_RE, () => _mark(i++)) : s, src, tgt) || '');
    if (out && keep.every((_, k) => out.split(_mark(k)).length === 2)) {
      const back = keep.reduce((t, tok, k) => t.replace(_mark(k), () => tok), out);
      if (_numSig(back) === _numSig(s)) return back;   // every number came back unchanged
    }
  }
  // Fallback: send only the words between the kept parts (numbers kept too).
  const parts = s.split(_KEEP_ALL_RE);
  const done = [];
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (k % 2 === 1 || !/\p{L}/u.test(p)) { done.push(p); continue; }
    const lead = p.match(/^\s*/)[0], trail = p.match(/\s*$/)[0];
    done.push(lead + (String(await bhashini.translate(p.trim(), src, tgt) || '') || p.trim()) + trail);
  }
  return done.join('');
}
// Translations add quiz ids the app's cached curriculum doesn't know yet:
// drop the cached copies so the next app read rebuilds them.
async function _dropManifests(db) {
  try {
    const snap = await db.collection('curriculum_manifests').get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  } catch (e) { log.warn({ err: e.message }, 'manifest refresh after translate failed'); }
}
router.use((req, res, next) => {
  // Cloud Scheduler calls /dispatch-scheduled with a shared secret (no user token).
  if (req.path === '/dispatch-scheduled' &&
      process.env.DISPATCH_SECRET &&
      req.get('x-cron-secret') === process.env.DISPATCH_SECRET) {
    req.user = { id: 'cloud-scheduler', role: 'master_admin' };
    return next();
  }
  return authenticate(req, res, next);
});

router.get('/', async (req, res) => {
  try {
    const db = getFirestore();
    // Was .limit(50) over every quiz: once there were more than 50, the rest
    // never reached the app or the Curriculum Map. Students only need live ones.
    const base = db.collection('quizzes');
    const snap = await (isAppCaller(req)
      ? base.where('status', 'in', [...LIVE_STATUSES]).limit(1000)
      : base.limit(1000)).get();
    let rows = snap.docs.map(d => {
      const q = { id: d.id, ...d.data() };
      if (q.language) q.language = _langCode(q.language); // older quizzes say "English"
      return q;
    });
    if (isAppCaller(req)) {
      // Students: their OWN state only, while it is open, quizzes on its
      // Curriculum Map (linked, or for a class it has), live and released for it.
      // (An All-India quiz used to show in every state with that class name —
      // even states without that class or still locked — and with no state
      // sent, every state's quizzes came back.)
      const scope = await stateScope(db, studentState(req, req.query.state));
      rows = allowedQuizzes(rows, scope, LIVE_STATUSES).map(q => ({ ...q, status: 'live' }));
    } else {
      rows = visibleInState(rows, req.query.state); // geofence: national + requested state
    }
    return res.json({ data: rows, total: rows.length });
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load quizzes');
    res.status(500).json({ error: 'Failed to load quizzes' });
  }
});

// A student may open only a quiz their state's list would show them (drafts
// and other states' quizzes used to open by id). Translations count as one.
async function appMayOpenQuiz(db, req, q) {
  const scope = await stateScope(db, studentState(req, req.query.state));
  let rows = [q];
  if (q.translation_group) {
    const sib = await db.collection('quizzes').where('translation_group', '==', q.translation_group).limit(50).get();
    rows = sib.docs.map(d => ({ id: d.id, ...d.data() }));
    if (!rows.some(r => r.id === q.id)) rows.push(q);
  }
  return allowedQuizzes(rows, scope, LIVE_STATUSES).some(r => r.id === q.id);
}

router.get('/:id', async (req, res, next) => {
  // '/:id' is declared before '/analytics', '/template' and '/pack', so Express
  // sent those requests here and answered 404 "Quiz not found". Hand them on.
  if (req.params.id === 'analytics' || req.params.id === 'template' ||
      req.params.id === 'pack') return next();
  try {
    const db  = getFirestore();
    const doc = await db.collection('quizzes').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Quiz not found' });
    const q = { id: doc.id, ...doc.data() };
    if (isAppCaller(req) && !(await appMayOpenQuiz(db, req, q))) {
      return res.status(404).json({ error: 'Quiz not found' });
    }
    return res.json(q);
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load quiz');
    res.status(500).json({ error: 'Failed to load quiz' });
  }
});

// GET /pack/:state — offline quiz pack for the app. Returns every quiz VISIBLE
// and RELEASED for the state, each with its questions inlined, in the shape the
// app's quiz_pack_store expects: { quizzes: [ { id, questions: [...] } ] }.
// This is the endpoint the app calls (QuizAPI.pack); it did not exist before,
// so the app always got an empty pack → "No quiz yet".
router.get('/pack/:state', async (req, res) => {
  try {
    const db = getFirestore();
    const stateRaw = req.params.state === 'ALL' ? '' : req.params.state;
    // Apps that can play picture / sequence rounds send ?rounds=1. Older apps
    // don't, and would show those questions with blank options — skip them.
    const withRounds = req.query.rounds === '1';
    const snap = await db.collection('quizzes').limit(1000).get();
    let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (isAppCaller(req)) {
      // Same rule as the quiz list: the student's own open state only ("ALL"
      // used to download every state's quizzes onto the phone).
      const scope = await stateScope(db, studentState(req, stateRaw));
      rows = allowedQuizzes(rows, scope, LIVE_STATUSES);
    } else {
      // State gate + live + released (same rules as the list endpoint).
      rows = visibleInState(rows, stateRaw)
        .filter(q => LIVE_STATUSES.has(q.status) && isReleased(q, stateRaw || req.user?.state));
    }
    const quizzes = [];
    for (const q of rows) {
      let questions = [];
      try {
        const qs = await db.collection('quizzes').doc(q.id)
          .collection('questions').orderBy('sort_order').get();
        questions = qs.docs.filter(d => withRounds || !ROUND_TYPES.has(d.data().type)).map(d => {
          const x = d.data();
          // Normalise to the app's expected field names.
          const options = Array.isArray(x.options) ? x.options.map(o => String(o ?? '')) : [];
          // The dashboard stores the correct answer as `correct_answer_index`
          // (the individual-quiz creator writes exactly this). Earlier this code
          // only read `correct_index`, which never existed → every question
          // defaulted to 0 (option A). Read every known field, then fall back to
          // a letter answer (A/B/C/D) if that's how it was stored.
          let ci = x.correct_answer_index;
          if (typeof ci !== 'number') ci = x.correct_index;
          if (typeof ci !== 'number') ci = x.correctIndex;
          if (typeof ci !== 'number') {
            const letter = String(x.answer ?? x.correct ?? x.Answer ?? '').trim().toUpperCase();
            const li = ['A', 'B', 'C', 'D'].indexOf(letter);
            ci = li >= 0 ? li : parseInt(ci, 10);
          }
          if (typeof ci !== 'number' || Number.isNaN(ci) || ci < 0) ci = 0;
          // Clamp to the available options so a bad value can't crash the app.
          if (options.length && ci >= options.length) ci = 0;
          const row = {
            question_text: x.question_text || x.text || x.question || '',
            options,
            correct_index: ci,
            explanation: x.explanation || '',
          };
          if (ROUND_TYPES.has(x.type)) {
            row.type = x.type;
            if (x.type === 'sequence') row.correct_index = 0;
            if (Array.isArray(x.option_images)) row.option_images = x.option_images;
            if (x.question_image) row.question_image = x.question_image;
          }
          return row;
        });
      } catch (_) { /* a quiz with no questions subcollection → empty */ }
      quizzes.push({ id: q.id, title: q.title || '', subject: q.subject || '', questions });
    }
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ state: req.params.state, quizzes });
  } catch (err) {
    log.error({ err: err.message }, 'quiz pack build failed');
    res.status(500).json({ error: 'Failed to build quiz pack' });
  }
});

router.get('/:id/questions', async (req, res) => {
  try {
    const db   = getFirestore();
    if (isAppCaller(req)) {
      // Same rule as opening the quiz: the questions of another state's quiz,
      // or of a draft, used to load for anyone who knew its id.
      const doc = await db.collection('quizzes').doc(req.params.id).get();
      if (!doc.exists || !(await appMayOpenQuiz(db, req, { id: doc.id, ...doc.data() }))) {
        return res.status(404).json({ error: 'Quiz not found' });
      }
    }
    const snap = await db.collection('quizzes').doc(req.params.id)
                         .collection('questions').orderBy('sort_order').get();
    return res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load quiz questions');
    res.status(500).json({ error: 'Failed to load questions' });
  }
});

// A state officer changes only quizzes aimed at their own state (edit, publish,
// pause, release, translate, delete). National staff are unaffected.
router.param('id', guardTargets('quizzes'));
const OUT_OF_STATE = (req) => ({ error: `Your account can only manage ${scopeState(req)}.` });

router.post('/', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const db = getFirestore();
    const id = uuidv4();
    const { go_live_immediately, release, ...fields } = req.body || {};
    const tgt = scopedTargets(req, fields.target_states); // state officer → own state
    if (!tgt) return res.status(403).json(OUT_OF_STATE(req));
    fields.target_states = tgt;
    if (fields.language) fields.language = _langCode(fields.language); // "English" → "en"
    const status = go_live_immediately === true ? 'live' : 'draft';
    if (release) fields.release = cleanRelease(release);
    const badStates = unknownStates(parseTargetStates(fields.target_states));
    if (badStates.length) return res.status(400).json({ error: UNKNOWN_STATE_MSG(badStates) });
    await db.collection('quizzes').doc(id).set({ ...fields, target_states: parseTargetStates(fields.target_states), created_by: req.user.id, created_at: new Date(), status, question_count: 0 });
    res.status(201).json({ id, ...fields, status });
  } catch { res.status(500).json({ error: 'Failed to create quiz' }); }
});

// POST /image — one picture for a picture round (the dashboard shrinks it to
// ≤640 px first). Returns { url } to save in option_images / question_image.
router.post('/image', requirePerm('perm_edit_curriculum'), quizImgUpload.single('image'), async (req, res) => {
  try {
    const b = req.file && req.file.buffer;
    if (!b || b.length < 12) return res.status(400).json({ error: 'No picture received' });
    const ext = (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) ? 'jpg'
      : (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') ? 'png'
      : (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') ? 'webp'
      : null;
    if (!ext) return res.status(400).json({ error: 'Use a JPG, PNG or WebP picture' });
    const name = `quizimg_${uuidv4()}.${ext}`;
    const key = `ar_assets/${name}`;
    await storage.putRaw(b, key, { contentType: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` });
    const url = process.env.R2_PUBLIC_URL ? `${process.env.R2_PUBLIC_URL}/${key}` : `/api/ar/file/${name}`;
    res.status(201).json({ url, size: b.length });
  } catch (err) {
    log.error({ err: err.message }, 'quiz image upload failed');
    res.status(500).json({ error: 'Could not save the picture' });
  }
});

router.put('/:id', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const db = getFirestore();
    const safe = stripFields(req.body, [
      'id', 'status', 'release', 'created_by', 'created_at', 'question_count', 'published_at',
    ]);
    // Edits save codes too ("Gujarat" → "GJ"), the same as a new quiz.
    if ('target_states' in safe) safe.target_states = parseTargetStates(safe.target_states);
    if ('target_states' in safe && !canTouchTargets(req, safe.target_states)) return res.status(403).json(OUT_OF_STATE(req));
    if (safe.language) safe.language = _langCode(safe.language);
    const badEdit = unknownStates(safe.target_states || []);
    if (badEdit.length) return res.status(400).json({ error: UNKNOWN_STATE_MSG(badEdit) });
    await db.collection('quizzes').doc(req.params.id).update({ ...safe, updated_at: new Date() });
    res.json({ id: req.params.id, ...safe });
  } catch { res.status(500).json({ error: 'Failed to update quiz' }); }
});

router.delete('/:id', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('quizzes').doc(req.params.id).update({ status: 'archived' });
    res.json({ message: 'Quiz archived' });
  } catch { res.status(500).json({ error: 'Failed to delete quiz' }); }
});

router.post('/attempts/batch', async (req, res) => {
  try {
    const { attempts } = req.body;
    if (!Array.isArray(attempts)) return res.status(400).json({ error: 'attempts array required' });
    // Only the signed-in student's OWN attempts are stored: nobody can post
    // results under another student's id. (The app sends only its own; on a
    // shared phone the others wait until those students sign in.)
    const me = String((req.user && req.user.id) || '');
    const mine = attempts.filter(a => a && typeof a === 'object' && String(a.student_id || '') === me);
    const rejected = attempts.length - mine.length;
    if (rejected) log.warn({ user: me, rejected }, 'quiz attempts for another student rejected');
    const db = getFirestore();
    // A Firestore batch holds at most 500 writes; a phone that was offline a
    // long time could send more, fail every time and retry forever.
    for (let i = 0; i < mine.length; i += 400) {
      const batch = db.batch();
      mine.slice(i, i + 400).forEach(a => {
        const ref = db.collection('quiz_attempts').doc(uuidv4());
        batch.set(ref, { ...a, synced_at: new Date() });
      });
      await batch.commit();
    }
    res.json({ received: true, count: mine.length, rejected });
  } catch (err) {
    res.status(500).json({ error: 'Batch submit failed' });
  }
});

// ── Shared: load quiz attempts once, normalised + filtered ───────────────────
// The app stores raw points (score / max_score) and time_taken_secs; older code
// treated score as a percentage and read a time field that does not exist.
async function loadAttempts(db, q = {}) {
  const [attemptsSnap, quizzesSnap] = await Promise.all([
    db.collection('quiz_attempts').limit(2000).get(),
    db.collection('quizzes').limit(500).get(),
  ]);
  const quizzes = {};
  quizzesSnap.docs.forEach(d => { quizzes[d.id] = { id: d.id, ...d.data() }; });
  const ms = (v) => (v && typeof v.toDate === 'function') ? v.toDate().getTime() : (v ? new Date(v).getTime() : 0);
  const days = parseInt(q.days, 10) || 0;
  const since = days ? Date.now() - days * 86400000 : 0;
  const lc = (v) => String(v || '').trim().toLowerCase();
  const rows = attemptsSnap.docs.map(d => {
    const a = d.data();
    const quiz = quizzes[a.quiz_id] || {};
    const max = Number(a.max_score) || 0;
    const raw = Number(a.score) || 0;
    return {
      quiz_id: a.quiz_id || null, student_id: a.student_id || null,
      pct: max > 0 ? (raw / max) * 100 : raw,
      time_secs: Number(a.time_taken_secs ?? a.time_secs) || 0,
      subject: a.subject || quiz.subject || null,
      class_name: a.class_grade || a.class_name || quiz.class_name || null,
      // One spelling per state, so "by state" has one row per state.
      state: toName(a.state) || a.state || null, district: a.district || null,
      language: a.app_language || a.language || quiz.language || null,
      at: ms(a.completed_at) || ms(a.submitted_at) || ms(a.synced_at),
    };
  }).filter(a =>
    (!since || a.at >= since) &&
    (!q.state || sameState(a.state, q.state)) &&
    (!q.district || lc(a.district) === lc(q.district)) &&
    (!q.class_name || lc(a.class_name) === lc(q.class_name)) &&
    (!q.subject || lc(a.subject) === lc(q.subject)) &&
    (!q.language || lc(a.language) === lc(q.language)));
  return { rows, quizzes };
}
const round1 = (v) => parseFloat((Number(v) || 0).toFixed(1));
function groupBy(rows, key) {
  const m = {};
  rows.forEach(a => {
    const k = a[key]; if (!k) return;
    m[k] = m[k] || { attempts: 0, total: 0, passed: 0 };
    m[k].attempts++; m[k].total += a.pct; if (a.pct >= 40) m[k].passed++;
  });
  return Object.entries(m).map(([k, d]) => ({ [key]: k, attempts: d.attempts,
    avg_score: round1(d.total / d.attempts), pass_rate: round1((d.passed / d.attempts) * 100) }))
    .sort((x, y) => y.attempts - x.attempts);
}

router.get('/analytics/deep', staffOnly, async (req, res) => {
  try {
    const { rows } = await loadAttempts(getFirestore(), { days: req.query.days });
    const total = rows.length;
    if (!total) return res.json({ overview: { total_attempts: 0, avg_score: 0, pass_rate: 0, avg_time_secs: 0 }, by_subject: [], by_state: [], hard_questions: [] });
    res.json({
      overview: {
        total_attempts: total,
        avg_score:      round1(rows.reduce((s, a) => s + a.pct, 0) / total),
        pass_rate:      round1((rows.filter(a => a.pct >= 40).length / total) * 100),
        avg_time_secs:  Math.round(rows.reduce((s, a) => s + a.time_secs, 0) / total),
      },
      by_subject: groupBy(rows, 'subject'),
      by_state:   groupBy(rows, 'state'),
      hard_questions: [],
    });
  } catch (err) {
    log.error({ err: err.message }, 'deep quiz analytics failed');
    res.status(500).json({ error: 'Failed to load quiz insights' });
  }
});

router.post('/attempts', async (req, res) => {
  try {
    // Same rule as /attempts/batch: only your own attempt is stored.
    if (String((req.body && req.body.student_id) || '') !== String((req.user && req.user.id) || '')) {
      return res.status(202).json({ received: false, rejected: 1 });
    }
    const db  = getFirestore();
    const doc = { ...req.body, synced_at: new Date() };
    await db.collection('quiz_attempts').add(doc);
    res.status(202).json({ received: true });
  } catch (_) {
    // Never fail the student app
    res.status(202).json({ received: true, queued: true });
  }
});

// ── POST /:id/publish — Publish a draft quiz ─────────────────────────────────
router.post('/:id/publish', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('quizzes').doc(req.params.id).update({
      status: 'published',
      published_at: new Date(),
      published_by: req.user.id,
    });
    res.json({ success: true, id: req.params.id, status: 'published' });
  } catch (err) {
    res.status(500).json({ error: 'Publish failed', detail: err.message });
  }
});

// ── POST /:id/pause — Pause a live quiz ──────────────────────────────────────
router.post('/:id/pause', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const db = getFirestore();
    await db.collection('quizzes').doc(req.params.id).update({
      status: 'paused',
      paused_at: new Date(),
      paused_by: req.user.id,
    });
    res.json({ success: true, id: req.params.id, status: 'paused' });
  } catch (err) {
    res.status(500).json({ error: 'Pause failed', detail: err.message });
  }
});

// ── POST /:id/schedule — Schedule a quiz to go live at a specific time ────────
// Stores the schedule in Firestore; a cron job or dispatch-scheduled
// endpoint would flip the status to published at the right time.
router.post('/:id/schedule', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const { scheduled_at } = req.body;
    if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at required' });
    // No scheduler needed: the quiz is published now with a release date —
    // students start seeing it from that moment (checked on every app read).
    const release = cleanRelease({ mode: 'date', at: scheduled_at });
    const db = getFirestore();
    await db.collection('quizzes').doc(req.params.id).update({
      status: 'live', release,
      scheduled_at: new Date(scheduled_at),
      scheduled_by: req.user.id,
    });
    res.json({ success: true, id: req.params.id, status: 'live', release, scheduled_at });
  } catch (err) {
    res.status(500).json({ error: 'Schedule failed', detail: err.message });
  }
});

// ── PUT /:id/release-state ─── release in ONE state (Curriculum page) ───────
router.put('/:id/release-state', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const db = getFirestore();
    const ref = db.collection('quizzes').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Quiz not found' });
    const release = cleanRelease(mergeStateRelease(doc.data().release, req.body?.state, req.body?.value));
    await ref.update({ release, release_updated_by: req.user.id, release_updated_at: new Date() });
    res.json({ success: true, id: req.params.id, release });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not save release' });
  }
});

// ── PUT /:id/release ─── when students may see this quiz ─────────────────────
router.put('/:id/release', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const release = cleanRelease(req.body && req.body.release);
    const db = getFirestore();
    const ref = db.collection('quizzes').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ error: 'Quiz not found' });
    await ref.update({ release, release_updated_by: req.user.id, release_updated_at: new Date() });
    await db.collection('audit_log').add({ action: 'quiz_release_set', actor: req.user.id, detail: { quiz_id: req.params.id, release }, created_at: new Date() });
    res.json({ success: true, id: req.params.id, release });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not save release' });
  }
});

// ── POST /bulk-upload — Upload questions from XLSX ────────────────────────────
// Accepts a quiz_id in the body and a pre-uploaded storage key for the xlsx.
// Parses the sheet using the xlsx library already in package.json.
router.post('/bulk-upload', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const { quiz_id, questions } = req.body;
    if (!quiz_id) return res.status(400).json({ error: 'quiz_id required' });
    if (scopeState(req) !== null) { // state officer: only their state's quizzes
      const qd = await getFirestore().collection('quizzes').doc(String(quiz_id)).get();
      if (qd.exists && !canTouchTargets(req, qd.data().target_states)) return res.status(403).json(OUT_OF_STATE(req));
    }
    if (!Array.isArray(questions) || !questions.length) {
      return res.status(400).json({ error: 'questions array required' });
    }

    let rounds;
    try { rounds = questions.map((q, i) => roundFields(q, i + 1)); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const db    = getFirestore();
    const batch = db.batch();
    questions.forEach((q, i) => {
      const ref = db.collection('quizzes').doc(quiz_id).collection('questions').doc();
      batch.set(ref, {
        question_text:         q.question_text         || q.Question       || '',
        options:               q.options               || [q.A, q.B, q.C, q.D].filter(Boolean),
        correct_answer_index:  rounds[i].type === 'sequence' ? 0
          : (q.correct_answer_index  ?? (q.Answer ? ['A','B','C','D'].indexOf(q.Answer) : 0)),
        explanation:           q.explanation           || q.Explanation    || '',
        sort_order:            q.sort_order            ?? i,
        ...rounds[i],
        created_at:            new Date(),
      });
    });
    await batch.commit();

    // Update question count on the parent quiz
    await db.collection('quizzes').doc(quiz_id).update({ question_count: questions.length });

    res.json({ success: true, uploaded: questions.length, quiz_id });
  } catch (err) {
    res.status(500).json({ error: 'Bulk upload failed', detail: err.message });
  }
});

// ── POST /bulk-upload-grouped — one flat sheet → many quizzes ────────────────
// body: { rows: [ {Class,Subject,Topic,State,"Source Language",question_text,Type,A..F,Answer,Explanation,_row}, ...] }
// Groups rows by Class + Subject + Topic(normalized) + State → one quiz each.
// Type: MCQ (default) → A–D + Answer. Sequence → 3–6 steps in A–F in the right
// order, no Answer. Unusable rows are skipped and returned in `skipped`.
router.post('/bulk-upload-grouped', requirePerm('perm_edit_curriculum'), caught(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'No rows' });
  const db = getFirestore();
  const normTopic = (t) => String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const groups = new Map();
  const skipped = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNo = Number(r._row) || i + 2;
    const skip = (reason) => { skipped.push({ row: rowNo, reason }); };
    const cls = String(r.class || r.Class || '').trim();
    const subj = String(r.subject || r.Subject || '').trim();
    const topic = String(r.topic || r.Topic || '').trim();
    const state = String(r.state || r.State || '').trim() || 'All India';
    const qtext = String(r.question_text || r.Question || '').trim();
    if (!cls || !subj || !topic || !qtext) { skip('Class, Subject, Topic and question_text are required'); continue; }
    const isSeq = /^seq/i.test(String(r.type || r.Type || '').trim());
    const cell = (k) => String(r[k] ?? '').trim();
    let q;
    if (isSeq) {
      const steps = ['A','B','C','D','E','F'].map(cell).filter(Boolean);
      if (steps.length < 3) { skip('A sequence needs at least 3 steps in A–F'); continue; }
      q = { type: 'sequence', question_text: qtext, options: steps, correct_answer_index: 0 };
    } else {
      const options = ['A','B','C','D'].map(cell);
      const ans = ['A','B','C','D'].indexOf(String(r.answer || r.Answer || '').trim().toUpperCase());
      if (options.filter(Boolean).length < 2) { skip('An MCQ needs at least 2 options'); continue; }
      if (ans < 0) { skip('Answer must be A, B, C or D'); continue; }
      if (!options[ans]) { skip(`Answer ${'ABCD'[ans]} points to an empty option`); continue; }
      // Drop empty options, keeping the answer on the same option.
      const kept = options.map((o, k) => ({ o, k })).filter(x => x.o);
      q = { question_text: qtext, options: kept.map(x => x.o), correct_answer_index: kept.findIndex(x => x.k === ans) };
    }
    q.explanation = String(r.explanation || r.Explanation || '').trim();
    const key = [cls, subj, normTopic(topic), state].join('||');
    if (!groups.has(key)) groups.set(key, {
      class_name: cls, subject: subj, topic, state,
      source_language: _langCode(r.source_language || r['Source Language'] || 'en'),
      questions: [],
    });
    groups.get(key).questions.push(q);
  }
  if (!groups.size) return res.status(400).json({ error: 'No complete rows found', skipped });

  const created = [];
  for (const g of groups.values()) {
    const id = uuidv4();
    const targetStates = /^all india$/i.test(g.state) ? [] : [g.state];
    // Stage 4: a row with a state that is not in the list is skipped, not saved.
    if (unknownStates(targetStates).length) { skipped.push({ reason: UNKNOWN_STATE_MSG(targetStates), topic: g.topic }); continue; }
    if (!canTouchTargets(req, targetStates)) { skipped.push({ reason: OUT_OF_STATE(req).error, topic: g.topic }); continue; }
    await db.collection('quizzes').doc(id).set({
      title: `${g.subject} — ${g.topic} (${g.class_name})`,
      class_name: g.class_name, subject: g.subject, topic: g.topic,
      topic_key: normTopic(g.topic),
      language: g.source_language,
      target_states: parseTargetStates(targetStates),
      status: 'draft', question_count: g.questions.length,
      created_by: req.user.id, created_at: new Date(),
    });
    const batch = db.batch();
    g.questions.forEach((q, i) => {
      const ref = db.collection('quizzes').doc(id).collection('questions').doc();
      batch.set(ref, { ...q, sort_order: i, created_at: new Date() });
    });
    await batch.commit();
    created.push({ quiz_id: id, class: g.class_name, subject: g.subject, topic: g.topic, state: g.state, questions: g.questions.length });
  }
  res.json({ success: true, created_quizzes: created.length, created_questions: created.reduce((s,c)=>s+c.questions,0), quizzes: created, skipped });
}));

// ── POST /:id/translate — NMT a quiz into target languages ────────────────────
// body: { target_langs: ['gu','ta',...], source_lang?: 'en', force?: bool }
// - Skips if the quiz's SUBJECT is a language lesson, UNLESS force=true.
// - Each target → a NEW quiz doc, status 'submitted' (needs per-language review),
//   sharing translation_group, same class/subject/topic, tagged language.
// - Translates question_text/options/explanation; keeps correct_answer_index,
//   numbers, formulae, {placeholders} verbatim.
router.post('/:id/translate', requirePerm('perm_edit_curriculum'), caught(async (req, res) => {
  if (!bhashini.isConfigured()) return res.status(503).json({ error: 'Bhashini not configured' });
  const db = getFirestore();
  const srcRef = db.collection('quizzes').doc(req.params.id);
  const srcSnap = await srcRef.get();
  if (!srcSnap.exists) return res.status(404).json({ error: 'Quiz not found' });
  const quiz = srcSnap.data();
  const force = req.body.force === true || req.body.force === 'true';

  if (isLanguageSubject(quiz.subject) && !force) {
    return res.status(409).json({ error: 'Language-subject quiz is not auto-translated', subject: quiz.subject, hint: 'send force:true to override' });
  }

  const srcCode = (req.body.source_lang || LANG_NAME_TO_CODE[String(quiz.language || '').toLowerCase()] || 'en').toLowerCase();
  const { languagesForStates } = require('../lib/stateLang');
  let targets = (Array.isArray(req.body.target_langs) ? req.body.target_langs : [])
    .map(l => String(l).toLowerCase());
  if (!targets.length) targets = languagesForStates(quiz.target_states || []); // auto from states
  targets = targets.filter(l => l && l !== srcCode);
  if (!targets.length) return res.status(400).json({ error: 'No target languages (no states set and none given)' });

  // Load source questions once.
  const qSnap = await srcRef.collection('questions').orderBy('sort_order').get();
  const srcQuestions = qSnap.docs.map(d => d.data());
  const groupId = quiz.translation_group || req.params.id;
  if (!quiz.translation_group) await srcRef.update({ translation_group: groupId });

  const created = [], failed = [];
  for (const tgt of targets) {
    try {
      const newId = uuidv4();
      // Translate quiz-level title.
      const title = await _tr(quiz.title || '', srcCode, tgt);
      await db.collection('quizzes').doc(newId).set({
        title,
        class_name: quiz.class_name || null,
        subject:    quiz.subject || null,
        topic:      quiz.topic || null,
        language:   tgt,
        target_states: quiz.target_states || [],
        translation_group: groupId,
        translated_from: req.params.id,
        machine_translated: true,
        status: 'submitted',            // per-language review gate
        created_by: req.user.id,
        created_at: new Date(),
        question_count: srcQuestions.length,
      });
      // Translate each question (answer key index untouched).
      const batch = db.batch();
      for (let i = 0; i < srcQuestions.length; i++) {
        const q = srcQuestions[i];
        const options = Array.isArray(q.options) ? q.options : [];
        const trOptions = [];
        for (const opt of options) trOptions.push(await _tr(opt, srcCode, tgt));
        const ref = db.collection('quizzes').doc(newId).collection('questions').doc();
        batch.set(ref, {
          question_text: await _tr(q.question_text || '', srcCode, tgt),
          options: trOptions,
          correct_answer_index: q.correct_answer_index ?? 0,   // NEVER translated
          explanation: await _tr(q.explanation || '', srcCode, tgt),
          sort_order: q.sort_order ?? i,
          // Round type and pictures carry over unchanged.
          ...(ROUND_TYPES.has(q.type) ? { type: q.type } : {}),
          ...(Array.isArray(q.option_images) ? { option_images: q.option_images } : {}),
          ...(q.question_image ? { question_image: q.question_image } : {}),
          created_at: new Date(),
        });
      }
      await batch.commit();
      created.push({ lang: tgt, quiz_id: newId });
    } catch (e) {
      failed.push({ lang: tgt, error: e.message });
    }
  }
  if (created.length) await _dropManifests(db);
  res.json({ message: 'Translation complete — review each language before publish', group: groupId, created, failed });
}));

// ── POST /extract-subjects — read an uploaded quiz XLSX, return distinct subjects
// Powers the manual force-translate picker. Accepts the parsed rows from the
// browser (same rows bulk-upload uses) OR a raw sheet already parsed client-side.
router.post('/extract-subjects', requirePerm('perm_edit_curriculum'), async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const subjects = {};
  for (const r of rows) {
    const subj = (r.subject || r.Subject || '').trim();
    if (!subj) continue;
    if (!subjects[subj]) subjects[subj] = { subject: subj, count: 0, is_language_subject: isLanguageSubject(subj) };
    subjects[subj].count++;
  }
  res.json({ subjects: Object.values(subjects) });
});

// ── GET /template — Download a blank XLSX question template ──────────────────
// index.html calls this when admin clicks "Download Template"
router.get('/template', requirePerm('perm_edit_curriculum'), (req, res) => {
  const XLSX = require('xlsx');
  const rows = [
    {
      question_text: 'What is the powerhouse of the cell?',
      A: 'Nucleus', B: 'Mitochondria', C: 'Ribosome', D: 'Golgi Apparatus',
      Answer: 'B',
      Explanation: 'Mitochondria produces ATP energy for the cell.',
    },
    {
      question_text: 'Which gas do plants absorb during photosynthesis?',
      A: 'Oxygen', B: 'Nitrogen', C: 'Carbon Dioxide', D: 'Hydrogen',
      Answer: 'C',
      Explanation: 'Plants absorb CO2 and release O2 during photosynthesis.',
    },
  ];

  const ws = XLSX.utils.json_to_sheet(rows);
  // Set column widths
  ws['!cols'] = [
    { wch: 60 }, { wch: 30 }, { wch: 30 }, { wch: 30 }, { wch: 30 },
    { wch: 10 }, { wch: 60 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Questions');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Disposition', 'attachment; filename="MITRA_Quiz_Template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── Change #31: Quiz analytics KPIs + top quizzes table ──────────────────────
router.get('/analytics', async (req, res) => {
  try {
    // Filters from the dashboard: state, district, class_name, subject, language, days
    const { rows, quizzes } = await loadAttempts(getFirestore(), req.query);
    const total_attempts  = rows.length;
    const unique_students = new Set(rows.map(a => a.student_id).filter(Boolean)).size;
    const avg_score_pct   = total_attempts ? round1(rows.reduce((s, a) => s + a.pct, 0) / total_attempts) : 0;
    const liveQuizzes = Object.values(quizzes).filter(q => ['live', 'published'].includes(q.status)).length;
    const completion_rate = (liveQuizzes && unique_students)
      ? round1(Math.min(100, (total_attempts / (liveQuizzes * unique_students)) * 100)) : 0;

    const buckets = [['0–25%', 0, 25], ['25–50%', 25, 50], ['50–75%', 50, 75], ['75–100%', 75, 101]];
    const score_distribution = total_attempts
      ? buckets.map(([bucket, lo, hi]) => ({ bucket, count: rows.filter(a => a.pct >= lo && a.pct < hi).length })) : [];

    const perQuiz = {};
    rows.forEach(a => {
      if (!a.quiz_id) return;
      perQuiz[a.quiz_id] = perQuiz[a.quiz_id] || { attempts: 0, total: 0, students: new Set() };
      perQuiz[a.quiz_id].attempts++; perQuiz[a.quiz_id].total += a.pct;
      if (a.student_id) perQuiz[a.quiz_id].students.add(a.student_id);
    });
    const top_quizzes = Object.entries(perQuiz).map(([quiz_id, d]) => {
      const q = quizzes[quiz_id] || {};
      return { quiz_id, title: q.title || quiz_id, class_name: q.class_name || null, subject: q.subject || null,
               topic: q.topic || null, language: q.language || null, status: q.status || null,
               attempts: d.attempts, avg_score_pct: round1(d.total / d.attempts),
               completion_rate: unique_students ? round1((d.students.size / unique_students) * 100) : 0 };
    }).sort((a, b) => b.attempts - a.attempts).slice(0, 10);

    res.json({
      kpi: { total_attempts, unique_students, avg_score_pct, completion_rate },
      score_distribution,
      by_subject: groupBy(rows, 'subject'),
      by_class:   groupBy(rows, 'class_name'),
      by_state:   groupBy(rows, 'state'),
      top_quizzes,
    });
  } catch (err) {
    log.error({ err: err.message }, 'Failed to load quiz analytics');
    res.status(500).json({ error: 'Failed to load quiz analytics' });
  }
});

// ── Change #32: Quiz analytics export (XLSX) ──────────────────────────────────
router.get('/analytics/export', requirePerm('perm_export_data'), async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const { rows, quizzes } = await loadAttempts(getFirestore(), req.query);
    const out = rows.map(a => ({
      'Quiz': (quizzes[a.quiz_id] || {}).title || a.quiz_id || '',
      'Student ID': a.student_id || '',
      'Score %': round1(a.pct),
      'Time (secs)': a.time_secs || '',
      'Subject': a.subject || '', 'Class': a.class_name || '',
      'State': a.state || '', 'District': a.district || '', 'Language': a.language || '',
      'Completed At': a.at ? new Date(a.at).toISOString() : '',
    }));
    const ws = XLSX.utils.json_to_sheet(out);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Quiz Attempts');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="Quiz_Analytics_Export.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    log.error({ err: err.message }, 'Quiz analytics export failed');
    res.status(500).json({ error: 'Export failed' });
  }
});

// ── Change #33: Bulk actions (delete / publish / archive / pause) ────────────
router.post('/bulk-action', requirePerm('perm_edit_curriculum'), async (req, res) => {
  try {
    const { action, quizIds } = req.body || {};
    if (!Array.isArray(quizIds) || !quizIds.length) {
      return res.status(400).json({ error: 'quizIds required' });
    }
    // The dashboard buttons send live / paused / draft / delete; older callers
    // sent publish / pause / archive. Accept both, and write the same status
    // (and stamps) the single-quiz ▶ Live / ⏸ buttons write.
    const statusForAction = {
      live: 'live', publish: 'live', published: 'live',
      paused: 'paused', pause: 'paused',
      draft: 'draft', archive: 'archived', archived: 'archived',
    };
    if (action !== 'delete' && !statusForAction[action]) {
      return res.status(400).json({ error: 'Unknown action: ' + action });
    }
    if (quizIds.length > 450) {
      return res.status(400).json({ error: 'Select at most 450 quizzes at a time' });
    }
    const db    = getFirestore();
    if (scopeState(req) !== null) { // state officer: every quiz must be their state's
      const docs = await db.getAll(...quizIds.map(id => db.collection('quizzes').doc(String(id))));
      if (docs.some(d => d.exists && !canTouchTargets(req, d.data().target_states))) {
        return res.status(403).json(OUT_OF_STATE(req));
      }
    }
    const batch = db.batch();
    const now   = new Date();
    const by    = (req.user && req.user.id) || null;
    quizIds.forEach(id => {
      const ref = db.collection('quizzes').doc(String(id));
      if (action === 'delete') { batch.delete(ref); return; }
      const status = statusForAction[action];
      const upd = { status, updated_at: now };
      if (status === 'live')   Object.assign(upd, { published_at: now, published_by: by });
      if (status === 'paused') Object.assign(upd, { paused_at: now, paused_by: by });
      batch.update(ref, upd);
    });
    await batch.commit();
    res.json({ message: `Applied "${action}" to ${quizIds.length} quizzes`, action, count: quizIds.length });
  } catch (err) {
    log.error({ err: err.message }, 'Quiz bulk-action failed');
    res.status(500).json({ error: 'Bulk action failed' });
  }
});

// ── POST /dispatch-scheduled ─ Cloud Scheduler flips due scheduled quizzes live ─
router.post('/dispatch-scheduled', staffOnly, async (req, res) => {
  try {
    const db  = getFirestore();
    const now = new Date();
    const snap = await db.collection('quizzes')
      .where('status', '==', 'scheduled')
      .where('scheduled_at', '<=', now)
      .limit(200)
      .get();
    if (snap.empty) return res.json({ published: 0 });
    let published = 0;
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = db.batch();
      for (const doc of snap.docs.slice(i, i + 400)) { batch.update(doc.ref, { status: 'live', published_at: now }); published++; }
      await batch.commit();
    }
    res.json({ published });
  } catch (err) {
    res.status(500).json({ error: 'Quiz dispatch failed', detail: err.message });
  }
});

module.exports = router;
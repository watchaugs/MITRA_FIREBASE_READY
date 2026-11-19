#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Stage 3 — one-time clean-up of state values already saved in Firestore, so
// every record uses the one list (public/mitra-states.js):
//   • names  → the official name   ("gujarat", "Orissa" → "Gujarat", "Odisha")
//   • codes  → the MITRA code      ("gj", "OR", "GUJARAT" → "GJ", "OD")
//
// Runs on YOUR computer with the Admin SDK (same credentials as the server:
// FIREBASE_ADMIN_SDK_PATH in .env, or gcloud application-default login).
// Nothing runs on Cloud Run, nothing is scheduled. Firestore reads/writes only.
//
//   node scripts/migrate_states.js              dry run: shows what would change
//   node scripts/migrate_states.js --apply      saves a backup file, then writes
//   node scripts/migrate_states.js --check      exit code 1 if anything is left
//   node scripts/migrate_states.js --restore=scripts/backups/state_migration_<time>.json
//
// What it touches (small collections only; telemetry and quiz attempts are
// left as they are — the server already matches every spelling there):
//   app_users, dashboard_users     assigned_state → name, + assigned_state_code
//   ar_assets, quizzes,
//   ad_campaigns                   target_states → codes; release.by_state keys → name;
//                                  ad_campaigns.state → name
//   geofences                      state → name, state_code → code
//   compliance_settings/territory_grace   days_by_state keys → one per state
//   curriculum_hierarchy           tree saved under a name ("Gujarat") moves to its
//                                  code ("GJ") when no code tree exists; state_name fixed
//   curriculum_manifests           cached copies under a name are deleted (rebuilt
//                                  from the tree on the next app request)
// Values it cannot place in the list are left alone and listed at the end.
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fb = require('../lib/firebase');
const { toCode, toName, isNational, sameState, norm } = require('../lib/states');

// Key for a per-state release date: the official name in lower case ("gujarat"
// for "GJ"). Same rule as relKey() in lib/release.js (Stage 3); kept here so
// the script also runs before that code is in place.
const relKey = (s) => String(toName(s) || s || '').trim().toLowerCase();

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CHECK = args.includes('--check');
const RESTORE = (args.find(a => a.startsWith('--restore=')) || '').slice(10);

// ── Backup encoding (keeps Firestore Timestamps across JSON) ────────────────
function enc(v) {
  if (v == null || typeof v !== 'object') return v;
  if (typeof v.toDate === 'function' && typeof v.toMillis === 'function') return { __ts: v.toMillis() };
  if (v instanceof Date) return { __ts: v.getTime() };
  if (typeof v.latitude === 'number' && typeof v.longitude === 'number' && Object.keys(v).length <= 2) {
    return { __geo: [v.latitude, v.longitude] };
  }
  if (Array.isArray(v)) return v.map(enc);
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = enc(x);
  return o;
}
function dec(v, admin) {
  if (v == null || typeof v !== 'object') return v;
  if ('__ts' in v && Object.keys(v).length === 1) return admin.firestore.Timestamp.fromMillis(v.__ts);
  if ('__geo' in v && Object.keys(v).length === 1) return new admin.firestore.GeoPoint(v.__geo[0], v.__geo[1]);
  if ('__missing' in v && Object.keys(v).length === 1) return admin.firestore.FieldValue.delete();
  if (Array.isArray(v)) return v.map(x => dec(x, admin));
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = dec(x, admin);
  return o;
}

// ── Planning ────────────────────────────────────────────────────────────────
const plan = [];        // { path, op: 'update'|'set'|'delete', data, before }
const unknown = {};     // "collection.field" -> { value: count }
const notes = [];       // conflicts and anything needing a person
const counts = {};      // collection -> { scanned, changed }

function seen(coll) { (counts[coll] ||= { scanned: 0, changed: 0 }).scanned++; }
function changed(coll) { (counts[coll] ||= { scanned: 0, changed: 0 }).changed++; }
function unk(where, value) {
  const m = (unknown[where] ||= {});
  const k = String(value);
  m[k] = (m[k] || 0) + 1;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Update only the fields that differ; remember their old values. */
function planUpdate(coll, doc, next) {
  const cur = doc.data();
  const data = {}; const before = {};
  for (const [k, v] of Object.entries(next)) {
    if (!same(cur[k], v)) { data[k] = v; before[k] = k in cur ? enc(cur[k]) : { __missing: true }; }
  }
  if (!Object.keys(data).length) return;
  plan.push({ path: doc.ref.path, op: 'update', data, before });
  changed(coll);
}

function nameFor(v, where) {
  const raw = String(v == null ? '' : v).trim();
  if (!raw) return raw;
  if (isNational(raw)) return 'All India';
  const n = toName(raw);
  if (!n) unk(where, raw);
  return n || raw;
}

function codesFor(list, where) {
  if (!Array.isArray(list)) return list;
  const out = [];
  for (const x of list) {
    const raw = String(x == null ? '' : x).trim();
    if (!raw) continue;
    if (isNational(raw)) return [];                 // "All India" inside the list = national
    const c = toCode(raw);
    if (!c) unk(where, raw);
    const v = c || raw;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

function releaseFor(rel) {
  if (!rel || rel.mode !== 'per_state' || !rel.by_state) return rel;
  // The app asks with the official name, so the value under that key is the one
  // students get today: it wins; other spellings only fill gaps.
  const by = {};
  const entries = Object.entries(rel.by_state);
  for (const [k, v] of entries) if (String(k).trim().toLowerCase() === relKey(k)) by[relKey(k)] = v;
  for (const [k, v] of entries) if (!(relKey(k) in by)) by[relKey(k)] = v;
  return { ...rel, by_state: by };
}

async function planUsers(db, coll) {
  const snap = await db.collection(coll).get();
  for (const d of snap.docs) {
    seen(coll);
    const u = d.data();
    if (u.assigned_state == null || String(u.assigned_state).trim() === '') continue;
    const name = nameFor(u.assigned_state, `${coll}.assigned_state`);
    if (name !== 'All India' && !toCode(name)) continue;   // not in the list: listed, left alone
    const code = name === 'All India' ? null : toCode(name);
    planUpdate(coll, d, { assigned_state: name, assigned_state_code: code });
  }
}

async function planContent(db, coll, extra = {}) {
  const snap = await db.collection(coll).get();
  for (const d of snap.docs) {
    seen(coll);
    const a = d.data();
    const next = {};
    if (Array.isArray(a.target_states)) next.target_states = codesFor(a.target_states, `${coll}.target_states`);
    if (a.release) next.release = releaseFor(a.release);
    if (extra.stateField && a.state) next.state = nameFor(a.state, `${coll}.state`);
    planUpdate(coll, d, next);
  }
}

async function planGeofences(db) {
  const coll = 'geofences';
  const snap = await db.collection(coll).get();
  for (const d of snap.docs) {
    seen(coll);
    const g = d.data();
    const src = g.state || g.state_code;
    if (!src) continue;
    const name = toName(src);
    if (!name) { unk(`${coll}.state`, src); continue; }
    planUpdate(coll, d, { state: name, state_code: toCode(name) });
  }
}

async function planGrace(db) {
  const coll = 'compliance_settings';
  const ref = db.collection(coll).doc('territory_grace');
  const doc = await ref.get();
  if (!doc.exists) return;
  seen(coll);
  const by = doc.data().days_by_state || {};
  const keyOf = (s) => norm(toName(s) || s);         // same key as routes/geofence.js graceKey()
  const next = {};
  const entries = Object.entries(by);
  for (const [k] of entries) if (!toName(k)) unk(`${coll}.days_by_state`, k);
  // Values saved under the official key win; other spellings fill gaps only.
  for (const [k, v] of entries) if (norm(k) === keyOf(k)) next[keyOf(k)] = v;
  for (const [k, v] of entries) {
    const key = keyOf(k);
    if (norm(k) === key) continue;
    if (!(key in next)) next[key] = v;
    else if (next[key] !== v) notes.push(`territory_grace: "${k}" says ${v} days but "${key}" says ${next[key]} — kept ${next[key]}.`);
  }
  planUpdate(coll, doc, { days_by_state: next });
}

async function planCurriculum(db) {
  const coll = 'curriculum_hierarchy';
  const snap = await db.collection(coll).get();
  const ids = new Set(snap.docs.map(d => d.id));
  for (const d of snap.docs) {
    seen(coll);
    const h = d.data();
    const code = toCode(d.id) || toCode(h.state_code) || toCode(h.state_name);
    if (!code) { unk(`${coll} (document id)`, d.id); continue; }
    const name = toName(code);
    if (d.id === code) {
      planUpdate(coll, d, { state_code: code, state_name: name });
      continue;
    }
    // Saved under a name / old code: move to the code if that is free.
    if (ids.has(code)) {
      notes.push(`curriculum_hierarchy: both "${d.id}" and "${code}" exist. Left both; open the Curriculum Map for ${name}, check the tree, and delete the old one.`);
      continue;
    }
    plan.push({ path: `${coll}/${code}`, op: 'set', data: { ...h, state_code: code, state_name: name }, before: null });
    plan.push({ path: d.ref.path, op: 'delete', data: null, before: enc(h) });
    ids.add(code);
    changed(coll);
  }
}

async function planManifests(db) {
  const coll = 'curriculum_manifests';
  const snap = await db.collection(coll).get();
  for (const d of snap.docs) {
    seen(coll);
    if (toCode(d.id) === d.id) continue;            // already keyed by code
    plan.push({ path: d.ref.path, op: 'delete', data: null, before: enc(d.data()) });
    changed(coll);
  }
}

// ── Writing ─────────────────────────────────────────────────────────────────
async function commit(db, items, toWrite) {
  for (let i = 0; i < items.length; i += 400) {
    const batch = db.batch();
    for (const it of items.slice(i, i + 400)) {
      const ref = db.doc(it.path);
      const w = toWrite(it);
      if (w.op === 'delete') batch.delete(ref);
      else if (w.op === 'set') batch.set(ref, w.data);
      else batch.update(ref, w.data);
    }
    await batch.commit();
  }
}

async function restore(db, file) {
  const admin = require('firebase-admin');
  const items = JSON.parse(fs.readFileSync(file, 'utf8')).items;
  // Undo in reverse order: re-create deleted docs, remove created ones, put old fields back.
  await commit(db, [...items].reverse(), (it) => {
    if (it.op === 'set' && it.before == null) return { op: 'delete' };
    if (it.op === 'delete') return { op: 'set', data: dec(it.before, admin) };
    return { op: 'update', data: dec(it.before, admin) };
  });
  console.log(`Restored ${items.length} change(s) from ${file}`);
}

(async () => {
  await fb.init();
  const db = fb.getFirestore();
  if (RESTORE) { await restore(db, RESTORE); process.exit(0); }

  await planUsers(db, 'app_users');
  await planUsers(db, 'dashboard_users');
  await planContent(db, 'ar_assets');
  await planContent(db, 'quizzes');
  await planContent(db, 'ad_campaigns', { stateField: true });
  await planGeofences(db);
  await planGrace(db);
  await planCurriculum(db);
  await planManifests(db);

  console.log('\nCollection                 scanned  to change');
  for (const [c, n] of Object.entries(counts)) console.log(`  ${c.padEnd(25)}${String(n.scanned).padStart(7)}${String(n.changed).padStart(11)}`);
  const unkList = Object.entries(unknown);
  if (unkList.length) {
    console.log('\nNot in the state list (left as they are — fix by hand if they are typos):');
    for (const [where, m] of unkList) for (const [v, n] of Object.entries(m)) console.log(`  ${where}: "${v}" ×${n}`);
  }
  if (notes.length) { console.log('\nNeeds a person:'); notes.forEach(n => console.log('  ' + n)); }
  if (!plan.length) console.log('\nNothing to change.');

  if (CHECK) process.exit(plan.length || unkList.length || notes.length ? 1 : 0);
  if (!APPLY) {
    if (plan.length) {
      console.log(`\nDry run: ${plan.length} write(s) planned. Examples:`);
      plan.slice(0, 15).forEach(p => console.log(`  ${p.op.padEnd(6)} ${p.path}  ${p.data ? JSON.stringify(p.data).slice(0, 160) : ''}`));
      console.log('\nRun again with --apply to write (a backup file is saved first).');
    }
    process.exit(0);
  }
  if (!plan.length) process.exit(0);

  const dir = path.join(__dirname, 'backups');   // scripts/ is kept out of the Cloud Run image
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `state_migration_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ created: new Date().toISOString(), items: plan }, null, 1));
  console.log(`\nBackup saved: ${file}`);
  await commit(db, plan, (it) => ({ op: it.op, data: it.data }));
  console.log(`Done: ${plan.length} write(s). Undo with: node scripts/migrate_states.js --restore=${path.relative(process.cwd(), file)}`);
  process.exit(0);
})().catch((e) => { console.error('Failed:', e.message); process.exit(2); });
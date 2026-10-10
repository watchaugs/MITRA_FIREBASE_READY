'use strict';
// ════════════════════════════════════════════════════════════════════════════
// MITRA — Telemetry Exporter  (Option A: Firestore → GCS NDJSON → BigQuery)
//
// WHAT IT DOES (plain language):
//   1. Reads telemetry batches the app wrote to Firestore (telemetry_sync/...)
//      that we haven't processed yet.
//   2. Flattens each batched event into one BigQuery row (correct field names).
//   3. Writes them as an NDJSON file to GCS (cheap: one file, not per-row).
//   4. Bulk-loads that file into BigQuery telemetry_synced (free: batch load).
//   5. Marks each Firestore batch 'processed' so it's never counted twice.
//
// COST-SAFE: no BigQuery streaming inserts (those cost); GCS batch load is free.
// Run on a schedule (Cloud Scheduler → this endpoint), e.g. every 15 min.
//
// Mount in server.js:
//   app.use('/api/internal', require('./routes/telemetry_export'));
// and protect it (see AUTH note at the route).
// ════════════════════════════════════════════════════════════════════════════

const { getFirestore } = require('../lib/firebase');
const { BigQuery } = require('@google-cloud/bigquery');
const { Storage } = require('@google-cloud/storage');

const PROJECT   = process.env.GCP_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || 'watchaugs-mitra';
const DATASET   = 'mitra_telemetry_production';
const TABLE     = 'telemetry_synced';
const GCS_BUCKET = process.env.TELEMETRY_BUCKET || 'mitra-telemetry-raw'; // the bucket you create
const COLLECTIONS = [
  'sessions', 'ar_views', 'quiz_attempts', 'screen_views', 'notification_events',
  'accessibility_events', 'language_events', 'compliance_events',
  'profile_events', 'sync_events',
];

// Field renames: app field → BigQuery column. Everything else maps by same name.
const RENAME = {
  class: 'class_grade',
  school_id: 'school_code',
  ar_id: 'ar_module_id',
  was_offline: 'offline_session',
  feature: 'accessibility_feature',
  enabled: 'accessibility_enabled',
};

// The columns that exist in BigQuery (anything else on an event is ignored).
const BQ_COLS = new Set([
  'document_id','parent_id','timestamp','student_id','school_code','class_grade',
  'subject','topic_id','session_minutes','ar_module_id','mcq_responses','offline_session',
  'app_version','device_id','network_quality','sync_version','event_type','event_collection',
  'state','district','area_type','geofence_id','gender','age_group','socioeconomic_status',
  'disability_status','minority_status','first_generation_learner','mobile_ownership','board',
  'language','ncert_mapped','blooms_level','content_status','ar_tier','risk_level','device_model',
  'os_version','ar_capable','connectivity_type','parental_consent_status','data_retention_consent',
  'consent_version','duration_seconds','completed','is_replay','pre_module_score',
  'post_module_score','score_uplift','tap_count','rotate_count','zoom_count','battery_drain_pct',
  'correct_answers','total_questions','score_pct','passed','accessibility_feature',
  'accessibility_enabled','notification_type','notification_action',
  // ── Table B additions: fields the app already collects ──────────────────
  'action','consent_type','consent_form_version','denial_reason','consent_timestamp',
  'gender_provided','mobile_ownership_provided','time_spent_seconds','completion_percent',
  'interactions_count','has_ar_content','quiz_id','quiz_title','module_title',
  'ar_init_success','failure_reason','screen_name','exited_rage_tap','deep_link_target',
  'accommodation_type','approved','from_language','to_language','cached_event_count',
  'sync_success','sync_duration_seconds',
]);

function flattenEvent(ev, collection, docId, index, flushedAt) {
  const row = {};
  for (const [k, v] of Object.entries(ev)) {
    const col = RENAME[k] || k;
    if (BQ_COLS.has(col)) row[col] = v;
  }
  row.event_collection = collection;
  row.document_id = `${docId}_${index}`;
  if (!row.timestamp) row.timestamp = flushedAt || new Date().toISOString();
  // mcq_responses may be an array/object → BigQuery column is STRING, so stringify
  if (row.mcq_responses && typeof row.mcq_responses !== 'string') {
    row.mcq_responses = JSON.stringify(row.mcq_responses);
  }
  return row;
}

/**
 * Core routine. Returns { batches, rows } processed.
 */
async function runExport({ limitPerCollection = 500 } = {}) {
  const db = getFirestore();
  const bigquery = new BigQuery({ projectId: PROJECT });
  const storage = new Storage({ projectId: PROJECT });

  const allRows = [];
  const processedRefs = [];

  // Firestore collectionGroup lets us read e.g. every 'ar_views' subcollection
  // across all students in one query.
  for (const collection of COLLECTIONS) {
    const snap = await db.collectionGroup(collection)
      .where('processed', '!=', true)   // only unprocessed batches
      .limit(limitPerCollection)
      .get()
      .catch(async () => {
        // If the '!=' needs an index or 'processed' doesn't exist yet,
        // fall back to reading all and filtering in code (fine at low volume).
        const s = await db.collectionGroup(collection).limit(limitPerCollection).get();
        return { docs: s.docs.filter(d => d.data().processed !== true), empty: s.empty };
      });

    for (const doc of snap.docs) {
      const data = doc.data();
      const events = data.batched_events || [];
      events.forEach((ev, i) =>
        allRows.push(flattenEvent(ev, collection, doc.id, i, data.batch_flushed_at)));
      processedRefs.push(doc.ref);
    }
  }

  if (allRows.length === 0) {
    return { batches: 0, rows: 0, note: 'nothing to export' };
  }

  // 1) Write NDJSON to GCS (one file per run)
  const ndjson = allRows.map(r => JSON.stringify(r)).join('\n');
  const fileName = `telemetry/${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`;
  await storage.bucket(GCS_BUCKET).file(fileName).save(ndjson, {
    contentType: 'application/x-ndjson',
    resumable: false,
  });

  // 2) Bulk-load that GCS file into BigQuery (free batch load, not streaming)
  await bigquery
    .dataset(DATASET)
    .table(TABLE)
    .load(storage.bucket(GCS_BUCKET).file(fileName), {
      sourceFormat: 'NEWLINE_DELIMITED_JSON',
      writeDisposition: 'WRITE_APPEND',
      ignoreUnknownValues: true,   // extra fields never break the load
      maxBadRecords: 0,
    });

  // 3) Mark Firestore batches processed (so they're never double-counted)
  //    Batched writes, 400 at a time (Firestore limit is 500).
  for (let i = 0; i < processedRefs.length; i += 400) {
    const batch = db.batch();
    for (const ref of processedRefs.slice(i, i + 400)) {
      batch.update(ref, { processed: true, processed_at: new Date() });
    }
    await batch.commit();
  }

  return { batches: processedRefs.length, rows: allRows.length, file: fileName };
}

module.exports = { runExport };
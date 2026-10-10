'use strict';
// ════════════════════════════════════════════════════════════════════════════
// lib/bq.js — tiny BigQuery read helper for the Analytics tab.
//
// Runs aggregate (GROUP BY) queries against the telemetry warehouse and returns
// small result sets. COST-SAFE by design:
//   • BigQuery has NO idle cost — you pay only per query, per bytes scanned.
//   • First 1 TB scanned per month is free; these aggregates scan KB at our
//     current data size, so effectively ₹0.
//   • Identical queries are served from BigQuery's 24h result cache for free.
//   • A 5-minute in-process cache stops repeated dashboard loads from re-querying.
//   • maximumBytesBilled caps every query at ~2 GB — a runaway query ERRORS
//     instead of spending money (the caller then shows the empty state).
// ════════════════════════════════════════════════════════════════════════════
const { BigQuery } = require('@google-cloud/bigquery');

const PROJECT = process.env.GCP_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || 'watchaugs-mitra';
const DATASET = 'mitra_telemetry_production';
const TABLE   = 'telemetry_synced';

const FQ_TABLE = `\`${PROJECT}.${DATASET}.${TABLE}\``;

let _bq;
function client() {
  _bq ||= new BigQuery({ projectId: PROJECT });
  return _bq;
}

// ── tiny 5-minute cache ──────────────────────────────────────────────────────
const _cache = new Map();
const CACHE_MS = 5 * 60 * 1000;

/**
 * Run a parameterised aggregate query. Returns an array of row objects.
 * @param {string} sql
 * @param {object} params   named @params for the query
 * @param {object} opts     { cacheKey }
 */
async function runQuery(sql, params = {}, { cacheKey } = {}) {
  const key = cacheKey || sql + JSON.stringify(params);
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;

  const [rows] = await client().query({
    query: sql,
    params,
    // Guard rail: never let a single query scan more than ~2 GB.
    maximumBytesBilled: String(2 * 1024 * 1024 * 1024),
  });
  _cache.set(key, { at: Date.now(), rows });
  return rows;
}

module.exports = { runQuery, FQ_TABLE };
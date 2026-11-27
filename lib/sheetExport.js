'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// lib/sheetExport.js — write export files (.xlsx / .csv) from plain rows.
//
// Replaces the server's use of SheetJS "xlsx" 0.18.5, which has unfixed npm
// advisories (SEC-008). The server only ever WRITES sheets, so ExcelJS (already
// a dependency) does the job. Columns follow the order keys first appear in the
// rows, the same as SheetJS json_to_sheet did.
//
// CSV cells that start with = + - @ (or a tab / carriage return) get a leading
// apostrophe, so a spreadsheet app shows them as text instead of running them
// as a formula (CSV formula injection, CWE-1236).
// ═══════════════════════════════════════════════════════════════════════════

const ExcelJS = require('exceljs');

function columnsOf(rows) {
  const seen = new Set();
  const cols = [];
  for (const r of rows) {
    for (const k of Object.keys(r || {})) {
      if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
  }
  return cols;
}

function cellValue(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number' || typeof v === 'boolean' || v instanceof Date) return v;
  return String(v);
}

// rows → .xlsx Buffer. opts.widths: optional column widths (characters), in column order.
async function rowsToXlsx(rows, sheetName, opts = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MITRA';
  const ws = wb.addWorksheet(String(sheetName || 'Sheet1').slice(0, 31));
  const cols = columnsOf(rows);
  ws.columns = cols.map((k, i) => ({ header: k, key: k, width: (opts.widths && opts.widths[i]) || undefined }));
  for (const r of rows) {
    const out = {};
    for (const k of cols) out[k] = cellValue(r[k]);
    ws.addRow(out);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function csvCell(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  let s = v === undefined || v === null ? '' : (v instanceof Date ? v.toISOString() : String(v));
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// rows → CSV text (header line first).
function rowsToCsv(rows) {
  const cols = columnsOf(rows);
  const lines = [cols.map(csvCell).join(',')];
  for (const r of rows) lines.push(cols.map((k) => csvCell(r[k])).join(','));
  return lines.join('\n');
}

module.exports = { rowsToXlsx, rowsToCsv };
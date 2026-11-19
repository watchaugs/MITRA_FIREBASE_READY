#!/usr/bin/env node
'use strict';
// Checks that the app's state list (lib/constants/india_states.dart) is the
// same as the Dashboard's (public/mitra-states.js): codes, names, aliases and
// order. Run after changing either file.
//
//   node scripts/check_states_sync.js D:\path\to\MITRA_App_2026
const fs = require('fs');
const path = require('path');

const appRepo = process.argv[2];
if (!appRepo) {
  console.error('Usage: node scripts/check_states_sync.js <path-to-app-repo>');
  process.exit(2);
}
const dash = require('../public/mitra-states.js');
const dart = fs.readFileSync(path.join(appRepo, 'lib', 'constants', 'india_states.dart'), 'utf8');

// IndiaState('GJ', 'Gujarat', ['a', 'b']),
const str = (s) => s.slice(1, -1).replace(/\\'/g, "'");
const app = [...dart.matchAll(/IndiaState\(\s*('(?:[^'\\]|\\.)*')\s*,\s*('(?:[^'\\]|\\.)*')(?:\s*,\s*\[([^\]]*)\])?\s*\)/g)]
  .map(m => ({
    code: str(m[1]),
    name: str(m[2]),
    aliases: m[3] ? [...m[3].matchAll(/'(?:[^'\\]|\\.)*'/g)].map(a => str(a[0])) : [],
  }));

const a = JSON.stringify(dash.map(s => [s.code, s.name, s.aliases]));
const b = JSON.stringify(app.map(s => [s.code, s.name, s.aliases]));
if (a === b) {
  console.log(`OK — both lists have the same ${dash.length} states.`);
  process.exit(0);
}
console.error('DIFFERENT — the app and Dashboard state lists do not match:');
const max = Math.max(dash.length, app.length);
for (let i = 0; i < max; i++) {
  const x = JSON.stringify(dash[i] && [dash[i].code, dash[i].name, dash[i].aliases]);
  const y = JSON.stringify(app[i] && [app[i].code, app[i].name, app[i].aliases]);
  if (x !== y) console.error(`  #${i + 1}\n    dashboard: ${x}\n    app:       ${y}`);
}
process.exit(1);

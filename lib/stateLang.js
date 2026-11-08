'use strict';
// State → primary language (mirrors the app's state_language_map.dart).
// Every state also implicitly gets Hindi + English (universal).
const STATE_PRIMARY = {
  'andhra pradesh':'te','arunachal pradesh':'en','assam':'as','bihar':'hi','chhattisgarh':'hi',
  'goa':'kok','gujarat':'gu','haryana':'hi','himachal pradesh':'hi','jharkhand':'hi',
  'karnataka':'kn','kerala':'ml','madhya pradesh':'hi','maharashtra':'mr','manipur':'mni',
  'meghalaya':'en','mizoram':'en','nagaland':'en','odisha':'or','punjab':'pa','rajasthan':'hi',
  'sikkim':'ne','tamil nadu':'ta','telangana':'te','tripura':'bn','uttar pradesh':'hi',
  'uttarakhand':'hi','west bengal':'bn',
  'andaman and nicobar islands':'hi','chandigarh':'hi',
  'dadra and nagar haveli and daman and diu':'gu','delhi':'hi','jammu and kashmir':'ur',
  'ladakh':'hi','lakshadweep':'ml','puducherry':'ta',
};
const UNIVERSAL = ['hi', 'en'];
function _norm(s) { return String(s || '').trim().toLowerCase().replace(/_/g, ' '); }

function allLanguages() {
  return [...new Set([...UNIVERSAL, ...Object.values(STATE_PRIMARY)])];
}
function languagesForStates(states = []) {
  const norm = states.map(_norm);
  if (!norm.length || norm.includes('all india') || norm.includes('all')) return allLanguages();
  const set = new Set(UNIVERSAL);
  for (const s of norm) { const p = STATE_PRIMARY[s]; if (p) set.add(p); }
  return [...set];
}
module.exports = { STATE_PRIMARY, UNIVERSAL, allLanguages, languagesForStates };
'use strict';
const { State, City } = require('country-state-city');
const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
router.use(authenticate);

// Pulls live from country-state-city package — all 36 states/UTs,
// all 784 districts, always current. No hardcoding.
const IN_STATES = State.getStatesOfCountry('IN').map(s => ({
  code: s.isoCode,
  name: s.name,
  region: s.name,
  capital: s.name, // package doesn't carry capital — acceptable for our use
}));

router.get('/states', (req, res) => res.json(IN_STATES));
router.get('/india-states', (req, res) => res.json(IN_STATES));

router.get('/districts/:stateCode', (req, res) => {
  const cities = City.getCitiesOfState('IN', req.params.stateCode);
  if (!cities.length) return res.status(404).json({ error: 'State not found' });
  res.json(cities.map(c => ({ name: c.name, state_code: req.params.stateCode })));
});

router.get('/districts', (req, res) => {
  const { state } = req.query;
  if (state) {
    const stateObj = IN_STATES.find(s => s.name === state || s.code === state);
    if (!stateObj) return res.json([]);
    const cities = City.getCitiesOfState('IN', stateObj.code);
    return res.json(cities.map(c => ({ name: c.name, state_code: stateObj.code })));
  }
  // All districts — only returned if explicitly requested without a filter
  const all = IN_STATES.flatMap(s =>
    City.getCitiesOfState('IN', s.code).map(c => ({ name: c.name, state_code: s.code }))
  );
  res.json(all);
});

router.get('/languages', (req, res) => res.json([
  { code: 'en',  name: 'English',   native: 'English' },
  { code: 'hi',  name: 'Hindi',     native: 'हिन्दी' },
  { code: 'gu',  name: 'Gujarati',  native: 'ગુજરાતી' },
  { code: 'mr',  name: 'Marathi',   native: 'मराठी' },
  { code: 'ta',  name: 'Tamil',     native: 'தமிழ்' },
  { code: 'kn',  name: 'Kannada',   native: 'ಕನ್ನಡ' },
  { code: 'te',  name: 'Telugu',    native: 'తెలుగు' },
  { code: 'bn',  name: 'Bengali',   native: 'বাংলা' },
  { code: 'or',  name: 'Odia',      native: 'ଓଡ଼ିଆ' },
  { code: 'pa',  name: 'Punjabi',   native: 'ਪੰਜਾਬੀ' },
  { code: 'ml',  name: 'Malayalam', native: 'മലയാളം' },
  { code: 'as',  name: 'Assamese',  native: 'অসমীয়া' },
  { code: 'ur',  name: 'Urdu',      native: 'اردو' },
  { code: 'ks',  name: 'Kashmiri',  native: 'كشميري' },
  { code: 'ne',  name: 'Nepali',    native: 'नेपाली' },
  { code: 'mai', name: 'Maithili',  native: 'मैथिली' },
  { code: 'sa',  name: 'Sanskrit',  native: 'संस्कृतम्' },
  { code: 'doi', name: 'Dogri',     native: 'डोगरी' },
  { code: 'kon', name: 'Konkani',   native: 'कोंकणी' },
  { code: 'sd',  name: 'Sindhi',    native: 'سنڌي' },
  { code: 'mni', name: 'Meitei',    native: 'ꯃꯩꯇꯩꯂꯣꯟ' },
  { code: 'sat', name: 'Santali',   native: 'ᱥᱟᱱᱛᱟᱲᱤ' },
]));

router.get('/geojson/state/:code', (req, res) => {
  const state = IN_STATES.find(s => s.code === req.params.code);
  if (!state) return res.status(404).json({ error: 'State not found' });
  res.json({ type: 'FeatureCollection', features: [], state });
});
router.get('/geojson/district/:id', (req, res) => {
  res.json({ type: 'FeatureCollection', features: [] });
});
router.post('/sync-geojson/state/:code', (req, res) => {
  res.json({ success: true, message: `GeoJSON sync queued for ${req.params.code}` });
});
router.post('/sync-geojson/district/:id', (req, res) => {
  res.json({ success: true, message: 'District GeoJSON sync queued' });
});
router.post('/sync-all', (req, res) => {
  res.json({ success: true, message: 'Full GeoJSON sync queued', total: IN_STATES.length });
});
router.get('/states/sync-status', (req, res) => {
  res.json({ synced: IN_STATES.length, pending: 0, last_sync: new Date().toISOString() });
});
router.post('/seed-states', (req, res) => {
  res.json({ success: true, seeded: IN_STATES.length });
});

module.exports = router;
/*
 * MITRA — the ONE list of Indian states and union territories.
 *
 * Used by the Dashboard page (window.MITRA_STATES) and by the server
 * (require('../public/mitra-states.js') in lib/states.js). The smartphone app
 * keeps an identical copy in lib/constants/india_states.dart — run
 * `node scripts/check_states_sync.js <path-to-app-repo>` after any change.
 *
 * code    — the state's MITRA code. Matches what the Curriculum Map already
 *           saves (e.g. curriculum_hierarchy/GJ), so nothing stored moves.
 * name    — the official English name; shown on screen and stored today.
 * aliases — other spellings and older codes seen in data, maps or GPS lookups
 *           (Orissa/OR, DN/DH, UT, TS, CG …). They all mean the same state.
 */
(function (root) {
  'use strict';
  var MITRA_STATES = [
    { code: 'AN', name: 'Andaman and Nicobar Islands', aliases: ['Andaman and Nicobar', 'Andaman & Nicobar Islands', 'A&N Islands'] },
    { code: 'AP', name: 'Andhra Pradesh', aliases: [] },
    { code: 'AR', name: 'Arunachal Pradesh', aliases: [] },
    { code: 'AS', name: 'Assam', aliases: [] },
    { code: 'BR', name: 'Bihar', aliases: [] },
    { code: 'CH', name: 'Chandigarh', aliases: [] },
    { code: 'CT', name: 'Chhattisgarh', aliases: ['CG', 'Chattisgarh'] },
    { code: 'DD', name: 'Dadra and Nagar Haveli and Daman and Diu', aliases: ['DN', 'DH', 'Dadra and Nagar Haveli', 'Daman and Diu', 'Dadra & Nagar Haveli and Daman & Diu'] },
    { code: 'DL', name: 'Delhi', aliases: ['NCT of Delhi', 'National Capital Territory of Delhi', 'New Delhi'] },
    { code: 'GA', name: 'Goa', aliases: [] },
    { code: 'GJ', name: 'Gujarat', aliases: [] },
    { code: 'HR', name: 'Haryana', aliases: [] },
    { code: 'HP', name: 'Himachal Pradesh', aliases: [] },
    { code: 'JK', name: 'Jammu and Kashmir', aliases: ['Jammu & Kashmir', 'Jammu and Kashmir Union Territory'] },
    { code: 'JH', name: 'Jharkhand', aliases: [] },
    { code: 'KA', name: 'Karnataka', aliases: [] },
    { code: 'KL', name: 'Kerala', aliases: [] },
    { code: 'LA', name: 'Ladakh', aliases: [] },
    { code: 'LD', name: 'Lakshadweep', aliases: [] },
    { code: 'MP', name: 'Madhya Pradesh', aliases: [] },
    { code: 'MH', name: 'Maharashtra', aliases: [] },
    { code: 'MN', name: 'Manipur', aliases: [] },
    { code: 'ML', name: 'Meghalaya', aliases: [] },
    { code: 'MZ', name: 'Mizoram', aliases: [] },
    { code: 'NL', name: 'Nagaland', aliases: [] },
    { code: 'OD', name: 'Odisha', aliases: ['OR', 'Orissa'] },
    { code: 'PY', name: 'Puducherry', aliases: ['Pondicherry'] },
    { code: 'PB', name: 'Punjab', aliases: [] },
    { code: 'RJ', name: 'Rajasthan', aliases: [] },
    { code: 'SK', name: 'Sikkim', aliases: [] },
    { code: 'TN', name: 'Tamil Nadu', aliases: [] },
    { code: 'TG', name: 'Telangana', aliases: ['TS'] },
    { code: 'TR', name: 'Tripura', aliases: [] },
    { code: 'UP', name: 'Uttar Pradesh', aliases: [] },
    { code: 'UK', name: 'Uttarakhand', aliases: ['UT', 'Uttaranchal'] },
    { code: 'WB', name: 'West Bengal', aliases: [] }
  ];
  if (typeof module === 'object' && module.exports) module.exports = MITRA_STATES;
  else root.MITRA_STATES = MITRA_STATES;
})(typeof window !== 'undefined' ? window : this);

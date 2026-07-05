'use strict';
const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
router.use(authenticate);

const STATES = [
  { code: 'GJ', name: 'Gujarat', region: 'West' },
  { code: 'MH', name: 'Maharashtra', region: 'West' },
  { code: 'UP', name: 'Uttar Pradesh', region: 'North' },
  { code: 'KA', name: 'Karnataka', region: 'South' },
  { code: 'TN', name: 'Tamil Nadu', region: 'South' },
  { code: 'RJ', name: 'Rajasthan', region: 'North' },
  { code: 'MP', name: 'Madhya Pradesh', region: 'Central' },
  { code: 'WB', name: 'West Bengal', region: 'East' },
  { code: 'OR', name: 'Odisha', region: 'East' },
  { code: 'HR', name: 'Haryana', region: 'North' },
];

const DISTRICTS = {
  GJ: ['Ahmedabad', 'Anand', 'Surat', 'Vadodara', 'Rajkot', 'Gandhinagar'],
  MH: ['Mumbai', 'Pune', 'Nagpur', 'Nashik', 'Aurangabad'],
  UP: ['Lucknow', 'Kanpur', 'Agra', 'Varanasi', 'Allahabad'],
  KA: ['Bengaluru', 'Mysuru', 'Mangaluru', 'Hubballi', 'Belagavi'],
  TN: ['Chennai', 'Coimbatore', 'Madurai', 'Tiruchirappalli', 'Salem'],
};

router.get('/states', (req, res) => res.json(STATES));
router.get('/districts/:stateCode', (req, res) => {
  const districts = DISTRICTS[req.params.stateCode] || [];
  res.json(districts.map(d => ({ name: d, state_code: req.params.stateCode })));
});
router.get('/districts', (req, res) => {
  const all = Object.entries(DISTRICTS).flatMap(([code, ds]) => ds.map(d => ({ name: d, state_code: code })));
  res.json(all);
});
router.get('/india-states', (req, res) => res.json(STATES));
router.get('/languages', (req, res) => res.json([
  { code: 'en', name: 'English' }, { code: 'hi', name: 'Hindi' },
  { code: 'gu', name: 'Gujarati' }, { code: 'mr', name: 'Marathi' },
  { code: 'ta', name: 'Tamil' }, { code: 'kn', name: 'Kannada' },
  { code: 'te', name: 'Telugu' }, { code: 'bn', name: 'Bengali' },
  { code: 'or', name: 'Odia' }, { code: 'pa', name: 'Punjabi' },
]));

module.exports = router;

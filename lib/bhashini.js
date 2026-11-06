'use strict';
// Bhashini (ULCA) client — server-side, build-time use only.
// Config call → meity-auth; compute call → URL returned by config.
// Dormant until BHASHINI_USER_ID + BHASHINI_API_KEY are set.
const axios = require('axios');
const log = require('./logger');

const CONFIG_URL = 'https://meity-auth.ulcacontrib.org/ulca/apis/v0/model/getModelsPipeline';
const PIPELINE_ID = () => process.env.BHASHINI_PIPELINE_ID || '64392f96daac500b55c543cd';

function isConfigured() {
  return !!(process.env.BHASHINI_USER_ID && process.env.BHASHINI_API_KEY);
}

// Cache pipeline-config per (task, lang) for an hour per warm instance.
const _cache = new Map();
const _key = (task, src, tgt) => `${task}:${src || ''}:${tgt || ''}`;

async function getConfig(task, sourceLang, targetLang) {
  const ck = _key(task, sourceLang, targetLang);
  const hit = _cache.get(ck);
  if (hit && hit.exp > Date.now()) return hit.val;

  const taskObj = { taskType: task, config: { language: { sourceLanguage: sourceLang } } };
  if (task === 'translation' && targetLang) taskObj.config.language.targetLanguage = targetLang;

  const res = await axios.post(CONFIG_URL,
    { pipelineTasks: [taskObj], pipelineRequestConfig: { pipelineId: PIPELINE_ID() } },
    { headers: { userID: process.env.BHASHINI_USER_ID, ulcaApiKey: process.env.BHASHINI_API_KEY, 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  const d = res.data;
  const ep = d.pipelineInferenceAPIEndPoint;
  const taskCfg = (d.pipelineResponseConfig || []).find(p => p.taskType === task);
  const serviceId = taskCfg?.config?.[0]?.serviceId;
  const val = {
    computeUrl: ep.callbackUrl,
    authKey: ep.inferenceApiKey?.name,
    authVal: ep.inferenceApiKey?.value,
    serviceId,
    // voices (TTS): speakers supported, if the config exposes them
    voices: taskCfg?.config?.map(c => ({ lang: c.language?.sourceLanguage, speakers: c.supportedVoices || c.config?.supportedVoices || [] })) || [],
  };
  _cache.set(ck, { val, exp: Date.now() + 3600000 });
  return val;
}

// TTS: returns { audio: Buffer, sampleRate } (WAV from Bhashini).
async function tts(text, lang, { gender = 'female', samplingRate = 22050 } = {}) {
  if (!isConfigured()) throw new Error('BHASHINI_NOT_CONFIGURED');
  const cfg = await getConfig('tts', lang);
  const body = {
    pipelineTasks: [{
      taskType: 'tts',
      config: { language: { sourceLanguage: lang }, serviceId: cfg.serviceId, gender, samplingRate },
    }],
    inputData: { input: [{ source: text }] },
  };
  const res = await axios.post(cfg.computeUrl, body,
    { headers: { [cfg.authKey]: cfg.authVal, 'Content-Type': 'application/json' }, timeout: 60000 });
  const out = res.data?.pipelineResponse?.find(p => p.taskType === 'tts');
  const b64 = out?.audio?.[0]?.audioContent;
  if (!b64) throw new Error('No audio returned from Bhashini');
  return { audio: Buffer.from(b64, 'base64'), sampleRate: samplingRate };
}

// NMT: returns translated string (used in Phase 6).
async function translate(text, sourceLang, targetLang) {
  if (!isConfigured()) throw new Error('BHASHINI_NOT_CONFIGURED');
  const cfg = await getConfig('translation', sourceLang, targetLang);
  const body = {
    pipelineTasks: [{
      taskType: 'translation',
      config: { language: { sourceLanguage: sourceLang, targetLanguage: targetLang }, serviceId: cfg.serviceId },
    }],
    inputData: { input: [{ source: text }] },
  };
  const res = await axios.post(cfg.computeUrl, body,
    { headers: { [cfg.authKey]: cfg.authVal, 'Content-Type': 'application/json' }, timeout: 60000 });
  const out = res.data?.pipelineResponse?.find(p => p.taskType === 'translation');
  return out?.output?.[0]?.target ?? '';
}

// List available TTS voices for a language (for the dashboard dropdown).
async function ttsVoices(lang) {
  if (!isConfigured()) return [];
  try {
    const cfg = await getConfig('tts', lang);
    const entry = (cfg.voices || []).find(v => v.lang === lang) || cfg.voices?.[0];
    return entry?.speakers || [];
  } catch (e) { log.warn({ err: e.message, lang }, 'ttsVoices failed'); return []; }
}

module.exports = { isConfigured, tts, translate, ttsVoices, getConfig };
// ═══════════════════════════════════════════════════════════════════
// ads-compliance.js — Advertisements + Legal & Compliance pages
// Loaded by index.html (<script src="/ads-compliance.js">).
//
// Everything on these two pages now comes from the server. Removed: invented
// campaign rows/charts/exports, the hard-coded audit-findings list, the
// toast-only filter and "Schedule" button, and the certificate that always
// said "COMPLIANCE VERIFIED / ISO 27001" regardless of the real checks.
// ═══════════════════════════════════════════════════════════════════

if (typeof window.showToast !== 'function') {
  window.showToast = function (msg) {
    const t = document.getElementById('toast');
    if (t) { t.innerText = msg; t.style.opacity = 1; setTimeout(() => { t.style.opacity = 0; }, 3000); }
    else { console.info('[Toast]', msg); }
  };
}

// ── Shared helpers ─────────────────────────────────────────────────────
function _authH(json = true) {
  const token = localStorage.getItem('mitra_token');
  const h = token ? { Authorization: 'Bearer ' + token } : {};
  if (json) h['Content-Type'] = 'application/json';
  return h;
}
async function _api(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ..._authH(!(opts.body instanceof FormData)), ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
  return data;
}
function _escHTML(str) {
  return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
function _toMs(v) {
  if (!v) return null;
  if (typeof v === 'object' && v._seconds != null) return v._seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}
function _fmtDate(v) {
  const t = _toMs(v);
  return t ? new Date(t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
}
function _downloadBlob(content, filename, mimeType) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mimeType }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
function _xlsxOrCSV(data, filename, fmt) {
  if (!data.length) { showToast('Nothing to export yet'); return; }
  const stamp = new Date().toISOString().slice(0, 10);
  if (fmt !== 'csv' && typeof XLSX !== 'undefined') {
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Data');
    XLSX.writeFile(wb, `${filename}_${stamp}.xlsx`);
  } else {
    const keys = Object.keys(data[0] || {});
    const csv = [keys.join(','), ...data.map(r => keys.map(k => '"' + String(r[k] == null ? '' : r[k]).replace(/"/g, '""') + '"').join(','))].join('\n');
    _downloadBlob(csv, `${filename}_${stamp}.csv`, 'text/csv');
  }
}
function toggleAllCheck(cls, cb) {
  document.querySelectorAll('.' + cls).forEach(c => { c.checked = cb.checked; });
}

// ══════════════════════════════════════════════════════════════════
// ADVERTISEMENTS
// ══════════════════════════════════════════════════════════════════
let _adCampaigns = [];
let _adLoading = null;
let _lastSavedAdCampaignId = null;
let _adMedia = null;            // { url, media_type, upload_id } after a successful upload

function switchAdTab(tabId, btn) {
  document.querySelectorAll('.ad-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.ad-section').forEach(s => s.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const section = document.getElementById('ad-' + tabId);
  if (section) section.classList.add('active');
  if (tabId === 'dashboard') loadAdCampaigns();
  if (tabId === 'upload') initAdTargeting();
  if (tabId === 'frequency') loadFrequencyConfig();
  if (tabId === 'history') loadAdCampaigns();
}

// Status as students experience it
function adRunState(c, now = Date.now()) {
  const s = (c.status || 'draft').toLowerCase();
  const start = _toMs(c.publish_at), end = _toMs(c.expires_at);
  if (end && end < now && (s === 'live' || s === 'scheduled')) return { label: 'Ended', dot: 'grey' };
  if (s === 'scheduled' || (s === 'live' && start && start > now)) return { label: 'Scheduled', dot: 'yellow' };
  if (s === 'live') return { label: 'Running', dot: 'green' };
  if (s === 'paused') return { label: 'Paused', dot: 'yellow' };
  if (s === 'expired') return { label: 'Ended', dot: 'grey' };
  return { label: 'Draft', dot: 'grey' };
}
function adTargetLabel(c) {
  const t = Array.isArray(c.target_states) ? c.target_states : [];
  if (!t.length) return 'All India';
  return t.length <= 2 ? t.join(', ') : `${t.slice(0, 2).join(', ')} +${t.length - 2}`;
}
function adPeriod(c) {
  const a = _fmtDate(c.publish_at), b = _fmtDate(c.expires_at);
  return a || b ? `${a || 'now'} → ${b || 'no end'}` : '—';
}
function adCtr(c) {
  const imp = Number(c.impressions) || 0, clk = Number(c.clicks) || 0;
  return imp ? ((clk / imp) * 100).toFixed(1) + '%' : '—';
}

/** Load campaigns once; every Ads view renders from this list. */
async function loadAdCampaigns() {
  if (_adLoading) return _adLoading;
  const tb = document.getElementById('ad-campaigns-body');
  if (tb && !_adCampaigns.length) tb.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text2);padding:16px">Loading campaigns…</td></tr>';
  _adLoading = (async () => {
    try {
      const d = await _api('/api/ads');
      _adCampaigns = (d.data || []).slice().sort((a, b) => (_toMs(b.created_at) || 0) - (_toMs(a.created_at) || 0));
      fillAdFilters();
      renderAdDashboard();
      renderAdHistory();
    } catch (e) {
      if (tb) tb.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#fca5a5;padding:16px">Could not load campaigns: ${_escHTML(e.message)}</td></tr>`;
    } finally {
      _adLoading = null;
    }
    return _adCampaigns;
  })();
  return _adLoading;
}
// Called by the page hooks in index.html
function loadAdStats() { return loadAdCampaigns(); }
function initAdCharts() { if (_adCampaigns.length) renderAdChart(adFiltered()); else loadAdCampaigns(); }

function fillAdFilters() {
  const camp = document.getElementById('adb-campaign');
  const st = document.getElementById('adb-state');
  if (camp) {
    const v = camp.value;
    while (camp.options.length > 1) camp.remove(1);
    _adCampaigns.forEach(c => camp.add(new Option(c.name || 'Untitled', c.id)));
    camp.value = v;
  }
  if (st && st.options.length <= 1 && typeof INDIA_STATES !== 'undefined') {
    INDIA_STATES.forEach(s => st.add(new Option(s.name, s.name)));
  }
}
function adFiltered() {
  const id = document.getElementById('adb-campaign')?.value || '';
  const state = document.getElementById('adb-state')?.value || '';
  return _adCampaigns.filter(c =>
    (!id || c.id === id) &&
    (!state || !(c.target_states || []).length || (c.target_states || []).includes(state)));
}
function filterAdDashboard() { renderAdDashboard(); }
function resetAdFilters() {
  ['adb-campaign', 'adb-state'].forEach(id => { const el = document.getElementById(id); if (el) el.selectedIndex = 0; });
  renderAdDashboard();
}

async function renderAdDashboard() {
  const rows = adFiltered();
  // KPIs (computed from the same campaigns, so they follow the filters)
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const running = rows.filter(c => adRunState(c).label === 'Running');
  const imp = rows.reduce((s, c) => s + (Number(c.impressions) || 0), 0);
  const clk = rows.reduce((s, c) => s + (Number(c.clicks) || 0), 0);
  const states = new Set(rows.flatMap(c => c.target_states || []));
  set('ad-stat-campaigns', running.length);
  set('ad-stat-impressions', _fmtNum(imp));
  set('ad-stat-ctr', imp ? ((clk / imp) * 100).toFixed(1) + '%' : '—');
  set('ad-stat-states', rows.some(c => !(c.target_states || []).length) ? 'All India' : states.size);
  // Table
  const tb = document.getElementById('ad-campaigns-body');
  if (tb) {
    tb.innerHTML = rows.length ? rows.map(c => {
      const st = adRunState(c);
      return `<tr>
        <td><strong>${_escHTML(c.name || 'Untitled')}</strong><div style="font-size:10px;color:var(--text2)">${_escHTML(c.advertiser || '')}</div></td>
        <td><span class="tag tag-b">${_escHTML(c.media_type || (c.media_url ? 'File' : 'No media'))}</span></td>
        <td><span class="tag tag-b">${_escHTML(adTargetLabel(c))}</span></td>
        <td><div style="font-size:11px">${_escHTML(adPeriod(c))}</div></td>
        <td>${(Number(c.impressions) || 0).toLocaleString('en-IN')}</td>
        <td>${(Number(c.clicks) || 0).toLocaleString('en-IN')}</td>
        <td>${adCtr(c)}</td>
        <td><span class="sdot ${st.dot}"></span>${st.label}</td>
        <td><button class="btn btn-s btn-sm" onclick="openAdEdit('${_escHTML(c.id)}')">Edit</button></td>
      </tr>`;
    }).join('') : `<tr><td colspan="9" style="text-align:center;color:var(--text2);padding:16px">${_adCampaigns.length ? 'No campaigns match the filters.' : 'No campaigns yet — create one in “Upload Advertisement”.'}</td></tr>`;
  }
  renderAdChart(rows);
  // Daily push cap (global setting)
  try {
    const f = await _api('/api/ads/frequency');
    set('ad-stat-daily', f.daily_push ?? f.cap ?? '—');
  } catch (_) { set('ad-stat-daily', '—'); }
}

function renderAdChart(rows) {
  const id = 'chart-ad-campaign-compare';
  const canvas = document.getElementById(id);
  if (!canvas || typeof Chart === 'undefined') return;
  const ex = Chart.getChart(id); if (ex) ex.destroy();
  const box = canvas.parentElement;
  let note = box && box.querySelector('.chart-empty');
  const data = rows.filter(c => Number(c.impressions) > 0).slice(0, 10);
  if (!data.length) {
    if (box && !note) {
      note = document.createElement('div'); note.className = 'chart-empty';
      note.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text3)';
      box.style.position = 'relative'; box.appendChild(note);
    }
    if (note) note.textContent = 'No impressions recorded yet.';
    return;
  }
  if (note) note.remove();
  new Chart(canvas, {
    type: 'bar',
    data: {
      labels: data.map(c => c.name || 'Untitled'),
      datasets: [
        { label: 'Impressions', data: data.map(c => Number(c.impressions) || 0), backgroundColor: 'rgba(99,102,241,0.8)', borderRadius: 4 },
        { label: 'Clicks', data: data.map(c => Number(c.clicks) || 0), backgroundColor: 'rgba(245,158,11,0.8)', borderRadius: 4 },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } },
      scales: { y: { grid: { color: '#1e2d4a' } }, x: { grid: { display: false } } } },
  });
}

function toggleAdExport() {
  const m = document.getElementById('ad-export-menu');
  if (m) m.style.display = m.style.display === 'none' ? 'block' : 'none';
}
document.addEventListener('click', function (e) {
  const m = document.getElementById('ad-export-menu');
  if (m && m.style.display === 'block' && !m.contains(e.target) && !(e.target.closest && e.target.closest('[onclick*="toggleAdExport"]'))) m.style.display = 'none';
});
function _adExportRows(rows) {
  return rows.map(c => ({
    Campaign: c.name || '', Advertiser: c.advertiser || '', Media: c.media_type || '',
    Target: adTargetLabel(c), Starts: _fmtDate(c.publish_at), Ends: _fmtDate(c.expires_at),
    Impressions: Number(c.impressions) || 0, Clicks: Number(c.clicks) || 0, CTR: adCtr(c), Status: adRunState(c).label,
  }));
}
function exportAdData(fmt) {
  const m = document.getElementById('ad-export-menu'); if (m) m.style.display = 'none';
  _xlsxOrCSV(_adExportRows(adFiltered()), 'MITRA_Ad_Campaigns', fmt);
}
function exportAdGranular(fmt) { _xlsxOrCSV(_adExportRows(_adCampaigns), 'MITRA_Ad_History', fmt); }

function renderAdHistory() {
  const tb = document.getElementById('ad-history-body');
  if (!tb) return;
  tb.innerHTML = _adCampaigns.length ? _adCampaigns.map(c => {
    const st = adRunState(c);
    return `<tr><td>${_escHTML(c.name || 'Untitled')}</td><td>${_escHTML(adPeriod(c))}</td><td>${_escHTML(adTargetLabel(c))}</td>
      <td>${(Number(c.impressions) || 0).toLocaleString('en-IN')}</td><td>${(Number(c.clicks) || 0).toLocaleString('en-IN')}</td>
      <td>${adCtr(c)}</td><td><span class="sdot ${st.dot}"></span>${st.label}</td></tr>`;
  }).join('') : '<tr><td colspan="7" style="text-align:center;color:var(--text2);padding:16px">No campaigns yet.</td></tr>';
}

// ── Upload + campaign form ─────────────────────────────────────────────
function initAdTargeting() {
  const box = document.getElementById('ad-target-states');
  if (!box || box.dataset.ready || typeof INDIA_STATES === 'undefined') return;
  box.innerHTML = INDIA_STATES.map(s =>
    `<div class="checklist-item"><input type="checkbox" class="adstate-cb" value="${_escHTML(s.name)}" id="adst-${_escHTML(s.code)}" onchange="if(this.checked){const a=document.getElementById('adst-all');if(a)a.checked=false;}"><label for="adst-${_escHTML(s.code)}" style="cursor:pointer;flex:1">${_escHTML(s.name)}</label></div>`).join('');
  box.dataset.ready = '1';
}

function handleAdUpload(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    showToast('❌ File exceeds 5 MB limit. Please choose a smaller file.');
    input.value = '';
    return;
  }
  const statusEl = document.getElementById('ad-upload-status');
  const fnameEl = document.getElementById('ad-fname');
  const fsizeEl = document.getElementById('ad-fsize');
  const fillEl = document.getElementById('ad-upfill');
  if (statusEl) statusEl.style.display = 'block';
  if (fnameEl) fnameEl.innerText = file.name + ' — uploading…';
  if (fsizeEl) fsizeEl.innerText = (file.size / 1024 / 1024).toFixed(2) + ' MB';
  if (fillEl) fillEl.style.width = '0%';
  _adMedia = null;

  // Real upload with real progress (the old bar was a random animation and the
  // request had no login token, so it always failed).
  const fd = new FormData();
  fd.append('file', file);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/ads/upload');
  const token = localStorage.getItem('mitra_token');
  if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
  xhr.upload.onprogress = ev => { if (ev.lengthComputable && fillEl) fillEl.style.width = Math.round((ev.loaded / ev.total) * 100) + '%'; };
  xhr.onload = () => {
    let d = {}; try { d = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
    if (xhr.status >= 200 && xhr.status < 300 && d.url) {
      _adMedia = { url: d.url, upload_id: d.id, media_type: file.type.startsWith('video') ? 'Video' : (file.type === 'image/gif' ? 'GIF' : 'Image') };
      if (fnameEl) fnameEl.innerText = file.name + ' — ✅ uploaded';
      if (fillEl) fillEl.style.width = '100%';
      showToast('✅ File uploaded — fill in the details below, then Save or Publish');
    } else {
      if (fnameEl) fnameEl.innerText = file.name + ' — ❌ upload failed';
      showToast('❌ Upload failed: ' + (d.error || xhr.status));
    }
  };
  xhr.onerror = () => { if (fnameEl) fnameEl.innerText = file.name + ' — ❌ network error'; showToast('❌ Upload failed — network error'); };
  xhr.send(fd);
}

function _adPayload() {
  const v = id => (document.getElementById(id) || {}).value || '';
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].filter(d => document.getElementById('adday-' + d)?.checked);
  const allStates = document.getElementById('adst-all')?.checked;
  const states = allStates ? [] : [...document.querySelectorAll('.adstate-cb:checked')].map(c => c.value);
  const toIso = s => s ? new Date(s).toISOString() : null;
  const p = {
    name: v('ad-campaign-name').trim(),
    advertiser: v('ad-advertiser').trim(),
    description: v('ad-description').trim(),
    publish_at: toIso(v('ad-publish-date')),
    expires_at: toIso(v('ad-expiry-date')),
    publish_days: days.length === 7 ? [] : days,
    target_states: states,
    // In-app popup behaviour (consumed by the app's _SponsorInterstitial).
    close_after_seconds: parseInt(v('ad-close-after'), 10) || 10,
    auto_dismiss_seconds: parseInt(v('ad-auto-dismiss'), 10) || 0,
    skippable: document.getElementById('ad-skippable')?.checked !== false,
  };
  if (_adMedia) { p.media_url = _adMedia.url; p.media_type = _adMedia.media_type; p.upload_id = _adMedia.upload_id; }
  return p;
}
async function _saveAd(statusHint) {
  const p = _adPayload();
  if (!p.name) throw new Error('Please enter a campaign name');
  if (!p.media_url && !_lastSavedAdCampaignId) throw new Error('Upload the advertisement file first');
  if (p.publish_at && p.expires_at && new Date(p.expires_at) <= new Date(p.publish_at)) throw new Error('Expiry must be after the publish date');
  if (statusHint) p.status = statusHint;
  if (_lastSavedAdCampaignId) {
    await _api('/api/ads/' + encodeURIComponent(_lastSavedAdCampaignId), { method: 'PUT', body: JSON.stringify(p) });
    return _lastSavedAdCampaignId;
  }
  const d = await _api('/api/ads', { method: 'POST', body: JSON.stringify(p) });
  _lastSavedAdCampaignId = d.id;
  return d.id;
}
function _resetAdForm() {
  ['ad-campaign-name', 'ad-advertiser', 'ad-description', 'ad-publish-date', 'ad-expiry-date', 'ad-close-after', 'ad-auto-dismiss'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const sk = document.getElementById('ad-skippable'); if (sk) sk.checked = true;
  document.querySelectorAll('.adstate-cb').forEach(c => { c.checked = false; });
  const all = document.getElementById('adst-all'); if (all) all.checked = true;
  const fi = document.getElementById('ad-file-input'); if (fi) fi.value = '';
  const st = document.getElementById('ad-upload-status'); if (st) st.style.display = 'none';
  _adMedia = null; _lastSavedAdCampaignId = null;
}

async function saveAdCampaign() {
  try {
    const id = await _saveAd();
    showToast('💾 Campaign saved as draft — students will not see it until you publish');
    loadAdCampaigns();
    return id;
  } catch (e) { showToast('❌ ' + e.message); return null; }
}
async function publishAdCampaign() {
  try {
    const id = await _saveAd();
    await _api('/api/ads/' + encodeURIComponent(id) + '/publish', { method: 'POST', body: '{}' });
    const p = _adPayload();
    showToast(p.publish_at && new Date(p.publish_at) > new Date()
      ? '🚀 Published — students start seeing it from ' + _fmtDate(p.publish_at)
      : '🚀 Published — students see it the next time they open the app');
    _resetAdForm();
    loadAdCampaigns();
  } catch (e) { showToast('❌ ' + e.message); }
}
async function scheduleAdCampaign() {
  const p = _adPayload();
  if (!p.publish_at || new Date(p.publish_at) <= new Date()) { showToast('🗓️ Pick a publish date and time in the future first'); return; }
  try {
    await _saveAd('scheduled');
    showToast('🗓️ Scheduled — it goes live automatically on ' + _fmtDate(p.publish_at) + ' (no further action needed)');
    _resetAdForm();
    loadAdCampaigns();
  } catch (e) { showToast('❌ ' + e.message); }
}

// ── Frequency (one global setting) ─────────────────────────────────────
function changeCounter(id, delta) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = Math.max(0, Math.min(50, (parseInt(el.value, 10) || 0) + delta));
  updatePushBar();
}
function clampCounter(el, max) {
  const v = parseInt(el.value, 10);
  el.value = Math.max(0, Math.min(max, Number.isNaN(v) ? 0 : v));
  updatePushBar();
}
function updatePushBar() {
  const el = document.getElementById('daily-push-counter');
  const bar = document.getElementById('push-freq-bar');
  const lbl = document.getElementById('push-freq-label');
  const v = el ? parseInt(el.value, 10) || 0 : 0;
  if (bar) bar.style.width = Math.min(100, (v / 50) * 100) + '%';
  if (lbl) lbl.textContent = `${Math.round((v / 50) * 100)}% of max frequency (50/day)`;
}
function toggleBeforeTopic(cb) {
  const counter = document.getElementById('daily-push-counter');
  const bar = document.getElementById('push-freq-bar');
  if (counter) counter.disabled = cb.checked;
  if (bar) { bar.style.background = cb.checked ? '#ec4899' : 'var(--accent2)'; if (cb.checked) bar.style.width = '100%'; else updatePushBar(); }
}
async function loadFrequencyConfig() {
  try {
    const f = await _api('/api/ads/frequency');
    const el = document.getElementById('daily-push-counter');
    if (el) el.value = f.daily_push ?? f.cap ?? 5;
    const bt = document.getElementById('before-topic-toggle');
    if (bt) { bt.checked = f.before_topic === true; toggleBeforeTopic(bt); }
    updatePushBar();
  } catch (e) { showToast('Could not load the frequency setting: ' + e.message); }
}
async function saveFrequencyConfig() {
  const val = parseInt((document.getElementById('daily-push-counter') || {}).value, 10) || 0;
  try {
    // Server route is PUT (this used PATCH and always failed)
    await _api('/api/ads/frequency', { method: 'PUT', body: JSON.stringify({ daily_push: val, before_topic: !!document.getElementById('before-topic-toggle')?.checked }) });
    showToast('✅ Frequency saved: ' + val + ' push(es) per student per day');
    const k = document.getElementById('ad-stat-daily'); if (k) k.textContent = val;
  } catch (e) { showToast('❌ Could not save frequency: ' + e.message); }
}

// ══════════════════════════════════════════════════════════════════
// LEGAL & COMPLIANCE
// ══════════════════════════════════════════════════════════════════

// CERT-In items cannot be measured from the dashboard, so they are
// SELF-DECLARED: tick an item once it is in place; the tick is saved on
// the server (compliance settings) with who/when, not in the browser.
const CERTIN_ITEMS = [
  { key: 'certin_6h_reporting', label: '6-Hour Incident Reporting', req: 'Report cyber incidents to CERT-In within 6 hours' },
  { key: 'certin_log_retention', label: '180-Day Log Retention', req: 'Keep system logs for at least 180 days in India' },
  { key: 'certin_ntp', label: 'NTP Clock Sync', req: 'Synchronise system clocks with NTP (Cloud Run does this)' },
  { key: 'certin_cloud_logs', label: 'Cloud Service Log Retention', req: 'Retain cloud service logs' },
  { key: 'certin_ir_plan', label: 'Incident Response Plan', req: 'Documented incident response procedure (incident-response.html)' },
  { key: 'certin_vapt', label: 'Vulnerability Assessment', req: 'Regular VAPT conducted' },
];
let _complianceSettings = {};
const _isOn = v => v === true || v === 'true';

const FINDING_HINTS = {
  privacy_policy: 'Add the public Privacy Policy URL in compliance settings (privacy_policy_url).',
  consent_mechanism: 'Appears once the app records its first consent.',
  retention_policy: 'Set a retention period (days) in compliance settings.',
  right_to_erasure: 'Turn on auto-purge below, or process an erasure request.',
  dpo_appointed: 'Save the Data Protection Officer at the top of this page.',
  grievance_officer: 'Save the Grievance Officer on this page.',
  parental_consent: 'Needs guardian-verified consent records from the app.',
  breach_procedure: 'Add a breach contact / procedure URL in compliance settings.',
  data_localisation: 'Set DATA_REGION=asia-south1 on the Cloud Run service.',
  audit_log_active: 'Appears once any audited action is taken.',
  admin_mfa: 'Turn on “Require sign-in code for all accounts” below.',
};

async function initCompliancePage() {
  await loadComplianceSettings();
  renderCERTInChecklist();
  loadAuditFindings();
  loadOfficersFromServer();
  if (typeof renderDPDPATracker === 'function') renderDPDPATracker();   // live tracker (index.html)
  if (typeof loadConsentCounts === 'function') loadConsentCounts();
}

async function loadComplianceSettings() {
  try { _complianceSettings = await _api('/api/compliance/settings'); } catch (_) { _complianceSettings = {}; }
  const s = _complianceSettings;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };
  set('toggle-erasure', _isOn(s.erasure));
  set('toggle-withdrawal', _isOn(s.withdrawal));
  set('toggle-global-mfa', _isOn(s.mfa_required));
  const se = document.getElementById('summary-erasure'); if (se) se.textContent = _isOn(s.erasure) ? 'Enabled' : 'Disabled';
  const sw = document.getElementById('summary-withdrawal'); if (sw) sw.textContent = _isOn(s.withdrawal) ? 'Enabled' : 'Disabled';
}

// Toggles on the Compliance page (erasure, withdrawal, global MFA, CERT-In ticks)
async function updateComplianceSetting(settingKey, isEnabled, toggleEl) {
  const el = toggleEl || document.getElementById('toggle-' + settingKey);
  try {
    // Server route is PUT and merges the body (this used POST {key, value} and never saved)
    await _api('/api/compliance/settings', { method: 'PUT', body: JSON.stringify({ [settingKey]: !!isEnabled }) });
    _complianceSettings[settingKey] = !!isEnabled;
    const names = { erasure: 'Right to Erasure', withdrawal: 'Consent Withdrawal', mfa_required: 'Sign-in code for all accounts' };
    showToast(`✅ ${names[settingKey] || 'Setting'} ${isEnabled ? 'on' : 'off'}`);
    if (typeof refreshComplianceStatus === 'function') refreshComplianceStatus(true);
  } catch (e) {
    if (el) el.checked = !isEnabled;
    showToast('❌ Could not save: ' + e.message);
  }
}

async function loadAuditFindings() {
  const box = document.getElementById('audit-findings-list');
  if (!box) return;
  box.innerHTML = '<div style="color:var(--text3);font-size:12px;text-align:center;padding:16px">⏳ Running live checks…</div>';
  try {
    const d = await _api('/api/compliance/audit-findings');
    window._auditFindings = d.data || [];
    renderAuditFindings(window._currentFindingFilter || 'all');
  } catch (e) {
    box.innerHTML = `<div style="color:#fca5a5;font-size:12px;text-align:center;padding:16px">Could not run the checks: ${_escHTML(e.message)}</div>`;
  }
}
function renderAuditFindings(filter) {
  window._currentFindingFilter = filter;
  const box = document.getElementById('audit-findings-list');
  if (!box) return;
  const all = window._auditFindings || [];
  const rows = filter === 'all' ? all : all.filter(f => f.severity === filter);
  if (!all.length) { box.innerHTML = '<div style="color:#6ee7b7;font-size:12px;text-align:center;padding:16px">✅ No open findings — every live check passes.</div>'; return; }
  if (!rows.length) { box.innerHTML = '<div style="color:var(--text3);font-size:12px;text-align:center;padding:16px">No open findings at this severity.</div>'; return; }
  const bg = { critical: 'rgba(239,68,68,.08)', high: 'rgba(245,158,11,.06)', medium: 'var(--bg3)' };
  const bd = { critical: 'rgba(239,68,68,.3)', high: 'rgba(245,158,11,.2)', medium: 'var(--border)' };
  const tc = { critical: '#fca5a5', high: '#fcd34d', medium: '#a5b4fc' };
  box.innerHTML = rows.map(f => `
    <div style="padding:10px 12px;background:${bg[f.severity] || 'var(--bg3)'};border:1px solid ${bd[f.severity] || 'var(--border)'};border-radius:8px;margin-bottom:8px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">
        <div style="font-size:12px;font-weight:600;color:var(--text)">${_escHTML(f.label)}</div>
        <span class="tag" style="color:${tc[f.severity] || '#a5b4fc'}">${_escHTML((f.severity || '').toUpperCase())}</span>
      </div>
      <div style="font-size:10px;color:var(--text2);margin-top:4px;line-height:1.5">${_escHTML(f.description || '')}</div>
      <div style="font-size:10px;color:var(--text3);margin-top:4px">How to fix: ${_escHTML(FINDING_HINTS[f.key] || 'See the DPDPA tracker below.')}</div>
    </div>`).join('');
}
function filterFindings(sev) { renderAuditFindings(sev); }

function renderCERTInChecklist() {
  const box = document.getElementById('certin-checklist');
  if (!box) return;
  box.innerHTML = '<div style="font-size:10px;color:var(--text3);margin-bottom:6px">Self-declared — tick an item once it is actually in place. Saved on the server.</div>' +
    CERTIN_ITEMS.map(item => {
      const on = _isOn(_complianceSettings[item.key]);
      return `<label style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid rgba(30,45,74,.5);cursor:pointer">
        <input type="checkbox" ${on ? 'checked' : ''} onchange="updateComplianceSetting('${item.key}', this.checked, this)">
        <div><div style="font-size:12px;font-weight:500;color:${on ? 'var(--text)' : '#fcd34d'}">${_escHTML(item.label)}</div>
        <div style="font-size:10px;color:var(--text2)">${_escHTML(item.req)}</div></div></label>`;
    }).join('');
}

// ── Officers (DPO / Grievance) ─────────────────────────────────────────
async function loadOfficersFromServer() {
  try {
    const data = await _api('/api/compliance/officers');
    const go = data.grievance_officer;
    if (go) {
      const n = document.getElementById('go-name'); if (n && go.name) n.value = go.name;
      const e = document.getElementById('go-email'); if (e && go.email) e.value = go.email;
      const p = document.getElementById('go-phone'); if (p && go.phone) p.value = go.phone;
      if (go.name && go.email) showGrievanceOfficerSaved(go.name, go.email, go.phone || '');
    }
    const dpo = data.dpo;
    if (dpo) {
      const dn = document.getElementById('dpo-name'); if (dn && dpo.name) dn.value = dpo.name;
      const de = document.getElementById('dpo-email'); if (de && dpo.email) de.value = dpo.email;
      const sn = document.getElementById('summary-dpo-name'); if (sn) sn.innerText = dpo.name || '';
      if (dpo.name) {
        const cmd = document.getElementById('dpo-command-center'); if (cmd) cmd.style.display = 'none';
        const sum = document.getElementById('dpo-summary-section'); if (sum) sum.style.display = 'block';
      }
    }
  } catch (e) { console.warn('[compliance] Could not load officer data:', e.message); }
}
async function saveGrievanceOfficer() {
  const val = id => (document.getElementById(id) || {}).value?.trim() || '';
  const name = val('go-name'), email = val('go-email'), phone = val('go-phone');
  if (!name || !email) { showToast('⚠️ Please enter both Name and Email.'); return; }
  try {
    await _api('/api/compliance/officers', { method: 'POST', body: JSON.stringify({ grievance_officer: { name, email, phone } }) });
    showToast('✅ Grievance Officer saved');
    showGrievanceOfficerSaved(name, email, phone);
    if (typeof refreshComplianceStatus === 'function') refreshComplianceStatus(true);
  } catch (e) { showToast('❌ Failed to save: ' + e.message); }
}
function showGrievanceOfficerSaved(name, email, phone) {
  document.getElementById('go-saved-name').textContent = name || '—';
  document.getElementById('go-saved-email').textContent = email || '—';
  document.getElementById('go-saved-phone').textContent = phone || '—';
  document.getElementById('go-saved-view').style.display = 'block';
  document.getElementById('go-edit-form').style.display = 'none';
}
function editGrievanceOfficer() {
  document.getElementById('go-saved-view').style.display = 'none';
  document.getElementById('go-edit-form').style.display = 'block';
  document.getElementById('go-cancel-btn').style.display = 'inline-flex';
}
function cancelEditGrievanceOfficer() {
  document.getElementById('go-saved-view').style.display = 'block';
  document.getElementById('go-edit-form').style.display = 'none';
}
async function saveDPO() {
  const name = document.getElementById('dpo-name').value.trim();
  const email = document.getElementById('dpo-email').value.trim();
  if (!name || !email) { showToast('⚠️ Please enter both Name and Email.'); return; }
  try {
    await _api('/api/compliance/officers', { method: 'POST', body: JSON.stringify({ dpo: { name, email } }) });
    const sn = document.getElementById('summary-dpo-name'); if (sn) sn.innerText = name;
    const cmd = document.getElementById('dpo-command-center'); if (cmd) cmd.style.display = 'none';
    const sum = document.getElementById('dpo-summary-section'); if (sum) sum.style.display = 'block';
    showToast('✅ Data Protection Officer saved');
    if (typeof refreshComplianceStatus === 'function') refreshComplianceStatus(true);
  } catch (e) { showToast('❌ Failed to save DPO: ' + e.message); }
}
function toggleDPOEdit() {
  document.getElementById('dpo-summary-section').style.display = 'none';
  document.getElementById('dpo-command-center').style.display = 'block';
}

// ── Exports (all from the live checks) ─────────────────────────────────
async function _liveChecks() {
  const d = await _api('/api/compliance/status');
  return d;
}
async function downloadComplianceSummary() {
  try {
    const d = await _liveChecks();
    const rows = (d.checks || []).map(c => ({ Check: c.title, Severity: c.severity, Status: c.status ? 'Pass' : 'Fail', Evidence: c.description || '' }));
    rows.push({ Check: 'OVERALL', Severity: '', Status: `${d.passed}/${d.total} passed (${d.score}%)`, Evidence: 'Evaluated ' + new Date(d.audited_at).toLocaleString('en-IN') });
    _xlsxOrCSV(rows, 'MITRA_Compliance_Summary');
  } catch (e) { showToast('❌ Could not build the summary: ' + e.message); }
}
async function exportDPDPAReport() { return downloadComplianceSummary(); }
async function exportComplianceXLSX(fmt) {
  try {
    const [d, f] = await Promise.all([_liveChecks(), _api('/api/compliance/audit-findings')]);
    const rows = [
      ...(d.checks || []).map(c => ({ Type: 'Check', Item: c.title, Severity: c.severity, Status: c.status ? 'Pass' : 'Fail', Detail: c.description || '' })),
      ...CERTIN_ITEMS.map(i => ({ Type: 'CERT-In (self-declared)', Item: i.label, Severity: '', Status: _isOn(_complianceSettings[i.key]) ? 'Declared in place' : 'Not declared', Detail: i.req })),
      ...(f.data || []).map(x => ({ Type: 'Open finding', Item: x.label, Severity: x.severity, Status: 'Open', Detail: FINDING_HINTS[x.key] || '' })),
    ];
    _xlsxOrCSV(rows, 'MITRA_Compliance_Full', fmt);
  } catch (e) { showToast('❌ Export failed: ' + e.message); }
}
function exportComplianceCSV() { return exportComplianceXLSX('csv'); }
function exportConsentLog() {
  showToast('Generating consent log XLSX…');
  fetch('/api/compliance/consent-log/export', { headers: _authH(false) })
    .then(r => { if (!r.ok) throw new Error('export-failed'); return r.blob(); })
    .then(blob => { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'Consent_Log_Export.xlsx'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); })
    .catch(() => showToast('❌ Consent log export failed'));
}
function exportData(type, fmt) {
  showToast('Generating ' + type + ' ' + fmt.toUpperCase() + '…');
  fetch('/api/compliance/export?type=' + encodeURIComponent(type) + '&format=' + encodeURIComponent(fmt), { headers: _authH(false) })
    .then(r => { if (!r.ok) throw new Error('export-failed'); return r.blob(); })
    .then(blob => { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `MITRA_${type}_export.${fmt}`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); })
    .catch(() => showToast('❌ Export failed'));
}

// ── Readiness certificate — states the REAL result of the live checks ──
async function openCertificateModal() {
  let d;
  try { d = await _liveChecks(); } catch (e) { showToast('❌ Could not run the checks: ' + e.message); return; }
  const checks = d.checks || [];
  const failed = checks.filter(c => !c.status);
  const critical = failed.filter(c => c.severity === 'critical');
  const ready = failed.length === 0;
  const val = id => (document.getElementById(id) || {}).value || '';
  const org = val('cert-org') || 'Your Organisation';
  const product = val('cert-product') || 'MITRA Admin Platform';
  const validEl = document.getElementById('cert-validity');
  const validUntil = validEl && validEl.value ? new Date(validEl.value).toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' }) : '—';
  const signatory = val('cert-signatory');
  const refInput = document.getElementById('cert-refno');
  const ref = (refInput && refInput.value) || ('MITRA-SA-' + Date.now().toString(36).toUpperCase());
  if (refInput && !refInput.value) refInput.value = ref;
  const issueDate = new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
  const title = ready ? 'ALL LIVE CHECKS PASSED' : (critical.length ? 'ACTION REQUIRED — CRITICAL ITEMS OPEN' : 'ACTION REQUIRED');
  const colour = ready ? '#047857' : (critical.length ? '#b91c1c' : '#b45309');

  const certHTML = `
  <div id="cert-printable" style="font-family:'DM Sans',sans-serif;padding:40px;background:#fff;color:#1e1b4b;max-width:780px;margin:0 auto">
    <div style="text-align:center;margin-bottom:24px;padding-bottom:20px;border-bottom:2px solid #e0e7ff">
      <div style="font-size:11px;font-weight:700;color:#6366f1;letter-spacing:3px;text-transform:uppercase;margin-bottom:10px">MITRA PLATFORM · INTERNAL SELF-ASSESSMENT</div>
      <div style="font-size:24px;font-weight:900;color:${colour};letter-spacing:1px;text-transform:uppercase">${title}</div>
      <div style="font-size:13px;color:#64748b;margin-top:6px">Compliance Readiness — ${d.passed}/${d.total} live checks passed (${d.score}%)</div>
    </div>
    <div style="text-align:center;margin-bottom:18px">
      <div style="font-size:16px;font-weight:700">${_escHTML(org)}</div>
      <div style="font-size:13px;color:#64748b;margin-top:4px">${_escHTML(product)}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:18px">
      ${checks.map(c => `<tr><td style="padding:6px 8px;border-bottom:1px solid #eef2ff">${c.status ? '✅' : (c.severity === 'critical' ? '⛔' : '❌')} ${_escHTML(c.title)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eef2ff;color:#64748b">${_escHTML(c.description || '')}</td></tr>`).join('')}
    </table>
    <div style="font-size:10.5px;color:#64748b;line-height:1.7;margin-bottom:18px">
      Frameworks considered: DPDP Act 2023 · IT Act 2000 §43A · CERT-In Directions 2022. CERT-In items are self-declared on the Compliance page.
      No external certification (e.g. ISO/IEC 27001) is claimed by this document.
    </div>
    <div style="display:flex;justify-content:space-between;align-items:flex-end;padding-top:16px;border-top:1px solid #e0e7ff;font-size:11px;color:#64748b;line-height:1.9">
      <div>
        <div>Reference No. <strong style="color:#1e1b4b;font-family:monospace">${_escHTML(ref)}</strong></div>
        <div>Assessed on <strong style="color:#1e1b4b">${issueDate}</strong></div>
        <div>Review by <strong style="color:#1e1b4b">${validUntil}</strong></div>
      </div>
      <div style="text-align:right">
        <div style="width:160px;border-bottom:1.5px solid #1e1b4b;margin-bottom:5px;margin-left:auto"></div>
        ${signatory ? `<div style="font-weight:700;color:#1e1b4b;font-size:12px">${_escHTML(signatory)}</div>` : '<div style="font-style:italic">Authorised Signatory</div>'}
        <div>${_escHTML(org)}</div>
      </div>
    </div>
  </div>`;
  const content = document.getElementById('cert-content');
  if (content) content.innerHTML = certHTML;
  const modal = document.getElementById('cert-modal');
  if (modal) { modal.style.display = 'flex'; document.body.style.overflow = 'hidden'; }
}
function closeCertificateModal() {
  const modal = document.getElementById('cert-modal');
  if (modal) modal.style.display = 'none';
  document.body.style.overflow = '';
}
function printCertificate() {
  const content = document.getElementById('cert-printable');
  if (!content) return;
  const win = window.open('', '_blank', 'width=900,height=700');
  win.document.write(`<!DOCTYPE html><html><head><title>Compliance Self-Assessment</title>
  <style>* { box-sizing:border-box;margin:0;padding:0; } body { font-family:sans-serif; } @media print { body { -webkit-print-color-adjust:exact; } }</style>
  </head><body>${content.outerHTML}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => { win.print(); }, 500);
}

// ==UserScript==
// @name         Torn Attack Intelligence – Hospital Dashboard
// @namespace    https://github.com/PatchPilotGer/torn-attack-intelligence
// @version      0.1.1
// @description  Incoming attacks, repeat offenders, mugging losses and location coverage on Torn's Hospital page (TornPDA).
// @author       PatchPilotGer
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

/*
 * No third-party endpoints. API calls go only to https://api.torn.com/v2.
 * The PDA API key is injected by TornPDA. Never paste API keys in GitHub.
 * The dashboard is scoped to /hospitalview.php and /hospital.php.
 */
(() => {
  'use strict';
  if (window.top !== window.self) return;
  if (!/^\/(hospitalview|hospital)\.php$/i.test(location.pathname)) return;
  if (document.getElementById('tai-root')) return;

  const API_KEY = '###PDA-APIKEY###';
  const VERSION = '0.1.1';
  const DB_KEY = 'tai-db-v1';
  const MAX_PAGES_REGULAR = 3;
  const MAX_PAGES_BACKFILL = 12;
  const SAMPLE_MAX_GAP = 60 * 60; // No denominator extrapolation across missing observations.
  const LOG_MUG_RECEIVED = 8156;
  const COUNTRY_NAMES = ['Torn City', 'Mexico', 'Cayman Islands', 'Canada', 'Hawaii', 'United Kingdom', 'Argentina', 'Switzerland', 'Japan', 'China', 'UAE', 'South Africa'];
  const EMPTY = { schema: 1, attacks: {}, mugs: {}, samples: [], meta: { updated: null, apiErrors: [] } };
  let db = JSON.parse(JSON.stringify(EMPTY));
  let range = '7';
  let isSyncing = false;
  let hasNativeStorage = typeof PDA_storage !== 'undefined' && typeof PDA_storage.get === 'function';

  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = amount => amount == null ? '—' : '$' + Number(amount).toLocaleString('en-US', {maximumFractionDigits:0});
  const number = n => Number(n).toLocaleString('de-DE');
  const utcDate = epoch => new Date(epoch * 1000).toISOString().slice(0, 10);
  const utcMonth = epoch => new Date(epoch * 1000).toISOString().slice(0, 7);
  const utcWeek = epoch => {
    const day = new Date(epoch * 1000);
    const weekday = (day.getUTCDay() + 6) % 7;
    day.setUTCDate(day.getUTCDate() - weekday);
    return day.toISOString().slice(0, 10);
  };
  const selectedFrom = () => range === 'all' ? 0 : Math.floor(Date.now() / 1000) - Number(range) * 86400;
  const within = ts => ts >= selectedFrom();
  const stableId = x => String(x.id || x.attack_id || x.code || '').trim();
  const nOrNull = x => x === null || x === undefined || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : null;
  const titleDate = ts => new Date(ts * 1000).toLocaleString('de-DE', {timeZone:'UTC', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'});

  async function readDb() {
    try {
      const existing = hasNativeStorage ? await PDA_storage.get(DB_KEY, null) : JSON.parse(localStorage.getItem(DB_KEY) || 'null');
      if (existing && existing.schema === 1) {
        db = { ...JSON.parse(JSON.stringify(EMPTY)), ...existing,
          attacks: existing.attacks || {}, mugs: existing.mugs || {},
          samples: Array.isArray(existing.samples) ? existing.samples : [],
          meta: {...EMPTY.meta, ...existing.meta} };
      }
    } catch (err) {
      showMessage('Speicher konnte nicht geladen werden: ' + err.message, true);
    }
  }
  async function saveDb() {
    if (hasNativeStorage) await PDA_storage.set(DB_KEY, db);
    else localStorage.setItem(DB_KEY, JSON.stringify(db));
  }
  async function callApi(path, params = {}) {
    if (!API_KEY || API_KEY.includes('PDA-APIKEY')) throw new Error('Kein TornPDA-API-Key verfügbar. Script in TornPDA ausführen.');
    if (typeof PDA_httpGet !== 'function') throw new Error('TornPDA HTTP-Bridge fehlt. Kein direkter Key-Versand aus dem Browser.');
    const url = new URL('https://api.torn.com/v2/' + path);
    for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    url.searchParams.set('comment', 'AttackIntel');
    const res = await PDA_httpGet(url.toString(), {Authorization: 'ApiKey ' + API_KEY});
    if (!res || Number(res.status) < 200 || Number(res.status) >= 300) throw new Error(path + ': HTTP ' + (res?.status ?? 'unbekannt'));
    let data;
    try { data = JSON.parse(res.responseText); } catch (_) { throw new Error(path + ': keine gültige JSON-Antwort'); }
    if (data.error) throw new Error(path + ': ' + (data.error.error || JSON.stringify(data.error)));
    return data;
  }
  function normalizeAttack(a) {
    const id = stableId(a);
    if (!id || !Number.isFinite(Number(a.ended ?? a.timestamp_ended))) return null;
    const attacker = a.attacker && Number(a.attacker.id) > 0 ? a.attacker : null;
    return {id, started: Number(a.started ?? a.timestamp_started ?? a.ended),
      ended: Number(a.ended ?? a.timestamp_ended),
      result: String(a.result || 'Unknown'), attackerId: attacker ? Number(attacker.id) : null,
      attackerName: attacker ? String(attacker.name || '#' + attacker.id) : null,
      faction: attacker?.faction?.name || null,
      stealthed: !!a.is_stealthed, code: String(a.code || ''),
      rankedWar: !!a.is_ranked_war};
  }
  function getMoneyLoss(log) {
    // The /user/log data object is dynamic and not described by OpenAPI.
    // Do not interpret arbitrary amounts or balances as a verified loss.
    const data = log?.data || {};
    for (const key of ['money', 'money_lost', 'money_stolen', 'amount_stolen', 'stolen', 'mugged', 'cash_stolen', 'amount']) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        const value = nOrNull(data[key]);
        if (value != null && value >= 0) return value;
      }
    }
    return null;
  }
  function normalizeMugLog(log) {
    if (Number(log?.details?.id) !== LOG_MUG_RECEIVED || !log.id || !Number.isFinite(Number(log.timestamp))) return null;
    const data = log.data || {};
    return {id: String(log.id), ts: Number(log.timestamp), amount: getMoneyLoss(log),
      // Keep only known public ID fields; no free text from the log is rendered.
      attackId: data.attack_id != null ? String(data.attack_id) : (data.attackId != null ? String(data.attackId) : null) };
  }
  async function fetchPages(endpoint, settings, kind, maxPages) {
    let params = {...settings};
    let imported = 0;
    let pages = 0;
    const from = Math.max(0, (Math.floor(Date.now() / 1000) - 365 * 86400));
    const seenCursors = new Set();
    for (let page = 0; page < maxPages; page++) {
      const data = await callApi(endpoint, params);
      const entries = data[kind];
      if (!Array.isArray(entries)) throw new Error('Unerwartete API-Struktur für ' + endpoint);
      let oldest = Infinity;
      let changes = 0;
      for (const entry of entries) {
        const obj = kind === 'attacks' ? normalizeAttack(entry) : normalizeMugLog(entry);
        if (!obj) continue;
        const key = obj.id;
        const collection = kind === 'attacks' ? db.attacks : db.mugs;
        if (!collection[key]) changes++;
        collection[key] = obj;
        const ts = kind === 'attacks' ? obj.ended : obj.ts;
        if (ts < oldest) oldest = ts;
      }
      imported += changes;
      pages++;
      if (entries.length < Number(settings.limit) || !Number.isFinite(oldest) || oldest <= from) break;
      const nextTo = oldest - 1;
      if (seenCursors.has(nextTo)) break;
      seenCursors.add(nextTo);
      params = {...params, to: nextTo};
    }
    return {imported, pages};
  }
  function inferPlace(profile, travel) {
    const status = profile?.status || {};
    const state = String(status.state || '').toLowerCase();
    if (state === 'traveling' || state === 'travelling') return 'Flug';
    if (state === 'abroad') return 'Ausland';
    const destination = String(travel?.destination || '').trim();
    if (COUNTRY_NAMES.includes(destination)) return destination === 'Torn City' ? 'Torn City' : 'Ausland';
    const info = String(status.description || '') + ' ' + String(status.details || '');
    if (/travel(ing|ling)/i.test(info)) return 'Flug';
    if (/torn city/i.test(info)) return 'Torn City';
    if (COUNTRY_NAMES.slice(1).some(name => info.toLowerCase().includes(name.toLowerCase()))) return 'Ausland';
    return 'Unbekannt';
  }
  function addPlaceSample(place) {
    const ts = Math.floor(Date.now() / 1000);
    if (!place || place === 'Unbekannt') return;
    const prev = db.samples[db.samples.length - 1];
    if (prev && prev.place === place && ts - prev.ts < 300) return;
    db.samples.push({ts, place});
    db.samples = db.samples.slice(-20000);
  }
  async function fetchCurrentLocation() {
    const [a,b] = await Promise.allSettled([callApi('user/basic'), callApi('user/travel')]);
    const profile = a.status === 'fulfilled' ? (a.value.profile || a.value.basic || a.value) : null;
    const travel = b.status === 'fulfilled' ? (b.value.travel || b.value) : null;
    if (profile || travel) addPlaceSample(inferPlace(profile, travel));
  }
  async function sync(backfill = false) {
    if (isSyncing) return;
    isSyncing = true;
    setBusy(true);
    const notes = [];
    const pages = backfill ? MAX_PAGES_BACKFILL : MAX_PAGES_REGULAR;
    try {
      const a = await fetchPages('user/attacks', {filters:'incoming', limit:100, sort:'DESC'}, 'attacks', pages);
      notes.push(`${a.imported} neue Angriffe`);
    } catch (err) { notes.push('Angriffe: ' + err.message); }
    try {
      const m = await fetchPages('user/log', {log:LOG_MUG_RECEIVED, limit:100}, 'log', pages);
      notes.push(`${m.imported} neue Mugging-Logs`);
    } catch (err) { notes.push('Geldbeträge (optionale Full/Custom-API): ' + err.message); }
    try { await fetchCurrentLocation(); } catch (_) { /* unavailable locations stay unknown */ }
    db.meta.updated = Math.floor(Date.now() / 1000);
    db.meta.apiErrors = notes.filter(n => n.includes(':'));
    try { await saveDb(); } catch (err) { notes.push('Speicher: ' + err.message); }
    isSyncing = false;
    setBusy(false);
    render();
    showMessage(notes.join(' · '), db.meta.apiErrors.length > 0);
  }
  function matchMugs(attacks, mugs) {
    // Match a log to at most one incoming attack. Unmatched log stays "not assignable".
    const byId = new Map(attacks.map(a => [a.id, a]));
    const used = new Set();
    const linked = new Map();
    const unassigned = [];
    for (const m of [...mugs].sort((a,b) => a.ts - b.ts)) {
      let match = m.attackId && byId.has(m.attackId) ? byId.get(m.attackId) : null;
      if (!match) {
        let bestGap = Infinity;
        for (const a of attacks) {
          if (String(a.result).toLowerCase() !== 'mugged' || used.has(a.id)) continue;
          const gap = Math.abs(a.ended - m.ts);
          if (gap <= 120 && gap < bestGap) { bestGap = gap; match = a; }
        }
      }
      if (match && !used.has(match.id)) { linked.set(match.id, m); used.add(match.id); }
      else unassigned.push(m);
    }
    return {linked, unassigned};
  }
  function makeStats() {
    const attacks = Object.values(db.attacks).filter(a => within(a.ended)).sort((a,b) => a.ended - b.ended);
    const mugs = Object.values(db.mugs).filter(m => within(m.ts));
    const {linked, unassigned} = matchMugs(attacks, mugs);
    const known = new Map();
    for (const a of attacks) {
      if (!a.attackerId) continue;
      const key = String(a.attackerId);
      if (!known.has(key)) known.set(key, {id:a.attackerId, name:a.attackerName, hits:0, loss:0, priced:0, last:0});
      const stat = known.get(key);
      stat.hits++; stat.name = a.attackerName || stat.name; stat.last = Math.max(stat.last, a.ended);
      const log = linked.get(a.id);
      if (log?.amount != null) { stat.loss += log.amount; stat.priced++; }
    }
    const knownLoss = [...known.values()].reduce((s,v)=>s+v.loss,0);
    let anonLoss = 0, anonPriced = 0;
    for (const a of attacks) {
      if (a.attackerId) continue;
      const log = linked.get(a.id);
      if (log?.amount != null) { anonLoss += log.amount; anonPriced++; }
    }
    const unassignedLoss = unassigned.filter(m => m.amount != null).reduce((s,m)=>s+m.amount,0);
    return { attacks, mugs, linked, known: [...known.values()].sort((a,b)=>b.hits-a.hits || b.loss-a.loss),
      loss: knownLoss+anonLoss+unassignedLoss, knownLoss, anonLoss, unassignedLoss,
      verifiedMugs: mugs.filter(m=>m.amount != null).length,
      unknownMugs: mugs.filter(m=>m.amount == null).length,
      anonymous: attacks.filter(a=>!a.attackerId).length, anonPriced };
  }
  function buildSeries(attacks, keyFn) {
    const groups = new Map();
    for (const attack of attacks) { const k = keyFn(attack.ended); groups.set(k, (groups.get(k)||0)+1); }
    return [...groups.entries()].sort((a,b)=>a[0].localeCompare(b[0])).slice(-31);
  }
  function renderBars(items) {
    if (!items.length) return '<div class="tai-muted">Noch keine Angriffe im gewählten Zeitraum.</div>';
    const max = Math.max(...items.map(x=>x[1]),1);
    return `<div class="tai-bars">${items.map(([key,value])=>`<div class="tai-bar"><span>${esc(key)}</span><div><i style="width:${Math.max(2, value/max*100).toFixed(1)}%"></i></div><b>${number(value)}</b></div>`).join('')}</div>`;
  }
  function renderHeatmap(attacks) {
    const cells = Array(168).fill(0);
    for (const a of attacks) { const d = new Date(a.ended*1000); cells[((d.getUTCDay()+6)%7)*24+d.getUTCHours()]++; }
    const max = Math.max(1,...cells);
    const week = ['Mo','Di','Mi','Do','Fr','Sa','So'];
    return '<div class="tai-heatwrap"><div class="tai-heat">' + week.map((day,i)=>`<div class="tai-daylabel">${day}</div>` + Array.from({length:24},(_,hour)=>`<div class="tai-cell" title="${day} ${hour}:00 UTC – ${cells[i*24+hour]} Angriffe" style="opacity:${(0.12 + 0.88*cells[i*24+hour]/max).toFixed(2)}"></div>`).join('')).join('') + '</div><div class="tai-muted">Je Zeile Mo–So, je 24 Spalten (0–23 Uhr UTC). Heller = häufiger.</div></div>';
  }
  function getCoverage(attacks) {
    const start = selectedFrom();
    const now = Math.floor(Date.now()/1000);
    const samples = db.samples.filter(s => s.ts >= start - SAMPLE_MAX_GAP && s.ts <= now);
    const windows = [];
    const covered = {'Torn City':0,'Ausland':0};
    for (let i=0; i<samples.length-1; i++) {
      const a=samples[i], b=samples[i+1];
      if (!covered.hasOwnProperty(a.place) || a.place !== b.place || b.ts-a.ts > SAMPLE_MAX_GAP) continue;
      const left=Math.max(start,a.ts), right=Math.min(now,b.ts);
      if (right <= left) continue;
      windows.push({start:left, end:right, place:a.place});
      covered[a.place] += right-left;
    }
    const counts = {'Torn City':0,'Ausland':0,Unbekannt:0};
    for (const a of attacks) {
      const found=windows.find(w=>a.ended >= w.start && a.ended < w.end);
      if (found) counts[found.place]++; else counts.Unbekannt++;
    }
    return {counts, covered};
  }
  function renderLocations(attacks) {
    const {counts, covered} = getCoverage(attacks);
    const lastSample=db.samples.at(-1);
    const current=lastSample?`Letzter Standort-Sample: ${lastSample.place} (${titleDate(lastSample.ts)} UTC); ${db.samples.length} Beobachtungen insgesamt. Aufenthaltszeit entsteht erst durch zwei übereinstimmende Samples innerhalb von 60 Minuten.`:'Noch keine zuverlässigen Standort-Samples. Die Erfassung startet erst mit erfolgreichen Standortabfragen; frühere Reisen können nicht rückwirkend rekonstruiert werden.';
    return `<div class="tai-muted" style="margin-bottom:8px">${esc(current)}</div><div class="tai-location-grid">${['Torn City','Ausland'].map(place=>{
      const hrs = covered[place] / 3600;
      const rate = hrs >= 1 ? (counts[place]*24/hrs).toFixed(2).replace('.',',') : '—';
      return `<div class="tai-loc"><b>${place}</b><strong>${number(counts[place])}</strong><small>${hrs.toFixed(1).replace('.',',')} h gesichert beobachtet</small><div>${rate} Angriffe / 24 h</div></div>`;
    }).join('')}</div><div class="tai-muted">${counts.Unbekannt} Angriffe ohne verlässliche Standortzuordnung. Quoten nur aus aufeinanderfolgenden, gleichlautenden Standort-Samples mit max. 60 Min Abstand. Flugzeit wird nicht gewertet.</div>`;
  }
  function buildUi() {
    const root = document.createElement('section');
    root.id = 'tai-root';
    root.innerHTML = `<div class="tai-header"><div><div class="tai-eyebrow">TORN PDA · HOSPITAL</div><div class="tai-title">🛡️ Attack Intelligence <span>v${VERSION}</span></div></div><button type="button" id="tai-collapse" aria-label="Dashboard ein- oder ausklappen">−</button></div>
      <div id="tai-content"><div class="tai-toolbar"><select id="tai-period" aria-label="Zeitraum"><option value="1">24 Stunden</option><option value="7" selected>7 Tage</option><option value="30">30 Tage</option><option value="all">Gesamt</option></select><button id="tai-refresh">↻ Aktualisieren</button><button id="tai-backfill" title="Längeren Verlauf nachladen">⤓ Historie</button></div>
      <p id="tai-message" class="tai-muted">Lade lokale Historie…</p><div id="tai-kpis"></div>
      <div class="tai-section"><h3>Angriffe · Tag / Woche / Monat</h3><div class="tai-tabs"><button data-group="day" class="active">Tag</button><button data-group="week">Woche</button><button data-group="month">Monat</button></div><div id="tai-timeseries"></div></div>
      <div class="tai-section"><h3>Bekannte Angreifer & Wiederholungstäter</h3><div id="tai-repeaters"></div></div>
      <div class="tai-section"><h3>Geldverluste</h3><div id="tai-money"></div></div>
      <div class="tai-section"><h3>Heatmap · UTC</h3><div id="tai-heatmap"></div></div>
      <div class="tai-section"><h3>Torn City vs. Ausland</h3><div id="tai-locations"></div></div>
      <div class="tai-foot">Nur eingehende Angriffe. Alle Uhrzeiten in Torn-Zeit (UTC). Blacklisting erfolgt manuell über das Spielerprofil → Enemies List → Allow Exchanges deaktivieren. Keine automatische Änderung an deinem Torn-Account.</div></div>`;
    const css = document.createElement('style');
    css.id = 'tai-style';
    css.textContent = `#tai-root{max-width:1050px;margin:12px auto 20px; padding:0;color:#e9edf6;background:#101827;border:1px solid #2e4257;border-radius:12px;font:13px/1.45 Arial,sans-serif;box-sizing:border-box;overflow:hidden;clear:both}#tai-root *{box-sizing:border-box}#tai-root .tai-header{background:linear-gradient(110deg,#163249,#111d31);padding:13px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px}#tai-root .tai-eyebrow{color:#87a9ba;letter-spacing:1.1px;font-size:10px}#tai-root .tai-title{font-size:19px;font-weight:800;line-height:1.3}#tai-root .tai-title span{font-size:10px;font-weight:400;color:#a1b4c5}#tai-root button,#tai-root select{background:#1f3149;border:1px solid #41546a;color:#eef5fc;border-radius:7px;padding:7px 10px;font:inherit;cursor:pointer}#tai-root button:hover{background:#2c4663}#tai-root button:disabled{opacity:.55;cursor:default}#tai-root .tai-toolbar{display:flex;gap:7px;flex-wrap:wrap;padding:12px 12px 4px}#tai-root #tai-message{padding:0 12px}#tai-root #tai-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:9px 12px 14px}#tai-root .tai-kpi{background:#1b293c;border-radius:8px;padding:10px;min-width:0}#tai-root .tai-kpi small{color:#a9bfd3;font-size:11px;display:block}#tai-root .tai-kpi strong{font-size:20px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#tai-root .tai-muted{color:#aab8c8;font-size:11px}#tai-root .tai-section{border-top:1px solid #2e4054;padding:10px 12px 12px}#tai-root h3{color:#e9edf6;font-size:14px;margin:0 0 10px}#tai-root .tai-tabs{display:flex;gap:6px;margin-bottom:9px}#tai-root .tai-tabs button{font-size:11px;padding:4px 10px}#tai-root button.active{background:#326b92}#tai-root .tai-bars{display:flex;flex-direction:column;gap:5px;max-height:230px;overflow:auto}#tai-root .tai-bar{display:grid;grid-template-columns:72px 1fr 32px;align-items:center;gap:5px;font-size:11px}#tai-root .tai-bar>div{height:9px;border-radius:4px;background:#253448;overflow:hidden}#tai-root .tai-bar i{display:block;height:100%;background:#48a3cc}#tai-root .tai-bar b{text-align:right}#tai-root .tai-table{width:100%;border-collapse:collapse;font-size:11px}#tai-root .tai-table th{text-align:left;color:#abc0d4;font-weight:400;padding:6px 4px;border-bottom:1px solid #354a60}#tai-root .tai-table td{padding:7px 4px;border-bottom:1px solid #273a4e;vertical-align:middle}#tai-root a{color:#82caed;text-decoration:none}#tai-root a.tai-action{display:inline-block;border:1px solid #55778f;border-radius:5px;padding:3px 5px;white-space:nowrap}#tai-root .tai-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}#tai-root .tai-lossbox,#tai-root .tai-loc{padding:10px;border-radius:8px;background:#1c2a3d}#tai-root .tai-lossbox small,#tai-root .tai-loc small{display:block;color:#b3c4d4;font-size:11px}#tai-root .tai-lossbox strong,#tai-root .tai-loc strong{display:block;font-size:18px}#tai-root .tai-heatwrap{overflow-x:auto}#tai-root .tai-heat{display:grid;grid-template-columns:27px repeat(24,minmax(7px,1fr));gap:3px;min-width:420px}#tai-root .tai-cell{height:13px;border-radius:3px;background:#26b6e7}#tai-root .tai-daylabel{font-size:10px;color:#a4bfd6;line-height:14px}#tai-root .tai-location-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:7px}#tai-root .tai-loc b{font-size:12px}#tai-root .tai-foot{padding:10px 12px;background:#142135;font-size:10px;color:#9eafc0}#tai-root .tai-alert{color:#f1c686!important}#tai-root [hidden]{display:none!important}@media(max-width:560px){#tai-root #tai-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}#tai-root .tai-kpi strong{font-size:19px}#tai-root .tai-table th:nth-child(4),#tai-root .tai-table td:nth-child(4){display:none}#tai-root .tai-location-grid{grid-template-columns:1fr}}`;
    document.head.appendChild(css);
    // Place above Torn's hospital player list, without replacing the host page content.
    const container = document.querySelector('#mainContainer .content-wrapper') ||
       document.querySelector('.content-wrapper') || document.querySelector('#mainContainer') || document.querySelector('main') || document.body;
    container.insertBefore(root, container.firstChild);
    return root;
  }
  let root;
  let group = 'day';
  const node = id => root?.querySelector('#' + id);
  function showMessage(s, isWarning = false) {
    const message=node('tai-message');
    if (message) {message.textContent=s;message.classList.toggle('tai-alert',isWarning);}
  }
  function setBusy(busy) { for (const id of ['tai-refresh','tai-backfill']) if (node(id)) node(id).disabled = busy; }
  function render() {
    if (!root) return;
    const s = makeStats();
    const repeats = s.known.filter(k=>k.hits>=2);
    const kpis=[['Angriffe',number(s.attacks.length)],['Geldverlust (belegt)',s.verifiedMugs>0?money(s.loss):'—'],['Anonyme Angriffe',number(s.anonymous)],['Wiederholungstäter',number(repeats.length)]];
    node('tai-kpis').innerHTML=kpis.map(([label,value])=>`<div class="tai-kpi"><small>${esc(label)}</small><strong>${esc(value)}</strong></div>`).join('');
    node('tai-timeseries').innerHTML=renderBars(buildSeries(s.attacks, group==='day'?utcDate:group==='week'?utcWeek:utcMonth));
    node('tai-repeaters').innerHTML=s.known.length ? `<div class="tai-muted">${s.known.length} identifizierte Spieler, davon ${repeats.length} Wiederholungstäter (mind. 2 Angriffe). Zum Sperren das Profil öffnen und den Spieler zur Enemies List hinzufügen.</div><div style="overflow-x:auto"><table class="tai-table"><thead><tr><th>Spieler</th><th>Angriffe</th><th>Verlust*</th><th>Zuletzt</th><th>Blacklist</th></tr></thead><tbody>${s.known.map(r=>`<tr><td><a href="https://www.torn.com/profiles.php?XID=${r.id}" target="_self">${esc(r.name)}</a>${r.hits>=2?' <b title="Wiederholungstäter" style="color:#f0c884">★</b>':''}</td><td>${number(r.hits)}</td><td>${money(r.priced?r.loss:null)}</td><td>${titleDate(r.last)}</td><td><a class="tai-action" href="https://www.torn.com/profiles.php?XID=${r.id}" target="_self" title="Spielerprofil öffnen, manuell zur Enemies List hinzufügen">Profil ↗</a></td></tr>`).join('')}</tbody></table></div><div class="tai-muted">*Verlust nur aus zugeordneten Mugging-Logs; fehlende Logbeträge bleiben unbekannt.</div>`:'<div class="tai-muted">Keine Angreifer identifiziert. Anonyme Angriffe lassen keine eindeutige Zuordnung zu.</div>';
    const hasAmounts=s.verifiedMugs>0;
    const noLogAccess=(db.meta.apiErrors||[]).some(err=>/Geldbeträge.*(access level|permission|not high enough)/i.test(err));
    const verifiedOrUnknown=value=>hasAmounts?money(value):'—';
    node('tai-money').innerHTML=`<div class="tai-grid2">${[['Bekannte Täter',s.knownLoss],['Anonyme Täter',s.anonLoss],['Nicht zuordenbar',s.unassignedLoss],['Verifizierte Logs',s.verifiedMugs]].map(([label,value],i)=>`<div class="tai-lossbox"><small>${label}</small><strong>${i===3?number(value):verifiedOrUnknown(value)}</strong></div>`).join('')}</div><p class="tai-muted">${noLogAccess?'⚠️ Dein TornPDA-API-Key erlaubt keinen Zugriff auf user/log. Für Verlustbeträge benötigst du die Log-Berechtigung (Full oder passender Custom-Key).':'Beträge sind nur verifizierte Teilbeträge, nicht zwangsläufig die Gesamtverluste.'} ${number(s.unknownMugs)} Mugging-Logs ohne sicher lesbaren Betrag; historische Logs können fehlen. „—“ bedeutet unbekannt, nicht $0.</p>`;
    node('tai-heatmap').innerHTML=renderHeatmap(s.attacks);
    node('tai-locations').innerHTML=renderLocations(s.attacks);
  }
  async function init() {
    root=buildUi();
    node('tai-period').addEventListener('change',e=>{range=e.target.value;render();});
    node('tai-refresh').addEventListener('click',()=>sync(false));
    node('tai-backfill').addEventListener('click',()=>sync(true));
    node('tai-collapse').addEventListener('click',()=>{
      const content=node('tai-content');const collapsed=content.hidden=!content.hidden;
      node('tai-collapse').textContent=collapsed?'+':'−';
    });
    root.querySelectorAll('[data-group]').forEach(btn=>btn.addEventListener('click',()=>{
      group=btn.dataset.group;
      root.querySelectorAll('[data-group]').forEach(el=>el.classList.toggle('active',el===btn));
      render();
    }));
    await readDb();render();
    const last=db.meta.updated ? titleDate(db.meta.updated)+' UTC' : 'noch nie';
    showMessage('Letzte Aktualisierung: '+last+(hasNativeStorage?' · PDA-Speicher':' · Browser-Speicher'));
    if (!db.meta.updated || Math.floor(Date.now()/1000)-db.meta.updated >= 300) await sync(false);
  }
  // The Hospital page can render late. DOM observer only waits for the parent container.
  if (document.body) init().catch(err=>console.error('[Attack Intelligence]',err));
  else document.addEventListener('DOMContentLoaded',()=>init().catch(err=>console.error('[Attack Intelligence]',err)),{once:true});
})();
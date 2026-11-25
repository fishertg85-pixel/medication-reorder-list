/* ---------------- Calendar tab (switched on per pharmacy and per person by the Account Owner) ----------------
   The calendar is its own page (calendar.html) shown inside this one. It takes its storage and the signed-in
   person from window.ILCAL_HOST below, so it never has its own sign-in. The server checks every request: the
   person can open the pharmacy, has the Calendar privilege, and the pharmacy has Calendar switched on. */
const CAL_CFG = ['v', 'profile', 'sites', 'people', 'equipment', 'documents', 'tracks', 'plans', 'work', 'reminders', 'rooms'];
const CAL_COLLS = ['records', 'events', 'obl', 'log', 'exc'];
const CAL = {store: null, sig: {}, loadedAt: 0, inflight: 0};     // sig: what the server has, per item, as text
const calOK = () => !!(ME && STORE && STORE.calendar === true && PERM('calendar'));
const calPath = () => '/stores/' + encodeURIComponent(STORE.id) + '/calendar';
function calItems(st){                                           // the calendar's state, split the way the server keeps it
  const out = {};
  for(const k of CAL_CFG) if(st[k] !== undefined) out['cfg#' + k] = {kind: 'cfg', key: k, json: JSON.stringify(st[k])};
  const add = (c, a) => (a || []).forEach(o => { if(o && o.id) out[c + '#' + o.id] = {kind: c, key: o.id, json: JSON.stringify(o), obj: o}; });
  add('records', st.records); add('events', st.events); add('log', st.log); add('exc', st.exc);
  add('obl', Object.values(st.obl || {}).concat(st.custom || []));
  return out;
}
// who may complete which built-in task (the server enforces the same table; this only keeps the screen honest)
const CAL_ROLE = { 'dea-reg': 'Owner', 'dea-biennial': 'PIC', 'tx-cs-annual': 'PIC', 'cs-reconcile': 'PIC', 'cs-cycle': 'PIC', 'tx-pharmacy-license': 'Owner', 'tx-rph-license': 'PIC', 'tx-tech-reg': 'PIC', 'tx-pic-change': 'PIC', 'tx-pic-inventory': 'PIC', 'tx-officer-change': 'Owner', 'tx-location-change': 'Owner',
  'u795-training': 'DP', 'u795-sop': 'DP', 'u797-cert-pec': 'DP', 'u797-cert-sec': 'DP', 'u797-air': 'DP', 'u797-surface': 'DP', 'u797-sop': 'DP', 'u797-qaqc': 'DP', 'u797-didactic': 'DP', 'u797-garb': 'DP', 'u797-media': 'DP', 'u797-sporicidal': 'DP', 'u797-monitor-cal': 'DP', 'u797-pressure': 'DP',
  'u800-list': 'DP', 'u800-risk': 'DP', 'u800-sop': 'DP', 'u800-training': 'DP', 'u800-wipe': 'DP', 'osha-ecp': 'Owner', 'osha-training': 'Owner', 'hipaa-risk': 'Owner', 'hipaa-training': 'Owner', 'doc-review': 'PIC' };
function calMayCompleteHere(obId){
  if(ME && ME.acctType === 'staff' && !(STORE && STORE.owner)) return false;         // Associates see the calendar; a technician or pharmacist enters tasks
  const role = CAL_ROLE[obId]; if(!role || !ME || !STORE) return true;       // custom tasks: anyone with the calendar
  if(STORE.pharm) return true;
  if(role === 'Owner') return !!STORE.owner;
  if(role === 'DP') return ME.docDuty === 'dp' || ME.docDuty === 'ctech' || ME.acctType === 'tech' || !!(ME.dp && Object.values(ME.dp).some(v => v === true));
  return false;
}
const calCtxOf = r => ({me: r.me, team: r.team || [], delegations: r.delegations || [], timeoff: r.timeoff || [], expiring: r.expiring || {registrations: 0, expired: 0}});
window.ILCAL_HOST = {
  suite: true,                                                   // inside the suite: no inner navigation, the tabs above choose the view
  ctx: null,                                                     // what the server says about this person here: roles, team, delegations, time off
  mayComplete: obId => calMayCompleteHere(obId),
  get user(){ return ME ? {name: ME.name || ME.login, login: ME.login} : null; },
  get canStart(){ return !!(STORE && STORE.owner); },
  get pharmacy(){                                                // what the account already knows, to pre-fill starting the calendar
    if(!STORE) return null;
    const map = {controlled:'controlled', nonsterile:'nonsterile', sterile:'sterile', hazardous:'hazardous', immunizations:'bbp'};
    return {name: STORE.name, tz: STORE.timezone, hours: Array.isArray(STORE.hours) ? STORE.hours : null, closures: STORE.closures || null, holClosed: Array.isArray(STORE.holClosed) ? STORE.holClosed : null, ownerName: ME && ME.owner ? (ME.name || '') : '',
      features: (STORE.services || []).filter(k => map[k]).map(k => map[k])};
  },
  async load(){
    if(!calOK()) throw new Error('The calendar is not available for this login at this pharmacy.');
    const id = STORE.id, r = await api('GET', calPath());
    if(!STORE || STORE.id !== id) throw new Error('Pharmacy changed.');
    CAL.store = id; CAL.sig = {}; CAL.loadedAt = Date.now(); if(r.me) this.ctx = calCtxOf(r);
    if(!r.started) return null;
    const st = Object.assign({}, r.config, {mode: 'live'});
    st.records = r.records || []; st.exc = r.exc || []; st.events = r.events || []; st.log = (r.log || []).sort((a, b) => a.ts < b.ts ? 1 : -1).slice(0, 300);
    st.obl = {}; st.custom = [];
    (r.obl || []).forEach(o => { if(o.isCustom) st.custom.push(o); else st.obl[o.id] = o; });
    const items = calItems(st); for(const k in items) CAL.sig[k] = items[k].json;
    return st;
  },
  async sync(){                                                   // re-read after a review step: the server stamps who and when and decides the next step
    if(!calOK()) return null;
    const id = STORE.id, r = await api('GET', calPath()); if(!STORE || STORE.id !== id) return null;
    if(r.me) this.ctx = calCtxOf(r);
    const recs = r.records || [], log = (r.log || []).sort((a, b) => a.ts < b.ts ? 1 : -1).slice(0, 300), keep = {};
    recs.forEach(o => { keep['records#' + o.id] = 1; CAL.sig['records#' + o.id] = JSON.stringify(o); });
    for(const k of Object.keys(CAL.sig)) if(k.startsWith('records#') && !keep[k]) delete CAL.sig[k];
    log.forEach(o => { CAL.sig['log#' + o.id] = JSON.stringify(o); });
    const exc = r.exc || []; exc.forEach(o => { CAL.sig['exc#' + o.id] = JSON.stringify(o); });
    return {records: recs, log, exc};
  },
  async upload(f){                                               // task attachments go to the pharmacy's private file store
    const r = await api('POST', calPath() + '/upload-url', {name: f.name, size: f.size});
    const put = await fetch(r.url, {method: 'PUT', headers: r.headers, body: f}); if(!put.ok) throw new Error('The upload did not finish.');
    return {id: r.id, sizeBytes: f.size, contentType: f.type};
  },
  async fileUrl(id){ const r = await api('GET', calPath() + '/file/' + encodeURIComponent(id)); return r.url; },
  async call(kind, id, action, body){                            // delegations and time off: the server checks the rules, then the lists are re-read
    const path = calPath() + '/' + kind + (id ? '/' + encodeURIComponent(id) : '') + (action ? '/' + action : '');
    const r = await api('POST', path, body || {}); await this.sync(); return r;
  },
  async save(st){
    if(!calOK() || CAL.store !== STORE.id) throw new Error('Not saved: the pharmacy or access changed. Reload the Calendar tab.');
    const items = calItems(st), ops = [];
    for(const k in items) if(CAL.sig[k] !== items[k].json) ops.push({k, put: items[k]});
    for(const k in CAL.sig) if(!(k in items) && !k.startsWith('cfg#') && !k.startsWith('log#')) ops.push({k, del: k});
    CAL.inflight++; saving++;
    try{
      for(let i = 0; i < ops.length; i += 60){
        const chunk = ops.slice(i, i + 60), body = {config: {}, put: {}, del: {}};
        for(const o of chunk){
          if(o.put){ if(o.put.kind === 'cfg') body.config[o.put.key] = JSON.parse(o.put.json); else (body.put[o.put.kind] = body.put[o.put.kind] || []).push(o.put.obj); }
          else { const [c, ...id] = o.del.split('#'); (body.del[c] = body.del[c] || []).push(id.join('#')); }
        }
        await api('POST', calPath() + '/commit', body);
        for(const o of chunk){ if(o.put) CAL.sig[o.k] = o.put.json; else delete CAL.sig[o.k]; }
      }
    }finally{ CAL.inflight--; saving--; }
  }
};
const CALV = {view: 'dashboard', sub: ''};
function calPost(){ const f = $('calFrame'); try{ if(f.contentWindow && f.dataset.ready === '1') f.contentWindow.postMessage({ilcal: 'view', v: CALV.view, sub: CALV.sub}, location.origin); }catch(e){} }
function calShow(view, sub){                                     // called when the Dashboard or Calendar tab (or a view from the Account page) is opened
  const f = $('calFrame'); if(!calOK()) return;
  CALV.view = view || 'dashboard'; CALV.sub = sub || '';
  const stale = f.dataset.store !== STORE.id || (CAL.inflight === 0 && Date.now() - CAL.loadedAt > 180000);
  if(stale || !f.getAttribute('src') || f.getAttribute('src') === 'about:blank'){ f.dataset.store = STORE.id; f.dataset.ready = ''; CAL.loadedAt = Date.now(); f.onload = () => { f.dataset.ready = '1'; }; f.src = 'calendar.html?view=' + encodeURIComponent(CALV.view) + '&v=' + Date.now(); }
  else calPost();
}
// People & Assets and Setup live with the pharmacy account: opened from there, shown in the same page
function calOpenView(view){
  document.querySelectorAll('#tabs button').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-calendar'));
  document.body.classList.remove('wideTab'); calShow(view);
}
window.addEventListener('message', e => {
  if(e.origin !== location.origin || !e.data || !e.data.ilcal) return;
  if(e.data.ilcal === 'badge') calBadge(+e.data.n || 0);
  if(e.data.ilcal === 'close-view'){ const t = document.querySelector('#tabs [data-tab="owner"]'); if(t) t.click(); }
});
function calBadge(n){ const t = document.querySelector('#tabs [data-tab="dashboard"]'); if(!t) return; let b = t.querySelector('.tabbadge'); if(!n){ if(b) b.remove(); return; } if(!b){ b = document.createElement('span'); b.className = 'tabbadge'; t.appendChild(b); } b.textContent = String(n); }
function calPaint(){                                             // called whenever the pharmacy or the person changes
  const tabs = ['dashboard', 'calendar'].map(k => document.querySelector('#tabs [data-tab="' + k + '"]')); if(!tabs[0]) return;
  const ok = calOK(); tabs.forEach(t => { t.style.display = ok ? '' : 'none'; });
  const f = $('calFrame');
  if(!ok || (f.dataset.store && STORE && f.dataset.store !== STORE.id)){
    f.removeAttribute('data-store'); f.src = 'about:blank'; CAL.sig = {}; CAL.store = null; calBadge(0);
    if(tabs.some(t => t.classList.contains('active'))) homeTab();
  }
}
// a window open inside the Calendar page counts for leaving the Calendar tab
UG.external({ dirty: () => { try{ const w = $('calFrame').contentWindow; return !!(w.ILUG && w.ILUG.dirty()); }catch(e){ return false; } }, save: async () => { $('calFrame').contentWindow.ILUG.save(); }, discard: () => { $('calFrame').contentWindow.ILUG.discard(); } });

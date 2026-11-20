/* ---------------- Calendar tab (switched on per pharmacy and per person by the Account Owner) ----------------
   The calendar is its own page (calendar.html) shown inside this one. It takes its storage and the signed-in
   person from window.ILCAL_HOST below, so it never has its own sign-in. The server checks every request: the
   person can open the pharmacy, has the Calendar privilege, and the pharmacy has Calendar switched on. */
const CAL_CFG = ['v', 'profile', 'sites', 'people', 'equipment', 'documents', 'tracks', 'plans', 'work', 'reminders', 'rooms'];
const CAL_COLLS = ['records', 'events', 'obl', 'log'];
const CAL = {store: null, sig: {}, loadedAt: 0, inflight: 0};     // sig: what the server has, per item, as text
const calOK = () => !!(ME && STORE && STORE.calendar === true && PERM('calendar'));
const calPath = () => '/stores/' + encodeURIComponent(STORE.id) + '/calendar';
function calItems(st){                                           // the calendar's state, split the way the server keeps it
  const out = {};
  for(const k of CAL_CFG) if(st[k] !== undefined) out['cfg#' + k] = {kind: 'cfg', key: k, json: JSON.stringify(st[k])};
  const add = (c, a) => (a || []).forEach(o => { if(o && o.id) out[c + '#' + o.id] = {kind: c, key: o.id, json: JSON.stringify(o), obj: o}; });
  add('records', st.records); add('events', st.events); add('log', st.log);
  add('obl', Object.values(st.obl || {}).concat(st.custom || []));
  return out;
}
// who may complete which built-in task (the server enforces the same table; this only keeps the screen honest)
const CAL_ROLE = { 'dea-reg': 'Owner', 'dea-biennial': 'PIC', 'tx-cs-annual': 'PIC', 'cs-reconcile': 'PIC', 'cs-cycle': 'PIC', 'tx-pharmacy-license': 'Owner', 'tx-rph-license': 'PIC', 'tx-tech-reg': 'PIC', 'tx-pic-change': 'PIC', 'tx-pic-inventory': 'PIC', 'tx-officer-change': 'Owner', 'tx-location-change': 'Owner',
  'u795-training': 'DP', 'u795-sop': 'DP', 'u797-cert-pec': 'DP', 'u797-cert-sec': 'DP', 'u797-air': 'DP', 'u797-surface': 'DP', 'u797-sop': 'DP', 'u797-qaqc': 'DP', 'u797-didactic': 'DP', 'u797-garb': 'DP', 'u797-media': 'DP', 'u797-sporicidal': 'DP', 'u797-monitor-cal': 'DP', 'u797-pressure': 'DP',
  'u800-list': 'DP', 'u800-risk': 'DP', 'u800-sop': 'DP', 'u800-training': 'DP', 'u800-wipe': 'DP', 'osha-ecp': 'Owner', 'osha-training': 'Owner', 'hipaa-risk': 'Owner', 'hipaa-training': 'Owner', 'doc-review': 'PIC' };
function calMayCompleteHere(obId){
  const role = CAL_ROLE[obId]; if(!role || !ME || !STORE) return true;       // custom tasks: anyone with the calendar
  if(STORE.pharm) return true;
  if(role === 'Owner') return !!STORE.owner;
  if(role === 'DP') return ME.docDuty === 'dp' || ME.docDuty === 'ctech';
  return false;
}
window.ILCAL_HOST = {
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
    CAL.store = id; CAL.sig = {}; CAL.loadedAt = Date.now();
    if(!r.started) return null;
    const st = Object.assign({}, r.config, {mode: 'live'});
    st.records = r.records || []; st.events = r.events || []; st.log = (r.log || []).sort((a, b) => a.ts < b.ts ? 1 : -1).slice(0, 300);
    st.obl = {}; st.custom = [];
    (r.obl || []).forEach(o => { if(o.isCustom) st.custom.push(o); else st.obl[o.id] = o; });
    const items = calItems(st); for(const k in items) CAL.sig[k] = items[k].json;
    return st;
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
function calShow(){                                              // called when the Calendar tab is opened
  const f = $('calFrame'); if(!calOK()) return;
  const stale = f.dataset.store !== STORE.id || (CAL.inflight === 0 && Date.now() - CAL.loadedAt > 180000);
  if(stale || !f.getAttribute('src') || f.getAttribute('src') === 'about:blank'){ f.dataset.store = STORE.id; CAL.loadedAt = Date.now(); f.src = 'calendar.html?v=' + Date.now(); }
}
function calPaint(){                                             // called whenever the pharmacy or the person changes
  const tab = document.querySelector('#tabs [data-tab="calendar"]'); if(!tab) return;
  const ok = calOK(); tab.style.display = ok ? '' : 'none';
  const f = $('calFrame');
  if(!ok || (f.dataset.store && STORE && f.dataset.store !== STORE.id)){
    f.removeAttribute('data-store'); f.src = 'about:blank'; CAL.sig = {}; CAL.store = null;
    if(tab.classList.contains('active')) homeTab();
  }
}

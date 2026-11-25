/* ---------------- Account tab: client, pharmacy, users and billing ----------------
   One tab for every role a person holds (Client Account Owner, pharmacy Account Owner, Pharmacist-in-Charge super user).
   Opening it needs the password again (never the signing PIN); one unlock covers all of it, and it locks after 5 minutes without activity.
   The server enforces the same rule and decides what each role may see and change, so the lock and the limits can't be skipped by changing the page.
   Drill-down: client (if you hold one) → its pharmacies → one pharmacy's account, Users and Billing, one pharmacy at a time. */
const OWN_MS = 5 * 60 * 1000;
let OWN_UNTIL = 0, ownLastAct = 0, ownPingAt = 0;
const ownerTabActive = () => !!document.querySelector('#tabs [data-tab="owner"].active');
function showOwnLock(msg){
  $('ownBody').style.display = 'none'; $('ownLock').style.display = '';
  $('ownPw').value = ''; $('ownLockMsg').textContent = msg || ''; $('passBox').style.display = 'none';
  setTimeout(() => $('ownPw').focus(), 50);
}
function ownerLockNow(msg, serverSaid){
  const was = OWN_UNTIL > 0; OWN_UNTIL = 0;
  if(was && !serverSaid) api('POST', '/owner-lock', {}).catch(() => {});
  AC_ST.open = null; for(const k in AC_ST.staged) delete AC_ST.staged[k]; AC = {client:null, pharm:null, view:'acct'}; ACD = {client:null, stores:[], users:[], U:null, B:null};
  ['acClient', 'acPharm', 'acUsers', 'acBill', 'acSide'].forEach(k => $(k).innerHTML = ''); $('acCrumb').innerHTML = '';   // nothing left on screen
  if(ownerTabActive()) showOwnLock(msg);
}
const TEMPS = {};                       // temporary passwords made on this screen, kept only in this page (never saved anywhere) so they can be copied again while the person is pending
const AC_ST = drState(TEMPS);           // the open Users view: which person is opened, changes waiting on a row
let AC = {client:null, pharm:null, view:'acct'};         // client: id | null; pharm: id | null; view: acct | users | billing
let ACD = {client:null, stores:[], users:[], U:null, B:null};   // client: answer of GET /client/:id; stores/users: the pharmacies and people this login manages; U/B: the open pharmacy's people / billing
const acMsg = t => { $('acMsg').textContent = t || ''; };
const acEnc = encodeURIComponent;
const managed = () => (ME.stores || []).filter(s => s.owner);                 // pharmacies this login runs (Account Owner or super user)
const ownedHere = id => !!(ME.stores || []).find(s => s.id === id && s.isOwner);
// what this login may open at a pharmacy: from the client page when it is one of the client's, else from the role held there
function reachOf(id){
  const c = ((ACD.client || {}).pharmacies || []).find(p => p.id === id);
  if(c) return c.reach;
  const m = managed().find(s => s.id === id); return m ? {users:true, billing:!!m.isOwner, manage:true} : {users:false, billing:false, manage:false};
}
const acName = id => { const m = (ME.stores || []).find(s => s.id === id), c = ((ACD.client || {}).pharmacies || []).find(p => p.id === id); return (m && m.name) || (c && c.name) || id; };
async function acLoad(){
  try{
    const jobs = [];
    const cl = ME.clientOwner ? (ME.clients || []) : [];
    if(cl.length){ if(!AC.client || !cl.some(c => c.id === AC.client)) AC.client = cl[0].id; jobs.push(api('GET', '/client/' + acEnc(AC.client)).then(r => { ACD.client = r; })); } else { AC.client = null; ACD.client = null; }
    if(managed().length) jobs.push(api('GET', '/owner/stores').then(r => { ACD.stores = r.stores; }), api('GET', '/owner/users').then(r => { ACD.users = r.users; }));
    else { ACD.stores = []; ACD.users = []; }
    await Promise.all(jobs);
    for(const k in TEMPS) if(!ACD.users.some(x => x.sub === k && x.pending)) delete TEMPS[k];
    const all = acPharmIds();
    if(AC.pharm && !all.includes(AC.pharm)) AC.pharm = null;
    if(!AC.pharm && !AC.client && all.length === 1){ AC.pharm = all[0]; AC.view = 'acct'; }       // one pharmacy and no client: open it straight away
    for(const st of ACD.stores) if(st.hasLogo && LOGOS[st.id] === undefined) loadLogo(st.id).then(() => acPaint());
    await acLoadPharm();
    acPaint();
  }catch(e){ if(!e.auth) $('acClient').innerHTML = `<div class="banner warn">${esc(e.message)}</div>`; }
}
// every pharmacy this login can open: its client's, and the ones it runs itself
function acPharmIds(){ const ids = new Set(((ACD.client || {}).pharmacies || []).map(p => p.id)); managed().forEach(s => ids.add(s.id)); return [...ids]; }
async function acLoadPharm(){
  ACD.U = ACD.B = null;
  if(!AC.pharm || AC.view === 'acct') return;
  const r = reachOf(AC.pharm);
  try{
    if(AC.view === 'users' && r.users){ ACD.U = await api('GET', '/pharmacy/' + acEnc(AC.pharm) + '/users'); for(const k in AC_ST.staged) if(!ACD.U.users.some(x => x.sub === k)) delete AC_ST.staged[k]; }
    else if(AC.view === 'billing' && r.billing) ACD.B = await api('GET', '/billing/' + acEnc(AC.pharm));
    else AC.view = 'acct';
  }catch(e){ if(e.auth) throw e; acMsg(e.message); }
}
function acGo(client, pharm, view){ AC.client = client; AC.pharm = pharm || null; AC.view = view || 'acct'; AC_ST.open = null; acMsg(''); acLoad(); }
function acPaint(){
  const cl = ME.clientOwner ? (ME.clients || []) : [], k = ACD.client, id = AC.pharm;
  // breadcrumb
  const lk = (w, t) => `<button class="lk" data-crumb="${w}">${esc(t)}</button>`, parts = [];
  if(k){ parts.push(id ? lk('client', k.client.dba || k.client.legalName) : `<b>${esc(k.client.dba || k.client.legalName)}</b>`); }
  else if(acPharmIds().length > 1) parts.push(id ? lk('home', 'Pharmacies') : '<b>Pharmacies</b>');
  if(id) parts.push(AC.view === 'acct' ? `<b>${esc(acName(id))}</b>` : lk('pharm', acName(id)));
  if(id && AC.view !== 'acct') parts.push(`<b>${AC.view === 'users' ? 'Users' : 'Billing'}</b>`);
  $('acCrumb').innerHTML = (cl.length > 1 ? `<select id="acPick" aria-label="Client">${cl.map(c => `<option value="${esc(c.id)}"${c.id === AC.client ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select> ` : '') + parts.join(' › ');
  // the right-hand list is always the next level down
  const row = (attr, v, title, sub, on, big) => `<button type="button" class="qrow${on ? ' on' : ''}${big ? ' big' : ''}" ${attr}="${esc(v)}"><b>${esc(title)}</b><span>${esc(sub)}</span></button>`;
  const prof = list => list.map(p => row('data-qs', p.id, p.name || p.id, [p.id, [p.city, p.state].filter(Boolean).join(', ')].filter(Boolean).join(' · '))).join('') || '<div class="hint">No pharmacies.</div>';
  if(id){ const r = reachOf(id);
    $('acSide').innerHTML = `<div class="cqh"><h2>${esc(id)}</h2></div>` + [['acct', 'Account', 'Details'], ['users', 'Users', 'People at this pharmacy']].concat(r.billing ? [['billing', 'Billing', 'Invoices and payments']] : []).filter(x => x[0] !== 'users' || r.users).map(([v, t, sub]) => row('data-view', v, t, sub, AC.view === v, true)).join('') + calLinks(id);
  }else{
    const own = managed().filter(s => !k || !k.pharmacies.some(p => p.id === s.id));
    $('acSide').innerHTML = `<div class="cqh"><h2>Profiles</h2></div>` + (k ? prof(k.pharmacies) : '') + (own.length ? (k ? '<div class="sub">Also yours</div>' : '') + prof(own) : '') + (!k && !own.length ? '<div class="hint">No pharmacies.</div>' : '');
  }
  const show = v => ['acClient', 'acPharm', 'acUsers', 'acBill'].forEach(x => $(x).hidden = x !== v);
  const ownerPage = id && AC.view === 'acct' && ACD.stores.some(s => s.id === id);
  $('impCard').style.display = ownerPage && ownedHere(id) ? '' : 'none';
  if(ownerPage) $('impStore').innerHTML = `<option value="${esc(id)}">${esc(id)} · ${esc(acName(id))}</option>`;
  if(id){
    if(AC.view === 'users'){
      show('acUsers'); if(!ACD.U){ $('acUsers').innerHTML = '<div class="hint"><span class="spin"></span>Loading…</div>'; return; }
      $('acUsers').innerHTML = `<div class="dtitle"><h2>Users · ${esc(acName(id))}</h2><span class="hint">${ACD.U.users.length} ${ACD.U.users.length === 1 ? 'person' : 'people'}</span></div><div id="acUsersBody">${drUsersHtml(ACD.U, acUsersOpts())}</div>`;
    }else if(AC.view === 'billing'){
      show('acBill'); if(!ACD.B){ $('acBill').innerHTML = '<div class="hint"><span class="spin"></span>Loading…</div>'; return; }
      $('acBill').innerHTML = `<div class="dtitle"><h2>Billing · ${esc(acName(id))}</h2></div>${drBillingHtml(ACD.B, AC_BO)}`;
    }else{
      show('acPharm');
      const st = ACD.stores.find(s => s.id === id), holder = u => { const h = (ACD.users || []).find(x => x.ownerStores && x.ownerStores[id] === true); return h ? (h.name || h.login) + ' (' + h.login + ')' : ''; };
      if(st) $('acPharm').innerHTML = `<div class="pcard" data-store="${esc(id)}">${pharmCardHtml(st, {logo:LOGOS[id], holder:holder(), people:ACD.users, picInfo:true, stores:ACD.stores})}</div>`;
      else{ const p = ((ACD.client || {}).pharmacies || []).find(x => x.id === id) || {id};
        $('acPharm').innerHTML = `<div class="card"><h2>${esc(p.name || id)}</h2><div class="pid">Pharmacy ID: <b>${esc(id)}</b></div><div class="hint">${esc([p.city, p.state].filter(Boolean).join(', '))}</div><div class="pid" style="margin-top:6px">Account Owner: <b>${esc(p.owner || 'Not set')}</b></div></div>`; }
    }
    return;
  }
  if(k){ show('acClient'); const people = k.pharmacies.filter(p => p.owner).map(p => ({name:p.owner, login:p.owner, ownerStores:{[p.id]:true}})).concat(k.owner ? [{name:k.owner.name, login:k.owner.login, ownerClients:{[k.client.id]:true}}] : []);
    k.client.pharmacies = k.pharmacies.map(p => p.id);
    $('acClient').innerHTML = `<div class="pcard" data-client="${esc(k.client.id)}">${clientCardHtml(k.client, {ro:true, host:false, stores:k.pharmacies, people})}</div>`; clientFreeze($('acClient').querySelector('.pcard')); return; }
  show('acClient'); $('acClient').innerHTML = '<div class="hint">Pick a pharmacy from the list on the right.</div>';
}
const AC_BO = {edit:false, filter:'all'};
const acUsersOpts = () => ({st:AC_ST, me:ME, host:false, ownerMe:ownedHere(AC.pharm), picMe:ME.acctType === 'pic', pinRequired:!!ME.pinRequired, canPin:true});
// People & Assets and the calendar's Setup belong to the pharmacy account: opened from here, shown in the calendar page
const calLinks = id => { const st = (ME.stores || []).find(x => x.id === id); if(!(st && st.calendar && st.owner)) return ''; const row = (v, t, sub) => `<button type="button" class="qrow big" data-calview="${v}"><b>${t}</b><span>${sub}</span></button>`; return row('people', 'People & Assets', 'Staff records, equipment, rooms') + row('setup', 'Calendar Setup', 'Programs, hours, tasks'); };
$('acSide').addEventListener('click', async e => {
  const cv = e.target.closest('[data-calview]'), p = e.target.closest('[data-qs]'), v = e.target.closest('[data-view]'); if(!(cv || p || v)) return;
  const pq = p && p.dataset.qs, vv = v && v.dataset.view, cvv = cv && cv.dataset.calview;
  if(!(await UG.leave())) return;
  if(cv){ calOpenView(cvv); return; }
  if(p) acGo(AC.client, pq, 'acct'); else if(v){ AC.view = vv; AC_ST.open = null; AC_BO.filter = 'all'; acMsg(''); acLoad(); }
});
$('acCrumb').addEventListener('click', async e => { const b = e.target.closest('[data-crumb]'); if(!b) return; const w = b.dataset.crumb; if(!(await UG.leave())) return; if(w === 'pharm') acGo(AC.client, AC.pharm, 'acct'); else acGo(AC.client, null); });
$('acCrumb').addEventListener('change', async e => { const s = e.target.closest('#acPick'); if(!s) return; const v = s.value; if(await UG.leave()) acGo(v, null); });
// pharmacy account page (Account Owner): the same card and events as before
UG.watch($('acPharm')); UG.watch($('acClient'));
pharmCardEvents($('acPharm'), {base:'/owner', stores:() => ACD.stores, say:toast, after: async () => { await refreshMe(); await acLoad(); }});
$('acPharm').addEventListener('click', async e => {
  const nl = e.target.closest('[data-nologo]');
  if(nl && confirm('Remove this pharmacy’s logo?')){
    try{ await api('POST', '/owner/stores/' + acEnc(nl.dataset.nologo) + '/logo', {dataUrl:null}); LOGOS[nl.dataset.nologo] = ''; paintStore(); acLoad(); }catch(err){ if(!err.auth) alert(err.message); }
  }
});
const acEnv = {get sid(){ return AC.pharm; }, base:'/owner', U:() => ACD.U, st:AC_ST, me:() => ME, say:acMsg, pass:showPassBox, paint:() => { $('acUsersBody').innerHTML = drUsersHtml(ACD.U, acUsersOpts()); }, reload: async () => { await acLoad(); }};
drUsersEvents($('acUsers'), acEnv);
drBillingEvents($('acBill'), {get sid(){ return AC.pharm; }, B:() => ACD.B, o:AC_BO, paint:() => acPaint(), reload: async () => { await acLoad(); }, say:acMsg});
function showPassBox(html){ $('passBox').innerHTML = html; $('passBox').style.display = 'block'; $('passBox').scrollIntoView({block:'center'}); }
function openOwnerTab(){
  if(!(OWN_UNTIL > Date.now())) return showOwnLock('');
  $('ownLock').style.display = 'none'; $('ownBody').style.display = '';
  ownLastAct = Date.now(); acLoad();
}
$('ownUnlock').onclick = async () => {
  const pw = $('ownPw').value; if(!pw) return showOwnLock('Enter your password.');
  busy($('ownUnlock'), true);
  try{
    await api('POST', '/owner-unlock', {password:pw, accessToken:SESSION && SESSION.access});
    OWN_UNTIL = Date.now() + OWN_MS; ownPingAt = Date.now(); $('ownPw').value = '';
    openOwnerTab();
  }catch(e){ if(!e.auth) { $('ownLockMsg').textContent = e.message; $('ownPw').select(); } }
  finally{ busy($('ownUnlock'), false); }
};
$('ownPw').addEventListener('keydown', e => { if(e.key === 'Enter') $('ownUnlock').click(); });
['keydown', 'pointerdown', 'input', 'wheel'].forEach(t => $('ownBody').addEventListener(t, () => { ownLastAct = Date.now(); }, {passive:true}));
setInterval(() => {
  if(!(OWN_UNTIL > 0)) return;
  const now = Date.now();
  if(now - ownLastAct > OWN_MS || now > OWN_UNTIL){ ownerLockNow('Locked after 5 minutes without activity. Re-enter your password.'); return; }
  if(ownLastAct > ownPingAt && now - ownPingAt > 60000){ ownPingAt = now; api('POST', '/owner/keepalive', {}).catch(() => {}); }
}, 15000);
async function refreshMe(){ ME = await api('GET', '/me'); STORE = ME.stores.find(s => s.id === STORE.id) || STORE; paintStore(); }
// bring in the old shared-drive file (nortex_reorder_data.json) — adds only, never overwrites
$('impGo').onclick = async () => {
  const f = $('impFile').files[0], store = $('impStore').value;
  if(!f || !store) return toast('Choose the pharmacy and the old nortex_reorder_data.json file.');
  let data; try{ data = JSON.parse(await f.text()); }catch(e){ return alert('That file isn’t a reorder data file: ' + e.message); }
  const arch = data.archive || [], open = (data.reorder || []).filter(r => !r.archived), mem = Object.entries(data.remember || {});
  if(!confirm(`Import into ${store}?\n\n${arch.length} archived lines, ${open.length} open lines, ${mem.length} remembered items.\nNothing already in the cloud is changed or removed.`)) return;
  const tot = {archiveAdded:0, archiveSkipped:0, linesAdded:0, linesSkipped:0, memoryAdded:0, memorySkipped:0};
  const add = r => Object.keys(tot).forEach(k => tot[k] += r[k] || 0);
  busy($('impGo'), true);
  try{
    for(let i = 0; i < arch.length; i += 500){ $('impMsg').textContent = `Archive ${i} of ${arch.length}…`; add(await api('POST', `/stores/${encodeURIComponent(store)}/import`, {archive:arch.slice(i, i + 500)})); }
    for(let i = 0; i < mem.length; i += 1000){ $('impMsg').textContent = `Memory ${i} of ${mem.length}…`; add(await api('POST', `/stores/${encodeURIComponent(store)}/import`, {remember:Object.fromEntries(mem.slice(i, i + 1000))})); }
    const fixed = open.map(r => Object.assign({}, r, {item: r.itemEdited ? r.item : fixItem(r.item)}));
    for(let i = 0; i < fixed.length; i += 500) add(await api('POST', `/stores/${encodeURIComponent(store)}/import`, {reorder:fixed.slice(i, i + 500)}));
    $('impMsg').innerHTML = `<b>Done.</b> Archive: ${tot.archiveAdded} added, ${tot.archiveSkipped} already there. Open list: ${tot.linesAdded} added, ${tot.linesSkipped} already there. Memory: ${tot.memoryAdded} added, ${tot.memorySkipped} already there.`;
    if(STORE && STORE.id === store) openStore(store);
  }catch(e){ $('impMsg').textContent = 'Stopped: ' + e.message + ' (safe to run again; nothing is added twice)'; }
  finally{ busy($('impGo'), false); }
};
// independent backup: a full copy of this pharmacy as a file
$('exportBtn').onclick = async () => {
  busy($('exportBtn'), true);
  try{
    const d = await api('GET', S() + '/export');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 1)], {type:'application/json'}));
    a.download = `reorder_backup_${STORE.id}_${todayISO()}.json`; a.click();
    toast(`Backup downloaded: ${d.archive.length} archived lines, ${d.reorder.length} open.`);
  }catch(e){ if(!e.auth) alert(e.message); } finally{ busy($('exportBtn'), false); }
};

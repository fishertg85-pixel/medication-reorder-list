/* ---------------- cloud: sign-in, current pharmacy, saving ---------------- */
const CFG = window.NORTEX_CONFIG || {};
const COG = CFG.cognitoEndpoint || `https://cognito-idp.${CFG.region}.amazonaws.com/`;
let STATE = {reorder:[], archive:[], remember:{}};
let ME = null, STORE = null;                       // ME: {name, login, owner, perms, stores}; STORE: {id, name, ...}
const PERM = p => !!(ME && ME.perms && ME.perms[p]);
const DISTRIBUTORS = ['Anda Inc','Auburn Pharmaceutical','Axia Medical','Blupax Pharmaceuticals, LLC','Capital Wholesale Drug Co','CityMedRX',
  'GRX / Greenhill','Independent Pharmacy Cooperative','Integral Rx / Smith Drug','KeySource Acquisition, LLC','Masters Pharmaceutical',
  'Mckesson Drug Company','Oak Drugs Inc','Paragon Enterprises','Parmed Pharmaceuticals','PBA Health','Pharmsource, LLC','Real Value Products',
  'Republic Pharmaceuticals','Second Source Rx','South Pointe Wholesale','Wellgistics'];
// the drug name/strength exactly as on the bottle, if someone corrected it before (✎)
function labelFor(st, ndc, rxcui){
  const m = st.remember || {};
  return (ndc && m[ndc] && m[ndc].item) || (rxcui && m['rx:' + rxcui] && m['rx:' + rxcui].item) || '';
}
// where a drug was ordered from last time: by NDC first, otherwise by drug + strength (for "any NDC" lines)
function lastDist(st, ndc, item){
  const m = st.remember || {};
  return (ndc && m[ndc] && m[ndc].dist) || (item && m['item:' + item] && m['item:' + item].dist) || '';
}
// lines added before the label-strength fix: "AMPHETAMINE-DEXTROAMPHETAMINE 5-5-5-5 MG TAB" -> "... 20 MG TAB"
function fixItem(item){
  const m = /^(.*?[A-Z)])\s+((?:[\d.]+(?:\s*-\s*[\d.]+){2,}\s*(?:MG|MCG|G)|[\d.]+\s*MG\s*\/\s*HR)\b.*)$/.exec(String(item || '').toUpperCase());
  if(!m) return item;
  const ls = labelStrength(m[1], m[2]);
  return ls.raw ? `${m[1]} ${ls.sf}` : item;
}

/* ---- Cognito (sign-in service), called directly: no library needed ---- */
const COG_ERR = {
  NotAuthorizedException: 'Login ID or password is wrong.', UserNotFoundException: 'Login ID or password is wrong.',
  CodeMismatchException: 'That code isn’t right. Check the text message and try again.', ExpiredCodeException: 'That code has expired. Start again to get a new one.',
  LimitExceededException: 'Too many tries. Wait a few minutes and try again.', TooManyRequestsException: 'Too many tries. Wait a few minutes and try again.',
  PasswordResetRequiredException: 'Your password was reset. Use “Forgot password?” or ask the account owner for a temporary password.',
  UserNotConfirmedException: 'This login isn’t finished being set up. Ask the account owner.'
};
async function cog(target, body){
  let r;
  try{ r = await fetch(COG, {method:'POST', headers:{'Content-Type':'application/x-amz-json-1.1', 'X-Amz-Target':'AWSCognitoIdentityProviderService.' + target}, body:JSON.stringify(body)}); }
  catch(e){ throw new Error('Can’t reach the sign-in service. Check the internet connection.'); }
  const j = await r.json().catch(() => ({}));
  if(!r.ok){
    const code = String(j.__type || '').split('#').pop();
    let msg = COG_ERR[code] || j.message || 'Sign-in failed.';
    if(code === 'NotAuthorizedException' && /disabled/i.test(j.message || '')) msg = 'This login is switched off. Ask the account owner.';
    if(code === 'NotAuthorizedException' && /expired/i.test(j.message || '')) msg = 'Your temporary password has expired. Ask the Account Owner for a new one.';
    if(code === 'NotAuthorizedException' && /attempts exceeded/i.test(j.message || '')) msg = 'Too many wrong tries. Wait 15 minutes, then try once more.';
    if(code === 'NotAuthorizedException' && /attempts exceeded/i.test(j.message || '')) msg = 'Too many wrong passwords. Wait a few minutes, or use “Forgot password?”.';
    if(code === 'InvalidPasswordException' || code === 'InvalidParameterException') msg = 'Password must be at least 10 characters and include a lowercase letter and a number.';
    const e = new Error(msg); e.code = code; throw e;
  }
  return j;
}
const SESSION_KEY = 'nortex-cloud-session';
let SESSION = null;                                 // {id, refresh, exp, login}
// Where the sign-in is kept. A phone with the app on its home screen is one person's device, so it stays signed in.
// On a computer (often shared), each browser tab keeps its own sign-in: a tab stays whoever signed into it, and
// closing the tab signs them out, so the next person never opens someone else's session.
const STANDALONE = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
const sessStore = () => STANDALONE ? localStorage : sessionStorage;
function saveSession(){ try{ SESSION ? sessStore().setItem(SESSION_KEY, JSON.stringify(SESSION)) : sessStore().removeItem(SESSION_KEY); }catch(e){} }
function loadSession(){
  if(!STANDALONE){ try{ localStorage.removeItem(SESSION_KEY); }catch(e){} }   // a shared sign-in left by an older version
  try{ SESSION = JSON.parse(sessStore().getItem(SESSION_KEY) || 'null'); }catch(e){ SESSION = null; }
}
const tokenExp = t => { try{ return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000; }catch(e){ return 0; } };
function setTokens(a, login){
  SESSION = {id:a.IdToken, access:a.AccessToken || (SESSION && SESSION.access), refresh:a.RefreshToken || (SESSION && SESSION.refresh), exp:tokenExp(a.IdToken), login:login || (SESSION && SESSION.login)};
  saveSession();
}
let refreshing = null;
async function idToken(force){
  if(!SESSION) throw authError();
  if(!force && SESSION.exp - 120000 > Date.now()) return SESSION.id;
  if(!refreshing) refreshing = cog('InitiateAuth', {ClientId:CFG.clientId, AuthFlow:'REFRESH_TOKEN_AUTH', AuthParameters:{REFRESH_TOKEN:SESSION.refresh}})
    .then(j => { setTokens(j.AuthenticationResult); return SESSION.id; })
    .catch(e => { if(e.code) { SESSION = null; saveSession(); } throw e.code ? authError() : e; })
    .finally(() => { refreshing = null; });
  return refreshing;
}
function authError(){ const e = new Error('Please sign in again.'); e.auth = true; return e; }

/* ---- our API ---- */
async function api(method, path, body, retried){
  let tok; try{ tok = await idToken(); }catch(e){ if(e.auth) showLogin('Your sign-in expired. Please sign in again.'); throw e; }
  let r;
  try{ r = await fetch(CFG.apiUrl.replace(/\/$/, '') + path, {method, headers:{Authorization:'Bearer ' + tok, ...(body ? {'Content-Type':'application/json'} : {})}, body:body ? JSON.stringify(body) : undefined, cache:'no-store'}); }
  catch(e){ setOnline(false); throw new Error('No connection to the server. Check the internet; your last change may not be saved.'); }
  setOnline(true);
  if(r.status === 401 && !retried){ try{ await idToken(true); }catch(e){ showLogin('Your sign-in expired. Please sign in again.'); throw e; } return api(method, path, body, true); }
  const j = await r.json().catch(() => ({}));
  if(r.status === 423 && j.locked){ ownerLockNow('Locked after 5 minutes without activity. Re-enter your password.', true); const e = new Error(j.error); e.auth = true; e.locked = true; throw e; }
  if(!r.ok){ const e = new Error(j.error || j.message || ('Server answered ' + r.status)); e.status = r.status; if(j.pin) e.pin = j.pin; throw e; }
  if(/^\/owner\/|\/import$/.test(path)) OWN_UNTIL = Date.now() + OWN_MS;         // using the tab keeps it open
  return j;
}
function setOnline(ok){ const b = $('offlineBanner'); if(b) b.style.display = ok ? 'none' : 'block'; }
const S = () => '/stores/' + encodeURIComponent(STORE.id);
// each pharmacy's own time zone (set by the Account Owner): all dates and times on its orders use it
const TZ_NAMES = {'America/New_York':'Eastern', 'America/Chicago':'Central', 'America/Denver':'Mountain', 'America/Phoenix':'Arizona (no daylight saving)',
  'America/Los_Angeles':'Pacific', 'America/Anchorage':'Alaska', 'Pacific/Honolulu':'Hawaii', 'America/Puerto_Rico':'Atlantic (Puerto Rico)'};
function storeTZ(){ try{ return (STORE && STORE.timezone) || 'America/Chicago'; }catch(e){ return 'America/Chicago'; } }

/* ---- saving: every change is worked out as a small list of edits and sent in one request ----
   Only the fields that changed are sent, so two people editing different things don't overwrite each other.
   Submitted lines go to the archive first; the server never deletes or overwrites archived lines. */
const LINE_FIELDS = ['dateAdded','item','mfr','ndc','ndc10','pkgSize','qty','src','setid','rxcui','autoPkg','dist','autoDist','need','autoQty','ordered','orderedAt','itemEdited'];
let saving = 0;
async function change(mutator){
  if(!STORE) return false;
  const before = new Map(STATE.reorder.map(l => [l.id, JSON.parse(JSON.stringify(l))]));
  const memBefore = {}; for(const [k, v] of Object.entries(STATE.remember)) memBefore[k] = JSON.stringify(v);
  const archLen = STATE.archive.length;
  mutator(STATE);
  const create = [], set = [], del = [], mem = {};
  const now = new Map(STATE.reorder.map(l => [l.id, l]));
  for(const [id, l] of now){
    const b = before.get(id);
    if(!b){ create.push(Object.fromEntries([['id', id], ...LINE_FIELDS.filter(f => l[f] !== undefined).map(f => [f, l[f]])])); continue; }
    const fields = {}; for(const f of LINE_FIELDS) if(JSON.stringify(l[f]) !== JSON.stringify(b[f])) fields[f] = l[f] === undefined ? '' : l[f];
    if(Object.keys(fields).length) set.push({id, fields});
  }
  for(const id of before.keys()) if(!now.has(id)) del.push(id);
  for(const [k, v] of Object.entries(STATE.remember)) if(memBefore[k] !== JSON.stringify(v)) mem[k] = v;
  const archive = STATE.archive.slice(archLen);
  if(!create.length && !set.length && !del.length && !archive.length && !Object.keys(mem).length){ renderAll(); return true; }
  renderAll();                                        // show it straight away; the server answer follows
  saving++;
  try{
    const r = await api('POST', S() + '/commit', {create, set, del, archive, mem});
    if(!editingRow()) STATE.reorder = r.lines;
    renderAll();
    if(archive.length) loadArchive(false).catch(() => {});
    return true;
  }catch(e){
    if(!e.auth) alert('Not saved: ' + e.message);
    // put the screen back to what the server has
    STATE.archive.splice(archLen);
    await refreshLines(true).catch(() => {});
    await refreshMemory().catch(() => {});
    return false;
  }finally{ saving--; }
}
const editingRow = () => { const a = document.activeElement; return a && a.closest && a.closest('#listBody') && !(a.type === 'checkbox' || a.tagName === 'BUTTON'); };
async function refreshLines(force){
  if(!STORE || (!force && (saving || editingRow()))) return;
  const id = STORE.id, r = await api('GET', S() + '/lines');
  if(STORE && STORE.id === id && (force || !(saving || editingRow()))){ STATE.reorder = r.lines; renderList(); }
}
async function refreshMemory(){ if(!STORE) return; const id = STORE.id, r = await api('GET', S() + '/memory'); if(STORE && STORE.id === id) STATE.remember = r.memory || {}; }

/* ---- archive: loaded newest first, a page at a time ---- */
let archCursor = null, archLoaded = false, archDays = new Set();
function mergeArchive(items){                         // the server's copy wins (it has who submitted it)
  const at = new Map(STATE.archive.map((r, i) => [r.id + '|' + r.submittedAt, i]));
  for(const r of items){ const k = r.id + '|' + r.submittedAt; if(at.has(k)) STATE.archive[at.get(k)] = r; else { at.set(k, STATE.archive.length); STATE.archive.push(r); } }
}
async function loadArchive(more){
  if(!STORE || !PERM('archive')) return;
  const id = STORE.id;
  const r = await api('GET', S() + '/archive?limit=1000' + (more && archCursor ? '&cursor=' + encodeURIComponent(archCursor) : ''));
  if(!STORE || STORE.id !== id) return;
  mergeArchive(r.items);
  if(!more || archCursor) archCursor = more ? r.cursor : (archLoaded ? archCursor : r.cursor);
  archLoaded = true;
  renderArchive();
}
async function loadArchiveDay(day){
  if(!day || archDays.has(day) || !STORE || !PERM('archive')) return;
  const r = await api('GET', S() + '/archive?day=' + day + '&limit=2000');
  mergeArchive(r.items); archDays.add(day); renderArchive();
}

/* ---- switching pharmacy ---- */
async function openStore(id){
  const s = ME.stores.find(x => x.id === id) || ME.stores[0];
  if(!s) return;
  STORE = s; STATE = {reorder:[], archive:[], remember:{}}; archCursor = null; archLoaded = false; archDays = new Set();
  try{ localStorage.setItem('nortex-last-pharmacy', s.id); }catch(e){}
  paintStore();
  renderAll();
  $('listBody').innerHTML = '<tr><td colspan="10" class="empty"><span class="spin"></span>Loading…</td></tr>';
  try{
    const [l, m] = await Promise.all([api('GET', S() + '/lines'), api('GET', S() + '/memory')]);
    if(STORE.id !== s.id) return;
    STATE.reorder = l.lines; STATE.remember = m.memory || {};
    renderAll();
    loadArchive(false).catch(() => {});
    loadLogo(s.id);
  }catch(e){ if(!e.auth) $('listBody').innerHTML = `<tr><td colspan="10" class="empty">Couldn’t load the list: ${esc(e.message)}</td></tr>`; }
}
const LOGOS = {};
async function fetchPublic(id){
  const r = await fetch(CFG.apiUrl.replace(/\/$/, '') + '/public/pharmacy/' + encodeURIComponent(id), {cache:'no-store'});
  return r.ok ? r.json() : {found:false};
}
async function loadLogo(id, fresh){
  if(LOGOS[id] === undefined || fresh){ try{ const p = await fetchPublic(id); LOGOS[id] = p.logo || ''; }catch(e){ LOGOS[id] = ''; } }
  if(STORE && STORE.id === id) paintStore();
}
let LANDED = false;
function paintStore(){
  $('storeName').textContent = STORE ? STORE.name : 'Reorder List';
  document.title = (STORE ? STORE.name + ' · ' : '') + 'Reorder List';
  const logo = STORE && LOGOS[STORE.id];
  $('storeLogo').style.display = logo ? '' : 'none'; if(logo) $('storeLogo').src = logo;
  const sel = $('storeSel');
  sel.style.display = ME && ME.stores.length > 1 ? '' : 'none';
  if(ME) sel.innerHTML = ME.stores.map(s => `<option value="${esc(s.id)}"${STORE && s.id === STORE.id ? ' selected' : ''}>${esc(s.id)} · ${esc(s.name)}</option>`).join('');
  $('whoLabel').textContent = ME ? (ME.name || ME.login) + (ME.owner ? ' (Account Owner)' : '') : '';
  // what this login may do
  document.querySelector('#tabs [data-tab="archive"]').style.display = PERM('archive') ? '' : 'none';
  document.querySelector('#tabs [data-tab="owner"]').style.display = ME && ME.owner ? '' : 'none';
  $('submitBtn').style.display = PERM('submit') ? '' : 'none';
  $('submitOff').style.display = ME && !PERM('submit') ? '' : 'none';
  $('exportCard').style.display = PERM('export') ? '' : 'none';
  renderStoreInfo();
  calPaint(); docsPaintTab(); rxPaint();
  $('archOpen').style.display = PERM('archive') ? '' : 'none';
  $('acctBtn').style.display = ME && ME.owner ? '' : 'none';
  if(!LANDED && ME && STORE){ LANDED = true;                  // first screen after sign-in = the first tab the person has (Calendar, Documents, Reorder List)
    const first = [...document.querySelectorAll('#tabs button')].find(b => !b.classList.contains('tabx') && b.style.display !== 'none');
    if(first && first.dataset.tab !== 'list') first.click(); }
}
const SVC_NAMES = {retail:'Retail dispensing', controlled:'Controlled substances', nonsterile:'Nonsterile compounding', sterile:'Sterile compounding', hazardous:'Hazardous drug compounding', immunizations:'Immunizations', delivery:'Delivery', ltc:'Long-term care', specialty:'Specialty', infusion:'Home infusion'};
function hoursText(h){
  if(!Array.isArray(h) || h.length !== 7) return '';
  const t = x => { const [hh, mm] = x.split(':').map(Number); return ((hh + 11) % 12 + 1) + (mm ? ':' + String(mm).padStart(2, '0') : '') + (hh < 12 ? ' AM' : ' PM'); };
  const D = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], out = [];
  for(let i = 0; i < 7; i++){ const x = h[i] ? t(h[i].o) + ' to ' + t(h[i].c) : 'Closed', last = out[out.length - 1];
    if(last && last.x === x) last.to = D[i]; else out.push({from: D[i], to: D[i], x}); }
  return out.map(o => (o.from === o.to ? o.from : o.from + '–' + o.to) + ' ' + o.x).join('; ');
}
function renderStoreInfo(){
  const s = STORE; if(!s){ $('storeInfo').innerHTML = ''; return; }
  const row = (k, v) => v ? `<tr><th style="width:140px;">${k}</th><td>${esc(v)}</td></tr>` : '';
  $('storeInfo').innerHTML = `<table>${row('Pharmacy ID', s.id)}${row('Name', s.name)}${row('Address', [[s.address, s.suite].filter(Boolean).join(', '), [s.city, [s.state, s.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', '))}${row('Phone', s.phone)}${row('Fax', s.fax)}${row('Email', s.email)}${row('State license #', s.license ? s.license + (s.licenseExpires ? ' (expires ' + s.licenseExpires + ')' : '') : '')}${row('NPI', s.npi)}${row('DEA #', s.dea ? s.dea + (s.deaExpires ? ' (expires ' + s.deaExpires + ')' : '') : '')}${row('NCPDP ID', s.ncpdp)}${row('Services', [...(s.services || []).map(k => SVC_NAMES[k] || k), s.servicesOther].filter(Boolean).join(', '))}${row('Hours', hoursText(s.hours))}${row('Time zone', TZ_NAMES[storeTZ()] || storeTZ())}</table>`;
}
$('storeSel').onchange = e => openStore(e.target.value);

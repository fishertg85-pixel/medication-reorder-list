/* =======================================================================
   NorTex Reorder List (cloud). Hosted on AWS: sign-in with Pharmacy ID + Login ID + password
   + text-message code; data per pharmacy in the cloud; works on computers and phones.
   Drug search: NLM RxTerms / RxNav live, FDA NDC Directory backup. DailyMed links open labels.
   ======================================================================= */
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const todayISO = () => { try{ return new Intl.DateTimeFormat('en-CA', {timeZone:storeTZ(), year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date()); }catch(e){ const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10); } };
const fmtDate = iso => { if(!iso) return ''; const [y,m,d] = String(iso).split('-'); return esc(d === undefined ? iso : `${m}/${d}/${y}`); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
function toast(msg){ const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2400); }
const dailyMedUrl = ndc => 'https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=' + encodeURIComponent(ndc);
const dm = (ndc, setid) => !(ndc || setid) ? '' : `<a class="dm" href="${setid ? 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=' + encodeURIComponent(setid) : dailyMedUrl(ndc)}" target="_blank" rel="noopener" title="Open on DailyMed">DailyMed ↗</a>`;

/* ---------------- theme (light / dark) ---------------- */
const SUN  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8L6 18M18 6l1.8-1.8"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg>';
function currentTheme(){
  const set = document.documentElement.getAttribute('data-theme');
  if(set) return set;
  return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function paintThemeBtn(){
  const dark = currentTheme() === 'dark';
  $('themeBtn').innerHTML = dark ? SUN : MOON;            // show what you'll switch TO
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  $('themeBtn').title = label; $('themeBtn').setAttribute('aria-label', label);
}
$('themeBtn').onclick = () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try{ localStorage.setItem('nortex-theme', next); }catch(e){}
  paintThemeBtn();
};
paintThemeBtn();
(function(){ const im = $('ilLogo'); if(!im) return; const show = () => { im.hidden = !(im.naturalWidth > 0); };
  if(im.complete) show(); else { im.addEventListener('load', show); im.addEventListener('error', () => { im.hidden = true; }); } })();

/* ---------------- cloud: sign-in, current pharmacy, saving ---------------- */
const CFG = window.NORTEX_CONFIG || {};
const COG = CFG.cognitoEndpoint || `https://cognito-idp.${CFG.region}.amazonaws.com/`;
let STATE = {reorder:[], archive:[], remember:{}};
let ME = null, STORE = null;                       // ME: {name, login, owner, perms, stores}; STORE: {id, name, ...}
const PERM = p => !!(ME && (STORE && STORE.perms ? STORE.perms[p] : ME.perms && ME.perms[p]));   // privileges are per pharmacy (an owner here may be staff elsewhere)
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
  if(/^\/(owner|client|pharmacy|billing)\/|\/import$/.test(path)) OWN_UNTIL = Date.now() + OWN_MS;         // using the tab keeps it open
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
// a tab went away (switched off, or another pharmacy): go to the first tab that is still there
function homeTab(){ const b = [...document.querySelectorAll('#tabs button')].find(x => !x.classList.contains('tabx') && x.style.display !== 'none') || document.querySelector('#tabs [data-tab="owner"]:not([style*="none"])'); if(b) b.click(); }
function paintStore(){
  $('storeName').textContent = STORE ? STORE.name : 'Reorder List';
  document.title = (STORE ? STORE.name + ' · ' : '') + 'Reorder List';
  const logo = STORE && LOGOS[STORE.id];
  $('storeLogo').style.display = logo ? '' : 'none'; if(logo) $('storeLogo').src = logo;
  const sel = $('storeSel');
  sel.style.display = ME && ME.stores.length > 1 ? '' : 'none';
  if(ME) sel.innerHTML = ME.stores.map(s => `<option value="${esc(s.id)}"${STORE && s.id === STORE.id ? ' selected' : ''}>${esc(s.id)} · ${esc(s.name)}</option>`).join('');
  $('whoLabel').textContent = ME ? (ME.name || ME.login) + (STORE && STORE.isOwner ? ' (Account Owner)' : STORE && STORE.owner ? ' (Administrator)' : '') : '';
  // what this login may do
  document.querySelector('#tabs [data-tab="archive"]').style.display = PERM('archive') && !(STORE && STORE.reorder === false) && !(ME && ME.acctType === 'staff' && (ME.subs || []).some(x => x === 'cashier' || x === 'driver') && !(STORE && STORE.owner)) ? '' : 'none';
  document.querySelector('#tabs [data-tab="owner"]').style.display = (STORE && STORE.owner) || (ME && ME.clientOwner) ? '' : 'none';
  const lt = document.querySelector('#tabs [data-tab="list"]'); const noReo = !!(STORE && STORE.reorder === false) || !!(ME && ME.acctType === 'staff' && (ME.subs || []).some(x => x === 'cashier' || x === 'driver') && !(STORE && STORE.owner));
  if(lt) lt.style.display = noReo ? 'none' : '';   // hidden when switched off for the pharmacy, and for Cashier and Driver
  if(noReo && document.querySelector('#tabs [data-tab="list"].active, #tabs [data-tab="archive"].active')) homeTab();
  $('submitBtn').style.display = PERM('submit') ? '' : 'none';
  $('submitOff').style.display = ME && !PERM('submit') ? '' : 'none';
  $('exportCard').style.display = PERM('export') ? '' : 'none';
  renderStoreInfo();
  calPaint(); docsPaintTab(); rxPaint();
  $('archOpen').style.display = PERM('archive') ? '' : 'none';
  $('acctBtn').style.display = (STORE && STORE.owner) || (ME && ME.clientOwner) ? '' : 'none';
  if(!LANDED && ME && STORE){ LANDED = true;                  // first screen after sign-in = the first tab the person has (Calendar, Documents, Reorder List)
    const first = [...document.querySelectorAll('#tabs button')].find(b => !b.classList.contains('tabx') && b.style.display !== 'none');       // Dashboard, Calendar, Documents, Reorder List, Rx Intake
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

/* ---------------- sign-in screen: Pharmacy ID + Login ID + password, then a text-message code ---------------- */
let LOGIN = {step:'start', session:null, user:'', pharm:'', dest:''};
const lget = k => { try{ return localStorage.getItem(k) || ''; }catch(e){ return ''; } };
function showLogin(msg){
  ME = null; STORE = null; clearInterval(showLogin.poll);
  $('app').style.display = 'none'; $('login').style.display = 'flex';
  LOGIN = {step:'start', session:null, user:'', pharm:'', dest:''};
  $('liPharm').value = $('liPharm').value || lget('nortex-last-pharmacy');
  $('liPass').value = '';
  paintLogin(msg || '');
  if($('liPharm').value) checkPharm();
  setTimeout(() => ($('liPharm').value ? ($('liUser').value ? $('liPass') : $('liUser')) : $('liPharm')).focus(), 50);
}
function paintLogin(msg, ok){
  const st = LOGIN.step;
  $('liStart').style.display = st === 'start' ? '' : 'none';
  $('liNew').style.display = st === 'newpw' ? '' : 'none';
  $('liCode').style.display = st === 'code' ? '' : 'none';
  $('liForgot').style.display = st === 'forgot' || st === 'forgot2' ? '' : 'none';
  $('liForgot2').style.display = st === 'forgot2' ? '' : 'none';
  $('liCodeDest').textContent = LOGIN.dest || 'your phone';
  $('liMsg').textContent = msg || ''; $('liMsg').className = 'li-msg' + (ok ? ' ok' : '');
}
let pharmTimer = null, pharmSeq = 0;
async function checkPharm(){
  const id = $('liPharm').value.trim().toUpperCase(), my = ++pharmSeq;
  if(id.length < 2){ $('liBrand').innerHTML = ''; return; }
  let p; try{ p = await fetchPublic(id); }catch(e){ p = null; }
  if(my !== pharmSeq) return;
  $('liBrand').innerHTML = p && p.found
    ? `${p.logo ? `<img src="${esc(p.logo)}" alt="">` : ''}<div class="li-pname">${esc(p.name)}</div>`
    : p ? '<div class="li-none">No pharmacy with that ID.</div>' : '';
  if(p && p.found && p.logo) LOGOS[p.id] = p.logo;
}
$('liPharm').addEventListener('input', () => { clearTimeout(pharmTimer); pharmTimer = setTimeout(checkPharm, 350); });
function busy(btn, on){ if(!btn) return; btn.disabled = on; btn.dataset.t = btn.dataset.t || btn.textContent; btn.textContent = on ? 'Please wait…' : btn.dataset.t; }
async function afterAuth(res){
  // Cognito answers with either tokens or the next question (new password, text code)
  if(res.AuthenticationResult){ setTokens(res.AuthenticationResult, LOGIN.user); return enterApp(LOGIN.pharm); }
  LOGIN.session = res.Session;
  if(res.ChallengeName === 'NEW_PASSWORD_REQUIRED'){ LOGIN.step = 'newpw'; paintLogin('Welcome! Choose your own password.', true); $('liNew1').focus(); return; }
  if(res.ChallengeName === 'SMS_MFA'){
    LOGIN.dest = (res.ChallengeParameters && res.ChallengeParameters.CODE_DELIVERY_DESTINATION) || '';
    LOGIN.step = 'code'; paintLogin(''); $('liCodeIn').value = ''; $('liCodeIn').focus(); return;
  }
  paintLogin('Sign-in needs a step this app doesn’t support (' + res.ChallengeName + '). Tell the Account Owner.');
}
$('liUser').addEventListener('input', () => { $('liPass').value = ''; });
// Pharmacy ID isn't case-sensitive: show it in capitals as it's typed (ntx -> NTX)
$('liPharm').addEventListener('input', e => { const i = e.target, a = i.selectionStart, b = i.selectionEnd, up = i.value.toUpperCase(); if(up !== i.value){ i.value = up; try{ i.setSelectionRange(a, b); }catch(x){} } });
$('liGo').onclick = async () => {
  const pharm = $('liPharm').value.trim().toUpperCase(), user = $('liUser').value.trim().toLowerCase(), pw = $('liPass').value.trim();
  if(!pharm || !user || !pw) return paintLogin('Enter Pharmacy ID, Login ID and password.');
  LOGIN.pharm = pharm; LOGIN.user = user;
  busy($('liGo'), true);
  try{ await afterAuth(await cog('InitiateAuth', {ClientId:CFG.clientId, AuthFlow:'USER_PASSWORD_AUTH', AuthParameters:{USERNAME:user, PASSWORD:pw}})); }
  catch(e){ paintLogin(e.message); }
  finally{ busy($('liGo'), false); }
};
$('liNewGo').onclick = async () => {
  const a = $('liNew1').value, b = $('liNew2').value;
  if(a.length < 10 || !/[a-z]/.test(a) || !/\d/.test(a)) return paintLogin('At least 10 characters, with a lowercase letter and a number.');
  if(a !== b) return paintLogin('The two passwords don’t match.');
  busy($('liNewGo'), true);
  try{ await afterAuth(await cog('RespondToAuthChallenge', {ClientId:CFG.clientId, ChallengeName:'NEW_PASSWORD_REQUIRED', Session:LOGIN.session, ChallengeResponses:{USERNAME:LOGIN.user, NEW_PASSWORD:a}})); }
  catch(e){ paintLogin(e.message); }
  finally{ busy($('liNewGo'), false); }
};
$('liCodeGo').onclick = async () => {
  const code = digitsOf($('liCodeIn').value);
  if(code.length < 6) return paintLogin('Enter the 6-digit code from the text message.');
  busy($('liCodeGo'), true);
  try{ await afterAuth(await cog('RespondToAuthChallenge', {ClientId:CFG.clientId, ChallengeName:'SMS_MFA', Session:LOGIN.session, ChallengeResponses:{USERNAME:LOGIN.user, SMS_MFA_CODE:code}})); }
  catch(e){ if(e.code === 'NotAuthorizedException') { LOGIN.step = 'start'; paintLogin('That took too long. Sign in again.'); } else paintLogin(e.message); }
  finally{ busy($('liCodeGo'), false); }
};
$('liForgotLink').onclick = e => { e.preventDefault(); LOGIN.step = 'forgot'; $('liFUser').value = $('liUser').value.trim(); paintLogin(''); $('liFUser').focus(); };
$('liFSend').onclick = async () => {
  const user = $('liFUser').value.trim().toLowerCase(); if(!user) return paintLogin('Enter your Login ID.');
  busy($('liFSend'), true);
  try{
    const r = await cog('ForgotPassword', {ClientId:CFG.clientId, Username:user});
    LOGIN.user = user; LOGIN.step = 'forgot2';
    const d = r.CodeDeliveryDetails && r.CodeDeliveryDetails.Destination;
    paintLogin(`If that Login ID exists, a code was texted${d ? ' to ' + d : ' to its phone'}.`, true); $('liFCode').focus();
  }catch(e){ paintLogin(e.message); }
  finally{ busy($('liFSend'), false); }
};
$('liFGo').onclick = async () => {
  const code = digitsOf($('liFCode').value), a = $('liFNew').value;
  if(code.length < 6) return paintLogin('Enter the code from the text message.');
  if(a.length < 10 || !/[a-z]/.test(a) || !/\d/.test(a)) return paintLogin('New password: at least 10 characters, with a lowercase letter and a number.');
  busy($('liFGo'), true);
  try{ await cog('ConfirmForgotPassword', {ClientId:CFG.clientId, Username:LOGIN.user, ConfirmationCode:code, Password:a});
    LOGIN.step = 'start'; $('liUser').value = LOGIN.user; $('liPass').value = ''; paintLogin('Password changed. Sign in with it now.', true); $('liPass').focus(); }
  catch(e){ paintLogin(e.message); }
  finally{ busy($('liFGo'), false); }
};
document.querySelectorAll('[data-liback]').forEach(a => a.onclick = e => { e.preventDefault(); LOGIN.step = 'start'; paintLogin(''); });
// Enter key moves through each step
[['liPharm','liUser'],['liUser','liPass'],['liPass','liGo'],['liNew1','liNew2'],['liNew2','liNewGo'],['liCodeIn','liCodeGo'],['liFUser','liFSend'],['liFCode','liFNew'],['liFNew','liFGo']]
  .forEach(([a, b]) => $(a).addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); $(b).tagName === 'BUTTON' ? $(b).click() : $(b).focus(); } }));

async function enterApp(pharm){
  try{ ME = await api('GET', '/me'); }
  catch(e){ if(!e.auth){ SESSION = null; saveSession(); showLogin(e.message); } return; }
  const want = (pharm || lget('nortex-last-pharmacy') || '').toUpperCase();
  if(pharm && !ME.stores.some(s => s.id === want)){
    signOut(true);
    return showLogin(`Your login isn’t switched on for pharmacy ${want}. Check the Pharmacy ID, or ask the Account Owner.`);
  }
  if(!ME.stores.length){ signOut(true); return showLogin('Your login isn’t switched on for any pharmacy yet. Ask the Account Owner.'); }
  try{ localStorage.removeItem('nortex-last-login'); }catch(e){}
  $('login').style.display = 'none'; $('app').style.display = '';
  await openStore(ME.stores.some(s => s.id === want) ? want : ME.stores[0].id);
  clearInterval(showLogin.poll);
  // pick up other people's changes; waits while someone is typing in a row
  let tick = 0;
  showLogin.poll = setInterval(() => {
    if(document.hidden || !STORE) return;
    tick++;
    refreshLines().catch(() => {});
    if(tick % 20 === 0) refreshMemory().catch(() => {});                                   // ~ every 3 minutes
    if(tick % 4 === 0 && document.querySelector('#tabs [data-tab="archive"].active')) loadArchive(false).catch(() => {});
    if(tick % 40 === 0) api('GET', '/me').then(m => { ME = m; if(!ME.stores.some(s => s.id === STORE.id)) { alert('Your access to this pharmacy was switched off.'); location.reload(); } else paintStore(); }).catch(() => {});
  }, 8000);
}
document.addEventListener('visibilitychange', () => { if(!document.hidden && STORE) refreshLines().catch(() => {}); });
async function signOut(quiet){
  LANDED = false;
  if(ME && (ME.owner || ME.clientOwner) && OWN_UNTIL > 0){ OWN_UNTIL = 0; await api('POST', '/owner-lock', {}).catch(() => {}); }
  if(SESSION && SESSION.refresh) cog('RevokeToken', {ClientId:CFG.clientId, Token:SESSION.refresh}).catch(() => {});
  SESSION = null; saveSession();
  if(typeof TEMPS !== 'undefined') for(const k in TEMPS) delete TEMPS[k];
  if(typeof AC_ST !== 'undefined'){ AC_ST.open = null; for(const k in AC_ST.staged) delete AC_ST.staged[k]; }       // copied temporary passwords go with the session
  if(!quiet){ $('liUser').value = ''; showLogin('Signed out. The next person can sign in.'); }   // shared computers: leave nobody's Login ID behind
}
$('signOutBtn').onclick = () => { if(confirm('Sign out of the Reorder List on this device?')) signOut(); };

/* ---------------- drug search: NLM RxTerms + RxNav (same lookups as the NorTex Rx Intake form) ----------------
   Name as you type  -> RxTerms (clinicaltables.nlm.nih.gov): drug names with every strength and form.
   Pick drug+strength -> RxNav ndcproperties: every active NDC for it, with labeler and package size.
   Type an NDC        -> RxNav ndcproperties -> RxTerms details: name, strength, dose form, route.
   NLM lets web pages read these directly; if the NorTex extension is installed it's used as a backup. */
const RXT = 'https://clinicaltables.nlm.nih.gov/api/rxterms/v3/search?ef=STRENGTHS_AND_FORMS,RXCUIS&maxList=25&terms=';
const RXNAV_NDC = 'https://rxnav.nlm.nih.gov/REST/ndcproperties.json?ndcstatus=active&id=';
const RXNAV_NDCPROP = 'https://rxnav.nlm.nih.gov/REST/ndcproperties.json?ndcstatus=all&id=';
const OPENFDA_NDC = 'https://api.fda.gov/drug/ndc.json?limit=5&search=';
const DM_SPLS = 'https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?ndc=';
const RXNAV_TERMS = rxcui => 'https://rxnav.nlm.nih.gov/REST/RxTerms/rxcui/' + encodeURIComponent(rxcui) + '/allinfo.json';
const digitsOf = s => String(s || '').replace(/\D/g, '');
// "00093-0787-01" -> 00093-<b>0787</b>-01: the middle (product) code is what tells look-alike NDCs apart
function ndcHtml(ndc){
  const p = String(ndc || '').split('-');
  return p.length === 3 ? `<span class="ndc-txt">${esc(p[0])}-<b class="ndcmid">${esc(p[1])}</b>-${esc(p[2])}</span>` : `<span class="ndc-txt">${esc(ndc || '')}</span>`;
}
const fmt11 = d => d.length === 11 ? `${d.slice(0,5)}-${d.slice(5,9)}-${d.slice(9)}` : d;

/* NorTex extension bridge (same messages as the Rx Intake form) */
let BRIDGE = false, bridgeSeq = 0; const bridgeWait = new Map();
window.addEventListener('message', e => {
  if(e.source !== window || !e.data || typeof e.data !== 'object') return;
  if(e.data.type === 'NORTEX_NPI_READY'){ BRIDGE = true; return; }
  if(e.data.type === 'NORTEX_NPI_RES'){
    const w = bridgeWait.get(e.data.id); if(!w) return;
    bridgeWait.delete(e.data.id);
    if(e.data.ok) w.resolve(e.data.data); else w.reject(new Error(e.data.error || 'Lookup failed'));
  }
});
window.postMessage({type:'NORTEX_NPI_PING'}, '*');
function bridgeGet(url){
  if(!BRIDGE) return Promise.reject(new Error('NorTex extension not installed'));
  const id = ++bridgeSeq;
  return new Promise((resolve, reject) => {
    bridgeWait.set(id, {resolve, reject});
    window.postMessage({type:'NORTEX_NPI_REQ', id, url}, '*');
    setTimeout(() => { if(bridgeWait.has(id)){ bridgeWait.delete(id); reject(new Error('Lookup timed out')); } }, 15000);
  });
}
let netState = 'unknown';
function setHeader(){
  /* the header carries no drug-search status line */
}
async function getJSON(url){
  try{
    const r = await fetch(url, {headers:{Accept:'application/json'}});
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json(); netState = 'ok'; setHeader(); return j;
  }catch(e){
    if(BRIDGE){ const j = await bridgeGet(url); netState = 'ok'; setHeader(); return j; }
    netState = navigator.onLine === false ? 'offline' : 'down'; setHeader(); throw e;
  }
}
const lookupError = () => netState === 'offline' ? 'No internet connection, so drugs can’t be looked up.'
  : 'Drug lookup isn’t answering right now. Try again in a minute, or add the drug by hand.';

/* cached lookups */
const rxtCache = new Map(), ndcCache = new Map();
function cached(map, key, make){ if(!map.has(key)){ const p = make(); map.set(key, p); p.catch(() => map.delete(key)); } return map.get(key); }
/* ---- strength as printed on the carton / bottle ----
   RxNorm states strength per ingredient and in standard units. Pharmacy labels don't:
   - mixed salts of one drug: RxNorm "5-5-5-5 MG" (amphetamine salts)   -> label "20 MG"
   - injectables with a fill volume: "0.5 ML of 10 MG/ML" (Zepbound)    -> label "5 MG/0.5 ML"
   - patches per hour: estradiol "0.00208 MG/HR"                         -> label "0.05 MG/DAY"
                       fentanyl / buprenorphine "0.025 MG/HR"            -> label "25 MCG/HR"
   Insulin and other UNIT products, oral liquids and true combinations (e.g. 50-25 MG) are left as is. */
function nice(x){                       // undo RxNorm rounding: 2.04 -> 2, 0.0499 -> 0.05
  if(!(x > 0)) return x;
  for(const p of [1, 2, 3]){ const r = +x.toPrecision(p); if(Math.abs(r - x) / x <= 0.03) return r; }
  return +x.toPrecision(4);
}
const fmtNum = x => String(+(+x).toFixed(4));
const SALTS = /\b(ASPARTATE|SULFATE|SACCHARATE|HYDROCHLORIDE|HCL|SODIUM|POTASSIUM|CALCIUM|MAGNESIUM|MALEATE|BITARTRATE|TARTRATE|ACETATE|PHOSPHATE|SUCCINATE|BESYLATE|MESYLATE|CITRATE|BROMIDE|CHLORIDE|FUMARATE|MONOHYDRATE|DIHYDRATE|ANHYDROUS)\b/g;
function sameMoiety(name){              // amphetamine + dextroamphetamine salts -> one drug
  const parts = String(name || '').toUpperCase().split(/\s*(?:\/|,|\bAND\b)\s*|-(?=[A-Z])/)
    .map(p => p.replace(SALTS, '').replace(/[^A-Z]/g, '')).filter(Boolean);
  if(parts.length < 2) return false;
  const root = parts.reduce((a, b) => a.length <= b.length ? a : b);
  return root.length >= 5 && parts.every(p => p.includes(root));
}
function labelStrength(name, sf, full){
  let s = String(sf || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const orig = s, F = String(full || '').toUpperCase(), N = String(name || '').toUpperCase();
  // 1) mixed salts: "5-5-5-5 MG TAB" or "5 MG / 5 MG / 5 MG / 5 MG ..."
  let m = /^([\d.]+(?:\s*-\s*[\d.]+)+)\s*(MG|MCG|G)\b(.*)$/.exec(s);
  let parts = m ? m[1].split('-').map(Number) : null, unit = m && m[2], rest = m && m[3];
  if(!m){
    const m2 = /^((?:[\d.]+\s*(MG|MCG|G)\s*\/\s*)+[\d.]+\s*(MG|MCG|G))\b(.*)$/.exec(s);
    if(m2 && !/\/\s*ML\b/.test(m2[1])){ parts = (m2[1].match(/[\d.]+/g) || []).map(Number); unit = m2[2]; rest = m2[4]; }
  }
  if(parts && parts.length > 1){
    const equal = parts.every(v => v === parts[0]);
    if(sameMoiety(N) || sameMoiety(F.replace(/\s[\d.]+\s*(MG|MCG|G)\b/g, ' /').replace(/\b(ORAL|TABLET|CAPSULE|EXTENDED|RELEASE)\b.*$/, '')) || (equal && parts.length >= 3)){
      s = `${fmtNum(nice(parts.reduce((a, b) => a + b, 0)))} ${unit}${rest}`.trim();
    }
  }
  // 2) injectables with a fill volume (RxNorm full name "0.5 ML TIRZEPATIDE 10 MG/ML AUTO-INJECTOR")
  const src = s + ' | ' + F;
  const conc = /([\d.]+)\s*(MG|MCG)\s*\/\s*ML\b/.exec(src);
  const vol = /(?:^|[^\/\d.])([\d.]+)\s*ML\b(?!\s*\/)/.exec(F) || /(?:^|[^\/\d.])([\d.]+)\s*ML\b(?!\s*\/)/.exec(s.replace(conc ? conc[0] : '\u0000', ''));
  if(conc && vol && +vol[1] > 0 && +vol[1] !== 1){
    const v = +vol[1], amt = nice(+conc[1] * v);
    const form = s.replace(conc[0], '').replace(new RegExp('(^|\\s)' + vol[1].replace('.', '\\.') + '\\s*ML\\b'), ' ').replace(/\s+/g, ' ').trim();
    // single-dose pens/syringes (<1 mL): the box shows the dose only ("15 MG/0.5 ML");
    // larger / multi-dose containers: keep the per-mL figure too, since many vial cartons print that first
    const perMl = v > 1 ? ` (${fmtNum(+conc[1])} ${conc[2]}/ML)` : '';
    s = `${fmtNum(amt)} ${conc[2]}/${fmtNum(v)} ML${perMl} ${form}`.trim();
  }
  // 3) patches stated per hour
  const hr = /([\d.]+)\s*MG\s*\/\s*(?:HR|H)\b/.exec(s) || /([\d.]+)\s*MG\s*\/\s*(?:HR|H)\b/.exec(F);
  if(hr){
    const opioid = /FENTANYL|BUPRENORPHINE/.test(N + ' ' + F);
    const lab = opioid ? `${fmtNum(nice(+hr[1] * 1000))} MCG/HR` : `${fmtNum(nice(+hr[1] * 24))} MG/DAY`;
    s = hr.index !== undefined && s.includes(hr[0]) ? s.replace(hr[0], lab) : `${lab} ${s}`.trim();
  }
  return {sf: s, raw: s !== orig ? orig : ''};
}

function rxtSearch(terms){
  return cached(rxtCache, terms, async () => {
    const j = await getJSON(RXT + encodeURIComponent(terms));
    const names = (j && j[1]) || [], sf = (j && j[2] && j[2].STRENGTHS_AND_FORMS) || [], rc = (j && j[2] && j[2].RXCUIS) || [];
    const rows = [];
    names.forEach((full, i) => {
      const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(full), base = (m ? m[1] : full).toUpperCase(), route = m ? m[2] : '';
      (sf[i] || []).forEach((s, k) => { const ls = labelStrength(base, s);
        rows.push({kind:'drug', name:base, sf:ls.sf, raw:ls.raw, route:route.toUpperCase(), rxcui:(rc[i] || [])[k] || ''}); });
    });
    // pens / auto-injectors / prefilled syringes: RxTerms gives mg per mL; the box shows mg per pen, so get the fill volume now
    const pens = rows.filter(r => r.rxcui && /M?C?G\/ML\b/.test(r.sf) && /PEN|INJECTOR|SYRINGE|CARTRIDGE|PREFILLED|\bINJ|VIAL/.test(r.sf)).slice(0, 30);
    await Promise.all(pens.map(async r => { const sf = await refineStrength(r); if(sf && sf !== r.sf){ r.raw = r.raw || r.sf; r.sf = sf; } }));
    return rows;
  });
}
function propOf(p, name){ const l = (p.propertyConceptList && p.propertyConceptList.propertyConcept) || []; return (l.find(x => x.propName === name) || {}).propValue || ''; }
function ndcRow(p){
  const d = digitsOf(p.ndcItem);
  return {ndc: d.length === 11 ? fmt11(d) : (p.ndc10 || p.ndcItem || ''), ndc10: p.ndc10 || '',
    mfr: String(p.labeler || propOf(p, 'LABELER') || '').toUpperCase(),
    pkg: String(((p.packagingList && p.packagingList.packaging) || [])[0] || '').replace(/\s*\([^)]*\)\s*$/, '').toUpperCase(),
    setid: p.splSetIdItem || '', sched: propOf(p, 'DCSA'), rxcui: p.rxcui || ''};
}
function ndcsFor(rxcui){
  return cached(ndcCache, rxcui, async () => {
    const j = await getJSON(RXNAV_NDC + encodeURIComponent(rxcui));
    return ((j && j.ndcPropertyList && j.ndcPropertyList.ndcProperty) || []).map(ndcRow)
      .sort((a, b) => a.mfr.localeCompare(b.mfr) || a.ndc.localeCompare(b.ndc));
  });
}
// A 10-digit NDC without dashes can be 4-4-2, 5-3-2 or 5-4-1; each becomes 11 digits by adding a zero to a different group.
// Scanned barcodes: UPC-A "3 + NDC10 + check digit"; GS1 GTIN-14 "003 + NDC10 + check" (DataMatrix starts "(01)").
function scanToNdc(val){
  const v = String(val || '').trim(), d = digitsOf(v);
  if(/^\(?01\)?\s*003\d{11}/.test(v.replace(/\s/g, '')) || (d.length >= 16 && d.startsWith('01003'))) return d.slice(5, 15);
  if(d.length === 13 && d.startsWith('03')) return d.slice(2, 12);
  if(d.length === 14 && d.startsWith('003')) return d.slice(3, 13);
  if(d.length === 12 && d[0] === '3') return d.slice(1, 11);
  return v;
}
function ndcCandidates(val){
  val = scanToNdc(val);
  const d = digitsOf(val), dashes = (val.match(/-/g) || []).length;
  if(d.length === 11) return [d];
  if(d.length === 10 && dashes === 2) return [val.trim()];
  if(d.length === 10) return ['0' + d, d.slice(0,5) + '0' + d.slice(5), d.slice(0,9) + '0' + d.slice(9)];
  return [];
}
// every dashed 10-digit form an NDC could have (what FDA / DailyMed use)
function ndc10Forms(val){
  val = scanToNdc(val);
  const d = digitsOf(val), dashes = (val.match(/-/g) || []).length;
  if(d.length === 10 && dashes === 2) return [val.trim()];
  if(d.length === 10) return [`${d.slice(0,4)}-${d.slice(4,8)}-${d.slice(8)}`, `${d.slice(0,5)}-${d.slice(5,8)}-${d.slice(8)}`, `${d.slice(0,5)}-${d.slice(5,9)}-${d.slice(9)}`];
  if(d.length === 11){
    const a = d.slice(0,5), b = d.slice(5,9), c = d.slice(9), out = [];
    if(a[0] === '0') out.push(`${a.slice(1)}-${b}-${c}`);
    if(b[0] === '0') out.push(`${a}-${b.slice(1)}-${c}`);
    if(c[0] === '0') out.push(`${a}-${b}-${c.slice(1)}`);
    return out;
  }
  return [];
}
const to11 = n10 => { const p = String(n10).split('-'); return p.length === 3 ? p.map((x, i) => x.padStart([5,4,2][i], '0')).join('-') : n10; };
async function rxtName(rxcui){            // RxTerms name + strength for an RxNorm concept
  const t = await getJSON(RXNAV_TERMS(rxcui)), r = (t && t.rxtermsProperties) || {};
  if(!r.displayName && !r.fullName) return null;
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(r.displayName || '');
  const nm = String(m ? m[1] : (r.displayName || r.fullName)).toUpperCase();
  const ls = labelStrength(nm, [r.strength, r.rxtermsDoseForm].filter(Boolean).join(' '), r.fullName);
  return {name:nm, sf:ls.sf, raw:ls.raw, route:String(r.route || (m ? m[2] : '')).toUpperCase()};
}
// 1) RxNav (NLM). Every possible reading of a 10-digit NDC is tried and all hits are kept.
async function fromRxNav(val, errs){
  const out = [];
  for(const cand of ndcCandidates(val)){
    let j; try{ j = await getJSON(RXNAV_NDCPROP + encodeURIComponent(cand)); }catch(e){ errs.push(e); continue; }
    const p = ((j && j.ndcPropertyList && j.ndcPropertyList.ndcProperty) || [])[0];
    if(!p) continue;
    const row = ndcRow(p);
    if(out.some(o => o.ndc === row.ndc)) continue;
    const nm = p.rxcui ? await rxtName(p.rxcui).catch(() => null) : null;
    if(!nm) continue;                                   // known NDC but no drug name: let the next source name it
    out.push(Object.assign(row, {kind:'ndc', src:'rxnav'}, nm));
  }
  return out;
}
// openFDA strength "5 mg/1", "15 mg/.5mL", "0.05 mg/d" -> "5 MG", "15 MG/0.5 ML", "0.05 MG/DAY"
function ofStrength(ings){
  const one = x => String(x || '').trim().toUpperCase()
    .replace(/\/\s*1\b(?!\s*[A-Z])/, '').replace(/\/\s*\.(\d)/, '/0.$1').replace(/(\d)\s*ML\b/, '$1 ML').replace(/\/\s*D\b/, '/DAY').replace(/\/\s*H\b/, '/HR')
    .replace(/\s+/g, ' ');
  const parts = (ings || []).map(i => one(i.strength)).filter(Boolean);
  if(!parts.length) return '';
  const m = parts.map(x => /^([\d.]+)\s*(MG|MCG|G)$/.exec(x));
  if(parts.length > 1 && m.every(Boolean) && m.every(x => x[2] === m[0][2])) return m.map(x => x[1]).join('-') + ' ' + m[0][2];
  return parts.join(' / ');
}
// 2) FDA NDC Directory via openFDA: built from the same drug-listing SPLs DailyMed shows; updated daily, so
//    new packages, repackagers and relabelers often appear here before RxNorm maps them.
async function fromOpenFda(val, errs){
  const forms = ndc10Forms(val); if(!forms.length) return [];
  const url = OPENFDA_NDC + forms.map(f => 'packaging.package_ndc:' + encodeURIComponent('"' + f + '"')).join('+');
  let j;
  try{ const r = await fetch(url); if(r.status === 404) return []; if(!r.ok) throw new Error('HTTP ' + r.status); j = await r.json(); }
  catch(e){ if(BRIDGE){ try{ j = await bridgeGet(url); }catch(e2){ return []; } } else { e.src = 'of'; errs.push(e); return []; } }
  const out = [];
  for(const p of (j && j.results) || []){
    for(const pk of p.packaging || []){
      if(!forms.includes(pk.package_ndc)) continue;
      const rxcui = ((p.openfda && p.openfda.rxcui) || [])[0] || '';
      const brand = String(p.brand_name || '').toUpperCase().trim(), gen = String(p.generic_name || '').toUpperCase().trim();
      const form = String(p.dosage_form || '').toUpperCase().split(',')[0].trim();
      const nm = brand || gen, ls = labelStrength(gen || nm, [ofStrength(p.active_ingredients), form].filter(Boolean).join(' '));
      const row = {kind:'ndc', src:'openfda', name:nm, sf:ls.sf, raw:'', route:String((p.route || [])[0] || '').toUpperCase(),
        ndc:to11(pk.package_ndc), ndc10:pk.package_ndc, mfr:String(p.labeler_name || '').toUpperCase(),
        pkg:String(pk.description || '').replace(/\s*\([^)]*\)\s*$/, '').toUpperCase(),
        setid:((p.openfda && p.openfda.spl_set_id) || [])[0] || '', sched:p.dea_schedule || '', rxcui};
      if(rxcui){ const r = await rxtName(rxcui).catch(() => null); if(r && r.sf) Object.assign(row, {name:r.name, sf:r.sf, raw:r.raw}); }
      if(!out.some(o => o.ndc === row.ndc)) out.push(row);
    }
  }
  return out;
}
// 3) DailyMed itself (only reachable through the NorTex extension; DailyMed blocks web pages)
async function fromDailyMed(val){
  if(!BRIDGE) return [];
  const out = [];
  for(const f of ndc10Forms(val)){
    let j; try{ j = await bridgeGet(DM_SPLS + encodeURIComponent(f)); }catch(e){ continue; }
    const hit = ((j && j.data) || [])[0]; if(!hit) continue;
    const t = String(hit.title || '').toUpperCase(), lab = (/\[([^\]]+)\]\s*$/.exec(t) || [])[1] || '';
    out.push({kind:'ndc', src:'dailymed', name:t.replace(/\s*\[[^\]]+\]\s*$/, ''), sf:'', raw:'', route:'', ndc:to11(f), ndc10:f, mfr:lab, pkg:'', setid:hit.setid || '', rxcui:''});
  }
  return out;
}
// 4) entered by hand here before
function fromMemory(val){
  const keys = new Set([normNdc(scanToNdc(val)), ...ndcCandidates(val).map(fmt11), ...ndc10Forms(val).map(to11)]);
  for(const k of keys){
    const m = STATE && STATE.remember && STATE.remember[k];
    if(m && m.item) return [{kind:'ndc', src:'manual', name:m.item, sf:'', raw:'', route:'', ndc:k, ndc10:m.ndc10 || '', mfr:m.mfr || '', pkg:m.pkgSize || '', setid:'', rxcui:'', mine:true}];
  }
  return [];
}
async function lookupNdcAll(val){
  const errs = [];
  for(const src of [fromRxNav, fromOpenFda, fromDailyMed]){
    const rows = await src(val, errs);
    if(rows.length) return rows;
  }
  const mine = fromMemory(val); if(mine.length) return mine;
  // RxNav failed on every reading AND openFDA failed: that's a connection problem, not "not found"
  if(errs.filter(e => e.src !== 'of').length >= ndcCandidates(val).length && errs.some(e => e.src === 'of')) throw errs[0];
  return [];
}
async function lookupNdc(val){ return (await lookupNdcAll(val))[0] || null; }

/* matching + ranking: every word typed must appear; whole-word hits first ("25" doesn't count "250") */
const tokensOf = q => q.toLowerCase().trim().split(/[\s,/]+/).filter(Boolean);
function matchAll(tokens, hay){ for(const t of tokens) if(hay.indexOf(t) === -1) return false; return true; }
function rankOf(tokens, name){
  if(!matchAll(tokens, name)) return 2;
  for(const t of tokens){
    let ok = false;
    for(let k = name.indexOf(t); k !== -1; k = name.indexOf(t, k + 1)){
      const before = k === 0 || /[^a-z0-9.]/.test(name[k-1]), after = name[k + t.length];
      if(before && !(/\d$/.test(t) && after && /[\d.]/.test(after))){ ok = true; break; }
    }
    if(!ok) return 1;
  }
  return 0;
}

/* search box UI: click a drug + strength (or an NDC) to add it */
let shown = [], shownFor = null, hi = 0, searchTimer = null, gen = 0;
const box = () => $('results');
const isNdcQ = q => /^[\d\s-]+$/.test(q) && digitsOf(q).length >= 10;
const isScanNdc = q => ndcCandidates(q).length > 0 && (/^[\d\s-]+$/.test(q) || /^\(?01\)?\s*003\d{11}/.test(q.replace(/\s/g, '')));
const newDrugOption = () => { const q = $('search').value.trim(); if(!q) return '';
  return `<div class="newdrug" data-new="1">＋ ${isNdcQ(q) ? `Add NDC ${esc(q)} by hand` : `Not listed? Add “${esc(q)}” by hand`}</div>`; };
const ATTR = '<div class="none" style="font-size:11px;">Drug data: NLM RxTerms / RxNav · NDC labels open on DailyMed</div>';
function render(html){ box().innerHTML = html; box().style.display = 'block'; paintHi(); }
function showMsg(html, busy){ shown = []; shownFor = null; render(`<div class="none">${busy ? '<span class="spin"></span>' : ''}${html}</div>` + newDrugOption()); }
const STAR = '<span class="usedb" title="Used before at this pharmacy">★</span> ';
const timesTxt = p => p && p.n ? ` <span class="maker">ordered ${p.n}×</span>` : '';
function itemHtml(r, i){
  if(r.kind === 'drug') return `<div data-i="${i}">${r.prior ? STAR : ''}<b>${esc(r.name)} ${esc(r.sf)}</b>${timesTxt(r.prior)}${r.route ? ' <span class="muted">· ' + esc(r.route) + '</span>' : ''}${r.raw ? '<div class="sub">RxNorm lists it as ' + esc(r.raw) + '</div>' : ''}</div>`;
  return `<div data-i="${i}">${r.prior ? STAR : ''}${ndcHtml(r.ndc)}${timesTxt(r.prior)} · <span class="maker">${esc(r.mfr)}</span>${dm(r.ndc10 || r.ndc, r.setid)}
    <div class="sub">${r.kind === 'ndc' ? '<b>' + esc(r.name) + ' ' + esc(r.sf) + '</b> · ' : ''}${r.sched ? '<b>' + esc(r.sched) + '</b> · ' : ''}${esc(r.pkg)}</div></div>`;
}
async function runSearch(){
  const q = $('search').value.trim(), my = ++gen;
  if(!q){ box().style.display = 'none'; shown = []; return; }
  const d = digitsOf(q);
  if(/^[\d\s-]+$/.test(q) || /^\(?01\)?\s*003\d{11}/.test(q.replace(/\s/g, ''))){   // NDC, or a scanned barcode
    if(d.length < 10) return showMsg('Keep typing: the full NDC is 10 or 11 digits (dashes optional).');
    if(!ndcCandidates(q).length) return showMsg('That isn’t an NDC: 10 or 11 digits (dashes optional), or scan the barcode.');
    showMsg('Looking up that NDC…', true);
    let rows; try{ rows = await lookupNdcAll(q); }catch(e){ if(my === gen) showMsg(lookupError()); return; }
    if(my !== gen) return;
    if(!rows.length) return showMsg(`<b>${esc(q)}</b> isn’t in RxNorm or the FDA NDC Directory${BRIDGE ? ' or DailyMed' : ''} yet `
      + `(common for brand-new packages, repackagers and some compounding/OTC items). Add it by hand below; it will be remembered for next time.`);
    shown = usedFirst(rows, r => r.ndc); shownFor = q; hi = 0;
    const SRC = {rxnav:'RxNorm', openfda:'FDA NDC Directory (not yet in RxNorm)', dailymed:'DailyMed (not yet in RxNorm)', manual:'entered by hand here before'};
    const head = rows.length > 1 ? `${rows.length} products match those 10 digits — pick the one on your bottle (check the bold middle number)` : `NDC found · ${SRC[rows[0].src] || ''}`;
    return render(`<div class="sect">${head}</div>` + rows.map(itemHtml).join('') + newDrugOption() + ATTR);
  }
  const tokens = tokensOf(q);
  const words = tokens.filter(t => /[a-z]/.test(t));
  if(words.join('').replace(/[^a-z]/g, '').length < 3) return showMsg('Keep typing: at least 3 letters of the drug name, or a full NDC.');
  showMsg('Searching…', true);
  let rows; try{ rows = await rxtSearch(words.join(' ')); }catch(e){ if(my === gen) showMsg(lookupError()); return; }
  if(my !== gen) return;
  const hay = r => `${r.name} ${r.sf} ${r.route} ${r.raw || ''}`.toLowerCase();
  const b = [[],[],[]];
  for(const r of rows) if(matchAll(tokens, hay(r))) b[matchAll(tokens, hay({...r, raw:''})) ? rankOf(tokens, hay({...r, raw:''})) : 2].push(r);
  const ranked = b[0].concat(b[1], b[2]);
  const drugKey = r => { const m = STATE.remember || {}; const a = r.rxcui && 'rx:' + r.rxcui, i = 'item:' + (labelFor(STATE, '', r.rxcui) || r.name + ' ' + r.sf);
    return (a && m[a]) ? a : (m[i] ? i : ''); };
  shown = usedFirst(ranked, drugKey); shownFor = q; hi = 0;
  if(!shown.length) return showMsg(rows.length ? 'No strength matches every word you typed.' : 'No match. Check the spelling, or type more of the name.');
  const np = shown.filter(r => r.prior).length;
  render(`<div class="sect">${shown.length} match${shown.length === 1 ? '' : 'es'}${np ? ` · ★ ${np} used before (listed first)` : ''} · click to add · choose the NDC in the list below</div>`
    + shown.map(itemHtml).join('') + newDrugOption() + ATTR);
}
async function refineStrength(r){        // RxTerms' short list may omit the fill volume; its full RxNorm name has it
  if(!r.rxcui) return r.sf;
  try{
    const t = await getJSON(RXNAV_TERMS(r.rxcui)), x = (t && t.rxtermsProperties) || {};
    return labelStrength(r.name, r.raw || r.sf, x.fullName).sf;
  }catch(e){ return r.sf; }
}
async function choose(r){
  if(!r) return;
  if(r.kind === 'drug'){
    box().style.display = 'none';
    const sf = await refineStrength(r);
    return addLine({name:r.name, strength:'', form:sf, mfr:'', ndc:'', pkg:'', setid:'', rxcui:r.rxcui, src:'rxnav'});
  }
  addLine({name:r.name, strength:'', form:r.sf, mfr:r.mfr, ndc:r.ndc, ndc10:r.ndc10 || '', pkg:r.pkg, setid:r.setid || '', rxcui:r.rxcui || '', src:'rxnav'});
}
function paintHi(){
  box().querySelectorAll('div[data-i]').forEach(d => d.classList.toggle('hi', +d.dataset.i === hi));
  const el = box().querySelector(`div[data-i="${hi}"]`); if(el) el.scrollIntoView({block:'nearest'});
}
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 250); });
$('search').addEventListener('focus', () => { if($('search').value.trim() && box().innerHTML) box().style.display = 'block'; });
$('search').addEventListener('keydown', e => {
  if(e.key === 'ArrowDown'){ hi = Math.min(hi + 1, shown.length - 1); paintHi(); e.preventDefault(); }
  else if(e.key === 'ArrowUp'){ hi = Math.max(hi - 1, 0); paintHi(); e.preventDefault(); }
  else if(e.key === 'Enter'){
    e.preventDefault();
    const q = $('search').value.trim();
    // only use the list on screen if it was made for exactly what's in the box now. A barcode scanner types the
    // code and presses Enter faster than the lookup answers; an older list must never be used for the new code.
    if(shown[hi] && shownFor === q){ choose(shown[hi]); return; }
    clearTimeout(searchTimer);
    runSearch().then(() => {
      // scanned / typed NDC with exactly one product: add it straight away (name searches still let you pick)
      if(isScanNdc(q) && shownFor === q && shown.length === 1 && $('search').value.trim() === q) choose(shown[0]);
    });
  }
  else if(e.key === 'Escape'){ box().style.display = 'none'; }
});
$('results').addEventListener('click', e => {
  if(e.target.closest('a')) return;                    // DailyMed link opens without adding
  if(e.target.closest('[data-new]')){ startNewDrug($('search').value.trim()); return; }
  const d = e.target.closest('div[data-i]'); if(d) choose(shown[+d.dataset.i]);
});
document.addEventListener('click', e => { if(!e.target.closest('.search-wrap')) box().style.display = 'none'; });

/* Setup: test the lookups from THIS browser */
$('dmTest').onclick = async () => {
  const s = $('dmStatus'); s.className = 'banner info'; s.innerHTML = '<span class="spin"></span>Testing from this browser…';
  async function probe(url){
    try{ const r = await fetch(url, {headers:{Accept:'application/json'}}); return r.ok ? 'works' : 'error ' + r.status; }
    catch(e){ try{ await fetch(url, {mode:'no-cors'}); return 'blocked'; }catch(e2){ return 'unreachable'; } }
  }
  const [a, b] = await Promise.all([probe(RXT + 'atenolol'), probe(RXNAV_NDCPROP + '00093075201')]);
  const say = v => v === 'works' ? '✅ works' : v === 'blocked' ? '❌ reachable, but blocks web pages' : v === 'unreachable' ? '❌ can’t reach (no internet or network block)' : '⚠️ ' + v;
  const ok = a === 'works' && b === 'works';
  s.className = 'banner ' + (ok || BRIDGE ? 'info' : 'warn');
  s.innerHTML = `<b>${ok ? 'Drug search is ready.' : BRIDGE ? 'Using the NorTex extension for lookups.' : 'Drug search won’t work in this browser yet.'}</b><br>
    Drug names (RxTerms): ${say(a)}<br>NDCs (RxNav): ${say(b)}<br>NorTex extension: ${BRIDGE ? '✅ found' : 'not installed (only needed if the above fail)'}
    ${ok || BRIDGE ? '' : '<br>Send a screenshot of this box to whoever hosts the app.'}`;
};

/* ---------------- reorder list ---------------- */
function shortPkg(desc){
  // "100 TABLET in 1 BOTTLE" -> "100 TABLET";  "1 BOTTLE in 1 CARTON > 90 TABLET in 1 BOTTLE" -> "1 BOTTLE × 90 TABLET"
  return (desc || '').split('>').map(s => s.trim().replace(/\s+in\s+1\s+.*$/i, '').trim()).filter(Boolean).join(' × ');
}
async function addLine(o){
  $('results').style.display = 'none'; $('search').value = '';
  box().style.display = 'none'; gen++;
  const item = labelFor(STATE, o.ndc, o.rxcui) || [o.name, o.strength, o.form].filter(Boolean).join(' ');
  // same NDC, or (when no NDC is given) the same drug + strength already on the list
  const same = r => o.ndc ? r.ndc === o.ndc : r.item === item;
  const dup = STATE.reorder.find(same);
  if(dup){ toast('Already on the list: ' + item); flashRowId(dup.id); return; }
  const mem = (o.ndc && STATE.remember[o.ndc]) || {};
  const line = {id:uid(), dateAdded:todayISO(), item, mfr:o.mfr || '', ndc:o.ndc, ndc10:o.ndc10 || '', setid:o.setid || '',
    pkgSize: mem.pkgSize || shortPkg(o.pkg), qty: +mem.qty > 0 ? +mem.qty : 1, autoQty: +mem.qty > 0 ? +mem.qty : '', src:o.src || 'rxnav', rxcui:o.rxcui || ''};
  line.autoPkg = line.pkgSize;
  line.dist = line.autoDist = lastDist(STATE, o.ndc, item);
  if(!await change(s => { if(s.reorder.some(same)) return; s.reorder.push(line);
    if(o.ndc) memTouch(s, o.ndc); if(o.rxcui) memTouch(s, 'rx:' + o.rxcui); memTouch(s, 'item:' + item); })) return;
  toast('Added: ' + item);
  $('search').focus();
}
function flashRowId(id){
  const tr = $('listBody').querySelector(`tr[data-id="${CSS.escape(id)}"]`);
  if(tr){ tr.scrollIntoView({block:'center'}); tr.style.outline = '2px solid #f0b429'; setTimeout(() => tr.style.outline = '', 1500); }
}
function flashRow(ndc){
  const tr = $('listBody').querySelector(`tr[data-ndc="${CSS.escape(ndc)}"]`);
  if(tr){ tr.scrollIntoView({block:'center'}); tr.style.outline = '2px solid #f0b429'; setTimeout(() => tr.style.outline = '', 1500); }
}

/* drug that isn't on DailyMed (supplies, compounding items) */
function normNdc(v){
  v = (v || '').trim();
  const digits = v.replace(/\D/g, '');
  if(v.split('-').length === 3) return v.split('-').map((p, i) => p.padStart([5,4,2][i], '0')).join('-');
  if(digits.length === 11) return `${digits.slice(0,5)}-${digits.slice(5,9)}-${digits.slice(9)}`;
  return v;
}
function startNewDrug(name){
  $('results').style.display = 'none';
  const ndc = isNdcQ(name) ? scanToNdc(name) : '';
  $('newDrugName').value = ndc ? '' : name.toUpperCase(); $('newDrugNdc').value = ndc; $('newDrugMfr').value = '';
  $('newDrugDm').innerHTML = ndc ? dm(normNdc(ndc)) : '';
  $('newDrug').style.display = 'block'; (ndc ? $('newDrugName') : $('newDrugNdc')).focus();
}
function endNewDrug(){ $('newDrug').style.display = 'none'; $('search').value = ''; }
$('newDrugNdc').addEventListener('input', () => { $('newDrugDm').innerHTML = dm(normNdc($('newDrugNdc').value)); });
['newDrugNdc','newDrugName','newDrugMfr'].forEach(k => $(k).addEventListener('keydown', e => { if(e.key === 'Enter') $('newDrugAdd').click(); }));
$('newDrugCancel').onclick = endNewDrug;
$('newDrugAdd').onclick = async () => {
  const ndc = normNdc($('newDrugNdc').value), digits = ndc.replace(/\D/g, '');
  if(digits.length < 10 || digits.length > 11){ toast('Enter the full NDC (10 or 11 digits).'); return; }
  const name = $('newDrugName').value.trim().toUpperCase(), mfr = $('newDrugMfr').value.trim().toUpperCase();
  if(!name){ toast('Type the drug name and strength as on the bottle.'); $('newDrugName').focus(); return; }
  // remember it so the next time this NDC is typed or scanned it is found here
  if(!await change(st => { st.remember[ndc] = Object.assign({}, st.remember[ndc], {item:name}, mfr ? {mfr} : {}); })) return;
  await addLine({name, mfr, ndc, src:'manual'});
  endNewDrug();
};

/* ---- what this pharmacy used before: drugs, NDCs and distributors go to the top, most recent first ---- */
function memTouch(st, key, patch){                    // remember that this drug / NDC was used, and when
  if(!key) return;
  st.remember[key] = Object.assign({}, st.remember[key], patch || {}, {last:new Date().toISOString()});
}
function memDist(st, key, dist){                      // newest distributor first, up to 6 kept per drug / NDC
  if(!key || !dist) return;
  const m = st.remember[key] || {}, prev = Array.isArray(m.dists) ? m.dists : (m.dist ? [m.dist] : []);
  st.remember[key] = Object.assign({}, m, {dist, dists:[dist].concat(prev.filter(d => d !== dist)).slice(0, 6), last:new Date().toISOString()});
}
// a submitted line counts once for its NDC, its drug and its distributor (how often = frequency)
function memSubmitted(st, key, dist){
  if(!key) return;
  const m = Object.assign({}, st.remember[key]);
  m.n = (+m.n || 0) + 1;
  if(dist){ const dn = Object.assign({}, m.distN); dn[dist] = (+dn[dist] || 0) + 1; m.distN = dn; }
  st.remember[key] = m;
}
// distributors used before for this drug / NDC: the most recent first, then the rest by how often they were used
function distHistory(st, ndc, item){
  const m = st.remember || {}, recent = [], count = {};
  for(const k of [ndc, item && 'item:' + item]){
    const e = k && m[k]; if(!e) continue;
    for(const d of (Array.isArray(e.dists) ? e.dists : (e.dist ? [e.dist] : []))) if(d && !recent.includes(d)) recent.push(d);
    for(const [d, n] of Object.entries(e.distN || {})) count[d] = Math.max(count[d] || 0, +n || 0);
  }
  if(recent.length < 2) return recent;
  const [newest, ...rest] = recent;
  return [newest].concat(rest.sort((a, b) => (count[b] || 0) - (count[a] || 0) || recent.indexOf(a) - recent.indexOf(b)));
}
// drugs / NDCs: the one used most recently first, then the others used before by how often they were submitted, then the rest
function usedFirst(list, keyOf){
  const info = x => { const e = st0()[keyOf(x)] || null; return e ? {last:e.last || '0', n:+e.n || 0} : null; };
  const st0 = () => (STATE && STATE.remember) || {};
  const used = [], unused = [];
  for(const x of list){ const u = keyOf(x) && info(x); if(u){ x.prior = u; used.push(x); } else { x.prior = null; unused.push(x); } }
  if(!used.length) return list;
  used.sort((a, b) => b.prior.last.localeCompare(a.prior.last));
  const [newest, ...rest] = used;
  rest.sort((a, b) => b.prior.n - a.prior.n || b.prior.last.localeCompare(a.prior.last));
  return [newest].concat(rest, unused);
}
const usedAt = (st, key) => { const e = key && st.remember && st.remember[key]; return (e && (e.last || (e.dist || e.pkgSize || e.item ? '0' : ''))) || ''; };
// distributors added by this pharmacy (not on the standard list), kept with the pharmacy's memory
const NEW_DIST = '__add_new_distributor__';
function allDistributors(st){
  const extra = ((st && st.remember && st.remember['_distributors']) || {}).list || [];
  const out = DISTRIBUTORS.slice();
  for(const d of extra) if(d && !out.some(x => x.toLowerCase() === String(d).toLowerCase())) out.push(String(d));
  return out.sort((a, b) => a.localeCompare(b, undefined, {sensitivity:'base'}));
}
function distOptions(cur, hist){
  hist = (hist || []).filter(Boolean);
  const all = allDistributors(STATE);
  for(const h of hist.concat(cur ? [cur] : [])) if(!all.includes(h)) all.push(h);   // keep any older or custom name already saved
  const opt = n => `<option${n === cur ? ' selected' : ''}>${esc(n)}</option>`;
  const add = `<option value="${NEW_DIST}">＋ Add a distributor not on the list…</option>`;
  if(!hist.length) return all.map(opt).join('') + add;
  return `<optgroup label="Used before (last used, then most used)">${hist.map(opt).join('')}</optgroup>`
    + `<optgroup label="All distributors">${all.filter(n => !hist.includes(n)).map(opt).join('')}</optgroup>` + add;
}
function renderList(){
  if(!STORE) return;
  const rows = STATE.reorder.filter(r => r.need === 'out').concat(STATE.reorder.filter(r => r.need !== 'out'));   // out of stock goes to the top
  $('openCount').textContent = rows.length;
  const done = rows.filter(r => r.ordered).length;
  const outN = rows.filter(r => r.need === 'out').length;
  $('orderedCount').textContent = rows.length ? `Ordered: ${done} of ${rows.length}` + (outN ? ` · Out of stock: ${outN}` : '') : '';
  $('submitBtn').disabled = !rows.length || !PERM('submit');
  $('listBody').innerHTML = rows.length ? rows.map(r => `<tr data-id="${esc(r.id)}" data-ndc="${esc(r.ndc)}" class="${[r.ordered ? 'is-ordered' : '', r.need === 'out' ? 'is-out' : ''].join(' ').trim()}">
      <td class="added">${fmtDate(r.dateAdded)}${r.addedBy ? `<div class="added-by">by ${esc(r.addedBy)}</div>` : ''}</td>
      <td class="drug"><b>${esc(r.item)}</b> <button class="edit" data-edit="${esc(r.id)}" title="Edit to match the bottle or box (remembered for next time)">✎</button>${r.src === 'manual' ? '<div class="maker">entered by hand</div>' : ''}</td>
      <td class="need" data-l="Need"><select data-f="need" class="${r.need === 'out' ? 'out' : r.need ? '' : 'need'}" title="Out of stock: holding up dispensing. Replenish: ordering ahead.">
        <option value=""${r.need ? '' : ' selected'}>Choose…</option><option value="out"${r.need === 'out' ? ' selected' : ''}>Out of stock</option><option value="restock"${r.need === 'restock' ? ' selected' : ''}>Replenish</option></select></td>
      <td class="ndc" data-l="NDC"><input type="text" class="ndcin" data-ndcin="${esc(r.id)}" data-rx="${esc(r.rxcui || '')}" value="${esc(r.ndc)}" placeholder="${r.rxcui ? 'Pick or type NDC' : 'Type NDC'}" autocomplete="off" spellcheck="false"></td>
      <td class="mfr" data-l="Manufacturer">${r.mfr ? esc(r.mfr) : '<span class="maker">' + (r.ndc ? '—' : 'choose an NDC') + '</span>'}</td>
      <td class="dist" data-l="Distributor"><select data-f="dist" class="${r.dist ? '' : 'need'}" title="${r.dist && r.dist === r.autoDist ? 'Filled in from the last time this was ordered' : 'Where this is ordered from'}">
        <option value="">Choose distributor…</option>${distOptions(r.dist, distHistory(STATE, r.ndc, r.item))}</select>${r.dist && r.dist === r.autoDist ? '<div class="maker">last used</div>' : ''}</td>
      <td class="pkg" data-l="Pkg Size"><input type="text" data-f="pkgSize" value="${esc(r.pkgSize)}" placeholder="e.g. 100 ct"></td>
      <td class="qty" data-l="Qty"><input type="number" inputmode="numeric" min="1" data-f="qty" value="${esc(r.qty)}"${r.autoQty && +r.qty === +r.autoQty ? ' class="lastqty" title="Same quantity as the last order. Change it if you need a different amount."' : ''}></td>
      <td class="chk" data-l="Ordered"><input type="checkbox" data-f="ordered" ${r.ordered ? 'checked' : ''} title="${r.ordered ? 'Ordered' + (r.orderedBy ? ' by ' + esc(r.orderedBy) : '') + (r.orderedAt ? ' ' + new Date(r.orderedAt).toLocaleString([], {month:'numeric', day:'numeric', hour:'numeric', minute:'2-digit', timeZone:storeTZ(), timeZoneName:'short'}) : '') : 'Tick once this has been ordered'}"></td>
      <td>${dm(r.ndc10 || r.ndc, r.setid)}</td>
      <td>${PERM('remove') ? `<button class="x" data-del="${esc(r.id)}" title="Remove from list">×</button>` : ''}</td>
    </tr>`).join('') : '<tr><td colspan="11" class="empty">Nothing to order yet. Search above to add a drug.</td></tr>';
}
/* ---- NDC box in each row: pick from the drug's NDCs OR type an exact NDC ----
   One shared pop-up list sits under whichever NDC box is active. The list shows NDC · manufacturer ·
   package; once chosen, the box shows only the NDC (manufacturer has its own column). */
const pop = $('ndcPop');
let popInput = null, popRows = [], popHi = 0;
const lineOf = id => STATE.reorder.find(x => x.id === id);
function placePop(inp){
  const r = inp.getBoundingClientRect();
  pop.style.left = (r.left + window.scrollX) + 'px';
  pop.style.top = (r.bottom + window.scrollY + 2) + 'px';
  pop.style.minWidth = Math.max(r.width, 380) + 'px';
}
function hidePop(){ pop.style.display = 'none'; popInput = null; popRows = []; }
async function showPop(inp){
  popInput = inp; placePop(inp);
  const rx = inp.dataset.rx, typed = inp.value.trim(), td = digitsOf(typed), tt = typed.toUpperCase();
  if(!rx){ pop.innerHTML = '<div class="none">Type the exact NDC (10 or 11 digits).</div>'; pop.style.display = 'block'; popRows = []; return; }
  pop.innerHTML = '<div class="none"><span class="spin"></span>Loading NDCs…</div>'; pop.style.display = 'block';
  let list; try{ list = await ndcsFor(rx); }catch(e){ list = null; }
  if(popInput !== inp) return;
  if(!list){ pop.innerHTML = '<div class="none">NDC list isn’t available right now. You can still type the exact NDC.</div>'; popRows = []; return; }
  const cur = lineOf(inp.dataset.ndcin);
  const filtering = typed && !(cur && typed === cur.ndc);
  const hits0 = filtering ? list.filter(o => (td && (digitsOf(o.ndc).includes(td) || digitsOf(o.ndc10).includes(td))) || (!td && o.mfr.includes(tt))) : list;
  const hits = usedFirst(hits0.map(o => Object.assign({}, o)), o => o.ndc);
  popRows = [{clear:true}].concat(hits);
  popHi = Math.max(0, popRows.findIndex(o => cur && o.ndc === cur.ndc));
  if(filtering && hits.length) popHi = 1;
  pop.innerHTML = `<div class="sect">${list.length} active NDC${list.length === 1 ? '' : 's'}${filtering ? ` · ${hits.length} match${hits.length === 1 ? '' : 'es'}` : ''} · or type the exact NDC</div>`
    + popRows.map((o, i) => o.clear
        ? `<div data-p="${i}" class="muted">Any NDC (decide later)</div>`
        : `<div data-p="${i}">${o.prior ? STAR : ''}${ndcHtml(o.ndc)}${timesTxt(o.prior)} · ${esc(o.mfr)}${o.sched ? ' · <b>' + esc(o.sched) + '</b>' : ''}<div class="sub">${esc(o.pkg)}</div></div>`).join('')
    + (filtering && !hits.length ? `<div class="none">${td.length >= 10 ? 'Not in this drug’s list. Press Enter to look it up.' : 'No NDC in the list matches. Keep typing the full NDC.'}</div>` : '');
  paintPop();
}
function paintPop(){
  pop.querySelectorAll('[data-p]').forEach(d => d.classList.toggle('hi', +d.dataset.p === popHi));
  const el = pop.querySelector(`[data-p="${popHi}"]`); if(el) el.scrollIntoView({block:'nearest'});
}
// write the chosen NDC (or none) onto the line
function setNdc(id, o){
  if(o && o.ndc && STATE.reorder.some(x => x.id !== id && x.ndc === o.ndc)){ toast('That NDC is already on the list.'); flashRow(o.ndc); renderList(); return; }
  return change(s => {
    const r = s.reorder.find(x => x.id === id); if(!r) return;
    const mem = (o && o.ndc && s.remember[o.ndc]) || {};
    r.ndc = o ? o.ndc : ''; r.ndc10 = o ? (o.ndc10 || '') : ''; r.mfr = o ? (o.mfr || '') : ''; r.setid = o ? (o.setid || '') : '';
    if(o && o.item) r.item = o.item;
    if(!r.itemEdited){ const lbl = labelFor(s, r.ndc, o && o.rxcui || r.rxcui); if(lbl) r.item = lbl; }
    if(o && o.rxcui) r.rxcui = o.rxcui;
    if(o && o.ndc) memTouch(s, o.ndc);
    if(!r.pkgSize || r.pkgSize === r.autoPkg){ r.pkgSize = o ? (mem.pkgSize || shortPkg(o.pkg)) : ''; r.autoPkg = r.pkgSize; }
    if(+r.qty === 1 || (r.autoQty && +r.qty === +r.autoQty)){       // quantity nobody has changed: last time's for this NDC
      if(+mem.qty > 0){ r.qty = +mem.qty; r.autoQty = +mem.qty; } else if(r.autoQty){ r.qty = 1; r.autoQty = ''; }
    }
    if(!r.dist || r.dist === r.autoDist){ const d = lastDist(s, r.ndc, r.item); if(d || !r.dist){ r.dist = d; r.autoDist = d; } }
  });
}
// a typed NDC: use the matching list entry, otherwise look it up in RxNav
async function commitTyped(inp){
  const id = inp.dataset.ndcin, line = lineOf(id); if(!line) return;
  const val = inp.value.trim();
  if(!val){ if(line.ndc) await setNdc(id, null); return; }
  if(val === line.ndc) return;
  const d = digitsOf(val);
  if(d.length < 10 || d.length > 11){ toast('An NDC is 10 or 11 digits.'); inp.value = line.ndc; return; }
  const list = line.rxcui ? await ndcsFor(line.rxcui).catch(() => []) : [];
  const inList = list.find(o => digitsOf(o.ndc) === d || digitsOf(o.ndc10) === d);
  if(inList) return setNdc(id, inList);
  inp.disabled = true; const old = inp.value; inp.value = 'Looking up…';
  let found = null; try{ found = await lookupNdc(val); }catch(e){}
  inp.disabled = false; inp.value = old;
  if(!found){
    const ndc = d.length === 11 ? fmt11(d) : val;
    toast('That NDC isn’t in RxNorm, so it was kept as typed with no manufacturer.');
    return setNdc(id, {ndc, mfr:'', pkg:'', setid:''});
  }
  if(STATE.reorder.some(x => x.id !== id && x.ndc === found.ndc)){ toast('That NDC is already on the list.'); flashRow(found.ndc); inp.value = line.ndc; return; }
  const foundItem = [found.name, found.sf].filter(Boolean).join(' ');
  if(foundItem && foundItem !== line.item && !confirm(`That NDC is ${foundItem}, not ${line.item}.\n\nUse it and change the drug on this line?`)){ inp.value = line.ndc; return; }
  return setNdc(id, Object.assign({}, found, {item: foundItem || line.item}));
}
$('listBody').addEventListener('focusin', e => { const inp = e.target.closest('input[data-ndcin]'); if(inp){ inp.select(); showPop(inp); } });
$('listBody').addEventListener('input', e => { const inp = e.target.closest('input[data-ndcin]'); if(inp) showPop(inp); });
$('listBody').addEventListener('keydown', e => {
  const inp = e.target.closest('input[data-ndcin]'); if(!inp) return;
  if(e.key === 'ArrowDown'){ if(pop.style.display !== 'block') showPop(inp); popHi = Math.min(popHi + 1, popRows.length - 1); paintPop(); e.preventDefault(); }
  else if(e.key === 'ArrowUp'){ popHi = Math.max(popHi - 1, 0); paintPop(); e.preventDefault(); }
  else if(e.key === 'Escape'){ const l = lineOf(inp.dataset.ndcin); inp.value = l ? l.ndc : ''; hidePop(); inp.blur(); }
  else if(e.key === 'Enter'){
    e.preventDefault();
    const typed = digitsOf(inp.value), o = popRows[popHi];
    const id = inp.dataset.ndcin; hidePop(); inp.dataset.done = '1';
    if(typed.length >= 10 && !(o && o.ndc && digitsOf(o.ndc).includes(typed))) commitTyped(inp);
    else if(o) setNdc(id, o.clear ? null : o);
    inp.blur();
  }
});
$('listBody').addEventListener('focusout', e => {
  const inp = e.target.closest('input[data-ndcin]'); if(!inp) return;
  setTimeout(() => {                                        // a click in the list is handled by mousedown below
    if(popInput === inp) hidePop();
    if(inp.dataset.done){ delete inp.dataset.done; return; }
    if(document.activeElement !== inp && !inp.disabled){ const l = lineOf(inp.dataset.ndcin); if(l && inp.value.trim() !== l.ndc) commitTyped(inp); }
  }, 150);
});
pop.addEventListener('mousedown', e => {
  e.preventDefault();                                       // keep focus in the box
  const d = e.target.closest('[data-p]'); if(!d || !popInput) return;
  const o = popRows[+d.dataset.p], inp = popInput;
  inp.value = o.clear ? '' : o.ndc; inp.dataset.done = '1';
  hidePop(); setNdc(inp.dataset.ndcin, o.clear ? null : o); inp.blur();
});
window.addEventListener('resize', () => { if(popInput) placePop(popInput); });
document.addEventListener('scroll', () => { if(popInput) placePop(popInput); }, true);

$('listBody').addEventListener('change', async e => {
  const inp = e.target.closest('input[data-f], select[data-f]'); if(!inp) return;
  const id = inp.closest('tr').dataset.id, f = inp.dataset.f;
  let val = f === 'ordered' ? inp.checked : f === 'qty' ? Math.max(1, parseInt(inp.value, 10) || 1) : inp.value.trim();
  if(f === 'dist' && val === NEW_DIST){
    const name = (prompt('Name of the distributor to add (it stays on this pharmacy’s list):') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if(!name){ renderList(); return; }
    const known = allDistributors(STATE).find(x => x.toLowerCase() === name.toLowerCase());
    val = known || name;
    if(!known){
      if(!await change(st => { const m = st.remember['_distributors'] || {}; const list = (m.list || []).filter(x => x.toLowerCase() !== name.toLowerCase());
        st.remember['_distributors'] = {list:list.concat([name]).slice(-60)}; })) { renderList(); return; }
      toast('Added distributor: ' + name);
    }
  }
  change(s => { const r = s.reorder.find(x => x.id === id); if(!r) return; r[f] = val;
    if(f === 'dist'){ r.autoDist = ''; if(val){ memDist(s, r.ndc, val); memDist(s, 'item:' + r.item, val); } }
    if(f === 'ordered') r.orderedAt = val ? new Date().toISOString() : '';
    if(f === 'qty') r.autoQty = ''; });
});
$('listBody').addEventListener('click', e => {
  const ed = e.target.closest('[data-edit]');
  if(ed){
    const r = STATE.reorder.find(x => x.id === ed.dataset.edit); if(!r) return;
    const v = (prompt('Drug name and strength exactly as on the bottle or box:', r.item) || '').trim().toUpperCase();
    if(!v || v === r.item) return;
    return change(s => {
      const x = s.reorder.find(y => y.id === r.id); if(!x) return;
      const old = x.item; x.item = v; x.itemEdited = true;
      // remember the wording for this NDC (and for the drug when no NDC is chosen), for everyone
      if(x.ndc) s.remember[x.ndc] = Object.assign({}, s.remember[x.ndc], {item:v});
      if(x.rxcui) s.remember['rx:' + x.rxcui] = Object.assign({}, s.remember['rx:' + x.rxcui], {item:v});
      const od = s.remember['item:' + old];                // keep the distributor memory under the new wording
      if(od && od.dist && !(s.remember['item:' + v] || {}).dist) s.remember['item:' + v] = Object.assign({}, s.remember['item:' + v], {dist:od.dist});
    });
  }
  const b = e.target.closest('[data-del]'); if(!b) return;
  change(s => { s.reorder = s.reorder.filter(x => x.id !== b.dataset.del); });
});

$('submitBtn').onclick = async () => {
  const n = STATE.reorder.length;
  if(!n) return;
  const missing = STATE.reorder.filter(r => !r.dist).length, unticked = STATE.reorder.filter(r => !r.ordered).length;
  if(!confirm(`Archive ${n} line${n === 1 ? '' : 's'} for ${STORE.id}? They move to the Archive.` +
     (unticked ? `\n\n${unticked} line${unticked === 1 ? ' is' : 's are'} not ticked as ordered yet.` : '') +
     (missing ? `\n\n${missing} line${missing === 1 ? ' has' : 's have'} no distributor chosen.` : ''))) return;
  let done = 0;
  const saved = await change(s => {
    const today = todayISO(), at = new Date().toISOString();
    for(const r of s.reorder){
      s.archive.push({id:uid(), lineId:r.id, dateAdded:r.dateAdded, dateSubmitted:today, submittedAt:at, item:r.item, mfr:r.mfr, ndc:r.ndc, ndc10:r.ndc10 || '', setid:r.setid || '', pkgSize:r.pkgSize, qty:r.qty, dist:r.dist || '', ordered:!!r.ordered, orderedAt:r.orderedAt || ''});
      // remembered for next time: package size by NDC; distributor by NDC and by drug + strength
      if(r.ndc && r.pkgSize) s.remember[r.ndc] = Object.assign({}, s.remember[r.ndc], {pkgSize:r.pkgSize});
      if(r.ndc && +r.qty > 0) s.remember[r.ndc] = Object.assign({}, s.remember[r.ndc], {qty:+r.qty});
      if(r.dist){ memDist(s, r.ndc, r.dist); memDist(s, 'item:' + r.item, r.dist); }
      memSubmitted(s, r.ndc, r.dist); memSubmitted(s, r.rxcui && 'rx:' + r.rxcui, r.dist); memSubmitted(s, 'item:' + r.item, r.dist);
      done++;
    }
    s.reorder = [];
  });
  if(!saved) return;
  $('archDate').value = todayISO(); renderArchive();       // Archive tab opens on today's orders, collapsed
  toast(`Submitted ${done} line${done === 1 ? '' : 's'}. See Archive.`);
};

/* ---------------- archive ---------------- */
const openOrders = new Set();          // which orders are expanded (kept across refreshes)
function orderKey(r){ return r.submittedAt || r.dateSubmitted || ''; }
function fmtTime(iso){ if(!iso || iso.length < 11) return ''; const d = new Date(iso); if(isNaN(d)) return ''; try{ return d.toLocaleTimeString([], {hour:'numeric', minute:'2-digit', timeZone:storeTZ(), timeZoneName:'short'}); }catch(e){ return d.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}); } }
function archiveOrders(){
  const day = $('archDate').value, groups = new Map();
  for(const r of STATE.archive){
    if(day && r.dateSubmitted !== day) continue;
    const k = orderKey(r); if(!groups.has(k)) groups.set(k, []); groups.get(k).push(r);
  }
  return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}
function renderArchive(){
  if(!STORE) return;
  $('archMore').style.display = archCursor && !$('archDate').value ? '' : 'none';
  const day = $('archDate').value, orders = archiveOrders();
  const lines = orders.reduce((n, o) => n + o[1].length, 0);
  $('archCount').textContent = `${orders.length} order${orders.length === 1 ? '' : 's'} · ${lines} line${lines === 1 ? '' : 's'}${day ? ' submitted ' + fmtDate(day) : ' in the archive'} · click an order to see its lines`;
  $('archExpand').textContent = orders.length && orders.every(o => openOrders.has(o[0])) ? 'Collapse all' : 'Expand all';
  $('archBody').innerHTML = orders.length ? orders.map(([k, rows]) => {
    const open = openOrders.has(k), first = rows[0];
    const names = rows.map(r => r.item), preview = names.slice(0, 3).join(', ') + (names.length > 3 ? `, +${names.length - 3} more` : '');
    const head = `<tr class="order${open ? ' open' : ''}" data-order="${esc(k)}" title="${open ? 'Hide' : 'Show'} the lines in this order">
      <td><span class="caret">${open ? '▾' : '▸'}</span> ${fmtDate(first.dateSubmitted)} <span class="maker">${fmtTime(first.submittedAt)}</span></td>
      <td colspan="7"><b>${rows.length} line${rows.length === 1 ? '' : 's'}</b>${first.submittedBy ? ` <span class="maker">· by ${esc(first.submittedBy)}</span>` : ''} · <span class="maker">${esc(preview)}</span></td></tr>`;
    return head + (open ? rows.map(r => `<tr class="order-line">
      <td></td>
      <td class="drug"><b>${esc(r.item)}</b></td>
      <td data-l="NDC">${r.ndc ? ndcHtml(r.ndc) : '<span class="maker">any NDC</span>'}</td><td class="mfr" data-l="Manufacturer">${esc(r.mfr || '')}</td><td class="mfr" data-l="Distributor">${esc(r.dist || '')}</td><td data-l="Pkg Size">${esc(r.pkgSize || '')}</td><td data-l="Qty">${esc(r.qty)}</td><td>${dm(r.ndc10 || r.ndc, r.setid)}</td>
    </tr>`).join('') : '');
  }).join('') : '<tr><td colspan="8" class="empty">Nothing here.</td></tr>';
}
$('archBody').addEventListener('click', e => {
  if(e.target.closest('a')) return;
  const tr = e.target.closest('tr.order'); if(!tr) return;
  const k = tr.dataset.order; openOrders.has(k) ? openOrders.delete(k) : openOrders.add(k);
  renderArchive();
});
$('archExpand').onclick = () => {
  const orders = archiveOrders(), allOpen = orders.length && orders.every(o => openOrders.has(o[0]));
  orders.forEach(o => allOpen ? openOrders.delete(o[0]) : openOrders.add(o[0]));
  renderArchive();
};
$('archDate').onchange = () => { renderArchive(); loadArchiveDay($('archDate').value).catch(() => {}); };
$('archMore').onclick = () => loadArchive(true).catch(e => { if(!e.auth) alert(e.message); });
$('archAll').onclick = () => { $('archDate').value = ''; renderArchive(); };
$('archLatest').onclick = () => {
  const last = STATE.archive.reduce((m, r) => (r.dateSubmitted || '') > m ? r.dateSubmitted : m, '');
  $('archDate').value = last; renderArchive();
};


/* ---------------- layout engine: the standard for every page of the suite ----------------
   A page is a set of panels placed on a 12-column grid. Each panel's place is [column, row, width in columns, height in rows]
   (1-based; a row is 12 px; a panel is never shorter than its content, so nothing is cut off). Narrow screens (under 1280 px wide)
   ignore the layout and stack the panels in reading order (top row first, then left to right).
   A page is described once, as a PAGE object:  { id, title, panels:[[panelId, 'Title'], ...], layout:{v:2, cols:12, panels:{id:[x,y,w,h]}}, render(sample, panels) }
   Its look is arranged ONLY in the layout editor (dev/build_layout_editor.py <page>), by Neo, then the code it gives is pasted into the page's
   layout constant and is permanent: nobody can change it from the app.
   To add a page: write src/parts/<page>_panels.js with a PAGE, its panel bodies and a sample, add it to build_layout_editor.py's PAGES, add it to assemble.py. */
const LAYOUT_COLS = 12, LAYOUT_ROW = 12;   // a row unit is 12 px; a panel's height is a number of rows
function layoutOk(page, L){
  if(!L || L.v !== 2 || L.cols !== LAYOUT_COLS || !L.panels) return false;
  const seen = [];
  for(const [id] of page.panels){
    const p = L.panels[id]; if(!Array.isArray(p) || p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 1)) return false;
    const [x, y, w, h] = p; if(x + w - 1 > LAYOUT_COLS || w < 2 || h < 6 || h > 200) return false;
    if(seen.some(q => x < q[0] + q[2] && q[0] < x + w && y < q[1] + q[3] && q[1] < y + h)) return false;     // overlapping panels
    seen.push(p);
  }
  return true;
}
// the grid: panels in reading order (row, then column) so narrow screens stack them sensibly; body(id) gives a panel's inner HTML
function layoutGridHtml(page, L, body){
  L = L || (layoutOk(page, page.layout) ? page.layout : null) || { panels: Object.fromEntries(page.panels.map(([id], i) => [id, [1, i + 1, LAYOUT_COLS, 6]])) };
  const order = page.panels.slice().sort((a, b) => (L.panels[a[0]][1] - L.panels[b[0]][1]) || (L.panels[a[0]][0] - L.panels[b[0]][0]));
  const rows = Math.max(...Object.values(L.panels).map(p => p[1] + p[3] - 1));
  return `<div class="pgrid" style="--rows:${rows}">${order.map(([id, title]) => { const [x, y, w, h] = L.panels[id];
    return `<section class="pnl" data-pnl="${id}" style="--x:${x};--y:${y};--w:${w};--h:${h}"><h4 class="pt">${title}</h4><div class="pb">${body(id)}</div></section>`; }).join('')}</div>`;
}

/* ---------------- pharmacy setup page (host) and pharmacy account page (Account Owner): panels and their layout ----------------
   Built on the layout engine (layout_engine.js). PHARM_LAYOUT is set once by Neo with the layout editor and is the same for everyone. */
const PHARM_COLS = LAYOUT_COLS, PHARM_ROW = LAYOUT_ROW;
const PHARM_PANELS = [['id', 'Pharmacy'], ['contact', 'Name And Address'], ['reg', 'License And Registration'], ['svc', 'Services Provided'], ['hrs', 'Hours Of Operation'], ['own', 'Account Owner And PIC'], ['mgr', 'Who Can Manage Users'], ['act', 'Modules And Save']];
const PHARM_LAYOUT = {"v":2,"cols":12,"panels":{"id":[1,1,4,40],"own":[1,41,4,49],"contact":[5,1,4,37],"reg":[5,38,4,52],"hrs":[9,1,4,71],"mgr":[9,72,4,18],"svc":[1,90,8,26],"act":[9,90,4,26]}};
const PHARM_PAGE = { id: 'pharm', title: 'Host Pharmacy Setup Page', panels: PHARM_PANELS, layout: PHARM_LAYOUT,
  render: (sample, panels) => pharmCardHtml(sample, { logo: '', holder: 'Pat Owner (owner)', host: true, clients: [{ id: 'IL-000001', legalName: 'NorTex Holdings LLC', entityType: 'llc', ein: '12-3456789' }] }, { panels }) };
// The Account Owner's version of the same page has its own layout (Neo arranges it separately in the layout editor: page key pharm_owner).
const PHARM_OWNER_LAYOUT = {"v":2,"cols":12,"panels":{"id":[1,1,4,41],"own":[1,42,4,12],"act":[1,54,4,20],"contact":[5,1,4,42],"reg":[5,43,4,31],"hrs":[9,1,4,73],"svc":[1,74,12,9]}};
const PHARM_OWNER_PANELS = PHARM_PANELS.filter(p => p[0] !== 'mgr');      // the switches are IronLedger's alone
const PHARM_OWNER_PAGE = { id: 'pharm_owner', title: 'Pharmacy Page (Account Owner)', panels: PHARM_OWNER_PANELS, layout: PHARM_OWNER_LAYOUT,
  render: (sample, panels) => pharmCardHtml(Object.assign({}, sample, { ein: '', einMasked: '••-•••4321' }), { logo: '', holder: 'Pat Owner (owner)' }, { panels }) };
const pharmLayoutOk = L => layoutOk(PHARM_PAGE, L);
const pharmLayout = () => pharmLayoutOk(PHARM_LAYOUT) ? PHARM_LAYOUT : null;
const sw = (attrs, on, title) => `<label class="switch" title="${esc(title || '')}"><input type="checkbox" ${attrs}${on ? ' checked' : ''}><span></span></label>`;
const SF = [['name','Pharmacy name'],['address','Street address'],['phone','Phone'],['fax','Fax'],['email','Email'],['suite','Suite / unit (if any)'],['city','City'],['state','State'],['zip','ZIP code'],['timezone','Time zone']];   // Street address sits directly under Pharmacy name
const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
const stateSelect = (attrs, cur) => `<select ${attrs}><option value=""></option>${US_STATES.map(v => `<option${v === (cur || '') ? ' selected' : ''}>${v}</option>`).join('')}</select>`;
const tzSelect = (attrs, cur) => `<select ${attrs}>${Object.entries(TZ_NAMES).map(([v, l]) => `<option value="${v}"${v === (cur || 'America/Chicago') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
// license, identifiers, services and hours kept on each pharmacy (edit-only: the add-pharmacy form stays short)
const SF2 = [['ncpdp','NCPDP ID (7 digits)'],['deaExpires','DEA expires','date']];
const SVC_LABELS = {retail:'Retail dispensing', controlled:'Controlled substances (DEA)', nonsterile:'Nonsterile compounding', sterile:'Sterile compounding', hazardous:'Hazardous drug compounding',
  immunizations:'Immunizations', delivery:'Delivery', ltc:'Long-term care', specialty:'Specialty', infusion:'Home infusion'};
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
// Additional closed days beyond the weekly hours: dated days the pharmacy adds (name, date, optional every year). Yearly-observance toggles removed; observances are entered by hand (Neo, 2026-11-17).
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// Federal holidays the pharmacy is closed on: a dropdown on the Hours panel. Stored on the pharmacy (holClosed); until one is saved these defaults show.
const FED_HOL = [['newyear', "New Year's Day"], ['mlk', 'Martin Luther King Jr. Day'], ['presidents', "Presidents' Day"], ['memorial', 'Memorial Day'], ['juneteenth', 'Juneteenth'], ['july4', 'Independence Day'], ['labor', 'Labor Day'], ['columbus', 'Columbus Day'], ['veterans', 'Veterans Day'], ['thanks', 'Thanksgiving Day'], ['xmas', 'Christmas Day']];
const FED_DEFAULT = ['newyear', 'memorial', 'july4', 'labor', 'thanks', 'xmas'];
const holOf = s => Array.isArray(s && s.holClosed) ? s.holClosed : FED_DEFAULT;
const holLabel = n => n ? n + ' federal holiday' + (n === 1 ? '' : 's') + ' closed' : 'No federal holidays closed';
const holOfCard = card => [...card.querySelectorAll('[data-hol]')].filter(i => i.checked).map(i => i.dataset.hol);
const closuresOf = s => s && s.closures && Array.isArray(s.closures.days) ? { days: s.closures.days } : { days: [] };
const closeDate = x => MONTHS[+x.d.slice(5, 7) - 1] + ' ' + (+x.d.slice(8, 10)) + (x.y ? ', every year' : ', ' + x.d.slice(0, 4));
const closeRows = days => days.map((x, i) => `<div class="clrow"><span class="cld">${esc(closeDate(x))}</span><span class="cln">${esc(x.n)}</span><button type="button" class="edit" data-cldel="${i}" title="Remove this day">✕</button></div>`).join('');
const closedState = card => { const el = card.querySelector('[data-cl]'); try{ return JSON.parse(el.dataset.cl); }catch(_){ return []; } };
const closuresOfCard = card => ({ days: closedState(card) });
const hoursOf = s => Array.isArray(s.hours) && s.hours.length === 7 ? s.hours : [null,{o:'09:00',c:'18:00'},{o:'09:00',c:'18:00'},{o:'09:00',c:'18:00'},{o:'09:00',c:'18:00'},{o:'09:00',c:'18:00'},null];
const field = (s, k, l, t, lock) => `<label><span>${l}</span>${k === 'timezone' ? tzSelect(`data-sf="timezone"`, s.timezone) : k === 'state' ? stateSelect(`data-sf="state"${lock ? ' disabled data-ident="1"' : ''}`, s.state) : `<input type="${t || 'text'}" data-sf="${k}" value="${esc(s[k] || '')}"${k === 'address' ? ' class="wide"' : ''}${lock ? ' readonly data-ident="1"' : ''}>`}</label>`;
const roVal = v => `<div class="ro${v ? '' : ' empty'}">${v ? esc(v) : 'Not set'}</div>`;
const roField = (s, k, l, t) => `<label><span>${l}</span>${roVal(s[k])}</label>`;
// c.host: the card is being used by IronLedger (the host login). Everyone else sees license, identifiers, services and the Calendar switch but cannot change them.
// Identity (name, address, license, NPI, DEA, NCPDP) is set by IronLedger and locked once on file; the Account Owner keeps phone, fax, time zone, hours and the two expiration dates.
const IDENT = ['name', 'address', 'suite', 'city', 'state', 'zip', 'license', 'npi', 'dea', 'ncpdp', 'clientId', 'entityLegalName', 'entityType', 'ein'], AM_EDIT = ['phone', 'fax', 'email', 'timezone', 'licenseExpires', 'deaExpires'];
// NPI: exactly 10 digits and a valid check digit; NCPDP: exactly 7 digits. The same rules run on the server; here they show under the box as you type.
function npiProblem(v){
  if(!v) return '';
  if(!/^\d{10}$/.test(v)) return 'NPI must be exactly 10 digits.';
  const d = ('80840' + v).split('').map(Number); let sum = 0, alt = false;
  for(let i = d.length - 1; i >= 0; i--, alt = !alt){ let x = d[i]; if(alt){ x *= 2; if(x > 9) x -= 9; } sum += x; }
  return sum % 10 === 0 ? '' : 'That NPI’s check digit doesn’t match. Re-check the number.';
}
const ncpdpProblem = v => v && !/^\d{7}$/.test(v) ? 'NCPDP ID must be exactly 7 digits.' : '';
const digitField = (s, k, l, lim, lock) => `<div class="fbtn"><label><span>${l}</span><input type="text" inputmode="numeric" autocomplete="off" data-sf="${k}" data-dig="${lim}" maxlength="${lim}" value="${esc(s[k] || '')}"${lock ? ' readonly data-ident="1"' : ''}></label></div><div class="fe" data-err="${k}" hidden></div>`;
// state licenses: one row per state (state, number, expiration, resident or non-resident). The resident (else first) license is also the pharmacy's main license number.
const licRow = (l, lock, canEditExp) => `<div class="licrow" data-licrow>
    <label><span>State</span>${stateSelect(`data-lic="state"${lock ? ' disabled data-ident="1"' : ''}`, l.state)}</label>
    <label><span>License #</span><input type="text" data-lic="number" maxlength="20" value="${esc(l.number || '')}"${lock ? ' readonly data-ident="1"' : ''}></label>
    <label><span>Expires</span><input type="date" data-lic="expires" value="${esc(l.expires || '')}"${canEditExp ? '' : ' disabled'}></label>
    <label><span>Type</span><select data-lic="type"${lock ? ' disabled data-ident="1"' : ''}><option value="resident"${l.type !== 'nonresident' ? ' selected' : ''}>Resident</option><option value="nonresident"${l.type === 'nonresident' ? ' selected' : ''}>Non-resident</option></select></label>
    <button type="button" class="edit" data-licdel="1" title="Remove this license">✕</button></div>`;
const licList = (s, c) => { const lock = !c.isNew && !c.rep && !c.repView;
  return `<div class="licbox"><b class="clh">State pharmacy licenses</b><div data-liclist>${(s.licenses || []).map(l => licRow(l, lock, true)).join('') || '<div class="hint" data-licnone>None yet. Add the license for each state the pharmacy is licensed in.</div>'}</div>
    <button type="button" class="btn2 small" data-licadd="1">Add a state license</button></div>`; };
const licRo = (s, c) => `<div class="licbox"><b class="clh">State pharmacy licenses</b>${(s.licenses || []).map(l => `<div class="licrow ro"><label><span>State</span>${roVal(l.state)}</label><label><span>License #</span>${roVal(l.number)}</label><label><span>Expires</span><input type="date" data-lic-exp="${esc(l.state)}" value="${esc(l.expires || '')}"></label><label><span>Type</span>${roVal(l.type === 'nonresident' ? 'Non-resident' : 'Resident')}</label></div>`).join('') || '<div class="hint">None set yet.</div>'}</div>`;
const licsOfCard = card => [...card.querySelectorAll('[data-licrow]')].map(r => { const g = k => (r.querySelector(`[data-lic=${k}]`) || {}).value || ''; return { state: g('state'), number: g('number').trim().toUpperCase(), expires: g('expires'), type: g('type') || 'resident' }; }).filter(l => l.state || l.number);
// who owns and who is the pharmacist in charge, from the people list (the host page and the Account Owner page both pass it in as c.people)
function ownInfo(s, people){
  const P = people || [], owner = P.find(u => u.ownerStores && u.ownerStores[s.id] === true) || null;
  const pic = s.ownerIsPic === true ? owner : s.ownerIsPic === false ? (P.find(u => u.login === s.picLogin) || null) : null;
  return { owner, pic, admins: P.filter(u => u.adminStores && u.adminStores[s.id] === true) };
}
const ownLabel = u => u ? (u.name || u.login) + ' (' + u.login + ')' : '';
const cardField = (s, k, l, t, c) => IDENT.includes(k) ? (c.host ? field(s, k, l, t, !c.isNew && !!s[k] && !c.rep && !c.repView) : roField(s, k, l, t)) : (c.host || AM_EDIT.includes(k) ? field(s, k, l, t) : roField(s, k, l, t));
const LOCKED = 'Set by IronLedger. Contact your IronLedger representative to change this.';
const LOCKED_ID = 'Name, address, license and identifiers must match your license and billing, so IronLedger sets them. Phone, fax, email, time zone, hours and expiration dates are yours to keep current.';
// Licensed entity (the entity named on the license, DEA and NPI; the EIN is required) and the client (the bill-to account, IL- number).
const ENT_TYPES = [['corporation', 'Corporation'], ['llc', 'LLC'], ['sole_prop', 'Sole proprietor'], ['partnership', 'Partnership'], ['other', 'Other']];
const entTypeLabel = v => (ENT_TYPES.find(x => x[0] === v) || [0, ''])[1];
const entTypeSelect = (attrs, cur) => `<select ${attrs}><option value=""></option>${ENT_TYPES.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
const clientName = (c, id) => { const k = (c.clients || []).find(x => x.id === id); return k ? k.legalName + ' (' + id + ')' : id || ''; };
const clientSelect = (c, cur, attrs) => `<select data-sf="clientId" ${attrs || ''}><option value=""></option>${(c.clients || []).map(k => `<option value="${esc(k.id)}"${k.id === cur ? ' selected' : ''}>${esc(k.legalName)} (${esc(k.id)})</option>`).join('')}</select>`;
const entityHost = (s, c) => { const lk = !c.isNew && !!s.ein && !c.rep && !c.repView, lkn = !c.isNew && !!s.entityLegalName && !c.rep && !c.repView, lkt = !c.isNew && !!s.entityType && !c.rep && !c.repView;
  return `<div class="entity"><b class="clh">Licensed entity</b> <span class="hint">the entity named on the license, DEA and NPI</span>
    <div class="pfields entrow"><label><span title="Required">Legal name *</span><input type="text" data-sf="entityLegalName" maxlength="120" value="${esc(s.entityLegalName || '')}"${lkn ? ' readonly data-ident="1"' : ''}></label>
    <label><span title="Required">Entity type *</span>${entTypeSelect(`data-sf="entityType"${lkt ? ' disabled data-ident="1"' : ''}`, s.entityType)}</label>
    <label><span title="Required">EIN *</span><input type="text" data-sf="ein" maxlength="11" placeholder="12-3456789" value="${esc(s.ein || '')}"${lk ? ' readonly data-ident="1"' : ''}></label></div>
    ${(c.clients || []).length && !c.repView && (!s.ein || c.isNew) ? '<button type="button" class="btn2 small" data-entsame="1" title="Fills the legal name, type and EIN from the selected client">Same as client</button>' : ''}
    ${!c.isNew && !s.ein ? '<div class="lockhint warn">EIN missing: required for every pharmacy.</div>' : ''}</div>`; };
const entityRo = s => `<div class="entity"><b class="clh">Licensed entity</b><div class="pfields entrow">${roField(s, 'entityLegalName', 'Legal name')}<label><span>Entity type</span>${roVal(entTypeLabel(s.entityType))}</label><label><span>EIN</span>${roVal(s.einMasked)}</label></div></div>`;
const PHARM_BODY = {
  id: (s, c) => c.isNew
      ? `<div class="pidbox"><label class="pfields"><span>Pharmacy ID</span><input type="text" class="newid" data-newid="1" maxlength="20" autocapitalize="characters" spellcheck="false"></label>
        <div class="hint">What people type when they sign in (2–20 letters, numbers or dashes, like NTX1). It can’t be changed later. Add the logo after the pharmacy is created.</div>
        <label class="pfields"><span>Client (bill-to account, required)</span>${clientSelect(c, s.clientId || '', c.clientFixed ? 'disabled' : '')}</label></div>${entityHost(s, c)}`
      : `<div class="plogo">${c.logo ? `<img src="${esc(c.logo)}" alt="">` : '<span class="hint">No logo</span>'}
        <label class="btn2 small">Upload logo<input type="file" accept="image/png,image/jpeg,image/webp" data-logo="${esc(s.id)}" hidden></label>
        ${c.logo ? `<button class="btn2 small" data-nologo="${esc(s.id)}">Remove</button>` : ''}</div>
      <div class="pidbox"><div class="pid">Pharmacy ID: <b>${esc(s.id)}</b></div><div class="hint">(what people type when they sign in)</div>
        <div class="pid">Primary account holder: <b>${esc(c.holder || 'Account Owner')}</b></div><div class="hint">(the Account Owner)</div>
        ${c.host
          ? `<label class="pfields"><span>Client (bill-to account)</span>${clientSelect(c, s.clientId, !!s.clientId && !c.rep && !c.repView ? 'disabled data-ident="1"' : '')}</label>${s.clientId ? '' : '<div class="lockhint warn">No client yet: pick one.</div>'}`
          : `<div class="pid">Account number: <b>${s.clientId ? esc(s.clientId) : 'Not assigned yet'}</b></div><div class="hint">(generated once by IronLedger; never changes)</div>`}</div>
      ${c.host ? entityHost(s, c) : entityRo(s)}`,
  contact: (s, c) => { const cf = SF.map(([k, l]) => cardField(s, k, l, undefined, c)); return `<div class="pfields"><div class="nlcol">${cf[0]}${cf[1]}</div>${cf.slice(2).join('')}${c.host ? '' : `<div class="lockhint">${LOCKED_ID}</div>`}</div>`; },
  reg: (s, c) => {
    if(c.host){
      const lock = (k) => !c.isNew && !!s[k] && !c.rep && !c.repView;
      return `<div class="pfields">${licList(s, c)}
        <div class="fbtn"><label><span>NPI (10 digits)</span><input type="text" inputmode="numeric" autocomplete="off" data-sf="npi" data-dig="10" maxlength="10" value="${esc(s.npi || '')}"${lock('npi') ? ' readonly data-ident="1"' : ''}></label>${c.rep ? '' : '<button class="btn2 small" type="button" data-npilook="1" title="Checks the NPI against the public registry. Nothing changes until you save.">Look up</button>'}</div><div class="fe" data-err="npi" hidden></div>
        <div class="npirow" data-npires></div>
        ${digitField(s, 'ncpdp', 'NCPDP ID (7 digits)', 7, lock('ncpdp'))}
        <label><span>DEA number</span><input type="text" data-sf="dea" maxlength="9" autocomplete="off" value="${esc(s.dea || '')}"${lock('dea') ? ' readonly data-ident="1"' : ''}></label>
        ${field(s, 'deaExpires', 'DEA expires', 'date')}
        ${c.rep ? '<div class="lockhint">A rep drafts changes and a supervisor reviews them. The NPI registry lookup is done by a supervisor.</div>' : ''}</div>`;
    }
    return `<div class="pfields">${licRo(s, c)}${roField(s, 'npi', 'NPI')}${roField(s, 'ncpdp', 'NCPDP ID')}${roField(s, 'dea', 'DEA number')}${cardField(s, 'deaExpires', 'DEA expires', 'date', c)}
        <div class="lockhint">License numbers, NPI, DEA and NCPDP are set by IronLedger. Expiration dates are yours to keep current.</div></div>`;
  },
  svc: (s, c) => c.host && !c.rep
    ? `<div class="pfields"><div class="svcs">${Object.entries(SVC_LABELS).map(([k, l]) => `<label class="chk">${sw(`data-svc="${k}"`, (s.services || []).includes(k))} ${l}</label>`).join('')}</div>
          ${field(s, 'servicesOther', 'Other services').replace('<label>', '<label class="oth">')}</div>`
    : `<div class="pfields"><div class="chips">${(s.services || []).map(k => `<span class="chip">${esc(SVC_LABELS[k] || k)}</span>`).join('') || '<span class="hint">None set yet.</span>'}</div>
          ${s.servicesOther ? `<div class="pid">Other: ${esc(s.servicesOther)}</div>` : ''}<div class="lockhint">${LOCKED}</div></div>`,
  hrs: s => `<div class="pfields"><div class="hrs">${s.hours ? '' : '<div class="hint">Not set yet; these are suggestions until you save.</div>'}
          ${hoursOf(s).map((h, i) => `<div class="hrow"><span title="${DAYS[i]}">${DAYS[i].slice(0, 3)}</span><input type="time" data-ho="${i}" value="${h ? h.o : '09:00'}"><input type="time" data-hc="${i}" value="${h ? h.c : '18:00'}"><label class="chk">${sw(`data-hx="${i}"`, !h)} Closed</label></div>`).join('')}</div>
          <div class="hdrop"><b class="clh">Federal holidays closed</b><div class="hdlist">${FED_HOL.map(([k, l]) => `<label class="chk">${sw(`data-hol="${k}"`, holOf(s).includes(k))} ${l}</label>`).join('')}</div></div>
          <div class="closed" data-cl='${esc(JSON.stringify(closuresOf(s).days))}'><b class="clh">Additional closed days</b>
            <div class="cllist" data-cllist>${closeRows(closuresOf(s).days)}</div>
            <div class="cladd"><input type="date" data-cld title="Date"><input type="text" data-cln maxlength="60" placeholder="Name, e.g. Mardi Gras"><label class="chk">${sw('data-cly')} Every year</label> <button type="button" class="btn2 small" data-cladd="1">Add</button></div>
          </div></div>`,
  own: (s, c) => {
    if(c.isNew) return '<div class="pfields"><div class="hint" style="grid-column:1/-1">Name the Account Owner after the pharmacy is created.</div></div>';
    const I = ownInfo(s, c.people), asked = s.ownerIsPic === true || s.ownerIsPic === false;
    const picTxt = s.ownerIsPic === true ? 'The Account Owner' : s.ownerIsPic === false ? (I.pic ? ownLabel(I.pic) : s.picLogin || 'Not set') : 'Not recorded yet';
    const head = `<div class="pid">Account Owner: <b>${I.owner ? esc(ownLabel(I.owner)) : 'Not set'}</b></div>
      <div class="pid">Pharmacist in charge: <b>${esc(picTxt)}</b></div>
      ${I.admins.length ? `<div class="pid">Super user: <b>${esc(I.admins.map(ownLabel).join(', '))}</b></div>` : ''}`;
    if(!c.host || c.rep) return `<div class="pfields" style="display:block">${head}<div class="lockhint">${LOCKED}</div></div>`;
    const pool = (c.people || []).filter(u => !u.employeeOnly && !u.disabled), clientOwner = (c.people || []).find(u => u.ownerClients && u.ownerClients[s.clientId] === true);
    const pharmacists = (c.people || []).filter(u => !u.employeeOnly && (u.acctType === 'pharmacist' || u.acctType === 'pic') && u.stores && u.stores[s.id] === true);
    return `<div class="pfields" style="display:block">${head}
      <div class="ownbox"><b class="clh">Change the Account Owner</b>
        <label><span>Pick a login</span><select data-ownpick><option value="">—</option>${I.owner ? '<option value="@none">No Account Owner (remove)</option>' : ''}${clientOwner ? `<option value="@client">Same as the client’s Account Owner: ${esc(ownLabel(clientOwner))}</option>` : ''}${pool.map(u => `<option value="${esc(u.login)}">${esc(ownLabel(u))}</option>`).join('')}<option value="@new">New login…</option></select></label>
        <div data-ownnew hidden class="pfields"><label><span>Full name</span><input type="text" data-on="name" maxlength="120"></label><label><span>Login ID</span><input type="text" data-on="login" maxlength="32" autocapitalize="none" spellcheck="false"></label>
          <label><span>Mobile number</span><input type="tel" data-on="phone" maxlength="20"></label><label><span>RPh license # (if a pharmacist)</span><input type="text" data-on="license" maxlength="20"></label>
          <label class="chk" style="grid-column:1/-1"><input type="checkbox" data-on="consent"> They signed the SMS consent form for this mobile number.</label></div>
        ${I.owner ? '<label><span>Reason for the change (required)</span><input type="text" data-ownreason maxlength="300"></label>' : ''}
        <button type="button" class="btn2 small" data-ownsave="${esc(s.id)}">Save Account Owner</button></div>
      <div class="ownbox"><b class="clh">Is the Account Owner the pharmacist in charge?</b>
        <label class="chk"><input type="radio" name="pic-${esc(s.id)}" data-picyes value="yes"${s.ownerIsPic === true ? ' checked' : ''}> Yes. They get the pharmacist functions: Rx Intake, validations, EM logs.</label>
        <label class="chk"><input type="radio" name="pic-${esc(s.id)}" data-picyes value="no"${s.ownerIsPic === false ? ' checked' : ''}> No. A licensed pharmacist is the PIC.</label>
        <label data-picwho${s.ownerIsPic === false ? '' : ' hidden'}><span>Pharmacist in charge</span><select data-picpick><option value="">—</option>${pharmacists.map(u => `<option value="${esc(u.login)}"${u.login === s.picLogin ? ' selected' : ''}>${esc(ownLabel(u))}${u.license ? '' : ' (no RPh license #)'}</option>`).join('')}</select></label>
        ${asked ? '<label><span>Reason for the change (required)</span><input type="text" data-picreason maxlength="300"></label>' : ''}
        <div class="hint">The PIC must be a licensed pharmacist with an RPh license number on their login. Only IronLedger records or changes this; each change is kept in the history.</div>
        <button type="button" class="btn2 small" data-picsave="${esc(s.id)}">Save</button></div></div>`;
  },
  mgr: (s, c) => c.isNew ? '<div class="pfields" style="display:block"><div class="hint">Set after the pharmacy is created.</div></div>'
    : `<div class="pfields" style="display:block"><div class="hint" style="margin-bottom:6px">May add, change and remove people at this pharmacy. Never billing, the client page or ownership.</div>
      <label class="chk">${sw('data-mgr="mgrOwner"', s.mgrOwner !== false)} Account Owner</label>
      <label class="chk">${sw('data-mgr="mgrPic"', s.mgrPic !== false)} Pharmacist-in-Charge super user</label>
      <label class="chk">${sw('data-mgr="mgrClient"', s.mgrClient === true)} Client Account Owner</label></div>`,
  act: (s, c) => `<div class="pfields"><div class="calsw">${c.host && !c.rep
        ? `<label class="chk">${sw(`data-sfcal="1"`, s.calendar, 'Calendar tab for this pharmacy')} Calendar</label> <span class="hint" title="People also need the Calendar privilege">(needs privilege)</span>`
        : `Calendar: <b>${s.calendar ? 'On' : 'Off'}</b>`}</div>
        <div class="calsw">${c.host && !c.rep
        ? `<label class="chk">${sw(`data-sfdocs="1"`, s.documents, 'Documents tab for this pharmacy')} Documents</label> <span class="hint" title="People also need the Documents privilege">(needs privilege)</span>`
        : `Documents: <b>${s.documents ? 'On' : 'Off'}</b>`}</div>
        <div class="calsw">${c.host && !c.rep
        ? `<label class="chk">${sw(`data-sfreo="1"`, s.reorder !== false, 'Reorder List tab for this pharmacy')} Reorder List</label>`
        : `Reorder List: <b>${s.reorder !== false ? 'On' : 'Off'}</b>`}</div>
        <div class="calsw">${c.host && !c.rep
        ? `<label class="chk">${sw(`data-sfrx="1"`, s.rx !== false, 'Rx Intake tab for this pharmacy')} Rx Intake</label> <span class="hint">(pharmacists only)</span>`
        : `Rx Intake: <b>${s.rx !== false ? 'On' : 'Off'}</b>`}</div>
        ${c.host ? '' : `<div class="lockhint">${LOCKED}</div>`}
        <div style="margin-top:10px;">${c.rep ? `<label class="reason"><span>Why (required, the supervisor reads this)</span><input type="text" data-draftnote maxlength="300"></label> <button class="btn small" data-draftstore="${esc(s.id)}">Submit for review</button>`
          : c.isNew ? '<button class="btn small" data-createstore="1">Create pharmacy</button>' : `<button class="btn small" data-savestore="${esc(s.id)}">Save details</button>`}</div>
        ${c.host && !c.isNew && !c.rep ? `<div class="identbar"><button class="btn2 small" data-unlockident="1" title="Name, address, license and identifiers are locked once on file. A reason is required and every change is kept in the history.">Unlock fields</button>
          <button class="btn2 small" data-hist="${esc(s.id)}">Change history</button>
          <label class="reason" hidden><span>Reason for the change</span><input type="text" data-reason maxlength="300"></label><div data-histout></div></div>` : ''}</div>`
};
// the whole card, built by the layout engine
function pharmCardHtml(s, c, L){ return layoutGridHtml(c.host ? PHARM_PAGE : PHARM_OWNER_PAGE, L, id => PHARM_BODY[id](s, c)); }

// ---------------- behaviour shared by the Account Owner page and the host page ----------------
// o = { base: '/owner' | '/host', stores: () => [store, …], say: text => …, after: async () => … }
const normNm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function showFieldErr(card, k, msg){ const el = card.querySelector(`[data-err=${k}]`); if(!el) return; el.textContent = msg || ''; el.hidden = !msg; const i = card.querySelector(`[data-sf=${k}]`); if(i) i.classList.toggle('bad', !!msg); }
function pharmCardEvents(root, o){
  root.addEventListener('input', e => {
    const i = e.target.closest('[data-dig]'); if(!i) return;
    const v = i.value.replace(/\D/g, '').slice(0, +i.dataset.dig); if(v !== i.value) i.value = v;
    const k = i.dataset.sf, msg = k === 'npi' ? npiProblem(v) : k === 'ncpdp' ? ncpdpProblem(v) : '';
    showFieldErr(i.closest('.pcard'), k, v && v.length < +i.dataset.dig && !i.dataset.touched ? '' : msg);
  });
  root.addEventListener('blur', e => { const i = e.target.closest && e.target.closest('[data-dig]'); if(!i) return; i.dataset.touched = '1';
    const v = i.value, k = i.dataset.sf; showFieldErr(i.closest('.pcard'), k, k === 'npi' ? npiProblem(v) : ncpdpProblem(v)); }, true);
  root.addEventListener('change', e => {
    if(e.target.closest('[data-lic]')){ const c = e.target.closest('.pcard'); if(c) c.dataset.licTouched = '1'; }
    if(e.target.closest('[data-lic-exp]')){ const c = e.target.closest('.pcard'); if(c) c.dataset.licTouched = '1'; }
    const pk = e.target.closest('[data-ownpick]'); if(pk) pk.closest('.pcard').querySelector('[data-ownnew]').hidden = pk.value !== '@new';
    const py = e.target.closest('[data-picyes]'); if(py) py.closest('.pcard').querySelector('[data-picwho]').hidden = py.value !== 'no'; if(e.target.closest('[data-ho],[data-hc],[data-hx]')){ const c = e.target.closest('.pcard'); if(c) c.dataset.hrTouched = '1'; }
    if(e.target.closest('[data-hol]')){ const c = e.target.closest('.pcard'); if(c) c.dataset.hcTouched = '1'; } });
  root.addEventListener('click', async e => {
    const la = e.target.closest('[data-licadd]'), ld = e.target.closest('[data-licdel]'), osv = e.target.closest('[data-ownsave]'), psv = e.target.closest('[data-picsave]');
    if(la || ld){
      const card = e.target.closest('.pcard'), list = card.querySelector('[data-liclist]');
      if(ld){
        const row = ld.closest('[data-licrow]');
        if(row.querySelector('[data-ident]') && !card.dataset.unlocked){ alert('Licenses on file are locked. Press “Unlock fields” first; a reason is required.'); return; }
        row.remove(); card.dataset.licTouched = '1'; if(!list.querySelector('[data-licrow]')) list.innerHTML = '<div class="hint" data-licnone>None yet. Add the license for each state the pharmacy is licensed in.</div>'; return;
      }
      const none = list.querySelector('[data-licnone]'); if(none) none.remove();
      list.insertAdjacentHTML('beforeend', licRow({ state: '', number: '', expires: '', type: list.querySelector('[data-licrow]') ? 'nonresident' : 'resident' }, false, true)); card.dataset.licTouched = '1'; return;
    }
    if(osv){
      const card = osv.closest('.pcard'), pick = card.querySelector('[data-ownpick]').value, g = k => ((card.querySelector(`[data-on=${k}]`) || {}).value || '').trim();
      if(!pick){ alert('Pick who will be the Account Owner.'); return; }
      const body = { reason: (card.querySelector('[data-ownreason]') || {}).value || '' };
      if(pick === '@none') body.remove = true;
      else if(pick === '@client') body.sameAsClient = true;
      else if(pick === '@new'){
        if(!g('name') || !g('login') || !g('phone')){ alert('Name, Login ID and mobile number are all needed.'); return; }
        if(!card.querySelector('[data-on=consent]').checked){ alert('Have them sign the SMS consent form first, then tick the box.'); return; }
        body.owner = { create: { name: g('name'), login: g('login').toLowerCase(), phone: g('phone'), license: g('license'), smsConsent: true } };
      } else body.owner = { login: pick };
      busy(osv, true);
      try{ const r = await api('POST', o.base + '/stores/' + encodeURIComponent(osv.dataset.ownsave) + '/owner', body);
        if(o.pass && r.tempPassword) o.pass(`<b>${esc(r.owner.name || r.owner.login)} is the Account Owner.</b> Give them:<br>Pharmacy ID: <b class="mono">${esc(osv.dataset.ownsave)}</b><br>Login ID: <b class="mono">${esc(r.owner.login)}</b><br>Temporary password: <b class="mono">${esc(r.tempPassword)}</b>`);
        o.say('Account Owner saved.'); await o.after(); }
      catch(err){ if(!err.auth) alert(err.message); } finally{ busy(osv, false); }
      return;
    }
    if(psv){
      const card = psv.closest('.pcard'), yes = card.querySelector('[data-picyes]:checked');
      if(!yes){ alert('Answer yes or no.'); return; }
      const body = { ownerIsPic: yes.value === 'yes', picLogin: yes.value === 'no' ? card.querySelector('[data-picpick]').value : '', reason: (card.querySelector('[data-picreason]') || {}).value || '' };
      if(yes.value === 'no' && !body.picLogin){ alert('Pick the pharmacist in charge.'); return; }
      busy(psv, true);
      try{ await api('POST', o.base + '/stores/' + encodeURIComponent(psv.dataset.picsave) + '/pic', body); o.say('Saved.'); await o.after(); }
      catch(err){ if(!err.auth) alert(err.message); } finally{ busy(psv, false); }
      return;
    }
    const lk = e.target.closest('[data-npilook]'), us = e.target.closest('[data-npiuse]');
    const dsub = e.target.closest('[data-draftstore]');
    const cla = e.target.closest('[data-cladd]'), cld = e.target.closest('[data-cldel]');
    if(cla || cld){
      const card = e.target.closest('.pcard'), box = card.querySelector('[data-cl]'), days = closedState(card);
      if(cld) days.splice(+cld.dataset.cldel, 1);
      else{
        const d = card.querySelector('[data-cld]').value, n = card.querySelector('[data-cln]').value.trim(), y = card.querySelector('[data-cly]').checked;
        if(!d){ alert('Pick the date.'); return; } if(!n){ alert('Give the day a name, for example “Day after Christmas”.'); return; }
        if(days.some(x => x.d === d || (y && x.y && x.d.slice(5) === d.slice(5)))){ alert('That day is already listed.'); return; }
        days.push({ d, n, y }); days.sort((a, b) => a.d.localeCompare(b.d));
        card.querySelector('[data-cld]').value = ''; card.querySelector('[data-cln]').value = ''; card.querySelector('[data-cly]').checked = false;
      }
      box.dataset.cl = JSON.stringify(days); card.querySelector('[data-cllist]').innerHTML = closeRows(days); card.dataset.clTouched = '1';
      return;
    }
    if(dsub){
      const card = dsub.closest('.pcard'), cur = o.stores().find(x => x.id === dsub.dataset.draftstore) || {}, fields = {};
      card.querySelectorAll('[data-sf]').forEach(i => { if(i.value.trim() !== String(cur[i.dataset.sf] || '')) fields[i.dataset.sf] = i.value.trim(); });
      if(card.dataset.hrTouched) fields.hours = DAYS.map((_, i) => card.querySelector(`[data-hx="${i}"]`).checked ? null : {o: card.querySelector(`[data-ho="${i}"]`).value, c: card.querySelector(`[data-hc="${i}"]`).value});
      if(card.dataset.clTouched) fields.closures = closuresOfCard(card);
      if(card.dataset.hcTouched) fields.holClosed = holOfCard(card);
      if(card.dataset.licTouched) fields.licenses = licsOfCard(card);
      if(!Object.keys(fields).length){ alert('Change something first.'); return; }
      busy(dsub, true);
      try{ await api('POST', o.base + '/stores/' + encodeURIComponent(dsub.dataset.draftstore) + '/drafts', {fields, note: card.querySelector('[data-draftnote]').value.trim()}); o.say('Submitted for review.'); await o.after(); }
      catch(err){ if(!err.auth) alert(err.message); } finally{ busy(dsub, false); }
      return;
    }
    const sv = e.target.closest('[data-savestore],[data-createstore]'), ul = e.target.closest('[data-unlockident]'), hs = e.target.closest('[data-hist]');
    const card = e.target.closest('.pcard'); if(!card) return;
    const val = k => { const i = card.querySelector(`[data-sf=${k}]`); return i ? i.value.trim() : ''; };
    const es = e.target.closest('[data-entsame]');
    if(es){
      const k = (o.clients ? o.clients() : []).find(x => x.id === (card.querySelector('[data-sf=clientId]') || {}).value);
      if(!k){ alert('Pick the client first.'); return; }
      const set = (n, v) => { const i = card.querySelector(`[data-sf=${n}]`); if(i && !i.readOnly && !i.disabled) i.value = v || ''; };
      set('entityLegalName', k.legalName); set('entityType', k.entityType); set('ein', k.ein); return;
    }
    if(ul){
      if(!confirm('The name, address, license and identifiers must match the license and billing. Unlock them to make a change? You will be asked for a reason.')) return;
      card.querySelectorAll('[data-ident]').forEach(i => { i.removeAttribute('readonly'); i.removeAttribute('disabled'); });
      card.dataset.unlocked = '1'; const r = card.querySelector('.reason'); r.hidden = false; r.querySelector('input').focus(); return;
    }
    if(hs){
      const out = card.querySelector('[data-histout]'); out.innerHTML = '<div class="hint">Loading…</div>';
      try{
        const r = await api('GET', o.base + '/stores/' + encodeURIComponent(hs.dataset.hist) + '/history');
        out.innerHTML = r.history.length ? r.history.map(h => `<div class="npibox"><b>${esc((h.at || '').slice(0, 16).replace('T', ' '))} UTC</b> · ${esc(h.by)}${h.reason ? ' · “' + esc(h.reason) + '”' : ''}<div class="hint">${Object.entries(h.changes).map(([k, v]) => esc(k) + ': ' + esc(Array.isArray(v[0]) ? v[0].join(', ') : v[0] == null ? '(blank)' : String(v[0])) + ' → ' + esc(Array.isArray(v[1]) ? v[1].join(', ') : String(v[1]))).join('<br>')}</div></div>`).join('') : '<div class="hint">No changes recorded yet.</div>';
      }catch(err){ if(!err.auth) out.innerHTML = `<div class="npibox bad">${esc(err.message)}</div>`; }
      return;
    }
    if(lk){
      const out = card.querySelector('[data-npires]'), npi = val('npi');
      if(!/^\d{10}$/.test(npi)){ out.innerHTML = '<div class="npibox bad">Type the 10-digit NPI first.</div>'; return; }
      out.innerHTML = '<div class="npibox hint">Looking up…</div>'; lk.disabled = true;
      try{
        const r = await api('GET', o.base + '/npi/' + encodeURIComponent(npi)); card._npi = r;
        if(!r.found){ out.innerHTML = '<div class="npibox bad">No provider with that NPI is in the NPI Registry. Re-check the number.</div>'; return; }
        const a = r.address, flags = [];
        if(r.type !== 'organization') flags.push('This is an individual NPI. A pharmacy normally has an organization NPI.');
        if(!r.active) flags.push('The registry shows this NPI as not active.');
        if(r.type === 'organization' && !r.pharmacyTaxonomy) flags.push('No pharmacy taxonomy is listed for it.');
        const cur = val('name'); if(cur && r.name && normNm(cur) !== normNm(r.name)) flags.push('The registry name differs from the pharmacy name above.');
        const lic = r.taxonomies.filter(t => t.license).map(t => `${esc(t.license)}${t.state ? ' (' + esc(t.state) + ')' : ''}`).join(', ');
        out.innerHTML = `<div class="npibox"><b>${esc(r.name || '(no name)')}</b> <span class="hint">${r.type === 'organization' ? 'Organization' : 'Individual'} · ${r.active ? 'Active' : 'Not active'}${r.lastUpdated ? ' · registry updated ' + esc(r.lastUpdated) : ''}</span>
          <div>${esc([a.address, a.suite].filter(Boolean).join(', '))}${a.address ? ', ' : ''}${esc([a.city, a.state].filter(Boolean).join(', '))} ${esc(a.zip)}${a.phone ? ' · ' + esc(a.phone) : ''}${a.fax ? ' · fax ' + esc(a.fax) : ''}</div>
          ${r.taxonomies.length ? `<div class="hint">${r.taxonomies.map(t => esc(t.desc || t.code)).join('; ')}${lic ? ' · license on file with registry: ' + lic : ''}</div>` : ''}
          ${flags.map(f => `<div class="npiflag">⚠ ${esc(f)}</div>`).join('')}
          <button class="btn2 small" data-npiuse="1" title="Fills name, address, phone and fax. The license number is never filled; type it from the state license.">Use these details</button></div>`;
      }catch(err){ if(!err.auth) out.innerHTML = `<div class="npibox bad">${esc(err.message)}</div>`; }
      finally{ lk.disabled = false; }
      return;
    }
    if(us){
      const r = card._npi; if(!r || !r.found) return;
      if(card.querySelector('[data-ident]') && !card.dataset.unlocked){ alert('The name and address are locked. Press “Unlock fields” first.'); return; }
      const set = (k, v) => { const i = card.querySelector(`[data-sf=${k}]`); if(i && v) i.value = v; };
      set('name', r.name); set('address', r.address.address); set('suite', r.address.suite); set('city', r.address.city); set('state', r.address.state); set('zip', r.address.zip); set('phone', r.address.phone); set('fax', r.address.fax);
      o.say('Filled in from the registry. Press ' + (card.dataset.isNew ? 'Create pharmacy' : 'Save details') + ' to keep it.'); return;
    }
    if(sv){
      const isNew = !!sv.dataset.createstore, id = isNew ? (card.querySelector('[data-newid]').value || '').trim().toUpperCase() : sv.dataset.savestore;
      const body = {}; card.querySelectorAll('[data-sf]').forEach(i => body[i.dataset.sf] = i.value.trim());
      const cal = card.querySelector('[data-sfcal]'); if(cal) body.calendar = cal.checked;
      const dcs = card.querySelector('[data-sfdocs]'); if(dcs) body.documents = dcs.checked;
      const reo = card.querySelector('[data-sfreo]'); if(reo) body.reorder = reo.checked;
      const rxs = card.querySelector('[data-sfrx]'); if(rxs) body.rx = rxs.checked;
      if(card.querySelector('[data-liclist]')) body.licenses = licsOfCard(card);
      else if(card.querySelector('[data-lic-exp]')){ const cur0 = o.stores().find(x => x.id === id) || {}; body.licenses = (cur0.licenses || []).map(l => ({ ...l, expires: (card.querySelector(`[data-lic-exp="${l.state}"]`) || {}).value || '' })); }
      for(const [k, fn] of [['npi', npiProblem], ['ncpdp', ncpdpProblem]]){ const m = fn(body[k] || ''); if(m){ showFieldErr(card, k, m); const i = card.querySelector(`[data-sf=${k}]`); if(i) i.focus(); return; } }
      if(card.querySelector('[data-svc]')) body.services = [...card.querySelectorAll('[data-svc]')].filter(i => i.checked).map(i => i.dataset.svc);
      const cur = o.stores().find(x => x.id === id);
      if(card.dataset.hrTouched || (cur && cur.hours)) body.hours = DAYS.map((_, i) => card.querySelector(`[data-hx="${i}"]`).checked ? null : {o: card.querySelector(`[data-ho="${i}"]`).value, c: card.querySelector(`[data-hc="${i}"]`).value});
      if(card.dataset.clTouched) body.closures = closuresOfCard(card);
      if(card.dataset.hcTouched) body.holClosed = holOfCard(card);
      const rs = card.querySelector('[data-reason]'); if(rs && rs.value.trim()) body.changeReason = rs.value.trim();
      if(isNew){ if(!id || !body.name){ alert('Pharmacy ID and name are needed.'); return; } body.id = id; }
      busy(sv, true);
      try{ await api('POST', o.base + '/stores' + (isNew ? '' : '/' + encodeURIComponent(id)), body); o.say(isNew ? 'Pharmacy created: ' + id : 'Pharmacy details saved.'); await o.after(isNew); }
      catch(err){ if(!err.auth) alert(err.message); } finally{ busy(sv, false); }
    }
  });
}

/* ---------------- client account page (host): who the client is, for account creation and billing ----------------
   Built on the layout engine (layout_engine.js) like every page of the suite. CLIENT_LAYOUT is set by Neo with the layout editor
   (dev/build_layout_editor.py client) and is the same for everyone. Uses helpers from pharm_panels.js (stateSelect, entTypeSelect, ENT_TYPES, esc).
   A client is the bill-to account: the legal entity that pays, its EIN, addresses and contacts, and the generated IL- account number (the client's key;
   it never changes). Pharmacies belong to a client; each pharmacy also carries its own licensed entity (that EIN can differ). */
const CLIENT_PANELS = [['ent', 'Client And Legal Entity'], ['addr', 'Addresses'], ['contact', 'Phone, Fax And Contacts'], ['own', 'Account Owner'], ['act', 'Save']];
const CLIENT_LAYOUT = {"v":2,"cols":12,"panels":{"ent":[1,1,6,18],"addr":[1,19,6,23],"act":[1,42,6,14],"own":[7,1,6,27],"contact":[7,28,6,28]}};
const CLIENT_SAMPLE = {id:'IL-000001', legalName:'NorTex Holdings LLC', dba:'NorTex Pharmacy', entityType:'llc', ein:'12-3456789', address:'100 Main St', suite:'Suite 5', city:'Haslet', state:'TX', zip:'76052', billingSame:false, bAddress:'PO Box 12', bCity:'Haslet', bState:'TX', bZip:'76052', phone:'817-555-0100', fax:'817-555-0101',
  contacts:[{role:'relations', name:'Pat Owner', title:'Owner', email:'pat@example.com', phone:'817-555-0102'},{role:'billing', name:'Sam Books', title:'Bookkeeper', email:'sam@example.com', phone:''}], pharmacies:['NTX1','NTX2']};
const CLIENT_PAGE = { id: 'client', title: 'Host Account (Client) Setup Page', panels: CLIENT_PANELS, layout: CLIENT_LAYOUT,
  render: (_unused, panels) => clientCardHtml(CLIENT_SAMPLE, { host: true, people: [], stores: [{ id: 'NTX1', name: 'NorTex Pharmacy - Haslet', city: 'Haslet', state: 'TX' }, { id: 'NTX2', name: 'NorTex Pharmacy - Keller', city: 'Keller', state: 'TX' }] }, { panels }) };
const money = c => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const CONTACT_ROLE_LABELS = { relations: 'Client relations', billing: 'Billing', other: 'Other' };
const clientLocked = (k, cl, c) => !c.isNew && !!cl[k];                 // identity values already on file are locked until the host unlocks them with a reason
const cfIn = (cl, k, l, c, o) => { o = o || {}; const lk = o.ident && clientLocked(k, cl, c);
  return `<label${o.w2 ? ' class="w2"' : ''}><span>${l}</span><input type="${o.type || 'text'}" data-cf="${k}" value="${esc(cl[k] || '')}"${o.max ? ` maxlength="${o.max}"` : ''}${o.ph ? ` placeholder="${o.ph}"` : ''}${lk ? ' readonly data-ident="1"' : ''}></label>`; };
const contactRows = list => list.map((x, i) => `<div class="clrow"><span class="cld">${esc(CONTACT_ROLE_LABELS[x.role] || x.role)}</span><span class="cln"><b>${esc(x.name)}</b>${x.title ? ', ' + esc(x.title) : ''}${x.email ? ' · ' + esc(x.email) : ''}${x.phone ? ' · ' + esc(x.phone) : ''}</span><button type="button" class="edit" data-ctdel="${i}" title="Remove this contact">✕</button></div>`).join('');
const contactsOfCard = card => { const el = card.querySelector('[data-ctcs]'); try{ return JSON.parse(el.dataset.ctcs); }catch(_){ return []; } };
const CLIENT_BODY = {
  ent: (cl, c) => `<div class="pfields">${c.isNew ? '<div class="hint">The account number (IL-…) is generated when you create the client.</div>' : `<div class="pid">Account number: <b>${esc(cl.id)}</b> <span class="hint">(never changes)</span></div>`}
      <label><span>Entity type (required)</span>${entTypeSelect(`data-cf="entityType"${clientLocked('entityType', cl, c) ? ' disabled data-ident="1"' : ''}`, cl.entityType)}</label>
      ${cfIn(cl, 'legalName', 'Legal name of the entity (required)', c, { ident: true, max: 160, w2: true })}
      ${cfIn(cl, 'dba', 'DBA (doing business as), if any', c, { max: 160, w2: true })}
      ${cfIn(cl, 'ein', 'EIN (required)', c, { ident: true, max: 11, ph: '12-3456789' })}
      ${!c.isNew && !c.ro ? `<div class="identbar"><button type="button" class="btn2 small" data-unlockclient="1" title="Legal name, entity type and EIN are locked once on file. A reason is required and every change is kept in the history.">Unlock fields</button>
        <label class="reason" hidden><span>Reason for the change</span><input type="text" data-reason maxlength="300"></label></div>` : ''}</div>`,
  addr: (cl, c) => `<div class="pfields"><b class="clh">Business address</b>
      ${cfIn(cl, 'address', 'Street address', c, { max: 200 })}${cfIn(cl, 'suite', 'Suite / unit (if any)', c, { max: 40 })}${cfIn(cl, 'city', 'City', c, { max: 80 })}
      <label><span>State</span>${stateSelect('data-cf="state"', cl.state)}</label>${cfIn(cl, 'zip', 'ZIP code', c, { max: 10 })}
      <label class="chk">${sw('data-cf="billingSame"', cl.billingSame !== false)} Billing address is the same</label>
      <div data-billbox${cl.billingSame !== false ? ' hidden' : ''}><b class="clh">Billing address</b>
      ${cfIn(cl, 'bAddress', 'Street address', c, { max: 200 })}${cfIn(cl, 'bSuite', 'Suite / unit (if any)', c, { max: 40 })}${cfIn(cl, 'bCity', 'City', c, { max: 80 })}
      <label><span>State</span>${stateSelect('data-cf="bState"', cl.bState)}</label>${cfIn(cl, 'bZip', 'ZIP code', c, { max: 10 })}</div></div>`,
  contact: (cl, c) => `<div class="pfields">${cfIn(cl, 'phone', 'Telephone', c, { type: 'tel', max: 30 })}${cfIn(cl, 'fax', 'Fax', c, { type: 'tel', max: 30 })}
      <b class="clh">Contacts</b><div class="hint">They don’t need a login.</div>
      <div class="cllist" data-ctlist>${contactRows(cl.contacts || [])}</div>
      <div class="cladd ctadd"><select data-ctrole>${Object.entries(CONTACT_ROLE_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <input type="text" data-ctname maxlength="80" placeholder="Name"><input type="text" data-cttitle maxlength="60" placeholder="Title">
        <input type="email" data-ctemail maxlength="120" placeholder="Email"><input type="tel" data-ctphone maxlength="30" placeholder="Phone">
        <button type="button" class="btn2 small" data-ctadd="1">Add</button></div>
      <span data-ctcs='${esc(JSON.stringify(cl.contacts || []))}' hidden></span></div>`,
  own: (cl, c) => {
    const owner = (c.people || []).find(u => u.ownerClients && u.ownerClients[cl.id] === true);
    const pool = (c.people || []).filter(u => !u.employeeOnly && !u.disabled);
    const head = c.isNew ? '' : `<div class="pid">Client Account Owner: <b>${owner ? esc(ownLabel(owner)) : 'Not set'}</b></div><div class="hint">Sees this page and each pharmacy’s billing, read only.</div>`;
    if(!c.host || c.ro) return `<div class="pfields" style="display:block">${head}${c.host ? '' : '<div class="lockhint">Set by IronLedger.</div>'}</div>`;
    return `<div class="pfields" style="display:block">${head}<div class="ownbox">${c.isNew ? '<b class="clh">Account Owner (optional now; can be set later)</b>' : '<b class="clh">Change the client’s Account Owner</b>'}
      <label><span>Pick a login</span><select data-cownpick><option value="">—</option>${pool.map(u => `<option value="${esc(u.login)}">${esc(ownLabel(u))}</option>`).join('')}<option value="@new">New login…</option></select></label>
      <div data-cownnew hidden class="pfields"><label><span>Full name</span><input type="text" data-cn="name" maxlength="120"></label><label><span>Login ID</span><input type="text" data-cn="login" maxlength="32" autocapitalize="none" spellcheck="false"></label>
        <label><span>Mobile number</span><input type="tel" data-cn="phone" maxlength="20"></label><label><span>RPh license # (if a pharmacist)</span><input type="text" data-cn="license" maxlength="20"></label>
        <label class="chk" style="grid-column:1/-1"><input type="checkbox" data-cn="consent"> They signed the SMS consent form for this mobile number.</label></div>
      ${!c.isNew && owner ? '<label><span>Reason for the change (required)</span><input type="text" data-cownreason maxlength="300"></label>' : ''}
      ${c.isNew ? '' : `<button type="button" class="btn2 small" data-cownsave="${esc(cl.id)}">Save Account Owner</button>`}</div></div>`;
  },
  act: (cl, c) => `<div class="pfields" style="display:block">
      <div style="margin-top:10px">${c.ro ? '' : c.isNew ? '<button type="button" class="btn small" data-createclient="1">Create client</button>' : `<button type="button" class="btn small" data-saveclient="${esc(cl.id)}">Save client</button>`}</div>
      ${c.isNew ? '' : `<div style="margin-top:8px"><button type="button" class="btn2 small" data-chist="${esc(cl.id)}">Change history</button><div data-histout></div></div>`}</div>`
};
// read-only view (the client's Account Owner): everything shown, nothing editable
function clientFreeze(root){ root.querySelectorAll('input,select,textarea,button[data-ctdel]').forEach(e => { e.disabled = true; }); root.querySelectorAll('.ctadd,[data-ctdel],.identbar,[data-pnl=act]').forEach(e => { e.hidden = true; e.style.display = 'none'; }); }
function clientCardHtml(cl, c, L){ return layoutGridHtml(CLIENT_PAGE, L, id => CLIENT_BODY[id](cl, c)); }

// ---------------- behaviour for the host page ----------------
// o = { stores: () => [pharmacy…], say: text => …, after: async isNew => … }
function clientCardEvents(root, o){
  root.addEventListener('change', e => {
    const p = e.target.closest('[data-cownpick]'); if(p){ p.closest('.pcard').querySelector('[data-cownnew]').hidden = p.value !== '@new'; return; }
    const b = e.target.closest('[data-cf=billingSame]'); if(!b) return;
    e.target.closest('.pcard').querySelector('[data-billbox]').hidden = b.checked;
  });
  const ownerSpec = card => {
    const pick = (card.querySelector('[data-cownpick]') || {}).value || '', g = k => ((card.querySelector(`[data-cn=${k}]`) || {}).value || '').trim();
    if(!pick) return null;
    if(pick !== '@new') return { login: pick };
    if(!g('name') || !g('login') || !g('phone')) throw new Error('Name, Login ID and mobile number are all needed for the new login.');
    if(!card.querySelector('[data-cn=consent]').checked) throw new Error('Have them sign the SMS consent form first, then tick the box.');
    return { create: { name: g('name'), login: g('login').toLowerCase(), phone: g('phone'), license: g('license'), smsConsent: true } };
  };
  const passHtml = (r, what) => `<b>${esc(r.owner.name || r.owner.login)} is the ${what}.</b> Give them:<br>Login ID: <b class="mono">${esc(r.owner.login)}</b><br>Temporary password: <b class="mono">${esc(r.tempPassword)}</b>`;
  root.addEventListener('click', async e => {
    const card = e.target.closest('.pcard'); if(!card) return;
    const cs = e.target.closest('[data-cownsave]');
    if(cs){
      let spec; try{ spec = ownerSpec(card); }catch(err){ alert(err.message); return; }
      if(!spec){ alert('Pick who will be the client’s Account Owner.'); return; }
      busy(cs, true);
      try{ const r = await api('POST', '/host/clients/' + encodeURIComponent(cs.dataset.cownsave) + '/owner', { owner: spec, reason: (card.querySelector('[data-cownreason]') || {}).value || '' });
        if(o.pass && r.tempPassword) o.pass(passHtml(r, 'client’s Account Owner')); o.say('Account Owner saved.'); await o.after(false); }
      catch(err){ if(!err.auth) alert(err.message); } finally{ busy(cs, false); }
      return;
    }
    const add = e.target.closest('[data-ctadd]'), del = e.target.closest('[data-ctdel]'), ul = e.target.closest('[data-unlockclient]'), hs = e.target.closest('[data-chist]'), sv = e.target.closest('[data-saveclient],[data-createclient]');
    if(add || del){
      const list = contactsOfCard(card), q = s => card.querySelector(s);
      if(del) list.splice(+del.dataset.ctdel, 1);
      else{
        const name = q('[data-ctname]').value.trim(); if(!name){ alert('Give the contact a name.'); return; }
        list.push({ role: q('[data-ctrole]').value, name, title: q('[data-cttitle]').value.trim(), email: q('[data-ctemail]').value.trim(), phone: q('[data-ctphone]').value.trim() });
        ['name', 'title', 'email', 'phone'].forEach(k => q(`[data-ct${k}]`).value = '');
      }
      q('[data-ctcs]').dataset.ctcs = JSON.stringify(list); q('[data-ctlist]').innerHTML = contactRows(list); return;
    }
    if(ul){
      if(!confirm('Billing follows the client’s identity. Unlock the legal name, entity type and EIN to make a change? You will be asked for a reason.')) return;
      card.querySelectorAll('[data-ident]').forEach(i => { i.removeAttribute('readonly'); i.removeAttribute('disabled'); });
      const r = card.querySelector('.reason'); r.hidden = false; r.querySelector('input').focus(); return;
    }
    if(hs){
      const out = card.querySelector('[data-histout]'); out.innerHTML = '<div class="hint">Loading…</div>';
      try{
        const r = await api('GET', '/host/clients/' + encodeURIComponent(hs.dataset.chist) + '/history');
        out.innerHTML = r.history.length ? r.history.map(h => `<div class="npibox"><b>${esc((h.at || '').slice(0, 16).replace('T', ' '))} UTC</b> · ${esc(h.by)}${h.reason ? ' · “' + esc(h.reason) + '”' : ''}<div class="hint">${Object.entries(h.changes).map(([k, v]) => esc(k) + ': ' + esc(Array.isArray(v[0]) ? v[0].length + ' contacts' : v[0] == null ? '(blank)' : String(v[0])) + ' → ' + esc(Array.isArray(v[1]) ? v[1].length + ' contacts' : String(v[1]))).join('<br>')}</div></div>`).join('') : '<div class="hint">No changes recorded yet.</div>';
      }catch(err){ if(!err.auth) out.innerHTML = `<div class="npibox bad">${esc(err.message)}</div>`; }
      return;
    }
    if(sv){
      const isNew = !!sv.dataset.createclient, body = {};
      card.querySelectorAll('[data-cf]').forEach(i => body[i.dataset.cf] = i.type === 'checkbox' ? i.checked : i.value.trim());
      body.contacts = contactsOfCard(card);
      const rs = card.querySelector('[data-reason]'); if(rs && rs.value.trim()) body.changeReason = rs.value.trim();
      if(isNew){ try{ const sp = ownerSpec(card); if(sp) body.owner = sp; }catch(err){ alert(err.message); return; } }
      busy(sv, true);
      try{
        const r = await api('POST', '/host/clients' + (isNew ? '' : '/' + encodeURIComponent(sv.dataset.saveclient)), body);
        if(isNew && r.tempPassword && o.pass) o.pass(passHtml(r, 'client’s Account Owner'));
        o.say(isNew ? 'Client created: ' + r.id + (r.ownerError ? '. The Account Owner was not set: ' + r.ownerError : '') : 'Client saved.'); await o.after(isNew ? r.id : false);
      }catch(err){ if(!err.auth) alert(err.message); } finally{ busy(sv, false); }
    }
  });
}

/* ---------------- Users and Billing at ONE pharmacy ----------------
   Shared by the IronLedger employee portal (host.js) and the Account tab (owner.js). Everything here works on one pharmacy at a time:
   the people at that pharmacy and that pharmacy's invoices, never another pharmacy's, even under the same client.
   The server decides who may open what (GET /pharmacy/:id/users, GET /billing/:id) and who may change what (canManage); this file only draws it.
   Needs esc, sw, busy and money (client_panels.js) from the page. */
const DR_PERMS = {submit:'Submit orders', archive:'View archive', remove:'Remove lines', export:'Download backup', calendar:'Calendar', documents:'Documents'};
const DR_ACCT = {pic:'Pharmacist-in-Charge', pharmacist:'Staff Pharmacist', tech:'Pharmacy Technician', staff:'Pharmacy Associate'};
// choosing a type switches these on or off (Calendar and Documents are never changed by a type)
const DR_PRESETS = {pic:{submit:true, archive:true, remove:true, export:true}, pharmacist:{submit:true, archive:true, remove:true, export:false},
  tech:{submit:true, archive:true, remove:true, export:false}, staff:{submit:true, archive:false, remove:false, export:false}};
const DR_DUTY = {'':'Staff (view and print only)', dp:'Designated Person', ctech:'Compliance Technician'};
// sub-roles: job-function switches inside the account type (combinable); Designated Person has a box per USP chapter
const DR_SUBS = {pic:{}, pharmacist:{lead:'Lead', supervisor:'Supervisor', immunizer:'Immunizer', sterile:'Sterile Compounding'}, tech:{lead:'Lead', sterile:'Sterile Compounding', nonsterile:'Nonsterile Compounding'},
  staff:{cashier:'Cashier', driver:'Driver', warehouse:'Warehouse', student:'Student Technician'}};
const DR_CHAPTERS = ['795', '797', '800'];
const DR_PIN = {none:'Not set', set:'Set', temp:'Temporary (they must choose their own)', locked:'Locked'};
const DR_COPY = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const drDay = iso => { try{ return new Date(iso).toLocaleDateString('en-US', {month:'short', day:'numeric'}); }catch(e){ return ''; } };
function drStatus(u){
  if(u.disabled) return '<span class="ustat off ust">Login off</span>';
  if(u.pending && u.tempExpired) return '<span class="ustat bad ust">Expired</span><div class="maker role">Temp password expired</div>';
  if(u.pending) return `<span class="ustat wait ust">Pending</span><div class="maker role">${u.tempExpires ? 'Temp password until ' + drDay(u.tempExpires) : 'Hasn’t signed in yet'}</div>`;
  return '<span class="ustat ok ust">Active</span>';
}
function drTemp(){ const L = 'abcdefghjkmnpqrstuvwxyz', D = '23456789', A = L + D, R = n => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
  let p = L[R(23)] + D[R(8)]; while(p.length < 12) p += A[R(A.length)]; return p; }
async function drCopy(t){
  try{ await navigator.clipboard.writeText(t); return true; }
  catch(e){ const a = document.createElement('textarea'); a.value = t; a.style.position = 'fixed'; a.style.opacity = '0'; document.body.appendChild(a); a.select();
    let ok = false; try{ ok = document.execCommand('copy'); }catch(e2){} a.remove(); return ok; }
}
// one state object per open Users view: which person is opened, changes waiting on a row, temporary passwords made in this tab
const drState = temps => ({open:null, staged:{}, temps:temps || {}});
function drEff(u, S, sid){
  const s = S[u.sub]; if(!s) return u;
  return Object.assign({}, u, {access:s.stores && s.stores[sid] !== undefined ? s.stores[sid] : u.access, perms:Object.assign({}, u.perms, s.perms || {}), isAdmin:s.adminStores && s.adminStores[sid] !== undefined ? s.adminStores[sid] : u.isAdmin,
    disabled:s.disabled !== undefined ? s.disabled : u.disabled, initials:s.initials !== undefined ? s.initials : u.initials, license:s.license !== undefined ? s.license : u.license,
    acctType:s.acctType !== undefined ? s.acctType : u.acctType, docDuty:s.docDuty !== undefined ? s.docDuty : u.docDuty,
    subs:s.subs !== undefined ? s.subs : (s.acctType !== undefined && s.acctType !== u.acctType ? [] : (u.subs || [])), dp:s.dp !== undefined ? s.dp : (s.acctType !== undefined && s.acctType !== u.acctType ? {} : (u.dp || {})),
    approver:s.approver !== undefined ? s.approver : (u.approver === true), licExpires:s.licExpires !== undefined ? s.licExpires : (u.licExpires || '')});
}
// the whole Users view of one pharmacy: the list (a line per person; open one for its details) and the add-a-person form
// U = answer of GET /pharmacy/:id/users; o = {st: drState(), me, host, ownerMe, pinRequired, canPin}
function drUsersHtml(U, o){
  const sid = U.store.id, can = U.canManage, S = o.st.staged, list = U.users.map(u => drEff(u, S, sid));
  const priv = (sw_, label, title) => `<span class="priv" title="${esc(title || label)}">${sw_}<span>${esc(label)}</span></span>`;
  const dpOf = u => DR_CHAPTERS.filter(c => u.dp && u.dp[c] === true), subName = u => (u.subs || []).map(k => (DR_SUBS[u.acctType] || {})[k]).filter(Boolean);
  const role = u => u.isOwner ? '<span class="urole">Account Owner</span>' : (u.isAdmin ? '<span class="urole">Super user</span>' : u.employee ? '<span class="urole">Also IronLedger</span>' : '') + (dpOf(u).length ? ` <span class="urole">Designated Person ${dpOf(u).join(', ')}</span>` : '') + (subName(u).length ? ` <span class="urole">${esc(subName(u).join(', '))}</span>` : '');
  const self = u => o.me && u.login === o.me.login;
  const canPin = u => o.pinRequired && o.canPin && can && !self(u) && !u.isOwner && !u.employee;
  const detail = u => {
    const st = S[u.sub], raw = U.users.find(x => x.sub === u.sub);
    const acts = !can ? '' : st ? `<button class="btn small" data-upd="${esc(u.sub)}">Update</button> <button class="btn2 small" data-undo="${esc(u.sub)}">Undo</button>`
      : (self(u) ? '' : `<button class="btn2 small" data-reset="${esc(u.sub)}">Reset password</button>`) + (u.isOwner || u.employee || self(u) ? '' : ` <button class="btn2 small danger" data-del="${esc(u.sub)}">${u.pending ? 'Cancel invite' : 'Delete'}</button>`)
        + (u.pending && o.st.temps[u.sub] ? ` <button class="btn2 small copyb" data-copy="${esc(u.sub)}" title="Copy Pharmacy ID, User ID and temporary password" aria-label="Copy sign-in details">${DR_COPY}</button>` : '');
    const signing = `<div class="upriv"><span class="plabel">Signing</span><input type="text" data-uini maxlength="3" value="${esc(u.initials || '')}" style="width:70px;text-transform:uppercase;" aria-label="Initials" placeholder="Initials">
        <span class="hint">Employee ID <b>${esc(u.empId || '-')}</b>${o.pinRequired ? ` · PIN: ${DR_PIN[u.pin || 'none']}` : ''}</span>
        ${canPin(u) ? `<button class="btn2 small" data-pinreset="${esc(u.sub)}" title="One-time temporary PIN to hand to them. Their old PIN stops working.">Issue Temporary PIN</button>` : ''}</div>`;
    const isTech = u.acctType === 'tech', lic = `<div class="upriv"><span class="plabel">${isTech ? 'Registration #' : 'RPh license #'}</span><input type="text" data-ulic maxlength="20" value="${esc(u.license || '')}" style="width:130px;text-transform:uppercase;" aria-label="${isTech ? 'Technician registration number' : 'RPh license number'}"> ${isTech ? `<span class="plabel" style="margin-left:10px">Expires</span><input type="date" data-uexp value="${esc(u.licExpires || '')}" aria-label="Registration expiry date"> <span class="hint">The expiry date goes on the calendar.</span>` : '<span class="hint">Pharmacists only. Prints on Rx Intake forms; the Pharmacist-In-Charge’s number prints as PIC.</span>'}</div>`;
    const subKeys = Object.entries(DR_SUBS[u.acctType] || {}), dpOk = u.acctType === 'pic' || u.acctType === 'pharmacist' || u.acctType === 'tech', mayGrant = o.host || o.ownerMe || o.picMe;
    const subsRow = subKeys.length ? `<div class="upriv"><span class="plabel">Sub-roles</span><span class="pgroup">${subKeys.map(([k, l]) => priv(sw(`data-usub="${k}"`, (u.subs || []).includes(k), l), l, l)).join('')}</span></div>` : '';
    const dpRow = dpOk ? `<div class="upriv"><span class="plabel">Designated Person</span><span class="pgroup">${DR_CHAPTERS.map(c => priv(sw(`data-udp="${c}"`, !!(u.dp && u.dp[c]), 'Designated Person for USP <' + c + '>'), '<' + c + '>', 'Designated Person for USP <' + c + '>')).join('')}</span><span class="hint">Reviews compliance records for the chapter before final approval.</span></div>` : '';
    const appRow = (u.acctType === 'pharmacist' && (o.host || o.ownerMe || (o.me && o.me.acctType === 'pic'))) ? `<div class="upriv"><span class="plabel">Final approver</span><span class="pgroup">${priv(sw('data-uapp="1"', u.approver === true, 'May give final approval (the pharmacist in charge always can)'), 'Approves', 'May give final approval')}</span><span class="hint">The pharmacist in charge is the final approver by default.</span></div>` : '';
    const others = raw && raw.others ? `<span class="hint">${o.host && raw.otherIds ? 'Also at ' + esc(raw.otherIds.join(', ')) : 'Also has access at ' + raw.others + (raw.others === 1 ? ' other pharmacy' : ' other pharmacies')}</span>` : '';
    if(u.isOwner) return `<div class="udetail">
        <div class="upriv"><span class="plabel">Account type</span><span class="hint">Account Owner · primary account holder, full access</span></div>${lic}${signing}
        ${o.host && can && !self(u) ? `<div class="upriv"><span class="plabel"></span>${acts}</div>` : ''}</div>`;
    return `<div class="udetail">
        <div class="upriv"><span class="plabel">Account type</span><select data-utype><option value="">Not set</option>${Object.entries(DR_ACCT).map(([k, l]) => `<option value="${k}"${u.acctType === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
          <span class="hint">Choosing a type sets Submit, Archive, Remove and Backup. Calendar and Documents are set separately.</span></div>
        ${lic}${signing}${subsRow}${dpRow}${appRow}
        ${u.perms.documents ? `<div class="upriv"><span class="plabel">Document duty</span>${u.acctType === 'pic' ? '<span class="hint">Pharmacist-In-Charge: manages and approves documents</span>' : `<select data-udoc>${Object.entries(DR_DUTY).map(([k, l]) => `<option value="${k}"${(u.docDuty || '') === k ? ' selected' : ''}>${l}</option>`).join('')}</select>`}</div>` : ''}
        <div class="upriv"><span class="plabel">This pharmacy</span><span class="pgroup">${priv(sw(`data-ust="${esc(sid)}"`, u.access === true, 'Access to ' + U.store.name), 'Access to ' + sid, 'Access to ' + U.store.name)}</span>${others}</div>
        <div class="upriv"><span class="plabel">Privileges</span><span class="pgroup">${Object.entries(DR_PERMS).map(([p, l]) => priv(sw(`data-uperm="${p}"`, !!u.perms[p], l + ' at ' + sid), l, l)).join('')}
          ${self(u) || u.employee ? '' : priv(sw('data-uon="1"', !u.disabled, 'Switch this login on or off'), 'Login on')}</span></div>
        ${(o.host || o.ownerMe || o.picMe) && (u.acctType === 'pic' ? (o.host || o.ownerMe) : (u.acctType === 'pharmacist' || u.acctType === 'tech')) && u.access ? `<div class="upriv"><span class="plabel">Super user</span><span class="pgroup">${priv(sw(`data-uadm="${esc(sid)}"`, u.isAdmin === true, 'All administrator privileges at ' + U.store.name + ' except billing, the client page and ownership'), sid, 'Super user at ' + U.store.name)}</span>
          <span class="hint">All administrator privileges except billing, the client page and ownership.</span></div>` : ''}
        ${acts ? `<div class="upriv"><span class="plabel"></span>${acts}</div>` : ''}</div>`;
  };
  const rows = list.map(u => {
    const open = o.st.open === u.sub;
    return `<div class="urow${u.disabled ? ' off' : ''}${S[u.sub] ? ' dirty' : ''}${open ? ' open' : ''}" data-sub="${esc(u.sub)}">
      <div class="ucols urowhead" role="button" tabindex="0" aria-expanded="${open}" data-open="${esc(u.sub)}">
        <div class="ucell uname" data-l="User"><b>${esc(u.name || u.login)}</b>${role(u)}</div>
        <div class="ucell mono" data-l="Username">${esc(u.login)}</div>
        <div class="ucell" data-l="Mobile"><span class="mono">${esc(u.phone || '')}</span>${can && !u.isOwner && !u.employee && open ? ` <button class="edit" data-phone="${esc(u.sub)}" title="Change mobile number">✎</button>` : u.isOwner ? ' <span class="hint" title="Sign-in codes are texted here, so only IronLedger changes it.">🔒</span>' : ''}</div>
        <div class="ucell" data-l="Status">${drStatus(u)}</div>
        <div class="ucell acts"><span class="chev" aria-hidden="true">${open ? '▾' : '▸'}</span></div></div>
      ${open ? detail(u) : ''}</div>`;
  }).join('');
  const top = !can ? '' : '<div class="toolbar row utop"><button class="btn" data-npopen="1">Add user</button></div>';
  const add = !can || !o.st.addOpen ? '' : `<div class="drmodal" data-npmodal role="dialog" aria-modal="true" aria-label="Add a user"><div class="drbox">
      <div class="drhead"><b>Add a user</b><button type="button" class="btn2 small" data-npclose="1" aria-label="Close">✕</button></div>
      <div class="formgrid grid2">
        <label class="f"><span>Full name</span><input type="text" data-np="name" maxlength="120"></label>
        <label class="f"><span>Login ID</span><input type="text" data-np="login" autocapitalize="none" spellcheck="false" maxlength="32"></label>
        <label class="f"><span>Mobile number (for sign-in codes)</span><input type="tel" data-np="phone" maxlength="20"></label>
        <label class="f"><span>Temporary password</span><input type="text" data-np="pass" class="mono" maxlength="64" value="${esc(o.st.np || drTemp())}"></label>
        <label class="f"><span>Account type</span><select data-np="type"><option value="">Not set</option>${Object.entries(DR_ACCT).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <label class="f"><span>Initials</span><input type="text" data-np="ini" maxlength="3" style="max-width:90px;text-transform:uppercase;"></label>
        <label class="f"><span>RPh license # or technician registration #</span><input type="text" data-np="lic" maxlength="20" style="max-width:150px;text-transform:uppercase;"></label>
      </div>
      <label class="chk" style="margin-top:10px"><input type="checkbox" data-np="consent" style="width:18px;height:18px;"> They signed the SMS consent form for this mobile number.</label>
      <div class="toolbar row" style="margin-top:10px"><button class="btn" data-npadd="1">Add user</button> <button class="btn2" data-npgen="1">New temporary password</button> <button class="btn2" data-npclose="1">Cancel</button></div>
      <div class="npmsg msg" data-npmsg role="status"></div></div></div>`;
  return `${top}<div class="ulist"><div class="uhead ucols"><div>User</div><div>Username</div><div>Mobile</div><div>Status</div><div></div></div>${rows || '<div class="hint" style="padding:10px">No one has access here yet.</div>'}</div>
    ${can ? '' : '<div class="hint" style="margin-top:10px">View only. Changes to people at this pharmacy are made by its Account Owner or IronLedger.</div>'}${add}`;
}
// behaviour: env = {sid, base:'/host'|'/owner', U:()=>answer, st:drState(), me:()=>ME, reload:async()=>…, paint:()=>…, say:text=>…, pass:html=>…}
function drUsersEvents(root, env){
  const find = sub => env.U().users.find(x => x.sub === sub);
  const raw0 = sub => find(sub) || {};
  const stg = sub => env.st.staged[sub] || (env.st.staged[sub] = {});
  const tidy = sub => { if(env.st.staged[sub] && !Object.keys(env.st.staged[sub]).length) delete env.st.staged[sub]; };
  const put = (sub, grp, k, v, was) => { const s = stg(sub); s[grp] = s[grp] || {}; if(v === was) delete s[grp][k]; else s[grp][k] = v; if(!Object.keys(s[grp]).length) delete s[grp]; tidy(sub); };
  const sig = u => { return `Pharmacy ID: ${env.sid}\nUser ID: ${u.login}\nTemporary Pass: `; };
  root.addEventListener('keydown', e => { if(e.key === 'Escape' && env.st.addOpen){ env.st.addOpen = false; env.paint(); return; }
     const h = e.target.closest('[data-open]'); if(h && (e.key === 'Enter' || e.key === ' ') && e.target === h){ e.preventDefault(); h.click(); } });
  root.addEventListener('change', e => {
    const row = e.target.closest('[data-sub]'); if(!row){ const t = e.target.closest('[data-np=type]'); if(t){ const pre = DR_PRESETS[t.value]; if(pre) for(const k in pre){ const c = root.querySelector(`[data-npperm="${k}"]`); if(c) c.checked = pre[k]; } } return; }
    const sub = row.dataset.sub, u = find(sub); if(!u) return;
    const ty = e.target.closest('select[data-utype]');
    if(ty){ if(ty.value === (u.acctType || '')) delete stg(sub).acctType; else stg(sub).acctType = ty.value;
      const pre = DR_PRESETS[ty.value]; if(pre){ const s = stg(sub); s.perms = s.perms || {}; for(const k in pre){ if(pre[k] === !!u.perms[k]) delete s.perms[k]; else s.perms[k] = pre[k]; } if(!Object.keys(s.perms).length) delete s.perms; }
      delete stg(sub).subs; delete stg(sub).dp; delete stg(sub).approver; tidy(sub); env.say(''); env.paint(); return; }
    const dd = e.target.closest('select[data-udoc]');
    if(dd){ if(dd.value === (u.docDuty || '')) delete stg(sub).docDuty; else stg(sub).docDuty = dd.value; tidy(sub); env.say(''); env.paint(); return; }
    const ini = e.target.closest('input[data-uini]');
    if(ini){ const v = ini.value.trim().toUpperCase(); if(v === (u.initials || '')) delete stg(sub).initials; else stg(sub).initials = v; tidy(sub); env.say(''); env.paint(); return; }
    const ex = e.target.closest('input[data-uexp]');
    if(ex){ const v = ex.value.trim(); if(v === (u.licExpires || '')) delete stg(sub).licExpires; else stg(sub).licExpires = v; tidy(sub); env.say(''); env.paint(); return; }
    const lic = e.target.closest('input[data-ulic]');
    if(lic){ const v = lic.value.trim().toUpperCase(); if(v === (u.license || '')) delete stg(sub).license; else stg(sub).license = v; tidy(sub); env.say(''); env.paint(); return; }
    const c = e.target.closest('input[type=checkbox]'); if(!c) return;
    if(c.dataset.ust) put(sub, 'stores', c.dataset.ust, c.checked, u.access === true);
    else if(c.dataset.uperm) put(sub, 'perms', c.dataset.uperm, c.checked, !!u.perms[c.dataset.uperm]);
    else if(c.dataset.usub){ const cur = new Set(u.subs || []); c.checked ? cur.add(c.dataset.usub) : cur.delete(c.dataset.usub); const arr = [...cur].sort(), was = (raw0(sub).subs || []).slice().sort(); if(JSON.stringify(arr) === JSON.stringify(was)) delete stg(sub).subs; else stg(sub).subs = arr; tidy(sub); }
    else if(c.dataset.udp){ const cur = Object.assign({}, u.dp || {}); if(c.checked) cur[c.dataset.udp] = true; else delete cur[c.dataset.udp]; const was = raw0(sub).dp || {}; if(JSON.stringify(Object.keys(cur).sort()) === JSON.stringify(Object.keys(was).filter(k => was[k]).sort())) delete stg(sub).dp; else stg(sub).dp = cur; tidy(sub); }
    else if(c.dataset.uapp){ if(c.checked === (raw0(sub).approver === true)) delete stg(sub).approver; else stg(sub).approver = c.checked; tidy(sub); }
    else if(c.dataset.uadm) put(sub, 'adminStores', c.dataset.uadm, c.checked, u.isAdmin === true);
    else if(c.dataset.uon){ if(!c.checked === !!u.disabled) delete stg(sub).disabled; else stg(sub).disabled = !c.checked; tidy(sub); }
    env.say(''); env.paint();
  });
  const bodyOf = sub => { const s = env.st.staged[sub] || {}, b = {}; if(s.stores) b.stores = s.stores; if(s.perms){ b.perms = s.perms; b.permStore = env.sid; } if(s.adminStores) b.adminStores = s.adminStores;
    ['disabled', 'initials', 'license', 'acctType', 'docDuty', 'subs', 'dp', 'approver', 'licExpires'].forEach(k => { if(s[k] !== undefined) b[k] = s[k]; }); return b; };
  root.addEventListener('click', async e => {
    const hd = e.target.closest('[data-open]');
    if(hd && !e.target.closest('button,input,select,a,label')){ env.st.open = env.st.open === hd.dataset.open ? null : hd.dataset.open; env.paint(); return; }
    const t = (s) => e.target.closest(s);
    const no = t('[data-npopen]'), nc = e.target.closest('[data-npclose]') || (e.target.matches('[data-npmodal]') ? e.target : null);
    if(no){ env.st.addOpen = true; env.paint(); const f = root.querySelector('[data-np=name]'); if(f) f.focus(); return; }
    if(nc){ env.st.addOpen = false; env.paint(); return; }
    const up = t('[data-upd]'), un = t('[data-undo]'), rs = t('[data-reset]'), dl = t('[data-del]'), cp = t('[data-copy]'), ph = t('[data-phone]'), pr = t('[data-pinreset]'), na = t('[data-npadd]'), ng = t('[data-npgen]');
    const nm = u => u.name || u.login, url = u => env.base + '/users/' + encodeURIComponent(u.sub);
    try{
      if(ng){ const i = root.querySelector('[data-np=pass]'); i.value = env.st.np = drTemp(); return; }
      if(na){
        const g = k => ((root.querySelector(`[data-np=${k}]`) || {}).value || '').trim(), perms = Object.assign({submit:true, archive:true, remove:true, export:false, calendar:true, documents:true}, DR_PRESETS[g('type')] || {});
        const say = (m, ok) => { const el = root.querySelector('[data-npmsg]'); el.textContent = m; el.className = 'npmsg msg' + (ok ? ' ok' : ''); };
        if(!g('name') || !g('login') || !g('phone')) return say('Name, Login ID and mobile number are all needed.');
        if(!root.querySelector('[data-np=consent]').checked) return say('Tick the box to confirm they signed the SMS consent form for this number.');
        const body = {name:g('name'), login:g('login').toLowerCase(), phone:g('phone'), tempPassword:g('pass') || undefined, initials:g('ini').toUpperCase(), license:g('lic').toUpperCase(), acctType:g('type'), stores:{[env.sid]:true}, perms, smsConsent:true};
        busy(na, true);
        try{ const r = await api('POST', env.base + '/users', body); env.st.temps[r.user.sub] = r.tempPassword; env.st.np = ''; env.st.addOpen = false; env.st.open = r.user.sub;
          env.pass(`<b>${esc(body.name)} can sign in now.</b> Give them:<br>Pharmacy ID: <b class="mono">${esc(env.sid)}</b><br>Login ID: <b class="mono">${esc(r.user.login)}</b><br>Temporary password: <b class="mono">${esc(r.tempPassword)}</b><br><span class="hint">They choose their own password the first time they sign in. The temporary password isn’t shown again.</span>`);
          await env.reload(); env.say('Added ' + body.name + '. They are Pending until they first sign in.'); }
        catch(err){ if(!err.auth) say('Not added: ' + err.message); } finally{ busy(na, false); }
        return;
      }
      const sub = (t('[data-sub]') || {}).dataset && t('[data-sub]').dataset.sub, u = sub && find(sub);
      if(!u) return;
      if(un){ delete env.st.staged[sub]; env.say(''); env.paint(); return; }
      if(up){
        const body = bodyOf(sub);
        if(body.disabled === true && !confirm(`Switch off ${nm(u)}'s login? They are signed out everywhere and can't sign in until it's switched back on.`)) return;
        busy(up, true);
        try{ await api('POST', url(u), body); delete env.st.staged[sub]; await env.reload(); env.say(body.disabled === true ? `${nm(u)}'s login was switched off. They were signed out.` : `${nm(u)}'s account access was updated. It takes effect after they sign out and sign back in.`); }
        catch(err){ busy(up, false); if(!err.auth) alert(err.message); }
        return;
      }
      if(pr){
        if(!confirm(`Issue a temporary PIN for ${nm(u)}?\n\nTheir current PIN stops working. They enter the temporary one and choose their own the next time they sign something. Give it to them in person.`)) return;
        busy(pr, true);
        try{ const r = await api('POST', url(u) + '/pin-reset', {}); await env.reload();
          env.pass(`<b>Temporary PIN for ${esc(nm(u))}:</b> <span class="mono" style="font-size:20px;letter-spacing:.2em;">${esc(r.tempPin)}</span><br><span class="hint">Shown once. Give it to them in person; they choose their own PIN when they next sign something.</span>`); }
        catch(err){ busy(pr, false); if(!err.auth) alert(err.message); }
        return;
      }
      if(cp){ if(!env.st.temps[sub]) return; const ok = await drCopy(sig(u) + env.st.temps[sub]); env.pass(ok ? `<b>Copied ${esc(nm(u))}’s sign-in details.</b> Paste them where you need them.` : 'Couldn’t copy. Select the text instead.'); return; }
      if(dl){
        const typed = prompt(u.pending ? `Cancel ${nm(u)}'s invitation?\n\nThey haven't signed in yet. Their login and temporary password are removed, and the Login ID can be used again.\n\nType their Login ID (${u.login}) to cancel it:` : `Delete ${nm(u)} for good?\n\nTheir login is removed and can't be switched back on. Orders and archive lines they entered stay, under their name.\nTo just stop them signing in for now, switch their login off instead.\n\nType their Login ID (${u.login}) to delete:`);
        if(typed === null) return;
        if(typed.trim().toLowerCase() !== u.login) return alert('The Login ID didn’t match. Nothing was deleted.');
        await api('POST', url(u) + '/delete', {}); env.st.open = null; await env.reload(); env.say(u.pending ? `${nm(u)}'s invitation was cancelled.` : `${nm(u)} was deleted.`); return;
      }
      if(ph){
        const v = prompt(`New mobile number for ${nm(u)} (sign-in codes are texted here):`, u.phone); if(!v) return;
        if(!confirm(`Has ${nm(u)} signed a new SMS consent form for ${v}?`)) return alert('Have them sign the SMS consent form for the new number first.');
        await api('POST', url(u), {phone:v, smsConsent:true}); await env.reload(); env.say('Mobile number saved.'); return;
      }
      if(rs){
        if(!confirm(`Give ${nm(u)} a new temporary password? Their current password stops working and they're signed out everywhere.`)) return;
        const r = await api('POST', url(u) + '/reset-password', {}); env.st.temps[sub] = r.tempPassword; await env.reload();
        env.pass(`<b>New temporary password for ${esc(nm(u))}</b><br>Login ID: <b class="mono">${esc(u.login)}</b><br>Temporary password: <b class="mono">${esc(r.tempPassword)}</b><br><span class="hint">They choose their own password when they next sign in. The copy button on their row copies their sign-in details.</span>`);
      }
    }catch(err){ if(!err.auth) alert(err.message); }
  });
}
/* ---------- one pharmacy's billing ---------- o = {edit: bool (IronLedger only), sid, filter} */
function drBillingHtml(B, o){
  const S = B.summary, tile = (l, x, cls) => `<div class="bt ${cls || ''}"><span>${l}</span><b>${x.count}</b><em>${money(x.cents)}</em></div>`;
  const st = i => i.status === 'paid' ? `<span class="ust ok">Paid${i.paidOn ? ' ' + esc(i.paidOn) : ''}</span>` : i.status === 'void' ? '<span class="ust off">Void</span>' : i.delinquent ? '<span class="ust bad">Delinquent</span>' : '<span class="ust wait">Unpaid</span>';
  const fl = o.filter || 'all', keep = i => fl === 'all' || (fl === 'paid' && i.status === 'paid') || (fl === 'delinquent' && i.delinquent && i.status !== 'paid' && i.status !== 'void') || (fl === 'unpaid' && i.status !== 'paid' && i.status !== 'void');
  const rows = B.invoices.filter(keep).map(i => `<tr data-inv="${esc(i.id)}"><td>${esc(i.number)}</td><td>${esc(i.issued)}</td><td>${esc(i.due)}</td><td class="num">${money(i.cents)}</td><td>${esc(i.description)}</td><td>${st(i)}</td>${o.edit ? `<td class="acts">${i.status !== 'paid' && i.status !== 'void' ? `<button type="button" class="btn2 small" data-invpaid="${esc(i.id)}">Mark paid</button> <button type="button" class="btn2 small" data-invvoid="${esc(i.id)}">Void</button>` : i.status === 'paid' ? `<button type="button" class="btn2 small" data-invunpaid="${esc(i.id)}">Undo</button>` : ''}</td>` : ''}</tr>`).join('');
  const fb = (k, l) => `<button type="button" class="${fl === k ? 'btn' : 'btn2'} small" data-bfil="${k}">${l}</button>`;
  return `<div class="btiles">${tile('New this month', S.newThisMonth)}${tile('Paid this month', S.paidThisMonth, 'ok')}${tile('Unpaid', S.unpaid)}${tile('Delinquent', S.delinquent, S.delinquent.count ? 'bad' : '')}</div>
    <div class="toolbar row" style="margin:10px 0">${fb('all', 'All invoices')}${fb('unpaid', 'Unpaid')}${fb('delinquent', 'Delinquent')}${fb('paid', 'Paid')}</div>
    <div class="tscroll"><table class="invt"><thead><tr><th>Invoice</th><th>Issued</th><th>Due</th><th class="num">Amount</th><th>For</th><th>Status</th>${o.edit ? '<th></th>' : ''}</tr></thead><tbody>${rows || `<tr><td colspan="7" class="hint">${B.invoices.length ? 'None in this list.' : 'No invoices yet.'}</td></tr>`}</tbody></table></div>
    ${o.edit ? `<div class="invadd"><b class="clh">Add an invoice</b><div class="pfields"><label><span>Issued</span><input type="date" data-iv="issued"></label><label><span>Due</span><input type="date" data-iv="due"></label>
      <label><span>Amount ($)</span><input type="text" inputmode="decimal" data-iv="amount" maxlength="12"></label><label><span>For</span><input type="text" data-iv="description" maxlength="200"></label></div>
      <button type="button" class="btn2 small" data-invadd="1">Add invoice</button></div>` : '<div class="hint">Read only. Questions about an invoice go to IronLedger.</div>'}`;
}
// env = {sid, B:()=>answer, o:{edit}, paint:()=>…, reload:async()=>…, say:text=>…}
function drBillingEvents(root, env){
  root.addEventListener('click', async e => {
    const f = e.target.closest('[data-bfil]'); if(f){ env.o.filter = f.dataset.bfil; env.paint(); return; }
    const ia = e.target.closest('[data-invadd]'), pd = e.target.closest('[data-invpaid]'), vd = e.target.closest('[data-invvoid]'), up = e.target.closest('[data-invunpaid]');
    if(!(ia || pd || vd || up) || !env.o.edit) return;
    const base = '/host/stores/' + encodeURIComponent(env.sid) + '/invoices';
    try{
      if(ia){ const g = k => root.querySelector(`[data-iv=${k}]`).value.trim(); await api('POST', base, {issued:g('issued') || undefined, due:g('due'), amount:g('amount'), description:g('description')}); }
      else if(pd) await api('POST', base + '/' + encodeURIComponent(pd.dataset.invpaid), {status:'paid'});
      else if(up) await api('POST', base + '/' + encodeURIComponent(up.dataset.invunpaid), {status:'unpaid'});
      else { const why = prompt('Why is this invoice voided?'); if(!why) return; await api('POST', base + '/' + encodeURIComponent(vd.dataset.invvoid), {status:'void', note:why}); }
      await env.reload(); env.say('Invoices updated.');
    }catch(err){ if(!err.auth) alert(err.message); }
  });
}

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
$('acSide').addEventListener('click', e => {
  const cv = e.target.closest('[data-calview]'); if(cv){ calOpenView(cv.dataset.calview); return; }
  const p = e.target.closest('[data-qs]'), v = e.target.closest('[data-view]');
  if(p) acGo(AC.client, p.dataset.qs, 'acct'); else if(v){ AC.view = v.dataset.view; AC_ST.open = null; AC_BO.filter = 'all'; acMsg(''); acLoad(); }
});
$('acCrumb').addEventListener('click', e => { const b = e.target.closest('[data-crumb]'); if(!b) return; const w = b.dataset.crumb; if(w === 'pharm') acGo(AC.client, AC.pharm, 'acct'); else acGo(AC.client, null); });
$('acCrumb').addEventListener('change', e => { const s = e.target.closest('#acPick'); if(s) acGo(s.value, null); });
// pharmacy account page (Account Owner): the same card and events as before
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

/* ---------------- Documents page: a pharmacy's own compliance document library ----------------
   Built on the layout engine (layout_engine.js) like every page of the suite. DOCS_LAYOUT is set by Neo with the layout editor
   (dev/build_layout_editor.py documents) and is the same for everyone. Panels: folders, summary tiles (Owner, Pharmacist-In-Charge, Designated Person only),
   pinned, and the document list. The detail panel and the windows (add, new version, approve, review, retire) open over the page.
   What a person may do is decided by the server from their duty (Owner, Pharmacist-In-Charge, Designated Person, Compliance Technician, Staff); the screen only follows it.
   Everyone with the Documents privilege can open, print and pin the current documents. */
const DOC_SLUG = s => s.replace(/ /g, '_').replace(/[()]/g, '');
const DOC_AREA_LIST = [['01', 'OPS', 'Pharmacy Operations'], ['02', 'CSA', 'Controlled Substances'], ['03', 'NSC', 'Nonsterile Compounding (USP 795)'], ['04', 'STC', 'Sterile Compounding (USP 797)'], ['05', 'HDR', 'Hazardous Drugs (USP 800)'], ['06', 'IMM', 'Immunizations'], ['07', 'HIP', 'Privacy and Security (HIPAA)'], ['08', 'OSH', 'Workplace Safety (OSHA)'], ['09', 'QMS', 'Quality and Medication Safety'], ['10', 'PER', 'Personnel Training and Competency'], ['11', 'REG', 'Licensing and Regulatory'], ['12', 'FAC', 'Facilities and Equipment']].map(([n, code, name]) => ({ n, code, name, folder: n + '_' + DOC_SLUG(name) }));
const DOC_AF = Object.fromEntries(DOC_AREA_LIST.map(a => [a.code, a.folder]));
const DOC_CMPA = ['NSC', 'STC', 'HDR'];
const DOC_TYPE_LIST = [
  { c: 'POL', n: 'Policy', f: '01_Policies', sub: null }, { c: 'SOP', n: 'SOP', f: '02_SOPs', sub: null }, { c: 'FRM', n: 'Form', f: '03_Forms', sub: null },
  { c: 'MFR', n: 'MFR', f: '04_MFRs', sub: DOC_CMPA, tip: 'Paper (PDF) renderings of Master Formulation Records' }, { c: 'CMP', n: 'Compounding Record', f: '05_Compounding_Records', sub: DOC_CMPA, tip: 'Blank compounding record templates' },
  { c: 'LOG', n: 'Log', f: '06_Logs', sub: null }, { c: 'CHK', n: 'Checklist', f: '07_Checklists', sub: null },
  { c: 'TRN', n: 'Training Material', f: '08_Training_and_Competency', sub: ['Orientation', 'Competency_Assessments', 'Training_Materials'] },
  { c: 'PAT', n: 'Patient Material', f: '09_Patient_Materials', sub: ['Notices', 'Counseling_Handouts', 'Immunization'] },
  { c: 'REF', n: 'Reference', f: '10_Reference', sub: ['Regulatory_Rules', 'Safety_Data_Sheets', 'Manufacturer_and_Vendor', 'Accreditation'] },
  { c: 'TMP', n: 'Template', f: '11_Templates_General', sub: ['Letterhead', 'General'] }];
const DOC_TY = Object.fromEntries(DOC_TYPE_LIST.map(t => [t.c, t]));
const DOC_FORMATS = ['Fillable PDF', 'Printable PDF'];
const DOC_DUTY_LABELS = { owner: 'Owner', pic: 'Pharmacist-In-Charge', dp: 'Designated Person', ctech: 'Compliance Technician', staff: 'Staff' };
const DOC_DUE_SOON = 30;
// the log stores UTC; show it in the pharmacy's own time zone with the zone name (CST / CDT)
function docsLocal(iso){
  try{
    const tz = typeof storeTZ === 'function' ? storeTZ() : 'America/Chicago', d = new Date(iso); if(isNaN(d)) return String(iso).slice(0, 16).replace('T', ' ');
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).formatToParts(d).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
  }catch(e){ return String(iso).slice(0, 16).replace('T', ' ') + ' UTC'; }
}
const docSubFor = d => { const t = DOC_TY[d.type]; return t.sub === null || DOC_CMPA.includes(t.sub[0]) ? DOC_AF[d.area] : (d.sub || t.sub[0]); };
const docFileName = (d, v) => `${d.id}_v${v}_${d.title.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}.pdf`;
const docPathOf = (d, v) => `${DOC_TY[d.type].f}/${docSubFor(d)}/${docFileName(d, v)}`;

const DOCS_PANELS = [['rail', 'Folders'], ['tiles', 'Compliance Summary'], ['pins', 'Pinned'], ['list', 'Documents']];
const DOCS_LAYOUT = {"v":2,"cols":12,"panels":{"rail":[1,1,2,43],"tiles":[3,1,10,11],"pins":[3,12,10,8],"list":[3,20,10,45]}};   // set by Neo from the layout editor (2026-11-18)
const DOCS_PAGE = { id: 'documents', title: 'Documents Page', panels: DOCS_PANELS, layout: DOCS_LAYOUT,
  render: (_unused, panels) => docsHtml(DOCS_SAMPLE_MODEL(), { panels }) };

/* ---- the screen's state (one per sign-in); the layout editor builds its own from the sample below ---- */
function docsNewModel(){ return { view: 'docs', insp: null, inspOK: false, tasks: null, mine: null, pers: null, persSel: null, grants: null, tasksOK: false, persOK: false, persAdd: false, boss: false, dpChapters: [], final: false, duty: 'staff', today: '', docs: [], pins: [], log: [], pharmacy: '', q: '', type: 'all', fstatus: '', fformat: '', freview: '', fpend: false, showRetired: false, sort: { k: 'id', d: 1 }, sel: '', loaded: false }; }
const docsIs = (m, ...ds) => ds.includes(m.duty);
const docsManage = m => docsIs(m, 'owner', 'pic', 'dp', 'ctech'), docsApprove = m => docsIs(m, 'owner', 'pic', 'dp');
const docsDate = s => { const [y, mo, d] = s.split('-').map(Number); return Date.UTC(y, mo - 1, d); };
const docsDiff = (a, b) => Math.round((docsDate(a) - docsDate(b)) / 864e5);
function docsAddMonths(s, n){ const [y, m, d] = s.split('-').map(Number), t = new Date(Date.UTC(y, m - 1 + n, 1)), last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); t.setUTCDate(Math.min(d, last)); return t.toISOString().slice(0, 10); }
function docInfo(d, m){
  const cur = d.versions.find(v => v.state === 'current'), pend = d.versions.find(v => v.state === 'pending');
  const status = d.retired ? 'Retired' : cur ? (d.underReview ? 'Under Review' : 'Active') : 'Draft';
  const base = d.lastReviewed || (cur && cur.effective) || null, next = base && d.cycle ? docsAddMonths(base, d.cycle) : null, days = next ? docsDiff(next, m.today) : null;
  let r = 'n/a'; if(status === 'Active' || status === 'Under Review') r = next == null ? 'No Date' : days < 0 ? 'Overdue' : days <= DOC_DUE_SOON ? 'Due Soon' : 'Current';
  return { cur, pend, status, version: cur ? cur.v : (pend ? pend.v : ''), effective: cur ? cur.effective : '', next, days, r };
}
const DOC_RORD = { Overdue: 0, 'Due Soon': 1, 'No Date': 2, Current: 3, 'n/a': 4 };
const docPill = (cls, t, title) => `<span class="dpill ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(t)}</span>`;
const docStatusPill = s => docPill({ Active: 'ok', Draft: 'gray', 'Under Review': 'warn', Retired: 'gray' }[s], s);
const docReviewPill = r => r === 'n/a' ? '<span class="hint">n/a</span>' : docPill({ Overdue: 'bad', 'Due Soon': 'warn', Current: 'ok', 'No Date': 'bad' }[r], r);
const docFormatPill = f => docPill(f === 'Fillable PDF' ? 'acc' : 'gray', f.replace(' PDF', ''));
function docDueText(i){ if(i.next == null) return ''; if(i.r === 'n/a') return i.next; return i.days < 0 ? `${-i.days} day${i.days === -1 ? '' : 's'} overdue` : i.days === 0 ? 'due today' : `in ${i.days} day${i.days === 1 ? '' : 's'}`; }

function docsRows(m){
  const q = m.q.trim().toLowerCase(), man = docsManage(m);
  let rows = m.docs.map(d => ({ d, i: docInfo(d, m) })).filter(({ d, i }) => {
    if(!man && (i.status === 'Draft' || i.status === 'Retired') && !(i.pend && d.chapter && m.dpChapters.includes(d.chapter))) return false;
    if(m.type !== 'all' && d.type !== m.type) return false;
    if(i.status === 'Retired' && !m.showRetired && m.fstatus !== 'Retired') return false;
    if(m.fstatus && i.status !== m.fstatus) return false;
    if(m.fformat && d.format !== m.fformat) return false;
    if(m.freview && i.r !== m.freview) return false;
    if(m.fpend && !i.pend) return false;
    if(q && !(d.id + ' ' + d.title + ' ' + d.notes + ' ' + d.basis).toLowerCase().includes(q)) return false;
    return true; });
  const V = { id: x => x.d.id, title: x => x.d.title.toLowerCase(), type: x => DOC_TY[x.d.type].n, version: x => x.i.version, status: x => x.i.status, next: x => x.i.next || '9999', r: x => DOC_RORD[x.i.r] }[m.sort.k] || (x => x.d.id);
  rows.sort((a, b) => { const x = V(a), y = V(b); return (x < y ? -1 : x > y ? 1 : a.d.id < b.d.id ? -1 : 1) * m.sort.d; });
  return rows;
}
/* ---- panel regions. Each region has a data-dz name so the live page can refresh just that part (typing in the search box is never interrupted) ---- */
function docsRailHtml(m){
  const all = m.docs.map(d => ({ d, i: docInfo(d, m) })), man = docsManage(m), appr = docsApprove(m);
  const live = all.filter(x => x.i.status !== 'Retired' && (man || x.i.status !== 'Draft'));
  const sp = `<button class="dit" data-dact="view" data-id="mine" aria-current="${m.view === 'mine'}"><span class="nm">My Documents</span></button>` +
    (m.tasksOK ? `<button class="dit" data-dact="view" data-id="tasks" aria-current="${m.view === 'tasks'}"><span class="nm">Tasks</span></button>` : '') +
    (m.persOK ? `<button class="dit" data-dact="view" data-id="pers" aria-current="${m.view === 'pers'}"><span class="nm">Personnel Files</span></button>` : '') +
    (m.inspOK ? `<button class="dit" data-dact="view" data-id="insp" aria-current="${m.view === 'insp'}"><span class="nm">Inspector Link</span></button>` : '') + '<div class="dgh">Library</div>';
  return sp + `<button class="dit" data-dact="view" data-id="docs" aria-current="${m.view === 'docs' && m.type === 'all'}"><span class="nm">All Documents</span><span class="ct">${live.length}</span></button>` +
    DOC_TYPE_LIST.map(t => { const mm = live.filter(x => x.d.type === t.c), od = mm.filter(x => x.i.r === 'Overdue').length;
      return `<button class="dit" data-dact="type" data-id="${t.c}" aria-current="${m.view === 'docs' && m.type === t.c}" title="${esc(t.tip || t.f)}"><span class="nm">${t.f.replace(/_/g, ' ')}</span>${od && appr ? `<span class="od">${od}</span>` : ''}<span class="ct">${mm.length}</span></button>`; }).join('') +
    (man ? `<div class="dgh">Archive</div><button class="dit" data-dact="showret"><span class="nm">99 Archive (Retired)</span><span class="ct">${all.filter(x => x.i.status === 'Retired').length}</span></button>` : '');
}
function docsTilesHtml(m){
  const all = m.docs.map(d => ({ d, i: docInfo(d, m) })), c = k => all.filter(x => x.i.r === k).length;
  return `<div class="dtiles">${[['active', 'acc', 'Active', all.filter(x => x.i.status === 'Active' || x.i.status === 'Under Review').length], ['Overdue', 'bad', 'Review Overdue', c('Overdue')], ['Due Soon', 'warn', `Due In ${DOC_DUE_SOON} Days`, c('Due Soon')],
    ['pend', 'warn', 'Awaiting Approval', all.filter(x => x.i.pend).length], ['Under Review', 'acc', 'Under Review', all.filter(x => x.i.status === 'Under Review').length]]
    .map(([k, cl, l, n]) => `<button class="dtile ${cl}" data-dact="tile" data-id="${k}"><div class="n">${n}</div><div class="l">${esc(l)}</div></button>`).join('')}</div>`;
}
function docsPinsHtml(m){
  const pins = m.pins.map(id => m.docs.find(d => d.id === id)).filter(Boolean);
  return pins.length ? pins.map(d => `<button class="dchip" data-dact="open" data-id="${d.id}" title="${esc(d.title)}"><span class="num">${d.id}</span> ${esc(d.title.length > 34 ? d.title.slice(0, 33) + '…' : d.title)}</button>`).join('') : '<span class="hint">Nothing pinned yet. Use the star on any row.</span>';
}
function docsChipsHtml(m){
  const act = [];
  if(m.type !== 'all') act.push(['Folder: ' + DOC_TY[m.type].f.replace(/_/g, ' '), 'type']); if(m.fstatus) act.push(['Status: ' + m.fstatus, 'fstatus']); if(m.fformat) act.push(['Format: ' + m.fformat, 'fformat']);
  if(m.freview) act.push(['Review: ' + m.freview, 'freview']); if(m.fpend) act.push(['Awaiting Approval', 'fpend']); if(m.showRetired) act.push(['Showing Retired', 'showRetired']);
  return act.length ? `<div class="dchips">${act.map(([l, k]) => `<button class="dchip" data-dact="clr" data-id="${k}">${esc(l)} ×</button>`).join('')}<button class="btn2 small" data-dact="clrall">Clear All</button></div>` : '';
}
function docsTableHtml(m){
  const rows = docsRows(m), man = docsManage(m), appr = docsApprove(m), pn = m.pins;
  const H = [['pin', ''], ['id', 'Doc ID'], ['title', 'Title'], ['type', 'Type'], ['version', 'Version'], ...(man ? [['status', 'Status']] : []), ...(appr ? [['next', 'Next Review'], ['r', 'Review']] : []), ['more', '']];
  const arrow = k => m.sort.k === k ? (m.sort.d > 0 ? ' ▲' : ' ▼') : '';
  if(!rows.length) return `<div class="dempty">No documents match. ${m.docs.length ? '<button class="btn2 small" data-dact="clrall">Clear Filters</button>' : ''}</div>`;
  return `<div class="dtw"><table class="dtable"><thead><tr>${H.map(([k, l]) => k === 'pin' || k === 'more' ? '<th></th>' : `<th class="s" data-dact="sort" data-id="${k}" scope="col">${l}${arrow(k)}</th>`).join('')}</tr></thead><tbody>${rows.map(({ d, i }) => `<tr class="dtr${m.sel === d.id ? ' sel' : ''}" tabindex="0" data-row="${d.id}">
    <td><button class="dstar${pn.includes(d.id) ? ' on' : ''}" data-dact="pin" data-id="${d.id}" aria-label="${pn.includes(d.id) ? 'Unpin' : 'Pin'} ${d.id}">${pn.includes(d.id) ? '★' : '☆'}</button></td>
    <td class="num">${d.id}</td><td title="${esc(d.title)}">${esc(d.title)}${i.pend && man ? ` ${docPill('warn', 'v' + i.pend.v + ' Pending', 'A new version is waiting for approval')}` : ''}</td><td>${DOC_TY[d.type].n}</td>
    <td class="num">${i.version || '-'}</td>${man ? `<td>${docStatusPill(i.status)}</td>` : ''}${appr ? `<td class="num">${i.next || '-'}</td><td>${docReviewPill(i.r)}</td>` : ''}
    <td><button class="dmore" data-dact="menu" data-id="${d.id}" aria-label="Details and actions for ${d.id}">⋯</button></td></tr>`).join('')}</tbody></table></div>`;
}
const docsCount = m => `${docsRows(m).length} of ${m.docs.filter(d => docsManage(m) || (d.versions.some(v => v.state === 'current') && !d.retired)).length} documents`;
/* ---- 39.2: audience, Tasks folder, My Documents, Personnel Files, Designated Person review ---- */
const DOC_AUD = [['pharmacist', 'Pharmacist'], ['pharmacist:lead', 'Pharmacist: Lead'], ['pharmacist:supervisor', 'Pharmacist: Supervisor'], ['pharmacist:immunizer', 'Pharmacist: Immunizer'], ['pharmacist:sterile', 'Pharmacist: Sterile'],
  ['tech', 'Technician'], ['tech:lead', 'Technician: Lead'], ['tech:sterile', 'Technician: Sterile'], ['tech:nonsterile', 'Technician: Nonsterile'],
  ['staff', 'Associate'], ['staff:cashier', 'Associate: Cashier'], ['staff:driver', 'Associate: Driver'], ['staff:warehouse', 'Associate: Warehouse'], ['staff:student', 'Associate: Student']];
const docsAudLabel = k => (DOC_AUD.find(x => x[0] === k) || [k, k])[1];
const docsAudHtml = sel => `<div class="dchecks">${DOC_AUD.map(([k, l]) => `<label><input type="checkbox" data-aud="${k}"${sel.includes(k) ? ' checked' : ''}> ${l}</label>`).join('')}</div><div class="hint">None ticked = everyone. The Pharmacist-In-Charge, the Account Owner and document managers always see it.</div>`;
const docsAudRead = () => [...document.querySelectorAll('[data-aud]:checked')].map(e => e.dataset.aud);
const DOC_ROLE = { pic: 'Pharmacist-In-Charge', pharmacist: 'Pharmacist', tech: 'Technician', staff: 'Associate' }, docsRole = k => DOC_ROLE[k] || '';
const docsFileBtns = (files, act, extra) => (files || []).map(f => `<button class="dlink" data-dact="${act}" data-id="${esc(f.id)}"${extra || ''} title="${esc(f.name)}">${esc(f.name.length > 24 ? f.name.slice(0, 23) + '…' : f.name)}</button>`).join(' ');
const docsRecTable = recs => recs && recs.length ? `<div class="dtw"><table class="dtable"><thead><tr><th>Date</th><th>Record</th><th>Result</th><th>Approved By</th></tr></thead><tbody>${recs.map(r => `<tr><td class="num">${esc(r.date)}</td><td>${esc(r.type)}</td><td>${esc(r.result)}</td><td>${r.approvedBy ? esc(r.approvedBy) : docPill('warn', 'Awaiting')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="hint">None yet.</div>';
function docsTasksHtml(m){
  if(!m.tasks) return '<div class="dempty">Loading…</div>';
  if(!m.tasks.folders.length) return '<div class="dempty">No files are attached to completed tasks yet. Files attached to a task are filed here by task type.</div>';
  return '<div class="dtw">' + m.tasks.folders.map(f => `<div class="dgh">${esc(f.title)} <span class="hint">${f.entries.length}</span></div><table class="dtable"><thead><tr><th>Date</th><th>Performed By</th><th>Completed By</th><th>Result</th><th>Approved By</th><th>Files</th></tr></thead><tbody>${f.entries.map(e => `<tr><td class="num">${esc(e.date)}</td><td>${esc(e.performedBy)}</td><td>${esc(e.completedBy)}</td><td>${esc(e.result)}</td><td>${e.approvedBy ? esc(e.approvedBy) : docPill('warn', e.status === 'returned' ? 'Returned' : 'Awaiting')}</td><td>${docsFileBtns(e.files, 'tfile')}</td></tr>`).join('')}</tbody></table>`).join('') + '</div>';
}
function docsMineHtml(m){
  const x = m.mine; if(!x) return '<div class="dempty">Loading…</div>';
  return `<div class="dtool"><b>My Documents</b><span class="dsp"></span><button class="btn small" data-dact="madd">Add Document</button></div><div class="hint">Private to you. The Pharmacist-In-Charge and the Account Owner can see them in your personnel file.</div>
   <div class="dgh">Uploaded</div>${x.uploads.length ? `<div class="dtw"><table class="dtable"><thead><tr><th>Title</th><th>Kind</th><th>Added</th><th>By</th><th></th></tr></thead><tbody>${x.uploads.map(u => `<tr><td>${esc(u.title)}</td><td>${esc(x.kinds[u.kind] || u.kind)}</td><td class="num">${esc(docsLocal(u.at).slice(0, 10))}</td><td>${esc(u.by)}</td><td><button class="btn2 small" data-dact="mfile" data-id="${esc(u.id)}">Open</button>${u.addedBy ? '' : ` <button class="btn2 small danger" data-dact="mremove" data-id="${esc(u.id)}">Remove</button>`}</td></tr>`).join('')}</tbody></table></div>` : '<div class="hint">Nothing uploaded.</div>'}
   <div class="dgh">License</div><div class="hint">${x.license.number ? `${esc(x.license.number)}${x.license.expires ? ', expires ' + esc(x.license.expires) : ''}` : 'No license on file.'}</div>
   <div class="dgh">Training And Validation Records</div>${docsRecTable(x.records)}`;
}
function docsPersHtml(m){
  const p = m.pers; if(!p) return '<div class="dempty">Loading…</div>';
  if(m.persSel){ const d = m.persSel;
    return `<div class="dtool"><button class="btn2 small" data-dact="perback">Back</button><b>${esc(d.person.name)}</b><span class="dsp"></span>${p.canAdd ? '<button class="btn small" data-dact="padd">Add Material</button>' : ''}</div>
     <div class="hint">${esc(docsRole(d.person.acctType))}${d.person.license ? ' · License ' + esc(d.person.license) : ''}${d.person.licExpires ? ' · Expires ' + esc(d.person.licExpires) : ''}</div>
     <div class="dgh">Documents</div>${d.uploads.length ? `<div class="dtw"><table class="dtable"><thead><tr><th>Title</th><th>Kind</th><th>Added</th><th>By</th><th></th></tr></thead><tbody>${d.uploads.map(u => `<tr><td>${esc(u.title)}</td><td>${esc(u.kind)}</td><td class="num">${esc(docsLocal(u.at).slice(0, 10))}</td><td>${esc(u.by)}</td><td><button class="btn2 small" data-dact="pfile" data-id="${esc(u.id)}" data-p="${esc(d.person.sub)}">Open</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="hint">Nothing uploaded.</div>'}
     <div class="dgh">Training And Validation Records</div>${docsRecTable(d.records)}`; }
  return `<div class="dtw"><table class="dtable"><thead><tr><th>Name</th><th>Role</th><th>License</th><th>Expires</th><th>Designated Person</th>${p.canGrant ? '<th>Personnel Files</th><th>Document Review</th><th>Inspector Link</th>' : ''}</tr></thead><tbody>${p.people.map(x => { const dp = Object.keys(x.dp || {}).filter(k => x.dp[k]); const g = m.grants || { personnel: {}, dpOff: {}, inspector: {} };
    return `<tr class="click" data-dact="persopen" data-id="${esc(x.sub)}"><td>${esc(x.name)}</td><td>${esc(docsRole(x.acctType))}</td><td>${esc(x.license)}</td><td class="num">${esc(x.licExpires)}</td><td>${dp.length ? esc(dp.join(', ')) : ''}</td>${p.canGrant ? `<td><input type="checkbox" data-grant="personnel" data-sub="${esc(x.sub)}"${g.personnel[x.sub] ? ' checked' : ''}${dp.length ? ' checked disabled title="On while a Designated Person box is ticked"' : ''}></td><td>${dp.length ? `<input type="checkbox" data-grant="dpoff" data-sub="${esc(x.sub)}"${g.dpOff[x.sub] ? '' : ' checked'} title="Reviews documents for their chapters">` : ''}</td><td><input type="checkbox" data-grant="inspector" data-sub="${esc(x.sub)}"${(g.inspector || {})[x.sub] ? ' checked' : ''}></td>` : ''}</tr>`; }).join('')}</tbody></table></div>${m.hostlog ? `<div class="dgh">IronLedger Access</div><div class="hint">IronLedger staff have read-only access to the Calendar and, with a privilege, Personnel Files. Every view is listed here.</div>${m.hostlog.length ? `<div class="dtw"><table class="dtable"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead><tbody>${m.hostlog.slice(0, 100).map(e => `<tr><td class="num">${esc(docsLocal(e.at))}</td><td>${esc(e.by)}</td><td>${esc(e.what)}</td><td>${esc(e.detail)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="hint">No IronLedger access yet.</div>'}` : ''}`;
}
const docsAltHtml = m => m.view === 'tasks' ? docsTasksHtml(m) : m.view === 'mine' ? docsMineHtml(m) : m.view === 'insp' ? docsInspHtml(m) : docsPersHtml(m);

const inspBase = () => '/stores/' + encodeURIComponent(STORE.id) + '/inspector';
const inspStamp = ms => docsLocal(new Date(ms).toISOString());
function docsInspHtml(m){
  const x = m.insp; if(!x) return '<div class="dempty">Loading…</div>';
  return `<div class="dtool"><b>Inspector Links</b><span class="dsp"></span><button class="btn small" data-dact="inspnew">New Link</button></div>
   <div class="hint">Read only and time limited. Opens the Dashboard, Task Logs, approved Documents and compliance Personnel data for the period you set. Not a login.</div>
   ${x.links.length ? `<div class="dtw"><table class="dtable"><thead><tr><th>For</th><th>Period</th><th>Sent By</th><th>Sent</th><th>Ends</th><th>Opens</th><th>Documents</th><th>Status</th><th></th></tr></thead><tbody>${x.links.map(l => `<tr><td>${esc(l.label)}</td><td class="num">${esc(l.from)} to ${esc(l.to)}</td><td>${esc(l.by)}</td><td class="num">${esc(docsLocal(l.at).slice(0, 10))}</td><td class="num">${esc(inspStamp(l.expiresAt))}</td><td class="num">${l.opens}</td><td>${l.docs ? 'Yes' : 'Register Only'}</td><td>${docPill({ Active: 'ok', Expired: 'gray', Revoked: 'bad' }[l.state], l.state)}</td><td>${l.state === 'Active' ? `<button class="btn2 small" data-dact="inspext" data-id="${esc(l.id)}">Change Expiry</button> <button class="btn2 small danger" data-dact="insprev" data-id="${esc(l.id)}">Revoke</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="hint">No links sent.</div>'}
   ${x.log ? `<div class="dgh">Access Log</div><div class="hint">Every open, kept permanently.</div>${x.log.length ? `<div class="dtw"><table class="dtable"><thead><tr><th>When</th><th>For</th><th>What</th><th>Detail</th><th>Device</th><th>IP</th></tr></thead><tbody>${x.log.map(e => `<tr><td class="num">${esc(docsLocal(e.at))}</td><td>${esc(e.label)}</td><td>${esc(e.what)}</td><td>${esc(e.detail)}</td><td title="${esc(e.device)}">${esc((e.device || '').slice(0, 40))}</td><td class="num">${esc(e.ip)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="hint">Not opened yet.</div>'}` : ''}`;
}
function docsInspNewModal(){
  docsModal(`<h3>New Inspector Link</h3><div class="dmb"><div class="dfld"><label for="iLbl">Who It Is For</label><input type="text" id="iLbl" maxlength="80" placeholder="Texas State Board of Pharmacy"></div>
   <div class="dg2"><div class="dfld"><label for="iFrom">Report Period From</label><input type="date" id="iFrom" value="${DOCS.today ? docsAddMonths(DOCS.today, -12) : ''}"></div><div class="dfld"><label for="iTo">Report Period To</label><input type="date" id="iTo" value="${DOCS.today}"></div></div>
   <div class="dg2"><div class="dfld"><label for="iDays">Link Ends After (Days)</label><input type="number" id="iDays" min="1" max="30" value="7"></div><div class="dfld"><label>Documents</label><label class="chk"><input type="checkbox" id="iDocs"> Allow Opening Approved Documents</label></div></div>
   <div class="hint">Drafts, voided records, billing, accounts and contacts are never shown.</div></div>
   <div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="iGo">Create Link</button></div>`);
  $('iGo').addEventListener('click', async () => { const label = $('iLbl').value.trim(); if(!label) return docsToast('Enter who it is for.'); busy($('iGo'), true);
    try{ const r = await api('POST', inspBase(), { label, from: $('iFrom').value, to: $('iTo').value, days: $('iDays').value, docs: $('iDocs').checked }), url = location.origin + r.path;
      DOCS.insp = await api('GET', inspBase());
      docsModal(`<h3>Inspector Link</h3><div class="dmb"><div class="hint">Copy it now. For safety it is not shown again.</div><div class="dfld"><input type="text" id="iUrl" readonly value="${esc(url)}" style="width:100%"></div></div>
       <div class="dmf"><button class="btn2" data-dact="closemodal">Close</button><button class="btn" id="iCopy">Copy Link</button></div>`, true);
      $('iCopy').addEventListener('click', async () => { try{ await navigator.clipboard.writeText(url); docsToast('Link copied.'); }catch(e){ $('iUrl').select(); docsToast('Press Ctrl+C to copy.'); } }); docsPaint(); }
    catch(e){ docsErr(e); busy($('iGo'), false); } });
}
function docsInspExpiryModal(id){
  docsModal(`<h3>Change Expiry</h3><div class="dmb"><div class="dfld"><label for="xDays">Link Ends After (Days From Now)</label><input type="number" id="xDays" min="1" max="30" value="7"></div></div><div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="xGo">Save</button></div>`);
  $('xGo').addEventListener('click', async () => { try{ await api('POST', inspBase() + '/' + encodeURIComponent(id) + '/expiry', { days: $('xDays').value }); DOCS.insp = await api('GET', inspBase()); docsCloseModal(); docsPaint(); docsToast('Saved.'); }catch(e){ docsErr(e); } });
}
async function docsInspRevoke(id){ try{ await api('POST', inspBase() + '/' + encodeURIComponent(id) + '/revoke', {}); DOCS.insp = await api('GET', inspBase()); docsPaint(); docsToast('Link revoked.'); }catch(e){ docsErr(e); } }
async function docsView(id){
  DOCS.view = id; if(id === 'docs'){ DOCS.type = 'all'; docsPaint(); return; }
  docsPaint();
  try{
    if(id === 'tasks') DOCS.tasks = await api('GET', docsPath() + '/tasks');
    else if(id === 'mine') DOCS.mine = await api('GET', docsPath() + '/mine');
    else if(id === 'insp') DOCS.insp = await api('GET', '/stores/' + encodeURIComponent(STORE.id) + '/inspector');
    else if(id === 'pers'){ DOCS.pers = await api('GET', docsPath() + '/personnel'); DOCS.persSel = null; DOCS.grants = DOCS.pers.canGrant ? await api('GET', docsPath() + '/grants') : null; DOCS.hostlog = DOCS.pers.canGrant ? (await api('GET', docsPath() + '/hostlog')).log : null; }
  }catch(e){ docsErr(e); DOCS.view = 'docs'; }
  if(DOCS.view === id) docsPaint();
}
async function docsFileOpen(path){
  const w = window.open('', '_blank');
  try{ const r = await api('GET', docsPath() + path); if(!w){ docsToast('Allow pop-ups for this site to open documents.'); return; } w.location = r.url; }catch(e){ if(w) w.close(); docsErr(e); }
}
async function docsPersOpen(sub){ try{ DOCS.persSel = await api('GET', docsPath() + '/personnel/' + encodeURIComponent(sub)); docsPaint(); }catch(e){ docsErr(e); } }
async function docsGrant(what, sub, on){
  try{ await api('POST', docsPath() + '/grants', { what, sub, on: what === 'dpoff' ? !on : on }); DOCS.grants = await api('GET', docsPath() + '/grants'); await docsLoad(); }catch(e){ docsErr(e); docsPaint(); }
}
async function docsMineRemove(id){ try{ await api('POST', docsPath() + '/mine/' + encodeURIComponent(id) + '/remove', {}); DOCS.mine = await api('GET', docsPath() + '/mine'); docsPaint(); docsToast('Removed.'); }catch(e){ docsErr(e); } }
function docsMineAddModal(forPerson){                            // forPerson: the Account Owner adds to someone's personnel file
  const sub = forPerson && DOCS.persSel ? DOCS.persSel.person.sub : '', base = forPerson ? '/personnel/' + encodeURIComponent(sub) : '/mine';
  docsModal(`<h3>${forPerson ? 'Add Material' : 'Add Document'}</h3><div class="dmb"><div class="dwarn">PDF only. Do not upload patient information.</div>
   <div class="dfld"><label for="mFile">PDF File</label><input type="file" id="mFile" accept="application/pdf,.pdf"></div>
   <div class="dg2"><div class="dfld"><label for="mTitle">Title</label><input type="text" id="mTitle" maxlength="200"></div><div class="dfld"><label for="mKind">Kind</label><select id="mKind">${Object.entries({ validation: 'Validation', license: 'License', training: 'Training', scan: 'Uploaded Scan', other: 'Other' }).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div></div></div>
   <div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="mGo">Save</button></div>`);
  $('mFile').addEventListener('change', e => { const f = e.target.files[0]; if(f && !$('mTitle').value) $('mTitle').value = f.name.replace(/\.pdf$/i, '').replace(/_+/g, ' '); });
  $('mGo').addEventListener('click', async () => { const f = $('mFile').files[0], t = $('mTitle').value.trim();
    if(!f) return docsToast('Choose the PDF file.'); if(!/\.pdf$/i.test(f.name)) return docsToast('Only PDF files are accepted.'); if(!t) return docsToast('Enter a title.'); busy($('mGo'), true);
    try{ const up = await docsUpload(f, base + '/upload-url'); await api('POST', docsPath() + base + (forPerson ? '/add' : ''), { title: t, kind: $('mKind').value, file: up }); docsCloseModal();
      if(forPerson) await docsPersOpen(sub); else { DOCS.mine = await api('GET', docsPath() + '/mine'); docsPaint(); } docsToast('Saved.'); }
    catch(e){ docsErr(e); busy($('mGo'), false); } });
}
function docsDpModal(id){
  const d = docOf(id), p = docInfo(d, DOCS).pend;
  docsModal(`<h3>Designated Person Review: ${d.id}</h3><div class="dmb"><div class="hint">${esc(d.title)}, v${esc(p.v)}, chapter ${esc(d.chapter)}. The final approver approves after this review.</div>
   <div class="dfld"><label>Outcome</label><div class="dradios"><label><input type="radio" name="dpo" value="ok" checked> Reviewed, Ready For Final Approval</label><label><input type="radio" name="dpo" value="return"> Return To The Submitter<br><span class="hint">Removes this version. Say what needs to change.</span></label></div></div>
   <div class="dfld"><label for="dpC">Comments</label><textarea id="dpC" maxlength="500"></textarea></div>${docsSignField('Reviewed')}</div>
   <div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="dpGo">Sign And Save</button></div>`);
  $('dpGo').addEventListener('click', () => { const out = document.querySelector('[name=dpo]:checked').value, c = $('dpC').value.trim(); if(out === 'return' && !c) return docsToast('Say what needs to change.');
    const pin = docsPinVal(); if(pin === null) return; busy($('dpGo'), true);
    docsDo('/' + id + '/dpreview', { outcome: out, comment: c, reason: c, pin }, out === 'ok' ? 'Review recorded.' : 'Returned.', () => docsDpModal(id)).then(r => { if(!r) busy($('dpGo'), false); }); });
}
const DOCS_BODY = {
  rail: m => `<div class="drail" data-dz="rail">${docsRailHtml(m)}</div>`,
  tiles: m => `<div data-dz="tiles">${docsTilesHtml(m)}</div>`,
  pins: m => `<div class="dpins" data-dz="pins">${docsPinsHtml(m)}</div>`,
  list: m => m.view !== 'docs' ? `<div data-dz="alt">${docsAltHtml(m)}</div>` : `<div class="dtool">
      <input type="search" data-dq placeholder="Search" value="${esc(m.q)}" aria-label="Search documents">
      ${docsManage(m) ? `<select data-dfs aria-label="Status"><option value="">Status: Any</option>${['Active', 'Draft', 'Under Review', 'Retired'].map(v => `<option${v === m.fstatus ? ' selected' : ''}>${v}</option>`).join('')}</select>` : ''}
      <select data-dff aria-label="Format"><option value="">Format: Any</option>${DOC_FORMATS.map(v => `<option${v === m.fformat ? ' selected' : ''}>${v}</option>`).join('')}</select>
      ${docsApprove(m) ? `<select data-dfr aria-label="Review status"><option value="">Review: Any</option>${['Overdue', 'Due Soon', 'Current', 'No Date'].map(v => `<option${v === m.freview ? ' selected' : ''}>${v}</option>`).join('')}</select>` : ''}
      ${docsManage(m) ? `<label class="chk"><input type="checkbox" data-dret${m.showRetired ? ' checked' : ''}> Show Retired</label>` : ''}
      <span class="dsp"></span>
      ${docsApprove(m) && ME && ME.pinRequired ? '<button class="btn2 small" data-dact="mypin" title="Change your signing PIN">My PIN</button>' : ''}
      ${docsApprove(m) ? '<button class="btn2 small" data-dact="csv" title="Copies the register in the order of Document_Register.xlsx">Copy Register As CSV</button>' : ''}
      ${docsManage(m) ? '<button class="btn small" data-dact="add">Add Document</button>' : ''}</div>
    <div data-dz="chips">${docsChipsHtml(m)}</div><div data-dz="tbl">${docsTableHtml(m)}</div><div class="hint dcount" data-dz="count">${docsCount(m)}</div>`
};
// panels slide up to close the gap when one is hidden (the summary tiles are for approvers only)
function docsLayoutWithout(L, hide){
  const P = {}; for(const k in L.panels) if(!hide.includes(k)) P[k] = L.panels[k].slice();
  const ks = Object.keys(P).sort((a, b) => P[a][1] - P[b][1] || P[a][0] - P[b][0]), hit = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
  for(const k of ks){ while(P[k][1] > 1){ P[k][1]--; if(ks.some(q => q !== k && hit(P[k], P[q]))){ P[k][1]++; break; } } }
  return { v: 2, cols: LAYOUT_COLS, panels: P };
}
function docsHtml(m, c){
  const hide = [...(docsApprove(m) && m.view === 'docs' ? [] : ['tiles']), ...(m.pins.length ? [] : ['pins'])], pg = Object.assign({}, DOCS_PAGE, { panels: DOCS_PANELS.filter(p => !hide.includes(p[0])) });
  const base = c && c.panels ? { v: 2, cols: LAYOUT_COLS, panels: c.panels } : (layoutOk(DOCS_PAGE, DOCS_LAYOUT) ? DOCS_LAYOUT : null);
  return layoutGridHtml(pg, base ? docsLayoutWithout(base, hide) : undefined, id => DOCS_BODY[id](m));
}
const DOCS_SAMPLE_MODEL = () => {
  const m = docsNewModel(), t = '2026-11-18', ago = n => { const d = new Date(Date.UTC(2026, 10, 18 - n)); return d.toISOString().slice(0, 10); };
  const V = (v, state, eff, o) => Object.assign({ v, state, effective: eff, at: eff || t, summary: 'Initial Release', by: 'Pat Owner', approvedBy: 'Pat Owner', hasFile: true }, o || {});
  const D = (id, title, o) => Object.assign({ id, title, type: id.slice(0, 3), area: id.slice(4, 7), sub: '', format: 'Printable PDF', cycle: 12, basis: 'Internal Policy', notes: '', underReview: false, retired: false, lastReviewed: '', reviews: [], versions: [] }, o);
  m.duty = 'owner'; m.today = t; m.pharmacy = 'NorTex Pharmacy - Haslet'; m.pins = ['FRM-IMM-001'];
  m.docs = [D('POL-OPS-001', 'Policy And Procedure Manual Overview', { lastReviewed: ago(120), versions: [V('1.0', 'current', ago(300))] }),
    D('SOP-CSA-001', 'Controlled Substance Receiving And Storage', { lastReviewed: ago(372), versions: [V('1.0', 'current', ago(380))] }),
    D('FRM-IMM-001', 'Vaccine Consent And Screening - General', { format: 'Fillable PDF', lastReviewed: ago(20), versions: [V('1.0', 'current', ago(20))] }),
    D('MFR-NSC-001', 'Hydroquinone Cream (Example Product)', { lastReviewed: ago(90), versions: [V('1.0', 'superseded', ago(240)), V('1.1', 'current', ago(90)), V('1.2', 'pending', '', { summary: 'Updated wording', approvedBy: '' })] }),
    D('SOP-HDR-001', 'Hazardous Drug Handling And Spill Response', { versions: [V('1.0', 'pending', '', { approvedBy: '' })] }),
    D('LOG-OPS-002', 'Delivery Log', { lastReviewed: ago(335), versions: [V('1.0', 'current', ago(350))], underReview: true }),
    D('SOP-OPS-002', 'Will-Call Procedure (Legacy)', { retired: true, lastReviewed: ago(600), versions: [V('1.0', 'current', ago(900))] })];
  return m;
};

/* ---------------- live page: loads, refreshes and acts ---------------- */
let DOCS = docsNewModel(), DOCS_STORE = '';
const dzq = s => document.querySelector('#docsRoot ' + s);
const docOf = id => DOCS.docs.find(d => d.id === id);
const docsPath = () => '/stores/' + encodeURIComponent(STORE.id) + '/documents';
const docsOK = () => !!(ME && STORE && STORE.documents === true && PERM('documents'));
function docsPaint(){                                            // the whole page (after loading, or when something changed that touches several panels)
  const r = $('docsRoot'); if(!r) return;
  r.innerHTML = docsHtml(DOCS, {}); docsHook();
}
function docsHook(){ const q = dzq('[data-dq]'); if(q) q.addEventListener('input', e => { DOCS.q = e.target.value; docsUpdate(); }); }
function docsUpdate(){                                           // refresh only the regions that depend on the data or filters
  if(!dzq('[data-dz]')) return;
  const set = (z, h) => { const e = dzq(`[data-dz="${z}"]`); if(e) e.innerHTML = h; };
  set('rail', docsRailHtml(DOCS)); set('tiles', docsTilesHtml(DOCS)); set('pins', docsPinsHtml(DOCS)); set('chips', docsChipsHtml(DOCS)); set('tbl', docsTableHtml(DOCS)); set('count', docsCount(DOCS));
}
async function docsLoad(){
  if(!docsOK()) return;
  const id = STORE.id; $('docsMsg').textContent = DOCS.loaded && DOCS_STORE === id ? '' : 'Loading…';
  try{
    const r = await api('GET', docsPath());
    if(!STORE || STORE.id !== id) return;
    const keep = DOCS_STORE === id ? DOCS : docsNewModel();
    DOCS = Object.assign(keep, { duty: r.duty, today: r.today, docs: r.docs, pins: r.pins, log: r.log || [], pharmacy: r.pharmacy, maxMb: r.maxMb, tasksOK: !!r.tasksOK, persOK: !!r.persOK, persAdd: !!r.persAdd, boss: !!r.boss, inspOK: !!r.inspOK, dpChapters: r.dpChapters || [], final: !!r.final, loaded: true }); DOCS_STORE = id;
    $('docsMsg').textContent = ''; docsPaint(); if(DOCS.open && docOf(DOCS.open)) docsDrawer(DOCS.open); else if(DOCS.open) docsCloseDrawer();
  }catch(e){ if(!e.auth) $('docsMsg').textContent = e.message; }
}
function docsShow(){ if(!docsOK()) return; if(!DOCS.loaded || DOCS_STORE !== STORE.id || Date.now() - (DOCS.at || 0) > 60000){ DOCS.at = Date.now(); docsLoad(); } }
function docsPaintTab(){                                         // called whenever the pharmacy or the person changes
  const tab = document.querySelector('#tabs [data-tab="documents"]'); if(!tab) return;
  const ok = docsOK(); tab.style.display = ok ? '' : 'none';
  if(!ok || (DOCS_STORE && STORE && DOCS_STORE !== STORE.id)){ DOCS = docsNewModel(); DOCS_STORE = ''; const r = $('docsRoot'); if(r) r.innerHTML = ''; docsCloseDrawer(); docsCloseModal();
    if(!ok && tab.classList.contains('active')) homeTab(); }
}
const docsToast = t => { const e = $('docsToast'); e.textContent = t; e.style.display = ''; clearTimeout(docsToast.t); docsToast.t = setTimeout(() => e.style.display = 'none', 3200); };
function docsModal(html, wide){ const o = $('docsOv'); o.innerHTML = `<div class="dov" data-dov><div class="dmodal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`; const f = o.querySelector('[autofocus],input:not([type=hidden]),select,textarea'); if(f) f.focus(); }
const docsCloseModal = () => { const o = $('docsOv'); if(o) o.innerHTML = ''; };
const docsCloseCtx = () => { const c = document.getElementById('dctx'); if(c) c.remove(); };
const docsErr = e => { if(!e.auth) docsToast(e.message); };
async function docsDo(path, body, done, redo){                   // one action on a document; the page reloads from the server afterwards so everyone sees the same thing
  try{ const r = await api('POST', docsPath() + path, body || {}); docsCloseModal(); await docsLoad(); if(done) docsToast(done); return r; }
  catch(e){
    if(e.pin === 'pin-not-set' || e.pin === 'pin-temp'){ docsPinModal(e.pin === 'pin-temp' ? 'temp' : 'set', redo); return null; }
    docsErr(e); return null;
  }
}
/* ---- signing: approve, review, reject, retire and restore need the person's own 4-digit PIN. The server checks it, stamps the initials and
   employee ID, and locks the PIN after 5 wrong tries. ---- */
const docsSignField = what => !(ME && ME.pinRequired) ? `<div class="dfld"><div class="hint">${ME && ME.initials ? `Signs this as ${esc(ME.initials)} (${esc(what)}).` : 'Your initials are not set yet. Ask the Account Owner.'}</div></div>` : `<div class="dfld"><label for="sPin">Your PIN</label><input type="password" id="sPin" inputmode="numeric" autocomplete="off" maxlength="4" style="max-width:110px;letter-spacing:.3em;"><div class="hint">${ME && ME.initials ? `Signs this as ${esc(ME.initials)} (${esc(what)}).` : 'Your initials are not set yet. Ask the Account Owner.'}</div></div>`;
const docsPinVal = () => { if(!(ME && ME.pinRequired)) return ''; const v = ($('sPin') || {}).value || ''; if(!/^\d{4}$/.test(v)){ docsToast('Enter your 4-digit PIN.'); return null; } return v; };
function docsPinModal(mode, redo){                               // mode: set (first time), temp (replace the temporary one), change (know the current one)
  const cur = mode !== 'set';
  docsModal(`<h3>${mode === 'change' ? 'Change Your PIN' : 'Choose Your PIN'}</h3><div class="dmb">
    <div class="hint">${mode === 'temp' ? 'Enter the temporary PIN you were given, then choose your own.' : mode === 'change' ? 'Enter your current PIN, then the new one.' : 'A 4-digit code only you know. It signs your approvals and reviews. Not 1234 or 1111.'} Never share it.</div>
    ${cur ? `<div class="dfld"><label for="pCur">${mode === 'temp' ? 'Temporary PIN' : 'Current PIN'}</label><input type="password" id="pCur" inputmode="numeric" autocomplete="off" maxlength="4" style="max-width:110px;letter-spacing:.3em;"></div>` : ''}
    <div class="dg2"><div class="dfld"><label for="pNew">New PIN</label><input type="password" id="pNew" inputmode="numeric" autocomplete="off" maxlength="4" style="letter-spacing:.3em;"></div>
    <div class="dfld"><label for="pNew2">Repeat New PIN</label><input type="password" id="pNew2" inputmode="numeric" autocomplete="off" maxlength="4" style="letter-spacing:.3em;"></div></div></div>
   <div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="pSave">Save PIN</button></div>`);
  $('pSave').addEventListener('click', async () => {
    const n = $('pNew').value, n2 = $('pNew2').value, c = cur ? $('pCur').value : '';
    if(cur && !/^\d{4}$/.test(c)) return docsToast('Enter the ' + (mode === 'temp' ? 'temporary' : 'current') + ' PIN.');
    if(!/^\d{4}$/.test(n)) return docsToast('The new PIN is 4 digits.'); if(n !== n2) return docsToast('The two new PINs do not match.');
    busy($('pSave'), true);
    try{ await api('POST', '/me/pin', { pin: n, current: c }); if(ME) ME.pin = 'set'; docsCloseModal(); docsToast('PIN saved.'); if(redo) redo(); }
    catch(e){ busy($('pSave'), false); docsErr(e); }
  });
}
/* ---- opening and printing the PDF. The link is short-lived and comes from the server; the stored file is never public. ---- */
async function docsOpen(id, v, stamp){
  const w = window.open('', '_blank');                           // opened now, while the click is still fresh, so the browser doesn't block it
  try{
    const qs = [v ? 'v=' + encodeURIComponent(v) : '', stamp ? 'print=1' : ''].filter(Boolean).join('&');
    const r = await api('GET', docsPath() + '/' + encodeURIComponent(id) + '/file' + (qs ? '?' + qs : ''));
    if(!w){ docsToast('Allow pop-ups for this site to open documents.'); return; }
    if(stamp) await docsStampOpen(w, r, id); else w.location = r.url;
  }catch(e){ if(w) w.close(); docsErr(e); }
}
function docsAsset(src){ return new Promise((ok, no) => { if(document.querySelector(`script[data-asset="${src}"]`)) return ok(); const s = document.createElement('script'); s.src = src; s.dataset.asset = src; s.onload = ok; s.onerror = () => no(new Error('Could not load the print tools.')); document.head.appendChild(s); }); }
async function docsStampOpen(w, r, id){                           // "Print Copy": the same PDF with the footer stamp on every page (Doc ID, version, effective date)
  const d = docOf(id), i = docInfo(d, DOCS), v = d.versions.find(x => x.v === r.v);
  if(!v || v.state !== 'current'){ w.location = r.url; docsToast('Only the current version is stamped. Opening it without a stamp.'); return; }
  await docsAsset('pdf-lib.min.js');
  const bytes = await (await fetch(r.url)).arrayBuffer(), pdf = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: false }), font = await pdf.embedFont(PDFLib.StandardFonts.Courier);
  const text = `${d.id}  |  v${v.v}  |  Effective ${v.effective}  |  Printed ${docsLocal(r.printedAt)} by ${r.initials}`;   // time = the server's, shown in the pharmacy's time zone
  for(const pg of pdf.getPages()){ const { width } = pg.getSize(), size = Math.min(7.5, (width - 72) / font.widthOfTextAtSize(text, 1));
    pg.drawLine({ start: { x: 36, y: 26 }, end: { x: width - 36, y: 26 }, thickness: 0.5, color: PDFLib.rgb(0.55, 0.55, 0.55) });
    pg.drawText(text, { x: 36, y: 15, size, font, color: PDFLib.rgb(0.25, 0.25, 0.25) }); }
  w.location = URL.createObjectURL(new Blob([await pdf.save()], { type: 'application/pdf' }));
}
/* ---- the detail drawer ---- */
function docsCloseDrawer(){ DOCS.open = ''; const r = $('docsDrawer'); if(r) r.innerHTML = ''; }
function docsDrawer(id){
  const d = docOf(id); if(!d){ docsCloseDrawer(); return; }
  DOCS.open = id; const m = DOCS, i = docInfo(d, m), man = docsManage(m), appr = docsApprove(m), pn = m.pins.includes(id), area = DOC_AREA_LIST.find(x => x.code === d.area);
  const dis = (ok, why) => ok ? '' : ` disabled title="${esc(why)}"`;
  const apprOk = appr && (!d.dpStep || (m.final && i.pend && (i.pend.dpReview || m.dpChapters.includes(d.chapter)))), apprWhy = !appr ? 'Owner, Pharmacist-In-Charge or Designated Person only' : (d.dpStep && !m.final ? 'Final approval is for the final approver' : 'Waiting for the Designated Person review');
  const vrows = d.versions.slice().reverse().map(v => `<tr><td class="num">v${esc(v.v)}</td><td>${v.state === 'current' ? docPill('ok', 'Current') : v.state === 'pending' ? docPill('warn', 'Pending Approval') : docPill('gray', 'Superseded')}</td><td class="num">${v.effective || '-'}</td><td>${esc(v.by || '-')}</td><td>${esc(v.approvedBy || '-')}${v.approvedIni ? ' (' + esc(v.approvedIni) + ')' : ''}${v.selfApproved ? ' ' + docPill('warn', 'Self-approved') : ''}</td><td title="${esc(v.summary)}">${esc(v.summary)}</td><td><button class="btn2 small" data-dact="openv" data-id="${id}" data-v="${esc(v.v)}"${v.hasFile ? '' : ' disabled'}>Open</button></td></tr>`).join('');
  const rrows = (d.reviews || []).slice().reverse().map(r => `<tr><td class="num">${r.at}</td><td>${esc(r.by)}${r.ini ? ' (' + esc(r.ini) + ')' : ''}</td><td>${esc(r.outcome)}</td><td title="${esc(r.comment)}">${esc(r.comment)}</td></tr>`).join('') || '<tr><td colspan="4" class="hint">No review recorded yet.</td></tr>';
  const act = (m.log || []).filter(l => l.docId === id).slice(0, 8).map(l => `<tr><td class="num">${esc(docsLocal(l.at))}</td><td>${esc(l.by)}${l.ini ? ' (' + esc(l.ini) + (l.emp ? ' ' + esc(l.emp) : '') + ')' : ''}</td><td>${esc(l.action)}${l.flag ? ' ' + docPill('warn', l.flag) : ''}</td><td title="${esc(l.detail)}">${esc(l.detail)}</td></tr>`).join('') || '<tr><td colspan="4" class="hint">No activity yet.</td></tr>';
  const stampTxt = i.cur ? `${d.id}  |  v${i.cur.v}  |  Effective ${i.cur.effective}  |  Printed [date and time] by [initials]` : '';
  $('docsDrawer').innerHTML = `<div class="dov dright" data-ddov><aside class="ddrawer" role="dialog" aria-modal="true" aria-label="Document details">
   <div class="ddh"><div class="drow"><span class="num hint">${d.id}</span><span class="dsp"></span><button class="btn2 small" data-dact="closedrawer">Close</button></div>
    <h2>${esc(d.title)}</h2><div class="drow">${man ? docStatusPill(i.status) : ''}${appr && i.r !== 'n/a' ? docReviewPill(i.r) : ''}${docFormatPill(d.format)}${docPill('gray', DOC_TY[d.type].n)}${i.pend && man ? docPill('warn', 'v' + i.pend.v + ' Awaiting Approval') : ''}</div>
    <div class="drow dacts">
     <button class="btn small" data-dact="openv" data-id="${id}"${i.cur || man ? '' : ' disabled'}>${d.format === 'Fillable PDF' ? 'Open Form' : 'Open'}</button>
     <button class="btn2 small" data-dact="printv" data-id="${id}"${i.cur ? '' : ' disabled'} title="The current version with the footer stamp on every page">Print Copy</button>
     <button class="btn2 small" data-dact="pin" data-id="${id}">${pn ? '★ Unpin' : '☆ Pin'}</button>
     ${d.chapter && i.pend && !i.pend.dpReview && m.dpChapters.includes(d.chapter) ? `<button class="btn small" data-dact="dpreview" data-id="${id}">Designated Person Review</button>` : ''}
     ${man ? `<button class="btn2 small" data-dact="review" data-id="${id}"${dis(appr && (i.status === 'Active' || i.status === 'Under Review'), appr ? 'Only Active documents can be reviewed' : 'Owner, Pharmacist-In-Charge or Designated Person only')}>Mark Reviewed</button>
     <button class="btn2 small" data-dact="newver" data-id="${id}"${dis(!i.pend && i.status !== 'Retired' && i.status !== 'Draft', i.pend ? 'A version is already waiting for approval' : 'Not available for this status')}>Upload New Version</button>
     ${i.pend ? `<button class="btn small" data-dact="approve" data-id="${id}"${dis(apprOk, apprWhy)}>Approve v${esc(i.pend.v)}</button><button class="btn2 small danger" data-dact="reject" data-id="${id}"${dis(appr, 'Owner, Pharmacist-In-Charge or Designated Person only')}>Reject</button>` : ''}
     <button class="btn2 small" data-dact="edit" data-id="${id}">Edit Details</button>
     ${i.status === 'Retired' ? `<button class="btn2 small" data-dact="restore" data-id="${id}"${dis(appr, 'Owner, Pharmacist-In-Charge or Designated Person only')}>Restore</button>` : `<button class="btn2 small danger" data-dact="retire" data-id="${id}"${dis(appr && i.status !== 'Draft', 'Owner, Pharmacist-In-Charge or Designated Person only')}>Retire</button>`}` : ''}</div></div>
   <div class="ddbody">
    <section class="pnl"><h4 class="pt">Details</h4><div class="pb"><dl class="dkv">
      <dt>Type</dt><dd>${DOC_TY[d.type].n}</dd><dt>File Type</dt><dd>${d.format}</dd>
      <dt>Program Area</dt><dd>${area.n} ${esc(area.name)}</dd><dt>Version</dt><dd class="num">${i.version ? 'v' + esc(i.version) : '-'}${i.cur ? '' : ' (not approved)'}</dd><dt>Effective Date</dt><dd class="num">${i.effective || '-'}</dd>
      ${appr ? `<dt>Last Reviewed</dt><dd class="num">${d.lastReviewed || '-'}</dd><dt>Review Cycle</dt><dd>${d.cycle ? d.cycle + ' months' : 'None'}</dd><dt>Next Review Due</dt><dd><span class="num">${i.next || '-'}</span> ${i.next && i.r !== 'n/a' ? `<span class="hint">${docDueText(i)}</span>` : ''}</dd>` : ''}
      ${d.chapter ? `<dt>Chapter</dt><dd>${esc(d.chapter)}${i.pend && d.dpStep ? (i.pend.dpReview ? ` (reviewed by ${esc(i.pend.dpReview.by)})` : ' (waiting for review)') : ''}</dd>` : ''}
      ${man ? `<dt>Regulatory Basis</dt><dd>${esc(d.basis || '-')}</dd>${d.chapter ? '' : '<dt>Chapter</dt><dd>None</dd>'}<dt>Who Can See It</dt><dd>${(d.audience || []).length ? esc(d.audience.map(docsAudLabel).join(', ')) : 'Everyone'}</dd>` : ''}
      <dt>Print Footer Stamp</dt><dd>${i.cur ? `<div class="dstamp">${esc(stampTxt)}</div>` : '<span class="hint">Applied when the version is approved.</span>'}</dd>
      ${man ? `<dt>File Path</dt><dd class="num dsmall">${esc(docPathOf(d, i.version || '1.0'))}</dd>${d.notes ? `<dt>Notes</dt><dd>${esc(d.notes)}</dd>` : ''}` : ''}</dl></div></section>
    ${man ? `<section class="pnl"><h4 class="pt">Versions</h4><div class="dtw"><table class="dtable"><thead><tr><th>Version</th><th>State</th><th>Effective</th><th>Submitted By</th><th>Approved By</th><th>Change Summary</th><th></th></tr></thead><tbody>${vrows}</tbody></table></div></section>` : ''}
    ${appr ? `<section class="pnl"><h4 class="pt">Review History</h4><div class="dtw"><table class="dtable"><thead><tr><th>Date</th><th>Reviewed By</th><th>Outcome</th><th>Comments</th></tr></thead><tbody>${rrows}</tbody></table></div></section>
    <section class="pnl"><h4 class="pt">Activity</h4><div class="dtw"><table class="dtable"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead><tbody>${act}</tbody></table></div></section>
    <section class="pnl"><h4 class="pt">Compliance Calendar Link</h4><div class="pb"><dl class="dkv"><dt>Calendar Track</dt><dd class="num">doc-review|${d.id}</dd><dt>Repeats</dt><dd>${d.cycle ? `Rolling: next due is the last review plus ${d.cycle} months` : 'No review cycle set'}</dd><dt>Status</dt><dd class="hint">Not connected to the Calendar tab yet.</dd></dl></div></section>` : ''}
   </div></aside></div>`;
}
/* ---- right-click / ⋯ menu ---- */
function docsMenu(id, x, y){
  docsCloseCtx(); const d = docOf(id); if(!d) return; const m = DOCS, i = docInfo(d, m), man = docsManage(m), a = docsApprove(m), pn = m.pins.includes(id);
  const up = i.cur || i.pend, due = i.next ? `<span class="num">${i.next}</span>${a && i.r !== 'n/a' ? ' ' + docReviewPill(i.r) : ''}` : (i.status === 'Draft' ? '<span class="hint">Not yet active</span>' : '<span class="hint">None</span>');
  const el = document.createElement('div'); el.id = 'dctx'; el.className = 'dctx'; el.setAttribute('role', 'menu');
  el.innerHTML = `<div class="dctxh"><span class="num hint">${d.id}</span><div class="dctxt">${esc(d.title)}</div></div>
   <dl class="dkv dctxkv"><dt>Uploaded</dt><dd class="num">${up ? (up.at || up.effective || '-') : '-'}</dd><dt>Version</dt><dd class="num">${i.version ? 'v' + esc(i.version) : '-'}${i.cur ? '' : ' (not approved)'}</dd><dt>Type</dt><dd>${DOC_TY[d.type].n}</dd><dt>File Type</dt><dd>${d.format}</dd>${a ? `<dt>Update Due</dt><dd>${due}</dd>` : ''}</dl>
   <div class="dctxsep"></div>
   <button role="menuitem" class="dctxi" data-dact="openv" data-id="${id}"${i.cur || man ? '' : ' disabled'}>Open<span class="hint">Double-click</span></button>
   <button role="menuitem" class="dctxi" data-dact="printv" data-id="${id}"${i.cur ? '' : ' disabled'}>Print Copy</button>
   <button role="menuitem" class="dctxi" data-dact="detail" data-id="${id}">Document Details</button>
   <button role="menuitem" class="dctxi" data-dact="pin" data-id="${id}">${pn ? 'Unpin From Quick Access' : 'Pin To Quick Access'}</button>
   ${man && !i.pend && i.status !== 'Retired' && i.status !== 'Draft' ? `<button role="menuitem" class="dctxi" data-dact="newver" data-id="${id}">Upload New Version</button>` : ''}
   ${a && (i.status === 'Active' || i.status === 'Under Review') ? `<button role="menuitem" class="dctxi" data-dact="review" data-id="${id}">Mark Reviewed</button>` : ''}
   ${a && i.pend ? `<button role="menuitem" class="dctxi" data-dact="approve" data-id="${id}">Approve v${esc(i.pend.v)}</button>` : ''}`;
  $('panel-documents').appendChild(el);
  const w = el.offsetWidth, h = el.offsetHeight; el.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px'; el.style.top = Math.max(8, Math.min(y, innerHeight - h - 8)) + 'px';
  const f = el.querySelector('.dctxi:not([disabled])'); if(f) f.focus();
}
/* ---- windows ---- */
const dOpts = (list, sel, fn) => list.map(x => { const v = fn ? fn(x)[0] : x, l = fn ? fn(x)[1] : x; return `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`; }).join('');
const dBump = (v, kind) => { const [a, b] = v.split('.').map(Number); return kind === 'major' ? (a + 1) + '.0' : a + '.' + (b + 1); };
async function docsUpload(file, path){                           // asks for a one-time upload link, then sends the file straight to private storage
  const r = await api('POST', docsPath() + (path || '/upload-url'), { name: file.name, size: file.size });
  let put; try{ put = await fetch(r.url, { method: 'PUT', headers: r.headers, body: file }); }catch(e){ throw new Error('The file could not be sent. Check the internet and try again.'); }
  if(!put.ok) throw new Error('The file could not be stored (' + put.status + '). Try again.');
  return { key: r.key, name: file.name };
}
async function docsDetectFillable(file){ try{ const t = new TextDecoder('latin1').decode(new Uint8Array(await file.arrayBuffer())); return /\/AcroForm/.test(t); }catch(e){ return null; } }
function docsAddModal(){
  docsModal(`<h3>Add Document</h3><div class="dmb">
   <div class="dwarn">Blank masters only. Do not upload anything containing patient information.</div>
   <div class="dfld"><label for="aFile">PDF File</label><input type="file" id="aFile" accept="application/pdf,.pdf"><div class="hint" id="aDet">Fillable form fields are detected automatically. Up to ${DOCS.maxMb || 25} MB.</div></div>
   <div class="dg2"><div class="dfld"><label for="aType">Document Type</label><select id="aType">${DOC_TYPE_LIST.map(t => `<option value="${t.c}">${t.n}</option>`).join('')}</select></div>
   <div class="dfld"><label for="aArea">Program Area</label><select id="aArea"></select></div></div>
   <div class="dfld" id="aSubWrap" style="display:none"><label for="aSub">Folder</label><select id="aSub"></select></div>
   <div class="dfld"><label for="aTitle">Title</label><input type="text" id="aTitle" maxlength="200" placeholder="Vaccine Consent And Screening - General"></div>
   <div class="dg2"><div class="dfld"><label for="aFmt">Format</label><select id="aFmt">${dOpts(DOC_FORMATS)}</select></div><div class="dfld"><label for="aVer">Version</label><input type="text" id="aVer" value="1.0"></div></div>
   <div class="dg2"><div class="dfld"><label for="aCyc">Review Cycle (Months)</label><input type="number" id="aCyc" min="0" max="120" value="12"><div class="hint">0 = no review cycle.</div></div>
   <div class="dfld"><label for="aBas">Regulatory Basis</label><input type="text" id="aBas" maxlength="200" placeholder="Internal Policy"></div></div>
   <div class="dg2"><div class="dfld"><label for="aChap">Chapter</label><select id="aChap">${dOpts(['', '795', '797', '800'], '', x => [x, x || 'None'])}</select><div class="hint">A Designated Person for the chapter reviews first.</div></div></div>
   <div class="dfld"><label>Who Can See It</label>${docsAudHtml([])}</div>
   <div class="dfld"><label>Will Be Saved As</label><div class="dpath" id="aPath"></div></div>
  </div><div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="aGo">Add As Draft</button></div>`, true);
  const g = id => $(id), nextN = (t, a) => { const p = t + '-' + a + '-', ns = DOCS.docs.filter(d => d.id.startsWith(p)).map(d => +d.id.slice(-3)); return p + String((ns.length ? Math.max(...ns) : 0) + 1).padStart(3, '0'); };
  const refresh = () => { const t = g('aType').value, tt = DOC_TY[t], ar = g('aArea').value || 'OPS', tsub = tt.sub && !DOC_CMPA.includes(tt.sub[0]); g('aSubWrap').style.display = tsub ? '' : 'none';
    if(tsub && g('aSub').dataset.t !== t){ g('aSub').innerHTML = dOpts(tt.sub); g('aSub').dataset.t = t; }
    g('aPath').textContent = docPathOf({ id: nextN(t, ar), title: g('aTitle').value || 'Title', type: t, area: ar, sub: tsub ? g('aSub').value : '' }, g('aVer').value || '1.0'); };
  const fillAreas = () => { const t = g('aType').value, limited = DOC_TY[t].sub && DOC_CMPA.includes(DOC_TY[t].sub[0]), cur = g('aArea').value;
    g('aArea').innerHTML = DOC_AREA_LIST.filter(a => !limited || DOC_CMPA.includes(a.code)).map(a => `<option value="${a.code}"${a.code === cur ? ' selected' : ''}>${a.n} ${esc(a.name)}</option>`).join(''); refresh(); };
  g('aType').addEventListener('change', fillAreas); fillAreas(); ['aArea', 'aSub', 'aTitle', 'aVer'].forEach(k => g(k).addEventListener('input', refresh));
  let file = null;
  g('aFile').addEventListener('change', async e => { file = e.target.files[0] || null; if(!file) return;
    if(!/\.pdf$/i.test(file.name)){ g('aDet').textContent = 'This is not a PDF. Only PDF files are accepted.'; file = null; return; }
    if(file.size > (DOCS.maxMb || 25) * 1048576){ g('aDet').textContent = 'That file is too big.'; file = null; return; }
    const fill = await docsDetectFillable(file); if(fill !== null){ g('aFmt').value = fill ? 'Fillable PDF' : 'Printable PDF'; g('aDet').textContent = fill ? 'Detected: fillable form fields found.' : 'Detected: no form fields. Set to Printable.'; }
    if(!g('aTitle').value) g('aTitle').value = file.name.replace(/\.pdf$/i, '').replace(/_+/g, ' '); refresh(); });
  g('aGo').addEventListener('click', async () => {
    const title = g('aTitle').value.trim(); if(!file) return docsToast('Choose the PDF file.'); if(!title) return docsToast('Enter a title.'); if(!/^\d+\.\d+$/.test(g('aVer').value.trim())) return docsToast('Version must look like 1.0.');
    const t = g('aType').value, tt = DOC_TY[t], btn = g('aGo'); busy(btn, true);
    try{ const f = await docsUpload(file);
      const r = await api('POST', docsPath(), { title, type: t, area: g('aArea').value, sub: tt.sub && !DOC_CMPA.includes(tt.sub[0]) ? g('aSub').value : '', format: g('aFmt').value, version: g('aVer').value.trim(), cycle: g('aCyc').value, basis: g('aBas').value.trim(), chapter: g('aChap').value, audience: docsAudRead(), file: f });
      docsCloseModal(); DOCS.open = r.id; await docsLoad(); docsToast(r.id + ' added as a draft. Approve it to make it Active.');
    }catch(e){ docsErr(e); busy(btn, false); }
  });
}
function docsReviewModal(id){
  const d = docOf(id), i = docInfo(d, DOCS);
  docsModal(`<h3>Mark Reviewed: ${d.id}</h3><div class="dmb"><div class="hint">${esc(d.title)} (v${esc(i.version)}). Next review is ${i.next || 'not set'}.</div>
   <div class="dfld"><label>Outcome</label><div class="dradios"><label><input type="radio" name="out" value="ok" checked> Reviewed, No Changes Needed<br><span class="hint">Resets the review clock. The version does not change.</span></label>
   <label><input type="radio" name="out" value="chg"> Reviewed, Changes Needed<br><span class="hint">Sets the status to Under Review. Upload a new version to finish.</span></label></div></div>
   <div class="dg2"><div class="dfld"><label for="rDate">Review Date</label><input type="date" id="rDate" value="${DOCS.today}" max="${DOCS.today}"></div><div class="dfld"><label>Reviewed By</label><div class="dro">${esc(ME.name || ME.login)}</div></div></div>
   <div class="dfld"><label for="rCom">Comments</label><textarea id="rCom" maxlength="500"></textarea><div class="hint" id="rHint">Optional.</div></div>${docsSignField('Reviewed')}</div>
   <div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="rGo">Sign And Save Review</button></div>`);
  document.querySelectorAll('[name=out]').forEach(r => r.addEventListener('change', () => { $('rHint').textContent = document.querySelector('[name=out]:checked').value === 'chg' ? 'Required: say what needs to change.' : 'Optional.'; }));
  $('rGo').addEventListener('click', () => { const out = document.querySelector('[name=out]:checked').value, com = $('rCom').value.trim();
    if(out === 'chg' && !com) return docsToast('Say what needs to change.'); const pin = docsPinVal(); if(pin === null) return; busy($('rGo'), true);
    docsDo('/' + id + '/review', { outcome: out, date: $('rDate').value, comment: com, pin }, 'Review recorded for ' + id, () => docsReviewModal(id)).then(r => { if(!r) busy($('rGo'), false); }); });
}
function docsNewVerModal(id){
  const d = docOf(id), i = docInfo(d, DOCS);
  docsModal(`<h3>Upload New Version: ${d.id}</h3><div class="dmb"><div class="hint">Current version is v${esc(i.version)}. The new version waits for approval; the current one stays in use until then.</div>
   <div class="dwarn">Blank masters only. No patient information.</div>
   <div class="dfld"><label for="nFile">PDF File</label><input type="file" id="nFile" accept="application/pdf,.pdf"></div>
   <div class="dfld"><label>Kind Of Change</label><div class="dradios"><label><input type="radio" name="kind" value="minor" checked> Minor: wording or formatting only</label><label><input type="radio" name="kind" value="major"> Major: content or requirements changed</label></div></div>
   <div class="dg2"><div class="dfld"><label for="nVer">New Version</label><input type="text" id="nVer" value="${dBump(i.version, 'minor')}"></div><div class="dfld"><label>Submitted By</label><div class="dro">${esc(ME.name || ME.login)}</div></div></div>
   <div class="dfld"><label for="nSum">Change Summary</label><textarea id="nSum" maxlength="300"></textarea><div class="hint">Required. Appears in the version history.</div></div>
   <div class="dpath" id="nPath"></div></div>
   <div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="nGo">Submit For Approval</button></div>`);
  const upd = () => { $('nPath').textContent = docPathOf(d, $('nVer').value || '?'); }; upd();
  document.querySelectorAll('[name=kind]').forEach(r => r.addEventListener('change', () => { $('nVer').value = dBump(i.version, r.value); upd(); })); $('nVer').addEventListener('input', upd);
  $('nGo').addEventListener('click', async () => { const v = $('nVer').value.trim(), sum = $('nSum').value.trim(), f = $('nFile').files[0];
    if(!f) return docsToast('Choose the PDF file.'); if(!/\.pdf$/i.test(f.name)) return docsToast('Only PDF files are accepted.'); if(!/^\d+\.\d+$/.test(v)) return docsToast('Version must look like 1.1.');
    if(d.versions.some(x => x.v === v)) return docsToast('That version number already exists.'); if(!sum) return docsToast('Enter a change summary.');
    busy($('nGo'), true); try{ const up = await docsUpload(f); const r = await docsDo('/' + id + '/version', { version: v, summary: sum, file: up }, 'v' + v + ' is waiting for approval.'); if(!r) busy($('nGo'), false); }catch(e){ docsErr(e); busy($('nGo'), false); } });
}
function docsApproveModal(id){
  const d = docOf(id), i = docInfo(d, DOCS), p = i.pend, self = (p.by || '') === (ME.name || ME.login);
  docsModal(`<h3>Approve v${esc(p.v)}: ${d.id}</h3><div class="dmb"><div class="hint">${esc(d.title)}. Submitted by ${esc(p.by)} on ${p.at}.</div>
   <div class="dinfo"><b>Change Summary:</b> ${esc(p.summary)}</div>
   ${self ? '<div class="dwarn">You submitted this version. Approving your own submission is allowed but is flagged in the activity log.</div>' : ''}
   <div class="dg2"><div class="dfld"><label for="pDate">Effective Date</label><input type="date" id="pDate" value="${DOCS.today}"></div><div class="dfld"><label>Approved By</label><div class="dro">${esc(ME.name || ME.login)}</div></div></div>
   <div class="hint">${i.cur ? `v${esc(i.cur.v)} becomes Superseded. Approval also counts as a review and resets the review clock.` : 'This makes the document Active and starts its review clock.'}</div>${docsSignField('Approved')}</div>
   <div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="pGo">Approve And Publish</button></div>`);
  $('pGo').addEventListener('click', () => { if(!$('pDate').value) return docsToast('Enter an effective date.'); const pin = docsPinVal(); if(pin === null) return; busy($('pGo'), true); docsDo('/' + id + '/approve', { effective: $('pDate').value, pin }, 'v' + p.v + ' is now current.', () => docsApproveModal(id)).then(r => { if(!r) busy($('pGo'), false); }); });
}
function docsReasonModal(id, kind){                              // reject, retire
  const d = docOf(id), p = docInfo(d, DOCS).pend, rej = kind === 'reject';
  docsModal(`<h3>${rej ? `Reject v${esc(p.v)}` : 'Retire'}: ${d.id}</h3><div class="dmb">${rej ? '' : `<div class="hint">${esc(d.title)} leaves the active library. Its files are kept and it can be restored.</div>`}
   <div class="dfld"><label for="tWhy">Reason</label><textarea id="tWhy" maxlength="500"></textarea><div class="hint">Required.${rej ? ' The submitter sees this in the activity log.' : ' Name the replacement document if there is one.'}</div></div>${docsSignField(rej ? 'Rejected' : 'Retired')}</div>
   <div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn danger" id="tGo">${rej ? 'Reject Version' : 'Retire Document'}</button></div>`);
  $('tGo').addEventListener('click', () => { const w = $('tWhy').value.trim(); if(!w) return docsToast('Enter a reason.'); const pin = docsPinVal(); if(pin === null) return; busy($('tGo'), true);
    docsDo('/' + id + '/' + (rej ? 'reject' : 'retire'), { reason: w, pin }, rej ? 'Version rejected.' : id + ' retired.', () => docsReasonModal(id, kind)).then(r => { if(!r) busy($('tGo'), false); }); });
}
function docsRestoreModal(id){
  const d = docOf(id);
  docsModal(`<h3>Restore: ${d.id}</h3><div class="dmb"><div class="hint">${esc(d.title)} returns to the active library.</div>${docsSignField('Restored')}</div>
   <div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="sGo">Sign And Restore</button></div>`);
  $('sGo').addEventListener('click', () => { const pin = docsPinVal(); if(pin === null) return; busy($('sGo'), true); docsDo('/' + id + '/restore', { pin }, id + ' restored.', () => docsRestoreModal(id)).then(r => { if(!r) busy($('sGo'), false); }); });
}
function docsEditModal(id){
  const d = docOf(id);
  docsModal(`<h3>Edit Details: ${d.id}</h3><div class="dmb"><div class="hint">Doc ID, type and program area cannot change, because the ID, folder and calendar link depend on them.</div>
   <div class="dfld"><label for="eTitle">Title</label><input type="text" id="eTitle" maxlength="200" value="${esc(d.title)}"></div>
   <div class="dg2"><div class="dfld"><label for="eCyc">Review Cycle (Months)</label><input type="number" id="eCyc" min="0" max="120" value="${d.cycle}"></div><div class="dfld"><label for="eBas">Regulatory Basis</label><input type="text" id="eBas" maxlength="200" value="${esc(d.basis)}"></div></div>
   <div class="dfld"><label for="eNot">Notes</label><textarea id="eNot" maxlength="1000">${esc(d.notes)}</textarea></div>
   <div class="dg2"><div class="dfld"><label for="eChap">Chapter</label><select id="eChap">${dOpts(['', '795', '797', '800'], d.chapter || '', x => [x, x || 'None'])}</select></div></div>
   <div class="dfld"><label>Who Can See It</label>${docsAudHtml(d.audience || [])}</div></div>
   <div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="eGo">Save</button></div>`);
  $('eGo').addEventListener('click', () => { const t = $('eTitle').value.trim(); if(!t) return docsToast('Title is required.'); busy($('eGo'), true);
    docsDo('/' + id + '/edit', { title: t, cycle: $('eCyc').value, basis: $('eBas').value.trim(), notes: $('eNot').value.trim(), chapter: $('eChap').value, audience: docsAudRead() }, 'Saved.').then(r => { if(!r) busy($('eGo'), false); }); });
}
const docsCsv = () => {
  const m = DOCS, out = [['Doc ID', 'Title', 'Doc Type', 'Program Area', 'Format', 'Status', 'Version', 'Effective Date', 'Last Reviewed', 'Review Cycle (Months)', 'Next Review Due', 'Days Until Due', 'Review Status', 'Approver', 'Regulatory Basis', 'Applies To (Site)', 'Supersedes', 'File Path', 'Calendar Item ID', 'Notes']];
  m.docs.forEach(d => { const i = docInfo(d, m), a = DOC_AREA_LIST.find(x => x.code === d.area);
    out.push([d.id, d.title, DOC_TY[d.type].n, a.n + ' ' + a.name, d.format, i.status, i.version, i.effective, d.lastReviewed, d.cycle, i.next || '', i.days == null ? '' : i.days, i.r === 'n/a' ? 'n/a' : i.r, i.cur ? i.cur.approvedBy || '' : '', d.basis, m.pharmacy,
      d.versions.filter(v => v.state === 'superseded').map(v => 'v' + v.v).join(' '), docPathOf(d, i.version || '1.0'), i.status === 'Active' ? 'doc-review|' + d.id : '', d.notes]); });
  return out.map(r => r.map(v => { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\n');
};
async function docsCopy(txt, label){
  try{ await navigator.clipboard.writeText(txt); docsToast(label + ' copied.'); }
  catch(e){ docsModal(`<h3>Copy ${esc(label)}</h3><div class="dmb"><div class="hint">The browser blocked automatic copying. Select all and copy.</div><textarea id="cpTa" style="min-height:260px;font:12px Consolas,monospace">${esc(txt)}</textarea></div><div class="dmf"><button class="btn2" data-dact="closemodal">Close</button></div>`); const t = $('cpTa'); t.focus(); t.select(); }
}
async function docsPin(id){
  const k = DOCS.pins.indexOf(id); if(k < 0) DOCS.pins.push(id); else DOCS.pins.splice(k, 1);
  if(DOCS.pins.length <= 1) docsPaint(); else docsUpdate(); if(DOCS.open) docsDrawer(DOCS.open);
  try{ await api('POST', docsPath() + '/pins', { ids: DOCS.pins }); }catch(e){ docsErr(e); }
}
const DOCS_ACT = {
  type: id => { DOCS.type = id; if(DOCS.view !== 'docs'){ DOCS.view = 'docs'; docsPaint(); } else docsUpdate(); }, view: id => docsView(id), dpreview: id => docsDpModal(id),
  tfile: (id) => docsFileOpen('/tasks/file/' + encodeURIComponent(id)), mfile: id => docsFileOpen('/mine/' + encodeURIComponent(id) + '/file'), pfile: (id, t) => docsFileOpen('/personnel/' + encodeURIComponent(t.dataset.p) + '/file/' + encodeURIComponent(id)),
  inspnew: () => docsInspNewModal(), inspext: id => docsInspExpiryModal(id), insprev: id => docsInspRevoke(id),
  mremove: id => docsMineRemove(id), madd: () => docsMineAddModal(false), padd: () => docsMineAddModal(true), persopen: id => docsPersOpen(id), perback: () => { DOCS.persSel = null; docsPaint(); }, showret: () => { DOCS.fstatus = 'Retired'; docsPaint(); },
  tile: id => { DOCS.fstatus = ''; DOCS.freview = ''; DOCS.fpend = false; DOCS.showRetired = false; if(id === 'Overdue' || id === 'Due Soon') DOCS.freview = id; else if(id === 'pend') DOCS.fpend = true; else if(id === 'Under Review') DOCS.fstatus = 'Under Review'; else DOCS.fstatus = 'Active'; docsPaint(); },
  clr: id => { ({ type: () => DOCS.type = 'all', fstatus: () => DOCS.fstatus = '', fformat: () => DOCS.fformat = '', freview: () => DOCS.freview = '', fpend: () => DOCS.fpend = false, showRetired: () => DOCS.showRetired = false })[id](); docsPaint(); },
  clrall: () => { DOCS.type = 'all'; DOCS.fstatus = DOCS.fformat = DOCS.freview = ''; DOCS.fpend = false; DOCS.showRetired = false; DOCS.q = ''; docsPaint(); },
  sort: id => { DOCS.sort = DOCS.sort.k === id ? { k: id, d: -DOCS.sort.d } : { k: id, d: 1 }; docsUpdate(); },
  open: id => docsOpen(id), openv: (id, t) => docsOpen(id, t.dataset.v || ''), printv: id => docsOpen(id, '', true), detail: id => docsDrawer(id),
  menu: (id, t) => { const r = t.getBoundingClientRect(); DOCS.sel = id; docsMenu(id, r.left - 300, r.bottom + 2); },
  pin: id => docsPin(id), add: () => docsAddModal(), review: id => docsReviewModal(id), newver: id => docsNewVerModal(id), approve: id => docsApproveModal(id),
  reject: id => docsReasonModal(id, 'reject'), retire: id => docsReasonModal(id, 'retire'), edit: id => docsEditModal(id), restore: id => docsRestoreModal(id), mypin: () => docsPinModal('change'),
  closemodal: () => docsCloseModal(), closedrawer: () => docsCloseDrawer(), csv: () => docsCopy(docsCsv(), 'Register')
};
function docsInit(){                                             // once, when the page loads
  const root = $('panel-documents'); if(!root) return;
  root.addEventListener('click', e => {
    docsCloseCtx();
    if(e.target.closest('[data-ddov]') && e.target.matches('[data-ddov]')){ docsCloseDrawer(); return; }
    const t = e.target.closest('[data-dact]'); if(!t || t.disabled) return; if(t.tagName === 'A') e.preventDefault();
    const f = DOCS_ACT[t.dataset.dact]; if(f) f(t.dataset.id, t, e);
  });
  root.addEventListener('change', e => { const t = e.target;
    if(t.matches('[data-dfs]')){ DOCS.fstatus = t.value; docsUpdate(); } else if(t.matches('[data-dff]')){ DOCS.fformat = t.value; docsUpdate(); }
    else if(t.matches('[data-grant]')){ docsGrant(t.dataset.grant, t.dataset.sub, t.checked); }
    else if(t.matches('[data-dfr]')){ DOCS.freview = t.value; docsUpdate(); } else if(t.matches('[data-dret]')){ DOCS.showRetired = t.checked; docsUpdate(); } });
  root.addEventListener('dblclick', e => { const tr = e.target.closest('tr[data-row]'); if(!tr || e.target.closest('button')) return; docsCloseCtx(); docsOpen(tr.dataset.row); });
  root.addEventListener('contextmenu', e => { const tr = e.target.closest('tr[data-row]'); if(!tr) return; e.preventDefault(); DOCS.sel = tr.dataset.row; docsMenu(tr.dataset.row, e.clientX, e.clientY); });
  document.addEventListener('keydown', e => {
    if(!root.classList.contains('active')) return;
    const ctx = document.getElementById('dctx');
    if(ctx && (e.key === 'ArrowDown' || e.key === 'ArrowUp')){ e.preventDefault(); const it = [...ctx.querySelectorAll('.dctxi:not([disabled])')], k = it.indexOf(document.activeElement); it[(k + (e.key === 'ArrowDown' ? 1 : -1) + it.length) % it.length].focus(); return; }
    if(e.key === 'Escape'){ if(ctx) ctx.remove(); else if($('docsOv').innerHTML) docsCloseModal(); else if(DOCS.open) docsCloseDrawer(); return; }
    if(e.key === 'Enter' && document.activeElement && document.activeElement.matches('tr[data-row]')) docsOpen(document.activeElement.dataset.row); });
  addEventListener('scroll', docsCloseCtx, true); addEventListener('resize', docsCloseCtx);
}

/* ---------------- Rx Intake tab (named users only, same list as Calendar and Documents) ----------------
   The form is its own page (rx.html) shown inside this one. It gets the pharmacy details, the receiving pharmacists, the shared directory
   of pharmacies and prescribers, and the NPI / address lookups from window.ILRX_HOST below. Patient fields, Rx data and PDFs never leave the
   form's page: nothing about a patient is sent to the server. The server checks every request against the named-user list. */
const RX = {loadedAt: 0};
const rxOK = () => !!(ME && STORE && STORE.rx === true);
const rxPath = tail => '/stores/' + encodeURIComponent(STORE.id) + '/rx/' + tail;
window.ILRX_HOST = {
  async config(){ if(!rxOK()) throw new Error('Rx Intake is not available for this login at this pharmacy.'); return await api('GET', rxPath('config')); },
  async dirSave(kind, rec){ const r = await api('POST', rxPath('dir/save'), {kind, rec}); return r.rec; },
  async dirImport(d){ return await api('POST', rxPath('dir/import'), {ph: d.ph || [], pr: d.pr || []}); },
  async lookup(url){ const r = await api('POST', rxPath('lookup'), {url}); return r.data; }
};
function rxShow(){                                                // called when the Rx Intake tab is opened
  const f = $('rxFrame'); if(!rxOK()) return;
  if(!f.getAttribute('src') || f.getAttribute('src') === 'about:blank' || f.dataset.store !== STORE.id){ f.dataset.store = STORE.id; RX.loadedAt = Date.now(); f.src = 'rx.html?v=' + Date.now(); }
}
function rxPaint(){                                               // called whenever the pharmacy or the person changes
  const tab = document.querySelector('#tabs [data-tab="rx"]'); if(!tab) return;
  const ok = rxOK(); tab.style.display = ok ? '' : 'none';
  const f = $('rxFrame');
  if(!ok || (f.dataset.store && STORE && f.dataset.store !== STORE.id)){
    f.removeAttribute('data-store'); f.src = 'about:blank';       // closing the page discards any form and PDFs held in it
    if(tab.classList.contains('active')) homeTab();
  }
}

/* ---------------- tabs, render, start ---------------- */
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach(x => { x.classList.toggle('active', x === b); x.classList.toggle('sub', b.dataset.tab === 'archive' && x.dataset.tab === 'list'); });
  $('acctBtn').classList.toggle('on', b.dataset.tab === 'owner');
  const pan = b.dataset.tab === 'dashboard' ? 'calendar' : b.dataset.tab;                  // Dashboard and Calendar are two views of the same page
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + pan));
  document.body.classList.toggle('wideTab', b.dataset.tab === 'owner' || b.dataset.tab === 'documents');
  if(b.dataset.tab === 'owner') openOwnerTab();
  if(b.dataset.tab === 'archive') loadArchive(false).catch(() => {});
  if(b.dataset.tab === 'calendar' || b.dataset.tab === 'dashboard') calShow(b.dataset.tab);
  if(b.dataset.tab === 'documents') docsShow();
  if(b.dataset.tab === 'rx') rxShow();
});
$('whoBtn').onclick = e => { e.stopPropagation(); const l = $('umList'); l.hidden = !l.hidden; $('whoBtn').setAttribute('aria-expanded', String(!l.hidden)); };
document.addEventListener('click', e => { const l = $('umList'); if(l && !l.hidden && !e.target.closest('.umenu')){ l.hidden = true; $('whoBtn').setAttribute('aria-expanded', 'false'); } });
$('acctBtn').onclick = () => { $('umList').hidden = true; document.querySelector('#tabs [data-tab="owner"]').click(); };                 // Account: in the name menu, not a tab
$('signOutBtn').addEventListener('click', () => { $('umList').hidden = true; });
$('archOpen').onclick = () => document.querySelector('#tabs [data-tab="archive"]').click();             // Archive: from the Reorder List page
$('archBack').onclick = () => document.querySelector('#tabs [data-tab="list"]').click();
function renderAll(){ renderList(); renderArchive(); }

/* ---- computers sign out by themselves after a while without use (shared front-counter computers) ----
   Any typing, click, scroll or barcode scan counts as use. A notice shows for the last minute. Changes are
   saved as they're made; a save still in progress finishes before the sign-out. Home-screen phones are left
   alone: a phone locks with its own screen lock. */
const IDLE_MIN = Number(CFG.idleMinutes) > 0 ? Number(CFG.idleMinutes) : 15, IDLE_MS = IDLE_MIN * 60000, WARN_MS = 60000;
let lastUse = Date.now();
const idleWarn = document.createElement('div');
idleWarn.id = 'idleWarn'; idleWarn.setAttribute('role', 'alert'); idleWarn.style.display = 'none';
document.body.appendChild(idleWarn);
function markUse(){ lastUse = Date.now(); if(idleWarn.style.display !== 'none') idleWarn.style.display = 'none'; }
['keydown', 'pointerdown', 'wheel', 'input', 'touchstart'].forEach(t => document.addEventListener(t, markUse, {capture:true, passive:true}));
setInterval(async () => {
  if(STANDALONE || !ME || !SESSION){ idleWarn.style.display = 'none'; return; }
  const left = IDLE_MS - (Date.now() - lastUse);
  if(left > WARN_MS){ idleWarn.style.display = 'none'; return; }
  if(left > 0){
    idleWarn.textContent = `Signing out in ${Math.ceil(left / 1000)} seconds because nobody has used this for a while. Any click keeps you signed in.`;
    idleWarn.style.display = ''; return;
  }
  if(saving > 0) return;                              // let a save finish first
  idleWarn.style.display = 'none';
  await signOut(true);
  $('liUser').value = '';
  showLogin(`Signed out after ${IDLE_MIN} minutes without use.`);
}, 1000);
if('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
docsInit();

(async function start(){
  if(!CFG.apiUrl || !CFG.clientId){ document.body.innerHTML = '<p style="padding:20px">This copy of the app isn’t set up yet (config.js is missing). Deploy it with deploy.sh.</p>'; return; }
  loadSession();
  if(!SESSION) return showLogin();
  try{ await idToken(); }catch(e){ return showLogin(e.auth ? '' : e.message); }
  await enterApp('');
})();

// Notifications: each person chooses email and/or text (none ticked means the app only). Messages never name a patient, drug or task.
$('notifBtn').onclick = async () => {
  $('umList').hidden = true;
  let n; try{ n = await api('GET', '/me/notify'); }catch(e){ if(!e.auth) alert(e.message); return; }
  const o = document.createElement('div'); o.className = 'dov'; o.id = 'notifOv';
  o.innerHTML = `<div class="dmodal" role="dialog" aria-modal="true"><h3>Notifications</h3><div class="dmb">
    <div class="hint">Waiting items always show in the app. Tick below to also get a short message with no patient, drug or task names.</div>
    <div class="dfld"><label class="chk"><input type="checkbox" id="nfEm"${n.email ? ' checked' : ''}> Email</label></div>
    <div class="dfld"><label for="nfAd">Email Address</label><input type="text" id="nfAd" maxlength="120" value="${esc(n.address)}" autocomplete="email"></div>
    <div class="dfld"><label class="chk"><input type="checkbox" id="nfTx"${n.text ? ' checked' : ''}> Text${n.phone ? ' To ' + esc(n.phone) : ''}</label></div></div>
    <div class="dmf"><button class="btn2" id="nfNo">Cancel</button><button class="btn" id="nfGo">Save</button></div></div>`;
  document.body.appendChild(o);
  const close = () => o.remove();
  $('nfNo').onclick = close; o.addEventListener('mousedown', e => { if(e.target === o) close(); });
  $('nfGo').onclick = async () => { try{ await api('POST', '/me/notify', { email: $('nfEm').checked, address: $('nfAd').value.trim(), text: $('nfTx').checked }); close(); }catch(e){ if(!e.auth) alert(e.message); } };
};

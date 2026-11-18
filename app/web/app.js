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
  if(!r.ok){ const e = new Error(j.error || j.message || ('Server answered ' + r.status)); e.status = r.status; throw e; }
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
  calPaint();
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
function busy(btn, on){ btn.disabled = on; btn.dataset.t = btn.dataset.t || btn.textContent; btn.textContent = on ? 'Please wait…' : btn.dataset.t; }
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
  if(ME && ME.owner && OWN_UNTIL > 0){ OWN_UNTIL = 0; await api('POST', '/owner-lock', {}).catch(() => {}); }
  if(SESSION && SESSION.refresh) cog('RevokeToken', {ClientId:CFG.clientId, Token:SESSION.refresh}).catch(() => {});
  SESSION = null; saveSession();
  if(typeof TEMPS !== 'undefined') for(const k in TEMPS) delete TEMPS[k];
  if(typeof STAGED !== 'undefined') for(const k in STAGED) delete STAGED[k];       // copied temporary passwords go with the session
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
  $('dmHeader').textContent = netState === 'offline' ? 'Drug search: no internet'
    : netState === 'down' ? 'Drug search: NLM not answering' : 'Drug search: NLM RxTerms / RxNav';
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
  if(!confirm(`Submit ${n} line${n === 1 ? '' : 's'} for ${STORE.id}? They move to the Archive.` +
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
const PHARM_PANELS = [['id', 'Pharmacy'], ['contact', 'Name And Address'], ['reg', 'License And Registration'], ['svc', 'Services Provided'], ['hrs', 'Hours Of Operation'], ['act', 'Calendar And Save']];
const PHARM_LAYOUT = {"v":2,"cols":12,"panels":{"id":[1,1,3,35],"contact":[4,1,4,35],"hrs":[8,1,5,55],"reg":[1,36,7,37],"svc":[1,79,12,19],"act":[8,56,5,23]}};
const PHARM_PAGE = { id: 'pharm', title: 'Pharmacy Setup Page (host)', panels: PHARM_PANELS, layout: PHARM_LAYOUT,
  render: (sample, panels) => pharmCardHtml(sample, { logo: '', holder: 'Pat Owner (owner)', host: true, clients: [{ id: 'IL-000001', legalName: 'NorTex Holdings LLC', entityType: 'llc', ein: '12-3456789' }] }, { panels }) };
const pharmLayoutOk = L => layoutOk(PHARM_PAGE, L);
const pharmLayout = () => pharmLayoutOk(PHARM_LAYOUT) ? PHARM_LAYOUT : null;
const sw = (attrs, on, title) => `<label class="switch" title="${esc(title || '')}"><input type="checkbox" ${attrs}${on ? ' checked' : ''}><span></span></label>`;
const SF = [['name','Pharmacy name'],['address','Street address'],['suite','Suite / unit (if any)'],['city','City'],['state','State'],['zip','ZIP code'],['phone','Phone'],['fax','Fax'],['email','Email'],['timezone','Time zone']];
const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
const stateSelect = (attrs, cur) => `<select ${attrs}><option value=""></option>${US_STATES.map(v => `<option${v === (cur || '') ? ' selected' : ''}>${v}</option>`).join('')}</select>`;
const tzSelect = (attrs, cur) => `<select ${attrs}>${Object.entries(TZ_NAMES).map(([v, l]) => `<option value="${v}"${v === (cur || 'America/Chicago') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
// license, identifiers, services and hours kept on each pharmacy (edit-only: the add-pharmacy form stays short)
const SF2 = [['license','State pharmacy license #'],['licenseExpires','License expires','date'],['npi','NPI (10 digits)'],['ncpdp','NCPDP ID (7 digits)'],['dea','DEA number'],['deaExpires','DEA expires','date']];
const SVC_LABELS = {retail:'Retail dispensing', controlled:'Controlled substances (DEA)', nonsterile:'Nonsterile compounding', sterile:'Sterile compounding', hazardous:'Hazardous drug compounding',
  immunizations:'Immunizations', delivery:'Delivery', ltc:'Long-term care', specialty:'Specialty', infusion:'Home infusion'};
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
// Additional closed days beyond the weekly hours: dated days the pharmacy adds (name, date, optional every year). Yearly-observance toggles removed; observances are entered by hand (Neo, 2026-11-17).
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
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
const cardField = (s, k, l, t, c) => IDENT.includes(k) ? (c.host ? field(s, k, l, t, !c.isNew && !!s[k] && !c.rep && !c.repView) : roField(s, k, l, t)) : (c.host || AM_EDIT.includes(k) ? field(s, k, l, t) : roField(s, k, l, t));
const LOCKED = 'Set by IronLedger. Contact your IronLedger representative to change this.';
const LOCKED_ID = 'Name, address, license and identifiers must match your license and billing, so IronLedger sets them. Phone, fax, email, time zone, hours and expiration dates are yours to keep current.';
const deaStat = s => s.deaVerified ? 'Checked on the DEA site ' + esc((s.deaVerified.at || '').slice(0, 10)) + (s.deaVerified.by ? ' by ' + esc(s.deaVerified.by) : '') : 'Not checked yet.';
// Licensed entity (the entity named on the license, DEA and NPI; the EIN is required) and the client (the bill-to account, IL- number).
const ENT_TYPES = [['corporation', 'Corporation'], ['llc', 'LLC'], ['sole_prop', 'Sole proprietor'], ['partnership', 'Partnership'], ['other', 'Other']];
const entTypeLabel = v => (ENT_TYPES.find(x => x[0] === v) || [0, ''])[1];
const entTypeSelect = (attrs, cur) => `<select ${attrs}><option value=""></option>${ENT_TYPES.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
const clientName = (c, id) => { const k = (c.clients || []).find(x => x.id === id); return k ? k.legalName + ' (' + id + ')' : id || ''; };
const clientSelect = (c, cur, attrs) => `<select data-sf="clientId" ${attrs || ''}><option value=""></option>${(c.clients || []).map(k => `<option value="${esc(k.id)}"${k.id === cur ? ' selected' : ''}>${esc(k.legalName)} (${esc(k.id)})</option>`).join('')}</select>`;
const entityHost = (s, c) => { const lk = !c.isNew && !!s.ein && !c.rep && !c.repView, lkn = !c.isNew && !!s.entityLegalName && !c.rep && !c.repView, lkt = !c.isNew && !!s.entityType && !c.rep && !c.repView;
  return `<div class="entity"><b class="clh">Licensed entity</b> <span class="hint">the entity named on the license, DEA and NPI</span>
    <div class="pfields"><label><span>Legal name (required)</span><input type="text" data-sf="entityLegalName" maxlength="120" value="${esc(s.entityLegalName || '')}"${lkn ? ' readonly data-ident="1"' : ''}></label>
    <label><span>Entity type (required)</span>${entTypeSelect(`data-sf="entityType"${lkt ? ' disabled data-ident="1"' : ''}`, s.entityType)}</label>
    <label><span>EIN (required)</span><input type="text" data-sf="ein" maxlength="11" placeholder="12-3456789" value="${esc(s.ein || '')}"${lk ? ' readonly data-ident="1"' : ''}></label></div>
    ${(c.clients || []).length && !c.repView && (!s.ein || c.isNew) ? '<button type="button" class="btn2 small" data-entsame="1" title="Fills the legal name, type and EIN from the selected client">Same as client</button>' : ''}
    ${!c.isNew && !s.ein ? '<div class="lockhint warn">EIN missing: required for every pharmacy.</div>' : ''}</div>`; };
const entityRo = s => `<div class="entity"><b class="clh">Licensed entity</b><div class="pfields">${roField(s, 'entityLegalName', 'Legal name')}<label><span>Entity type</span>${roVal(entTypeLabel(s.entityType))}</label><label><span>EIN</span>${roVal(s.einMasked)}</label></div></div>`;
const PHARM_BODY = {
  id: (s, c) => c.isNew
      ? `<div class="pidbox"><label class="pfields"><span>Pharmacy ID</span><input type="text" class="newid" data-newid="1" maxlength="20" autocapitalize="characters" spellcheck="false"></label>
        <div class="hint">What people type when they sign in (2–20 letters, numbers or dashes, like NTX1). It can’t be changed later. Add the logo after the pharmacy is created.</div>
        <label class="pfields"><span>Client (bill-to account, required)</span>${clientSelect(c, '')}</label></div>`
      : `<div class="plogo">${c.logo ? `<img src="${esc(c.logo)}" alt="">` : '<span class="hint">No logo</span>'}
        <label class="btn2 small">Upload logo<input type="file" accept="image/png,image/jpeg,image/webp" data-logo="${esc(s.id)}" hidden></label>
        ${c.logo ? `<button class="btn2 small" data-nologo="${esc(s.id)}">Remove</button>` : ''}</div>
      <div class="pidbox"><div class="pid">Pharmacy ID: <b>${esc(s.id)}</b></div><div class="hint">(what people type when they sign in)</div>
        <div class="pid">Primary account holder: <b>${esc(c.holder || 'Account Owner')}</b></div><div class="hint">(the Account Owner)</div>
        ${c.host
          ? `<label class="pfields"><span>Client (bill-to account)</span>${clientSelect(c, s.clientId, !!s.clientId && !c.rep && !c.repView ? 'disabled data-ident="1"' : '')}</label>${s.clientId ? '' : '<div class="lockhint warn">No client yet: pick one.</div>'}`
          : `<div class="pid">Account number: <b>${s.clientId ? esc(s.clientId) : 'Not assigned yet'}</b></div><div class="hint">(generated once by IronLedger; never changes)</div>`}</div>`,
  contact: (s, c) => `<div class="pfields">${SF.map(([k, l]) => cardField(s, k, l, undefined, c)).join('')}${c.host ? '' : `<div class="lockhint">${LOCKED_ID}</div>`}</div>`,
  reg: (s, c) => c.rep ? ((h) => h.slice(0, h.indexOf('<div class="pid npirow">')) + '<div class="lockhint">A rep drafts changes and a supervisor reviews them. The NPI registry lookup and the DEA check are done by a supervisor.</div></div>')(PHARM_BODY.reg(s, { ...c, rep: false, repView: true }))
    : c.host
    ? `<div class="pfields">${SF2.map(([k, l, t]) => cardField(s, k, l, t, c)).join('')}</div>${entityHost(s, c)}<div class="pfields">
        <div class="pid npirow"><button class="btn2 small" data-npilook="1" title="Checks the NPI against the public registry. Nothing changes until you save.">Look up NPI in the federal registry</button><div data-npires></div></div>
        <div class="pid npirow"><a class="btn2 small" href="https://apps.deadiversion.usdoj.gov/webforms2/spring/validationLogin" target="_blank" rel="noopener noreferrer">Open the DEA registration check</a>${c.isNew ? '' : ' <button class="btn2 small" data-deaok="1" data-deastat title="' + deaStat(s) + '">I checked this DEA number there</button>'}</div></div>`
    : `<div class="pfields">${SF2.map(([k, l, t]) => cardField(s, k, l, t, c)).join('')}
        <div class="lockhint">License number, NPI, DEA and NCPDP are set by IronLedger. Expiration dates are yours to keep current.</div><div class="pid npirow hint">DEA check: ${deaStat(s)}</div></div>${entityRo(s)}`,
  svc: (s, c) => c.host && !c.rep
    ? `<div class="pfields"><div class="svcs">${Object.entries(SVC_LABELS).map(([k, l]) => `<label class="chk">${sw(`data-svc="${k}"`, (s.services || []).includes(k))} ${l}</label>`).join('')}</div>
          ${field(s, 'servicesOther', 'Other services').replace('<label>', '<label class="oth">')}</div>`
    : `<div class="pfields"><div class="chips">${(s.services || []).map(k => `<span class="chip">${esc(SVC_LABELS[k] || k)}</span>`).join('') || '<span class="hint">None set yet.</span>'}</div>
          ${s.servicesOther ? `<div class="pid">Other: ${esc(s.servicesOther)}</div>` : ''}<div class="lockhint">${LOCKED}</div></div>`,
  hrs: s => `<div class="pfields"><div class="hrs">${s.hours ? '' : '<div class="hint">Not set yet; these are suggestions until you save.</div>'}
          ${hoursOf(s).map((h, i) => `<div class="hrow"><span>${DAYS[i]}</span><input type="time" data-ho="${i}" value="${h ? h.o : '09:00'}"><input type="time" data-hc="${i}" value="${h ? h.c : '18:00'}"><label class="chk">${sw(`data-hx="${i}"`, !h)} Closed</label></div>`).join('')}</div>
          <div class="closed" data-cl='${esc(JSON.stringify(closuresOf(s).days))}'><b class="clh">Additional closed days</b>
            <div class="cllist" data-cllist>${closeRows(closuresOf(s).days)}</div>
            <div class="cladd"><input type="date" data-cld title="Date"><input type="text" data-cln maxlength="60" placeholder="Name, e.g. Mardi Gras"><label class="chk">${sw('data-cly')} Every year</label> <button type="button" class="btn2 small" data-cladd="1">Add</button></div>
          </div></div>`,
  act: (s, c) => `<div class="pfields"><div class="calsw">${c.host && !c.rep
        ? `<label class="chk">${sw(`data-sfcal="1"`, s.calendar, 'Calendar tab for this pharmacy')} Calendar switched on for this pharmacy</label> <span class="hint">(people also need the Calendar privilege)</span>`
        : `Calendar: <b>${s.calendar ? 'On' : 'Off'}</b> <span class="hint">${LOCKED}</span>`}</div>
        <div style="margin-top:10px;">${c.rep ? `<label class="reason"><span>Why (required, the supervisor reads this)</span><input type="text" data-draftnote maxlength="300"></label> <button class="btn small" data-draftstore="${esc(s.id)}">Submit for review</button>`
          : c.isNew ? '<button class="btn small" data-createstore="1">Create pharmacy</button>' : `<button class="btn small" data-savestore="${esc(s.id)}">Save details</button>`}</div>
        ${c.host && !c.isNew && !c.rep ? `<div class="identbar"><button class="btn2 small" data-unlockident="1">Change name, address, license or identifiers…</button>
          <div class="hint">Locked on purpose: they must match the license and billing. A reason is required and every change is kept in the history.</div>
          <label class="reason" hidden><span>Reason for the change</span><input type="text" data-reason maxlength="300"></label>
          <div style="margin-top:8px"><button class="btn2 small" data-hist="${esc(s.id)}">Change history</button><div data-histout></div></div></div>` : ''}</div>`
};
// the whole card, built by the layout engine
function pharmCardHtml(s, c, L){ return layoutGridHtml(PHARM_PAGE, L, id => PHARM_BODY[id](s, c)); }

// ---------------- behaviour shared by the Account Owner page and the host page ----------------
// o = { base: '/owner' | '/host', stores: () => [store, …], say: text => …, after: async () => … }
const normNm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function pharmCardEvents(root, o){
  root.addEventListener('change', e => { if(e.target.closest('[data-ho],[data-hc],[data-hx]')){ const c = e.target.closest('.pcard'); if(c) c.dataset.hrTouched = '1'; } });
  root.addEventListener('click', async e => {
    const lk = e.target.closest('[data-npilook]'), us = e.target.closest('[data-npiuse]'), dk = e.target.closest('[data-deaok]');
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
    if(dk){
      const dea = val('dea'); if(!dea){ alert('Type the DEA number first.'); return; }
      if(!confirm('Confirm you looked up ' + dea.toUpperCase() + ' on the DEA registration check and the name, address and expiration match this pharmacy?')) return;
      try{ await api('POST', o.base + '/stores/' + encodeURIComponent(card.dataset.store), {dea, deaVerified:true}); o.say('DEA check recorded.'); await o.after(); }catch(err){ if(!err.auth) alert(err.message); }
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
      if(card.querySelector('[data-ident]') && !card.dataset.unlocked){ alert('The name and address are locked. Press “Change name, address, license or identifiers…” first.'); return; }
      const set = (k, v) => { const i = card.querySelector(`[data-sf=${k}]`); if(i && v) i.value = v; };
      set('name', r.name); set('address', r.address.address); set('suite', r.address.suite); set('city', r.address.city); set('state', r.address.state); set('zip', r.address.zip); set('phone', r.address.phone); set('fax', r.address.fax);
      o.say('Filled in from the registry. Press ' + (card.dataset.isNew ? 'Create pharmacy' : 'Save details') + ' to keep it.'); return;
    }
    if(sv){
      const isNew = !!sv.dataset.createstore, id = isNew ? (card.querySelector('[data-newid]').value || '').trim().toUpperCase() : sv.dataset.savestore;
      const body = {}; card.querySelectorAll('[data-sf]').forEach(i => body[i.dataset.sf] = i.value.trim());
      const cal = card.querySelector('[data-sfcal]'); if(cal) body.calendar = cal.checked;
      if(card.querySelector('[data-svc]')) body.services = [...card.querySelectorAll('[data-svc]')].filter(i => i.checked).map(i => i.dataset.svc);
      const cur = o.stores().find(x => x.id === id);
      if(card.dataset.hrTouched || (cur && cur.hours)) body.hours = DAYS.map((_, i) => card.querySelector(`[data-hx="${i}"]`).checked ? null : {o: card.querySelector(`[data-ho="${i}"]`).value, c: card.querySelector(`[data-hc="${i}"]`).value});
      if(card.dataset.clTouched) body.closures = closuresOfCard(card);
      const rs = card.querySelector('[data-reason]'); if(rs && rs.value.trim()) body.changeReason = rs.value.trim();
      if(isNew){ if(!id || !body.name){ alert('Pharmacy ID and name are needed.'); return; } body.id = id; }
      busy(sv, true);
      try{ await api('POST', o.base + '/stores' + (isNew ? '' : '/' + encodeURIComponent(id)), body); o.say(isNew ? 'Pharmacy created: ' + id : 'Pharmacy details saved.'); await o.after(isNew); }
      catch(err){ if(!err.auth) alert(err.message); } finally{ busy(sv, false); }
    }
  });
}

/* ---------------- Account Owner tab: pharmacies, people, access switches, import ----------------
   Opening it needs the password again; it locks after 5 minutes without activity on the tab.
   The server enforces the same rule, so the lock can't be skipped by changing the page. */
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
  for(const k in STAGED) delete STAGED[k]; peopleMsg('');
  OWN = {stores:[], users:[]}; $('ownPeople').innerHTML = ''; $('ownStores').innerHTML = '';   // nothing left on screen
  if(ownerTabActive()) showOwnLock(msg);
}
function openOwnerTab(){
  if(!(OWN_UNTIL > Date.now())) return showOwnLock('');
  $('ownLock').style.display = 'none'; $('ownBody').style.display = '';
  ownLastAct = Date.now(); loadOwner();
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
const PERM_LABELS = {submit:'Submit orders', archive:'View archive', remove:'Remove lines', export:'Download backup', calendar:'Calendar'};
const PERM_HEADS = {submit:'Submit', archive:'Archive', remove:'Remove', export:'Backup', calendar:'Calendar'};
let OWN = {stores:[], users:[]};
// temporary passwords made on this screen, kept only in this page (never saved anywhere) so they can be copied again
// while the person is still pending; gone on sign-out or reload, or once the person has signed in
const TEMPS = {};
// switch changes on a person's row wait here until Update is pressed on that row (Undo puts them back)
const STAGED = {};
function effUser(u){
  const s = STAGED[u.sub]; if(!s) return u;
  return Object.assign({}, u, {stores:Object.assign({}, u.stores, s.stores || {}), perms:Object.assign({}, u.perms, s.perms || {}), acctType:s.acctType !== undefined ? s.acctType : u.acctType,
    disabled:s.disabled !== undefined ? s.disabled : u.disabled});
}
const stageBtns = sub => `<button class="btn small" data-upd="${esc(sub)}">Update</button> <button class="btn2 small" data-undo="${esc(sub)}">Undo</button>`;
function peopleMsg(m){ $('ownPeopleMsg').textContent = m || ''; }
const COPY_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
function signInText(u, pw){
  const on = (OWN.stores || []).filter(s => u.stores && u.stores[s.id] === true).map(s => s.id);
  const here = typeof STORE !== 'undefined' && STORE && on.includes(STORE.id) ? STORE.id : null;
  return `Pharmacy ID: ${here || on.join(' or ') || '(switch a pharmacy on first)'}\nUser ID: ${u.login}\nTemporary Pass: ${pw}`;
}
async function copyText(t){
  try{ await navigator.clipboard.writeText(t); return true; }
  catch(e){ const a = document.createElement('textarea'); a.value = t; a.style.position = 'fixed'; a.style.opacity = '0'; document.body.appendChild(a); a.select();
    let ok = false; try{ ok = document.execCommand('copy'); }catch(e2){} a.remove(); return ok; }
}
async function loadOwner(){
  if(!ME || !ME.owner) return;
  $('ownStores').innerHTML = $('ownPeople').innerHTML = '<div class="hint"><span class="spin"></span>Loading…</div>';
  try{
    const [s, u] = await Promise.all([api('GET', '/owner/stores'), api('GET', '/owner/users')]);
    OWN = {stores:s.stores, users:u.users};
    for(const k in TEMPS) if(!OWN.users.some(x => x.sub === k && x.pending)) delete TEMPS[k];
    for(const k in STAGED) if(!OWN.users.some(x => x.sub === k)) delete STAGED[k];
    for(const st of OWN.stores) if(st.hasLogo && LOGOS[st.id] === undefined) loadLogo(st.id).then(renderOwnStores);
    renderOwner();
  }catch(e){ if(!e.auth) $('ownPeople').innerHTML = `<div class="banner warn">${esc(e.message)}</div>`; }
}
let npStoresSig = '';
function renderOwner(){ renderOwnStores(); renderOwnPeople();
  const sig = OWN.stores.map(s => s.id + ':' + s.name).join('|');
  if(sig !== npStoresSig || !$('npPerms').innerHTML){ npStoresSig = sig; paintNewPerson(); }   // don't undo switches someone is setting for the next person
  $('impStore').innerHTML = OWN.stores.map(s => `<option value="${esc(s.id)}">${esc(s.id)} · ${esc(s.name)}</option>`).join(''); }
const ACCT_LABELS = {pic:'Pharmacist-in-Charge', pharmacist:'Staff Pharmacist', tech:'Pharmacy Technician', staff:'Other Staff'};
// choosing a type switches these on or off (the Calendar privilege is never changed by a type; it is set on its own)
const ACCT_PRESETS = {pic:{submit:true, archive:true, remove:true, export:true}, pharmacist:{submit:true, archive:true, remove:true, export:false},
  tech:{submit:true, archive:true, remove:true, export:false}, staff:{submit:true, archive:false, remove:false, export:false}};
function renderOwnStores(){
  const holder = (OWN.users || []).find(u => u.owner), hn = holder ? (holder.name || holder.login) + ' (' + holder.login + ')' : '';
  $('ownStores').innerHTML = OWN.stores.map(s => `<div class="pcard" data-store="${esc(s.id)}">${pharmCardHtml(s, { logo: LOGOS[s.id], holder: hn })}</div>`).join('') || '<div class="hint">No pharmacies yet.</div>';
}
const fmtDay = iso => { try{ return new Date(iso).toLocaleDateString('en-US', {month:'short', day:'numeric'}); }catch(e){ return ''; } };
function statusBadge(u){
  if(u.disabled) return '<span class="ustat off">Login off</span>';
  if(u.pending && u.tempExpired) return `<span class="ustat bad">Expired</span><div class="maker">Temp password expired</div>`;
  if(u.pending) return `<span class="ustat wait">Pending</span><div class="maker">${u.tempExpires ? 'Temp password until ' + fmtDay(u.tempExpires) : 'Hasn’t signed in yet'}</div>`;
  return '<span class="ustat ok">Active</span>';
}
function renderOwnPeople(){
  const st = OWN.stores, P = Object.keys(PERM_LABELS);
  const priv = (sw_, label, title) => `<span class="priv" title="${esc(title || label)}">${sw_}<span>${esc(label)}</span></span>`;
  const head = u => `
      <div class="ucell uname" data-l="User"><b>${esc(u.name || u.login)}</b>${u.owner ? '<span class="urole">Account Owner</span>' : u.host ? '<span class="urole">Host (IronLedger)</span>' : ''}</div>
      <div class="ucell mono" data-l="Username">${esc(u.login)}</div>
      <div class="ucell" data-l="Mobile">${esc(u.phone)}${u.owner ? ' <span class="hint" title="Sign-in codes are texted here, so only IronLedger changes it. Contact IronLedger.">🔒</span>' : u.host ? '' : ` <button class="edit" data-phone="${esc(u.sub)}" title="Change mobile number">✎</button>`}</div>
      <div class="ucell" data-l="Status">${statusBadge(u)}</div>`;
  const acts = u => `<div class="ucell acts">${STAGED[u.sub] ? stageBtns(u.sub) : `<button class="btn2 small" data-reset="${esc(u.sub)}">Reset password</button> <button class="btn2 small danger" data-del="${esc(u.sub)}">${u.pending ? 'Cancel invite' : 'Delete'}</button>`}</div>
      <div class="ucell copycell">${u.pending && TEMPS[u.sub] ? `<button class="btn2 small copyb" data-copy="${esc(u.sub)}" title="Copy Pharmacy ID, User ID and temporary password" aria-label="Copy sign-in details">${COPY_SVG}</button>` : ''}</div>`;
  const rowCls = u => `urow${u.disabled ? ' off' : ''}${STAGED[u.sub] ? ' dirty' : ''}`;
  $('ownPeople').innerHTML = `<div class="ulist">
    <div class="uhead ucols"><div>User</div><div>Username</div><div>Mobile</div><div>Status</div><div></div><div></div></div>
    ${OWN.users.map(effUser).map(u => u.owner
      ? `<div class="urow"><div class="ucols">${head(u)}<div class="ucell acts"></div><div class="ucell copycell"></div></div>
         <div class="upriv"><span class="plabel">Account type</span><span class="hint">Account Owner · primary account holder</span></div>
         <div class="upriv"><span class="plabel">Pharmacies</span><span class="hint">All pharmacies</span></div>
         <div class="upriv"><span class="plabel">Privileges</span><span class="hint">Full access</span></div></div>`
      : u.host
      ? `<div class="${rowCls(u)}" data-sub="${esc(u.sub)}"><div class="ucols">${head(u)}<div class="ucell acts">${STAGED[u.sub] ? stageBtns(u.sub) : ''}</div><div class="ucell copycell"></div></div>
         <div class="upriv"><span class="plabel">Pharmacies</span>
           <span class="pgroup">${st.map(s => priv(sw(`data-ust="${esc(s.id)}"`, u.stores[s.id] === true, 'Let the host open ' + s.name), s.id, 'Let the host open ' + s.name)).join('')}</span></div>
         <div class="upriv"><span class="plabel">Privileges</span>
           <span class="pgroup">${P.map(p => priv(sw(`data-uperm="${p}"`, u.perms[p], PERM_LABELS[p] + ' (host)'), PERM_LABELS[p], PERM_LABELS[p])).join('')}</span>
           <span class="hint">IronLedger support · only in pharmacies switched on above</span></div></div>`
      : `<div class="${rowCls(u)}" data-sub="${esc(u.sub)}"><div class="ucols">${head(u)}${acts(u)}</div>
         <div class="upriv"><span class="plabel">Account type</span>
           <select data-utype><option value="">Not set</option>${Object.entries(ACCT_LABELS).map(([k, l]) => `<option value="${k}"${u.acctType === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
           <span class="hint">Choosing a type sets Submit, Archive, Remove and Backup. Calendar is set separately.</span></div>
         <div class="upriv"><span class="plabel">Pharmacies</span>
           <span class="pgroup">${st.map(s => priv(sw(`data-ust="${esc(s.id)}"`, u.stores[s.id] === true, 'Access to ' + s.name), s.id, 'Access to ' + s.name)).join('')}</span></div>
         <div class="upriv"><span class="plabel">Privileges</span>
           <span class="pgroup">${P.map(p => priv(sw(`data-uperm="${p}"`, u.perms[p], PERM_LABELS[p]), PERM_LABELS[p], PERM_LABELS[p])).join('')}
           ${priv(sw('data-uon="1"', !u.disabled, 'Switch this login on or off'), 'Login on')}</span></div></div>`).join('')}
  </div>`;
}
function fitPeople(){}   // the two-line layout fits any width; nothing to switch
function paintNewPerson(){
  $('npType').innerHTML = '<option value="">Not set</option>' + Object.entries(ACCT_LABELS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  $('npType').onchange = () => { const pre = ACCT_PRESETS[$('npType').value]; if(pre) for(const k in pre){ const c = document.querySelector(`[data-npperm="${k}"]`); if(c) c.checked = pre[k]; } };
  $('npStores').innerHTML = OWN.stores.map(s => `<label class="chk">${sw(`data-npst="${esc(s.id)}"`, OWN.stores.length === 1)} ${esc(s.id)} · ${esc(s.name)}</label>`).join('');
  $('npPerms').innerHTML = Object.entries(PERM_LABELS).map(([p, l]) => `<label class="chk">${sw(`data-npperm="${p}"`, p !== 'export' && p !== 'calendar')} ${l}</label>`).join('');
}
function genTemp(){ const L = 'abcdefghjkmnpqrstuvwxyz', D = '23456789', A = L + D; let p = L[Math.random()*23|0] + D[Math.random()*8|0]; while(p.length < 12) p += A[Math.random()*A.length|0]; return p; }
function showPassBox(html){ $('passBox').innerHTML = html; $('passBox').style.display = 'block'; $('passBox').scrollIntoView({block:'center'}); }
$('npAdd').onclick = async () => {
  const stores = {}; document.querySelectorAll('[data-npst]').forEach(c => stores[c.dataset.npst] = c.checked);
  const perms = {}; document.querySelectorAll('[data-npperm]').forEach(c => perms[c.dataset.npperm] = c.checked);
  const acctType = $('npType').value;
  const body = {name:$('npName').value.trim(), login:$('npLogin').value.trim().toLowerCase(), phone:$('npPhone').value.trim(), tempPassword:$('npPass').value.trim() || undefined, stores, perms, acctType, smsConsent:$('npConsent').checked};
  const say = (m, ok) => { $('npMsg').textContent = m; $('npMsg').className = 'npmsg' + (ok ? ' ok' : ''); };
  say('');
  if(!body.name || !body.login || !body.phone) return say('Name, Login ID and mobile number are all needed.');
  if(!body.smsConsent) return say('Tick the box to confirm they signed the SMS consent form for this number.');
  busy($('npAdd'), true);
  try{
    const r = await api('POST', '/owner/users', body);
    TEMPS[r.user.sub] = r.tempPassword;
    const ids = Object.keys(stores).filter(k => stores[k]);
    showPassBox(`<b>${esc(body.name)} can sign in now.</b> Give them:<br>Pharmacy ID: <b class="mono">${esc(ids.join(' or ') || '(switch one on first)')}</b><br>
      Login ID: <b class="mono">${esc(r.user.login)}</b><br>Temporary password: <b class="mono">${esc(r.tempPassword)}</b><br>
      <span class="hint">They choose their own password the first time they sign in. The temporary password works for 3 days and isn’t shown again.</span>`);
    ['npName','npLogin','npPhone'].forEach(k => $(k).value = ''); $('npPass').value = genTemp(); $('npConsent').checked = false;
    say(`Added ${body.name}. They are at the top of the list as Pending until they sign in for the first time. The form is clear for the next user.`, true);
    paintNewPerson(); $('npName').focus({preventScroll: true});      // pharmacies and permissions back to their defaults too, straight away
    await loadOwner();
  }catch(e){ if(!e.auth) say('Not added: ' + e.message); }
  finally{ busy($('npAdd'), false); }
};
$('npGen').onclick = () => { $('npPass').value = genTemp(); };
$('ownPeople').addEventListener('change', async e => {
  const ty = e.target.closest('select[data-utype]');
  if(ty){                                                         // an account type: stage it and the privileges that go with it
    const sub = ty.closest('[data-sub]').dataset.sub, u = OWN.users.find(x => x.sub === sub); if(!u) return;
    const stg = STAGED[sub] || (STAGED[sub] = {});
    if(ty.value === (u.acctType || '')) delete stg.acctType; else stg.acctType = ty.value;
    const pre = ACCT_PRESETS[ty.value];
    if(pre){ stg.perms = stg.perms || {}; for(const k in pre){ if(pre[k] === !!(u.perms || {})[k]) delete stg.perms[k]; else stg.perms[k] = pre[k]; } if(!Object.keys(stg.perms).length) delete stg.perms; }
    if(!Object.keys(stg).length) delete STAGED[sub];
    peopleMsg(''); renderOwnPeople(); return;
  }
  const c = e.target.closest('input[type=checkbox]'); if(!c) return;
  const sub = c.closest('[data-sub]').dataset.sub, u = OWN.users.find(x => x.sub === sub); if(!u) return;
  stageChange(STAGED, u, c); peopleMsg(''); renderOwnPeople();   // nothing is saved until Update is pressed on the row
});
// record one switch change against the person's saved settings; a change back to the saved value cancels itself
function stageChange(staged, u, c){
  const s = staged[u.sub] || (staged[u.sub] = {});
  const put = (grp, k, v, was) => { s[grp] = s[grp] || {}; if(v === was) delete s[grp][k]; else s[grp][k] = v; if(!Object.keys(s[grp]).length) delete s[grp]; };
  if(c.dataset.ust) put('stores', c.dataset.ust, c.checked, (u.stores || {})[c.dataset.ust] === true);
  else if(c.dataset.uperm) put('perms', c.dataset.uperm, c.checked, !!(u.perms || {})[c.dataset.uperm]);
  else if(c.dataset.uon){ if(!c.checked === !!u.disabled) delete s.disabled; else s.disabled = !c.checked; }
  if(!Object.keys(s).length) delete staged[u.sub];
}
$('ownPeople').addEventListener('click', async e => {
  const r = e.target.closest('[data-reset]'), ph = e.target.closest('[data-phone]'), dl = e.target.closest('[data-del]'), cp = e.target.closest('[data-copy]');
  const up = e.target.closest('[data-upd]'), un = e.target.closest('[data-undo]');
  if(un){ delete STAGED[un.dataset.undo]; peopleMsg(''); renderOwnPeople(); return; }
  if(up){
    const u = OWN.users.find(x => x.sub === up.dataset.upd), body = STAGED[up.dataset.upd]; if(!u || !body) return;
    if(body.disabled === true && !confirm(`Switch off ${u.name || u.login}'s login? They are signed out everywhere and can't sign in until you switch it back on.`)) return;
    busy(up, true);
    try{
      await api('POST', '/owner/users/' + encodeURIComponent(u.sub), body);
      delete STAGED[u.sub];
      peopleMsg(body.disabled === true ? `${u.name || u.login}'s login was switched off. They were signed out.`
        : `${u.name || u.login}'s account access was updated. It takes effect after they sign out and sign back in.`);
      await loadOwner();
    }catch(err){ busy(up, false); if(!err.auth) alert(err.message); }
    return;
  }
  if(cp){
    const u = OWN.users.find(x => x.sub === cp.dataset.copy); if(!u || !TEMPS[u.sub]) return;
    toast(await copyText(signInText(u, TEMPS[u.sub])) ? `Copied ${u.name || u.login}'s sign-in details.` : 'Couldn’t copy. Select the text in the box at the top instead.');
    return;
  }
  if(dl){
    const u = OWN.users.find(x => x.sub === dl.dataset.del);
    const typed = prompt(u.pending ? `Cancel ${u.name || u.login}'s invitation?\n\nThey haven't signed in yet. Their login and temporary password are removed, and the Login ID can be used again.\n\nType their Login ID (${u.login}) to cancel it:` : `Delete ${u.name || u.login} for good?\n\nTheir login is removed and can't be switched back on. Orders and archive lines they entered stay, under their name.\nTo just stop them signing in for now, switch their login off instead.\n\nType their Login ID (${u.login}) to delete:`);
    if(typed === null) return;
    if(typed.trim().toLowerCase() !== u.login) return alert('The Login ID didn’t match. Nothing was deleted.');
    try{ await api('POST', '/owner/users/' + encodeURIComponent(u.sub) + '/delete', {}); toast(u.pending ? `${u.name || u.login}'s invitation was cancelled.` : `${u.name || u.login} was deleted.`); loadOwner(); }catch(err){ if(!err.auth) alert(err.message); }
  }
  if(ph){
    const u = OWN.users.find(x => x.sub === ph.dataset.phone);
    const v = prompt(`New mobile number for ${u.name || u.login} (sign-in codes are texted here):`, u.phone); if(!v) return;
    if(!confirm(`Has ${u.name || u.login} signed a new SMS consent form for ${v}?`)) return toast('Have them sign the SMS consent form for the new number first.');
    try{ await api('POST', '/owner/users/' + encodeURIComponent(u.sub), {phone:v, smsConsent:true}); toast('Mobile number saved.'); loadOwner(); }catch(err){ if(!err.auth) alert(err.message); }
  }
  if(r){
    const u = OWN.users.find(x => x.sub === r.dataset.reset);
    if(!confirm(`Give ${u.name || u.login} a new temporary password? Their current password stops working and they're signed out everywhere.`)) return;
    try{ const res = await api('POST', '/owner/users/' + encodeURIComponent(u.sub) + '/reset-password', {});
      TEMPS[u.sub] = res.tempPassword;
      showPassBox(`<b>New temporary password for ${esc(u.name || u.login)}</b> (Login ID <b class="mono">${esc(u.login)}</b>): <b class="mono">${esc(res.tempPassword)}</b><br><span class="hint">They choose their own password when they next sign in. Use the copy button on their row to copy their sign-in details.</span>`);
      await loadOwner(); }
    catch(err){ if(!err.auth) alert(err.message); }
  }
});
// pharmacies
pharmCardEvents($('ownStores'), { base:'/owner', stores:() => OWN.stores, say:toast, after: async () => { await refreshMe(); await loadOwner(); } });
$('ownStores').addEventListener('click', async e => {
  const nl = e.target.closest('[data-nologo]');
  if(nl && confirm('Remove this pharmacy’s logo?')){
    try{ await api('POST', '/owner/stores/' + encodeURIComponent(nl.dataset.nologo) + '/logo', {dataUrl:null}); LOGOS[nl.dataset.nologo] = ''; paintStore(); loadOwner(); }catch(err){ if(!err.auth) alert(err.message); }
  }
});
// shrink the picture to at most 256 px so it loads instantly on the sign-in screen
function shrinkImage(file){
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, 256 / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      let d = c.toDataURL('image/png'); if(d.length > 200000) d = c.toDataURL('image/jpeg', 0.85);
      res(d);
    };
    img.onerror = () => rej(new Error('That file isn’t a picture this browser can read.')); img.src = url;
  });
}
$('ownStores').addEventListener('change', async e => {
  const f = e.target.closest('[data-logo]'); if(!f || !f.files[0]) return;
  try{ const d = await shrinkImage(f.files[0]); await api('POST', '/owner/stores/' + encodeURIComponent(f.dataset.logo) + '/logo', {dataUrl:d});
    LOGOS[f.dataset.logo] = d; paintStore(); renderOwnStores(); toast('Logo saved. It shows on the sign-in screen for this Pharmacy ID.'); }
  catch(err){ if(!err.auth) alert(err.message); }
});
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
window.ILCAL_HOST = {
  get user(){ return ME ? {name: ME.name || ME.login, login: ME.login} : null; },
  get canStart(){ return !!(ME && ME.owner); },
  get pharmacy(){                                                // what the account already knows, to pre-fill starting the calendar
    if(!STORE) return null;
    const map = {controlled:'controlled', nonsterile:'nonsterile', sterile:'sterile', hazardous:'hazardous', immunizations:'bbp'};
    return {name: STORE.name, tz: STORE.timezone, hours: Array.isArray(STORE.hours) ? STORE.hours : null, closures: STORE.closures || null, ownerName: ME && ME.owner ? (ME.name || '') : '',
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
    if(tab.classList.contains('active')) document.querySelector('#tabs [data-tab="list"]').click();
  }
}

/* ---------------- tabs, render, start ---------------- */
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + b.dataset.tab));
  document.body.classList.toggle('wideTab', b.dataset.tab === 'owner');
  if(b.dataset.tab === 'owner') openOwnerTab();
  if(b.dataset.tab === 'archive') loadArchive(false).catch(() => {});
  if(b.dataset.tab === 'calendar') calShow();
});
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
$('npPass').value = genTemp();

(async function start(){
  if(!CFG.apiUrl || !CFG.clientId){ document.body.innerHTML = '<p style="padding:20px">This copy of the app isn’t set up yet (config.js is missing). Deploy it with deploy.sh.</p>'; return; }
  loadSession();
  if(!SESSION) return showLogin();
  try{ await idToken(); }catch(e){ return showLogin(e.auth ? '' : e.message); }
  await enterApp('');
})();

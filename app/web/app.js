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
    if(code === 'NotAuthorizedException' && /expired/i.test(j.message || '')) msg = 'Your temporary password has expired. Ask the Account Manager for a new one.';
    if(code === 'NotAuthorizedException' && /attempts exceeded/i.test(j.message || '')) msg = 'Too many wrong tries. Wait 15 minutes, then try once more.';
    if(code === 'NotAuthorizedException' && /attempts exceeded/i.test(j.message || '')) msg = 'Too many wrong passwords. Wait a few minutes, or use “Forgot password?”.';
    if(code === 'InvalidPasswordException' || code === 'InvalidParameterException') msg = 'Password must be at least 10 characters and include a lowercase letter and a number.';
    const e = new Error(msg); e.code = code; throw e;
  }
  return j;
}
const SESSION_KEY = 'nortex-cloud-session';
let SESSION = null;                                 // {id, refresh, exp, login}
function saveSession(){ try{ SESSION ? localStorage.setItem(SESSION_KEY, JSON.stringify(SESSION)) : localStorage.removeItem(SESSION_KEY); }catch(e){} }
function loadSession(){ try{ SESSION = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }catch(e){ SESSION = null; } }
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
// each pharmacy's own time zone (set by the Account Manager): all dates and times on its orders use it
const TZ_NAMES = {'America/New_York':'Eastern', 'America/Chicago':'Central', 'America/Denver':'Mountain', 'America/Phoenix':'Arizona (no daylight saving)',
  'America/Los_Angeles':'Pacific', 'America/Anchorage':'Alaska', 'Pacific/Honolulu':'Hawaii', 'America/Puerto_Rico':'Atlantic (Puerto Rico)'};
function storeTZ(){ try{ return (STORE && STORE.timezone) || 'America/Chicago'; }catch(e){ return 'America/Chicago'; } }

/* ---- saving: every change is worked out as a small list of edits and sent in one request ----
   Only the fields that changed are sent, so two people editing different things don't overwrite each other.
   Submitted lines go to the archive first; the server never deletes or overwrites archived lines. */
const LINE_FIELDS = ['dateAdded','item','mfr','ndc','ndc10','pkgSize','qty','src','setid','rxcui','autoPkg','dist','autoDist','ordered','orderedAt','itemEdited'];
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
  $('whoLabel').textContent = ME ? (ME.name || ME.login) + (ME.owner ? ' (Account Manager)' : '') : '';
  // what this login may do
  document.querySelector('#tabs [data-tab="archive"]').style.display = PERM('archive') ? '' : 'none';
  document.querySelector('#tabs [data-tab="owner"]').style.display = ME && ME.owner ? '' : 'none';
  $('submitBtn').style.display = PERM('submit') ? '' : 'none';
  $('submitOff').style.display = ME && !PERM('submit') ? '' : 'none';
  $('exportCard').style.display = PERM('export') ? '' : 'none';
  renderStoreInfo();
}
function renderStoreInfo(){
  const s = STORE; if(!s){ $('storeInfo').innerHTML = ''; return; }
  const row = (k, v) => v ? `<tr><th style="width:140px;">${k}</th><td>${esc(v)}</td></tr>` : '';
  $('storeInfo').innerHTML = `<table>${row('Pharmacy ID', s.id)}${row('Name', s.name)}${row('Address', [[s.address, s.suite].filter(Boolean).join(', '), [s.city, [s.state, s.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', '))}${row('Phone', s.phone)}${row('Fax', s.fax)}${row('Email', s.email)}${row('License #', s.license)}${row('Time zone', TZ_NAMES[storeTZ()] || storeTZ())}</table>`;
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
  $('liUser').value = $('liUser').value || lget('nortex-last-login');
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
  paintLogin('Sign-in needs a step this app doesn’t support (' + res.ChallengeName + '). Tell the Account Manager.');
}
$('liGo').onclick = async () => {
  const pharm = $('liPharm').value.trim().toUpperCase(), user = $('liUser').value.trim().toLowerCase(), pw = $('liPass').value;
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
    return showLogin(`Your login isn’t switched on for pharmacy ${want}. Check the Pharmacy ID, or ask the Account Manager.`);
  }
  if(!ME.stores.length){ signOut(true); return showLogin('Your login isn’t switched on for any pharmacy yet. Ask the Account Manager.'); }
  try{ localStorage.setItem('nortex-last-login', ME.login); }catch(e){}
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
  if(!quiet) showLogin('Signed out.');
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
    pkgSize: mem.pkgSize || shortPkg(o.pkg), qty:1, src:o.src || 'rxnav', rxcui:o.rxcui || ''};
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
  const rows = STATE.reorder;
  $('openCount').textContent = rows.length;
  const done = rows.filter(r => r.ordered).length;
  $('orderedCount').textContent = rows.length ? `Ordered: ${done} of ${rows.length}` : '';
  $('submitBtn').disabled = !rows.length || !PERM('submit');
  $('listBody').innerHTML = rows.length ? rows.map(r => `<tr data-id="${esc(r.id)}" data-ndc="${esc(r.ndc)}"${r.ordered ? ' class="is-ordered"' : ''}>
      <td class="added">${fmtDate(r.dateAdded)}${r.addedBy ? `<div class="added-by">by ${esc(r.addedBy)}</div>` : ''}</td>
      <td class="drug"><b>${esc(r.item)}</b> <button class="edit" data-edit="${esc(r.id)}" title="Edit to match the bottle or box (remembered for next time)">✎</button>${r.src === 'manual' ? '<div class="maker">entered by hand</div>' : ''}</td>
      <td class="ndc" data-l="NDC"><input type="text" class="ndcin" data-ndcin="${esc(r.id)}" data-rx="${esc(r.rxcui || '')}" value="${esc(r.ndc)}" placeholder="${r.rxcui ? 'Pick or type NDC' : 'Type NDC'}" autocomplete="off" spellcheck="false"></td>
      <td class="mfr" data-l="Manufacturer">${r.mfr ? esc(r.mfr) : '<span class="maker">' + (r.ndc ? '—' : 'choose an NDC') + '</span>'}</td>
      <td class="dist" data-l="Distributor"><select data-f="dist" class="${r.dist ? '' : 'need'}" title="${r.dist && r.dist === r.autoDist ? 'Filled in from the last time this was ordered' : 'Where this is ordered from'}">
        <option value="">Choose distributor…</option>${distOptions(r.dist, distHistory(STATE, r.ndc, r.item))}</select>${r.dist && r.dist === r.autoDist ? '<div class="maker">last used</div>' : ''}</td>
      <td class="pkg" data-l="Pkg Size"><input type="text" data-f="pkgSize" value="${esc(r.pkgSize)}" placeholder="e.g. 100 ct"></td>
      <td class="qty" data-l="Qty"><input type="number" inputmode="numeric" min="1" data-f="qty" value="${esc(r.qty)}"></td>
      <td class="chk" data-l="Ordered"><input type="checkbox" data-f="ordered" ${r.ordered ? 'checked' : ''} title="${r.ordered ? 'Ordered' + (r.orderedBy ? ' by ' + esc(r.orderedBy) : '') + (r.orderedAt ? ' ' + new Date(r.orderedAt).toLocaleString([], {month:'numeric', day:'numeric', hour:'numeric', minute:'2-digit', timeZone:storeTZ(), timeZoneName:'short'}) : '') : 'Tick once this has been ordered'}"></td>
      <td>${dm(r.ndc10 || r.ndc, r.setid)}</td>
      <td>${PERM('remove') ? `<button class="x" data-del="${esc(r.id)}" title="Remove from list">×</button>` : ''}</td>
    </tr>`).join('') : '<tr><td colspan="10" class="empty">Nothing to order yet. Search above to add a drug.</td></tr>';
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
    if(f === 'ordered') r.orderedAt = val ? new Date().toISOString() : ''; });
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


/* ---------------- Account Manager tab: pharmacies, people, access switches, import ----------------
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
const PERM_LABELS = {submit:'Submit orders', archive:'View archive', remove:'Remove lines', export:'Download backup'};
let OWN = {stores:[], users:[]};
async function loadOwner(){
  if(!ME || !ME.owner) return;
  $('ownStores').innerHTML = $('ownPeople').innerHTML = '<div class="hint"><span class="spin"></span>Loading…</div>';
  try{
    const [s, u] = await Promise.all([api('GET', '/owner/stores'), api('GET', '/owner/users')]);
    OWN = {stores:s.stores, users:u.users};
    for(const st of OWN.stores) if(st.hasLogo && LOGOS[st.id] === undefined) loadLogo(st.id).then(renderOwnStores);
    renderOwner();
  }catch(e){ if(!e.auth) $('ownPeople').innerHTML = `<div class="banner warn">${esc(e.message)}</div>`; }
}
function renderOwner(){ renderOwnStores(); renderOwnPeople(); paintNewPerson(); $('impStore').innerHTML = OWN.stores.map(s => `<option value="${esc(s.id)}">${esc(s.id)} · ${esc(s.name)}</option>`).join(''); }
const SF = [['name','Pharmacy name'],['address','Street address'],['suite','Suite / unit (if any)'],['city','City'],['state','State'],['zip','ZIP code'],['phone','Phone'],['fax','Fax'],['email','Email'],['license','License #'],['timezone','Time zone']];
const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
const stateSelect = (attrs, cur) => `<select ${attrs}><option value=""></option>${US_STATES.map(v => `<option${v === (cur || '') ? ' selected' : ''}>${v}</option>`).join('')}</select>`;
const tzSelect = (attrs, cur) => `<select ${attrs}>${Object.entries(TZ_NAMES).map(([v, l]) => `<option value="${v}"${v === (cur || 'America/Chicago') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
function renderOwnStores(){
  $('ownStores').innerHTML = OWN.stores.map(s => `<div class="pcard" data-store="${esc(s.id)}">
      <div class="plogo">${LOGOS[s.id] ? `<img src="${esc(LOGOS[s.id])}" alt="">` : '<span class="hint">No logo</span>'}
        <label class="btn2 small">Upload logo<input type="file" accept="image/png,image/jpeg,image/webp" data-logo="${esc(s.id)}" hidden></label>
        ${LOGOS[s.id] ? `<button class="btn2 small" data-nologo="${esc(s.id)}">Remove</button>` : ''}</div>
      <div class="pfields"><div class="pid">Pharmacy ID: <b>${esc(s.id)}</b> <span class="hint">(what people type when they sign in)</span></div>
        ${SF.map(([k, l]) => `<label><span>${l}</span>${k === 'timezone' ? tzSelect(`data-sf="timezone"`, s.timezone) : k === 'state' ? stateSelect(`data-sf="state"`, s.state) : `<input type="text" data-sf="${k}" value="${esc(s[k] || '')}"${k === 'address' ? ' class="wide"' : ''}>`}</label>`).join('')}
        <div><button class="btn small" data-savestore="${esc(s.id)}">Save details</button></div></div>
    </div>`).join('') || '<div class="hint">No pharmacies yet.</div>';
}
const fmtDay = iso => { try{ return new Date(iso).toLocaleDateString('en-US', {month:'short', day:'numeric'}); }catch(e){ return ''; } };
function statusBadge(u){
  if(u.disabled) return '<span class="ustat off">Login off</span>';
  if(u.pending && u.tempExpired) return `<span class="ustat bad">Temporary password expired</span><div class="maker">Reset password to send a new one</div>`;
  if(u.pending) return `<span class="ustat wait">Pending</span><div class="maker">Hasn’t signed in yet${u.tempExpires ? ' · temporary password good until ' + fmtDay(u.tempExpires) : ''}</div>`;
  return '<span class="ustat ok">Active</span>';
}
const sw = (attrs, on, title) => `<label class="switch" title="${esc(title || '')}"><input type="checkbox" ${attrs}${on ? ' checked' : ''}><span></span></label>`;
function renderOwnPeople(){
  const st = OWN.stores, P = Object.keys(PERM_LABELS);
  $('ownPeople').innerHTML = `<div class="tscroll"><table class="people"><thead><tr><th>Person</th><th>Status</th><th>Mobile</th>
      ${st.map(s => `<th class="c" title="${esc(s.name)}">${esc(s.id)}</th>`).join('')}
      ${P.map(p => `<th class="c">${PERM_LABELS[p]}</th>`).join('')}<th class="c">Login on</th><th></th></tr></thead><tbody>
    ${OWN.users.map(u => u.owner ? `<tr><td data-l="Person"><b>${esc(u.name || u.login)}</b><div class="maker">${esc(u.login)} · Account Manager</div></td><td data-l="Status">${statusBadge(u)}</td><td data-l="Mobile">${esc(u.phone)}</td>
        <td colspan="${st.length + P.length + 2}" class="hint">Full access to every pharmacy (can’t be changed)</td></tr>`
      : u.host ? `<tr data-sub="${esc(u.sub)}"${u.disabled ? ' class="off"' : ''}><td data-l="Person"><b>${esc(u.name || u.login)}</b><div class="maker">${esc(u.login)} · Host (IronLedger)</div></td><td data-l="Status">${statusBadge(u)}</td><td data-l="Mobile">${esc(u.phone)}</td>
        ${st.map(s => `<td class="c" data-l="${esc(s.id)}">${sw(`data-ust="${esc(s.id)}"`, u.stores[s.id] === true, 'Let the host open ' + s.name)}</td>`).join('')}
        <td colspan="${P.length + 2}" class="hint">Runs the program for you: passwords, phones, logins. Sees a pharmacy’s list only if you switch it on here.</td></tr>`
      : `<tr data-sub="${esc(u.sub)}"${u.disabled ? ' class="off"' : ''}><td data-l="Person"><b>${esc(u.name || u.login)}</b><div class="maker">${esc(u.login)}</div></td><td data-l="Status">${statusBadge(u)}</td>
        <td data-l="Mobile">${esc(u.phone)} <button class="edit" data-phone="${esc(u.sub)}" title="Change mobile number">✎</button></td>
        ${st.map(s => `<td class="c" data-l="${esc(s.id)}">${sw(`data-ust="${esc(s.id)}"`, u.stores[s.id] === true, 'Access to ' + s.name)}</td>`).join('')}
        ${P.map(p => `<td class="c" data-l="${PERM_LABELS[p]}">${sw(`data-uperm="${p}"`, u.perms[p], PERM_LABELS[p])}</td>`).join('')}
        <td class="c" data-l="Login on">${sw('data-uon="1"', !u.disabled, 'Switch this login on or off')}</td>
        <td><button class="btn2 small" data-reset="${esc(u.sub)}">Reset password</button> <button class="btn2 small danger" data-del="${esc(u.sub)}">${u.pending ? 'Cancel invite' : 'Delete'}</button></td></tr>`).join('')}
    </tbody></table></div>`;
}
function paintNewPerson(){
  $('npStores').innerHTML = OWN.stores.map(s => `<label class="chk">${sw(`data-npst="${esc(s.id)}"`, OWN.stores.length === 1)} ${esc(s.id)} · ${esc(s.name)}</label>`).join('');
  $('npPerms').innerHTML = Object.entries(PERM_LABELS).map(([p, l]) => `<label class="chk">${sw(`data-npperm="${p}"`, p !== 'export')} ${l}</label>`).join('');
}
function genTemp(){ const L = 'abcdefghjkmnpqrstuvwxyz', D = '23456789', A = L + D; let p = L[Math.random()*23|0] + D[Math.random()*8|0]; while(p.length < 12) p += A[Math.random()*A.length|0]; return p; }
function showPassBox(html){ $('passBox').innerHTML = html; $('passBox').style.display = 'block'; $('passBox').scrollIntoView({block:'center'}); }
$('npAdd').onclick = async () => {
  const stores = {}; document.querySelectorAll('[data-npst]').forEach(c => stores[c.dataset.npst] = c.checked);
  const perms = {}; document.querySelectorAll('[data-npperm]').forEach(c => perms[c.dataset.npperm] = c.checked);
  const body = {name:$('npName').value.trim(), login:$('npLogin').value.trim().toLowerCase(), phone:$('npPhone').value.trim(), tempPassword:$('npPass').value.trim() || undefined, stores, perms, smsConsent:$('npConsent').checked};
  const say = (m, ok) => { $('npMsg').textContent = m; $('npMsg').className = 'npmsg' + (ok ? ' ok' : ''); };
  say('');
  if(!body.name || !body.login || !body.phone) return say('Name, Login ID and mobile number are all needed.');
  if(!body.smsConsent) return say('Tick the box to confirm they signed the SMS consent form for this number.');
  busy($('npAdd'), true);
  try{
    const r = await api('POST', '/owner/users', body);
    const ids = Object.keys(stores).filter(k => stores[k]);
    showPassBox(`<b>${esc(body.name)} can sign in now.</b> Give them:<br>Pharmacy ID: <b class="mono">${esc(ids.join(' or ') || '(switch one on first)')}</b><br>
      Login ID: <b class="mono">${esc(r.user.login)}</b><br>Temporary password: <b class="mono">${esc(r.tempPassword)}</b><br>
      <span class="hint">They choose their own password the first time they sign in. The temporary password works for 7 days and isn’t shown again.</span>`);
    ['npName','npLogin','npPhone'].forEach(k => $(k).value = ''); $('npPass').value = genTemp(); $('npConsent').checked = false;
    say(`Added ${body.name}. They are at the top of the list as Pending until they sign in for the first time. The form is clear for the next person.`, true);
    await loadOwner();
    paintNewPerson(); $('npName').focus({preventScroll: true});      // pharmacies and permissions back to their defaults too
  }catch(e){ if(!e.auth) say('Not added: ' + e.message); }
  finally{ busy($('npAdd'), false); }
};
$('npGen').onclick = () => { $('npPass').value = genTemp(); };
$('ownPeople').addEventListener('change', async e => {
  const c = e.target.closest('input[type=checkbox]'); if(!c) return;
  const sub = c.closest('tr').dataset.sub, u = OWN.users.find(x => x.sub === sub); if(!u) return;
  let body;
  if(c.dataset.ust) body = {stores:{[c.dataset.ust]:c.checked}};
  else if(c.dataset.uperm) body = {perms:{[c.dataset.uperm]:c.checked}};
  else if(c.dataset.uon){
    if(!c.checked && !confirm(`Switch off ${u.name || u.login}'s login? They are signed out everywhere and can't sign in until you switch it back on.`)){ c.checked = true; return; }
    body = {disabled:!c.checked};
  }
  c.disabled = true;
  try{ await api('POST', '/owner/users/' + encodeURIComponent(sub), body); toast('Saved: ' + (u.name || u.login)); await loadOwner(); }
  catch(e){ c.checked = !c.checked; if(!e.auth) alert(e.message); }
  finally{ c.disabled = false; }
});
$('ownPeople').addEventListener('click', async e => {
  const r = e.target.closest('[data-reset]'), ph = e.target.closest('[data-phone]'), dl = e.target.closest('[data-del]');
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
      showPassBox(`<b>New temporary password for ${esc(u.name || u.login)}</b> (Login ID <b class="mono">${esc(u.login)}</b>): <b class="mono">${esc(res.tempPassword)}</b><br><span class="hint">They choose their own password when they next sign in.</span>`); }
    catch(err){ if(!err.auth) alert(err.message); }
  }
});
// pharmacies
$('ownStores').addEventListener('click', async e => {
  const sv = e.target.closest('[data-savestore]'), nl = e.target.closest('[data-nologo]');
  if(sv){
    const card = sv.closest('.pcard'), body = {}; card.querySelectorAll('[data-sf]').forEach(i => body[i.dataset.sf] = i.value.trim());
    busy(sv, true);
    try{ await api('POST', '/owner/stores/' + encodeURIComponent(sv.dataset.savestore), body); toast('Pharmacy details saved.'); await refreshMe(); loadOwner(); }
    catch(err){ if(!err.auth) alert(err.message); } finally{ busy(sv, false); }
  }
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
$('psAdd').onclick = async () => {
  const body = {id:$('psId').value.trim().toUpperCase()}; SF.forEach(([k]) => body[k] = $('ps_' + k).value.trim());
  if(!body.id || !body.name) return toast('Pharmacy ID and name are needed.');
  busy($('psAdd'), true);
  try{ await api('POST', '/owner/stores', body); toast('Pharmacy added: ' + body.id); $('psId').value = ''; SF.forEach(([k]) => { if(k !== 'timezone' && k !== 'state') $('ps_' + k).value = ''; }); await refreshMe(); loadOwner(); }
  catch(err){ if(!err.auth) alert(err.message); } finally{ busy($('psAdd'), false); }
};
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

/* ---------------- tabs, render, start ---------------- */
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + b.dataset.tab));
  if(b.dataset.tab === 'owner') openOwnerTab();
  if(b.dataset.tab === 'archive') loadArchive(false).catch(() => {});
});
function renderAll(){ renderList(); renderArchive(); }
if('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
$('npPass').value = genTemp();

(async function start(){
  if(!CFG.apiUrl || !CFG.clientId){ document.body.innerHTML = '<p style="padding:20px">This copy of the app isn’t set up yet (config.js is missing). Deploy it with deploy.sh.</p>'; return; }
  loadSession();
  if(!SESSION) return showLogin();
  try{ await idToken(); }catch(e){ return showLogin(e.auth ? '' : e.message); }
  await enterApp('');
})();

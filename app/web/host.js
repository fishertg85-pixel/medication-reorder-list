/* IronLedger employee portal: a separate sign-in for IronLedger employees only (its own app client; a pharmacy login is refused like a wrong password).
   Clients → pharmacies → one pharmacy's account, users and billing. Talks to /host/* and to the one-pharmacy views; the server decides what each login may see.
   The sign-in is kept for this browser tab only, and the page locks after 5 minutes without activity. */
'use strict';
const CFG = window.NORTEX_CONFIG || {};
const CID = CFG.portalClientId || CFG.clientId;       // the portal's own sign-in client (falls back to the app's in dev)
const COG = CFG.cognitoEndpoint || `https://cognito-idp.${CFG.region}.amazonaws.com/`;
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const LOCK_MS = 5 * 60 * 1000;
const TZ_NAMES = {'America/New_York':'Eastern', 'America/Chicago':'Central', 'America/Denver':'Mountain', 'America/Phoenix':'Arizona (no daylight saving)',
  'America/Los_Angeles':'Pacific', 'America/Anchorage':'Alaska', 'Pacific/Honolulu':'Hawaii', 'America/Puerto_Rico':'Atlantic (Puerto Rico)'};
const PERMS = {submit:'Submit orders', archive:'View archive', remove:'Remove lines', export:'Download backup'};

/* ---- Cognito, called directly ---- */
const COG_ERR = {
  NotAuthorizedException: 'Incorrect ID or password.', UserNotFoundException: 'Incorrect ID or password.', UserLambdaValidationException: 'Incorrect ID or password.',
  CodeMismatchException: 'That code isn’t right. Check the text message and try again.', ExpiredCodeException: 'That code has expired. Start again.',
  LimitExceededException: 'Too many tries. Wait a few minutes.', TooManyRequestsException: 'Too many tries. Wait a few minutes.'
};
async function cog(target, body){
  let r;
  try{ r = await fetch(COG, {method:'POST', headers:{'Content-Type':'application/x-amz-json-1.1', 'X-Amz-Target':'AWSCognitoIdentityProviderService.' + target}, body:JSON.stringify(body)}); }
  catch(e){ throw new Error('Can’t reach the sign-in service. Check the internet connection.'); }
  const j = await r.json().catch(() => ({}));
  if(!r.ok){
    const code = String(j.__type || '').split('#').pop();
    let msg = COG_ERR[code] || (code === 'UserLambdaValidationException' ? 'Incorrect ID or password.' : j.message) || 'Sign-in failed.';
    if(code === 'NotAuthorizedException' && /disabled/i.test(j.message || '')) msg = 'This login is switched off.';
    if(code === 'NotAuthorizedException' && /expired/i.test(j.message || '')) msg = 'The temporary password has expired. Run host.sh make-host again for a new one.';
    if(code === 'NotAuthorizedException' && /attempts exceeded/i.test(j.message || '')) msg = 'Too many wrong tries. Wait 15 minutes, then try once more.';
    if(code === 'InvalidPasswordException' || code === 'InvalidParameterException') msg = 'Password must be at least 10 characters with a lowercase letter and a number.';
    const e = new Error(msg); e.code = code; throw e;
  }
  return j;
}
const KEY = 'ironledger-host-session';                 // this tab only: closing it signs you out
let SES = null;
const store = () => { try{ SES ? sessionStorage.setItem(KEY, JSON.stringify(SES)) : sessionStorage.removeItem(KEY); }catch(e){} };
const expOf = t => { try{ return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000; }catch(e){ return 0; } };
function setTokens(a){ SES = {id:a.IdToken, access:a.AccessToken || (SES && SES.access), refresh:a.RefreshToken || (SES && SES.refresh), exp:expOf(a.IdToken)}; store(); }
async function idToken(force){
  if(!SES) throw authErr();
  if(!force && SES.exp - 120000 > Date.now()) return SES.id;
  try{ const j = await cog('InitiateAuth', {ClientId:CID, AuthFlow:'REFRESH_TOKEN_AUTH', AuthParameters:{REFRESH_TOKEN:SES.refresh}}); setTokens(j.AuthenticationResult); return SES.id; }
  catch(e){ if(e.code){ SES = null; store(); throw authErr(); } throw e; }
}
function authErr(){ const e = new Error('Please sign in again.'); e.auth = true; return e; }

/* ---- the server: /host/* only ---- */
let OUTING = null;                                         // the sign-out under way, if any (see signOut)
async function api(method, path, body, retried){
  const ses = SES;                                         // the sign-in this request belongs to: a late answer from an earlier sign-in, or one that arrives while signing out, must not sign the page out again
  let tok; try{ tok = await idToken(); }catch(e){ if(e.auth) showSign('Please sign in again.'); throw e; }
  let r;
  try{ r = await fetch(CFG.apiUrl.replace(/\/$/, '') + path, {method, headers:{Authorization:'Bearer ' + tok, ...(body ? {'Content-Type':'application/json'} : {})}, body:body ? JSON.stringify(body) : undefined, cache:'no-store'}); }
  catch(e){ throw new Error('No connection to the server. Check the internet.'); }
  if(r.status === 401 && !retried){ try{ await idToken(true); }catch(e){ showSign('Please sign in again.'); throw e; } return api(method, path, body, true); }
  const j = await r.json().catch(() => ({}));
  if(r.status === 423){ lockNow('Locked after 5 minutes without activity.', true); const e = new Error(j.error); e.auth = true; throw e; }
  if(r.status === 404 && path.startsWith('/host')){ if(ses && SES === ses && !OUTING) await signOut('Incorrect ID or password.'); const e = new Error('Not an employee'); e.auth = true; throw e; }
  if(r.status === 403 && path === '/me'){ if(ses && SES === ses && !OUTING) await signOut('This login is switched off.'); const e = new Error('off'); e.auth = true; throw e; }
  if(!r.ok){ const e = new Error(j.error || j.message || ('Server answered ' + r.status)); e.status = r.status; throw e; }
  UNTIL = Date.now() + LOCK_MS;
  return j;
}

/* ---- screens ---- */
let ME = null, UNTIL = 0, lastAct = 0, pingAt = 0, DATA = {stores:[], users:[], clients:[]}, LOGOS = {};
const NAV = {client:null, pharm:null, view:'acct'};       // client: null (the start page) | IL-id; pharm: a pharmacy ID; view: acct | users | billing (one pharmacy at a time)
const TEMPS = {};                                         // temporary passwords made in this tab, so they can be copied again while the person is pending
const PS = {U:null, B:null, st:drState(TEMPS), bo:{edit:true, filter:'all'}};      // the open pharmacy's people and billing
const SIGN = {step:'start', session:null, user:'', pw:''};
function only(id){ ['gSign', 'gLock', 'gBody'].forEach(k => $(k).style.display = k === id ? '' : 'none'); document.body.classList.toggle('hshell', id === 'gBody'); }
function clearData(){ DATA = {stores:[], users:[], clients:[]}; LOGOS = {}; NAV.client = NAV.pharm = null; NAV.view = 'acct'; PS.U = PS.B = null; PS.st.open = null; for(const k in PS.st.staged) delete PS.st.staged[k]; PS.bo.filter = 'all';
  ['vNew', 'vClient', 'vPharm', 'vUsers', 'vBill', 'side', 'gHits'].forEach(k => $(k).innerHTML = ''); $('gFind').value = ''; $('gHits').hidden = true; $('clientMsg').textContent = ''; $('pmodal').hidden = true; $('newStore').innerHTML = ''; $('passBox').style.display = 'none'; $('passBox').innerHTML = ''; }
function showSign(msg, ok){
  ME = null; UNTIL = 0; clearData(); only('gSign');
  SIGN.step = 'start'; SIGN.pw = ''; $('sPass').value = '';
  paintSign(msg, ok); setTimeout(() => ($('sUser').value ? $('sPass') : $('sUser')).focus(), 30);
}
function paintSign(msg, ok){
  $('sStart').style.display = SIGN.step === 'start' ? '' : 'none';
  $('sNew').style.display = SIGN.step === 'newpw' ? '' : 'none';
  $('sCode').style.display = SIGN.step === 'code' ? '' : 'none';
  $('sMsg').textContent = msg || ''; $('sMsg').className = 'msg' + (ok ? ' ok' : '');
}
function busy(b, on){ b.disabled = on; b.dataset.t = b.dataset.t || b.textContent; b.textContent = on ? 'Please wait…' : b.dataset.t; }
async function afterAuth(res){
  if(res.AuthenticationResult){ setTokens(res.AuthenticationResult); return enter(SIGN.pw); }
  SIGN.session = res.Session;
  if(res.ChallengeName === 'NEW_PASSWORD_REQUIRED'){ SIGN.step = 'newpw'; paintSign('Welcome. Choose your own password.', true); $('sNew1').focus(); return; }
  if(res.ChallengeName === 'SMS_MFA'){
    $('sDest').textContent = (res.ChallengeParameters && res.ChallengeParameters.CODE_DELIVERY_DESTINATION) || 'your phone';
    SIGN.step = 'code'; paintSign(''); $('sCodeIn').value = ''; $('sCodeIn').focus(); return;
  }
  paintSign('Sign-in needs a step this page doesn’t support (' + res.ChallengeName + ').');
}
$('sGo').onclick = async () => {
  const user = $('sUser').value.trim().toLowerCase(), pw = $('sPass').value.trim();
  if(!user || !pw) return paintSign('Enter your Login ID and password.');
  SIGN.user = user; SIGN.pw = pw; busy($('sGo'), true);
  try{ await afterAuth(await cog('InitiateAuth', {ClientId:CID, AuthFlow:'USER_PASSWORD_AUTH', AuthParameters:{USERNAME:user, PASSWORD:pw}})); }
  catch(e){ SIGN.pw = ''; paintSign(e.message); } finally{ busy($('sGo'), false); }
};
$('sPass').addEventListener('keydown', e => { if(e.key === 'Enter') $('sGo').click(); });
$('sNewGo').onclick = async () => {
  const a = $('sNew1').value, b = $('sNew2').value;
  if(a.length < 10 || !/[a-z]/.test(a) || !/\d/.test(a)) return paintSign('At least 10 characters, with a lowercase letter and a number.');
  if(a !== b) return paintSign('The two passwords don’t match.');
  busy($('sNewGo'), true);
  try{ SIGN.pw = a; await afterAuth(await cog('RespondToAuthChallenge', {ClientId:CID, ChallengeName:'NEW_PASSWORD_REQUIRED', Session:SIGN.session, ChallengeResponses:{USERNAME:SIGN.user, NEW_PASSWORD:a}})); $('sNew1').value = $('sNew2').value = ''; }
  catch(e){ paintSign(e.message); } finally{ busy($('sNewGo'), false); }
};
$('sCodeGo').onclick = async () => {
  const code = $('sCodeIn').value.replace(/\D/g, '');
  if(code.length < 6) return paintSign('Enter the 6-digit code from the text message.');
  busy($('sCodeGo'), true);
  try{ await afterAuth(await cog('RespondToAuthChallenge', {ClientId:CID, ChallengeName:'SMS_MFA', Session:SIGN.session, ChallengeResponses:{USERNAME:SIGN.user, SMS_MFA_CODE:code}})); }
  catch(e){ if(e.code === 'NotAuthorizedException'){ SIGN.step = 'start'; SIGN.pw = ''; paintSign('That took too long. Sign in again.'); } else paintSign(e.message); }
  finally{ busy($('sCodeGo'), false); }
};
$('sCodeIn').addEventListener('keydown', e => { if(e.key === 'Enter') $('sCodeGo').click(); });
$('sBack').onclick = () => showSign('');

// signed in: make sure this is the host login, then open (the password just typed opens the page; it isn't kept)
async function enter(pw){
  try{ ME = await api('GET', '/me'); }catch(e){ return; }
  if(!ME.host){ return signOut('Incorrect ID or password.'); }
  $('bWho').textContent = ME.name || ME.login;
  if(pw){ SIGN.pw = ''; return unlock(pw, $('sMsg')); }
  showLock('');
}
function showLock(msg){ UNTIL = 0; clearData(); only('gLock'); $('lPass').value = ''; $('lMsg').textContent = msg || ''; setTimeout(() => $('lPass').focus(), 30); }
async function unlock(pw, msgEl){
  try{
    await api('POST', '/host-unlock', {password:pw, accessToken:SES && SES.access});
    UNTIL = Date.now() + LOCK_MS; lastAct = pingAt = Date.now(); only('gBody'); load();
  }catch(e){ if(!e.auth){ if(msgEl === $('sMsg')) showLock(e.message); else { $('lMsg').textContent = e.message; $('lPass').select(); } } }
}
$('lGo').onclick = async () => { const pw = $('lPass').value; if(!pw) return; busy($('lGo'), true); try{ await unlock(pw, $('lMsg')); } finally{ busy($('lGo'), false); $('lPass').value = ''; } };
$('lPass').addEventListener('keydown', e => { if(e.key === 'Enter') $('lGo').click(); });
function lockNow(msg, serverSaid){
  const was = UNTIL > 0; UNTIL = 0;
  if(was && !serverSaid) api('POST', '/host-lock', {}).catch(() => {});
  if(ME) showLock(msg);
}
// One sign-out at a time: several answers refusing the same sign-in (a login that is not an employee gets one per request) share it,
// so the sign-in box is drawn once and what the person types next is not wiped by a late answer.
function signOut(msg){ if(!OUTING) OUTING = doSignOut(msg).finally(() => { OUTING = null; }); return OUTING; }
async function doSignOut(msg){
  const ses = SES;
  if(ses){
    try{ if(UNTIL > 0) await api('POST', '/host-lock', {}); }catch(e){}
    try{ await cog('RevokeToken', {ClientId:CID, Token:ses.refresh}); }catch(e){}
  }
  if(SES === ses){ SES = null; store(); }
  for(const k in TEMPS) delete TEMPS[k]; showSign(msg || 'Signed out.', !msg);
}
$('lOut').onclick = () => signOut();
$('bOut').onclick = async () => { if(await UG.leave()) signOut(); };
$('bLock').onclick = async () => { if(await UG.leave()) lockNow('Locked.'); };
$('bRefresh').onclick = async () => { if(await UG.leave()) load(); };
['keydown', 'pointerdown', 'input', 'wheel'].forEach(t => $('gBody').addEventListener(t, () => { lastAct = Date.now(); }, {passive:true}));
setInterval(() => {
  if(!(UNTIL > 0)) return;
  const now = Date.now();
  if(now - lastAct > LOCK_MS || now > UNTIL) return lockNow('Locked after 5 minutes without activity.');
  if(lastAct > pingAt && now - pingAt > 60000){ pingAt = now; api('POST', '/host/keepalive', {}).catch(() => {}); }
}, 15000);

/* ---- what an IronLedger employee can do ---- */
const enc = encodeURIComponent;
async function load(){
  try{
    const [s, u, me, cl] = await Promise.all([api('GET', '/host/stores'), api('GET', '/host/users'), api('GET', '/me'), api('GET', '/host/clients')]);
    DATA = {stores:s.stores, users:u.users.filter(x => !x.employeeOnly), me, clients:cl.clients};
    if(NAV.client && !DATA.clients.some(k => k.id === NAV.client)) NAV.client = NAV.pharm = null;
    if(NAV.pharm && !DATA.stores.some(x => x.id === NAV.pharm)) NAV.pharm = null;
    for(const k in TEMPS) if(!DATA.users.some(x => x.sub === k && x.pending)) delete TEMPS[k];
    await loadPharm();
    render();
  }catch(e){ if(!e.auth) $('clientMsg').innerHTML = `<span class="msg">${esc(e.message)}</span>`; }
}
// the open pharmacy's people or billing: one pharmacy at a time, read from the server when its button is pressed
async function loadPharm(){
  PS.U = PS.B = null;
  if(!NAV.pharm || NAV.view === 'acct') return;
  try{
    if(NAV.view === 'users'){ PS.U = await api('GET', '/pharmacy/' + enc(NAV.pharm) + '/users'); for(const k in PS.st.staged) if(!PS.U.users.some(x => x.sub === k)) delete PS.st.staged[k]; }
    else PS.B = await api('GET', '/host/stores/' + enc(NAV.pharm) + '/billing');
  }catch(e){ if(e.auth) throw e; $('clientMsg').innerHTML = `<span class="msg">${esc(e.message)}</span>`; }
}
const isRepMe = () => !!(DATA.me && DATA.me.hostRole === 'rep');
const clientOf = id => (DATA.clients || []).find(k => k.id === id);
const storeOf = id => DATA.stores.find(s => s.id === id);
const clientLabel = k => k ? (k.dba || k.legalName) : '';
const holderOf = s => { const o = ownInfo(s, DATA.users).owner; return o ? ownLabel(o) : 'Not set yet'; };
const sayStore = t => { $('clientMsg').textContent = t; };
function showPass(html){ $('passBox').innerHTML = html; $('passBox').style.display = 'block'; $('passBox').scrollIntoView({block:'center'}); }
function goto(client, pharm, view){ NAV.client = client || null; NAV.pharm = pharm || null; NAV.view = view || 'acct'; PS.st.open = null; PS.bo.filter = 'all'; $('clientMsg').textContent = ''; $('gHits').hidden = true; load(); }

function render(){
  renderNav();
  const keep = $('impStore').value;
  $('impStore').innerHTML = DATA.stores.map(s => `<option value="${esc(s.id)}">${esc(s.id)} · ${esc(s.name)}</option>`).join('');
  if(keep && DATA.stores.some(s => s.id === keep)) $('impStore').value = keep;
  for(const s of DATA.stores) if(s.hasLogo && LOGOS[s.id] === undefined) loadLogo(s.id);
}
const unlinked = () => DATA.stores.filter(s => !s.clientId);
function renderNav(){
  const rep_ = isRepMe(), clients = DATA.clients || [];
  if(NAV.pharm && !NAV.client){ const s0 = storeOf(NAV.pharm); if(s0 && s0.clientId) NAV.client = s0.clientId; }       // linked to a client: it now lives inside that client
  const k = NAV.client ? clientOf(NAV.client) : null, s = NAV.pharm ? storeOf(NAV.pharm) : null;
  // breadcrumb: Clients › client › pharmacy › Users / Billing
  const lk = (w, t) => `<button class="lk" data-crumb="${w}">${esc(t)}</button>`;
  const parts = [];
  if(!k && !s) parts.push('<b>Clients</b>');
  else{
    parts.push(lk('home', 'Clients'));
    if(k) parts.push(s ? lk('client', clientLabel(k)) : `<b>${esc(clientLabel(k))}</b>`);
    if(s) parts.push(NAV.view === 'acct' ? `<b>${esc(s.name || s.id)}</b>` : lk('pharm', s.name || s.id));
    if(s && NAV.view !== 'acct') parts.push(`<b>${NAV.view === 'users' ? 'Users' : 'Billing'}</b>`);
  }
  $('crumb').innerHTML = parts.join(' › ');
  // the right-hand list is always the next level down
  const row = (attr, id, title, sub, on, big) => `<button type="button" class="qrow${on ? ' on' : ''}${big ? ' big' : ''}" ${attr}="${esc(id)}"><b>${esc(title)}</b><span>${esc(sub)}</span></button>`;
  if(s){
    $('side').innerHTML = `<div class="cqh"><h2>${esc(s.id)}</h2></div>` + [['acct', 'Account'], ['users', 'Users'], ['billing', 'Billing']].map(([v, t]) => row('data-view', v, t, v === 'acct' ? 'Details, owner, services' : v === 'users' ? 'People at this pharmacy' : 'Invoices and payments', NAV.view === v, true)).join('');
  }else if(k){
    const mine = DATA.stores.filter(x => x.clientId === k.id);
    $('side').innerHTML = `<div class="cqh"><h2>Profiles</h2>${rep_ ? '' : `<button type="button" class="btn small" id="addP">Add pharmacy</button>`}</div>` +
      (mine.map(x => row('data-qs', x.id, x.name || x.id, [x.id, [x.city, x.state].filter(Boolean).join(', '), holderOf(x)].filter(Boolean).join(' · '))).join('') || '<div class="hint">No pharmacies yet.</div>');
  }else{
    const un = unlinked();
    $('side').innerHTML = `<div class="cqh"><h2>Clients</h2></div>` +
      (clients.map(c => row('data-q', c.id, clientLabel(c), `${c.id} · ${(c.pharmacies || []).length} ${(c.pharmacies || []).length === 1 ? 'pharmacy' : 'pharmacies'}`)).join('') || '<div class="hint">No clients yet.</div>') +
      (un.length ? '<div class="sub">Not linked to a client yet</div>' + un.map(x => row('data-qs', x.id, x.name || x.id, x.id + ' · link it to a client on its page')).join('') : '');
  }
  // the middle: only the one thing that is open
  const show = id => ['vNew', 'vClient', 'vPharm', 'vUsers', 'vBill'].forEach(x => $(x).hidden = x !== id);
  $('impCard').hidden = !!(k || s) || rep_;
  if(s){
    if(NAV.view === 'users'){
      show('vUsers');
      if(!PS.U){ $('vUsers').innerHTML = '<div class="hint">Loading…</div>'; return; }
      $('vUsers').innerHTML = `<div class="dtitle"><h2>Users · ${esc(s.name || s.id)}</h2><span class="hint">${PS.U.users.length} ${PS.U.users.length === 1 ? 'person' : 'people'}</span></div><div class="msg ok" id="usersMsg" role="status" style="margin:0 0 8px"></div><div id="usersBody">${drUsersHtml(PS.U, usersOpts())}</div>`;
    }else if(NAV.view === 'billing'){
      show('vBill');
      if(!PS.B){ $('vBill').innerHTML = '<div class="hint">Loading…</div>'; return; }
      PS.bo.edit = !rep_;
      $('vBill').innerHTML = `<div class="dtitle"><h2>Billing · ${esc(s.name || s.id)}</h2></div><div class="msg ok" id="billMsg" role="status" style="margin:0 0 8px"></div>${drBillingHtml(PS.B, PS.bo)}`;
    }else{
      show('vPharm');
      $('vPharm').innerHTML = `<div class="pcard" data-store="${esc(s.id)}">${pharmCardHtml(s, {logo:LOGOS[s.id], host:true, rep:rep_, holder:holderOf(s), clients:DATA.clients, people:DATA.users})}</div>`;
    }
    return;
  }
  if(k){ show('vClient'); $('vClient').innerHTML = `<div class="pcard" data-client="${esc(k.id)}"><h3 class="clt">${esc(k.legalName)}${k.dba ? ' <span class="hint">dba ' + esc(k.dba) + '</span>' : ''}</h3>${clientCardHtml(k, {host:true, stores:DATA.stores, people:DATA.users, ro:rep_}, undefined)}</div>`; return; }
  show('vNew');
  if(rep_) $('vNew').innerHTML = '<div class="hint">New clients are set up by an IronLedger supervisor.</div>';
  else if(!$('vNew').querySelector('[data-is-new]')) $('vNew').innerHTML = `<div class="pcard" data-is-new="1"><h3 class="clt">New client</h3>${clientCardHtml({billingSame:true}, {host:true, isNew:true, stores:DATA.stores, people:DATA.users}, undefined)}</div>`;
}
const usersOpts = () => ({st:PS.st, me:ME, host:true, ownerMe:false, pinRequired:!!(ME && ME.pinRequired), canPin:!isRepMe()});
$('side').addEventListener('click', async e => {
  const q = e.target.closest('[data-q]'), p = e.target.closest('[data-qs]'), v = e.target.closest('[data-view]'), qd = q && q.dataset.q, pd = p && p.dataset.qs, vd = v && v.dataset.view;
  if(!(q || p || v || e.target.closest('#addP'))) return;
  if(!(await UG.leave())) return;                                          // unsaved changes: Yes saves, No leaves
  if(q) goto(qd, null); else if(p) goto(NAV.client || (storeOf(pd) || {}).clientId || null, pd); else if(v){ NAV.view = vd; PS.st.open = null; $('clientMsg').textContent = ''; load(); }
  else openAddPharm(NAV.client);
});
$('crumb').addEventListener('click', async e => { const b = e.target.closest('[data-crumb]'); if(!b) return; const w = b.dataset.crumb;
  if(!(await UG.leave())) return;
  if(w === 'home') goto(null, null); else if(w === 'client') goto(NAV.client, null); else goto(NAV.client, NAV.pharm, 'acct'); });

/* ---- one search bar: clients, pharmacies and people (name, username or employee ID) ---- */
function findHits(q){
  q = q.trim().toLowerCase(); if(q.length < 2) return [];
  const has = (...v) => v.some(x => String(x || '').toLowerCase().includes(q)), out = [];
  for(const c of DATA.clients || []) if(has(c.legalName, c.dba, c.id)) out.push({g:'Clients', t:clientLabel(c), s:c.id, go:() => goto(c.id, null)});
  for(const x of DATA.stores) if(has(x.id, x.name)) out.push({g:'Pharmacies', t:x.name || x.id, s:x.id, go:() => goto(x.clientId || null, x.id)});
  for(const u of DATA.users) if(has(u.name, u.login, u.empId)){
    const ids = [...new Set([...Object.keys(u.stores || {}).filter(i => u.stores[i]), ...Object.keys(u.ownerStores || {}).filter(i => u.ownerStores[i]), ...Object.keys(u.adminStores || {}).filter(i => u.adminStores[i])])].filter(i => storeOf(i));
    for(const i of ids) out.push({g:'People', t:u.name || u.login, s:`${u.login}${u.empId ? ' · ' + u.empId : ''} · at ${i}`, go:() => { PS.st.open = u.sub; NAV.client = (storeOf(i) || {}).clientId || null; NAV.pharm = i; NAV.view = 'users'; $('clientMsg').textContent = ''; $('gHits').hidden = true; load(); }});
  }
  return out.slice(0, 40);
}
let HITS = [];
$('gFind').addEventListener('input', e => {
  HITS = findHits(e.target.value); const box = $('gHits'); let g = '';
  box.innerHTML = HITS.map((h, i) => (h.g !== g ? `<div class="hg">${g = h.g}</div>` : '') + `<button type="button" class="hit" data-hit="${i}"><b>${esc(h.t)}</b><span>${esc(h.s)}</span></button>`).join('') || '<div class="hint" style="padding:8px 12px">No match.</div>';
  box.hidden = e.target.value.trim().length < 2;
});
$('gHits').addEventListener('click', async e => { const b = e.target.closest('[data-hit]'); if(!b) return; const h = HITS[+b.dataset.hit]; $('gHits').hidden = true; if(!(await UG.leave())) return; $('gFind').value = ''; if(h) h.go(); });
document.addEventListener('click', e => { if(!e.target.closest('.dfound')) $('gHits').hidden = true; });
$('gFind').addEventListener('keydown', e => { if(e.key === 'Escape'){ $('gHits').hidden = true; } else if(e.key === 'Enter'){ const b = $('gHits').querySelector('[data-hit]'); if(b) b.click(); } });

/* ---- the open things and what they do ---- */
const clientEv = {stores:() => DATA.stores, say:sayStore, pass:showPass, after: async newId => { if(newId){ NAV.client = newId; NAV.pharm = null; NAV.view = 'acct'; $('vNew').innerHTML = ''; } await load(); }};
// The Save / Create button of the open card sits in the fixed row above the scrolling middle. The real button stays in the card (hidden on wide screens); this one passes the click on.
function syncSave(){
  const slot = $('tbSave'), v = ['vNew', 'vClient', 'vPharm'].map($).find(e => e && !e.hidden), real = v && v.querySelector('.savebar button');
  if(!real){ slot.textContent = ''; slot._real = null; return; }
  let b = slot.firstElementChild;
  if(!b){ b = document.createElement('button'); b.type = 'button'; slot.appendChild(b); b.addEventListener('click', () => { if(slot._real) slot._real.click(); }); }
  slot._real = real; b.className = real.className + ' small'; b.textContent = real.textContent; b.disabled = real.disabled;
  [...b.attributes].filter(x => x.name.startsWith('data-')).forEach(x => b.removeAttribute(x.name)); [...real.attributes].filter(x => x.name.startsWith('data-')).forEach(x => b.setAttribute(x.name, x.value));
}
new MutationObserver(syncSave).observe(document.querySelector('.cmain'), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'disabled'] });
UG.watch($('vNew')); UG.watch($('vClient')); UG.watch($('vPharm'));
clientCardEvents($('vClient'), clientEv); clientCardEvents($('vNew'), clientEv);
const pharmEv = {base:'/host', stores:() => DATA.stores, clients:() => DATA.clients, say:sayStore, pass:showPass, after: async () => { await load(); }};
pharmCardEvents($('vPharm'), pharmEv);
// who may manage people at this pharmacy: three switches, saved as they are pressed
$('vPharm').addEventListener('change', async e => {
  const m = e.target.closest('[data-mgr]'); if(!m) return;
  const sid = m.closest('[data-store]').dataset.store;
  try{ await api('POST', '/host/stores/' + enc(sid), {[m.dataset.mgr]:m.checked}); sayStore('Saved.'); await load(); }
  catch(err){ m.checked = !m.checked; if(!err.auth) alert(err.message); }
});
$('vPharm').addEventListener('change', async e => {
  const f = e.target.closest('[data-logo]'); if(!f || !f.files[0]) return;
  try{ const d = await shrink(f.files[0]); await api('POST', '/host/stores/' + enc(f.dataset.logo) + '/logo', {dataUrl:d}); LOGOS[f.dataset.logo] = d; renderNav(); }
  catch(err){ if(!err.auth) alert(err.message); }
});
const usersEnv = {get sid(){ return NAV.pharm; }, base:'/host', U:() => PS.U, st:PS.st, me:() => ME, say:t => { const m = $('usersMsg'); if(m) m.textContent = t || ''; },
  pass:showPass, paint:() => { $('usersBody').innerHTML = drUsersHtml(PS.U, usersOpts()); }, reload: async () => { await load(); }};
drUsersEvents($('vUsers'), usersEnv);
const billEnv = {get sid(){ return NAV.pharm; }, B:() => PS.B, o:PS.bo, paint:() => renderNav(), reload: async () => { await load(); }, say:t => { const m = $('billMsg'); if(m) m.textContent = t || ''; }};
drBillingEvents($('vBill'), billEnv);
// Add pharmacy: a window over the page, the client already chosen
function openAddPharm(clientId){
  if(isRepMe()){ alert('New pharmacies are set up by an IronLedger supervisor.'); return; }
  const k = clientOf(clientId) || {};
  $('newStore').innerHTML = `<div class="pcard" data-is-new="1">${pharmCardHtml({clientId, entityLegalName:k.legalName || '', entityType:k.entityType || '', ein:k.ein || ''}, {host:true, isNew:true, clientFixed:true, clients:DATA.clients, people:DATA.users})}</div>`;
  $('pmodal').hidden = false; $('pmodal').querySelector('.mbox').scrollTop = 0; const i = $('newStore').querySelector('[data-newid]'); if(i) i.focus();
}
const closeAddPharm = () => { $('pmodal').hidden = true; $('newStore').innerHTML = ''; };
const askCloseAddPharm = async () => { if(await UG.leave()) closeAddPharm(); };          // unsaved entries: Yes creates the pharmacy, No closes without it
$('pmClose').onclick = askCloseAddPharm;
$('pmodal').addEventListener('mousedown', e => { if(e.target === $('pmodal')) askCloseAddPharm(); });
document.addEventListener('keydown', e => { if(e.key === 'Escape' && !$('pmodal').hidden && !document.querySelector('.ug-back:not([hidden])')) askCloseAddPharm(); });
UG.watch($('newStore'));
pharmCardEvents($('newStore'), {base:'/host', stores:() => DATA.stores, clients:() => DATA.clients, say:sayStore, pass:showPass, after: async isNew => {
  if(isNew){ const id = (($('newStore').querySelector('[data-newid]') || {}).value || '').trim().toUpperCase(); closeAddPharm(); NAV.pharm = id || null; NAV.view = 'acct'; await load(); }
  else await load(); }});
async function loadLogo(id){
  LOGOS[id] = '';
  try{ const r = await fetch(CFG.apiUrl.replace(/\/$/, '') + '/public/pharmacy/' + enc(id), {cache:'no-store'}); const j = await r.json(); LOGOS[id] = j.logo || ''; renderNav(); }catch(e){}
}
function shrink(file){
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => { const k = Math.min(1, 256 / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      let d = c.toDataURL('image/png'); if(d.length > 200000) d = c.toDataURL('image/jpeg', 0.85); res(d); };
    img.onerror = () => rej(new Error('That file isn’t a picture this browser can read.')); img.src = url;
  });
}
$('impGo').onclick = async () => {
  const f = $('impFile').files[0], sid = $('impStore').value;
  if(!f || !sid) return alert('Choose the pharmacy and the nortex_reorder_data.json file.');
  let data; try{ data = JSON.parse(await f.text()); }catch(e){ return alert('That file isn’t a reorder data file: ' + e.message); }
  if(!data || typeof data !== 'object' || !(Array.isArray(data.reorder) || Array.isArray(data.archive))) return alert('That file isn’t a reorder data file (no orders or archive in it).');
  const arch = data.archive || [], open = (data.reorder || []).filter(r => r && !r.archived), mem = Object.entries(data.remember || {});
  const name = (DATA.stores.find(s => s.id === sid) || {}).name || sid;
  if(!confirm(`Import into ${sid} · ${name}?\n\n${open.length} open orders, ${arch.length} archived lines, ${mem.length} remembered items.\nNothing already in the cloud is changed or removed.`)) return;
  const tot = {linesAdded:0, linesSkipped:0, archiveAdded:0, archiveSkipped:0, memoryAdded:0, memorySkipped:0};
  const add = r => Object.keys(tot).forEach(k => tot[k] += r[k] || 0), url = '/host/import/' + encodeURIComponent(sid);
  busy($('impGo'), true);
  try{
    for(let i = 0; i < open.length; i += 500){ $('impMsg').textContent = `Open orders ${i} of ${open.length}…`; add(await api('POST', url, {reorder:open.slice(i, i + 500)})); }
    for(let i = 0; i < arch.length; i += 500){ $('impMsg').textContent = `Archive ${i} of ${arch.length}…`; add(await api('POST', url, {archive:arch.slice(i, i + 500)})); }
    for(let i = 0; i < mem.length; i += 1000){ $('impMsg').textContent = `Remembered items ${i} of ${mem.length}…`; add(await api('POST', url, {remember:Object.fromEntries(mem.slice(i, i + 1000))})); }
    $('impMsg').innerHTML = `<b>Done: ${esc(sid)}.</b> Open orders: ${tot.linesAdded} added, ${tot.linesSkipped} already there. Archive: ${tot.archiveAdded} added, ${tot.archiveSkipped} already there. Remembered items: ${tot.memoryAdded} added, ${tot.memorySkipped} already there.`;
    $('impFile').value = '';
  }catch(e){ if(!e.auth) $('impMsg').textContent = 'Stopped: ' + e.message + ' (safe to run again; nothing is added twice)'; }
  finally{ busy($('impGo'), false); }
};

/* ---- start: a reload in the same tab goes to the password box, never straight in ---- */
try{ SES = JSON.parse(sessionStorage.getItem(KEY) || 'null'); }catch(e){ SES = null; }
if(SES) enter(''); else showSign('');

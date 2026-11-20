/* IronLedger host page: a separate gate for the host login only.
   Talks only to /host/* on the server, which answers nobody but a host login (everyone else gets "not found").
   The sign-in is kept for this browser tab only, and the page locks after 5 minutes without activity. */
'use strict';
const CFG = window.NORTEX_CONFIG || {};
const COG = CFG.cognitoEndpoint || `https://cognito-idp.${CFG.region}.amazonaws.com/`;
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const LOCK_MS = 5 * 60 * 1000;
const TZ_NAMES = {'America/New_York':'Eastern', 'America/Chicago':'Central', 'America/Denver':'Mountain', 'America/Phoenix':'Arizona (no daylight saving)',
  'America/Los_Angeles':'Pacific', 'America/Anchorage':'Alaska', 'Pacific/Honolulu':'Hawaii', 'America/Puerto_Rico':'Atlantic (Puerto Rico)'};
const PERMS = {submit:'Submit orders', archive:'View archive', remove:'Remove lines', export:'Download backup'};

/* ---- Cognito, called directly ---- */
const COG_ERR = {
  NotAuthorizedException: 'Login ID or password is wrong.', UserNotFoundException: 'Login ID or password is wrong.',
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
    let msg = COG_ERR[code] || j.message || 'Sign-in failed.';
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
  try{ const j = await cog('InitiateAuth', {ClientId:CFG.clientId, AuthFlow:'REFRESH_TOKEN_AUTH', AuthParameters:{REFRESH_TOKEN:SES.refresh}}); setTokens(j.AuthenticationResult); return SES.id; }
  catch(e){ if(e.code){ SES = null; store(); throw authErr(); } throw e; }
}
function authErr(){ const e = new Error('Please sign in again.'); e.auth = true; return e; }

/* ---- the server: /host/* only ---- */
async function api(method, path, body, retried){
  let tok; try{ tok = await idToken(); }catch(e){ if(e.auth) showSign('Please sign in again.'); throw e; }
  let r;
  try{ r = await fetch(CFG.apiUrl.replace(/\/$/, '') + path, {method, headers:{Authorization:'Bearer ' + tok, ...(body ? {'Content-Type':'application/json'} : {})}, body:body ? JSON.stringify(body) : undefined, cache:'no-store'}); }
  catch(e){ throw new Error('No connection to the server. Check the internet.'); }
  if(r.status === 401 && !retried){ try{ await idToken(true); }catch(e){ showSign('Please sign in again.'); throw e; } return api(method, path, body, true); }
  const j = await r.json().catch(() => ({}));
  if(r.status === 423){ lockNow('Locked after 5 minutes without activity.', true); const e = new Error(j.error); e.auth = true; throw e; }
  if(r.status === 404 && path.startsWith('/host')){ await signOut('This page is only for the IronLedger host login.'); const e = new Error('Not the host'); e.auth = true; throw e; }
  if(r.status === 403 && path === '/me'){ await signOut('This login is switched off.'); const e = new Error('off'); e.auth = true; throw e; }
  if(!r.ok){ const e = new Error(j.error || j.message || ('Server answered ' + r.status)); e.status = r.status; throw e; }
  if(path.startsWith('/host/')) UNTIL = Date.now() + LOCK_MS;
  return j;
}

/* ---- screens ---- */
let ME = null, UNTIL = 0, lastAct = 0, pingAt = 0, DATA = {stores:[], users:[]}, LOGOS = {};
const NAV = {client:null, pharm:null, find:''};          // client: null | 'new' | IL-id; pharm: a pharmacy ID inside that client
let BILL = null;                                          // the open client's invoices
const SIGN = {step:'start', session:null, user:'', pw:''};
function only(id){ ['gSign', 'gLock', 'gBody'].forEach(k => $(k).style.display = k === id ? '' : 'none'); }
function clearData(){ for(const k in STAGED) delete STAGED[k]; if($('peopleMsg')) $('peopleMsg').textContent = ''; DATA = {stores:[], users:[]}; LOGOS = {}; BILL = null; NAV.client = NAV.pharm = null; NAV.find = ''; $('people').innerHTML = ''; $('cview').innerHTML = ''; $('pview').innerHTML = ''; $('cqueue').innerHTML = ''; $('pmodal').hidden = true; $('newStore').innerHTML = ''; $('passBox').style.display = 'none'; $('passBox').innerHTML = ''; }
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
  try{ await afterAuth(await cog('InitiateAuth', {ClientId:CFG.clientId, AuthFlow:'USER_PASSWORD_AUTH', AuthParameters:{USERNAME:user, PASSWORD:pw}})); }
  catch(e){ SIGN.pw = ''; paintSign(e.message); } finally{ busy($('sGo'), false); }
};
$('sPass').addEventListener('keydown', e => { if(e.key === 'Enter') $('sGo').click(); });
$('sNewGo').onclick = async () => {
  const a = $('sNew1').value, b = $('sNew2').value;
  if(a.length < 10 || !/[a-z]/.test(a) || !/\d/.test(a)) return paintSign('At least 10 characters, with a lowercase letter and a number.');
  if(a !== b) return paintSign('The two passwords don’t match.');
  busy($('sNewGo'), true);
  try{ SIGN.pw = a; await afterAuth(await cog('RespondToAuthChallenge', {ClientId:CFG.clientId, ChallengeName:'NEW_PASSWORD_REQUIRED', Session:SIGN.session, ChallengeResponses:{USERNAME:SIGN.user, NEW_PASSWORD:a}})); $('sNew1').value = $('sNew2').value = ''; }
  catch(e){ paintSign(e.message); } finally{ busy($('sNewGo'), false); }
};
$('sCodeGo').onclick = async () => {
  const code = $('sCodeIn').value.replace(/\D/g, '');
  if(code.length < 6) return paintSign('Enter the 6-digit code from the text message.');
  busy($('sCodeGo'), true);
  try{ await afterAuth(await cog('RespondToAuthChallenge', {ClientId:CFG.clientId, ChallengeName:'SMS_MFA', Session:SIGN.session, ChallengeResponses:{USERNAME:SIGN.user, SMS_MFA_CODE:code}})); }
  catch(e){ if(e.code === 'NotAuthorizedException'){ SIGN.step = 'start'; SIGN.pw = ''; paintSign('That took too long. Sign in again.'); } else paintSign(e.message); }
  finally{ busy($('sCodeGo'), false); }
};
$('sCodeIn').addEventListener('keydown', e => { if(e.key === 'Enter') $('sCodeGo').click(); });
$('sBack').onclick = () => showSign('');

// signed in: make sure this is the host login, then open (the password just typed opens the page; it isn't kept)
async function enter(pw){
  try{ ME = await api('GET', '/me'); }catch(e){ return; }
  if(!ME.host){ return signOut('This page is only for the IronLedger host login.'); }
  $('bWho').textContent = (ME.name || ME.login) + ' · host';
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
async function signOut(msg){
  if(SES){
    try{ if(UNTIL > 0) await api('POST', '/host-lock', {}); }catch(e){}
    try{ await cog('RevokeToken', {ClientId:CFG.clientId, Token:SES.refresh}); }catch(e){}
  }
  SES = null; store(); for(const k in TEMPS) delete TEMPS[k]; showSign(msg || 'Signed out.', !msg);
}
$('lOut').onclick = $('bOut').onclick = () => signOut();
$('bLock').onclick = () => lockNow('Locked.');
$('bRefresh').onclick = () => load();
['keydown', 'pointerdown', 'input', 'wheel'].forEach(t => $('gBody').addEventListener(t, () => { lastAct = Date.now(); }, {passive:true}));
setInterval(() => {
  if(!(UNTIL > 0)) return;
  const now = Date.now();
  if(now - lastAct > LOCK_MS || now > UNTIL) return lockNow('Locked after 5 minutes without activity.');
  if(lastAct > pingAt && now - pingAt > 60000){ pingAt = now; api('POST', '/host/keepalive', {}).catch(() => {}); }
}, 15000);

/* ---- what the host can do ---- */
async function load(){
  try{
    const [s, u, me, dr, cl] = await Promise.all([api('GET', '/host/stores'), api('GET', '/host/users'), api('GET', '/me'), api('GET', '/host/drafts'), api('GET', '/host/clients')]);
    DATA = {stores:s.stores, users:u.users, me, drafts:dr.drafts, clients:cl.clients};
    if(NAV.client && NAV.client !== 'new' && !DATA.clients.some(k => k.id === NAV.client)) NAV.client = NAV.pharm = null;
    if(NAV.pharm && !DATA.stores.some(x => x.id === NAV.pharm)) NAV.pharm = null;
    if(NAV.client && NAV.client !== 'new'){ try{ BILL = await api('GET', '/host/clients/' + encodeURIComponent(NAV.client) + '/billing'); }catch(e){ if(e.auth) throw e; BILL = null; } } else BILL = null;
    for(const k in TEMPS) if(!DATA.users.some(x => x.sub === k && x.pending)) delete TEMPS[k];
    for(const k in STAGED) if(!DATA.users.some(x => x.sub === k)) delete STAGED[k];
    render();
  }catch(e){ if(!e.auth) $('people').innerHTML = `<div class="msg">${esc(e.message)}</div>`; }
}
const fmtDay = iso => { try{ return new Date(iso).toLocaleDateString('en-US', {month:'short', day:'numeric'}); }catch(e){ return ''; } };
function statusBadge(u){
  if(u.disabled) return '<span class="ust off">Login off</span>';
  if(u.pending && u.tempExpired) return '<span class="ust bad">Expired</span><div class="role">Temp password expired</div>';
  if(u.pending) return `<span class="ust wait">Pending</span><div class="role">${u.tempExpires ? 'Temp password until ' + fmtDay(u.tempExpires) : 'Hasn’t signed in yet'}</div>`;
  return '<span class="ust ok">Active</span>';
}
// temporary passwords made on this page, kept only in this tab's memory so they can be copied again while the person is pending
const TEMPS = {};
// switch changes wait on the row until Update is pressed (Undo puts them back)
const STAGED = {};
function effUser(u){
  const s = STAGED[u.sub]; if(!s) return u;
  return Object.assign({}, u, {adminStores:Object.assign({}, u.adminStores || {}, s.adminStores || {}), stores:Object.assign({}, u.stores, s.stores || {}), perms:Object.assign({}, u.perms, s.perms || {}),
    disabled:s.disabled !== undefined ? s.disabled : u.disabled, initials:s.initials !== undefined ? s.initials : u.initials, license:s.license !== undefined ? s.license : u.license});
}
function stageChange(u, c){
  const s = STAGED[u.sub] || (STAGED[u.sub] = {});
  const put = (grp, k, v, was) => { s[grp] = s[grp] || {}; if(v === was) delete s[grp][k]; else s[grp][k] = v; if(!Object.keys(s[grp]).length) delete s[grp]; };
  if(c.dataset.ust) put('stores', c.dataset.ust, c.checked, (u.stores || {})[c.dataset.ust] === true);
  else if(c.dataset.uadm) put('adminStores', c.dataset.uadm, c.checked, (u.adminStores || {})[c.dataset.uadm] === true);
  else if(c.dataset.uperm) put('perms', c.dataset.uperm, c.checked, !!(u.perms || {})[c.dataset.uperm]);
  else if(c.dataset.uon){ if(!c.checked === !!u.disabled) delete s.disabled; else s.disabled = !c.checked; }
  if(!Object.keys(s).length) delete STAGED[u.sub];
}
const COPY_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
function signInText(u, pw){
  const on = DATA.stores.filter(s => u.stores && u.stores[s.id] === true).map(s => s.id);
  const ownIds = Object.keys(u.ownerStores || {}).filter(k => u.ownerStores[k]);
  return `Pharmacy ID: ${(ownIds.length ? ownIds : on).join(' or ') || '(switch a pharmacy on first)'}\nUser ID: ${u.login}\nTemporary Pass: ${pw}`;
}
async function copyText(t){
  try{ await navigator.clipboard.writeText(t); return true; }
  catch(e){ const a = document.createElement('textarea'); a.value = t; a.style.position = 'fixed'; a.style.opacity = '0'; document.body.appendChild(a); a.select();
    let ok = false; try{ ok = document.execCommand('copy'); }catch(e2){} a.remove(); return ok; }
}
// never a sideways scroll: if the people table is wider than its space, each person becomes a card
function fitPeople(){}   // the two-line layout fits any width
let fitTimer = 0;
window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitPeople, 120); });
const box = (attrs, on, title) => `<input type="checkbox" ${attrs}${on ? ' checked' : ''} title="${esc(title || '')}">`;
function render(){
  const st = DATA.stores, P = Object.keys(PERMS);
  // two lines per user, like the Account Owner tab: user / username / mobile / status, then Pharmacies, then Privileges
  const priv = (b, label, title) => `<label class="priv" title="${esc(title || label)}">${b}<span>${esc(label)}</span></label>`;
  $('people').innerHTML = `<div class="ulist">
    <div class="uhead ucols"><div>User</div><div>Username</div><div>Mobile</div><div>Status</div><div></div><div></div></div>
    ${DATA.users.map(effUser).map(u => {
      const self = u.sub === (ME && ME.sub) || (u.host && u.login === ME.login);
      const own = Object.keys(u.ownerStores || {}).filter(k => u.ownerStores[k]), cown = Object.keys(u.ownerClients || {}).filter(k => u.ownerClients[k]);
      const role = u.host ? 'Host (IronLedger)' : [own.length ? 'Account Owner' : '', cown.length ? 'Client Account Owner' : ''].filter(Boolean).join(' · ');
      const on = self ? '' : priv(box('data-uon="1"', !u.disabled, 'Switch this login on or off'), 'Login on');
      const isOwn = id => u.ownerStores && u.ownerStores[id] === true;
      const adm = (id) => (ME && ME.hostRole !== 'rep' && !u.host && (u.acctType === 'pic' || u.acctType === 'pharmacist') && !isOwn(id) && (u.stores[id] === true || (u.adminStores || {})[id] === true)) ? priv(box(`data-uadm="${esc(id)}"`, (u.adminStores || {})[id] === true, 'Super user: every Account Owner privilege at this pharmacy except billing, the client page and ownership'), 'Super user at ' + id) : '';
      const pharm = u.host ? `<span class="hint">${esc(st.filter(s => u.stores[s.id] === true).map(s => s.id).join(', ') || 'None')} (set by the Account Owner)</span>`
        : st.map(s => isOwn(s.id) ? `<span class="tag" title="Account Owner of ${esc(s.name)}">${esc(s.id)} · Owner</span>` : priv(box(`data-ust="${esc(s.id)}"`, u.stores[s.id] === true, 'Access to ' + s.name), s.id, 'Access to ' + s.name)).join('');
      const privs = u.host ? `<span class="hint">${esc(P.filter(p => u.perms[p]).map(p => PERMS[p]).join(', ') || 'None')} (set by the Account Owner)</span>${on}`
        : P.map(p => priv(box(`data-uperm="${p}"`, u.perms[p], PERMS[p]), PERMS[p])).join('') + st.map(s => adm(s.id)).join('') + on;
      const acts = STAGED[u.sub] ? `<button class="btn small" data-upd="${esc(u.sub)}">Update</button> <button class="btn2 small" data-undo="${esc(u.sub)}">Undo</button>`
        : (self ? '' : `<button class="btn2 small" data-reset="${esc(u.sub)}">Reset password</button>`) + (u.owner || u.host || cown.length ? '' : ` <button class="btn2 small danger" data-del="${esc(u.sub)}">${u.pending ? 'Cancel invite' : 'Delete'}</button>`);
      return `<div class="urow${u.disabled ? ' off' : ''}${STAGED[u.sub] ? ' dirty' : ''}" data-sub="${esc(u.sub)}">
        <div class="ucols">
          <div class="ucell uname" data-l="User"><b>${esc(u.name || u.login)}</b>${role ? `<span class="urole">${role}</span>` : ''}</div>
          <div class="ucell mono" data-l="Username">${esc(u.login)}</div>
          <div class="ucell" data-l="Mobile"><span class="mono">${esc(u.phone)}</span> <button class="edit" data-phone="${esc(u.sub)}" title="Change mobile number">✎</button></div>
          <div class="ucell" data-l="Status">${statusBadge(u)}</div>
          <div class="ucell acts">${acts}</div>
          <div class="ucell copycell">${u.pending && TEMPS[u.sub] ? `<button class="btn2 small copyb" data-copy="${esc(u.sub)}" title="Copy Pharmacy ID, User ID and temporary password" aria-label="Copy sign-in details">${COPY_SVG}</button>` : ''}</div>
        </div>
        <div class="upriv"><span class="plabel">Pharmacies</span><span class="pgroup">${pharm}</span></div>
        <div class="upriv"><span class="plabel">Privileges</span><span class="pgroup">${privs}</span></div>
        <div class="upriv"><span class="plabel">RPh license #</span><input type="text" data-ulic maxlength="20" value="${esc(u.license || '')}" style="width:130px;text-transform:uppercase;" aria-label="RPh license number"> <span class="hint">Pharmacists only. Prints on Rx Intake forms; the Pharmacist-In-Charge's number prints as PIC.</span></div>
        <div class="upriv"><span class="plabel">Signing</span><input type="text" data-uini maxlength="3" value="${esc(u.initials || '')}" style="width:70px;text-transform:uppercase;" aria-label="Initials" placeholder="Initials">
          <span class="hint">Employee ID <b>${esc(u.empId || '-')}</b>${ME && ME.pinRequired ? ` · PIN: ${({none:'Not set', set:'Set', temp:'Temporary', locked:'Locked'})[u.pin || 'none']}` : ''}</span>
          ${ME && ME.pinRequired && !self && ME.hostRole !== 'rep' ? `<button class="btn2 small" data-pinreset="${esc(u.sub)}" title="One-time temporary PIN to hand to them. Their old PIN stops working.">Issue Temporary PIN</button>` : ''}</div>
      </div>`;
    }).join('')}
  </div>`;
  fitPeople();
  $('nStores').innerHTML = st.map(s => `<label class="chk"><input type="checkbox" data-nst="${esc(s.id)}"${st.length === 1 ? ' checked' : ''}> ${esc(s.id)} · ${esc(s.name)}</label>`).join('') || '<span class="hint">Add a pharmacy first.</span>';
  $('nPerms').innerHTML = Object.entries(PERMS).map(([p, l]) => `<label class="chk"><input type="checkbox" data-nperm="${p}"${p !== 'export' ? ' checked' : ''}> ${l}</label>`).join('');
  if(!$('nPass').value) $('nPass').value = genTemp();
  renderNav(); renderReviews();
  const keep = $('impStore').value;
  $('impStore').innerHTML = st.map(s => `<option value="${esc(s.id)}">${esc(s.id)} · ${esc(s.name)}</option>`).join('');
  if(keep && st.some(s => s.id === keep)) $('impStore').value = keep;
  for(const s of st) if(s.hasLogo && LOGOS[s.id] === undefined) loadLogo(s.id);
}
const holderOf = s => { const o = ownInfo(s, DATA.users).owner; return o ? ownLabel(o) : 'Not set yet'; };
const isRepMe = () => !!(DATA.me && DATA.me.hostRole === 'rep');
function renderReviews(){
  const d = DATA.drafts || [], sup = !isRepMe(), pend = d.filter(x => x.status === 'pending');
  $('reviewCard').hidden = !(d.length || (sup && DATA.users.some(u => u.hostRole === 'rep')));
  $('reviewTitle').textContent = sup ? 'Rep drafts waiting for review' : 'Your drafts';
  const chg = c => Object.entries(c).map(([k, v]) => `<div class="hint">${esc(k)}: ${esc(Array.isArray(v[0]) || typeof v[0] === 'object' ? JSON.stringify(v[0]) : v[0] === '' ? '(blank)' : v[0])} → ${esc(typeof v[1] === 'object' ? JSON.stringify(v[1]) : v[1])}</div>`).join('');
  $('reviews').innerHTML = (sup ? pend : d).map(x => `<div class="npibox" data-draft="${esc(x.id)}" data-dstore="${esc(x.store)}"><b>${esc(x.store)}</b> · ${esc(x.by)} · ${esc((x.at || '').slice(0, 10))} · <b>${esc(x.status)}</b>
      <div>“${esc(x.note)}”</div>${chg(x.changes)}${x.decisionNote ? `<div class="hint">Decision by ${esc(x.decidedBy)}: ${esc(x.decisionNote)}</div>` : ''}
      ${sup && x.status === 'pending' ? '<div class="row" style="margin-top:6px"><button class="btn small" data-dapprove="1">Approve and apply</button><button class="btn2 small" data-dreject="1">Reject…</button></div>' : ''}</div>`).join('') || '<div class="hint">Nothing waiting.</div>';
  const reps = sup ? DATA.users.filter(u => u.hostRole === 'rep') : [];
  $('repAssign').innerHTML = reps.length ? '<h3 style="font-size:15px;margin:14px 0 6px">Which pharmacies each rep may draft for</h3>' + reps.map(u => `<div class="npibox" data-repsub="${esc(u.sub)}"><b>${esc(u.name || u.login)}</b> ${DATA.stores.map(s => `<label class="chk"><input type="checkbox" data-repstore="${esc(s.id)}"${(u.repStores || {})[s.id] ? ' checked' : ''}> ${esc(s.id)}</label>`).join('')} <button class="btn2 small" data-repsave="1">Save</button></div>`).join('') : '';
}
$('reviewCard').addEventListener('click', async e => {
  const ap = e.target.closest('[data-dapprove]'), rj = e.target.closest('[data-dreject]'), rs = e.target.closest('[data-repsave]'), box = e.target.closest('[data-draft]');
  try{
    if(rs){ const row = rs.closest('[data-repsub]'), st = {}; row.querySelectorAll('[data-repstore]').forEach(i => st[i.dataset.repstore] = i.checked); await api('POST', '/host/users/' + encodeURIComponent(row.dataset.repsub), {repStores:st}); await load(); return; }
    if(!box) return;
    if(ap){ await api('POST', `/host/drafts/${encodeURIComponent(box.dataset.dstore)}/${encodeURIComponent(box.dataset.draft)}/approve`, {}); sayStore('Approved and applied.'); await load(); }
    if(rj){ const n = prompt('Why is this rejected?'); if(!n) return; await api('POST', `/host/drafts/${encodeURIComponent(box.dataset.dstore)}/${encodeURIComponent(box.dataset.draft)}/reject`, {note:n}); await load(); }
  }catch(err){ if(!err.auth) alert(err.message); }
});
const sayStore = t => { $('clientMsg').textContent = t; };
const sayClient = sayStore;
const clientOf = id => (DATA.clients || []).find(k => k.id === id);
const storeOf = id => DATA.stores.find(s => s.id === id);
const clientLabel = k => k ? (k.dba || k.legalName) : '';
function goto(client, pharm){ NAV.client = client || null; NAV.pharm = pharm || null; $('clientMsg').textContent = ''; document.querySelector('#hTabs [data-tab=clients]').click(); load(); }
function renderNav(){
  const rep_ = isRepMe(), clients = DATA.clients || [], q = NAV.find.trim().toLowerCase();
  // the queue (right): one line per client, the selected one highlighted; typing finds a client by name, account number or one of its pharmacies
  const hit = k => !q || [k.legalName, k.dba, k.id].some(x => String(x || '').toLowerCase().includes(q)) || (k.pharmacies || []).some(id => { const s = storeOf(id); return id.toLowerCase().includes(q) || (s && String(s.name || '').toLowerCase().includes(q)); });
  $('cqueue').innerHTML = clients.filter(hit).map(k => `<button type="button" class="qrow${NAV.client === k.id ? ' on' : ''}" data-q="${esc(k.id)}"><b>${esc(clientLabel(k))}</b><span>${esc(k.id)} · ${(k.pharmacies || []).length} ${(k.pharmacies || []).length === 1 ? 'pharmacy' : 'pharmacies'}</span></button>`).join('') || `<div class="hint">${clients.length ? 'No match.' : 'No clients yet.'}</div>`;
  $('qNew').style.display = rep_ ? 'none' : '';
  // breadcrumb
  const k = NAV.client && NAV.client !== 'new' ? clientOf(NAV.client) : null, s = NAV.pharm ? storeOf(NAV.pharm) : null;
  $('crumb').innerHTML = !NAV.client ? '<b>Clients</b>' : NAV.client === 'new' ? '<button class="lk" data-crumb="home">Clients</button> › <b>New client</b>'
    : `<button class="lk" data-crumb="home">Clients</button> › ${s ? `<button class="lk" data-crumb="client">${esc(clientLabel(k))}</button> › <b>${esc(s.name || s.id)}</b>` : `<b>${esc(clientLabel(k))}</b>`}`;
  const cv = $('cview'), pv = $('pview'); cv.hidden = !!s; pv.hidden = !s;
  if(s){
    $('cview').innerHTML = '';
    pv.innerHTML = `<div class="pcard" data-store="${esc(s.id)}">${pharmCardHtml(s, {logo:LOGOS[s.id], host:true, rep:rep_, holder:holderOf(s), clients:DATA.clients, people:DATA.users})}</div>`;
    return;
  }
  pv.innerHTML = '';
  if(NAV.client === 'new'){ if(rep_) cv.innerHTML = '<div class="hint">New clients are set up by an IronLedger supervisor.</div>'; else if(!cv.querySelector('[data-is-new]')) cv.innerHTML = `<div class="pcard" data-is-new="1"><h3 class="clt">New client</h3>${clientCardHtml({billingSame:true}, {host:true, isNew:true, stores:DATA.stores, people:DATA.users}, undefined)}</div>`; return; }
  if(!k){ cv.innerHTML = '<div class="hint">Pick a client from the list on the right, or add one.</div>'; return; }
  cv.innerHTML = `<div class="pcard" data-client="${esc(k.id)}"><h3 class="clt">${esc(k.legalName)}${k.dba ? ' <span class="hint">dba ' + esc(k.dba) + '</span>' : ''}</h3>${clientCardHtml(k, {host:true, stores:DATA.stores, people:DATA.users, billing:BILL, ro:rep_}, undefined)}</div>`;
}
$('cqueue').addEventListener('click', e => { const b = e.target.closest('[data-q]'); if(b) goto(b.dataset.q, null); });
$('qNew').onclick = () => { NAV.client = 'new'; NAV.pharm = null; $('cview').innerHTML = ''; $('clientMsg').textContent = ''; renderNav(); };
$('qFind').addEventListener('input', e => { NAV.find = e.target.value; renderNav(); });
$('crumb').addEventListener('click', e => { const b = e.target.closest('[data-crumb]'); if(!b) return; if(b.dataset.crumb === 'home') goto(null, null); else goto(NAV.client, null); });
// the client page (setup information, owner, pharmacies, billing) and its pharmacies' pages
const clientEv = {stores:() => DATA.stores, say:sayClient, pass:showPass, openPharm:id => goto(NAV.client, id), addPharm:openAddPharm, after: async newId => { if(newId){ NAV.client = newId; NAV.pharm = null; $('cview').innerHTML = ''; } await load(); }};
clientCardEvents($('cview'), clientEv);
$('hTabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if(!b) return;
  document.querySelectorAll('#hTabs button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('[data-pane]').forEach(x => x.hidden = x.dataset.pane !== b.dataset.tab);
  if(b.dataset.tab === 'billing') loadBillAll(); });
async function loadBillAll(){
  const box = $('billAll'), cl = DATA.clients || []; if(!cl.length){ box.innerHTML = '<div class="hint">No clients yet.</div>'; return; }
  box.innerHTML = '<div class="hint">Loading…</div>';
  try{
    const rs = await Promise.all(cl.map(k => api('GET', '/host/clients/' + encodeURIComponent(k.id) + '/billing')));
    const t = (x, bad) => `<div${bad && x.count ? ' class="bad"' : ''}><b>${x.count}</b><em>${money(x.cents)}</em></div>`;
    box.innerHTML = '<div class="bgrid"><div class="brow" style="cursor:default;border:0;background:none;font-size:11.5px;text-transform:uppercase;color:var(--muted)"><div>Client</div><div>New this month</div><div>Paid this month</div><div>Unpaid</div><div>Delinquent</div></div>' +
      cl.map((k, i) => { const S = rs[i].summary; return `<button type="button" class="brow" data-bill="${esc(k.id)}"><div><b>${esc(clientLabel(k))}</b><em>${esc(k.id)}</em></div>${t(S.newThisMonth)}${t(S.paidThisMonth)}${t(S.unpaid)}${t(S.delinquent, true)}</button>`; }).join('') + '</div>';
  }catch(e){ if(!e.auth) box.innerHTML = `<div class="msg">${esc(e.message)}</div>`; }
}
$('billAll').addEventListener('click', e => { const b = e.target.closest('[data-bill]'); if(b) goto(b.dataset.bill, null); });
const pharmEv = {base:'/host', stores:() => DATA.stores, clients:() => DATA.clients, say:sayStore, pass:showPass, after: async () => { await load(); }};
pharmCardEvents($('pview'), pharmEv);
// Add pharmacy: a window over the page, the client already chosen
function openAddPharm(clientId){
  if(isRepMe()){ alert('New pharmacies are set up by an IronLedger supervisor.'); return; }
  const k = clientOf(clientId) || {};
  $('newStore').innerHTML = `<div class="pcard" data-is-new="1">${pharmCardHtml({clientId, entityLegalName:k.legalName || '', entityType:k.entityType || '', ein:k.ein || ''}, {host:true, isNew:true, clientFixed:true, clients:DATA.clients, people:DATA.users})}</div>`;
  $('pmodal').hidden = false; $('pmodal').querySelector('.mbox').scrollTop = 0; const i = $('newStore').querySelector('[data-newid]'); if(i) i.focus();
}
const closeAddPharm = () => { $('pmodal').hidden = true; $('newStore').innerHTML = ''; };
$('pmClose').onclick = closeAddPharm;
$('pmodal').addEventListener('mousedown', e => { if(e.target === $('pmodal')) closeAddPharm(); });
document.addEventListener('keydown', e => { if(e.key === 'Escape' && !$('pmodal').hidden && !document.querySelector('details.hdrop[open]')) closeAddPharm(); });
pharmCardEvents($('newStore'), {base:'/host', stores:() => DATA.stores, clients:() => DATA.clients, say:sayStore, pass:showPass, after: async isNew => { if(isNew){ const id = ($('newStore').querySelector('[data-newid]') || {}).value; closeAddPharm(); await load(); const s = DATA.stores.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0]; if(id && storeOf(id.trim().toUpperCase())) NAV.pharm = id.trim().toUpperCase(); else if(s) NAV.pharm = s.id; renderNav(); } else await load(); }});
async function loadLogo(id){
  LOGOS[id] = '';
  try{ const r = await fetch(CFG.apiUrl.replace(/\/$/, '') + '/public/pharmacy/' + encodeURIComponent(id), {cache:'no-store'}); const j = await r.json(); LOGOS[id] = j.logo || ''; renderNav(); }catch(e){}
}
function genTemp(){ const L = 'abcdefghjkmnpqrstuvwxyz', D = '23456789', A = L + D, R = n => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
  let p = L[R(23)] + D[R(8)]; while(p.length < 12) p += A[R(A.length)]; return p; }
function showPass(html){ $('passBox').innerHTML = html; $('passBox').style.display = 'block'; $('passBox').scrollIntoView({block:'center'}); }
const nameOf = sub => { const u = DATA.users.find(x => x.sub === sub); return u ? (u.name || u.login) : ''; };

$('people').addEventListener('change', async e => {
  const ini = e.target.closest('input[data-uini]');
  if(ini){
    const sub = ini.closest('[data-sub]').dataset.sub, u = DATA.users.find(x => x.sub === sub); if(!u) return;
    const v = ini.value.trim().toUpperCase(), stg = STAGED[sub] || (STAGED[sub] = {});
    if(v === (u.initials || '')) delete stg.initials; else stg.initials = v;
    if(!Object.keys(stg).length) delete STAGED[sub];
    $('peopleMsg').textContent = ''; render(); return;
  }
  const lic = e.target.closest('input[data-ulic]');
  if(lic){
    const sub = lic.closest('[data-sub]').dataset.sub, u = DATA.users.find(x => x.sub === sub); if(!u) return;
    const v = lic.value.trim().toUpperCase(), stg = STAGED[sub] || (STAGED[sub] = {});
    if(v === (u.license || '')) delete stg.license; else stg.license = v;
    if(!Object.keys(stg).length) delete STAGED[sub];
    $('peopleMsg').textContent = ''; render(); return;
  }
  const c = e.target.closest('input[type=checkbox]'); if(!c) return;
  const sub = c.closest('[data-sub]').dataset.sub, u = DATA.users.find(x => x.sub === sub); if(!u) return;
  stageChange(u, c); $('peopleMsg').textContent = ''; render();      // saved only when Update is pressed
});
$('people').addEventListener('click', async e => {
  const ph = e.target.closest('[data-phone]'), rs = e.target.closest('[data-reset]'), dl = e.target.closest('[data-del]'), cp = e.target.closest('[data-copy]');
  const up = e.target.closest('[data-upd]'), un = e.target.closest('[data-undo]');
  const pr = e.target.closest('[data-pinreset]');
  if(pr){
    const u = DATA.users.find(x => x.sub === pr.dataset.pinreset); if(!u) return;
    if(!confirm(`Issue a temporary PIN for ${u.name || u.login}? Their current PIN stops working. Give it to them in person.`)) return;
    try{ const r = await api('POST', '/host/users/' + encodeURIComponent(u.sub) + '/pin-reset', {}); await load();
      showPass(`<b>Temporary PIN for ${esc(u.name || u.login)}:</b> <span class="mono" style="font-size:20px;letter-spacing:.2em;">${esc(r.tempPin)}</span><br><span class="hint">Shown once. They choose their own PIN when they next sign something.</span>`); }
    catch(err){ if(!err.auth) alert(err.message); }
    return;
  }
  if(un){ delete STAGED[un.dataset.undo]; $('peopleMsg').textContent = ''; render(); return; }
  if(up){
    const u = DATA.users.find(x => x.sub === up.dataset.upd), body = STAGED[up.dataset.upd]; if(!u || !body) return;
    const am = u.owner ? '\n\nThis is the Account Owner.' : '';
    if(body.disabled === true && !confirm(`Switch off ${nameOf(u.sub)}'s login? They are signed out everywhere and can't sign in until it's switched back on.${am}`)) return;
    busy(up, true);
    try{
      await api('POST', '/host/users/' + encodeURIComponent(u.sub), body);
      delete STAGED[u.sub];
      $('peopleMsg').textContent = body.disabled === true ? `${nameOf(u.sub)}'s login was switched off. They were signed out.`
        : `${nameOf(u.sub)}'s account access was updated. It takes effect after they sign out and sign back in.`;
      await load();
    }catch(err){ busy(up, false); if(!err.auth) alert(err.message); }
    return;
  }
  if(cp){
    const u = DATA.users.find(x => x.sub === cp.dataset.copy); if(!u || !TEMPS[u.sub]) return;
    const ok = await copyText(signInText(u, TEMPS[u.sub])); cp.title = ok ? 'Copied' : 'Couldn’t copy';
    showPass(ok ? `<b>Copied ${esc(u.name || u.login)}’s sign-in details.</b> Paste them where you need them.` : 'Couldn’t copy. Select the text instead.'); return;
  }
  if(dl){
    const u = DATA.users.find(x => x.sub === dl.dataset.del);
    const typed = prompt(u.pending ? `Cancel ${u.name || u.login}'s invitation?\n\nThey haven't signed in yet. Their login and temporary password are removed, and the Login ID can be used again.\n\nType their Login ID (${u.login}) to cancel it:` : `Delete ${u.name || u.login} for good?\n\nTheir login is removed and can't be switched back on. Orders and archive lines they entered stay, under their name.\nTo just stop them signing in for now, switch their login off instead.\n\nType their Login ID (${u.login}) to delete:`);
    if(typed === null) return;
    if(typed.trim().toLowerCase() !== u.login) return alert('The Login ID didn’t match. Nothing was deleted.');
    try{ await api('POST', '/host/users/' + encodeURIComponent(u.sub) + '/delete', {}); await load(); alert(`${u.name || u.login} was deleted.`); }catch(err){ if(!err.auth) alert(err.message); }
  }
  if(ph){
    const u = DATA.users.find(x => x.sub === ph.dataset.phone);
    const v = prompt(`New mobile number for ${u.name || u.login} (sign-in codes are texted here):`, u.phone); if(!v) return;
    if(!confirm(`Has ${u.name || u.login} signed a new SMS consent form for ${v}?`)) return alert('Have them sign the SMS consent form for the new number first.');
    try{ await api('POST', '/host/users/' + encodeURIComponent(u.sub), {phone:v, smsConsent:true}); await load(); }catch(err){ if(!err.auth) alert(err.message); }
  }
  if(rs){
    const u = DATA.users.find(x => x.sub === rs.dataset.reset);
    if(!confirm(`Give ${u.name || u.login} a new temporary password? Their current password stops working and they're signed out everywhere.`)) return;
    try{ const r = await api('POST', '/host/users/' + encodeURIComponent(u.sub) + '/reset-password', {});
      TEMPS[u.sub] = r.tempPassword; await load();
      showPass(`<b>New temporary password for ${esc(u.name || u.login)}</b><br>Login ID: <b class="mono">${esc(u.login)}</b><br>Temporary password: <b class="mono">${esc(r.tempPassword)}</b><br><span class="hint">They choose their own password when they next sign in. The copy button on their row copies their sign-in details.</span>`); }
    catch(err){ if(!err.auth) alert(err.message); }
  }
});
$('nAdd').onclick = async () => {
  const stores = {}; document.querySelectorAll('[data-nst]').forEach(c => stores[c.dataset.nst] = c.checked);
  const perms = {}; document.querySelectorAll('[data-nperm]').forEach(c => perms[c.dataset.nperm] = c.checked);
  const body = {name:$('nName').value.trim(), login:$('nLogin').value.trim().toLowerCase(), phone:$('nPhone').value.trim(), tempPassword:$('nPass').value.trim() || undefined, stores, perms, smsConsent:$('nConsent').checked};
  if(!body.name || !body.login || !body.phone) return alert('Name, Login ID and mobile number are all needed.');
  if(!body.smsConsent) return alert('Have them sign the SMS consent form first, then tick the box.');
  busy($('nAdd'), true);
  try{
    const r = await api('POST', '/host/users', body); TEMPS[r.user.sub] = r.tempPassword;
    const ids = Object.keys(stores).filter(k => stores[k]);
    showPass(`<b>${esc(body.name)} can sign in now.</b> Give them:<br>Pharmacy ID: <b class="mono">${esc(ids.join(' or ') || '(switch one on first)')}</b><br>Login ID: <b class="mono">${esc(r.user.login)}</b><br>Temporary password: <b class="mono">${esc(r.tempPassword)}</b><br><span class="hint">This temporary password isn’t shown again.</span>`);
    ['nName', 'nLogin', 'nPhone'].forEach(k => $(k).value = ''); $('nPass').value = genTemp(); $('nConsent').checked = false;
    await load(); $('nName').focus({preventScroll: true});
  }catch(err){ if(!err.auth) alert(err.message); }
  finally{ busy($('nAdd'), false); }
};
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
$('pview').addEventListener('change', async e => {
  const f = e.target.closest('[data-logo]'); if(!f || !f.files[0]) return;
  try{ const d = await shrink(f.files[0]); await api('POST', '/host/stores/' + encodeURIComponent(f.dataset.logo) + '/logo', {dataUrl:d}); LOGOS[f.dataset.logo] = d; renderNav(); }
  catch(err){ if(!err.auth) alert(err.message); }
});
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

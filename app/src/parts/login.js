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
$('signOutBtn').onclick = async () => { if(!(await UG.leave())) return; if(confirm('Sign out of the Reorder List on this device?')) signOut(); };

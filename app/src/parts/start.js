/* ---------------- tabs, render, start ---------------- */
document.querySelectorAll('#tabs button').forEach(b => b.onclick = async () => {
  if(!(await UG.leave())) return;                                      // unsaved changes: Yes saves, No leaves
  document.querySelectorAll('#tabs button').forEach(x => { x.classList.toggle('active', x === b); x.classList.toggle('sub', b.dataset.tab === 'archive' && x.dataset.tab === 'list'); });
  $('acctBtn').classList.toggle('on', b.dataset.tab === 'owner');
  const pan = b.dataset.tab === 'dashboard' ? 'calendar' : b.dataset.tab;                  // Dashboard and Calendar are two views of the same page
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + pan));
  document.body.classList.toggle('wideTab', b.dataset.tab === 'owner' || b.dataset.tab === 'documents');
  document.body.classList.toggle('calWide', b.dataset.tab === 'calendar');     // the Calendar tab uses the whole window width (task column on the right)
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

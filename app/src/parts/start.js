/* ---------------- tabs, render, start ---------------- */
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + b.dataset.tab));
  if(b.dataset.tab === 'owner') openOwnerTab();
  if(b.dataset.tab === 'archive') loadArchive(false).catch(() => {});
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

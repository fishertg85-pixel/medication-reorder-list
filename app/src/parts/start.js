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

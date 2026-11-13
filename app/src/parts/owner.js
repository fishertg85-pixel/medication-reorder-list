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
const PERM_HEADS = {submit:'Submit', archive:'Archive', remove:'Remove', export:'Backup'};
let OWN = {stores:[], users:[]};
// temporary passwords made on this screen, kept only in this page (never saved anywhere) so they can be copied again
// while the person is still pending; gone on sign-out or reload, or once the person has signed in
const TEMPS = {};
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
    for(const st of OWN.stores) if(st.hasLogo && LOGOS[st.id] === undefined) loadLogo(st.id).then(renderOwnStores);
    renderOwner();
  }catch(e){ if(!e.auth) $('ownPeople').innerHTML = `<div class="banner warn">${esc(e.message)}</div>`; }
}
let npStoresSig = '';
function renderOwner(){ renderOwnStores(); renderOwnPeople();
  const sig = OWN.stores.map(s => s.id + ':' + s.name).join('|');
  if(sig !== npStoresSig || !$('npPerms').innerHTML){ npStoresSig = sig; paintNewPerson(); }   // don't undo switches someone is setting for the next person
  $('impStore').innerHTML = OWN.stores.map(s => `<option value="${esc(s.id)}">${esc(s.id)} · ${esc(s.name)}</option>`).join(''); }
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
  if(u.pending && u.tempExpired) return `<span class="ustat bad">Expired</span><div class="maker">Temp password expired</div>`;
  if(u.pending) return `<span class="ustat wait">Pending</span><div class="maker">${u.tempExpires ? 'Temp password good until ' + fmtDay(u.tempExpires) : 'Hasn’t signed in yet'}</div>`;
  return '<span class="ustat ok">Active</span>';
}
const sw = (attrs, on, title) => `<label class="switch" title="${esc(title || '')}"><input type="checkbox" ${attrs}${on ? ' checked' : ''}><span></span></label>`;
function renderOwnPeople(){
  const st = OWN.stores, P = Object.keys(PERM_LABELS);
  $('ownPeople').innerHTML = `<div class="tscroll"><table class="people"><thead><tr><th>Person</th><th>Status</th><th>Mobile</th>
      ${st.map(s => `<th class="c" title="${esc(s.name)}">${esc(s.id)}</th>`).join('')}
      ${P.map(p => `<th class="c" title="${PERM_LABELS[p]}">${PERM_HEADS[p]}</th>`).join('')}<th class="c">Login on</th><th></th><th></th></tr></thead><tbody>
    ${OWN.users.map(u => u.owner ? `<tr><td data-l="Person"><b>${esc(u.name || u.login)}</b><div class="maker">${esc(u.login)} · Acct Manager</div></td><td data-l="Status">${statusBadge(u)}</td><td data-l="Mobile">${esc(u.phone)}</td>
        <td colspan="${st.length + P.length + 3}" class="hint">Full access to every pharmacy</td></tr>`
      : u.host ? `<tr data-sub="${esc(u.sub)}"${u.disabled ? ' class="off"' : ''}><td data-l="Person"><b>${esc(u.name || u.login)}</b><div class="maker">${esc(u.login)} · Host (IronLedger)</div></td><td data-l="Status">${statusBadge(u)}</td><td data-l="Mobile">${esc(u.phone)}</td>
        ${st.map(s => `<td class="c" data-l="${esc(s.id)}">${sw(`data-ust="${esc(s.id)}"`, u.stores[s.id] === true, 'Let the host open ' + s.name)}</td>`).join('')}
        <td colspan="${P.length + 3}" class="hint" title="Runs the program for you: passwords, phones, logins. Sees a pharmacy’s list only if you switch it on here.">IronLedger support · sees a list only if switched on</td></tr>`
      : `<tr data-sub="${esc(u.sub)}"${u.disabled ? ' class="off"' : ''}><td data-l="Person"><b>${esc(u.name || u.login)}</b><div class="maker">${esc(u.login)}</div></td><td data-l="Status">${statusBadge(u)}</td>
        <td data-l="Mobile">${esc(u.phone)} <button class="edit" data-phone="${esc(u.sub)}" title="Change mobile number">✎</button></td>
        ${st.map(s => `<td class="c" data-l="${esc(s.id)}">${sw(`data-ust="${esc(s.id)}"`, u.stores[s.id] === true, 'Access to ' + s.name)}</td>`).join('')}
        ${P.map(p => `<td class="c" data-l="${PERM_LABELS[p]}">${sw(`data-uperm="${p}"`, u.perms[p], PERM_LABELS[p])}</td>`).join('')}
        <td class="c" data-l="Login on">${sw('data-uon="1"', !u.disabled, 'Switch this login on or off')}</td>
        <td class="acts"><button class="btn2 small" data-reset="${esc(u.sub)}">Reset password</button> <button class="btn2 small danger" data-del="${esc(u.sub)}">${u.pending ? 'Cancel invite' : 'Delete'}</button></td>
        <td class="c copycell" data-l="Copy sign-in">${u.pending && TEMPS[u.sub] ? `<button class="btn2 small copyb" data-copy="${esc(u.sub)}" title="Copy Pharmacy ID, User ID and temporary password" aria-label="Copy sign-in details">${COPY_SVG}</button>` : ''}</td></tr>`).join('')}
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
    TEMPS[r.user.sub] = r.tempPassword;
    const ids = Object.keys(stores).filter(k => stores[k]);
    showPassBox(`<b>${esc(body.name)} can sign in now.</b> Give them:<br>Pharmacy ID: <b class="mono">${esc(ids.join(' or ') || '(switch one on first)')}</b><br>
      Login ID: <b class="mono">${esc(r.user.login)}</b><br>Temporary password: <b class="mono">${esc(r.tempPassword)}</b><br>
      <span class="hint">They choose their own password the first time they sign in. The temporary password works for 7 days and isn’t shown again.</span>`);
    ['npName','npLogin','npPhone'].forEach(k => $(k).value = ''); $('npPass').value = genTemp(); $('npConsent').checked = false;
    say(`Added ${body.name}. They are at the top of the list as Pending until they sign in for the first time. The form is clear for the next person.`, true);
    paintNewPerson(); $('npName').focus({preventScroll: true});      // pharmacies and permissions back to their defaults too, straight away
    await loadOwner();
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
  const r = e.target.closest('[data-reset]'), ph = e.target.closest('[data-phone]'), dl = e.target.closest('[data-del]'), cp = e.target.closest('[data-copy]');
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

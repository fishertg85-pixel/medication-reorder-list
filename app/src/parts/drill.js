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
    acctType:s.acctType !== undefined ? s.acctType : u.acctType, docDuty:s.docDuty !== undefined ? s.docDuty : u.docDuty});
}
// the whole Users view of one pharmacy: the list (a line per person; open one for its details) and the add-a-person form
// U = answer of GET /pharmacy/:id/users; o = {st: drState(), me, host, ownerMe, pinRequired, canPin}
function drUsersHtml(U, o){
  const sid = U.store.id, can = U.canManage, S = o.st.staged, list = U.users.map(u => drEff(u, S, sid));
  const priv = (sw_, label, title) => `<span class="priv" title="${esc(title || label)}">${sw_}<span>${esc(label)}</span></span>`;
  const role = u => u.isOwner ? '<span class="urole">Account Owner</span>' : u.isAdmin ? '<span class="urole">Super user</span>' : u.employee ? '<span class="urole">Also IronLedger</span>' : '';
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
    const lic = `<div class="upriv"><span class="plabel">RPh license #</span><input type="text" data-ulic maxlength="20" value="${esc(u.license || '')}" style="width:130px;text-transform:uppercase;" aria-label="RPh license number"> <span class="hint">Pharmacists only. Prints on Rx Intake forms; the Pharmacist-In-Charge’s number prints as PIC.</span></div>`;
    const others = raw && raw.others ? `<span class="hint">${o.host && raw.otherIds ? 'Also at ' + esc(raw.otherIds.join(', ')) : 'Also has access at ' + raw.others + (raw.others === 1 ? ' other pharmacy' : ' other pharmacies')}</span>` : '';
    if(u.isOwner) return `<div class="udetail">
        <div class="upriv"><span class="plabel">Account type</span><span class="hint">Account Owner · primary account holder, full access</span></div>${lic}${signing}
        ${o.host && can && !self(u) ? `<div class="upriv"><span class="plabel"></span>${acts}</div>` : ''}</div>`;
    return `<div class="udetail">
        <div class="upriv"><span class="plabel">Account type</span><select data-utype><option value="">Not set</option>${Object.entries(DR_ACCT).map(([k, l]) => `<option value="${k}"${u.acctType === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
          <span class="hint">Choosing a type sets Submit, Archive, Remove and Backup. Calendar and Documents are set separately.</span></div>
        ${lic}${signing}
        ${u.perms.documents ? `<div class="upriv"><span class="plabel">Document duty</span>${u.acctType === 'pic' ? '<span class="hint">Pharmacist-In-Charge: manages and approves documents</span>' : `<select data-udoc>${Object.entries(DR_DUTY).map(([k, l]) => `<option value="${k}"${(u.docDuty || '') === k ? ' selected' : ''}>${l}</option>`).join('')}</select>`}</div>` : ''}
        <div class="upriv"><span class="plabel">This pharmacy</span><span class="pgroup">${priv(sw(`data-ust="${esc(sid)}"`, u.access === true, 'Access to ' + U.store.name), 'Access to ' + sid, 'Access to ' + U.store.name)}</span>${others}</div>
        <div class="upriv"><span class="plabel">Privileges</span><span class="pgroup">${Object.entries(DR_PERMS).map(([p, l]) => priv(sw(`data-uperm="${p}"`, !!u.perms[p], l + ' at ' + sid), l, l)).join('')}
          ${self(u) || u.employee ? '' : priv(sw('data-uon="1"', !u.disabled, 'Switch this login on or off'), 'Login on')}</span></div>
        ${(o.host || o.ownerMe) && u.acctType === 'pic' && u.access ? `<div class="upriv"><span class="plabel">Super user</span><span class="pgroup">${priv(sw(`data-uadm="${esc(sid)}"`, u.isAdmin === true, 'All administrator privileges at ' + U.store.name + ' except billing, the client page and ownership'), sid, 'Super user at ' + U.store.name)}</span>
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
  const add = !can ? '' : `<section class="card" style="margin-top:14px"><h2>Add a user</h2>
      <div class="formgrid grid2">
        <label class="f"><span>Full name</span><input type="text" data-np="name" maxlength="120"></label>
        <label class="f"><span>Login ID</span><input type="text" data-np="login" autocapitalize="none" spellcheck="false" maxlength="32"></label>
        <label class="f"><span>Mobile number (for sign-in codes)</span><input type="tel" data-np="phone" maxlength="20"></label>
        <label class="f"><span>Temporary password</span><input type="text" data-np="pass" class="mono" maxlength="64" value="${esc(o.st.np || drTemp())}"></label>
        <label class="f"><span>Initials</span><input type="text" data-np="ini" maxlength="3" style="max-width:90px;text-transform:uppercase;"></label>
        <label class="f"><span>RPh license # (pharmacists)</span><input type="text" data-np="lic" maxlength="20" style="max-width:150px;text-transform:uppercase;"></label>
      </div>
      <div style="margin-top:8px"><b class="hint">Account type:</b> <select data-np="type"><option value="">Not set</option>${Object.entries(DR_ACCT).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select> <span class="hint">sets the switches below; change any of them after</span></div>
      <div style="margin-top:4px"><b class="hint">May:</b><div>${Object.entries(DR_PERMS).map(([p, l]) => `<label class="chk">${sw(`data-npperm="${p}"`, p !== 'export' && p !== 'calendar' && p !== 'documents')} ${l}</label>`).join('')}</div></div>
      <label class="chk" style="margin-top:10px"><input type="checkbox" data-np="consent" style="width:18px;height:18px;"> They signed the SMS consent form for this mobile number.</label>
      <div class="toolbar row" style="margin-top:10px"><button class="btn" data-npadd="1">Add user</button> <button class="btn2" data-npgen="1">New temporary password</button></div>
      <div class="npmsg msg" data-npmsg role="status"></div></section>`;
  return `<div class="ulist"><div class="uhead ucols"><div>User</div><div>Username</div><div>Mobile</div><div>Status</div><div></div></div>${rows || '<div class="hint" style="padding:10px">No one has access here yet.</div>'}</div>
    ${can ? '' : '<div class="hint" style="margin-top:10px">View only. Changes to people at this pharmacy are made by its Account Owner or IronLedger.</div>'}${add}`;
}
// behaviour: env = {sid, base:'/host'|'/owner', U:()=>answer, st:drState(), me:()=>ME, reload:async()=>…, paint:()=>…, say:text=>…, pass:html=>…}
function drUsersEvents(root, env){
  const find = sub => env.U().users.find(x => x.sub === sub);
  const stg = sub => env.st.staged[sub] || (env.st.staged[sub] = {});
  const tidy = sub => { if(env.st.staged[sub] && !Object.keys(env.st.staged[sub]).length) delete env.st.staged[sub]; };
  const put = (sub, grp, k, v, was) => { const s = stg(sub); s[grp] = s[grp] || {}; if(v === was) delete s[grp][k]; else s[grp][k] = v; if(!Object.keys(s[grp]).length) delete s[grp]; tidy(sub); };
  const sig = u => { return `Pharmacy ID: ${env.sid}\nUser ID: ${u.login}\nTemporary Pass: `; };
  root.addEventListener('keydown', e => { const h = e.target.closest('[data-open]'); if(h && (e.key === 'Enter' || e.key === ' ') && e.target === h){ e.preventDefault(); h.click(); } });
  root.addEventListener('change', e => {
    const row = e.target.closest('[data-sub]'); if(!row){ const t = e.target.closest('[data-np=type]'); if(t){ const pre = DR_PRESETS[t.value]; if(pre) for(const k in pre){ const c = root.querySelector(`[data-npperm="${k}"]`); if(c) c.checked = pre[k]; } } return; }
    const sub = row.dataset.sub, u = find(sub); if(!u) return;
    const ty = e.target.closest('select[data-utype]');
    if(ty){ if(ty.value === (u.acctType || '')) delete stg(sub).acctType; else stg(sub).acctType = ty.value;
      const pre = DR_PRESETS[ty.value]; if(pre){ const s = stg(sub); s.perms = s.perms || {}; for(const k in pre){ if(pre[k] === !!u.perms[k]) delete s.perms[k]; else s.perms[k] = pre[k]; } if(!Object.keys(s.perms).length) delete s.perms; }
      tidy(sub); env.say(''); env.paint(); return; }
    const dd = e.target.closest('select[data-udoc]');
    if(dd){ if(dd.value === (u.docDuty || '')) delete stg(sub).docDuty; else stg(sub).docDuty = dd.value; tidy(sub); env.say(''); env.paint(); return; }
    const ini = e.target.closest('input[data-uini]');
    if(ini){ const v = ini.value.trim().toUpperCase(); if(v === (u.initials || '')) delete stg(sub).initials; else stg(sub).initials = v; tidy(sub); env.say(''); env.paint(); return; }
    const lic = e.target.closest('input[data-ulic]');
    if(lic){ const v = lic.value.trim().toUpperCase(); if(v === (u.license || '')) delete stg(sub).license; else stg(sub).license = v; tidy(sub); env.say(''); env.paint(); return; }
    const c = e.target.closest('input[type=checkbox]'); if(!c) return;
    if(c.dataset.ust) put(sub, 'stores', c.dataset.ust, c.checked, u.access === true);
    else if(c.dataset.uperm) put(sub, 'perms', c.dataset.uperm, c.checked, !!u.perms[c.dataset.uperm]);
    else if(c.dataset.uadm) put(sub, 'adminStores', c.dataset.uadm, c.checked, u.isAdmin === true);
    else if(c.dataset.uon){ if(!c.checked === !!u.disabled) delete stg(sub).disabled; else stg(sub).disabled = !c.checked; tidy(sub); }
    env.say(''); env.paint();
  });
  const bodyOf = sub => { const s = env.st.staged[sub] || {}, b = {}; if(s.stores) b.stores = s.stores; if(s.perms){ b.perms = s.perms; b.permStore = env.sid; } if(s.adminStores) b.adminStores = s.adminStores;
    ['disabled', 'initials', 'license', 'acctType', 'docDuty'].forEach(k => { if(s[k] !== undefined) b[k] = s[k]; }); return b; };
  root.addEventListener('click', async e => {
    const hd = e.target.closest('[data-open]');
    if(hd && !e.target.closest('button,input,select,a,label')){ env.st.open = env.st.open === hd.dataset.open ? null : hd.dataset.open; env.paint(); return; }
    const t = (s) => e.target.closest(s);
    const up = t('[data-upd]'), un = t('[data-undo]'), rs = t('[data-reset]'), dl = t('[data-del]'), cp = t('[data-copy]'), ph = t('[data-phone]'), pr = t('[data-pinreset]'), na = t('[data-npadd]'), ng = t('[data-npgen]');
    const nm = u => u.name || u.login, url = u => env.base + '/users/' + encodeURIComponent(u.sub);
    try{
      if(ng){ const i = root.querySelector('[data-np=pass]'); i.value = env.st.np = drTemp(); return; }
      if(na){
        const g = k => ((root.querySelector(`[data-np=${k}]`) || {}).value || '').trim(), perms = {}; root.querySelectorAll('[data-npperm]').forEach(c => perms[c.dataset.npperm] = c.checked);
        const say = (m, ok) => { const el = root.querySelector('[data-npmsg]'); el.textContent = m; el.className = 'npmsg msg' + (ok ? ' ok' : ''); };
        if(!g('name') || !g('login') || !g('phone')) return say('Name, Login ID and mobile number are all needed.');
        if(!root.querySelector('[data-np=consent]').checked) return say('Tick the box to confirm they signed the SMS consent form for this number.');
        const body = {name:g('name'), login:g('login').toLowerCase(), phone:g('phone'), tempPassword:g('pass') || undefined, initials:g('ini').toUpperCase(), license:g('lic').toUpperCase(), acctType:g('type'), stores:{[env.sid]:true}, perms, smsConsent:true};
        busy(na, true);
        try{ const r = await api('POST', env.base + '/users', body); env.st.temps[r.user.sub] = r.tempPassword; env.st.np = '';
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

/* ---------------- client account page (host): who the client is, for account creation and billing ----------------
   Built on the layout engine (layout_engine.js) like every page of the suite. CLIENT_LAYOUT is set by Neo with the layout editor
   (dev/build_layout_editor.py client) and is the same for everyone. Uses helpers from pharm_panels.js (stateSelect, entTypeSelect, ENT_TYPES, esc).
   A client is the bill-to account: the legal entity that pays, its EIN, addresses and contacts, and the generated IL- account number (the client's key;
   it never changes). Pharmacies belong to a client; each pharmacy also carries its own licensed entity (that EIN can differ). */
const CLIENT_PANELS = [['ent', 'Client And Legal Entity'], ['addr', 'Addresses'], ['contact', 'Phone, Fax And Contacts'], ['own', 'Account Owner'], ['pharm', 'Pharmacies'], ['bill', 'Billing And Invoices'], ['act', 'Save']];
const CLIENT_LAYOUT = {"v":2,"cols":12,"panels":{"ent":[1,1,4,30],"own":[1,31,4,24],"addr":[5,1,4,44],"contact":[9,1,4,44],"pharm":[1,56,4,28],"bill":[5,46,8,38],"act":[1,85,12,10]}};
const CLIENT_SAMPLE = {id:'IL-000001', legalName:'NorTex Holdings LLC', dba:'NorTex Pharmacy', entityType:'llc', ein:'12-3456789', address:'100 Main St', suite:'Suite 5', city:'Haslet', state:'TX', zip:'76052', billingSame:false, bAddress:'PO Box 12', bCity:'Haslet', bState:'TX', bZip:'76052', phone:'817-555-0100', fax:'817-555-0101',
  contacts:[{role:'relations', name:'Pat Owner', title:'Owner', email:'pat@example.com', phone:'817-555-0102'},{role:'billing', name:'Sam Books', title:'Bookkeeper', email:'sam@example.com', phone:''}], pharmacies:['NTX1','NTX2']};
const CLIENT_PAGE = { id: 'client', title: 'Host Account (Client) Setup Page', panels: CLIENT_PANELS, layout: CLIENT_LAYOUT,
  render: (_unused, panels) => clientCardHtml(CLIENT_SAMPLE, { host: true, billing: BILL_SAMPLE, people: [], stores: [{ id: 'NTX1', name: 'NorTex Pharmacy - Haslet', city: 'Haslet', state: 'TX' }, { id: 'NTX2', name: 'NorTex Pharmacy - Keller', city: 'Keller', state: 'TX' }] }, { panels }) };
const money = c => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const BILL_SAMPLE = { today: '2026-11-19', summary: { newThisMonth: { count: 1, cents: 14900 }, paidThisMonth: { count: 1, cents: 14900 }, unpaid: { count: 1, cents: 14900 }, delinquent: { count: 0, cents: 0 } },
  invoices: [{ id: '2026-11-01_a1', number: 'IL-000001-202611-01', issued: '2026-11-01', due: '2026-11-15', cents: 14900, description: 'Compliance Calendar', status: 'paid', delinquent: false, paidOn: '2026-11-10' }, { id: '2026-12-01_b2', number: 'IL-000001-202612-01', issued: '2026-12-01', due: '2026-12-15', cents: 14900, description: 'Compliance Calendar', status: 'unpaid', delinquent: false }] };
const CONTACT_ROLE_LABELS = { relations: 'Client relations', billing: 'Billing', other: 'Other' };
const clientLocked = (k, cl, c) => !c.isNew && !!cl[k];                 // identity values already on file are locked until the host unlocks them with a reason
const cfIn = (cl, k, l, c, o) => { o = o || {}; const lk = o.ident && clientLocked(k, cl, c);
  return `<label><span>${l}</span><input type="${o.type || 'text'}" data-cf="${k}" value="${esc(cl[k] || '')}"${o.max ? ` maxlength="${o.max}"` : ''}${o.ph ? ` placeholder="${o.ph}"` : ''}${lk ? ' readonly data-ident="1"' : ''}></label>`; };
const contactRows = list => list.map((x, i) => `<div class="clrow"><span class="cld">${esc(CONTACT_ROLE_LABELS[x.role] || x.role)}</span><span class="cln"><b>${esc(x.name)}</b>${x.title ? ', ' + esc(x.title) : ''}${x.email ? ' · ' + esc(x.email) : ''}${x.phone ? ' · ' + esc(x.phone) : ''}</span><button type="button" class="edit" data-ctdel="${i}" title="Remove this contact">✕</button></div>`).join('');
const contactsOfCard = card => { const el = card.querySelector('[data-ctcs]'); try{ return JSON.parse(el.dataset.ctcs); }catch(_){ return []; } };
const CLIENT_BODY = {
  ent: (cl, c) => `<div class="pfields">${c.isNew ? '<div class="hint">The account number (IL-…) is generated when you create the client and never changes.</div>' : `<div class="pid">Account number: <b>${esc(cl.id)}</b></div><div class="hint">(generated once; never changes)</div>`}
      <label><span>Entity type (required)</span>${entTypeSelect(`data-cf="entityType"${clientLocked('entityType', cl, c) ? ' disabled data-ident="1"' : ''}`, cl.entityType)}</label>
      ${cfIn(cl, 'legalName', 'Legal name of the entity (required)', c, { ident: true, max: 160 })}
      ${cfIn(cl, 'dba', 'DBA (doing business as), if any', c, { max: 160 })}
      ${cfIn(cl, 'ein', 'EIN (required)', c, { ident: true, max: 11, ph: '12-3456789' })}
      ${!c.isNew && !c.ro ? `<div class="identbar"><button type="button" class="btn2 small" data-unlockclient="1">Change legal name, entity type or EIN…</button>
        <div class="hint">Locked on purpose: billing follows the client’s identity. A reason is required and every change is kept in the history.</div>
        <label class="reason" hidden><span>Reason for the change</span><input type="text" data-reason maxlength="300"></label></div>` : ''}</div>`,
  addr: (cl, c) => `<div class="pfields"><b class="clh">Business address</b>
      ${cfIn(cl, 'address', 'Street address', c, { max: 200 })}${cfIn(cl, 'suite', 'Suite / unit (if any)', c, { max: 40 })}${cfIn(cl, 'city', 'City', c, { max: 80 })}
      <label><span>State</span>${stateSelect('data-cf="state"', cl.state)}</label>${cfIn(cl, 'zip', 'ZIP code', c, { max: 10 })}
      <label class="chk">${sw('data-cf="billingSame"', cl.billingSame !== false)} Billing address is the same</label>
      <div data-billbox${cl.billingSame !== false ? ' hidden' : ''}><b class="clh">Billing address</b>
      ${cfIn(cl, 'bAddress', 'Street address', c, { max: 200 })}${cfIn(cl, 'bSuite', 'Suite / unit (if any)', c, { max: 40 })}${cfIn(cl, 'bCity', 'City', c, { max: 80 })}
      <label><span>State</span>${stateSelect('data-cf="bState"', cl.bState)}</label>${cfIn(cl, 'bZip', 'ZIP code', c, { max: 10 })}</div></div>`,
  contact: (cl, c) => `<div class="pfields">${cfIn(cl, 'phone', 'Telephone', c, { type: 'tel', max: 30 })}${cfIn(cl, 'fax', 'Fax', c, { type: 'tel', max: 30 })}
      <b class="clh">Contacts</b><div class="hint">Client relations and billing contacts. They don’t need a login.</div>
      <div class="cllist" data-ctlist>${contactRows(cl.contacts || [])}</div>
      <div class="cladd ctadd"><select data-ctrole>${Object.entries(CONTACT_ROLE_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <input type="text" data-ctname maxlength="80" placeholder="Name"><input type="text" data-cttitle maxlength="60" placeholder="Title">
        <input type="email" data-ctemail maxlength="120" placeholder="Email"><input type="tel" data-ctphone maxlength="30" placeholder="Phone">
        <button type="button" class="btn2 small" data-ctadd="1">Add</button></div>
      <span data-ctcs='${esc(JSON.stringify(cl.contacts || []))}' hidden></span></div>`,
  own: (cl, c) => {
    const owner = (c.people || []).find(u => u.ownerClients && u.ownerClients[cl.id] === true);
    const pool = (c.people || []).filter(u => !u.host && !u.disabled);
    const head = c.isNew ? '' : `<div class="pid">Client Account Owner: <b>${owner ? esc(ownLabel(owner)) : 'Not set'}</b></div><div class="hint">Sees this client page (setup information, billing and invoices) behind a password step-up. Often the same person who owns the pharmacy.</div>`;
    if(!c.host || c.ro) return `<div class="pfields" style="display:block">${head}${c.host ? '' : '<div class="lockhint">Set by IronLedger.</div>'}</div>`;
    return `<div class="pfields" style="display:block">${head}<div class="ownbox">${c.isNew ? '<b class="clh">Account Owner (optional now; can be set later)</b>' : '<b class="clh">Change the client’s Account Owner</b>'}
      <label><span>Pick a login</span><select data-cownpick><option value="">—</option>${pool.map(u => `<option value="${esc(u.login)}">${esc(ownLabel(u))}</option>`).join('')}<option value="@new">New login…</option></select></label>
      <div data-cownnew hidden class="pfields"><label><span>Full name</span><input type="text" data-cn="name" maxlength="120"></label><label><span>Login ID</span><input type="text" data-cn="login" maxlength="32" autocapitalize="none" spellcheck="false"></label>
        <label><span>Mobile number</span><input type="tel" data-cn="phone" maxlength="20"></label><label><span>RPh license # (if a pharmacist)</span><input type="text" data-cn="license" maxlength="20"></label>
        <label class="chk" style="grid-column:1/-1"><input type="checkbox" data-cn="consent"> They signed the SMS consent form for this mobile number.</label></div>
      ${!c.isNew && owner ? '<label><span>Reason for the change (required)</span><input type="text" data-cownreason maxlength="300"></label>' : ''}
      ${c.isNew ? '' : `<button type="button" class="btn2 small" data-cownsave="${esc(cl.id)}">Save Account Owner</button>`}</div></div>`;
  },
  pharm: (cl, c) => { if(c.isNew) return '<div class="pfields" style="display:block"><div class="hint">Create the client first, then add its pharmacies here.</div></div>';
    const rows = (cl.pharmacies || []).map(id => (c.stores || []).find(x => x.id === id) || { id }).map(s => { const I = ownInfo(s, c.people);
      return `<button type="button" class="clrow2" data-openpharm="${esc(s.id)}"><b>${esc(s.id)}</b><span>${esc(s.name || '')}</span><span class="hint">${esc([s.city, s.state].filter(Boolean).join(', '))}</span><span class="hint">${I.owner ? esc(I.owner.name || I.owner.login) : 'No owner yet'}</span></button>`; }).join('');
    return `<div class="pfields" style="display:block">${c.host && !c.ro ? `<button type="button" class="btn small" data-addpharm="${esc(cl.id)}">Add pharmacy</button>` : ''}
      <div class="plist">${rows || '<div class="hint" style="margin-top:8px">No pharmacies yet.</div>'}</div></div>`; },
  bill: (cl, c) => { const B = c.billing; if(c.isNew) return '<div class="pfields" style="display:block"><div class="hint">Invoices appear here once the client exists.</div></div>';
    if(!B) return '<div class="pfields" style="display:block"><div class="hint">Loading…</div></div>';
    const S = B.summary, tile = (l, x, cls) => `<div class="bt ${cls || ''}"><span>${l}</span><b>${x.count}</b><em>${money(x.cents)}</em></div>`;
    const st = i => i.status === 'paid' ? `<span class="ust ok">Paid${i.paidOn ? ' ' + esc(i.paidOn) : ''}</span>` : i.status === 'void' ? '<span class="ust off">Void</span>' : i.delinquent ? '<span class="ust bad">Delinquent</span>' : '<span class="ust wait">Unpaid</span>';
    const rows = B.invoices.map(i => `<tr><td>${esc(i.number)}</td><td>${esc(i.issued)}</td><td>${esc(i.due)}</td><td class="num">${money(i.cents)}</td><td>${esc(i.description)}</td><td>${st(i)}</td>${c.host && !c.ro ? `<td class="acts">${i.status !== 'paid' && i.status !== 'void' ? `<button type="button" class="btn2 small" data-invpaid="${esc(i.id)}">Mark paid</button> <button type="button" class="btn2 small" data-invvoid="${esc(i.id)}">Void</button>` : i.status === 'paid' ? `<button type="button" class="btn2 small" data-invunpaid="${esc(i.id)}">Undo</button>` : ''}</td>` : ''}</tr>`).join('');
    return `<div class="pfields" style="display:block"><div class="btiles">${tile('New this month', S.newThisMonth)}${tile('Paid this month', S.paidThisMonth, 'ok')}${tile('Unpaid', S.unpaid)}${tile('Delinquent', S.delinquent, S.delinquent.count ? 'bad' : '')}</div>
      <div class="tscroll"><table class="invt"><thead><tr><th>Invoice</th><th>Issued</th><th>Due</th><th class="num">Amount</th><th>For</th><th>Status</th>${c.host && !c.ro ? '<th></th>' : ''}</tr></thead><tbody>${rows || `<tr><td colspan="7" class="hint">No invoices yet.</td></tr>`}</tbody></table></div>
      ${c.host && !c.ro ? `<div class="invadd"><b class="clh">Add an invoice</b><div class="pfields"><label><span>Issued</span><input type="date" data-iv="issued"></label><label><span>Due</span><input type="date" data-iv="due"></label>
        <label><span>Amount ($)</span><input type="text" inputmode="decimal" data-iv="amount" maxlength="12"></label><label><span>For</span><input type="text" data-iv="description" maxlength="200"></label></div>
        <button type="button" class="btn2 small" data-invadd="${esc(cl.id)}">Add invoice</button></div>` : '<div class="hint">Read only. Questions about an invoice go to IronLedger.</div>'}</div>`; },
  act: (cl, c) => `<div class="pfields" style="display:block">
      <div style="margin-top:10px">${c.ro ? '' : c.isNew ? '<button type="button" class="btn small" data-createclient="1">Create client</button>' : `<button type="button" class="btn small" data-saveclient="${esc(cl.id)}">Save client</button>`}</div>
      ${c.isNew ? '' : `<div style="margin-top:8px"><button type="button" class="btn2 small" data-chist="${esc(cl.id)}">Change history</button><div data-histout></div></div>`}</div>`
};
// read-only view (the client's Account Owner): everything shown, nothing editable
function clientFreeze(root){ root.querySelectorAll('input,select,textarea,button[data-ctdel]').forEach(e => { e.disabled = true; }); root.querySelectorAll('.ctadd,[data-ctdel],.identbar,[data-pnl=act]').forEach(e => { e.hidden = true; e.style.display = 'none'; }); }
function clientCardHtml(cl, c, L){ return layoutGridHtml(CLIENT_PAGE, L, id => CLIENT_BODY[id](cl, c)); }

// ---------------- behaviour for the host page ----------------
// o = { stores: () => [pharmacy…], say: text => …, after: async isNew => … }
function clientCardEvents(root, o){
  root.addEventListener('change', e => {
    const p = e.target.closest('[data-cownpick]'); if(p){ p.closest('.pcard').querySelector('[data-cownnew]').hidden = p.value !== '@new'; return; }
    const b = e.target.closest('[data-cf=billingSame]'); if(!b) return;
    e.target.closest('.pcard').querySelector('[data-billbox]').hidden = b.checked;
  });
  const ownerSpec = card => {
    const pick = (card.querySelector('[data-cownpick]') || {}).value || '', g = k => ((card.querySelector(`[data-cn=${k}]`) || {}).value || '').trim();
    if(!pick) return null;
    if(pick !== '@new') return { login: pick };
    if(!g('name') || !g('login') || !g('phone')) throw new Error('Name, Login ID and mobile number are all needed for the new login.');
    if(!card.querySelector('[data-cn=consent]').checked) throw new Error('Have them sign the SMS consent form first, then tick the box.');
    return { create: { name: g('name'), login: g('login').toLowerCase(), phone: g('phone'), license: g('license'), smsConsent: true } };
  };
  const passHtml = (r, what) => `<b>${esc(r.owner.name || r.owner.login)} is the ${what}.</b> Give them:<br>Login ID: <b class="mono">${esc(r.owner.login)}</b><br>Temporary password: <b class="mono">${esc(r.tempPassword)}</b>`;
  root.addEventListener('click', async e => {
    const card = e.target.closest('.pcard'); if(!card) return;
    const op = e.target.closest('[data-openpharm]'), ap = e.target.closest('[data-addpharm]'), cs = e.target.closest('[data-cownsave]');
    const ia = e.target.closest('[data-invadd]'), ipd = e.target.closest('[data-invpaid]'), ivd = e.target.closest('[data-invvoid]'), iup = e.target.closest('[data-invunpaid]');
    if(op){ if(o.openPharm) o.openPharm(op.dataset.openpharm); return; }
    if(ap){ if(o.addPharm) o.addPharm(ap.dataset.addpharm); return; }
    if(cs){
      let spec; try{ spec = ownerSpec(card); }catch(err){ alert(err.message); return; }
      if(!spec){ alert('Pick who will be the client’s Account Owner.'); return; }
      busy(cs, true);
      try{ const r = await api('POST', '/host/clients/' + encodeURIComponent(cs.dataset.cownsave) + '/owner', { owner: spec, reason: (card.querySelector('[data-cownreason]') || {}).value || '' });
        if(o.pass && r.tempPassword) o.pass(passHtml(r, 'client’s Account Owner')); o.say('Account Owner saved.'); await o.after(false); }
      catch(err){ if(!err.auth) alert(err.message); } finally{ busy(cs, false); }
      return;
    }
    if(ia || ipd || ivd || iup){
      try{
        if(ia){ const g = k => card.querySelector(`[data-iv=${k}]`).value.trim(); await api('POST', '/host/clients/' + encodeURIComponent(ia.dataset.invadd) + '/invoices', { issued: g('issued') || undefined, due: g('due'), amount: g('amount'), description: g('description') }); }
        else if(ipd){ await api('POST', '/host/clients/' + encodeURIComponent(card.dataset.client) + '/invoices/' + encodeURIComponent(ipd.dataset.invpaid), { status: 'paid' }); }
        else if(iup){ await api('POST', '/host/clients/' + encodeURIComponent(card.dataset.client) + '/invoices/' + encodeURIComponent(iup.dataset.invunpaid), { status: 'unpaid' }); }
        else { const why = prompt('Why is this invoice voided?'); if(!why) return; await api('POST', '/host/clients/' + encodeURIComponent(card.dataset.client) + '/invoices/' + encodeURIComponent(ivd.dataset.invvoid), { status: 'void', note: why }); }
        o.say('Invoices updated.'); await o.after(false);
      }catch(err){ if(!err.auth) alert(err.message); }
      return;
    }
    const add = e.target.closest('[data-ctadd]'), del = e.target.closest('[data-ctdel]'), ul = e.target.closest('[data-unlockclient]'), hs = e.target.closest('[data-chist]'), sv = e.target.closest('[data-saveclient],[data-createclient]');
    if(add || del){
      const list = contactsOfCard(card), q = s => card.querySelector(s);
      if(del) list.splice(+del.dataset.ctdel, 1);
      else{
        const name = q('[data-ctname]').value.trim(); if(!name){ alert('Give the contact a name.'); return; }
        list.push({ role: q('[data-ctrole]').value, name, title: q('[data-cttitle]').value.trim(), email: q('[data-ctemail]').value.trim(), phone: q('[data-ctphone]').value.trim() });
        ['name', 'title', 'email', 'phone'].forEach(k => q(`[data-ct${k}]`).value = '');
      }
      q('[data-ctcs]').dataset.ctcs = JSON.stringify(list); q('[data-ctlist]').innerHTML = contactRows(list); return;
    }
    if(ul){
      if(!confirm('Billing follows the client’s identity. Unlock the legal name, entity type and EIN to make a change? You will be asked for a reason.')) return;
      card.querySelectorAll('[data-ident]').forEach(i => { i.removeAttribute('readonly'); i.removeAttribute('disabled'); });
      const r = card.querySelector('.reason'); r.hidden = false; r.querySelector('input').focus(); return;
    }
    if(hs){
      const out = card.querySelector('[data-histout]'); out.innerHTML = '<div class="hint">Loading…</div>';
      try{
        const r = await api('GET', '/host/clients/' + encodeURIComponent(hs.dataset.chist) + '/history');
        out.innerHTML = r.history.length ? r.history.map(h => `<div class="npibox"><b>${esc((h.at || '').slice(0, 16).replace('T', ' '))} UTC</b> · ${esc(h.by)}${h.reason ? ' · “' + esc(h.reason) + '”' : ''}<div class="hint">${Object.entries(h.changes).map(([k, v]) => esc(k) + ': ' + esc(Array.isArray(v[0]) ? v[0].length + ' contacts' : v[0] == null ? '(blank)' : String(v[0])) + ' → ' + esc(Array.isArray(v[1]) ? v[1].length + ' contacts' : String(v[1]))).join('<br>')}</div></div>`).join('') : '<div class="hint">No changes recorded yet.</div>';
      }catch(err){ if(!err.auth) out.innerHTML = `<div class="npibox bad">${esc(err.message)}</div>`; }
      return;
    }
    if(sv){
      const isNew = !!sv.dataset.createclient, body = {};
      card.querySelectorAll('[data-cf]').forEach(i => body[i.dataset.cf] = i.type === 'checkbox' ? i.checked : i.value.trim());
      body.contacts = contactsOfCard(card);
      const rs = card.querySelector('[data-reason]'); if(rs && rs.value.trim()) body.changeReason = rs.value.trim();
      if(isNew){ try{ const sp = ownerSpec(card); if(sp) body.owner = sp; }catch(err){ alert(err.message); return; } }
      busy(sv, true);
      try{
        const r = await api('POST', '/host/clients' + (isNew ? '' : '/' + encodeURIComponent(sv.dataset.saveclient)), body);
        if(isNew && r.tempPassword && o.pass) o.pass(passHtml(r, 'client’s Account Owner'));
        o.say(isNew ? 'Client created: ' + r.id + (r.ownerError ? '. The Account Owner was not set: ' + r.ownerError : '') : 'Client saved.'); await o.after(isNew ? r.id : false);
      }catch(err){ if(!err.auth) alert(err.message); } finally{ busy(sv, false); }
    }
  });
}

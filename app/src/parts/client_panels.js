/* ---------------- client account page (host): who the client is, for account creation and billing ----------------
   Built on the layout engine (layout_engine.js) like every page of the suite. CLIENT_LAYOUT is set by Neo with the layout editor
   (dev/build_layout_editor.py client) and is the same for everyone. Uses helpers from pharm_panels.js (stateSelect, entTypeSelect, ENT_TYPES, esc).
   A client is the bill-to account: the legal entity that pays, its EIN, addresses and contacts, and the generated IL- account number (the client's key;
   it never changes). Pharmacies belong to a client; each pharmacy also carries its own licensed entity (that EIN can differ). */
const CLIENT_PANELS = [['ent', 'Client And Legal Entity'], ['addr', 'Addresses'], ['contact', 'Phone, Fax And Contacts'], ['own', 'Account Owner'], ['act', 'Save']];
const CLIENT_LAYOUT = {"v":2,"cols":12,"panels":{"ent":[1,1,6,18],"addr":[1,19,6,23],"act":[1,42,6,14],"own":[7,1,6,27],"contact":[7,28,6,28]}};
const CLIENT_SAMPLE = {id:'IL-000001', legalName:'NorTex Holdings LLC', dba:'NorTex Pharmacy', entityType:'llc', ein:'12-3456789', address:'100 Main St', suite:'Suite 5', city:'Haslet', state:'TX', zip:'76052', billingSame:false, bAddress:'PO Box 12', bCity:'Haslet', bState:'TX', bZip:'76052', phone:'817-555-0100', fax:'817-555-0101',
  contacts:[{role:'relations', name:'Pat Owner', title:'Owner', email:'pat@example.com', phone:'817-555-0102'},{role:'billing', name:'Sam Books', title:'Bookkeeper', email:'sam@example.com', phone:''}], pharmacies:['NTX1','NTX2']};
const CLIENT_PAGE = { id: 'client', title: 'Host Account (Client) Setup Page', panels: CLIENT_PANELS, layout: CLIENT_LAYOUT,
  render: (_unused, panels) => clientCardHtml(CLIENT_SAMPLE, { host: true, people: [], stores: [{ id: 'NTX1', name: 'NorTex Pharmacy - Haslet', city: 'Haslet', state: 'TX' }, { id: 'NTX2', name: 'NorTex Pharmacy - Keller', city: 'Keller', state: 'TX' }] }, { panels }) };
const money = c => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const CONTACT_ROLE_LABELS = { relations: 'Client relations', billing: 'Billing', other: 'Other' };
const clientLocked = (k, cl, c) => !c.isNew && !!cl[k];                 // identity values already on file are locked until the host unlocks them with a reason
const cfIn = (cl, k, l, c, o) => { o = o || {}; const lk = o.ident && clientLocked(k, cl, c);
  return `<label${o.w2 ? ' class="w2"' : ''}><span>${l}</span><input type="${o.type || 'text'}" data-cf="${k}" value="${esc(cl[k] || '')}"${o.max ? ` maxlength="${o.max}"` : ''}${o.ph ? ` placeholder="${o.ph}"` : ''}${lk ? ' readonly data-ident="1"' : ''}></label>`; };
const contactRows = list => list.map((x, i) => `<div class="clrow"><span class="cld">${esc(CONTACT_ROLE_LABELS[x.role] || x.role)}</span><span class="cln"><b>${esc(x.name)}</b>${x.title ? ', ' + esc(x.title) : ''}${x.email ? ' · ' + esc(x.email) : ''}${x.phone ? ' · ' + esc(x.phone) : ''}</span><button type="button" class="edit" data-ctdel="${i}" title="Remove this contact">✕</button></div>`).join('');
const contactsOfCard = card => { const el = card.querySelector('[data-ctcs]'); try{ return JSON.parse(el.dataset.ctcs); }catch(_){ return []; } };
const CLIENT_BODY = {
  ent: (cl, c) => `<div class="pfields">${c.isNew ? '<div class="hint">The account number (IL-…) is generated when you create the client.</div>' : `<div class="pid">Account number: <b>${esc(cl.id)}</b> <span class="hint">(never changes)</span></div>`}
      <label><span>Entity type (required)</span>${entTypeSelect(`data-cf="entityType"${clientLocked('entityType', cl, c) ? ' disabled data-ident="1"' : ''}`, cl.entityType)}</label>
      ${cfIn(cl, 'legalName', 'Legal name of the entity (required)', c, { ident: true, max: 160, w2: true })}
      ${cfIn(cl, 'dba', 'DBA (doing business as), if any', c, { max: 160, w2: true })}
      ${cfIn(cl, 'ein', 'EIN (required)', c, { ident: true, max: 11, ph: '12-3456789' })}
      ${!c.isNew && !c.ro ? `<div class="identbar"><button type="button" class="btn2 small" data-unlockclient="1" title="Legal name, entity type and EIN are locked once on file. A reason is required and every change is kept in the history.">Unlock fields</button>
        <label class="reason" hidden><span>Reason for the change</span><input type="text" data-reason maxlength="300"></label></div>` : ''}</div>`,
  addr: (cl, c) => `<div class="pfields"><b class="clh">Business address</b>
      ${cfIn(cl, 'address', 'Street address', c, { max: 200 })}${cfIn(cl, 'suite', 'Suite / unit (if any)', c, { max: 40 })}${cfIn(cl, 'city', 'City', c, { max: 80 })}
      <label><span>State</span>${stateSelect('data-cf="state"', cl.state)}</label>${cfIn(cl, 'zip', 'ZIP code', c, { max: 10 })}
      <label class="chk">${sw('data-cf="billingSame"', cl.billingSame !== false)} Billing address is the same</label>
      <div data-billbox${cl.billingSame !== false ? ' hidden' : ''}><b class="clh">Billing address</b>
      ${cfIn(cl, 'bAddress', 'Street address', c, { max: 200 })}${cfIn(cl, 'bSuite', 'Suite / unit (if any)', c, { max: 40 })}${cfIn(cl, 'bCity', 'City', c, { max: 80 })}
      <label><span>State</span>${stateSelect('data-cf="bState"', cl.bState)}</label>${cfIn(cl, 'bZip', 'ZIP code', c, { max: 10 })}</div></div>`,
  contact: (cl, c) => `<div class="pfields">${cfIn(cl, 'phone', 'Telephone', c, { type: 'tel', max: 30 })}${cfIn(cl, 'fax', 'Fax', c, { type: 'tel', max: 30 })}
      <b class="clh">Contacts</b><div class="hint">They don’t need a login.</div>
      <div class="cllist" data-ctlist>${contactRows(cl.contacts || [])}</div>
      <div class="cladd ctadd"><select data-ctrole>${Object.entries(CONTACT_ROLE_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <input type="text" data-ctname maxlength="80" placeholder="Name"><input type="text" data-cttitle maxlength="60" placeholder="Title">
        <input type="email" data-ctemail maxlength="120" placeholder="Email"><input type="tel" data-ctphone maxlength="30" placeholder="Phone">
        <button type="button" class="btn2 small" data-ctadd="1">Add</button></div>
      <span data-ctcs='${esc(JSON.stringify(cl.contacts || []))}' hidden></span></div>`,
  own: (cl, c) => {
    const owner = (c.people || []).find(u => u.ownerClients && u.ownerClients[cl.id] === true);
    const pool = (c.people || []).filter(u => !u.employeeOnly && !u.disabled);
    const head = c.isNew ? '' : `<div class="pid">Client Account Owner: <b>${owner ? esc(ownLabel(owner)) : 'Not set'}</b></div><div class="hint">Sees this page and each pharmacy’s billing, read only.</div>`;
    if(!c.host || c.ro) return `<div class="pfields" style="display:block">${head}${c.host ? '' : '<div class="lockhint">Set by IronLedger.</div>'}</div>`;
    return `<div class="pfields" style="display:block">${head}<div class="ownbox">${c.isNew ? '<b class="clh">Account Owner (optional now; can be set later)</b>' : '<b class="clh">Change the client’s Account Owner</b>'}
      <label><span>Pick a login</span><select data-cownpick><option value="">—</option>${pool.map(u => `<option value="${esc(u.login)}">${esc(ownLabel(u))}</option>`).join('')}<option value="@new">New login…</option></select></label>
      <div data-cownnew hidden class="pfields"><label><span>Full name</span><input type="text" data-cn="name" maxlength="120"></label><label><span>Login ID</span><input type="text" data-cn="login" maxlength="32" autocapitalize="none" spellcheck="false"></label>
        <label><span>Mobile number</span><input type="tel" data-cn="phone" maxlength="20"></label><label><span>RPh license # (if a pharmacist)</span><input type="text" data-cn="license" maxlength="20"></label>
        <label class="chk" style="grid-column:1/-1"><input type="checkbox" data-cn="consent"> They signed the SMS consent form for this mobile number.</label></div>
      ${!c.isNew && owner ? '<label><span>Reason for the change (required)</span><input type="text" data-cownreason maxlength="300"></label>' : ''}
      ${c.isNew ? '' : `<button type="button" class="btn2 small" data-cownsave="${esc(cl.id)}">Save Account Owner</button>`}</div></div>`;
  },
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
    const cs = e.target.closest('[data-cownsave]');
    if(cs){
      let spec; try{ spec = ownerSpec(card); }catch(err){ alert(err.message); return; }
      if(!spec){ alert('Pick who will be the client’s Account Owner.'); return; }
      busy(cs, true);
      try{ const r = await api('POST', '/host/clients/' + encodeURIComponent(cs.dataset.cownsave) + '/owner', { owner: spec, reason: (card.querySelector('[data-cownreason]') || {}).value || '' });
        if(o.pass && r.tempPassword) o.pass(passHtml(r, 'client’s Account Owner')); o.say('Account Owner saved.'); await o.after(false); }
      catch(err){ if(!err.auth) alert(err.message); } finally{ busy(cs, false); }
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

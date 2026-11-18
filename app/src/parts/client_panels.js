/* ---------------- client account page (host): who the client is, for account creation and billing ----------------
   Built on the layout engine (layout_engine.js) like every page of the suite. CLIENT_LAYOUT is set by Neo with the layout editor
   (dev/build_layout_editor.py client) and is the same for everyone. Uses helpers from pharm_panels.js (stateSelect, entTypeSelect, ENT_TYPES, esc).
   A client is the bill-to account: the legal entity that pays, its EIN, addresses and contacts, and the generated IL- account number (the client's key;
   it never changes). Pharmacies belong to a client; each pharmacy also carries its own licensed entity (that EIN can differ). */
const CLIENT_PANELS = [['ent', 'Client And Legal Entity'], ['addr', 'Addresses'], ['contact', 'Phone, Fax And Contacts'], ['act', 'Save And Pharmacies']];
const CLIENT_LAYOUT = {"v":2,"cols":12,"panels":{"ent":[1,1,4,30],"addr":[5,1,4,44],"contact":[9,1,4,44],"act":[1,45,12,14]}};
const CLIENT_SAMPLE = {id:'IL-000001', legalName:'NorTex Holdings LLC', dba:'NorTex Pharmacy', entityType:'llc', ein:'12-3456789', address:'100 Main St', suite:'Suite 5', city:'Haslet', state:'TX', zip:'76052', billingSame:false, bAddress:'PO Box 12', bCity:'Haslet', bState:'TX', bZip:'76052', phone:'817-555-0100', fax:'817-555-0101',
  contacts:[{role:'relations', name:'Pat Owner', title:'Owner', email:'pat@example.com', phone:'817-555-0102'},{role:'billing', name:'Sam Books', title:'Bookkeeper', email:'sam@example.com', phone:''}], pharmacies:['NTX1','NTX2']};
const CLIENT_PAGE = { id: 'client', title: 'Host Account (Client) Setup Page', panels: CLIENT_PANELS, layout: CLIENT_LAYOUT,
  render: (_unused, panels) => clientCardHtml(CLIENT_SAMPLE, { host: true, stores: [{ id: 'NTX1', name: 'NorTex Pharmacy - Haslet' }, { id: 'NTX2', name: 'NorTex Pharmacy - Keller' }] }, { panels }) };
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
  act: (cl, c) => `<div class="pfields" style="display:block">${c.isNew ? '' : `<div class="pid"><b>Pharmacies under this client</b></div>
      <div class="chips">${(cl.pharmacies || []).map(id => { const s = (c.stores || []).find(x => x.id === id); return `<span class="chip">${esc(id)}${s && s.name ? ' · ' + esc(s.name) : ''}</span>`; }).join('') || '<span class="hint">None yet. Pick this client when you set up a pharmacy.</span>'}</div>`}
      <div style="margin-top:10px">${c.ro ? '' : c.isNew ? '<button type="button" class="btn small" data-createclient="1">Create client</button>' : `<button type="button" class="btn small" data-saveclient="${esc(cl.id)}">Save client</button>`}</div>
      ${c.isNew ? '' : `<div style="margin-top:8px"><button type="button" class="btn2 small" data-chist="${esc(cl.id)}">Change history</button><div data-histout></div></div>`}</div>`
};
function clientCardHtml(cl, c, L){ return layoutGridHtml(CLIENT_PAGE, L, id => CLIENT_BODY[id](cl, c)); }

// ---------------- behaviour for the host page ----------------
// o = { stores: () => [pharmacy…], say: text => …, after: async isNew => … }
function clientCardEvents(root, o){
  root.addEventListener('change', e => {
    const b = e.target.closest('[data-cf=billingSame]'); if(!b) return;
    e.target.closest('.pcard').querySelector('[data-billbox]').hidden = b.checked;
  });
  root.addEventListener('click', async e => {
    const card = e.target.closest('.pcard'); if(!card) return;
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
      busy(sv, true);
      try{
        const r = await api('POST', '/host/clients' + (isNew ? '' : '/' + encodeURIComponent(sv.dataset.saveclient)), body);
        o.say(isNew ? 'Client created: ' + r.id : 'Client saved.'); await o.after(isNew);
      }catch(err){ if(!err.auth) alert(err.message); } finally{ busy(sv, false); }
    }
  });
}

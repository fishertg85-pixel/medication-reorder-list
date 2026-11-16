/* ---------------- pharmacy account page: panels and their layout ----------------
   The pharmacy card is built from panels placed on a 12-column grid. Each panel's place is [column, row, width, height]
   (1-based column and row; width in columns; height in rows). Rows are as tall as their content, so nothing is ever cut off.
   Rows are 12 px steps; a panel is never shorter than its content (the page grows if content grows, e.g. a registry result).
   PHARM_LAYOUT is set once by the owner of the program with the layout editor and is the same for everyone.
   Narrow screens (under 1280 px wide) ignore it and stack the panels in reading order. */
const PHARM_COLS = 12, PHARM_ROW = 12;   // a row unit is 12 px; a panel's height is a number of rows
const PHARM_PANELS = [['id', 'Pharmacy'], ['contact', 'Name And Address'], ['reg', 'License And Registration'], ['svc', 'Services Provided'], ['hrs', 'Hours Of Operation'], ['act', 'Calendar And Save']];
const PHARM_LAYOUT = {"v":2,"cols":12,"panels":{"id":[1,1,3,35],"contact":[4,1,4,35],"hrs":[8,1,5,35],"reg":[1,36,7,37],"svc":[1,73,12,19],"act":[8,36,5,14]}};
function pharmLayoutOk(L){
  if(!L || L.v !== 2 || L.cols !== PHARM_COLS || !L.panels) return false;
  const seen = [];
  for(const [id] of PHARM_PANELS){
    const p = L.panels[id]; if(!Array.isArray(p) || p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 1)) return false;
    const [x, y, w, h] = p; if(x + w - 1 > PHARM_COLS || w < 2 || h < 6 || h > 200) return false;
    if(seen.some(q => x < q[0] + q[2] && q[0] < x + w && y < q[1] + q[3] && q[1] < y + h)) return false;     // overlapping panels
    seen.push(p);
  }
  return true;
}
const pharmLayout = () => pharmLayoutOk(PHARM_LAYOUT) ? PHARM_LAYOUT : null;
const sw = (attrs, on, title) => `<label class="switch" title="${esc(title || '')}"><input type="checkbox" ${attrs}${on ? ' checked' : ''}><span></span></label>`;
const SF = [['name','Pharmacy name'],['address','Street address'],['suite','Suite / unit (if any)'],['city','City'],['state','State'],['zip','ZIP code'],['phone','Phone'],['fax','Fax'],['email','Email'],['timezone','Time zone']];
const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
const stateSelect = (attrs, cur) => `<select ${attrs}><option value=""></option>${US_STATES.map(v => `<option${v === (cur || '') ? ' selected' : ''}>${v}</option>`).join('')}</select>`;
const tzSelect = (attrs, cur) => `<select ${attrs}>${Object.entries(TZ_NAMES).map(([v, l]) => `<option value="${v}"${v === (cur || 'America/Chicago') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
// license, identifiers, services and hours kept on each pharmacy (edit-only: the add-pharmacy form stays short)
const SF2 = [['license','State pharmacy license #'],['licenseExpires','License expires','date'],['npi','NPI (10 digits)'],['ncpdp','NCPDP ID (7 digits)'],['dea','DEA number'],['deaExpires','DEA expires','date']];
const SVC_LABELS = {retail:'Retail dispensing', controlled:'Controlled substances (DEA)', nonsterile:'Nonsterile compounding', sterile:'Sterile compounding', hazardous:'Hazardous drug compounding',
  immunizations:'Immunizations', delivery:'Delivery', ltc:'Long-term care', specialty:'Specialty', infusion:'Home infusion'};
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const hoursOf = s => Array.isArray(s.hours) && s.hours.length === 7 ? s.hours : [null,{o:'09:00',c:'18:00'},{o:'09:00',c:'18:00'},{o:'09:00',c:'18:00'},{o:'09:00',c:'18:00'},{o:'09:00',c:'18:00'},null];
const field = (s, k, l, t) => `<label><span>${l}</span>${k === 'timezone' ? tzSelect(`data-sf="timezone"`, s.timezone) : k === 'state' ? stateSelect(`data-sf="state"`, s.state) : `<input type="${t || 'text'}" data-sf="${k}" value="${esc(s[k] || '')}"${k === 'address' ? ' class="wide"' : ''}>`}</label>`;
const roVal = v => `<div class="ro${v ? '' : ' empty'}">${v ? esc(v) : 'Not set'}</div>`;
const roField = (s, k, l, t) => `<label><span>${l}</span>${roVal(s[k])}</label>`;
// c.host: the card is being used by IronLedger (the host login). Everyone else sees license, identifiers, services and the Calendar switch but cannot change them.
const hostField = (s, k, l, t, c) => c.host ? field(s, k, l, t) : roField(s, k, l, t);
const LOCKED = 'Set by IronLedger. Contact your IronLedger representative to change this.';
const deaStat = s => s.deaVerified ? 'Checked on the DEA site ' + esc((s.deaVerified.at || '').slice(0, 10)) + (s.deaVerified.by ? ' by ' + esc(s.deaVerified.by) : '') : 'Not checked yet.';
const PHARM_BODY = {
  id: (s, c) => c.isNew
      ? `<div class="pidbox"><label class="pfields"><span>Pharmacy ID</span><input type="text" class="newid" data-newid="1" maxlength="20" autocapitalize="characters" spellcheck="false"></label>
        <div class="hint">What people type when they sign in (2–20 letters, numbers or dashes, like NTX1). It can’t be changed later. Add the logo after the pharmacy is created.</div></div>`
      : `<div class="plogo">${c.logo ? `<img src="${esc(c.logo)}" alt="">` : '<span class="hint">No logo</span>'}
        <label class="btn2 small">Upload logo<input type="file" accept="image/png,image/jpeg,image/webp" data-logo="${esc(s.id)}" hidden></label>
        ${c.logo ? `<button class="btn2 small" data-nologo="${esc(s.id)}">Remove</button>` : ''}</div>
      <div class="pidbox"><div class="pid">Pharmacy ID: <b>${esc(s.id)}</b></div><div class="hint">(what people type when they sign in)</div>
        <div class="pid">Primary account holder: <b>${esc(c.holder || 'Account Manager')}</b></div><div class="hint">(the Account Manager)</div></div>`,
  contact: s => `<div class="pfields">${SF.map(([k, l]) => field(s, k, l)).join('')}</div>`,
  reg: (s, c) => c.host
    ? `<div class="pfields">${SF2.map(([k, l, t]) => field(s, k, l, t)).join('')}
        <div class="pid npirow"><button class="btn2 small" data-npilook="1">Look up NPI in the federal registry</button> <span class="hint">checks the number above against the public NPI Registry; nothing changes until you save</span><div data-npires></div></div>
        <div class="pid npirow"><a class="btn2 small" href="https://apps.deadiversion.usdoj.gov/webforms2/spring/validationLogin" target="_blank" rel="noopener noreferrer">Open the DEA registration check</a>${c.isNew ? '' : ' <button class="btn2 small" data-deaok="1">I checked this DEA number there</button>'}
          <span class="hint" data-deastat>${c.isNew ? 'Record the DEA check after the pharmacy is created.' : deaStat(s)} The DEA does not offer a public lookup: its tool asks for details from the registration certificate, so this is checked by a person and recorded here.</span></div></div>`
    : `<div class="pfields">${SF2.map(([k, l, t]) => roField(s, k, l, t)).join('')}
        <div class="lockhint">${LOCKED}</div><div class="pid npirow hint">DEA check: ${deaStat(s)}</div></div>`,
  svc: (s, c) => c.host
    ? `<div class="pfields"><div class="svcs">${Object.entries(SVC_LABELS).map(([k, l]) => `<label class="chk">${sw(`data-svc="${k}"`, (s.services || []).includes(k))} ${l}</label>`).join('')}</div>
          ${field(s, 'servicesOther', 'Other services').replace('<label>', '<label class="oth">')}</div>`
    : `<div class="pfields"><div class="chips">${(s.services || []).map(k => `<span class="chip">${esc(SVC_LABELS[k] || k)}</span>`).join('') || '<span class="hint">None set yet.</span>'}</div>
          ${s.servicesOther ? `<div class="pid">Other: ${esc(s.servicesOther)}</div>` : ''}<div class="lockhint">${LOCKED}</div></div>`,
  hrs: s => `<div class="pfields"><div class="hrs">${s.hours ? '' : '<div class="hint">Not set yet; these are suggestions until you save.</div>'}
          ${hoursOf(s).map((h, i) => `<div class="hrow"><span>${DAYS[i]}</span><input type="time" data-ho="${i}" value="${h ? h.o : '09:00'}"><input type="time" data-hc="${i}" value="${h ? h.c : '18:00'}"><label class="chk">${sw(`data-hx="${i}"`, !h)} Closed</label></div>`).join('')}</div></div>`,
  act: (s, c) => `<div class="pfields"><div class="calsw">${c.host
        ? `<label class="chk">${sw(`data-sfcal="1"`, s.calendar, 'Calendar tab for this pharmacy')} Calendar switched on for this pharmacy</label> <span class="hint">(people also need the Calendar privilege)</span>`
        : `Calendar: <b>${s.calendar ? 'On' : 'Off'}</b> <span class="hint">${LOCKED}</span>`}</div>
        <div style="margin-top:10px;">${c.isNew ? '<button class="btn small" data-createstore="1">Create pharmacy</button>' : `<button class="btn small" data-savestore="${esc(s.id)}">Save details</button>`}</div></div>`
};
// the whole card: panels in reading order (row, then column) so narrow screens stack them sensibly
function pharmCardHtml(s, c, L){
  L = L || pharmLayout() || { panels: Object.fromEntries(PHARM_PANELS.map(([id], i) => [id, [1, i + 1, PHARM_COLS, 6]])) };
  const order = PHARM_PANELS.slice().sort((a, b) => (L.panels[a[0]][1] - L.panels[b[0]][1]) || (L.panels[a[0]][0] - L.panels[b[0]][0]));
  const rows = Math.max(...Object.values(L.panels).map(p => p[1] + p[3] - 1));
  return `<div class="pgrid" style="--rows:${rows}">${order.map(([id, title]) => { const [x, y, w, h] = L.panels[id];
    return `<section class="pnl" data-pnl="${id}" style="--x:${x};--y:${y};--w:${w};--h:${h}"><h4 class="pt">${title}</h4><div class="pb">${PHARM_BODY[id](s, c)}</div></section>`; }).join('')}</div>`;
}

// ---------------- behaviour shared by the Account Manager page and the host page ----------------
// o = { base: '/owner' | '/host', stores: () => [store, …], say: text => …, after: async () => … }
const normNm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function pharmCardEvents(root, o){
  root.addEventListener('change', e => { if(e.target.closest('[data-ho],[data-hc],[data-hx]')){ const c = e.target.closest('.pcard'); if(c) c.dataset.hrTouched = '1'; } });
  root.addEventListener('click', async e => {
    const lk = e.target.closest('[data-npilook]'), us = e.target.closest('[data-npiuse]'), dk = e.target.closest('[data-deaok]');
    const sv = e.target.closest('[data-savestore],[data-createstore]');
    const card = e.target.closest('.pcard'); if(!card) return;
    const val = k => { const i = card.querySelector(`[data-sf=${k}]`); return i ? i.value.trim() : ''; };
    if(dk){
      const dea = val('dea'); if(!dea){ alert('Type the DEA number first.'); return; }
      if(!confirm('Confirm you looked up ' + dea.toUpperCase() + ' on the DEA registration check and the name, address and expiration match this pharmacy?')) return;
      try{ await api('POST', o.base + '/stores/' + encodeURIComponent(card.dataset.store), {dea, deaVerified:true}); o.say('DEA check recorded.'); await o.after(); }catch(err){ if(!err.auth) alert(err.message); }
      return;
    }
    if(lk){
      const out = card.querySelector('[data-npires]'), npi = val('npi');
      if(!/^\d{10}$/.test(npi)){ out.innerHTML = '<div class="npibox bad">Type the 10-digit NPI first.</div>'; return; }
      out.innerHTML = '<div class="npibox hint">Looking up…</div>'; lk.disabled = true;
      try{
        const r = await api('GET', o.base + '/npi/' + encodeURIComponent(npi)); card._npi = r;
        if(!r.found){ out.innerHTML = '<div class="npibox bad">No provider with that NPI is in the NPI Registry. Re-check the number.</div>'; return; }
        const a = r.address, flags = [];
        if(r.type !== 'organization') flags.push('This is an individual NPI. A pharmacy normally has an organization NPI.');
        if(!r.active) flags.push('The registry shows this NPI as not active.');
        if(r.type === 'organization' && !r.pharmacyTaxonomy) flags.push('No pharmacy taxonomy is listed for it.');
        const cur = val('name'); if(cur && r.name && normNm(cur) !== normNm(r.name)) flags.push('The registry name differs from the pharmacy name above.');
        const lic = r.taxonomies.filter(t => t.license).map(t => `${esc(t.license)}${t.state ? ' (' + esc(t.state) + ')' : ''}`).join(', ');
        out.innerHTML = `<div class="npibox"><b>${esc(r.name || '(no name)')}</b> <span class="hint">${r.type === 'organization' ? 'Organization' : 'Individual'} · ${r.active ? 'Active' : 'Not active'}${r.lastUpdated ? ' · registry updated ' + esc(r.lastUpdated) : ''}</span>
          <div>${esc([a.address, a.suite].filter(Boolean).join(', '))}${a.address ? ', ' : ''}${esc([a.city, a.state].filter(Boolean).join(', '))} ${esc(a.zip)}${a.phone ? ' · ' + esc(a.phone) : ''}${a.fax ? ' · fax ' + esc(a.fax) : ''}</div>
          ${r.taxonomies.length ? `<div class="hint">${r.taxonomies.map(t => esc(t.desc || t.code)).join('; ')}${lic ? ' · license on file with registry: ' + lic : ''}</div>` : ''}
          ${flags.map(f => `<div class="npiflag">⚠ ${esc(f)}</div>`).join('')}
          <button class="btn2 small" data-npiuse="1">Use these details</button> <span class="hint">fills name, address, phone and fax above (the license number is not filled; type it from the state license)</span></div>`;
      }catch(err){ if(!err.auth) out.innerHTML = `<div class="npibox bad">${esc(err.message)}</div>`; }
      finally{ lk.disabled = false; }
      return;
    }
    if(us){
      const r = card._npi; if(!r || !r.found) return;
      const set = (k, v) => { const i = card.querySelector(`[data-sf=${k}]`); if(i && v) i.value = v; };
      set('name', r.name); set('address', r.address.address); set('suite', r.address.suite); set('city', r.address.city); set('state', r.address.state); set('zip', r.address.zip); set('phone', r.address.phone); set('fax', r.address.fax);
      o.say('Filled in from the registry. Press ' + (card.dataset.isNew ? 'Create pharmacy' : 'Save details') + ' to keep it.'); return;
    }
    if(sv){
      const isNew = !!sv.dataset.createstore, id = isNew ? (card.querySelector('[data-newid]').value || '').trim().toUpperCase() : sv.dataset.savestore;
      const body = {}; card.querySelectorAll('[data-sf]').forEach(i => body[i.dataset.sf] = i.value.trim());
      const cal = card.querySelector('[data-sfcal]'); if(cal) body.calendar = cal.checked;
      if(card.querySelector('[data-svc]')) body.services = [...card.querySelectorAll('[data-svc]')].filter(i => i.checked).map(i => i.dataset.svc);
      const cur = o.stores().find(x => x.id === id);
      if(card.dataset.hrTouched || (cur && cur.hours)) body.hours = DAYS.map((_, i) => card.querySelector(`[data-hx="${i}"]`).checked ? null : {o: card.querySelector(`[data-ho="${i}"]`).value, c: card.querySelector(`[data-hc="${i}"]`).value});
      if(isNew){ if(!id || !body.name){ alert('Pharmacy ID and name are needed.'); return; } body.id = id; }
      busy(sv, true);
      try{ await api('POST', o.base + '/stores' + (isNew ? '' : '/' + encodeURIComponent(id)), body); o.say(isNew ? 'Pharmacy created: ' + id : 'Pharmacy details saved.'); await o.after(isNew); }
      catch(err){ if(!err.auth) alert(err.message); } finally{ busy(sv, false); }
    }
  });
}

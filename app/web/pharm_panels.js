/* ---------------- pharmacy setup page (host) and pharmacy account page (Account Owner): panels and their layout ----------------
   Built on the layout engine (layout_engine.js). PHARM_LAYOUT is set once by Neo with the layout editor and is the same for everyone. */
const PHARM_COLS = LAYOUT_COLS, PHARM_ROW = LAYOUT_ROW;
const PHARM_PANELS = [['id', 'Pharmacy'], ['contact', 'Name And Address'], ['reg', 'License And Registration'], ['svc', 'Services Provided'], ['hrs', 'Hours Of Operation'], ['own', 'Account Owner And PIC'], ['mgr', 'Who Can Manage Users'], ['act', 'Modules And Save']];
const PHARM_LAYOUT = {"v":2,"cols":12,"panels":{"id":[1,1,4,40],"own":[1,41,4,49],"contact":[5,1,4,37],"reg":[5,38,4,52],"hrs":[9,1,4,71],"mgr":[9,72,4,18],"svc":[1,90,8,26],"act":[9,90,4,26]}};
const PHARM_PAGE = { id: 'pharm', title: 'Host Pharmacy Setup Page', panels: PHARM_PANELS, layout: PHARM_LAYOUT,
  render: (sample, panels) => pharmCardHtml(sample, { logo: '', holder: 'Pat Owner (owner)', host: true, clients: [{ id: 'IL-000001', legalName: 'NorTex Holdings LLC', entityType: 'llc', ein: '12-3456789' }] }, { panels }) };
// The Account Owner's version of the same page has its own layout (Neo arranges it separately in the layout editor: page key pharm_owner).
const PHARM_OWNER_LAYOUT = {"v":2,"cols":12,"panels":{"id":[1,1,4,41],"own":[1,42,4,12],"act":[1,54,4,20],"contact":[5,1,4,42],"reg":[5,43,4,31],"hrs":[9,1,4,73],"svc":[1,74,12,9]}};
const PHARM_OWNER_PANELS = PHARM_PANELS.filter(p => p[0] !== 'mgr');      // the switches are IronLedger's alone
const PHARM_OWNER_PAGE = { id: 'pharm_owner', title: 'Pharmacy Page (Account Owner)', panels: PHARM_OWNER_PANELS, layout: PHARM_OWNER_LAYOUT,
  render: (sample, panels) => pharmCardHtml(Object.assign({}, sample, { ein: '', einMasked: '••-•••4321' }), { logo: '', holder: 'Pat Owner (owner)' }, { panels }) };
const pharmLayoutOk = L => layoutOk(PHARM_PAGE, L);
const pharmLayout = () => pharmLayoutOk(PHARM_LAYOUT) ? PHARM_LAYOUT : null;
const sw = (attrs, on, title) => `<label class="switch" title="${esc(title || '')}"><input type="checkbox" ${attrs}${on ? ' checked' : ''}><span></span></label>`;
const SF = [['name','Pharmacy name'],['address','Street address'],['suite','Suite / unit (if any)'],['city','City'],['state','State'],['zip','ZIP code'],['phone','Phone'],['fax','Fax'],['email','Email'],['timezone','Time zone']];
const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
const stateSelect = (attrs, cur) => `<select ${attrs}><option value=""></option>${US_STATES.map(v => `<option${v === (cur || '') ? ' selected' : ''}>${v}</option>`).join('')}</select>`;
const tzSelect = (attrs, cur) => `<select ${attrs}>${Object.entries(TZ_NAMES).map(([v, l]) => `<option value="${v}"${v === (cur || 'America/Chicago') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
// license, identifiers, services and hours kept on each pharmacy (edit-only: the add-pharmacy form stays short)
const SF2 = [['ncpdp','NCPDP ID (7 digits)'],['deaExpires','DEA expires','date']];
const SVC_LABELS = {retail:'Retail dispensing', controlled:'Controlled substances (DEA)', nonsterile:'Nonsterile compounding', sterile:'Sterile compounding', hazardous:'Hazardous drug compounding',
  immunizations:'Immunizations', delivery:'Delivery', ltc:'Long-term care', specialty:'Specialty', infusion:'Home infusion'};
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
// Additional closed days beyond the weekly hours: dated days the pharmacy adds (name, date, optional every year). Yearly-observance toggles removed; observances are entered by hand (Neo, 2026-11-17).
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// Federal holidays the pharmacy is closed on: a dropdown on the Hours panel. Stored on the pharmacy (holClosed); until one is saved these defaults show.
const FED_HOL = [['newyear', "New Year's Day"], ['mlk', 'Martin Luther King Jr. Day'], ['presidents', "Presidents' Day"], ['memorial', 'Memorial Day'], ['juneteenth', 'Juneteenth'], ['july4', 'Independence Day'], ['labor', 'Labor Day'], ['columbus', 'Columbus Day'], ['veterans', 'Veterans Day'], ['thanks', 'Thanksgiving Day'], ['xmas', 'Christmas Day']];
const FED_DEFAULT = ['newyear', 'memorial', 'july4', 'labor', 'thanks', 'xmas'];
const holOf = s => Array.isArray(s && s.holClosed) ? s.holClosed : FED_DEFAULT;
const holLabel = n => n ? n + ' federal holiday' + (n === 1 ? '' : 's') + ' closed' : 'No federal holidays closed';
const holOfCard = card => [...card.querySelectorAll('[data-hol]')].filter(i => i.checked).map(i => i.dataset.hol);
const closuresOf = s => s && s.closures && Array.isArray(s.closures.days) ? { days: s.closures.days } : { days: [] };
const closeDate = x => MONTHS[+x.d.slice(5, 7) - 1] + ' ' + (+x.d.slice(8, 10)) + (x.y ? ', every year' : ', ' + x.d.slice(0, 4));
const closeRows = days => days.map((x, i) => `<div class="clrow"><span class="cld">${esc(closeDate(x))}</span><span class="cln">${esc(x.n)}</span><button type="button" class="edit" data-cldel="${i}" title="Remove this day">✕</button></div>`).join('');
const closedState = card => { const el = card.querySelector('[data-cl]'); try{ return JSON.parse(el.dataset.cl); }catch(_){ return []; } };
const closuresOfCard = card => ({ days: closedState(card) });
const hoursOf = s => Array.isArray(s.hours) && s.hours.length === 7 ? s.hours : [null,{o:'09:00',c:'18:00'},{o:'09:00',c:'18:00'},{o:'09:00',c:'18:00'},{o:'09:00',c:'18:00'},{o:'09:00',c:'18:00'},null];
const field = (s, k, l, t, lock) => `<label><span>${l}</span>${k === 'timezone' ? tzSelect(`data-sf="timezone"`, s.timezone) : k === 'state' ? stateSelect(`data-sf="state"${lock ? ' disabled data-ident="1"' : ''}`, s.state) : `<input type="${t || 'text'}" data-sf="${k}" value="${esc(s[k] || '')}"${k === 'address' ? ' class="wide"' : ''}${lock ? ' readonly data-ident="1"' : ''}>`}</label>`;
const roVal = v => `<div class="ro${v ? '' : ' empty'}">${v ? esc(v) : 'Not set'}</div>`;
const roField = (s, k, l, t) => `<label><span>${l}</span>${roVal(s[k])}</label>`;
// c.host: the card is being used by IronLedger (the host login). Everyone else sees license, identifiers, services and the Calendar switch but cannot change them.
// Identity (name, address, license, NPI, DEA, NCPDP) is set by IronLedger and locked once on file; the Account Owner keeps phone, fax, time zone, hours and the two expiration dates.
const IDENT = ['name', 'address', 'suite', 'city', 'state', 'zip', 'license', 'npi', 'dea', 'ncpdp', 'clientId', 'entityLegalName', 'entityType', 'ein'], AM_EDIT = ['phone', 'fax', 'email', 'timezone', 'licenseExpires', 'deaExpires'];
// NPI: exactly 10 digits and a valid check digit; NCPDP: exactly 7 digits. The same rules run on the server; here they show under the box as you type.
function npiProblem(v){
  if(!v) return '';
  if(!/^\d{10}$/.test(v)) return 'NPI must be exactly 10 digits.';
  const d = ('80840' + v).split('').map(Number); let sum = 0, alt = false;
  for(let i = d.length - 1; i >= 0; i--, alt = !alt){ let x = d[i]; if(alt){ x *= 2; if(x > 9) x -= 9; } sum += x; }
  return sum % 10 === 0 ? '' : 'That NPI’s check digit doesn’t match. Re-check the number.';
}
const ncpdpProblem = v => v && !/^\d{7}$/.test(v) ? 'NCPDP ID must be exactly 7 digits.' : '';
const digitField = (s, k, l, lim, lock) => `<div class="fbtn"><label><span>${l}</span><input type="text" inputmode="numeric" autocomplete="off" data-sf="${k}" data-dig="${lim}" maxlength="${lim}" value="${esc(s[k] || '')}"${lock ? ' readonly data-ident="1"' : ''}></label></div><div class="fe" data-err="${k}" hidden></div>`;
// state licenses: one row per state (state, number, expiration, resident or non-resident). The resident (else first) license is also the pharmacy's main license number.
const licRow = (l, lock, canEditExp) => `<div class="licrow" data-licrow>
    <label><span>State</span>${stateSelect(`data-lic="state"${lock ? ' disabled data-ident="1"' : ''}`, l.state)}</label>
    <label><span>License #</span><input type="text" data-lic="number" maxlength="20" value="${esc(l.number || '')}"${lock ? ' readonly data-ident="1"' : ''}></label>
    <label><span>Expires</span><input type="date" data-lic="expires" value="${esc(l.expires || '')}"${canEditExp ? '' : ' disabled'}></label>
    <label><span>Type</span><select data-lic="type"${lock ? ' disabled data-ident="1"' : ''}><option value="resident"${l.type !== 'nonresident' ? ' selected' : ''}>Resident</option><option value="nonresident"${l.type === 'nonresident' ? ' selected' : ''}>Non-resident</option></select></label>
    <button type="button" class="edit" data-licdel="1" title="Remove this license">✕</button></div>`;
const licList = (s, c) => { const lock = !c.isNew && !c.rep && !c.repView;
  return `<div class="licbox"><b class="clh">State pharmacy licenses</b><div data-liclist>${(s.licenses || []).map(l => licRow(l, lock, true)).join('') || '<div class="hint" data-licnone>None yet. Add the license for each state the pharmacy is licensed in.</div>'}</div>
    <button type="button" class="btn2 small" data-licadd="1">Add a state license</button></div>`; };
const licRo = (s, c) => `<div class="licbox"><b class="clh">State pharmacy licenses</b>${(s.licenses || []).map(l => `<div class="licrow ro"><label><span>State</span>${roVal(l.state)}</label><label><span>License #</span>${roVal(l.number)}</label><label><span>Expires</span><input type="date" data-lic-exp="${esc(l.state)}" value="${esc(l.expires || '')}"></label><label><span>Type</span>${roVal(l.type === 'nonresident' ? 'Non-resident' : 'Resident')}</label></div>`).join('') || '<div class="hint">None set yet.</div>'}</div>`;
const licsOfCard = card => [...card.querySelectorAll('[data-licrow]')].map(r => { const g = k => (r.querySelector(`[data-lic=${k}]`) || {}).value || ''; return { state: g('state'), number: g('number').trim().toUpperCase(), expires: g('expires'), type: g('type') || 'resident' }; }).filter(l => l.state || l.number);
// who owns and who is the pharmacist in charge, from the people list (the host page and the Account Owner page both pass it in as c.people)
function ownInfo(s, people){
  const P = people || [], owner = P.find(u => u.ownerStores && u.ownerStores[s.id] === true) || null;
  const pic = s.ownerIsPic === true ? owner : s.ownerIsPic === false ? (P.find(u => u.login === s.picLogin) || null) : null;
  return { owner, pic, admins: P.filter(u => u.adminStores && u.adminStores[s.id] === true) };
}
const ownLabel = u => u ? (u.name || u.login) + ' (' + u.login + ')' : '';
const cardField = (s, k, l, t, c) => IDENT.includes(k) ? (c.host ? field(s, k, l, t, !c.isNew && !!s[k] && !c.rep && !c.repView) : roField(s, k, l, t)) : (c.host || AM_EDIT.includes(k) ? field(s, k, l, t) : roField(s, k, l, t));
const LOCKED = 'Set by IronLedger. Contact your IronLedger representative to change this.';
const LOCKED_ID = 'Name, address, license and identifiers must match your license and billing, so IronLedger sets them. Phone, fax, email, time zone, hours and expiration dates are yours to keep current.';
// Licensed entity (the entity named on the license, DEA and NPI; the EIN is required) and the client (the bill-to account, IL- number).
const ENT_TYPES = [['corporation', 'Corporation'], ['llc', 'LLC'], ['sole_prop', 'Sole proprietor'], ['partnership', 'Partnership'], ['other', 'Other']];
const entTypeLabel = v => (ENT_TYPES.find(x => x[0] === v) || [0, ''])[1];
const entTypeSelect = (attrs, cur) => `<select ${attrs}><option value=""></option>${ENT_TYPES.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
const clientName = (c, id) => { const k = (c.clients || []).find(x => x.id === id); return k ? k.legalName + ' (' + id + ')' : id || ''; };
const clientSelect = (c, cur, attrs) => `<select data-sf="clientId" ${attrs || ''}><option value=""></option>${(c.clients || []).map(k => `<option value="${esc(k.id)}"${k.id === cur ? ' selected' : ''}>${esc(k.legalName)} (${esc(k.id)})</option>`).join('')}</select>`;
const entityHost = (s, c) => { const lk = !c.isNew && !!s.ein && !c.rep && !c.repView, lkn = !c.isNew && !!s.entityLegalName && !c.rep && !c.repView, lkt = !c.isNew && !!s.entityType && !c.rep && !c.repView;
  return `<div class="entity"><b class="clh">Licensed entity</b> <span class="hint">the entity named on the license, DEA and NPI</span>
    <div class="pfields"><label><span>Legal name (required)</span><input type="text" data-sf="entityLegalName" maxlength="120" value="${esc(s.entityLegalName || '')}"${lkn ? ' readonly data-ident="1"' : ''}></label>
    <label><span>Entity type (required)</span>${entTypeSelect(`data-sf="entityType"${lkt ? ' disabled data-ident="1"' : ''}`, s.entityType)}</label>
    <label><span>EIN (required)</span><input type="text" data-sf="ein" maxlength="11" placeholder="12-3456789" value="${esc(s.ein || '')}"${lk ? ' readonly data-ident="1"' : ''}></label></div>
    ${(c.clients || []).length && !c.repView && (!s.ein || c.isNew) ? '<button type="button" class="btn2 small" data-entsame="1" title="Fills the legal name, type and EIN from the selected client">Same as client</button>' : ''}
    ${!c.isNew && !s.ein ? '<div class="lockhint warn">EIN missing: required for every pharmacy.</div>' : ''}</div>`; };
const entityRo = s => `<div class="entity"><b class="clh">Licensed entity</b><div class="pfields">${roField(s, 'entityLegalName', 'Legal name')}<label><span>Entity type</span>${roVal(entTypeLabel(s.entityType))}</label><label><span>EIN</span>${roVal(s.einMasked)}</label></div></div>`;
const PHARM_BODY = {
  id: (s, c) => c.isNew
      ? `<div class="pidbox"><label class="pfields"><span>Pharmacy ID</span><input type="text" class="newid" data-newid="1" maxlength="20" autocapitalize="characters" spellcheck="false"></label>
        <div class="hint">What people type when they sign in (2–20 letters, numbers or dashes, like NTX1). It can’t be changed later. Add the logo after the pharmacy is created.</div>
        <label class="pfields"><span>Client (bill-to account, required)</span>${clientSelect(c, s.clientId || '', c.clientFixed ? 'disabled' : '')}</label></div>${entityHost(s, c)}`
      : `<div class="plogo">${c.logo ? `<img src="${esc(c.logo)}" alt="">` : '<span class="hint">No logo</span>'}
        <label class="btn2 small">Upload logo<input type="file" accept="image/png,image/jpeg,image/webp" data-logo="${esc(s.id)}" hidden></label>
        ${c.logo ? `<button class="btn2 small" data-nologo="${esc(s.id)}">Remove</button>` : ''}</div>
      <div class="pidbox"><div class="pid">Pharmacy ID: <b>${esc(s.id)}</b></div><div class="hint">(what people type when they sign in)</div>
        <div class="pid">Primary account holder: <b>${esc(c.holder || 'Account Owner')}</b></div><div class="hint">(the Account Owner)</div>
        ${c.host
          ? `<label class="pfields"><span>Client (bill-to account)</span>${clientSelect(c, s.clientId, !!s.clientId && !c.rep && !c.repView ? 'disabled data-ident="1"' : '')}</label>${s.clientId ? '' : '<div class="lockhint warn">No client yet: pick one.</div>'}`
          : `<div class="pid">Account number: <b>${s.clientId ? esc(s.clientId) : 'Not assigned yet'}</b></div><div class="hint">(generated once by IronLedger; never changes)</div>`}</div>
      ${c.host ? entityHost(s, c) : entityRo(s)}`,
  contact: (s, c) => `<div class="pfields">${SF.map(([k, l]) => cardField(s, k, l, undefined, c)).join('')}${c.host ? '' : `<div class="lockhint">${LOCKED_ID}</div>`}</div>`,
  reg: (s, c) => {
    if(c.host){
      const lock = (k) => !c.isNew && !!s[k] && !c.rep && !c.repView;
      return `<div class="pfields">${licList(s, c)}
        <div class="fbtn"><label><span>NPI (10 digits)</span><input type="text" inputmode="numeric" autocomplete="off" data-sf="npi" data-dig="10" maxlength="10" value="${esc(s.npi || '')}"${lock('npi') ? ' readonly data-ident="1"' : ''}></label>${c.rep ? '' : '<button class="btn2 small" type="button" data-npilook="1" title="Checks the NPI against the public registry. Nothing changes until you save.">Look up</button>'}</div><div class="fe" data-err="npi" hidden></div>
        <div class="npirow" data-npires></div>
        ${digitField(s, 'ncpdp', 'NCPDP ID (7 digits)', 7, lock('ncpdp'))}
        <label><span>DEA number</span><input type="text" data-sf="dea" maxlength="9" autocomplete="off" value="${esc(s.dea || '')}"${lock('dea') ? ' readonly data-ident="1"' : ''}></label>
        ${field(s, 'deaExpires', 'DEA expires', 'date')}
        ${c.rep ? '<div class="lockhint">A rep drafts changes and a supervisor reviews them. The NPI registry lookup is done by a supervisor.</div>' : ''}</div>`;
    }
    return `<div class="pfields">${licRo(s, c)}${roField(s, 'npi', 'NPI')}${roField(s, 'ncpdp', 'NCPDP ID')}${roField(s, 'dea', 'DEA number')}${cardField(s, 'deaExpires', 'DEA expires', 'date', c)}
        <div class="lockhint">License numbers, NPI, DEA and NCPDP are set by IronLedger. Expiration dates are yours to keep current.</div></div>`;
  },
  svc: (s, c) => c.host && !c.rep
    ? `<div class="pfields"><div class="svcs">${Object.entries(SVC_LABELS).map(([k, l]) => `<label class="chk">${sw(`data-svc="${k}"`, (s.services || []).includes(k))} ${l}</label>`).join('')}</div>
          ${field(s, 'servicesOther', 'Other services').replace('<label>', '<label class="oth">')}</div>`
    : `<div class="pfields"><div class="chips">${(s.services || []).map(k => `<span class="chip">${esc(SVC_LABELS[k] || k)}</span>`).join('') || '<span class="hint">None set yet.</span>'}</div>
          ${s.servicesOther ? `<div class="pid">Other: ${esc(s.servicesOther)}</div>` : ''}<div class="lockhint">${LOCKED}</div></div>`,
  hrs: s => `<div class="pfields"><div class="hrs">${s.hours ? '' : '<div class="hint">Not set yet; these are suggestions until you save.</div>'}
          ${hoursOf(s).map((h, i) => `<div class="hrow"><span title="${DAYS[i]}">${DAYS[i].slice(0, 3)}</span><input type="time" data-ho="${i}" value="${h ? h.o : '09:00'}"><input type="time" data-hc="${i}" value="${h ? h.c : '18:00'}"><label class="chk">${sw(`data-hx="${i}"`, !h)} Closed</label></div>`).join('')}</div>
          <div class="hdrop"><b class="clh">Federal holidays closed</b><div class="hdlist">${FED_HOL.map(([k, l]) => `<label class="chk">${sw(`data-hol="${k}"`, holOf(s).includes(k))} ${l}</label>`).join('')}</div></div>
          <div class="closed" data-cl='${esc(JSON.stringify(closuresOf(s).days))}'><b class="clh">Additional closed days</b>
            <div class="cllist" data-cllist>${closeRows(closuresOf(s).days)}</div>
            <div class="cladd"><input type="date" data-cld title="Date"><input type="text" data-cln maxlength="60" placeholder="Name, e.g. Mardi Gras"><label class="chk">${sw('data-cly')} Every year</label> <button type="button" class="btn2 small" data-cladd="1">Add</button></div>
          </div></div>`,
  own: (s, c) => {
    if(c.isNew) return '<div class="pfields"><div class="hint" style="grid-column:1/-1">Name the Account Owner after the pharmacy is created.</div></div>';
    const I = ownInfo(s, c.people), asked = s.ownerIsPic === true || s.ownerIsPic === false;
    const picTxt = s.ownerIsPic === true ? 'The Account Owner' : s.ownerIsPic === false ? (I.pic ? ownLabel(I.pic) : s.picLogin || 'Not set') : 'Not recorded yet';
    const head = `<div class="pid">Account Owner: <b>${I.owner ? esc(ownLabel(I.owner)) : 'Not set'}</b></div>
      <div class="pid">Pharmacist in charge: <b>${esc(picTxt)}</b></div>
      ${I.admins.length ? `<div class="pid">Super user: <b>${esc(I.admins.map(ownLabel).join(', '))}</b></div>` : ''}`;
    if(!c.host || c.rep) return `<div class="pfields" style="display:block">${head}<div class="lockhint">${LOCKED}</div></div>`;
    const pool = (c.people || []).filter(u => !u.employeeOnly && !u.disabled), clientOwner = (c.people || []).find(u => u.ownerClients && u.ownerClients[s.clientId] === true);
    const pharmacists = (c.people || []).filter(u => !u.employeeOnly && (u.acctType === 'pharmacist' || u.acctType === 'pic') && u.stores && u.stores[s.id] === true);
    return `<div class="pfields" style="display:block">${head}
      <div class="ownbox"><b class="clh">Change the Account Owner</b>
        <label><span>Pick a login</span><select data-ownpick><option value="">—</option>${I.owner ? '<option value="@none">No Account Owner (remove)</option>' : ''}${clientOwner ? `<option value="@client">Same as the client’s Account Owner: ${esc(ownLabel(clientOwner))}</option>` : ''}${pool.map(u => `<option value="${esc(u.login)}">${esc(ownLabel(u))}</option>`).join('')}<option value="@new">New login…</option></select></label>
        <div data-ownnew hidden class="pfields"><label><span>Full name</span><input type="text" data-on="name" maxlength="120"></label><label><span>Login ID</span><input type="text" data-on="login" maxlength="32" autocapitalize="none" spellcheck="false"></label>
          <label><span>Mobile number</span><input type="tel" data-on="phone" maxlength="20"></label><label><span>RPh license # (if a pharmacist)</span><input type="text" data-on="license" maxlength="20"></label>
          <label class="chk" style="grid-column:1/-1"><input type="checkbox" data-on="consent"> They signed the SMS consent form for this mobile number.</label></div>
        ${I.owner ? '<label><span>Reason for the change (required)</span><input type="text" data-ownreason maxlength="300"></label>' : ''}
        <button type="button" class="btn2 small" data-ownsave="${esc(s.id)}">Save Account Owner</button></div>
      <div class="ownbox"><b class="clh">Is the Account Owner the pharmacist in charge?</b>
        <label class="chk"><input type="radio" name="pic-${esc(s.id)}" data-picyes value="yes"${s.ownerIsPic === true ? ' checked' : ''}> Yes. They get the pharmacist functions: Rx Intake, validations, EM logs.</label>
        <label class="chk"><input type="radio" name="pic-${esc(s.id)}" data-picyes value="no"${s.ownerIsPic === false ? ' checked' : ''}> No. A licensed pharmacist is the PIC.</label>
        <label data-picwho${s.ownerIsPic === false ? '' : ' hidden'}><span>Pharmacist in charge</span><select data-picpick><option value="">—</option>${pharmacists.map(u => `<option value="${esc(u.login)}"${u.login === s.picLogin ? ' selected' : ''}>${esc(ownLabel(u))}${u.license ? '' : ' (no RPh license #)'}</option>`).join('')}</select></label>
        ${asked ? '<label><span>Reason for the change (required)</span><input type="text" data-picreason maxlength="300"></label>' : ''}
        <div class="hint">The PIC must be a licensed pharmacist with an RPh license number on their login. Only IronLedger records or changes this; each change is kept in the history.</div>
        <button type="button" class="btn2 small" data-picsave="${esc(s.id)}">Save</button></div></div>`;
  },
  mgr: (s, c) => c.isNew ? '<div class="pfields" style="display:block"><div class="hint">Set after the pharmacy is created.</div></div>'
    : `<div class="pfields" style="display:block"><div class="hint" style="margin-bottom:6px">May add, change and remove people at this pharmacy. Never billing, the client page or ownership.</div>
      <label class="chk">${sw('data-mgr="mgrOwner"', s.mgrOwner !== false)} Account Owner</label>
      <label class="chk">${sw('data-mgr="mgrPic"', s.mgrPic !== false)} Pharmacist-in-Charge super user</label>
      <label class="chk">${sw('data-mgr="mgrClient"', s.mgrClient === true)} Client Account Owner</label></div>`,
  act: (s, c) => `<div class="pfields"><div class="calsw">${c.host && !c.rep
        ? `<label class="chk">${sw(`data-sfcal="1"`, s.calendar, 'Calendar tab for this pharmacy')} Calendar</label> <span class="hint" title="People also need the Calendar privilege">(needs privilege)</span>`
        : `Calendar: <b>${s.calendar ? 'On' : 'Off'}</b>`}</div>
        <div class="calsw">${c.host && !c.rep
        ? `<label class="chk">${sw(`data-sfdocs="1"`, s.documents, 'Documents tab for this pharmacy')} Documents</label> <span class="hint" title="People also need the Documents privilege">(needs privilege)</span>`
        : `Documents: <b>${s.documents ? 'On' : 'Off'}</b>`}</div>
        <div class="calsw">${c.host && !c.rep
        ? `<label class="chk">${sw(`data-sfreo="1"`, s.reorder !== false, 'Reorder List tab for this pharmacy')} Reorder List</label>`
        : `Reorder List: <b>${s.reorder !== false ? 'On' : 'Off'}</b>`}</div>
        <div class="calsw">${c.host && !c.rep
        ? `<label class="chk">${sw(`data-sfrx="1"`, s.rx !== false, 'Rx Intake tab for this pharmacy')} Rx Intake</label> <span class="hint">(pharmacists only)</span>`
        : `Rx Intake: <b>${s.rx !== false ? 'On' : 'Off'}</b>`}</div>
        ${c.host ? '' : `<div class="lockhint">${LOCKED}</div>`}
        <div style="margin-top:10px;">${c.rep ? `<label class="reason"><span>Why (required, the supervisor reads this)</span><input type="text" data-draftnote maxlength="300"></label> <button class="btn small" data-draftstore="${esc(s.id)}">Submit for review</button>`
          : c.isNew ? '<button class="btn small" data-createstore="1">Create pharmacy</button>' : `<button class="btn small" data-savestore="${esc(s.id)}">Save details</button>`}</div>
        ${c.host && !c.isNew && !c.rep ? `<div class="identbar"><button class="btn2 small" data-unlockident="1" title="Name, address, license and identifiers are locked once on file. A reason is required and every change is kept in the history.">Unlock fields</button>
          <button class="btn2 small" data-hist="${esc(s.id)}">Change history</button>
          <label class="reason" hidden><span>Reason for the change</span><input type="text" data-reason maxlength="300"></label><div data-histout></div></div>` : ''}</div>`
};
// the whole card, built by the layout engine
function pharmCardHtml(s, c, L){ return layoutGridHtml(c.host ? PHARM_PAGE : PHARM_OWNER_PAGE, L, id => PHARM_BODY[id](s, c)); }

// ---------------- behaviour shared by the Account Owner page and the host page ----------------
// o = { base: '/owner' | '/host', stores: () => [store, …], say: text => …, after: async () => … }
const normNm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function showFieldErr(card, k, msg){ const el = card.querySelector(`[data-err=${k}]`); if(!el) return; el.textContent = msg || ''; el.hidden = !msg; const i = card.querySelector(`[data-sf=${k}]`); if(i) i.classList.toggle('bad', !!msg); }
function pharmCardEvents(root, o){
  root.addEventListener('input', e => {
    const i = e.target.closest('[data-dig]'); if(!i) return;
    const v = i.value.replace(/\D/g, '').slice(0, +i.dataset.dig); if(v !== i.value) i.value = v;
    const k = i.dataset.sf, msg = k === 'npi' ? npiProblem(v) : k === 'ncpdp' ? ncpdpProblem(v) : '';
    showFieldErr(i.closest('.pcard'), k, v && v.length < +i.dataset.dig && !i.dataset.touched ? '' : msg);
  });
  root.addEventListener('blur', e => { const i = e.target.closest && e.target.closest('[data-dig]'); if(!i) return; i.dataset.touched = '1';
    const v = i.value, k = i.dataset.sf; showFieldErr(i.closest('.pcard'), k, k === 'npi' ? npiProblem(v) : ncpdpProblem(v)); }, true);
  root.addEventListener('change', e => {
    if(e.target.closest('[data-lic]')){ const c = e.target.closest('.pcard'); if(c) c.dataset.licTouched = '1'; }
    if(e.target.closest('[data-lic-exp]')){ const c = e.target.closest('.pcard'); if(c) c.dataset.licTouched = '1'; }
    const pk = e.target.closest('[data-ownpick]'); if(pk) pk.closest('.pcard').querySelector('[data-ownnew]').hidden = pk.value !== '@new';
    const py = e.target.closest('[data-picyes]'); if(py) py.closest('.pcard').querySelector('[data-picwho]').hidden = py.value !== 'no'; if(e.target.closest('[data-ho],[data-hc],[data-hx]')){ const c = e.target.closest('.pcard'); if(c) c.dataset.hrTouched = '1'; }
    if(e.target.closest('[data-hol]')){ const c = e.target.closest('.pcard'); if(c) c.dataset.hcTouched = '1'; } });
  root.addEventListener('click', async e => {
    const la = e.target.closest('[data-licadd]'), ld = e.target.closest('[data-licdel]'), osv = e.target.closest('[data-ownsave]'), psv = e.target.closest('[data-picsave]');
    if(la || ld){
      const card = e.target.closest('.pcard'), list = card.querySelector('[data-liclist]');
      if(ld){
        const row = ld.closest('[data-licrow]');
        if(row.querySelector('[data-ident]') && !card.dataset.unlocked){ alert('Licenses on file are locked. Press “Unlock fields” first; a reason is required.'); return; }
        row.remove(); card.dataset.licTouched = '1'; if(!list.querySelector('[data-licrow]')) list.innerHTML = '<div class="hint" data-licnone>None yet. Add the license for each state the pharmacy is licensed in.</div>'; return;
      }
      const none = list.querySelector('[data-licnone]'); if(none) none.remove();
      list.insertAdjacentHTML('beforeend', licRow({ state: '', number: '', expires: '', type: list.querySelector('[data-licrow]') ? 'nonresident' : 'resident' }, false, true)); card.dataset.licTouched = '1'; return;
    }
    if(osv){
      const card = osv.closest('.pcard'), pick = card.querySelector('[data-ownpick]').value, g = k => ((card.querySelector(`[data-on=${k}]`) || {}).value || '').trim();
      if(!pick){ alert('Pick who will be the Account Owner.'); return; }
      const body = { reason: (card.querySelector('[data-ownreason]') || {}).value || '' };
      if(pick === '@none') body.remove = true;
      else if(pick === '@client') body.sameAsClient = true;
      else if(pick === '@new'){
        if(!g('name') || !g('login') || !g('phone')){ alert('Name, Login ID and mobile number are all needed.'); return; }
        if(!card.querySelector('[data-on=consent]').checked){ alert('Have them sign the SMS consent form first, then tick the box.'); return; }
        body.owner = { create: { name: g('name'), login: g('login').toLowerCase(), phone: g('phone'), license: g('license'), smsConsent: true } };
      } else body.owner = { login: pick };
      busy(osv, true);
      try{ const r = await api('POST', o.base + '/stores/' + encodeURIComponent(osv.dataset.ownsave) + '/owner', body);
        if(o.pass && r.tempPassword) o.pass(`<b>${esc(r.owner.name || r.owner.login)} is the Account Owner.</b> Give them:<br>Pharmacy ID: <b class="mono">${esc(osv.dataset.ownsave)}</b><br>Login ID: <b class="mono">${esc(r.owner.login)}</b><br>Temporary password: <b class="mono">${esc(r.tempPassword)}</b>`);
        o.say('Account Owner saved.'); await o.after(); }
      catch(err){ if(!err.auth) alert(err.message); } finally{ busy(osv, false); }
      return;
    }
    if(psv){
      const card = psv.closest('.pcard'), yes = card.querySelector('[data-picyes]:checked');
      if(!yes){ alert('Answer yes or no.'); return; }
      const body = { ownerIsPic: yes.value === 'yes', picLogin: yes.value === 'no' ? card.querySelector('[data-picpick]').value : '', reason: (card.querySelector('[data-picreason]') || {}).value || '' };
      if(yes.value === 'no' && !body.picLogin){ alert('Pick the pharmacist in charge.'); return; }
      busy(psv, true);
      try{ await api('POST', o.base + '/stores/' + encodeURIComponent(psv.dataset.picsave) + '/pic', body); o.say('Saved.'); await o.after(); }
      catch(err){ if(!err.auth) alert(err.message); } finally{ busy(psv, false); }
      return;
    }
    const lk = e.target.closest('[data-npilook]'), us = e.target.closest('[data-npiuse]');
    const dsub = e.target.closest('[data-draftstore]');
    const cla = e.target.closest('[data-cladd]'), cld = e.target.closest('[data-cldel]');
    if(cla || cld){
      const card = e.target.closest('.pcard'), box = card.querySelector('[data-cl]'), days = closedState(card);
      if(cld) days.splice(+cld.dataset.cldel, 1);
      else{
        const d = card.querySelector('[data-cld]').value, n = card.querySelector('[data-cln]').value.trim(), y = card.querySelector('[data-cly]').checked;
        if(!d){ alert('Pick the date.'); return; } if(!n){ alert('Give the day a name, for example “Day after Christmas”.'); return; }
        if(days.some(x => x.d === d || (y && x.y && x.d.slice(5) === d.slice(5)))){ alert('That day is already listed.'); return; }
        days.push({ d, n, y }); days.sort((a, b) => a.d.localeCompare(b.d));
        card.querySelector('[data-cld]').value = ''; card.querySelector('[data-cln]').value = ''; card.querySelector('[data-cly]').checked = false;
      }
      box.dataset.cl = JSON.stringify(days); card.querySelector('[data-cllist]').innerHTML = closeRows(days); card.dataset.clTouched = '1';
      return;
    }
    if(dsub){
      const card = dsub.closest('.pcard'), cur = o.stores().find(x => x.id === dsub.dataset.draftstore) || {}, fields = {};
      card.querySelectorAll('[data-sf]').forEach(i => { if(i.value.trim() !== String(cur[i.dataset.sf] || '')) fields[i.dataset.sf] = i.value.trim(); });
      if(card.dataset.hrTouched) fields.hours = DAYS.map((_, i) => card.querySelector(`[data-hx="${i}"]`).checked ? null : {o: card.querySelector(`[data-ho="${i}"]`).value, c: card.querySelector(`[data-hc="${i}"]`).value});
      if(card.dataset.clTouched) fields.closures = closuresOfCard(card);
      if(card.dataset.hcTouched) fields.holClosed = holOfCard(card);
      if(card.dataset.licTouched) fields.licenses = licsOfCard(card);
      if(!Object.keys(fields).length){ alert('Change something first.'); return; }
      busy(dsub, true);
      try{ await api('POST', o.base + '/stores/' + encodeURIComponent(dsub.dataset.draftstore) + '/drafts', {fields, note: card.querySelector('[data-draftnote]').value.trim()}); o.say('Submitted for review.'); await o.after(); }
      catch(err){ if(!err.auth) alert(err.message); } finally{ busy(dsub, false); }
      return;
    }
    const sv = e.target.closest('[data-savestore],[data-createstore]'), ul = e.target.closest('[data-unlockident]'), hs = e.target.closest('[data-hist]');
    const card = e.target.closest('.pcard'); if(!card) return;
    const val = k => { const i = card.querySelector(`[data-sf=${k}]`); return i ? i.value.trim() : ''; };
    const es = e.target.closest('[data-entsame]');
    if(es){
      const k = (o.clients ? o.clients() : []).find(x => x.id === (card.querySelector('[data-sf=clientId]') || {}).value);
      if(!k){ alert('Pick the client first.'); return; }
      const set = (n, v) => { const i = card.querySelector(`[data-sf=${n}]`); if(i && !i.readOnly && !i.disabled) i.value = v || ''; };
      set('entityLegalName', k.legalName); set('entityType', k.entityType); set('ein', k.ein); return;
    }
    if(ul){
      if(!confirm('The name, address, license and identifiers must match the license and billing. Unlock them to make a change? You will be asked for a reason.')) return;
      card.querySelectorAll('[data-ident]').forEach(i => { i.removeAttribute('readonly'); i.removeAttribute('disabled'); });
      card.dataset.unlocked = '1'; const r = card.querySelector('.reason'); r.hidden = false; r.querySelector('input').focus(); return;
    }
    if(hs){
      const out = card.querySelector('[data-histout]'); out.innerHTML = '<div class="hint">Loading…</div>';
      try{
        const r = await api('GET', o.base + '/stores/' + encodeURIComponent(hs.dataset.hist) + '/history');
        out.innerHTML = r.history.length ? r.history.map(h => `<div class="npibox"><b>${esc((h.at || '').slice(0, 16).replace('T', ' '))} UTC</b> · ${esc(h.by)}${h.reason ? ' · “' + esc(h.reason) + '”' : ''}<div class="hint">${Object.entries(h.changes).map(([k, v]) => esc(k) + ': ' + esc(Array.isArray(v[0]) ? v[0].join(', ') : v[0] == null ? '(blank)' : String(v[0])) + ' → ' + esc(Array.isArray(v[1]) ? v[1].join(', ') : String(v[1]))).join('<br>')}</div></div>`).join('') : '<div class="hint">No changes recorded yet.</div>';
      }catch(err){ if(!err.auth) out.innerHTML = `<div class="npibox bad">${esc(err.message)}</div>`; }
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
          <button class="btn2 small" data-npiuse="1" title="Fills name, address, phone and fax. The license number is never filled; type it from the state license.">Use these details</button></div>`;
      }catch(err){ if(!err.auth) out.innerHTML = `<div class="npibox bad">${esc(err.message)}</div>`; }
      finally{ lk.disabled = false; }
      return;
    }
    if(us){
      const r = card._npi; if(!r || !r.found) return;
      if(card.querySelector('[data-ident]') && !card.dataset.unlocked){ alert('The name and address are locked. Press “Unlock fields” first.'); return; }
      const set = (k, v) => { const i = card.querySelector(`[data-sf=${k}]`); if(i && v) i.value = v; };
      set('name', r.name); set('address', r.address.address); set('suite', r.address.suite); set('city', r.address.city); set('state', r.address.state); set('zip', r.address.zip); set('phone', r.address.phone); set('fax', r.address.fax);
      o.say('Filled in from the registry. Press ' + (card.dataset.isNew ? 'Create pharmacy' : 'Save details') + ' to keep it.'); return;
    }
    if(sv){
      const isNew = !!sv.dataset.createstore, id = isNew ? (card.querySelector('[data-newid]').value || '').trim().toUpperCase() : sv.dataset.savestore;
      const body = {}; card.querySelectorAll('[data-sf]').forEach(i => body[i.dataset.sf] = i.value.trim());
      const cal = card.querySelector('[data-sfcal]'); if(cal) body.calendar = cal.checked;
      const dcs = card.querySelector('[data-sfdocs]'); if(dcs) body.documents = dcs.checked;
      const reo = card.querySelector('[data-sfreo]'); if(reo) body.reorder = reo.checked;
      const rxs = card.querySelector('[data-sfrx]'); if(rxs) body.rx = rxs.checked;
      if(card.querySelector('[data-liclist]')) body.licenses = licsOfCard(card);
      else if(card.querySelector('[data-lic-exp]')){ const cur0 = o.stores().find(x => x.id === id) || {}; body.licenses = (cur0.licenses || []).map(l => ({ ...l, expires: (card.querySelector(`[data-lic-exp="${l.state}"]`) || {}).value || '' })); }
      for(const [k, fn] of [['npi', npiProblem], ['ncpdp', ncpdpProblem]]){ const m = fn(body[k] || ''); if(m){ showFieldErr(card, k, m); const i = card.querySelector(`[data-sf=${k}]`); if(i) i.focus(); return; } }
      if(card.querySelector('[data-svc]')) body.services = [...card.querySelectorAll('[data-svc]')].filter(i => i.checked).map(i => i.dataset.svc);
      const cur = o.stores().find(x => x.id === id);
      if(card.dataset.hrTouched || (cur && cur.hours)) body.hours = DAYS.map((_, i) => card.querySelector(`[data-hx="${i}"]`).checked ? null : {o: card.querySelector(`[data-ho="${i}"]`).value, c: card.querySelector(`[data-hc="${i}"]`).value});
      if(card.dataset.clTouched) body.closures = closuresOfCard(card);
      if(card.dataset.hcTouched) body.holClosed = holOfCard(card);
      const rs = card.querySelector('[data-reason]'); if(rs && rs.value.trim()) body.changeReason = rs.value.trim();
      if(isNew){ if(!id || !body.name){ alert('Pharmacy ID and name are needed.'); return; } body.id = id; }
      busy(sv, true);
      try{ await api('POST', o.base + '/stores' + (isNew ? '' : '/' + encodeURIComponent(id)), body); o.say(isNew ? 'Pharmacy created: ' + id : 'Pharmacy details saved.'); await o.after(isNew); }
      catch(err){ if(!err.auth) alert(err.message); } finally{ busy(sv, false); }
    }
  });
}

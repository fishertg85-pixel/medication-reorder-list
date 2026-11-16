/* ---------------- pharmacy account page: panels and their layout ----------------
   The pharmacy card is built from panels placed on a 12-column grid. Each panel's place is [column, row, width, height]
   (1-based column and row; width in columns; height in rows). Rows are as tall as their content, so nothing is ever cut off.
   PHARM_LAYOUT is set once by the owner of the program with the layout editor and is the same for everyone.
   Narrow screens (under 1280 px wide) ignore it and stack the panels in reading order. */
const PHARM_COLS = 12;
const PHARM_PANELS = [['id', 'Pharmacy'], ['contact', 'Name And Address'], ['reg', 'License And Registration'], ['svc', 'Services Provided'], ['hrs', 'Hours Of Operation'], ['act', 'Calendar And Save']];
const PHARM_LAYOUT = {"v":1,"cols":12,"panels":{"id":[1,1,3,1],"contact":[4,1,4,1],"hrs":[8,1,5,2],"reg":[1,2,7,1],"svc":[1,3,7,1],"act":[8,3,5,1]}};
function pharmLayoutOk(L){
  if(!L || L.v !== 1 || L.cols !== PHARM_COLS || !L.panels) return false;
  const seen = [];
  for(const [id] of PHARM_PANELS){
    const p = L.panels[id]; if(!Array.isArray(p) || p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 1)) return false;
    const [x, y, w, h] = p; if(x + w - 1 > PHARM_COLS || w < 2 || h > 8) return false;
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
const PHARM_BODY = {
  id: (s, c) => `<div class="plogo">${c.logo ? `<img src="${esc(c.logo)}" alt="">` : '<span class="hint">No logo</span>'}
        <label class="btn2 small">Upload logo<input type="file" accept="image/png,image/jpeg,image/webp" data-logo="${esc(s.id)}" hidden></label>
        ${c.logo ? `<button class="btn2 small" data-nologo="${esc(s.id)}">Remove</button>` : ''}</div>
      <div class="pidbox"><div class="pid">Pharmacy ID: <b>${esc(s.id)}</b></div><div class="hint">(what people type when they sign in)</div>
        <div class="pid">Primary account holder: <b>${esc(c.holder || 'Account Manager')}</b></div><div class="hint">(the Account Manager)</div></div>`,
  contact: s => `<div class="pfields">${SF.map(([k, l]) => field(s, k, l)).join('')}</div>`,
  reg: s => `<div class="pfields">${SF2.map(([k, l, t]) => field(s, k, l, t)).join('')}
        <div class="pid npirow"><button class="btn2 small" data-npilook="1">Look up NPI in the federal registry</button> <span class="hint">checks the number above against the public NPI Registry; nothing changes until you press Save details</span><div data-npires></div></div>
        <div class="pid npirow"><a class="btn2 small" href="https://apps.deadiversion.usdoj.gov/webforms2/spring/validationLogin" target="_blank" rel="noopener noreferrer">Open the DEA registration check</a> <button class="btn2 small" data-deaok="1">I checked this DEA number there</button>
          <span class="hint" data-deastat>${s.deaVerified ? 'Checked on the DEA site ' + esc((s.deaVerified.at || '').slice(0, 10)) + (s.deaVerified.by ? ' by ' + esc(s.deaVerified.by) : '') : 'Not checked yet.'} The DEA does not offer a public lookup: its tool asks for details from the registration certificate, so this is checked by a person and recorded here.</span></div></div>`,
  svc: s => `<div class="pfields"><div class="svcs">${Object.entries(SVC_LABELS).map(([k, l]) => `<label class="chk">${sw(`data-svc="${k}"`, (s.services || []).includes(k))} ${l}</label>`).join('')}</div>
          ${field(s, 'servicesOther', 'Other services').replace('<label>', '<label class="oth">')}</div>`,
  hrs: s => `<div class="pfields"><div class="hrs">${s.hours ? '' : '<div class="hint">Not set yet; these are suggestions until you save.</div>'}
          ${hoursOf(s).map((h, i) => `<div class="hrow"><span>${DAYS[i]}</span><input type="time" data-ho="${i}" value="${h ? h.o : '09:00'}"><input type="time" data-hc="${i}" value="${h ? h.c : '18:00'}"><label class="chk">${sw(`data-hx="${i}"`, !h)} Closed</label></div>`).join('')}</div></div>`,
  act: s => `<div class="pfields"><div class="calsw"><label class="chk">${sw(`data-sfcal="1"`, s.calendar, 'Calendar tab for this pharmacy')} Calendar switched on for this pharmacy</label> <span class="hint">(people also need the Calendar privilege)</span></div>
        <div style="margin-top:10px;"><button class="btn small" data-savestore="${esc(s.id)}">Save details</button></div></div>`
};
// the whole card: panels in reading order (row, then column) so narrow screens stack them sensibly
function pharmCardHtml(s, c, L){
  L = L || pharmLayout() || { panels: Object.fromEntries(PHARM_PANELS.map(([id], i) => [id, [1, i + 1, PHARM_COLS, 1]])) };
  const order = PHARM_PANELS.slice().sort((a, b) => (L.panels[a[0]][1] - L.panels[b[0]][1]) || (L.panels[a[0]][0] - L.panels[b[0]][0]));
  return `<div class="pgrid">${order.map(([id, title]) => { const [x, y, w, h] = L.panels[id];
    return `<section class="pnl" data-pnl="${id}" style="--x:${x};--y:${y};--w:${w};--h:${h}"><h4 class="pt">${title}</h4><div class="pb">${PHARM_BODY[id](s, c)}</div></section>`; }).join('')}</div>`;
}

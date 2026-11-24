/* ---------------- Documents page: a pharmacy's own compliance document library ----------------
   Built on the layout engine (layout_engine.js) like every page of the suite. DOCS_LAYOUT is set by Neo with the layout editor
   (dev/build_layout_editor.py documents) and is the same for everyone. Panels: folders, summary tiles (Owner, Pharmacist-In-Charge, Designated Person only),
   pinned, and the document list. The detail panel and the windows (add, new version, approve, review, retire) open over the page.
   What a person may do is decided by the server from their duty (Owner, Pharmacist-In-Charge, Designated Person, Compliance Technician, Staff); the screen only follows it.
   Everyone with the Documents privilege can open, print and pin the current documents. */
const DOC_SLUG = s => s.replace(/ /g, '_').replace(/[()]/g, '');
const DOC_AREA_LIST = [['01', 'OPS', 'Pharmacy Operations'], ['02', 'CSA', 'Controlled Substances'], ['03', 'NSC', 'Nonsterile Compounding (USP 795)'], ['04', 'STC', 'Sterile Compounding (USP 797)'], ['05', 'HDR', 'Hazardous Drugs (USP 800)'], ['06', 'IMM', 'Immunizations'], ['07', 'HIP', 'Privacy and Security (HIPAA)'], ['08', 'OSH', 'Workplace Safety (OSHA)'], ['09', 'QMS', 'Quality and Medication Safety'], ['10', 'PER', 'Personnel Training and Competency'], ['11', 'REG', 'Licensing and Regulatory'], ['12', 'FAC', 'Facilities and Equipment']].map(([n, code, name]) => ({ n, code, name, folder: n + '_' + DOC_SLUG(name) }));
const DOC_AF = Object.fromEntries(DOC_AREA_LIST.map(a => [a.code, a.folder]));
const DOC_CMPA = ['NSC', 'STC', 'HDR'];
const DOC_TYPE_LIST = [
  { c: 'POL', n: 'Policy', f: '01_Policies', sub: null }, { c: 'SOP', n: 'SOP', f: '02_SOPs', sub: null }, { c: 'FRM', n: 'Form', f: '03_Forms', sub: null },
  { c: 'MFR', n: 'MFR', f: '04_MFRs', sub: DOC_CMPA, tip: 'Paper (PDF) renderings of Master Formulation Records' }, { c: 'CMP', n: 'Compounding Record', f: '05_Compounding_Records', sub: DOC_CMPA, tip: 'Blank compounding record templates' },
  { c: 'LOG', n: 'Log', f: '06_Logs', sub: null }, { c: 'CHK', n: 'Checklist', f: '07_Checklists', sub: null },
  { c: 'TRN', n: 'Training Material', f: '08_Training_and_Competency', sub: ['Orientation', 'Competency_Assessments', 'Training_Materials'] },
  { c: 'PAT', n: 'Patient Material', f: '09_Patient_Materials', sub: ['Notices', 'Counseling_Handouts', 'Immunization'] },
  { c: 'REF', n: 'Reference', f: '10_Reference', sub: ['Regulatory_Rules', 'Safety_Data_Sheets', 'Manufacturer_and_Vendor', 'Accreditation'] },
  { c: 'TMP', n: 'Template', f: '11_Templates_General', sub: ['Letterhead', 'General'] }];
const DOC_TY = Object.fromEntries(DOC_TYPE_LIST.map(t => [t.c, t]));
const DOC_FORMATS = ['Fillable PDF', 'Printable PDF'];
const DOC_DUTY_LABELS = { owner: 'Owner', pic: 'Pharmacist-In-Charge', dp: 'Designated Person', ctech: 'Compliance Technician', staff: 'Staff' };
const DOC_DUE_SOON = 30;
// the log stores UTC; show it in the pharmacy's own time zone with the zone name (CST / CDT)
function docsLocal(iso){
  try{
    const tz = typeof storeTZ === 'function' ? storeTZ() : 'America/Chicago', d = new Date(iso); if(isNaN(d)) return String(iso).slice(0, 16).replace('T', ' ');
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).formatToParts(d).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
  }catch(e){ return String(iso).slice(0, 16).replace('T', ' ') + ' UTC'; }
}
const docSubFor = d => { const t = DOC_TY[d.type]; return t.sub === null || DOC_CMPA.includes(t.sub[0]) ? DOC_AF[d.area] : (d.sub || t.sub[0]); };
const docFileName = (d, v) => `${d.id}_v${v}_${d.title.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}.pdf`;
const docPathOf = (d, v) => `${DOC_TY[d.type].f}/${docSubFor(d)}/${docFileName(d, v)}`;

const DOCS_PANELS = [['rail', 'Folders'], ['tiles', 'Compliance Summary'], ['pins', 'Pinned'], ['list', 'Documents']];
const DOCS_LAYOUT = {"v":2,"cols":12,"panels":{"rail":[1,1,2,43],"tiles":[3,1,10,11],"pins":[3,12,10,8],"list":[3,20,10,45]}};   // set by Neo from the layout editor (2026-11-18)
const DOCS_PAGE = { id: 'documents', title: 'Documents Page', panels: DOCS_PANELS, layout: DOCS_LAYOUT,
  render: (_unused, panels) => docsHtml(DOCS_SAMPLE_MODEL(), { panels }) };

/* ---- the screen's state (one per sign-in); the layout editor builds its own from the sample below ---- */
function docsNewModel(){ return { view: 'docs', insp: null, inspOK: false, tasks: null, mine: null, pers: null, persSel: null, grants: null, tasksOK: false, persOK: false, persAdd: false, boss: false, dpChapters: [], final: false, duty: 'staff', today: '', docs: [], pins: [], log: [], pharmacy: '', q: '', type: 'all', fstatus: '', fformat: '', freview: '', fpend: false, showRetired: false, sort: { k: 'id', d: 1 }, sel: '', loaded: false }; }
const docsIs = (m, ...ds) => ds.includes(m.duty);
const docsManage = m => docsIs(m, 'owner', 'pic', 'dp', 'ctech'), docsApprove = m => docsIs(m, 'owner', 'pic', 'dp');
const docsDate = s => { const [y, mo, d] = s.split('-').map(Number); return Date.UTC(y, mo - 1, d); };
const docsDiff = (a, b) => Math.round((docsDate(a) - docsDate(b)) / 864e5);
function docsAddMonths(s, n){ const [y, m, d] = s.split('-').map(Number), t = new Date(Date.UTC(y, m - 1 + n, 1)), last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); t.setUTCDate(Math.min(d, last)); return t.toISOString().slice(0, 10); }
function docInfo(d, m){
  const cur = d.versions.find(v => v.state === 'current'), pend = d.versions.find(v => v.state === 'pending');
  const status = d.retired ? 'Retired' : cur ? (d.underReview ? 'Under Review' : 'Active') : 'Draft';
  const base = d.lastReviewed || (cur && cur.effective) || null, next = base && d.cycle ? docsAddMonths(base, d.cycle) : null, days = next ? docsDiff(next, m.today) : null;
  let r = 'n/a'; if(status === 'Active' || status === 'Under Review') r = next == null ? 'No Date' : days < 0 ? 'Overdue' : days <= DOC_DUE_SOON ? 'Due Soon' : 'Current';
  return { cur, pend, status, version: cur ? cur.v : (pend ? pend.v : ''), effective: cur ? cur.effective : '', next, days, r };
}
const DOC_RORD = { Overdue: 0, 'Due Soon': 1, 'No Date': 2, Current: 3, 'n/a': 4 };
const docPill = (cls, t, title) => `<span class="dpill ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(t)}</span>`;
const docStatusPill = s => docPill({ Active: 'ok', Draft: 'gray', 'Under Review': 'warn', Retired: 'gray' }[s], s);
const docReviewPill = r => r === 'n/a' ? '<span class="hint">n/a</span>' : docPill({ Overdue: 'bad', 'Due Soon': 'warn', Current: 'ok', 'No Date': 'bad' }[r], r);
const docFormatPill = f => docPill(f === 'Fillable PDF' ? 'acc' : 'gray', f.replace(' PDF', ''));
function docDueText(i){ if(i.next == null) return ''; if(i.r === 'n/a') return i.next; return i.days < 0 ? `${-i.days} day${i.days === -1 ? '' : 's'} overdue` : i.days === 0 ? 'due today' : `in ${i.days} day${i.days === 1 ? '' : 's'}`; }

function docsRows(m){
  const q = m.q.trim().toLowerCase(), man = docsManage(m);
  let rows = m.docs.map(d => ({ d, i: docInfo(d, m) })).filter(({ d, i }) => {
    if(!man && (i.status === 'Draft' || i.status === 'Retired') && !(i.pend && d.chapter && m.dpChapters.includes(d.chapter))) return false;
    if(m.type !== 'all' && d.type !== m.type) return false;
    if(i.status === 'Retired' && !m.showRetired && m.fstatus !== 'Retired') return false;
    if(m.fstatus && i.status !== m.fstatus) return false;
    if(m.fformat && d.format !== m.fformat) return false;
    if(m.freview && i.r !== m.freview) return false;
    if(m.fpend && !i.pend) return false;
    if(q && !(d.id + ' ' + d.title + ' ' + d.notes + ' ' + d.basis).toLowerCase().includes(q)) return false;
    return true; });
  const V = { id: x => x.d.id, title: x => x.d.title.toLowerCase(), type: x => DOC_TY[x.d.type].n, version: x => x.i.version, status: x => x.i.status, next: x => x.i.next || '9999', r: x => DOC_RORD[x.i.r] }[m.sort.k] || (x => x.d.id);
  rows.sort((a, b) => { const x = V(a), y = V(b); return (x < y ? -1 : x > y ? 1 : a.d.id < b.d.id ? -1 : 1) * m.sort.d; });
  return rows;
}
/* ---- panel regions. Each region has a data-dz name so the live page can refresh just that part (typing in the search box is never interrupted) ---- */
function docsRailHtml(m){
  const all = m.docs.map(d => ({ d, i: docInfo(d, m) })), man = docsManage(m), appr = docsApprove(m);
  const live = all.filter(x => x.i.status !== 'Retired' && (man || x.i.status !== 'Draft'));
  const sp = `<button class="dit" data-dact="view" data-id="mine" aria-current="${m.view === 'mine'}"><span class="nm">My Documents</span></button>` +
    (m.tasksOK ? `<button class="dit" data-dact="view" data-id="tasks" aria-current="${m.view === 'tasks'}"><span class="nm">Tasks</span></button>` : '') +
    (m.persOK ? `<button class="dit" data-dact="view" data-id="pers" aria-current="${m.view === 'pers'}"><span class="nm">Personnel Files</span></button>` : '') +
    (m.inspOK ? `<button class="dit" data-dact="view" data-id="insp" aria-current="${m.view === 'insp'}"><span class="nm">Inspector Link</span></button>` : '') + '<div class="dgh">Library</div>';
  return sp + `<button class="dit" data-dact="view" data-id="docs" aria-current="${m.view === 'docs' && m.type === 'all'}"><span class="nm">All Documents</span><span class="ct">${live.length}</span></button>` +
    DOC_TYPE_LIST.map(t => { const mm = live.filter(x => x.d.type === t.c), od = mm.filter(x => x.i.r === 'Overdue').length;
      return `<button class="dit" data-dact="type" data-id="${t.c}" aria-current="${m.view === 'docs' && m.type === t.c}" title="${esc(t.tip || t.f)}"><span class="nm">${t.f.replace(/_/g, ' ')}</span>${od && appr ? `<span class="od">${od}</span>` : ''}<span class="ct">${mm.length}</span></button>`; }).join('') +
    (man ? `<div class="dgh">Archive</div><button class="dit" data-dact="showret"><span class="nm">99 Archive (Retired)</span><span class="ct">${all.filter(x => x.i.status === 'Retired').length}</span></button>` : '');
}
function docsTilesHtml(m){
  const all = m.docs.map(d => ({ d, i: docInfo(d, m) })), c = k => all.filter(x => x.i.r === k).length;
  return `<div class="dtiles">${[['active', 'acc', 'Active', all.filter(x => x.i.status === 'Active' || x.i.status === 'Under Review').length], ['Overdue', 'bad', 'Review Overdue', c('Overdue')], ['Due Soon', 'warn', `Due In ${DOC_DUE_SOON} Days`, c('Due Soon')],
    ['pend', 'warn', 'Awaiting Approval', all.filter(x => x.i.pend).length], ['Under Review', 'acc', 'Under Review', all.filter(x => x.i.status === 'Under Review').length]]
    .map(([k, cl, l, n]) => `<button class="dtile ${cl}" data-dact="tile" data-id="${k}"><div class="n">${n}</div><div class="l">${esc(l)}</div></button>`).join('')}</div>`;
}
function docsPinsHtml(m){
  const pins = m.pins.map(id => m.docs.find(d => d.id === id)).filter(Boolean);
  return pins.length ? pins.map(d => `<button class="dchip" data-dact="open" data-id="${d.id}" title="${esc(d.title)}"><span class="num">${d.id}</span> ${esc(d.title.length > 34 ? d.title.slice(0, 33) + '…' : d.title)}</button>`).join('') : '<span class="hint">Nothing pinned yet. Use the star on any row.</span>';
}
function docsChipsHtml(m){
  const act = [];
  if(m.type !== 'all') act.push(['Folder: ' + DOC_TY[m.type].f.replace(/_/g, ' '), 'type']); if(m.fstatus) act.push(['Status: ' + m.fstatus, 'fstatus']); if(m.fformat) act.push(['Format: ' + m.fformat, 'fformat']);
  if(m.freview) act.push(['Review: ' + m.freview, 'freview']); if(m.fpend) act.push(['Awaiting Approval', 'fpend']); if(m.showRetired) act.push(['Showing Retired', 'showRetired']);
  return act.length ? `<div class="dchips">${act.map(([l, k]) => `<button class="dchip" data-dact="clr" data-id="${k}">${esc(l)} ×</button>`).join('')}<button class="btn2 small" data-dact="clrall">Clear All</button></div>` : '';
}
function docsTableHtml(m){
  const rows = docsRows(m), man = docsManage(m), appr = docsApprove(m), pn = m.pins;
  const H = [['pin', ''], ['id', 'Doc ID'], ['title', 'Title'], ['type', 'Type'], ['version', 'Version'], ...(man ? [['status', 'Status']] : []), ...(appr ? [['next', 'Next Review'], ['r', 'Review']] : []), ['more', '']];
  const arrow = k => m.sort.k === k ? (m.sort.d > 0 ? ' ▲' : ' ▼') : '';
  if(!rows.length) return `<div class="dempty">No documents match. ${m.docs.length ? '<button class="btn2 small" data-dact="clrall">Clear Filters</button>' : ''}</div>`;
  return `<div class="dtw"><table class="dtable"><thead><tr>${H.map(([k, l]) => k === 'pin' || k === 'more' ? '<th></th>' : `<th class="s" data-dact="sort" data-id="${k}" scope="col">${l}${arrow(k)}</th>`).join('')}</tr></thead><tbody>${rows.map(({ d, i }) => `<tr class="dtr${m.sel === d.id ? ' sel' : ''}" tabindex="0" data-row="${d.id}">
    <td><button class="dstar${pn.includes(d.id) ? ' on' : ''}" data-dact="pin" data-id="${d.id}" aria-label="${pn.includes(d.id) ? 'Unpin' : 'Pin'} ${d.id}">${pn.includes(d.id) ? '★' : '☆'}</button></td>
    <td class="num">${d.id}</td><td title="${esc(d.title)}">${esc(d.title)}${i.pend && man ? ` ${docPill('warn', 'v' + i.pend.v + ' Pending', 'A new version is waiting for approval')}` : ''}</td><td>${DOC_TY[d.type].n}</td>
    <td class="num">${i.version || '-'}</td>${man ? `<td>${docStatusPill(i.status)}</td>` : ''}${appr ? `<td class="num">${i.next || '-'}</td><td>${docReviewPill(i.r)}</td>` : ''}
    <td><button class="dmore" data-dact="menu" data-id="${d.id}" aria-label="Details and actions for ${d.id}">⋯</button></td></tr>`).join('')}</tbody></table></div>`;
}
const docsCount = m => `${docsRows(m).length} of ${m.docs.filter(d => docsManage(m) || (d.versions.some(v => v.state === 'current') && !d.retired)).length} documents`;
/* ---- 39.2: audience, Tasks folder, My Documents, Personnel Files, Designated Person review ---- */
const DOC_AUD = [['pharmacist', 'Pharmacist'], ['pharmacist:lead', 'Pharmacist: Lead'], ['pharmacist:supervisor', 'Pharmacist: Supervisor'], ['pharmacist:immunizer', 'Pharmacist: Immunizer'], ['pharmacist:sterile', 'Pharmacist: Sterile'],
  ['tech', 'Technician'], ['tech:lead', 'Technician: Lead'], ['tech:sterile', 'Technician: Sterile'], ['tech:nonsterile', 'Technician: Nonsterile'],
  ['staff', 'Associate'], ['staff:cashier', 'Associate: Cashier'], ['staff:driver', 'Associate: Driver'], ['staff:warehouse', 'Associate: Warehouse'], ['staff:student', 'Associate: Student']];
const docsAudLabel = k => (DOC_AUD.find(x => x[0] === k) || [k, k])[1];
const docsAudHtml = sel => `<div class="dchecks">${DOC_AUD.map(([k, l]) => `<label><input type="checkbox" data-aud="${k}"${sel.includes(k) ? ' checked' : ''}> ${l}</label>`).join('')}</div><div class="hint">None ticked = everyone. The Pharmacist-In-Charge, the Account Owner and document managers always see it.</div>`;
const docsAudRead = () => [...document.querySelectorAll('[data-aud]:checked')].map(e => e.dataset.aud);
const DOC_ROLE = { pic: 'Pharmacist-In-Charge', pharmacist: 'Pharmacist', tech: 'Technician', staff: 'Associate' }, docsRole = k => DOC_ROLE[k] || '';
const docsFileBtns = (files, act, extra) => (files || []).map(f => `<button class="dlink" data-dact="${act}" data-id="${esc(f.id)}"${extra || ''} title="${esc(f.name)}">${esc(f.name.length > 24 ? f.name.slice(0, 23) + '…' : f.name)}</button>`).join(' ');
const docsRecTable = recs => recs && recs.length ? `<div class="dtw"><table class="dtable"><thead><tr><th>Date</th><th>Record</th><th>Result</th><th>Approved By</th></tr></thead><tbody>${recs.map(r => `<tr><td class="num">${esc(r.date)}</td><td>${esc(r.type)}</td><td>${esc(r.result)}</td><td>${r.approvedBy ? esc(r.approvedBy) : docPill('warn', 'Awaiting')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="hint">None yet.</div>';
function docsTasksHtml(m){
  if(!m.tasks) return '<div class="dempty">Loading…</div>';
  if(!m.tasks.folders.length) return '<div class="dempty">No files are attached to completed tasks yet. Files attached to a task are filed here by task type.</div>';
  return '<div class="dtw">' + m.tasks.folders.map(f => `<div class="dgh">${esc(f.title)} <span class="hint">${f.entries.length}</span></div><table class="dtable"><thead><tr><th>Date</th><th>Performed By</th><th>Completed By</th><th>Result</th><th>Approved By</th><th>Files</th></tr></thead><tbody>${f.entries.map(e => `<tr><td class="num">${esc(e.date)}</td><td>${esc(e.performedBy)}</td><td>${esc(e.completedBy)}</td><td>${esc(e.result)}</td><td>${e.approvedBy ? esc(e.approvedBy) : docPill('warn', e.status === 'returned' ? 'Returned' : 'Awaiting')}</td><td>${docsFileBtns(e.files, 'tfile')}</td></tr>`).join('')}</tbody></table>`).join('') + '</div>';
}
function docsMineHtml(m){
  const x = m.mine; if(!x) return '<div class="dempty">Loading…</div>';
  return `<div class="dtool"><b>My Documents</b><span class="dsp"></span><button class="btn small" data-dact="madd">Add Document</button></div><div class="hint">Private to you. The Pharmacist-In-Charge and the Account Owner can see them in your personnel file.</div>
   <div class="dgh">Uploaded</div>${x.uploads.length ? `<div class="dtw"><table class="dtable"><thead><tr><th>Title</th><th>Kind</th><th>Added</th><th>By</th><th></th></tr></thead><tbody>${x.uploads.map(u => `<tr><td>${esc(u.title)}</td><td>${esc(x.kinds[u.kind] || u.kind)}</td><td class="num">${esc(docsLocal(u.at).slice(0, 10))}</td><td>${esc(u.by)}</td><td><button class="btn2 small" data-dact="mfile" data-id="${esc(u.id)}">Open</button>${u.addedBy ? '' : ` <button class="btn2 small danger" data-dact="mremove" data-id="${esc(u.id)}">Remove</button>`}</td></tr>`).join('')}</tbody></table></div>` : '<div class="hint">Nothing uploaded.</div>'}
   <div class="dgh">License</div><div class="hint">${x.license.number ? `${esc(x.license.number)}${x.license.expires ? ', expires ' + esc(x.license.expires) : ''}` : 'No license on file.'}</div>
   <div class="dgh">Training And Validation Records</div>${docsRecTable(x.records)}`;
}
function docsPersHtml(m){
  const p = m.pers; if(!p) return '<div class="dempty">Loading…</div>';
  if(m.persSel){ const d = m.persSel;
    return `<div class="dtool"><button class="btn2 small" data-dact="perback">Back</button><b>${esc(d.person.name)}</b><span class="dsp"></span>${p.canAdd ? '<button class="btn small" data-dact="padd">Add Material</button>' : ''}</div>
     <div class="hint">${esc(docsRole(d.person.acctType))}${d.person.license ? ' · License ' + esc(d.person.license) : ''}${d.person.licExpires ? ' · Expires ' + esc(d.person.licExpires) : ''}</div>
     <div class="dgh">Documents</div>${d.uploads.length ? `<div class="dtw"><table class="dtable"><thead><tr><th>Title</th><th>Kind</th><th>Added</th><th>By</th><th></th></tr></thead><tbody>${d.uploads.map(u => `<tr><td>${esc(u.title)}</td><td>${esc(u.kind)}</td><td class="num">${esc(docsLocal(u.at).slice(0, 10))}</td><td>${esc(u.by)}</td><td><button class="btn2 small" data-dact="pfile" data-id="${esc(u.id)}" data-p="${esc(d.person.sub)}">Open</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="hint">Nothing uploaded.</div>'}
     <div class="dgh">Training And Validation Records</div>${docsRecTable(d.records)}`; }
  return `<div class="dtw"><table class="dtable"><thead><tr><th>Name</th><th>Role</th><th>License</th><th>Expires</th><th>Designated Person</th>${p.canGrant ? '<th>Personnel Files</th><th>Document Review</th><th>Inspector Link</th>' : ''}</tr></thead><tbody>${p.people.map(x => { const dp = Object.keys(x.dp || {}).filter(k => x.dp[k]); const g = m.grants || { personnel: {}, dpOff: {}, inspector: {} };
    return `<tr class="click" data-dact="persopen" data-id="${esc(x.sub)}"><td>${esc(x.name)}</td><td>${esc(docsRole(x.acctType))}</td><td>${esc(x.license)}</td><td class="num">${esc(x.licExpires)}</td><td>${dp.length ? esc(dp.join(', ')) : ''}</td>${p.canGrant ? `<td><input type="checkbox" data-grant="personnel" data-sub="${esc(x.sub)}"${g.personnel[x.sub] ? ' checked' : ''}${dp.length ? ' checked disabled title="On while a Designated Person box is ticked"' : ''}></td><td>${dp.length ? `<input type="checkbox" data-grant="dpoff" data-sub="${esc(x.sub)}"${g.dpOff[x.sub] ? '' : ' checked'} title="Reviews documents for their chapters">` : ''}</td><td><input type="checkbox" data-grant="inspector" data-sub="${esc(x.sub)}"${(g.inspector || {})[x.sub] ? ' checked' : ''}></td>` : ''}</tr>`; }).join('')}</tbody></table></div>${m.hostlog ? `<div class="dgh">IronLedger Access</div><div class="hint">IronLedger staff have read-only access to the Calendar and, with a privilege, Personnel Files. Every view is listed here.</div>${m.hostlog.length ? `<div class="dtw"><table class="dtable"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead><tbody>${m.hostlog.slice(0, 100).map(e => `<tr><td class="num">${esc(docsLocal(e.at))}</td><td>${esc(e.by)}</td><td>${esc(e.what)}</td><td>${esc(e.detail)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="hint">No IronLedger access yet.</div>'}` : ''}`;
}
const docsAltHtml = m => m.view === 'tasks' ? docsTasksHtml(m) : m.view === 'mine' ? docsMineHtml(m) : m.view === 'insp' ? docsInspHtml(m) : docsPersHtml(m);

const inspBase = () => '/stores/' + encodeURIComponent(STORE.id) + '/inspector';
const inspStamp = ms => docsLocal(new Date(ms).toISOString());
function docsInspHtml(m){
  const x = m.insp; if(!x) return '<div class="dempty">Loading…</div>';
  return `<div class="dtool"><b>Inspector Links</b><span class="dsp"></span><button class="btn small" data-dact="inspnew">New Link</button></div>
   <div class="hint">Read only and time limited. Opens the Dashboard, Task Logs, approved Documents and compliance Personnel data for the period you set. Not a login.</div>
   ${x.links.length ? `<div class="dtw"><table class="dtable"><thead><tr><th>For</th><th>Period</th><th>Sent By</th><th>Sent</th><th>Ends</th><th>Opens</th><th>Documents</th><th>Status</th><th></th></tr></thead><tbody>${x.links.map(l => `<tr><td>${esc(l.label)}</td><td class="num">${esc(l.from)} to ${esc(l.to)}</td><td>${esc(l.by)}</td><td class="num">${esc(docsLocal(l.at).slice(0, 10))}</td><td class="num">${esc(inspStamp(l.expiresAt))}</td><td class="num">${l.opens}</td><td>${l.docs ? 'Yes' : 'Register Only'}</td><td>${docPill({ Active: 'ok', Expired: 'gray', Revoked: 'bad' }[l.state], l.state)}</td><td>${l.state === 'Active' ? `<button class="btn2 small" data-dact="inspext" data-id="${esc(l.id)}">Change Expiry</button> <button class="btn2 small danger" data-dact="insprev" data-id="${esc(l.id)}">Revoke</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="hint">No links sent.</div>'}
   ${x.log ? `<div class="dgh">Access Log</div><div class="hint">Every open, kept permanently.</div>${x.log.length ? `<div class="dtw"><table class="dtable"><thead><tr><th>When</th><th>For</th><th>What</th><th>Detail</th><th>Device</th><th>IP</th></tr></thead><tbody>${x.log.map(e => `<tr><td class="num">${esc(docsLocal(e.at))}</td><td>${esc(e.label)}</td><td>${esc(e.what)}</td><td>${esc(e.detail)}</td><td title="${esc(e.device)}">${esc((e.device || '').slice(0, 40))}</td><td class="num">${esc(e.ip)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="hint">Not opened yet.</div>'}` : ''}`;
}
function docsInspNewModal(){
  docsModal(`<h3>New Inspector Link</h3><div class="dmb"><div class="dfld"><label for="iLbl">Who It Is For</label><input type="text" id="iLbl" maxlength="80" placeholder="Texas State Board of Pharmacy"></div>
   <div class="dg2"><div class="dfld"><label for="iFrom">Report Period From</label><input type="date" id="iFrom" value="${DOCS.today ? docsAddMonths(DOCS.today, -12) : ''}"></div><div class="dfld"><label for="iTo">Report Period To</label><input type="date" id="iTo" value="${DOCS.today}"></div></div>
   <div class="dg2"><div class="dfld"><label for="iDays">Link Ends After (Days)</label><input type="number" id="iDays" min="1" max="30" value="7"></div><div class="dfld"><label>Documents</label><label class="chk"><input type="checkbox" id="iDocs"> Allow Opening Approved Documents</label></div></div>
   <div class="hint">Drafts, voided records, billing, accounts and contacts are never shown.</div></div>
   <div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="iGo">Create Link</button></div>`);
  $('iGo').addEventListener('click', async () => { const label = $('iLbl').value.trim(); if(!label) return docsToast('Enter who it is for.'); busy($('iGo'), true);
    try{ const r = await api('POST', inspBase(), { label, from: $('iFrom').value, to: $('iTo').value, days: $('iDays').value, docs: $('iDocs').checked }), url = location.origin + r.path;
      DOCS.insp = await api('GET', inspBase());
      docsModal(`<h3>Inspector Link</h3><div class="dmb"><div class="hint">Copy it now. For safety it is not shown again.</div><div class="dfld"><input type="text" id="iUrl" readonly value="${esc(url)}" style="width:100%"></div></div>
       <div class="dmf"><button class="btn2" data-dact="closemodal">Close</button><button class="btn" id="iCopy">Copy Link</button></div>`, true);
      $('iCopy').addEventListener('click', async () => { try{ await navigator.clipboard.writeText(url); docsToast('Link copied.'); }catch(e){ $('iUrl').select(); docsToast('Press Ctrl+C to copy.'); } }); docsPaint(); }
    catch(e){ docsErr(e); busy($('iGo'), false); } });
}
function docsInspExpiryModal(id){
  docsModal(`<h3>Change Expiry</h3><div class="dmb"><div class="dfld"><label for="xDays">Link Ends After (Days From Now)</label><input type="number" id="xDays" min="1" max="30" value="7"></div></div><div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="xGo">Save</button></div>`);
  $('xGo').addEventListener('click', async () => { try{ await api('POST', inspBase() + '/' + encodeURIComponent(id) + '/expiry', { days: $('xDays').value }); DOCS.insp = await api('GET', inspBase()); docsCloseModal(); docsPaint(); docsToast('Saved.'); }catch(e){ docsErr(e); } });
}
async function docsInspRevoke(id){ try{ await api('POST', inspBase() + '/' + encodeURIComponent(id) + '/revoke', {}); DOCS.insp = await api('GET', inspBase()); docsPaint(); docsToast('Link revoked.'); }catch(e){ docsErr(e); } }
async function docsView(id){
  DOCS.view = id; if(id === 'docs'){ DOCS.type = 'all'; docsPaint(); return; }
  docsPaint();
  try{
    if(id === 'tasks') DOCS.tasks = await api('GET', docsPath() + '/tasks');
    else if(id === 'mine') DOCS.mine = await api('GET', docsPath() + '/mine');
    else if(id === 'insp') DOCS.insp = await api('GET', '/stores/' + encodeURIComponent(STORE.id) + '/inspector');
    else if(id === 'pers'){ DOCS.pers = await api('GET', docsPath() + '/personnel'); DOCS.persSel = null; DOCS.grants = DOCS.pers.canGrant ? await api('GET', docsPath() + '/grants') : null; DOCS.hostlog = DOCS.pers.canGrant ? (await api('GET', docsPath() + '/hostlog')).log : null; }
  }catch(e){ docsErr(e); DOCS.view = 'docs'; }
  if(DOCS.view === id) docsPaint();
}
async function docsFileOpen(path){
  const w = window.open('', '_blank');
  try{ const r = await api('GET', docsPath() + path); if(!w){ docsToast('Allow pop-ups for this site to open documents.'); return; } w.location = r.url; }catch(e){ if(w) w.close(); docsErr(e); }
}
async function docsPersOpen(sub){ try{ DOCS.persSel = await api('GET', docsPath() + '/personnel/' + encodeURIComponent(sub)); docsPaint(); }catch(e){ docsErr(e); } }
async function docsGrant(what, sub, on){
  try{ await api('POST', docsPath() + '/grants', { what, sub, on: what === 'dpoff' ? !on : on }); DOCS.grants = await api('GET', docsPath() + '/grants'); await docsLoad(); }catch(e){ docsErr(e); docsPaint(); }
}
async function docsMineRemove(id){ try{ await api('POST', docsPath() + '/mine/' + encodeURIComponent(id) + '/remove', {}); DOCS.mine = await api('GET', docsPath() + '/mine'); docsPaint(); docsToast('Removed.'); }catch(e){ docsErr(e); } }
function docsMineAddModal(forPerson){                            // forPerson: the Account Owner adds to someone's personnel file
  const sub = forPerson && DOCS.persSel ? DOCS.persSel.person.sub : '', base = forPerson ? '/personnel/' + encodeURIComponent(sub) : '/mine';
  docsModal(`<h3>${forPerson ? 'Add Material' : 'Add Document'}</h3><div class="dmb"><div class="dwarn">PDF only. Do not upload patient information.</div>
   <div class="dfld"><label for="mFile">PDF File</label><input type="file" id="mFile" accept="application/pdf,.pdf"></div>
   <div class="dg2"><div class="dfld"><label for="mTitle">Title</label><input type="text" id="mTitle" maxlength="200"></div><div class="dfld"><label for="mKind">Kind</label><select id="mKind">${Object.entries({ validation: 'Validation', license: 'License', training: 'Training', scan: 'Uploaded Scan', other: 'Other' }).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div></div></div>
   <div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="mGo">Save</button></div>`);
  $('mFile').addEventListener('change', e => { const f = e.target.files[0]; if(f && !$('mTitle').value) $('mTitle').value = f.name.replace(/\.pdf$/i, '').replace(/_+/g, ' '); });
  $('mGo').addEventListener('click', async () => { const f = $('mFile').files[0], t = $('mTitle').value.trim();
    if(!f) return docsToast('Choose the PDF file.'); if(!/\.pdf$/i.test(f.name)) return docsToast('Only PDF files are accepted.'); if(!t) return docsToast('Enter a title.'); busy($('mGo'), true);
    try{ const up = await docsUpload(f, base + '/upload-url'); await api('POST', docsPath() + base + (forPerson ? '/add' : ''), { title: t, kind: $('mKind').value, file: up }); docsCloseModal();
      if(forPerson) await docsPersOpen(sub); else { DOCS.mine = await api('GET', docsPath() + '/mine'); docsPaint(); } docsToast('Saved.'); }
    catch(e){ docsErr(e); busy($('mGo'), false); } });
}
function docsDpModal(id){
  const d = docOf(id), p = docInfo(d, DOCS).pend;
  docsModal(`<h3>Designated Person Review: ${d.id}</h3><div class="dmb"><div class="hint">${esc(d.title)}, v${esc(p.v)}, chapter ${esc(d.chapter)}. The final approver approves after this review.</div>
   <div class="dfld"><label>Outcome</label><div class="dradios"><label><input type="radio" name="dpo" value="ok" checked> Reviewed, Ready For Final Approval</label><label><input type="radio" name="dpo" value="return"> Return To The Submitter<br><span class="hint">Removes this version. Say what needs to change.</span></label></div></div>
   <div class="dfld"><label for="dpC">Comments</label><textarea id="dpC" maxlength="500"></textarea></div>${docsSignField('Reviewed')}</div>
   <div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="dpGo">Sign And Save</button></div>`);
  $('dpGo').addEventListener('click', () => { const out = document.querySelector('[name=dpo]:checked').value, c = $('dpC').value.trim(); if(out === 'return' && !c) return docsToast('Say what needs to change.');
    const pin = docsPinVal(); if(pin === null) return; busy($('dpGo'), true);
    docsDo('/' + id + '/dpreview', { outcome: out, comment: c, reason: c, pin }, out === 'ok' ? 'Review recorded.' : 'Returned.', () => docsDpModal(id)).then(r => { if(!r) busy($('dpGo'), false); }); });
}
const DOCS_BODY = {
  rail: m => `<div class="drail" data-dz="rail">${docsRailHtml(m)}</div>`,
  tiles: m => `<div data-dz="tiles">${docsTilesHtml(m)}</div>`,
  pins: m => `<div class="dpins" data-dz="pins">${docsPinsHtml(m)}</div>`,
  list: m => m.view !== 'docs' ? `<div data-dz="alt">${docsAltHtml(m)}</div>` : `<div class="dtool">
      <input type="search" data-dq placeholder="Search" value="${esc(m.q)}" aria-label="Search documents">
      ${docsManage(m) ? `<select data-dfs aria-label="Status"><option value="">Status: Any</option>${['Active', 'Draft', 'Under Review', 'Retired'].map(v => `<option${v === m.fstatus ? ' selected' : ''}>${v}</option>`).join('')}</select>` : ''}
      <select data-dff aria-label="Format"><option value="">Format: Any</option>${DOC_FORMATS.map(v => `<option${v === m.fformat ? ' selected' : ''}>${v}</option>`).join('')}</select>
      ${docsApprove(m) ? `<select data-dfr aria-label="Review status"><option value="">Review: Any</option>${['Overdue', 'Due Soon', 'Current', 'No Date'].map(v => `<option${v === m.freview ? ' selected' : ''}>${v}</option>`).join('')}</select>` : ''}
      ${docsManage(m) ? `<label class="chk"><input type="checkbox" data-dret${m.showRetired ? ' checked' : ''}> Show Retired</label>` : ''}
      <span class="dsp"></span>
      ${docsApprove(m) && ME && ME.pinRequired ? '<button class="btn2 small" data-dact="mypin" title="Change your signing PIN">My PIN</button>' : ''}
      ${docsApprove(m) ? '<button class="btn2 small" data-dact="csv" title="Copies the register in the order of Document_Register.xlsx">Copy Register As CSV</button>' : ''}
      ${docsManage(m) ? '<button class="btn small" data-dact="add">Add Document</button>' : ''}</div>
    <div data-dz="chips">${docsChipsHtml(m)}</div><div data-dz="tbl">${docsTableHtml(m)}</div><div class="hint dcount" data-dz="count">${docsCount(m)}</div>`
};
// panels slide up to close the gap when one is hidden (the summary tiles are for approvers only)
function docsLayoutWithout(L, hide){
  const P = {}; for(const k in L.panels) if(!hide.includes(k)) P[k] = L.panels[k].slice();
  const ks = Object.keys(P).sort((a, b) => P[a][1] - P[b][1] || P[a][0] - P[b][0]), hit = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
  for(const k of ks){ while(P[k][1] > 1){ P[k][1]--; if(ks.some(q => q !== k && hit(P[k], P[q]))){ P[k][1]++; break; } } }
  return { v: 2, cols: LAYOUT_COLS, panels: P };
}
function docsHtml(m, c){
  const hide = [...(docsApprove(m) && m.view === 'docs' ? [] : ['tiles']), ...(m.pins.length ? [] : ['pins'])], pg = Object.assign({}, DOCS_PAGE, { panels: DOCS_PANELS.filter(p => !hide.includes(p[0])) });
  const base = c && c.panels ? { v: 2, cols: LAYOUT_COLS, panels: c.panels } : (layoutOk(DOCS_PAGE, DOCS_LAYOUT) ? DOCS_LAYOUT : null);
  return layoutGridHtml(pg, base ? docsLayoutWithout(base, hide) : undefined, id => DOCS_BODY[id](m));
}
const DOCS_SAMPLE_MODEL = () => {
  const m = docsNewModel(), t = '2026-11-18', ago = n => { const d = new Date(Date.UTC(2026, 10, 18 - n)); return d.toISOString().slice(0, 10); };
  const V = (v, state, eff, o) => Object.assign({ v, state, effective: eff, at: eff || t, summary: 'Initial Release', by: 'Pat Owner', approvedBy: 'Pat Owner', hasFile: true }, o || {});
  const D = (id, title, o) => Object.assign({ id, title, type: id.slice(0, 3), area: id.slice(4, 7), sub: '', format: 'Printable PDF', cycle: 12, basis: 'Internal Policy', notes: '', underReview: false, retired: false, lastReviewed: '', reviews: [], versions: [] }, o);
  m.duty = 'owner'; m.today = t; m.pharmacy = 'NorTex Pharmacy - Haslet'; m.pins = ['FRM-IMM-001'];
  m.docs = [D('POL-OPS-001', 'Policy And Procedure Manual Overview', { lastReviewed: ago(120), versions: [V('1.0', 'current', ago(300))] }),
    D('SOP-CSA-001', 'Controlled Substance Receiving And Storage', { lastReviewed: ago(372), versions: [V('1.0', 'current', ago(380))] }),
    D('FRM-IMM-001', 'Vaccine Consent And Screening - General', { format: 'Fillable PDF', lastReviewed: ago(20), versions: [V('1.0', 'current', ago(20))] }),
    D('MFR-NSC-001', 'Hydroquinone Cream (Example Product)', { lastReviewed: ago(90), versions: [V('1.0', 'superseded', ago(240)), V('1.1', 'current', ago(90)), V('1.2', 'pending', '', { summary: 'Updated wording', approvedBy: '' })] }),
    D('SOP-HDR-001', 'Hazardous Drug Handling And Spill Response', { versions: [V('1.0', 'pending', '', { approvedBy: '' })] }),
    D('LOG-OPS-002', 'Delivery Log', { lastReviewed: ago(335), versions: [V('1.0', 'current', ago(350))], underReview: true }),
    D('SOP-OPS-002', 'Will-Call Procedure (Legacy)', { retired: true, lastReviewed: ago(600), versions: [V('1.0', 'current', ago(900))] })];
  return m;
};

/* ---------------- live page: loads, refreshes and acts ---------------- */
let DOCS = docsNewModel(), DOCS_STORE = '';
const dzq = s => document.querySelector('#docsRoot ' + s);
const docOf = id => DOCS.docs.find(d => d.id === id);
const docsPath = () => '/stores/' + encodeURIComponent(STORE.id) + '/documents';
const docsOK = () => !!(ME && STORE && STORE.documents === true && PERM('documents'));
function docsPaint(){                                            // the whole page (after loading, or when something changed that touches several panels)
  const r = $('docsRoot'); if(!r) return;
  r.innerHTML = docsHtml(DOCS, {}); docsHook();
}
function docsHook(){ const q = dzq('[data-dq]'); if(q) q.addEventListener('input', e => { DOCS.q = e.target.value; docsUpdate(); }); }
function docsUpdate(){                                           // refresh only the regions that depend on the data or filters
  if(!dzq('[data-dz]')) return;
  const set = (z, h) => { const e = dzq(`[data-dz="${z}"]`); if(e) e.innerHTML = h; };
  set('rail', docsRailHtml(DOCS)); set('tiles', docsTilesHtml(DOCS)); set('pins', docsPinsHtml(DOCS)); set('chips', docsChipsHtml(DOCS)); set('tbl', docsTableHtml(DOCS)); set('count', docsCount(DOCS));
}
async function docsLoad(){
  if(!docsOK()) return;
  const id = STORE.id; $('docsMsg').textContent = DOCS.loaded && DOCS_STORE === id ? '' : 'Loading…';
  try{
    const r = await api('GET', docsPath());
    if(!STORE || STORE.id !== id) return;
    const keep = DOCS_STORE === id ? DOCS : docsNewModel();
    DOCS = Object.assign(keep, { duty: r.duty, today: r.today, docs: r.docs, pins: r.pins, log: r.log || [], pharmacy: r.pharmacy, maxMb: r.maxMb, tasksOK: !!r.tasksOK, persOK: !!r.persOK, persAdd: !!r.persAdd, boss: !!r.boss, inspOK: !!r.inspOK, dpChapters: r.dpChapters || [], final: !!r.final, loaded: true }); DOCS_STORE = id;
    $('docsMsg').textContent = ''; docsPaint(); if(DOCS.open && docOf(DOCS.open)) docsDrawer(DOCS.open); else if(DOCS.open) docsCloseDrawer();
  }catch(e){ if(!e.auth) $('docsMsg').textContent = e.message; }
}
function docsShow(){ if(!docsOK()) return; if(!DOCS.loaded || DOCS_STORE !== STORE.id || Date.now() - (DOCS.at || 0) > 60000){ DOCS.at = Date.now(); docsLoad(); } }
function docsPaintTab(){                                         // called whenever the pharmacy or the person changes
  const tab = document.querySelector('#tabs [data-tab="documents"]'); if(!tab) return;
  const ok = docsOK(); tab.style.display = ok ? '' : 'none';
  if(!ok || (DOCS_STORE && STORE && DOCS_STORE !== STORE.id)){ DOCS = docsNewModel(); DOCS_STORE = ''; const r = $('docsRoot'); if(r) r.innerHTML = ''; docsCloseDrawer(); docsCloseModal();
    if(!ok && tab.classList.contains('active')) homeTab(); }
}
const docsToast = t => { const e = $('docsToast'); e.textContent = t; e.style.display = ''; clearTimeout(docsToast.t); docsToast.t = setTimeout(() => e.style.display = 'none', 3200); };
function docsModal(html, wide){ const o = $('docsOv'); o.innerHTML = `<div class="dov" data-dov><div class="dmodal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`; const f = o.querySelector('[autofocus],input:not([type=hidden]),select,textarea'); if(f) f.focus(); }
const docsCloseModal = () => { const o = $('docsOv'); if(o) o.innerHTML = ''; };
const docsCloseCtx = () => { const c = document.getElementById('dctx'); if(c) c.remove(); };
const docsErr = e => { if(!e.auth) docsToast(e.message); };
async function docsDo(path, body, done, redo){                   // one action on a document; the page reloads from the server afterwards so everyone sees the same thing
  try{ const r = await api('POST', docsPath() + path, body || {}); docsCloseModal(); await docsLoad(); if(done) docsToast(done); return r; }
  catch(e){
    if(e.pin === 'pin-not-set' || e.pin === 'pin-temp'){ docsPinModal(e.pin === 'pin-temp' ? 'temp' : 'set', redo); return null; }
    docsErr(e); return null;
  }
}
/* ---- signing: approve, review, reject, retire and restore need the person's own 4-digit PIN. The server checks it, stamps the initials and
   employee ID, and locks the PIN after 5 wrong tries. ---- */
const docsSignField = what => !(ME && ME.pinRequired) ? `<div class="dfld"><div class="hint">${ME && ME.initials ? `Signs this as ${esc(ME.initials)} (${esc(what)}).` : 'Your initials are not set yet. Ask the Account Owner.'}</div></div>` : `<div class="dfld"><label for="sPin">Your PIN</label><input type="password" id="sPin" inputmode="numeric" autocomplete="off" maxlength="4" style="max-width:110px;letter-spacing:.3em;"><div class="hint">${ME && ME.initials ? `Signs this as ${esc(ME.initials)} (${esc(what)}).` : 'Your initials are not set yet. Ask the Account Owner.'}</div></div>`;
const docsPinVal = () => { if(!(ME && ME.pinRequired)) return ''; const v = ($('sPin') || {}).value || ''; if(!/^\d{4}$/.test(v)){ docsToast('Enter your 4-digit PIN.'); return null; } return v; };
function docsPinModal(mode, redo){                               // mode: set (first time), temp (replace the temporary one), change (know the current one)
  const cur = mode !== 'set';
  docsModal(`<h3>${mode === 'change' ? 'Change Your PIN' : 'Choose Your PIN'}</h3><div class="dmb">
    <div class="hint">${mode === 'temp' ? 'Enter the temporary PIN you were given, then choose your own.' : mode === 'change' ? 'Enter your current PIN, then the new one.' : 'A 4-digit code only you know. It signs your approvals and reviews. Not 1234 or 1111.'} Never share it.</div>
    ${cur ? `<div class="dfld"><label for="pCur">${mode === 'temp' ? 'Temporary PIN' : 'Current PIN'}</label><input type="password" id="pCur" inputmode="numeric" autocomplete="off" maxlength="4" style="max-width:110px;letter-spacing:.3em;"></div>` : ''}
    <div class="dg2"><div class="dfld"><label for="pNew">New PIN</label><input type="password" id="pNew" inputmode="numeric" autocomplete="off" maxlength="4" style="letter-spacing:.3em;"></div>
    <div class="dfld"><label for="pNew2">Repeat New PIN</label><input type="password" id="pNew2" inputmode="numeric" autocomplete="off" maxlength="4" style="letter-spacing:.3em;"></div></div></div>
   <div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="pSave">Save PIN</button></div>`);
  $('pSave').addEventListener('click', async () => {
    const n = $('pNew').value, n2 = $('pNew2').value, c = cur ? $('pCur').value : '';
    if(cur && !/^\d{4}$/.test(c)) return docsToast('Enter the ' + (mode === 'temp' ? 'temporary' : 'current') + ' PIN.');
    if(!/^\d{4}$/.test(n)) return docsToast('The new PIN is 4 digits.'); if(n !== n2) return docsToast('The two new PINs do not match.');
    busy($('pSave'), true);
    try{ await api('POST', '/me/pin', { pin: n, current: c }); if(ME) ME.pin = 'set'; docsCloseModal(); docsToast('PIN saved.'); if(redo) redo(); }
    catch(e){ busy($('pSave'), false); docsErr(e); }
  });
}
/* ---- opening and printing the PDF. The link is short-lived and comes from the server; the stored file is never public. ---- */
async function docsOpen(id, v, stamp){
  const w = window.open('', '_blank');                           // opened now, while the click is still fresh, so the browser doesn't block it
  try{
    const qs = [v ? 'v=' + encodeURIComponent(v) : '', stamp ? 'print=1' : ''].filter(Boolean).join('&');
    const r = await api('GET', docsPath() + '/' + encodeURIComponent(id) + '/file' + (qs ? '?' + qs : ''));
    if(!w){ docsToast('Allow pop-ups for this site to open documents.'); return; }
    if(stamp) await docsStampOpen(w, r, id); else w.location = r.url;
  }catch(e){ if(w) w.close(); docsErr(e); }
}
function docsAsset(src){ return new Promise((ok, no) => { if(document.querySelector(`script[data-asset="${src}"]`)) return ok(); const s = document.createElement('script'); s.src = src; s.dataset.asset = src; s.onload = ok; s.onerror = () => no(new Error('Could not load the print tools.')); document.head.appendChild(s); }); }
async function docsStampOpen(w, r, id){                           // "Print Copy": the same PDF with the footer stamp on every page (Doc ID, version, effective date)
  const d = docOf(id), i = docInfo(d, DOCS), v = d.versions.find(x => x.v === r.v);
  if(!v || v.state !== 'current'){ w.location = r.url; docsToast('Only the current version is stamped. Opening it without a stamp.'); return; }
  await docsAsset('pdf-lib.min.js');
  const bytes = await (await fetch(r.url)).arrayBuffer(), pdf = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: false }), font = await pdf.embedFont(PDFLib.StandardFonts.Courier);
  const text = `${d.id}  |  v${v.v}  |  Effective ${v.effective}  |  Printed ${docsLocal(r.printedAt)} by ${r.initials}`;   // time = the server's, shown in the pharmacy's time zone
  for(const pg of pdf.getPages()){ const { width } = pg.getSize(), size = Math.min(7.5, (width - 72) / font.widthOfTextAtSize(text, 1));
    pg.drawLine({ start: { x: 36, y: 26 }, end: { x: width - 36, y: 26 }, thickness: 0.5, color: PDFLib.rgb(0.55, 0.55, 0.55) });
    pg.drawText(text, { x: 36, y: 15, size, font, color: PDFLib.rgb(0.25, 0.25, 0.25) }); }
  w.location = URL.createObjectURL(new Blob([await pdf.save()], { type: 'application/pdf' }));
}
/* ---- the detail drawer ---- */
function docsCloseDrawer(){ DOCS.open = ''; const r = $('docsDrawer'); if(r) r.innerHTML = ''; }
function docsDrawer(id){
  const d = docOf(id); if(!d){ docsCloseDrawer(); return; }
  DOCS.open = id; const m = DOCS, i = docInfo(d, m), man = docsManage(m), appr = docsApprove(m), pn = m.pins.includes(id), area = DOC_AREA_LIST.find(x => x.code === d.area);
  const dis = (ok, why) => ok ? '' : ` disabled title="${esc(why)}"`;
  const apprOk = appr && (!d.dpStep || (m.final && i.pend && (i.pend.dpReview || m.dpChapters.includes(d.chapter)))), apprWhy = !appr ? 'Owner, Pharmacist-In-Charge or Designated Person only' : (d.dpStep && !m.final ? 'Final approval is for the final approver' : 'Waiting for the Designated Person review');
  const vrows = d.versions.slice().reverse().map(v => `<tr><td class="num">v${esc(v.v)}</td><td>${v.state === 'current' ? docPill('ok', 'Current') : v.state === 'pending' ? docPill('warn', 'Pending Approval') : docPill('gray', 'Superseded')}</td><td class="num">${v.effective || '-'}</td><td>${esc(v.by || '-')}</td><td>${esc(v.approvedBy || '-')}${v.approvedIni ? ' (' + esc(v.approvedIni) + ')' : ''}${v.selfApproved ? ' ' + docPill('warn', 'Self-approved') : ''}</td><td title="${esc(v.summary)}">${esc(v.summary)}</td><td><button class="btn2 small" data-dact="openv" data-id="${id}" data-v="${esc(v.v)}"${v.hasFile ? '' : ' disabled'}>Open</button></td></tr>`).join('');
  const rrows = (d.reviews || []).slice().reverse().map(r => `<tr><td class="num">${r.at}</td><td>${esc(r.by)}${r.ini ? ' (' + esc(r.ini) + ')' : ''}</td><td>${esc(r.outcome)}</td><td title="${esc(r.comment)}">${esc(r.comment)}</td></tr>`).join('') || '<tr><td colspan="4" class="hint">No review recorded yet.</td></tr>';
  const act = (m.log || []).filter(l => l.docId === id).slice(0, 8).map(l => `<tr><td class="num">${esc(docsLocal(l.at))}</td><td>${esc(l.by)}${l.ini ? ' (' + esc(l.ini) + (l.emp ? ' ' + esc(l.emp) : '') + ')' : ''}</td><td>${esc(l.action)}${l.flag ? ' ' + docPill('warn', l.flag) : ''}</td><td title="${esc(l.detail)}">${esc(l.detail)}</td></tr>`).join('') || '<tr><td colspan="4" class="hint">No activity yet.</td></tr>';
  const stampTxt = i.cur ? `${d.id}  |  v${i.cur.v}  |  Effective ${i.cur.effective}  |  Printed [date and time] by [initials]` : '';
  $('docsDrawer').innerHTML = `<div class="dov dright" data-ddov><aside class="ddrawer" role="dialog" aria-modal="true" aria-label="Document details">
   <div class="ddh"><div class="drow"><span class="num hint">${d.id}</span><span class="dsp"></span><button class="btn2 small" data-dact="closedrawer">Close</button></div>
    <h2>${esc(d.title)}</h2><div class="drow">${man ? docStatusPill(i.status) : ''}${appr && i.r !== 'n/a' ? docReviewPill(i.r) : ''}${docFormatPill(d.format)}${docPill('gray', DOC_TY[d.type].n)}${i.pend && man ? docPill('warn', 'v' + i.pend.v + ' Awaiting Approval') : ''}</div>
    <div class="drow dacts">
     <button class="btn small" data-dact="openv" data-id="${id}"${i.cur || man ? '' : ' disabled'}>${d.format === 'Fillable PDF' ? 'Open Form' : 'Open'}</button>
     <button class="btn2 small" data-dact="printv" data-id="${id}"${i.cur ? '' : ' disabled'} title="The current version with the footer stamp on every page">Print Copy</button>
     <button class="btn2 small" data-dact="pin" data-id="${id}">${pn ? '★ Unpin' : '☆ Pin'}</button>
     ${d.chapter && i.pend && !i.pend.dpReview && m.dpChapters.includes(d.chapter) ? `<button class="btn small" data-dact="dpreview" data-id="${id}">Designated Person Review</button>` : ''}
     ${man ? `<button class="btn2 small" data-dact="review" data-id="${id}"${dis(appr && (i.status === 'Active' || i.status === 'Under Review'), appr ? 'Only Active documents can be reviewed' : 'Owner, Pharmacist-In-Charge or Designated Person only')}>Mark Reviewed</button>
     <button class="btn2 small" data-dact="newver" data-id="${id}"${dis(!i.pend && i.status !== 'Retired' && i.status !== 'Draft', i.pend ? 'A version is already waiting for approval' : 'Not available for this status')}>Upload New Version</button>
     ${i.pend ? `<button class="btn small" data-dact="approve" data-id="${id}"${dis(apprOk, apprWhy)}>Approve v${esc(i.pend.v)}</button><button class="btn2 small danger" data-dact="reject" data-id="${id}"${dis(appr, 'Owner, Pharmacist-In-Charge or Designated Person only')}>Reject</button>` : ''}
     <button class="btn2 small" data-dact="edit" data-id="${id}">Edit Details</button>
     ${i.status === 'Retired' ? `<button class="btn2 small" data-dact="restore" data-id="${id}"${dis(appr, 'Owner, Pharmacist-In-Charge or Designated Person only')}>Restore</button>` : `<button class="btn2 small danger" data-dact="retire" data-id="${id}"${dis(appr && i.status !== 'Draft', 'Owner, Pharmacist-In-Charge or Designated Person only')}>Retire</button>`}` : ''}</div></div>
   <div class="ddbody">
    <section class="pnl"><h4 class="pt">Details</h4><div class="pb"><dl class="dkv">
      <dt>Type</dt><dd>${DOC_TY[d.type].n}</dd><dt>File Type</dt><dd>${d.format}</dd>
      <dt>Program Area</dt><dd>${area.n} ${esc(area.name)}</dd><dt>Version</dt><dd class="num">${i.version ? 'v' + esc(i.version) : '-'}${i.cur ? '' : ' (not approved)'}</dd><dt>Effective Date</dt><dd class="num">${i.effective || '-'}</dd>
      ${appr ? `<dt>Last Reviewed</dt><dd class="num">${d.lastReviewed || '-'}</dd><dt>Review Cycle</dt><dd>${d.cycle ? d.cycle + ' months' : 'None'}</dd><dt>Next Review Due</dt><dd><span class="num">${i.next || '-'}</span> ${i.next && i.r !== 'n/a' ? `<span class="hint">${docDueText(i)}</span>` : ''}</dd>` : ''}
      ${d.chapter ? `<dt>Chapter</dt><dd>${esc(d.chapter)}${i.pend && d.dpStep ? (i.pend.dpReview ? ` (reviewed by ${esc(i.pend.dpReview.by)})` : ' (waiting for review)') : ''}</dd>` : ''}
      ${man ? `<dt>Regulatory Basis</dt><dd>${esc(d.basis || '-')}</dd>${d.chapter ? '' : '<dt>Chapter</dt><dd>None</dd>'}<dt>Who Can See It</dt><dd>${(d.audience || []).length ? esc(d.audience.map(docsAudLabel).join(', ')) : 'Everyone'}</dd>` : ''}
      <dt>Print Footer Stamp</dt><dd>${i.cur ? `<div class="dstamp">${esc(stampTxt)}</div>` : '<span class="hint">Applied when the version is approved.</span>'}</dd>
      ${man ? `<dt>File Path</dt><dd class="num dsmall">${esc(docPathOf(d, i.version || '1.0'))}</dd>${d.notes ? `<dt>Notes</dt><dd>${esc(d.notes)}</dd>` : ''}` : ''}</dl></div></section>
    ${man ? `<section class="pnl"><h4 class="pt">Versions</h4><div class="dtw"><table class="dtable"><thead><tr><th>Version</th><th>State</th><th>Effective</th><th>Submitted By</th><th>Approved By</th><th>Change Summary</th><th></th></tr></thead><tbody>${vrows}</tbody></table></div></section>` : ''}
    ${appr ? `<section class="pnl"><h4 class="pt">Review History</h4><div class="dtw"><table class="dtable"><thead><tr><th>Date</th><th>Reviewed By</th><th>Outcome</th><th>Comments</th></tr></thead><tbody>${rrows}</tbody></table></div></section>
    <section class="pnl"><h4 class="pt">Activity</h4><div class="dtw"><table class="dtable"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead><tbody>${act}</tbody></table></div></section>
    <section class="pnl"><h4 class="pt">Compliance Calendar Link</h4><div class="pb"><dl class="dkv"><dt>Calendar Track</dt><dd class="num">doc-review|${d.id}</dd><dt>Repeats</dt><dd>${d.cycle ? `Rolling: next due is the last review plus ${d.cycle} months` : 'No review cycle set'}</dd><dt>Status</dt><dd class="hint">Not connected to the Calendar tab yet.</dd></dl></div></section>` : ''}
   </div></aside></div>`;
}
/* ---- right-click / ⋯ menu ---- */
function docsMenu(id, x, y){
  docsCloseCtx(); const d = docOf(id); if(!d) return; const m = DOCS, i = docInfo(d, m), man = docsManage(m), a = docsApprove(m), pn = m.pins.includes(id);
  const up = i.cur || i.pend, due = i.next ? `<span class="num">${i.next}</span>${a && i.r !== 'n/a' ? ' ' + docReviewPill(i.r) : ''}` : (i.status === 'Draft' ? '<span class="hint">Not yet active</span>' : '<span class="hint">None</span>');
  const el = document.createElement('div'); el.id = 'dctx'; el.className = 'dctx'; el.setAttribute('role', 'menu');
  el.innerHTML = `<div class="dctxh"><span class="num hint">${d.id}</span><div class="dctxt">${esc(d.title)}</div></div>
   <dl class="dkv dctxkv"><dt>Uploaded</dt><dd class="num">${up ? (up.at || up.effective || '-') : '-'}</dd><dt>Version</dt><dd class="num">${i.version ? 'v' + esc(i.version) : '-'}${i.cur ? '' : ' (not approved)'}</dd><dt>Type</dt><dd>${DOC_TY[d.type].n}</dd><dt>File Type</dt><dd>${d.format}</dd>${a ? `<dt>Update Due</dt><dd>${due}</dd>` : ''}</dl>
   <div class="dctxsep"></div>
   <button role="menuitem" class="dctxi" data-dact="openv" data-id="${id}"${i.cur || man ? '' : ' disabled'}>Open<span class="hint">Double-click</span></button>
   <button role="menuitem" class="dctxi" data-dact="printv" data-id="${id}"${i.cur ? '' : ' disabled'}>Print Copy</button>
   <button role="menuitem" class="dctxi" data-dact="detail" data-id="${id}">Document Details</button>
   <button role="menuitem" class="dctxi" data-dact="pin" data-id="${id}">${pn ? 'Unpin From Quick Access' : 'Pin To Quick Access'}</button>
   ${man && !i.pend && i.status !== 'Retired' && i.status !== 'Draft' ? `<button role="menuitem" class="dctxi" data-dact="newver" data-id="${id}">Upload New Version</button>` : ''}
   ${a && (i.status === 'Active' || i.status === 'Under Review') ? `<button role="menuitem" class="dctxi" data-dact="review" data-id="${id}">Mark Reviewed</button>` : ''}
   ${a && i.pend ? `<button role="menuitem" class="dctxi" data-dact="approve" data-id="${id}">Approve v${esc(i.pend.v)}</button>` : ''}`;
  $('panel-documents').appendChild(el);
  const w = el.offsetWidth, h = el.offsetHeight; el.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px'; el.style.top = Math.max(8, Math.min(y, innerHeight - h - 8)) + 'px';
  const f = el.querySelector('.dctxi:not([disabled])'); if(f) f.focus();
}
/* ---- windows ---- */
const dOpts = (list, sel, fn) => list.map(x => { const v = fn ? fn(x)[0] : x, l = fn ? fn(x)[1] : x; return `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`; }).join('');
const dBump = (v, kind) => { const [a, b] = v.split('.').map(Number); return kind === 'major' ? (a + 1) + '.0' : a + '.' + (b + 1); };
async function docsUpload(file, path){                           // asks for a one-time upload link, then sends the file straight to private storage
  const r = await api('POST', docsPath() + (path || '/upload-url'), { name: file.name, size: file.size });
  let put; try{ put = await fetch(r.url, { method: 'PUT', headers: r.headers, body: file }); }catch(e){ throw new Error('The file could not be sent. Check the internet and try again.'); }
  if(!put.ok) throw new Error('The file could not be stored (' + put.status + '). Try again.');
  return { key: r.key, name: file.name };
}
async function docsDetectFillable(file){ try{ const t = new TextDecoder('latin1').decode(new Uint8Array(await file.arrayBuffer())); return /\/AcroForm/.test(t); }catch(e){ return null; } }
function docsAddModal(){
  docsModal(`<h3>Add Document</h3><div class="dmb">
   <div class="dwarn">Blank masters only. Do not upload anything containing patient information.</div>
   <div class="dfld"><label for="aFile">PDF File</label><input type="file" id="aFile" accept="application/pdf,.pdf"><div class="hint" id="aDet">Fillable form fields are detected automatically. Up to ${DOCS.maxMb || 25} MB.</div></div>
   <div class="dg2"><div class="dfld"><label for="aType">Document Type</label><select id="aType">${DOC_TYPE_LIST.map(t => `<option value="${t.c}">${t.n}</option>`).join('')}</select></div>
   <div class="dfld"><label for="aArea">Program Area</label><select id="aArea"></select></div></div>
   <div class="dfld" id="aSubWrap" style="display:none"><label for="aSub">Folder</label><select id="aSub"></select></div>
   <div class="dfld"><label for="aTitle">Title</label><input type="text" id="aTitle" maxlength="200" placeholder="Vaccine Consent And Screening - General"></div>
   <div class="dg2"><div class="dfld"><label for="aFmt">Format</label><select id="aFmt">${dOpts(DOC_FORMATS)}</select></div><div class="dfld"><label for="aVer">Version</label><input type="text" id="aVer" value="1.0"></div></div>
   <div class="dg2"><div class="dfld"><label for="aCyc">Review Cycle (Months)</label><input type="number" id="aCyc" min="0" max="120" value="12"><div class="hint">0 = no review cycle.</div></div>
   <div class="dfld"><label for="aBas">Regulatory Basis</label><input type="text" id="aBas" maxlength="200" placeholder="Internal Policy"></div></div>
   <div class="dg2"><div class="dfld"><label for="aChap">Chapter</label><select id="aChap">${dOpts(['', '795', '797', '800'], '', x => [x, x || 'None'])}</select><div class="hint">A Designated Person for the chapter reviews first.</div></div></div>
   <div class="dfld"><label>Who Can See It</label>${docsAudHtml([])}</div>
   <div class="dfld"><label>Will Be Saved As</label><div class="dpath" id="aPath"></div></div>
  </div><div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="aGo">Add As Draft</button></div>`, true);
  const g = id => $(id), nextN = (t, a) => { const p = t + '-' + a + '-', ns = DOCS.docs.filter(d => d.id.startsWith(p)).map(d => +d.id.slice(-3)); return p + String((ns.length ? Math.max(...ns) : 0) + 1).padStart(3, '0'); };
  const refresh = () => { const t = g('aType').value, tt = DOC_TY[t], ar = g('aArea').value || 'OPS', tsub = tt.sub && !DOC_CMPA.includes(tt.sub[0]); g('aSubWrap').style.display = tsub ? '' : 'none';
    if(tsub && g('aSub').dataset.t !== t){ g('aSub').innerHTML = dOpts(tt.sub); g('aSub').dataset.t = t; }
    g('aPath').textContent = docPathOf({ id: nextN(t, ar), title: g('aTitle').value || 'Title', type: t, area: ar, sub: tsub ? g('aSub').value : '' }, g('aVer').value || '1.0'); };
  const fillAreas = () => { const t = g('aType').value, limited = DOC_TY[t].sub && DOC_CMPA.includes(DOC_TY[t].sub[0]), cur = g('aArea').value;
    g('aArea').innerHTML = DOC_AREA_LIST.filter(a => !limited || DOC_CMPA.includes(a.code)).map(a => `<option value="${a.code}"${a.code === cur ? ' selected' : ''}>${a.n} ${esc(a.name)}</option>`).join(''); refresh(); };
  g('aType').addEventListener('change', fillAreas); fillAreas(); ['aArea', 'aSub', 'aTitle', 'aVer'].forEach(k => g(k).addEventListener('input', refresh));
  let file = null;
  g('aFile').addEventListener('change', async e => { file = e.target.files[0] || null; if(!file) return;
    if(!/\.pdf$/i.test(file.name)){ g('aDet').textContent = 'This is not a PDF. Only PDF files are accepted.'; file = null; return; }
    if(file.size > (DOCS.maxMb || 25) * 1048576){ g('aDet').textContent = 'That file is too big.'; file = null; return; }
    const fill = await docsDetectFillable(file); if(fill !== null){ g('aFmt').value = fill ? 'Fillable PDF' : 'Printable PDF'; g('aDet').textContent = fill ? 'Detected: fillable form fields found.' : 'Detected: no form fields. Set to Printable.'; }
    if(!g('aTitle').value) g('aTitle').value = file.name.replace(/\.pdf$/i, '').replace(/_+/g, ' '); refresh(); });
  g('aGo').addEventListener('click', async () => {
    const title = g('aTitle').value.trim(); if(!file) return docsToast('Choose the PDF file.'); if(!title) return docsToast('Enter a title.'); if(!/^\d+\.\d+$/.test(g('aVer').value.trim())) return docsToast('Version must look like 1.0.');
    const t = g('aType').value, tt = DOC_TY[t], btn = g('aGo'); busy(btn, true);
    try{ const f = await docsUpload(file);
      const r = await api('POST', docsPath(), { title, type: t, area: g('aArea').value, sub: tt.sub && !DOC_CMPA.includes(tt.sub[0]) ? g('aSub').value : '', format: g('aFmt').value, version: g('aVer').value.trim(), cycle: g('aCyc').value, basis: g('aBas').value.trim(), chapter: g('aChap').value, audience: docsAudRead(), file: f });
      docsCloseModal(); DOCS.open = r.id; await docsLoad(); docsToast(r.id + ' added as a draft. Approve it to make it Active.');
    }catch(e){ docsErr(e); busy(btn, false); }
  });
}
function docsReviewModal(id){
  const d = docOf(id), i = docInfo(d, DOCS);
  docsModal(`<h3>Mark Reviewed: ${d.id}</h3><div class="dmb"><div class="hint">${esc(d.title)} (v${esc(i.version)}). Next review is ${i.next || 'not set'}.</div>
   <div class="dfld"><label>Outcome</label><div class="dradios"><label><input type="radio" name="out" value="ok" checked> Reviewed, No Changes Needed<br><span class="hint">Resets the review clock. The version does not change.</span></label>
   <label><input type="radio" name="out" value="chg"> Reviewed, Changes Needed<br><span class="hint">Sets the status to Under Review. Upload a new version to finish.</span></label></div></div>
   <div class="dg2"><div class="dfld"><label for="rDate">Review Date</label><input type="date" id="rDate" value="${DOCS.today}" max="${DOCS.today}"></div><div class="dfld"><label>Reviewed By</label><div class="dro">${esc(ME.name || ME.login)}</div></div></div>
   <div class="dfld"><label for="rCom">Comments</label><textarea id="rCom" maxlength="500"></textarea><div class="hint" id="rHint">Optional.</div></div>${docsSignField('Reviewed')}</div>
   <div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="rGo">Sign And Save Review</button></div>`);
  document.querySelectorAll('[name=out]').forEach(r => r.addEventListener('change', () => { $('rHint').textContent = document.querySelector('[name=out]:checked').value === 'chg' ? 'Required: say what needs to change.' : 'Optional.'; }));
  $('rGo').addEventListener('click', () => { const out = document.querySelector('[name=out]:checked').value, com = $('rCom').value.trim();
    if(out === 'chg' && !com) return docsToast('Say what needs to change.'); const pin = docsPinVal(); if(pin === null) return; busy($('rGo'), true);
    docsDo('/' + id + '/review', { outcome: out, date: $('rDate').value, comment: com, pin }, 'Review recorded for ' + id, () => docsReviewModal(id)).then(r => { if(!r) busy($('rGo'), false); }); });
}
function docsNewVerModal(id){
  const d = docOf(id), i = docInfo(d, DOCS);
  docsModal(`<h3>Upload New Version: ${d.id}</h3><div class="dmb"><div class="hint">Current version is v${esc(i.version)}. The new version waits for approval; the current one stays in use until then.</div>
   <div class="dwarn">Blank masters only. No patient information.</div>
   <div class="dfld"><label for="nFile">PDF File</label><input type="file" id="nFile" accept="application/pdf,.pdf"></div>
   <div class="dfld"><label>Kind Of Change</label><div class="dradios"><label><input type="radio" name="kind" value="minor" checked> Minor: wording or formatting only</label><label><input type="radio" name="kind" value="major"> Major: content or requirements changed</label></div></div>
   <div class="dg2"><div class="dfld"><label for="nVer">New Version</label><input type="text" id="nVer" value="${dBump(i.version, 'minor')}"></div><div class="dfld"><label>Submitted By</label><div class="dro">${esc(ME.name || ME.login)}</div></div></div>
   <div class="dfld"><label for="nSum">Change Summary</label><textarea id="nSum" maxlength="300"></textarea><div class="hint">Required. Appears in the version history.</div></div>
   <div class="dpath" id="nPath"></div></div>
   <div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="nGo">Submit For Approval</button></div>`);
  const upd = () => { $('nPath').textContent = docPathOf(d, $('nVer').value || '?'); }; upd();
  document.querySelectorAll('[name=kind]').forEach(r => r.addEventListener('change', () => { $('nVer').value = dBump(i.version, r.value); upd(); })); $('nVer').addEventListener('input', upd);
  $('nGo').addEventListener('click', async () => { const v = $('nVer').value.trim(), sum = $('nSum').value.trim(), f = $('nFile').files[0];
    if(!f) return docsToast('Choose the PDF file.'); if(!/\.pdf$/i.test(f.name)) return docsToast('Only PDF files are accepted.'); if(!/^\d+\.\d+$/.test(v)) return docsToast('Version must look like 1.1.');
    if(d.versions.some(x => x.v === v)) return docsToast('That version number already exists.'); if(!sum) return docsToast('Enter a change summary.');
    busy($('nGo'), true); try{ const up = await docsUpload(f); const r = await docsDo('/' + id + '/version', { version: v, summary: sum, file: up }, 'v' + v + ' is waiting for approval.'); if(!r) busy($('nGo'), false); }catch(e){ docsErr(e); busy($('nGo'), false); } });
}
function docsApproveModal(id){
  const d = docOf(id), i = docInfo(d, DOCS), p = i.pend, self = (p.by || '') === (ME.name || ME.login);
  docsModal(`<h3>Approve v${esc(p.v)}: ${d.id}</h3><div class="dmb"><div class="hint">${esc(d.title)}. Submitted by ${esc(p.by)} on ${p.at}.</div>
   <div class="dinfo"><b>Change Summary:</b> ${esc(p.summary)}</div>
   ${self ? '<div class="dwarn">You submitted this version. Approving your own submission is allowed but is flagged in the activity log.</div>' : ''}
   <div class="dg2"><div class="dfld"><label for="pDate">Effective Date</label><input type="date" id="pDate" value="${DOCS.today}"></div><div class="dfld"><label>Approved By</label><div class="dro">${esc(ME.name || ME.login)}</div></div></div>
   <div class="hint">${i.cur ? `v${esc(i.cur.v)} becomes Superseded. Approval also counts as a review and resets the review clock.` : 'This makes the document Active and starts its review clock.'}</div>${docsSignField('Approved')}</div>
   <div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="pGo">Approve And Publish</button></div>`);
  $('pGo').addEventListener('click', () => { if(!$('pDate').value) return docsToast('Enter an effective date.'); const pin = docsPinVal(); if(pin === null) return; busy($('pGo'), true); docsDo('/' + id + '/approve', { effective: $('pDate').value, pin }, 'v' + p.v + ' is now current.', () => docsApproveModal(id)).then(r => { if(!r) busy($('pGo'), false); }); });
}
function docsReasonModal(id, kind){                              // reject, retire
  const d = docOf(id), p = docInfo(d, DOCS).pend, rej = kind === 'reject';
  docsModal(`<h3>${rej ? `Reject v${esc(p.v)}` : 'Retire'}: ${d.id}</h3><div class="dmb">${rej ? '' : `<div class="hint">${esc(d.title)} leaves the active library. Its files are kept and it can be restored.</div>`}
   <div class="dfld"><label for="tWhy">Reason</label><textarea id="tWhy" maxlength="500"></textarea><div class="hint">Required.${rej ? ' The submitter sees this in the activity log.' : ' Name the replacement document if there is one.'}</div></div>${docsSignField(rej ? 'Rejected' : 'Retired')}</div>
   <div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn danger" id="tGo">${rej ? 'Reject Version' : 'Retire Document'}</button></div>`);
  $('tGo').addEventListener('click', () => { const w = $('tWhy').value.trim(); if(!w) return docsToast('Enter a reason.'); const pin = docsPinVal(); if(pin === null) return; busy($('tGo'), true);
    docsDo('/' + id + '/' + (rej ? 'reject' : 'retire'), { reason: w, pin }, rej ? 'Version rejected.' : id + ' retired.', () => docsReasonModal(id, kind)).then(r => { if(!r) busy($('tGo'), false); }); });
}
function docsRestoreModal(id){
  const d = docOf(id);
  docsModal(`<h3>Restore: ${d.id}</h3><div class="dmb"><div class="hint">${esc(d.title)} returns to the active library.</div>${docsSignField('Restored')}</div>
   <div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="sGo">Sign And Restore</button></div>`);
  $('sGo').addEventListener('click', () => { const pin = docsPinVal(); if(pin === null) return; busy($('sGo'), true); docsDo('/' + id + '/restore', { pin }, id + ' restored.', () => docsRestoreModal(id)).then(r => { if(!r) busy($('sGo'), false); }); });
}
function docsEditModal(id){
  const d = docOf(id);
  docsModal(`<h3>Edit Details: ${d.id}</h3><div class="dmb"><div class="hint">Doc ID, type and program area cannot change, because the ID, folder and calendar link depend on them.</div>
   <div class="dfld"><label for="eTitle">Title</label><input type="text" id="eTitle" maxlength="200" value="${esc(d.title)}"></div>
   <div class="dg2"><div class="dfld"><label for="eCyc">Review Cycle (Months)</label><input type="number" id="eCyc" min="0" max="120" value="${d.cycle}"></div><div class="dfld"><label for="eBas">Regulatory Basis</label><input type="text" id="eBas" maxlength="200" value="${esc(d.basis)}"></div></div>
   <div class="dfld"><label for="eNot">Notes</label><textarea id="eNot" maxlength="1000">${esc(d.notes)}</textarea></div>
   <div class="dg2"><div class="dfld"><label for="eChap">Chapter</label><select id="eChap">${dOpts(['', '795', '797', '800'], d.chapter || '', x => [x, x || 'None'])}</select></div></div>
   <div class="dfld"><label>Who Can See It</label>${docsAudHtml(d.audience || [])}</div></div>
   <div class="dmf"><button class="btn2" data-dact="closemodal">Cancel</button><button class="btn" id="eGo">Save</button></div>`);
  $('eGo').addEventListener('click', () => { const t = $('eTitle').value.trim(); if(!t) return docsToast('Title is required.'); busy($('eGo'), true);
    docsDo('/' + id + '/edit', { title: t, cycle: $('eCyc').value, basis: $('eBas').value.trim(), notes: $('eNot').value.trim(), chapter: $('eChap').value, audience: docsAudRead() }, 'Saved.').then(r => { if(!r) busy($('eGo'), false); }); });
}
const docsCsv = () => {
  const m = DOCS, out = [['Doc ID', 'Title', 'Doc Type', 'Program Area', 'Format', 'Status', 'Version', 'Effective Date', 'Last Reviewed', 'Review Cycle (Months)', 'Next Review Due', 'Days Until Due', 'Review Status', 'Approver', 'Regulatory Basis', 'Applies To (Site)', 'Supersedes', 'File Path', 'Calendar Item ID', 'Notes']];
  m.docs.forEach(d => { const i = docInfo(d, m), a = DOC_AREA_LIST.find(x => x.code === d.area);
    out.push([d.id, d.title, DOC_TY[d.type].n, a.n + ' ' + a.name, d.format, i.status, i.version, i.effective, d.lastReviewed, d.cycle, i.next || '', i.days == null ? '' : i.days, i.r === 'n/a' ? 'n/a' : i.r, i.cur ? i.cur.approvedBy || '' : '', d.basis, m.pharmacy,
      d.versions.filter(v => v.state === 'superseded').map(v => 'v' + v.v).join(' '), docPathOf(d, i.version || '1.0'), i.status === 'Active' ? 'doc-review|' + d.id : '', d.notes]); });
  return out.map(r => r.map(v => { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\n');
};
async function docsCopy(txt, label){
  try{ await navigator.clipboard.writeText(txt); docsToast(label + ' copied.'); }
  catch(e){ docsModal(`<h3>Copy ${esc(label)}</h3><div class="dmb"><div class="hint">The browser blocked automatic copying. Select all and copy.</div><textarea id="cpTa" style="min-height:260px;font:12px Consolas,monospace">${esc(txt)}</textarea></div><div class="dmf"><button class="btn2" data-dact="closemodal">Close</button></div>`); const t = $('cpTa'); t.focus(); t.select(); }
}
async function docsPin(id){
  const k = DOCS.pins.indexOf(id); if(k < 0) DOCS.pins.push(id); else DOCS.pins.splice(k, 1);
  if(DOCS.pins.length <= 1) docsPaint(); else docsUpdate(); if(DOCS.open) docsDrawer(DOCS.open);
  try{ await api('POST', docsPath() + '/pins', { ids: DOCS.pins }); }catch(e){ docsErr(e); }
}
const DOCS_ACT = {
  type: id => { DOCS.type = id; if(DOCS.view !== 'docs'){ DOCS.view = 'docs'; docsPaint(); } else docsUpdate(); }, view: id => docsView(id), dpreview: id => docsDpModal(id),
  tfile: (id) => docsFileOpen('/tasks/file/' + encodeURIComponent(id)), mfile: id => docsFileOpen('/mine/' + encodeURIComponent(id) + '/file'), pfile: (id, t) => docsFileOpen('/personnel/' + encodeURIComponent(t.dataset.p) + '/file/' + encodeURIComponent(id)),
  inspnew: () => docsInspNewModal(), inspext: id => docsInspExpiryModal(id), insprev: id => docsInspRevoke(id),
  mremove: id => docsMineRemove(id), madd: () => docsMineAddModal(false), padd: () => docsMineAddModal(true), persopen: id => docsPersOpen(id), perback: () => { DOCS.persSel = null; docsPaint(); }, showret: () => { DOCS.fstatus = 'Retired'; docsPaint(); },
  tile: id => { DOCS.fstatus = ''; DOCS.freview = ''; DOCS.fpend = false; DOCS.showRetired = false; if(id === 'Overdue' || id === 'Due Soon') DOCS.freview = id; else if(id === 'pend') DOCS.fpend = true; else if(id === 'Under Review') DOCS.fstatus = 'Under Review'; else DOCS.fstatus = 'Active'; docsPaint(); },
  clr: id => { ({ type: () => DOCS.type = 'all', fstatus: () => DOCS.fstatus = '', fformat: () => DOCS.fformat = '', freview: () => DOCS.freview = '', fpend: () => DOCS.fpend = false, showRetired: () => DOCS.showRetired = false })[id](); docsPaint(); },
  clrall: () => { DOCS.type = 'all'; DOCS.fstatus = DOCS.fformat = DOCS.freview = ''; DOCS.fpend = false; DOCS.showRetired = false; DOCS.q = ''; docsPaint(); },
  sort: id => { DOCS.sort = DOCS.sort.k === id ? { k: id, d: -DOCS.sort.d } : { k: id, d: 1 }; docsUpdate(); },
  open: id => docsOpen(id), openv: (id, t) => docsOpen(id, t.dataset.v || ''), printv: id => docsOpen(id, '', true), detail: id => docsDrawer(id),
  menu: (id, t) => { const r = t.getBoundingClientRect(); DOCS.sel = id; docsMenu(id, r.left - 300, r.bottom + 2); },
  pin: id => docsPin(id), add: () => docsAddModal(), review: id => docsReviewModal(id), newver: id => docsNewVerModal(id), approve: id => docsApproveModal(id),
  reject: id => docsReasonModal(id, 'reject'), retire: id => docsReasonModal(id, 'retire'), edit: id => docsEditModal(id), restore: id => docsRestoreModal(id), mypin: () => docsPinModal('change'),
  closemodal: () => docsCloseModal(), closedrawer: () => docsCloseDrawer(), csv: () => docsCopy(docsCsv(), 'Register')
};
function docsInit(){                                             // once, when the page loads
  const root = $('panel-documents'); if(!root) return;
  root.addEventListener('click', e => {
    docsCloseCtx();
    if(e.target.closest('[data-ddov]') && e.target.matches('[data-ddov]')){ docsCloseDrawer(); return; }
    const t = e.target.closest('[data-dact]'); if(!t || t.disabled) return; if(t.tagName === 'A') e.preventDefault();
    const f = DOCS_ACT[t.dataset.dact]; if(f) f(t.dataset.id, t, e);
  });
  root.addEventListener('change', e => { const t = e.target;
    if(t.matches('[data-dfs]')){ DOCS.fstatus = t.value; docsUpdate(); } else if(t.matches('[data-dff]')){ DOCS.fformat = t.value; docsUpdate(); }
    else if(t.matches('[data-grant]')){ docsGrant(t.dataset.grant, t.dataset.sub, t.checked); }
    else if(t.matches('[data-dfr]')){ DOCS.freview = t.value; docsUpdate(); } else if(t.matches('[data-dret]')){ DOCS.showRetired = t.checked; docsUpdate(); } });
  root.addEventListener('dblclick', e => { const tr = e.target.closest('tr[data-row]'); if(!tr || e.target.closest('button')) return; docsCloseCtx(); docsOpen(tr.dataset.row); });
  root.addEventListener('contextmenu', e => { const tr = e.target.closest('tr[data-row]'); if(!tr) return; e.preventDefault(); DOCS.sel = tr.dataset.row; docsMenu(tr.dataset.row, e.clientX, e.clientY); });
  document.addEventListener('keydown', e => {
    if(!root.classList.contains('active')) return;
    const ctx = document.getElementById('dctx');
    if(ctx && (e.key === 'ArrowDown' || e.key === 'ArrowUp')){ e.preventDefault(); const it = [...ctx.querySelectorAll('.dctxi:not([disabled])')], k = it.indexOf(document.activeElement); it[(k + (e.key === 'ArrowDown' ? 1 : -1) + it.length) % it.length].focus(); return; }
    if(e.key === 'Escape'){ if(ctx) ctx.remove(); else if($('docsOv').innerHTML) docsCloseModal(); else if(DOCS.open) docsCloseDrawer(); return; }
    if(e.key === 'Enter' && document.activeElement && document.activeElement.matches('tr[data-row]')) docsOpen(document.activeElement.dataset.row); });
  addEventListener('scroll', docsCloseCtx, true); addEventListener('resize', docsCloseCtx);
}

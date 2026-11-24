/* Inspector view: read only. The long address (after #) is the key; nothing here can change anything. Every open is logged by the server. */
(function(){
  const CFG = window.NORTEX_CONFIG || {}, TOKEN = decodeURIComponent((location.hash || '').replace(/^#/, '')), $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ROLE = { pic: 'Pharmacist-In-Charge', pharmacist: 'Pharmacist', tech: 'Technician', staff: 'Associate', '': '' };
  const TYPE = { POL: 'Policy', SOP: 'SOP', FRM: 'Form', MFR: 'MFR', CMP: 'Compounding Record', LOG: 'Log', CHK: 'Checklist', TRN: 'Training Material' };
  let META = null, TAB = 'summary', CACHE = {}, REP = null;
  async function get(what, arg){
    const r = await fetch((CFG.apiUrl || '/api') + '/public/inspect/' + encodeURIComponent(TOKEN) + '/' + what + (arg ? '/' + encodeURIComponent(arg) : ''));
    const j = await r.json().catch(() => ({})); if(!r.ok){ const e = new Error(j.error || 'This link is not valid.'); e.code = r.status; throw e; } return j;
  }
  const local = ms => new Date(ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const tbl = (head, rows, empty) => rows.length ? `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>` : `<div class="hint">${empty || 'None.'}</div>`;
  const lic = l => (l || []).map(x => `${esc(x.state)} ${esc(x.type || '')} ${esc(x.number)}${x.expires ? ', expires ' + esc(x.expires) : ''}`).join('<br>') || '-';
  const metrics = s => `<div class="tiles"><div class="tile"><div class="n">${s.completed}</div><div class="l">Approved Task Records</div></div><div class="tile"><div class="n">${s.corrected}</div><div class="l">Corrected</div></div>
    <div class="tile"><div class="n">${s.excursions}</div><div class="l">Excursions</div></div><div class="tile"><div class="n">${s.missed}</div><div class="l">Missed Entries</div></div><div class="tile"><div class="n">${s.open}</div><div class="l">Still Open</div></div></div>
    <h2>By Task Type</h2>${tbl(['Task', 'Records'], s.byType.map(t => `<tr><td>${esc(t.title)}</td><td class="n">${t.n}</td></tr>`), 'No approved records in this period.')}`;
  const logRows = rows => tbl(['Date', 'Performed By', 'Result', 'Approved By', ''], rows.map(r => `<tr><td class="n">${esc(r.date)}</td><td>${esc(r.performedBy)}</td><td>${esc(r.result)}</td><td>${esc(r.approvedBy)}</td><td>${r.corrected ? '<span class="pill warn">Corrected</span>' : ''}</td></tr>`));
  const excRows = ex => tbl(['Date', 'Kind', 'What Happened', 'Handling', 'Status'], ex.map(e => `<tr><td class="n">${esc(e.date)}</td><td>${e.kind === 'missed' ? 'Missed Entry' : 'Excursion'}</td><td>${esc(e.what)}</td><td>${esc(e.handling)}</td><td>${esc(e.status)}${e.reconciliation ? '<br><span class="hint">' + esc(e.reconciliation) + '</span>' : ''}</td></tr>`), 'None in this period.');
  const docRows = (docs, withOpen) => tbl(['Doc ID', 'Title', 'Type', 'Version', 'Approved', 'Next Review', ...(withOpen ? [''] : [])], docs.map(d => `<tr><td class="n">${esc(d.id)}</td><td>${esc(d.title)}</td><td>${esc(TYPE[d.type] || d.type)}</td><td class="n">v${esc(d.version)}</td><td class="n">${esc(d.effective)}</td><td class="n">${esc(d.nextReview)}</td>${withOpen ? `<td>${d.hasFile ? `<button class="b2" data-open="${esc(d.id)}">Open</button>` : ''}</td>` : ''}</tr>`), 'No approved documents.');
  const persBlock = p => `<h2>${esc(p.name)}</h2><div class="hint">${esc(ROLE[p.acctType] || p.acctType)}${p.license ? ' · License ' + esc(p.license) : ''}${p.licExpires ? ' · Expires ' + esc(p.licExpires) : ''}${Object.keys(p.dp || {}).filter(k => p.dp[k]).length ? ' · Designated Person: ' + Object.keys(p.dp).filter(k => p.dp[k]).join(', ') : ''}</div>${tbl(['Date', 'Training Or Validation', 'Result'], (p.records || []).map(r => `<tr><td class="n">${esc(r.date)}</td><td>${esc(r.type)}</td><td>${esc(r.result)}</td></tr>`), 'No approved training or validation records.')}`;
  const VIEWS = {
    summary: d => `<div class="card"><h2>Dashboard</h2><div class="hint">Period ${esc(d.period.from)} to ${esc(d.period.to)}</div><div style="margin-top:12px">${metrics(d)}</div></div>`,
    logs: d => `<div class="card">${d.logs.length ? d.logs.map(g => `<h2>${esc(g.title)}</h2>${logRows(g.rows)}`).join('') : '<div class="hint">No approved records in this period.</div>'}<h2>Excursions And Missed Entries</h2>${excRows(d.exceptions)}</div>`,
    docs: d => `<div class="card"><h2>Document Register</h2>${docRows(d.docs, META && META.docs)}${META && META.docs ? '' : '<div class="hint" style="margin-top:8px">This link shows the register only.</div>'}</div>`,
    personnel: d => `<div class="card">${d.people.map(persBlock).join('')}</div>`,
    report: () => `<div class="card"><div class="bar"><button class="b" id="prt">Print Report</button><select id="prtOpt"><option value="reg">Register Only</option>${META && META.docs ? '<option value="docs">Register Plus Documents</option>' : ''}</select><span class="hint" id="prtMsg"></span></div>
      <div class="hint">Cover page, dashboard, task logs by type, document register, and one page per person.</div></div>`
  };
  function reportHtml(r){
    const ph = r.pharmacy;
    return `<div class="pg cover"><h1>${esc(ph.name)}</h1><div>Compliance Report</div><div class="kv"><b>Address</b> ${esc(ph.address)}<br><b>Phone</b> ${esc(ph.phone)}<br><b>NPI</b> ${esc(ph.npi)} &nbsp; <b>DEA</b> ${esc(ph.dea)}<br><b>Licenses</b><br>${lic(ph.licenses)}<br><br><b>Report Period</b> ${esc(r.period.from)} to ${esc(r.period.to)}<br><b>Prepared For</b> ${esc(r.meta.label)}<br><b>Generated By</b> ${esc(r.meta.by)}<br><b>Generated</b> ${esc(local(Date.parse(r.generatedAt)))}</div></div>
      <div class="pg"><h2>Dashboard</h2>${metrics(r)}</div>
      <div class="pg"><h2>Task Logs</h2>${r.logs.map(g => `<h2>${esc(g.title)}</h2>${logRows(g.rows)}`).join('')}<h2>Excursions And Missed Entries</h2>${excRows(r.exceptions)}</div>
      <div class="pg"><h2>Document Register</h2>${docRows(r.docs, false)}</div>` + r.people.map(p => `<div class="pg">${persBlock(p)}</div>`).join('');
  }
  async function openDoc(id){ const w = window.open('', '_blank'); try{ const r = await get('file', id); if(w) w.location = r.url; }catch(e){ if(w) w.close(); alert(e.message); } }
  async function packet(docs, msg){                              // the approved documents merged into one PDF to print after the report
    const out = await PDFLib.PDFDocument.create(); let n = 0;
    for(const d of docs.filter(x => x.hasFile)){ msg.textContent = 'Adding ' + d.id + '…';
      try{ const r = await get('file', d.id), bytes = await (await fetch(r.url)).arrayBuffer(), src = await PDFLib.PDFDocument.load(bytes); (await out.copyPages(src, src.getPageIndices())).forEach(p => out.addPage(p)); n++; }catch(e){}
    }
    if(!n) return null; return URL.createObjectURL(new Blob([await out.save()], { type: 'application/pdf' }));
  }
  async function show(t){
    TAB = t; document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.t === t ? 'true' : 'false'));
    const app = $('app'); if(!CACHE[t] && t !== 'report') app.innerHTML = '<div class="msg">Loading…</div>';
    try{
      const d = t === 'report' ? {} : (CACHE[t] || (CACHE[t] = await get(t))); META = d.meta || META; if(META){ $('ro').textContent = 'Read only · link ends ' + local(META.expiresAt); }
      if(TAB !== t) return; app.innerHTML = VIEWS[t](d);
      if(t === 'docs') app.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openDoc(b.dataset.open)));
      if(t === 'report'){ $('prt').addEventListener('click', async () => {
        const opt = $('prtOpt').value, msg = $('prtMsg'), btn = $('prt'); btn.disabled = true; msg.textContent = 'Preparing…';
        try{ REP = REP || await get('report'); $('rep').innerHTML = reportHtml(REP); let url = null; if(opt === 'docs') url = await packet(REP.docs, msg); msg.textContent = ''; window.print();
          if(url) window.open(url, '_blank'); else if(opt === 'docs') msg.textContent = 'No document files to add.'; }
        catch(e){ msg.textContent = e.message; } btn.disabled = false; }); }
    }catch(e){ app.innerHTML = `<div class="msg">${esc(e.message)}</div>`; if(e.code === 404 || e.code === 410) $('tabs').style.display = 'none'; }
  }
  document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => show(b.dataset.t)));
  (async () => {
    if(!TOKEN){ $('app').innerHTML = '<div class="msg">This link is not valid.</div>'; return; }
    try{ const d = await get('summary'); CACHE.summary = d; META = d.meta; $('ph').textContent = d.pharmacy.name; $('tabs').style.display = ''; $('ro').textContent = 'Read only · link ends ' + local(META.expiresAt); await show('summary'); }
    catch(e){ $('app').innerHTML = `<div class="msg">${esc(e.message)}</div>`; }
  })();
})();

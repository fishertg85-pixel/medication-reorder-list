/* ---------------- Rx Intake tab (named users only, same list as Calendar and Documents) ----------------
   The form is its own page (rx.html) shown inside this one. It gets the pharmacy details, the receiving pharmacists, the shared directory
   of pharmacies and prescribers, and the NPI / address lookups from window.ILRX_HOST below. Patient fields, Rx data and PDFs never leave the
   form's page: nothing about a patient is sent to the server. The server checks every request against the named-user list. */
const RX = {loadedAt: 0};
const rxOK = () => !!(ME && STORE && STORE.rx === true);
const rxPath = tail => '/stores/' + encodeURIComponent(STORE.id) + '/rx/' + tail;
window.ILRX_HOST = {
  get canEditStaff(){ return !!(ME && ME.owner); },
  async config(){ if(!rxOK()) throw new Error('Rx Intake is not available for this login at this pharmacy.'); return await api('GET', rxPath('config')); },
  async dirSave(kind, rec){ const r = await api('POST', rxPath('dir/save'), {kind, rec}); return r.rec; },
  async dirImport(d){ return await api('POST', rxPath('dir/import'), {ph: d.ph || [], pr: d.pr || []}); },
  async staffSave(s){ return await api('POST', rxPath('staff'), s); },
  async lookup(url){ const r = await api('POST', rxPath('lookup'), {url}); return r.data; }
};
function rxShow(){                                                // called when the Rx Intake tab is opened
  const f = $('rxFrame'); if(!rxOK()) return;
  if(!f.getAttribute('src') || f.getAttribute('src') === 'about:blank' || f.dataset.store !== STORE.id){ f.dataset.store = STORE.id; RX.loadedAt = Date.now(); f.src = 'rx.html?v=' + Date.now(); }
}
function rxPaint(){                                               // called whenever the pharmacy or the person changes
  const tab = document.querySelector('#tabs [data-tab="rx"]'); if(!tab) return;
  const ok = rxOK(); tab.style.display = ok ? '' : 'none';
  const f = $('rxFrame');
  if(!ok || (f.dataset.store && STORE && f.dataset.store !== STORE.id)){
    f.removeAttribute('data-store'); f.src = 'about:blank';       // closing the page discards any form and PDFs held in it
    if(tab.classList.contains('active')) document.querySelector('#tabs [data-tab="list"]').click();
  }
}

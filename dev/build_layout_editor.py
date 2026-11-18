# Builds dev/layout_editor.html: a single-file page that shows the host's pharmacy setup page panels on a snap-to-grid canvas.
# It uses the app's own CSS and panel code (app/src/parts/pharm_panels.js), so what you arrange is what the app shows.
# Output: a layout code to paste back; it is baked into the app as PAGE.layout. Not shipped in the deployment package.
import re, os
HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, '..', 'app')
css = '\n'.join(re.findall(r'<style>([\s\S]*?)</style>', open(os.path.join(APP, 'web', 'index.html')).read()))
import sys
# Pages the editor can lay out (the standard for every page of the suite). To add one: its src/parts/<page>_panels.js defines a PAGE (see layout_engine.js) and a sample.
PAGES = {'pharm': {'file': 'pharm_panels.js', 'var': 'PHARM_PAGE', 'out': 'layout_editor.html', 'title': 'Host Pharmacy Setup Page'},
         'pharm_owner': {'file': 'pharm_panels.js', 'var': 'PHARM_OWNER_PAGE', 'out': 'layout_editor_owner.html', 'title': 'Account Owner Pharmacy Page'},
         'client': {'file': 'client_panels.js', 'deps': ['pharm_panels.js'], 'var': 'CLIENT_PAGE', 'out': 'layout_editor_client.html', 'title': 'Host Account (Client) Setup Page'}}
PG = PAGES[sys.argv[1] if len(sys.argv) > 1 else 'pharm']
panels = open(os.path.join(APP, 'src', 'parts', 'layout_engine.js')).read() + '\n' + ''.join(open(os.path.join(APP, 'src', 'parts', d)).read() + '\n' for d in PG.get('deps', [])) + open(os.path.join(APP, 'src', 'parts', PG['file'])).read() + '\nconst PAGE = ' + PG['var'] + ';'
tz = re.search(r"const TZ_NAMES = \{[\s\S]*?\};", open(os.path.join(APP, 'src', 'parts', 'state.js')).read()).group(0)
EDITOR_CSS = r'''
body{margin:0;background:var(--bg,#eef3f8);}
#bar{position:sticky;top:0;z-index:30;background:#0e2238;color:#fff;padding:8px 14px;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;font-size:13px;}
#bar b{font-size:14px;} #bar select,#bar button{font-size:13px;padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.35);background:rgba(255,255,255,.1);color:#fff;cursor:pointer;font-family:inherit;}
#bar select option{color:#000;} #bar button:disabled{opacity:.4;cursor:default;} #bar .sp{flex:1;} #bar label{display:flex;align-items:center;gap:5px;}
#msg{font-weight:600;color:#ffd77a;min-height:1em;}
#help{max-width:1100px;margin:10px 20px 0;font-size:13px;color:var(--muted);line-height:1.5;}
#vp{margin:10px auto 0;padding:0 20px;box-sizing:content-box;}
#vp .pcard{margin-bottom:12px;}
.pgrid.force-stack{display:block !important;} .pgrid.force-stack .pnl{margin-bottom:10px;} .pgrid.force-grid{display:grid !important;}
.pgrid.guides{background-image:repeating-linear-gradient(to right,rgba(43,108,176,.10) 0,rgba(43,108,176,.10) calc((100% - 132px)/12),transparent calc((100% - 132px)/12),transparent calc((100% - 132px)/12 + 12px));}
.pnl{position:relative;} .pnl .pb{pointer-events:none;user-select:none;} .pnl .pt{cursor:grab;touch-action:none;display:flex;justify-content:space-between;} .pnl .pt small{font-weight:400;opacity:.7;letter-spacing:0;text-transform:none;}
.pnl.drag{box-shadow:0 0 0 3px #2b6cb0;z-index:5;} .pnl.drag .pt{cursor:grabbing;}
.rz{position:absolute;background:#2b6cb0;opacity:.45;touch-action:none;border-radius:4px;z-index:3;} .rz:hover{opacity:1;}
.rz[data-s=e]{right:-6px;top:20%;bottom:20%;width:11px;cursor:ew-resize;} .rz[data-s=w]{left:-6px;top:20%;bottom:20%;width:11px;cursor:ew-resize;}
.rz[data-s=s]{bottom:-6px;left:20%;right:20%;height:11px;cursor:ns-resize;} .rz[data-s=n]{top:-6px;left:20%;right:20%;height:11px;cursor:ns-resize;}
.rz[data-s=se]{right:-7px;bottom:-7px;width:16px;height:16px;cursor:nwse-resize;} .rz[data-s=nw]{left:-7px;top:-7px;width:16px;height:16px;cursor:nwse-resize;}
.rz[data-s=ne]{right:-7px;top:-7px;width:16px;height:16px;cursor:nesw-resize;} .rz[data-s=sw]{left:-7px;bottom:-7px;width:16px;height:16px;cursor:nesw-resize;}
.force-stack .rz{display:none;}
.pvonly{display:none;}
body.pv .ed,body.pv #help,body.pv #codebox,body.pv .rz,body.pv .pnl .pt small{display:none !important;}
body.pv .pvonly{display:inline-flex;align-items:center;gap:8px;}
body.pv #bar{background:#44546a;}
body.pv .pgrid.guides{background-image:none;}
body.pv .pnl .pb{pointer-events:auto;user-select:auto;} body.pv .pnl .pt{cursor:default;}
body.pv #vp{margin-top:14px;} body.pv #vp .pcard{box-shadow:0 2px 14px rgba(0,0,0,.18);}
#codebox{max-width:1100px;margin:14px 20px 40px;} #codebox textarea{width:100%;box-sizing:border-box;height:84px;font:12px Consolas,monospace;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--input-bg);color:var(--text);}
#codebox .row{display:flex;gap:8px;margin:6px 0;flex-wrap:wrap;align-items:center;} #report{font-size:13px;margin-top:8px;white-space:pre-line;}
'''
SAMPLE_JS = r'''
const SAMPLE = {id:'NTX1', name:'NorTex Pharmacy - Haslet', address:'100 Main St', suite:'Suite 5', city:'Haslet', state:'TX', zip:'76052', phone:'817-555-0100', fax:'817-555-0101', email:'pharmacy@example.com',
  timezone:'America/Chicago', clientId:'IL-000001', entityLegalName:'NorTex Haslet LLC', entityType:'llc', ein:'98-7654321', license:'12345', licenseExpires:'2027-06-30', npi:'1234567893', ncpdp:'1234567', dea:'AB1234563', deaExpires:'2028-03-31', services:['retail','controlled','sterile'],
  hours:[null,{o:'09:00',c:'18:00'},{o:'09:00',c:'18:00'},{o:'09:00',c:'18:00'},{o:'09:00',c:'18:00'},{o:'09:00',c:'18:00'},null], calendar:true, deaVerified:{at:'2026-11-16T12:00:00Z', by:'Pat Owner (owner)'}};
const SAMPLE_NPI = '<div class="npibox"><b>NORTEX PHARMACY LLC</b> <span class="hint">Organization · Active · registry updated 2024-05-01</span><div>100 MAIN ST, STE 5, HASLET, TX 76252 · 817-555-0100 · fax 817-555-0101</div><div class="hint">Pharmacy - Community/Retail Pharmacy · license on file with registry: TX12345 (TX)</div><div class="npiflag">⚠ The registry name differs from the pharmacy name above.</div><button class="btn2 small">Use these details</button></div>';
'''
EDITOR_JS = r'''
const COLS = LAYOUT_COLS, ROW = LAYOUT_ROW, MINH = 6, KEY = 'il_' + PAGE.id + '_layout_v2';
const qs = s => document.querySelector(s);
let L = null, hist = [], showSample = true, widthSel = 'full', pv = false;
const clone = o => JSON.parse(JSON.stringify(o));
try{ const saved = JSON.parse(localStorage.getItem(KEY) || 'null'); if(saved && layoutOk(PAGE, saved)) L = saved; }catch(e){}
if(!L) L = clone(PAGE.layout);
const hit = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
function resolve(P, id, pos){                    // place one panel, push the ones it lands on down, then slide everything up to close gaps
  const Q = clone(P); Q[id] = [pos.x, pos.y, pos.w, pos.h];
  const others = Object.keys(Q).filter(k => k !== id).sort((a, b) => Q[a][1] - Q[b][1] || Q[a][0] - Q[b][0]), placed = [id];
  for(const k of others){ while(placed.some(q => hit(Q[k], Q[q]))) Q[k][1] = Math.max(Q[k][1] + 1, Q[placed.find(q => hit(Q[k], Q[q]))][1] + Q[placed.find(q => hit(Q[k], Q[q]))][3]); placed.push(k); }
  const all = Object.keys(Q).sort((a, b) => Q[a][1] - Q[b][1] || Q[a][0] - Q[b][0]);
  for(const k of all){ while(Q[k][1] > 1){ Q[k][1]--; if(all.some(q => q !== k && hit(Q[k], Q[q]))){ Q[k][1]++; break; } } }
  return Q;
}
function stageWidth(){ const avail = innerWidth - 40; return widthSel === 'full' ? avail : +widthSel; }
const stacked = () => qs('.pgrid').classList.contains('force-stack');
function setStage(w){ const vp = qs('#vp'); vp.style.width = (w - 40 - 26) + 'px'; const g = qs('.pgrid'); if(g){ g.classList.toggle('force-stack', w < 1280); g.classList.toggle('force-grid', w >= 1280); } }
function need(id){ const n = qs(`.pnl[data-pnl="${id}"]`); return Math.ceil((n.querySelector('.pt').offsetHeight + n.querySelector('.pb').offsetHeight + 24) / ROW); }   // rows the content needs (incl. the 12 px gap)
function paint(){
  const card = qs('#vp .pcard'); card.innerHTML = PAGE.render(SAMPLE, L.panels);
  const g = card.querySelector('.pgrid'); if(!pv) g.classList.add('guides');
  if(!pv) g.querySelectorAll('.pnl').forEach(n => { n.insertAdjacentHTML('beforeend', ['n','s','e','w','ne','nw','se','sw'].map(d => `<i class="rz" data-s="${d}"></i>`).join('')); });
  if(showSample && !pv){ const r = g.querySelector('[data-npires]'); if(r) r.innerHTML = SAMPLE_NPI; }
  setStage(stageWidth()); decorate(); if(!stacked()) fit(); code();
}
function fit(){ let ch = false; for(const [id] of PAGE.panels){ const nd = need(id), p = L.panels[id]; if(p[3] < nd){ L.panels = resolve(L.panels, id, { x: p[0], y: p[1], w: p[2], h: nd }); ch = true; decorate(); } } return ch; }
function decorate(){ const g = qs('.pgrid'); let bottom = 0;
  g.querySelectorAll('.pnl').forEach(n => { const p = L.panels[n.dataset.pnl]; n.style.setProperty('--x', p[0]); n.style.setProperty('--y', p[1]); n.style.setProperty('--w', p[2]); n.style.setProperty('--h', p[3]); bottom = Math.max(bottom, p[1] + p[3] - 1);
    const t = n.querySelector('.pt'); let s = t.querySelector('small'); if(!s){ s = document.createElement('small'); t.appendChild(s); } s.textContent = p[2] + ' cols × ' + p[3] * ROW + ' px'; });
  g.style.setProperty('--rows', bottom + 14); }
function code(){ qs('#code').value = JSON.stringify({ v: 2, cols: COLS, panels: L.panels }); try{ localStorage.setItem(KEY, JSON.stringify(L)); }catch(e){} qs('#undo').disabled = !hist.length; }
function say(t){ const m = qs('#msg'); m.textContent = t; clearTimeout(say.t); say.t = setTimeout(() => m.textContent = '', 4000); }
function metrics(){
  const g = qs('.pgrid'), cs = getComputedStyle(g), gap = parseFloat(cs.columnGap) || 12, rect = g.getBoundingClientRect(), W = g.clientWidth;
  const colW = (W - gap * (COLS - 1)) / COLS, rows = cs.gridTemplateRows.split(' ').map(parseFloat).filter(n => !isNaN(n)), tops = []; let t = 0;
  for(const h of rows){ tops.push(t); t += h; }
  return { rect, gap, colW, rows, tops, rowEnd: t };
}
const colAt = (m, px) => Math.max(0, Math.min(COLS - 1, Math.floor((px - m.rect.left) / (m.colW + m.gap))));
const rowAt = (m, py) => { const y = py - m.rect.top; let r = 0; for(let i = 0; i < m.tops.length; i++) if(m.tops[i] <= y) r = i; return r; };
function overflowing(id){ const n = qs(`.pnl[data-pnl="${id}"]`), b = n && n.querySelector('.pb'); return !!b && b.scrollWidth > b.clientWidth + 1; }
let act = null;
document.addEventListener('pointerdown', e => {
  if(stacked() || pv) return;
  const rz = e.target.closest('.rz'), t = e.target.closest('.pt'), n = e.target.closest('.pnl'); if(!n || !(rz || t)) return;
  e.preventDefault(); const id = n.dataset.pnl, p = L.panels[id], m = metrics();
  act = { id, side: rz ? rz.dataset.s : '', start: clone(L.panels), good: clone(L.panels), gc: colAt(m, e.clientX) - (p[0] - 1), gr: rowAt(m, e.clientY) - (p[1] - 1) };
  n.classList.add('drag'); n.setPointerCapture && n.setPointerCapture(e.pointerId);
});
document.addEventListener('pointermove', e => {
  if(!act) return; const { id, side } = act, p = act.good[id], m = metrics(), c = colAt(m, e.clientX) + 1, r = rowAt(m, e.clientY) + 1;
  let [x, y, w, h] = p;
  if(!side){ x = Math.max(1, Math.min(COLS - w + 1, c - act.gc)); y = Math.max(1, r - act.gr); }
  else{
    let x2 = x + w - 1, y2 = y + h - 1;
    if(side.includes('e')) x2 = Math.max(x + 1, Math.min(COLS, c));
    if(side.includes('w')) x = Math.min(x2 - 1, Math.max(1, c));
    if(side.includes('s')) y2 = Math.max(y + MINH - 1, r);
    if(side.includes('n')) y = Math.min(y2 - MINH + 1, Math.max(1, r));
    w = x2 - x + 1; h = y2 - y + 1;
  }
  let Q = resolve(act.good, id, { x, y, w, h }); if(JSON.stringify(Q) === JSON.stringify(L.panels)) return;
  const before = L.panels; L.panels = Q; decorate();
  if(side){
    const nd = need(id);                                   // never shorter than the content
    if(Q[id][3] < nd){ const bottom = Q[id][1] + Q[id][3] - 1, ny = side.includes('n') ? bottom - nd + 1 : Q[id][1]; L.panels = resolve(act.good, id, { x: Q[id][0], y: Math.max(1, ny), w: Q[id][2], h: nd }); decorate(); }
    if(overflowing(id)){ L.panels = before; decorate(); say('Stopped: that would cut off text in ' + (PAGE.panels.find(q => q[0] === id) || [0, id])[1] + '.'); return; }
  }
  act.good = clone(L.panels);
});
document.addEventListener('pointerup', () => {
  if(!act) return; qs('.pnl.drag') && qs('.pnl.drag').classList.remove('drag');
  if(JSON.stringify(act.start) !== JSON.stringify(L.panels)){ hist.push(act.start); paint(); } act = null;
});
document.addEventListener('dblclick', e => {                // double-click a title bar: shrink or grow the box to exactly fit its content
  const n = e.target.closest('.pnl'); if(!n || stacked() || pv) return; const r = n.querySelector('.pt').getBoundingClientRect(); if(e.clientY < r.top || e.clientY > r.bottom) return;   // the panel holds the pointer capture, so test the position
  const id = n.dataset.pnl, p = L.panels[id], nd = need(id);
  if(p[3] !== nd){ hist.push(clone(L.panels)); L.panels = resolve(L.panels, id, { x: p[0], y: p[1], w: p[2], h: nd }); paint(); say('Fitted to its content.'); }
});
const setPreview = on => { pv = on; document.body.classList.toggle('pv', on); paint(); scrollTo(0, 0); };
qs('#preview').onclick = () => setPreview(true); qs('#back').onclick = () => setPreview(false);
addEventListener('keydown', e => { if(e.key === 'Escape' && pv) setPreview(false); });
qs('#undo').onclick = () => { if(hist.length){ L.panels = hist.pop(); paint(); } };
qs('#reset').onclick = () => { hist.push(clone(L.panels)); L.panels = clone(PAGE.layout.panels); paint(); say('Back to the starting layout. Undo brings your layout back.'); };
qs('#copy').onclick = () => { const t = qs('#code'); t.select(); try{ navigator.clipboard.writeText(t.value).then(() => say('Layout code copied.'), () => { document.execCommand('copy'); say('Layout code copied.'); }); }catch(e){ document.execCommand('copy'); say('Layout code copied.'); } };
qs('#apply').onclick = () => { try{ const c = JSON.parse(qs('#code').value); if(!layoutOk(PAGE, c)) throw 0; hist.push(clone(L.panels)); L = c; paint(); say('Layout code applied.'); }catch(e){ say('That layout code is not valid (it must be a version 2 code).'); } };
qs('#width').onchange = e => { widthSel = e.target.value; setStage(stageWidth()); if(!stacked() && fit()) code(); };
qs('#sample').onchange = e => { showSample = e.target.checked; paint(); };
addEventListener('resize', () => setStage(stageWidth()));
qs('#check').onclick = () => {
  const keep = stageWidth(), out = [];
  for(const w of [1920, 1680, 1536, 1366, 1280]){ setStage(w); const bad = PAGE.panels.filter(([id]) => overflowing(id)).map(q => q[1]); const tall = PAGE.panels.filter(([id]) => need(id) > L.panels[id][3]).map(q => q[1]);
    out.push(w + ' px wide: ' + (bad.length ? 'text cut off sideways in ' + bad.join(', ') : 'fits') + (tall.length ? ' (the page grows taller to fit: ' + tall.join(', ') + ')' : '')); }
  setStage(keep); qs('#report').textContent = out.join('\n') + '\nBelow 1280 px wide the panels stack in one column in reading order (top row first, left to right).';
};
paint();
'''
HTML = f'''<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>{PG['title']} Layout Editor</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>{css}</style><style>{EDITOR_CSS}</style></head><body>
<div id="bar"><b>Layout Editor: {PG['title']}</b>
<label>Preview width <select id="width"><option value="full">Full window</option><option value="1920">1920</option><option value="1680">1680</option><option value="1536">1536</option><option value="1366">1366</option><option value="1280">1280</option><option value="1100">1100 (stacked)</option><option value="820">820 (tablet, stacked)</option></select></label>
<label class="ed"><input type="checkbox" id="sample" checked> Show sample registry result</label>
<button id="preview" class="ed" title="See the page as it will look in a browser, without the editing tools">Preview</button><span class="pvonly"><b>Preview: how the page will look</b> <button id="back">Back To Editing</button> <span>(Esc also goes back)</span></span>
<button class="ed" id="undo" disabled>Undo</button><button class="ed" id="reset">Reset To Start</button><button class="ed" id="check">Check All Widths</button><span class="sp"></span><span id="msg"></span><button class="ed" id="copy">Copy Layout Code</button></div>
<div id="help">Drag a panel by its title bar to move it. Drag any blue edge or corner to make it wider, narrower, taller or shorter (width snaps to 12 columns, height to 12 px steps). Double-click a title bar to fit the box to its content. Panels never overlap and never go shorter than their content, so nothing is ever cut off. The page uses the full window width. Sample data is shown; nothing here is saved to the pharmacy.</div>
<div id="vp"><div class="pcard"></div></div>
<div id="codebox"><b>Layout Code</b> <span class="hint">(copy it and send it back to be built into the app; to reload an earlier layout, paste a code here and press Apply)</span>
<textarea id="code" spellcheck="false"></textarea><div class="row"><button class="btn2 small" id="apply">Apply Pasted Code</button></div><div id="report"></div></div>
<script>
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}}[c]));
{tz}
{panels}
{SAMPLE_JS}
{EDITOR_JS}
</script></body></html>'''
out = os.path.join(HERE, PG['out']); open(out, 'w', encoding='utf-8').write(HTML); print('written', out, len(HTML))

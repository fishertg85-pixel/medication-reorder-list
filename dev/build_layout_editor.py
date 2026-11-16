# Builds dev/layout_editor.html: a single-file page that shows the pharmacy account page's panels on a snap-to-grid canvas.
# It uses the app's own CSS and panel code (app/src/parts/pharm_panels.js), so what you arrange is what the app shows.
# Output: a layout code to paste back; it is baked into the app as PHARM_LAYOUT. Not shipped in the deployment package.
import re, os
HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, '..', 'app')
css = '\n'.join(re.findall(r'<style>([\s\S]*?)</style>', open(os.path.join(APP, 'web', 'index.html')).read()))
panels = open(os.path.join(APP, 'src', 'parts', 'pharm_panels.js')).read()
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
.rz{position:absolute;background:#2b6cb0;opacity:.55;touch-action:none;border-radius:4px;} .rz:hover{opacity:1;}
.rz.r{right:-5px;top:25%;bottom:25%;width:9px;cursor:ew-resize;} .rz.b{bottom:-5px;left:25%;right:25%;height:9px;cursor:ns-resize;} .rz.c{right:-6px;bottom:-6px;width:15px;height:15px;cursor:nwse-resize;}
.force-stack .rz{display:none;}
#codebox{max-width:1100px;margin:14px 20px 40px;} #codebox textarea{width:100%;box-sizing:border-box;height:84px;font:12px Consolas,monospace;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--input-bg);color:var(--text);}
#codebox .row{display:flex;gap:8px;margin:6px 0;flex-wrap:wrap;align-items:center;} #report{font-size:13px;margin-top:8px;white-space:pre-line;}
'''
SAMPLE_JS = r'''
const SAMPLE = {id:'NTX1', name:'NorTex Pharmacy - Haslet', address:'100 Main St', suite:'Suite 5', city:'Haslet', state:'TX', zip:'76052', phone:'817-555-0100', fax:'817-555-0101', email:'pharmacy@example.com',
  timezone:'America/Chicago', license:'12345', licenseExpires:'2027-06-30', npi:'1234567893', ncpdp:'1234567', dea:'AB1234563', deaExpires:'2028-03-31', services:['retail','controlled','sterile'],
  hours:[null,{o:'09:00',c:'18:00'},{o:'09:00',c:'18:00'},{o:'09:00',c:'18:00'},{o:'09:00',c:'18:00'},{o:'09:00',c:'18:00'},null], calendar:true, deaVerified:{at:'2026-11-16T12:00:00Z', by:'Pat Owner (owner)'}};
const SAMPLE_NPI = '<div class="npibox"><b>NORTEX PHARMACY LLC</b> <span class="hint">Organization · Active · registry updated 2024-05-01</span><div>100 MAIN ST, STE 5, HASLET, TX 76252 · 817-555-0100 · fax 817-555-0101</div><div class="hint">Pharmacy - Community/Retail Pharmacy · license on file with registry: TX12345 (TX)</div><div class="npiflag">⚠ The registry name differs from the pharmacy name above.</div><button class="btn2 small">Use these details</button> <span class="hint">fills name, address, phone and fax above (the license number is not filled; type it from the state license)</span></div>';
'''
EDITOR_JS = r'''
const COLS = PHARM_COLS, GAPCSS = 12, KEY = 'il_pharm_layout_v1';
const qs = s => document.querySelector(s);
let L = null, hist = [], showSample = true, widthSel = 'full';
const clone = o => JSON.parse(JSON.stringify(o));
try{ const saved = JSON.parse(localStorage.getItem(KEY) || 'null'); if(saved && pharmLayoutOk(saved)) L = saved; }catch(e){}
if(!L) L = clone(PHARM_LAYOUT);
const hit = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
function resolve(P, id, pos){                    // place one panel, push the ones it lands on down, then slide everything up to close gaps
  const Q = clone(P); Q[id] = [pos.x, pos.y, pos.w, pos.h];
  const others = Object.keys(Q).filter(k => k !== id).sort((a, b) => Q[a][1] - Q[b][1] || Q[a][0] - Q[b][0]), placed = [id];
  for(const k of others){ while(placed.some(q => hit(Q[k], Q[q]))) Q[k][1]++; placed.push(k); }
  const all = Object.keys(Q).sort((a, b) => Q[a][1] - Q[b][1] || Q[a][0] - Q[b][0]);
  for(const k of all){ while(Q[k][1] > 1){ Q[k][1]--; if(all.some(q => q !== k && hit(Q[k], Q[q]))){ Q[k][1]++; break; } } }
  return Q;
}
function stageWidth(){ const avail = innerWidth - 40; return widthSel === 'full' ? avail : +widthSel; }
function setStage(w){ const vp = qs('#vp'); vp.style.width = (w - 40 - 26) + 'px'; const g = qs('.pgrid'); if(g){ g.classList.toggle('force-stack', w < 1280); g.classList.toggle('force-grid', w >= 1280); } }
function paint(){
  const card = qs('#vp .pcard'); card.innerHTML = pharmCardHtml(SAMPLE, { logo: '', holder: 'Pat Owner (owner)' }, { panels: L.panels });
  const g = card.querySelector('.pgrid'); g.classList.add('guides');
  g.querySelectorAll('.pnl').forEach(n => { n.insertAdjacentHTML('beforeend', '<i class="rz r"></i><i class="rz b"></i><i class="rz c"></i>'); });
  if(showSample){ const r = g.querySelector('[data-npires]'); if(r) r.innerHTML = SAMPLE_NPI; }
  setStage(stageWidth()); decorate(); code();
}
function decorate(){ qs('.pgrid').querySelectorAll('.pnl').forEach(n => { const p = L.panels[n.dataset.pnl]; n.style.setProperty('--x', p[0]); n.style.setProperty('--y', p[1]); n.style.setProperty('--w', p[2]); n.style.setProperty('--h', p[3]);
  const t = n.querySelector('.pt'); let s = t.querySelector('small'); if(!s){ s = document.createElement('small'); t.appendChild(s); } s.textContent = p[2] + ' × ' + p[3]; }); }
function code(){ qs('#code').value = JSON.stringify({ v: 1, cols: COLS, panels: L.panels }); try{ localStorage.setItem(KEY, JSON.stringify(L)); }catch(e){} qs('#undo').disabled = !hist.length; }
function say(t){ const m = qs('#msg'); m.textContent = t; clearTimeout(say.t); say.t = setTimeout(() => m.textContent = '', 4000); }
function metrics(){
  const g = qs('.pgrid'), cs = getComputedStyle(g), gap = parseFloat(cs.columnGap) || GAPCSS, rg = parseFloat(cs.rowGap) || gap, rect = g.getBoundingClientRect(), W = g.clientWidth;
  const colW = (W - gap * (COLS - 1)) / COLS, rows = cs.gridTemplateRows.split(' ').map(parseFloat).filter(n => !isNaN(n)), tops = []; let t = 0;
  for(const h of rows){ tops.push(t); t += h + rg; }
  return { rect, gap, colW, rows, tops, rowEnd: t };
}
const colAt = (m, px) => Math.max(0, Math.min(COLS - 1, Math.floor((px - m.rect.left) / (m.colW + m.gap))));
const rowAt = (m, py) => { const y = py - m.rect.top; let r = 0; for(let i = 0; i < m.tops.length; i++) if(m.tops[i] <= y) r = i; return y > m.rowEnd ? m.tops.length : r; };
function overflowing(id){ const n = qs(`.pnl[data-pnl="${id}"]`), b = n && n.querySelector('.pb'); return !!b && b.scrollWidth > b.clientWidth + 1; }
let act = null;
document.addEventListener('pointerdown', e => {
  if(qs('.pgrid').classList.contains('force-stack')) return;
  const rz = e.target.closest('.rz'), t = e.target.closest('.pt'), n = e.target.closest('.pnl'); if(!n || !(rz || t)) return;
  e.preventDefault(); const id = n.dataset.pnl, p = L.panels[id], m = metrics();
  act = { id, kind: rz ? (rz.classList.contains('r') ? 'w' : rz.classList.contains('b') ? 'h' : 'wh') : 'move', start: clone(L.panels), good: clone(L.panels), m,
    gc: colAt(m, e.clientX) - (p[0] - 1), gr: rowAt(m, e.clientY) - (p[1] - 1) };
  n.classList.add('drag'); n.setPointerCapture && n.setPointerCapture(e.pointerId);
});
document.addEventListener('pointermove', e => {
  if(!act) return; const { id, kind } = act, p = act.good[id], m = metrics();
  let x = p[0], y = p[1], w = p[2], h = p[3];
  if(kind === 'move'){ x = Math.max(1, Math.min(COLS - w + 1, colAt(m, e.clientX) - act.gc + 1)); y = Math.max(1, rowAt(m, e.clientY) - act.gr + 1); }
  if(kind === 'w' || kind === 'wh') w = Math.max(2, Math.min(COLS - x + 1, colAt(m, e.clientX) - (x - 1) + 1));
  if(kind === 'h' || kind === 'wh') h = Math.max(1, Math.min(8, rowAt(m, e.clientY) - (y - 1) + 1));
  const Q = resolve(act.good, id, { x, y, w, h }); if(JSON.stringify(Q) === JSON.stringify(L.panels)) return;
  const before = L.panels; L.panels = Q; decorate();
  if(kind !== 'move' && overflowing(id)){ L.panels = before; decorate(); say('Stopped: that would cut off text in ' + (PHARM_PANELS.find(q => q[0] === id) || [0, id])[1] + '.'); return; }
  act.good = clone(Q);
});
document.addEventListener('pointerup', () => {
  if(!act) return; qs('.pnl.drag') && qs('.pnl.drag').classList.remove('drag');
  if(JSON.stringify(act.start) !== JSON.stringify(L.panels)){ hist.push(act.start); paint(); } act = null;
});
qs('#undo').onclick = () => { if(hist.length){ L.panels = hist.pop(); paint(); } };
qs('#reset').onclick = () => { hist.push(clone(L.panels)); L.panels = clone(PHARM_LAYOUT.panels); paint(); say('Back to the starting layout. Undo brings your layout back.'); };
qs('#copy').onclick = () => { const t = qs('#code'); t.select(); try{ navigator.clipboard.writeText(t.value).then(() => say('Layout code copied.'), () => { document.execCommand('copy'); say('Layout code copied.'); }); }catch(e){ document.execCommand('copy'); say('Layout code copied.'); } };
qs('#apply').onclick = () => { try{ const c = JSON.parse(qs('#code').value); if(!pharmLayoutOk(c)) throw 0; hist.push(clone(L.panels)); L = c; paint(); say('Layout code applied.'); }catch(e){ say('That layout code is not valid.'); } };
qs('#width').onchange = e => { widthSel = e.target.value; setStage(stageWidth()); };
qs('#sample').onchange = e => { showSample = e.target.checked; paint(); };
addEventListener('resize', () => setStage(stageWidth()));
qs('#check').onclick = () => {
  const keep = stageWidth(), out = [];
  for(const w of [1920, 1680, 1536, 1366, 1280]){ setStage(w); const bad = PHARM_PANELS.filter(([id]) => overflowing(id)).map(q => q[1]); out.push(w + ' px wide: ' + (bad.length ? 'text cut off in ' + bad.join(', ') : 'fits')); }
  setStage(keep); qs('#report').textContent = out.join('\n') + '\nBelow 1280 px wide the panels stack in one column in reading order (top row first, left to right).';
};
paint();
'''
HTML = f'''<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Pharmacy Account Page Layout Editor</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>{css}</style><style>{EDITOR_CSS}</style></head><body>
<div id="bar"><b>Layout Editor: Pharmacy Account Page</b>
<label>Preview width <select id="width"><option value="full">Full window</option><option value="1920">1920</option><option value="1680">1680</option><option value="1536">1536</option><option value="1366">1366</option><option value="1280">1280</option><option value="1100">1100 (stacked)</option><option value="820">820 (tablet, stacked)</option></select></label>
<label><input type="checkbox" id="sample" checked> Show sample registry result</label>
<button id="undo" disabled>Undo</button><button id="reset">Reset To Start</button><button id="check">Check All Widths</button><span class="sp"></span><span id="msg"></span><button id="copy">Copy Layout Code</button></div>
<div id="help">Drag a panel by its title bar to move it. Drag the blue edge or corner to resize it. Panels snap to a 12-column grid, never overlap, and rows are as tall as their content, so nothing is ever cut off. The page uses the full window width. Sample data is shown; nothing here is saved to the pharmacy.</div>
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
out = os.path.join(HERE, 'layout_editor.html'); open(out, 'w', encoding='utf-8').write(HTML); print('written', out, len(HTML))

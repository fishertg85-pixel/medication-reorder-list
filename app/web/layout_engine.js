/* ---------------- layout engine: the standard for every page of the suite ----------------
   A page is a set of panels placed on a 12-column grid. Each panel's place is [column, row, width in columns, height in rows]
   (1-based; a row is 12 px; a panel is never shorter than its content, so nothing is cut off). Narrow screens (under 1280 px wide)
   ignore the layout and stack the panels in reading order (top row first, then left to right).
   A page is described once, as a PAGE object:  { id, title, panels:[[panelId, 'Title'], ...], layout:{v:2, cols:12, panels:{id:[x,y,w,h]}}, render(sample, panels) }
   Its look is arranged ONLY in the layout editor (dev/build_layout_editor.py <page>), by Neo, then the code it gives is pasted into the page's
   layout constant and is permanent: nobody can change it from the app.
   To add a page: write src/parts/<page>_panels.js with a PAGE, its panel bodies and a sample, add it to build_layout_editor.py's PAGES, add it to assemble.py. */
const LAYOUT_COLS = 12, LAYOUT_ROW = 12;   // a row unit is 12 px; a panel's height is a number of rows
function layoutOk(page, L){
  if(!L || L.v !== 2 || L.cols !== LAYOUT_COLS || !L.panels) return false;
  const seen = [];
  for(const [id] of page.panels){
    const p = L.panels[id]; if(!Array.isArray(p) || p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 1)) return false;
    const [x, y, w, h] = p; if(x + w - 1 > LAYOUT_COLS || w < 2 || h < 6 || h > 200) return false;
    if(seen.some(q => x < q[0] + q[2] && q[0] < x + w && y < q[1] + q[3] && q[1] < y + h)) return false;     // overlapping panels
    seen.push(p);
  }
  return true;
}
// the grid: panels in reading order (row, then column) so narrow screens stack them sensibly; body(id) gives a panel's inner HTML
function layoutGridHtml(page, L, body){
  L = L || (layoutOk(page, page.layout) ? page.layout : null) || { panels: Object.fromEntries(page.panels.map(([id], i) => [id, [1, i + 1, LAYOUT_COLS, 6]])) };
  const order = page.panels.slice().sort((a, b) => (L.panels[a[0]][1] - L.panels[b[0]][1]) || (L.panels[a[0]][0] - L.panels[b[0]][0]));
  const rows = Math.max(...Object.values(L.panels).map(p => p[1] + p[3] - 1));
  return `<div class="pgrid" style="--rows:${rows}">${order.map(([id, title]) => { const [x, y, w, h] = L.panels[id];
    return `<section class="pnl" data-pnl="${id}" style="--x:${x};--y:${y};--w:${w};--h:${h}"><h4 class="pt">${title}</h4><div class="pb">${body(id)}</div></section>`; }).join('')}</div>`;
}

# Fit report: after each screenshot, say whether the page needs scrolling and which fields clip their text (dev helper, not part of the regression).
import re
JS = """() => { const d = document.documentElement, out = {sh: d.scrollHeight, ih: innerHeight, sw: d.scrollWidth, iw: innerWidth, clip: [], wrap: []};
  for(const e of document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=date]):not([type=time]),select,textarea,.ro')){
    if(!e.offsetParent) continue; const cs = getComputedStyle(e); if(cs.visibility === 'hidden') continue;
    let over = e.scrollWidth - e.clientWidth > 1;
    if(e.tagName === 'SELECT'){ const t = e.options[e.selectedIndex]; if(t){ const c = document.createElement('canvas').getContext('2d'); c.font = cs.font; over = c.measureText(t.text).width > e.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 22; } }
    if(over) out.clip.push((e.getAttribute('data-sf') || e.getAttribute('data-cf') || e.id || e.className || e.tagName) + '=' + String(e.value || e.textContent).slice(0, 30)); }
  const lines = e => { const r = document.createRange(); r.selectNodeContents(e); const tops = new Set([...r.getClientRects()].filter(x => x.width > 0).map(x => Math.round(x.top / 4))); return tops.size; };
  for(const e of document.querySelectorAll('label > span, .pt, button, h3, h4, .hint, .lockhint, .pid, .clh, option')){ if(!e.offsetParent || e.tagName === 'OPTION') continue; if(!e.textContent.trim()) continue; if(lines(e) > 1) out.wrap.push(e.textContent.trim().slice(0, 40)); }
  for(const e of document.querySelectorAll('*')){ if(!e.offsetParent && e.tagName !== 'BODY') continue; if((e.scrollHeight > e.clientHeight + 2 || e.scrollWidth > e.clientWidth + 2) && /(auto|scroll)/.test(getComputedStyle(e).overflow + getComputedStyle(e).overflowX + getComputedStyle(e).overflowY) && e.clientHeight > 0 && !['HTML','BODY','TEXTAREA'].includes(e.tagName) && !e.closest('.dmodal,.ddrawer,.drmodal')) out.wrap.push('SCROLLBOX ' + (e.id || e.className).toString().slice(0, 30)); }
  return out; }"""
def fitshot(pg, path, **kw):
    try:
        r = pg.evaluate(JS)
        name = re.sub(r'.*/|\.png$', '', path)
        print(f"FIT {name}: page {r['sw']}x{r['sh']} in {r['iw']}x{r['ih']}  {'SCROLLS' if r['sh'] > r['ih'] + 1 or r['sw'] > r['iw'] + 1 else 'fits'}  clipped={r['clip']} wrapped={r['wrap'][:8]}")
    except Exception as e: print('FIT error', e)
    pg.screenshot(path=path, **kw)

# One field-color standard: fillable = lighter field color; not fillable (readonly/disabled) = the window background. Every page, light and dark.
import sys, re
from playwright.sync_api import sync_playwright
BASE = 'http://localhost:8790/'; fails = []
def check(n, ok, extra=''):
    print(('ok   ' if ok else 'FAIL ') + n, extra); 
    if not ok: fails.append(n)
JS = """(theme)=>{ document.documentElement.setAttribute('data-theme', theme);
  const mk=(attrs)=>{const i=document.createElement('input'); i.type='text'; Object.entries(attrs).forEach(([k,v])=>i.setAttribute(k,v)); document.body.appendChild(i); return i;};
  const a=mk({}), b=mk({readonly:''}), c=mk({disabled:''}); const s=document.createElement('select'); s.disabled=true; document.body.appendChild(s); const t=document.createElement('textarea'); document.body.appendChild(t);
  const g=e=>getComputedStyle(e).backgroundColor; const bg=getComputedStyle(document.body).backgroundColor;
  const r=[g(a),g(b),g(c),g(s),g(t),bg]; [a,b,c,s,t].forEach(e=>e.remove()); return r; }"""
with sync_playwright() as pw:
    br = pw.chromium.launch(args=['--no-sandbox'])
    for page in ['index.html', 'host.html', 'calendar.html']:
        pg = br.new_context(viewport={'width': 1300, 'height': 800}).new_page()
        pg.goto(BASE + page, wait_until='domcontentloaded', timeout=20000); pg.wait_for_timeout(800)
        for theme in ['light', 'dark']:
            fill, ro, dis, sel, ta, bg = pg.evaluate(JS, theme)
            check(f'{page} {theme}: fillable is lighter than the window and differs from locked', fill != bg and fill != ro, (fill, ro, bg))
            check(f'{page} {theme}: readonly, disabled and disabled select are the window background', ro == bg and dis == bg and sel == bg, (ro, dis, sel, bg))
            # lighter means higher luminance than the window background
            L = lambda c: sum(int(x) * w for x, w in zip(re.findall(r'\d+', c)[:3], (.2126, .7152, .0722)))
            check(f'{page} {theme}: fillable luminance above the window', L(fill) > L(bg))
    br.close()
print('FAILED:' if fails else 'all passed', fails or '')

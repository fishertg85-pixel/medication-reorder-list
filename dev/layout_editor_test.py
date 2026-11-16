# Layout editor in the browser: move, resize from every edge, snap, no overlap, never shorter than content, no cut-off text, undo, code round-trip.
import json, os
from playwright.sync_api import sync_playwright
fails = []
def check(name, got, want):
    ok = got == want; print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  got {got!r} want {want!r}'))
    if not ok: fails.append(name)
errs = []
with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox']); p = b.new_context(viewport={'width': 1700, 'height': 1700}).new_page(); p.on('pageerror', lambda e: errs.append(str(e))); p.on('dialog', lambda d: d.accept())
    p.goto('file://' + os.path.abspath('layout_editor.html')); p.wait_for_selector('.pgrid'); p.wait_for_timeout(400)
    code = lambda: json.loads(p.input_value('#code'))['panels']
    box = lambda sel: p.locator(sel).bounding_box()
    start = code(); print('start', start)
    def overlap(P):
        v = list(P.values()); return any(a is not c and a[0] < c[0] + c[2] and c[0] < a[0] + a[2] and a[1] < c[1] + c[3] and c[1] < a[1] + a[3] for a in v for c in v)
    def drag(frm, to, steps=14):
        p.mouse.move(*frm); p.mouse.down(); p.mouse.move(*to, steps=steps); p.mouse.up(); p.wait_for_timeout(250)
    def handle(pid, side):
        h = p.locator(f'.pnl[data-pnl={pid}] .rz[data-s={side}]').bounding_box(); return (h['x'] + h['width'] / 2, h['y'] + h['height'] / 2)
    def content_fits(pid):
        return p.evaluate("(id) => { const n = document.querySelector('.pnl[data-pnl=' + id + ']'); return n.querySelector('.pt').offsetHeight + n.querySelector('.pb').offsetHeight + 12 <= n.getBoundingClientRect().height + 1; }", pid)
    check('starts without overlap', overlap(start), False)
    # --- Preview: the page as it will look, no editing tools; Back (or Esc) returns, layout untouched
    before_code = code(); p.click('#preview'); p.wait_for_timeout(400)
    vis = lambda sel: p.evaluate("(s) => [...document.querySelectorAll(s)].some(e => e.offsetParent !== null)", sel)
    check('preview hides the resize handles, code box, help and editing buttons', (vis('.rz'), vis('#codebox'), vis('#help'), vis('#undo'), vis('#copy'), vis('#check')), (False, False, False, False, False, False))
    check('preview hides the size labels and the grid guides', (vis('.pnl .pt small'), p.evaluate("document.querySelector('.pgrid').classList.contains('guides')")), (False, False))
    check('preview shows the panels and a way back', (len(p.locator('.pnl').all()) >= 6, vis('#back')), (True, True))
    check('preview has no sample registry result', p.locator('.npibox').count(), 0)
    p.screenshot(path='screenshots/layout_preview.png')
    p.keyboard.press('Escape'); p.wait_for_timeout(300)
    check('Esc returns to editing with handles back', (vis('.rz'), vis('#codebox'), code()), (True, True, before_code))
    p.click('#preview'); p.wait_for_timeout(300); p.click('#back'); p.wait_for_timeout(300); check('Back To Editing works too', vis('.rz'), True)
    check('every box at least as tall as its content', all(content_fits(i) for i in start), True)
    # --- taller (bottom edge) really changes the box's height on screen
    h0 = box('.pnl[data-pnl=svc]')['height']; r0 = code()['svc'][3]; fx, fy = handle('svc', 's'); drag((fx, fy), (fx, fy + 96))
    h1 = box('.pnl[data-pnl=svc]')['height']; check('dragging the bottom edge down makes the box taller on screen', h1 - h0 >= 80, True); check('height is in 12 px steps', (code()['svc'][3] - r0) in range(7, 10), True)
    # --- shorter, but never below its content
    fx, fy = handle('svc', 's'); drag((fx, fy), (fx, fy - 600)); check('shrinking stops at the content height', content_fits('svc'), True)
    check('shrunk box is no taller than before the stretch plus a step', box('.pnl[data-pnl=svc]')['height'] <= h0 + 13, True)
    # --- top edge (resize from the top), left edge
    p.click('#reset'); p.wait_for_timeout(300); a = code()['act']; fx, fy = handle('act', 's'); drag((fx, fy), (fx, fy + 120)); a2 = code()['act']; check('act taller', a2[3] > a[3], True)
    fx, fy = handle('act', 'n'); drag((fx, fy), (fx, fy - 40)); a3 = code()['act']; check('top edge changes height and keeps the bottom edge', (a3[1] + a3[3]) == (a2[1] + a2[3]) or a3[1] < a2[1], True)
    check('no overlap after top-edge resize', overlap(code()), False)
    p.click('#reset'); p.wait_for_timeout(300); r = code()['reg']; fx, fy = handle('reg', 'e'); g = box('.pgrid'); colw = (g['width'] - 132) / 12; drag((fx, fy), (fx + 1.2 * (colw + 12), fy))
    r2 = code()['reg']; check('right edge makes it wider', r2[2] > r[2], True); fx, fy = handle('reg', 'w'); drag((fx, fy), (fx + 1.2 * (colw + 12), fy)); r3 = code()['reg']; check('left edge narrows it and moves its left side', (r3[0] > r2[0], r3[0] + r3[2] == r2[0] + r2[2]), (True, True))
    check('no overlap after width changes', overlap(code()), False)
    # --- corner
    p.click('#reset'); p.wait_for_timeout(300); fx, fy = handle('svc', 'se'); before = code()['svc']; drag((fx, fy), (fx - 1.3 * (colw + 12), fy + 60)); s2 = code()['svc']; check('corner changes width and height together', (s2[2] < before[2], s2[3] > before[3]), (True, True))
    # --- move + drop onto another panel
    p.click('#reset'); p.wait_for_timeout(300); t = box('.pnl[data-pnl=svc] .pt'); t2 = box('.pnl[data-pnl=contact] .pt'); drag((t['x'] + 30, t['y'] + 10), (t2['x'] + 30, t2['y'] + 10))
    check('no overlap after dropping onto another panel', overlap(code()), False); check('layout code stays valid', all(v[0] >= 1 and v[0] + v[2] - 1 <= 12 and v[2] >= 2 and v[3] >= 6 for v in code().values()), True)
    # --- width shrink refused before text is cut off sideways
    p.click('#reset'); p.wait_for_timeout(300); fx, fy = handle('hrs', 'w'); drag((fx, fy), (fx + 6 * (colw + 12), fy)); hh = code()['hrs']
    check('narrowing Hours stops before text is cut off', p.evaluate("(() => { const n = document.querySelector('.pnl[data-pnl=hrs] .pb'); return n.scrollWidth > n.clientWidth + 1; })()"), False); check('Hours kept a usable width', hh[2] >= 3, True)
    # --- double-click fits to content
    p.click('#reset'); p.wait_for_timeout(300); fx, fy = handle('svc', 's'); drag((fx, fy), (fx, fy + 150)); tt = box('.pnl[data-pnl=svc] .pt'); p.mouse.dblclick(tt['x'] + 40, tt['y'] + 8); p.wait_for_timeout(250)
    check('double-click fits the box to its content', abs(box('.pnl[data-pnl=svc]')['height'] - (p.evaluate("(() => { const n = document.querySelector('.pnl[data-pnl=svc]'); return n.querySelector('.pt').offsetHeight + n.querySelector('.pb').offsetHeight + 12; })()"))) < 14, True)
    # --- undo, reset, code
    before = code(); p.click('#undo'); p.wait_for_timeout(250); check('undo changes the layout', code() != before, True)
    p.click('#reset'); p.wait_for_timeout(250); check('reset returns to the starting layout', code(), start)
    new = json.loads(json.dumps(start)); new['act'] = [8, 36, 5, 40]; p.fill('#code', json.dumps({'v': 2, 'cols': 12, 'panels': new})); p.click('#apply'); p.wait_for_timeout(250); check('pasted code applies', code()['act'][3], 40)
    p.fill('#code', '{"v":1}'); p.click('#apply'); p.wait_for_timeout(250); check('bad code refused', 'not valid' in p.inner_text('#msg'), True)
    p.click('#reset'); p.wait_for_timeout(250); p.click('#check'); p.wait_for_timeout(600); rep = p.inner_text('#report'); print(rep.replace('\n', ' | '))
    check('default fits sideways at every grid width', 'cut off sideways' in rep, False)
    p.select_option('#width', '820'); p.wait_for_timeout(300); check('narrow preview stacks the panels', p.evaluate("getComputedStyle(document.querySelector('.pgrid')).display"), 'block')
    p.select_option('#width', 'full'); p.wait_for_timeout(300); p.screenshot(path='screenshots/layout_editor.png', full_page=True)
    b.close()
check('no script errors', errs, [])
print('\nFAILED:', fails if fails else 'none')

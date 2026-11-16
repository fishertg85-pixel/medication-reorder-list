# Layout editor in the browser: moving, resizing, snapping, no overlap, no cut-off text, undo, code round-trip.
import json, os
from playwright.sync_api import sync_playwright
fails = []
def check(name, got, want):
    ok = got == want; print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  got {got!r} want {want!r}'))
    if not ok: fails.append(name)
errs = []
with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox']); p = b.new_context(viewport={'width': 1700, 'height': 1700}).new_page(); p.on('pageerror', lambda e: errs.append(str(e))); p.on('dialog', lambda d: d.accept())
    p.goto('file://' + os.path.abspath('layout_editor.html')); p.wait_for_selector('.pgrid'); p.wait_for_timeout(300)
    code = lambda: json.loads(p.input_value('#code'))['panels']
    start = code(); check('starts from the default layout', start['hrs'], [8, 1, 5, 2])
    def box(sel): return p.locator(sel).bounding_box()
    def drag(frm, to, steps=12):
        p.mouse.move(*frm); p.mouse.down(); p.mouse.move(*to, steps=steps); p.mouse.up(); p.wait_for_timeout(200)
    def overlap(P):
        v = list(P.values()); return any(a is not b_ and a[0] < b_[0] + b_[2] and b_[0] < a[0] + a[2] and a[1] < b_[1] + b_[3] and b_[1] < a[1] + a[3] for a in v for b_ in v)
    # move Services next to Hours' column: drop the Services title at the far right, row 3
    t = box('.pnl[data-pnl=svc] .pt'); g = box('.pgrid'); colw = (g['width'] - 132) / 12
    drag((t['x'] + 30, t['y'] + 10), (g['x'] + 7.5 * (colw + 12) + 30, t['y'] + 10))
    c = code(); check('moved panel lands on a grid column', c['svc'][0] in range(1, 13), True); check('no overlap after a move', overlap(c), False)
    check('layout code stays valid', all(1 <= v[0] and v[0] + v[2] - 1 <= 12 and v[2] >= 2 for v in c.values()), True)
    # drop Hours panel on top of Contact: the others must make room, not overlap
    t = box('.pnl[data-pnl=hrs] .pt'); t2 = box('.pnl[data-pnl=contact] .pt'); drag((t['x'] + 30, t['y'] + 10), (t2['x'] + 30, t2['y'] + 10))
    check('no overlap after dropping onto another panel', overlap(code()), False)
    # resize: shrink Hours by dragging its right edge far left -> must stop before text is cut off
    c0 = code(); hh = box('.pnl[data-pnl=hrs]'); p.mouse.move(hh['x'] + hh['width'] - 1, hh['y'] + hh['height'] / 2); p.mouse.down(); p.mouse.move(hh['x'] + 40, hh['y'] + hh['height'] / 2, steps=15); p.mouse.up(); p.wait_for_timeout(200)
    c1 = code(); n = p.evaluate("(() => { const n = document.querySelector('.pnl[data-pnl=hrs] .pb'); return n.scrollWidth > n.clientWidth + 1; })()")
    check('shrinking stops before text is cut off', n, False); check('Hours kept a usable width', c1['hrs'][2] >= 3, True)
    # widening works (the check must not block legitimate resizes)
    p.click('#reset'); p.wait_for_timeout(200); sv = box('.pnl[data-pnl=svc]'); w0 = code()['svc'][2]
    p.mouse.move(sv['x'] + sv['width'] - 1, sv['y'] + sv['height'] / 2); p.mouse.down(); p.mouse.move(sv['x'] + sv['width'] + 150, sv['y'] + sv['height'] / 2, steps=12); p.mouse.up(); p.wait_for_timeout(200)
    check('widening a panel works', code()['svc'][2] > w0, True); check('no overlap after widening', overlap(code()), False)
    sv = box('.pnl[data-pnl=svc]'); h0 = code()['svc'][3]
    p.mouse.move(sv['x'] + sv['width'] / 2, sv['y'] + sv['height'] - 1); p.mouse.down(); p.mouse.move(sv['x'] + sv['width'] / 2, sv['y'] + sv['height'] + 60, steps=12); p.mouse.up(); p.wait_for_timeout(200)
    check('making a panel taller works', code()['svc'][3] >= h0, True)
    # undo restores
    before = code(); p.click('#undo'); p.wait_for_timeout(200); check('undo changes the layout', code() != before, True)
    p.click('#reset'); p.wait_for_timeout(200); check('reset returns to the starting layout', code(), start)
    # round trip a code
    new = dict(start); new['act'] = [1, 4, 6, 1]; p.fill('#code', json.dumps({'v': 1, 'cols': 12, 'panels': new})); p.click('#apply'); p.wait_for_timeout(200); check('pasted code applies', code()['act'][:2], [1, 4])
    p.fill('#code', '{"v":1}'); p.click('#apply'); p.wait_for_timeout(200); check('bad code refused', 'not valid' in p.inner_text('#msg'), True)
    p.click('#reset'); p.wait_for_timeout(200); p.click('#check'); p.wait_for_timeout(500); rep = p.inner_text('#report'); print(rep.replace('\n', ' | '))
    check('default fits at every grid width', 'cut off' in rep, False)
    p.select_option('#width', '820'); p.wait_for_timeout(300); check('narrow preview stacks the panels', p.evaluate("getComputedStyle(document.querySelector('.pgrid')).display"), 'block')
    p.select_option('#width', 'full'); p.wait_for_timeout(300); p.screenshot(path='screenshots/layout_editor.png', full_page=True)
    b.close()
check('no script errors', errs, [])
print('\nFAILED:', fails if fails else 'none')

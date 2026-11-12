src = open('e2e.py').read().split("with sync_playwright() as pw:")[0]
exec(src)
NDCS["197379"].append(("51655012301", "51655-123-01", "Northwind Pharmaceuticals", "30 TABLET in 1 BOTTLE (51655-123-01)", "nw1", ""))
def dist_opts(p): return p.locator('#listBody tr').first.locator('select[data-f=dist]').evaluate("s => [...s.querySelectorAll('optgroup')].map(g => g.label + ': ' + [...g.children].slice(0,4).map(o => o.textContent).join(', '))")
def dist_val(p): return p.locator('#listBody tr').first.locator('select[data-f=dist]').input_value()
def ndc_list(p):
    row = p.locator('#listBody tr').first; row.locator('input.ndcin').click(); p.wait_for_timeout(2000)
    out = [t.split('\n')[0][:58] for t in p.locator('#ndcPop [data-p]').all_inner_texts()]; return out
def pick_ndc(p, ndc):
    i = [j for j, t in enumerate(p.locator('#ndcPop [data-p]').all_inner_texts()) if ndc in t][0]
    p.locator('#ndcPop [data-p]').nth(i).dispatch_event('mousedown'); p.wait_for_timeout(1000)
def order(ndc, dist):
    search_add(p, 'ateno 25'); ndc_list(p); pick_ndc(p, ndc)
    p.locator('#listBody tr').first.locator('select[data-f=dist]').select_option(dist); p.wait_for_timeout(900)
    p.click('#submitBtn'); p.wait_for_timeout(1500)
with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={"width": 1300, "height": 900}); setup(ctx); p = page_for(ctx)
    login(p, 'NTX1', 'owner', 'temp12345a')
    order('68180-', 'Anda Inc'); order('68180-', 'Anda Inc'); order('51655-', 'Parmed Pharmaceuticals'); order('00093-', 'Mckesson Drug Company')
    # history now: Lupin 68180 x2 (Anda x2), Northwind 51655 x1 (Parmed), Teva 00093 x1 most recent (McKesson)
    p.click('#search'); p.keyboard.type('ateno', delay=10); p.wait_for_timeout(1500)
    print('S1 search:', [t.split('\n')[0][:50] for t in p.locator('#results div[data-i]').all_inner_texts()])
    p.keyboard.press('Escape'); p.fill('#search', '')
    search_add(p, 'ateno 25')
    print('S2 distributor filled in:', dist_val(p))
    print('S3 distributor list:', dist_opts(p))
    print('S4 NDC list:', ndc_list(p))
    print('ERRORS:', ERR or 'none'); b.close()

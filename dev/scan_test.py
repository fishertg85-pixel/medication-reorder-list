src = open('e2e.py').read().split("with sync_playwright() as pw:")[0]
exec(src)
def upc(ndc10):
    d = '3' + ndc10; s = sum(int(c) * (3 if i % 2 == 0 else 1) for i, c in enumerate(d)); return d + str((10 - s % 10) % 10)
with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={"width": 1300, "height": 800}); setup(ctx); p = page_for(ctx)
    login(p, 'NTX1', 'owner', 'temp12345a')
    # 1) someone searched atenolol (list on screen, nothing chosen) ... then scans an amphetamine bottle
    p.click('#search'); p.keyboard.type('ateno 25', delay=10); p.wait_for_timeout(900)
    p.fill('#search', ''); p.keyboard.type(upc('1671495301'), delay=2); p.keyboard.press('Enter'); p.wait_for_timeout(2500)
    print('A scan after a name search adds:', items(p))
    # 2) scan right after adding something (old list still in memory)
    p.keyboard.type(upc('0093075201'), delay=2); p.keyboard.press('Enter'); p.wait_for_timeout(2500)
    print('B second scan adds:', items(p))
    # 3) box 2D code (GS1) scanned
    p.keyboard.type('0100368180501016' + '17281231' + '10LOT42', delay=2); p.keyboard.press('Enter'); p.wait_for_timeout(2500)
    print('C 2D box code adds:', items(p), '| mfr:', p.locator('#listBody td.mfr').last.inner_text())
    # 4) a name typed fast + Enter still lets you pick (no auto-add)
    p.keyboard.type('amphet 20', delay=2); p.keyboard.press('Enter'); p.wait_for_timeout(1500)
    print('D name + Enter: list shown, nothing added:', p.is_visible('#results'), len(items(p)))
    print('ERRORS:', ERR or 'none'); b.close()

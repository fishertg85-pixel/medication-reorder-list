# Host page, new flow: clients queue on the right, client page, Add-pharmacy window, pharmacy page with breadcrumb, owners, licenses, NPI/NCPDP limits, holiday popover. Run ./reset.sh first.
import json, subprocess, os
from playwright.sync_api import sync_playwright
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'screenshots') + '/'
FAIL = []
def check(name, ok):
    print(("PASS " if ok else "FAIL ") + name)
    if not ok: FAIL.append(name)
def node(arg): return json.loads(subprocess.check_output(["node", "boot.mjs", json.dumps(arg)]).decode().strip().splitlines()[-1])
node({"makeHost": {"login": "Neo", "name": "Thomas Fisher", "phone": "8175559999", "tempPassword": "hosttemp12a"}})
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 1500, "height": 1000})
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("dialog", lambda d: d.accept(""))
    pg.goto("http://localhost:8790/host.html")
    pg.fill("#sUser", "neo"); pg.fill("#sPass", "hosttemp12a"); pg.click("#sGo")
    pg.wait_for_selector("#sNew:visible"); pg.fill("#sNew1", "hostpass999"); pg.fill("#sNew2", "hostpass999"); pg.click("#sNewGo")
    pg.wait_for_selector("#sCode:visible, #gBody:visible")
    if pg.is_visible("#sCode"): pg.fill("#sCodeIn", "123456"); pg.click("#sCodeGo")
    pg.wait_for_selector("#side [data-qs]", state="visible")
    check("queue is on the right of the page", pg.locator(".cq").bounding_box()["x"] > pg.locator(".cmain").bounding_box()["x"])
    # original pharmacies (no client yet) are listed in the queue; an owner can be removed; a pharmacy can be linked to a client
    check("queue lists pharmacies not linked to a client", pg.locator("#side [data-qs]").count() >= 1 and "not linked" in pg.inner_text("#side").lower())
    pg.click("#side [data-qs=NTX1]"); pg.wait_for_selector("#vPharm .pcard[data-store='NTX1']")
    check("its page opens with Clients > pharmacy crumb", "NTX1" in pg.inner_text("#crumb") or "NorTex" in pg.inner_text("#crumb"))
    check("legacy owner shown on it", "owner" in pg.inner_text("#vPharm [data-pnl=own]").lower())
    pg.select_option("#vPharm [data-ownpick]", "@none"); pg.click("#vPharm [data-ownsave]"); pg.wait_for_timeout(800)
    check("removing the owner needs a reason (nothing changed)", "Not set" not in pg.inner_text("#vPharm [data-pnl=own]"))
    pg.fill("#vPharm [data-ownreason]", "Test pharmacy: not hers"); pg.click("#vPharm [data-ownsave]")
    pg.wait_for_selector("#vPharm [data-pnl=own]:has-text('Not set')", timeout=8000)
    check("owner removed", True)
    pg.click("#crumb [data-crumb=home]"); pg.wait_for_selector("#vNew .pcard"); nc = "#vNew .pcard"
    pg.select_option(nc + " [data-cf=entityType]", "llc"); pg.fill(nc + " [data-cf=legalName]", "NorTex Holdings LLC"); pg.fill(nc + " [data-cf=ein]", "22-2222222")
    pg.fill(nc + " [data-cf=address]", "1 Main"); pg.fill(nc + " [data-cf=city]", "Haslet"); pg.select_option(nc + " [data-cf=state]", "TX"); pg.fill(nc + " [data-cf=zip]", "76052")
    pg.click("#tbSave [data-createclient]"); pg.wait_for_selector("#vClient .pcard")
    pg.click("#crumb [data-crumb=home]"); pg.wait_for_selector("#side [data-qs=NTX1]")
    pg.click("#side [data-qs=NTX1]"); pg.wait_for_selector("#vPharm .pcard[data-store='NTX1']")
    k = pg.locator("#vPharm [data-sf=clientId]"); k.select_option(index=1); pg.click("#tbSave [data-savestore]"); pg.wait_for_timeout(1500)
    check("linking moves it inside the client (crumb shows the client)", "NorTex Holdings" in pg.inner_text("#crumb"))
    check("no longer in the unlinked list", (pg.click("#crumb [data-crumb=home]"), pg.wait_for_selector("#vNew .pcard"), pg.locator("#side [data-qs=NTX1]").count())[2] == 0)
    check("no script errors", not errs)
    if errs: print(errs)
    b.close()
print("\n" + ("all passed" if not FAIL else "%d failed" % len(FAIL)))

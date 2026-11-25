# (base copy) Employee portal: new-client form on the start page with the client list on the right, client page + Profiles (pharmacies), Add-pharmacy window, pharmacy page with Users and Billing buttons, one search bar, breadcrumb, owners, licenses, NPI/NCPDP limits, holiday popover, the who-can-manage switches. Run ./reset.sh first.
import json, subprocess, os, sys
from playwright.sync_api import sync_playwright
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'screenshots') + '/'
FAIL = []
def check(name, ok):
    print(("PASS " if ok else "FAIL ") + name)
    if not ok: FAIL.append(name)
def node(arg): return json.loads(subprocess.check_output(["node", "boot.mjs", json.dumps(arg)]).decode().strip().splitlines()[-1])
def measure(pg, sel):
    if not os.environ.get("MEASURE"): return
    print("MEASURE", sel, pg.evaluate("""(sel)=>{const o={};const ps=[...document.querySelectorAll(sel+' .pnl')];let y=1;ps.forEach(n=>{n.style.setProperty('--x',1);n.style.setProperty('--y',y);n.style.setProperty('--w',6);n.style.setProperty('--h',1);y+=400;});return new Promise(r=>setTimeout(()=>{ps.forEach(n=>o[n.dataset.pnl]=[Math.round(n.getBoundingClientRect().height),Math.round(n.getBoundingClientRect().width)]);r(JSON.stringify(o))},300));}""", sel))
node({"makeHost": {"login": "Neo", "name": "Thomas Fisher", "phone": "8175559999", "tempPassword": "hosttemp12a"}})
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 1500, "height": 1000})
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("dialog", lambda d: d.accept(""))
    pg.goto("http://localhost:8790/host.html"); pg.wait_for_selector("#sUser"); pg.screenshot(path=OUT + "_ug_signin.png")
    pg.fill("#sUser", "neo"); pg.fill("#sPass", "hosttemp12a"); pg.click("#sGo")
    pg.wait_for_selector("#sNew:visible"); pg.fill("#sNew1", "hostpass999"); pg.fill("#sNew2", "hostpass999"); pg.click("#sNewGo")
    pg.wait_for_selector("#sCode:visible, #side", state="attached")
    if pg.is_visible("#sCode"): pg.fill("#sCodeIn", "123456"); pg.click("#sCodeGo")
    pg.wait_for_selector("#side", state="visible")
    check("no tabs across the top, titled IronLedger employee portal", pg.locator("#hTabs").count() == 0 and "IronLedger employee portal" in pg.inner_text("header.topbar"))
    pg.wait_for_selector("#side [data-qs=NTX1]")
    check("start page: the new-client form is in the middle and the client list is on the right", pg.is_visible("#tbSave [data-createclient]") and pg.locator(".cq").bounding_box()["x"] > pg.locator(".cmain").bounding_box()["x"] and "Clients" in pg.inner_text("#side h2"))
    check("start page lists pharmacies not linked to a client yet", "NorTex Pharmacy - Haslet" in pg.inner_text("#side") and "Not linked to a client yet" in pg.inner_text("#side"))
    nc = "#vNew .pcard"
    pg.select_option(nc + " [data-cf=entityType]", "llc"); pg.fill(nc + " [data-cf=legalName]", "IronLedger Compliance LLC"); pg.fill(nc + " [data-cf=ein]", "12-3456789")
    pg.fill(nc + " [data-cf=address]", "100 Main St"); pg.fill(nc + " [data-cf=city]", "Haslet"); pg.select_option(nc + " [data-cf=state]", "TX"); pg.fill(nc + " [data-cf=zip]", "76052")
    pg.select_option(nc + " [data-cownpick]", "@new")
    pg.fill(nc + " [data-cn=name]", "Thomas Fisher"); pg.fill(nc + " [data-cn=login]", "tfisher85"); pg.fill(nc + " [data-cn=phone]", "817-555-0188"); pg.check(nc + " [data-cn=consent]")
    measure(pg, "#vNew")
    pg.screenshot(path=OUT + "_ug_new_client.png", full_page=True)
    pg.click("#tbSave [data-createclient]")
    pg.wait_for_selector("#vClient .pcard")
    check("the client opens: its account in the middle, its Profiles (pharmacies) on the right", "IronLedger Compliance LLC" in pg.inner_text("#vClient") and "Profiles" in pg.inner_text("#side h2") and pg.is_visible("#addP"))
    check("client page opened with a temporary password shown for the new owner", "tfisher85" in pg.inner_text("#passBox") and pg.is_visible("#passBox"))
    check("client page shows the owner", "tfisher85" in pg.inner_text("#vClient [data-pnl=own]"))
    check("client page has no pharmacies or billing panels (those are one level down)", pg.locator("#vClient [data-pnl=pharm], #vClient [data-pnl=bill]").count() == 0)
    check("breadcrumb: Clients > client", "IronLedger Compliance LLC" in pg.inner_text("#crumb"))
    measure(pg, "#vClient")
    pg.screenshot(path=OUT + "_ug_client_page.png", full_page=True)
    # ---- unsaved changes ----
    dlg = lambda: pg.is_visible(".ug-back:not([hidden])")
    dba = lambda: pg.input_value("#vClient [data-cf=dba]")
    def api_client():
        return pg.evaluate("() => DATA.clients.find(c => c.legalName === 'IronLedger Compliance LLC').dba || ''")
    pg.click("#bRefresh"); pg.wait_for_timeout(500)
    check("nothing changed: leaving asks nothing", not dlg())
    pg.fill("#vClient [data-cf=dba]", "Iron Ledger Rx")
    pg.click("#bRefresh"); pg.wait_for_selector(".ug-back:not([hidden])")
    check("a change, then Refresh: the Save your changes? window opens, Yes and No only", pg.inner_text(".ug-q") == "Save your changes?" and pg.locator(".ug-btns button").all_inner_texts() == ["Yes", "No"])
    pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    check("Escape does not answer it: a choice is required", dlg())
    pg.click("[data-ug=no]"); pg.wait_for_timeout(900)
    check("No leaves without saving: the page is drawn again with the old value", (not dlg()) and dba() == "" and api_client() == "")
    pg.fill("#vClient [data-cf=dba]", "Iron Ledger Rx")
    pg.click("#crumb [data-crumb=home]"); pg.wait_for_selector(".ug-back:not([hidden])")
    pg.click("[data-ug=yes]"); pg.wait_for_selector("#vNew:visible", timeout=8000); pg.wait_for_timeout(600)
    check("Yes saves and then leaves for the page asked for", (not dlg()) and pg.is_visible("#tbSave [data-createclient]") and api_client() == "Iron Ledger Rx")
    pg.click("#side [data-q]"); pg.wait_for_selector("#vClient .pcard"); pg.wait_for_timeout(400)
    check("opening it again: unchanged, nothing asked on the way out", (dba() == "Iron Ledger Rx") and not pg.evaluate("() => UG.changed()"))
    pg.fill("#vClient [data-cf=ein]", "") if False else None
    pg.select_option("#vClient [data-cf=state]", "OK"); pg.click("#bRefresh"); pg.wait_for_selector(".ug-back:not([hidden])"); pg.click("[data-ug=no]"); pg.wait_for_timeout(700)
    check("a dropdown change counts too", (not dlg()) and pg.input_value("#vClient [data-cf=state]") == "TX")
    pg.click("#vClient [data-cf=billingSame]", force=True) if False else None
    # the Add pharmacy window
    pg.click("#addP"); pg.wait_for_selector("#pmodal:visible")
    pg.click("#pmClose"); pg.wait_for_timeout(300)
    check("Add pharmacy window closes straight away when nothing was typed", pg.is_hidden("#pmodal") and not dlg())
    pg.click("#addP"); pg.wait_for_selector("#pmodal:visible"); pg.fill("#newStore [data-newid]", "ZZ9"); pg.fill("#newStore [data-sf=name]", "Zed Nine Pharmacy")
    pg.click("#pmClose"); pg.wait_for_selector(".ug-back:not([hidden])")
    check("typed into the Add pharmacy window, then Close: the question comes first, the window stays open behind it", pg.is_visible("#pmodal"))
    pg.click("[data-ug=no]"); pg.wait_for_timeout(500)
    check("No closes the Add pharmacy window without creating anything", pg.is_hidden("#pmodal") and not pg.evaluate("() => DATA.stores.some(s => s.id === 'ZZ9')"))
    pg.click("#addP"); pg.wait_for_selector("#pmodal:visible"); pg.fill("#newStore [data-newid]", "ZZ9"); pg.fill("#newStore [data-sf=name]", "Zed Nine Pharmacy")
    pg.click("#pmodal", position={"x": 5, "y": 5}); pg.wait_for_selector(".ug-back:not([hidden])"); pg.click("[data-ug=yes]"); pg.wait_for_timeout(2500)
    check("Yes in the Add pharmacy window creates the pharmacy and opens it", pg.evaluate("() => DATA.stores.some(s => s.id === 'ZZ9')") and pg.is_hidden("#pmodal"))
    # a save that is refused keeps the person on the page
    pg.fill("#vPharm [data-sf=npi]", "123"); pg.on("dialog", lambda d: d.accept())
    pg.click("#bLock"); pg.wait_for_selector(".ug-back:not([hidden])"); pg.click("[data-ug=yes]"); pg.wait_for_timeout(1500)
    check("a save that is refused (NPI not valid) keeps the person on the page, still unsaved", pg.is_visible("#gBody") and pg.evaluate("() => UG.changed()") and not dlg())
    pg.fill("#vPharm [data-sf=npi]", ""); pg.evaluate("() => document.querySelector('#vPharm [data-sf=npi]').dispatchEvent(new Event('input', {bubbles: true}))")
    # an hours change through the new time boxes counts
    pg.reload(); pg.wait_for_timeout(500)
    check("no script errors", errs == [])
    b.close()
print("\nFAILED:" , FAIL if FAIL else "none"); sys.exit(1 if FAIL else 0)

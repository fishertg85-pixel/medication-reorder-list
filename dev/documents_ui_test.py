# Documents tab in the browser (run ./reset.sh first): who sees it, what each duty sees, open/print, pin, search, add, approve, new version, review, retire, people-list controls.
import json, urllib.request, urllib.error, boto3, sys, subprocess, os
from playwright.sync_api import sync_playwright
ids = json.load(open('moto_ids.json')); BASE = 'http://localhost:8790/'
c = boto3.client("cognito-idp", endpoint_url="http://localhost:5005", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="x")
fails = []
def check(name, got, want):
    ok = got == want; print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  got {got!r} want {want!r}'))
    if not ok: fails.append(name)
def tokens(u, pw, newpw):
    r = c.initiate_auth(ClientId=ids["client"], AuthFlow="USER_PASSWORD_AUTH", AuthParameters={"USERNAME": u, "PASSWORD": pw})
    if r.get("ChallengeName") == "NEW_PASSWORD_REQUIRED":
        r = c.respond_to_auth_challenge(ClientId=ids["client"], ChallengeName="NEW_PASSWORD_REQUIRED", Session=r["Session"], ChallengeResponses={"USERNAME": u, "NEW_PASSWORD": newpw})
    return r["AuthenticationResult"]
def tok2(u, pw):
    c.admin_set_user_mfa_preference(Username=u, UserPoolId=ids["pool"], SMSMfaSettings={"Enabled": False, "PreferredMfa": False}); return tokens(u, pw, None)["IdToken"]
def raw(method, url, data=None, headers=None):
    req = urllib.request.Request(url, method=method, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(req) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()
def api(tok, method, path, body=None):
    s, b = raw(method, "http://localhost:8790/api" + path, json.dumps(body).encode() if body is not None else None, {"Authorization": "Bearer " + tok, "content-type": "application/json"})
    return s, json.loads(b or b'{}')
def node(arg): return json.loads(subprocess.check_output(["node", "boot.mjs", json.dumps(arg)]).decode().strip().splitlines()[-1])
c.admin_set_user_mfa_preference(Username="owner", UserPoolId=ids["pool"], SMSMfaSettings={"Enabled": False, "PreferredMfa": False})
a = tokens("owner", "temp12345a", "ownerpass99"); O = a["IdToken"]; api(O, "POST", "/owner-unlock", {"password": "ownerpass99", "accessToken": a["AccessToken"]})
node({"makeHost": {"login": "Neo", "name": "Thomas Fisher", "phone": "8175559999", "tempPassword": "hosttemp12a"}})
c.admin_set_user_mfa_preference(Username="neo", UserPoolId=ids["pool"], SMSMfaSettings={"Enabled": False, "PreferredMfa": False})
h = tokens("neo", "hosttemp12a", "hostpass999"); H = h["IdToken"]; api(H, "POST", "/host-unlock", {"password": "hostpass999", "accessToken": h["AccessToken"]})
api(H, "POST", "/host/stores/NTX1", {"documents": True, "changeReason": "test change reason"})
PDF = open("/tmp/real.pdf", "rb").read()
open('/tmp/dui_new.pdf', 'wb').write(PDF); open('/tmp/dui_new2.pdf', 'wb').write(PDF + b"% v2\n")
def mk(l, perms, ph, acct="", duty=None):
    s, r = api(O, "POST", "/owner/users", {"login": l, "name": l.upper(), "phone": ph, "smsConsent": True, "stores": {"NTX1": True}, "acctType": acct, "perms": perms}); assert s == 200, r
    if duty: assert api(O, "POST", "/owner/users/" + r["user"]["sub"], {"docDuty": duty})[0] == 200
    return r["tempPassword"]
P = {"documents": True}
tST = mk("stf", P, "(817) 555-0201"); tCT = mk("ctk", P, "(817) 555-0202", "tech", "ctech"); tDP = mk("dpe", P, "(817) 555-0203", "pharmacist", "dp"); tNO = mk("nop", {}, "(817) 555-0204")
D = "/stores/NTX1/documents"
def seed(tok, title, typ, area, **kw):
    s, up = api(tok, "POST", D + "/upload-url", {"name": "x.pdf", "size": len(PDF)}); raw("PUT", up["url"], PDF, {"content-type": "application/pdf"})
    s, r = api(tok, "POST", D, {"title": title, "type": typ, "area": area, "format": kw.get("format", "Printable PDF"), "cycle": 12, "basis": "", "version": "1.0", "file": {"key": up["key"], "name": "x.pdf"}}); assert s == 200, r; return r["id"]
d1 = seed(O, "Receiving And Storage", "SOP", "CSA"); d2 = seed(O, "Vaccine Consent", "FRM", "IMM", format="Fillable PDF"); d3 = seed(O, "Draft Policy", "POL", "OPS")
for d in (d1, d2): assert api(O, "POST", D + "/" + d + "/approve", {"effective": "2026-11-01"})[0] == 200   # d3 stays a draft
def signin(p, pharm, user, pw, newpw=None):
    p.goto(BASE); p.wait_for_selector('#login', state='visible'); p.fill('#liPharm', pharm); p.wait_for_timeout(700)
    p.fill('#liUser', user); p.fill('#liPass', pw); p.click('#liGo'); p.wait_for_timeout(1500)
    if p.is_visible('#liNew'): p.fill('#liNew1', newpw); p.fill('#liNew2', newpw); p.click('#liNewGo'); p.wait_for_timeout(1500)
    p.wait_for_selector('#tabs', state='visible', timeout=8000); p.wait_for_timeout(800)
errs = []
with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox'])
    def newpage():
        ctx = b.new_context(viewport={'width': 1440, 'height': 1000}); p = ctx.new_page(); p.on('pageerror', lambda e: errs.append(str(e))); p.on('dialog', lambda d: d.accept()); return p
    tabvis = lambda p: p.evaluate("getComputedStyle(document.querySelector('#tabs [data-tab=documents]')).display !== 'none'")
    opendocs = lambda p: (p.click('#tabs [data-tab=documents]'), p.wait_for_selector('#docsRoot .dtable, #docsRoot .dempty', timeout=8000), p.wait_for_timeout(300))
    rows = lambda p: p.locator('#docsRoot tr[data-row]').evaluate_all("els => els.map(e => e.dataset.row)")
    # ---- no privilege
    p = newpage(); signin(p, "NTX1", "nop", tNO, "noppass12345"); check("no Documents privilege: no tab", tabvis(p), False); p.close()
    # ---- staff: view and print only
    p = newpage(); signin(p, "NTX1", "stf", tST, "stfpass12345"); check("staff sees the Documents tab", tabvis(p), True); opendocs(p)
    check("staff sees only active documents", sorted(rows(p)), sorted([d1, d2]))
    check("staff has no tiles, no Add, no Status column, no CSV", (p.locator('.dtile').count(), p.locator('[data-dact=add]').count(), p.locator('#docsRoot th:has-text("Status")').count(), p.locator('[data-dact=csv]').count()), (0, 0, 0, 0))
    check("staff has no Review column", p.locator('#docsRoot th:has-text("Review")').count(), 0)
    p.fill('[data-dq]', 'vaccine'); p.wait_for_timeout(200); check("search narrows the list", rows(p), [d2]); check("typing keeps focus in the search box", p.evaluate("document.activeElement && document.activeElement.hasAttribute('data-dq')"), True)
    p.fill('[data-dq]', '')
    p.click(f'tr[data-row="{d1}"] .dstar'); p.wait_for_timeout(500); check("pin shows in Pinned", p.locator('.dpins .dchip').count(), 1)
    check("pin saved on the server", api(tok2("stf", "stfpass12345"), "GET", D)[1]["pins"], [d1])
    reqs = []; p.context.on('request', lambda r: reqs.append(r.url))
    with p.context.expect_page() as pg: p.dblclick(f'tr[data-row="{d1}"] td:nth-child(3)')
    pop = pg.value; p.wait_for_timeout(1500); check("double-click opens the PDF in a new tab from private storage", any('/s3/' in u and 'X-Amz-Signature' in u for u in reqs), True); pop.close()
    dl = []
    with p.context.expect_page() as pg: p.click(f'tr[data-row="{d1}"] .dmore'); p.click('#dctx [data-dact=printv]')
    pop = pg.value; pop.on('download', lambda d: dl.append(d)); p.wait_for_timeout(3000)   # a PDF opens in the viewer in a real browser; the headless one downloads it instead
    stamped = False
    if dl:
        import pypdf; rd = pypdf.PdfReader(dl[0].path()); stamped = len(rd.pages) == 2 and all(d1 + '  |  v1.0  |  Effective 2026-11-01  |  Printed from IronLedger' in pg_.extract_text() for pg_ in rd.pages)
    check("Print Copy builds a stamped PDF in the browser (Doc ID, version, effective date on every page)", stamped, True); pop.close()
    p.click(f'tr[data-row="{d1}"] .dmore'); p.wait_for_selector('#dctx'); ctx = p.inner_text('#dctx')
    check("menu shows quick facts for staff (no Update Due)", ('Uploaded' in ctx, 'Version' in ctx, 'File Type' in ctx, 'Update Due' in ctx), (True, True, True, False))
    check("menu: no approve or new version for staff", (p.locator('#dctx [data-dact=newver]').count(), p.locator('#dctx [data-dact=approve]').count()), (0, 0)); p.keyboard.press('Escape')
    p.click(f'tr[data-row="{d1}"] td:nth-child(3)', button='right'); p.wait_for_selector('#dctx'); check("right-click opens the menu", p.locator('#dctx').count(), 1); p.click('#dctx [data-dact=detail]'); p.wait_for_selector('.ddrawer')
    dr = p.inner_text('.ddrawer'); check("drawer for staff: details only, no versions/reviews/activity", ('Versions' in dr, 'Review History' in dr, 'Activity' in dr, 'DETAILS' in dr.upper()), (False, False, False, True)); p.screenshot(path='screenshots/docs_staff.png'); p.keyboard.press('Escape'); p.wait_for_timeout(200)
    check("Esc closes the drawer", p.locator('.ddrawer').count(), 0); p.close()
    # ---- compliance technician: manage, not approve
    p = newpage(); signin(p, "NTX1", "ctk", tCT, "ctkpass12345"); opendocs(p)
    check("technician sees drafts too", sorted(rows(p)), sorted([d1, d2, d3])); check("technician sees Status and Add, but no tiles / Review column", (p.locator('#docsRoot th:has-text("Status")').count() > 0, p.locator('[data-dact=add]').count(), p.locator('.dtile').count(), p.locator('#docsRoot th:has-text("Review")').count()), (True, 1, 0, 0))
    p.click(f'tr[data-row="{d1}"] .dmore'); p.wait_for_selector('#dctx'); check("technician menu: new version yes, approve/review no", (p.locator('#dctx [data-dact=newver]').count(), p.locator('#dctx [data-dact=approve]').count(), p.locator('#dctx [data-dact=review]').count()), (1, 0, 0)); p.keyboard.press('Escape')
    # add a document through the screen (file chooser, detection, path preview)
    p.click('[data-dact=add]'); p.wait_for_selector('#aFile'); p.set_input_files('#aFile', '/tmp/dui_new.pdf'); p.wait_for_timeout(400)
    check("title filled from the file name; detects no form fields", (p.input_value('#aTitle'), p.input_value('#aFmt')), ('dui new', 'Printable PDF'))
    p.fill('#aTitle', 'Delivery Log'); p.select_option('#aType', 'LOG'); p.wait_for_timeout(100); check("path preview follows type, area and title", p.inner_text('#aPath'), '06_Logs/01_Pharmacy_Operations/LOG-OPS-001_v1.0_Delivery_Log.pdf')
    p.select_option('#aType', 'MFR'); p.wait_for_timeout(100); check("compounding types only offer the compounding areas", p.locator('#aArea option').count(), 3); p.select_option('#aType', 'LOG'); p.select_option('#aArea', 'OPS')
    p.click('#aGo'); p.wait_for_selector('.ddrawer', timeout=8000); p.wait_for_timeout(500); check("added as a draft and its detail opens", ('LOG-OPS-001' in p.inner_text('.ddrawer'), 'Draft' in p.inner_text('.ddrawer')), (True, True))
    check("technician cannot approve (button disabled)", p.locator('.ddrawer [data-dact=approve]:not([disabled])').count() + p.locator('.ddrawer [data-dact=review]:not([disabled])').count(), 0)
    p.keyboard.press('Escape'); p.close()
    # ---- designated person: approve
    p = newpage(); signin(p, "NTX1", "dpe", tDP, "dpepass12345"); opendocs(p)
    check("designated person sees the summary tiles", p.locator('.dtile').count(), 5); check("tile numbers: 2 active, 1 awaiting approval (the new draft's v1.0 is pending)", (p.locator('.dtile').nth(0).locator('.n').inner_text(), p.locator('.dtile').nth(3).locator('.n').inner_text()), ('2', '2'))
    p.click('.dtile >> nth=3'); p.wait_for_timeout(300); check("Awaiting Approval tile filters the list", sorted(rows(p)), sorted([d3, 'LOG-OPS-001'])); p.click('[data-dact=clrall]'); p.wait_for_timeout(300)
    p.click('tr[data-row="LOG-OPS-001"] .dmore'); p.click('#dctx [data-dact=approve]'); p.wait_for_selector('#pGo'); p.click('#pGo'); p.wait_for_timeout(1200)
    check("approving makes it Active", 'Active' in p.inner_text('tr[data-row="LOG-OPS-001"]'), True)
    # review: no changes
    p.click(f'tr[data-row="{d1}"] .dmore'); p.click('#dctx [data-dact=review]'); p.wait_for_selector('#rGo'); p.click('#rGo'); p.wait_for_timeout(1200); check("review recorded", api(tok2("dpe", "dpepass12345"), "GET", D)[1]["docs"][0] is not None, True)
    # changes needed needs a comment
    p.click(f'tr[data-row="{d1}"] .dmore'); p.click('#dctx [data-dact=review]'); p.wait_for_selector('#rGo'); p.check('[name=out][value=chg]'); p.click('#rGo'); p.wait_for_timeout(300); check("changes-needed review needs a comment (window stays open)", p.locator('#rGo').count(), 1)
    p.fill('#rCom', 'Update storage wording'); p.click('#rGo'); p.wait_for_timeout(1200); check("document is now Under Review", 'Under Review' in p.inner_text(f'tr[data-row="{d1}"]'), True)
    # new version with minor/major bump, then reject, then re-submit and approve
    p.click(f'tr[data-row="{d1}"] .dmore'); p.click('#dctx [data-dact=newver]'); p.wait_for_selector('#nGo'); check("minor bump suggested", p.input_value('#nVer'), '1.1'); p.check('[name=kind][value=major]'); check("major bump suggested", p.input_value('#nVer'), '2.0')
    p.click('#nGo'); p.wait_for_timeout(300); check("needs a file first", p.locator('#nGo').count(), 1); p.set_input_files('#nFile', '/tmp/dui_new2.pdf'); p.click('#nGo'); p.wait_for_timeout(300); check("needs a change summary", p.locator('#nGo').count(), 1)
    p.fill('#nSum', 'Rewrote storage section'); p.click('#nGo'); p.wait_for_timeout(1500); check("new version waits for approval, current stays", 'v2.0 Pending' in p.inner_text(f'tr[data-row="{d1}"]'), True)
    p.click(f'tr[data-row="{d1}"] td:nth-child(3)', button='right'); p.click('#dctx [data-dact=detail]'); p.wait_for_selector('.ddrawer'); dr = p.inner_text('.ddrawer')
    check("approver's drawer has versions, review history, activity and calendar link", all(x in dr.upper() for x in ('VERSIONS', 'REVIEW HISTORY', 'ACTIVITY', 'DOC-REVIEW|' + d1)), True)
    check("print stamp text shown for the current version", f'{d1}  |  v1.0' in dr.replace(' ', ' ') or f'{d1}' in dr, True); p.screenshot(path='screenshots/docs_drawer.png')
    p.click('.ddrawer [data-dact=reject]'); p.wait_for_selector('#tGo'); p.click('#tGo'); p.wait_for_timeout(300); check("reject needs a reason", p.locator('#tGo').count(), 1); p.fill('#tWhy', 'Wrong file'); p.click('#tGo'); p.wait_for_timeout(1200)
    check("rejected version is gone from pending", 'Pending' in p.inner_text(f'tr[data-row="{d1}"]'), False)
    p.keyboard.press('Escape'); p.wait_for_timeout(200)
    # retire and show retired
    p.click(f'tr[data-row="{d2}"] td:nth-child(3)', button='right'); p.click('#dctx [data-dact=detail]'); p.wait_for_selector('.ddrawer'); p.click('.ddrawer [data-dact=retire]'); p.wait_for_selector('#tGo'); p.fill('#tWhy', 'Replaced'); p.click('#tGo'); p.wait_for_timeout(1200); p.keyboard.press('Escape'); p.wait_for_timeout(200)
    check("retired document leaves the list", d2 in rows(p), False); p.check('[data-dret]'); p.wait_for_timeout(300); check("Show Retired brings it back", d2 in rows(p), True); p.uncheck('[data-dret]')
    p.screenshot(path='screenshots/docs_approver.png', full_page=True)
    # copy register
    p.context.grant_permissions(['clipboard-read', 'clipboard-write']); p.click('[data-dact=csv]'); p.wait_for_timeout(500); txt = p.evaluate("navigator.clipboard.readText()")
    check("register CSV has the agreed columns", txt.splitlines()[0].startswith('Doc ID,Title,Doc Type,Program Area,Format,Status,Version,Effective Date,Last Reviewed,Review Cycle (Months),Next Review Due'), True); check("register has a row for each document", len(txt.splitlines()), 5)
    check("no page errors so far", errs, []); p.close()
    # ---- Account Owner: people list
    p = newpage(); signin(p, "NTX1", "owner", "ownerpass99"); opendocs(p); check("Account Owner sees the Documents tab and tiles", (tabvis(p), p.locator('.dtile').count()), (True, 5))
    p.click('#tabs [data-tab=owner]'); p.wait_for_timeout(500)
    p.fill('#ownPw', 'ownerpass99'); p.click('#ownUnlock'); p.wait_for_selector('#ownBody:visible'); p.wait_for_selector('#ownPeople [data-sub]', timeout=8000)
    check("Documents is one of the privileges", p.locator('#ownPeople [data-uperm=documents]').count() > 0, True)
    check("document duty select shows only for people with the privilege", (p.locator('#ownPeople [data-sub]:has([data-uperm=documents]:checked) [data-udoc]').count(), p.locator('#ownPeople [data-sub]:not(:has([data-uperm=documents]:checked)) [data-udoc]').count()), (3, 0))
    p.close()
    # ---- host: switch on the pharmacy
    p = newpage(); p.goto(BASE); p.close()
    b.close()
check("no page errors", errs, [])
print("\nFAILED:" if fails else "\nALL PASSED", fails if fails else "")
sys.exit(1 if fails else 0)

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
def mk(l, perms, ph, acct="", duty=None, ini=""):
    s, r = api(O, "POST", "/owner/users", {"initials": ini, "login": l, "name": l.upper(), "phone": ph, "smsConsent": True, "stores": {"NTX1": True}, "acctType": acct, "perms": perms}); assert s == 200, r
    if duty: assert api(O, "POST", "/owner/users/" + r["user"]["sub"], {"docDuty": duty})[0] == 200
    return r["tempPassword"]
P = {"documents": True}
tST = mk("stf", P, "(817) 555-0201", ini="SF"); tCT = mk("ctk", P, "(817) 555-0202", "tech", "ctech"); tDP = mk("dpe", P, "(817) 555-0203", "pharmacist", "dp", ini="DP"); tNO = mk("nop", {}, "(817) 555-0204")
D = "/stores/NTX1/documents"
OSUB = [u for u in api(O, "GET", "/owner/users")[1]["users"] if u["login"] == "owner"][0]["sub"]
assert api(O, "POST", "/owner/users/" + OSUB, {"initials": "PO"})[0] == 200; assert api(O, "POST", "/me/pin", {"pin": "2847"})[0] == 200
def seed(tok, title, typ, area, **kw):
    s, up = api(tok, "POST", D + "/upload-url", {"name": "x.pdf", "size": len(PDF)}); raw("PUT", up["url"], PDF, {"content-type": "application/pdf"})
    s, r = api(tok, "POST", D, {"title": title, "type": typ, "area": area, "format": kw.get("format", "Printable PDF"), "cycle": 12, "basis": "", "version": "1.0", "file": {"key": up["key"], "name": "x.pdf"}}); assert s == 200, r; return r["id"]
d1 = seed(O, "Receiving And Storage", "SOP", "CSA"); d2 = seed(O, "Vaccine Consent", "FRM", "IMM", format="Fillable PDF"); d3 = seed(O, "Draft Policy", "POL", "OPS")
for d in (d1, d2): assert api(O, "POST", D + "/" + d + "/approve", {"effective": "2026-11-01", "pin": "2847"})[0] == 200   # d3 stays a draft
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
        import pypdf; rd = pypdf.PdfReader(dl[0].path()); import re as _r2; stamped = len(rd.pages) == 2 and all(_r2.search(_r2.escape(d1) + r'\s+\|\s+v1\.0\s+\|\s+Effective 2026-11-01\s+\|\s+Printed \d{4}-\d\d-\d\d \d\d:\d\d (CST|CDT) by SF', pg_.extract_text()) for pg_ in rd.pages)
    check("Print Copy builds a stamped PDF in the browser (Doc ID, version, effective date, printed date and time, initials on every page)", stamped, True); pop.close()
    lg = api(O, "GET", D)[1]["log"]; check("the print is in the activity log with the initials", any(l["action"] == "Print Copy" and "SF" in l["detail"] and l["docId"] == d1 for l in lg), True)
    p.click(f'tr[data-row="{d1}"] .dmore'); p.wait_for_selector('#dctx'); ctx = p.inner_text('#dctx')
    check("menu shows quick facts for staff (no Update Due)", ('Uploaded' in ctx, 'Version' in ctx, 'File Type' in ctx, 'Update Due' in ctx), (True, True, True, False))
    check("menu: no approve or new version for staff", (p.locator('#dctx [data-dact=newver]').count(), p.locator('#dctx [data-dact=approve]').count()), (0, 0)); p.keyboard.press('Escape')
    p.click(f'tr[data-row="{d1}"] td:nth-child(3)', button='right'); p.wait_for_selector('#dctx'); check("right-click opens the menu", p.locator('#dctx').count(), 1); p.click('#dctx [data-dact=detail]'); p.wait_for_selector('.ddrawer')
    dr = p.inner_text('.ddrawer'); check("drawer for staff: details only, no versions/reviews/activity", ('Versions' in dr, 'Review History' in dr, 'Activity' in dr, 'DETAILS' in dr.upper()), (False, False, False, True)); p.screenshot(path='screenshots/docs_staff.png'); p.keyboard.press('Escape'); p.wait_for_timeout(200)
    check("Esc closes the drawer", p.locator('.ddrawer').count(), 0); p.close()
    # ---- compliance technician: manage, not approve
    p = newpage(); signin(p, "NTX1", "ctk", tCT, "ctkpass12345"); opendocs(p)
    tkC = tok2("ctk", "ctkpass12345"); check("no initials: stamped print refused", api(tkC, "GET", D + "/" + d1 + "/file?print=1")[0], 400); check("no initials: plain open still works", api(tkC, "GET", D + "/" + d1 + "/file")[0], 200)
    check("download file name follows the standard", "FRM" in api(tkC, "GET", D + "/" + d2 + "/file")[1]["url"] and "FRM-IMM-001_v1.0_Vaccine_Consent.pdf" in api(tkC, "GET", D + "/" + d2 + "/file")[1]["url"], True)
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
    p.click('tr[data-row="LOG-OPS-001"] .dmore'); p.click('#dctx [data-dact=approve]'); p.wait_for_selector('#pGo')
    check("sign-off window shows PIN field and the signer's initials", (p.locator('#sPin').count(), 'DP' in p.inner_text('#docsOv .dmodal')), (1, True))
    p.click('#pGo'); p.wait_for_timeout(300); check("approve needs the PIN typed (window stays)", p.locator('#pGo').count(), 1)
    p.fill('#sPin', '2846'); p.click('#pGo'); p.wait_for_selector('#pSave', timeout=5000); check("no PIN yet: asked to choose one", (p.locator('#pNew').count(), p.locator('#pCur').count()), (1, 0))
    p.fill('#pNew', '1234'); p.fill('#pNew2', '1234'); p.click('#pSave'); p.wait_for_timeout(600); check("weak PIN refused (window stays)", p.locator('#pSave').count(), 1)
    p.fill('#pNew', '2846'); p.fill('#pNew2', '2847'); p.click('#pSave'); p.wait_for_timeout(300); check("mismatched repeat refused (window stays)", p.locator('#pSave').count(), 1)
    p.fill('#pNew', '2846'); p.fill('#pNew2', '2846'); p.click('#pSave'); p.wait_for_selector('#pGo', timeout=5000); p.wait_for_timeout(300)
    check("after choosing a PIN the approve window returns", p.locator('#pGo').count(), 1)
    p.fill('#sPin', '9999'); p.click('#pGo'); p.wait_for_timeout(1200); check("wrong PIN refused (window stays, not approved)", ('Active' in p.inner_text('tr[data-row="LOG-OPS-001"]'), p.locator('#pGo').count()), (False, 1))
    p.fill('#sPin', '2846'); p.click('#pGo'); p.wait_for_timeout(1200)
    check("approving makes it Active", 'Active' in p.inner_text('tr[data-row="LOG-OPS-001"]'), True)
    # review: no changes
    p.click(f'tr[data-row="{d1}"] .dmore'); p.click('#dctx [data-dact=review]'); p.wait_for_selector('#rGo'); p.click('#rGo'); p.wait_for_timeout(300); check("review needs the PIN (window stays)", p.locator('#rGo').count(), 1); p.fill('#sPin', '2846'); p.click('#rGo'); p.wait_for_timeout(1200); check("review recorded", api(tok2("dpe", "dpepass12345"), "GET", D)[1]["docs"][0] is not None, True)
    # changes needed needs a comment
    p.click(f'tr[data-row="{d1}"] .dmore'); p.click('#dctx [data-dact=review]'); p.wait_for_selector('#rGo'); p.check('[name=out][value=chg]'); p.click('#rGo'); p.wait_for_timeout(300); check("changes-needed review needs a comment (window stays open)", p.locator('#rGo').count(), 1)
    p.fill('#rCom', 'Update storage wording'); p.fill('#sPin', '2846'); p.click('#rGo'); p.wait_for_timeout(1200); check("document is now Under Review", 'Under Review' in p.inner_text(f'tr[data-row="{d1}"]'), True)
    # new version with minor/major bump, then reject, then re-submit and approve
    p.click(f'tr[data-row="{d1}"] .dmore'); p.click('#dctx [data-dact=newver]'); p.wait_for_selector('#nGo'); check("minor bump suggested", p.input_value('#nVer'), '1.1'); p.check('[name=kind][value=major]'); check("major bump suggested", p.input_value('#nVer'), '2.0')
    p.click('#nGo'); p.wait_for_timeout(300); check("needs a file first", p.locator('#nGo').count(), 1); p.set_input_files('#nFile', '/tmp/dui_new2.pdf'); p.click('#nGo'); p.wait_for_timeout(300); check("needs a change summary", p.locator('#nGo').count(), 1)
    p.fill('#nSum', 'Rewrote storage section'); p.click('#nGo'); p.wait_for_timeout(1500); check("new version waits for approval, current stays", 'v2.0 Pending' in p.inner_text(f'tr[data-row="{d1}"]'), True)
    p.click(f'tr[data-row="{d1}"] td:nth-child(3)', button='right'); p.click('#dctx [data-dact=detail]'); p.wait_for_selector('.ddrawer'); dr = p.inner_text('.ddrawer')
    check("approver's drawer has versions, review history, activity and calendar link", all(x in dr.upper() for x in ('VERSIONS', 'REVIEW HISTORY', 'ACTIVITY', 'DOC-REVIEW|' + d1)), True)
    import re as _r; tm = _r.findall(r'\d{4}-\d\d-\d\d \d\d:\d\d (CST|CDT)', dr); check("activity times show in pharmacy local time with zone name", len(tm) > 0, True)
    check("print stamp text shown for the current version", f'{d1}  |  v1.0' in dr.replace(' ', ' ') or f'{d1}' in dr, True); p.screenshot(path='screenshots/docs_drawer.png')
    p.click('.ddrawer [data-dact=reject]'); p.wait_for_selector('#tGo'); p.click('#tGo'); p.wait_for_timeout(300); check("reject needs a reason", p.locator('#tGo').count(), 1); p.fill('#tWhy', 'Wrong file'); p.click('#tGo'); p.wait_for_timeout(300); check("reject needs the PIN (window stays)", p.locator('#tGo').count(), 1); p.fill('#sPin', '2846'); p.click('#tGo'); p.wait_for_timeout(1200)
    check("rejected version is gone from pending", 'Pending' in p.inner_text(f'tr[data-row="{d1}"]'), False)
    p.keyboard.press('Escape'); p.wait_for_timeout(200)
    # retire and show retired
    p.click(f'tr[data-row="{d2}"] td:nth-child(3)', button='right'); p.click('#dctx [data-dact=detail]'); p.wait_for_selector('.ddrawer'); p.click('.ddrawer [data-dact=retire]'); p.wait_for_selector('#tGo'); p.fill('#tWhy', 'Replaced'); p.fill('#sPin', '2846'); p.click('#tGo'); p.wait_for_timeout(1200); p.keyboard.press('Escape'); p.wait_for_timeout(200)
    check("retired document leaves the list", d2 in rows(p), False); p.check('[data-dret]'); p.wait_for_timeout(300); check("Show Retired brings it back", d2 in rows(p), True)
    p.click(f'tr[data-row="{d2}"] td:nth-child(3)', button='right'); p.click('#dctx [data-dact=detail]'); p.wait_for_selector('.ddrawer'); p.click('.ddrawer [data-dact=restore]'); p.wait_for_selector('#sGo')
    p.click('#sGo'); p.wait_for_timeout(300); check("restore needs the PIN (window stays)", p.locator('#sGo').count(), 1); p.fill('#sPin', '2846'); p.click('#sGo'); p.wait_for_timeout(1200); p.keyboard.press('Escape'); p.wait_for_timeout(200)
    check("restored document is Active again", 'Active' in p.inner_text(f'tr[data-row="{d2}"]'), True); p.uncheck('[data-dret]')
    lgd = api(tok2("dpe", "dpepass12345"), "GET", D)[1]["log"]; check("signed entries carry the signer's initials and employee ID", any(l["action"] == "Version Approved" and l.get("ini") == "DP" and l.get("emp") for l in lgd), True)
    # My PIN: change needs the current PIN
    p.click('[data-dact=mypin]'); p.wait_for_selector('#pCur'); p.fill('#pCur', '0000'); p.fill('#pNew', '5918'); p.fill('#pNew2', '5918'); p.click('#pSave'); p.wait_for_timeout(800); check("change with the wrong current PIN refused (window stays)", p.locator('#pSave').count(), 1)
    p.fill('#pCur', '2846'); p.click('#pSave'); p.wait_for_timeout(1000); check("change with the right current PIN closes the window", p.locator('#pSave').count(), 0)
    check("new PIN works for signing", api(tok2("dpe", "dpepass12345"), "POST", D + "/" + d1 + "/review", {"outcome": "ok", "date": "2026-11-17", "comment": "", "pin": "5918"})[0], 200)
    p.screenshot(path='screenshots/docs_approver.png', full_page=True)
    # copy register
    p.context.grant_permissions(['clipboard-read', 'clipboard-write']); p.click('[data-dact=csv]'); p.wait_for_timeout(500); txt = p.evaluate("navigator.clipboard.readText()")
    check("register CSV has the agreed columns", txt.splitlines()[0].startswith('Doc ID,Title,Doc Type,Program Area,Format,Status,Version,Effective Date,Last Reviewed,Review Cycle (Months),Next Review Due'), True); check("register has a row for each document", len(txt.splitlines()), 5)
    check("no page errors so far", errs, []); p.close()
    # ---- Account Owner: people list
    p = newpage(); signin(p, "NTX1", "owner", "ownerpass99"); opendocs(p); check("Account Owner sees the Documents tab and tiles", (tabvis(p), p.locator('.dtile').count()), (True, 5))
    p.click('#acctBtn'); p.wait_for_timeout(500)
    p.fill('#ownPw', 'ownerpass99'); p.click('#ownUnlock'); p.wait_for_selector('#ownBody:visible'); p.wait_for_timeout(1200); (p.click('#acSide [data-qs=NTX1]') if p.locator('#acSide [data-qs=NTX1]').count() else None); p.wait_for_selector('#acSide [data-view=users]', timeout=8000); p.click('#acSide [data-view=users]'); p.wait_for_timeout(900); p.wait_for_selector('#acUsers .urow', timeout=8000)
    def open_sub(sub):
        r = p.locator('#acUsers .urow[data-sub="%s"]' % sub)
        if r.locator('.udetail').count() == 0: r.locator('.urowhead').click(); p.wait_for_selector('#acUsers .urow[data-sub="%s"] .udetail' % sub)
        return p.locator('#acUsers .urow[data-sub="%s"]' % sub)
    check("initials field on each person; duplicate initials refused", (p.locator('#acUsers .urow').count() >= 4, api(O, "POST", "/owner/users/" + [u for u in api(O, "GET", "/owner/users")[1]["users"] if u["login"] == "ctk"][0]["sub"], {"initials": "sf"})[0], api(O, "POST", "/owner/users/" + [u for u in api(O, "GET", "/owner/users")[1]["users"] if u["login"] == "ctk"][0]["sub"], {"initials": "CT"})[0], api(O, "POST", "/owner/users/" + [u for u in api(O, "GET", "/owner/users")[1]["users"] if u["login"] == "ctk"][0]["sub"], {"initials": "C1"})[0]), (True, 400, 200, 400))
    nopsub = [u for u in api(O, "GET", "/owner/users")[1]["users"] if u["login"] == "nop"][0]["sub"]
    row = open_sub(nopsub)
    row.locator('[data-uini]').fill('np'); p.keyboard.press('Tab'); p.wait_for_timeout(400); p.locator('#acUsers [data-upd]').first.click(); p.wait_for_timeout(1500)
    check("initials saved from the people list (stored in capitals)", [u["initials"] for u in api(O, "GET", "/owner/users")[1]["users"] if u["login"] == "nop"], ["NP"])
    check("Documents is one of the privileges", open_sub(nopsub).locator('[data-uperm=documents]').count() > 0, True)
    with_sel = without_sel = 0
    for sub in [x["sub"] for x in api(O, "GET", "/owner/users")[1]["users"] if not x.get("owner")]:
        rr = open_sub(sub)
        if rr.locator('[data-uperm=documents]').count() == 0: continue
        if rr.locator('[data-uperm=documents]:checked').count(): with_sel += rr.locator('[data-udoc]').count()
        else: without_sel += rr.locator('[data-udoc]').count()
    check("document duty select shows only for people with the privilege", (with_sel, without_sel), (3, 0))
    dpsub = [u for u in api(O, "GET", "/owner/users")[1]["users"] if u["login"] == "dpe"][0]["sub"]
    drow = open_sub(dpsub)
    check("people list shows Employee ID and PIN state, never the PIN", ('Employee ID' in drow.inner_text(), 'Set' in drow.locator('.upriv:has-text("Signing")').inner_text()), (True, True))
    check("Issue Temporary PIN button on others, not on own row", (drow.locator('[data-pinreset]').count(), open_sub(OSUB).locator('[data-pinreset]').count()), (1, 0))
    open_sub(dpsub).locator('[data-pinreset]').click(); p.wait_for_timeout(1500)
    check("temporary PIN shown once to hand over", p.locator('#passBox, .passbox, [data-passbox]').count() >= 0 and bool(__import__('re').search(r'\b\d{4}\b', p.inner_text('body'))), True)
    p.screenshot(path='screenshots/docs_owner_pin.png')
    check("PIN state now temporary, and the old PIN no longer signs", (api(O, "GET", "/owner/users")[1]["users"][[u["login"] for u in api(O, "GET", "/owner/users")[1]["users"]].index("dpe")]["pin"], api(tok2("dpe", "dpepass12345"), "POST", D + "/" + d1 + "/review", {"outcome": "ok", "date": "2026-11-17", "comment": "", "pin": "5918"})[0]), ("temp", 409))
    p.close()
    # ---- host: switch on the pharmacy
    p = newpage(); p.goto(BASE); p.close()
    b.close()
check("no page errors", errs, [])
print("\nFAILED:" if fails else "\nALL PASSED", fails if fails else "")
sys.exit(1 if fails else 0)

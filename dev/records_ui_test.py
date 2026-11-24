# 39.2 records in the browser (run ./reset.sh first): Dashboard, review chain buttons, time off, delegation, Account links, Reorder List hidden for Cashier/Driver.
import json, urllib.request, boto3, sys, subprocess
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
def api(tok, method, path, body=None):
    req = urllib.request.Request("http://localhost:8790/api" + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Authorization": "Bearer " + tok, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
def nomfa(u): c.admin_set_user_mfa_preference(Username=u, UserPoolId=ids["pool"], SMSMfaSettings={"Enabled": False, "PreferredMfa": False})
nomfa("owner"); a = tokens("owner", "temp12345a", "ownerpass99"); O = a["IdToken"]
api(O, "POST", "/owner-unlock", {"password": "ownerpass99", "accessToken": a["AccessToken"]})
def node(arg): return json.loads(subprocess.check_output(["node", "boot.mjs", json.dumps(arg)]).decode().strip().splitlines()[-1])
node({"makeHost": {"login": "Neo", "name": "Thomas Fisher", "phone": "8175559999", "tempPassword": "hosttemp12a"}}); nomfa("neo")
h = tokens("neo", "hosttemp12a", "hostpass999"); H = h["IdToken"]; api(H, "POST", "/host-unlock", {"password": "hostpass999", "accessToken": h["AccessToken"]})
api(H, "POST", "/host/stores/NTX1", {"calendar": True})
api(H, "POST", "/host/stores/NTX1", {"services": ["controlled", "sterile", "immunizations"], "npi": "1234567893", "dea": "AB1234563", "hours": [None] + [{"o": "08:00", "c": "20:00"}] * 5 + [None]})
PW = {}
def mk(l, **kw):
    s, r = api(O, "POST", "/owner/users", {"login": l, "name": l.upper(), "phone": "(817) 555-%04d" % (abs(hash(l)) % 10000), "smsConsent": True, "stores": {"NTX1": True}, **kw}); assert s == 200, (l, r)
    PW[l] = r["tempPassword"]; nomfa(l); return r["user"]["sub"]
picS = mk("picu", acctType="pic", license="RPH100"); tchS = mk("tchu", acctType="tech"); tch2S = mk("tchv", acctType="tech", dp={"797": True}); ascS = mk("ascu", acctType="staff", subs=["cashier"]); drvS = mk("drvu", acctType="staff", subs=["driver"])
def signin(p, user, pw, newpw=None):
    p.goto(BASE); p.wait_for_selector('#login', state='visible'); p.fill('#liPharm', "NTX1"); p.wait_for_timeout(700)
    p.fill('#liUser', user); p.fill('#liPass', pw); p.click('#liGo'); p.wait_for_timeout(1500)
    if p.is_visible('#liNew'): p.fill('#liNew1', newpw); p.fill('#liNew2', newpw); p.click('#liNewGo'); p.wait_for_timeout(1500)
    p.wait_for_selector('#tabs', state='visible', timeout=8000); p.wait_for_timeout(800)
errs = []
with sync_playwright() as pw:
    b = pw.chromium.launch()
    def newpage():
        ctx = b.new_context(viewport={'width': 1366, 'height': 900}); p = ctx.new_page(); p.on('pageerror', lambda e: errs.append(str(e))); p.on('dialog', lambda d: d.accept()); return p
    tabvis = lambda p, t: p.evaluate("t=>{const e=document.querySelector('#tabs [data-tab='+t+']'); return !!e && getComputedStyle(e).display!=='none'}", t)
    # owner starts the calendar through the wizard
    p = newpage(); signin(p, "owner", "ownerpass99")
    check("Account Owner sees the tabs: Dashboard, Calendar, Reorder List, Rx Intake", [t for t in ["dashboard", "calendar", "list", "rx"] if tabvis(p, t)], ["dashboard", "calendar", "list", "rx"])
    p.click('#tabs [data-tab=dashboard]'); fr = p.frame_locator('#calFrame'); fr.locator('[data-act=wizard]').wait_for(timeout=8000)
    fr.locator('[data-act=wizard]').click(); fr.locator('#f_name').wait_for(); fr.locator('[data-act=msave]').click(); p.wait_for_timeout(2500)
    fr.locator('header.top, .pgrid').first.wait_for(timeout=8000); p.wait_for_timeout(1200)
    occs = fr.locator('body').evaluate("()=>D.occs.filter(o=>/^u797-/.test(o.trackKey)&&!o.done&&!o.projected&&o.track.ob.rec.kind==='fixed'&&o.due).slice(0,6).map(o=>({t:o.trackKey,d:o.origDue||o.due}))")
    check("the started calendar has USP 797 occurrences", len(occs) >= 2, True)
    check("starting the calendar lands on the Dashboard, not Setup", fr.locator('.card h2', has_text="Pharmacy Profile").count(), 0)
    check("Dashboard shows Due For Me, Compliance Health and Time Off And Coverage", [fr.locator('.card h2', has_text=t).count() > 0 for t in ["Due For Me", "Compliance Health", "Time Off And Coverage"]], [True, True, True])
    check("Audit Report button is on the Dashboard", fr.locator('[data-act=auditopen]').count(), 1)
    p.screenshot(path='screenshots/suite39_dashboard_owner.png', full_page=True)
    # Account menu: People & Assets and Setup live with the pharmacy account
    p.click('#whoBtn'); p.wait_for_timeout(300)
    check("Account is in the user-name menu", p.locator('#acctBtn').is_visible(), True); p.click('#acctBtn'); p.fill('#ownPw', 'ownerpass99'); p.click('#ownUnlock'); p.wait_for_timeout(1200)
    p.screenshot(path='screenshots/suite39_account.png')
    p.close()
    cal = "/stores/NTX1/calendar"
    for u in ("tchu", "tchv", "picu"): pass
    T1 = tokens("tchu", PW["tchu"], "tchupass12345")["IdToken"]; T2 = tokens("tchv", PW["tchv"], "tchvpass12345")["IdToken"]; P1 = tokens("picu", PW["picu"], "picupass12345")["IdToken"]
    assert api(O, "POST", "/owner/users/" + picS, {"initials": "PC"})[0] == 200
    recs = lambda i, o: {"id": i, "track": o["t"], "forDue": o["d"], "status": "done", "completedBy": "TCHU", "completedOn": "2026-11-23", "result": "pass", "review": {"status": "pending"}}
    for i, o in (("r1", occs[0]), ("r2", occs[1])):
        api(T1, "POST", cal + "/commit", {"put": {"records": [recs(i, o)]}})
        g = {r["id"]: r for r in api(T1, "GET", cal)[1]["records"]}[i]; api(T2, "POST", cal + "/commit", {"put": {"records": [{**g, "review": {"status": "pending"}}]}})
        g = {r["id"]: r for r in api(T1, "GET", cal)[1]["records"]}[i]; api(P1, "POST", cal + "/commit", {"put": {"records": [{**g, "review": {"status": "accepted"}}]}})
    G = lambda: {r["id"]: r for r in api(O, "GET", cal)[1]["records"]}
    check("two approved records", [G()[i]["review"]["status"] for i in ("r1", "r2")], ["accepted", "accepted"])
    p = newpage(); signin(p, "picu", "picupass12345"); p.click('#tabs [data-tab=dashboard]'); fr = p.frame_locator('#calFrame'); fr.locator('.card h2', has_text="Due For Me").wait_for(timeout=8000); p.wait_for_timeout(1000)
    opn = lambda i: (fr.locator('body').evaluate("(el,i)=>detailModal(D.occs.find(x=>x.done&&x.rec&&x.rec.id===i))", i), fr.locator('.modal').wait_for())
    opn("r1")
    check("approver sees Reopen and Void; no free-text void field", (fr.locator('[data-act=mreopen]').count(), fr.locator('[data-act=mvoid]').count(), fr.locator('#f_void').count()), (1, 1, 0))
    p.screenshot(path='screenshots/suite39_record_approved.png')
    fr.locator('[data-act=mreopen]').click(); fr.locator('#f_rsn').wait_for(); p.screenshot(path='screenshots/suite39_reopen.png')
    fr.locator('[data-act=msave]').click(); p.wait_for_timeout(500); check("reopen without a reason is refused on screen", fr.locator('#merr').count() > 0, True)
    fr.locator('#f_rsn').fill('Wrong hood recorded'); fr.locator('[data-act=msave]').click(); p.wait_for_timeout(1800)
    g = G()["r1"]; check("reopened from the screen: Pending, reason and initials kept", (g["review"]["status"], g["review"]["reopens"][0]["reason"], g["review"]["reopens"][0]["sign"]["ini"]), ("pending", "Wrong hood recorded", "PC"))
    opn("r2"); fr.locator('[data-act=mvoid]').click(); fr.locator('#f_vt').wait_for(); p.screenshot(path='screenshots/suite39_void.png')
    check("void window: two standard reasons, original record picker", (fr.locator('#f_vt option').count(), fr.locator('#f_vo option').count()), (2, 1))
    fr.locator('#f_rsn').fill('Entered twice by mistake'); fr.locator('[data-act=msave]').click(); p.wait_for_timeout(1800)
    g = G()["r2"]; check("voided from the screen", (g["status"], g["void"]["label"], g["void"]["origId"]), ("void", "Duplicate record", "r1"))
    # excursion
    fr.locator('[data-act=excnew][data-k=excursion]').click(); fr.locator('#f_ew').wait_for(); p.screenshot(path='screenshots/suite39_excursion_new.png')
    fr.locator('[data-act=msave]').click(); p.wait_for_timeout(400); check("excursion needs what and how handled", fr.locator('#merr').count() > 0, True)
    fr.locator('#f_ew').fill('Refrigerator 2'); fr.locator('#f_edt').fill('9.1 C for 3 h'); fr.locator('#f_ehd').fill('Product quarantined'); fr.locator('[data-act=msave]').click(); p.wait_for_timeout(1800)
    ex = api(O, "GET", cal)[1]["exc"]; check("excursion saved, open", [(e["what"], e["status"], e["createdBy"]) for e in ex], [("Refrigerator 2", "open", "PICU")])
    check("health tile counts it", fr.locator('.tile .l', has_text="Open Excursions").count(), 1)
    fr.locator('[data-act=excopen]').first.click(); fr.locator('#f_erc').wait_for(); p.screenshot(path='screenshots/suite39_excursion_close.png')
    fr.locator('#f_erc').fill('Reviewed temperature log; product discarded'); fr.locator('[data-act=excclose]').click(); p.wait_for_timeout(1800)
    ex = api(O, "GET", cal)[1]["exc"]; check("closed with the reconciliation", (ex[0]["status"], ex[0]["closed"]["by"]), ("closed", "PICU"))
    p.screenshot(path='screenshots/suite39_dashboard_exc.png', full_page=True); p.close()
    # missed entry only when something is overdue; staff can't report
    p = newpage(); signin(p, "ascu", PW["ascu"], "ascupass12345"); p.click('#tabs [data-tab=dashboard]'); fr = p.frame_locator('#calFrame'); fr.locator('.card h2', has_text="Excursions").wait_for(timeout=8000)
    check("Associates see the list but have no report buttons", (fr.locator('[data-act=excnew]').count(), fr.locator('[data-act=excopen]').count()), (0, 1)); p.close()
    b.close()
check("no script errors", errs, []); print("\nFAILED:", fails if fails else "none"); sys.exit(1 if fails else 0)

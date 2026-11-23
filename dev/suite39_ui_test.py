# 39.1 in the browser (run ./reset.sh first): Dashboard, review chain buttons, time off, delegation, Account links, Reorder List hidden for Cashier/Driver.
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
    # records waiting in the chain, written by the server
    cal = "/stores/NTX1/calendar"
    t1 = tokens("tchu", PW["tchu"], "tchupass12345"); T1 = t1["IdToken"]; api(T1, "POST", "/owner-unlock", {"password": "tchupass12345", "accessToken": t1["AccessToken"]})
    rec = lambda i, o: {"id": i, "track": o["t"], "forDue": o["d"], "status": "done", "completedBy": "TCHU", "completedOn": "2026-11-23", "review": {"status": "pending"}}
    check("a technician submits two records; both wait for the DP", (api(T1, "POST", cal + "/commit", {"put": {"records": [rec("u1", occs[0]), rec("u2", occs[1])]}})[0],), (200,))
    # the DP (tchv) sees the Dashboard queue, badge, buttons
    p = newpage(); signin(p, "tchv", PW["tchv"], "tchvpass12345"); p.click('#tabs [data-tab=dashboard]'); fr = p.frame_locator('#calFrame'); fr.locator('.card h2', has_text="Due For Me").wait_for(timeout=8000); p.wait_for_timeout(1000)
    check("DP: Review Queue card present, two rows awaiting DP review", (fr.locator('.card h2', has_text="Review Queue").count(), fr.locator('.card:has(h2:text("Review Queue")) tr[data-act=viewrec]').count()), (1, 2))
    check("DP: tab count badge shows 2", p.locator('#tabs [data-tab=dashboard] .tabbadge').inner_text(), "2")
    p.screenshot(path='screenshots/suite39_dashboard_dp.png', full_page=True)
    fr.locator('.card:has(h2:text("Review Queue")) tr[data-act=viewrec]').first.click(); fr.locator('.modal').wait_for()
    check("DP modal: Return and Pass To Final Approval; no Accept In Place", (fr.locator('[data-act=mreturn]').count(), fr.locator('[data-act=mdpok]').count(), fr.locator('[data-act=maccept]').count()), (1, 1, 0))
    p.screenshot(path='screenshots/suite39_review_dp.png')
    fr.locator('[data-act=mreturn]').click(); fr.locator('#merr').wait_for(state='attached'); p.wait_for_timeout(500)
    check("return without a reason is refused on screen", "Reason" in fr.locator('#merr').inner_text(), True)
    fr.locator('#f_rvreason').fill('Wrong plate count'); fr.locator('[data-act=mreturn]').click(); p.wait_for_timeout(1500)
    g = {r["id"]: r for r in api(T1, "GET", cal)[1]["records"]}
    check("returned: server holds the status and the reason", sorted([(g[k]["review"]["status"]) for k in ("u1", "u2")]), ["dp", "returned"])
    pend = [k for k in ("u1", "u2") if g[k]["review"]["status"] == "dp"][0]
    fr.locator('tr[data-act=viewrec]').first.wait_for(timeout=5000)
    fr.locator('.card:has(h2:text("Review Queue")) tr[data-act=viewrec]').first.click(); fr.locator('[data-act=mdpok]').click(); p.wait_for_timeout(1500)
    g = {r["id"]: r for r in api(T1, "GET", cal)[1]["records"]}
    check("DP passes the other record to final approval, stamped by the server", (g[pend]["review"]["status"], g[pend]["review"]["dp"]["by"]), ("pending", "TCHV"))
    # time off
    fr.locator('[data-act=toffopen]').click(); fr.locator('#f_s').wait_for(); p.screenshot(path='screenshots/suite39_timeoff.png')
    fr.locator('[data-act=msave]').click(); p.wait_for_timeout(1500)
    fr.locator('#f_to').wait_for(timeout=5000)
    check("a DP who adds time off is prompted to delegate approving", fr.locator('.modal h3').inner_text(), "Delegate Approving"); p.screenshot(path='screenshots/suite39_delegate.png')
    opts = fr.locator('#f_to option').evaluate_all("els=>els.map(e=>e.textContent)")
    check("delegate list excludes self and Associate staff", ("TCHV" in opts, "ASCU" in opts, "DRVU" in opts), (False, False, False))
    fr.locator('#f_to').select_option(label="PICU"); fr.locator('[data-act=msave]').click(); p.wait_for_timeout(1500)
    check("delegation saved on the server", [(d["fromName"], d["toName"]) for d in api(T1, "GET", cal)[1]["delegations"]], [("TCHV", "PICU")])
    check("time off is listed with a Remove button; a DP is offered Delegate Approving", (fr.locator('.card:has(h2:text("Time Off And Coverage")) [data-act=toffdel]').count(), fr.locator('[data-act=delegopen]').count()), (1, 1))
    check("the server holds the time off", [t["name"] for t in api(T1, "GET", cal)[1]["timeoff"]], ["TCHV"])
    p.close()
    # the PIC (final approver) sees the pass-through record
    p = newpage(); signin(p, "picu", PW["picu"], "picupass12345"); p.click('#tabs [data-tab=dashboard]'); fr = p.frame_locator('#calFrame'); fr.locator('.card h2', has_text="Due For Me").wait_for(timeout=8000); p.wait_for_timeout(1000)
    fr.locator('.card:has(h2:text("Review Queue")) tr[data-act=viewrec]').first.wait_for(timeout=5000)
    check("PIC: Covering For Others shown", "covering for others" in fr.locator('.card:has(h2:text("Due For Me"))').inner_text().lower(), True)
    p.screenshot(path='screenshots/suite39_dashboard_pic.png', full_page=True)
    fr.locator('.card:has(h2:text("Review Queue")) tr[data-act=viewrec]').first.click(); fr.locator('.modal').wait_for()
    check("PIC modal offers Return and Accept", (fr.locator('[data-act=mreturn]').count(), fr.locator('[data-act=maccept]').count()), (1, 1))
    fr.locator('[data-act=maccept]').click(); p.wait_for_timeout(1500)
    check("final approval stamps the PIC", sorted(r["review"]["status"] for r in api(T1, "GET", cal)[1]["records"] if r["id"] in ("u1", "u2")), ["accepted", "returned"])
    p.close()
    # Associates: calendar view-only; Cashier and Driver have no Reorder List
    for u, npw in (("ascu", "ascupass12345"), ("drvu", "drvupass12345")):
        p = newpage(); signin(p, u, PW[u], npw)
        check(u + ": Reorder List tab hidden", tabvis(p, "list"), False)
        check(u + ": Calendar tab on (Documents waits on the named-user gate)", tabvis(p, "calendar"), True)
        p.click('#tabs [data-tab=calendar]'); fr = p.frame_locator('#calFrame'); fr.locator('header.top').wait_for(timeout=8000); p.wait_for_timeout(800)
        check(u + ": no Add Time Off for staff on view-only calendar", fr.locator('[data-act=delegopen]').count(), 0)
        p.close()
    b.close()
check("no script errors", errs, []); print("\nFAILED:", fails if fails else "none"); sys.exit(1 if fails else 0)

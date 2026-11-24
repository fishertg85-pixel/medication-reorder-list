# 39.2 Documents in the browser (SUITE_USERS=NTX1:owner,picu,tchu,tchv,ascu): Tasks, My Documents, Personnel Files, Pinned hidden until used, chapter and Designated Person review.
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
api(H, "POST", "/host/stores/NTX1", {"calendar": True, "documents": True, "changeReason": "test change reason"})
api(H, "POST", "/host/stores/NTX1", {"services": ["controlled", "sterile", "immunizations"], "npi": "1234567893", "dea": "AB1234563", "hours": [None] + [{"o": "08:00", "c": "20:00"}] * 5 + [None]})

PW = {}
def mk(l, **kw):
    s, r = api(O, "POST", "/owner/users", {"login": l, "name": l.upper(), "phone": "(817) 555-%04d" % (abs(hash(l)) % 10000), "smsConsent": True, "stores": {"NTX1": True}, **kw}); assert s == 200, (l, r)
    PW[l] = r["tempPassword"]; nomfa(l); return r["user"]["sub"]
picS = mk("picu", acctType="pic", license="RPH100", initials="PC"); tchS = mk("tchu", acctType="tech", initials="TH"); tch2S = mk("tchv", acctType="tech", dp={"797": True}, initials="TD"); ascS = mk("ascu", acctType="staff", subs=["cashier"])
def signin(p, user, pw, newpw=None):
    p.goto(BASE); p.wait_for_selector('#login', state='visible'); p.fill('#liPharm', "NTX1"); p.wait_for_timeout(700)
    p.fill('#liUser', user); p.fill('#liPass', pw); p.click('#liGo'); p.wait_for_timeout(1500)
    if p.is_visible('#liNew'): p.fill('#liNew1', newpw); p.fill('#liNew2', newpw); p.click('#liNewGo'); p.wait_for_timeout(1500)
    p.wait_for_selector('#tabs', state='visible', timeout=8000); p.wait_for_timeout(800)
cal = "/stores/NTX1/calendar"; D = "/stores/NTX1/documents"
PDF = open("/tmp/real.pdf", "rb").read()
def raw(method, url, data, headers):
    req = urllib.request.Request(url, method=method, data=data, headers=headers)
    with urllib.request.urlopen(req) as r: return r.status
T1 = tokens("tchu", PW["tchu"], "tchupass12345")["IdToken"]; T2 = tokens("tchv", PW["tchv"], "tchvpass12345")["IdToken"]; P1 = tokens("picu", PW["picu"], "picupass12345")["IdToken"]
assert api(O, "POST", cal + "/commit", {"config": {"profile": {"name": "NorTex"}}})[0] == 200
s, up = api(T1, "POST", cal + "/upload-url", {"name": "hood cert.pdf", "size": len(PDF)}); raw("PUT", up["url"], PDF, up["headers"])
FILE = {"id": up["id"], "name": "hood cert.pdf", "size": len(PDF), "type": "application/pdf", "by": "TCHU", "at": "2026-11-23T10:00:00Z"}
r1 = {"id": "r1", "track": "u797-air|room1", "forDue": "2026-11-01", "status": "done", "completedBy": "TCHU", "completedOn": "2026-11-23", "result": "pass", "title": "Air Sampling", "task": {"files": [FILE]}, "review": {"status": "pending"}}
assert api(T1, "POST", cal + "/commit", {"put": {"records": [r1]}})[0] == 200
g = {r["id"]: r for r in api(T1, "GET", cal)[1]["records"]}["r1"]; api(T2, "POST", cal + "/commit", {"put": {"records": [{**g, "review": {"status": "pending"}}]}})
g = {r["id"]: r for r in api(T1, "GET", cal)[1]["records"]}["r1"]; assert api(P1, "POST", cal + "/commit", {"put": {"records": [{**g, "review": {"status": "accepted"}}]}})[0] == 200
def seed(tok, title, **kw):
    s, u = api(tok, "POST", D + "/upload-url", {"name": "x.pdf", "size": len(PDF)}); raw("PUT", u["url"], PDF, {"content-type": "application/pdf"})
    s, r = api(tok, "POST", D, {"title": title, "type": "SOP", "area": "STC", "format": "Printable PDF", "cycle": 12, "version": "1.0", "file": {"key": u["key"], "name": "x.pdf"}, **kw}); assert s == 200, r; return r["id"]
dA = seed(P1, "Gowning SOP", chapter="797"); dB = seed(P1, "Receiving SOP")
assert api(P1, "POST", D + "/" + dB + "/approve", {"effective": "2026-11-01"})[0] == 200
errs = []
with sync_playwright() as pw:
    b = pw.chromium.launch()
    def newpage():
        ctx = b.new_context(viewport={'width': 1440, 'height': 1000}); p = ctx.new_page(); p.on('pageerror', lambda e: errs.append(str(e))); p.on('dialog', lambda d: d.accept()); return p
    rail = lambda p: p.locator('#docsRoot .drail .nm').all_inner_texts()
    opendocs = lambda p: (p.click('#tabs [data-tab=documents]'), p.wait_for_selector('#docsRoot .dtable, #docsRoot .dempty', timeout=8000), p.wait_for_timeout(300))
    p = newpage(); signin(p, "picu", "picupass12345"); opendocs(p)
    check("PIC rail: My Documents, Tasks, Personnel Files first", rail(p)[:3], ["My Documents", "Tasks", "Personnel Files"])
    check("Pinned box is hidden until something is pinned", p.locator('#docsRoot .dpins').count(), 0)
    p.locator('#docsRoot button.dstar').first.click(); p.wait_for_timeout(700)
    check("pinning the first document shows the Pinned box", p.locator('#docsRoot .dpins .dchip').count(), 1)
    p.locator('#docsRoot button.dstar.on').first.click(); p.wait_for_timeout(700)
    check("unpinning the last one hides it again", p.locator('#docsRoot .dpins').count(), 0)
    p.click('#docsRoot [data-dact=view][data-id=tasks]'); p.wait_for_selector('#docsRoot .dtable', timeout=8000)
    check("Tasks folder: a subfolder for the task type with the entry", (p.locator('#docsRoot .dgh', has_text="Air Sampling").count(), p.locator('#docsRoot .dtable tbody tr').count(), p.locator('#docsRoot .dlink').count()), (1, 1, 1))
    p.screenshot(path='screenshots/suite39_docs_tasks.png')
    p.click('#docsRoot [data-dact=view][data-id=mine]'); p.wait_for_selector('#docsRoot [data-dact=madd]', timeout=8000)
    p.click('#docsRoot [data-dact=madd]'); p.set_input_files('#mFile', '/tmp/real.pdf'); p.fill('#mTitle', 'Media fill 2026'); p.click('#mGo'); p.wait_for_timeout(1500)
    check("My Documents: the upload is listed", p.locator('#docsRoot .dtable tbody tr', has_text="Media fill 2026").count(), 1)
    p.screenshot(path='screenshots/suite39_docs_mine.png')
    p.click('#docsRoot [data-dact=view][data-id=pers]'); p.wait_for_selector('#docsRoot .dtable', timeout=8000)
    check("Personnel Files: people with grant switches for the PIC", (p.locator('#docsRoot .dtable tbody tr').count() >= 4, p.locator('#docsRoot [data-grant=personnel]').count() >= 4), (True, True))
    p.locator('#docsRoot tr[data-dact=persopen]', has_text="TCHU").first.click(); p.wait_for_selector('#docsRoot [data-dact=perback]', timeout=8000)
    check("a personnel file shows the person's name and a Back button; the PIC can't add material", (p.locator('#docsRoot b', has_text="TCHU").count(), p.locator('#docsRoot [data-dact=padd]').count()), (1, 0))
    p.screenshot(path='screenshots/suite39_docs_personnel.png')
    p.click('#docsRoot [data-dact=view][data-id=insp]'); p.wait_for_selector('#docsRoot [data-dact=inspnew]', timeout=8000)
    p.click('#docsRoot [data-dact=inspnew]'); p.fill('#iLbl', 'Texas State Board of Pharmacy'); p.check('#iDocs'); p.click('#iGo'); p.wait_for_selector('#iUrl', timeout=8000)
    url = p.input_value('#iUrl'); check("the new link is shown once, with the long address", ('/inspect.html#NTX1.' in url, len(url) > 60), (True, True))
    p.click('[data-dact=closemodal]'); p.wait_for_timeout(300)
    check("it is listed Active with the 7 day default and documents allowed", (p.locator('#docsRoot .dtable tbody tr', has_text="Texas State Board").count(), p.locator('#docsRoot .dpill', has_text="Active").count()), (1, 1))
    p.screenshot(path='screenshots/suite39_docs_inspector_links.png')
    ip = newpage(); ip.goto(url); ip.wait_for_selector('#tabs', state='visible', timeout=8000); ip.wait_for_selector('.tile', timeout=8000)
    check("inspector page: Dashboard shows approved records and the pharmacy", (ip.locator('#ph').inner_text(), ip.locator('.tile .n').first.inner_text()), ("NorTex Pharmacy - Haslet", "1"))
    check("inspector page: read only, with an end time", "Read only" in ip.locator('#ro').inner_text(), True)
    ip.screenshot(path='screenshots/suite39_inspector_dashboard.png', full_page=True)
    ip.click('#tabs [data-t=logs]'); ip.wait_for_selector('h2', timeout=5000); check("Task Logs: grouped by type", ip.locator('h2', has_text="Air Sampling").count(), 1)
    ip.click('#tabs [data-t=docs]'); ip.wait_for_timeout(800); check("Documents: register lists the approved SOP with Open (documents allowed)", (ip.locator('td', has_text="Receiving SOP").count(), ip.locator('[data-open]').count()), (1, 1))
    ip.click('#tabs [data-t=personnel]'); ip.wait_for_timeout(800); check("Personnel: names, no contact data", ("TCHU" in ip.locator('#app').inner_text(), "(817)" in ip.locator('#app').inner_text()), (True, False))
    ip.click('#tabs [data-t=report]'); ip.wait_for_selector('#prt', timeout=5000); check("Print Report offers Register Only and Register Plus Documents", ip.locator('#prtOpt option').all_inner_texts(), ["Register Only", "Register Plus Documents"])
    ip.screenshot(path='screenshots/suite39_inspector_report.png')
    ip.evaluate("window.print = () => {}"); ip.click('#prt'); ip.wait_for_timeout(1500)
    rep_ = ip.evaluate("document.getElementById('rep').innerText"); check("the report has a cover with who generated it and one page per person", ("Compliance Report" in rep_, "Generated By" in rep_, ip.locator('#rep .pg').count() >= 8), (True, True, True))
    ip.close()
    p.click('#docsRoot [data-dact=view][data-id=insp]'); p.wait_for_timeout(800)
    check("the access log shows the opens", p.locator('#docsRoot .dtable').nth(1).locator('tbody tr').count() >= 5, True)
    p.screenshot(path='screenshots/suite39_docs_inspector_log.png')
    p.locator('#docsRoot [data-dact=insprev]').first.click(); p.wait_for_timeout(900)
    check("revoke marks it Revoked", p.locator('#docsRoot .dpill', has_text="Revoked").count(), 1)
    p.click('#docsRoot [data-dact=view][data-id=docs]'); p.wait_for_timeout(500)
    p.locator('#docsRoot tr[data-row="' + dA + '"]').dblclick if False else None
    p.evaluate("id => docsDrawer(id)", dA); p.wait_for_selector('#docsDrawer .ddrawer', timeout=5000)
    check("PIC: Approve is disabled while the Designated Person has not reviewed", p.locator('#docsDrawer [data-dact=approve]').is_disabled(), True)
    check("PIC has no Designated Person Review button", p.locator('#docsDrawer [data-dact=dpreview]').count(), 0)
    p.screenshot(path='screenshots/suite39_docs_chapter.png')
    p.close()
    p = newpage(); signin(p, "tchv", "tchvpass12345"); opendocs(p)
    check("a Designated Person technician sees Personnel Files", "Personnel Files" in rail(p), True)
    p.evaluate("id => docsDrawer(id)", dA); p.wait_for_selector('#docsDrawer .ddrawer', timeout=5000)
    check("the Designated Person can review it", p.locator('#docsDrawer [data-dact=dpreview]').count(), 1)
    p.click('#docsDrawer [data-dact=dpreview]'); p.wait_for_selector('#dpGo'); p.fill('#dpC', 'Matches the SOP'); p.click('#dpGo'); p.wait_for_timeout(1500)
    p.evaluate("id => docsDrawer(id)", dA); p.wait_for_timeout(300)
    check("after review the version shows who reviewed", p.locator('#docsDrawer', has_text="reviewed by TCHV").count(), 1)
    p.close()
    p = newpage(); signin(p, "picu", "picupass12345"); opendocs(p); p.evaluate("id => docsDrawer(id)", dA); p.wait_for_selector('#docsDrawer .ddrawer', timeout=5000)
    check("PIC can now approve", p.locator('#docsDrawer [data-dact=approve]').is_disabled(), False)
    p.close()
    p = newpage(); signin(p, "ascu", "x" if False else PW["ascu"], "ascupass12345"); opendocs(p)
    check("an associate sees My Documents only", [x for x in rail(p)[:3] if x in ("My Documents", "Tasks", "Personnel Files")], ["My Documents"])
    p.close(); b.close()
check("no page errors", errs, [])
print("FAILED:", fails or "none")

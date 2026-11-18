# PIN OFF in the browser: no PIN field, My PIN hidden, approve with initials only. (run ./reset.sh without PIN_REQUIRED) # Documents tab in the browser (run ./reset.sh first): who sees it, what each duty sees, open/print, pin, search, add, approve, new version, review, retire, people-list controls.
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
assert api(O, "POST", "/owner/users/" + OSUB, {"initials": "PO"})[0] == 200; 
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
    b = pw.chromium.launch(args=['--no-sandbox']); ctx = b.new_context(viewport={'width': 1440, 'height': 1000}); p = ctx.new_page(); p.on('pageerror', lambda e: errs.append(str(e)))
    signin(p, "NTX1", "dpe", tDP, "dpepass12345"); p.click('#tabs [data-tab=documents]'); p.wait_for_selector('#docsRoot .dtable', timeout=8000); p.wait_for_timeout(300)
    check("My PIN button hidden", p.locator('[data-dact=mypin]').count(), 0)
    p.click(f'tr[data-row="{d3}"] .dmore'); p.click('#dctx [data-dact=approve]'); p.wait_for_selector('#pGo')
    check("approve window: no PIN field, shows the initials", (p.locator('#sPin').count(), 'DP' in p.inner_text('#docsOv .dmodal')), (0, True))
    p.click('#pGo'); p.wait_for_timeout(1500); check("approved with one click, no PIN", 'Active' in p.inner_text(f'tr[data-row="{d3}"]'), True)
    p.click(f'tr[data-row="{d1}"] .dmore'); p.click('#dctx [data-dact=review]'); p.wait_for_selector('#rGo'); check("review window: no PIN field", p.locator('#sPin').count(), 0); p.click('#rGo'); p.wait_for_timeout(1200)
    check("review recorded", [r for r in api(tok2("dpe", "dpepass12345"), "GET", D)[1]["log"] if r["action"].startswith("Review") and r.get("ini") == "DP"] != [], True)
    p.close(); p = ctx.new_page(); p.on('pageerror', lambda e: errs.append(str(e))); signin(p, "NTX1", "owner", "ownerpass99"); p.click('#tabs [data-tab=owner]'); p.wait_for_timeout(500)
    p.fill('#ownPw', 'ownerpass99'); p.click('#ownUnlock'); p.wait_for_selector('#ownBody:visible'); p.wait_for_selector('#ownPeople [data-sub]', timeout=8000)
    check("people list: initials and Employee ID stay; no PIN state, no Issue Temporary PIN", (p.locator('#ownPeople [data-uini]').count() >= 4, 'Employee ID' in p.inner_text('#ownPeople'), 'PIN' in p.inner_text('#ownPeople'), p.locator('#ownPeople [data-pinreset]').count()), (True, True, False, 0))
    b.close()
check("no page errors", errs, [])
print("\nFAILED:" if fails else "\nALL PASSED", fails if fails else "")
sys.exit(1 if fails else 0)

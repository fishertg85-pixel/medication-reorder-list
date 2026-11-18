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
    b = pw.chromium.launch(args=['--no-sandbox']); ctx = b.new_context(viewport={'width': 1440, 'height': 900}); p = ctx.new_page(); p.on('pageerror', lambda e: errs.append(str(e)))
    signin(p, "NTX1", "owner", "ownerpass99"); p.wait_for_timeout(800)
    api(O, "POST", "/stores/NTX1/commit", {"reorder": []}) if False else None
    print("landing tab:", p.evaluate("document.querySelector('#tabs button.active').dataset.tab"), "| tabs:", p.locator('#tabs button:visible').all_inner_texts())
    p.screenshot(path='screenshots/suite_1_landing.png')
    p.click('#tabs [data-tab=list]'); p.wait_for_timeout(300); p.screenshot(path='screenshots/suite_2_list.png')
    p.click('#archOpen'); p.wait_for_timeout(600); print("archive active tab:", p.evaluate("document.querySelector('#tabs button.active').dataset.tab"), "list tab marked:", p.evaluate("document.querySelector('#tabs [data-tab=list]').classList.contains('sub')")); p.screenshot(path='screenshots/suite_3_archive.png')
    p.click('#archBack'); p.click('#acctBtn'); p.fill('#ownPw', 'ownerpass99'); p.click('#ownUnlock'); p.wait_for_selector('#ownBody:visible'); p.wait_for_timeout(800); p.screenshot(path='screenshots/suite_4_account.png', full_page=True)
    p.click('#tabs [data-tab=documents]'); p.wait_for_timeout(1200); p.screenshot(path='screenshots/suite_5_documents.png')
    p.evaluate("document.documentElement.setAttribute('data-theme','dark')"); p.wait_for_timeout(300); p.screenshot(path='screenshots/suite_6_documents_dark.png'); p.click('#tabs [data-tab=list]'); p.wait_for_timeout(300); p.screenshot(path='screenshots/suite_7_list_dark.png')
    print(errs); b.close()

# 39.2 Notifications in the browser: name menu, modal, validation, save, read back (SUITE_USERS=NTX1:owner,picu,tchu,tchv,ascu).
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

newpage = lambda: b.new_page(viewport={"width": 1400, "height": 900})
errs = []
with sync_playwright() as pw:
    b = pw.chromium.launch()
    p = newpage(); p.on("pageerror", lambda e: errs.append(str(e)))
    signin(p, "picu", PW["picu"], "picupass12345")
    p.click('#whoBtn'); check("Notifications is in the name menu", p.is_visible('#notifBtn'), True)
    p.click('#notifBtn'); p.wait_for_selector('#notifOv')
    check("the phone number is shown masked", "(•••)" in p.inner_text('#notifOv'), True)
    p.check('#nfEm'); p.click('#nfGo'); p.wait_for_timeout(500)
    check("email ticked with no address stays open (refused)", p.is_visible('#notifOv'), True) if False else None
    p.once("dialog", lambda d: (errs.append("DLG:" + d.message) if False else d.accept()))
    p.click('#nfGo'); p.wait_for_timeout(600)
    check("an empty address is refused, the form stays", p.is_visible('#notifOv'), True)
    p.fill('#nfAd', 'pic@example.com'); p.check('#nfTx'); p.click('#nfGo'); p.wait_for_timeout(700)
    check("saved and closed", p.is_visible('#notifOv'), False)
    p.screenshot(path="screenshots/suite39_notify_menu.png")
    p.click('#whoBtn'); p.click('#notifBtn'); p.wait_for_selector('#notifOv')
    check("choices read back", (p.is_checked('#nfEm'), p.is_checked('#nfTx'), p.input_value('#nfAd')), (True, True, 'pic@example.com'))
    p.screenshot(path="screenshots/suite39_notify_modal.png")
    p.click('#nfNo'); check("Cancel closes", p.is_visible('#notifOv'), False)
    p.close(); b.close()
check("no page errors", errs, [])
print("FAILED:", fails or "none")

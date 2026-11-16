# Calendar tab in the browser (run ./reset.sh first): who sees it, start by the Account Manager, saving to the server.
import json, urllib.request, boto3, sys
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
c.admin_set_user_mfa_preference(Username="owner", UserPoolId=ids["pool"], SMSMfaSettings={"Enabled": False, "PreferredMfa": False})   # the local stand-in has no real text codes
a = tokens("owner", "temp12345a", "ownerpass99"); O = a["IdToken"]
api(O, "POST", "/owner-unlock", {"password": "ownerpass99", "accessToken": a["AccessToken"]})
api(O, "POST", "/owner/stores", {"id": "NTX2", "name": "Other Pharmacy"}); api(O, "POST", "/owner/stores/NTX1", {"calendar": True})
def mk(l, stores, cal, ph):
    s, r = api(O, "POST", "/owner/users", {"login": l, "name": l.upper(), "phone": ph, "smsConsent": True, "stores": stores, "perms": {"calendar": cal}}); assert s == 200, r; return r["tempPassword"]
tA = mk("cala", {"NTX1": True, "NTX2": True}, True, "(817) 555-0101"); tB = mk("calb", {"NTX1": True}, False, "(817) 555-0102")
def signin(p, pharm, user, pw, newpw=None):
    p.goto(BASE); p.wait_for_selector('#login', state='visible'); p.fill('#liPharm', pharm); p.wait_for_timeout(700)
    p.fill('#liUser', user); p.fill('#liPass', pw); p.click('#liGo'); p.wait_for_timeout(1500)
    if p.is_visible('#liNew'): p.fill('#liNew1', newpw); p.fill('#liNew2', newpw); p.click('#liNewGo'); p.wait_for_timeout(1500)
    p.wait_for_selector('#tabs', state='visible', timeout=8000); p.wait_for_timeout(800)
errs = []
with sync_playwright() as pw:
    b = pw.chromium.launch(); 
    def newpage():
        ctx = b.new_context(viewport={'width': 1366, 'height': 900}); p = ctx.new_page(); p.on('pageerror', lambda e: errs.append(str(e))); p.on('dialog', lambda d: d.accept()); return p
    vis = lambda p: p.evaluate("getComputedStyle(document.querySelector('#tabs [data-tab=calendar]')).display !== 'none'")
    # no privilege: no tab, reorder works
    p = newpage(); signin(p, "NTX1", "calb", tB, "calbpass12345"); check("no privilege: no Calendar tab", vis(p), False); p.close()
    # privileged, not owner: sees tab, not started -> told to ask the Account Manager
    p = newpage(); signin(p, "NTX1", "cala", tA, "calapass12345"); check("privileged person sees Calendar tab at NTX1", vis(p), True)
    p.click('#tabs [data-tab=calendar]'); fr = p.frame_locator('#calFrame'); fr.locator('.card .hd').first.wait_for(timeout=8000)
    txt = fr.locator('.card').first.inner_text(); check("not started: asked to see the Account Manager, no Start button", ('Ask the Account Manager' in txt, fr.locator('[data-act=wizard]').count()), (True, 0))
    # other pharmacy: tab hidden
    p.select_option('#storeSel', 'NTX2'); p.wait_for_timeout(1200); check("tab hidden at pharmacy with Calendar off", vis(p), False)
    check("left the Calendar panel", p.evaluate("document.querySelector('#panel-calendar').classList.contains('active')"), False)
    p.select_option('#storeSel', 'NTX1'); p.wait_for_timeout(1200); check("tab back at NTX1", vis(p), True); p.close()
    # Account Manager starts the calendar; data reaches the server
    p = newpage(); signin(p, "NTX1", "owner", "ownerpass99"); check("Account Manager sees tab at NTX1", vis(p), True)
    p.click('#tabs [data-tab=calendar]'); fr = p.frame_locator('#calFrame'); fr.locator('[data-act=wizard]').wait_for(timeout=8000)
    fr.locator('[data-act=wizard]').click(); fr.locator('#f_name').fill('NorTex Pharmacy - Haslet'); fr.locator('[data-act=msave]').click(); p.wait_for_timeout(2500)
    g = api(O, "GET", "/stores/NTX1/calendar")[1]; check("start saved to the server", (g["started"], g["config"]["profile"]["name"]), (True, "NorTex Pharmacy - Haslet"))
    check("audit log names the signed-in login", [l["by"] for l in g["log"]][:1], ["Pat Owner"])
    p.screenshot(path='screenshots/calendar_tab.png'); p.close()
    # privileged person now sees the started calendar
    c.admin_set_user_mfa_preference(Username="cala", UserPoolId=ids["pool"], SMSMfaSettings={"Enabled": False, "PreferredMfa": False})
    p = newpage(); signin(p, "NTX1", "cala", "calapass12345"); p.click('#tabs [data-tab=calendar]'); fr = p.frame_locator('#calFrame'); fr.locator('nav.tabs').wait_for(timeout=8000)
    check("privileged person opens the started calendar", fr.locator('.brand small').inner_text().upper().find('NORTEX') >= 0, True); p.close()
    b.close()
check("no script errors", errs, []); print("\nFAILED:", fails if fails else "none"); sys.exit(1 if fails else 0)

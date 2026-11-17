# Calendar tab in the browser (run ./reset.sh first): who sees it, start by the Account Owner, saving to the server.
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
import subprocess
def node(arg): return json.loads(subprocess.check_output(["node", "boot.mjs", json.dumps(arg)]).decode().strip().splitlines()[-1])
node({"makeHost": {"login": "Neo", "name": "Thomas Fisher", "phone": "8175559999", "tempPassword": "hosttemp12a"}})
c.admin_set_user_mfa_preference(Username="neo", UserPoolId=ids["pool"], SMSMfaSettings={"Enabled": False, "PreferredMfa": False})
h = tokens("neo", "hosttemp12a", "hostpass999"); H = h["IdToken"]; api(H, "POST", "/host-unlock", {"password": "hostpass999", "accessToken": h["AccessToken"]})
CL = lambda **k: dict({"legalName": "NorTex Holdings LLC", "entityType": "llc", "ein": "12-3456789", "address": "100 Main St", "city": "Haslet", "state": "TX", "zip": "76052"}, **k)
client1 = api(H, "POST", "/host/clients", CL())[1]["id"]; ENT = {"clientId": client1, "entityLegalName": "Other Pharmacy LLC", "entityType": "llc", "ein": "98-7654321"}
api(H, "POST", "/host/stores", {"id": "NTX2", "name": "Other Pharmacy", **ENT}); api(H, "POST", "/host/stores/NTX1", {"calendar": True})      # the host (IronLedger) switches the Calendar on and sets services
api(H, "POST", "/host/stores/NTX1", {"services": ["controlled", "sterile", "immunizations"], "npi": "1234567893", "dea": "AB1234563", "hours": [None] + [{"o": "08:00", "c": "20:00"}] * 5 + [None]})
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
    # privileged, not owner: sees tab, not started -> told to ask the Account Owner
    p = newpage(); signin(p, "NTX1", "cala", tA, "calapass12345"); check("privileged person sees Calendar tab at NTX1", vis(p), True)
    p.click('#tabs [data-tab=calendar]'); fr = p.frame_locator('#calFrame'); fr.locator('.card .hd').first.wait_for(timeout=8000)
    txt = fr.locator('.card').first.inner_text(); check("not started: asked to see the Account Owner, no Start button", ('Ask the Account Owner' in txt, fr.locator('[data-act=wizard]').count()), (True, 0))
    # other pharmacy: tab hidden
    p.select_option('#storeSel', 'NTX2'); p.wait_for_timeout(1200); check("tab hidden at pharmacy with Calendar off", vis(p), False)
    check("left the Calendar panel", p.evaluate("document.querySelector('#panel-calendar').classList.contains('active')"), False)
    p.select_option('#storeSel', 'NTX1'); p.wait_for_timeout(1200); check("tab back at NTX1", vis(p), True); p.close()
    # Account Owner starts the calendar; data reaches the server
    p = newpage(); signin(p, "NTX1", "owner", "ownerpass99"); check("Account Owner sees tab at NTX1", vis(p), True)
    p.click('#tabs [data-tab=calendar]'); fr = p.frame_locator('#calFrame'); fr.locator('[data-act=wizard]').wait_for(timeout=8000)
    fr.locator('[data-act=wizard]').click(); fr.locator('#f_name').wait_for()
    check("wizard pre-filled from the account: name", fr.locator('#f_name').input_value(), "NorTex Pharmacy - Haslet")
    check("wizard pre-filled: owner and programs", (fr.locator('#f_owner').input_value(), sorted(fr.locator('#f_feat input:checked').evaluate_all("els=>els.map(e=>e.value)"))), ("Pat Owner", ['bbp', 'controlled', 'sterile']))
    fr.locator('[data-act=msave]').click(); p.wait_for_timeout(2500)
    g = api(O, "GET", "/stores/NTX1/calendar")[1]; check("start saved to the server", (g["started"], g["config"]["profile"]["name"]), (True, "NorTex Pharmacy - Haslet"))
    check("calendar hours came from the account", (g["config"]["profile"]["hours"][1], g["config"]["profile"]["hours"][0]), ({"o": "08:00", "c": "20:00"}, None))
    check("audit log names the signed-in login", [l["by"] for l in g["log"]][:1], ["Pat Owner"])
    p.screenshot(path='screenshots/calendar_tab.png')
    # Account Owner tab: account type for a person, identifiers on the pharmacy
    p.click('#tabs [data-tab=owner]'); p.fill('#ownPw', 'ownerpass99'); p.click('#ownUnlock'); p.wait_for_selector('select[data-utype]', timeout=8000)
    row = p.locator('.urow[data-sub]').filter(has_text='CALA'); row.locator('select[data-utype]').select_option('pharmacist'); p.wait_for_timeout(300)
    row = p.locator('.urow[data-sub]').filter(has_text='CALA'); row.locator('[data-upd]').click(); p.wait_for_timeout(1500)
    cu = {u["login"]: u for u in api(O, "GET", "/owner/users")[1]["users"]}["cala"]
    check("type saved from the screen, Calendar privilege untouched", (cu["acctType"], cu["perms"]["calendar"], cu["perms"]["submit"]), ("pharmacist", True, True))
    p.screenshot(path='screenshots/account_manager_people.png')
    # the Account Owner's pharmacy card: name/address/phone/hours editable; licenses, identifiers, services and Calendar are shown but locked
    card = p.locator('.pcard[data-store=NTX1]')
    check("identifiers show as read-only text", (card.locator('[data-sf=npi]').count(), card.locator('[data-sf=dea]').count(), "1234567893" in card.inner_text(), "AB1234563" in card.inner_text()), (0, 0, True, True))
    check("no services switches, no Calendar switch, no registry buttons", (card.locator('[data-svc]').count(), card.locator('[data-sfcal]').count(), card.locator('[data-npilook]').count(), card.locator('[data-deaok]').count()), (0, 0, 0, 0))
    check("locked message and services shown", ("Set by IronLedger" in card.inner_text(), "Sterile compounding" in card.inner_text(), "Calendar: On" in card.inner_text()), (True, True, True))
    check("no Add-a-pharmacy form for the Account Owner", p.locator('#psAdd').count(), 0)
    card.locator('[data-sf=phone]').fill('(817) 555-0123'); card.locator('[data-savestore]').click(); p.wait_for_timeout(1500)
    ns = [x for x in api(H, "GET", "/host/stores")[1]["stores"] if x["id"] == "NTX1"][0]
    check("phone saved from the screen; services, identifiers and hours untouched", (ns["phone"], ns["npi"], ns["services"], ns["hours"][1]), ("(817) 555-0123", "1234567893", ["controlled", "sterile", "immunizations"], {"o": "08:00", "c": "20:00"}))
    # closed days on the Hours panel: the Account Owner adds them; they show on the calendar for everyone who can open it
    check("Hours panel has the closed-days editor", (card.locator('[data-clobs]').count(), card.locator('[data-cladd]').count(), "Additional closed days" in card.inner_text()), (0, 1, True))
    card.locator('[data-cld]').fill('2027-02-09'); card.locator('[data-cln]').fill('Mardi Gras'); card.locator('[data-cly]').evaluate("e=>e.click()"); card.locator('[data-cladd]').click()
    card.locator('[data-cld]').fill('2026-12-28'); card.locator('[data-cln]').fill('Day after Christmas'); card.locator('[data-cladd]').click()
    check("added days are listed", (card.locator('.clrow').count(), "Mardi Gras" in card.locator('[data-cllist]').inner_text(), "every year" in card.locator('[data-cllist]').inner_text()), (2, True, True))
    card.locator('[data-savestore]').click(); p.wait_for_timeout(1500)
    ns = [x for x in api(H, "GET", "/host/stores")[1]["stores"] if x["id"] == "NTX1"][0]
    check("closed days saved from the screen", (ns["closures"]["obs"], [(x["d"], x["y"]) for x in ns["closures"]["days"]]), ([], [("2026-12-28", False), ("2027-02-09", True)]))
    check("hours untouched by saving closed days", ns["hours"][1], {"o": "08:00", "c": "20:00"})
    p.click('#tabs [data-tab=calendar]'); fr = p.frame_locator('#calFrame'); fr.locator('body').wait_for(timeout=8000); p.wait_for_timeout(1500)
    hf = lambda d: fr.locator('body').evaluate("(el, d) => { const h = hoursFor(d); return [h.closed, h.reason || '']; }", d)
    check("calendar: custom day is closed", hf('2026-12-28'), [True, 'Day after Christmas'])
    check("calendar: every-year day closes in later years too", (hf('2027-02-09'), hf('2030-02-09')), ([True, 'Mardi Gras'], [True, 'Mardi Gras']))
    check("calendar: no yearly observances unless dated days are added (Christmas Eve 2026 stays open)", (hf('2026-12-24')[0], hf('2026-12-31')[0]), (False, False))
    check("calendar: a one-time date does not repeat", hf('2027-12-28')[0], False)
    check("calendar: day cell names the closure", "Closed: Day after Christmas" in fr.locator('body').evaluate("() => dayFacts('2026-12-28').map(f => f.name).join('|')"), True)
    check("a task due on a closed day moves to the next open day", fr.locator('body').evaluate("() => adjustDue('2026-12-28')") not in ('2026-12-28', None), True)
    p.screenshot(path='screenshots/account_manager_pharmacy.png', full_page=True); p.close()
    # privileged person now sees the started calendar
    c.admin_set_user_mfa_preference(Username="cala", UserPoolId=ids["pool"], SMSMfaSettings={"Enabled": False, "PreferredMfa": False})
    p = newpage(); signin(p, "NTX1", "cala", "calapass12345"); p.click('#tabs [data-tab=calendar]'); fr = p.frame_locator('#calFrame'); fr.locator('nav.tabs').wait_for(timeout=8000)
    check("privileged person opens the started calendar", fr.locator('.brand small').inner_text().upper().find('NORTEX') >= 0, True); p.close()
    b.close()
check("no script errors", errs, []); print("\nFAILED:", fails if fails else "none"); sys.exit(1 if fails else 0)

# Owner side in the browser (run ./reset.sh first, no SUITE_USERS): per-pharmacy owner, Account tab with the Client page (password step-up),
# Pharmacy Associate label, super-user switch for a PIC, Reorder List tab off, calendar completion screen rules.
import json, urllib.request, urllib.error, boto3, subprocess, os
from playwright.sync_api import sync_playwright
ids = json.load(open('moto_ids.json')); BASE = 'http://localhost:8790/'
c = boto3.client("cognito-idp", endpoint_url="http://localhost:5005", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="x")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'screenshots') + '/'
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
def node(arg): return json.loads(subprocess.check_output(["node", "boot.mjs", json.dumps(arg)]).decode().strip().splitlines()[-1])
node({"makeHost": {"login": "Neo", "name": "Thomas Fisher", "phone": "8175559999", "tempPassword": "hosttemp12a"}})
c.admin_set_user_mfa_preference(Username="neo", UserPoolId=ids["pool"], SMSMfaSettings={"Enabled": False, "PreferredMfa": False})
h = tokens("neo", "hosttemp12a", "hostpass999"); H = h["IdToken"]; api(H, "POST", "/host-unlock", {"password": "hostpass999", "accessToken": h["AccessToken"]})
r = api(H, "POST", "/host/clients", {"legalName": "IronLedger Compliance LLC", "entityType": "llc", "ein": "12-3456789", "address": "100 Main St", "city": "Haslet", "state": "TX", "zip": "76052",
      "owner": {"create": {"login": "lagown", "name": "Lena Owner", "phone": "(817) 555-0111", "smsConsent": True}}})
C1 = r[1]["id"]; OWNPW = r[1]["tempPassword"]
api(H, "POST", "/host/stores", {"id": "LAG1", "name": "Lagniappe Pharmacy", "clientId": C1, "entityLegalName": "Lagniappe Pharmacy LLC", "entityType": "llc", "ein": "98-7654321"})
check("owner assigned to the pharmacy", api(H, "POST", "/host/stores/LAG1/owner", {"owner": {"login": "lagown"}})[0], 200)
api(H, "POST", "/host/stores/LAG1", {"calendar": True})
api(H, "POST", "/host/clients/" + C1 + "/invoices", {"issued": "2026-11-01", "due": "2026-11-30", "amount": "149.00", "description": "November"})
def hu(login, name, ph, acct, ini, lic=''):
    s, r = api(H, "POST", "/host/users", {"login": login, "name": name, "phone": ph, "smsConsent": True, "stores": {"LAG1": True}, "perms": {"calendar": True}, "acctType": acct, "initials": ini, "license": lic}); assert s == 200, r; return r["tempPassword"]
tR = hu("rph1", "Rae Pharmacist", "(817) 555-0122", "pic", "RP", "RPH-1"); tA = hu("assoc1", "Al Associate", "(817) 555-0144", "staff", "AA")
for u in ("lagown", "rph1", "assoc1"): c.admin_set_user_mfa_preference(Username=u, UserPoolId=ids["pool"], SMSMfaSettings={"Enabled": False, "PreferredMfa": False})
def signin(p, user, pw, newpw):
    p.goto(BASE); p.wait_for_selector('#login', state='visible'); p.fill('#liPharm', 'LAG1'); p.wait_for_timeout(700)
    p.fill('#liUser', user); p.fill('#liPass', pw); p.click('#liGo'); p.wait_for_timeout(1500)
    if p.is_visible('#liNew'): p.fill('#liNew1', newpw); p.fill('#liNew2', newpw); p.click('#liNewGo'); p.wait_for_timeout(1500)
    p.wait_for_selector('#tabs', state='visible', timeout=8000); p.wait_for_timeout(800)
errs = []
tabs = lambda p: [t for t in p.locator('#tabs button:visible').all_inner_texts()]
with sync_playwright() as pw:
    b = pw.chromium.launch()
    def newpage():
        ctx = b.new_context(viewport={'width': 1400, 'height': 1000}); p = ctx.new_page(); p.on('pageerror', lambda e: errs.append(str(e))); p.on('dialog', lambda d: d.accept()); return p
    # ---- the owner (also the client's Account Owner)
    p = newpage(); signin(p, "lagown", OWNPW, "lagpass12345")
    check("header names the Account Owner at this pharmacy", "Account Owner" in p.inner_text('#whoLabel'), True)
    check("Account is reachable", p.is_visible('#acctBtn'), True)
    p.click('#acctBtn'); p.wait_for_timeout(400); check("locked until the password is typed", p.is_visible('#ownLock') and not p.is_visible('#ownBody'), True)
    p.fill('#ownPw', 'lagpass12345'); p.click('#ownUnlock'); p.wait_for_selector('#ownBody', state='visible'); p.wait_for_selector('#ownStores .pcard', timeout=8000)
    check("Client button shown (client owner)", p.is_visible('#ownSwitch') and p.is_visible('#ownSwClient'), True)
    check("pharmacy card shows the owner (holder)", "Lena Owner" in p.inner_text('#ownStores'), True)
    check("account type label: Pharmacy Associate", "Pharmacy Associate" in p.inner_text('#ownPeople') or "Pharmacy Associate" in p.inner_text('#npType') if p.locator('#npType').count() else "Pharmacy Associate" in p.inner_text('#ownPeople'), True)
    sup = p.locator('[data-uadm=LAG1]'); check("super user switch for the PIC (only)", sup.count(), 1)
    sup.locator('xpath=..').click(); p.wait_for_timeout(300); p.locator('#ownPeople [data-upd]').first.click(); p.wait_for_timeout(1200)
    p.screenshot(path=OUT + 'owner_people.png', full_page=True)
    p.click('#ownSwClient'); p.wait_for_selector('#ownClientView .pcard', timeout=8000)
    t = p.inner_text('#ownClientView') + ' ' + ' '.join(p.eval_on_selector_all('#ownClientView input', 'els => els.map(e => e.value)'))
    check("client page fields are disabled", p.eval_on_selector_all('#ownClientView .pcard input:not([type=hidden]), #ownClientView .pcard select', 'els => els.every(e => e.disabled)'), True)
    check("client page: legal name, pharmacy, invoice", ("IronLedger Compliance LLC" in t, "Lagniappe" in t, "$149.00" in t), (True, True, True))
    check("client page is read-only (no save, no invoice entry)", (p.locator('#ownClientView [data-saveclient]').count(), p.locator('#ownClientView [data-ivadd]').count(), p.locator('#ownClientView [data-addpharm]').count()), (0, 0, 0))
    p.screenshot(path=OUT + 'owner_client_page.png', full_page=True)
    p.click('#ownSwPharm'); p.wait_for_selector('#ownStores .pcard'); check("back to the pharmacy view", p.is_visible('#ownPharmView') and not p.is_visible('#ownClientView'), True)
    # Reorder List off -> tab gone
    api(H, "POST", "/host/stores/LAG1", {"reorder": False}); p.evaluate("refreshMe()"); p.wait_for_timeout(1200)
    check("Reorder List tab hidden when switched off", 'Reorder List' in tabs(p), False)
    api(H, "POST", "/host/stores/LAG1", {"reorder": True}); p.close()
    # ---- Pharmacy Associate: calendar completion rules on screen
    p = newpage(); signin(p, "assoc1", tA, "asspass12345")
    check("associate has no Account tab", p.is_visible('#acctBtn'), False)
    m = p.evaluate("[ILCAL_HOST.mayComplete('hipaa-training'), ILCAL_HOST.mayComplete('dea-biennial'), ILCAL_HOST.mayComplete('custom-1')]")
    check("associate: built-in tasks view-only, custom allowed", m, [False, False, True]); p.close()
    p = newpage(); signin(p, "rph1", tR, "rphpass12345")
    check("PIC (administrator now): pharmacist tasks allowed", p.evaluate("[ILCAL_HOST.mayComplete('dea-biennial'), ILCAL_HOST.mayComplete('u797-air')]"), [True, True])
    check("administrator sees the Account tab, labelled", ("Administrator" in p.inner_text('#whoLabel'), p.is_visible('#acctBtn')), (True, True)); p.close()
    b.close()
check("no script errors", errs, [])
print('\nFAILED: ' + (', '.join(fails) if fails else 'none'))

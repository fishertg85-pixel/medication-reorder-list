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
api(H, "POST", "/host/stores/LAG1/invoices", {"issued": "2026-11-01", "due": "2026-11-30", "amount": "149.00", "description": "November"})
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
    p.fill('#ownPw', 'lagpass12345'); p.click('#ownUnlock'); p.wait_for_selector('#ownBody', state='visible'); p.wait_for_selector('#acClient .pcard', timeout=8000)
    check("a Client Account Owner starts inside the client: its account in the middle, Profiles on the right", (p.eval_on_selector('#acClient [data-cf=legalName]', 'e => e.value'), "Profiles" in p.inner_text('#acSide h2'), "Lagniappe" in p.inner_text('#acSide')), ("IronLedger Compliance LLC", True, True))
    check("client page fields are disabled and it is read only", (p.eval_on_selector_all('#acClient .pcard input:not([type=hidden]), #acClient .pcard select', 'els => els.every(e => e.disabled)'), p.locator('#acClient [data-saveclient]').count(), p.locator('#acClient [data-addpharm]').count()), (True, 0, 0))
    check("no client list and no new-client form for a client's own owner", (p.locator('#acClient [data-createclient]').count(), p.locator('#acSide [data-q]').count()), (0, 0))
    p.screenshot(path=OUT + 'owner_client_page.png', full_page=True)
    p.click('#acSide [data-qs=LAG1]'); p.wait_for_selector('#acPharm .pcard', timeout=8000)
    check("pharmacy account: holder shown, Account / Users / Billing on the right", ("Lena Owner" in p.inner_text('#acPharm'), [x.split("\n")[0] for x in p.locator('#acSide .qrow').all_inner_texts()]), (True, ["Account", "Users", "Billing"]))
    check("the who-can-manage switches are not on the owner's page (IronLedger's alone)", p.locator('#acPharm [data-mgr]').count(), 0)
    p.click('#acSide [data-view=users]'); p.wait_for_selector('#acUsers .urow', timeout=8000)
    check("Users: this pharmacy's people only, owner can manage", ("Rae Pharmacist" in p.inner_text('#acUsers'), "Al Associate" in p.inner_text('#acUsers'), p.locator('#acUsers [data-npadd]').count()), (True, True, 1))
    p.click('#acUsers .urow:has-text("rph1") .urowhead'); p.wait_for_selector('#acUsers .udetail')
    check("account type label: Pharmacy Associate is a choice", "Pharmacy Associate" in p.inner_text('#acUsers .udetail select[data-utype]'), True)
    sup = p.locator('#acUsers [data-uadm=LAG1]'); check("super user switch for the PIC (only)", sup.count(), 1)
    sup.locator('xpath=..').click(); p.wait_for_timeout(300); p.locator('#acUsers [data-upd]').first.click(); p.wait_for_selector('#acMsg:has-text("updated")', timeout=8000)
    p.screenshot(path=OUT + 'owner_people.png', full_page=True)
    p.click('#acCrumb [data-crumb=pharm]'); p.wait_for_selector('#acPharm .pcard'); p.click('#acSide [data-view=billing]'); p.wait_for_selector('#acBill .btiles', timeout=8000)
    check("Billing: this pharmacy's invoice, read only", ("$149.00" in p.inner_text('#acBill'), p.locator('#acBill [data-invadd]').count(), p.locator('#acBill [data-invpaid]').count()), (True, 0, 0))
    p.screenshot(path=OUT + 'owner_billing.png', full_page=True)
    # the host switches the Account Owner's people management off for this pharmacy: view only
    api(H, "POST", "/host/stores/LAG1", {"mgrOwner": False})
    p.click('#acCrumb [data-crumb=pharm]'); p.wait_for_selector('#acPharm .pcard'); p.click('#acSide [data-view=users]'); p.wait_for_selector('#acUsers .urow')
    check("with the switch off: people shown, view only, nothing to add", ("View only" in p.inner_text('#acUsers'), p.locator('#acUsers [data-npadd]').count()), (True, 0))
    api(H, "POST", "/host/stores/LAG1", {"mgrOwner": True})
    p.click('#acCrumb [data-crumb=client]'); p.wait_for_selector('#acClient .pcard'); check("breadcrumb returns to the client", "Profiles" in p.inner_text('#acSide h2'), True)
    p.click('#acSide [data-qs=LAG1]'); p.wait_for_selector('#acPharm .pcard')
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
    check("administrator sees the Account tab, labelled", ("Administrator" in p.inner_text('#whoLabel'), p.is_visible('#acctBtn')), (True, True))
    p.click('#acctBtn'); p.fill('#ownPw', 'rphpass12345'); p.click('#ownUnlock'); p.wait_for_selector('#ownBody', state='visible'); p.wait_for_selector('#acPharm .pcard', timeout=8000)
    check("a super user (no client) opens straight into the one pharmacy: Account and Users, no Billing", [x.split("\n")[0] for x in p.locator('#acSide .qrow').all_inner_texts()], ["Account", "Users"])
    p.click('#acSide [data-view=users]'); p.wait_for_selector('#acUsers .urow', timeout=8000)
    check("a super user sees the people but cannot grant super user", ("Al Associate" in p.inner_text('#acUsers'), p.locator('#acUsers [data-uadm]').count()), (True, 0)); p.close()
    b.close()
check("no script errors", errs, [])
print('\nFAILED: ' + (', '.join(fails) if fails else 'none'))

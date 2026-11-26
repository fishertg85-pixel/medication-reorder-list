# An IronLedger employee who also works at a pharmacy: on the pharmacy side the login is an ordinary user (no employee marking, account type and role like anyone's);
# the employee portal: no marking either. Run ./reset.sh first.
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
tD = hu("dual1", "Dana Dual", "(817) 555-0166", "", "DD")
check("the login is also made an IronLedger employee", node({"makeHost": {"login": "dual1", "name": "Dana Dual", "phone": "8175550166"}}).get("ok"), True)
for u in ("lagown", "rph1", "assoc1", "dual1"): c.admin_set_user_mfa_preference(Username=u, UserPoolId=ids["pool"], SMSMfaSettings={"Enabled": False, "PreferredMfa": False})
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
    p = newpage(); signin(p, "lagown", OWNPW, "lagpass12345")
    p.click('#whoBtn'); p.click('#acctBtn'); p.wait_for_timeout(400); p.fill('#ownPw', 'lagpass12345'); p.click('#ownUnlock'); p.wait_for_selector('#ownBody', state='visible'); p.wait_for_selector('#acClient .pcard', timeout=8000)
    p.click('#acSide [data-qs=LAG1]'); p.wait_for_selector('#acPharm .pcard', timeout=8000); p.click('#acSide [data-view=users]'); p.wait_for_selector('#acUsers .urow', timeout=8000)
    row = lambda: p.locator('#acUsers .urow:has-text("dual1")')
    check("pharmacy side: the list does not mark the login as IronLedger or host", ("IronLedger" in p.inner_text('#acUsers .ulist') if p.locator('#acUsers .ulist').count() else "IronLedger" in p.inner_text('#acUsers'), "host" in row().inner_text().lower()), (False, False))
    row().locator('.urowhead').click(); p.wait_for_selector('#acUsers .udetail')
    check("pharmacy side: account type, license and privileges are there like anyone's", (row().locator('select[data-utype]').count(), row().locator('[data-ulic]').count(), row().locator('[data-uperm], [data-perm]').count() > 0 or row().locator('.priv').count() > 0), (1, 1, True))
    check("pharmacy side: the sign-in controls IronLedger keeps are not offered (reset password, delete, login on/off, mobile)", (row().locator('[data-reset]').count(), row().locator('[data-del]').count(), row().locator('[data-uon]').count(), row().locator('[data-phone]').count()), (0, 0, 0, 0))
    row().locator('select[data-utype]').select_option('pharmacist'); p.wait_for_timeout(300); row().locator('[data-ulic]').fill('TX55555'); row().locator('[data-ulic]').dispatch_event('change'); p.wait_for_timeout(300)
    row().locator('[data-upd]').click(); p.wait_for_selector('#acMsg:has-text("updated")', timeout=8000)
    u = [x for x in api(H, "GET", "/pharmacy/LAG1/users")[1]["users"] if x["login"] == "dual1"][0]
    check("the Account Owner made them a Staff Pharmacist from the screen (type, license, preset privileges)", (u["acctType"], u["license"], u["perms"].get("submit"), u["perms"].get("archive"), u["perms"].get("remove")), ("pharmacist", "TX55555", True, True, True))
    p.screenshot(path=OUT + 'dual_owner_users.png'); p.close()
    # ---- the employee portal still marks it
    p = newpage(); p.goto(BASE + 'host.html'); p.wait_for_selector('#sUser'); p.fill('#sUser', 'neo'); p.fill('#sPass', 'hostpass999'); p.click('#sGo'); p.wait_for_selector('#sCode:visible, #gBody:visible')
    if p.is_visible('#sCode'): p.fill('#sCodeIn', '123456'); p.click('#sCodeGo')
    p.wait_for_selector('#side [data-q]', timeout=8000); p.click('#side [data-q]'); p.wait_for_selector('#side [data-qs=LAG1]'); p.click('#side [data-qs=LAG1]'); p.wait_for_selector('#vPharm .pcard')
    p.click('#vPharm label:has([data-picyes][value=no])'); p.wait_for_timeout(300)
    opts = [o.strip() for o in p.locator('#vPharm [data-picpick] option').all_inner_texts()]
    check("PIC dropdown: lists the people whose Account Type is Pharmacist-in-Charge (Rae), not a Staff Pharmacist (Dana); a hint says where to set it", (any("Rae Pharmacist" in o for o in opts), any("Dana Dual" in o for o in opts), p.inner_text('#vPharm [data-picwho] .hint')), (True, False, "Not listed? Set Account Type in Users."))
    p.click('#side [data-view=users]'); p.wait_for_selector('.ug-back:not([hidden]), #vUsers .urow')
    if p.is_visible('.ug-back:not([hidden])'): p.click('[data-ug=no]')
    p.wait_for_selector('#vUsers .urow')
    prow = p.locator('#vUsers .urow:has-text("dual1")')
    check("employee portal: no screen marks the login as IronLedger either; it shows as a Staff Pharmacist like anyone", ("IronLedger" in prow.inner_text(), "IronLedger" in p.inner_text('#vUsers'), u["acctType"]), (False, False, "pharmacist"))
    prow.locator('.urowhead').click(); p.wait_for_selector('#vUsers .udetail')
    check("employee portal: opened, still no such text; the row works like any other (account type, license)", ("IronLedger" in prow.inner_text(), prow.locator('select[data-utype]').count(), prow.locator('[data-ulic]').count()), (False, 1, 1))
    p.close(); b.close()
check("no script errors", errs, []); print("\nFAILED:", fails if fails else "none"); import sys; sys.exit(1 if fails else 0)

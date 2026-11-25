# Users list, Pharmacy column: when the viewer has more than one pharmacy, each person's row shows which pharmacies they are assigned to.
# An Account Owner sees only their own pharmacies there; IronLedger sees all. Run ./reset.sh first.
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
api(H, "POST", "/host/stores", {"id": "LAG2", "name": "Lagniappe Pharmacy West", "clientId": C1, "entityLegalName": "Lagniappe Pharmacy LLC", "entityType": "llc", "ein": "98-7654321"})
check("the same owner is given the second pharmacy", api(H, "POST", "/host/stores/LAG2/owner", {"owner": {"login": "lagown"}})[0], 200)
def mk(login, name, ph, stores, ini):
    s, r = api(H, "POST", "/host/users", {"login": login, "name": name, "phone": ph, "smsConsent": True, "stores": stores, "acctType": "tech", "initials": ini}); assert s == 200, r; return r["tempPassword"]
mk("one1", "Ona One", "(817) 555-0301", {"LAG1": True}, "OO"); mk("two2", "Tia Two", "(817) 555-0302", {"LAG1": True, "LAG2": True}, "TT"); mk("mix3", "Max Mix", "(817) 555-0303", {"LAG1": True, "NTX1": True}, "MM")
c.admin_set_user_mfa_preference(Username="lagown", UserPoolId=ids["pool"], SMSMfaSettings={"Enabled": False, "PreferredMfa": False})
ot = tokens("lagown", OWNPW, "lagpass12345"); O = ot["IdToken"]; api(O, "POST", "/owner-unlock", {"password": "lagpass12345", "accessToken": ot["AccessToken"]})
U = api(O, "GET", "/pharmacy/LAG1/users")[1]; at = {u["login"]: u["at"] for u in U["users"]}
check("owner of two pharmacies: the list says to show the Pharmacy column", U.get("multi"), True)
check("each person's pharmacies: one, both, and the owner's own two", (at["one1"], at["two2"], at["lagown"]), (["LAG1"], ["LAG1", "LAG2"], ["LAG1", "LAG2"]))
check("a pharmacy that is not the owner's is never named (only counted)", (at["mix3"], "NTX1" in json.dumps(U), [u["others"] for u in U["users"] if u["login"] == "mix3"]), (["LAG1"], False, [1]))
check("names for the hover text: the owner's pharmacies only", U.get("places"), {"LAG1": "Lagniappe Pharmacy", "LAG2": "Lagniappe Pharmacy West"})
HU = api(H, "GET", "/pharmacy/LAG1/users")[1]; hat = {u["login"]: u["at"] for u in HU["users"]}
check("IronLedger sees every pharmacy a person is assigned to", (HU.get("multi"), hat["mix3"], hat["two2"]), (True, ["LAG1", "NTX1"], ["LAG1", "LAG2"]))
c.admin_set_user_mfa_preference(Username="owner", UserPoolId=ids["pool"], SMSMfaSettings={"Enabled": False, "PreferredMfa": False})
st = tokens("owner", "temp12345a", "ownerpass99"); S1 = st["IdToken"]; api(S1, "POST", "/owner-unlock", {"password": "ownerpass99", "accessToken": st["AccessToken"]})
U1 = api(S1, "GET", "/pharmacy/NTX1/users")[1]
check("an owner with one pharmacy: no Pharmacy column, and the other owner's pharmacy is not named", (U1.get("multi"), [u["at"] for u in U1["users"] if u["login"] == "mix3"], "LAG1" in json.dumps(U1)), (False, [["NTX1"]], False))
def signin(p, user, pw):
    p.goto(BASE); p.wait_for_selector('#login', state='visible'); p.fill('#liPharm', 'LAG1'); p.wait_for_timeout(700)
    p.fill('#liUser', user); p.fill('#liPass', pw); p.click('#liGo'); p.wait_for_selector('#tabs', state='visible', timeout=8000); p.wait_for_timeout(800)
errs = []
with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={'width': 1440, 'height': 900}); p = ctx.new_page(); p.on('pageerror', lambda e: errs.append(str(e))); p.on('dialog', lambda d: d.accept())
    signin(p, "lagown", "lagpass12345")
    p.click('#whoBtn'); p.click('#acctBtn'); p.wait_for_timeout(400); p.fill('#ownPw', 'lagpass12345'); p.click('#ownUnlock'); p.wait_for_selector('#ownBody', state='visible'); p.wait_for_selector('#acClient .pcard', timeout=8000)
    p.click('#acSide [data-qs=LAG1]'); p.wait_for_selector('#acPharm .pcard', timeout=8000); p.click('#acSide [data-view=users]'); p.wait_for_selector('#acUsers .urow', timeout=8000)
    check("screen: a Pharmacy column sits between Username and Mobile", [x.strip() for x in p.locator('#acUsers .uhead > div').all_inner_texts()][:5], ["USER", "USERNAME", "PHARMACY", "MOBILE", "STATUS"])
    cell = lambda l: p.locator('#acUsers .urow:has-text("%s") .uat' % l).inner_text()
    check("screen: each row names the person's pharmacies", (cell("one1"), cell("two2"), cell("mix3")), ("LAG1", "LAG1, LAG2", "LAG1"))
    geo = p.evaluate("""() => { const h = [...document.querySelectorAll('#acUsers .uhead > div')].map(e => Math.round(e.getBoundingClientRect().left)); const rows = [...document.querySelectorAll('#acUsers .urowhead')].map(r => [...r.children].map(e => Math.round(e.getBoundingClientRect().left))); const fit = [...document.querySelectorAll('#acUsers .uat')].every(e => e.scrollWidth <= e.clientWidth + 1 && e.getClientRects().length === 1); const d = document.documentElement; return {aligned: rows.every(r => r.join() === h.join()), fit, sideways: d.scrollWidth > d.clientWidth}; }""")
    check("screen: every column lines up under its title, the pharmacy text is not cut off or wrapped, no sideways scroll", geo, {"aligned": True, "fit": True, "sideways": False})
    p.screenshot(path=OUT + 'users_pharmacy_column.png')
    p.click('#acUsers .urow:has-text("two2") .urowhead'); p.wait_for_selector('#acUsers .udetail')
    check("screen: opening a row keeps the column", cell("two2"), "LAG1, LAG2")
    p.close(); b.close()
check("no script errors", errs, []); print("\nFAILED:", fails if fails else "none"); import sys; sys.exit(1 if fails else 0)

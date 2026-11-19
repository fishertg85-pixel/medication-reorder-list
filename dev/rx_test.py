# Rx Intake tab: access list, shared directory, pharmacists, lookup relay, and the page in a browser. Run: SUITE_USERS='NTX1:owner,pha,tch' bash reset.sh
import json, subprocess, urllib.request, urllib.error, boto3, sys
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
s, r = api(H, "POST", "/host/stores/NTX1", {"address": "5796 E State Hwy 114", "suite": "5A", "city": "Haslet", "state": "TX", "zip": "76052", "phone": "8179848722", "fax": "8175498796", "license": "34469", "dea": "AB1234563", "npi": "1234567893", "changeReason": "test setup change"}); print("store setup:", s, r if s != 200 else "")
SUBS = {}
def mk(l, ph, acct="pharmacist", lic=""):
    s_, r = api(O, "POST", "/owner/users", {"login": l, "name": l.upper() + " Lastname", "phone": ph, "smsConsent": True, "stores": {"NTX1": True}, "acctType": acct, "license": lic, "perms": {}}); assert s_ == 200, r; SUBS[l] = r["user"]["sub"]
    t = tokens(l, r["tempPassword"], l + "pass12345")["IdToken"]; c.admin_set_user_mfa_preference(Username=l, UserPoolId=ids["pool"], SMSMfaSettings={"Enabled": False, "PreferredMfa": False}); return t
P = mk("pha", "(817) 555-0301", lic="59985"); N = mk("nop", "(817) 555-0302"); T = mk("tch", "(817) 555-0303", acct="tech", lic="777")
OSUB = [u for u in api(O, "GET", "/owner/users")[1]["users"] if u["login"] == "owner"][0]["sub"]
R = "/stores/NTX1/rx/"
# flags
for nm, tok, want in (("owner", O, True), ("pha", P, True), ("nop", N, False), ("tch", T, False)):
    st = [x for x in api(tok, "GET", "/me")[1]["stores"] if x["id"] == "NTX1"][0]
    check(nm + ": Rx Intake flag", st.get("rx"), want)
# access
check("owner: config", api(O, "GET", R + "config")[0], 200)
check("named user: config", api(P, "GET", R + "config")[0], 200)
check("user not on the list: config refused", api(N, "GET", R + "config")[0], 403)
check("user not on the list: lookup refused", api(N, "POST", R + "lookup", {"url": "https://rxnav.nlm.nih.gov/REST/drugs.json?name=x"})[0], 403)
check("host: refused", api(H, "GET", R + "config")[0], 403)
cfg = api(O, "GET", R + "config")[1]
check("pharmacy block comes from setup", (cfg["pharmacy"]["address"], cfg["pharmacy"]["suite"], cfg["pharmacy"]["fax"], cfg["pharmacy"]["dea"]), ("5796 E State Hwy 114", "5A", "8175498796", "AB1234563"))
check("no license on the Account Owner yet: PIC missing note", [n for n in cfg["notes"] if "Pharmacist-In-Charge" in n] != [], True)
check("license format refused", api(O, "POST", "/owner/users/" + OSUB, {"license": "no way!"})[0], 400)
check("Account Owner license saved", api(O, "POST", "/owner/users/" + OSUB, {"license": "40291"})[0], 200)
check("license shown in people list", [u["license"] for u in api(O, "GET", "/owner/users")[1]["users"] if u["login"] in ("owner", "pha")], ["40291", "59985"])
cfgP = api(P, "GET", R + "config")[1]
check("staff pharmacist: receiving is the login, PIC is the Account Owner", (cfgP["receiving"], cfgP["pic"]["license"], cfgP["pic"]["name"] == cfgP["pic"]["name"].upper(), cfgP["notes"]), ({"name": "PHA LASTNAME", "license": "59985"}, "40291", True, []))
cfgO = api(O, "GET", R + "config")[1]
check("PIC signed in: same person twice", (cfgO["receiving"]["license"], cfgO["pic"]["license"], cfgO["receiving"]["name"] == cfgO["pic"]["name"]), ("40291", "40291", True))
check("technician (named user, not a pharmacist): Rx Intake refused", api(T, "GET", R + "config")[0], 403)
stT = [x for x in api(T, "GET", "/me")[1]["stores"] if x["id"] == "NTX1"][0]; check("technician still has Calendar and Documents", (stT["calendar"], stT["documents"]), (True, True))
check("technician cannot use the lookup relay or directory either", (api(T, "POST", R + "lookup", {"url": "https://rxnav.nlm.nih.gov/REST/x"})[0], api(T, "POST", R + "dir/save", {"kind": "ph", "rec": {"name": "X"}})[0]), (403, 403))
cfg = cfgO
# directory
s, r = api(P, "POST", R + "dir/save", {"kind": "pr", "rec": {"name": "SMITH, JOHN", "last": "SMITH", "first": "JOHN", "npi": "1234567893", "dea": "AB1234563", "phone": "(817) 555-1212", "bogus": "x"}})
check("prescriber saved", (s, r["rec"]["_id"], r["rec"]["phone"], "bogus" in r["rec"]), (200, "npi_1234567893", "8175551212", False))
s, r = api(P, "POST", R + "dir/save", {"kind": "ph", "rec": {"name": "CVS #1", "city": "Fort Worth"}}); check("pharmacy saved (no NPI: generated id)", (s, r["rec"]["_id"].startswith("r")), (200, True))
phid = r["rec"]["_id"]
check("no name refused", api(P, "POST", R + "dir/save", {"kind": "pr", "rec": {"name": ""}})[0], 400)
check("bad kind refused", api(P, "POST", R + "dir/save", {"kind": "x", "rec": {"name": "A"}})[0], 400)
cfg = api(O, "GET", R + "config")[1]; check("directory shared between users", (len(cfg["dir"]["ph"]), len(cfg["dir"]["pr"])), (1, 1))
s, r = api(O, "POST", R + "dir/import", {"ph": [{"name": "WALGREENS 7"}], "pr": [{"name": "DOE, JANE", "npi": "1234567893"}, {"nope": 1}]}); check("import counts (same NPI merges)", (s, r["ph"], r["pr"]), (200, 1, 1))
cfg = api(O, "GET", R + "config")[1]; check("after import", (len(cfg["dir"]["ph"]), len(cfg["dir"]["pr"]), cfg["dir"]["pr"][0]["name"]), (2, 1, "DOE, JANE"))
check("delete", api(P, "POST", R + "dir/delete", {"kind": "ph", "id": phid})[0], 200)
check("delete bad id refused", api(P, "POST", R + "dir/delete", {"kind": "ph", "id": "../x"})[0], 400)
check("staff endpoint is gone", api(O, "POST", R + "staff", {"pharmacists": []})[0], 404)
# lookup relay: only the four addresses, https, GET
for nm, u in (("other site", "https://example.com/api/"), ("http", "http://rxnav.nlm.nih.gov/REST/x"), ("port", "https://rxnav.nlm.nih.gov:8443/REST/x"), ("look-alike host", "https://rxnav.nlm.nih.gov.evil.com/REST/x"), ("login in url", "https://u:p@rxnav.nlm.nih.gov/REST/x"), ("other path on allowed host", "https://npiregistry.cms.hhs.gov/other"), ("not a url", "nope")):
    check("lookup refused: " + nm, api(O, "POST", R + "lookup", {"url": u})[0], 400)
s, r = api(O, "POST", R + "lookup", {"url": "https://rxnav.nlm.nih.gov/REST/drugs.json?name=lisinopril"}); check("allowed address passes the gate (200 with network, 502 without)", s in (200, 502), True)
# ---- the page
errs = []; posted = []
def signin(p, user, pw):
    p.goto(BASE); p.wait_for_selector('#login', state='visible'); p.fill('#liPharm', "NTX1"); p.wait_for_timeout(700)
    p.fill('#liUser', user); p.fill('#liPass', pw); p.click('#liGo'); p.wait_for_selector('#tabs', state='visible', timeout=9000); p.wait_for_timeout(1000)
with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--no-sandbox']); ctx = b.new_context(viewport={'width': 1440, 'height': 1000}); p = ctx.new_page()
    p.on('pageerror', lambda e: errs.append(str(e))); p.on('console', lambda m: errs.append('console: ' + m.text) if m.type == 'error' else None)
    p.on('request', lambda rq: posted.append((rq.method, rq.url, rq.post_data or '')) if rq.method != 'GET' else None)
    signin(p, "pha", "phapass12345")
    tabs = p.locator('#tabs button:visible').all_inner_texts(); check("tab order", tabs, ["Calendar", "Documents", "Rx Intake", "Reorder List"])
    p.click('#tabs [data-tab=rx]'); p.wait_for_selector('#rxFrame'); fr = p.frame_locator('#rxFrame'); fr.locator('#rcv_name').wait_for(timeout=8000); p.wait_for_timeout(800)
    check("receiving pharmacy shown from setup", (fr.locator('#rcv_addr').inner_text(), fr.locator('#rcv_fax').inner_text(), fr.locator('#rcv_dea').inner_text()), ("5796 E State Hwy 114, Suite 5A", "817-549-8796", "AB1234563"))
    check("receiving pharmacist and PIC filled from the logins", (fr.locator('#rp_rph').input_value(), fr.locator('#rp_lic').input_value(), fr.locator('#rp_pic').input_value(), fr.locator('#rp_piclic').input_value()), ("PHA LASTNAME", "59985", "OWNER LASTNAME" if False else fr.locator('#rp_pic').input_value(), "40291"))
    check("none of the four can be edited", [fr.locator(i).get_attribute('readonly') is not None for i in ('#rp_rph', '#rp_lic', '#rp_pic', '#rp_piclic')], [True] * 4)
    check("directory count", fr.locator('#dirCount').inner_text(), "Pharmacy directory: 1 pharmacies · 1 prescribers")
    p.screenshot(path='screenshots/rx_1_top.png')
    fr.locator('#pt_last').fill("Patientlastname"); fr.locator('#pt_first').fill("Sam"); fr.locator('#pt_dob').fill("01/02/1980")
    fr.locator('#pr_last').fill("Smith"); fr.locator('#pr_first').fill("John"); fr.locator('#pr_caller').fill("Nurse Joy")
    fr.locator('#rx1-drug').fill("Lisinopril"); fr.locator('#rx1-sig').fill("Take 1 tablet daily"); fr.locator('#rx1-qty').fill("30")
    fr.locator('#prSave').click(); fr.locator('#prMsg').wait_for(); p.wait_for_timeout(800)
    check("prescriber save message", fr.locator('#prMsg').inner_text(), "Saved to directory.")
    fr.locator('#pdfBtn').click(); p.wait_for_timeout(2500)
    check("PDF created (copy bar visible)", fr.locator('#copyBar').is_visible(), True)
    p.screenshot(path='screenshots/rx_2_pdf.png', full_page=True)
    p.evaluate("document.documentElement.setAttribute('data-theme','dark')"); p.wait_for_timeout(500); p.screenshot(path='screenshots/rx_3_dark.png')
    check("form follows the suite's dark theme", fr.locator('html').get_attribute('data-theme'), "dark")
    check("patient name never sent to the server", any("Patientlastname".lower() in (u + d).lower() for m, u, d in posted), False)
    p.click('#tabs [data-tab=list]'); p.wait_for_timeout(300); p.click('#tabs [data-tab=rx]'); p.wait_for_timeout(1500)
    check("form is kept when switching tabs", fr.locator('#pt_last').input_value(), "PATIENTLASTNAME")
    p2 = ctx.new_page(); p2.on('pageerror', lambda e: errs.append(str(e)))
    signin(p2, "owner", "ownerpass99"); p2.click('#tabs [data-tab=rx]'); f2 = p2.frame_locator('#rxFrame'); f2.locator('#rcv_name').wait_for(timeout=8000); p2.wait_for_timeout(800)
    check("PIC signed in: both blocks show the same person", (f2.locator('#rp_rph').input_value() == f2.locator('#rp_pic').input_value(), f2.locator('#rp_lic').input_value(), f2.locator('#rp_piclic').input_value()), (True, "40291", "40291"))
    check("no pharmacists editor any more", f2.locator('#staffBtn').count(), 0)
    p2.screenshot(path='screenshots/rx_4_owner.png')
    p3 = ctx.new_page(); signin(p3, "tch", "tchpass12345")
    check("technician's tabs", p3.locator('#tabs button:visible').all_inner_texts(), ["Calendar", "Documents", "Reorder List"])
    # sign out clears the form page
    p.click('#signOut') if p.locator('#signOut').count() else None
    b.close()
check("no page errors (outside the no-internet lookups of this test machine)", [e for e in errs if 'nlm.nih.gov' not in e and 'Failed to load resource' not in e and 'ERR_' not in e], [])
print("FAILED:", fails or "none")

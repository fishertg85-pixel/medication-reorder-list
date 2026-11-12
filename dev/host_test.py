# Host page: a separate gate. Run ./reset.sh first.
import json, subprocess, urllib.request, boto3, base64, sys
from playwright.sync_api import sync_playwright
ids = json.load(open('moto_ids.json'))
c = boto3.client("cognito-idp", endpoint_url="http://localhost:5005", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="x")
FAIL = []
def check(name, ok):
    print(("PASS " if ok else "FAIL ") + name)
    if not ok: FAIL.append(name)
def login(u, pw, newpw=None):
    r = c.initiate_auth(ClientId=ids["client"], AuthFlow="USER_PASSWORD_AUTH", AuthParameters={"USERNAME":u,"PASSWORD":pw})
    if r.get("ChallengeName") == "NEW_PASSWORD_REQUIRED":
        r = c.respond_to_auth_challenge(ClientId=ids["client"], ChallengeName="NEW_PASSWORD_REQUIRED", Session=r["Session"], ChallengeResponses={"USERNAME":u,"NEW_PASSWORD":newpw})
    if r.get("ChallengeName") == "SMS_MFA":           # moto accepts any code
        r = c.respond_to_auth_challenge(ClientId=ids["client"], ChallengeName="SMS_MFA", Session=r["Session"], ChallengeResponses={"USERNAME":u,"SMS_MFA_CODE":"123456"})
    a = r["AuthenticationResult"]; return a["IdToken"], a["AccessToken"]
def api(tok, method, path, body=None):
    req = urllib.request.Request("http://localhost:8790/api"+path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization":"Bearer "+tok, "content-type":"application/json"} if tok else {})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
def node(arg): return json.loads(subprocess.check_output(["node", "boot.mjs", json.dumps(arg)]).decode().strip().splitlines()[-1])

r = node({"makeHost": {"login": "Neo", "name": "Thomas Fisher", "phone": "8175559999", "tempPassword": "hosttemp12a"}})
check("make-host creates the host login", r.get("ok") is True)
check("make-host again only gives a new temp password", node({"makeHost": {"login": "neo", "name": "x", "phone": "8175559999", "tempPassword": "hosttemp34b"}}).get("ok") is True)
check("make-host refuses the Account Manager's login", node({"makeHost": {"login": "owner", "name": "x", "phone": "8175559999"}}).get("ok") is False)

OT, OA = login("owner", "temp12345a", "ownerpass99")
HT, HA = login("neo", "hosttemp34b", "hostpass999")
s, me = api(HT, "GET", "/me")
check("host /me says host, no pharmacies", me.get("host") is True and me.get("owner") is False and me.get("stores") == [])
# the two gates
check("Account Manager gets 404 on the host gate", api(OT, "GET", "/host/users")[0] == 404 and api(OT, "POST", "/host-unlock", {"password":"ownerpass99","accessToken":OA})[0] == 404)
check("host gets refused on the Account Manager gate", api(HT, "GET", "/owner/users")[0] == 403 and api(HT, "POST", "/owner-unlock", {"password":"hostpass999","accessToken":HA})[0] == 403)
check("host gate is locked until the password is given", api(HT, "GET", "/host/users")[0] == 423)
check("wrong password does not open it", api(HT, "POST", "/host-unlock", {"password":"nope12345a","accessToken":HA})[0] == 400)
check("someone else's access token does not open it", api(HT, "POST", "/host-unlock", {"password":"ownerpass99","accessToken":OA})[0] == 401)
check("right password opens it", api(HT, "POST", "/host-unlock", {"password":"hostpass999","accessToken":HA})[0] == 200)
s, u = api(HT, "GET", "/host/users"); users = {x["login"]: x for x in u.get("users", [])}
check("host sees everyone, Account Manager first, host second", s == 200 and [x["login"] for x in u["users"]][:2] == ["owner", "neo"])
check("host has no pharmacy data", api(HT, "GET", "/stores/NTX1/lines")[0] == 403)
amsub = users["owner"]["sub"]; hsub = users["neo"]["sub"]
s, r = api(HT, "POST", f"/host/users/{amsub}/reset-password", {})
check("host resets the Account Manager's password", s == 200 and r.get("tempPassword"))
OT, OA = login("owner", r["tempPassword"], "ownerpass77")
check("Account Manager can sign in with it", bool(OT))
check("host changes the AM's phone (with consent)", api(HT, "POST", f"/host/users/{amsub}", {"phone":"8175550001","smsConsent":True})[0] == 200)
check("host can't change the AM's pharmacies", api(HT, "POST", f"/host/users/{amsub}", {"stores":{"NTX1":False}})[0] == 400)
check("host can't switch itself off", api(HT, "POST", f"/host/users/{hsub}", {"disabled":True})[0] == 400)
check("host can't give itself a pharmacy", api(HT, "POST", f"/host/users/{hsub}", {"stores":{"NTX1":True}})[0] == 400)
check("host adds a pharmacy", api(HT, "POST", "/host/stores", {"id":"NTX2","name":"NorTex Keller","timezone":"America/Chicago"})[0] == 200)
s, r = api(HT, "POST", "/host/users", {"login":"tech1","name":"Tech One","phone":"8175552222","stores":{"NTX2":True},"smsConsent":True})
check("host adds a person to a pharmacy", s == 200 and r["user"]["stores"] == {"NTX2": True})
tsub = r["user"]["sub"]
check("host assigns them another pharmacy", api(HT, "POST", f"/host/users/{tsub}", {"stores":{"NTX1":True}})[0] == 200)
check("host switches a login off", api(HT, "POST", f"/host/users/{tsub}", {"disabled":True})[0] == 200)
check("host switches the AM off and on", api(HT, "POST", f"/host/users/{amsub}", {"disabled":True})[0] == 200 and api(HT, "POST", f"/host/users/{amsub}", {"disabled":False})[0] == 200)
check("host can't import into a pharmacy", api(HT, "POST", "/stores/NTX1/import", {"archive":[]})[0] == 403)
# the Account Manager's side
OT, OA = login("owner", "ownerpass77")
api(OT, "POST", "/owner-unlock", {"password":"ownerpass77","accessToken":OA})
s, u = api(OT, "GET", "/owner/users"); hrow = [x for x in u["users"] if x["login"] == "neo"]
check("Account Manager sees the host row", s == 200 and hrow and hrow[0]["host"] is True)
check("AM can't reset the host's password", api(OT, "POST", f"/owner/users/{hsub}/reset-password", {})[0] == 403)
check("AM can't switch the host off", api(OT, "POST", f"/owner/users/{hsub}", {"disabled":True})[0] == 403)
check("AM can't change the host's phone", api(OT, "POST", f"/owner/users/{hsub}", {"phone":"8175550000","smsConsent":True})[0] == 403)
check("AM can give the host a pharmacy", api(OT, "POST", f"/owner/users/{hsub}", {"stores":{"NTX1":True}})[0] == 200)
check("then the host can open that one", api(HT, "GET", "/stores/NTX1/lines")[0] == 200 and api(HT, "GET", "/stores/NTX2/lines")[0] == 403)
check("AM still can't switch herself off", api(OT, "POST", f"/owner/users/{amsub}", {"disabled":True})[0] == 400)
check("host lock closes the gate", api(HT, "POST", "/host-lock", {})[0] == 200 and api(HT, "GET", "/host/users")[0] == 423)

# ---- the page itself
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 1280, "height": 900})
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("dialog", lambda d: d.accept())
    pg.goto("http://localhost:8790/host.html")
    pg.fill("#sUser", "owner"); pg.fill("#sPass", "ownerpass77"); pg.click("#sGo")
    pg.wait_for_selector("#sMsg:has-text('only for the IronLedger host'), #sCode:visible")
    if pg.is_visible("#sCode"): pg.fill("#sCodeIn", "123456"); pg.click("#sCodeGo"); pg.wait_for_selector("#sMsg:has-text('only for the IronLedger host')")
    check("page turns the Account Manager away", pg.is_visible("#gSign") and not pg.is_visible("#gBody"))
    pg.fill("#sUser", "neo"); pg.fill("#sPass", "hostpass999"); pg.click("#sGo")
    pg.wait_for_selector("#people table, #sCode:visible")
    if pg.is_visible("#sCode"): pg.fill("#sCodeIn", "123456"); pg.click("#sCodeGo"); pg.wait_for_selector("#people table")
    check("host signs in and the page opens without a second password", pg.is_visible("#gBody"))
    check("page lists the AM with reset", pg.locator(f"[data-reset='{amsub}']").count() == 1)
    pg.locator(f"[data-reset='{amsub}']").click()
    pg.wait_for_selector("#passBox:has-text('Temporary password')")
    check("reset from the page shows a temporary password", pg.is_visible("#passBox"))
    pg.screenshot(path="screenshots/host_page.png", full_page=True)
    pg.reload(); pg.wait_for_selector("#gLock", state="visible")
    check("reload asks for the password again", pg.is_visible("#gLock") and not pg.is_visible("#gBody"))
    pg.fill("#lPass", "hostpass999"); pg.click("#lGo"); pg.wait_for_selector("#people table")
    pg.evaluate("lastAct = Date.now() - 6*60*1000"); pg.wait_for_selector("#gLock", state="visible", timeout=20000)
    check("locks after 5 minutes idle", pg.locator("#lMsg").inner_text().startswith("Locked"))
    pg.set_viewport_size({"width": 390, "height": 844}); pg.fill("#lPass", "hostpass999"); pg.click("#lGo"); pg.wait_for_selector("#people table")
    sw = pg.evaluate("document.documentElement.scrollWidth")
    check("fits a phone screen", sw <= 392)
    pg.screenshot(path="screenshots/host_phone.png", full_page=True)
    pg.click("#bOut"); pg.wait_for_selector("#gSign", state="visible")
    check("no script errors", not errs); print(errs) if errs else None
    b.close()
print("\n%d failed" % len(FAIL) if FAIL else "\nall passed"); sys.exit(1 if FAIL else 0)

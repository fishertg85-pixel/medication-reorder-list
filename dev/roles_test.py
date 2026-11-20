# Roles at one pharmacy: who sees which people and billing, per-pharmacy privileges, the host's manage-users switches, the employee portal sign-in check.
# Run ./reset.sh first (no env). A second pass with PORTAL_CLIENT_ID set is in portal_ctx_test.py.
import json, subprocess, urllib.request, urllib.error, boto3, sys
ids = json.load(open('moto_ids.json'))
c = boto3.client("cognito-idp", endpoint_url="http://localhost:5005", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="x")
fails = []
def check(name, got, want=True):
    ok = got == want; print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  got {got!r} want {want!r}'))
    if not ok: fails.append(name)
def login(u, pw, newpw=None):
    r = c.initiate_auth(ClientId=ids["client"], AuthFlow="USER_PASSWORD_AUTH", AuthParameters={"USERNAME": u, "PASSWORD": pw})
    if r.get("ChallengeName") == "NEW_PASSWORD_REQUIRED":
        r = c.respond_to_auth_challenge(ClientId=ids["client"], ChallengeName="NEW_PASSWORD_REQUIRED", Session=r["Session"], ChallengeResponses={"USERNAME": u, "NEW_PASSWORD": newpw})
    return r["AuthenticationResult"]["IdToken"], r["AuthenticationResult"]["AccessToken"]
def api(tok, method, path, body=None):
    req = urllib.request.Request("http://localhost:8790/api" + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Authorization": "Bearer " + tok, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
def node(arg): return json.loads(subprocess.check_output(["node", "boot.mjs", json.dumps(arg)]).decode().strip().splitlines()[-1])
def nomfa(u): c.admin_set_user_mfa_preference(Username=u, UserPoolId=ids["pool"], SMSMfaSettings={"Enabled": False, "PreferredMfa": False})
def unlock(t, a, pw): return api(t, "POST", "/owner-unlock", {"password": pw, "accessToken": a})
def person(H, login, stores, **kw):
    s, r = api(H, "POST", "/host/users", {"login": login, "name": login.title(), "phone": "8175550100", "stores": stores, "smsConsent": True, **kw})
    assert s == 200, (login, s, r)
    nomfa(login); t, a = login_(login, r["tempPassword"]); return r["user"]["sub"], t, a
def login_(u, tmp): return login(u, tmp, u + "pass12345")

nomfa("owner")
node({"makeHost": {"login": "Neo", "name": "Thomas Fisher", "phone": "8175559999", "tempPassword": "hosttemp12a"}})
nomfa("neo"); H, HA = login("neo", "hosttemp12a", "hostpass999"); api(H, "POST", "/host-unlock", {"password": "hostpass999", "accessToken": HA})
CL = dict(legalName="Roles LLC", entityType="llc", ein="12-3456789", address="100 Main St", city="Haslet", state="TX", zip="76052")
C1 = api(H, "POST", "/host/clients", CL)[1]["id"]
ENT = {"clientId": C1, "entityType": "llc", "ein": "98-7654321"}
for sid in ("LAG1", "LAG2"): check("pharmacy " + sid, api(H, "POST", "/host/stores", {"id": sid, "name": "Lag " + sid, **ENT, "entityLegalName": sid + " LLC"})[0], 200)

# people: the owner of LAG1, a PIC super user at LAG1, the client's owner, and staff at both pharmacies
r = api(H, "POST", "/host/stores/LAG1/owner", {"owner": {"create": {"login": "own1", "name": "Own One", "phone": "8175550101", "smsConsent": True}}})[1]; nomfa("own1")
O1, O1A = login("own1", r["tempPassword"], "own1pass12345"); unlock(O1, O1A, "own1pass12345")
r = api(H, "POST", f"/host/clients/{C1}/owner", {"owner": {"create": {"login": "cown", "name": "Client Owner", "phone": "8175550102", "smsConsent": True}}})[1]; nomfa("cown")
CO, COA = login("cown", r["tempPassword"], "cownpass12345"); unlock(CO, COA, "cownpass12345")
picsub, PT, PA = person(H, "picx", {"LAG1": True}, acctType="pic", license="RPH123")
check("host makes the PIC a super user at LAG1", api(H, "POST", f"/host/users/{picsub}", {"adminStores": {"LAG1": True}})[0], 200); unlock(PT, PA, "picxpass12345")
ssub, ST, SA = person(H, "staff1", {"LAG1": True, "LAG2": True})

# ---- who may open a pharmacy's people and billing
s, u = api(H, "GET", "/pharmacy/LAG1/users")
check("host: people at LAG1, with canManage", (s, u["canManage"], sorted(x["login"] for x in u["users"])), (200, True, ["own1", "picx", "staff1"]))
check("the employee login is not in any pharmacy's people", all(x["login"] != "neo" for x in u["users"]))
s, u = api(O1, "GET", "/pharmacy/LAG1/users"); check("owner: own pharmacy, can manage", (s, u["canManage"]), (200, True))
check("owner: another pharmacy of the same client is closed (people and billing)", (api(O1, "GET", "/pharmacy/LAG2/users")[0], api(O1, "GET", "/billing/LAG2")[0]), (403, 403))
check("PIC: people yes, billing no", (api(PT, "GET", "/pharmacy/LAG1/users")[0], api(PT, "GET", "/billing/LAG1")[0]), (200, 403))
s, u = api(CO, "GET", "/pharmacy/LAG1/users"); check("client owner: people at LAG1, view only by default", (s, u["canManage"]), (200, False))
check("client owner: both pharmacies' billing", (api(CO, "GET", "/billing/LAG1")[0], api(CO, "GET", "/billing/LAG2")[0]), (200, 200))
check("staff: nothing", (api(ST, "GET", "/pharmacy/LAG1/users")[0], api(ST, "GET", "/billing/LAG1")[0]), (403, 403))
s, u = api(O1, "GET", "/pharmacy/LAG1/users")
st1 = [x for x in u["users"] if x["login"] == "staff1"][0]
check("another pharmacy's name is not shown to the owner (only a count)", ("otherIds" in st1, st1["others"]), (False, 1))
check("the host does see which other pharmacies", api(H, "GET", "/pharmacy/LAG1/users")[1]["users"][0].get("otherIds") is not None)

# ---- invoices belong to the pharmacy
today = api(H, "GET", "/host/stores/LAG1/billing")[1]["today"]
check("host adds an invoice to LAG1", api(H, "POST", "/host/stores/LAG1/invoices", {"issued": today, "due": "2099-01-01", "amount": "149.00", "description": "Calendar"})[0], 200)
check("owner of LAG1 sees it, client owner sees it, LAG2 has none", (len(api(O1, "GET", "/billing/LAG1")[1]["invoices"]), len(api(CO, "GET", "/billing/LAG1")[1]["invoices"]), len(api(CO, "GET", "/billing/LAG2")[1]["invoices"])), (1, 1, 0))
check("nobody but IronLedger changes an invoice", (api(O1, "POST", "/owner/stores/LAG1/invoices", {"issued": today, "due": today, "amount": "1"})[0], api(CO, "POST", "/owner/stores/LAG1/invoices", {"issued": today, "due": today, "amount": "1"})[0]), (403, 403))

# ---- privileges at one pharmacy
check("host sets a privilege at LAG1 only", api(H, "POST", f"/host/users/{ssub}", {"perms": {"remove": False}, "permStore": "LAG1"})[0], 200)
mine = {x["id"]: x["perms"]["remove"] for x in api(ST, "GET", "/me")[1]["stores"]}
check("staff: remove is off at LAG1 and still on at LAG2", mine, {"LAG1": False, "LAG2": True})
check("the people list shows it per pharmacy", ([x for x in api(H, "GET", "/pharmacy/LAG1/users")[1]["users"] if x["login"] == "staff1"][0]["perms"]["remove"], [x for x in api(H, "GET", "/pharmacy/LAG2/users")[1]["users"] if x["login"] == "staff1"][0]["perms"]["remove"]), (False, True))

# ---- the host's manage-users switches
chg = lambda t, perm: api(t, "POST", f"/owner/users/{ssub}", {"perms": {"submit": perm}, "permStore": "LAG1"})[0]
check("defaults: the owner and the PIC may manage, the client owner may not", (chg(O1, True), chg(PT, True), chg(CO, True)), (200, 200, 403))
check("host switches the owner off at LAG1", api(H, "POST", "/host/stores/LAG1", {"mgrOwner": False})[0], 200)
check("owner can still look but not change", (api(O1, "GET", "/pharmacy/LAG1/users")[1]["canManage"], chg(O1, True)), (False, 404))
check("the PIC still can", chg(PT, True), 200)
check("host switches the client owner on at LAG1 only", api(H, "POST", "/host/stores/LAG1", {"mgrClient": True})[0], 200)
check("client owner changes people at LAG1, not at LAG2", (chg(CO, False), api(CO, "POST", f"/owner/users/{ssub}", {"perms": {"submit": True}, "permStore": "LAG2"})[0]), (200, 403))
check("client owner may not give super user, change ownership or reset the owner", (api(CO, "POST", f"/owner/users/{picsub}", {"adminStores": {"LAG1": False}})[0], api(CO, "POST", "/owner/users/" + [x for x in api(H, "GET", "/pharmacy/LAG1/users")[1]["users"] if x["login"] == "own1"][0]["sub"] + "/reset-password", {})[0]), (403, 403))
check("host switches the PIC off", api(H, "POST", "/host/stores/LAG1", {"mgrPic": False})[0], 200)
check("the PIC cannot change people any more", chg(PT, True), 404)
for k in ("mgrOwner", "mgrPic"): api(H, "POST", "/host/stores/LAG1", {k: True})
api(H, "POST", "/host/stores/LAG1", {"mgrClient": False})
check("switches back to the defaults", (chg(O1, True), chg(PT, True), chg(CO, True)), (200, 200, 403))
check("only the host can set the switches", (api(O1, "POST", "/owner/stores/LAG1", {"mgrOwner": False})[0], api(CO, "POST", "/owner/stores/LAG1", {"mgrClient": True})[0]), (403, 403))
check("a switch is recorded in the pharmacy's history", any("mgrOwner" in (h.get("changes") or {}) for h in api(H, "GET", "/host/stores/LAG1/history")[1]["history"]))

# ---- one person, both a pharmacy user and an IronLedger employee
bsub, BT, BA = person(H, "both1", {"LAG1": True})
r = node({"makeHost": {"login": "both1", "name": "x", "phone": "8175550199"}})
check("an existing pharmacy login can be made an employee too (same ID and password)", r.get("ok"), True)
check("the owner still sees them as ordinary staff, and can set their privileges here", (any(x["login"] == "both1" for x in api(O1, "GET", "/pharmacy/LAG1/users")[1]["users"]), api(O1, "POST", f"/owner/users/{bsub}", {"perms": {"submit": False}, "permStore": "LAG1"})[0]), (True, 200))
check("but the owner can't reset their password, switch them off or delete them", (api(O1, "POST", f"/owner/users/{bsub}/reset-password", {})[0], api(O1, "POST", f"/owner/users/{bsub}", {"disabled": True})[0], api(O1, "POST", f"/owner/users/{bsub}/delete", {})[0]), (403, 403, 403))
check("the host can set an employee-with-pharmacy's access", api(H, "POST", f"/host/users/{bsub}", {"stores": {"LAG2": True}})[0], 200)
check("an employee login can be an Account Owner", api(H, "POST", "/host/stores/LAG2/owner", {"owner": {"sub": bsub}})[0], 200)

# ---- the Cognito pre-sign-in check (called as Cognito would call it)
pre = lambda cid, sub, env=None: node({"triggerSource": "PreAuthentication_Authentication", "userPoolId": ids["pool"], "callerContext": {"clientId": cid}, "request": {"userAttributes": {"sub": sub}}})
check("with no portal client configured, every sign-in is let through", "threw" not in pre(ids["client"], ssub))
print("\n" + ("all passed" if not fails else "FAILED: " + str(fails)))

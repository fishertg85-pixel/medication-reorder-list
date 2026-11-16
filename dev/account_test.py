# Pharmacy profile (NPI, DEA, license, services, hours) and account types. Run ./reset.sh first.
import json, subprocess, urllib.request, boto3, sys
ids = json.load(open('moto_ids.json'))
c = boto3.client("cognito-idp", endpoint_url="http://localhost:5005", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="x")
fails = []
def check(name, got, want):
    ok = got == want; print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  got {got!r} want {want!r}'))
    if not ok: fails.append(name)
def login(u, pw, newpw):
    r = c.initiate_auth(ClientId=ids["client"], AuthFlow="USER_PASSWORD_AUTH", AuthParameters={"USERNAME": u, "PASSWORD": pw})
    if r.get("ChallengeName") == "NEW_PASSWORD_REQUIRED":
        r = c.respond_to_auth_challenge(ClientId=ids["client"], ChallengeName="NEW_PASSWORD_REQUIRED", Session=r["Session"], ChallengeResponses={"USERNAME": u, "NEW_PASSWORD": newpw})
    return r["AuthenticationResult"]
def api(tok, method, path, body=None):
    req = urllib.request.Request("http://localhost:8790/api" + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Authorization": "Bearer " + tok, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
a = login("owner", "temp12345a", "ownerpass99"); O = a["IdToken"]; api(O, "POST", "/owner-unlock", {"password": "ownerpass99", "accessToken": a["AccessToken"]})
def node(arg): return json.loads(subprocess.check_output(["node", "boot.mjs", json.dumps(arg)]).decode().strip().splitlines()[-1])
node({"makeHost": {"login": "Neo", "name": "Thomas Fisher", "phone": "8175559999", "tempPassword": "hosttemp12a"}})
h = login("neo", "hosttemp12a", "hostpass999"); H = h["IdToken"]; api(H, "POST", "/host-unlock", {"password": "hostpass999", "accessToken": h["AccessToken"]})
st = lambda body: api(H, "POST", "/host/stores/NTX1", body)           # licenses, identifiers, services and the Calendar switch are set by the host
stO = lambda body: api(O, "POST", "/owner/stores/NTX1", body)         # the Account Manager can only change name, address, phone, hours...
getS = lambda: [x for x in api(H, "GET", "/host/stores")[1]["stores"] if x["id"] == "NTX1"][0]
good_hours = [None] + [{"o": "09:00", "c": "18:00"}] * 5 + [None]
check("valid profile saves", st({"npi": "1234567893", "dea": "ab1234563", "deaExpires": "2028-03-31", "license": "12345", "licenseExpires": "2027-06-30", "ncpdp": "1234567",
    "services": ["retail", "controlled", "sterile"], "servicesOther": "Compounded vet meds", "hours": good_hours})[0], 200)
s = getS()
check("fields come back (DEA upper-cased)", (s["npi"], s["dea"], s["deaExpires"], s["licenseExpires"], s["ncpdp"], s["services"], s["servicesOther"], s["hours"][1], s["hours"][0]),
      ("1234567893", "AB1234563", "2028-03-31", "2027-06-30", "1234567", ["retail", "controlled", "sterile"], "Compounded vet meds", {"o": "09:00", "c": "18:00"}, None))
check("NPI check digit wrong", st({"npi": "1234567890"})[0], 400); check("NPI not 10 digits", st({"npi": "12345"})[0], 400)
check("DEA check digit wrong", st({"dea": "AB1234560"})[0], 400); check("DEA bad shape", st({"dea": "1234567"})[0], 400)
check("NCPDP not 7 digits", st({"ncpdp": "123"})[0], 400); check("bad expiration date", st({"deaExpires": "03/31/2028"})[0], 400)
check("unknown service", st({"services": ["retail", "bogus"]})[0], 400); check("services must be a list", st({"services": "retail"})[0], 400)
check("hours: not seven days", st({"hours": good_hours[:5]})[0], 400)
check("hours: close before open", st({"hours": [None] + [{"o": "18:00", "c": "09:00"}] * 5 + [None]})[0], 400)
check("clearing an identifier works", (st({"npi": ""})[0], getS()["npi"]), (200, ""))
pub = api(O, "GET", "/public/pharmacy/NTX1")[1]
check("sign-in screen shows only name and logo", sorted(pub.keys()), ["found", "id", "logo", "name"])
def mk(l, ph):
    s_, r = api(O, "POST", "/owner/users", {"login": l, "name": l.upper(), "phone": ph, "smsConsent": True, "stores": {"NTX1": True}, "acctType": "tech"}); assert s_ == 200, r
    return r["user"]["sub"], r["tempPassword"]
sub, tmp = mk("acct1", "(817) 555-0201")
users = {u["login"]: u for u in api(O, "GET", "/owner/users")[1]["users"]}
check("type set when the person is added", users["acct1"]["acctType"], "tech")
check("change type", api(O, "POST", "/owner/users/" + sub, {"acctType": "pharmacist"})[0], 200)
check("type listed", {u["login"]: u["acctType"] for u in api(O, "GET", "/owner/users")[1]["users"]}["acct1"], "pharmacist")
check("bad type refused", api(O, "POST", "/owner/users/" + sub, {"acctType": "wizard"})[0], 400)
check("clear type", api(O, "POST", "/owner/users/" + sub, {"acctType": ""})[0], 200)
ownersub = [u for u in api(O, "GET", "/owner/users")[1]["users"] if u["owner"]][0]["sub"]
check("Account Manager has no type to set", api(O, "POST", "/owner/users/" + ownersub, {"acctType": "tech"})[0], 400)
api(O, "POST", "/owner/users/" + sub, {"acctType": "tech"})
U = login("acct1", tmp, "acct1pass12345")["IdToken"]
check("/me carries the type", api(U, "GET", "/me")[1]["acctType"], "tech")

# ---- NPI Registry lookup (stand-in registry in dev/server.mjs; real one is public NPPES v2.1)
r = api(H, "GET", "/host/npi/1234567893"); check("NPI lookup finds the organization", (r[0], r[1].get("found"), r[1].get("name"), r[1].get("type"), r[1].get("active"), r[1].get("pharmacyTaxonomy")), (200, True, "NORTEX PHARMACY LLC", "organization", True, True))
check("lookup uses the LOCATION address, ZIP cut to 5", r[1]["address"], {"address": "100 MAIN ST", "suite": "STE 5", "city": "HASLET", "state": "TX", "zip": "76252", "phone": "817-555-0100", "fax": "817-555-0101"})
check("lookup passes license/taxonomy through", r[1]["taxonomies"][0]["license"], "TX12345")
r = api(H, "GET", "/host/npi/1245319599"); check("individual NPI flagged as individual", (r[1].get("found"), r[1].get("type")), (True, "individual"))
check("NPI not in registry", api(H, "GET", "/host/npi/1111111112")[1], {"found": False})
check("bad check digit refused before any lookup", api(H, "GET", "/host/npi/1234567890")[0], 400)
check("registry failure is a clear 502", api(H, "GET", "/host/npi/9999999995")[0], 502)
check("registry lookup is host only", (api(U, "GET", "/owner/npi/1234567893")[0], api(O, "GET", "/owner/npi/1234567893")[0], api(U, "GET", "/host/npi/1234567893")[0]), (403, 403, 404))
# ---- DEA: recorded check against the exact number
st({"dea": "AB1234563"})
check("DEA check needs a number on file", (api(H, "POST", "/host/stores/NTX1", {"dea": "", "deaVerified": True})[0]), 400)
check("DEA check recorded", api(H, "POST", "/host/stores/NTX1", {"dea": "AB1234563", "deaVerified": True})[0], 200)
s = getS()
check("check shows who and when", (bool(s["deaVerified"]), s["deaVerified"]["by"] != "", len(s["deaVerified"]["at"]) > 10), (True, True, True))
check("saving the same number keeps the check", (st({"dea": "AB1234563", "deaExpires": "2029-01-31"})[0], getS()["deaVerified"] is not None), (200, True))
check("changing the number voids the check", (st({"dea": "AB1234575"})[0], getS()["deaVerified"]), (200, None))
st({"dea": "AB1234563"})
check("changing back does not revive it", getS()["deaVerified"], None)
check("verified flag cannot be set false/edited", api(H, "POST", "/host/stores/NTX1", {"deaVerified": False})[0], 400)
check("a staff login cannot edit the pharmacy profile", api(U, "POST", "/owner/stores/NTX1", {"npi": "1234567893"})[0], 403)
# ---- host-only fields: the Account Manager sees them but the server refuses any change; the host (IronLedger) sets them
for k, v in [("calendar", True), ("services", ["retail"]), ("servicesOther", "x"), ("npi", "1234567893"), ("dea", "AB1234563"), ("deaExpires", "2030-01-01"),
             ("ncpdp", "1234567"), ("license", "999"), ("licenseExpires", "2030-01-01"), ("deaVerified", True)]:
    check("Account Manager cannot change " + k, stO({k: v})[0], 403)
check("a refused request changes nothing", (getS()["license"], getS()["services"]), ("12345", ["retail", "controlled", "sterile"]))
check("Account Manager can still edit name, phone and hours", stO({"name": "NorTex Pharmacy", "phone": "(817) 555-0100", "hours": good_hours})[0], 200)
check("and the new phone shows", getS()["phone"], "(817) 555-0100")
check("Account Manager cannot add a pharmacy", api(O, "POST", "/owner/stores", {"id": "ZZ9", "name": "Nope"})[0], 403)
check("Account Manager still sees the identifiers (read-only)", [x for x in api(O, "GET", "/owner/stores")[1]["stores"] if x["id"] == "NTX1"][0]["npi"], "")
check("host turns the Calendar switch on", (st({"calendar": True})[0], getS()["calendar"]), (200, True))
check("host creates a new pharmacy with its whole profile", api(H, "POST", "/host/stores", {"id": "tst2", "name": "Test Two", "city": "Haslet", "state": "TX", "zip": "76052", "npi": "1234567893", "dea": "AB1234563",
      "ncpdp": "1234567", "license": "A1", "services": ["retail", "delivery"], "calendar": False, "hours": good_hours})[0], 200)
t2 = [x for x in api(H, "GET", "/host/stores")[1]["stores"] if x["id"] == "TST2"]
check("new pharmacy saved with its fields", (len(t2), t2 and t2[0]["services"], t2 and t2[0]["npi"]), (1, ["retail", "delivery"], "1234567893"))
check("new pharmacy ID already used is refused", api(H, "POST", "/host/stores", {"id": "TST2", "name": "Again"})[0], 400)
check("new pharmacy ID must be valid", api(H, "POST", "/host/stores", {"id": "x", "name": "Bad"})[0], 400)
check("a staff login cannot change types", api(U, "POST", "/owner/users/" + sub, {"acctType": "pic"})[0], 403)
# ---- an IronLedger rep (none exist yet): passwords and privileges only; pharmacy details and services wait for a supervisor
node({"makeHost": {"login": "rep1", "name": "Rep One", "phone": "8175559998", "tempPassword": "reptemp12a", "role": "rep"}})
rp = login("rep1", "reptemp12a", "reppass9999"); RT = rp["IdToken"]; api(RT, "POST", "/host-unlock", {"password": "reppass9999", "accessToken": rp["AccessToken"]})
check("rep can see pharmacies", api(RT, "GET", "/host/stores")[0], 200)
check("rep can see users", api(RT, "GET", "/host/users")[0], 200)
check("rep can change a privilege on an active person with a type", (api(RT, "POST", "/host/users/" + sub, {"perms": {"archive": False}})[0], [u for u in api(H, "GET", "/host/users")[1]["users"] if u["login"] == "acct1"][0]["perms"]["archive"]), (200, False))
check("rep cannot change the account type itself", api(RT, "POST", "/host/users/" + sub, {"acctType": "pharmacist"})[0], 403)
check("rep cannot change the Calendar privilege", api(RT, "POST", "/host/users/" + sub, {"perms": {"calendar": True}})[0], 403)
check("rep cannot change pharmacies, name or phone", [api(RT, "POST", "/host/users/" + sub, b)[0] for b in ({"stores": {"NTX1": False}}, {"name": "X"}, {"phone": "8175550000", "smsConsent": True}, {"disabled": True})], [403, 403, 403, 403])
check("rep cannot delete a person", api(RT, "POST", "/host/users/" + sub + "/delete", {})[0], 403)
sub2, tmp2 = mk("acct2", "(817) 555-0202")
check("rep cannot change privileges of a person who has not signed in yet", api(RT, "POST", "/host/users/" + sub2, {"perms": {"archive": False}})[0], 403)
api(O, "POST", "/owner/users/" + sub2, {"acctType": ""}); login("acct2", tmp2, "acct2pass12345")
check("rep cannot change privileges of a person with no account type", api(RT, "POST", "/host/users/" + sub2, {"perms": {"archive": False}})[0], 403)
api(O, "POST", "/owner/users/" + sub2, {"acctType": "tech"}); api(O, "POST", "/owner/users/" + sub2, {"disabled": True})
check("rep cannot change privileges of a switched-off person", api(RT, "POST", "/host/users/" + sub2, {"perms": {"archive": False}})[0], 403)
hsub = [u for u in api(H, "GET", "/host/users")[1]["users"] if u["login"] == "neo"][0]["sub"]
check("rep cannot reset a host login", api(RT, "POST", "/host/users/" + hsub + "/reset-password", {})[0], 403)
check("a supervisor still can change the type", api(H, "POST", "/host/users/" + sub, {"acctType": "pharmacist"})[0], 200)
check("rep can change a user's privileges", api(RT, "POST", "/host/users/" + sub, {"perms": {"remove": True}})[0], 200)
check("rep can reset an active user's password", api(RT, "POST", "/host/users/" + sub + "/reset-password", {})[0], 200)
check("rep cannot change a phone number", api(RT, "POST", "/host/users/" + sub, {"phone": "8175550000", "smsConsent": True})[0], 403)
check("rep cannot change pharmacy access", api(RT, "POST", "/host/users/" + sub, {"stores": {"NTX1": False}})[0], 403)
check("rep cannot mix an allowed and a disallowed change", api(RT, "POST", "/host/users/" + sub, {"acctType": "tech", "disabled": True})[0], 403)
check("rep cannot add a user", api(RT, "POST", "/host/users", {"login": "zz1", "name": "Z", "phone": "8175550003", "stores": {}, "smsConsent": True})[0], 403)
check("rep cannot touch the Account Manager", (api(RT, "POST", "/host/users/" + ownersub, {"perms": {"remove": False}})[0], api(RT, "POST", "/host/users/" + ownersub + "/reset-password", {})[0]), (403, 403))
check("rep cannot import", api(RT, "POST", "/host/import/NTX1", {"archive": []})[0], 403)
api(H, "POST", "/host/users/" + sub, {"disabled": True})
check("rep cannot change a user who is switched off", api(RT, "POST", "/host/users/" + sub, {"acctType": "tech"})[0], 403)
check("rep cannot delete a user", api(RT, "POST", "/host/users/" + sub + "/delete", {})[0], 403)
api(H, "POST", "/host/users/" + sub, {"disabled": False})
check("rep cannot turn on services", api(RT, "POST", "/host/stores/NTX1", {"services": ["retail", "sterile"]})[0], 403)
check("rep cannot turn on the Calendar", api(RT, "POST", "/host/stores/NTX1", {"calendar": False})[0], 403)
check("rep cannot edit pharmacy details yet", api(RT, "POST", "/host/stores/NTX1", {"phone": "1"})[0], 403)
check("rep cannot create a pharmacy", api(RT, "POST", "/host/stores", {"id": "RR1", "name": "x"})[0], 403)
check("rep cannot use the registry lookup", api(RT, "GET", "/host/npi/1234567893")[0], 403)
check("services were not changed by the rep", getS()["services"], ["retail", "controlled", "sterile"])
print("\nFAILED:", fails if fails else "none"); sys.exit(1 if fails else 0)

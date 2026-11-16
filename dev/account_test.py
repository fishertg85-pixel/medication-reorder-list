# Pharmacy profile (NPI, DEA, license, services, hours) and account types. Run ./reset.sh first.
import json, urllib.request, boto3, sys
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
st = lambda body: api(O, "POST", "/owner/stores/NTX1", body)
good_hours = [None] + [{"o": "09:00", "c": "18:00"}] * 5 + [None]
check("valid profile saves", st({"npi": "1234567893", "dea": "ab1234563", "deaExpires": "2028-03-31", "license": "12345", "licenseExpires": "2027-06-30", "ncpdp": "1234567",
    "services": ["retail", "controlled", "sterile"], "servicesOther": "Compounded vet meds", "hours": good_hours})[0], 200)
s = [x for x in api(O, "GET", "/owner/stores")[1]["stores"] if x["id"] == "NTX1"][0]
check("fields come back (DEA upper-cased)", (s["npi"], s["dea"], s["deaExpires"], s["licenseExpires"], s["ncpdp"], s["services"], s["servicesOther"], s["hours"][1], s["hours"][0]),
      ("1234567893", "AB1234563", "2028-03-31", "2027-06-30", "1234567", ["retail", "controlled", "sterile"], "Compounded vet meds", {"o": "09:00", "c": "18:00"}, None))
check("NPI check digit wrong", st({"npi": "1234567890"})[0], 400); check("NPI not 10 digits", st({"npi": "12345"})[0], 400)
check("DEA check digit wrong", st({"dea": "AB1234560"})[0], 400); check("DEA bad shape", st({"dea": "1234567"})[0], 400)
check("NCPDP not 7 digits", st({"ncpdp": "123"})[0], 400); check("bad expiration date", st({"deaExpires": "03/31/2028"})[0], 400)
check("unknown service", st({"services": ["retail", "bogus"]})[0], 400); check("services must be a list", st({"services": "retail"})[0], 400)
check("hours: not seven days", st({"hours": good_hours[:5]})[0], 400)
check("hours: close before open", st({"hours": [None] + [{"o": "18:00", "c": "09:00"}] * 5 + [None]})[0], 400)
check("clearing an identifier works", (st({"npi": ""})[0], [x for x in api(O, "GET", "/owner/stores")[1]["stores"] if x["id"] == "NTX1"][0]["npi"]), (200, ""))
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
r = api(O, "GET", "/owner/npi/1234567893"); check("NPI lookup finds the organization", (r[0], r[1].get("found"), r[1].get("name"), r[1].get("type"), r[1].get("active"), r[1].get("pharmacyTaxonomy")), (200, True, "NORTEX PHARMACY LLC", "organization", True, True))
check("lookup uses the LOCATION address, ZIP cut to 5", r[1]["address"], {"address": "100 MAIN ST", "suite": "STE 5", "city": "HASLET", "state": "TX", "zip": "76252", "phone": "817-555-0100", "fax": "817-555-0101"})
check("lookup passes license/taxonomy through", r[1]["taxonomies"][0]["license"], "TX12345")
r = api(O, "GET", "/owner/npi/1245319599"); check("individual NPI flagged as individual", (r[1].get("found"), r[1].get("type")), (True, "individual"))
check("NPI not in registry", api(O, "GET", "/owner/npi/1111111112")[1], {"found": False})
check("bad check digit refused before any lookup", api(O, "GET", "/owner/npi/1234567890")[0], 400)
check("registry failure is a clear 502", api(O, "GET", "/owner/npi/9999999995")[0], 502)
check("lookup is owner only", api(U, "GET", "/owner/npi/1234567893")[0], 403)
# ---- DEA: recorded check against the exact number
st({"dea": "AB1234563"})
check("DEA check needs a number on file", (api(O, "POST", "/owner/stores/NTX1", {"dea": "", "deaVerified": True})[0]), 400)
check("DEA check recorded", api(O, "POST", "/owner/stores/NTX1", {"dea": "AB1234563", "deaVerified": True})[0], 200)
s = [x for x in api(O, "GET", "/owner/stores")[1]["stores"] if x["id"] == "NTX1"][0]
check("check shows who and when", (bool(s["deaVerified"]), s["deaVerified"]["by"] != "", len(s["deaVerified"]["at"]) > 10), (True, True, True))
check("saving the same number keeps the check", (st({"dea": "AB1234563", "deaExpires": "2029-01-31"})[0], [x for x in api(O, "GET", "/owner/stores")[1]["stores"] if x["id"] == "NTX1"][0]["deaVerified"] is not None), (200, True))
check("changing the number voids the check", (st({"dea": "AB1234575"})[0], [x for x in api(O, "GET", "/owner/stores")[1]["stores"] if x["id"] == "NTX1"][0]["deaVerified"]), (200, None))
st({"dea": "AB1234563"})
check("changing back does not revive it", [x for x in api(O, "GET", "/owner/stores")[1]["stores"] if x["id"] == "NTX1"][0]["deaVerified"], None)
check("verified flag cannot be set false/edited", api(O, "POST", "/owner/stores/NTX1", {"deaVerified": False})[0], 400)
check("a staff login cannot edit the pharmacy profile", api(U, "POST", "/owner/stores/NTX1", {"npi": "1234567893"})[0], 403)
check("a staff login cannot change types", api(U, "POST", "/owner/users/" + sub, {"acctType": "pic"})[0], 403)
print("\nFAILED:", fails if fails else "none"); sys.exit(1 if fails else 0)

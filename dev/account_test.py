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
st = lambda body: api(H, "POST", "/host/stores/NTX1", {**body, "changeReason": "test change reason"})           # licenses, identifiers, services and the Calendar switch are set by the host
stO = lambda body: api(O, "POST", "/owner/stores/NTX1", body)         # the Account Owner can only change name, address, phone, hours...
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
check("Account Owner has no type to set", api(O, "POST", "/owner/users/" + ownersub, {"acctType": "tech"})[0], 400)
api(O, "POST", "/owner/users/" + sub, {"acctType": "tech"})
check("Account Owner cannot change her OWN mobile number", api(O, "POST", "/owner/users/" + ownersub, {"phone": "8175550777", "smsConsent": True})[0], 403)
check("her number is unchanged", [u for u in api(O, "GET", "/owner/users")[1]["users"] if u["owner"]][0]["phone"] != "+18175550777", True)
check("Account Owner can still change a staff member's number", api(O, "POST", "/owner/users/" + sub, {"phone": "8175550778", "smsConsent": True})[0], 200)
check("host can change the Account Owner's number", api(H, "POST", "/host/users/" + ownersub, {"phone": "8175550001", "smsConsent": True})[0], 200)
check("no per-person email is accepted", (api(O, "POST", "/owner/users/" + sub, {"email": "x@example.com"})[0], api(H, "POST", "/host/users/" + ownersub, {"email": "x@example.com"})[0]), (400, 400))
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
# ---- host-only fields: the Account Owner sees them but the server refuses any change; the host (IronLedger) sets them
for k, v in [("calendar", True), ("services", ["retail"]), ("servicesOther", "x"), ("npi", "1234567893"), ("dea", "AB1234563"), ("name", "Renamed"), ("address", "1 New St"),
             ("suite", "9"), ("city", "Keller"), ("state", "OK"), ("zip", "76248"), ("ncpdp", "1234567"), ("license", "999"), ("deaVerified", True), ("changeReason", "because I said so")]:
    check("Account Owner cannot change " + k, stO({k: v})[0], 403)
check("a refused request changes nothing", (getS()["license"], getS()["services"], getS()["name"] != "Renamed"), ("12345", ["retail", "controlled", "sterile"], True))
check("Account Owner can edit phone, fax, time zone, hours and the two expiration dates", stO({"phone": "(817) 555-0100", "fax": "(817) 555-0101", "email": "pharmacy@example.com", "timezone": "America/Denver", "hours": good_hours, "licenseExpires": "2027-12-31", "deaExpires": "2028-12-31"})[0], 200)
check("and they show", (getS()["email"], getS()["fax"], getS()["timezone"], getS()["licenseExpires"], getS()["deaExpires"]), ("pharmacy@example.com", "(817) 555-0101", "America/Denver", "2027-12-31", "2028-12-31"))
stO({"timezone": "America/Chicago"})
check("and the new phone shows", getS()["phone"], "(817) 555-0100")
cl_ok = {"days": [{"d": "2026-11-27", "n": "Day after Thanksgiving", "y": False}, {"d": "2026-02-17", "n": "Mardi Gras", "y": True}]}
check("Account Owner adds closed days", stO({"closures": cl_ok})[0], 200)
check("closed days come back sorted by date", [x["n"] for x in getS()["closures"]["days"]], ["Mardi Gras", "Day after Thanksgiving"])
check("closed days: a stray observance list is ignored and not stored", (stO({"closures": {"obs": ["bogus"], "days": cl_ok["days"]}})[0], "obs" in getS()["closures"]), (200, False))
check("closed day: not a real date refused", stO({"closures": {"days": [{"d": "2026-02-30", "n": "x", "y": False}]}})[0], 400)
check("closed day: name required", stO({"closures": {"days": [{"d": "2026-12-28", "n": " ", "y": False}]}})[0], 400)
check("closed day: same date twice refused", stO({"closures": {"days": [{"d": "2026-12-28", "n": "a", "y": False}, {"d": "2026-12-28", "n": "b", "y": False}]}})[0], 400)
check("closed day: more than 60 refused", stO({"closures": {"days": [{"d": "2026-%02d-%02d" % (1 + i // 28, 1 + i % 28), "n": "x", "y": False} for i in range(61)]}})[0], 400)
check("a refused request changes nothing", len(getS()["closures"]["days"]), 2)
check("staff cannot edit closed days", api(U, "POST", "/owner/stores/NTX1", {"closures": {"days": []}})[0], 403)
check("closed days appear for staff who open the pharmacy", [x["n"] for x in [x for x in api(U, "GET", "/me")[1]["stores"] if x["id"] == "NTX1"][0]["closures"]["days"]], ["Mardi Gras", "Day after Thanksgiving"])
check("closed-day change is in the history", "closures" in api(H, "GET", "/host/stores/NTX1/history")[1]["history"][0]["changes"], True)
check("Account Owner cannot add a pharmacy", api(O, "POST", "/owner/stores", {"id": "ZZ9", "name": "Nope"})[0], 403)
check("Account Owner still sees the identifiers (read-only)", [x for x in api(O, "GET", "/owner/stores")[1]["stores"] if x["id"] == "NTX1"][0]["npi"], "")
# identity values on file are hard to change: a reason is required even for the host, and every change is kept in the history
nm = getS()["name"]
check("host cannot change the name without a reason", api(H, "POST", "/host/stores/NTX1", {"name": "Different Name LLC"})[0], 400)
check("a reason that is too short is refused", api(H, "POST", "/host/stores/NTX1", {"name": "Different Name LLC", "changeReason": "typo"})[0], 400)
check("name unchanged after refusals", getS()["name"], nm)
check("host changes the name with a reason", api(H, "POST", "/host/stores/NTX1", {"name": "Different Name LLC", "changeReason": "Name corrected to match the license"})[0], 200)
check("saving the same values again needs no reason", api(H, "POST", "/host/stores/NTX1", {"name": "Different Name LLC", "phone": "(817) 555-0100"})[0], 200)
api(H, "POST", "/host/stores/NTX1", {"name": nm, "changeReason": "Reverting the test change"})
hist = api(H, "GET", "/host/stores/NTX1/history")[1]["history"]
check("history records who, why and what changed", (len(hist) >= 2, hist[0]["reason"], hist[0]["changes"]["name"][1], hist[0]["by"] != ""), (True, "Reverting the test change", nm, True))
check("Account Owner and staff cannot read the history", (api(O, "GET", "/owner/stores/NTX1/history")[0], api(U, "GET", "/owner/stores/NTX1/history")[0]), (403, 403))
CL = lambda **k: dict({"legalName": "NorTex Holdings LLC", "entityType": "llc", "ein": "12-3456789", "address": "100 Main St", "city": "Haslet", "state": "TX", "zip": "76052"}, **k)
client1 = api(H, "POST", "/host/clients", CL())[1]["id"]; ENT = {"clientId": client1, "entityLegalName": "Blank Test LLC", "entityType": "llc", "ein": "98-7654321"}
api(H, "POST", "/host/stores", {"id": "TST3", "name": "Blank Test", **ENT})
check("filling a blank identity value needs no reason", api(H, "POST", "/host/stores/TST3", {"npi": "1234567893", "city": "Haslet"})[0], 200)
check("changing it afterwards does", api(H, "POST", "/host/stores/TST3", {"city": "Keller"})[0], 400)
# clients: the bill-to account with the generated IL- account number; pharmacies carry the licensed entity and its EIN
check("account number generated when the client is created", client1[:3], "IL-")
client2 = api(H, "POST", "/host/clients", CL(legalName="Second Client Inc", entityType="corporation", ein="55-1234567"))[1]["id"]
check("account numbers are unique", client1 != client2, True)
check("account number cannot be set through an update", api(H, "POST", "/host/clients/" + client1, {"acctNo": "IL-999999"})[0], 400)
check("Account Owner and staff cannot see or change clients", (api(O, "GET", "/owner/clients")[0], api(U, "GET", "/owner/clients")[0], api(O, "POST", "/owner/clients", CL())[0], api(O, "POST", "/owner/clients/" + client1, {"dba": "x"})[0]), (403, 403, 403, 403))
check("client needs legal name, type, EIN and address", [api(H, "POST", "/host/clients", {k: v for k, v in CL().items() if k != drop})[0] for drop in ("legalName", "entityType", "ein", "address", "city", "state", "zip")], [400] * 7)
check("EIN must be 9 digits", (api(H, "POST", "/host/clients", CL(ein="12-345"))[0], api(H, "POST", "/host/clients", CL(ein="ab-cdefghi"))[0]), (400, 400))
check("entity type must be from the list", api(H, "POST", "/host/clients", CL(entityType="trust"))[0], 400)
check("EIN is stored as XX-XXXXXXX", (api(H, "POST", "/host/clients/" + client2, {"ein": "551234567"})[0], [c for c in api(H, "GET", "/host/clients")[1]["clients"] if c["id"] == client2][0]["ein"]), (200, "55-1234567"))
check("changing the legal name needs a reason", api(H, "POST", "/host/clients/" + client2, {"legalName": "Second Client Holdings Inc"})[0], 400)
check("changing EIN needs a reason", api(H, "POST", "/host/clients/" + client2, {"ein": "55-7654321"})[0], 400)
check("with a reason the legal name changes", api(H, "POST", "/host/clients/" + client2, {"legalName": "Second Client Holdings Inc", "changeReason": "Name changed per Secretary of State filing"})[0], 200)
check("legal name and EIN cannot be cleared", (api(H, "POST", "/host/clients/" + client2, {"ein": ""})[0], api(H, "POST", "/host/clients/" + client2, {"legalName": ""})[0]), (400, 400))
chist = api(H, "GET", "/host/clients/" + client2 + "/history")[1]["history"]
check("client history records who, why and from/to", (chist[0]["reason"][:12], chist[0]["changes"]["legalName"][0], chist[0]["by"] != ""), ("Name changed", "Second Client Inc", True))
check("Account Owner cannot read client history", api(O, "GET", "/owner/clients/" + client2 + "/history")[0], 403)
check("billing address differs: needs street and city", api(H, "POST", "/host/clients/" + client2, {"billingSame": False, "bAddress": "", "bCity": ""})[0], 400)
check("billing address saved when it differs", (api(H, "POST", "/host/clients/" + client2, {"billingSame": False, "bAddress": "PO Box 5", "bCity": "Dallas", "bState": "tx", "bZip": "75201"})[0], [c for c in api(H, "GET", "/host/clients")[1]["clients"] if c["id"] == client2][0]["bState"]), (200, "TX"))
check("same-as-business clears the separate billing address", (api(H, "POST", "/host/clients/" + client2, {"billingSame": True})[0], [c for c in api(H, "GET", "/host/clients")[1]["clients"] if c["id"] == client2][0]["bAddress"]), (200, ""))
ctc = [{"role": "relations", "name": "Pat Owner", "title": "Owner", "email": "pat@example.com", "phone": "817-555-0100"}, {"role": "billing", "name": "Bill Ing", "email": "billing@example.com"}]
check("contacts saved with roles", (api(H, "POST", "/host/clients/" + client2, {"contacts": ctc})[0], [c["role"] for c in [c for c in api(H, "GET", "/host/clients")[1]["clients"] if c["id"] == client2][0]["contacts"]]), (200, ["relations", "billing"]))
check("contact role, name and email are checked", [api(H, "POST", "/host/clients/" + client2, {"contacts": [dict(ctc[0], **k)]})[0] for k in ({"role": "boss"}, {"name": ""}, {"email": "nope"})], [400, 400, 400])
check("a pharmacy needs its client, entity name, type and EIN", [api(H, "POST", "/host/stores", {"id": "EE1", "name": "x", **{k: v for k, v in ENT.items() if k != drop}})[0] for drop in ("clientId", "entityLegalName", "entityType", "ein")], [400] * 4)
check("a pharmacy cannot point at a client that does not exist", api(H, "POST", "/host/stores", {"id": "EE2", "name": "x", **ENT, "clientId": "IL-999999"})[0], 400)
check("pharmacy EIN is checked", api(H, "POST", "/host/stores", {"id": "EE3", "name": "x", **ENT, "ein": "123"})[0], 400)
check("an existing pharmacy without an EIN can still be saved, and EIN filled with no reason", (st({"phone": "(817) 555-0100"})[0], st({"clientId": client1, "entityLegalName": "NorTex Haslet LLC", "entityType": "llc", "ein": "987654321"})[0], getS()["ein"]), (200, 200, "98-7654321"))
check("pharmacy EIN cannot be cleared", st({"ein": ""})[0], 400)
stn = lambda body: api(H, "POST", "/host/stores/NTX1", body)                # no reason given
check("changing the pharmacy EIN, entity or client needs a reason", (stn({"ein": "11-2223334"})[0], stn({"entityLegalName": "Other LLC"})[0], stn({"clientId": client2})[0]), (400, 400, 400))
check("with a reason the pharmacy moves to another client", stn({"clientId": client2, "changeReason": "Pharmacy sold to the second client"})[0], 200)
stn({"clientId": client1, "changeReason": "Reverting the test change"})
check("Account Owner sees only the masked EIN", [(x["ein"], x["einMasked"]) for x in api(O, "GET", "/owner/stores")[1]["stores"] if x["id"] == "NTX1"][0], ("", "••-•••4321"))
check("staff see only the masked EIN in /me", [(x["ein"], x["einMasked"]) for x in api(U, "GET", "/me")[1]["stores"] if x["id"] == "NTX1"][0], ("", "••-•••4321"))
check("host sees the full EIN", getS()["ein"], "98-7654321")
check("Account Owner cannot edit EIN, entity or client", [stO({k: v})[0] for k, v in (("ein", "11-2223334"), ("entityLegalName", "x"), ("clientId", client2))], [403, 403, 403])
check("the pharmacy list shows no per-pharmacy account number any more", "acctNo" in getS(), False)
check("clients list shows each client's pharmacies", sorted([p for c in api(H, "GET", "/host/clients")[1]["clients"] if c["id"] == client1 for p in c["pharmacies"]])[:1], ["NTX1"])
check("host turns the Calendar switch on", (st({"calendar": True})[0], getS()["calendar"]), (200, True))
check("host creates a new pharmacy with its whole profile", api(H, "POST", "/host/stores", {**ENT, "id": "tst2", "name": "Test Two", "city": "Haslet", "state": "TX", "zip": "76052", "npi": "1234567893", "dea": "AB1234563",
      "ncpdp": "1234567", "license": "A1", "services": ["retail", "delivery"], "calendar": False, "hours": good_hours})[0], 200)
t2 = [x for x in api(H, "GET", "/host/stores")[1]["stores"] if x["id"] == "TST2"]
check("new pharmacy saved with its fields", (len(t2), t2 and t2[0]["services"], t2 and t2[0]["npi"]), (1, ["retail", "delivery"], "1234567893"))
check("new pharmacy ID already used is refused", api(H, "POST", "/host/stores", {**ENT, "id": "TST2", "name": "Again"})[0], 400)
check("new pharmacy ID must be valid", api(H, "POST", "/host/stores", {**ENT, "id": "x", "name": "Bad"})[0], 400)
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
check("a person who has not signed in yet is still active (ID is live): rep can change a privilege", api(RT, "POST", "/host/users/" + sub2, {"perms": {"archive": False}})[0], 200)
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
check("rep cannot touch the Account Owner", (api(RT, "POST", "/host/users/" + ownersub, {"perms": {"remove": False}})[0], api(RT, "POST", "/host/users/" + ownersub + "/reset-password", {})[0]), (403, 403))
check("rep cannot import", api(RT, "POST", "/host/import/NTX1", {"archive": []})[0], 403)
api(H, "POST", "/host/users/" + sub, {"disabled": True})
check("rep cannot change a user who is switched off", api(RT, "POST", "/host/users/" + sub, {"acctType": "tech"})[0], 403)
check("rep cannot delete a user", api(RT, "POST", "/host/users/" + sub + "/delete", {})[0], 403)
api(H, "POST", "/host/users/" + sub, {"disabled": False})
check("rep cannot turn on services", api(RT, "POST", "/host/stores/NTX1", {"services": ["retail", "sterile"]})[0], 403)
check("rep cannot turn on the Calendar", api(RT, "POST", "/host/stores/NTX1", {"calendar": False})[0], 403)
check("rep cannot edit pharmacy details yet", api(RT, "POST", "/host/stores/NTX1", {"phone": "1"})[0], 403)
check("rep cannot create a pharmacy", api(RT, "POST", "/host/stores", {"id": "RR1", "name": "x"})[0], 403)
check("a rep can read clients but not create or change them", (api(RT, "GET", "/host/clients")[0], api(RT, "POST", "/host/clients", CL())[0], api(RT, "POST", "/host/clients/" + client1, {"dba": "x"})[0]), (200, 403, 403))
check("rep cannot use the registry lookup", api(RT, "GET", "/host/npi/1234567893")[0], 403)
check("services were not changed by the rep", getS()["services"], ["retail", "controlled", "sterile"])
# ---- rep drafts: a rep proposes, a supervisor approves; nothing is applied before that
repsub = [u for u in api(H, "GET", "/host/users")[1]["users"] if u["login"] == "rep1"][0]["sub"]
check("people list shows the rep role", [u for u in api(H, "GET", "/host/users")[1]["users"] if u["login"] == "rep1"][0]["hostRole"], "rep")
check("/me tells a host login its role", (api(RT, "GET", "/me")[1]["hostRole"], api(H, "GET", "/me")[1]["hostRole"]), ("rep", "supervisor"))
dr = lambda store, fields, note="Client moved suites; letter attached": api(RT, "POST", "/host/stores/%s/drafts" % store, {"fields": fields, "note": note})
check("rep cannot draft for a pharmacy not assigned to them", dr("NTX1", {"city": "Keller"})[0], 403)
check("rep cannot assign themselves", api(RT, "POST", "/host/users/" + repsub, {"repStores": {"NTX1": True}})[0], 403)
check("supervisor assigns the rep to NTX1", api(H, "POST", "/host/users/" + repsub, {"repStores": {"NTX1": True}})[0], 200)
check("only reps have assigned pharmacies", api(H, "POST", "/host/users/" + sub, {"repStores": {"NTX1": True}})[0], 400)
check("rep draft needs a reason", dr("NTX1", {"city": "Keller"}, "short")[0], 400)
check("rep draft cannot touch services, Calendar or DEA check", [dr("NTX1", f)[0] for f in ({"services": ["retail"]}, {"calendar": True}, {"deaVerified": True}, {"servicesOther": "x"})], [400, 400, 400, 400])
check("draft is validated like a direct edit", dr("NTX1", {"zip": "123"})[0], 400)
check("rep draft for another pharmacy is refused", dr("TST3", {"city": "Keller"})[0], 403)
cityBefore = getS().get("city")
r = dr("NTX1", {"city": "Keller", "address": "5 Draft St"}); check("rep submits a draft", r[0], 200)
check("nothing applied before approval", getS().get("city"), cityBefore)
check("rep sees only their own drafts", [d["status"] for d in api(RT, "GET", "/host/drafts")[1]["drafts"]], ["pending"])
pd = api(H, "GET", "/host/drafts")[1]["drafts"]
check("supervisor sees it with from/to", (len(pd), pd[0]["store"], pd[0]["changes"]["city"][1], pd[0]["by"]), (1, "NTX1", "Keller", "Rep One"))
did = pd[0]["id"]
check("a rep cannot approve or reject", (api(RT, "POST", "/host/drafts/NTX1/%s/approve" % did, {})[0], api(RT, "POST", "/host/drafts/NTX1/%s/reject" % did, {"note": "no way"})[0]), (403, 403))
check("reject needs a reason", api(H, "POST", "/host/drafts/NTX1/%s/reject" % did, {})[0], 400)
check("supervisor approves", api(H, "POST", "/host/drafts/NTX1/%s/approve" % did, {})[0], 200)
check("approved draft is applied", (getS()["city"], getS()["address"]), ("Keller", "5 Draft St"))
check("it cannot be decided twice", api(H, "POST", "/host/drafts/NTX1/%s/approve" % did, {})[0], 400)
h0 = api(H, "GET", "/host/stores/NTX1/history")[1]["history"][0]
check("history keeps the rep's reason and both names", ("Client moved suites" in h0["reason"], "Rep One" in h0["reason"], "Neo" in h0["by"] or "Thomas" in h0["by"] or h0["by"] != ""), (True, True, True))
r2 = dr("NTX1", {"city": "Haslet"}); d2 = [d for d in api(H, "GET", "/host/drafts")[1]["drafts"] if d["status"] == "pending"][0]["id"]
check("supervisor rejects with a reason", api(H, "POST", "/host/drafts/NTX1/%s/reject" % d2, {"note": "Does not match the license"})[0], 200)
check("rejected draft changes nothing", getS().get("city"), "Keller")
check("rep sees the decision", [(d["status"], d["decisionNote"]) for d in api(RT, "GET", "/host/drafts")[1]["drafts"]][0], ("rejected", "Does not match the license"))
check("Account Owner and staff cannot see drafts", (api(O, "GET", "/owner/drafts")[0], api(U, "GET", "/owner/drafts")[0]), (403, 403))
print("\nFAILED:", fails if fails else "none"); sys.exit(1 if fails else 0)

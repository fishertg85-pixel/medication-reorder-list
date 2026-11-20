# Owners and roles: pharmacy and client Account Owners, scoping, PIC, super user, client page + invoices, Rx and calendar rules, state licenses, NPI/NCPDP digits.
# Run ./reset.sh first (no SUITE_USERS).
import json, subprocess, urllib.request, urllib.error, boto3, sys
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
    return r["AuthenticationResult"]["IdToken"], r["AuthenticationResult"]["AccessToken"]
def api(tok, method, path, body=None):
    req = urllib.request.Request("http://localhost:8790/api" + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Authorization": "Bearer " + tok, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
def node(arg): return json.loads(subprocess.check_output(["node", "boot.mjs", json.dumps(arg)]).decode().strip().splitlines()[-1])
c.admin_set_user_mfa_preference(Username="owner", UserPoolId=ids["pool"], SMSMfaSettings={"Enabled": False, "PreferredMfa": False})
O, OA = login("owner", "temp12345a", "ownerpass99")
node({"makeHost": {"login": "Neo", "name": "Thomas Fisher", "phone": "8175559999", "tempPassword": "hosttemp12a"}})
H, HA = login("neo", "hosttemp12a", "hostpass999"); api(H, "POST", "/host-unlock", {"password": "hostpass999", "accessToken": HA})
CL = dict(legalName="IronLedger Compliance LLC", entityType="llc", ein="12-3456789", address="100 Main St", city="Haslet", state="TX", zip="76052")
r = api(H, "POST", "/host/clients", CL)[1]; C1 = r["id"]
ENT = {"clientId": C1, "entityLegalName": "Lagniappe Pharmacy LLC", "entityType": "llc", "ein": "98-7654321"}
check("add pharmacy under the client", api(H, "POST", "/host/stores", {"id": "LAG1", "name": "Lagniappe Pharmacy", **ENT})[0], 200)
check("migration: the original owner owns NTX1 (no client) and not LAG1", (lambda m: ({s["id"]: s["owner"] for s in m["stores"]}, m["owner"]))(api(O, "GET", "/me")[1]), ({"NTX1": True}, True))

# ---- NPI / NCPDP / state licenses
chk = lambda b: api(H, "POST", "/host/stores/LAG1", b)
s, e = chk({"npi": "123456789"}); check("NPI: 9 digits refused with the length message", (s, e.get("error")), (400, "NPI must be exactly 10 digits."))
s, e = chk({"npi": "1234567890"}); check("NPI: bad check digit says so", (s, e.get("error")), (400, "That NPI’s check digit doesn’t match. Re-check the number."))
check("NPI: valid 10 digits saved", chk({"npi": "1234567893"})[0], 200)
s, e = chk({"ncpdp": "123456"}); check("NCPDP: 6 digits refused", (s, e.get("error")), (400, "NCPDP ID must be exactly 7 digits."))
check("NCPDP: 7 digits saved", chk({"ncpdp": "1234567"})[0], 200)
check("licenses: several states saved", chk({"licenses": [{"state": "LA", "number": "PH123", "expires": "2027-06-30", "type": "resident"}, {"state": "TX", "number": "TX999", "expires": "2027-01-31", "type": "nonresident"}]})[0], 200)
st = {x["id"]: x for x in api(H, "GET", "/host/stores")[1]["stores"]}["LAG1"]
check("licenses list returned, resident mirrored to license", ([(l["state"], l["type"]) for l in st["licenses"]], st["license"]), ([("LA", "resident"), ("TX", "nonresident")], "PH123"))
check("licenses: the same state twice refused", chk({"licenses": [{"state": "LA", "number": "A1", "type": "resident"}, {"state": "LA", "number": "A2", "type": "nonresident"}]})[0], 400)
check("changing a license number needs a reason", chk({"licenses": [{"state": "LA", "number": "PH124", "expires": "2027-06-30", "type": "resident"}]})[0], 400)

# ---- owners: create a new login as the pharmacy's Account Owner; the owner is NOT the PIC
r = api(H, "POST", "/host/stores/LAG1/owner", {"owner": {"create": {"login": "lagown", "name": "Lena Owner", "phone": "(817) 555-0111", "smsConsent": True}}})
check("host creates the pharmacy owner (new login)", (r[0], bool(r[1].get("tempPassword"))), (200, True))
LO, LOA = login("lagown", r[1]["tempPassword"], "lagpass12345")
c.admin_set_user_mfa_preference(Username="lagown", UserPoolId=ids["pool"], SMSMfaSettings={"Enabled": False, "PreferredMfa": False})
me = api(LO, "GET", "/me")[1]
check("owner sees only their pharmacy, as owner", ({s["id"]: s["owner"] for s in me["stores"]}, me["owner"], me["clientOwner"]), ({"LAG1": True}, True, False))
check("owner has no pharmacist functions until IronLedger says the owner is the PIC (not recorded yet: counts, old rule)", {s["id"]: s["pharm"] for s in me["stores"]}["LAG1"], True)
api(LO, "POST", "/owner-unlock", {"password": "lagpass12345", "accessToken": LOA})
check("an owner can't name an owner", api(LO, "POST", "/owner/stores/LAG1/owner", {"owner": {"login": "owner"}})[0], 403)
check("owner list of pharmacies is scoped", [s["id"] for s in api(LO, "GET", "/owner/stores")[1]["stores"]], ["LAG1"])
check("owner cannot edit another pharmacy", api(LO, "POST", "/owner/stores/NTX1", {"phone": "8175550000"})[0], 403)
check("owner can edit own pharmacy phone", api(LO, "POST", "/owner/stores/LAG1", {"phone": "8175550000"})[0], 200)
check("owner can't import into another pharmacy", api(LO, "POST", "/owner/import/NTX1", {})[0], 403)
check("owner can't open another pharmacy's lines", api(LO, "GET", "/stores/NTX1/lines")[0], 403)
users = api(LO, "GET", "/owner/users")[1]["users"]
check("owner's people list excludes the other pharmacy's owner", sorted(u["login"] for u in users), ["lagown"])

# ---- PIC: yes/no, host only, licensed pharmacist
r = api(H, "POST", "/host/users", {"login": "rph1", "name": "Rae Pharmacist", "phone": "(817) 555-0122", "smsConsent": True, "stores": {"LAG1": True}, "perms": {"calendar": True}, "acctType": "pharmacist", "initials": "RP", "license": "RPH-1"})
check("host adds a staff pharmacist", r[0], 200); RP, RPA = login("rph1", r[1]["tempPassword"], "rphpass12345")
r = api(H, "POST", "/host/users", {"login": "tech1", "name": "Tia Tech", "phone": "(817) 555-0133", "smsConsent": True, "stores": {"LAG1": True}, "perms": {"calendar": True}, "acctType": "tech", "initials": "TT"})
TT, TTA = login("tech1", r[1]["tempPassword"], "techpass12345")
r = api(H, "POST", "/host/users", {"login": "assoc1", "name": "Al Associate", "phone": "(817) 555-0144", "smsConsent": True, "stores": {"LAG1": True}, "perms": {"calendar": True}, "acctType": "staff", "initials": "AA"})
AS, ASA = login("assoc1", r[1]["tempPassword"], "asspass12345")
check("PIC: owner-is-PIC needs an RPh license on the owner's login", api(H, "POST", "/host/stores/LAG1/pic", {"ownerIsPic": True})[0], 400)
check("PIC: answer must be yes/no", api(H, "POST", "/host/stores/LAG1/pic", {"ownerIsPic": "maybe"})[0], 400)
check("PIC: not the owner -> pick a pharmacist who works there", api(H, "POST", "/host/stores/LAG1/pic", {"ownerIsPic": False, "picLogin": "tech1"})[0], 400)
check("PIC: staff pharmacist recorded", api(H, "POST", "/host/stores/LAG1/pic", {"ownerIsPic": False, "picLogin": "rph1"})[0], 200)
check("PIC: a change needs a reason", api(H, "POST", "/host/stores/LAG1/pic", {"ownerIsPic": False, "picLogin": "rph1"})[0], 400)
check("PIC: owner cannot change it", api(LO, "POST", "/owner/stores/LAG1/pic", {"ownerIsPic": True})[0], 403)
meo = api(LO, "GET", "/me")[1]; lag = [s for s in meo["stores"] if s["id"] == "LAG1"][0]
check("owner not PIC: no pharmacist functions, no Rx tab", (lag["pharm"], lag["rx"]), (False, False))
check("owner not PIC: Rx Intake refused", api(LO, "GET", "/stores/LAG1/rx/config")[0], 403)
check("staff pharmacist: Rx Intake allowed (Rx switch on by default)", api(RP, "GET", "/stores/LAG1/rx/config")[0], 200)
check("technician: Rx Intake refused", api(TT, "GET", "/stores/LAG1/rx/config")[0], 403)
check("associate: Rx Intake refused", api(AS, "GET", "/stores/LAG1/rx/config")[0], 403)
check("Rx switch off blocks even the pharmacist", (api(H, "POST", "/host/stores/LAG1", {"rx": False})[0], api(RP, "GET", "/stores/LAG1/rx/config")[0]), (200, 403))
api(H, "POST", "/host/stores/LAG1", {"rx": True})
check("reorder switch off blocks the list", (api(H, "POST", "/host/stores/LAG1", {"reorder": False})[0], api(RP, "GET", "/stores/LAG1/lines")[0]), (200, 403))
api(H, "POST", "/host/stores/LAG1", {"reorder": True})
check("owner is the PIC: give the owner a license, then yes", (api(H, "POST", "/host/users/" + [u for u in api(H, "GET", "/host/users")[1]["users"] if u["login"] == "lagown"][0]["sub"], {"license": "RPH-9"})[0], api(H, "POST", "/host/stores/LAG1/pic", {"ownerIsPic": True, "reason": "Owner took over as PIC at licensure"})[0]), (200, 200))
check("owner is PIC: pharmacist functions and Rx now allowed", (api(LO, "GET", "/stores/LAG1/rx/config")[0]), 200)
api(H, "POST", "/host/stores/LAG1/pic", {"ownerIsPic": False, "picLogin": "rph1", "reason": "Back to the staff pharmacist as PIC"})

# ---- calendar completion by role
api(H, "POST", "/host/stores/LAG1", {"calendar": True})
check("owner starts the calendar", api(LO, "POST", "/stores/LAG1/calendar/commit", {"config": {"v": 1, "profile": {"name": "Lagniappe"}}})[0], 200)
rec = lambda i, ob: {"put": {"records": [{"id": i, "track": ob + "|fac", "status": "done"}]}}
cm = lambda tok, i, ob: api(tok, "POST", "/stores/LAG1/calendar/commit", rec(i, ob))[0]
check("non-clinical owner: PIC task refused", cm(LO, "r1", "dea-biennial"), 403)
check("non-clinical owner: Designated Person task (EM) refused", cm(LO, "r2", "u797-air"), 403)
check("non-clinical owner: Owner task allowed", cm(LO, "r3", "dea-reg"), 200)
check("pharmacist: PIC task allowed", cm(RP, "r4", "dea-biennial"), 200)
check("technician (no duty): EM task refused", cm(TT, "r5", "u797-air"), 403)
check("associate: built-in task refused", cm(AS, "r6", "hipaa-training"), 403)
check("associate: custom task allowed", cm(AS, "r7", "custom-1"), 200)
check("everyone with the calendar sees the whole calendar", [api(t, "GET", "/stores/LAG1/calendar")[0] for t in (LO, RP, TT, AS)], [200] * 4)
check("host gives the tech the compliance-technician duty", api(H, "POST", "/host/users/" + [u for u in api(H, "GET", "/host/users")[1]["users"] if u["login"] == "tech1"][0]["sub"], {"docDuty": "ctech"})[0], 200)
check("compliance technician: EM task allowed", cm(TT, "r8", "u797-air"), 200)

# ---- super user (administrator) for the PIC
rsub = [u for u in api(H, "GET", "/host/users")[1]["users"] if u["login"] == "rph1"][0]["sub"]
check("owner makes the PIC an administrator", api(LO, "POST", "/owner/users/" + rsub, {"adminStores": {"LAG1": True}})[0], 200)
check("a technician can't be an administrator", api(LO, "POST", "/owner/users/" + [u for u in api(H, "GET", "/host/users")[1]["users"] if u["login"] == "tech1"][0]["sub"], {"adminStores": {"LAG1": True}})[0], 400)
api(RP, "POST", "/owner-unlock", {"password": "rphpass12345", "accessToken": RPA})
check("administrator reaches the owner tab, scoped", [s["id"] for s in api(RP, "GET", "/owner/stores")[1]["stores"]], ["LAG1"])
check("administrator can't hand out administrator privileges", api(RP, "POST", "/owner/users/" + [u for u in api(H, "GET", "/host/users")[1]["users"] if u["login"] == "tech1"][0]["sub"], {"adminStores": {"LAG1": True}})[0], 403)
check("administrator can't reset the owner's password", api(RP, "POST", "/owner/users/" + [u for u in api(H, "GET", "/host/users")[1]["users"] if u["login"] == "lagown"][0]["sub"] + "/reset-password", {})[0], 403)
check("administrator can't open the client page", api(RP, "GET", "/client/" + C1)[0], 403)
check("the owner can't be deleted", api(H, "POST", "/host/users/" + [u for u in api(H, "GET", "/host/users")[1]["users"] if u["login"] == "lagown"][0]["sub"] + "/delete", {})[0], 400)

# ---- client Account Owner (same person as the pharmacy owner: one login, extra button) + the client page
r = api(H, "POST", f"/host/clients/{C1}/owner", {"owner": {"login": "lagown"}})
check("host makes the same login the client's Account Owner", r[0], 200)
me = api(LO, "GET", "/me")[1]
check("one login: pharmacy owner and client owner", (me["owner"], me["clientOwner"], [x["id"] for x in me["clients"]]), (True, True, [C1]))
api(LO, "POST", "/owner-lock", {})
check("client page is locked until the password is entered again", api(LO, "GET", f"/client/{C1}")[0], 423)
LO2, LOA2 = login("lagown", "lagpass12345", "lagpass12345")
check("unlock with the password", api(LO2, "POST", "/owner-unlock", {"password": "lagpass12345", "accessToken": LOA2})[0], 200)
check("wrong password does not unlock", api(LO2, "POST", "/owner-unlock", {"password": "nope-nope-1", "accessToken": LOA2})[0], 400)
pg = api(LO2, "GET", f"/client/{C1}")[1]
check("client page: setup info + pharmacies (billing and people open per pharmacy)", (pg["client"]["legalName"], [p["id"] for p in pg["pharmacies"]], "billing" in pg), ("IronLedger Compliance LLC", ["LAG1"], False))
check("other logins can't open a client page", [api(t, "GET", f"/client/{C1}")[0] for t in (RP, TT, AS)], [403] * 3)
today = api(H, "GET", "/host/stores/LAG1/billing")[1]["today"]
check("host adds an invoice (current)", api(H, "POST", f"/host/stores/LAG1/invoices", {"issued": today, "due": "2099-01-01", "amount": "149.00", "description": "Compliance Calendar"})[0], 200)
check("host adds an overdue invoice", api(H, "POST", f"/host/stores/LAG1/invoices", {"issued": "2026-01-05", "due": "2026-01-20", "amount": "$99.50", "description": "Old"})[0], 200)
check("bad amount refused", api(H, "POST", f"/host/stores/LAG1/invoices", {"issued": today, "due": today, "amount": "abc"})[0], 400)
b = api(LO2, "GET", "/billing/LAG1")[1]
check("summary: new this month, unpaid, delinquent", (b["summary"]["newThisMonth"], b["summary"]["unpaid"], b["summary"]["delinquent"]), ({"count": 1, "cents": 14900}, {"count": 1, "cents": 14900}, {"count": 1, "cents": 9950}))
inv = [i for i in b["invoices"] if i["delinquent"]][0]["id"]
check("host marks it paid", api(H, "POST", f"/host/stores/LAG1/invoices/{inv}", {"status": "paid", "paidOn": today})[0], 200)
b = api(LO2, "GET", "/billing/LAG1")[1]
check("summary after payment", (b["summary"]["paidThisMonth"], b["summary"]["delinquent"]), ({"count": 1, "cents": 9950}, {"count": 0, "cents": 0}))
check("client owner cannot change invoices", (api(LO2, "POST", "/host/stores/LAG1/invoices", {"issued": today, "due": today, "amount": "1"})[0], api(LO2, "POST", "/owner/stores/LAG1/invoices", {"issued": today, "due": today, "amount": "1"})[0]), (404, 403))
check("owner step-up relocks via owner-lock", (api(LO2, "POST", "/owner-lock", {})[0], api(LO2, "GET", f"/client/{C1}")[0]), (200, 423))
check("new client with a new owner login in one go", (lambda r: (r[0], bool(r[1].get("tempPassword"))))(api(H, "POST", "/host/clients", dict(CL, legalName="Second LLC", owner={"create": {"login": "own2", "name": "Two Owner", "phone": "(817) 555-0155", "smsConsent": True}}))), (200, True))
check("the first owner isn't a client owner for the second client", len(api(LO, "GET", "/me")[1]["clients"]), 1)
print("\n" + ("all passed" if not fails else "FAILED: " + str(fails)))

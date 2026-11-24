# Sub-roles, DP boxes, tier rule, approval chain, delegation and time off (run ./reset.sh first).
import json, subprocess, urllib.request, boto3, datetime, zoneinfo
ids = json.load(open('moto_ids.json'))
c = boto3.client("cognito-idp", endpoint_url="http://localhost:5005", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="x")
fails = []
def check(name, got, want):
    ok = got == want
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  got {got!r} want {want!r}'))
    if not ok: fails.append(name)
def login(u, pw, newpw):
    r = c.initiate_auth(ClientId=ids["client"], AuthFlow="USER_PASSWORD_AUTH", AuthParameters={"USERNAME": u, "PASSWORD": pw})
    if r.get("ChallengeName") == "NEW_PASSWORD_REQUIRED":
        r = c.respond_to_auth_challenge(ClientId=ids["client"], ChallengeName="NEW_PASSWORD_REQUIRED", Session=r["Session"], ChallengeResponses={"USERNAME": u, "NEW_PASSWORD": newpw})
    return r["AuthenticationResult"]["IdToken"], r["AuthenticationResult"]["AccessToken"]
def api(tok, method, path, body=None):
    req = urllib.request.Request("http://localhost:8790/api" + path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + tok, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
def node(arg): return json.loads(subprocess.check_output(["node", "boot.mjs", json.dumps(arg)]).decode().strip().splitlines()[-1])
O, OA = login("owner", "temp12345a", "ownerpass99")
api(O, "POST", "/owner-unlock", {"password": "ownerpass99", "accessToken": OA})
node({"makeHost": {"login": "Neo", "name": "Thomas Fisher", "phone": "8175559999", "tempPassword": "hosttemp12a"}})
H, HA = login("neo", "hosttemp12a", "hostpass999"); api(H, "POST", "/host-unlock", {"password": "hostpass999", "accessToken": HA})
check("calendar on for NTX1", api(H, "POST", "/host/stores/NTX1", {"calendar": True})[0], 200)
def mk(login_id, **kw):
    s, r = api(O, "POST", "/owner/users", {"login": login_id, "name": login_id.upper(), "phone": "(817) 555-%04d" % (abs(hash(login_id)) % 10000), "smsConsent": True, "stores": {"NTX1": True}, **kw})
    assert s == 200, (login_id, s, r)
    t, a = login(login_id, r["tempPassword"], login_id + "pass12345")
    return r["user"]["sub"], t, a
def unlock(t, a, pw): api(t, "POST", "/owner-unlock", {"password": pw, "accessToken": a})
picS, PIC, PICA = mk("picu", acctType="pic", license="RPH100")
rphS, RPH, RPHA = mk("rphu", acctType="pharmacist", license="RPH200")
rph2S, RPH2, _ = mk("rphv", acctType="pharmacist", license="RPH201")
tchS, TCH, TCHA = mk("tchu", acctType="tech")
tch2S, TCH2, TCH2A = mk("tchv", acctType="tech")
ascS, ASC, _ = mk("ascu", acctType="staff", subs=["cashier"])
U = lambda: {u["login"]: u for u in api(O, "GET", "/owner/users")[1]["users"]}
upd = lambda tok, sub, b: api(tok, "POST", "/owner/users/" + sub, b)


upd(O, picS, {"initials": "PC"}) if False else None
cal = "/stores/NTX1/calendar"
api(O, "POST", "/owner/users/" + tch2S, {"dp": {"797": True}})
for t, a, pw in ((PIC, PICA, "picupass12345"), (RPH, RPHA, "rphupass12345"), (TCH, TCHA, "tchupass12345"), (TCH2, TCH2A, "tchvpass12345")): unlock(t, a, pw)
check("start the calendar", api(O, "POST", cal + "/commit", {"config": {"profile": {"name": "NorTex"}}})[0], 200)
TR = "u797-air|room1"
rec = lambda i, **kw: {"id": i, "track": TR, "forDue": "2026-11-0" + i[-1], "status": "done", "completedBy": "TCHU", "completedOn": "2026-11-23", "result": "pass", "review": {"status": "pending"}, **kw}
G = lambda tok=None: {r["id"]: r for r in api(tok or O, "GET", cal)[1]["records"]}
def approve(i):
    api(TCH, "POST", cal + "/commit", {"put": {"records": [rec(i)]}})
    g = G()[i]; api(TCH2, "POST", cal + "/commit", {"put": {"records": [{**g, "review": {"status": "pending"}}]}})
    g = G()[i]; return api(PIC, "POST", cal + "/commit", {"put": {"records": [{**g, "review": {"status": "accepted"}}]}})
check("r1 approved through the chain", (approve("r1")[0], G()["r1"]["review"]["status"]), (200, "accepted"))
# locks
g = G()["r1"]
check("an approved record can't be edited", api(TCH, "POST", cal + "/commit", {"put": {"records": [{**g, "result": "fail"}]}})[0], 403)
check("an unchanged re-save is fine", api(TCH, "POST", cal + "/commit", {"put": {"records": [g]}})[0], 200)
check("records are never deleted", (api(O, "POST", cal + "/commit", {"del": {"records": ["r1"]}})[0], "r1" in G()), (403, True))
check("a void can't be written through commit", api(PIC, "POST", cal + "/commit", {"put": {"records": [rec("r9", status="void")]}})[0], 403)
# reopen
R = cal + "/records/r1/"
check("a pharmacist who is not an approver can't reopen", api(RPH, "POST", R + "reopen", {"reason": "wrong hood"})[0], 403)
check("a technician can't reopen", api(TCH, "POST", R + "reopen", {"reason": "wrong hood"})[0], 403)
check("reopen needs initials set", (lambda r: (r[0], "initials" in r[1]["error"]))(api(PIC, "POST", R + "reopen", {"reason": "wrong hood"})), (400, True))
assert api(O, "POST", "/owner/users/" + picS, {"initials": "PC"})[0] == 200
check("reopen needs a reason", api(PIC, "POST", R + "reopen", {"reason": "x"})[0], 400)
check("the approver reopens with a reason", api(PIC, "POST", R + "reopen", {"reason": "Wrong hood recorded"})[0], 200)
g = G()["r1"]; rv = g["review"]
check("reopened: status Pending, reason, version kept, initials stamped", (rv["status"], rv["reopens"][0]["reason"], len(g["versions"]), g["versions"][0]["review"]["status"], rv["reopens"][0]["sign"]["ini"]), ("pending", "Wrong hood recorded", 1, "accepted", "PC"))
check("a reopened record can't be reopened again until reapproved", api(PIC, "POST", R + "reopen", {"reason": "again please"})[0], 400)
check("the technician corrects it", api(TCH, "POST", cal + "/commit", {"put": {"records": [{**g, "result": "pass, hood B"}]}})[0], 200)
g = G()["r1"]
check("correction kept the reopen history", (g["result"], len(g["review"]["reopens"]), len(g["versions"])), ("pass, hood B", 1, 1))
check("the same PIC reapproves; marked as the same person", (api(PIC, "POST", cal + "/commit", {"put": {"records": [{**g, "review": {"status": "accepted"}}]}})[0], G()["r1"]["review"]["reopens"][0]["reapproved"]["same"]), (200, True))
check("approved again, locked again", api(TCH, "POST", cal + "/commit", {"put": {"records": [{**G()["r1"], "result": "x"}]}})[0], 403)
# hard void
check("r2 approved", approve("r2")[0], 200)
V = cal + "/records/r2/"
check("void: pharmacist without approver can't", api(RPH, "POST", V + "void", {"type": "nottask", "note": "no task done"})[0], 403)
check("void: reason type required", api(PIC, "POST", V + "void", {"note": "no task done"})[0], 400)
check("void: note required", api(PIC, "POST", V + "void", {"type": "nottask", "note": ""})[0], 400)
check("void: duplicate must point to an existing original", api(PIC, "POST", V + "void", {"type": "duplicate", "note": "same as r1", "origId": "nope"})[0], 400)
check("void: duplicate can't point to itself", api(PIC, "POST", V + "void", {"type": "duplicate", "note": "same", "origId": "r2"})[0], 400)
# excursions and missed entries
E = lambda **kw: {"id": "x1", "kind": "excursion", "date": "2026-11-23", "what": "Refrigerator 2", "type": "temperature", "detail": "9.1 C for 3 h", "handling": "Product quarantined", **kw}
check("excursion needs how it was handled", api(TCH, "POST", cal + "/commit", {"put": {"exc": [E(handling="")]}})[0], 400)
check("a technician reports an excursion", api(TCH, "POST", cal + "/commit", {"put": {"exc": [E(refId="r2")]}})[0], 200)
check("the server stamps who reported it, status open", (lambda x: (x["status"], x["createdBy"]))(api(O, "GET", cal)[1]["exc"][0]), ("open", "TCHU"))
check("missed entry needs the task and the due date", (api(TCH, "POST", cal + "/commit", {"put": {"exc": [{"id": "m1", "kind": "missed", "date": "2026-11-23", "what": "Surface sampling", "handling": "Done next day"}]}})[0]), 400)
check("a missed entry is recorded", api(TCH, "POST", cal + "/commit", {"put": {"exc": [{"id": "m1", "kind": "missed", "date": "2026-11-23", "what": "Surface sampling", "track": TR, "forDue": "2026-11-20", "handling": "Done next day"}]}})[0], 200)
check("void: a record an excursion refers to can't be voided", api(PIC, "POST", V + "void", {"type": "nottask", "note": "no task done"})[0], 403)
check("a technician can't close an excursion", api(TCH, "POST", cal + "/exc/x1/close", {"reconciliation": "Reviewed temperature log"})[0], 403)
check("closing needs the reconciliation", api(PIC, "POST", cal + "/exc/x1/close", {"reconciliation": ""})[0], 400)
check("the approver closes it", api(PIC, "POST", cal + "/exc/x1/close", {"reconciliation": "Reviewed temperature log; product discarded"})[0], 200)
x = {e["id"]: e for e in api(O, "GET", cal)[1]["exc"]}
check("closed: who, when and the reconciliation kept", (x["x1"]["status"], x["x1"]["closed"]["by"], x["x1"]["closed"]["reconciliation"][:8], x["x1"]["closed"]["sign"]["ini"]), ("closed", "PICU", "Reviewed", "PC"))
check("a closed excursion can't be edited", api(TCH, "POST", cal + "/commit", {"put": {"exc": [{**x["x1"], "handling": "changed"}]}})[0], 403)
check("excursions and missed entries are never deleted", (api(O, "POST", cal + "/commit", {"del": {"exc": ["m1"]}})[0], "m1" in {e["id"]: 1 for e in api(O, "GET", cal)[1]["exc"]}), (403, True))
# void r2 (no longer referenced? still referenced) -> use a third record
check("r3 approved", approve("r3")[0], 200)
V3 = cal + "/records/r3/"
check("void r3 as a duplicate of r1", api(PIC, "POST", V3 + "void", {"type": "duplicate", "note": "Entered twice", "origId": "r1"})[0], 200)
g = G()["r3"]
check("voided: kept with type, note, original, who, initials, version", (g["status"], g["void"]["label"], g["void"]["origId"], g["void"]["by"], g["void"]["sign"]["ini"], len(g["versions"])), ("void", "Duplicate record", "r1", "PICU", "PC", 1))
check("a voided record can't be changed", api(TCH, "POST", cal + "/commit", {"put": {"records": [{**g, "result": "z", "status": "done"}]}})[0], 403)
check("a voided record can't be voided or reopened again", (api(PIC, "POST", V3 + "void", {"type": "nottask", "note": "again"})[0], api(PIC, "POST", V3 + "reopen", {"reason": "again please"})[0]), (400, 400))
check("the log has the actions", sorted({e["action"] for e in api(O, "GET", cal)[1]["log"] if e["action"].startswith(("Record", "Excursion", "Missed"))}), ["Excursion Closed", "Record Reopened", "Record Voided"])
print("FAILED:", fails or "none")

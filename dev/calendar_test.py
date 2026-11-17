# Calendar access rules (run ./reset.sh first). Needs only boto3 + the local stand-in server.
import json, subprocess, urllib.request, boto3, sys
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
O, OA = login("owner", "temp12345a", "ownerpass99")
api(O, "POST", "/owner-unlock", {"password": "ownerpass99", "accessToken": OA})
def node(arg): return json.loads(subprocess.check_output(["node", "boot.mjs", json.dumps(arg)]).decode().strip().splitlines()[-1])
node({"makeHost": {"login": "Neo", "name": "Thomas Fisher", "phone": "8175559999", "tempPassword": "hosttemp12a"}})
H, HA = login("neo", "hosttemp12a", "hostpass999"); api(H, "POST", "/host-unlock", {"password": "hostpass999", "accessToken": HA})
check("add NTX2 (host)", api(H, "POST", "/host/stores", {"id": "NTX2", "name": "Other Pharmacy"})[0], 200)
check("Account Owner cannot switch the calendar on", api(O, "POST", "/owner/stores/NTX1", {"calendar": True})[0], 403)
def mk(login_id, stores, cal):
    s, r = api(O, "POST", "/owner/users", {"login": login_id, "name": login_id.upper(), "phone": "(817) 555-%04d" % (abs(hash(login_id)) % 10000), "smsConsent": True,
        "stores": stores, "perms": {"calendar": cal}})
    assert s == 200, (s, r)
    return login(login_id, r["tempPassword"], login_id + "pass12345")[0]
A = mk("cala", {"NTX1": True, "NTX2": True}, True)     # privilege, both pharmacies
B = mk("calb", {"NTX1": True}, False)                  # no privilege
Cc = mk("calc", {"NTX2": True}, True)                  # privilege, but no NTX1 access
cal = lambda s: "/stores/%s/calendar" % s
check("calendar flag off: owner refused", api(O, "GET", cal("NTX1"))[0], 403)
check("people list shows calendar perm default off", [u for u in api(O, "GET", "/owner/users")[1]["users"] if u["login"] == "calb"][0]["perms"]["calendar"], False)
check("switch NTX1 calendar on", api(H, "POST", "/host/stores/NTX1", {"calendar": True})[0], 200)
check("flag must be boolean", api(H, "POST", "/host/stores/NTX1", {"calendar": "yes"})[0], 400)
stores = {s["id"]: s for s in api(O, "GET", "/owner/stores")[1]["stores"]}
check("NTX1 flag true / NTX2 false", (stores["NTX1"]["calendar"], stores["NTX2"]["calendar"]), (True, False))
me = api(A, "GET", "/me")[1]
check("/me carries privilege and pharmacy flag", (me["perms"]["calendar"], {s["id"]: s["calendar"] for s in me["stores"]}), (True, {"NTX1": True, "NTX2": False}))
check("owner sees empty calendar", api(O, "GET", cal("NTX1"))[1].get("started"), False)
check("privileged non-owner sees not-started", api(A, "GET", cal("NTX1"))[1].get("started"), False)
prof = {"config": {"v": 1, "profile": {"name": "Test Pharmacy"}, "sites": [{"id": "s1", "name": "Test Pharmacy"}]}, "put": {"records": [{"id": "r1", "x": 1}], "log": [{"id": "l1", "ts": "2026-11-16T00:00:00Z"}]}}
check("non-owner cannot start calendar", api(A, "POST", cal("NTX1") + "/commit", prof)[0], 403)
check("owner starts calendar", api(O, "POST", cal("NTX1") + "/commit", prof)[1].get("saved"), 5)
check("privileged person can now save", api(A, "POST", cal("NTX1") + "/commit", {"put": {"records": [{"id": "r2", "x": 2}], "obl": [{"id": "o1", "isCustom": True}]}})[1].get("saved"), 2)
g = api(A, "GET", cal("NTX1"))[1]
check("load returns it all", (g["started"], sorted(r["id"] for r in g["records"]), [o["id"] for o in g["obl"]], g["config"]["profile"]["name"], len(g["log"])), (True, ["r1", "r2"], ["o1"], "Test Pharmacy", 1))
check("no privilege: refused", api(B, "GET", cal("NTX1"))[0], 403)
check("no privilege: save refused", api(B, "POST", cal("NTX1") + "/commit", {"put": {"records": [{"id": "z"}]}})[0], 403)
check("no access to the pharmacy: refused", api(Cc, "GET", cal("NTX1"))[0], 403)
check("flag off at other pharmacy: privileged person refused", api(A, "GET", cal("NTX2"))[0], 403)
check("flag off at other pharmacy: owner refused", api(O, "GET", cal("NTX2"))[0], 403)
check("flag off: save refused", api(A, "POST", cal("NTX2") + "/commit", {"put": {"records": [{"id": "z"}]}})[0], 403)
check("delete a record", api(A, "POST", cal("NTX1") + "/commit", {"del": {"records": ["r2"]}})[1].get("removed"), 1)
check("log is add-only", api(A, "POST", cal("NTX1") + "/commit", {"del": {"log": ["l1"]}})[0], 403)
check("unknown setting refused", api(A, "POST", cal("NTX1") + "/commit", {"config": {"evil": 1}})[0], 400)
check("unknown list refused", api(A, "POST", cal("NTX1") + "/commit", {"put": {"nope": [{"id": "a"}]}})[0], 400)
check("item without id refused", api(A, "POST", cal("NTX1") + "/commit", {"put": {"records": [{"x": 1}]}})[0], 400)
check("too many changes refused", api(A, "POST", cal("NTX1") + "/commit", {"put": {"records": [{"id": "q%d" % i} for i in range(101)]}})[0], 400)
check("oversize item refused", api(A, "POST", cal("NTX1") + "/commit", {"put": {"records": [{"id": "big", "t": "x" * 400000}]}})[0], 400)
check("reorder list still works for the no-privilege user", api(B, "GET", "/stores/NTX1/lines")[0], 200)
check("pharmacies stay separate", api(H, "POST", "/host/stores/NTX2", {"calendar": True})[0], 200)
check("NTX2 starts empty", api(O, "GET", cal("NTX2"))[1].get("started"), False)
check("calc (NTX2 only, privileged) sees NTX2 not-started, not NTX1 data", (api(Cc, "GET", cal("NTX2"))[1].get("started"), api(Cc, "GET", cal("NTX1"))[0]), (False, 403))
print("\nFAILED:", fails if fails else "none"); sys.exit(1 if fails else 0)

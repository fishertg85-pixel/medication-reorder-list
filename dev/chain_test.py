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

# ---- sub-roles, DP boxes, approver, registration expiry
check("sub-role is stored with the person", U()["ascu"]["subs"], ["cashier"])
check("a sub-role from another tier is refused", upd(O, tchS, {"subs": ["cashier"]})[0], 400)
check("a technician sub-role", (upd(O, tchS, {"subs": ["lead", "sterile"]})[0], U()["tchu"]["subs"]), (200, ["lead", "sterile"]))
check("DP boxes: a technician can hold 797", (upd(O, tch2S, {"dp": {"797": True}})[0], U()["tchv"]["dp"]), (200, {"797": True}))
check("DP boxes: unknown chapter refused", upd(O, tchS, {"dp": {"999": True}})[0], 400)
check("DP boxes: staff can't be a Designated Person", upd(O, ascS, {"dp": {"797": True}})[0], 400)
check("registration expiry", (upd(O, tchS, {"licExpires": "2027-03-31"})[0], U()["tchu"]["licExpires"]), (200, "2027-03-31"))
check("registration expiry must be a date", upd(O, tchS, {"licExpires": "next spring"})[0], 400)
check("approver: a technician can't be one", upd(O, tchS, {"approver": True})[0], 400)
check("approver: the Account Owner names a pharmacist", (upd(O, rph2S, {"approver": True})[0], U()["rphv"]["approver"]), (200, True))
check("changing the account type clears sub-roles", (upd(O, tchS, {"acctType": "staff"})[0], U()["tchu"]["subs"]), (200, []))
check("back to technician", upd(O, tchS, {"acctType": "tech"})[0], 200)

# ---- super users and the tier rule
check("owner gives a technician super user", upd(O, tchS, {"adminStores": {"NTX1": True}})[0], 200)
check("owner gives a pharmacist super user", upd(O, rphS, {"adminStores": {"NTX1": True}})[0], 200)
check("owner gives the PIC super user", upd(O, picS, {"adminStores": {"NTX1": True}})[0], 200)
check("a Cashier can't be a super user", upd(O, ascS, {"adminStores": {"NTX1": True}})[0], 400)
unlock(TCH, TCHA, "tchupass12345"); unlock(RPH, RPHA, "rphupass12345"); unlock(PIC, PICA, "picupass12345")
check("technician super user manages technicians", upd(TCH, tch2S, {"subs": ["lead"]})[0], 200)
check("technician super user can't touch a pharmacist", upd(TCH, rph2S, {"subs": ["lead"]})[0], 403)
check("technician super user can't touch the PIC", upd(TCH, picS, {"subs": []})[0], 403)
check("technician super user can't give super user", upd(TCH, tch2S, {"adminStores": {"NTX1": True}})[0], 403)
check("technician super user can't raise someone's type", upd(TCH, tch2S, {"acctType": "pharmacist"})[0], 403)
check("technician super user can't change their own type", upd(TCH, tchS, {"acctType": "pharmacist"})[0], 403)
check("pharmacist super user manages pharmacists and technicians", (upd(RPH, rph2S, {"subs": ["immunizer"]})[0], upd(RPH, tchS, {"subs": ["lead"]})[0]), (200, 200))
check("pharmacist super user can't touch the PIC", upd(RPH, picS, {"subs": []})[0], 403)
check("pharmacist super user can't make another super user", upd(RPH, rph2S, {"adminStores": {"NTX1": True}})[0], 403)
check("pharmacist super user can't make someone the PIC", upd(RPH, tchS, {"acctType": "pic"})[0], 403)
check("PIC gives a pharmacist super user", upd(PIC, rph2S, {"adminStores": {"NTX1": True}})[0], 200)
check("PIC takes it back", upd(PIC, rph2S, {"adminStores": {"NTX1": False}})[0], 200)
check("PIC gives a technician super user", (upd(PIC, tch2S, {"adminStores": {"NTX1": True}})[0], upd(PIC, tch2S, {"adminStores": {"NTX1": False}})[0]), (200, 200))
check("PIC can't give super user to staff", upd(PIC, ascS, {"adminStores": {"NTX1": True}})[0], 403)
check("PIC names an approver", upd(PIC, rph2S, {"approver": True})[0], 200)

# ---- Associates see the calendar and nothing more
cal = "/stores/NTX1/calendar"
prof = {"config": {"v": 1, "profile": {"name": "Test Pharmacy"}, "sites": [{"id": "s1", "name": "Test Pharmacy"}]}}
check("owner starts the calendar", api(O, "POST", cal + "/commit", prof)[0], 200)
g = api(ASC, "GET", cal); check("Associate opens the calendar, view-only flag set", (g[0], g[1]["me"]["viewOnly"]), (200, True))
check("Associate can't save", api(ASC, "POST", cal + "/commit", {"put": {"records": [{"id": "ra1", "track": "x|y", "status": "done"}]}})[0], 403)
check("Associate can't add time off for someone else", api(ASC, "POST", cal + "/timeoff", {"for": tchS, "start": "2099-01-01T08:00", "end": "2099-01-02T08:00"})[0], 403)

# ---- approval chain (USP 797 task: air sampling)
TR = "u797-air|room1"
def rec(i, by, **kw): return {"id": i, "track": TR, "status": "done", "completedBy": by, "completedOn": "2026-11-23", "review": {"status": "pending"}, **kw}
def put(tok, r): return api(tok, "POST", cal + "/commit", {"put": {"records": [r]}})
def get(i):
    return [r for r in api(O, "GET", cal)[1]["records"] if r["id"] == i][0]
upd(O, tch2S, {"dp": {"797": False}})
check("no DP for the chapter: submission goes straight to final approval", (put(TCH, rec("c1", "TCHU"))[0], get("c1")["review"]["status"]), (200, "pending"))
upd(O, tch2S, {"dp": {"797": True}})
check("DP exists: a technician's submission waits for the DP", (put(TCH, rec("c2", "TCHU"))[0], get("c2")["review"]["status"]), (200, "dp"))
check("a non-DP technician can't pass the DP step", put(TCH, {**get("c2"), "review": {"status": "pending"}})[0], 403)
check("the final approver can't accept before the DP without a reason", put(PIC, {**get("c2"), "review": {"status": "accepted"}})[0], 400)
check("the DP passes it", (put(TCH2, {**get("c2"), "review": {"status": "pending"}})[0], get("c2")["review"]["status"], get("c2")["review"]["dp"]["by"]), (200, "pending", "TCHV"))
check("the DP can't give final approval", put(TCH2, {**get("c2"), "review": {"status": "accepted"}})[0], 403)
check("a pharmacist without the approver switch can't give final approval", put(RPH, {**get("c2"), "review": {"status": "accepted"}})[0], 403)
check("the PIC gives final approval (server stamps who)", (put(PIC, {**get("c2"), "review": {"status": "accepted", "by": "Someone Else"}})[0], get("c2")["review"]["status"], get("c2")["review"]["by"], get("c2")["review"]["sameAsDp"]), (200, "accepted", "PICU", False))
check("accepted can't be changed back", (put(TCH, {**get("c2"), "review": {"status": "pending"}})[0], get("c2")["review"]["status"]), (200, "accepted"))
check("the designated approver (pharmacist with the switch) may accept", (put(TCH, rec("c3", "TCHU"))[0], put(TCH2, {**get("c3"), "review": {"status": "pending"}})[0], put(RPH2, {**get("c3"), "review": {"status": "accepted"}})[0]), (200, 200, 200))
check("a return needs a reason", put(TCH2, {**rec("c4", "TCHU"), "review": {"status": "returned"}})[0], 403)         # not yet submitted: nothing to return
put(TCH, rec("c4", "TCHU"))
check("return at the DP step needs a reason", put(TCH2, {**get("c4"), "review": {"status": "returned"}})[0], 400)
check("return at the DP step with a reason", (put(TCH2, {**get("c4"), "review": {"status": "returned", "reason": "Wrong plate count"}})[0], get("c4")["review"]["status"], get("c4")["review"]["hist"][0]["reason"]), (200, "returned", "Wrong plate count"))
check("the technician resubmits: back through the DP, history kept", (put(TCH, {**get("c4"), "review": {"status": "pending"}})[0], get("c4")["review"]["status"], len(get("c4")["review"]["hist"])), (200, "dp", 1))
put(TCH2, {**get("c4"), "review": {"status": "pending"}})
check("return at the final step, with reason", (put(PIC, {**get("c4"), "review": {"status": "returned", "reason": "Attach the report"}})[0], get("c4")["review"]["status"], [h["step"] for h in get("c4")["review"]["hist"]]), (200, "returned", ["dp", "final"]))
check("the DP submitting goes straight to final approval", (put(TCH2, rec("c5", "TCHV"))[0], get("c5")["review"]["status"]), (200, "pending"))
put(TCH, rec("c6", "TCHU"))
check("review in place with a reason: bypass is logged on the record", (put(PIC, {**get("c6"), "review": {"status": "accepted", "bypassReason": "DP out sick, unplanned"}})[0], get("c6")["review"]["bypassed"]["reason"]), (200, "DP out sick, unplanned"))
check("a retail task skips the DP step", (put(TCH, {"id": "c7", "track": "custom-x|s", "status": "done", "review": {"status": "pending"}})[0], get("c7")["review"]["status"]), (200, "pending"))

# ---- delegation (pharmacy time zone, date AND time)
tz = zoneinfo.ZoneInfo("America/Chicago")
nowL = datetime.datetime.now(tz).replace(second=0, microsecond=0)
f = lambda d: d.strftime("%Y-%m-%dT%H:%M")
S0, E0 = f(nowL), f(nowL + datetime.timedelta(hours=8))
D = cal + "/delegations"
check("start can't be in the past", api(TCH2, "POST", D, {"step": "dp", "to": picS, "start": f(nowL - datetime.timedelta(hours=3)), "end": E0})[0], 400)
check("end must be after start", api(TCH2, "POST", D, {"step": "dp", "to": picS, "start": S0, "end": S0})[0], 400)
check("date AND time are needed", api(TCH2, "POST", D, {"step": "dp", "to": picS, "start": "2026-11-23", "end": "2026-11-24"})[0], 400)
check("only a DP gives away the review step", api(TCH, "POST", D, {"step": "dp", "to": picS, "start": S0, "end": E0})[0], 400)
check("the review step can't go to Associate staff", api(TCH2, "POST", D, {"step": "dp", "to": ascS, "start": S0, "end": E0})[0], 400)
check("final approval can't go to a technician", api(PIC, "POST", D, {"step": "final", "to": tchS, "start": S0, "end": E0})[0], 400)
check("a pharmacist without the approver switch can't give final approval away", api(RPH, "POST", D, {"step": "final", "to": rph2S, "start": S0, "end": E0})[0], 400)
put(TCH, rec("c8", "TCHU"))
check("before the delegation the PIC can't pass the DP step", put(PIC, {**get("c8"), "review": {"status": "pending"}})[0], 403)
s, r = api(TCH2, "POST", D, {"step": "dp", "to": picS, "start": S0, "end": E0}); did = r.get("id")
check("the DP delegates to the PIC for a span", s, 200)
check("the PIC passes the DP step on behalf of the DP", (put(PIC, {**get("c8"), "review": {"status": "pending"}})[0], get("c8")["review"]["dp"].get("onBehalfOf")), (200, "TCHV"))
g = api(TCH, "GET", cal)[1]
check("everyone sees the delegation as active", [(d["fromName"], d["toName"], d["active"]) for d in g["delegations"]], [("TCHV", "PICU", True)])
check("the PIC's chapters include 797 while it runs", api(PIC, "GET", cal)[1]["me"]["dpChapters"], ["797"])
check("a technician can't cancel someone else's delegation", api(TCH, "POST", D + "/" + did + "/cancel", {})[0], 403)
check("the delegator cancels", api(TCH2, "POST", D + "/" + did + "/cancel", {})[0], 200)
put(TCH, rec("c9", "TCHU"))
check("after cancelling, the PIC is no longer a DP for it", put(PIC, {**get("c9"), "review": {"status": "pending"}})[0], 403)
check("the PIC sets one for someone else: reason required", api(PIC, "POST", D, {"step": "dp", "for": tch2S, "to": rphS, "start": S0, "end": E0})[0], 400)
check("the PIC sets one for someone else with a reason", api(PIC, "POST", D, {"step": "dp", "for": tch2S, "to": rphS, "start": S0, "end": E0, "reason": "Called out sick"})[0], 200)
check("a technician can't set one for someone else", api(TCH, "POST", D, {"step": "dp", "for": tch2S, "to": rphS, "start": S0, "end": E0, "reason": "x"})[0], 403)
check("the delegate can't hand it on again", api(RPH, "POST", D, {"step": "dp", "to": rph2S, "start": S0, "end": E0})[0], 400)
check("final approval delegated to a pharmacist", api(PIC, "POST", D, {"step": "final", "to": rphS, "start": S0, "end": E0})[0], 200)
put(TCH, {"id": "c10", "track": "custom-x|s", "status": "done", "review": {"status": "pending"}})
check("the delegate gives final approval on behalf of the PIC", (put(RPH, {**get("c10"), "review": {"status": "accepted"}})[0], get("c10")["review"].get("onBehalfOf")), (200, "PICU"))
check("log carries the delegations", sorted(set(l["action"] for l in api(O, "GET", cal)[1]["log"] if l["action"].startswith("Delegation"))), ["Delegation Cancelled", "Delegation Set"])

# ---- time off
T = cal + "/timeoff"
check("a technician adds their own time off; no prompt for a delegation", (lambda r: (r[0], r[1].get("promptDelegation")))(api(TCH, "POST", T, {"start": S0, "end": E0})), (200, False))
s, r = api(TCH2, "POST", T, {"start": S0, "end": E0, "reason": "Surgery"})
check("a DP is asked to name who covers", (s, r.get("promptDelegation")), (200, True))
toid = r["id"]
g = api(ASC, "GET", cal)[1]
check("everyone sees name and span, never a reason", sorted((t["name"], "reason" in t) for t in g["timeoff"]), [("TCHU", False), ("TCHV", False)])
check("time off can't start in the past", api(TCH, "POST", T, {"start": f(nowL - datetime.timedelta(days=2)), "end": E0})[0], 400)
check("a technician can't add it for someone else", api(TCH, "POST", T, {"for": tch2S, "start": S0, "end": E0})[0], 403)
check("a technician can't remove someone else's", api(TCH, "POST", T + "/" + toid + "/cancel", {})[0], 403)
check("the PIC removes it", api(PIC, "POST", T + "/" + toid + "/cancel", {})[0], 200)
check("removed time off disappears", sorted(t["name"] for t in api(ASC, "GET", cal)[1]["timeoff"]), ["TCHU"])
check("time off and delegations can't be written through commit", (api(O, "POST", cal + "/commit", {"put": {"deleg": [{"id": "z"}]}})[0], api(O, "POST", cal + "/commit", {"put": {"timeoff": [{"id": "z"}]}})[0]), (400, 400))
upd(O, tchS, {"licExpires": f(nowL + datetime.timedelta(days=10))[:10]})
g = api(ASC, "GET", cal)[1]
check("a non-manager doesn't see others' registration dates; count is shown", ("licExpires" in [t for t in g["team"] if t["name"] == "TCHV"][0], g["expiring"]["registrations"]), (False, 1))
print("FAILED:", fails or "none")

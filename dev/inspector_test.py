# 39.2 Inspector link, access log, host read-only logged view (SUITE_USERS=NTX1:owner,picu,rphu,rphv,tchu,tchv,ascu).
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

TR = "u797-air|room1"
rec = lambda i, **kw: {"id": i, "track": TR, "forDue": "2026-11-0" + i[-1], "status": "done", "completedBy": "TCHU", "completedOn": "2026-11-23", "result": "pass", "review": {"status": "pending"}, **kw}
G = lambda tok=None: {r["id"]: r for r in api(tok or O, "GET", cal)[1]["records"]}

import urllib.error
PDF = b"%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
def raw(method, url, data=None, headers=None):
    req = urllib.request.Request(url, method=method, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(req) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()
def pub(path):
    s, b = raw("GET", "http://localhost:8790/api/public/inspect/" + path, None, {"user-agent": "InspectorTest/1.0"}); return s, json.loads(b or b'{}')
D = "/stores/NTX1/documents"; IN = "/stores/NTX1/inspector"
for sub, ini in ((picS, "PC"), (tchS, "TH"), (tch2S, "TD")): assert api(O, "POST", "/owner/users/" + sub, {"initials": ini})[0] == 200
# data: approved r1 (in period), approved r2 (outside the period), pending r3, voided r4, an excursion, a missed entry, documents
def approve_rec(i, on, **kw):
    api(TCH, "POST", cal + "/commit", {"put": {"records": [rec(i, completedOn=on, title="Air Sampling", **kw)]}})
    g = G()[i]; api(TCH2, "POST", cal + "/commit", {"put": {"records": [{**g, "review": {"status": "pending"}}]}})
    g = G()[i]; return api(PIC, "POST", cal + "/commit", {"put": {"records": [{**g, "review": {"status": "accepted"}}]}})[0]
check("r1 approved (in period)", approve_rec("r1", "2026-11-20"), 200)
check("r2 approved (outside the period)", approve_rec("r2", "2026-09-10"), 200)
check("r3 left pending", api(TCH, "POST", cal + "/commit", {"put": {"records": [rec("r3", completedOn="2026-11-21", title="Air Sampling")]}})[0], 200)
check("r4 approved then voided", (approve_rec("r4", "2026-11-22"), api(PIC, "POST", cal + "/records/r4/void", {"type": "nottask", "note": "entered by mistake"})[0]), (200, 200))
check("an excursion is reported", api(TCH, "POST", cal + "/commit", {"put": {"exc": [{"id": "e1", "kind": "excursion", "date": "2026-11-21", "what": "Fridge 9 C", "handling": "Moved stock, discarded 2 vials", "type": "temperature", "track": TR}]}})[0], 200)
def upload(tok, path):
    s, r = api(tok, "POST", path, {"name": "Policy.pdf", "size": len(PDF)}); raw("PUT", r["url"], PDF, {"content-type": "application/pdf"}); return r
def newdoc(title, typ="SOP"):
    u = upload(PIC, D + "/upload-url"); s, r = api(PIC, "POST", D, {"title": title, "type": typ, "area": "STC" if typ == "SOP" else "OPS", "format": "Printable PDF", "cycle": 12, "version": "1.0", "file": {"key": u["key"], "name": "Policy.pdf"}}); assert s == 200, r; return r["id"]
dA = newdoc("Gowning SOP"); dB = newdoc("Draft SOP"); dR = newdoc("Patient Notice", "PAT")
assert api(PIC, "POST", D + "/" + dA + "/approve", {"effective": "2026-11-01"})[0] == 200; assert api(PIC, "POST", D + "/" + dR + "/approve", {"effective": "2026-11-01"})[0] == 200
# ---- who may send
check("a technician can't send a link", api(TCH, "POST", IN, {"label": "TSBP", "from": "2026-11-01", "to": "2026-11-30"})[0], 403)
check("a pharmacist without the privilege can't", api(RPH, "GET", IN)[0], 403)
check("the PIC grants it", api(PIC, "POST", D + "/grants", {"what": "inspector", "sub": rphS, "on": True})[0], 200)
check("a bad period is refused", api(PIC, "POST", IN, {"label": "TSBP", "from": "2026-11-30", "to": "2026-11-01"})[0], 400)
check("a name is required", api(PIC, "POST", IN, {"label": "", "from": "2026-11-01", "to": "2026-11-30"})[0], 400)
check("expiry over 30 days is refused", api(PIC, "POST", IN, {"label": "TSBP", "from": "2026-11-01", "to": "2026-11-30", "days": 60})[0], 400)
s, L1 = api(PIC, "POST", IN, {"label": "TSBP Inspector Smith", "from": "2026-11-01", "to": "2026-11-30"}); T = L1["token"]
check("the link is made with the 7 day default", (s, L1["link"]["state"], round((L1["link"]["expiresAt"] / 1000 - __import__("time").time()) / 86400)), (200, "Active", 7))
check("only a hash is stored, never the token", "token" in json.dumps(api(PIC, "GET", IN)[1]), False)
s, L2 = api(RPH, "POST", IN, {"label": "DEA", "from": "2026-11-01", "to": "2026-11-30", "docs": True}); T2 = L2["token"]; check("a granted pharmacist sends one with documents", s, 200)
# ---- what the inspector sees
s, sm = pub(T + "/summary")
check("no sign-in needed; summary counts approved, in-period, not voided", (s, sm["completed"], sm["excursions"], sm["open"], sm["period"]), (200, 1, 1, 1, {"from": "2026-11-01", "to": "2026-11-30"}))
check("summary has no internal review queue", [k for k in sm if "queue" in k.lower() or "review" in k.lower()], [])
s, lg = pub(T + "/logs"); row = lg["logs"][0]
check("task logs: grouped by type; performed by, result, approver", (lg["logs"][0]["title"], len(row["rows"]), row["rows"][0]["performedBy"], row["rows"][0]["approvedBy"]), ("Air Sampling", 1, "TCHU", "PICU"))
check("the exception shows its handling", (lg["exceptions"][0]["what"], lg["exceptions"][0]["handling"], lg["exceptions"][0]["status"]), ("Fridge 9 C", "Moved stock, discarded 2 vials", "Open"))
check("a voided record is hidden", "r4" in json.dumps(lg), False)
s, dc = pub(T + "/docs"); check("documents: approved only, no drafts, no patient material", [d["id"] for d in dc["docs"]], [dA])
check("documents show version and next review", (dc["docs"][0]["version"], dc["docs"][0]["nextReview"]), ("1.0", "2027-11-01"))
s, pe = pub(T + "/personnel")
check("personnel: compliance data only", sorted(pe["people"][0].keys()), sorted(["sub", "name", "acctType", "subs", "dp", "license", "licExpires", "records"]))
check("no phone numbers anywhere in the inspector view", "(817)" in json.dumps(pe) + json.dumps(sm) + json.dumps(lg) + json.dumps(api(PIC, "GET", D + "/personnel/" + tchS)[1]["person"]), False)
check("this link shows the register only: file refused", pub(T + "/file/" + dA)[0], 403)
s, f = pub(T2 + "/file/" + dA); check("a link with documents can open an approved one", (s, "url" in f), (200, True))
check("but not a draft", pub(T2 + "/file/" + dB)[0], 404)
check("nor a patient notice", pub(T2 + "/file/" + dR)[0], 404)
s, rp = pub(T + "/report")
check("print report has cover, metrics, logs, register and one personnel entry per person", (rp["pharmacy"]["name"], rp["meta"]["by"], bool(rp["generatedAt"]), len(rp["logs"]), len(rp["docs"]), len(rp["people"]) >= 5), ("NorTex Pharmacy - Haslet", "PICU", True, 1, 1, True))
# ---- bad links
check("a made-up token", pub("NTX1.nottherightone/summary")[0], 404)
check("a token from a different store prefix", pub("TEST1." + T.split(".", 1)[1] + "/summary")[0], 404)
check("the link can't reach anything else", pub(T + "/billing")[0], 404)
# ---- access log
s, ov = api(PIC, "GET", IN); log = ov["log"]
check("every open is logged with what, when, IP and device", (len(log) >= 6, {"Opened Dashboard", "Opened Task Logs", "Opened Documents", "Opened Personnel", "Opened Print Report", "Downloaded Document"} <= {e["what"] for e in log}, log[0]["device"], bool(log[0]["ip"])), (True, True, "InspectorTest/1.0", True))
check("the download names the document", [e["detail"] for e in log if e["what"] == "Downloaded Document"], [dA + " v1.0"])
check("a granted pharmacist doesn't see the access log", api(RPH, "GET", IN)[1]["log"], None)
check("opens counted per link", [l["opens"] for l in ov["links"] if l["id"] == L1["link"]["id"]], [sum(1 for e in log if e["lid"] == L1["link"]["id"])])
# ---- expiry and revoke
check("the sender shortens the expiry", api(PIC, "POST", IN + "/" + L1["link"]["id"] + "/expiry", {"days": 1})[0], 200)
check("expiry out of range refused", api(PIC, "POST", IN + "/" + L1["link"]["id"] + "/expiry", {"days": 99})[0], 400)
check("revoke", api(PIC, "POST", IN + "/" + L1["link"]["id"] + "/revoke", {})[0], 200)
check("a revoked link answers 410", pub(T + "/summary")[0], 410)
check("a revoked link can't be extended", api(PIC, "POST", IN + "/" + L1["link"]["id"] + "/expiry", {"days": 3})[0], 400)
# an expired link
import time
s, L3 = api(PIC, "POST", IN, {"label": "Short", "from": "2026-11-01", "to": "2026-11-30", "days": 1})
node({"expire": 1}) if False else None
check("the access log is kept after the link is revoked", len(api(PIC, "GET", IN)[1]["log"]) >= len(log), True)
check("sending and revoking are in the Documents activity log", {"Inspector Link Sent", "Inspector Link Revoked", "Inspector Link Expiry Changed", "Inspector Link Granted"} <= {x["action"] for x in api(PIC, "GET", D)[1]["log"]}, True)
# ---- host: read only and logged
neo = [a["Value"] for a in c.admin_get_user(UserPoolId=ids["pool"], Username="neo")["UserAttributes"] if a["Name"] == "sub"][0]
HV = "/stores/NTX1/host-view"
check("host reads the calendar", (lambda r: (r[0], r[1].get("readOnly")))(api(H, "GET", HV + "/calendar")), (200, True))
check("host can't write through it", api(H, "POST", HV + "/calendar", {})[0], 403)
check("a pharmacy user gets nothing from host-view", api(PIC, "GET", HV + "/calendar")[0], 404)
check("host personnel needs the privilege", api(H, "GET", HV + "/personnel")[0], 403)
check("a pharmacy user can't give it", api(PIC, "POST", "/host/personnel-priv/" + neo, {"on": True})[0] in (403, 404), True)
check("a supervisor gives it", api(H, "POST", "/host/personnel-priv/" + neo, {"on": True})[0], 200)
hl = api(H, "GET", HV + "/personnel"); check("host reads the personnel list", (hl[0], len(hl[1]["people"]) >= 5), (200, True))
check("and one person's file", api(H, "GET", HV + "/personnel/" + tchS)[0], 200)
s, hlog = api(PIC, "GET", D + "/hostlog"); check("the pharmacy sees every host view", (s, {"Calendar Viewed", "Personnel List Viewed", "Personnel File Viewed"} <= {e["what"] for e in hlog["log"]}, hlog["log"][0]["by"]), (200, True, "Thomas Fisher"))
check("only the PIC or owner can read the host log", api(TCH, "GET", D + "/hostlog")[0], 403)
check("the host log is in the same list for the owner", api(O, "GET", D + "/hostlog")[0], 200)
print("FAILED:", fails or "none")

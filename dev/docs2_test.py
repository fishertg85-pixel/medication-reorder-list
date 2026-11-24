# 39.2 Documents: task files, Tasks folder, My Documents, Personnel Files, audience, chapter, Designated Person review (SUITE_USERS=NTX1:owner,picu,rphu,rphv,tchu,tchv,ascu).
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
D = "/stores/NTX1/documents"
for sub, ini in ((picS, "PC"), (rphS, "RP"), (tchS, "TH"), (tch2S, "TD")): r_ = api(O, "POST", "/owner/users/" + sub, {"initials": ini}); assert r_[0] == 200, r_
for t, a, pw in ((RPH2, None, None),): pass
assert api(O, "POST", "/owner/users/" + picS, {"license": "RPH100", "licExpires": "2027-06-30"})[0] == 200
def put_pdf(tok, path):
    s, r = api(tok, "POST", path, {"name": "Scan.pdf", "size": len(PDF)})
    if s != 200: return s, r
    ps, _ = raw("PUT", r["url"], PDF, {"content-type": "application/pdf"}); return ps, r
# ---- task files
check("a view-only associate can't attach", api(ASC, "POST", cal + "/upload-url", {"name": "a.pdf", "size": 10})[0], 403)
check("an unsupported type is refused", api(TCH, "POST", cal + "/upload-url", {"name": "a.exe", "size": 10})[0], 400)
check("over 20 MB is refused", api(TCH, "POST", cal + "/upload-url", {"name": "a.pdf", "size": 21 * 1048576})[0], 400)
s, up = api(TCH, "POST", cal + "/upload-url", {"name": "hood cert.png", "size": 6})
check("a technician gets an upload link and a safe id", (s, bool(__import__("re").match(r"^[a-f0-9]{32}\.png$", up.get("id", "")))), (200, True))
check("the file uploads", raw("PUT", up["url"], b"\x89PNG\r\n", up["headers"])[0], 200)
s, fl = api(TCH, "GET", cal + "/file/" + up["id"]); check("the file link opens", (s, "url" in fl), (200, True))
check("a view-only associate can't open task files", api(ASC, "GET", cal + "/file/" + up["id"])[0], 403)
check("a bad file id is refused", api(TCH, "GET", cal + "/file/..%2Fx.png")[0] in (400, 404), True)
FILE = {"id": up["id"], "name": "hood cert.png", "size": 6, "type": "image/png", "by": "TCHU", "at": "2026-11-23T10:00:00Z"}
check("a record with a made-up file id is refused", api(TCH, "POST", cal + "/commit", {"put": {"records": [rec("r2", title="Air Sampling", task={"files": [{**FILE, "id": "evil.png"}]})]}})[0], 400)
check("a record with an uploaded file is saved", api(TCH, "POST", cal + "/commit", {"put": {"records": [rec("r2", title="Air Sampling", task={"files": [FILE]})]}})[0], 200)
g = G()["r2"]; api(TCH2, "POST", cal + "/commit", {"put": {"records": [{**g, "review": {"status": "pending"}}]}})
g = G()["r2"]; check("approved by the PIC", api(PIC, "POST", cal + "/commit", {"put": {"records": [{**g, "review": {"status": "accepted"}}]}})[0], 200)
s, t = api(PIC, "GET", D + "/tasks"); f0 = (t.get("folders") or [{}])[0]
check("Tasks folder: a subfolder per task type with the entry", (s, f0.get("title"), len(f0.get("entries", []))), (200, "Air Sampling", 1))
e = (f0.get("entries") or [{}])[0]
check("entry shows date, who performed, result, approver, files", (e.get("date"), e.get("performedBy"), e.get("result"), e.get("approvedBy"), len(e.get("files", []))), ("2026-11-23", "TCHU", "pass", "PICU", 1))
check("task technicians see it", api(TCH, "GET", D + "/tasks")[0], 200)
check("view-only associate is refused", api(ASC, "GET", D + "/tasks")[0], 403)
check("task file opens from the folder", (lambda r: (r[0], "url" in r[1]))(api(PIC, "GET", D + "/tasks/file/" + up["id"])), (200, True))
check("voided records leave the folder", (api(PIC, "POST", cal + "/records/r2/void", {"type": "nottask", "note": "entered by mistake"})[0], api(PIC, "GET", D + "/tasks")[1]["folders"]), (200, []))
# ---- My Documents
M = D + "/mine"
check("my documents starts empty", (lambda r: (r[0], r[1]["uploads"]))(api(TCH, "GET", M)), (200, []))
ps, mu = put_pdf(TCH, M + "/upload-url"); check("a technician uploads a scan", ps, 200)
check("add it as a validation", api(TCH, "POST", M, {"title": "Media fill 2026", "kind": "validation", "file": {"key": mu["key"], "name": "Scan.pdf"}})[0], 200)
check("a bad kind is refused", api(TCH, "POST", M, {"title": "x", "kind": "zzz", "file": {"key": mu["key"], "name": "Scan.pdf"}})[0], 400)
mine = api(TCH, "GET", M)[1]; mid = mine["uploads"][0]["id"]
check("it lists with title and kind", (mine["uploads"][0]["title"], mine["uploads"][0]["kind"]), ("Media fill 2026", "validation"))
check("nobody else sees it in their own list", api(RPH, "GET", M)[1]["uploads"], [])
check("owner can't read it through My Documents", api(RPH, "GET", M + "/" + mid + "/file")[0], 404)
check("my own file opens", (lambda r: (r[0], "url" in r[1]))(api(TCH, "GET", M + "/" + mid + "/file")), (200, True))
check("the PIC has a My Documents page too", api(PIC, "GET", M)[0], 200)
check("my license shows from my login", api(PIC, "GET", M)[1]["license"], {"number": "RPH100", "expires": "2027-06-30"})
# ---- Personnel Files
P = D + "/personnel"
check("an associate is refused", api(ASC, "GET", P)[0], 403)
check("a pharmacist without the privilege is refused", api(RPH, "GET", P)[0], 403)
check("the PIC may open it", api(PIC, "GET", P)[0], 200)
check("the Account Owner may open it", api(O, "GET", P)[0], 200)
check("a ticked Designated Person box turns it on", api(TCH2, "GET", P)[0], 200)
check("a technician without a box is refused", api(TCH, "GET", P)[0], 403)
check("only the PIC or owner can grant", api(RPH, "POST", D + "/grants", {"what": "personnel", "sub": rphS, "on": True})[0], 403)
check("the PIC grants a pharmacist", api(PIC, "POST", D + "/grants", {"what": "personnel", "sub": rphS, "on": True})[0], 200)
check("the granted pharmacist opens it", api(RPH, "GET", P)[0], 200)
lst = api(PIC, "GET", P)[1]
check("the list is compliance data only", sorted(lst["people"][0].keys()), sorted(["sub", "name", "acctType", "subs", "dp", "license", "licExpires"]))
d = api(PIC, "GET", P + "/" + tchS)[1]
check("a person's file: their scan and no contact data", (d["person"]["name"], [u["title"] for u in d["uploads"]], "phone" in d["person"]), ("TCHU", ["Media fill 2026"], False))
check("their scan opens for the PIC", (lambda r: (r[0], "url" in r[1]))(api(PIC, "GET", P + "/" + tchS + "/file/" + mid)), (200, True))
check("only the owner adds material", api(PIC, "POST", P + "/" + tchS + "/upload-url", {"name": "x.pdf", "size": 10})[0], 403)
ps, ou = put_pdf(O, P + "/" + tchS + "/upload-url"); check("owner uploads", ps, 200)
check("owner adds material to the file", api(O, "POST", P + "/" + tchS + "/add", {"title": "Signed offer letter", "kind": "other", "file": {"key": ou["key"], "name": "Scan.pdf"}})[0], 200)
check("the person sees what the owner added", sorted(u["title"] for u in api(TCH, "GET", M)[1]["uploads"]), ["Media fill 2026", "Signed offer letter"])
oid = [u["id"] for u in api(TCH, "GET", M)[1]["uploads"] if u["title"] == "Signed offer letter"][0]
check("the person can't remove what the owner added", api(TCH, "POST", M + "/" + oid + "/remove", {})[0], 403)
check("the person removes their own", api(TCH, "POST", M + "/" + mid + "/remove", {})[0], 200)
check("the PIC removes the grant", api(PIC, "POST", D + "/grants", {"what": "personnel", "sub": rphS, "on": False})[0], 200)
check("and the pharmacist is refused again", api(RPH, "GET", P)[0], 403)
log = api(PIC, "GET", D)[1]["log"]
check("every view is logged", sorted({x["action"] for x in log if x["action"].startswith("Personnel")}), ["Personnel Document Opened", "Personnel File Viewed", "Personnel Files Granted", "Personnel Files Opened", "Personnel Files Removed", "Personnel Material Added"])
# ---- chapter, audience, Designated Person review
def newdoc(tok, **kw):
    ps, u = put_pdf(tok, D + "/upload-url")
    s, r = api(tok, "POST", D, {"title": "Gowning SOP", "type": "SOP", "area": "STC", "format": "Printable PDF", "cycle": 12, "version": "1.0", "file": {"key": u["key"], "name": "Policy.pdf"}, **kw})
    return s, r
check("a bad chapter is refused", newdoc(PIC, chapter="123")[0], 400)
check("a bad audience is refused", newdoc(PIC, audience=["wizard"])[0], 400)
s, r = newdoc(PIC, chapter="797", audience=["tech"]); did = r["id"]; check("PIC adds a chaptered document for technicians", s, 200)
check("a Designated Person for 797 exists, so approval waits for them", (lambda r: (r[0], "Designated Person" in r[1].get("error", "")))(api(PIC, "POST", D + "/" + did + "/approve", {"effective": "2026-11-24"})), (400, True))
check("a pharmacist without the box can't review", api(RPH, "POST", D + "/" + did + "/dpreview", {})[0], 403)
check("the Designated Person reviews", api(TCH2, "POST", D + "/" + did + "/dpreview", {"comment": "Matches the SOP"})[0], 200)
check("the review shows on the version", api(PIC, "GET", D)[1]["docs"][0]["versions"][0]["dpReview"]["by"], "TCHV")
check("a technician Designated Person can't give final approval", api(TCH2, "POST", D + "/" + did + "/approve", {"effective": "2026-11-24"})[0], 403)
check("the final approver approves", api(PIC, "POST", D + "/" + did + "/approve", {"effective": "2026-11-24"})[0], 200)
check("audience: technicians see it", [x["id"] for x in api(TCH, "GET", D)[1]["docs"]], [did])
check("audience: an associate does not", api(ASC, "GET", D)[1]["docs"], [])
check("audience: and can't open its file", api(ASC, "GET", D + "/" + did + "/file")[0], 404)
check("the PIC widens the audience to everyone", api(PIC, "POST", D + "/" + did + "/edit", {"audience": []})[0], 200)
check("now the associate sees it", [x["id"] for x in api(ASC, "GET", D)[1]["docs"]], [did])
check("a sub-role audience", api(PIC, "POST", D + "/" + did + "/edit", {"audience": ["staff:cashier", "pharmacist:sterile"]})[0], 200)
check("a cashier (sub-role) sees it", [x["id"] for x in api(ASC, "GET", D)[1]["docs"]], [did])
check("a pharmacist outside the sub-role does not", api(RPH, "GET", D)[1]["docs"], [])
check("a bad audience on edit is refused", api(PIC, "POST", D + "/" + did + "/edit", {"audience": ["x"]})[0], 400)
check("tag the chapter later", api(PIC, "POST", D + "/" + did + "/edit", {"chapter": "795"})[0], 200)
check("only the PIC or owner switches a person's review off", api(RPH, "POST", D + "/grants", {"what": "dpoff", "sub": tch2S, "on": True})[0], 403)
check("a non-Designated Person can't be switched", api(PIC, "POST", D + "/grants", {"what": "dpoff", "sub": tchS, "on": True})[0], 400)
s, r = newdoc(PIC, chapter="797"); d2 = r["id"]
check("PIC switches the Designated Person's review off", api(PIC, "POST", D + "/grants", {"what": "dpoff", "sub": tch2S, "on": True})[0], 200)
check("the switched-off person can't review", api(TCH2, "POST", D + "/" + d2 + "/dpreview", {})[0], 403)
check("with no Designated Person step, the final approver still approves", api(PIC, "POST", D + "/" + d2 + "/approve", {"effective": "2026-11-24"})[0], 200)
check("a technician (no Designated Person) can't approve at all", api(CT := TCH, "POST", D + "/" + d2 + "/approve", {"effective": "2026-11-24"})[0], 403)
s, r = newdoc(PIC, chapter="795"); d3 = r["id"]
check("a chapter with nobody holding the box has no extra step", api(PIC, "POST", D + "/" + d3 + "/approve", {"effective": "2026-11-24"})[0], 200)
print("FAILED:", fails or "none")

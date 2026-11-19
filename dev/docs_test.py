# Documents: access rules, duties, upload, versions, approval, review, retire, file links, pins. Run ./reset.sh first.
import re, json, subprocess, urllib.request, urllib.error, boto3, sys
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
def raw(method, url, data=None, headers=None):
    req = urllib.request.Request(url, method=method, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(req) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()
def api(tok, method, path, body=None):
    s, b = raw(method, "http://localhost:8790/api" + path, json.dumps(body).encode() if body is not None else None, {"Authorization": "Bearer " + tok, "content-type": "application/json"})
    return s, json.loads(b or b'{}')
def node(arg): return json.loads(subprocess.check_output(["node", "boot.mjs", json.dumps(arg)]).decode().strip().splitlines()[-1])
a = login("owner", "temp12345a", "ownerpass99"); O = a["IdToken"]; api(O, "POST", "/owner-unlock", {"password": "ownerpass99", "accessToken": a["AccessToken"]})
node({"makeHost": {"login": "Neo", "name": "Thomas Fisher", "phone": "8175559999", "tempPassword": "hosttemp12a"}})
h = login("neo", "hosttemp12a", "hostpass999"); H = h["IdToken"]; api(H, "POST", "/host-unlock", {"password": "hostpass999", "accessToken": h["AccessToken"]})
PDF = b"%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
def mk(login_, perms, acct="", duty=None, stores=True):
    s_, r = api(O, "POST", "/owner/users", {"login": login_, "name": login_.upper(), "phone": "(817) 555-" + str(1000 + len(login_) * 7 + sum(map(ord, login_)) % 900), "smsConsent": True, "stores": {"NTX1": stores}, "acctType": acct, "perms": perms}); assert s_ == 200, r
    if duty: assert api(O, "POST", "/owner/users/" + r["user"]["sub"], {"docDuty": duty})[0] == 200
    return login(login_, r["tempPassword"], login_ + "pass12345")["IdToken"]
P = {"documents": True}
PIC = mk("pic1", P, "pic"); DP = mk("dp1", P, "pharmacist", "dp"); CT = mk("ctech1", P, "tech", "ctech"); ST = mk("staff1", P, "staff"); NOP = mk("noperm1", {})
# initials and PINs: approvers sign with a personal PIN (the tests below send it automatically on signing calls)
USERS = lambda: api(O, "GET", "/owner/users")[1]["users"]
subof = lambda l: [u for u in USERS() if u["login"] == l][0]["sub"]
for l, ini in (("owner", "PO"), ("pic1", "PC"), ("dp1", "DP"), ("ctech1", "CT")): assert api(O, "POST", "/owner/users/" + subof(l), {"initials": ini})[0] == 200
PINS = {O: "2847", PIC: "3951", DP: "7264"}
for t, pn in PINS.items(): assert api(t, "POST", "/me/pin", {"pin": pn})[0] == 200
_api0 = api
def api(tok, method, path, body=None):
    if method == "POST" and tok in PINS and isinstance(body, dict) and "pin" not in body and path.rsplit("/", 1)[-1] in ("approve", "reject", "review", "retire", "restore"): body = dict(body, pin=PINS[tok])
    return _api0(tok, method, path, body)
D = "/stores/NTX1/documents"
check("Documents switched off: everyone is refused", (api(O, "GET", D)[0], api(PIC, "GET", D)[0]), (403, 403))
check("host switches Documents on", api(H, "POST", "/host/stores/NTX1", {"documents": True, "changeReason": "test change reason"})[0], 200)
check("pharmacy reports documents on", [x for x in api(H, "GET", "/host/stores")[1]["stores"] if x["id"] == "NTX1"][0]["documents"], True)
check("Account Owner cannot switch the pharmacy flag", api(O, "POST", "/owner/stores/NTX1", {"documents": False})[0] in (400, 403), True)
check("no Documents privilege: refused", api(NOP, "GET", D)[0], 403)
check("Account Owner duty", api(O, "GET", D)[1]["duty"], "owner")
check("duties from account type and per-person setting", [api(t, "GET", D)[1]["duty"] for t in (PIC, DP, CT, ST)], ["pic", "dp", "ctech", "staff"])
check("bad duty refused", api(O, "POST", "/owner/users/" + [u for u in api(O, "GET", "/owner/users")[1]["users"] if u["login"] == "staff1"][0]["sub"], {"docDuty": "king"})[0], 400)
# ---- upload
def upload(tok, data=PDF, name="Policy.pdf"):
    s, r = api(tok, "POST", D + "/upload-url", {"name": name, "size": len(data)})
    if s != 200: return s, r
    ps, _ = raw("PUT", r["url"], data, {"content-type": "application/pdf"})
    return ps, r
check("staff cannot upload", api(ST, "POST", D + "/upload-url", {"name": "a.pdf", "size": 10})[0], 403)
check("not a pdf name refused", api(CT, "POST", D + "/upload-url", {"name": "a.docx", "size": 10})[0], 400)
check("too big refused", api(CT, "POST", D + "/upload-url", {"name": "a.pdf", "size": 26 * 1048576})[0], 400)
ps, up = upload(CT); check("compliance tech can upload (file stored)", ps, 200)
body = lambda up, **kw: {"title": "Telephone Order Intake", "type": "SOP", "area": "OPS", "format": "Printable PDF", "cycle": 12, "basis": "", "version": "1.0", "file": {"key": up["key"], "name": "Policy.pdf"}, **kw}
check("staff cannot add", api(ST, "POST", D, body(up))[0], 403)
s, r = api(CT, "POST", D, body(up)); check("tech adds a document", (s, r.get("id")), (200, "SOP-OPS-001"))
ps, up2 = upload(CT); s, r2 = api(CT, "POST", D, body(up2, title="Second")); check("IDs count up per type and area", r2.get("id"), "SOP-OPS-002")
ps, up3 = upload(CT); s, r3 = api(CT, "POST", D, body(up3, title="Form", type="FRM", area="IMM", format="Fillable PDF")); check("different type has its own count", r3.get("id"), "FRM-IMM-001")
check("compounding-only type refuses other areas", api(CT, "POST", D, body(up, type="MFR", area="OPS"))[0], 400)
check("bad type refused", api(CT, "POST", D, body(up, type="XXX"))[0], 400)
check("title required", api(CT, "POST", D, body(up, title=" "))[0], 400)
check("version shape checked", api(CT, "POST", D, body(up, version="one"))[0], 400)
check("file from another pharmacy refused", api(CT, "POST", D, body({"key": "OTHER/files/abcdef0123456789.pdf"}))[0], 400)
check("file that was never uploaded refused", api(CT, "POST", D, body({"key": "NTX1/files/neveruploaded000.pdf"}))[0], 400)
ps, notpdf = upload(CT, b"hello, this is text", "x.pdf"); check("text file named .pdf refused", api(CT, "POST", D, body(notpdf))[0], 400)
# ---- who sees what
view = lambda tok: api(tok, "GET", D)[1]
check("staff see no drafts", view(ST)["docs"], [])
check("tech sees drafts", sorted(d["id"] for d in view(CT)["docs"]), ["FRM-IMM-001", "SOP-OPS-001", "SOP-OPS-002"])
check("staff cannot open a draft file", api(ST, "GET", D + "/SOP-OPS-001/file")[0], 404)
# ---- approval
check("tech cannot approve", api(CT, "POST", D + "/SOP-OPS-001/approve", {"effective": "2026-11-01"})[0], 403)
check("staff cannot approve", api(ST, "POST", D + "/SOP-OPS-001/approve", {"effective": "2026-11-01"})[0], 403)
check("bad date refused", api(PIC, "POST", D + "/SOP-OPS-001/approve", {"effective": "11/01/2026"})[0], 400)
check("PIC approves", api(PIC, "POST", D + "/SOP-OPS-001/approve", {"effective": "2026-11-01"})[0], 200)
today = view(PIC)["today"]
d1 = [d for d in view(PIC)["docs"] if d["id"] == "SOP-OPS-001"][0]
check("now active with current v1.0", ([v["state"] for v in d1["versions"]], d1["lastReviewed"]), (["current"], "2026-11-01"))
check("nothing waiting: approve again refused", api(PIC, "POST", D + "/SOP-OPS-001/approve", {"effective": "2026-11-01"})[0], 400)
sd = [d for d in view(ST)["docs"]]
check("staff now see only the active document, current version only, no review data", ([d["id"] for d in sd], sd[0]["reviews"], sd[0]["lastReviewed"], [v["v"] for v in sd[0]["versions"]]), (["SOP-OPS-001"], [], "", ["1.0"]))
check("staff cannot see the file path or notes", ("fileName" in sd[0]["versions"][0], sd[0]["notes"]), (False, ""))
s, fl = api(ST, "GET", D + "/SOP-OPS-001/file"); check("staff get a link", s, 200)
gs, gb = raw("GET", fl["url"]); check("the link serves the PDF", (gs, gb[:5]), (200, b"%PDF-"))
check("staff cannot ask for a pending/other version", api(ST, "GET", D + "/SOP-OPS-001/file?v=9.9")[0], 200)   # ignored: staff always get the current one
# self approval is flagged
ps, up4 = upload(PIC); s, r4 = api(PIC, "POST", D, body(up4, title="Self approved")); sid = r4["id"]
check("self-approval allowed", api(PIC, "POST", D + "/" + sid + "/approve", {"effective": "2026-11-02"})[0], 200)
log = view(PIC)["log"]; check("self-approval flagged in the log", [e["flag"] for e in log if e["action"] == "Version Approved" and e["docId"] == sid], ["Self-Approved"])
check("tech does not get the log", "log" in view(CT), False)
check("tech sees no review data", [(d["lastReviewed"], d["reviews"]) for d in view(CT)["docs"] if d["id"] == "SOP-OPS-001"], [("", [])])
# ---- new version
ps, up5 = upload(CT); nv = lambda **kw: {"version": "1.1", "summary": "Updated wording", "file": {"key": up5["key"], "name": "v11.pdf"}, **kw}
check("staff cannot submit a version", api(ST, "POST", D + "/SOP-OPS-001/version", nv())[0], 403)
check("summary required", api(CT, "POST", D + "/SOP-OPS-001/version", nv(summary=""))[0], 400)
check("duplicate version number refused", api(CT, "POST", D + "/SOP-OPS-001/version", nv(version="1.0"))[0], 400)
check("tech submits v1.1", api(CT, "POST", D + "/SOP-OPS-001/version", nv())[0], 200)
check("second pending refused", api(CT, "POST", D + "/SOP-OPS-001/version", nv(version="1.2"))[0], 400)
check("staff still get the current file while v1.1 waits", api(ST, "GET", D + "/SOP-OPS-001/file")[1]["v"], "1.0")
check("tech can open the pending file", api(CT, "GET", D + "/SOP-OPS-001/file?v=1.1")[1]["v"], "1.1")
check("approve v1.1 supersedes v1.0", (api(DP, "POST", D + "/SOP-OPS-001/approve", {"effective": "2026-11-10"})[0], [(v["v"], v["state"]) for v in [d for d in view(DP)["docs"] if d["id"] == "SOP-OPS-001"][0]["versions"]]), (200, [("1.0", "superseded"), ("1.1", "current")]))
ps, up6 = upload(CT); api(CT, "POST", D + "/SOP-OPS-001/version", {"version": "1.2", "summary": "Bad idea", "file": {"key": up6["key"], "name": "v12.pdf"}})
check("reject needs a reason", api(PIC, "POST", D + "/SOP-OPS-001/reject", {})[0], 400)
check("reject removes the pending version", (api(PIC, "POST", D + "/SOP-OPS-001/reject", {"reason": "Not needed"})[0], [v["v"] for v in [d for d in view(PIC)["docs"] if d["id"] == "SOP-OPS-001"][0]["versions"]]), (200, ["1.0", "1.1"]))
check("rejecting a first draft removes the document", (api(PIC, "POST", D + "/SOP-OPS-002/reject", {"reason": "Duplicate"})[1].get("removed"), "SOP-OPS-002" in [d["id"] for d in view(PIC)["docs"]]), (True, False))
# ---- review
check("tech cannot mark reviewed", api(CT, "POST", D + "/SOP-OPS-001/review", {"outcome": "ok", "date": today})[0], 403)
check("future review date refused", api(DP, "POST", D + "/SOP-OPS-001/review", {"outcome": "ok", "date": "2999-01-01"})[0], 400)
check("changes needed requires a comment", api(DP, "POST", D + "/SOP-OPS-001/review", {"outcome": "chg", "date": today})[0], 400)
check("review: no changes", api(DP, "POST", D + "/SOP-OPS-001/review", {"outcome": "ok", "date": today})[0], 200)
d1 = [d for d in view(DP)["docs"] if d["id"] == "SOP-OPS-001"][0]; check("last reviewed moves", d1["lastReviewed"], today)
check("review: changes needed -> under review", (api(DP, "POST", D + "/SOP-OPS-001/review", {"outcome": "chg", "date": today, "comment": "Update call-back step"})[0], [d for d in view(DP)["docs"] if d["id"] == "SOP-OPS-001"][0]["underReview"]), (200, True))
check("staff still see an under-review document", "SOP-OPS-001" in [d["id"] for d in view(ST)["docs"]], True)
check("draft cannot be reviewed", api(DP, "POST", D + "/FRM-IMM-001/review", {"outcome": "ok", "date": today})[0], 400)
# ---- edit, retire, restore
check("staff cannot edit", api(ST, "POST", D + "/SOP-OPS-001/edit", {"title": "x"})[0], 403)
check("tech edits title and cycle", api(CT, "POST", D + "/SOP-OPS-001/edit", {"title": "Telephone Order And Transfer Intake", "cycle": 6, "notes": "n"})[0], 200)
d1 = [d for d in view(DP)["docs"] if d["id"] == "SOP-OPS-001"][0]; check("edit saved", (d1["title"], d1["cycle"], d1["notes"]), ("Telephone Order And Transfer Intake", 6, "n"))
check("bad cycle refused", api(CT, "POST", D + "/SOP-OPS-001/edit", {"cycle": 500})[0], 400)
check("tech cannot retire", api(CT, "POST", D + "/SOP-OPS-001/retire", {"reason": "x"})[0], 403)
check("retire needs a reason", api(DP, "POST", D + "/SOP-OPS-001/retire", {})[0], 400)
check("a draft cannot be retired", api(DP, "POST", D + "/FRM-IMM-001/retire", {"reason": "x"})[0], 400)
check("retire", api(DP, "POST", D + "/SOP-OPS-001/retire", {"reason": "Replaced by SOP-OPS-009"})[0], 200)
check("retired is hidden from staff and their file link", ("SOP-OPS-001" in [d["id"] for d in view(ST)["docs"]], api(ST, "GET", D + "/SOP-OPS-001/file")[0]), (False, 404))
check("retired still visible to tech", [d["retired"] for d in view(CT)["docs"] if d["id"] == "SOP-OPS-001"], [True])
check("restore", (api(DP, "POST", D + "/SOP-OPS-001/restore", {})[0], "SOP-OPS-001" in [d["id"] for d in view(ST)["docs"]]), (200, True))
# ---- pins are per person
check("pin", api(ST, "POST", D + "/pins", {"ids": ["SOP-OPS-001", "NOPE", "FRM-IMM-001"]})[0], 200)
check("pins kept per person; unseen/invalid ones dropped", (view(ST)["pins"], view(PIC)["pins"]), (["SOP-OPS-001"], []))
# ---- the log
ev = view(PIC)["log"]; check("events recorded", sorted(set(e["action"] for e in ev)), sorted(["Document Added", "Version Approved", "Version Submitted", "Version Rejected", "Reviewed", "Details Edited", "Retired", "Restored"]))
check("events name the person and duty", [(e["by"], e["duty"]) for e in ev if e["action"] == "Retired"], [("DP1", "dp")])
# ---- employee IDs and PINs
us = {u["login"]: u for u in USERS()}
check("employee IDs: assigned, 4 digits, all different", (all(re.fullmatch(r"\d{4}", u["empId"]) for u in us.values()), len({u["empId"] for u in us.values()}) == len(us)), (True, True))
check("PIN states listed", (us["pic1"]["pin"], us["staff1"]["pin"]), ("set", "none"))
check("approver without a PIN is asked to set one", (api(ST, "POST", "/me/pin", {"pin": "1234"})[0], api(ST, "POST", "/me/pin", {"pin": "1111"})[0], api(ST, "POST", "/me/pin", {"pin": "12a4"})[0]), (400, 400, 400))
s_, r_ = _api0(O, "POST", D + "/SOP-OPS-001/review", {"outcome": "ok", "date": today}); check("signing without a PIN is refused with a code", (s_, r_.get("pin")), (400, None))
ps_, ups = upload(CT); s_, rr = _api0(CT, "POST", D, body(ups, title="PIN Probe")); pid = rr["id"]
DP2 = mk("dp2", P, "pharmacist", "dp"); assert api(O, "POST", "/owner/users/" + subof("dp2"), {"initials": "DQ"})[0] == 200
check("an approver with no PIN yet gets a pin-not-set answer", (lambda x: (x[0], x[1].get("pin")))(_api0(DP2, "POST", D + "/" + pid + "/approve", {"effective": "2026-11-01", "pin": "4826"})), (409, "pin-not-set"))
DP3 = mk("dp3", P, "pharmacist", "dp"); assert _api0(DP3, "POST", "/me/pin", {"pin": "4826"})[0] == 200
check("no initials: signing refused before the PIN is even tried", (lambda x: (x[0], "initials" in x[1]["error"]))(_api0(DP3, "POST", D + "/" + pid + "/approve", {"effective": "2026-11-01", "pin": "4826"})), (400, True))
check("wrong PIN counts and says how many tries are left", (lambda x: (x[0], "4 tries" in x[1]["error"]))(_api0(PIC, "POST", D + "/" + pid + "/approve", {"effective": "2026-11-01", "pin": "1111"})), (400, True))
check("right PIN still works after a wrong try (counter resets)", _api0(PIC, "POST", D + "/" + pid + "/approve", {"effective": "2026-11-01", "pin": "3951"})[0], 200)
# lockout on a fresh draft: five wrong tries lock, even the right PIN is then refused
ps_, ups = upload(CT); s_, rr = _api0(CT, "POST", D, body(ups, title="Lock Probe")); lid = rr["id"]
res = [_api0(DP, "POST", D + "/" + lid + "/approve", {"effective": "2026-11-01", "pin": "0001"}) for _ in range(5)]
check("five wrong tries: last one reports the lock", (res[0][0], res[4][0], res[4][1].get("pin")), (400, 403, "pin-locked"))
check("locked: the right PIN is refused too", (lambda x: (x[0], x[1].get("pin")))(_api0(DP, "POST", D + "/" + lid + "/approve", {"effective": "2026-11-01", "pin": "7264"})), (403, "pin-locked"))
check("locked: listed as locked", [u["pin"] for u in USERS() if u["login"] == "dp1"], ["locked"])
check("cannot change a locked PIN by knowing it", _api0(DP, "POST", "/me/pin", {"current": "7264", "pin": "5918"})[0], 403)
check("a person cannot issue their own temporary PIN", _api0(DP, "POST", "/owner/users/" + subof("dp1") + "/pin-reset", {})[0], 403)
check("another approver (PIC) cannot issue one either", _api0(PIC, "POST", "/owner/users/" + subof("dp1") + "/pin-reset", {})[0], 403)
s_, tp = _api0(O, "POST", "/owner/users/" + subof("dp1") + "/pin-reset", {}); check("Account Owner issues a temporary PIN", (s_, bool(re.fullmatch(r"\d{4}", tp.get("tempPin", "")))), (200, True))
check("temporary PIN cannot sign: must be replaced first", (lambda x: (x[0], x[1].get("pin")))(_api0(DP, "POST", D + "/" + lid + "/approve", {"effective": "2026-11-01", "pin": tp["tempPin"]})), (409, "pin-temp"))
check("replacing it needs the temporary one", _api0(DP, "POST", "/me/pin", {"current": "0000", "pin": "5918"})[0], 400)
check("must differ from the temporary PIN", _api0(DP, "POST", "/me/pin", {"current": tp["tempPin"], "pin": tp["tempPin"]})[0] in (400,), True)
check("new PIN set with the temporary one", _api0(DP, "POST", "/me/pin", {"current": tp["tempPin"], "pin": "5918"})[0], 200); PINS[DP] = "5918"
check("signing works again with the new PIN", _api0(DP, "POST", D + "/" + lid + "/approve", {"effective": "2026-11-01", "pin": "5918"})[0], 200)
check("changing needs the current PIN", (_api0(DP, "POST", "/me/pin", {"current": "9999", "pin": "6482"})[0], _api0(DP, "POST", "/me/pin", {"current": "5918", "pin": "6482"})[0]), (400, 200)); PINS[DP] = "6482"
check("the Account Owner's own PIN is reset only by the host", (_api0(PIC, "POST", "/owner/users/" + subof("owner") + "/pin-reset", {})[0], _api0(H, "POST", "/host/users/" + subof("owner") + "/pin-reset", {})[0]), (403, 200)); del PINS[O]
log_ = view(O)["log"]; check("signed entries carry initials and employee ID", [(e["ini"], bool(e["emp"])) for e in log_ if e["action"] == "Version Approved"][0], ("DP", True))
check("review history shows the signer's initials", [r["ini"] for d in view(O)["docs"] if d["id"] == "SOP-OPS-001" for r in d["reviews"] if r["outcome"].startswith("Reviewed")][:1], ["DP"])
check("the PIN is not exposed by the people list", "pin\": {" not in json.dumps(api(O, "GET", "/owner/users")[1]) and "h\":" not in json.dumps(api(O, "GET", "/owner/users")[1]), True)
# ---- reps and privileges
node({"makeHost": {"login": "rep1", "name": "Rep One", "phone": "8175559998", "tempPassword": "reptemp12ab", "role": "rep"}})
ra = login("rep1", "reptemp12ab", "reppass9999"); R = ra["IdToken"]; api(R, "POST", "/host-unlock", {"password": "reppass9999", "accessToken": ra["AccessToken"]})
stu = [u for u in api(O, "GET", "/owner/users")[1]["users"] if u["login"] == "staff1"][0]
check("rep cannot grant Documents or set a duty", (api(R, "POST", "/host/users/" + stu["sub"], {"perms": {"documents": True}})[0], api(R, "POST", "/host/users/" + stu["sub"], {"docDuty": "dp"})[0]), (403, 403))
check("Account Owner can set Documents privilege", api(O, "POST", "/owner/users/" + stu["sub"], {"perms": {"documents": False}})[0], 200)
check("access follows the switch immediately", api(ST, "GET", D)[0], 403)
check("Account Owner can hold a document duty (the document view still treats the owner as Owner)", api(O, "POST", "/owner/users/" + [u for u in api(O, "GET", "/owner/users")[1]["users"] if u["owner"]][0]["sub"], {"docDuty": "dp"})[0], 200)
print("\n%d failed" % len(fails) if fails else "\nall passed"); sys.exit(1 if fails else 0)

# Documents: access rules, duties, upload, versions, approval, review, retire, file links, pins. Run ./reset.sh first.
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
# ---- reps and privileges
node({"makeHost": {"login": "rep1", "name": "Rep One", "phone": "8175559998", "tempPassword": "reptemp12ab", "role": "rep"}})
ra = login("rep1", "reptemp12ab", "reppass9999"); R = ra["IdToken"]; api(R, "POST", "/host-unlock", {"password": "reppass9999", "accessToken": ra["AccessToken"]})
stu = [u for u in api(O, "GET", "/owner/users")[1]["users"] if u["login"] == "staff1"][0]
check("rep cannot grant Documents or set a duty", (api(R, "POST", "/host/users/" + stu["sub"], {"perms": {"documents": True}})[0], api(R, "POST", "/host/users/" + stu["sub"], {"docDuty": "dp"})[0]), (403, 403))
check("Account Owner can set Documents privilege", api(O, "POST", "/owner/users/" + stu["sub"], {"perms": {"documents": False}})[0], 200)
check("access follows the switch immediately", api(ST, "GET", D)[0], 403)
check("Account Owner duty cannot be set", api(O, "POST", "/owner/users/" + [u for u in api(O, "GET", "/owner/users")[1]["users"] if u["owner"]][0]["sub"], {"docDuty": "dp"})[0], 400)
print("\n%d failed" % len(fails) if fails else "\nall passed"); sys.exit(1 if fails else 0)

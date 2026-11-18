# Suite access list: Calendar + Documents only for the named logins at NTX1, no switches. Run: SUITE_USERS='NTX1:tfisher85,mferreiro,eoviedo,mamare' bash reset.sh
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
def mk(login_, perms, acct="", duty=None, stores=True, pw=None):
    s_, r = api(O, "POST", "/owner/users", {"login": login_, "name": login_.upper(), "phone": "(817) 555-" + str(1000 + len(login_) * 7 + sum(map(ord, login_)) % 900), "smsConsent": True, "stores": {"NTX1": stores}, "acctType": acct, "perms": perms}); assert s_ == 200, r
    if duty: assert api(O, "POST", "/owner/users/" + r["user"]["sub"], {"docDuty": duty})[0] == 200
    return login(login_, r["tempPassword"], login_ + "pass12345")["IdToken"]

D = "/stores/NTX1/documents"; CAL = "/stores/NTX1/calendar"
T = {l: mk(l, {}, "", None) for l in ("tfisher85", "mferreiro", "eoviedo", "mamare", "otheruser")}   # no perms, nobody switched anything on
check("nothing was switched on for the pharmacy", [x for x in api(H, "GET", "/host/stores")[1]["stores"] if x["id"] == "NTX1"][0]["documents"], False)
for l in ("tfisher85", "mferreiro", "eoviedo", "mamare"):
    m = api(T[l], "GET", "/me")[1]; st = [x for x in m["stores"] if x["id"] == "NTX1"][0]
    check(l + ": sees Calendar and Documents with no switches", (st["calendar"], st["documents"], m["perms"]["calendar"], m["perms"]["documents"], api(T[l], "GET", CAL)[0], api(T[l], "GET", D)[0]), (True, True, True, True, 200, 200))
m = api(T["otheruser"], "GET", "/me")[1]; st = [x for x in m["stores"] if x["id"] == "NTX1"][0]
check("other user (has the reorder list): no Calendar or Documents", (st["calendar"], st["documents"], api(T["otheruser"], "GET", "/stores/NTX1/lines")[0], api(T["otheruser"], "GET", CAL)[0], api(T["otheruser"], "GET", D)[0]), (False, False, 200, 403, 403))
check("the Account Owner is not on the list: blocked too", (api(O, "GET", CAL)[0], api(O, "GET", D)[0], [x for x in api(O, "GET", "/me")[1]["stores"] if x["id"] == "NTX1"][0]["documents"]), (403, 403, False))
assert api(H, "POST", "/host/stores/NTX1", {"calendar": True, "documents": True, "changeReason": "test change reason"})[0] == 200
sub = [u for u in api(O, "GET", "/owner/users")[1]["users"] if u["login"] == "otheruser"][0]["sub"]
assert api(H, "POST", "/host/users/" + sub, {"perms": {"calendar": True, "documents": True}})[0] == 200
check("even with the switches and privileges on, a user not on the list stays out", (api(T["otheruser"], "GET", CAL)[0], api(T["otheruser"], "GET", D)[0], api(T["otheruser"], "POST", D + "/upload-url", {"name": "x.pdf", "size": 10})[0]), (403, 403, 403))
check("a named user can start the calendar (not only the Account Owner)", api(T["tfisher85"], "POST", CAL + "/commit", {"config": {"profile": {"name": "NorTex"}}})[0], 200)
check("a non-listed user cannot write to the calendar", api(T["otheruser"], "POST", CAL + "/commit", {"config": {"profile": {"name": "x"}}})[0], 403)
tsub = [u for u in api(O, "GET", "/owner/users")[1]["users"] if u["login"] == "tfisher85"][0]["sub"]; check("people list shows the Documents privilege for a named user, so the duty can be set", [u["perms"]["documents"] for u in api(O, "GET", "/owner/users")[1]["users"] if u["login"] == "tfisher85"], [True])
assert api(O, "POST", "/owner/users/" + tsub, {"docDuty": "pic"})[0] == 200
s_, up = api(T["tfisher85"], "POST", D + "/upload-url", {"name": "x.pdf", "size": len(PDF)}); raw("PUT", up["url"], PDF, {"content-type": "application/pdf"})
check("a named user can add a document", api(T["tfisher85"], "POST", D, {"title": "T", "type": "SOP", "area": "OPS", "format": "Printable PDF", "cycle": 12, "basis": "", "version": "1.0", "file": {"key": up["key"], "name": "x.pdf"}})[0], 200)
print("\nFAILED:" if fails else "\nall passed", fails if fails else "")
sys.exit(1 if fails else 0)

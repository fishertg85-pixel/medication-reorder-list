# PIN requirement OFF (default): signing needs initials only, no PIN. Run ./reset.sh first (without PIN_REQUIRED).
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

D = "/stores/NTX1/documents"; assert api(H, "POST", "/host/stores/NTX1", {"documents": True, "changeReason": "test change reason"})[0] == 200
def sub(l): return [u for u in api(O, "GET", "/owner/users")[1]["users"] if u["login"] == l][0]["sub"]
DP = mk("dp1", {"documents": True}, "pharmacist", "dp")
s_, up = api(DP, "POST", D + "/upload-url", {"name": "x.pdf", "size": len(PDF)}); raw("PUT", up["url"], PDF, {"content-type": "application/pdf"})
s_, r = api(DP, "POST", D, {"title": "T", "type": "SOP", "area": "OPS", "format": "Printable PDF", "cycle": 12, "basis": "", "version": "1.0", "file": {"key": up["key"], "name": "x.pdf"}}); did = r["id"]
check("/me says the PIN is not required", api(DP, "GET", "/me")[1].get("pinRequired"), False)
check("no initials: signing refused", api(DP, "POST", D + "/" + did + "/approve", {"effective": "2026-11-01"})[0], 400)
assert api(O, "POST", "/owner/users/" + sub("dp1"), {"initials": "DP"})[0] == 200
check("with initials and no PIN: approve works", api(DP, "POST", D + "/" + did + "/approve", {"effective": "2026-11-01"})[0], 200)
check("review works without a PIN", api(DP, "POST", D + "/" + did + "/review", {"outcome": "ok", "date": "2026-11-17"})[0], 200)
lg = api(DP, "GET", D)[1]["log"]; check("log still carries initials and employee ID", [(l.get("ini"), bool(l.get("emp"))) for l in lg if l["action"] == "Version Approved"][0], ("DP", True))
check("retire and restore work without a PIN", (api(DP, "POST", D + "/" + did + "/retire", {"reason": "x"})[0], api(DP, "POST", D + "/" + did + "/restore", {})[0]), (200, 200))
print("\nFAILED:" if fails else "\nall passed", fails if fails else "")
sys.exit(1 if fails else 0)

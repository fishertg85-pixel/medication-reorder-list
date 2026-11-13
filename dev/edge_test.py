# Edge cases for adding people: a half-made login left by a failed add, and an expired temporary password. Run after ./reset.sh
import json, sys, urllib.request, boto3, datetime
ids = json.load(open('moto_ids.json'))
c = boto3.client("cognito-idp", endpoint_url="http://localhost:5005", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="x")
d = boto3.client("dynamodb", endpoint_url="http://localhost:5005", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="x")
FAIL = []
def check(n, ok): print(("PASS " if ok else "FAIL ") + n); FAIL.append(n) if not ok else None
def login(u, pw, newpw=None):
    r = c.initiate_auth(ClientId=ids["client"], AuthFlow="USER_PASSWORD_AUTH", AuthParameters={"USERNAME":u,"PASSWORD":pw})
    if r.get("ChallengeName") == "NEW_PASSWORD_REQUIRED":
        r = c.respond_to_auth_challenge(ClientId=ids["client"], ChallengeName="NEW_PASSWORD_REQUIRED", Session=r["Session"], ChallengeResponses={"USERNAME":u,"NEW_PASSWORD":newpw})
    if r.get("ChallengeName") == "SMS_MFA":
        r = c.respond_to_auth_challenge(ClientId=ids["client"], ChallengeName="SMS_MFA", Session=r["Session"], ChallengeResponses={"USERNAME":u,"SMS_MFA_CODE":"123456"})
    a = r["AuthenticationResult"]; return a["IdToken"], a["AccessToken"]
def api(tok, method, path, body=None):
    req = urllib.request.Request("http://localhost:8790/api"+path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization":"Bearer "+tok, "content-type":"application/json"})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
T, A = login("owner", "temp12345a", "ownerpass99")
api(T, "POST", "/owner-unlock", {"password":"ownerpass99","accessToken":A})
# a login that exists in sign-in but not in the people list (an add that stopped halfway)
c.admin_create_user(UserPoolId=ids["pool"], Username="ghost", TemporaryPassword="ghostpass12", MessageAction="SUPPRESS")
s, r = api(T, "POST", "/owner/users", {"login":"ghost","name":"Real Ghost","phone":"8175556666","stores":{"NTX1":True},"smsConsent":True})
check("a half-made login from a failed add is cleared and the add goes through", s == 200 and r["user"]["login"] == "ghost")
check("and they can sign in with the new temporary password", bool(login("ghost", r["tempPassword"], "ghostnew123")[0]))
# expired temporary password shows as expired
s, r = api(T, "POST", "/owner/users", {"login":"late1","name":"Late One","phone":"8175557777","stores":{},"smsConsent":True})
tbl = [t for t in d.list_tables()["TableNames"] if "rchive" not in t][0]
old = (datetime.datetime.utcnow() - datetime.timedelta(days=4)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
d.update_item(TableName=tbl, Key={"pk":{"S":"USERS"},"sk":{"S":r["user"]["sub"]}}, UpdateExpression="SET tempIssuedAt = :o", ExpressionAttributeValues={":o":{"S":old}})
u = [x for x in api(T, "GET", "/owner/users")[1]["users"] if x["login"] == "late1"][0]
check("temporary password older than 3 days shows as expired", u["pending"] and u["tempExpired"])
s, r2 = api(T, "POST", f"/owner/users/{u['sub']}/reset-password", {})
u = [x for x in api(T, "GET", "/owner/users")[1]["users"] if x["login"] == "late1"][0]
check("a reset starts a fresh 3 days", s == 200 and u["pending"] and not u["tempExpired"])
v = [x for x in api(T, "GET", "/owner/users")[1]["users"] if x["login"] == "ghost"][0]
check("someone who signed in is not pending", v["pending"] is False)
print("\n%d failed" % len(FAIL) if FAIL else "\nall passed"); sys.exit(1 if FAIL else 0)

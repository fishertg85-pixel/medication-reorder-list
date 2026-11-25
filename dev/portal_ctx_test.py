# One login for the pharmacy app and the IronLedger employee portal: the portal sign-in client, the pre-sign-in refusal, and what each door gives.
# Run ./reset.sh first (no env). Restarts the dev server itself with PORTAL_CLIENT_ID set.
import json, subprocess, time, os, urllib.request, urllib.error, boto3
ids = json.load(open('moto_ids.json'))
c = boto3.client("cognito-idp", endpoint_url="http://localhost:5005", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="x")
fails = []
def check(name, got, want=True):
    ok = got == want; print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  got {got!r} want {want!r}'))
    if not ok: fails.append(name)
def login(u, pw, newpw=None, cid=None):
    cid = cid or ids["client"]
    r = c.initiate_auth(ClientId=cid, AuthFlow="USER_PASSWORD_AUTH", AuthParameters={"USERNAME": u, "PASSWORD": pw})
    if r.get("ChallengeName") == "NEW_PASSWORD_REQUIRED":
        r = c.respond_to_auth_challenge(ClientId=cid, ChallengeName="NEW_PASSWORD_REQUIRED", Session=r["Session"], ChallengeResponses={"USERNAME": u, "NEW_PASSWORD": newpw})
    return r["AuthenticationResult"]["IdToken"], r["AuthenticationResult"]["AccessToken"]
def api(tok, method, path, body=None):
    req = urllib.request.Request("http://localhost:8790/api" + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Authorization": "Bearer " + tok, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
def node(arg, env=None): return json.loads(subprocess.check_output(["node", "boot.mjs", json.dumps(arg)], env={**os.environ, **(env or {})}).decode().strip().splitlines()[-1])
def nomfa(u): c.admin_set_user_mfa_preference(Username=u, UserPoolId=ids["pool"], SMSMfaSettings={"Enabled": False, "PreferredMfa": False})

PC = c.create_user_pool_client(UserPoolId=ids["pool"], ClientName="nortexreorder-portal", ExplicitAuthFlows=["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"])["UserPoolClient"]["ClientId"]
nomfa("owner")
node({"makeHost": {"login": "Neo", "name": "Thomas Fisher", "phone": "8175559999", "tempPassword": "hosttemp12a"}})
nomfa("neo")
def sub(u): return c.admin_get_user(UserPoolId=ids["pool"], Username=u)["Username"]
sub_of = lambda u: [a["Value"] for a in c.admin_get_user(UserPoolId=ids["pool"], Username=u)["UserAttributes"] if a["Name"] == "sub"][0]
pre = lambda cid, u, env=None: node({"triggerSource": "PreAuthentication_Authentication", "userPoolId": ids["pool"], "callerContext": {"clientId": cid}, "request": {"userAttributes": {"sub": sub_of(u)}}}, env)

# ---- the pre-sign-in check, found by the app client's name
check("portal door: a pharmacy login is refused with the same words as a wrong password", pre(PC, "owner").get("threw"), "Incorrect ID or password.")
check("portal door: an employee gets through", "threw" not in pre(PC, "neo"))
check("pharmacy door: everyone gets through", ("threw" not in pre(ids["client"], "owner"), "threw" not in pre(ids["client"], "neo")), (True, True))
check("with the portal client id in the environment, it is found without a lookup", (pre(PC, "owner", {"PORTAL_CLIENT_ID": PC}).get("threw"), "threw" in pre(ids["client"], "owner", {"PORTAL_CLIENT_ID": PC})), ("Incorrect ID or password.", False))

# ---- restart the dev server with the portal client set
subprocess.run("pkill -x node", shell=True); time.sleep(1)
subprocess.Popen(["node", "server.mjs", "8790"], env={**os.environ, "PORTAL_CLIENT_ID": PC}, stdout=open("/tmp/dev.log", "w"), stderr=subprocess.STDOUT); time.sleep(1.5)

HP, HPA = login("neo", "hosttemp12a", "hostpass999", PC)
HA_, HAA = login("neo", "hostpass999", cid=ids["client"])
check("portal door: locked until the password is entered again", api(HP, "GET", "/host/stores")[0], 423)
api(HP, "POST", "/host-unlock", {"password": "hostpass999", "accessToken": HPA})
check("portal door: employee tools are open", api(HP, "GET", "/host/stores")[0], 200)
check("the same login through the pharmacy door gets no employee tools", (api(HA_, "GET", "/host/stores")[0], api(HA_, "GET", "/host/clients")[0]), (404, 404))
check("/me says which door is allowed", (api(HP, "GET", "/me")[1].get("portal"), api(HA_, "GET", "/me")[1].get("portal")), (True, True))

# a pharmacy owner can't get in by the portal's token either (no such login there), and a pharmacy login's token from the pharmacy door has no host reach
O, OA = login("owner", "temp12345a", "ownerpass99")
check("a pharmacy login has no portal and no employee tools", (api(O, "GET", "/me")[1].get("portal"), api(O, "GET", "/host/stores")[0]), (False, 404))

# ---- one person: employee and pharmacy user on the same login
r = api(HP, "POST", "/host/users", {"login": "both2", "name": "Both Two", "phone": "8175550188", "stores": {"NTX1": True}, "smsConsent": True}); nomfa("both2")
check("host creates an ordinary pharmacy login", r[0], 200)
check("make it an employee too", node({"makeHost": {"login": "both2", "name": "x", "phone": "8175550188"}}).get("ok"), True)
B, BA = login("both2", r[1]["tempPassword"], "both2pass12345")
check("pharmacy door: both2 is a plain user at NTX1, no employee tools", (any(s["id"] == "NTX1" for s in api(B, "GET", "/me")[1]["stores"]), api(B, "GET", "/host/stores")[0]), (True, 404))
BP, BPA = login("both2", "both2pass12345", cid=PC)
check("portal door: both2 gets in and has employee tools after unlocking", api(BP, "GET", "/me")[1].get("portal"), True)

# ---- 39.5: an employee who also works at a pharmacy is an ordinary user there (account type, role and privileges like anyone's); nothing on the pharmacy side marks the login
bsub = sub_of("both2"); nsub = sub_of("neo")
ntx = lambda tok: [x for x in api(tok, "GET", "/me")[1]["stores"] if x["id"] == "NTX1"][0]
check("before an account type is set: no pharmacist functions, no Rx Intake", (ntx(B).get("pharm"), ntx(B).get("rx")), (False, False))
api(O, "POST", "/owner-unlock", {"password": "ownerpass99", "accessToken": OA})
ulist = lambda tok, base: api(tok, "GET", "/pharmacy/NTX1/users")[1]["users"]
row = lambda tok, base: [u for u in ulist(tok, base) if u["login"] == "both2"][0]
check("the pharmacy's Users list does not say who is an IronLedger employee", ("employee" in row(O, "/owner"), row(O, "/owner").get("locked")), (False, True))
check("the employee portal still marks the login", row(HP, "/host").get("employee"), True)
ou = [u for u in api(O, "GET", "/owner/users")[1]["users"] if u["login"] == "both2"][0]
check("the Account Owner's people list carries no employee fields either", (ou.get("host"), ou.get("hostRole"), ou.get("repStores"), ou.get("locked")), (False, "", {}, True))
check("the Account Owner sets the account type, license and privileges like anyone's", api(O, "POST", "/owner/users/" + bsub, {"acctType": "pharmacist", "license": "TX12345", "perms": {"submit": True, "archive": True, "remove": True}, "permStore": "NTX1"})[0], 200)
check("...and it is saved", (row(O, "/owner")["acctType"], row(O, "/owner")["license"], row(O, "/owner")["perms"]["archive"]), ("pharmacist", "TX12345", True))
B, BA = login("both2", "both2pass12345")
check("pharmacy door: now a staff pharmacist, with Rx Intake", (ntx(B).get("pharm"), ntx(B).get("rx"), api(B, "GET", "/host/stores")[0]), (True, True, 404))
check("Rx Intake opens for them and names them as the receiving pharmacist", (lambda r: (r[0], (r[1].get("receiving") or {}).get("license")))(api(B, "GET", "/stores/NTX1/rx/config")), (200, "TX12345"))
check("sub-roles, Designated Person and final approver can be given too", api(O, "POST", "/owner/users/" + bsub, {"subs": ["immunizer"], "dp": {"797": True}, "approver": True})[0], 200)
check("the sign-in stays with IronLedger: the pharmacy cannot reset the password, issue a PIN, delete, switch off, rename or change the mobile",
      (api(O, "POST", "/owner/users/" + bsub + "/reset-password", {})[0], api(O, "POST", "/owner/users/" + bsub + "/pin-reset", {})[0], api(O, "POST", "/owner/users/" + bsub + "/delete", {})[0],
       api(O, "POST", "/owner/users/" + bsub, {"disabled": True})[0], api(O, "POST", "/owner/users/" + bsub, {"name": "X"})[0], api(O, "POST", "/owner/users/" + bsub, {"phone": "8175550000"})[0]), (403, 403, 403, 403, 403, 403))
check("the refusal does not call it a host login", "host" in api(O, "POST", "/owner/users/" + bsub + "/reset-password", {})[1].get("error", "").lower(), False)
check("they cannot change their own role from the pharmacy side (same as anyone)", api(B, "POST", "/owner/users/" + bsub, {"acctType": "pic"})[0] in (403, 404), True)
api(BP, "POST", "/host-unlock", {"password": "both2pass12345", "accessToken": BPA})
check("from the employee portal an IronLedger supervisor sets it, their own included", (api(BP, "POST", "/host/users/" + bsub, {"acctType": "pic"})[0], api(HP, "POST", "/host/users/" + bsub, {"acctType": "pharmacist", "license": "TX12345"})[0]), (200, 200))
check("an employee login with no pharmacy still takes no pharmacy role", api(HP, "POST", "/host/users/" + nsub, {"acctType": "pharmacist"})[0], 400)
check("through the portal the same person is IronLedger, not a pharmacist (no Rx Intake there)", api(BP, "GET", "/stores/NTX1/rx/config")[0], 403)
print("\n" + ("all passed" if not fails else "FAILED: " + str(fails)))

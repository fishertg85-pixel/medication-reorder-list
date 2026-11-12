import json, urllib.request, boto3, base64
ids = json.load(open('moto_ids.json'))
c = boto3.client("cognito-idp", endpoint_url="http://localhost:5005", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="x")
def login(u, pw, newpw):
    r = c.initiate_auth(ClientId=ids["client"], AuthFlow="USER_PASSWORD_AUTH", AuthParameters={"USERNAME":u,"PASSWORD":pw})
    if r.get("ChallengeName") == "NEW_PASSWORD_REQUIRED":
        r = c.respond_to_auth_challenge(ClientId=ids["client"], ChallengeName="NEW_PASSWORD_REQUIRED", Session=r["Session"], ChallengeResponses={"USERNAME":u,"NEW_PASSWORD":newpw})
    print("  challenge after:", r.get("ChallengeName"))
    return r["AuthenticationResult"]["IdToken"]
def api(tok, method, path, body=None):
    req = urllib.request.Request("http://localhost:8790/api"+path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization":"Bearer "+tok, "content-type":"application/json"} if tok else {})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
T = login("owner", "temp12345a", "ownerpass99")   # case-insensitive login id
print("claims:", {k:v for k,v in json.loads(base64.urlsafe_b64decode(T.split('.')[1]+'==')).items() if k in ('sub','token_use','cognito:username','aud')})
print("me:", api(T,"GET","/me"))
print("public NTX1:", api(None,"GET","/public/pharmacy/ntx1"))
print("public bad:", api(None,"GET","/public/pharmacy/NOPE"))
print("add store:", api(T,"POST","/owner/stores",{"id":"ntx2","name":"NorTex Pharmacy - Keller","address":"1 Main St, Keller TX","phone":"817-555-0000","fax":"817-555-0001","email":"keller@example.com","license":"TX12345"}))
print("add store dup:", api(T,"POST","/owner/stores",{"id":"NTX2","name":"x"}))
png = "data:image/png;base64," + base64.b64encode(open('boot.mjs','rb').read()).decode()
print("logo:", api(T,"POST","/owner/stores/NTX2/logo",{"dataUrl":png}))
print("public NTX2 logo len:", len(api(None,"GET","/public/pharmacy/NTX2")[1].get("logo","")))
s, r = api(T,"POST","/owner/users",{"login":"maria.t","name":"Maria T","phone":"(817) 555-2222","stores":{"NTX1":True}})
print("create user:", s, r.get("tempPassword"), r.get("user",{}).get("perms"))
tmp = r["tempPassword"]; sub = r["user"]["sub"]
T2 = login("maria.t", tmp, "mariapass12")
print("maria me:", api(T2,"GET","/me")[1])
print("maria NTX2 (not granted):", api(T2,"GET","/stores/NTX2/lines"))
print("maria owner api:", api(T2,"GET","/owner/users"))
# commit flow
L = {"id":"l1","dateAdded":"2026-11-12","item":"ATENOLOL 25 MG TAB","ndc":"00093-0752-01","qty":1}
print("create:", api(T2,"POST","/stores/NTX1/commit",{"create":[L, dict(L,id="l2",item="LISINOPRIL 10 MG TAB",ndc="")]})[1]["lines"].__len__())
print("dup create ignored:", len(api(T2,"POST","/stores/NTX1/commit",{"create":[L]})[1]["lines"]))
st, r = api(T2,"POST","/stores/NTX1/commit",{"set":[{"id":"l1","fields":{"dist":"Anda Inc","ordered":True}}],"mem":{"00093-0752-01":{"dist":"Anda Inc","pkgSize":"100 TABLET"}}})
print("set:", [ (l["id"], l.get("dist"), l.get("ordered"), l.get("orderedBy"), l.get("addedBy")) for l in r["lines"]])
print("set on deleted line ignored:", api(T2,"POST","/stores/NTX1/commit",{"set":[{"id":"zz","fields":{"qty":3}}]})[0])
print("memory:", api(T2,"GET","/stores/NTX1/memory")[1])
# owner turns off remove permission for maria
print("perm off:", api(T,"POST",f"/owner/users/{sub}",{"perms":{"remove":False}}))
print("maria remove denied:", api(T2,"POST","/stores/NTX1/commit",{"del":["l2"]}))
# submit
arch = [{"id":"a1","dateAdded":"2026-11-12","dateSubmitted":"2026-11-12","submittedAt":"2026-11-12T16:00:00.000Z","item":"ATENOLOL 25 MG TAB","ndc":"00093-0752-01","qty":1,"dist":"Anda Inc","ordered":True},
        {"id":"a2","dateAdded":"2026-11-12","dateSubmitted":"2026-11-12","submittedAt":"2026-11-12T16:00:00.000Z","item":"LISINOPRIL 10 MG TAB","qty":1}]
print("submit:", api(T2,"POST","/stores/NTX1/commit",{"archive":arch,"del":["l1","l2"]})[1]["lines"])
print("re-submit same archive ids (no overwrite):", api(T2,"POST","/stores/NTX1/commit",{"archive":[dict(arch[0],item="HACKED")]})[0], api(T2,"GET","/stores/NTX1/archive")[1]["items"][0]["item"] if False else "")
a = api(T2,"GET","/stores/NTX1/archive")[1]
print("archive:", [(x["id"], x["item"], x.get("submittedBy")) for x in a["items"]], "cursor", a["cursor"])
print("archive by day:", len(api(T2,"GET","/stores/NTX1/archive?day=2026-11-12")[1]["items"]), len(api(T2,"GET","/stores/NTX1/archive?day=2026-11-11")[1]["items"]))
print("perm archive off:", api(T,"POST",f"/owner/users/{sub}",{"perms":{"archive":False}})[0], api(T2,"GET","/stores/NTX1/archive")[0])
print("export denied:", api(T2,"GET","/stores/NTX1/export")[0])
e = api(T,"GET","/stores/NTX1/export")[1]; print("owner export:", len(e["archive"]), len(e["reorder"]), list(e["remember"]))
# import
old = {"reorder":[{"id":"o1","dateAdded":"2026-11-01","item":"METFORMIN 500 MG TAB","qty":2}],
       "archive":[{"id":"x1","dateSubmitted":"2026-10-20","submittedAt":"2026-10-20T15:00:00.000Z","item":"AMPHETAMINE 20 MG","qty":2,"dist":"Anda Inc"}, arch[0]],
       "remember":{"00093-0752-01":{"dist":"McKesson"},"16714-0953-01":{"dist":"Anda Inc"}}}
print("import:", api(T,"POST","/stores/NTX1/import",old)[1])
print("import again:", api(T,"POST","/stores/NTX1/import",old)[1])
print("memory kept newer:", api(T,"GET","/stores/NTX1/memory")[1]["memory"]["00093-0752-01"])
print("maria import denied:", api(T2,"GET","/stores/NTX1/lines")[0], api(T2,"POST","/stores/NTX1/import",old)[0])
print("users:", [(u["login"],u["owner"],u["stores"],u["perms"],u["status"]) for u in api(T,"GET","/owner/users")[1]["users"]])
print("owner perms locked:", api(T,"POST",f"/owner/users/{api(T,'GET','/owner/users')[1]['users'][0]['sub']}",{"disabled":True}))
print("reset pw:", api(T,"POST",f"/owner/users/{sub}/reset-password",{})[1].keys())
print("disable maria:", api(T,"POST",f"/owner/users/{sub}",{"disabled":True}), api(T2,"GET","/me")[0])
print("bad login id:", api(T,"POST","/owner/users",{"login":"a b","phone":"8175550000","stores":{}}))
print("bad phone:", api(T,"POST","/owner/users",{"login":"bob","phone":"555","stores":{}}))
print("no token:", api(None,"GET","/me")[0])

import json
exec(open('api_test2.py').read().split("T = login(")[0])
T = login("owner", "temp12345a", "ownerpass99")
r0 = c.initiate_auth(ClientId=ids["client"], AuthFlow="USER_PASSWORD_AUTH", AuthParameters={"USERNAME":"owner","PASSWORD":"ownerpass99"})
r0 = r0.get("AuthenticationResult") or c.respond_to_auth_challenge(ClientId=ids["client"], ChallengeName=r0["ChallengeName"], Session=r0["Session"], ChallengeResponses={"USERNAME":"owner","SMS_MFA_CODE":"123456"})["AuthenticationResult"]
T = r0["IdToken"]
print("0 locked before unlock:", api(T,"GET","/owner/users")[0], "| unlock:", api(T,"POST","/owner-unlock",{"password":"ownerpass99","accessToken":r0["AccessToken"]})[1])
s, r = api(T,"POST","/owner/users",{"login":"eve","name":"Eve","phone":"8175553333","stores":{"NTX1":True},"perms":{"remove":False},"smsConsent":True})
E = login("eve", r["tempPassword"], "evepass1234")
api(T,"POST","/stores/NTX1/commit",{"create":[{"id":"good1","item":"ATENOLOL","dateAdded":"2026-11-12","qty":1},{"id":"good2","item":"LISINOPRIL","dateAdded":"2026-11-12","qty":1}]})
s, r = api(E,"POST","/stores/NTX1/commit",{"create":[{"id":"x1","item":"X","dateAdded":"<img src=x onerror=alert(1)>","orderedAt":"<svg onload=1>","qty":"9999999"}]})
x = [l for l in r["lines"] if l["id"]=="x1"][0]
print("1 XSS date dropped:", "dateAdded" not in x, "orderedAt" not in x, "qty:", x["qty"])
fake = {"id":"f1","lineId":"nope","dateSubmitted":"2026-11-12","submittedAt":"2026-11-12T17:00:00Z","item":"FAKE","addedBy":"Pat Owner","orderedBy":"Pat Owner"}
print("2 remove bypass via fake archive:", api(E,"POST","/stores/NTX1/commit",{"archive":[fake],"del":["good1","good2"]}))
print("   lines still there:", [l["id"] for l in api(E,"GET","/stores/NTX1/lines")[1]["lines"]])
api(T,"POST","/stores/NTX1/commit",{"set":[{"id":"good1","fields":{"ordered":True}}]})
real = {"id":"r1","lineId":"good1","dateSubmitted":"2026-11-12","submittedAt":"2026-11-12T18:00:00Z","item":"ATENOLOL","addedBy":"Spoofed","orderedBy":"Spoofed"}
print("3 legit submit of own line w/o remove perm:", api(E,"POST","/stores/NTX1/commit",{"archive":[real],"del":["good1"]})[0])
a = [x for x in api(E,"GET","/stores/NTX1/archive")[1]["items"] if x["id"]=="r1"][0]
print("   who-fields from server:", a.get("addedBy"), a.get("orderedBy"), a.get("submittedBy"))
print("4 logo on missing store:", api(T,"POST","/owner/stores/NOPE/logo",{"dataUrl":None}))
print("   stores:", [s["id"] for s in api(T,"GET","/owner/stores")[1]["stores"]])
print("5 bad % public:", api(None,"GET","/public/pharmacy/%E0%A4%A"), " neg limit:", api(T,"GET","/stores/NTX1/archive?limit=-5")[0])

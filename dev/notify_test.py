# 39.2 Notifications: opt-in, 72 h first message, 2 h urgent, 96 h PIC, no repeats, no text with names (SUITE_USERS=NTX1:owner,picu,rphu,rphv,tchu,tchv,ascu NOTIFY_TEST=1).
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



import time
cal = "/stores/NTX1/calendar"
api(O, "POST", "/owner/users/" + tch2S, {"dp": {"797": True}})
TR = "u797-air|room1"
rec = lambda i, **kw: {"id": i, "track": TR, "forDue": "2026-11-0" + i[-1], "status": "done", "completedBy": "TCHU", "completedOn": "2026-11-23", "result": "pass", "title": "Air Sampling", "review": {"status": "pending"}, **kw}
tick = lambda hrs: node({"notifyTick": {"now": int(time.time() * 1000 + hrs * 3600000)}})
NT = lambda tok, b: api(tok, "POST", "/me/notify", b)

check("no sender, nothing sent without opt-in", tick(73).get("sent"), [])
check("email needs an address", NT(PIC, {"email": True, "address": ""})[0], 400)
check("email needs a real address", NT(PIC, {"email": True, "address": "nope"})[0], 400)
check("PIC opts in by email", NT(PIC, {"email": True, "address": "pic@example.com"})[0], 200)
check("prefs read back", (lambda r: (r[1]["email"], r[1]["text"], r[1]["address"]))(api(PIC, "GET", "/me/notify")), (True, False, "pic@example.com"))
check("the phone number is masked", api(PIC, "GET", "/me/notify")[1]["phone"].startswith("(•••)"), True)
check("designated person opts in by text", NT(TCH2, {"text": True})[0], 200)
check("owner opts in by email", NT(O, {"email": True, "address": "owner@example.com"})[0], 200)

check("r1 submitted", api(TCH, "POST", cal + "/commit", {"put": {"records": [rec("r1")]}})[0], 200)
check("r1 waits on the designated person", G_ := api(O, "GET", cal)[1]["records"][0]["review"]["status"], "dp")
check("r2 submitted", api(TCH, "POST", cal + "/commit", {"put": {"records": [rec("r2")]}})[0], 200)
g = {r["id"]: r for r in api(O, "GET", cal)[1]["records"]}
check("r2 passed to final approval", api(TCH2, "POST", cal + "/commit", {"put": {"records": [{**g["r2"], "review": {"status": "pending"}}]}})[0], 200)

check("nothing at 71 hours", tick(71).get("sent"), [])
s = tick(73)["sent"]; subs = {x["sub"]: x for x in s}
check("at 73 hours the DP and the final approvers get one message each", sorted((x["kind"], x["channels"][0]) for x in s), [("waiting", "email"), ("waiting", "email"), ("waiting", "text")])
check("the PIC is not messaged before 96 hours for the DP wait... (PIC is a final approver for r2 only)", picS in subs and subs[picS]["kind"], "waiting")
check("the technician who did not opt in is skipped", tchS in subs, False)
check("text carries no patient, drug or task name", all(not any(w in x["text"].lower() for w in ("air", "sampling", "room")) for x in s), True)
check("no repeat for the same item", tick(73)["sent"], [])
s = tick(97)["sent"]
check("at 97 hours the PIC (and the owner, who is the PIC here) get the 96-hour message", (sorted(x["kind"] for x in s), picS in [x["sub"] for x in s]), (["pic", "pic"], True))
check("and not again", tick(98)["sent"], [])

check("an excursion is reported", api(TCH, "POST", cal + "/commit", {"put": {"exc": [{"id": "e1", "kind": "excursion", "date": "2026-11-24", "what": "Fridge 9 C", "handling": "Moved stock", "type": "temperature", "track": TR}]}})[0], 200)
check("nothing urgent at 1 hour", [x for x in tick(1)["sent"] if x["kind"] == "urgent"], [])
s = [x for x in tick(3)["sent"] if x["kind"] == "urgent"]
check("urgent at 2 hours to the approvers and the DP who opted in", sorted(x["channels"][0] for x in s), ["email", "email", "text"])
check("urgent not repeated", [x for x in tick(4)["sent"] if x["kind"] == "urgent"], [])

check("staff cannot change the timing", api(TCH, "POST", "/stores/NTX1/documents/notifycfg", {"firstHours": 24})[0], 403)
check("the PIC changes the first message to 24 hours", api(PIC, "POST", "/stores/NTX1/documents/notifycfg", {"firstHours": 24})[0], 200)
check("bad hours refused", api(PIC, "POST", "/stores/NTX1/documents/notifycfg", {"firstHours": 0})[0], 400)
check("timing read back", api(PIC, "GET", "/stores/NTX1/documents/notifycfg")[1]["firstHours"], 24)

import os
os.chdir(".")
unit = subprocess.check_output(["node", "-e", """
process.env.AWS_REGION='us-east-1';process.env.AWS_ENDPOINT_URL='http://localhost:5005';process.env.AWS_ACCESS_KEY_ID='x';process.env.AWS_SECRET_ACCESS_KEY='x';process.env.MAIN_TABLE='t';process.env.ARCHIVE_TABLE='a';process.env.USER_POOL_ID='p';process.env.NOTIFY_TEST='1';
const m = await import('../app/lambda/index.mjs');
const hrs = Array.from({length:7},(_,i)=> i===0?null:{o:'09:00',c:'17:00'});
const now = Date.parse('2026-11-24T23:00:00Z');  // Tuesday 5 pm Central... use two moments
const team=[{sub:'a',acctType:'pic',notify:{email:true,address:'a@b.co'},dp:{},ownerStores:{}}];
const recs=[{id:'r',status:'done',track:'u797-x|y',review:{status:'pending',since:'2026-11-01T00:00:00Z'}}];
const exc=[{id:'e',kind:'excursion',status:'open',createdAt:'2026-11-20T00:00:00Z',track:''}];
const base={store:'S',storeItem:{timezone:'America/Chicago',hours:hrs,closures:{days:[]},ownerIsPic:true},team,recs,exc,docs:[],cfg:{firstHours:72,urgentHours:2,picHours:96},sent:new Set()};
const open = m.notifyPlan({...base,nowMs:Date.parse('2026-11-24T18:00:00Z')}).map(x=>x.kind);     // 12:00 Tue Central: open
const shut = m.notifyPlan({...base,nowMs:Date.parse('2026-11-25T03:00:00Z')}).map(x=>x.kind);     // 21:00 Tue Central: closed
const sun = m.notifyPlan({...base,recs:[],nowMs:Date.parse('2026-11-29T18:00:00Z')}).map(x=>x.kind); // Sunday: closed, urgent still goes
console.log(JSON.stringify({open,shut,sun}));
"""], cwd=".", env={**os.environ}).decode().strip().splitlines()[-1]
u = json.loads(unit)
check("open hours: waiting item and urgent item collapse to one urgent message", u["open"], ["urgent"])
check("closed hours: urgent still goes out", u["shut"], ["urgent"])
check("closed day: urgent still goes out", u["sun"], ["urgent"])
base_only = subprocess.check_output(["node", "-e", """
process.env.AWS_REGION='us-east-1';process.env.AWS_ENDPOINT_URL='http://localhost:5005';process.env.AWS_ACCESS_KEY_ID='x';process.env.AWS_SECRET_ACCESS_KEY='x';process.env.MAIN_TABLE='t';process.env.ARCHIVE_TABLE='a';process.env.USER_POOL_ID='p';
const m = await import('../app/lambda/index.mjs');
const hrs = Array.from({length:7},(_,i)=> i===0?null:{o:'09:00',c:'17:00'});
const team=[{sub:'a',acctType:'pic',notify:{email:true,address:'a@b.co'},dp:{},ownerStores:{}}];
const recs=[{id:'r',status:'done',track:'u797-x|y',review:{status:'pending',since:'2026-11-01T00:00:00Z'}}];
const base={store:'S',storeItem:{timezone:'America/Chicago',hours:hrs,closures:{days:['2026-11-24']},ownerIsPic:true},team,recs,exc:[],docs:[],cfg:{firstHours:72,urgentHours:2,picHours:96},sent:new Set()};
const f=(iso,extra={})=>m.notifyPlan({...base,...extra,nowMs:Date.parse(iso)}).length;
console.log(JSON.stringify({open:f('2026-11-25T18:00:00Z'),after:f('2026-11-26T01:00:00Z'),holiday:f('2026-11-24T18:00:00Z'),sun:f('2026-11-29T18:00:00Z')}));
"""], cwd=".", env={**os.environ}).decode().strip().splitlines()[-1]
b = json.loads(base_only)
check("a waiting message goes out during open hours", b["open"], 1)
check("not after closing", b["after"], 0)
check("not on a closed day", b["holiday"], 0)
check("not on Sunday (closed)", b["sun"], 0)
check("opt out", NT(TCH2, {"email": False, "text": False})[0], 200)
print("FAILS:", fails) if fails else print("ALL OK")

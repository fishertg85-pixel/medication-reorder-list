# Shared computers: each tab keeps its own sign-in; idle sign-out. Need column: out of stock / replenish.
# Real local sign-in (moto). Run ./reset.sh first.
import json, sys, urllib.request, boto3
from playwright.sync_api import sync_playwright
BASE = 'http://localhost:8790/'
ids = json.load(open('moto_ids.json'))
c = boto3.client("cognito-idp", endpoint_url="http://localhost:5005", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="x")
FAIL = []
def check(n, ok): print(("PASS " if ok else "FAIL ") + n); FAIL.append(n) if not ok else None
def tok(u, pw, newpw=None):
    r = c.initiate_auth(ClientId=ids["client"], AuthFlow="USER_PASSWORD_AUTH", AuthParameters={"USERNAME": u, "PASSWORD": pw})
    if r.get("ChallengeName") == "NEW_PASSWORD_REQUIRED":
        r = c.respond_to_auth_challenge(ClientId=ids["client"], ChallengeName="NEW_PASSWORD_REQUIRED", Session=r["Session"], ChallengeResponses={"USERNAME": u, "NEW_PASSWORD": newpw})
    if r.get("ChallengeName") == "SMS_MFA":
        r = c.respond_to_auth_challenge(ClientId=ids["client"], ChallengeName="SMS_MFA", Session=r["Session"], ChallengeResponses={"USERNAME": u, "SMS_MFA_CODE": "123456"})
    return r["AuthenticationResult"]["IdToken"], r["AuthenticationResult"]["AccessToken"]
def api(t, m, p, b=None):
    rq = urllib.request.Request(BASE + "api" + p, method=m, data=json.dumps(b).encode() if b is not None else None, headers={"Authorization": "Bearer " + t, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(rq) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')

T, A = tok("owner", "temp12345a", "ownerpass99")
api(T, "POST", "/owner-unlock", {"password": "ownerpass99", "accessToken": A})
s, r = api(T, "POST", "/owner/users", {"login": "tech2", "name": "Tech Two", "phone": "8175551616", "stores": {"NTX1": True}, "smsConsent": True})
tech_pw = "techpass123"; tok("tech2", r["tempPassword"], tech_pw)
# Need column on the server
s, r = api(T, "POST", "/stores/NTX1/commit", {"create": [
    {"id": "l1", "dateAdded": "2026-11-13", "item": "ATENOLOL 25 MG TAB", "ndc": "00093075201", "mfr": "Teva", "qty": 2, "need": "out"},
    {"id": "l2", "dateAdded": "2026-11-13", "item": "LISINOPRIL 10 MG TAB", "qty": 1, "need": "restock"},
    {"id": "l3", "dateAdded": "2026-11-13", "item": "METFORMIN 500 MG TAB", "qty": 1, "need": "bogus"}], "set": [], "del": [], "archive": [], "mem": {}})
lines = {l["id"]: l for l in api(T, "GET", "/stores/NTX1/lines")[1]["lines"]}
check("server keeps Out of stock / Replenish", lines["l1"].get("need") == "out" and lines["l2"].get("need") == "restock")
check("server drops anything else", "need" not in lines["l3"])

def sign_in(p, user, pw):
    p.wait_for_selector('#liUser:visible')
    p.fill('#liPharm', 'NTX1'); p.fill('#liUser', user); p.fill('#liPass', pw); p.click('#liGo')
    p.wait_for_selector('#tabs:visible, #liCode:visible', timeout=10000)
    if p.is_visible('#liCode'): p.fill('#liCodeIn', '123456'); p.click('#liCodeGo'); p.wait_for_selector('#tabs:visible')
who = lambda p: p.inner_text('#userBadge') if p.locator('#userBadge').count() else p.inner_text('header')

with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={'width': 1280, 'height': 900})   # one browser, like the front counter
    errs = []
    a = ctx.new_page(); a.on('pageerror', lambda e: errs.append(str(e))); a.on('dialog', lambda d: d.accept())
    a.route('**/clinicaltables.nlm.nih.gov/**', lambda r, q: r.fulfill(status=200, body='[0,[],{},[]]', headers={'Access-Control-Allow-Origin': '*'}))
    a.goto(BASE); sign_in(a, 'owner', 'ownerpass99')
    check('tab A signed in as the Account Owner', a.eval_on_selector('#acctBtn', "e => e.style.display !== 'none'"))
    bp = ctx.new_page(); bp.on('pageerror', lambda e: errs.append(str(e))); bp.on('dialog', lambda d: d.accept()); bp.goto(BASE)
    bp.wait_for_selector('#liUser:visible, #tabs:visible')
    check("a new tab in the same browser does not open the Account Owner's session", bp.is_visible('#liUser') and not bp.is_visible('#tabs'))
    sign_in(bp, 'tech2', tech_pw)
    check('tab B signs in as the employee', bp.is_visible('#tabs') and 'Account Owner' not in bp.inner_text('#tabs'))
    a.reload(); a.wait_for_selector('#tabs:visible')
    check('reloading tab A keeps it the Account Owner', a.eval_on_selector('#acctBtn', "e => e.style.display !== 'none'"))
    bp.reload(); bp.wait_for_selector('#tabs:visible')
    check('reloading tab B keeps it the employee', 'Account Owner' not in bp.inner_text('#tabs'))
    a.close()
    a2 = ctx.new_page(); a2.goto(BASE); a2.wait_for_selector('#liUser:visible, #tabs:visible')
    check('closing a tab signs that person out; reopening asks for a sign-in', a2.is_visible('#liUser'))
    a2.close()
    # Need column in the list
    bp.wait_for_selector('#listBody tr[data-id="l1"]')
    r1 = bp.locator('#listBody tr[data-id="l1"]'); r2 = bp.locator('#listBody tr[data-id="l2"]'); r3 = bp.locator('#listBody tr[data-id="l3"]')
    check('Out of stock line shows it and is marked', r1.locator('select[data-f=need]').input_value() == 'out' and 'is-out' in (r1.get_attribute('class') or ''))
    check('Replenish line shows it', r2.locator('select[data-f=need]').input_value() == 'restock')
    check('line with no choice asks for one', r3.locator('select[data-f=need]').input_value() == '')
    check('count of out-of-stock lines shown', 'Out of stock: 1' in bp.inner_text('#orderedCount'))
    r3.locator('select[data-f=need]').select_option('out'); bp.wait_for_timeout(1500)
    lines = {l["id"]: l for l in api(T, "GET", "/stores/NTX1/lines")[1]["lines"]}
    check('choosing Out of stock saves it', lines["l3"].get("need") == "out")
    check('count updates', 'Out of stock: 2' in bp.inner_text('#orderedCount'))
    order = bp.eval_on_selector_all('#listBody tr[data-id]', 'els => els.map(e => e.dataset.id)')
    check('out-of-stock lines move to the top', order == ['l1', 'l3', 'l2'])
    bp.screenshot(path='screenshots/need_column.png')
    # submit -> archive keeps it
    bp.click('#submitBtn'); bp.wait_for_timeout(2500)
    arch = api(T, "GET", "/stores/NTX1/archive")[1]
    items = arch.get("items") or arch.get("archive") or []
    check('Need is not kept after submission', len(items) >= 3 and not any(x.get("need") for x in items))
    mem = api(T, "GET", "/stores/NTX1/memory")[1]
    rem = mem.get("remember") or mem.get("memory") or mem
    check("last order's quantity is remembered for the NDC", (rem.get("00093075201") or {}).get("qty") == 2)
    bp.click('#archOpen'); bp.wait_for_timeout(1200)
    bp.locator('#archBody tr.order').first.click(); bp.wait_for_timeout(400)
    check('archive has no Need column', 'Out of stock' not in bp.inner_text('#archBody') and 'Need' not in bp.inner_text('#panel-archive thead'))
    bp.click('#tabs [data-tab=list]'); bp.wait_for_timeout(300)
    bp.evaluate("addLine({ndc:'00093075201', ndc10:'0093-0752-01', name:'atenolol', strength:'25 mg', form:'Tab', mfr:'Teva Pharmaceuticals USA', src:'rxnav'})")
    bp.wait_for_selector('#listBody tr[data-ndc="00093075201"]')
    nr = bp.locator('#listBody tr[data-ndc="00093075201"]'); q = nr.locator('input[data-f=qty]')
    check('same NDC again: quantity from last time, shown yellow', q.input_value() == '2' and 'lastqty' in (q.get_attribute('class') or ''))
    check('same NDC again: Need is not filled in', nr.locator('select[data-f=need]').input_value() == '')
    bp.screenshot(path='screenshots/last_qty.png')
    q.fill('3'); q.press('Tab'); bp.wait_for_timeout(1500)
    q = bp.locator('#listBody tr[data-ndc="00093075201"] input[data-f=qty]')
    check('changing the quantity clears the yellow', q.input_value() == '3' and 'lastqty' not in (q.get_attribute('class') or ''))
    bp.screenshot(path='screenshots/need_archive.png')
    # idle sign-out
    bp.click('#tabs [data-tab=list]')
    bp.evaluate("lastUse = Date.now() - (15*60*1000 - 30000)"); bp.wait_for_selector('#idleWarn:visible', timeout=5000)
    check('a notice shows in the last minute', 'Signing out in' in bp.inner_text('#idleWarn'))
    bp.screenshot(path='screenshots/idle_warning.png')
    bp.mouse.click(5, 5); bp.wait_for_timeout(1500)
    check('any click keeps you signed in', not bp.is_visible('#idleWarn') and bp.is_visible('#tabs'))
    bp.evaluate("lastUse = Date.now() - 16*60*1000"); bp.wait_for_selector('#liUser:visible', timeout=5000)
    check('signs out after 15 minutes without use', 'without use' in bp.inner_text('#liMsg') and bp.input_value('#liUser') == '')
    bp.reload(); bp.wait_for_selector('#liUser:visible, #tabs:visible')
    check('and stays signed out after a reload', bp.is_visible('#liUser'))
    check('no script errors', not errs); print(errs) if errs else None
    b.close()
print("\n%d failed" % len(FAIL) if FAIL else "\nall passed"); sys.exit(1 if FAIL else 0)

# Calendar tab: uses the whole window width; the calendar on the left, a task column on the right (overdue, due soon, coming up, no record). Run ./reset.sh first.
import json, urllib.request, boto3, sys
from playwright.sync_api import sync_playwright
ids = json.load(open('moto_ids.json')); BASE = 'http://localhost:8790/'
c = boto3.client("cognito-idp", endpoint_url="http://localhost:5005", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="x")
fails = []
def check(name, got, want):
    ok = got == want; print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  got {got!r} want {want!r}'))
    if not ok: fails.append(name)
def tokens(u, pw, newpw):
    r = c.initiate_auth(ClientId=ids["client"], AuthFlow="USER_PASSWORD_AUTH", AuthParameters={"USERNAME": u, "PASSWORD": pw})
    if r.get("ChallengeName") == "NEW_PASSWORD_REQUIRED":
        r = c.respond_to_auth_challenge(ClientId=ids["client"], ChallengeName="NEW_PASSWORD_REQUIRED", Session=r["Session"], ChallengeResponses={"USERNAME": u, "NEW_PASSWORD": newpw})
    return r["AuthenticationResult"]
def api(tok, method, path, body=None):
    req = urllib.request.Request("http://localhost:8790/api" + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Authorization": "Bearer " + tok, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
c.admin_set_user_mfa_preference(Username="owner", UserPoolId=ids["pool"], SMSMfaSettings={"Enabled": False, "PreferredMfa": False})   # the local stand-in has no real text codes
a = tokens("owner", "temp12345a", "ownerpass99"); O = a["IdToken"]
api(O, "POST", "/owner-unlock", {"password": "ownerpass99", "accessToken": a["AccessToken"]})
import subprocess
def node(arg): return json.loads(subprocess.check_output(["node", "boot.mjs", json.dumps(arg)]).decode().strip().splitlines()[-1])
node({"makeHost": {"login": "Neo", "name": "Thomas Fisher", "phone": "8175559999", "tempPassword": "hosttemp12a"}})
c.admin_set_user_mfa_preference(Username="neo", UserPoolId=ids["pool"], SMSMfaSettings={"Enabled": False, "PreferredMfa": False})
h = tokens("neo", "hosttemp12a", "hostpass999"); H = h["IdToken"]; api(H, "POST", "/host-unlock", {"password": "hostpass999", "accessToken": h["AccessToken"]})
CL = lambda **k: dict({"legalName": "NorTex Holdings LLC", "entityType": "llc", "ein": "12-3456789", "address": "100 Main St", "city": "Haslet", "state": "TX", "zip": "76052"}, **k)
client1 = api(H, "POST", "/host/clients", CL())[1]["id"]; ENT = {"clientId": client1, "entityLegalName": "Other Pharmacy LLC", "entityType": "llc", "ein": "98-7654321"}
api(H, "POST", "/host/stores", {"id": "NTX2", "name": "Other Pharmacy", **ENT}); api(H, "POST", "/host/stores/NTX2/owner", {"owner": {"login": "owner"}}); api(H, "POST", "/host/stores/NTX1", {"calendar": True})      # the host (IronLedger) switches the Calendar on and sets services
api(H, "POST", "/host/stores/NTX1", {"services": ["controlled", "sterile", "immunizations"], "npi": "1234567893", "dea": "AB1234563", "hours": [None] + [{"o": "08:00", "c": "20:00"}] * 5 + [None]})
def mk(l, stores, cal, ph):
    s, r = api(O, "POST", "/owner/users", {"login": l, "name": l.upper(), "phone": ph, "smsConsent": True, "stores": stores, "perms": {"calendar": cal}}); assert s == 200, r; return r["tempPassword"]
tA = mk("cala", {"NTX1": True, "NTX2": True}, True, "(817) 555-0101"); tB = mk("calb", {"NTX1": True}, False, "(817) 555-0102")
def signin(p, pharm, user, pw, newpw=None):
    p.goto(BASE); p.wait_for_selector('#login', state='visible'); p.fill('#liPharm', pharm); p.wait_for_timeout(700)
    p.fill('#liUser', user); p.fill('#liPass', pw); p.click('#liGo'); p.wait_for_timeout(1500)
    if p.is_visible('#liNew'): p.fill('#liNew1', newpw); p.fill('#liNew2', newpw); p.click('#liNewGo'); p.wait_for_timeout(1500)
    p.wait_for_selector('#tabs', state='visible', timeout=8000); p.wait_for_timeout(800)
errs = []
with sync_playwright() as pw:
    b = pw.chromium.launch(); 
    def newpage():
        ctx = b.new_context(viewport={'width': 1840, 'height': 1000}); p = ctx.new_page(); p.on('pageerror', lambda e: errs.append(str(e))); p.on('dialog', lambda d: d.accept()); return p
    vis = lambda p: p.evaluate("getComputedStyle(document.querySelector('#tabs [data-tab=calendar]')).display !== 'none'")
    # no privilege: no tab, reorder works
    p = newpage(); signin(p, "NTX1", "calb", tB, "calbpass12345"); check("no privilege: no Calendar tab", vis(p), False); p.close()
    # privileged, not owner: sees tab, not started -> told to ask the Account Owner
    p = newpage(); signin(p, "NTX1", "cala", tA, "calapass12345"); check("privileged person sees Calendar tab at NTX1", vis(p), True)
    p.click('#tabs [data-tab=calendar]'); fr = p.frame_locator('#calFrame'); fr.locator('.card .hd').first.wait_for(timeout=8000)
    txt = fr.locator('.card').first.inner_text(); check("not started: asked to see the Account Owner, no Start button", ('Ask the Account Owner' in txt, fr.locator('[data-act=wizard]').count()), (True, 0))
    # other pharmacy: tab hidden
    p.select_option('#storeSel', 'NTX2'); p.wait_for_timeout(1200); check("tab hidden at pharmacy with Calendar off", vis(p), False)
    check("left the Calendar panel", p.evaluate("document.querySelector('#panel-calendar').classList.contains('active')"), False)
    p.select_option('#storeSel', 'NTX1'); p.wait_for_timeout(1200); check("tab back at NTX1", vis(p), True); p.close()
    # Account Owner starts the calendar; data reaches the server
    p = newpage(); signin(p, "NTX1", "owner", "ownerpass99"); check("Account Owner sees tab at NTX1", vis(p), True)
    p.click('#tabs [data-tab=calendar]'); fr = p.frame_locator('#calFrame'); fr.locator('[data-act=wizard]').wait_for(timeout=8000)
    fr.locator('[data-act=wizard]').click(); fr.locator('#f_name').wait_for()
    check("wizard pre-filled from the account: name", fr.locator('#f_name').input_value(), "NorTex Pharmacy - Haslet")
    check("wizard pre-filled: owner and programs", (fr.locator('#f_owner').input_value(), sorted(fr.locator('#f_feat input:checked').evaluate_all("els=>els.map(e=>e.value)"))), ("Pat Owner", ['bbp', 'controlled', 'sterile']))
    fr.locator('[data-act=msave]').click(); p.wait_for_timeout(2500)
    g = api(O, "GET", "/stores/NTX1/calendar")[1]; check("start saved to the server", (g["started"], g["config"]["profile"]["name"]), (True, "NorTex Pharmacy - Haslet"))
    check("calendar hours came from the account", (g["config"]["profile"]["hours"][1], g["config"]["profile"]["hours"][0]), ({"o": "08:00", "c": "20:00"}, None))
    check("audit log names the signed-in login", [l["by"] for l in g["log"]][:1], ["Pat Owner"])
    R = """e => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right), Math.round(b.top), Math.round(b.bottom)]; }"""
    p.click('#tabs [data-tab=calendar]'); fr.locator('.dayside.tside').wait_for(timeout=8000); p.wait_for_timeout(600)
    g = p.evaluate("""() => { const r = e => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right)]; }; return {frame: r(document.getElementById('calFrame')), logo: r(document.querySelector('header .il-lock')), win: innerWidth, sideways: document.documentElement.scrollWidth > innerWidth}; }""")
    check("Calendar tab: the calendar page spans the whole window (no empty margin on the left), no sideways scroll", (g["frame"], g["sideways"]), ([0, g["win"]], False))
    q = lambda sel: fr.locator(sel).first.evaluate(R)
    card, cal, side, clock = q('main .card'), q('.cal'), q('.dayside'), q('#clock')
    check("the calendar box starts under the logo's left edge and ends under the clock's right edge", (card[0], card[1]), (g["logo"][0], clock[1]))
    check("calendar on the left, task column on the right, in the same box: same top row, same bottom edge", (cal[0] < side[0], side[0] - cal[1] in range(0, 20), abs(side[1] - card[1]) <= 2, abs(side[3] - cal[3]) <= 14, side[1] - side[0]), (True, True, True, True, 380))
    check("the calendar is wider than it was (1,190 px at this window size)", cal[1] - cal[0] > 1300, True)
    tx = fr.locator('.dayside.tside').inner_text()
    heads = [h.strip().split("\n")[0] for h in fr.locator('.tside .tsh').all_inner_texts()]
    check("task column: titled Tasks with the open count; sections in order with the same names as the legend", (tx.startswith("Tasks"), "12 Open" in tx, heads), (True, True, ["Due Soon", "No Record"]))
    rows = fr.locator('.tside .sr.tk'); first = rows.first.inner_text().split("\n")
    check("each task: title, then due date, how soon, and what it is for", (rows.count(), first[0], first[1]), (12, "Monthly Controlled Substance Reconciliation", "Nov 30 · In 5 Days · NorTex Pharmacy - Haslet"))
    fit = fr.locator('body').evaluate("""() => { const t = document.querySelector('.tside .tsin'); const cut = [...document.querySelectorAll('.tside .sr.tk .tx b, .tside .sr.tk .tx span.mut')].filter(e => e.scrollWidth > e.clientWidth + 1).length; const two = [...document.querySelectorAll('.tside .sr.tk .tx b')].filter(e => { const r = document.createRange(); r.selectNodeContents(e); return new Set([...r.getClientRects()].map(x => Math.round(x.top))).size > 1; }).length; return {cut, two, sideways: t.scrollWidth > t.clientWidth, own: getComputedStyle(t).overflowY}; }""")
    check("nothing in the column is cut off or wrapped; a long list scrolls inside the column, never sideways", fit, {"cut": 0, "two": 0, "sideways": False, "own": "auto"})
    rows.first.click(); fr.locator('#modal .modal').wait_for(timeout=4000)
    check("clicking a task opens it", "Monthly Controlled Substance Reconciliation" in fr.locator('#modal').inner_text(), True)
    fr.locator('#modal [data-act=close]').first.click(); p.wait_for_timeout(300)
    fr.locator('.cal .day[data-d="2026-11-30"]').click(); fr.locator('.dayside:not(.tside)').wait_for(timeout=4000)
    side2, cal2 = q('.dayside'), q('.cal')
    check("picking a day shows that day in the same column; the calendar does not change size", (side2[:2], cal2[:2], "Mon, Nov 30, 2026" in fr.locator('.dayside').inner_text()), (side[:2], cal[:2], True))
    fr.locator('[data-act=closeside]').click(); fr.locator('.dayside.tside').wait_for(timeout=4000)
    check("Close brings the task column back", fr.locator('.tside .sr.tk').count(), 12)
    fr.locator('[data-chg=fMine]').check(); p.wait_for_timeout(400)
    n_mine = fr.locator('.tside .sr.tk').count(); fr.locator('[data-chg=fMine]').uncheck(); p.wait_for_timeout(300)
    check("the column follows the filters above the calendar", (n_mine <= 12, fr.locator('.tside .sr.tk').count()), (True, 12))
    fr.locator('[data-act=calview][data-v=week]').click(); p.wait_for_timeout(400)
    check("Weekly and Bi-Weekly keep the task column", (fr.locator('.dayside').count(), fr.locator('.calwrap.fix').count()), (1, 1))
    fr.locator('[data-act=calview][data-v=month]').click(); p.wait_for_timeout(300)
    if fr.locator('[data-act=closeside]').count(): fr.locator('[data-act=closeside]').click(); p.wait_for_timeout(300)
    p.screenshot(path='screenshots/calendar_wide_1840.png')
    p.click('#tabs [data-tab=dashboard]'); p.wait_for_timeout(800)
    d = p.evaluate("""() => { const b = document.getElementById('calFrame').getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right)]; }""")
    check("the Dashboard tab keeps its own width (unchanged)", d, [290, 1550])
    p.click('#tabs [data-tab=calendar]'); p.wait_for_timeout(800)
    check("back on Calendar: full width again", p.evaluate("""() => { const b = document.getElementById('calFrame').getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right)]; }"""), [0, 1840])
    # a narrower window: the calendar keeps the full width and the task list goes under it
    p.set_viewport_size({'width': 1440, 'height': 900}); p.wait_for_timeout(700)
    cal3, side3 = q('.cal'), q('.dayside')
    check("1440 wide: calendar full width, task list below it, no sideways scroll", (cal3[1] - cal3[0] > 1300, side3[2] >= cal3[3], side3[1] - side3[0] > 1300, p.evaluate("document.documentElement.scrollWidth > innerWidth"), fr.locator('body').evaluate("() => document.documentElement.scrollWidth > innerWidth")), (True, True, True, False, False))
    fr.locator('.cal .day[data-d="2026-11-30"]').click(); fr.locator('.dayside:not(.tside)').wait_for(timeout=4000)
    side4, cal4 = q('.dayside'), q('.cal')
    check("1440 wide: a picked day still opens on the right, beside the calendar (as before)", (side4[0] > cal4[1] - 2, side4[1] - side4[0]), (True, 380))
    p.screenshot(path='screenshots/calendar_wide_1440.png')
    p.close(); b.close()
check("no script errors", errs, [])
print("\nFAILED:", fails if fails else "none"); import sys; sys.exit(1 if fails else 0)

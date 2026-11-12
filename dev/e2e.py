import os
import json, re, sys, base64, urllib.request
from urllib.parse import urlparse, parse_qs, unquote
from playwright.sync_api import sync_playwright
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'screenshots') + '/'
import os; os.makedirs(OUT, exist_ok=True)
BASE = 'http://localhost:8790/'
# ---- stand-in NLM data (RxTerms search, RxNav NDC lists / lookups)
DRUGS = [("atenolol (Oral Pill)", [("25 mg Tab", "197379"), ("50 mg Tab", "197380")]),
         ("amphetamine-dextroamphetamine (Oral Pill)", [("5-5-5-5 mg Tab", "541363")])]
NDCS = {"197379": [("00093075201", "0093-0752-01", "Teva Pharmaceuticals USA", "100 TABLET in 1 BOTTLE (0093-0752-01)", "teva1", ""),
                   ("68180050101", "68180-501-01", "Lupin Pharmaceuticals", "100 TABLET in 1 BOTTLE (68180-501-01)", "lup1", "")],
        "541363": [("16714095301", "16714-953-01", "NorthStar Rx LLC", "100 TABLET in 1 BOTTLE (16714-953-01)", "ns1", "CII")]}
TERMS = {"197379": ("atenolol (Oral Pill)", "25 mg", "Tab", "Oral Pill", "atenolol 25 MG Oral Tablet"),
         "541363": ("amphetamine-dextroamphetamine (Oral Pill)", "5-5-5-5 mg", "Tab", "Oral Pill", "amphetamine aspartate 5 MG / amphetamine sulfate 5 MG / dextroamphetamine saccharate 5 MG / dextroamphetamine sulfate 5 MG Oral Tablet")}
def prop(n, rx):
    return {"ndcItem": n[0], "ndc10": n[1], "rxcui": rx, "splSetIdItem": n[4], "packagingList": {"packaging": [n[3]]},
            "propertyConceptList": {"propertyConcept": [{"propName": "LABELER", "propValue": n[2]}] + ([{"propName": "DCSA", "propValue": n[5]}] if n[5] else [])}}
def nlm(route, req):
    u = urlparse(req.url); q = parse_qs(u.query); body = {}
    if 'rxterms' in u.path:
        words = unquote(q.get("terms", [""])[0]).lower().split()
        hits = [d for d in DRUGS if all(any(w2.startswith(w) for w2 in d[0].lower().replace("(", " ").split()) for w in words)]
        body = [len(hits), [h[0] for h in hits], {"STRENGTHS_AND_FORMS": [[s for s, _ in h[1]] for h in hits], "RXCUIS": [[r for _, r in h[1]] for h in hits]}, []]
    elif u.path.endswith('ndcproperties.json'):
        i = q.get("id", [""])[0]
        if i in NDCS: body = {"ndcPropertyList": {"ndcProperty": [prop(n, i) for n in NDCS[i]]}}
        else:
            for rx, l in NDCS.items():
                for n in l:
                    if i in (n[0], n[1]): body = {"ndcPropertyList": {"ndcProperty": [prop(n, rx)]}}
    elif '/RxTerms/rxcui/' in u.path:
        t = TERMS.get(u.path.split('/rxcui/')[1].split('/')[0])
        body = {"rxtermsProperties": {"displayName": t[0], "strength": t[1], "rxtermsDoseForm": t[2], "route": t[3], "fullName": t[4]}} if t else {}
    route.fulfill(status=200, body=json.dumps(body), headers={"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"})
def fda(route, req): route.fulfill(status=404, body='{}', headers={"Access-Control-Allow-Origin": "*"})

# ---- simulate Cognito's first-sign-in steps (moto skips them): new password, then text-message code
FLOW = {}
def cognito(route, req):
    try: return cognito2(route, req)
    except Exception as e:
        import traceback; print('   MOCK FAIL', repr(e)); route.fulfill(status=500, body='{}')
def cognito2(route, req):
    tgt = req.headers.get('x-amz-target', '').split('.')[-1]; b = json.loads(req.post_data or '{}')
    print('   [cog]', tgt, b.get('ChallengeName',''), (b.get('AuthParameters') or b.get('ChallengeResponses') or {}).get('USERNAME',''))
    if tgt == 'InitiateAuth' and b.get('AuthFlow') == 'USER_PASSWORD_AUTH':
        u = b['AuthParameters']['USERNAME']; pw = b['AuthParameters']['PASSWORD']
        FLOW[u] = pw
        if u in WANT_CHALLENGE and not WANT_CHALLENGE[u].get('done'):
            return route.fulfill(status=200, body=json.dumps({"ChallengeName": "NEW_PASSWORD_REQUIRED", "Session": "s1", "ChallengeParameters": {}}))
        return route.fulfill(status=200, body=json.dumps({"ChallengeName": "SMS_MFA", "Session": "s2:" + u, "ChallengeParameters": {"CODE_DELIVERY_DESTINATION": "+*******1234"}}))
    if tgt == 'RespondToAuthChallenge':
        if b['ChallengeName'] == 'NEW_PASSWORD_REQUIRED':
            u = b['ChallengeResponses']['USERNAME']; WANT_CHALLENGE[u]['done'] = True; WANT_CHALLENGE[u]['new'] = b['ChallengeResponses']['NEW_PASSWORD']
            return route.fulfill(status=200, body=json.dumps({"ChallengeName": "SMS_MFA", "Session": "s2:" + u, "ChallengeParameters": {"CODE_DELIVERY_DESTINATION": "+*******2222"}}))
        if b['ChallengeName'] == 'SMS_MFA':
            if b['ChallengeResponses']['SMS_MFA_CODE'] != '123456':
                return route.fulfill(status=400, body=json.dumps({"__type": "CodeMismatchException", "message": "Invalid code"}))
            u = b['ChallengeResponses']['USERNAME']
            def call(target, body):
                rq = urllib.request.Request(BASE + 'cognito', method='POST', data=json.dumps(body).encode(),
                        headers={"content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSCognitoIdentityProviderService." + target})
                try: return json.loads(urllib.request.urlopen(rq).read())
                except urllib.error.HTTPError as e: print('   real cognito error', e.code, e.read()); raise
            r = call('InitiateAuth', {"ClientId": b['ClientId'], "AuthFlow": "USER_PASSWORD_AUTH", "AuthParameters": {"USERNAME": u, "PASSWORD": REALPW[u]}})
            if r.get('ChallengeName') == 'NEW_PASSWORD_REQUIRED':
                r = call('RespondToAuthChallenge', {"ClientId": b['ClientId'], "ChallengeName": "NEW_PASSWORD_REQUIRED", "Session": r['Session'], "ChallengeResponses": {"USERNAME": u, "NEW_PASSWORD": REALPW[u] + 'x1'}})
                REALPW[u] = REALPW[u] + 'x1'
            if r.get('ChallengeName') == 'SMS_MFA':
                r = call('RespondToAuthChallenge', {"ClientId": b['ClientId'], "ChallengeName": "SMS_MFA", "Session": r['Session'], "ChallengeResponses": {"USERNAME": u, "SMS_MFA_CODE": "123456"}})
            print('   [real]', list(r.keys()), r.get('ChallengeName')); return route.fulfill(status=200, body=json.dumps(r))
    route.continue_()
WANT_CHALLENGE = {}; REALPW = {"owner": "temp12345a"}

ERR = []
def page_for(ctx):
    p = ctx.new_page(); p.on('pageerror', lambda e: ERR.append(str(e))); p.on('console', lambda m: print('   [console]', m.text) if m.type in ('error','warning') else None)
    p.on('response', lambda r: print('   [resp]', r.status, r.url[-60:]) if ('/api/' in r.url or 'cognito' in r.url) and r.status >= 400 else None); p.on('dialog', lambda d: d.accept()); return p
def setup(ctx):
    for h in ("https://clinicaltables.nlm.nih.gov/**", "https://rxnav.nlm.nih.gov/**"): ctx.route(h, nlm)
    ctx.route("https://api.fda.gov/**", fda); ctx.route(BASE + 'cognito', cognito)
def login(p, pharm, user, pw, code='123456'):
    p.goto(BASE); p.wait_for_selector('#login', state='visible')
    p.fill('#liPharm', pharm); p.wait_for_timeout(700)
    p.fill('#liUser', user); p.fill('#liPass', pw); p.click('#liGo'); p.wait_for_timeout(500)
    print('   [login]', user, 'new:', p.is_visible('#liNew'), 'code:', p.is_visible('#liCode'), 'msg:', p.inner_text('#liMsg'))
    if p.is_visible('#liNew'):
        p.fill('#liNew1', 'newpass1234'); p.fill('#liNew2', 'newpass1234'); p.click('#liNewGo'); p.wait_for_timeout(500)
    if p.is_visible('#liCode'):
        print('   code screen says:', p.inner_text('#liCode').split('\n')[0], '| btn:', p.inner_text('#liCodeGo'), p.is_enabled('#liCodeGo'))
        p.fill('#liCodeIn', code); p.click('#liCodeGo'); p.wait_for_timeout(900)
def search_add(p, q, wait=900):
    if not p.is_visible('#search'): p.click('#tabs [data-tab=list]'); p.wait_for_timeout(200)
    p.click('#search'); p.fill('#search', ''); p.keyboard.type(q, delay=15); p.wait_for_timeout(wait); p.keyboard.press('Enter'); p.wait_for_timeout(900)
def items(p): return [t.split('✎')[0].strip() for t in p.locator('#listBody td.drug').all_inner_texts()]

with sync_playwright() as pw:
    b = pw.chromium.launch()
    # ================= Account Manager, desktop
    ctx = b.new_context(viewport={"width": 1400, "height": 900}); setup(ctx); p = page_for(ctx)
    p.goto(BASE); p.wait_for_selector('#login', state='visible')
    p.fill('#liPharm', 'ntx1'); p.wait_for_timeout(700); print('1 brand on sign-in:', p.inner_text('#liBrand'))
    p.fill('#liPharm', 'zzz9'); p.wait_for_timeout(700); print('  unknown ID:', p.inner_text('#liBrand'))
    p.fill('#liUser', 'owner'); p.fill('#liPass', 'wrong'); p.click('#liGo'); p.wait_for_timeout(400)
    print('  after password step (mocked):', 'code screen' if p.is_visible('#liCode') else p.inner_text('#liMsg'))
    p.fill('#liCodeIn', '999999'); p.click('#liCodeGo'); p.wait_for_timeout(500); print('  wrong code:', p.inner_text('#liMsg'))
    login(p, 'NTX1', 'owner', 'temp12345a')
    print('2 header:', p.inner_text('#storeName'), '|', p.inner_text('#whoLabel'), '| tabs:', [t for t in p.locator('#tabs button:visible').all_inner_texts()])
    search_add(p, 'ateno 25'); search_add(p, '16714-953-01', 1400)
    print('3 list:', items(p), '| added by:', p.locator('#listBody .added-by').first.inner_text())
    row = p.locator('#listBody tr').first
    row.locator('select[data-f=dist]').select_option('Anda Inc'); p.wait_for_timeout(700)
    row.locator('input[data-f=ordered]').check(); p.wait_for_timeout(700)
    # Account Manager tab: pharmacy details + logo + new pharmacy + person
    p.click('#tabs [data-tab=owner]'); p.wait_for_timeout(500)
    print('L1 owner tab locked at first:', p.is_visible('#ownLock'), '| body hidden:', not p.is_visible('#ownBody'))
    p.fill('#ownPw', 'wrongpass99'); p.click('#ownUnlock'); p.wait_for_timeout(700); print('L2 wrong password:', p.inner_text('#ownLockMsg'))
    p.fill('#ownPw', REALPW['owner']); p.click('#ownUnlock'); p.wait_for_timeout(1200)
    print('L3 unlocked:', p.is_visible('#ownBody'), '| people rows:', p.locator('table.people tbody tr').count())
    p.click('#tabs [data-tab=list]'); p.wait_for_timeout(200); p.click('#tabs [data-tab=owner]'); p.wait_for_timeout(600)
    print('L4 back within 5 min, still open:', p.is_visible('#ownBody'))
    card = p.locator('.pcard').first
    for k, v in {"address": "102 Main St, Haslet TX 76052", "phone": "817-555-0100", "fax": "817-555-0101", "email": "haslet@example.com", "license": "TX-31234"}.items():
        card.locator(f'[data-sf={k}]').fill(v)
    card.locator('[data-savestore]').click(); p.wait_for_timeout(900)
    card.locator('[data-logo]').set_input_files(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app', 'web', 'icon-512.png')); p.wait_for_timeout(1200)
    p.fill('#psId', 'ntx2'); p.fill('#ps_name', 'NorTex Pharmacy - Keller'); p.fill('#ps_address', '200 Elm St, Keller TX'); p.fill('#ps_license', 'TX-40000'); p.click('#psAdd'); p.wait_for_timeout(1200)
    print('4 pharmacies:', [t.split('\n')[0] for t in p.locator('.pcard .pid').all_inner_texts()], '| store switcher visible:', p.is_visible('#storeSel'))
    p.fill('#npName', 'Maria Tech'); p.fill('#npLogin', 'maria.t'); p.fill('#npPhone', '817-555-2222')
    (None if p.locator('[data-npst=NTX1]').is_checked() else p.locator('[data-npst=NTX1]').locator('xpath=..').click()); p.click('#npAdd'); p.wait_for_timeout(800)
    print('C1 without consent tick, person created:', p.is_visible('#passBox') and 'can sign in now' in p.inner_text('#passBox'))
    p.check('#npConsent'); p.click('#npAdd'); p.wait_for_timeout(1500)
    box = p.inner_text('#passBox'); print('5 new person box:', box.replace('\n', ' | ')[:200])
    temp = re.search(r'Temporary password: (\S+)', box).group(1)
    p.screenshot(path=OUT + 'owner_tab.png', full_page=True)
    # Setup tab: pharmacy details
    p.click('#tabs [data-tab=setup]'); p.wait_for_timeout(300); print('6 setup details:', p.inner_text('#storeInfo').replace('\n', ' | ')[:160])
    p.click('#tabs [data-tab=list]'); p.wait_for_timeout(300); p.screenshot(path=OUT + 'list_desktop.png')

    import boto3
    ddb = boto3.client('dynamodb', endpoint_url='http://localhost:5005', region_name='us-east-1', aws_access_key_id='x', aws_secret_access_key='x')
    for it in ddb.query(TableName='nortex-reorder-main', KeyConditionExpression='pk=:p', ExpressionAttributeValues={':p':{'S':'USERS'}})['Items']:
        if it.get('owner', {}).get('BOOL'): ddb.update_item(TableName='nortex-reorder-main', Key={'pk':it['pk'],'sk':it['sk']}, UpdateExpression='SET unlockUntil = :z', ExpressionAttributeValues={':z':{'N':'1'}})
    p.click('#tabs [data-tab=list]'); p.wait_for_timeout(200); p.click('#tabs [data-tab=owner]'); p.wait_for_timeout(1200)
    print('L5 server says 5 min passed -> lock shown, nothing loaded:', p.is_visible('#ownLock'), not p.is_visible('#ownBody'), '|', p.inner_text('#ownLockMsg'))
    tok = p.evaluate("SESSION.id")
    import urllib.request
    rq = urllib.request.Request(BASE + 'api/owner/users', headers={'Authorization': 'Bearer ' + tok})
    try: urllib.request.urlopen(rq); print('L6 direct API while locked: NOT BLOCKED')
    except urllib.error.HTTPError as e: print('L6 direct API while locked:', e.code, json.loads(e.read())['error'])
    p.fill('#ownPw', REALPW['owner']); p.click('#ownUnlock'); p.wait_for_timeout(1200); print('L7 unlocked again:', p.is_visible('#ownBody'))
    # client-side idle: pretend the last activity was 6 minutes ago
    p.evaluate("ownLastAct = Date.now() - 6*60*1000"); p.wait_for_timeout(16000)
    print('L8 client idle lock:', p.is_visible('#ownLock'), '| people table cleared:', p.locator('table.people').count() == 0)
    p.fill('#ownPw', REALPW['owner']); p.click('#ownUnlock'); p.wait_for_timeout(1200)
    # ================= employee, phone
    REALPW['maria.t'] = temp; WANT_CHALLENGE['maria.t'] = {}
    ctx2 = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=2); setup(ctx2); m = page_for(ctx2)
    m.goto(BASE); m.fill('#liPharm', 'NTX2'); m.wait_for_timeout(800); m.screenshot(path=OUT + 'login_phone_logo_missing.png')
    m.fill('#liPharm', 'NTX1'); m.wait_for_timeout(800); m.screenshot(path=OUT + 'login_phone.png')
    print('7 phone sign-in shows logo:', m.locator('#liBrand img').count() == 1)
    m.fill('#liPharm', 'NTX2'); m.fill('#liUser', 'maria.t'); m.fill('#liPass', temp); m.click('#liGo'); m.wait_for_timeout(500)
    m.fill('#liNew1', 'mariapass12'); m.fill('#liNew2', 'mariapass12'); m.click('#liNewGo'); m.wait_for_timeout(500)
    m.fill('#liCodeIn', '123456'); m.click('#liCodeGo'); m.wait_for_timeout(900)
    print('8 maria into NTX2 (not switched on):', m.inner_text('#liMsg'))
    login(m, 'NTX1', 'maria.t', temp)
    m.wait_for_timeout(1500); print('   state:', m.evaluate("JSON.stringify({s:!!SESSION, me:ME, step:LOGIN.step})")); print('   maria login msg:', m.inner_text('#liMsg') if m.is_visible('#login') else 'in app')
    print('9 maria sees:', items(m), '| tabs:', m.locator('#tabs button:visible').all_inner_texts(), '| store switcher:', m.is_visible('#storeSel'))
    m.screenshot(path=OUT + 'list_phone.png', full_page=True)
    # owner adds a line; maria's phone picks it up by polling
    search_add(p, 'ateno 50'); m.wait_for_timeout(9000)
    print('10 after owner adds, maria sees:', items(m))
    # owner switches off maria's "remove" permission → her × disappears after refresh
    p.click('#tabs [data-tab=owner]'); p.wait_for_timeout(900)
    if p.is_visible('#ownLock'): p.fill('#ownPw', REALPW['owner']); p.click('#ownUnlock'); p.wait_for_timeout(1200)
    p.locator('tr[data-sub] [data-uperm=remove]').locator('xpath=..').click(); p.wait_for_timeout(900)
    m.reload(); m.wait_for_timeout(1800); print('11 maria remove buttons after switch-off:', m.locator('#listBody [data-del]').count())
    # maria submits
    m.click('#submitBtn'); m.wait_for_timeout(1500)
    print('12 after submit list:', items(m))
    m.click('#tabs [data-tab=archive]'); m.wait_for_timeout(1200)
    print('13 archive (maria):', m.inner_text('#archCount'), '|', m.locator('#archBody tr.order').first.inner_text().replace('\n', ' ')[:140])
    m.locator('#archBody tr.order').first.click(); m.wait_for_timeout(300); m.screenshot(path=OUT + 'archive_phone.png', full_page=True)
    # owner switches off maria's access to NTX1 → she's told on next /me check; on reload she can't get in
    p.locator('tr[data-sub] [data-ust=NTX1]').locator('xpath=..').click(); p.wait_for_timeout(900)
    m.reload(); m.wait_for_timeout(1500); print('14 maria after access switched off:', m.inner_text('#liMsg') if m.is_visible('#login') else 'STILL IN APP')
    # import old shared-drive file into NTX2 (owner)
    old = {"reorder": [{"id": "o1", "dateAdded": "2026-11-01", "item": "AMPHETAMINE-DEXTROAMPHETAMINE 5-5-5-5 MG TAB", "qty": 2}],
           "archive": [{"id": "x1", "dateSubmitted": "2026-10-20", "submittedAt": "2026-10-20T15:00:00.000Z", "item": "LISINOPRIL 10 MG TAB", "qty": 2, "dist": "Anda Inc"}],
           "remember": {"00093-0752-01": {"dist": "McKesson", "pkgSize": "100 TABLET"}}}
    open('/tmp/old.json', 'w').write(json.dumps(old))
    p.select_option('#impStore', 'NTX2'); p.set_input_files('#impFile', '/tmp/old.json'); p.click('#impGo'); p.wait_for_timeout(2500)
    print('15 import:', p.inner_text('#impMsg'))
    p.select_option('#storeSel', 'NTX2'); p.wait_for_timeout(1500); p.click('#tabs [data-tab=list]'); p.wait_for_timeout(200)
    print('16 NTX2 list after import:', items(p), '| header:', p.inner_text('#storeName'))
    p.click('#tabs [data-tab=archive]'); p.wait_for_timeout(1200); print('17 NTX2 archive:', p.inner_text('#archCount'))
    # sign out → sign-in screen
    p.click('#signOutBtn'); p.wait_for_timeout(500); print('18 signed out shows login:', p.is_visible('#login'))
    print('ERRORS:', ERR or 'none'); b.close()

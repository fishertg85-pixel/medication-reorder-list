# Screenshots of the pharmacy account page at several window widths (run ./reset.sh first).
import json, boto3, sys
from playwright.sync_api import sync_playwright
ids = json.load(open('moto_ids.json')); BASE = 'http://localhost:8790/'
c = boto3.client("cognito-idp", endpoint_url="http://localhost:5005", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="x")
c.admin_set_user_mfa_preference(Username="owner", UserPoolId=ids["pool"], SMSMfaSettings={"Enabled": False, "PreferredMfa": False})
widths = [int(x) for x in (sys.argv[1:] or ['1920', '1366', '800'])]
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/chromium' if __import__('os').path.exists('/usr/bin/chromium') else None, args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 1920, 'height': 1000}); p = ctx.new_page(); p.on('dialog', lambda d: d.accept())
    errs = []; p.on('pageerror', lambda e: errs.append(str(e)))
    r = c.initiate_auth(ClientId=ids["client"], AuthFlow="USER_PASSWORD_AUTH", AuthParameters={"USERNAME": "owner", "PASSWORD": "temp12345a"})
    c.respond_to_auth_challenge(ClientId=ids["client"], ChallengeName="NEW_PASSWORD_REQUIRED", Session=r["Session"], ChallengeResponses={"USERNAME": "owner", "NEW_PASSWORD": "ownerpass99"})
    p.goto(BASE); p.wait_for_selector('#login', state='visible'); p.fill('#liPharm', 'NTX1'); p.wait_for_timeout(700)
    p.fill('#liUser', 'owner'); p.fill('#liPass', 'ownerpass99'); p.click('#liGo'); p.wait_for_selector('#tabs', state='visible', timeout=8000); p.wait_for_timeout(800)
    p.click('#tabs [data-tab=owner]'); p.fill('#ownPw', 'ownerpass99'); p.click('#ownUnlock')
    p.wait_for_selector('.pgrid', timeout=8000)
    for w in widths:
        p.set_viewport_size({'width': w, 'height': 1000}); p.wait_for_timeout(400)
        over = p.evaluate("""() => [...document.querySelectorAll('.pnl')].filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.dataset.pnl)""")
        docover = p.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1")
        print(w, 'panels cut off horizontally:', over, '| page scrolls sideways:', docover)
        p.locator('.pcard').first.screenshot(path=f'screenshots/pharmacy_layout_{w}.png')
    print('script errors:', errs or 'none'); b.close()

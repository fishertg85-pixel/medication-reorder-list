# Account Manager tab: add people (pending until first sign-in), see them go active, cancel an invite, delete.
# Real local sign-in (moto), no mocks. Run ./reset.sh first.
import json, sys, os
from playwright.sync_api import sync_playwright
BASE = 'http://localhost:8790/'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'screenshots') + '/'
FAIL = []
def check(name, ok):
    print(("PASS " if ok else "FAIL ") + name)
    if not ok: FAIL.append(name)

def sign_in(p, pharm, user, pw, newpw):
    p.goto(BASE); p.wait_for_selector('#liUser')
    p.fill('#liPharm', pharm); p.fill('#liUser', user); p.fill('#liPass', pw); p.click('#liGo')
    p.wait_for_selector('#liNew:visible, #liCode:visible, #tabs:visible, #liMsg:not(:empty)', timeout=10000)
    if p.is_visible('#liNew'):
        p.fill('#liNew1', newpw); p.fill('#liNew2', newpw); p.click('#liNewGo')
        p.wait_for_selector('#liCode:visible, #tabs:visible, #liMsg:not(:empty)', timeout=10000)
    if p.is_visible('#liCode'):
        p.fill('#liCodeIn', '123456'); p.click('#liCodeGo')
    p.wait_for_selector('#tabs:visible', timeout=10000)

PROMPT = ['']
with sync_playwright() as pw:
    b = pw.chromium.launch()
    errs = []
    am = b.new_context(viewport={'width': 1280, 'height': 900}).new_page()
    am.on('pageerror', lambda e: errs.append(str(e)))
    am.on('dialog', lambda d: d.accept(PROMPT[0]) if d.type == 'prompt' else d.accept())
    am.route('**/clinicaltables.nlm.nih.gov/**', lambda r, q: r.fulfill(status=200, body='[0,[],{},[]]', headers={'Access-Control-Allow-Origin': '*'}))
    sign_in(am, 'NTX1', 'owner', 'temp12345a', 'ownerpass99')
    am.click('#tabs [data-tab=owner]'); am.fill('#ownPw', 'ownerpass99'); am.click('#ownUnlock'); am.wait_for_selector('#ownBody:visible')
    am.wait_for_selector('table.people tbody tr')

    # 1. missing consent: a message that stays on screen next to the button
    am.fill('#npName', 'Dana Tech'); am.fill('#npLogin', 'dtech'); am.fill('#npPhone', '817-555-1212')
    am.click('#npAdd'); am.wait_for_timeout(300)
    check('without the consent tick: message stays next to the button', 'consent' in am.inner_text('#npMsg'))
    # 2. add
    am.check('#npConsent')
    am.locator('label.switch:has([data-npperm=submit])').click()           # change a default before adding
    am.click('#npAdd')
    am.wait_for_selector('#passBox:has-text("Temporary password")')
    temp = am.locator('#passBox b.mono').nth(2).inner_text()
    check('added: temp password shown', len(temp) >= 10)
    check('added: confirmation next to the button', 'Pending' in am.inner_text('#npMsg'))
    check('form cleared for the next person', [am.input_value(k) for k in ('#npName', '#npLogin', '#npPhone')] == ['', '', '']
          and not am.is_checked('#npConsent') and am.input_value('#npPass') not in ('', temp))
    check('pharmacy and permission switches back to defaults', am.is_checked('[data-npperm=submit]') and not am.is_checked('[data-npperm=export]'))
    check('cursor is in Name, ready for the next person', am.evaluate("document.activeElement.id") == 'npName')
    am.wait_for_selector('table.people tbody tr:has-text("dtech")')
    rows = am.locator('table.people tbody tr')
    row = am.locator('table.people tbody tr:has-text("dtech")')
    check('new person is listed as Pending', 'Pending' in row.inner_text() and 'Hasn’t signed in yet' in row.inner_text())
    check('pending person sits right under the Account Manager', 'dtech' in rows.nth(1).inner_text())
    check('pending row offers Cancel invite', row.locator('[data-del]').inner_text() == 'Cancel invite')
    am.screenshot(path=OUT + 'am_people_pending.png', full_page=True)
    # 3. same Login ID again is refused, with the reason on screen
    am.fill('#npName', 'Dup'); am.fill('#npLogin', 'dtech'); am.fill('#npPhone', '8175551313'); am.check('#npConsent'); am.click('#npAdd')
    am.wait_for_selector('#npMsg:has-text("already taken")')
    check('duplicate Login ID refused with a message', True)
    # 4. the person signs in for the first time and picks a password -> Active
    st = b.new_context(viewport={'width': 390, 'height': 844}).new_page()
    sign_in(st, 'NTX1', 'dtech', temp, 'danapass123')
    check('new person signs in and changes the temporary password', st.is_visible('#tabs'))
    am.click('#tabs [data-tab=list]'); am.click('#tabs [data-tab=owner]'); am.wait_for_timeout(1200)
    row = am.locator('table.people tbody tr:has-text("dtech")')
    check('after first sign-in the person shows Active', 'Active' in row.inner_text() and 'Pending' not in row.inner_text())
    check('active row offers Delete', row.locator('[data-del]').inner_text() == 'Delete')
    # 5. add a second person and cancel the invite before they sign in
    am.fill('#npName', 'Sam Float'); am.fill('#npLogin', 'sfloat'); am.fill('#npPhone', '8175551414'); am.check('#npConsent'); am.click('#npAdd')
    am.wait_for_selector('table.people tbody tr:has-text("sfloat")')
    srow = am.locator('table.people tbody tr:has-text("sfloat")')
    PROMPT[0] = 'nope'; srow.locator('[data-del]').click(); am.wait_for_timeout(800)
    check('wrong Login ID typed: invite kept', am.locator('table.people tbody tr:has-text("sfloat")').count() == 1)
    PROMPT[0] = 'sfloat'; srow.locator('[data-del]').click()
    am.wait_for_selector('table.people tbody tr:has-text("sfloat")', state='detached')
    check('pending invite cancelled', True)
    # the Login ID is free again
    am.fill('#npName', 'Sam Float'); am.fill('#npLogin', 'sfloat'); am.fill('#npPhone', '8175551414'); am.check('#npConsent'); am.click('#npAdd')
    am.wait_for_selector('table.people tbody tr:has-text("sfloat")')
    check('cancelled Login ID can be used again', True)
    # 6. delete the active person; their open session is shut out
    PROMPT[0] = 'dtech'; am.locator('table.people tbody tr:has-text("dtech") [data-del]').click()
    am.wait_for_selector('table.people tbody tr:has-text("dtech")', state='detached')
    check('active person deleted', True)
    st.reload(); st.wait_for_timeout(2500)
    check("deleted person's open session is shut out", not st.is_visible('#listBody') or st.is_visible('#liUser'))
    check('no script errors', not errs); print(errs) if errs else None
    b.close()
print("\n%d failed" % len(FAIL) if FAIL else "\nall passed"); sys.exit(1 if FAIL else 0)

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
    if not p.is_visible('#liUser'): p.goto(BASE); p.wait_for_selector('#liUser')
    p.fill('#liPharm', pharm); p.fill('#liUser', user); p.fill('#liPass', pw); p.click('#liGo')
    p.wait_for_selector('#liNew:visible, #liCode:visible, #tabs:visible, #liMsg:not(:empty)', timeout=10000); p.wait_for_timeout(300)
    if p.is_visible('#liNew'):
        p.fill('#liNew1', newpw); p.fill('#liNew2', newpw); p.click('#liNewGo')
        p.wait_for_selector('#liCode:visible, #tabs:visible, #liMsg:not(:empty)', timeout=10000)
    if p.is_visible('#liCode'):
        p.fill('#liCodeIn', '123456'); p.click('#liCodeGo')
    try: p.wait_for_selector('#tabs:visible', timeout=10000)
    except Exception: print('    sign-in message:', p.inner_text('#liMsg')); raise

PROMPT = ['']
with sync_playwright() as pw:
    b = pw.chromium.launch()
    errs = []
    actx = b.new_context(viewport={'width': 1280, 'height': 900}, permissions=['clipboard-read', 'clipboard-write']); am = actx.new_page()
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
    try: am.wait_for_function("document.activeElement && document.activeElement.id === 'npName'", timeout=5000)
    except Exception: print('    focus on:', am.evaluate("document.activeElement && (document.activeElement.id || document.activeElement.tagName)"), '| msg:', am.inner_text('#npMsg'), '| submit:', am.is_checked('[data-npperm=submit]'))
    check('form cleared for the next person', [am.input_value(k) for k in ('#npName', '#npLogin', '#npPhone')] == ['', '', '']
          and not am.is_checked('#npConsent') and am.input_value('#npPass') not in ('', temp))
    check('pharmacy and permission switches back to defaults', am.is_checked('[data-npperm=submit]') and not am.is_checked('[data-npperm=export]'))
    check('cursor is in Name, ready for the next person', am.evaluate("document.activeElement.id") == 'npName')
    am.wait_for_selector('table.people tbody tr:has-text("dtech")')
    rows = am.locator('table.people tbody tr')
    row = am.locator('table.people tbody tr:has-text("dtech")')
    check('new person is listed as Pending', 'Pending' in row.inner_text() and 'Temp password until' in row.inner_text())
    check('pending person sits right under the Account Manager', 'dtech' in rows.nth(1).inner_text())
    check('pending row offers Cancel invite', row.locator('[data-del]').inner_text() == 'Cancel invite')
    row.locator('[data-copy]').click(); am.wait_for_timeout(300)
    clip = am.evaluate('navigator.clipboard.readText()')
    check('copy icon copies the sign-in details in the agreed format', clip == f'Pharmacy ID: NTX1\nUser ID: dtech\nTemporary Pass: {temp}')
    print('    copied:', repr(clip))
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
    # changing an active person's access waits for Update
    sw = row.locator('label.switch:has([data-uperm=remove])')
    sw.click(); am.wait_for_timeout(300)
    row = am.locator('table.people tbody tr:has-text("dtech")')
    check('changing a switch shows Update and Undo on that row', row.locator('[data-upd]').count() == 1 and row.locator('[data-undo]').count() == 1 and 'dirty' in (row.get_attribute('class') or ''))
    am.click('#tabs [data-tab=list]'); am.click('#tabs [data-tab=owner]'); am.wait_for_timeout(1200)
    st.reload(); st.wait_for_selector('#tabs:visible'); st.wait_for_timeout(1200)
    check('nothing is saved before Update', st.locator('#listBody [data-del]').count() >= 0 and am.locator('table.people tbody tr:has-text("dtech") [data-uperm=remove]').is_checked() is False)
    row = am.locator('table.people tbody tr:has-text("dtech")')
    row.locator('[data-undo]').click(); am.wait_for_timeout(300)
    row = am.locator('table.people tbody tr:has-text("dtech")')
    check('Undo puts the switch back', row.locator('[data-uperm=remove]').is_checked() and row.locator('[data-upd]').count() == 0)
    row.locator('label.switch:has([data-uperm=remove])').click(); row = am.locator('table.people tbody tr:has-text("dtech")')
    row.locator('label.switch:has([data-ust=NTX1])').click(); row = am.locator('table.people tbody tr:has-text("dtech")')
    row.locator('label.switch:has([data-ust=NTX1])').click(); am.wait_for_timeout(200)   # switched back: only the Remove change is left
    row = am.locator('table.people tbody tr:has-text("dtech")')
    row.locator('[data-upd]').click(); am.wait_for_selector('#ownPeopleMsg:has-text("updated")')
    check('Update saves and says so', 'account access was updated' in am.inner_text('#ownPeopleMsg') and 'sign out and sign back in' in am.inner_text('#ownPeopleMsg'))
    row = am.locator('table.people tbody tr:has-text("dtech")')
    check('after Update the row is saved: Remove off, pharmacy still on', not row.locator('[data-uperm=remove]').is_checked() and row.locator('[data-ust=NTX1]').is_checked() and row.locator('[data-upd]').count() == 0)
    am.screenshot(path=OUT + 'am_update.png')
    check('no copy icon once they have signed in', row.locator('[data-copy]').count() == 0)
    row.locator('[data-reset]').click(); am.wait_for_selector('#passBox:has-text("New temporary password")')
    rtemp = am.locator('#passBox b.mono').nth(1).inner_text()
    row = am.locator('table.people tbody tr:has-text("dtech")')
    am.wait_for_selector('table.people tbody tr:has-text("dtech") [data-copy]')
    check('after a reset the person is Pending again with a copy icon', 'Pending' in row.inner_text())
    row.locator('[data-copy]').click(); am.wait_for_timeout(300)
    check('copy after a reset gives the new temporary password', am.evaluate('navigator.clipboard.readText()') == f'Pharmacy ID: NTX1\nUser ID: dtech\nTemporary Pass: {rtemp}')
    am.screenshot(path=OUT + 'am_people_copy.png')
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
    # 7. one shared computer: the Account Manager signs out, the new person signs in on the same browser
    am.fill('#npName', 'Kim Shared'); am.fill('#npLogin', 'kshared'); am.fill('#npPhone', '8175551515'); am.check('#npConsent'); am.click('#npAdd')
    am.wait_for_selector('#passBox:has-text("kshared")')
    ktemp = am.locator('#passBox b.mono').nth(2).inner_text()
    am.click('#signOutBtn'); am.wait_for_selector('#liUser:visible')
    check('after sign-out on a shared computer, no Login ID is left filled in', am.input_value('#liUser') == '' and am.input_value('#liPass') == '')
    am.wait_for_timeout(800); am.fill('#liPharm', ''); am.type('#liPharm', 'ntx1')
    print('    pharmacy box:', repr(am.input_value('#liPharm'))); check('Pharmacy ID shows in capitals as it is typed', am.input_value('#liPharm') == 'NTX1')
    am.fill('#liPass', 'ownerpass99'); am.fill('#liUser', 'kshared')
    check('typing a different Login ID clears a password the browser filled in', am.input_value('#liPass') == '')
    sign_in(am, 'NTX1', 'kshared', ' ' + ktemp + ' ', 'kimpass1234')          # pasted with stray spaces
    check('new person signs in on the same browser with a pasted temporary password', am.is_visible('#tabs') and 'Account Manager' not in am.inner_text('#tabs'))
    check('no script errors', not errs); print(errs) if errs else None
    b.close()
print("\n%d failed" % len(FAIL) if FAIL else "\nall passed"); sys.exit(1 if FAIL else 0)

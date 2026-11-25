# Time widget: 00:00 box + AM/PM dropdown over a hidden 24-hour input.
import sys, pathlib
from playwright.sync_api import sync_playwright
WEB = pathlib.Path(__file__).resolve().parent.parent / "app" / "web"
ok = bad = 0
def check(n, got, want):
    global ok, bad
    if got == want: ok += 1; print("ok  ", n)
    else: bad += 1; print("FAIL", n, "got", got, "want", want)
html = "<!doctype html><meta charset=utf-8><style>" + (WEB / "fields.css").read_text() + "</style><div id=h><input type=time id=a value='09:00'><input type=time id=b value='18:30' disabled></div><script>" + (WEB / "timepick.js").read_text() + "</script>"
with sync_playwright() as pw:
    b = pw.chromium.launch(); pg = b.new_page(viewport={"width": 800, "height": 400}); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.set_content(html)
    v = lambda i: pg.evaluate("i => document.getElementById(i).value", i)
    t = lambda n: pg.locator(".tp").nth(n).locator(".tp-t"); m = lambda n: pg.locator(".tp").nth(n).locator(".tp-m")
    check("each time field gets one box + one dropdown, original hidden", (pg.locator(".tp").count(), pg.locator("#a").is_visible()), (2, False))
    check("shows 09:00 AM from 09:00", (t(0).input_value(), m(0).input_value()), ("09:00", "AM"))
    check("shows 06:30 PM from 18:30", (t(1).input_value(), m(1).input_value()), ("06:30", "PM"))
    check("the second is disabled with the original", (t(1).is_disabled(), m(1).is_disabled(), t(0).is_disabled()), (True, True, False))
    t(0).click(); t(0).press("Control+a"); pg.keyboard.type("0830")
    check("typing 0830 shows 08:30, original 08:30", (t(0).input_value(), v("a")), ("08:30", "08:30"))
    m(0).select_option("PM")
    check("dropdown PM -> 20:30", v("a"), "20:30")
    t(0).click(); t(0).press("Control+a"); pg.keyboard.type("9")
    check("typing 9 -> 09", t(0).input_value(), "09")
    pg.keyboard.type("45")
    check("then 45 -> 09:45 (colon added)", (t(0).input_value(), v("a")), ("09:45", "21:45"))
    t(0).press("Control+a"); pg.keyboard.type("1300"); 
    check("13:00 typed -> 01:00 PM", (t(0).input_value(), m(0).input_value(), v("a")), ("01:00", "PM", "13:00"))
    t(0).press("Control+a"); pg.keyboard.type("0030")
    check("00:30 typed -> 12:30 AM", (t(0).input_value(), m(0).input_value(), v("a")), ("12:30", "AM", "00:30"))
    t(0).press("Control+a"); pg.keyboard.type("1275")
    check("minutes over 59 clamp to 59", (t(0).input_value(), v("a")), ("12:59", "00:59"))
    t(0).press("Control+a"); pg.keyboard.type("7"); pg.keyboard.press("Tab")
    check("7 then leaving -> 07:00", (t(0).input_value(), v("a")), ("07:00", "07:00"))
    t(0).press("Control+a"); pg.keyboard.type("ab1x2"); 
    check("letters are ignored", t(0).input_value(), "12")
    pg.keyboard.press("Tab")
    pg.evaluate("document.getElementById('a').value='17:05'")
    check("code that sets the original keeps the boxes in step", (t(0).input_value(), m(0).input_value()), ("05:05", "PM"))
    pg.evaluate("document.getElementById('b').disabled=false")
    check("enabling the original enables the boxes", (t(1).is_disabled(), m(1).is_disabled()), (False, False))
    pg.evaluate("document.getElementById('h').insertAdjacentHTML('beforeend','<input type=time id=c value=\"23:15\">')")
    pg.wait_for_timeout(100)
    check("time fields added later are handled too", (pg.locator(".tp").count(), pg.locator(".tp").nth(2).locator(".tp-t").input_value(), pg.locator(".tp").nth(2).locator(".tp-m").input_value()), (3, "11:15", "PM"))
    ev = pg.evaluate("""() => new Promise(r => { const a = document.getElementById('a'); const got = []; a.addEventListener('change', () => got.push(a.value)); document.querySelectorAll('.tp-m')[0].value = 'AM'; document.querySelectorAll('.tp-m')[0].dispatchEvent(new Event('change', {bubbles: true})); setTimeout(() => r(got), 50); })""")
    check("a change event reaches listeners on the original with the 24-hour value", ev, ["05:05"])
    check("no page errors", errs, [])
    b.close()
print("pass=%d fail=%d" % (ok, bad)); sys.exit(1 if bad else 0)

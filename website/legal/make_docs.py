import json, sys, html
# Fill these in, then re-run. Anything left as None shows as a highlighted [placeholder].
V = {
  "company": "IronLedger Compliance LLC",
  "brand": "IronLedger",
  "program": "IronLedger Sign-In Codes (NorTex Reorder)",
  "address": None,     # business address (same as EIN)
  "email": None,       # contact email for SMS questions
  "phone": None,       # contact phone
  "web": None,         # where privacy.html / sms-terms.html are published, e.g. https://d123.cloudfront.net or https://ironledgerrx.com
  "effective": "November 12, 2026",
}
try: V.update({k: v for k, v in json.load(open(sys.argv[1])).items() if v})
except Exception: pass
def f(k, label=None):
    v = V.get(k)
    return html.escape(v) if v else f'<mark>[{label or k.upper()}]</mark>'
WEB = (V["web"] or "").rstrip("/")
def link(path):
    if WEB: return f'<a href="{html.escape(WEB + path)}">{html.escape(WEB.replace("https://","") + path)}</a>'
    # not known yet: once these pages are published, they show their own web address
    return f'<a class="selfurl" data-path="{path}" href="{path}">{path}</a>'
SAMPLE = "IronLedger: Your NorTex Reorder sign-in code is 123456. Do not share this code. Reply STOP to opt out."
CSS = """<link rel="stylesheet" href="brand.css"><link rel="icon" href="mark.svg" type="image/svg+xml">
<style>
main.doc{max-width:820px;margin:24px auto;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:32px 38px;box-shadow:var(--shadow)}
main.doc h1{font-size:25px;margin:0 0 4px}main.doc h2{font-size:16.5px;margin:24px 0 6px;color:var(--ink-2)}
.sub{color:var(--muted);font-size:13.5px;margin-bottom:18px}mark{background:#fff3b0;color:#02182e;padding:0 3px}
.box{border:1px solid var(--line);border-radius:8px;padding:12px 14px;background:var(--panel-2)}
@media (max-width:680px){main.doc{margin:12px;padding:22px 16px}}
@media print{main.doc{margin:0;border:0;padding:0;max-width:none}}
</style>"""
def page(title, body):
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)} · IronLedger</title>{CSS}</head><body>
<header class="topbar"><div class="in"><a class="brand" href="/"><img src="mark.svg" alt=""><span class="wm">IronLedger</span></a><span class="tag">{html.escape(V['company'])}</span></div></header>
<main class="doc">{body}</main>
<script>document.querySelectorAll('.selfurl').forEach(function(a){{ if(location.host) a.textContent = location.host + a.getAttribute('data-path'); }});</script>
<footer class="foot"><img src="mark.svg" alt=""><span>2026 IronLedger LLC</span><span>·</span><span>{f('company')}</span><span>·</span><span>{f('email','CONTACT EMAIL')}</span><span>·</span><span>{f('phone','CONTACT PHONE')}</span></footer>
</body></html>"""

privacy = page("SMS Privacy Policy", f"""
<h1>Privacy Policy — Text Messaging</h1>
<div class="sub">{f('company')} · Effective {V['effective']}</div>
<p>This policy explains how {f('company')} ("IronLedger", "we") handles information for the <b>{html.escape(V['program'])}</b> text messaging program. The program sends one-time sign-in codes to employees of pharmacies that use the NorTex Reorder system hosted by IronLedger.</p>
<h2>Information we collect</h2>
<p>The employee's name, login ID, mobile phone number, the pharmacy or pharmacies they work for, and records of sign-ins and of the codes we send (date, time, delivery status). The mobile number is provided by the employee, with their signed consent, to their employer's account manager when their login is created.</p>
<h2>How we use it</h2>
<p>Only to send one-time sign-in codes when the employee signs in, to confirm it is really them, and to keep the system secure. We do not send marketing or promotional messages.</p>
<h2>Sharing</h2>
<p><b>We do not sell, rent or share mobile phone numbers or text messaging consent with anyone for marketing or promotional purposes.</b> No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Text messaging originator opt-in data and consent are not shared with any third parties.</p>
<p>We use service providers only to operate the program — Amazon Web Services delivers the messages and hosts the system — and they may use the information only to provide that service. We may disclose information if required by law.</p>
<h2>Keeping it safe and how long we keep it</h2>
<p>Information is stored encrypted on Amazon Web Services and is available only to authorized people. Mobile numbers are kept while the employee has an active login and removed or deactivated when the employer switches the login off, unless we must keep records longer by law.</p>
<h2>Your choices</h2>
<p>Reply <b>STOP</b> to any message to stop receiving texts. Reply <b>HELP</b> for help. Because codes are needed to sign in, stopping texts means you will need your account manager to set up another way to sign in. You may ask us what information we hold about you or ask for it to be corrected by contacting us below.</p>
<h2>Changes</h2>
<p>We may update this policy; the effective date above shows the latest version.</p>
<h2>Contact</h2>
<div class="box">{f('company')}<br>{f('address','BUSINESS ADDRESS')}<br>Email: {f('email','CONTACT EMAIL')} · Phone: {f('phone','CONTACT PHONE')}</div>
""")

terms = page("SMS Terms and Conditions", f"""
<h1>Text Messaging Terms and Conditions</h1>
<div class="sub">{f('company')} · Effective {V['effective']}</div>
<h2>Program</h2>
<p><b>{html.escape(V['program'])}</b> is operated by {f('company')}. It sends one-time sign-in codes by text message to employees of pharmacies that use the NorTex Reorder system hosted by IronLedger, so they can sign in securely.</p>
<div class="box">Example message: “{html.escape(SAMPLE)}”</div>
<h2>Who receives messages and how you agree</h2>
<p>Only employees whose employer has given them a login. You agree to receive these messages by signing the IronLedger SMS consent form when your login is created. Messages are transactional sign-in codes only — no marketing.</p>
<h2>Message frequency</h2>
<p>Message frequency varies: a code is sent only when you sign in on a new device or after a period without signing in (typically a few messages per month).</p>
<h2>Cost</h2>
<p><b>Message and data rates may apply</b> according to your mobile plan. IronLedger does not charge you for these messages.</p>
<h2>Stopping and help</h2>
<p>Reply <b>STOP</b> at any time to stop receiving messages; you will receive one confirmation message. Reply <b>HELP</b> for help, or contact us at {f('email','CONTACT EMAIL')} or {f('phone','CONTACT PHONE')}. After STOP you will not receive sign-in codes, so you will not be able to sign in until your account manager arranges another method; to start again, reply START or contact us.</p>
<h2>Delivery</h2>
<p>Mobile carriers are not liable for delayed or undelivered messages. Delivery depends on your carrier and coverage.</p>
<h2>Privacy</h2>
<p>See our Privacy Policy: {link('/privacy.html')}. We never sell or share your mobile number for marketing.</p>
<h2>Changes and contact</h2>
<p>We may update these terms; the effective date above shows the latest version.</p>
<div class="box">{f('company')}<br>{f('address','BUSINESS ADDRESS')}<br>Email: {f('email','CONTACT EMAIL')} · Phone: {f('phone','CONTACT PHONE')}</div>
""")

consent = page("SMS Consent Form", f"""
<h1>Consent to Receive Sign-In Codes by Text</h1>
<div class="sub">{f('company')} · {html.escape(V['program'])}</div>
<p>To protect pharmacy ordering records, signing in to the NorTex Reorder system requires a one-time code sent by text message to your mobile phone.</p>
<div class="box">
<p style="margin-top:0">By signing below, I agree to receive automated text messages from <b>{f('company')}</b> at the mobile number below, <b>for one-time sign-in codes only</b>. Message frequency varies with sign-ins (typically a few per month). <b>Message and data rates may apply.</b> Reply <b>STOP</b> to opt out or <b>HELP</b> for help. No marketing messages will be sent, and my number will not be sold or shared for marketing.</p>
<p style="margin-bottom:0">Terms: {link('/sms-terms.html')} · Privacy Policy: {link('/privacy.html')}</p>
</div>
<style>.f{{display:grid;grid-template-columns:200px 1fr;gap:18px 14px;margin-top:22px}}.f div:nth-child(odd){{font-weight:600;font-size:13.5px;padding-top:8px}}.f div:nth-child(even){{border-bottom:1px solid #8a92a0;min-height:30px}}</style>
<div class="f">
<div>Employee name</div><div></div>
<div>Pharmacy (Pharmacy ID)</div><div></div>
<div>Login ID</div><div></div>
<div>Mobile phone number</div><div></div>
<div>Employee signature</div><div></div>
<div>Date</div><div></div>
<div>Account Manager (name)</div><div></div>
<div>Login created on</div><div></div>
</div>
<p style="font-size:12.5px;color:#5f6673;margin-top:22px">Keep the signed form on file. The Account Manager enters the mobile number in the reorder system only after this form is signed.</p>
""")

out = sys.argv[2] if len(sys.argv) > 2 else '.'
for n, h in [('privacy.html', privacy), ('sms-terms.html', terms), ('sms-consent.html', consent)]:
    open(f'{out}/{n}', 'w').write(h)
print('written to', out)

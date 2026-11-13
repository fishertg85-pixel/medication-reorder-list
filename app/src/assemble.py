import re, sys
import os
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', '..', 'shared-drive', 'index.html')
OUT = os.path.join(HERE, '..', 'web', 'index.html')
P = os.path.join(HERE, 'parts') + '/'
s = open(SRC).read()
def rep(a, b, n=1):
    global s
    c = s.count(a)
    assert c == n, (c, a[:90])
    s = s.replace(a, b)
def cut(start, end, new):
    global s
    i = s.index(start); j = s.index(end, i)
    s = s[:i] + new + s[j:]

# ---------- head
rep('<title>NorTex Reorder List</title>', '''<title>Reorder List</title>
<meta name="theme-color" content="#1f3864">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon-192.png">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Reorder">
<script src="config.js"></script>''')
rep('<meta name="viewport" content="width=device-width, initial-scale=1">', '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">')

# ---------- CSS
rep('</style>\n</head>', r'''
  /* ---- cloud version additions ---- */
  input[type=tel],input[type=email],input[type=password]{background:var(--input-bg);color:var(--text);border:1px solid var(--input-line);border-radius:6px;padding:7px 9px;font-size:14px;font-family:inherit;}
  #storeLogo{height:38px;width:38px;object-fit:contain;border-radius:6px;background:#fff;padding:2px;}
  .hsel{background:rgba(255,255,255,.08);color:var(--head-text);border:1px solid rgba(255,255,255,.3);border-radius:6px;padding:6px 8px;font-size:12.5px;max-width:260px;}
  .hsel option{color:#111;}
  .who{font-size:12px;color:var(--head-sub);}
  .addrow{display:flex;gap:8px;align-items:stretch;}
  .addrow .search-wrap{flex:1;}
  .added-by{font-size:11px;color:var(--muted);}
  /* sign-in */
  #login{min-height:calc(100vh - 52px);display:none;align-items:center;justify-content:center;padding:20px;background:var(--bg);}
  .li-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:26px 24px;width:100%;max-width:380px;box-shadow:var(--shadow);}
  .li-card h1{font-size:18px;margin:0 0 4px;} .li-card .hint{margin-bottom:14px;}
  .li-card label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin:10px 0 4px;text-transform:uppercase;letter-spacing:.04em;}
  .li-card input{width:100%;font-size:16px;padding:10px 11px;}
  .li-card .btn{width:100%;margin-top:16px;padding:11px;font-size:15px;}
  #liBrand{text-align:center;min-height:20px;margin-bottom:6px;}
  #liBrand img{max-height:96px;max-width:200px;object-fit:contain;display:block;margin:0 auto 8px;}
  .li-pname{font-weight:700;font-size:15px;} .li-none{color:var(--muted);font-size:13px;}
  .li-msg{min-height:18px;margin-top:12px;font-size:13px;color:var(--danger);} .li-msg.ok{color:var(--accent);}
  .li-links{margin-top:12px;font-size:13px;text-align:center;}
  #liCodeIn,#liFCode{letter-spacing:.3em;font-family:Consolas,Menlo,monospace;text-align:center;}
  /* Account Manager tab */
  .pcard{display:flex;gap:16px;border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:12px;flex-wrap:wrap;}
  .plogo{width:150px;display:flex;flex-direction:column;align-items:center;gap:6px;}
  .plogo img{max-width:140px;max-height:100px;object-fit:contain;}
  .pfields{flex:1;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px 12px;min-width:240px;}
  .pfields .pid{grid-column:1/-1;font-size:13px;}
  .pfields label span{display:block;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px;}
  .pfields input,.pfields select,.formgrid select{width:100%;background:var(--input-bg);color:var(--text);border:1px solid var(--input-line);border-radius:6px;padding:7px 9px;font-size:14px;font-family:inherit;} .pfields label:has(.wide){grid-column:span 2;}
  .btn.small,.btn2.small{padding:5px 10px;font-size:12.5px;}
  .btn2.danger{color:var(--bad, #a33);border-color:currentColor;}
  .copyb{padding:4px 8px;vertical-align:middle;line-height:0;} .copyb svg{display:block;}
  table.people th, table.people td{white-space:nowrap;}
  table.people tr.dirty td{background:color-mix(in srgb, #e0a100 14%, var(--panel)) !important;}   /* no wrapping in the people list */
  table.people td.acts{white-space:nowrap;} table.people td.copycell{padding-left:18px;}
  @media (max-width:820px){ table.people td.copycell:empty{display:none;}
    table.people td.acts, table.people td.hint, table.people td[data-l="Status"]{grid-column:1 / -1;} }
  #idleWarn{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:60;max-width:min(560px,calc(100vw - 32px));background:#fff4d6;color:#3a2a00;border:2px solid #e0a100;border-radius:10px;padding:12px 16px;font-weight:600;box-shadow:0 6px 24px rgba(0,0,0,.25);}
  .npmsg{min-height:1.4em;margin-top:8px;font-weight:600;color:var(--bad, #a33);} .npmsg.ok{color:var(--ok, #2f6b4e);}
  .ustat{display:inline-block;font-size:12px;font-weight:600;border-radius:999px;padding:1px 9px;white-space:nowrap;}
  .ustat.ok{background:var(--ok-soft, #d5e6dc);color:var(--ok, #2f6b4e);} .ustat.wait{background:var(--warn-soft, #f3e7d8);color:var(--warn, #8a5a22);}
  .ustat.bad{background:var(--bad-soft, #f2ded9);color:var(--bad, #8e3d2b);} .ustat.off{background:var(--panel-2, #ddd);color:var(--muted, #555);}
  label.btn2{display:inline-block;}
  .tscroll{overflow-x:auto;} #ownPeople .tscroll{overflow-x:visible;}
  table.people th.c, table.people td.c{text-align:center;}
  /* users: line 1 = user, username, mobile, status, buttons; line 2 = privileges */
  .ulist{margin-top:4px;}
  .ucols{display:grid;grid-template-columns:minmax(170px,1.6fr) minmax(100px,1fr) minmax(130px,1fr) minmax(170px,1.3fr) 240px 40px;gap:12px;align-items:center;}
  .uhead{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-weight:700;padding:8px 8px;border-bottom:2px solid var(--line);}
  .urow{padding:10px 8px;border-bottom:1px solid var(--line);}
  .urow.off{opacity:.6;} .urow.dirty{background:color-mix(in srgb, #e0a100 14%, var(--panel));border-radius:6px;}
  .ucell{white-space:nowrap;min-width:0;} .ucell.uname, .ucell.mono{overflow:hidden;text-overflow:ellipsis;}
  .ucell.acts{text-align:right;} .ucell.copycell{text-align:center;}
  .urole{margin-left:8px;font-size:11.5px;font-weight:600;color:var(--muted);}
  .upriv{display:flex;flex-wrap:wrap;align-items:center;gap:8px 22px;margin-top:8px;}
  .plabel{min-width:88px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700;}
  .pgroup{display:inline-flex;align-items:center;gap:14px;flex-wrap:wrap;} .pg{font-size:12px;color:var(--muted);font-weight:600;}
  .priv{display:inline-flex;align-items:center;gap:6px;font-size:13px;white-space:nowrap;}
  @media (max-width:820px){
    .uhead{display:none;}
    .ucols{grid-template-columns:1fr 1fr;gap:6px 12px;}
    .ucell[data-l]:before{content:attr(data-l);display:block;font-size:10.5px;color:var(--muted);text-transform:uppercase;}
    .ucell.uname, .ucell.acts{grid-column:1 / -1;} .ucell.acts{text-align:left;} .ucell.copycell:empty{display:none;}
    .ucell.uname, .ucell.mono{white-space:normal;}
  }
  /* when the full table is wider than the space it has, each person becomes a card instead of scrolling sideways */
  table.people.cards thead{display:none;}
  table.people.cards, table.people.cards tbody{display:block;}
  table.people.cards tr{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px 12px;padding:10px 0;border-bottom:2px solid var(--line);}
  table.people.cards td{border:none;text-align:left !important;padding:2px 4px;}
  table.people.cards td[data-l]:before{content:attr(data-l);display:block;font-size:10.5px;color:var(--muted);text-transform:uppercase;}
  table.people.cards td[data-l="Person"], table.people.cards td.acts, table.people.cards td.hint{grid-column:1 / -1;}
  table.people.cards td.copycell:empty{display:none;}
  table.people.cards td{background:transparent;} table.people.cards td[data-l="Status"]{grid-column:span 2;}
  table.people tr.off td{opacity:.55;}
  .switch{position:relative;display:inline-block;width:38px;height:22px;vertical-align:middle;}
  .switch input{opacity:0;width:0;height:0;}
  .switch span{position:absolute;inset:0;background:var(--input-line);border-radius:22px;transition:.15s;cursor:pointer;}
  .switch span:before{content:"";position:absolute;height:16px;width:16px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.15s;}
  .switch input:checked + span{background:var(--accent);}
  .switch input:checked + span:before{transform:translateX(16px);}
  .switch input:disabled + span{opacity:.5;}
  .formgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px 12px;}
  .formgrid label span{display:block;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px;}
  .formgrid input{width:100%;}
  label.chk{display:inline-flex;align-items:center;gap:6px;margin:4px 14px 4px 0;font-size:13px;}
  #passBox{display:none;}
  /* phones: tables become cards */
  @media (max-width:760px){
    header{gap:8px;padding:10px 12px;} header h1{font-size:15px;} header .sub,.hide-sm{display:none;}
    nav{overflow-x:auto;} nav button{padding:10px 12px;white-space:nowrap;}
    main{padding:10px 10px 80px;} .card{padding:12px;}
    #listTable thead, #archTable thead{display:none;}
    #listBody tr{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;padding:10px 4px;border-bottom:2px solid var(--line);}
    #listBody tr td{border:none;padding:2px 0;background:transparent !important;}
    #listBody td[data-l]:before{content:attr(data-l);display:block;font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;}
    #listBody td.drug{grid-column:1/-1;font-size:14px;order:-2;}
    #listBody td.added{order:-3;grid-column:1/-1;font-size:11.5px;color:var(--muted);}
    #listBody td.ndc, #listBody td.dist{grid-column:1/-1;}
    #listBody td.ndc input.ndcin{max-width:none;font-size:15px;}
    #listBody td.dist select{max-width:none;font-size:15px;padding:8px;}
    #listBody td.pkg, #listBody td.qty{width:auto;}
    #listBody td input{font-size:15px;padding:7px;}
    #listBody td.chk{text-align:left;} #listBody td.chk input{width:26px;height:26px;}
    #listBody tr.is-ordered{background:color-mix(in srgb, var(--accent) 12%, var(--panel));}
    #listBody td.empty{grid-column:1/-1;}
    #archBody tr.order td:nth-child(2){display:block;}
    #archBody tr.order{display:grid;grid-template-columns:1fr;} #archBody tr.order td{border:none;}
    #archBody tr.order-line{display:grid;grid-template-columns:1fr 1fr;padding:6px 0;border-bottom:1px solid var(--line);}
    #archBody tr.order-line td{border:none;padding:2px 4px;} #archBody tr.order-line td:first-child{display:none;}
    #archBody tr.order-line td.drug{grid-column:1/-1;}
    #archBody td[data-l]:before{content:attr(data-l);display:block;font-size:10.5px;color:var(--muted);text-transform:uppercase;}
    .results{max-height:60vh;}
    table.people thead{display:none;}
    table.people tr{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:10px 0;border-bottom:2px solid var(--line);}
    table.people td{border:none;text-align:left !important;}
    table.people td[data-l]:before{content:attr(data-l);display:block;font-size:10.5px;color:var(--muted);text-transform:uppercase;}
    .pfields label:has(.wide){grid-column:auto;}
    .toast{left:10px;right:10px;bottom:14px;text-align:center;}
  }
</style>
</head>''')

# ---------- body: sign-in screen + app wrapper
cut('<header>', '<nav id="tabs">', '''<div id="login">
  <div class="li-card">
    <div id="liBrand"></div>
    <h1>Reorder List</h1>
    <div class="li-msg" id="liMsg"></div>
    <div id="liStart">
      <label for="liPharm">Pharmacy ID</label><input type="text" id="liPharm" autocomplete="organization" autocapitalize="characters" spellcheck="false">
      <label for="liUser">Login ID</label><input type="text" id="liUser" autocomplete="username" autocapitalize="none" spellcheck="false">
      <label for="liPass">Password</label><input type="password" id="liPass" autocomplete="current-password">
      <button class="btn" id="liGo">Sign in</button>
      <div class="li-links"><a href="#" id="liForgotLink">Forgot password?</a></div>
    </div>
    <div id="liNew" style="display:none;">
      <label for="liNew1">New password</label><input type="password" id="liNew1" autocomplete="new-password">
      <label for="liNew2">Type it again</label><input type="password" id="liNew2" autocomplete="new-password">
      <div class="hint" style="margin-top:6px;">At least 10 characters, with a lowercase letter and a number.</div>
      <button class="btn" id="liNewGo">Save password</button>
    </div>
    <div id="liCode" style="display:none;">
      <div class="hint">A code was texted to <b id="liCodeDest"></b>.</div>
      <label for="liCodeIn">Code</label><input type="text" id="liCodeIn" inputmode="numeric" autocomplete="one-time-code" maxlength="8">
      <button class="btn" id="liCodeGo">Continue</button>
      <div class="li-links"><a href="#" data-liback="1">Start over</a></div>
    </div>
    <div id="liForgot" style="display:none;">
      <label for="liFUser">Login ID</label><input type="text" id="liFUser" autocapitalize="none" spellcheck="false">
      <button class="btn" id="liFSend">Text me a code</button>
      <div id="liForgot2" style="display:none;">
        <label for="liFCode">Code from the text</label><input type="text" id="liFCode" inputmode="numeric" autocomplete="one-time-code" maxlength="8">
        <label for="liFNew">New password</label><input type="password" id="liFNew" autocomplete="new-password">
        <button class="btn" id="liFGo">Change password</button>
      </div>
      <div class="li-links"><a href="#" data-liback="1">Back to sign in</a></div>
    </div>
  </div>
</div>

<div id="app" style="display:none;">
<header>
  <img id="storeLogo" alt="" style="display:none;">
  <div>
    <h1 id="storeName">Reorder List</h1>
    <div class="sub" id="dmHeader">Drug search: NLM RxTerms / RxNav</div>
  </div>
  <div class="spacer"></div>
  <select class="hsel" id="storeSel" title="Switch pharmacy" style="display:none;"></select>
  <span class="who hide-sm" id="whoLabel"></span>
  <button class="hbtn" id="signOutBtn">Sign out</button>
  <button class="hbtn theme-btn" id="themeBtn" title="Switch to dark mode" aria-label="Switch to dark mode"></button>
</header>

''')
rep('''  <button data-tab="setup">Setup</button>
</nav>''', '''  <button data-tab="setup">Setup</button>
  <button data-tab="owner" style="display:none;">Account Manager</button>
</nav>''')
cut('  <div id="wipeBanner"', '  <!-- ======================= REORDER LIST', '''  <div id="offlineBanner" class="banner warn" style="display:none;">No connection to the server right now. Changes can’t be saved until the connection is back.</div>

''')
rep('''      <div class="search-wrap">
        <input type="text" id="search" placeholder="Search drug name or NDC, e.g. “ateno 25” or 00093075201" autocomplete="off" spellcheck="false">
        <div id="results" class="results"></div>
      </div>''', '''      <div class="addrow">
        <div class="search-wrap">
          <input type="text" id="search" placeholder="Search drug name or NDC, e.g. “ateno 25” or 00093075201" autocomplete="off" spellcheck="false" enterkeyhint="search">
          <div id="results" class="results"></div>
        </div>
      </div>''')
rep('''        <button class="btn" id="submitBtn">Submit order</button>''', '''        <span class="hint" id="submitOff" style="display:none;">Submitting is switched off for your login.</span>
        <button class="btn" id="submitBtn">Submit order</button>''')
rep('''      <table>
        <thead><tr><th>Added</th>''', '''      <table id="listTable">
        <thead><tr><th>Added</th>''')
rep('''      <table>
        <thead><tr><th>Submitted</th>''', '''      <table id="archTable">
        <thead><tr><th>Submitted</th>''')
rep('''        <tbody id="archBody"></tbody>
      </table>''', '''        <tbody id="archBody"></tbody>
      </table>
      <div class="toolbar" style="margin-top:10px;"><button class="btn2" id="archMore" style="display:none;">Load older orders</button></div>''')

cut('  <!-- ======================= SETUP ======================= -->', '</main>', '''  <!-- ======================= SETUP ======================= -->
  <section id="panel-setup" class="panel">
    <div class="card">
      <h2>Pharmacy Details</h2>
      <div id="storeInfo"></div>
    </div>
    <div class="card">
      <h2>Drug Search</h2>
      <div id="dmStatus" class="banner info">Not tested on this device yet.</div>
      <div class="hint">Drug names, strengths and NDCs come from the National Library of Medicine (RxTerms and RxNav), with the FDA NDC Directory as a backup. Needs internet. “DailyMed” links open each product’s label.</div>
      <div class="toolbar" style="margin-top:10px;"><button class="btn2" id="dmTest">Test drug search</button></div>
    </div>
    <div class="card" id="exportCard" style="display:none;">
      <h2>Download A Backup</h2>
      <div class="hint">Everything for this pharmacy (open list, full archive, remembered distributors and package sizes) as one file. The cloud copy also keeps 35 days of automatic restore points.</div>
      <div class="toolbar" style="margin-top:10px;"><button class="btn2" id="exportBtn">Download backup file</button></div>
    </div>
    <div class="card">
      <h2>Use It On A Phone Or Tablet</h2>
      <ol class="steps">
        <li><b>iPhone / iPad (Safari):</b> open this page, tap the Share button, then <b>Add to Home Screen</b>.</li>
        <li><b>Android (Chrome):</b> open this page, tap the ⋮ menu, then <b>Add to Home screen</b> or <b>Install app</b>.</li>
        <li><b>Computer (Chrome / Edge):</b> click the install icon at the right of the address bar, or just bookmark the page.</li>
      </ol>
      <div class="hint">Barcode scanning is for computers with a USB barcode scanner: click in the search box and scan the bottle or box.</div>
    </div>
  </section>

  <!-- ======================= ACCOUNT MANAGER ======================= -->
  <section id="panel-owner" class="panel">
    <div class="card" id="ownLock" style="max-width:420px;">
      <h2>🔒 Account Manager</h2>
      <div class="hint">Re-enter your password to open this tab. It locks again after 5 minutes without activity here.</div>
      <div class="toolbar" style="margin-top:10px;"><input type="password" id="ownPw" autocomplete="current-password" style="flex:1;min-width:180px;"><button class="btn" id="ownUnlock">Unlock</button></div>
      <div class="li-msg" id="ownLockMsg"></div>
    </div>
    <div id="ownBody" style="display:none;">
    <div class="banner info" id="passBox"></div>
    <div class="card">
      <h2>Users</h2>
      <div class="hint" style="margin-bottom:8px;">Change a user’s privileges, then press <b>Update</b> on that user to save. <b>Undo</b> puts them back.</div>
      <div id="ownPeopleMsg" class="npmsg ok" role="status"></div>
      <div id="ownPeople"></div>
    </div>
    <div class="card">
      <h2>Add A User</h2>
      <div class="formgrid">
        <label><span>Name</span><input type="text" id="npName"></label>
        <label><span>Login ID</span><input type="text" id="npLogin" autocapitalize="none" spellcheck="false" placeholder="e.g. maria.t"></label>
        <label><span>Mobile number (for sign-in codes)</span><input type="tel" id="npPhone" placeholder="817-555-1234"></label>
        <label><span>Temporary password</span><input type="text" id="npPass" class="mono" spellcheck="false"></label>
      </div>
      <label class="chk" style="margin-top:10px;"><input type="checkbox" id="npConsent" style="width:18px;height:18px;"> The employee has signed the <a href="https://ironledgerrx.com/sms-consent.html" target="_blank" rel="noopener">SMS consent form</a> for this mobile number (print it, have them sign, keep it on file).</label>
      <div style="margin-top:8px;"><b class="hint">Pharmacies:</b><div id="npStores"></div></div>
      <div style="margin-top:4px;"><b class="hint">May:</b><div id="npPerms"></div></div>
      <div class="toolbar" style="margin-top:10px;"><button class="btn" id="npAdd">Add user</button> <button class="btn2" id="npGen">New temporary password</button></div>
      <div id="npMsg" class="npmsg" role="status"></div>
    </div>
    <div class="card">
      <h2>Pharmacies</h2>
      <div id="ownStores"></div>
      <h2 style="margin-top:14px;">Add A Pharmacy</h2>
      <div class="formgrid">
        <label><span>Pharmacy ID (typed at sign-in)</span><input type="text" id="psId" autocapitalize="characters" placeholder="e.g. NTX2" style="text-transform:uppercase"></label>
        <label><span>Pharmacy name</span><input type="text" id="ps_name"></label>
        <label><span>Street address</span><input type="text" id="ps_address" maxlength="200"></label>
        <label><span>Suite / unit (if any)</span><input type="text" id="ps_suite" maxlength="40"></label>
        <label><span>City</span><input type="text" id="ps_city" maxlength="80"></label>
        <label><span>State</span><select id="ps_state"><option value=""></option><option>AL</option><option>AK</option><option>AZ</option><option>AR</option><option>CA</option><option>CO</option><option>CT</option><option>DE</option><option>DC</option><option>FL</option><option>GA</option><option>HI</option><option>ID</option><option>IL</option><option>IN</option><option>IA</option><option>KS</option><option>KY</option><option>LA</option><option>ME</option><option>MD</option><option>MA</option><option>MI</option><option>MN</option><option>MS</option><option>MO</option><option>MT</option><option>NE</option><option>NV</option><option>NH</option><option>NJ</option><option>NM</option><option>NY</option><option>NC</option><option>ND</option><option>OH</option><option>OK</option><option>OR</option><option>PA</option><option>PR</option><option>RI</option><option>SC</option><option>SD</option><option>TN</option><option selected>TX</option><option>UT</option><option>VT</option><option>VA</option><option>WA</option><option>WV</option><option>WI</option><option>WY</option></select></label>
        <label><span>ZIP code</span><input type="text" id="ps_zip" maxlength="10" inputmode="numeric"></label>
        <label><span>Phone</span><input type="tel" id="ps_phone"></label>
        <label><span>Fax</span><input type="tel" id="ps_fax"></label>
        <label><span>Email</span><input type="email" id="ps_email"></label>
        <label><span>License #</span><input type="text" id="ps_license"></label>
      </div>
      <div class="toolbar" style="margin-top:10px;"><button class="btn" id="psAdd">Add pharmacy</button><span class="hint">The Pharmacy ID can’t be changed later.</span></div>
    </div>
    <div class="card">
      <h2>Import From The Shared-Drive Version</h2>
      <div class="hint">Brings in the old <b>nortex_reorder_data.json</b>: archive, open list and remembered distributors. Only adds; anything already here is left as it is, so it’s safe to run twice.</div>
      <div class="toolbar" style="margin-top:10px;"><select id="impStore" class="btn2"></select><input type="file" id="impFile" accept=".json"><button class="btn" id="impGo">Import</button></div>
      <div class="hint" id="impMsg"></div>
    </div>
    </div><!-- #ownBody -->
  </section>
''')
rep('''<div class="results" id="ndcPop" style="position:absolute;left:0;right:auto;max-height:320px;"></div>
<div class="toast" id="toast"></div>''', '''</div><!-- #app -->

<div class="results" id="ndcPop" style="position:absolute;left:0;right:auto;max-height:320px;"></div>
<div class="toast" id="toast"></div>''')

# ---------- script
rep('''/* =======================================================================
   NorTex Reorder List: one local HTML page, no server, no install.
   Shared state lives in nortex_reorder_data.json on the shared drive.
   Drug search asks DailyMed live (needs internet). DailyMed links
   open the product's label.
   ======================================================================= */''', '''/* =======================================================================
   NorTex Reorder List (cloud). Hosted on AWS: sign-in with Pharmacy ID + Login ID + password
   + text-message code; data per pharmacy in the cloud; works on computers and phones.
   Drug search: NLM RxTerms / RxNav live, FDA NDC Directory backup. DailyMed links open labels.
   ======================================================================= */''')
cut('/* ---------------- shared state ---------------- */', '/* ---------------- drug search:', open(P + 'state.js').read() + '\n' + open(P + 'login.js').read() + '\n')
cut('/* ---------------- safety net:', '</script>', open(P + 'owner.js').read() + '\n' + open(P + 'start.js').read())
# remove the old tabs/start (now in start.js) — it was after the safety-net block, so already cut

# ---------- list rows: who added it, labels for phone layout, remove only with permission
rep('''      <td>${fmtDate(r.dateAdded)}</td>
      <td><b>${esc(r.item)}</b>''', '''      <td class="added">${fmtDate(r.dateAdded)}${r.addedBy ? `<div class="added-by">by ${esc(r.addedBy)}</div>` : ''}</td>
      <td class="drug"><b>${esc(r.item)}</b>''')
rep('''      <td class="ndc"><input''', '''      <td class="ndc" data-l="NDC"><input''')
rep('''      <td class="mfr">${r.mfr ? esc(r.mfr)''', '''      <td class="mfr" data-l="Manufacturer">${r.mfr ? esc(r.mfr)''')
rep('''      <td class="dist"><select''', '''      <td class="dist" data-l="Distributor"><select''')
rep('''      <td class="pkg"><input type="text" data-f="pkgSize"''', '''      <td class="pkg" data-l="Pkg Size"><input type="text" data-f="pkgSize"''')
rep('''      <td class="qty"><input type="number"''', '''      <td class="qty" data-l="Qty"><input type="number" inputmode="numeric"''')
rep('''      <td class="chk"><input type="checkbox" data-f="ordered" ${r.ordered ? 'checked' : ''} title="${r.ordered ? 'Ordered' + (r.orderedAt''',
    '''      <td class="chk" data-l="Ordered"><input type="checkbox" data-f="ordered" ${r.ordered ? 'checked' : ''} title="${r.ordered ? 'Ordered' + (r.orderedBy ? ' by ' + r.orderedBy : '') + (r.orderedAt''')
rep('''      <td><button class="x" data-del="${r.id}" title="Remove from list">×</button></td>''',
    '''      <td>${PERM('remove') ? `<button class="x" data-del="${r.id}" title="Remove from list">×</button>` : ''}</td>''')
rep('''function renderList(){
  const rows = STATE.reorder.filter''', '''function renderList(){
  if(!STORE) return;
  const rows = STATE.reorder.filter''')
rep('''  $('submitBtn').disabled = !rows.length;''', '''  $('submitBtn').disabled = !rows.length || !PERM('submit');''')

# ---------- archive: who submitted, phone labels, load older, day lookups
rep('''      <td colspan="7"><b>${rows.length} line${rows.length === 1 ? '' : 's'}</b> · <span class="maker">${esc(preview)}</span></td></tr>`;''',
    '''      <td colspan="7"><b>${rows.length} line${rows.length === 1 ? '' : 's'}</b>${first.submittedBy ? ` <span class="maker">· by ${esc(first.submittedBy)}</span>` : ''} · <span class="maker">${esc(preview)}</span></td></tr>`;''')
rep('''      <td><b>${esc(r.item)}</b></td>
      <td>${r.ndc ? ndcHtml(r.ndc) : '<span class="maker">any NDC</span>'}</td><td class="mfr">${esc(r.mfr || '')}</td><td class="mfr">${esc(r.dist || '')}</td><td>${esc(r.pkgSize || '')}</td><td>${esc(r.qty)}</td><td>${dm(r.ndc10 || r.ndc, r.setid)}</td>''',
    '''      <td class="drug"><b>${esc(r.item)}</b></td>
      <td data-l="NDC">${r.ndc ? ndcHtml(r.ndc) : '<span class="maker">any NDC</span>'}</td><td class="mfr" data-l="Manufacturer">${esc(r.mfr || '')}</td><td class="mfr" data-l="Distributor">${esc(r.dist || '')}</td><td data-l="Pkg Size">${esc(r.pkgSize || '')}</td><td data-l="Qty">${esc(r.qty)}</td><td>${dm(r.ndc10 || r.ndc, r.setid)}</td>''')
rep('''function renderArchive(){
  const day = $('archDate').value, orders = archiveOrders();''', '''function renderArchive(){
  if(!STORE) return;
  $('archMore').style.display = archCursor && !$('archDate').value ? '' : 'none';
  const day = $('archDate').value, orders = archiveOrders();''')
rep('''$('archDate').onchange = renderArchive;''', '''$('archDate').onchange = () => { renderArchive(); loadArchiveDay($('archDate').value).catch(() => {}); };
$('archMore').onclick = () => loadArchive(true).catch(e => { if(!e.auth) alert(e.message); });''')
rep('''  ${ok || BRIDGE ? '' : '<br>Send Claude a screenshot of this box.'}`;''', '''  ${ok || BRIDGE ? '' : '<br>Send a screenshot of this box to whoever hosts the app.'}`;''')

# submit: confirm text mentions pharmacy
rep('''  if(!confirm(`Submit ${n} line${n === 1 ? '' : 's'}? They move to the Archive.` +''',
    '''  if(!confirm(`Submit ${n} line${n === 1 ? '' : 's'} for ${STORE.id}? They move to the Archive.` +''')


# ---------- review fixes: escape everything that came from the server
rep("const fmtDate = iso => { if(!iso) return ''; const [y,m,d] = iso.split('-'); return `${m}/${d}/${y}`; };",
    "const fmtDate = iso => { if(!iso) return ''; const [y,m,d] = String(iso).split('-'); return esc(d === undefined ? iso : `${m}/${d}/${y}`); };")
rep("""title="${r.ordered ? 'Ordered' + (r.orderedBy ? ' by ' + r.orderedBy : '') + (r.orderedAt""", """title="${r.ordered ? 'Ordered' + (r.orderedBy ? ' by ' + esc(r.orderedBy) : '') + (r.orderedAt""")
rep("""`<button class="x" data-del="${r.id}" title="Remove from list">×</button>`""", """`<button class="x" data-del="${esc(r.id)}" title="Remove from list">×</button>`""")
rep("""<tr data-id="${r.id}" data-ndc="${esc(r.ndc)}\"""", """<tr data-id="${esc(r.id)}" data-ndc="${esc(r.ndc)}\"""")
rep("""data-edit="${r.id}\"""", """data-edit="${esc(r.id)}\"""")
rep("""data-ndcin="${r.id}\"""", """data-ndcin="${esc(r.id)}\"""")
# submitted lines carry the open line's id, so the server can copy who added/ordered it and check permissions
rep("""      s.archive.push({id:uid(), dateAdded:r.dateAdded,""", """      s.archive.push({id:uid(), lineId:r.id, dateAdded:r.dateAdded,""")
# password help: only the Account Manager resets passwords (a texted code alone would bypass the password)
rep("""      <div class="li-links"><a href="#" id="liForgotLink">Forgot password?</a></div>""",
    """      <div class="li-links hint">Forgot your password? Ask the Account Manager for a temporary one.</div>
      <a href="#" id="liForgotLink" style="display:none;"></a>""")


# ---------- per-pharmacy time zone for every date/time shown or stamped
rep("const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10); };",
    "const todayISO = () => { try{ return new Intl.DateTimeFormat('en-CA', {timeZone:storeTZ(), year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date()); }catch(e){ const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10); } };")
rep("function fmtTime(iso){ if(!iso || iso.length < 11) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}); }",
    "function fmtTime(iso){ if(!iso || iso.length < 11) return ''; const d = new Date(iso); if(isNaN(d)) return ''; try{ return d.toLocaleTimeString([], {hour:'numeric', minute:'2-digit', timeZone:storeTZ(), timeZoneName:'short'}); }catch(e){ return d.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}); } }")
rep("new Date(r.orderedAt).toLocaleString([], {month:'numeric', day:'numeric', hour:'numeric', minute:'2-digit'})",
    "new Date(r.orderedAt).toLocaleString([], {month:'numeric', day:'numeric', hour:'numeric', minute:'2-digit', timeZone:storeTZ(), timeZoneName:'short'})")
rep("""        <label><span>License #</span><input type="text" id="ps_license"></label>""",
    """        <label><span>License #</span><input type="text" id="ps_license"></label>
        <label><span>Time zone</span><select id="ps_timezone"><option value="America/New_York">Eastern</option><option value="America/Chicago" selected>Central</option><option value="America/Denver">Mountain</option><option value="America/Phoenix">Arizona (no daylight saving)</option><option value="America/Los_Angeles">Pacific</option><option value="America/Anchorage">Alaska</option><option value="Pacific/Honolulu">Hawaii</option><option value="America/Puerto_Rico">Atlantic (Puerto Rico)</option></select></label>""")


# ---------- IronLedger look: same palette and type as the IronLedger compliance app (cloud version only)
IL_LIGHT = """--bg:#ccdee4;--panel:#e8f1f5;--text:#02182e;--muted:#49637a;--line:#abc6d4;
    --head:#02182e;--head-text:#e8f1f5;--head-sub:#85c4e4;--nav:#022f56;
    --accent:#022f56;--accent-hover:#02182e;--on-accent:#ffffff;--ok:#2f6b4e;--link:#0b4f86;--danger:#8e3d2b;
    --input-bg:#ffffff;--input-line:#abc6d4;--row-alt:#dcebf1;--hover:#d3e5ee;
    --sect:#dcebf1;--sect-text:#022f56;--sect-fda:#d5e6dc;--sect-fda-text:#2f6b4e;
    --warn-bg:#f2ded9;--warn-line:#e2b8ad;--warn-text:#8e3d2b;--info-bg:#dcebf1;--info-line:#abc6d4;--info-text:#022f56;
    --new-bg:#f3e7d8;--shadow:0 1px 2px rgba(13,20,38,.06),0 8px 24px rgba(13,20,38,.10);"""
IL_DARK = """--bg:#02182e;--panel:#022f56;--text:#ccdee4;--muted:#86a7bd;--line:#0b3f6d;
    --head:#010f1e;--head-text:#ccdee4;--head-sub:#85c4e4;--nav:#011426;
    --accent:#85c4e4;--accent-hover:#a9d6ee;--on-accent:#02182e;--ok:#86c7a7;--link:#85c4e4;--danger:#f0ab92;
    --input-bg:#02182e;--input-line:#0b3f6d;--row-alt:#03284a;--hover:#043a68;
    --sect:#043a68;--sect-text:#a9d6ee;--sect-fda:#123f2c;--sect-fda-text:#86c7a7;
    --warn-bg:#5e2a1c;--warn-line:#8e3d2b;--warn-text:#f0ab92;--info-bg:#0a3a63;--info-line:#0b3f6d;--info-text:#a9d6ee;
    --new-bg:#4a3519;--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35);"""
rep('</style>\n</head>', """</style>
<link rel="stylesheet" href="fonts.css">
<style id="ironledger-theme">
  :root{""" + IL_LIGHT + """}
  @media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){""" + IL_DARK + """} }
  :root[data-theme="dark"]{""" + IL_DARK + """}
  body{font-family:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;}
  .mono,.ndc-txt,td input.ndcin,td.ndc,#liCodeIn,#liFCode{font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
  .btn{color:var(--on-accent);} .btn:hover{color:var(--on-accent);}
  nav button.active{border-bottom-color:#85c4e4;}
  td.chk input{accent-color:var(--ok);}
  #listBody tr.is-ordered td{background:color-mix(in srgb, var(--ok) 14%, var(--panel)) !important;}
  .card,.li-card{box-shadow:var(--shadow);}
  .li-il{display:flex;align-items:center;gap:9px;margin-bottom:14px;color:var(--muted);font-size:13px;font-weight:600;letter-spacing:.02em;}
  .li-il img{width:26px;height:26px;border-radius:6px;}
  .brandfoot img{height:20px;width:20px;border-radius:5px;}
</style>
</head>""")
rep('<meta name="theme-color" content="#1f3864">', '<meta name="theme-color" content="#02182e">')
rep('<meta name="apple-mobile-web-app-title" content="Reorder">', '<meta name="apple-mobile-web-app-title" content="IronLedger Reorder">')
rep('<link rel="icon" href="icon-192.png">', '<link rel="icon" href="mark.svg" type="image/svg+xml">\n<link rel="alternate icon" href="icon-192.png">')
rep("""  <div class="li-card">
    <div id="liBrand"></div>""", """  <div class="li-card">
    <div class="li-il"><img src="mark.svg" alt=""><span>IronLedger</span></div>
    <div id="liBrand"></div>""")
rep('<img id="ilLogo" src="ironledger-logo.png" alt="" hidden>', '<img id="ilLogo" src="mark.svg" alt="" hidden>')

# ---------- move the app script out of the page so a strict Content-Security-Policy can block injected scripts
import hashlib, base64 as b64
m = re.search(r'<script>\n(/\* =+\n   NorTex Reorder List \(cloud\)[\s\S]*?)</script>', s)
open(OUT.replace('index.html', 'app.js'), 'w').write(m.group(1))
s = s[:m.start()] + '<script src="app.js"></script>' + s[m.end():]
th = re.search(r'<script>([\s\S]*?)</script>', s).group(1)
h = b64.b64encode(hashlib.sha256(th.encode()).digest()).decode()
csp = ("default-src 'self'; script-src 'self' 'sha256-%s'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " % h +
  "connect-src 'self' https://*.amazonaws.com https://clinicaltables.nlm.nih.gov https://rxnav.nlm.nih.gov https://api.fda.gov https://dailymed.nlm.nih.gov http://localhost:8790; " +
  "worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'")
s = s.replace('<meta charset="UTF-8">', '<meta charset="UTF-8">\n<meta http-equiv="Content-Security-Policy" content="%s">' % csp, 1)
open(OUT, 'w').write(s)
print('written', len(s))

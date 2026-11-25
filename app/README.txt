NorTex Reorder List — Cloud Version (AWS)
==========================================
Hosted on your AWS account. Works in any browser on computers, phones and tablets, and installs to a
phone's home screen. Each pharmacy has its own list, archive and distributor memory.

==========================================================================================
INSTALL OR UPDATE: THE COMMANDS (START HERE)
==========================================================================================
  A. Upload the zip.   AWS console > CloudShell (the >_ icon in the top bar) > Actions > Upload file >
     choose NorTex_Reorder_Cloud_39.5.zip   (use the same region as before).
  B. Run it (copy the whole line; it works for a first install and for every update):
         rm -rf ~/nortex && mkdir ~/nortex && unzip -q ~/NorTex_Reorder_Cloud_39.5.zip -d ~/nortex && cd ~/nortex && bash deploy.sh
     A first install asks for the Account Owner and the first pharmacy (see FIRST DEPLOY below).
     An update asks nothing: it replaces only the app and server code. Lists, archives, memory and
     logins are never touched, and earlier settings (text codes, SUITE_USERS, PIN setting) are kept.
  C. Afterwards: hard-refresh the site (Ctrl+Shift+R), then sign in on the employee portal with a
     PHARMACY login; it must say "Incorrect ID or password." and no text may arrive.

  Options (put them in front of bash deploy.sh; each is remembered until you change it):
     TEXT_CODES=off bash deploy.sh        password-only sign-in until the texting number is approved
     TEXT_CODES=on  bash deploy.sh        texted sign-in codes back on
     NOTIFY_FROM=notices@ironledgerrx.com bash deploy.sh    email reminders (needs a verified SES sender)
     NOTIFY_TEXT=on bash deploy.sh        text reminders (needs the approved texting number)
     APP=othername bash deploy.sh         a second, separate copy (another business)
  Host tools, from the same folder (cd ~/nortex):
     bash host.sh people     bash host.sh reset-password LOGIN     bash host.sh set-phone LOGIN 8175551234
     bash host.sh off LOGIN  bash host.sh on LOGIN                 bash host.sh pharmacies
     bash host.sh add-pharmacy NTX2 "NorTex Pharmacy - Keller" central
     bash host.sh assign LOGIN NTX2        bash host.sh unassign LOGIN NTX2

ZIP 39.5 (2026-11-25): WHAT CHANGED (on top of 39.4)
  Employee who  An IronLedger employee whose login also works at a pharmacy is an ordinary user on the pharmacy side.
  also works    Before, the server refused an account type, sub-roles, Designated Person, final approver, document
  at a pharmacy duty and super user on such a login, so it could not be a Staff Pharmacist and had no Rx Intake tab.
                Now the Account Owner, the PIC super user or an IronLedger supervisor sets them like anyone's.
                The pharmacy's Users list no longer marks the login ("Also IronLedger" shows in the employee portal
                only) and lists it in the normal order. What stays with IronLedger for that login: reset password,
                temporary PIN, mobile number, name, login on/off and delete (the same login opens the employee
                portal). Through the portal the person is IronLedger, not a pharmacist.
  Named users   The Calendar / Documents / Rx Intake named list (template.yaml, SUITE_USERS) now also names the login
                tfisher at NTX1 and TEST1 (Neo's pharmacist login; tfisher85 becomes the IronLedger employee login).
  TWO LOGINS    1. Employee portal > the pharmacy > Users > Add User: Login ID tfisher, Account Type Staff Pharmacist,
  (Neo)            RPh License #, mobile. Initials are one per person: clear them on tfisher85 first if you want the
                   same ones. A temporary password is shown.
                2. Sign in at the pharmacy site as tfisher; choose the password (it may be the one you use today).
                3. Employee portal > Users > tfisher85 > switch off Access To <pharmacy> > Update (every pharmacy it
                   has). If tfisher85 is an Account Owner anywhere, change that Account Owner to tfisher first.
                4. New password for tfisher85:   cd ~/nortex && bash host.sh reset-password tfisher85

ZIP 39.4 (2026-11-25): WHAT CHANGED (on top of 39.3)
  Phone, time   Phone and fax boxes format themselves as 000-000-0000 while typing. Every time field is a 00:00 box
                (digits only, the colon is added) with an AM/PM dropdown; 13:00 typed becomes 01:00 PM. The
                formatting is for the person reading; the server keeps plain values (24-hour times).
  Hours         Hours Of Operation is one grid with column titles (Opens, Closes, Closed, Time Zone); every day row
                lines up under them. Beside the right-hand list the panels stack in one column below 1366 px wide.
  Holidays      The Federal Holidays Closed list is two columns (the second starts with Labor Day). The dates are
                worked out from the federal rules for every year on the server as well as in the Calendar (tested
                identical for 2021 through 2050), so nothing is entered by hand. A reminder is not sent on a
                federal holiday the pharmacy is closed for. Additional Closed Days show on the Calendar by name
                and are shaded like every other closed day; an Every Year day repeats.
  Portal frame  Employee portal: the IronLedger header, the Refresh row, the Find box, the breadcrumb and the
                right-hand list stay put; only the middle scrolls. Logo and tag line line up with the page edges.
                The middle box and the right-hand list start and end at the same height.
  Save          Save / Create sits in the fixed row at the top right, outside the scrolling box, so it never scrolls
                away. The Save box on the client page is gone (Change History moved beside Unlock Fields).
  Layouts       Default layouts are in aligned bands: panels side by side share the same top and bottom edge.
                Client page: [Client And Legal Entity | Account Owner], [Addresses | Phone, Fax And Contacts].
  Unsaved       Leaving a page or window with changes asks "Save your changes?" Yes saves, then leaves (a save that
                is refused keeps you there with the message). No leaves without saving. Covered: employee portal
                (client, new client, pharmacy, Add Pharmacy window; breadcrumb, lists, search, Refresh, Lock, Sign
                Out), the Account tab (pharmacy page; lists, breadcrumb, tabs, Sign Out), every Calendar window
                (Cancel, click outside, Escape, changing tabs). Closing the browser tab shows the browser's own
                warning (a page cannot draw its own window there). Not covered yet: the Users lists, Documents
                and Rx Intake.

ZIP 39.3 (2026-11-25): WHAT CHANGED (on top of 39.2)
  Setup pages   Pharmacy and client pages: Pharmacy Name on its own row; then [Street Address][Suite / Unit],
                [City][State][ZIP], [Phone][Fax], [Email]. Same pattern for the client business and billing addresses.
  Save          A Save button at the top, right-aligned above the panels (Create on new pharmacies and clients).
  Hours         Time Zone sits in the Hours Of Operation box, right of the Sunday row. A day switched to Closed grays
                out its time fields.
  Fit           Labels and buttons never wrap. A text too long for its box gets a smaller type size and the full text
                as a hover tip. Shorter hint texts. Default layouts: Hours Of Operation is 5 columns wide.

ZIP 39.2 (2026-11-24): WHAT CHANGED
  Records       The approver reopens a record (back to review, old version kept) or voids it (reason required,
                hidden from lists and the inspector, kept on file). Nothing is deleted. Excursion and
                missed-entry records are their own kind and are closed only by the approver.
  Documents     Tasks folder (a subfolder per task type, filled automatically from completed-task files; for
                people who enter or approve tasks). My Documents (private to each person). Personnel Files
                (PIC, Account Owner, anyone the PIC allows; ticking a Designated Person box turns it on; the
                host is read-only and logged). Per-document audience, chapter tag, Designated Person review
                before the final approval (the PIC can switch the review off per person; the final approval
                is always required). Pinned box stays hidden until something is pinned.
  Task files    Files attached to Calendar tasks now work in the suite (private S3 storage).
  Inspector     Documents > Inspector Link: a time-limited, read-only link (Dashboard, Task Logs, Documents,
                Personnel compliance data, Print Report with Register Only or Register Plus Documents). Every
                open is logged and kept (PIC and Account Owner see it). Voided records are hidden.
  Host access   IronLedger can read a pharmacy's Calendar, and Personnel with a per-person privilege, read-only.
                Every view is logged and visible to the pharmacy. (The server part is done; the host page for it is not.)
  Reminders     Name menu > Notifications: each person picks Email and/or Text (neither = in the app only).
                Waiting items: first message after 72 hours (adjustable by the PIC or Account Owner; the screen for it is not built yet),
                only while the pharmacy is open. Excursion or missed required entry: after 2 hours, any hour, to the
                approvers and Designated Persons on that step. A Designated Person review still waiting: one
                message to the PIC at 96 hours. One message per person per check, never repeated for the same
                item, and no patient, drug or task names in any message.

TO TURN ON EMAIL AND TEXT REMINDERS (nothing is sent until you do)
  Email  1. AWS console > Amazon SES > Verified identities > create one for your sender (ironledgerrx.com or
            notices@ironledgerrx.com) and add the DNS records it shows.
         2. New SES accounts are in a sandbox (only verified addresses receive mail). Request production access.
         3. Run: NOTIFY_FROM=notices@ironledgerrx.com bash deploy.sh
  Text   Uses the same toll-free number and registration as the sign-in codes. When approved:
         NOTIFY_TEXT=on bash deploy.sh   (keeps the last choice on later runs)
  A check runs every 30 minutes. Cost: pennies at this size.

ZIP 39.1 (2026-11-23): WHAT CHANGED
  Tabs         Dashboard, Calendar, Documents, Reorder List, Rx Intake. Review Queue is on the Dashboard;
               Obligations is Calendar > List; People & Assets and Calendar Setup are on the pharmacy account
               (Account is in the user-name menu).
  Dashboard    Due For Me, Compliance Health (counts, everyone), Review Queue, Time Off And Coverage, Audit Report.
               Count badge on the tab; waits turn amber at 24 h and red at 48 h.
  People       Sub-roles inside each account type; Designated Person boxes (USP 795 / 797 / 800); technician
               registration number and expiry. A super user manages people at or below their own type only.
  Approvals    Technician submits > Designated Person reviews > final approval; a return at either step needs a
               reason. Delegation (date and time) and Time Off. The server stamps who and when.
  Access       Calendar is view-only for Associates; Cashier and Driver have no Reorder List.
  Still limited to the named logins in template.yaml (SUITE_USERS) for Calendar, Documents and Rx until you lift it.
  (Documents tasks folder and review, reopen and void, inspector link and reminders came in 39.2, below.)

WHO DOES WHAT
  Host (you)         Runs the AWS account: deploys, updates, AWS settings, backups. Doesn't need a login
                     in the app, but the Account Owner can add you like anyone else.
  Account Owner    The business owner. The only login that can add pharmacies and people, switch each
                     person's access on/off per pharmacy, and switch permissions on/off. This role can't
                     be given to anyone else from the app.
  Everyone else      Signs in with Pharmacy ID + Login ID + password, then a code texted to their phone.
                     Only the Account Owner can change someone's mobile number or reset their password,
                     except her own mobile number: that is the security factor for her sign-in, so only
                     IronLedger (the host) changes it.

WHAT'S IN THIS FOLDER
  deploy.sh      installs or updates everything (run it in AWS CloudShell)
  host.sh        host tools: people list, reset a password, change a mobile number, switch a login off/on
  template.yaml  the AWS resources (CloudFormation)
  lambda/        the server code
  web/           the app pages (the deploy script adds config.js)

WHAT IT RUNS ON (all in your account, in the region where you run deploy.sh)
  CloudFront + S3      the web address and pages      DynamoDB    lists, archives, memory, people
  Cognito              logins, passwords, text codes  Lambda + API Gateway   the server
  SNS / End User Messaging   sends the text-message codes

ROUGH MONTHLY COST (3 pharmacies, ~20 people; moderate confidence, check AWS pricing)
  Website, server, database, logins: under $1–2 (free-tier sized).
  Text messages: toll-free number ~ $2/month + about 1¢ per text (incl. carrier fees). Codes are only
  sent at sign-in on a new device or after 30 days, so a few dozen texts a month.

==========================================================================================
ONE-TIME AWS PREP FOR TEXT MESSAGES (start this first — approval can take days to weeks)
==========================================================================================
Per person, the only setup is the mobile number the Account Owner types in when creating the login.
But before AWS will text ANY number, the AWS account itself needs these one-time steps (US carrier
rules + AWS defaults for new accounts). Until then, codes only reach numbers you verify by hand.
In the AWS console, in the SAME region you'll deploy to (US East (N. Virginia) us-east-1 is a good choice):
  1. Raise the SMS spending limit. New accounts are capped at $1/month and texts silently stop at the cap.
     AWS End User Messaging SMS (or SNS > Text messaging) > account spend limit > request an increase
     (e.g. $20/month) through a Service Quotas / Support request.
  2. Get a toll-free number and submit its registration: End User Messaging SMS > Phone numbers >
     Request originator > United States > Toll-free > "Transactional", then fill in the registration
     (business name, website or description, sample message: "IronLedger: Your NorTex Reorder sign-in code is 123456. Do not share this code. Reply STOP to opt out.").
  3. Ask to leave the SMS sandbox (same console, "Request production access").
  4. While waiting: SNS > Text messaging (SMS) > Sandbox destination phone numbers > Add the phone
     numbers of the people testing (each gets a verification code).

==========================================================================================
FIRST DEPLOY (about 15 minutes, mostly waiting)
==========================================================================================
  1. Sign in to the AWS console with an account that can create resources (an admin user, not root if
     you can avoid it). Pick the region at the top right (same as above).
  2. Open CloudShell (the >_ icon in the top bar).
  3. Upload the zip and run the command in INSTALL OR UPDATE (at the top of this file).
  4. It builds everything (5–10 minutes the first time), then asks for:
       the Account Owner's name, Login ID and mobile number, and the first pharmacy's ID and name.
     It prints a temporary password and the web address (something like https://d1abc2def3.cloudfront.net).
  5. Give the Account Owner: the web address, Pharmacy ID, Login ID and temporary password.
     On first sign-in they choose their own password, then enter the texted code.
  Optional short link: make a TinyURL that points to the web address for typing it the first time.
  Security comes from the login and text code, not from the address being hard to guess.

TEXTED SIGN-IN CODES OFF / ON
  Until the toll-free number is approved, texts can't be delivered, so nobody could finish signing in.
  Password-only for now:   TEXT_CODES=off bash deploy.sh
  Codes back on later:     TEXT_CODES=on bash deploy.sh     (also re-enables codes for every login)
  The choice is kept across normal updates (plain 'bash deploy.sh') until you change it.
  Temporary passwords are never texted: they are shown on screen to whoever reset them.

IRONLEDGER EMPLOYEE PORTAL (no CloudShell needed)
  Once for a new employee:  bash host.sh make-host neo "Thomas Fisher" 8175551234    (prints a temporary password)
  For a login that already exists (e.g. your own pharmacy login):  bash host.sh make-host tfisher85
  (it keeps its ID and password; the same login then also opens the portal).
  Open  <web address>/host.html  and sign in with the Login ID and password (no Pharmacy ID), then the texted code.
  The portal has its own sign-in entry (a separate Cognito app client, same user pool). A pre-sign-in check
  refuses a pharmacy login there exactly like a wrong password ("Incorrect ID or password.") before any text code is sent.
  It asks for the password again on reload and locks after 5 minutes idle. Employee logins never appear in a pharmacy's people list.
  Layout: start page = new-client form in the middle, client list on the right. Open a client: its account in the
  middle and its Profiles (pharmacies, "Add pharmacy") on the right. Open a pharmacy: its account in the middle and
  Users / Billing buttons on the right. One search bar at the top finds clients, pharmacies and people
  (name, login, employee ID). The breadcrumb goes back up. Users and Billing show ONE pharmacy at a time.
  The pharmacy page has "Who can manage users" switches (Account Owner, PIC, Client Account Owner).
  Pharmacies with no client are listed on the start page under "Not linked to a client yet" so they can be opened and linked.
  If you ever lose the password, run the make-host command again for a new temporary one.
  SETTING UP A PHARMACY: only the portal sets a pharmacy's license, NPI, DEA, NCPDP, Services provided and Calendar switch;
  the pharmacy's Account Owner sees them but cannot change them or add a pharmacy. The Account Owner edits name, address,
  phone, fax, email, time zone and hours. The portal needs a desktop or tablet screen.
  AFTER EACH deploy.sh: sign in on the portal with a PHARMACY login. It must say "Incorrect ID or password." and no text arrives.
  If a text arrives, the pre-sign-in check is not attached: re-run bash deploy.sh and tell your developer.

HOST TOOLS (CloudShell, in the same folder)
  bash host.sh people                    bash host.sh reset-password maria.t
  bash host.sh set-phone maria.t 8175551234      bash host.sh off maria.t   /   bash host.sh on maria.t
  bash host.sh pharmacies                bash host.sh add-pharmacy NTX2 "NorTex Pharmacy - Keller" central
  bash host.sh assign maria.t NTX2       bash host.sh unassign maria.t NTX2
  Pharmacies and access can be set up by the host here or by the Account Owner in the app; both
  change the same records.

UPDATES
  Upload the new zip to CloudShell and run the command in INSTALL OR UPDATE (top of this file). Updates replace only the app and server
  code. Lists, archives, memory and logins are never touched.

==========================================================================================
THE ACCOUNT OWNER, IN THE APP (Account Owner tab)
==========================================================================================
  The Account Owner uses the Reorder List like everyone else. Opening the Account Owner tab asks for
  their password again; it locks after 5 minutes without activity on that tab (the screen clears and the
  server refuses Account Owner changes until the password is entered again).
  Pharmacies   Add each pharmacy: Pharmacy ID (what people type at sign-in, e.g. NTX2; can't be changed),
               name, address, phone, fax, email, license #, and time zone (Central unless changed).
               Every date and time on that pharmacy's list and archive uses its time zone, no matter
               where the phone or computer is. Upload a logo: it shows on the sign-in screen
               once someone types that Pharmacy ID, and in the app header.
  People       Add a person: name, Login ID, mobile number, temporary password (one is suggested).
               The app shows exactly what to give them. Then use the switches:
                 one switch per pharmacy (access on/off)
                 Submit orders · View archive · Remove lines · Download backup
                 Login on (off = signed out everywhere and can't sign in)
               Reset password gives a new temporary password. ✎ changes the mobile number.
  Import       Brings in the old shared-drive file nortex_reorder_data.json for a pharmacy.
               Adds only; nothing already in the cloud is changed, so it's safe to run twice.

EVERYONE
  Sign in: Pharmacy ID, Login ID, password, then the texted code (only on a new device or every 30 days).
  Forgot password? The Account Owner (Account Owner tab > Reset password) or the host (host.sh) gives a
  new temporary password.
  By design there's no self-service reset: a texted code alone would get around the password.
  Phone: open the web address, then Share > Add to Home Screen (iPhone) or ⋮ > Install app (Android).
  Barcode scanner (computers only): click in the search box and scan the bottle (UPC) or the 2D code on
  the box. The drug, strength, NDC, manufacturer, package size and last distributor fill in by themselves.
  The phone app has no scanning.
  Someone with more than one pharmacy switches between them at the top of the screen.
  - Distributor not on the list? Choose "+ Add a distributor not on the list..." at the bottom of the
    Distributor box and type its name. It stays on this pharmacy's list for everyone.
  - Used before = listed first (★). In the search box, in each line's NDC list and in the Distributor
    list: the most recently used one is on top, then the others used before by how often they were
    submitted ("ordered 3×"), then everything else. The distributor is saved the moment it's picked;
    if it changes, the newest choice fills in next time.
  Everything else works as before: search, NDC box, Distributor (remembered per pharmacy), Ordered,
  Submit, Archive, label strengths, ✎ for wording, add by hand.

==========================================================================================
KEEPING ORDERS SAFE
==========================================================================================
  - Open lines can be edited or removed (if "Remove lines" is on) until Submit. Submit doesn't send
    anything to a vendor; it records that the lines were ordered and moves them to the Archive.
  - The archive can only be added to. Nobody, including the Account Owner, can edit or delete an
    archived line in the app; the server has no permission to, so a bug or a bad update can't erase them.
    (Only someone with admin rights to the AWS account itself could alter the database directly.)
  - Both data tables have deletion protection, are kept even if the app is removed, and have 35 days
    of point-in-time restore (DynamoDB console > table > Backups > Restore to point in time).
  - Anyone with "Download backup" switched on can save a full copy file from Setup. Doing this weekly
    gives a copy outside AWS.
  - The app blocks injected scripts (Content-Security-Policy), checks every field on the server, and
    each permission switch is enforced by the server, not just hidden on screen.
  - Every list line records who added it and who ticked Ordered; every archived line records who
    submitted it.

TROUBLESHOOTING
  Codes don't arrive          SMS spend limit, sandbox or toll-free registration (see above);
                              CloudWatch > Logs; SNS > Text messaging > delivery status logs.
  "Not switched on for this pharmacy"   the Account Owner turns on that pharmacy for the person.
  Server errors               CloudWatch > Log groups > /aws/lambda/nortex-reorder-api
  A second, separate copy (e.g. another business):  APP=othername bash deploy.sh

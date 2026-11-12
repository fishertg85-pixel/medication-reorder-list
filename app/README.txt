NorTex Reorder List — Cloud Version (AWS)
==========================================
Hosted on your AWS account. Works in any browser on computers, phones and tablets, and installs to a
phone's home screen. Each pharmacy has its own list, archive and distributor memory.

WHO DOES WHAT
  Host (you)         Runs the AWS account: deploys, updates, AWS settings, backups. Doesn't need a login
                     in the app, but the Account Manager can add you like anyone else.
  Account Manager    The business owner. The only login that can add pharmacies and people, switch each
                     person's access on/off per pharmacy, and switch permissions on/off. This role can't
                     be given to anyone else from the app.
  Everyone else      Signs in with Pharmacy ID + Login ID + password, then a code texted to their phone.
                     Only the Account Manager can change someone's mobile number or reset their password.

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
Per person, the only setup is the mobile number the Account Manager types in when creating the login.
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
  3. Actions > Upload file > choose NorTex_Reorder_Cloud.zip. Then type:
         unzip -o NorTex_Reorder_Cloud.zip -d nortex && cd nortex && bash deploy.sh
  4. It builds everything (5–10 minutes the first time), then asks for:
       the Account Manager's name, Login ID and mobile number, and the first pharmacy's ID and name.
     It prints a temporary password and the web address (something like https://d1abc2def3.cloudfront.net).
  5. Give the Account Manager: the web address, Pharmacy ID, Login ID and temporary password.
     On first sign-in they choose their own password, then enter the texted code.
  Optional short link: make a TinyURL that points to the web address for typing it the first time.
  Security comes from the login and text code, not from the address being hard to guess.

HOST PAGE (no CloudShell needed)
  Once:  bash host.sh make-host neo "Thomas Fisher" 8175551234    (prints a temporary password)
  Then open  <web address>/host.html  and sign in with that Login ID and password (no Pharmacy ID),
  then the texted code. It is a separate gate: only the host login opens it, it asks for the password
  again on reload and locks after 5 minutes idle. From there: reset any password (including the
  Account Manager's), change mobile numbers, switch logins on/off, add people and pharmacies, and
  assign people to pharmacies. The host sees no pharmacy's list unless the Account Manager allows it.
  If you ever lose the host password, run the make-host command again for a new temporary one.

HOST TOOLS (CloudShell, in the same folder)
  bash host.sh people                    bash host.sh reset-password maria.t
  bash host.sh set-phone maria.t 8175551234      bash host.sh off maria.t   /   bash host.sh on maria.t
  bash host.sh pharmacies                bash host.sh add-pharmacy NTX2 "NorTex Pharmacy - Keller" central
  bash host.sh assign maria.t NTX2       bash host.sh unassign maria.t NTX2
  Pharmacies and access can be set up by the host here or by the Account Manager in the app; both
  change the same records.

UPDATES
  Upload the new zip to CloudShell and run the same commands. Updates replace only the app and server
  code. Lists, archives, memory and logins are never touched.

==========================================================================================
THE ACCOUNT MANAGER, IN THE APP (Account Manager tab)
==========================================================================================
  The Account Manager uses the Reorder List like everyone else. Opening the Account Manager tab asks for
  their password again; it locks after 5 minutes without activity on that tab (the screen clears and the
  server refuses Account Manager changes until the password is entered again).
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
  Forgot password? The Account Manager (Account Manager tab > Reset password) or the host (host.sh) gives a
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
  - The archive can only be added to. Nobody, including the Account Manager, can edit or delete an
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
  "Not switched on for this pharmacy"   the Account Manager turns on that pharmacy for the person.
  Server errors               CloudWatch > Log groups > /aws/lambda/nortex-reorder-api
  A second, separate copy (e.g. another business):  APP=othername bash deploy.sh

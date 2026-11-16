# Medication Reorder List (IronLedger)

A pharmacy medication reorder list, hosted on AWS by IronLedger Compliance LLC. It is part of the IronLedger pharmacy compliance program and is meant to be merged into it later.

Staff sign in with **Pharmacy ID + Login ID + password + a texted code**. Each pharmacy has its own reorder list, archive and distributor memory. The app works on computers and phones (installable to the home screen), and a USB barcode scanner can be used on computers.

## What's in this repository

| Folder | What it is |
|---|---|
| `app/` | The AWS app, deployed with `bash deploy.sh` from AWS CloudShell. Contains `template.yaml` (CloudFormation), `lambda/` (API), `web/` (built pages), `host.sh` (host tools) and `README.txt` (setup and operations guide). |
| `app/src/` | Build source for `app/web/`. `assemble.py` combines `shared-drive/index.html` with `parts/*.js`, which add sign-in, cloud saving and the Account Manager tab. |
| `website/` | The ironledgerrx.com company site, with the privacy policy, SMS terms and employee SMS consent form. Deployed with `bash site.sh`; `legal/make_docs.py` regenerates the legal pages. |
| `shared-drive/` | The original single-file version that runs from a shared drive (`index.html` + `nortex_reorder_data.json`). It is also the base for the cloud build. |
| `dev/` | Local test setup: a local AWS stand-in (moto), the real Lambda handler, and Playwright tests. |

## Build

```
python3 app/src/assemble.py        # rebuilds app/web/index.html and app/web/app.js
```

Edit `shared-drive/index.html` (drug search, list, archive, shared features) or `app/src/parts/*.js` (cloud-only features), then rebuild. Commit both the source and the built `app/web/` files.

## Test locally

Needs Python 3 with `moto[server,cognitoidp,dynamodb]`, `boto3` and `playwright`, plus Node 22. Run `npm install` at the repo root first.

```
cd dev
./reset.sh                 # fresh local AWS stand-in + test Account Manager (login "owner")
python3 e2e.py             # full flow: sign-in, lock, people, pharmacies, list, submit, archive, import
python3 attack_test.py     # security checks (run ./reset.sh before each test file)
python3 scan_test.py       # barcode scanner input
python3 recent_test.py     # used-before ordering (recent, then frequency)
python3 tz_test.py         # per-pharmacy time zones
python3 dist_test.py       # adding a distributor
python3 host_test.py       # the host page: its own gate, sign-in and lock
python3 am_people_test.py  # Account Manager: add (pending), first sign-in (active), cancel invite, delete
python3 edge_test.py       # half-made logins from a failed add; expired temporary passwords
python3 session_test.py    # shared computers: a sign-in per tab, idle sign-out; Need column (out of stock / replenish)
python3 calendar_test.py    # Calendar access rules at the API (privilege, pharmacy switch, Account Manager starts it)
python3 calendar_ui_test.py # Calendar tab in the browser: who sees it, start, saving to the server
```

## Deploy

See `app/README.txt`. Use one AWS region for the app and all SMS setup (US East (Ohio) recommended). Updates are the same command and never touch the data.

## Calendar tab (trial: NTX only)

The Compliance Calendar is its own page (`app/web/calendar.html`) shown inside the app on a **Calendar** tab, with no second sign-in. It is built in the `compliance-calendar-lite` repo; `app/src/calendar/calendar_blank.html` is the copy this repo builds from (see `SOURCE.txt` there). Rules, all enforced on the server:

1. the person can open the pharmacy,
2. the person has the **Calendar** privilege (Account Manager tab, per person, off by default),
3. the pharmacy has **Calendar switched on** (Account Manager tab, per pharmacy, off by default),
4. only the Account Manager can start a pharmacy's calendar.

Each pharmacy's calendar is separate data (`STORE#<id>` / `CAL#...` items in the main table, one item per record). People without both switches see only the Reorder List. Not built yet: file attachments on calendar tasks (they need private S3 storage), live updates between people (changes show when the tab is reopened after a few minutes), and the Documents Repository tab.

## Host page

`<web address>/host.html` is a separate page for the IronLedger host login only (created once with `bash host.sh make-host LOGIN "NAME" MOBILE`). It signs in with Login ID, password and a texted code, with no Pharmacy ID, and talks only to `/host/*` on the server, which answers nobody but a host login. From it the host can reset passwords (including the Account Manager's), change mobile numbers, switch logins on or off, add or delete people, add pharmacies (street, suite, city, state, ZIP), assign people to pharmacies, and import a pharmacy's old shared-drive file. It re-asks for the password on reload and locks after 5 minutes idle. The host sees no pharmacy's list unless the Account Manager switches that pharmacy on for the host, and only the host can change the host login.

### Setting up a pharmacy (host page)

The host page has a **Set up a new pharmacy** card (same panels as the pharmacy's own page) and a **Pharmacies** list. Only the host sets a pharmacy's license, NPI, DEA (with the recorded DEA check), NCPDP, Services provided and Calendar switch; the server answers 403 if the pharmacy's Account Manager tries to change them or to add a pharmacy. The Account Manager's card shows those fields read-only and lets them edit name, address, phone, fax, email, time zone and hours. The card and its layout live in `app/src/parts/pharm_panels.js` and `pharm_panels.css` (built into the app and also written to `web/` for the host page).

A host login made with role `rep` (Lambda `makeHost`, `role: "rep"`) is limited: password resets and privilege changes on active people (ID live) who have an account type, nothing else; no direct pharmacy writes. A supervisor assigns a rep to pharmacies on the host page; the rep drafts changes (never services, the Calendar switch or DEA checks) and a supervisor approves or rejects them. Identity values (name, address, license, NPI, DEA, NCPDP) need a written reason to change even for the host, every change is kept in a per-pharmacy history, and each pharmacy has a generated, never-changing IronLedger account number.

**Layout standard:** every page is designed with the layout editor (`dev/build_layout_editor.py <page>`); the engine is `app/src/parts/layout_engine.js`.

## Data safety

- Archived orders can only be added to. The API's IAM role has no delete or update permission on the archive table.
- Both data tables have deletion protection, 35-day point-in-time recovery, and are kept if the stack is deleted.
- Never commit `app/web/config.js`; deploy.sh writes it for each deployment.

2026 IronLedger LLC

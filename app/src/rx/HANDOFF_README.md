# NorTex Rx Intake (Transfer In / Telephone Order): handoff for the IronLedger suite build

For the Claude session that builds the IronLedger suite (Calendar, Documents, Reorder List tabs). Neo asked for this function to become a tab in the suite. This package is the working function as a standalone page, plus notes on what to change when it moves into the suite. Nothing here has been connected to the suite repo; I never saw that repo.

Version: 2026-11-19. Tested in headless Chromium (Playwright); not tested on the pharmacy computers or against the live NPI Registry from a browser.

## 1. What is in the package

| File | What it is |
|---|---|
| `NorTex_Rx_Intake.html` | The whole function as one working file (1.1 MB). Open it in Chrome or Edge to see exactly what Neo uses today. This is the behavior reference. |
| `parts/head.html` | Doctype, title, Google Fonts link (IBM Plex Sans and Mono). |
| `parts/rx_intake_body.html` | The page markup (header, panels, Rx card template, copy bar, prompts). |
| `parts/rx_intake.css` | All styles. Light and dark themes use CSS variables. |
| `parts/rx_intake_app.js` | All form logic, lookups, directory, PDF layout. One IIFE. |
| `parts/rx_zip_data.js` | `const ZIPS = "..."`: US ZIP to city and state table (about 700 KB). Used to fill city and state from a ZIP. Must load before the app script. |
| `parts/vendor_jspdf.js` | jsPDF, minified (about 360 KB). PDFs are built in the browser. |
| `build_single_file.py` | Rebuilds the single file from `parts/`. I checked the rebuild is byte-identical to `NorTex_Rx_Intake.html`. |

Suite repo convention (from the project notes) is `src/parts/<page>_panels.js` plus `assemble.py`. The parts above are split so they can be dropped into that structure. High confidence the split is clean; I have not seen `assemble.py`.

## 2. What the function does (behavior to preserve)

Order types (toggle at top): **Telephone order** and **Transfer in**. Some panels and fields show only for one type (`data-only="tel"` / `"xfer"`).

Panels, in order:
1. **Receiving Pharmacy.** NorTex name, address, phone, fax, TX license, DEA, NPI are static text. Receiving pharmacist is a dropdown (remembered in localStorage `nortex_rph`); RPh license and PIC and PIC license fill automatically.
2. **Transferring Pharmacy** (transfer only). Name, address, phone, fax, license, NPI, DEA, transferring pharmacist and license. Lookup by name, phone or NPI against the saved directory, then the NPI Registry.
3. **Patient.** Last, first, DOB, sex (dropdown M/F/U), phone, address, city/state/ZIP.
4. **Prescriber.** Last, first, credentials, NPI, DEA, TX license, address, phone, fax, plus (telephone only) person calling and call-back number. Same lookup as the pharmacy.
5. **Prescriptions.** One or more Rx cards: drug (type-ahead from NLM RxTerms), strength and units, dosage form, NDC (type or pick, via NLM RxNav), directions, quantity, refills, days supply, DAW/substitution (dropdown), schedule, and for transfers: original Rx number and date, remaining quantity and refills, first and last fill dates. "Never filled at pharmacy of origin" fills the dates with NEVER FILLED and makes remaining quantity and refills equal the originals (locked, follows edits).
6. **Actions.** Create PDF for fax, Clear form.

Rules built in:
- Required fields: receiving pharmacist, patient name and DOB, prescriber last name; telephone adds person calling; transfer adds transferring pharmacy and pharmacist, original Rx number, remaining refills. Per Rx: drug, directions, quantity, units when a strength is typed. Controlled schedules also require prescriber DEA and patient address (and transferring DEA on transfers). CII cannot be transferred.
- DEA fields (prescriber and transferring pharmacy) are grayed out while every Rx is Non-controlled.
- Formats: dates 00/00/0000, phones 000-000-0000, all text uppercase, ZIP fills city and state.
- Text shrinks (down to 6 px) so nothing is cut off in a field. Field text is 11 px, field titles 12 px, titles capitalized.
- Light/dark toggle (sun/moon), saved in localStorage `nortex_theme`.

PDF flow (after "Create PDF for fax"):
- The copy bar lists the PDFs with Open and Download. Nothing is stored server-side; closing the page discards them.
- The form stays editable. Adding or changing anything shows "form has changed" and the button becomes **Update PDF**, which rebuilds with the new content and a new date/time stamp.
- With two or more Rx, a switch toggles **One form, all prescriptions** and **Separate form for each prescription**. Separate also gives **Print all consecutively (one print job)**, a single file with one prescription per page group.
- PDF top right reads "Date/Time Transferred" (transfer) or "Date/Time Transcribed" (telephone). Long values shrink to fit rather than clip.
- **Done, clear form**: on a telephone order it asks "Keep the prescriber for the next patient?" and, if yes, keeps the prescriber block, person calling and call-back number. The manual Clear form asks the same way. Transfers do not ask.

## 3. Changes needed for the suite (my recommendations; Neo has not approved these)

### 3a. Lookups: replace the browser extension with the server
Today the NPI Registry and the Census address lookup cannot be called from a web page (the sites do not allow it), so the standalone form relies on a Chrome/Edge extension ("NorTex NPI Bridge"). Inside an AWS-hosted suite the Lambda can make these calls, so **the extension is not needed**. High confidence on the cause; I did not test the sites from a browser, but the extension exists only for this reason.

All lookups go through one function, `bridgeGet(url)` in `rx_intake_app.js`, which sends `NORTEX_NPI_REQ` messages and expects parsed JSON back. To move to the server:
- Replace the body of `bridgeGet(url)` with a call to a suite endpoint (for example `POST /api/rx-lookup {url}`) that returns the parsed JSON, and set `NPI_BRIDGE = true` and `ADDR_BRIDGE = true` at startup. `npiFetch`, the address lookup and the NLM fallback already route through it.
- Server allowlist (copy this exactly; the extension enforces the same):
  - `https://npiregistry.cms.hhs.gov/api/` (NPPES API v2.1, JSON; query string is built in `npiSearch`)
  - `https://geocoding.geo.census.gov/geocoder/` (one-line address)
  - `https://clinicaltables.nlm.nih.gov/api/` (RxTerms)
  - `https://rxnav.nlm.nih.gov/REST/` (RxNav)
  - https only, GET only, no redirects off those hosts.
- The NLM calls (RxTerms and RxNav) already work directly from a browser; the server route is only the fallback, and can be skipped.
- Remove the "Lookups: ..." status line and the extension reference links (`.reglink`).

Reference for the old extension (not needed once the server route exists): content script answers `NORTEX_NPI_PING` with `NORTEX_NPI_READY {address:true}`, forwards `NORTEX_NPI_REQ {id,url}`, returns `NORTEX_NPI_RES {id,ok,data|error}`.

### 3b. Directory storage: shared, not per-browser
Today the saved pharmacies and prescribers live in `localStorage` key `nortex_rx_directory_v1` as `{ph:[...], pr:[...]}`, so each browser has its own. Import and Export directory (JSON) buttons exist because of that. In the suite this should be one shared list per pharmacy. Hooks: `loadDir()` and `persistDir()` and the `dir` object. Record shapes:
- Pharmacy: `{_id, name, addr, city, state, zip, phone, fax, license, npi, dea, updatedAt}`
- Prescriber: `{_id, name ("LAST, FIRST"), last, first, cred, npi, dea, addr, city, state, zip, phone, fax, license, updatedAt}`
- `_id` is `npi_<NPI>` when an NPI is present, otherwise a generated id. Phones and faxes are stored as digits.
Keep Import/Export for moving Neo's existing directory in. Open question: DEA numbers are stored in the directory today; confirm the suite is allowed to store them server-side.

### 3c. Patient information: keep it off the server
The standalone form stores no patient information; PDFs are built and held in browser memory only. Documents in the suite is explicitly "blank masters only, no patient information". I recommend the Rx Intake tab keep the same rule: no patient fields, Rx data or PDFs sent to or stored on the server, and no patient data in the activity log. Only the shared directory (pharmacy and prescriber records) is stored. This is my recommendation, not a stated requirement.

### 3d. Configuration to take from the suite instead of constants
In `rx_intake_app.js`, near the top: `STAFF` (receiving pharmacists with license numbers, and the PIC) and `FAX_NUMBER` ("8175498796"). Both are hardcoded and readable by anyone who opens the page. In the suite they should come from the pharmacy's people list and pharmacy setup. The receiving-pharmacy block (name, address, phone, fax, license, DEA, NPI) is static text in `rx_intake_body.html` and should come from pharmacy setup as well. Values in the file today belong to NorTex (pharmacy ID `NTX1`).

### 3e. Suite standards that apply (from the project notes, as I read them)
- **Layout editor standard (2026-11-16):** every suite page is a PAGE object with panels arranged by Neo in the layout editor on a 12-column grid. Suggested panels for this page: Receiving Pharmacy, Transferring Pharmacy, Patient, Prescriber, Prescriptions, Actions and PDF copies. The current page is a single-column stack, not a layout-editor page; that arrangement is Neo's call.
- **Look:** `suite.css` (near-white page, white panels, steel-blue accent, IBM Plex Sans, underlined tabs). The standalone CSS uses its own variables and a teal accent; map them to the suite's. The light/dark toggle is standalone-only; confirm whether the suite has one before keeping it.
- **Labels capitalized, no text wrapping** (Neo's standing preferences). Done in this page via CSS; keep it.
- **Footer:** "2026 IronLedger LLC" with the logo, per Neo. Not on this page yet.
- **Access:** tabs are limited by the `SUITE_USERS` list (NTX1: tfisher85, mferreiro, eoviedo, mamare). Who gets an "Rx Intake" tab is a decision for Neo (see section 5).
- **Tab name and position:** not decided.

### 3f. Do not break
- Script order: jsPDF, then `rx_zip_data.js`, then the app script.
- The app script is one IIFE using plain DOM ids (`pt_last`, `pr_npi`, `rx1-drug` style card ids). Embedding it in a page that already has elements with those ids will collide. Prefix or scope them if the suite page shares a document with other tabs (the suite appears to be a single page app).
- jsPDF is about 360 KB and the ZIP table 700 KB. Load them only when this tab is opened.
- `pagehide` revokes PDF object URLs; keep that so PDF copies do not linger.

## 4. How it was tested (2026-11-19, headless Chromium)
- Create PDF, add a second drug, Update PDF: PDF text contained both drugs; stale notice appears and clears.
- One form / separate toggle: two PDFs plus the print-all file; both drugs present; switching back works.
- Telephone Done: keep-prescriber prompt appears; Keep retains prescriber, caller and call-back and clears patient and Rx; Clear everything clears all; manual Clear in telephone mode prompts; transfer mode does not.
- Never filled: remaining equals original, locked, follows edits, unlocks on uncheck.
- DEA gating, dropdowns, theme toggle, shrink-to-fit labels, no console errors.
- Extension handshake tested earlier in a real Chromium; live NPI/Census calls could not be tested from my environment (no outbound access to those sites).

## 5. Open decisions for Neo
1. Who sees the Rx Intake tab: the four named users, all NTX staff, or other pharmacies too.
2. Shared directory per pharmacy (recommended) or keep per-browser with Import/Export.
3. Is storing prescriber and pharmacy DEA numbers on the server acceptable.
4. Layout: arrange it in the layout editor (suite standard) or keep the current single-column stack.
5. Keep the light/dark toggle in the suite, or follow the suite's single look.
6. The telephone-order footer note on the PDF ("reduced to writing by the receiving pharmacist ... 22 TAC 291.34 ...") is still printed; the transfer note was removed at Neo's request. Confirm the telephone note stays.
7. The Excel/VBA version (`NorTexIntake.bas`) does not have any of the 2026-10-09 to 2026-11-19 changes and is not part of this package.

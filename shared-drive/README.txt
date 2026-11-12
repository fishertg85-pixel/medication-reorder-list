NorTex Pharmacy Reorder List
============================
A shared reorder list that runs as one page in Chrome or Edge. Drug
search is live (needs internet) and uses the same National Library of
Medicine lookups as the NorTex Rx Intake form: RxTerms for drug names
and strengths, RxNav for NDCs. "DailyMed" links open each NDC's label.

FILES (keep them together in one folder on the shared drive)
  index.html                 the app: open this
  nortex_reorder_data.json   the shared list + archive (everyone uses this one)

UPDATING THE APP  (your list and archive are never touched)
  Updates come as index.html only. Replace index.html in the folder and
  leave nortex_reorder_data.json alone. Updates never include a data file.

FIRST TIME, ON EACH COMPUTER
  1. Open index.html > Setup > "Connect to shared file..." > pick
     nortex_reorder_data.json in this folder > Allow. The browser
     remembers it. If it later shows "Reconnect", click it and Allow.
     (Brand-new install with no data file yet: "Create new data file...")
  2. Setup > "Test drug search". It should say "Drug search is ready."

SAFETY NET
  - Every computer keeps automatic backups of the list each time it
    saves (Setup > Backups on this computer: last 30 saves + one per day
    for 60 days). Restore or download any of them.
  - If the shared file ever shows fewer archived orders than a computer
    last saw (replaced, emptied, older copy), that computer refuses to
    save over it and shows a "Restore that backup" button at the top.

DAILY USE
  - Type part of a drug name (3+ letters) and strength: "ateno 25",
    "lisin 10". Click the drug + strength (or press Enter) and it's
    added to the list right away.
  - NDC box in each row does two things: click it to pick from that
    drug's NDCs (shows manufacturer and package size), or type the exact
    NDC (dashes optional). Typing part of an NDC narrows the list.
    Once chosen, the box shows only the NDC; Manufacturer and Pkg Size
    fill in by themselves. "Any NDC" clears it.
  - Or type an NDC in the top search box and press Enter to add that
    exact NDC directly.
  - Distributor not on the list? Choose "+ Add a distributor not on the list..." at the bottom of the
    Distributor box and type its name. It stays on this pharmacy's list for everyone.
  - Used before = listed first (★). In the search box, in each line's NDC list and in the Distributor
    list: the most recently used one is on top, then the others used before by how often they were
    submitted ("ordered 3×"), then everything else. The distributor is saved the moment it's picked;
    if it changes, the newest choice fills in next time.
  - Distributor: pick where it's ordered from. After a drug has been
    ordered once, its distributor fills in automatically next time
    (matched by NDC, or by drug + strength), marked "last used". You can
    always change it. Blank ones are highlighted; Submit warns about them.
  - Ordered (checkbox after Qty): tick each line once its order has been
    placed. Ticked lines turn green and the header shows "Ordered: x of y".
    Everyone sees the ticks. Submit warns if any line isn't ticked.
  - Adjust Pkg Size and Qty in the row. Pkg Size fills from the NDC's
    package, or from what was used last time for that NDC.
  - NDC lookup order: RxNorm first; if RxNorm doesn't have it yet, the
    FDA NDC Directory (openFDA, built from the same labels DailyMed shows,
    updated daily, so brand-new packages and repackagers show up there
    first); then DailyMed itself if the NorTex extension is installed;
    then anything entered by hand here before. The search list says
    which source found it.
  - Barcode scanner: click in the search box and scan the bottle (UPC) or
    the 2D code on the box. When that NDC is found, the line is added with
    drug, strength, NDC, manufacturer, package size and last distributor.
    (Fixed: a fast scan could add the previous search's drug instead.)
  - Typed a 10-digit NDC without dashes and more than one product
    matches? All of them are listed; pick the one on your bottle.
  - Still not found but it's in your hand? Click "+ Add NDC ... by hand",
    type the name/strength/form as on the bottle (manufacturer optional).
    It is saved for that NDC, so next time anyone types or scans it, it
    comes up straight away.
  - "DailyMed" opens that product's label.
  - "Submit order" moves everything to the Archive. Each submitted order
    shows as one line there; click it to see its lines (or "Expand all").
  - Strengths are shown the way the bottle or box reads them, not the
    way RxNorm stores them: mixed salts are added up (amphetamine salts
    "5-5-5-5 mg" shows as 20 MG), pens and auto-injectors show the amount
    per pen (Zepbound 5 MG/0.5 ML, Ozempic 2 MG/3 ML), and patches show the
    labeled rate (estradiol 0.05 MG/DAY, fentanyl 25 MCG/HR). The search
    list shows RxNorm's wording underneath ("RxNorm lists it as ...").
  - Pencil button next to a drug name: type the name and strength exactly
    as on your bottle. It is remembered for that NDC and used every time
    that product is added again. (Lines already on the list from before
    this update were converted where possible; archived orders are kept
    exactly as they were submitted.)
  - In NDC lists the middle (product) code is in bold, to help tell
    look-alike NDCs apart.
  - Sun/moon button (top right) switches light/dark mode.

GOOD TO KNOW
  - NDCs not in RxNorm (supplies, bulk compounding ingredients, some
    very new or old packages) won't be found: add those by hand.
  - Changes save to the shared file immediately; other screens update
    within about 8 seconds.
  - Firefox can't save straight to the shared drive (uses manual
    Open/Save in Setup). Use Chrome or Edge.

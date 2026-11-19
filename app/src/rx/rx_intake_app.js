(function(){
const $ = id => document.getElementById(id);
const digits = s => (s||"").replace(/\D/g,"");
const fmtPhone = s => { let d = digits(s); if (d.length===11 && d[0]==="1") d = d.slice(1); return d.length===10 ? `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}` : (s||""); };
let otype = "tel";
let dbReady = false;
/* Pharmacy block, receiving pharmacists and the shared directory come from the suite page around this one (window.parent.ILRX_HOST).
   Patient fields, Rx data and PDFs stay in this page: nothing about a patient is ever sent to the server. */
const HOST = window.parent && window.parent.ILRX_HOST;
["keydown","pointerdown","wheel","input","touchstart"].forEach(t => document.addEventListener(t, () => { try { window.parent.markUse(); } catch(e){} }, { capture: true, passive: true }));   // typing here counts as use for the suite's idle sign-out
let STAFF = { pharmacists: [], pic: null };
let FAX_NUMBER = "";
const RCV = { name: "", addr: "", phone: "", fax: "", lic: "", dea: "", npi: "" };   // receiving pharmacy, from pharmacy setup

/* ===================================================================== */
let storeOk = true;
function persistDir(){ return true; }     // saving is done record by record through the suite (HOST.dirSave / HOST.dirImport)
function updateCount(){ $("dirCount").textContent = `Pharmacy directory: ${dir.ph.length} pharmacies · ${dir.pr.length} prescribers`; }

/* ---------- NPI Registry (CMS NPPES API v2.1) ---------- */
const NPI_API = "https://npiregistry.cms.hhs.gov/api/?version=2.1&limit=10";
const titleCase = s => String(s||"").trim().toUpperCase();
function mapNpi(kind, r){
  const b = r.basic || {}, addrs = r.addresses || [], tax = r.taxonomies || [];
  const loc = addrs.find(a => a.address_purpose === "LOCATION") || addrs[0] || {};
  const prim = tax.find(t => t.primary) || tax[0] || {};
  const lic = tax.find(t => t.license && t.state === "TX") || tax.find(t => t.license) || {};
  const rec = { _id:"", _src:"npi", npi:String(r.number||""),
    addr: titleCase([loc.address_1, loc.address_2].filter(Boolean).join(", ")), city: titleCase(loc.city), state: loc.state||"",
    zip: String(loc.postal_code||"").slice(0,5), phone: digits(loc.telephone_number), fax: digits(loc.fax_number),
    license: lic.license||"", dea:"" };
  if (kind === "ph"){ rec.name = titleCase(b.organization_name); rec.cred = ""; }
  else {
    rec.last = titleCase(b.last_name);
    rec.first = titleCase([b.first_name, b.middle_name ? b.middle_name[0] : ""].filter(Boolean).join(" "));
    rec.name = [rec.last, rec.first].filter(Boolean).join(", ");
    rec.cred = [String(b.credential||"").replace(/\./g,""), prim.desc||""].filter(Boolean).join(", ");
  }
  return rec;
}
/* The NPI Registry and the Census address service cannot be called from a web page, so lookups go through the suite (the server relays them). */
let NPI_BRIDGE = true, ADDR_BRIDGE = true;
function npiStatus(){ const el = document.getElementById("npiStatus"); if (el) el.hidden = true; document.querySelectorAll(".reglink").forEach(a => a.hidden = true); }
function bridgeGet(url){
  if (!HOST) return Promise.reject(new Error("Not connected to the suite"));
  return Promise.race([HOST.lookup(url), new Promise((_, rej) => setTimeout(() => rej(new Error("Lookup timed out")), 15000))]);
}
function npiFetch(url){ return bridgeGet(url).then(j => (j && Array.isArray(j.results)) ? j.results : []); }
async function npiSearch(kind, q){
  q = String(q||"").trim();
  let url = NPI_API + "&enumeration_type=" + (kind === "ph" ? "NPI-2" : "NPI-1");
  const dq = digits(q);
  let isNum = false;
  if (/^\d{10}$/.test(dq) && q.replace(/[\s.-]/g,"").length === 10){ isNum = true; url += "&number=" + dq; }
  else if (kind === "ph"){ if (q.length < 2) return []; url += "&organization_name=" + encodeURIComponent(q) + "*"; }
  else {
    let first = "", last = "";
    const clean = t => String(t||"").replace(/[^A-Za-z' -]/g,"").trim();
    if (q.includes(",")){ const p = q.split(","); last = clean(p[0]); first = clean(p[1]).split(/\s+/)[0] || ""; }
    else { const p = clean(q).split(/\s+/).filter(Boolean); if (!p.length) return []; last = p[p.length-1]; if (p.length > 1) first = p[0]; }
    if (last.length < 2) return [];
    url += "&last_name=" + encodeURIComponent(last) + "*";
    if (first.length >= 2) url += "&first_name=" + encodeURIComponent(first) + "*";
  }
  let results;
  if (isNum) results = await npiFetch(url);
  else { results = await npiFetch(url + "&state=TX"); if (!results.length) results = await npiFetch(url); }
  const out = results.map(r => mapNpi(kind, r));
  out.sort((a,b) => (a.state==="TX"?0:1) - (b.state==="TX"?0:1) || a.name.localeCompare(b.name));
  return out;
}
const dir = { ph: [], pr: [] };
const selected = { ph: null, pr: null };

const PH_FIELDS = {name:"ph_name",addr:"ph_addr",city:"ph_city",state:"ph_state",zip:"ph_zip",phone:"ph_phone",fax:"ph_fax",license:"ph_lic",npi:"ph_npi",dea:"ph_dea"};
const PR_FIELDS = {last:"pr_last",first:"pr_first",cred:"pr_cred",npi:"pr_npi",dea:"pr_dea",addr:"pr_addr",city:"pr_city",state:"pr_state",zip:"pr_zip",phone:"pr_phone",fax:"pr_fax",license:"pr_lic"};
const MAP = { ph: PH_FIELDS, pr: PR_FIELDS };
const COLL = { ph: "pharmacies", pr: "prescribers" };

/* ---------- order type ---------- */
function applyType(){
  otype = document.querySelector('input[name="otype"]:checked').value;
  document.querySelectorAll("[data-only]").forEach(el => el.hidden = el.dataset.only !== otype);
  document.querySelectorAll("[data-lbl-tel]").forEach(el => el.textContent = otype==="xfer" ? el.dataset.lblXfer : el.dataset.lblTel);
  rxCards().forEach(card => {
    const sel = g(card, "sched"), cii = sel.querySelector("[data-tel-only]");
    cii.disabled = otype === "xfer";
    if (otype === "xfer" && sel.value === "CII") sel.value = "Non-controlled";
    schedNoteC(card);
  });
  updateDea();
}
document.querySelectorAll('input[name="otype"]').forEach(r => r.addEventListener("change", applyType));

/* ---------- receiving RPh convenience ---------- */
let staff = { pharmacists: [], pic: null };
function applyRph(){
  const p = staff.pharmacists.find(x => x.name === $("rp_rph").value);
  $("rp_lic").value = p ? p.license : "";
  $("rp_pic").value = p && staff.pic ? staff.pic.name : "";
  $("rp_piclic").value = p && staff.pic ? staff.pic.license : "";
  try { localStorage.setItem("nortex_rph", $("rp_rph").value); } catch(e){}
}
function loadStaff(cfg){
  staff = cfg || staff;
  const sel = $("rp_rph");
  staff.pharmacists.forEach(p => { const o = document.createElement("option"); o.value = p.name; o.textContent = p.name; sel.appendChild(o); });
  try { const last = localStorage.getItem("nortex_rph"); if (last && staff.pharmacists.some(p => p.name===last)) sel.value = last; } catch(e){}
  applyRph();
}
$("rp_rph").addEventListener("change", applyRph);

/* ---------- stamp ---------- */
function nowStamp(){
  const d = new Date(), p = n => String(n).padStart(2,"0");
  return `${p(d.getMonth()+1)}/${p(d.getDate())}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- lookup ---------- */
function describe(kind, r){
  const bits = [r.city && r.state ? `${r.city}, ${r.state}` : (r.city||r.state||""), r.phone ? fmtPhone(r.phone) : "", r.npi ? "NPI "+r.npi : ""].filter(Boolean);
  return bits.join(" · ");
}
function matches(kind, q){
  q = (q||"").trim().toLowerCase(); if (!q) return [];
  const qd = digits(q);
  return dir[kind].filter(r => {
    if ((r.name||"").toLowerCase().includes(q)) return true;
    if (qd.length >= 3 && (digits(r.phone).includes(qd) || digits(r.fax).includes(qd) || (r.npi||"").includes(qd))) return true;
    return false;
  }).slice(0, 8);
}
let openList = null;
function closeList(){ if (openList){ openList.remove(); openList = null; } }
let npiSeq = 0, npiTimer = null;
function renderList(input, localItems, npiState, npiItems){
  const kind = input.dataset.lookup;
  closeList();
  const ul = document.createElement("ul"); ul.className = "suggest"; ul.setAttribute("role","listbox");
  const addHead = t => { const h = document.createElement("li"); h.className = "grp"; h.textContent = t; ul.appendChild(h); };
  const addItem = r => {
    const li = document.createElement("li"); li.setAttribute("role","option");
    const n = document.createElement("span"); n.className="n"; n.textContent = r.name + (r.cred ? ", "+r.cred : "");
    const d = document.createElement("span"); d.className="d"; d.textContent = describe(kind, r);
    li.append(n,d); li._rec = r;
    li.addEventListener("mousedown", e => { e.preventDefault(); fill(kind, r); closeList(); });
    ul.appendChild(li);
  };
  addHead("Saved directory");
  if (localItems.length) localItems.forEach(addItem);
  else { const li = document.createElement("li"); li.className = "empty"; li.textContent = NPI_BRIDGE ? "No saved match." : "No saved match. Fill it in (use the NPI Registry link below), then Save to directory."; ul.appendChild(li); }
  if (npiState){
    addHead("NPI Registry");
    const known = new Set(localItems.map(r => r.npi).filter(Boolean));
    const fresh = (npiItems||[]).filter(r => !known.has(r.npi));
    if (npiState === "loading"){ const li = document.createElement("li"); li.className = "empty"; li.textContent = "Searching NPI Registry…"; ul.appendChild(li); }
    else if (npiState === "error"){ const li = document.createElement("li"); li.className = "empty"; li.textContent = "NPI Registry couldn't be reached from this browser. Check the internet connection, or enter details by hand."; ul.appendChild(li); }
    else if (!fresh.length){ const li = document.createElement("li"); li.className = "empty"; li.textContent = "No NPI Registry match. Try last name, or the 10-digit NPI."; ul.appendChild(li); }
    else fresh.forEach(addItem);
  }
  const first = ul.querySelector('li[role="option"]'); if (first) first.setAttribute("aria-selected","true");
  input.parentElement.appendChild(ul); openList = ul; openList._input = input;
}
function showList(input){
  const kind = input.dataset.lookup, q = input.value.trim();
  closeList(); clearTimeout(npiTimer);
  if (!q) return;
  const local = dbReady ? matches(kind, q) : [];
  const isPhone = input.id.endsWith("_phone");
  const canNpi = NPI_BRIDGE && !isPhone && (/^\d{10}$/.test(digits(q)) || (!input.id.endsWith("_npi") && q.replace(/[^A-Za-z]/g,"").length >= 2));
  renderList(input, local, canNpi ? "loading" : null);
  if (!canNpi) return;
  let npiQuery = q;
  if (input.id === "pr_last" && v("pr_first")) npiQuery = q + ", " + v("pr_first");
  if (input.id === "pr_first") npiQuery = v("pr_last") ? v("pr_last") + ", " + q : "";
  if (!npiQuery){ renderList(input, local, null); return; }
  const seq = ++npiSeq;
  npiTimer = setTimeout(() => {
    npiSearch(kind, npiQuery)
      .then(items => { if (seq !== npiSeq || document.activeElement !== input) return; renderList(input, dbReady ? matches(kind, input.value) : [], "done", items); })
      .catch(() => { if (seq !== npiSeq || document.activeElement !== input) return; renderList(input, dbReady ? matches(kind, input.value) : [], "error"); });
  }, 450);
}
function fill(kind, r){
  const m = MAP[kind];
  if (kind === "pr" && !r.last && r.name){           // older entries saved as one name
    const nm = String(r.name).toUpperCase();
    if (nm.includes(",")){ const p = nm.split(","); r = Object.assign({}, r, { last: p[0].trim(), first: p.slice(1).join(",").trim() }); }
    else { const p = nm.trim().split(/\s+/); r = Object.assign({}, r, { last: p.pop() || "", first: p.join(" ") }); }
  }
  Object.entries(m).forEach(([k,id]) => { $(id).value = (k==="phone"||k==="fax") ? fmtPhone(r[k]) : String(r[k]||"").toUpperCase(); });
  selected[kind] = r._id || null;
  $(kind+"Tag").textContent = r._src === "npi" ? "FROM NPI REGISTRY, ADD DEA" : "FROM DIRECTORY";
  $(kind+"Msg").textContent = "";
}
document.querySelectorAll("[data-lookup]").forEach(inp => {
  inp.addEventListener("input", () => { selected[inp.dataset.lookup] = null; $(inp.dataset.lookup+"Tag").textContent = ""; showList(inp); });
  inp.addEventListener("focus", () => { if (inp.value.trim()) showList(inp); });
  inp.addEventListener("blur", () => { inp._blurT = setTimeout(() => { if (openList && openList._input === inp) closeList(); }, 120); });
  inp.addEventListener("focus", () => clearTimeout(inp._blurT));
  inp.addEventListener("keydown", e => {
    if (!openList || openList._input !== inp) return;
    const opts = [...openList.querySelectorAll('li[role="option"]')]; if (!opts.length) return;
    let i = opts.findIndex(o => o.getAttribute("aria-selected")==="true");
    if (e.key==="ArrowDown"||e.key==="ArrowUp"){ e.preventDefault(); opts[i]?.removeAttribute("aria-selected"); i = (i + (e.key==="ArrowDown"?1:-1) + opts.length) % opts.length; opts[i].setAttribute("aria-selected","true"); opts[i].scrollIntoView({block:"nearest"}); }
    else if (e.key==="Enter"){ e.preventDefault(); fill(inp.dataset.lookup, opts[Math.max(i,0)]._rec); closeList(); }
    else if (e.key==="Escape"){ closeList(); }
  });
});
/* ---------- input formatting: caps, 00/00/0000 dates, 000-000-0000 phones, ZIP -> city/state ---------- */
const DATE_IDS = ["pt_dob"];
const PHONE_IDS = ["pr_phone","pr_fax","ph_phone","ph_fax","pr_callback","pt_phone"];
const ZIP_SETS = [["pt_zip","pt_city","pt_state"],["pr_zip","pr_city","pr_state"],["ph_zip","ph_city","ph_state"]];
const DIGIT_IDS = { pr_npi:10, ph_npi:10 };
const maskDate = s => { const d = digits(s).slice(0,8); return d.length>4 ? d.slice(0,2)+"/"+d.slice(2,4)+"/"+d.slice(4) : d.length>2 ? d.slice(0,2)+"/"+d.slice(2) : d; };
const maskPhone = s => { let d = digits(s); if (d.length===11 && d[0]==="1") d = d.slice(1); d = d.slice(0,10); return d.length>6 ? d.slice(0,3)+"-"+d.slice(3,6)+"-"+d.slice(6) : d.length>3 ? d.slice(0,3)+"-"+d.slice(3) : d; };
function validDate(t){
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t); if (!m) return false;
  const mo = +m[1], da = +m[2], yr = +m[3]; if (mo<1||mo>12||da<1||yr<1900||yr>2100) return false;
  return da <= new Date(yr, mo, 0).getDate();
}
function flag(el, ok){ el.classList.toggle("bad", !ok); el.title = ok ? "" : (el.dataset.kind === "date" ? "Enter a real date as 00/00/0000" : "Enter a 10-digit number"); }
function checkField(el){
  if (el.disabled){ flag(el, true); return true; }
  const t = el.value.trim();
  if (!t){ flag(el, true); return true; }
  const ok = el.dataset.kind === "date" ? validDate(t) : el.dataset.kind === "phone" ? /^\d{3}-\d{3}-\d{4}$/.test(t) : true;
  flag(el, ok); return ok;
}
let zipIndex = null;
function zipLookup(z){
  if (!zipIndex){ zipIndex = new Map(); ZIPS.split(";").forEach(e => zipIndex.set(e.slice(0,5), [e.slice(7), e.slice(5,7)])); }
  return zipIndex.get(z) || null;
}
DATE_IDS.forEach(id => { const el = $(id); el.dataset.kind = "date"; el.inputMode = "numeric"; el.maxLength = 10;
  el.addEventListener("input", () => { el.value = maskDate(el.value); if (el.value.length === 10) checkField(el); else flag(el, true); });
  el.addEventListener("blur", () => checkField(el)); });
PHONE_IDS.forEach(id => { const el = $(id); el.dataset.kind = "phone"; el.inputMode = "numeric"; el.maxLength = 12; el.placeholder = "000-000-0000";
  el.addEventListener("input", () => { el.value = maskPhone(el.value); if (el.value.length === 12) checkField(el); else flag(el, true); });
  el.addEventListener("blur", () => checkField(el)); });
Object.entries(DIGIT_IDS).forEach(([id,max]) => { const el = $(id); el.inputMode = "numeric"; el.maxLength = max;
  el.addEventListener("input", () => { el.value = digits(el.value).slice(0,max); }); });
ZIP_SETS.forEach(([zid, cid, sid]) => {
  const z = $(zid), c = $(cid), st = $(sid);
  z.inputMode = "numeric"; z.maxLength = 5;
  z.addEventListener("input", () => {
    z.value = digits(z.value).slice(0,5);
    if (z.value.length !== 5) return;
    const hit = zipLookup(z.value); if (!hit) return;
    if (!c.value.trim() || c.dataset.auto === "1"){ c.value = hit[0]; c.dataset.auto = "1"; }
    if (!st.value.trim() || st.dataset.auto === "1"){ st.value = hit[1]; st.dataset.auto = "1"; }
  });
  c.addEventListener("input", () => { delete c.dataset.auto; });
  st.addEventListener("change", () => { delete st.dataset.auto; });
});
["pr_dea","ph_dea"].forEach(id => { const el = $(id); el.maxLength = 9; el.addEventListener("input", () => { el.value = el.value.replace(/[^A-Za-z0-9]/g,"").toUpperCase(); }); });
// everything else: capital letters only
document.addEventListener("input", e => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || !el.closest(".wrap") || ["radio","checkbox","file"].includes(el.type)) return;
  if (el.value === el.value.toUpperCase()) return;
  const p = el.selectionStart, q = el.selectionEnd;
  el.value = el.value.toUpperCase();
  try { el.setSelectionRange(p, q); } catch(err){}
}, true);

/* ---------- address lookup: U.S. Census Bureau geocoder (through the NorTex extension) ---------- */
const CENSUS = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=";
const UNIT_RE = /\s*,?\s*\b(?:STE|SUITE|APT|APARTMENT|UNIT|BLDG|BUILDING|RM|ROOM|LOT|TRLR|#)\s*#?\s*[A-Z0-9-]+\s*$/i;
let cSeq = 0, cTimer = null;
function addrList(input, state, items){
  closeList();
  const ul = document.createElement("ul"); ul.className = "suggest"; ul.setAttribute("role","listbox");
  const note = t => { const li = document.createElement("li"); li.className = "empty"; li.textContent = t; ul.appendChild(li); };
  if (state === "loading") note("Checking the address…");
  else if (state === "error") note("Address lookup isn't available right now. Type the address; the ZIP still fills city and state.");
  else if (!items.length) note("No match yet. Finish the street address, or add the ZIP code first.");
  else items.forEach((m, i) => {
    const c = m.addressComponents || {};
    const li = document.createElement("li"); li.setAttribute("role","option"); if (i === 0) li.setAttribute("aria-selected","true");
    const n = document.createElement("span"); n.className = "n"; n.textContent = String(m.matchedAddress || "").split(",")[0].toUpperCase();
    const d = document.createElement("span"); d.className = "d"; d.textContent = [c.city, [c.state, c.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ").toUpperCase();
    li.append(n, d); li._pred = m;
    li.addEventListener("mousedown", e => { e.preventDefault(); pickAddress(input, m); });
    ul.appendChild(li);
  });
  const a = document.createElement("li"); a.className = "gattr"; a.textContent = "Address data: U.S. Census Bureau"; ul.appendChild(a);
  input.parentElement.appendChild(ul); openList = ul; openList._input = input;
}
function addrInput(input){
  clearTimeout(cTimer);
  const q = input.value.trim();
  if (!ADDR_BRIDGE || !/^\d+[A-Z]?\s+\S.{2,}/i.test(q)){ if (openList && openList._input === input) closeList(); return; }
  const seq = ++cSeq, pre = input.dataset.addr;
  cTimer = setTimeout(async () => {
    if (document.activeElement !== input) return;
    addrList(input, "loading", []);
    const street = q.replace(UNIT_RE, "").trim();
    const where = [v(pre + "_city"), v(pre + "_state"), v(pre + "_zip")].filter(Boolean).join(" ");
    try {
      const j = await bridgeGet(CENSUS + encodeURIComponent(where ? street + ", " + where : street));
      const m = (j && j.result && Array.isArray(j.result.addressMatches)) ? j.result.addressMatches : [];
      if (seq !== cSeq || document.activeElement !== input) return;
      addrList(input, "done", m.slice(0, 6));
    } catch(e){
      if (seq !== cSeq || document.activeElement !== input) return;
      addrList(input, "error", []);
    }
  }, 700);
}
function pickAddress(input, m){
  closeList();
  const pre = input.dataset.addr, c = m.addressComponents || {};
  const unit = (input.value.match(UNIT_RE) || [""])[0].replace(/^[\s,]+/, "").toUpperCase();
  const street = String(m.matchedAddress || "").split(",")[0].trim().toUpperCase();
  input.value = street + (unit ? " " + unit : "");
  if (c.city) $(pre + "_city").value = String(c.city).toUpperCase();
  if (c.state) $(pre + "_state").value = String(c.state).toUpperCase();
  if (c.zip) $(pre + "_zip").value = String(c.zip);
  [pre + "_city", pre + "_state"].forEach(id => delete $(id).dataset.auto);
}
document.querySelectorAll("[data-addr]").forEach(inp => {
  inp.addEventListener("input", () => addrInput(inp));
  inp.addEventListener("blur", () => { inp._blurT = setTimeout(() => { if (openList && openList._input === inp) closeList(); }, 150); });
  inp.addEventListener("focus", () => clearTimeout(inp._blurT));
  inp.addEventListener("keydown", e => {
    if (!openList || openList._input !== inp) return;
    const opts = [...openList.querySelectorAll('li[role="option"]')]; if (!opts.length) return;
    let i = opts.findIndex(o => o.getAttribute("aria-selected")==="true");
    if (e.key==="ArrowDown"||e.key==="ArrowUp"){ e.preventDefault(); opts[i]?.removeAttribute("aria-selected"); i = (i + (e.key==="ArrowDown"?1:-1) + opts.length) % opts.length; opts[i].setAttribute("aria-selected","true"); }
    else if (e.key==="Enter"){ e.preventDefault(); pickAddress(inp, opts[Math.max(i,0)]._pred); }
    else if (e.key==="Escape"){ closeList(); }
  });
});

/* ---------- prescriptions: one card per Rx (click + to add) ---------- */
let rxUid = 0;
const rxCards = () => [...document.querySelectorAll("#rxList .rxcard")];
const g = (card, f) => card.querySelector('[data-f="' + f + '"]');
const gv = (card, f) => { const el = g(card, f); return el ? (el.value || "").trim() : ""; };
function addRx(){
  rxUid++;
  const wrap = document.createElement("div");
  wrap.innerHTML = $("rxTpl").innerHTML.replace(/__N__/g, rxUid).trim();
  const card = wrap.firstElementChild;
  $("rxList").appendChild(card);
  wireRx(card);
  renumberRx();
  applyType();
  return card;
}
function removeRx(card){ closeList(); card.remove(); renumberRx(); updateDea(); }
function renumberRx(){
  const cs = rxCards();
  cs.forEach((c, i) => {
    c.querySelector(".rxnum").textContent = "Prescription " + (i + 1) + (cs.length > 1 ? " of " + cs.length : "");
    c.querySelector(".rxremove").hidden = cs.length === 1;
  });
  $("rxCount").textContent = cs.length > 1 ? cs.length + " prescriptions" : "";
}
function schedNoteC(card){
  const val = gv(card, "sched"), n = g(card, "schedNote");
  let t = "";
  if (val === "CII") t = "CII telephone order: emergency only, quantity limited to the emergency period, signed Rx due within 7 days.";
  else if (val !== "Non-controlled" && otype === "xfer") t = "CIII–V: one transfer only. Record the transferring pharmacy's DEA #.";
  else if (val !== "Non-controlled") t = "Controlled substance: Texas requires e-Rx unless an exception applies. Record prescriber DEA #.";
  n.textContent = t; n.hidden = !t;
}
function toggleOtherC(card){
  const u = gv(card, "unit") === "OTHER", f = gv(card, "form") === "OTHER";
  g(card, "unitOtherBox").hidden = !u; g(card, "formOtherBox").hidden = !f; g(card, "otherRow").hidden = !(u || f);
}
function applyNeverC(card){
  const on = g(card, "never").checked;
  ["first", "last"].forEach(f => { const el = g(card, f); el.disabled = on; el.value = on ? "NEVER FILLED" : ""; flag(el, true); });
  // never filled: nothing has been dispensed, so remaining = original
  [["qrem", "qty"], ["rrem", "ref"]].forEach(([r, o]) => { const el = g(card, r); el.readOnly = on; el.value = on ? g(card, o).value : ""; });
}
function syncNeverC(card){
  if (!g(card, "never").checked) return;
  g(card, "qrem").value = g(card, "qty").value;
  g(card, "rrem").value = g(card, "ref").value;
}
/* DEA # fields are only available when a prescription is controlled (CII-CV) */
function updateDea(){
  const controlled = rxCards().some(c => gv(c, "sched") !== "Non-controlled");
  ["pr_dea", "ph_dea"].forEach(id => { $(id).disabled = !controlled; });
}
const unitValC = card => gv(card, "unit") === "OTHER" ? gv(card, "unit_other") : gv(card, "unit");
const formValC = card => gv(card, "form") === "OTHER" ? gv(card, "form_other") : gv(card, "form");
const strengthValC = card => [gv(card, "str"), unitValC(card)].filter(Boolean).join(" ");

/* ---- drug lookup: NLM RxTerms (RxNorm) ---- */
const RXT = "https://clinicaltables.nlm.nih.gov/api/rxterms/v3/search?ef=STRENGTHS_AND_FORMS,RXCUIS&maxList=8&terms=";
async function rxtGet(url){
  try { const r = await fetch(url, { headers: { "Accept": "application/json" } }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
  catch(e){ if (NPI_BRIDGE) return bridgeGet(url); throw e; }
}
const UNIT_MAP = { "mg":"MG","mcg":"MCG","g":"G","mg/ml":"MG/ML","mcg/ml":"MCG/ML","mg/5ml":"MG/5 ML","mg/g":"MG/G","%":"%","unt":"UNITS","units":"UNITS",
  "unt/ml":"UNITS/ML","units/ml":"UNITS/ML","meq":"MEQ","meq/ml":"MEQ/ML","mmol":"MMOL","iu":"IU","mcg/hr":"MCG/HR","mg/24hr":"MG/24 HR","mg/24 hr":"MG/24 HR",
  "mg/actuat":"MG/ACTUATION","mcg/actuat":"MCG/ACTUATION","mg/dose":"MG/DOSE","ml":"ML" };
function mapForm(t){
  const x = " " + t.toUpperCase() + " ", has = w => x.includes(w);
  const tab = /\bTAB\b|TABLET/.test(x), cap = /\bCAP\b|CAPSULE/.test(x), ext = /\b(XR|ER|SR|XL|ES|CR|LA)\b|\d+ HR\b/.test(x), dr = /\bDR\b|DELAYED/.test(x);
  if (has("DISINTEGRAT") || /\bODT\b/.test(x)) return "TABLET, ODT";
  if (has("CHEW")) return "TABLET, CHEWABLE";
  if (/\bSL\b|SUBLINGUAL/.test(x)) return "TABLET, SUBLINGUAL";
  if (tab && dr) return "TABLET, DELAYED RELEASE";
  if (cap && dr) return "CAPSULE, DELAYED RELEASE";
  if (tab && ext) return "TABLET, EXTENDED RELEASE";
  if (cap && ext) return "CAPSULE, EXTENDED RELEASE";
  if (tab) return "TABLET";
  if (cap) return "CAPSULE";
  if (has("OPHTH")) return has("OINT") ? "OINTMENT, OPHTHALMIC" : "DROPS, OPHTHALMIC";
  if (has("OTIC")) return "DROPS, OTIC";
  if (has("NASAL")) return "SPRAY, NASAL";
  if (has("AEROSOL") || has("MDI") || has("ACTUAT") && !has("POWDER")) return "INHALER, MDI";
  if (has("DPI") || (has("INHAL") && has("POWDER"))) return "INHALER, DPI";
  if (has("NEBUL") || /INHAL\w*\s+(SOL|SOLN|SOLUTION)\b/.test(x)) return "SOLUTION, NEBULIZER";
  if (has("INHAL")) return "INHALER, MDI";
  if (has("PEN")) return "INJECTION, PEN";
  if (has("PREFILLED") || has("SYRINGE")) return "INJECTION, PREFILLED SYRINGE";
  if (has("AMPULE")) return "INJECTION, AMPULE";
  if (/\bINJ|INJECT/.test(x)) return "INJECTION, VIAL";
  if (has("PATCH") || has("TRANSDERMAL")) return "PATCH, TRANSDERMAL";
  if (has("SUPP")) return has("VAGINAL") ? "SUPPOSITORY, VAGINAL" : "SUPPOSITORY, RECTAL";
  if (has("CREAM")) return has("VAGINAL") ? "CREAM, VAGINAL" : "CREAM";
  if (has("OINT")) return "OINTMENT";
  if (/\bGEL\b/.test(x)) return "GEL";
  if (has("LOTION")) return "LOTION";
  if (has("FOAM")) return "FOAM";
  if (has("SUSP")) return "SUSPENSION, ORAL";
  if (has("SYRUP")) return "SYRUP";
  if (has("ELIXIR")) return "ELIXIR";
  if (has("LOZENGE") || has("TROCHE")) return "TROCHE / LOZENGE";
  if (/\bFILM\b/.test(x)) return "FILM";
  if (has("GRANULE")) return "GRANULES";
  if (has("POWDER")) return "POWDER";
  if (/\bKIT\b/.test(x)) return "KIT";
  if (has("TOPICAL") && /SOL/.test(x)) return "SOLUTION, TOPICAL";
  if (has("DROPS")) return "DROPS, ORAL";
  if (/\bSOL|SOLN|SOLUTION|ORAL LIQUID/.test(x)) return "SOLUTION, ORAL";
  return "";
}
function setSelectC(card, selF, otherF, val, rawIfOther){
  const sel = g(card, selF);
  if (val && [...sel.options].some(o => o.value === val)){ sel.value = val; g(card, otherF).value = ""; }
  else if (rawIfOther){ sel.value = "OTHER"; g(card, otherF).value = rawIfOther.toUpperCase(); }
  else { sel.value = ""; g(card, otherF).value = ""; }
}
function applyStrengthFormC(card, sf, route){
  const m = /^([\d.,\-\/]+)\s*([a-z%]+(?:\/\s*[\d.]*\s*[a-z]+)?)\s*(.*)$/i.exec(String(sf).trim());
  let str = "", unitRaw = "", rest = sf;
  if (m){ str = m[1]; unitRaw = m[2]; rest = m[3]; }
  g(card, "str").value = str.toUpperCase();
  const ukey = unitRaw.toLowerCase().replace(/\s+/g, "");
  setSelectC(card, "unit", "unit_other", UNIT_MAP[ukey] || UNIT_MAP[unitRaw.toLowerCase()], unitRaw);
  setSelectC(card, "form", "form_other", mapForm((rest + " " + route).trim()), rest || route);
  toggleOtherC(card);
}
function pickList(input, head, items, note, attr){
  closeList();
  const ul = document.createElement("ul"); ul.className = "suggest"; ul.setAttribute("role","listbox");
  if (head){ const h = document.createElement("li"); h.className = "grp"; h.textContent = head; ul.appendChild(h); }
  if (note){ const li = document.createElement("li"); li.className = "empty"; li.textContent = note; ul.appendChild(li); }
  items.forEach((it, i) => {
    const li = document.createElement("li"); li.setAttribute("role","option"); if (i === 0) li.setAttribute("aria-selected","true");
    const n = document.createElement("span"); n.className = "n"; n.textContent = it.label; li.appendChild(n);
    if (it.sub){ const d = document.createElement("span"); d.className = "d"; d.textContent = it.sub; li.appendChild(d); }
    li._onPick = it.pick;
    li.addEventListener("mousedown", e => { e.preventDefault(); it.pick(); });
    ul.appendChild(li);
  });
  if (attr){ const a = document.createElement("li"); a.className = "gattr"; a.textContent = attr; ul.appendChild(a); }
  input.parentElement.appendChild(ul); openList = ul; openList._input = input;
}
function listKeys(e, input){
  if (!openList || openList._input !== input) return;
  const opts = [...openList.querySelectorAll('li[role="option"]')]; if (!opts.length) return;
  let i = opts.findIndex(o => o.getAttribute("aria-selected") === "true");
  if (e.key === "ArrowDown" || e.key === "ArrowUp"){ e.preventDefault(); opts[i]?.removeAttribute("aria-selected"); i = (i + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length; opts[i].setAttribute("aria-selected","true"); opts[i].scrollIntoView({block:"nearest"}); }
  else if (e.key === "Enter"){ e.preventDefault(); opts[Math.max(i,0)]._onPick(); }
  else if (e.key === "Escape"){ closeList(); }
}
function autoClose(input){
  input.addEventListener("blur", () => { input._blurT = setTimeout(() => { if (openList && openList._input === input) closeList(); }, 150); });
  input.addEventListener("focus", () => clearTimeout(input._blurT));
  input.addEventListener("keydown", e => listKeys(e, input));
}
const RX_ATTR = "Drug data: NLM RxTerms / RxNorm";
function chooseStrengthC(card, name, route, strengths, rxcuis){
  const input = g(card, "drug");
  if (!strengths.length){ closeList(); return; }
  pickList(input, "Pick strength and form for " + name, strengths.map((sf, k) => ({
    label: sf.toUpperCase(), sub: route ? route.toUpperCase() : "",
    pick: () => { closeList(); applyStrengthFormC(card, sf, route); loadNdcsC(card, (rxcuis || [])[k]); }
  })), "", RX_ATTR);
}
function rxInputC(card){
  const input = g(card, "drug"), q = input.value.trim(), st = card._rx;
  clearTimeout(st.t);
  if (card._ndc.opts.length){ card._ndc.opts = []; card._ndc.seq++; g(card, "ndc").value = ""; g(card, "ndcTag").textContent = ""; }
  if (q.replace(/[^A-Za-z]/g, "").length < 3){ if (openList && openList._input === input) closeList(); return; }
  const seq = ++st.seq;
  st.t = setTimeout(async () => {
    try {
      const j = await rxtGet(RXT + encodeURIComponent(q));
      if (seq !== st.seq || document.activeElement !== input) return;
      const names = (j && j[1]) || [], sf = (j && j[2] && j[2].STRENGTHS_AND_FORMS) || [], rc = (j && j[2] && j[2].RXCUIS) || [];
      if (!names.length){ pickList(input, "", [], "No match. Check the spelling, or type the drug name in full.", RX_ATTR); return; }
      pickList(input, "", names.map((full, i) => {
        const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(full), base = (m ? m[1] : full).toUpperCase(), route = m ? m[2] : "";
        return { label: base, sub: [route.toUpperCase(), (sf[i] || []).length + " strength(s)"].filter(Boolean).join(" · "),
                 pick: () => { input.value = base; chooseStrengthC(card, base, route, sf[i] || [], rc[i] || []); } };
      }), "", RX_ATTR);
    } catch(e){
      if (seq !== st.seq || document.activeElement !== input) return;
      pickList(input, "", [], "Drug lookup isn't available right now. Type the drug, strength and form by hand.", RX_ATTR);
    }
  }, 300);
}

/* ---- NDC (NLM RxNav) ---- */
const RXNAV_NDC = "https://rxnav.nlm.nih.gov/REST/ndcproperties.json?ndcstatus=active&id=";
const RXNAV_NDCPROP = "https://rxnav.nlm.nih.gov/REST/ndcproperties.json?ndcstatus=all&id=";
const RXNAV_TERMS = rxcui => "https://rxnav.nlm.nih.gov/REST/RxTerms/rxcui/" + encodeURIComponent(rxcui) + "/allinfo.json";
const fmtNdc = s => { const d = digits(s); return d.length === 11 ? d.slice(0,5) + "-" + d.slice(5,9) + "-" + d.slice(9) : String(s||"").toUpperCase(); };
function ndcComplete(val){ const d = digits(val); return d.length === 11 || d.length === 10; }
// A 10-digit NDC without dashes can be 4-4-2, 5-3-2 or 5-4-1; each becomes 11 digits by adding a zero to the front of a different group.
function ndcCandidates(val){
  const d = digits(val), dashes = (val.match(/-/g) || []).length;
  if (d.length === 11) return [d];
  if (d.length === 10 && dashes === 2) return [val];
  if (d.length === 10) return ["0" + d, d.slice(0,5) + "0" + d.slice(5), d.slice(0,9) + "0" + d.slice(9)];
  return [];
}
async function loadNdcsC(card, rxcui, keepValue){
  const st = card._ndc, tag = g(card, "ndcTag");
  st.opts = []; if (!keepValue){ g(card, "ndc").value = ""; tag.textContent = ""; }
  if (!rxcui) return;
  const seq = ++st.seq;
  if (!keepValue) tag.textContent = "· loading…";
  try {
    const j = await rxtGet(RXNAV_NDC + encodeURIComponent(rxcui));
    if (seq !== st.seq) return;
    const list = (j && j.ndcPropertyList && j.ndcPropertyList.ndcProperty) || [];
    st.opts = list.map(p => {
      const props = (p.propertyConceptList && p.propertyConceptList.propertyConcept) || [];
      const lab = (props.find(x => x.propName === "LABELER") || {}).propValue || p.labeler || "";
      const pkg = ((p.packagingList && p.packagingList.packaging) || [])[0] || "";
      return { ndc: p.ndc10 || fmtNdc(p.ndcItem), ndc11: p.ndcItem || "", labeler: lab.toUpperCase(), pkg: pkg.replace(/\s*\([^)]*\)\s*$/, "").toUpperCase() };
    }).sort((a,b) => a.labeler.localeCompare(b.labeler) || a.ndc.localeCompare(b.ndc));
    if (!keepValue) tag.textContent = st.opts.length ? "· " + st.opts.length + " to pick from" : "· none listed";
  } catch(e){
    if (seq !== st.seq) return;
    if (!keepValue) tag.textContent = "· lookup unavailable";
  }
}
async function lookupNdcC(card, val){
  const st = card._ndc, seq = ++st.lookSeq, tag = g(card, "ndcTag");
  tag.textContent = "· looking up…";
  try {
    let p = null;
    for (const cand of ndcCandidates(val)){
      const j = await rxtGet(RXNAV_NDCPROP + encodeURIComponent(cand));
      if (seq !== st.lookSeq) return;
      p = ((j && j.ndcPropertyList && j.ndcPropertyList.ndcProperty) || [])[0];
      if (p && p.rxcui) break;
    }
    if (!p || !p.rxcui){ tag.textContent = "· NDC not found; check the number"; return; }
    const t = await rxtGet(RXNAV_TERMS(p.rxcui));
    if (seq !== st.lookSeq) return;
    const r = (t && t.rxtermsProperties) || {};
    const props = (p.propertyConceptList && p.propertyConceptList.propertyConcept) || [];
    const lab = (p.labeler || (props.find(x => x.propName === "LABELER") || {}).propValue || "").toUpperCase();
    const pkg = (((p.packagingList && p.packagingList.packaging) || [])[0] || "").replace(/\s*\([^)]*\)\s*$/, "").toUpperCase();
    if (r.displayName){
      const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(r.displayName);
      g(card, "drug").value = (m ? m[1] : r.displayName).toUpperCase();
      applyStrengthFormC(card, ((r.strength || "") + " " + (r.rxtermsDoseForm || "")).trim(), r.route || (m ? m[2] : ""));
    } else if (r.fullName){
      g(card, "drug").value = String(r.fullName).toUpperCase();
    }
    g(card, "ndc").value = p.ndc10 || fmtNdc(val);
    tag.textContent = "· " + [lab, pkg].filter(Boolean).join(" · ");
    loadNdcsC(card, p.rxcui, true);
  } catch(e){
    if (seq !== st.lookSeq) return;
    tag.textContent = "· lookup unavailable";
  }
}
function showNdcsC(card){
  const input = g(card, "ndc"), opts = card._ndc.opts;
  if (!opts.length) return;
  const q = input.value.trim().toUpperCase(), qd = digits(q);
  const hits = opts.filter(o => !q || (qd && (digits(o.ndc).includes(qd) || o.ndc11.includes(qd))) || o.labeler.includes(q)).slice(0, 40);
  pickList(input, "", hits.map(o => ({ label: o.ndc + "  " + o.labeler, sub: o.pkg, pick: () => { input.value = o.ndc; closeList(); } })),
           hits.length ? "" : "No listed NDC matches. Keep what you typed if it's from the bottle.", "NDC data: NLM RxNav (active NDCs)");
}

/* ---- wire one prescription card ---- */
function wireRx(card){
  card._rx = { seq: 0, t: null };
  card._ndc = { opts: [], seq: 0, lookSeq: 0, lookT: null };
  const drug = g(card, "drug"), ndc = g(card, "ndc");
  drug.addEventListener("input", () => rxInputC(card));
  autoClose(drug);
  g(card, "unit").addEventListener("change", () => toggleOtherC(card));
  g(card, "form").addEventListener("change", () => toggleOtherC(card));
  g(card, "never").addEventListener("change", () => applyNeverC(card));
  g(card, "qty").addEventListener("input", () => syncNeverC(card));
  g(card, "ref").addEventListener("input", () => syncNeverC(card));
  g(card, "sched").addEventListener("change", () => { schedNoteC(card); updateDea(); });
  card.querySelector(".rxremove").addEventListener("click", () => removeRx(card));
  const days = g(card, "days"); days.inputMode = "numeric"; days.maxLength = 3;
  days.addEventListener("input", () => { days.value = digits(days.value).slice(0, 3); });
  ["date", "first", "last"].forEach(f => {
    const el = g(card, f); el.dataset.kind = "date"; el.inputMode = "numeric"; el.maxLength = 10;
    el.addEventListener("input", () => { el.value = maskDate(el.value); if (el.value.length === 10) checkField(el); else flag(el, true); });
    el.addEventListener("blur", () => checkField(el));
  });
  ndc.addEventListener("focus", () => showNdcsC(card));
  ndc.addEventListener("input", () => {
    ndc.value = ndc.value.replace(/[^0-9-]/g, "").slice(0, 13);
    showNdcsC(card);
    clearTimeout(card._ndc.lookT);
    if (ndcComplete(ndc.value)){
      const val = ndc.value, wait = digits(val).length === 10 && !val.includes("-") ? 900 : 400;   // give time for an 11th digit
      card._ndc.lookT = setTimeout(() => { if (openList && openList._input === ndc) closeList(); lookupNdcC(card, val); }, wait);
    }
  });
  ndc.addEventListener("blur", () => { if (digits(ndc.value).length === 11 && !ndc.value.includes("-")) ndc.value = fmtNdc(ndc.value); });
  autoClose(ndc);
  toggleOtherC(card);
  schedNoteC(card);
}
$("rxAdd").addEventListener("click", () => { const c = addRx(); g(c, "drug").focus(); c.scrollIntoView({ behavior: "smooth", block: "start" }); });

/* ---- read one card for the PDF ---- */
function rxData(card){
  const o = {};
  ["drug","sig","ndc","qty","ref","date","days","daw","daw_t","origno","qrem","rrem","first","last","sched"].forEach(f => o[f] = gv(card, f));
  o.strength = strengthValC(card); o.form = formValC(card); o.sched = o.sched.toUpperCase();
  return o;
}

/* ---------- save to directory ---------- */
async function saveDir(kind){
  const msg = $(kind+"Msg"); msg.className = "msg";
  const m = MAP[kind], rec = {};
  Object.entries(m).forEach(([k,id]) => { let v = $(id).value.trim().toUpperCase(); if (k==="phone"||k==="fax") v = digits(v); rec[k] = v; });
  if (kind === "pr") rec.name = [rec.last, rec.first].filter(Boolean).join(", ");
  if (!rec.name){ msg.textContent = kind === "pr" ? "Enter the prescriber's last name before saving." : "Enter a name before saving."; msg.classList.add("err"); return; }
  if (rec.npi && !/^\d{10}$/.test(rec.npi)){ msg.textContent = "NPI must be 10 digits."; msg.classList.add("err"); return; }
  const list = dir[kind];
  let i = selected[kind] ? list.findIndex(r => r._id === selected[kind]) : -1;
  if (i < 0 && rec.npi) i = list.findIndex(r => r.npi === rec.npi);
  if (i < 0) i = list.findIndex(r => (r.name||"").toLowerCase() === rec.name.toLowerCase());
  const id0 = i >= 0 ? list[i]._id : (rec.npi ? "npi_" + rec.npi : "");
  let saved;
  try { saved = await HOST.dirSave(kind, Object.assign({}, rec, { _id: id0 })); }
  catch(e){ msg.textContent = "Couldn't save to the directory: " + (e && e.message || "try again"); msg.className = "msg err"; return; }
  const id = saved._id;
  i = list.findIndex(r => r._id === id);
  if (i >= 0) list[i] = saved; else list.push(saved);
  list.sort((x,y) => (x.name||"").localeCompare(y.name||""));
  selected[kind] = id;
  msg.textContent = "Saved to directory."; msg.className = "msg ok";
  $(kind+"Tag").textContent = "FROM DIRECTORY";
  updateCount();
}
$("phSave").addEventListener("click", () => saveDir("ph"));
$("prSave").addEventListener("click", () => saveDir("pr"));

/* ---------- clear ---------- */
$("clearBtn").addEventListener("click", () => { $("clearConfirm").hidden = false; $("clearBtn").hidden = true; });
function clearForm(keepPr){
  closeList();
  const keepId = id => id.startsWith("rp_") || (keepPr && id.startsWith("pr_"));
  document.querySelectorAll(".wrap input:not([type=radio]):not([type=checkbox]), .wrap select").forEach(el => { if (!keepId(el.id)) el.value = el.tagName==="SELECT" ? el.options[0].value : ""; });
  document.querySelectorAll(".wrap input.bad").forEach(el => { if (!keepId(el.id)) flag(el, true); });
  document.querySelectorAll("[data-auto]").forEach(el => { if (!keepId(el.id)) delete el.dataset.auto; });
  selected.ph = null; $("phTag").textContent = "";
  if (!keepPr){ selected.pr = null; $("prTag").textContent = ""; }
  $("rxList").innerHTML = ""; addRx();
  $("printChoice").hidden = true; $("keepPr").hidden = true;
  ["phMsg","mainMsg"].concat(keepPr ? [] : ["prMsg"]).forEach(i => $(i).textContent = "");
  $("clearConfirm").hidden = true; $("clearBtn").hidden = false;
}
$("clearConfirm").addEventListener("click", () => clearRequest(false));

/* ---------- local PDF copies (browser memory only) ---------- */
let copyUrls = [], lastMode = null, pdfMade = false;
function discardCopy(){
  pdfMade = false; $("pdfBtn").textContent = "Create PDF for fax"; $("staleNote").hidden = true;
  copyUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch(e){} });
  copyUrls = [];
  $("copyList").innerHTML = ""; $("copyAll").hidden = true; $("copyAll").removeAttribute("href"); $("copyDlAll").hidden = true;
  $("copyBar").hidden = true;
}
function showCopies(files, printAll){
  discardCopy();
  const list = $("copyList");
  files.forEach(f => {
    const url = URL.createObjectURL(f.blob); copyUrls.push(url);
    const rowEl = document.createElement("div"); rowEl.className = "copyrow";
    const name = document.createElement("span"); name.className = "copyname"; name.textContent = f.label || f.name;
    const sub = document.createElement("span"); sub.className = "hint"; sub.textContent = f.name;
    const open = document.createElement("a"); open.className = "btnlink"; open.href = url; open.target = "_blank"; open.rel = "noopener"; open.textContent = "Open";
    const dl = document.createElement("a"); dl.className = "btnlink alt"; dl.href = url; dl.download = f.name; dl.textContent = "Download";
    const txt = document.createElement("div"); txt.append(name, document.createElement("br"), sub);
    const acts = document.createElement("div"); acts.className = "copyactions"; acts.append(open, dl);
    rowEl.append(txt, acts); list.appendChild(rowEl);
  });
  if (printAll){
    const url = URL.createObjectURL(printAll.blob); copyUrls.push(url);
    $("copyAll").href = url; $("copyAll").hidden = false;
  }
  $("copyDlAll").hidden = files.length < 2;
  $("copyDlAll").onclick = () => { list.querySelectorAll("a[download]").forEach((a, i) => setTimeout(() => a.click(), i * 400)); };
  $("copyBar").hidden = false;
  pdfMade = true; $("pdfBtn").textContent = "Update PDF";
}
/* clearing: telephone orders ask whether to keep the prescriber for the caller's next patient */
let clearWasDone = false;
function finishClear(keepPr){
  $("keepPr").hidden = true;
  discardCopy(); clearForm(keepPr);
  const m = $("mainMsg");
  if (clearWasDone){
    const t = new Date(), p2 = n=>String(n).padStart(2,"0");
    m.textContent = `Done at ${p2(t.getHours())}:${p2(t.getMinutes())}. Form cleared${keepPr ? ", prescriber kept" : ""}.`; m.className = "msg ok";
  } else if (keepPr){ m.textContent = "Form cleared, prescriber kept."; m.className = "msg ok"; }
}
function clearRequest(done){
  clearWasDone = done;
  if (otype === "tel" && ["pr_last", "pr_first", "pr_npi"].some(id => ($(id).value || "").trim())){
    $("keepPr").hidden = false; $("keepPr").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  finishClear(false);
}
$("copyDone").addEventListener("click", () => clearRequest(true));
$("keepPrYes").addEventListener("click", () => finishClear(true));
$("keepPrNo").addEventListener("click", () => finishClear(false));
$("keepPrCancel").addEventListener("click", () => { $("keepPr").hidden = true; $("clearConfirm").hidden = true; $("clearBtn").hidden = false; });
$("copyKeep").addEventListener("click", discardCopy);
/* the form stays editable after a PDF: flag it as out of date until the PDF is updated */
const markStale = () => { if (pdfMade) $("staleNote").hidden = false; };
document.addEventListener("input", e => { if (e.target.closest && e.target.closest(".wrap") && !e.target.closest("#copyBar")) markStale(); });
document.addEventListener("change", e => { if (e.target.closest && e.target.closest(".wrap") && !e.target.closest("#copyBar")) markStale(); });
document.addEventListener("click", e => { if (e.target.closest && e.target.closest("#rxAdd, .rxremove")) markStale(); });
window.addEventListener("pagehide", discardCopy);

/* ---------- PDF ---------- */
const v = id => ($(id).value||"").trim();
function joinAddr(a,c,s,z){ const cs = [c, [s,z].filter(Boolean).join(" ")].filter(Boolean).join(", "); return [a, cs].filter(Boolean).join(", "); }

/* groups: array of arrays of {rx, num, total}. Each group starts on a fresh page with the full header.
   labels: optional footer label per group ("1 of 3"); without labels, pages get "Page i of n" when there is more than one. */
function buildPdf(sentAt, groups, labels){
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:"pt", format:"letter" });
  const W = 612, M = 34, CW = W - 2*M, BOTTOM = 742;
  const xferMode = otype === "xfer";
  const title = xferMode ? "Prescription Transfer In" : "Telephone Prescription Order";
  let y = 40;
  const pageGroup = [];   // group index for each page

  function bar(t, x=M, w=CW){ doc.setFillColor(225,225,225); doc.rect(x, y, w, 13, "F"); doc.setFont("helvetica","bold"); doc.setFontSize(8); doc.setTextColor(0); doc.text(t.toUpperCase(), x+4, y+9.2); }
  function cell(x, yy, w, label, value, h=24){
    doc.setDrawColor(150); doc.setLineWidth(.5); doc.rect(x, yy, w, h);
    doc.setFont("helvetica","normal"); doc.setTextColor(80);
    const lbl = String(label||"").toUpperCase(); let ls = 6.3;
    doc.setFontSize(ls); while (ls > 4 && doc.getTextWidth(lbl) > w-6){ ls -= .25; doc.setFontSize(ls); }
    doc.text(lbl, x+3, yy+7.5);
    doc.setTextColor(0);
    // shrink the text until all of it fits the box (nothing is cut off)
    const maxLines = h > 26 ? 2 : 1, txt = value || "";
    let fs = 9.5, lines;
    for (;;){
      doc.setFontSize(fs); lines = doc.splitTextToSize(txt, w-6);
      if (lines.length <= maxLines || fs <= 4.5) break;
      fs -= .25;
    }
    doc.text(lines, x+3, yy+18, {lineHeightFactor: 1});
  }
  function row(items, x0=M, total=CW, h=24){
    let x = x0;
    items.forEach(([frac,label,val]) => { const w = total*frac; cell(x, y, w, label, val, h); x += w; });
    y += h;
  }
  function titleLine(cont){
    doc.setFont("helvetica","bold"); doc.setFontSize(15); doc.setTextColor(0); doc.text(title + (cont ? " (continued)" : ""), M, y);
    doc.setFont("helvetica","normal"); doc.setFontSize(8.5);
    doc.text((xferMode ? "Date/Time Transferred: " : "Date/Time Transcribed: ") + sentAt, W-M, y, {align:"right"});
    y += 10; doc.setLineWidth(1); doc.setDrawColor(0); doc.line(M, y, W-M, y); y += 8;
  }
  function header(){
    titleLine(false);
    if (xferMode){
      const half = (CW-10)/2, xR = M+half+10;
      bar("Receiving pharmacy", M, half); bar("Transferring pharmacy", xR, half); y += 13;
      const yStart = y;
      row([[1,"Pharmacy",RCV.name]], M, half);
      row([[1,"Address",RCV.addr]], M, half);
      row([[.5,"Phone",fmtPhone(RCV.phone)],[.5,"Fax",fmtPhone(RCV.fax)]], M, half);
      row([[.3,"TX license",RCV.lic],[.35,"DEA",RCV.dea],[.35,"NPI",RCV.npi]], M, half);
      row([[.65,"Receiving pharmacist",v("rp_rph")],[.35,"RPh license #",v("rp_lic")]], M, half);
      row([[.65,"Pharmacist in charge (PIC)",v("rp_pic")],[.35,"PIC license #",v("rp_piclic")]], M, half);
      const yL = y; y = yStart;
      row([[1,"Pharmacy",v("ph_name")]], xR, half);
      row([[1,"Address",joinAddr(v("ph_addr"),v("ph_city"),v("ph_state").toUpperCase(),v("ph_zip"))]], xR, half);
      row([[.5,"Phone",fmtPhone(v("ph_phone"))],[.5,"Fax",fmtPhone(v("ph_fax"))]], xR, half);
      row([[.3,"License #",v("ph_lic")],[.35,"DEA #",$("ph_dea").disabled ? "" : v("ph_dea")],[.35,"NPI",v("ph_npi")]], xR, half);
      row([[.65,"Transferring pharmacist",v("ph_rph")],[.35,"RPh license #",v("ph_rphlic")]], xR, half);
      y = Math.max(y, yL) + 10;
    } else {
      bar("Receiving pharmacy"); y += 13;
      row([[.26,"Pharmacy",RCV.name],[.38,"Address",RCV.addr],[.18,"Phone",fmtPhone(RCV.phone)],[.18,"Fax",fmtPhone(RCV.fax)]]);
      row([[.14,"TX license",RCV.lic],[.16,"DEA",RCV.dea],[.16,"NPI",RCV.npi],[.36,"Receiving pharmacist",v("rp_rph")],[.18,"RPh license #",v("rp_lic")]]);
      row([[.46,"",""],[.36,"Pharmacist in charge (PIC)",v("rp_pic")],[.18,"PIC license #",v("rp_piclic")]]);
      y += 10;
    }
    const half = (CW-10)/2, xR = M + half + 10;
    bar("Patient information", M, half); bar("Prescriber information", xR, half); y += 13;
    const yS = y;
    row([[.5,"Last name",v("pt_last")],[.5,"First name",v("pt_first")]], M, half);
    row([[.4,"Date of birth",v("pt_dob")],[.15,"Sex",v("pt_sex")],[.45,"Phone",fmtPhone(v("pt_phone"))]], M, half);
    row([[1,"Address",joinAddr(v("pt_addr"),v("pt_city"),v("pt_state"),v("pt_zip"))]], M, half, 34);
    const yL = y; y = yS;
    row([[.5,"Last name",v("pr_last")],[.5,"First name",v("pr_first")]], xR, half);
    row([[.5,"Credentials / specialty",v("pr_cred")],[.5,"NPI",v("pr_npi")]], xR, half);
    row([[.5,"DEA #",$("pr_dea").disabled ? "" : v("pr_dea")],[.5,"TX license #",v("pr_lic")]], xR, half);
    row([[1,"Practice address",joinAddr(v("pr_addr"),v("pr_city"),v("pr_state"),v("pr_zip"))]], xR, half, 34);
    row([[.5,"Phone",fmtPhone(v("pr_phone"))],[.5,"Fax",fmtPhone(v("pr_fax"))]], xR, half);
    if (!xferMode) row([[.6,"Person calling",v("pr_caller")],[.4,"Call-back number",fmtPhone(v("pr_callback"))]], xR, half);
    y = Math.max(y, yL) + 10;
  }
  function continuationHeader(){
    titleLine(true);
    doc.setFont("helvetica","normal"); doc.setFontSize(9); doc.setTextColor(0);
    doc.text("Patient: " + [v("pt_last"), v("pt_first")].filter(Boolean).join(", ") + "    DOB: " + v("pt_dob") +
             "    Prescriber: " + [v("pr_last"), v("pr_first")].filter(Boolean).join(", "), M, y + 4);
    y += 16;
  }
  const RX_H = xferMode ? 13 + 24 + 34 + 24 + 24 + 10 : 13 + 24 + 34 + 24 + 10;
  function rxBlock(item){
    const r = item.rx;
    bar(item.total > 1 ? "Prescription " + item.num + " of " + item.total : "Prescription"); y += 13;
    if (xferMode){
      row([[.36,"Drug name",r.drug],[.18,"Strength",r.strength],[.28,"Dosage form",r.form],[.18,"Original Rx #",r.origno]]);
      row([[.72,"Directions (sig)",r.sig],[.28,"NDC",r.ndc]], M, CW, 34);
      row([[.2,"Original quantity",r.qty],[.2,"Original refills",r.ref],[.2,"Original Rx date",r.date],[.16,"Days supply",r.days],[.24,"DAW / substitution",r.daw]]);
      row([[.2,"Remaining quantity",r.qrem],[.2,"Remaining refills",r.rrem],[.2,"Date of first fill",r.first],[.2,"Date of last fill",r.last],[.2,"Schedule",r.sched]]);
    } else {
      row([[.38,"Drug name",r.drug],[.18,"Strength",r.strength],[.28,"Dosage form",r.form],[.16,"Schedule",r.sched]]);
      row([[.72,"Directions (sig)",r.sig],[.28,"NDC",r.ndc]], M, CW, 34);
      row([[.2,"Quantity",r.qty],[.2,"Refills",r.ref],[.2,"Days supply",r.days],[.4,"Substitution",r.daw_t]]);
    }
    y += 10;
  }
  const note = xferMode ? "" : "Telephone order reduced to writing by the receiving pharmacist (22 TAC 291.34). CII: emergency only, signed Rx due within 7 days (21 CFR 1306.11; HSC 481.074). TX e-Rx required for CII-CV unless an exception applies (HSC 481.0755).";

  groups.forEach((items, gi) => {
    if (gi > 0) doc.addPage();
    y = 40; pageGroup.push(gi);
    header();
    items.forEach(item => {
      if (y + RX_H > BOTTOM){ doc.addPage(); pageGroup.push(gi); y = 40; continuationHeader(); }
      rxBlock(item);
    });
    if (note){
      doc.setFont("helvetica","normal"); doc.setFontSize(6.5); doc.setTextColor(60);
      const lines = doc.splitTextToSize(note, CW);
      if (y + lines.length * 8 > BOTTOM + 8){ doc.addPage(); pageGroup.push(gi); y = 40; continuationHeader(); doc.setFont("helvetica","normal"); doc.setFontSize(6.5); doc.setTextColor(60); }
      doc.text(lines, M, y + 4);
    }
  });

  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++){
    doc.setPage(i);
    doc.setFont("helvetica","normal"); doc.setFontSize(6); doc.setTextColor(60);
    doc.text("CONFIDENTIAL: contains protected health information. If received in error, notify " + RCV.name + " at " + fmtPhone(RCV.phone) + " and destroy all copies.", M, 770);
    doc.text("Fax to " + fmtPhone(RCV.fax), W-M, 770, {align:"right"});
    let lab = "";
    if (labels) lab = labels[pageGroup[i-1]] || "";
    else if (n > 1) lab = "Page " + i + " of " + n;
    if (lab){ doc.setFont("helvetica","bold"); doc.setFontSize(10); doc.setTextColor(0); doc.text(lab, W/2, 782, {align:"center"}); }
  }
  return doc;
}

/* ---------- create PDFs ---------- */
function validateAll(){
  const missing = [];
  const req = ["rp_rph","pt_last","pt_first","pt_dob","pr_last"];
  if (otype === "xfer") req.push("ph_name","ph_rph"); else req.push("pr_caller");
  const cards = rxCards();
  const controlled = cards.some(c => gv(c, "sched") !== "Non-controlled");
  if (controlled){ req.push("pr_dea","pt_addr"); if (otype === "xfer") req.push("ph_dea"); }
  const PFX = { pt_last:"Patient ", pt_first:"Patient ", pr_last:"Prescriber " };
  req.forEach(id => { if (!v(id)) missing.push((PFX[id]||"") + document.querySelector(`label[for="${id}"]`).textContent.replace(/^Last name|^First name/, t => PFX[id] ? t.toLowerCase() : t)); });
  cards.forEach((c, i) => {
    const pre = cards.length > 1 ? "Rx " + (i+1) + ": " : "";
    const need = [["drug","Drug name"],["sig","Directions"],["qty","Quantity"]];
    if (otype === "xfer") need.push(["origno","Original Rx #"],["rrem","Remaining refills"]);
    need.forEach(([f, lab]) => { if (!gv(c, f)) missing.push(pre + lab); });
    if (gv(c, "str") && !unitValC(c)) missing.push(pre + "Strength units");
    if (gv(c, "unit") === "OTHER" && !gv(c, "unit_other")) missing.push(pre + "Other units");
    if (gv(c, "form") === "OTHER" && !gv(c, "form_other")) missing.push(pre + "Other dosage form");
  });
  if (missing.length) return "Missing: " + missing.join(", ") + ". Fill these in, then create the PDF.";
  const bad = [...document.querySelectorAll(".wrap [data-kind]")].filter(el => el.closest("[hidden]") === null && !checkField(el));
  if (bad.length){ bad[0].focus(); return "Check format: " + bad.map(el => (el.closest(".rxcard") ? "Rx " + (rxCards().indexOf(el.closest(".rxcard")) + 1) + " " : "") + document.querySelector(`label[for="${el.id}"]`).textContent).join(", ") + " (dates 00/00/0000, phones 000-000-0000)."; }
  if (!window.jspdf) return "The PDF library didn't load. Reload the page and try again.";
  return "";
}
function baseName(){
  const last = (v("pt_last")||"patient").replace(/[^A-Za-z0-9]+/g,"");
  const d = new Date(), p = n=>String(n).padStart(2,"0");
  return `NorTex_${otype==="xfer"?"TransferIn":"PhoneOrder"}_${last}_${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
function generate(mode){
  $("printChoice").hidden = true;
  const msg = $("mainMsg");
  const sent = nowStamp(), rxs = rxCards().map(rxData), X = rxs.length, base = baseName();
  const items = rxs.map((rx, i) => ({ rx, num: i + 1, total: X }));
  const files = [];
  let printAll = null;
  if (mode === "separate" && X > 1){
    items.forEach((it, i) => files.push({ name: `${base}_${i+1}of${X}.pdf`, label: `Prescription ${i+1} of ${X}: ${it.rx.drug}`,
      blob: buildPdf(sent, [[it]], [`${i+1} of ${X}`]).output("blob") }));
    printAll = { name: `${base}_ALL_${X}.pdf`, blob: buildPdf(sent, items.map(it => [it]), items.map((it, i) => `${i+1} of ${X}`)).output("blob") };
  } else {
    files.push({ name: `${base}.pdf`, label: X > 1 ? `One form, ${X} prescriptions` : rxs[0].drug, blob: buildPdf(sent, [items]).output("blob") });
  }
  showCopies(files, printAll);
  if (X > 1 || !lastMode) lastMode = X > 1 ? mode : "one";
  $("layoutBar").hidden = X < 2;
  $("layOne").classList.toggle("primary", lastMode !== "separate"); $("laySep").classList.toggle("primary", lastMode === "separate");
  msg.textContent = files.length > 1 ? `${files.length} PDFs ready. Print or fax them, then click Done to clear the form.` : "PDF ready. Fax it, then click Done to clear the form.";
  msg.className = "msg ok";
  $("copyBar").scrollIntoView({ behavior: "smooth", block: "center" });
}
$("pdfBtn").addEventListener("click", () => {
  const msg = $("mainMsg"); msg.className = "msg";
  const err = validateAll();
  if (err){ msg.textContent = err; msg.classList.add("err"); return; }
  const X = rxCards().length;
  if (pdfMade){ generate(X > 1 ? (lastMode || "one") : "one"); return; }   // Update PDF: same layout, current form
  if (X > 1){
    $("choiceCount").textContent = X;
    $("choiceOne").textContent = `One form with all ${X} prescriptions`;
    $("choiceSep").textContent = `Separate form for each (${X} PDFs, "1 of ${X}"…)`;
    $("printChoice").hidden = false;
    $("printChoice").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  generate("one");
});
$("choiceOne").addEventListener("click", () => generate("one"));
$("choiceSep").addEventListener("click", () => generate("separate"));
$("choiceCancel").addEventListener("click", () => { $("printChoice").hidden = true; });
$("copyUpdate").addEventListener("click", () => $("pdfBtn").click());
function switchLayout(mode){ const err = validateAll(); if (err){ $("mainMsg").textContent = err; $("mainMsg").className = "msg err"; return; } generate(mode); }
$("layOne").addEventListener("click", () => switchLayout("one"));
$("laySep").addEventListener("click", () => switchLayout("separate"));

/* ---------- directory backup ---------- */
$("dirExport").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), ph: dir.ph, pr: dir.pr }, null, 1)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  const t = new Date(), p = n=>String(n).padStart(2,"0");
  a.download = `NorTex_directory_${t.getFullYear()}${p(t.getMonth()+1)}${p(t.getDate())}.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$("dirImportBtn").addEventListener("click", () => $("dirImport").click());
$("dirImport").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  const msg = $("mainMsg");
  try {
    const d = JSON.parse(await f.text());
    const merge = (kind, incoming) => (incoming||[]).forEach(r => {
      if (!r || !r.name) return;
      const list = dir[kind];
      const i = list.findIndex(x => (r.npi && x.npi === r.npi) || (x.name||"").toLowerCase() === String(r.name).toLowerCase());
      const clean = Object.assign({}, r, { _id: (i >= 0 ? list[i]._id : (r._id || (r.npi ? "npi_"+r.npi : "id_"+Math.random().toString(36).slice(2)))) });
      if (i >= 0) list[i] = clean; else list.push(clean);
    });
    merge("ph", d.ph); merge("pr", d.pr);
    dir.ph.sort((x,y)=>(x.name||"").localeCompare(y.name||"")); dir.pr.sort((x,y)=>(x.name||"").localeCompare(y.name||""));
    const r = await HOST.dirImport({ ph: dir.ph, pr: dir.pr });
    updateCount();
    msg.textContent = "Directory imported and merged (" + r.ph + " pharmacies, " + r.pr + " prescribers)."; msg.className = "msg ok";
  } catch(err){ msg.textContent = (err instanceof SyntaxError || !HOST) ? "That file isn't a directory backup." : "Import failed: " + (err && err.message || "try again"); msg.className = "msg err"; }
});

/* ---------- shrink long text so it all stays visible in its field ---------- */
const fitCtx = document.createElement("canvas").getContext("2d");
function fitField(el){
  if (!el.clientWidth) return;
  const cs = getComputedStyle(el), isLbl = el.tagName === "LABEL" || el.classList.contains("k");
  const base = isLbl ? 12 : 11, min = isLbl ? 8.5 : 6;
  const txt = isLbl ? el.textContent.trim() : el.tagName === "SELECT" ? (el.selectedOptions[0] ? el.selectedOptions[0].textContent : "") : el.value;
  const key = txt + "|" + el.clientWidth;
  if (el._fitKey === key) return;
  el._fitKey = key;
  const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - (el.tagName === "SELECT" ? 22 : 2);
  const shown = cs.textTransform === "uppercase" ? txt.toUpperCase() : txt;
  let size = base;
  for (;;){
    fitCtx.font = cs.fontStyle + " " + cs.fontWeight + " " + size + "px " + cs.fontFamily;
    if (fitCtx.measureText(shown).width <= avail || size <= min) break;
    size -= .5;
  }
  el.style.fontSize = size === base ? "" : size + "px";
}
function fitAll(){ document.querySelectorAll(".f input:not([type=checkbox]), .f select, .f > label, .static .k").forEach(fitField); }
setInterval(fitAll, 300);
window.addEventListener("resize", fitAll);

/* ---------- light / dark mode: follows the suite (its moon/sun button) ---------- */
const rootEl = document.documentElement;
function syncTheme(){
  let t = ""; try { t = window.parent.document.documentElement.getAttribute("data-theme") || ""; } catch(e){}
  if (t === "dark" || t === "light") rootEl.dataset.theme = t; else delete rootEl.dataset.theme;
}
syncTheme();
try { new MutationObserver(syncTheme).observe(window.parent.document.documentElement, { attributes: true, attributeFilter: ["data-theme"] }); } catch(e){}

/* ---------- receiving pharmacists (Account Owner only) ---------- */
function staffRow(p, isPic){
  const d = document.createElement("div"); d.className = "row staffrow";
  d.innerHTML = '<div class="f c6"><label>Name</label><input data-sn autocomplete="off"></div><div class="f c3"><label>RPh license #</label><input data-sl class="num" autocomplete="off"></div><div class="f c2"><label>PIC</label><label class="chk"><input type="checkbox" data-sp></label></div><div class="f c1"><label>&nbsp;</label><button type="button" class="small" data-sx aria-label="Remove">×</button></div>';
  d.querySelector("[data-sn]").value = p.name || ""; d.querySelector("[data-sl]").value = p.license || ""; d.querySelector("[data-sp]").checked = !!isPic;
  d.querySelector("[data-sx]").addEventListener("click", () => d.remove());
  d.querySelector("[data-sp]").addEventListener("change", e => { if (e.target.checked) document.querySelectorAll("#staffRows [data-sp]").forEach(x => { if (x !== e.target) x.checked = false; }); });
  return d;
}
function openStaff(){
  const box = $("staffRows"); box.innerHTML = "";
  staff.pharmacists.forEach(p => box.appendChild(staffRow(p, staff.pic && staff.pic.name === p.name)));
  $("staffMsg").textContent = ""; $("staffCard").hidden = false;
}
$("staffBtn").addEventListener("click", () => { if ($("staffCard").hidden) openStaff(); else $("staffCard").hidden = true; });
$("staffClose").addEventListener("click", () => $("staffCard").hidden = true);
$("staffAdd").addEventListener("click", () => $("staffRows").appendChild(staffRow({}, false)));
$("staffSave").addEventListener("click", async () => {
  const msg = $("staffMsg"); msg.className = "msg";
  const rows = [...document.querySelectorAll("#staffRows .staffrow")].map(r => ({ name: r.querySelector("[data-sn]").value.trim().toUpperCase(), license: r.querySelector("[data-sl]").value.trim(), pic: r.querySelector("[data-sp]").checked })).filter(r => r.name);
  const pic = rows.find(r => r.pic);
  try {
    const r = await HOST.staffSave({ pharmacists: rows.map(r => ({ name: r.name, license: r.license })), pic: pic ? { name: pic.name, license: pic.license } : null });
    staff = r.staff; const sel = $("rp_rph"), cur = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    staff.pharmacists.forEach(p => { const o = document.createElement("option"); o.value = p.name; o.textContent = p.name; sel.appendChild(o); });
    sel.value = staff.pharmacists.some(p => p.name === cur) ? cur : ""; applyRph();
    msg.textContent = "Saved."; msg.className = "msg ok";
  } catch(e){ msg.textContent = "Not saved: " + (e && e.message || "try again"); msg.className = "msg err"; }
});
if (HOST && HOST.canEditStaff) $("staffBtn").hidden = false;

/* ---------- start ---------- */
npiStatus();
addRx();
applyType();
$("dirCount").textContent = "Loading directory…";
(async function(){
  try {
    const c = await HOST.config(), p = c.pharmacy || {};
    RCV.name = p.name || ""; RCV.addr = [p.address, p.suite && !/^(suite|ste|unit|#)/i.test(p.suite.trim()) ? "Suite " + p.suite : p.suite].filter(Boolean).join(", ");
    RCV.phone = digits(p.phone); RCV.fax = digits(p.fax); RCV.lic = p.license || ""; RCV.dea = p.dea || ""; RCV.npi = p.npi || "";
    FAX_NUMBER = RCV.fax;
    $("rcv_name").textContent = RCV.name; $("rcv_addr").textContent = RCV.addr; $("rcv_phone").textContent = fmtPhone(RCV.phone); $("rcv_fax").textContent = fmtPhone(RCV.fax);
    $("rcv_lic").textContent = RCV.lic; $("rcv_dea").textContent = RCV.dea; $("rcv_npi").textContent = RCV.npi;
    loadStaff(c.staff || STAFF);
    dir.ph = (c.dir && c.dir.ph || []).sort((x,y) => (x.name||"").localeCompare(y.name||"")); dir.pr = (c.dir && c.dir.pr || []).sort((x,y) => (x.name||"").localeCompare(y.name||""));
    $("faxTo").textContent = "Fax to " + fmtPhone(FAX_NUMBER);
    updateCount(); dbReady = true;
  } catch(e){ $("dirCount").textContent = ""; const m = $("mainMsg"); m.textContent = "Could not load the pharmacy settings: " + (e && e.message || "try again") + ". Reload this tab."; m.className = "msg err"; }
})();
})();

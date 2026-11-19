// NorTex Reorder List API (AWS Lambda, Node.js 22, HTTP API payload 2.0, Cognito JWT authorizer)
//
// MAIN table (pk / sk):
//   STORES          / <PHARMACY ID>    pharmacy registry {name}; the ID is what people type at sign-in
//   USERS           / <cognito sub>    profile {login, name, phone, owner, stores:{ID:true}, perms:{...}, disabled}
// Only the one Account Owner can add people/pharmacies and switch access on or off.
//   STORE#<id>      / LINE#<lineId>    open reorder line
//   STORE#<id>      / MEM#<key>        memory {v:{...}}: pkg size / distributor / wording by NDC, drug, rxcui
// ARCHIVE table (pk / sk):
//   <storeId>       / <dateSubmitted>#<submittedAt>#<id>   one archived line. Only ever added, never changed or deleted.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminDeleteUserCommand, AdminDisableUserCommand, AdminEnableUserCommand,
         AdminUpdateUserAttributesCommand, AdminSetUserPasswordCommand, AdminSetUserMFAPreferenceCommand,
         AdminUserGlobalSignOutCommand, AdminGetUserCommand, ListUsersCommand, ChangePasswordCommand } from '@aws-sdk/client-cognito-identity-provider';

import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'node:crypto';

const MAIN = process.env.MAIN_TABLE, ARCH = process.env.ARCHIVE_TABLE, POOL = process.env.USER_POOL_ID;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const idp = new CognitoIdentityProviderClient({});

const LINE_FIELDS = ['dateAdded','item','mfr','ndc','ndc10','pkgSize','qty','src','setid','rxcui','autoPkg','dist','autoDist','need','autoQty','ordered','orderedAt','itemEdited'];
const NEEDS = ['', 'out', 'restock'];             // why it's on the list: out of stock (holding up dispensing) or replenish (ordering ahead)
const ARCH_FIELDS = ['id','lineId','dateAdded','dateSubmitted','submittedAt','item','mfr','ndc','ndc10','setid','pkgSize','qty','dist','need','ordered','orderedAt'];
const DATE = /^\d{4}-\d{2}-\d{2}$/, STAMP = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
// date-ish fields must look like dates (they are shown on screen); anything else is dropped
function fixDates(o){
  if(o.dateAdded !== undefined && !DATE.test(String(o.dateAdded))) delete o.dateAdded;
  if(o.orderedAt !== undefined && o.orderedAt !== '' && !STAMP.test(String(o.orderedAt))) delete o.orderedAt;
  if(o.submittedAt !== undefined && !STAMP.test(String(o.submittedAt))) delete o.submittedAt;
  if(o.qty !== undefined){ const n = parseInt(o.qty, 10); o.qty = Number.isFinite(n) && n > 0 && n < 100000 ? n : 1; }
  return o;
}

class HttpError extends Error { constructor(code, msg, pin){ super(msg); this.code = code; if(pin) this.pin = pin; } }
const bad = m => new HttpError(400, m), forbidden = m => new HttpError(403, m || 'You do not have access to that.');
const json = (code, body) => ({ statusCode: code, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
const now = () => new Date().toISOString();
const isCond = e => e && e.name === 'ConditionalCheckFailedException';

// ---------- small helpers
function clean(v, max = 400){                       // strings/numbers/booleans only, bounded length
  if(v == null) return undefined;
  if(typeof v === 'boolean') return v;
  if(typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  return String(v).slice(0, max);
}
function pick(obj, fields){ const o = {}; for(const f of fields) if(obj && obj[f] !== undefined){ const c = clean(obj[f]); if(c !== undefined) o[f] = c; }
  if('need' in o && !NEEDS.includes(o.need)) delete o.need;
  return fixDates(o); }
const okId = s => typeof s === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(s);
async function queryAll(params){
  const out = []; let ExclusiveStartKey;
  do { const r = await ddb.send(new QueryCommand({ ...params, ExclusiveStartKey })); out.push(...(r.Items || [])); ExclusiveStartKey = r.LastEvaluatedKey; } while(ExclusiveStartKey);
  return out;
}
async function inBatches(items, n, fn){ for(let i = 0; i < items.length; i += n) await Promise.all(items.slice(i, i + n).map(fn)); }
const strip = it => { const { pk, sk, ...rest } = it; return rest; };
const archKey = r => `${r.dateSubmitted}#${r.submittedAt}#${r.id}`;
const encCursor = k => k ? Buffer.from(JSON.stringify(k)).toString('base64url') : null;
const decCursor = c => { try{ return c ? JSON.parse(Buffer.from(c, 'base64url').toString()) : undefined; }catch(e){ throw bad('Bad cursor'); } };

// ---------- who is calling, and what they may do
const PERMS = ['submit', 'archive', 'remove', 'export', 'calendar', 'documents'];           // switched on/off per person by the owner
const DEFAULT_PERMS = { submit: true, archive: true, remove: true, export: false, calendar: false, documents: false };
async function profileOf(sub){
  const r = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'USERS', sk: sub } }));
  return r.Item || null;
}
const STORE_FIELDS = ['name', 'address', 'suite', 'city', 'state', 'zip', 'phone', 'fax', 'email', 'license', 'licenseExpires', 'npi', 'dea', 'deaExpires', 'ncpdp', 'servicesOther', 'timezone', 'clientId', 'entityLegalName', 'entityType', 'ein'];
// what the pharmacy does (feeds the calendar's programs when its calendar is started) and its weekly hours
const SERVICES = ['retail', 'controlled', 'nonsterile', 'sterile', 'hazardous', 'immunizations', 'delivery', 'ltc', 'specialty', 'infusion'];
const ACCT_TYPES = ['pic', 'pharmacist', 'tech', 'staff'];       // the Account Owner and the host are separate roles
const cleanType = v => { v = String(v == null ? '' : v); if(v !== '' && !ACCT_TYPES.includes(v)) throw bad('Pick the account type from the list.'); return v; };
function validNpi(s){                                         // 10 digits; Luhn check over the number with prefix 80840
  if(!/^\d{10}$/.test(s)) return false;
  const d = ('80840' + s).split('').map(Number); let sum = 0, alt = false;
  for(let i = d.length - 1; i >= 0; i--, alt = !alt){ let x = d[i]; if(alt){ x *= 2; if(x > 9) x -= 9; } sum += x; }
  return sum % 10 === 0;
}
// Look a pharmacy's NPI up in the federal NPI Registry (NPPES, public, no key). Done here on the server so the browser never calls it.
const NPI_API = process.env.NPI_API || 'https://npiregistry.cms.hhs.gov/api/';
async function npiLookup(npi){
  if(!validNpi(npi)) throw bad('NPI should be 10 digits and pass the NPI check digit. Re-check it.');
  let r, j;
  try{
    r = await fetch(NPI_API + '?version=2.1&number=' + npi, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    j = await r.json();
  }catch(e){ throw new HttpError(502, 'Could not reach the NPI Registry just now. Try again in a minute, or type the details in yourself.'); }
  if(!r.ok || (j && Array.isArray(j.Errors) && j.Errors.length)) throw new HttpError(502, 'The NPI Registry did not accept that lookup. Try again, or type the details in yourself.');
  const hit = j && Array.isArray(j.results) && j.results[0];
  if(!hit) return { found: false };
  const b = hit.basic || {}, org = hit.enumeration_type === 'NPI-2';
  const name = org ? (b.organization_name || '') : [b.name_prefix, b.first_name, b.middle_name, b.last_name, b.credential].filter(Boolean).join(' ');
  const loc = (hit.addresses || []).find(a => a.address_purpose === 'LOCATION') || (hit.addresses || [])[0] || {};
  const str = v => String(v == null ? '' : v).trim();
  const tax = (hit.taxonomies || []).map(t => ({ code: str(t.code), desc: str(t.desc), primary: !!t.primary, state: str(t.state), license: str(t.license) }));
  return { found: true, npi: String(hit.number || npi), type: org ? 'organization' : 'individual', name: str(name), active: str(b.status) === 'A',
    lastUpdated: str(b.last_updated), pharmacyTaxonomy: tax.some(t => /^3336/.test(t.code)),
    address: { address: str(loc.address_1), suite: str(loc.address_2), city: str(loc.city), state: str(loc.state), zip: str(loc.postal_code).slice(0, 5),
      phone: str(loc.telephone_number), fax: str(loc.fax_number) }, taxonomies: tax.slice(0, 6) };
}
function validDea(s){                                         // 2 letters + 7 digits; (d1+d3+d5) + 2*(d2+d4+d6) ends in d7
  if(!/^[ABCDEFGHJKLMPRSTUX][A-Z]\d{7}$/.test(s)) return false;
  const d = s.slice(2).split('').map(Number);
  return ((d[0] + d[2] + d[4]) + 2 * (d[1] + d[3] + d[5])) % 10 === d[6];
}
function cleanHours(h){
  if(!Array.isArray(h) || h.length !== 7) throw bad('Hours need all seven days.');
  return h.map(x => {
    if(x == null || x === false) return null;
    if(!x || !/^\d\d:\d\d$/.test(String(x.o)) || !/^\d\d:\d\d$/.test(String(x.c)) || String(x.o) >= String(x.c)) throw bad('Hours: each open day needs an opening time before its closing time.');
    return { o: String(x.o), c: String(x.c) };
  });
}
// Additional closed days beyond the weekly hours: dated days the pharmacy enters by hand (Christmas Eve, a regional day like Good Friday in south
// Louisiana). A day is saved for that year only, or repeats every year. All show on the calendar for everyone who can open it. Anything else is dropped.
// Federal holidays the pharmacy is closed on (a list of ids). The calendar still shows federal holidays as its own display setting.
const FED_HOL = ['newyear', 'mlk', 'presidents', 'memorial', 'juneteenth', 'july4', 'labor', 'columbus', 'veterans', 'thanks', 'xmas'];
function cleanHolClosed(h){
  if(!Array.isArray(h) || h.some(x => !FED_HOL.includes(x))) throw bad('Federal holidays: pick them from the list.');
  return FED_HOL.filter(x => h.includes(x));
}
function cleanClosures(c){
  if(c == null || typeof c !== 'object' || Array.isArray(c)) throw bad('Closed days: unrecognized format.');
  const days = Array.isArray(c.days) ? c.days : [];
  if(days.length > 60) throw bad('Closed days: up to 60 dates.');
  const seen = new Set(), out = days.map(x => {
    const d = String(x && x.d || ''), n = String(x && x.n || '').trim().slice(0, 60);
    if(!DATE.test(d) || new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) !== d) throw bad('Closed days: each needs a real date.');
    if(!n) throw bad('Closed days: give each date a name (for example "Day after Thanksgiving").');
    const y = x.y === true, key = (y ? d.slice(5) : d) + (y ? 'y' : '');
    if(seen.has(key)) throw bad('Closed days: ' + d + ' is listed twice.');
    seen.add(key);
    return { d, n, y };
  }).sort((a, b) => a.d.localeCompare(b.d));
  return { days: out };
}
// ---- clients and legal entities. An EIN belongs to a legal entity, not a location: a pharmacy carries the licensed entity (legal name, type, EIN) and
// belongs to a client (the bill-to account, with the IL- account number). The client record is kept apart in CLIENTS.
const ENTITY_TYPES = ['corporation', 'llc', 'sole_prop', 'partnership', 'other'];
function cleanEin(v){ const d = String(v || '').replace(/\D/g, ''); if(!/^\d{9}$/.test(d)) throw bad('EIN: 9 digits (like 12-3456789).'); return d.slice(0, 2) + '-' + d.slice(2); }
const maskEin = e => e ? '••-•••' + String(e).slice(-4) : '';
const CLIENT_ID = /^IL-\d{6}$/;
// each pharmacy's local time zone: dates/times on its orders are shown in it
const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
  'America/Anchorage', 'Pacific/Honolulu', 'America/Puerto_Rico'];
const DEFAULT_TZ = 'America/Chicago';
const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
async function allStores(){
  return (await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'STORES' } }))
    .map(s => ({ id: s.sk, ...pick(s, STORE_FIELDS), timezone: TIMEZONES.includes(s.timezone) ? s.timezone : DEFAULT_TZ, hasLogo: !!s.hasLogo, calendar: s.calendar === true, documents: s.documents === true,
      deaVerified: s.dea && s.deaVerifiedDea === s.dea ? { at: s.deaVerifiedAt || '', by: s.deaVerifiedBy || '' } : null,
      services: Array.isArray(s.services) ? s.services.filter(x => SERVICES.includes(x)) : [], hours: Array.isArray(s.hours) && s.hours.length === 7 ? s.hours : null,
      closures: s.closures && Array.isArray(s.closures.days) ? { days: s.closures.days } : { days: [] },
      holClosed: Array.isArray(s.holClosed) ? s.holClosed : null }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
const maskStore = s => ({ ...s, ein: '', einMasked: maskEin(s.ein) });      // only IronLedger sees a full EIN
async function storesFor(me){ const all = await allStores(); const mine = me.owner ? all : all.filter(s => (me.stores || {})[s.id] === true); return me.host ? mine : mine.map(maskStore).map(s => suiteStore(s.id) ? { ...s, calendar: suiteUser(me, s.id), documents: suiteUser(me, s.id), rx: suiteUser(me, s.id) && rxPharmacist(me) } : s); }
function canUse(me, store){ return !!me.owner || (me.stores || {})[store] === true; }
function permsOf(me){ const o = {}; for(const p of PERMS) o[p] = me.owner ? true : ((me.perms || {})[p] ?? DEFAULT_PERMS[p]); return o; }
// ---------- Calendar + Documents suite access: a fixed list of logins per pharmacy (SUITE_USERS in template.yaml, "NTX1:login,login;..."),
// not switches. For a pharmacy on the list, ONLY these logins get Calendar and Documents, whatever else they have access to there (the reorder
// list, Account Owner role, other privileges). Pharmacies not on the list keep the older switches. Editing the list is a code/template change.
const SUITE = (() => { const o = {}; for(const part of String(process.env.SUITE_USERS || '').split(';')){ const [id, list] = part.split(':'); if(id && list) o[id.trim()] = list.split(',').map(x => x.trim().toLowerCase()).filter(Boolean); } return o; })();
const suiteStore = id => Object.prototype.hasOwnProperty.call(SUITE, id);
const suiteUser = (me, id) => suiteStore(id) && canUse(me, id) && !me.host && SUITE[id].includes(String(me.login || '').toLowerCase());
const suiteAny = me => Object.keys(SUITE).some(id => suiteUser(me, id));
const effPerms = me => { const o = permsOf(me); if(suiteAny(me)){ o.calendar = true; o.documents = true; } return o; };
function need(me, p, what){ if(!permsOf(me)[p]) throw forbidden(`You don't have permission to ${what}. Ask the Account Owner.`); }
const who = me => me.name || me.login;

// ---------- store data
async function lines(store){
  const items = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': 'STORE#' + store, ':s': 'LINE#' } });
  return items.map(it => ({ id: it.sk.slice(5), ...strip(it) })).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}
async function memory(store){
  const items = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': 'STORE#' + store, ':s': 'MEM#' } });
  const m = {}; for(const it of items) m[it.sk.slice(4)] = it.v || {}; return m;
}
async function archivePage(store, q){
  const lim = parseInt(q.limit, 10);
  const p = { TableName: ARCH, ScanIndexForward: false, Limit: Math.max(1, Math.min(Number.isFinite(lim) ? lim : 1000, 2000)), ExclusiveStartKey: decCursor(q.cursor) };
  if(q.day && /^\d{4}-\d{2}-\d{2}$/.test(q.day)){ p.KeyConditionExpression = 'pk = :p AND begins_with(sk, :d)'; p.ExpressionAttributeValues = { ':p': store, ':d': q.day + '#' }; }
  else { p.KeyConditionExpression = 'pk = :p'; p.ExpressionAttributeValues = { ':p': store }; }
  const r = await ddb.send(new QueryCommand(p));
  return { items: (r.Items || []).map(strip), cursor: encCursor(r.LastEvaluatedKey) };
}
async function putArchive(store, rec){                 // add-only: never replaces an existing archived line
  try{
    await ddb.send(new PutCommand({ TableName: ARCH, Item: { pk: store, sk: archKey(rec), ...rec }, ConditionExpression: 'attribute_not_exists(pk)' }));
    return true;
  }catch(e){ if(isCond(e)) return false; throw e; }
}
async function putMemory(store, key, v, onlyIfNew){
  try{
    await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: 'STORE#' + store, sk: 'MEM#' + key, v, updatedAt: now() },
      ...(onlyIfNew ? { ConditionExpression: 'attribute_not_exists(pk)' } : {}) }));
    return true;
  }catch(e){ if(isCond(e)) return false; throw e; }
}
function cleanMem(v){
  if(!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = {};
  for(const [k, x] of Object.entries(v).slice(0, 20)){
    if(!/^[A-Za-z0-9_]{1,40}$/.test(k)) continue;
    if(Array.isArray(x)){ o[k] = x.slice(0, 60).map(y => String(y == null ? '' : y).slice(0, 120)).filter(Boolean); continue; }   // e.g. distributors, newest first
    if(x && typeof x === 'object'){                                   // e.g. how many times each distributor was used
      const m = {}; for(const [kk, n] of Object.entries(x).slice(0, 30)) if(Number.isFinite(+n)) m[String(kk).slice(0, 120)] = +n;
      o[k] = m; continue;
    }
    const c = clean(x); if(c !== undefined) o[k] = c;
  }
  return o;
}
function cleanArch(r, me){
  const rec = pick(r, ARCH_FIELDS);
  if(!okId(rec.id)) rec.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  if(!DATE.test(rec.dateSubmitted || '')) throw bad('Archived line is missing its submitted date.');
  rec.submittedAt = rec.submittedAt || rec.dateSubmitted;
  if(r.addedBy && !me) rec.addedBy = clean(r.addedBy, 120);          // import only; live submits take it from the stored line
  if(me) rec.submittedBy = who(me);
  else if(r.submittedBy) rec.submittedBy = clean(r.submittedBy, 120);
  return rec;
}

// one call carries every change a click makes: new lines, field edits, removals, submitted lines, memory
async function commit(store, me, b){
  const submitted = new Set((Array.isArray(b.archive) ? b.archive : []).map(r => r && r.lineId).filter(Boolean));
  if(submitted.size || (Array.isArray(b.archive) && b.archive.length)) need(me, 'submit', 'submit orders');
  if((Array.isArray(b.del) ? b.del : []).some(id => !submitted.has(id))) need(me, 'remove', 'remove lines');
  const create = Array.isArray(b.create) ? b.create : [], set = Array.isArray(b.set) ? b.set : [],
        del = Array.isArray(b.del) ? b.del : [], archive = Array.isArray(b.archive) ? b.archive : [],
        mem = b.mem && typeof b.mem === 'object' ? b.mem : {};
  if(create.length + set.length + del.length + archive.length > 2000) throw bad('Too many changes at once.');
  const pk = 'STORE#' + store, t = now(), by = who(me);

  // 1) archive first: if any of it fails, nothing is removed from the open list.
  //    Who added / ticked the line is copied from the stored line, never taken from the request.
  const arch = archive.map(r => cleanArch(r, me));
  await inBatches(arch, 10, async rec => {
    if(!okId(rec.lineId)) return;
    const l = (await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk, sk: 'LINE#' + rec.lineId } }))).Item;
    if(l){ if(l.addedBy) rec.addedBy = l.addedBy; if(l.orderedBy) rec.orderedBy = l.orderedBy; }
  });
  await inBatches(arch, 10, r => putArchive(store, r));

  // 2) new lines (a second click on another screen can't make a duplicate id)
  await inBatches(create, 10, async l => {
    if(!okId(l.id)) throw bad('Bad line id');
    const item = { pk, sk: 'LINE#' + l.id, ...pick(l, LINE_FIELDS), createdAt: t, updatedAt: t, addedBy: by };
    if(item.ordered) item.orderedBy = by;
    try{ await ddb.send(new PutCommand({ TableName: MAIN, Item: item, ConditionExpression: 'attribute_not_exists(pk)' })); }
    catch(e){ if(!isCond(e)) throw e; }
  });

  // 3) field edits: only the fields that changed, so two people editing different fields don't overwrite each other
  await inBatches(set, 10, async s => {
    if(!okId(s.id)) throw bad('Bad line id');
    const f = pick(s.fields || {}, LINE_FIELDS); if(!Object.keys(f).length) return;
    if('ordered' in f) f.orderedBy = f.ordered ? by : '';
    f.updatedAt = t;
    const names = {}, vals = {}, parts = [];
    Object.entries(f).forEach(([k, v], i) => { names['#f' + i] = k; vals[':v' + i] = v; parts.push(`#f${i} = :v${i}`); });
    try{ await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk, sk: 'LINE#' + s.id }, UpdateExpression: 'SET ' + parts.join(', '),
      ExpressionAttributeNames: names, ExpressionAttributeValues: vals, ConditionExpression: 'attribute_exists(pk)' })); }
    catch(e){ if(!isCond(e)) throw e; }                 // someone else removed or submitted it meanwhile
  });

  // 4) removals from the open list (submitted lines are already safe in the archive)
  await inBatches(del, 10, async id => { if(okId(id)) await ddb.send(new DeleteCommand({ TableName: MAIN, Key: { pk, sk: 'LINE#' + id } })); });

  // 5) memory
  const memEntries = Object.entries(mem).slice(0, 2000);
  await inBatches(memEntries, 10, async ([k, v]) => { const c = cleanMem(v); if(c && k.length <= 300) await putMemory(store, k, c, false); });

  return { ok: true, lines: await lines(store) };
}

// bring in a nortex_reorder_data.json from the shared-drive version. Adds only; never overwrites.
async function importData(store, b){
  const res = { archiveAdded: 0, archiveSkipped: 0, linesAdded: 0, linesSkipped: 0, memoryAdded: 0, memorySkipped: 0 };
  const archive = Array.isArray(b.archive) ? b.archive.slice(0, 1000) : [];
  await inBatches(archive.map(r => cleanArch(r, null)), 10, async r => { (await putArchive(store, r)) ? res.archiveAdded++ : res.archiveSkipped++; });
  const open = Array.isArray(b.reorder) ? b.reorder.slice(0, 500) : [], t = now();
  await inBatches(open, 10, async l => {
    if(!okId(l.id)) { res.linesSkipped++; return; }
    try{ await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: 'STORE#' + store, sk: 'LINE#' + l.id, ...pick(l, LINE_FIELDS), createdAt: t, updatedAt: t, addedBy: 'imported' },
      ConditionExpression: 'attribute_not_exists(pk)' })); res.linesAdded++; }
    catch(e){ if(isCond(e)) res.linesSkipped++; else throw e; }
  });
  const mem = Object.entries(b.remember && typeof b.remember === 'object' ? b.remember : {}).slice(0, 2000);
  await inBatches(mem, 10, async ([k, v]) => { const c = cleanMem(v); if(!c || k.length > 300){ res.memorySkipped++; return; }
    (await putMemory(store, k, c, true)) ? res.memoryAdded++ : res.memorySkipped++; });
  return res;
}

// ---------- owner: pharmacies and people
const PHARM_ID = /^[A-Z0-9][A-Z0-9-]{1,19}$/;              // e.g. NTX1, NORTEX-HASLET
const LOGIN_ID = /^[a-z0-9][a-z0-9._-]{2,31}$/;
function phoneE164(v){
  const d = String(v || '').replace(/\D/g, '');
  if(d.length === 10) return '+1' + d;
  if(d.length === 11 && d[0] === '1') return '+' + d;
  if(String(v || '').trim().startsWith('+') && d.length >= 8 && d.length <= 15) return '+' + d;
  throw bad('Enter a valid mobile number (10 digits for US).');
}
function tempPassword(){                                    // meets the policy: 10+ chars, lowercase + number
  const L = 'abcdefghjkmnpqrstuvwxyz', D = '23456789', A = L + D;
  let p = L[Math.floor(Math.random() * L.length)] + D[Math.floor(Math.random() * D.length)];
  while(p.length < 12) p += A[Math.floor(Math.random() * A.length)];
  return p;
}
function storeFields(b){
  const f = {};
  const max = { address: 200, suite: 40, city: 80, state: 2, zip: 10, npi: 10, dea: 9, ncpdp: 7, licenseExpires: 10, deaExpires: 10, servicesOther: 300 };
  for(const k of STORE_FIELDS) if(b[k] !== undefined) f[k] = String(clean(b[k], max[k] || 120) || '').trim();
  if(f.state) f.state = f.state.toUpperCase();
  if(f.state && !US_STATES.includes(f.state)) throw bad('Pick the state from the list.');
  if(f.zip && !/^\d{5}(-\d{4})?$/.test(f.zip)) throw bad('ZIP code: 5 digits (or ZIP+4, like 76052-1234).');
  if(f.name === '') throw bad('Pharmacy name is required.');
  if(f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) throw bad('Pharmacy email doesn’t look right.');
  if(f.timezone !== undefined && !TIMEZONES.includes(f.timezone)) throw bad('Pick the pharmacy’s time zone from the list.');
  if(b.calendar !== undefined){ if(typeof b.calendar !== 'boolean') throw bad('Calendar switch must be on or off.'); f.calendar = b.calendar; }
  if(b.documents !== undefined){ if(typeof b.documents !== 'boolean') throw bad('Documents switch must be on or off.'); f.documents = b.documents; }
  if(f.npi && !validNpi(f.npi)) throw bad('NPI should be 10 digits and pass the NPI check digit. Re-check it.');
  if(f.dea){ f.dea = f.dea.toUpperCase(); if(!validDea(f.dea)) throw bad('DEA number should be 2 letters and 7 digits and pass the DEA check digit. Re-check it.'); }
  if(f.ncpdp && !/^\d{7}$/.test(f.ncpdp)) throw bad('NCPDP provider ID is 7 digits.');
  for(const k of ['licenseExpires', 'deaExpires']) if(f[k] && !DATE.test(f[k])) throw bad('Expiration dates: use the date picker (YYYY-MM-DD).');
  if(b.services !== undefined){
    if(!Array.isArray(b.services) || b.services.some(x => !SERVICES.includes(x))) throw bad('Pick services from the list.');
    f.services = [...new Set(b.services)];
  }
  if(f.entityType) { if(!ENTITY_TYPES.includes(f.entityType)) throw bad('Pick the entity type from the list.'); }
  if(f.ein) f.ein = cleanEin(f.ein);
  if(f.clientId && !CLIENT_ID.test(f.clientId)) throw bad('Pick the client from the list.');
  if(b.hours !== undefined) f.hours = cleanHours(b.hours);
  if(b.closures !== undefined) f.closures = cleanClosures(b.closures);
  if(b.holClosed !== undefined) f.holClosed = cleanHolClosed(b.holClosed);
  return f;
}
// What each side may change on a pharmacy.
// The Account Owner (the pharmacy's primary account holder) may change only these. Everything else (name, address, email, license, NPI, DEA, NCPDP,
// services, the Calendar switch) is set by IronLedger (the host login); billing follows the client's identity, so those must stay consistent.
const AM_EDITABLE = ['phone', 'fax', 'email', 'timezone', 'hours', 'closures', 'holClosed', 'licenseExpires', 'deaExpires'];
// Identity: once a value is on file it is hard to change. Even the host must give a reason, and every change is written to the pharmacy's change history.
const IDENTITY = ['name', 'address', 'suite', 'city', 'state', 'zip', 'license', 'npi', 'dea', 'ncpdp', 'clientId', 'entityLegalName', 'entityType', 'ein'];
async function nextAcctNo(){                              // the client's IronLedger account number: generated once, never changed
  const r = await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'COUNTER', sk: 'ACCT' }, UpdateExpression: 'ADD n :one', ExpressionAttributeValues: { ':one': 1 }, ReturnValues: 'UPDATED_NEW' }));
  return 'IL-' + String(r.Attributes.n).padStart(6, '0');
}
// ---- rep drafts: a rep assigned to a pharmacy proposes changes; a supervisor approves or rejects. Nothing is applied until approved.
// Services, the Calendar switch and DEA checks are never in a draft (a new service line needs pricing and contracting settled first).
const DRAFT_KEYS = [...IDENTITY, 'email', ...AM_EDITABLE];
const isRep = me => !!(me.host && me.hostRole === 'rep'), isSupervisor = me => !!(me.host && me.hostRole !== 'rep');
async function createDraft(me, id, b){
  if(!isRep(me)) throw forbidden('Drafts are entered by an IronLedger rep. A supervisor edits directly.');
  if(!okId(id)) throw bad('Bad pharmacy');
  if(!(me.repStores || {})[id]) throw forbidden('That pharmacy is not assigned to you.');
  const fields = b.fields && typeof b.fields === 'object' ? b.fields : {};
  const keys = Object.keys(fields); if(!keys.length) throw bad('Nothing to submit.');
  if(keys.some(k => !DRAFT_KEYS.includes(k))) throw bad('Services, the Calendar switch and DEA checks can’t be drafted. Escalate them to a supervisor.');
  const note = String(b.note || '').trim(); if(note.length < 10) throw bad('Say why (at least 10 characters) so the supervisor can review it.');
  const cur = (await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'STORES', sk: id } }))).Item; if(!cur) throw bad('No such pharmacy.');
  const f = storeFields(fields);                       // same validation as a direct edit
  const sk = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 6);
  await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: 'STOREDRAFT#' + id, sk, store: id, status: 'pending', fields: f, note, by: who(me), bySub: me.sk, at: now() } }));
  return { ok: true, draft: sk };
}
async function listDrafts(me){
  const stores = isSupervisor(me) ? (await allStores()).map(s => s.id) : Object.keys(me.repStores || {});
  const out = [];
  for(const id of stores){
    const r = await ddb.send(new QueryCommand({ TableName: MAIN, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'STOREDRAFT#' + id }, ScanIndexForward: false, Limit: 30 }));
    const cur = (await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'STORES', sk: id } }))).Item || {};
    for(const d of r.Items || []){
      if(!isSupervisor(me) && d.bySub !== me.sk) continue;
      out.push({ store: id, id: d.sk, status: d.status, note: d.note, by: d.by, at: d.at, decidedBy: d.decidedBy || '', decidedAt: d.decidedAt || '', decisionNote: d.decisionNote || '',
        changes: Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, [cur[k] === undefined ? '' : cur[k], v]])) });
    }
  }
  return { drafts: out.sort((a, b) => (b.at || '').localeCompare(a.at || '')) };
}
async function decideDraft(me, id, sk, action, b){
  if(!isSupervisor(me)) throw forbidden('A supervisor reviews drafts.');
  if(!okId(id) || !/^[0-9]+-[a-z0-9]+$/.test(sk)) throw bad('Bad draft');
  const d = (await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'STOREDRAFT#' + id, sk } }))).Item;
  if(!d) throw new HttpError(404, 'No such draft.');
  if(d.status !== 'pending') throw bad('That draft was already ' + d.status + '.');
  const dn = String(b.note || '').trim();
  if(action === 'reject' && dn.length < 5) throw bad('Say why it was rejected.');
  if(action === 'approve') await updateStore(id, { ...d.fields, changeReason: d.note + ' (entered by ' + d.by + ', approved by ' + who(me) + ')' }, who(me) + ' (approved draft by ' + d.by + ')', true);
  try{ await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'STOREDRAFT#' + id, sk }, ConditionExpression: '#s = :p', UpdateExpression: 'SET #s = :n, decidedBy = :b, decidedAt = :a, decisionNote = :d',
    ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':p': 'pending', ':n': action === 'approve' ? 'approved' : 'rejected', ':b': who(me), ':a': now(), ':d': dn } })); }
  catch(e){ if(isCond(e)) throw bad('That draft was just decided by someone else.'); throw e; }
  return { ok: true };
}
// ---- clients (host only): the bill-to account. Account number IL-nnnnnn is generated once and is the client's key; it never changes.
const CLIENT_TEXT = { legalName: 160, dba: 160, address: 200, suite: 40, city: 80, state: 2, zip: 10, phone: 30, fax: 30, bAddress: 200, bSuite: 40, bCity: 80, bState: 2, bZip: 10 };
const CLIENT_IDENTITY = ['legalName', 'entityType', 'ein'];
const CONTACT_ROLES = ['relations', 'billing', 'other'];
function clientFields(b, creating){
  const f = {};
  for(const [k, m] of Object.entries(CLIENT_TEXT)) if(b[k] !== undefined) f[k] = String(clean(b[k], m) || '').trim();
  if(b.entityType !== undefined){ f.entityType = String(b.entityType); if(!ENTITY_TYPES.includes(f.entityType)) throw bad('Pick the entity type from the list.'); }
  if(b.ein !== undefined) f.ein = cleanEin(b.ein);
  for(const k of ['state', 'bState']) if(f[k]){ f[k] = f[k].toUpperCase(); if(!US_STATES.includes(f[k])) throw bad('Pick the state from the list.'); }
  for(const k of ['zip', 'bZip']) if(f[k] && !/^\d{5}(-\d{4})?$/.test(f[k])) throw bad('ZIP code: 5 digits (or ZIP+4, like 76052-1234).');
  if(b.billingSame !== undefined){ if(typeof b.billingSame !== 'boolean') throw bad('Billing address: same as business must be on or off.'); f.billingSame = b.billingSame; }
  if(b.contacts !== undefined){
    if(!Array.isArray(b.contacts) || b.contacts.length > 20) throw bad('Contacts: up to 20.');
    f.contacts = b.contacts.map(c => {
      const o = { role: String(c && c.role || ''), name: String(clean(c && c.name, 80) || '').trim(), title: String(clean(c && c.title, 60) || '').trim(), email: String(clean(c && c.email, 120) || '').trim(), phone: String(clean(c && c.phone, 30) || '').trim() };
      if(!CONTACT_ROLES.includes(o.role)) throw bad('Contacts: pick the role from the list.');
      if(!o.name) throw bad('Contacts: each needs a name.');
      if(o.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email)) throw bad('Contacts: ' + o.name + '’s email doesn’t look right.');
      return o;
    });
  }
  if(creating){
    for(const [k, msg] of [['legalName', 'Legal name of the entity is required.'], ['entityType', 'Entity type is required.'], ['ein', 'EIN is required.'], ['address', 'Business street address is required.'], ['city', 'Business city is required.'], ['state', 'Business state is required.'], ['zip', 'Business ZIP is required.']]) if(!f[k]) throw bad(msg);
    if(f.billingSame === undefined) f.billingSame = true;
  }
  if(f.billingSame === false && ((b.bAddress !== undefined && !f.bAddress) || (b.bCity !== undefined && !f.bCity))) throw bad('Billing address: street and city are needed when it differs from the business address.');
  if(f.billingSame === true) Object.assign(f, { bAddress: '', bSuite: '', bCity: '', bState: '', bZip: '' });
  return f;
}
async function needClient(id){
  if(!CLIENT_ID.test(String(id))) throw bad('Pick the client from the list.');
  const r = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'CLIENTS', sk: id } }));
  if(!r.Item) throw bad('No such client.');
  return r.Item;
}
const clientView = c => ({ id: c.sk, acctNo: c.sk, ...pick(c, [...Object.keys(CLIENT_TEXT), 'entityType', 'ein']), billingSame: c.billingSame !== false, contacts: Array.isArray(c.contacts) ? c.contacts : [], createdAt: c.createdAt || '' });
async function listClients(){
  const items = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'CLIENTS' } });
  const stores = await allStores();
  return items.map(c => ({ ...clientView(c), pharmacies: stores.filter(s => s.clientId === c.sk).map(s => s.id) })).sort((a, b) => a.id.localeCompare(b.id));
}
async function addClient(b, by){
  const f = clientFields(b, true), id = await nextAcctNo();
  await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: 'CLIENTS', sk: id, ...f, createdAt: now(), createdBy: by || '' }, ConditionExpression: 'attribute_not_exists(pk)' }));
  return { id, acctNo: id };
}
async function updateClient(id, b, by){
  if(!CLIENT_ID.test(String(id))) throw bad('Bad client');
  const cur = (await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'CLIENTS', sk: id } }))).Item; if(!cur) throw new HttpError(404, 'No such client.');
  if(Object.keys(b).some(k => !Object.keys(CLIENT_TEXT).concat(['entityType', 'ein', 'billingSame', 'contacts', 'changeReason']).includes(k))) throw bad('Unknown field. The account number can’t be changed.');
  const f = clientFields(b, false);
  if(f.ein === '' || f.legalName === '') throw bad('The legal name and EIN can’t be cleared. Enter the corrected value instead.');
  const changed = CLIENT_IDENTITY.filter(k => f[k] !== undefined && (cur[k] || '') !== '' && f[k] !== cur[k]), reason = String(b.changeReason || '').trim();
  if(changed.length && reason.length < 10) throw bad('Changing ' + changed.join(', ') + ' needs a reason (at least 10 characters). Billing follows the client’s identity, so these must stay consistent.');
  const diff = {};
  for(const [k, v] of Object.entries(f)){ const o = cur[k]; if(JSON.stringify(o === undefined ? (Array.isArray(v) ? [] : '') : o) !== JSON.stringify(v)) diff[k] = [o === undefined ? null : o, v]; }
  if(!Object.keys(diff).length) return;
  await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: 'CLIENTAUDIT#' + id, sk: now() + '#' + Math.random().toString(36).slice(2, 7), at: now(), by: by || '', reason, changes: diff } }));
  const names = {}, vals = {}, parts = [];
  Object.entries({ ...f, updatedAt: now() }).forEach(([k, v], i) => { names['#f' + i] = k; vals[':v' + i] = v; parts.push(`#f${i} = :v${i}`); });
  await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'CLIENTS', sk: id }, UpdateExpression: 'SET ' + parts.join(', '), ExpressionAttributeNames: names, ExpressionAttributeValues: vals, ConditionExpression: 'attribute_exists(pk)' }));
}
async function clientHistory(id){
  if(!CLIENT_ID.test(String(id))) throw bad('Bad client');
  const r = await ddb.send(new QueryCommand({ TableName: MAIN, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'CLIENTAUDIT#' + id }, ScanIndexForward: false, Limit: 50 }));
  return { history: (r.Items || []).map(i => ({ at: i.at, by: i.by, reason: i.reason || '', changes: i.changes })) };
}
async function storeHistory(id){
  if(!okId(id)) throw bad('Bad pharmacy');
  const r = await ddb.send(new QueryCommand({ TableName: MAIN, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'STOREAUDIT#' + id }, ScanIndexForward: false, Limit: 50 }));
  return { history: (r.Items || []).map(i => ({ at: i.at, by: i.by, reason: i.reason || '', changes: i.changes })) };
}
async function addStore(b, by, firstRun){
  const id = String(b.id || '').trim().toUpperCase();
  if(!PHARM_ID.test(id)) throw bad('Pharmacy ID: 2–20 letters, numbers or dashes (e.g. NTX1).');
  const f = storeFields(b); if(!f.name) throw bad('Pharmacy name is required.');
  if(!f.timezone) f.timezone = DEFAULT_TZ;
  if(!firstRun){      // the first pharmacy made by the setup script has no client yet; every other one needs its client and licensed entity
    if(!f.clientId) throw bad('Pick the client this pharmacy belongs to (bill-to account).');
    if(!f.entityLegalName) throw bad('Legal name of the entity that holds the pharmacy license is required.');
    if(!f.entityType) throw bad('Entity type is required.');
    if(!f.ein) throw bad('The licensed entity’s EIN is required.');
  }
  if(f.clientId) await needClient(f.clientId);
  try{ await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: 'STORES', sk: id, ...f, createdAt: now(), createdBy: by || '' }, ConditionExpression: 'attribute_not_exists(pk)' })); }
  catch(e){ if(isCond(e)) throw bad('That Pharmacy ID is already used.'); throw e; }
  return { id, ...f };
}
async function updateStore(id, b, by, isHost){
  if(!okId(id)) throw bad('Bad pharmacy');
  if(!isHost && Object.keys(b).some(k => !AM_EDITABLE.includes(k))) throw forbidden('Only phone, fax, email, time zone, hours, closed days and license/DEA expiration dates can be changed here. The name, address, license and identifiers, services and Calendar are set by IronLedger. Contact your IronLedger representative.');
  const f = storeFields(b);
  const curItem = (await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'STORES', sk: id } }))).Item;
  if(!curItem) throw bad('No such pharmacy.');
  // changing an identity value that is already on file needs a written reason (filling a blank does not)
  if(f.clientId) await needClient(f.clientId);
  if(f.ein === '' && curItem.ein) throw bad('The licensed entity’s EIN is required and can’t be cleared. Enter the corrected number instead.');
  const changedIdent = IDENTITY.filter(k => f[k] !== undefined && (curItem[k] || '') !== '' && f[k] !== curItem[k]);
  const reason = String(b.changeReason || '').trim();
  if(changedIdent.length && reason.length < 10) throw bad('Changing ' + changedIdent.join(', ') + ' needs a reason (at least 10 characters). The name, address, license and identifiers must stay consistent with the license and with billing.');
  const diff = {};
  for(const [k, v] of Object.entries(f)){ const o = curItem[k]; if(JSON.stringify(o === undefined ? (Array.isArray(v) ? [] : '') : o) !== JSON.stringify(v)) diff[k] = [o === undefined ? null : o, v]; }
  if(b.deaVerified !== undefined){          // a person checked the number on the DEA's own validation site and says so; recorded against that exact number
    if(b.deaVerified !== true) throw bad('Verification can only be recorded, not edited.');
    const cur = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'STORES', sk: id } }));
    if(!cur.Item) throw bad('No such pharmacy.');
    const dea = f.dea !== undefined ? f.dea : (cur.Item.dea || '');
    if(!dea) throw bad('Enter the DEA number first.');
    f.deaVerifiedDea = dea; f.deaVerifiedAt = now(); f.deaVerifiedBy = by || '';
  }
  else if(f.dea !== undefined){              // the number was changed: an earlier check no longer applies to it
    const cur = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'STORES', sk: id } }));
    if(cur.Item && (cur.Item.dea || '') !== f.dea) f.deaVerifiedDea = '';
  }
  if(!Object.keys(f).length) return;
  if(Object.keys(diff).length) await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: 'STOREAUDIT#' + id, sk: now() + '#' + Math.random().toString(36).slice(2, 7), at: now(), by: by || '', reason, changes: diff } }));
  const names = {}, vals = {}, parts = [];
  Object.entries({ ...f, updatedAt: now() }).forEach(([k, v], i) => { names['#f' + i] = k; vals[':v' + i] = v; parts.push(`#f${i} = :v${i}`); });
  try{ await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'STORES', sk: id }, UpdateExpression: 'SET ' + parts.join(', '),
    ExpressionAttributeNames: names, ExpressionAttributeValues: vals, ConditionExpression: 'attribute_exists(pk)' })); }
  catch(e){ if(isCond(e)) throw bad('No such pharmacy.'); throw e; }
}
// logo: a small image (the app shrinks it to 256 px before upload) kept as a data URL in its own item
async function setLogo(id, dataUrl){
  if(!okId(id)) throw bad('Bad pharmacy');
  if(dataUrl === null || dataUrl === ''){
    await ddb.send(new DeleteCommand({ TableName: MAIN, Key: { pk: 'LOGO', sk: id } }));
    try{ await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'STORES', sk: id }, UpdateExpression: 'SET hasLogo = :f', ExpressionAttributeValues: { ':f': false }, ConditionExpression: 'attribute_exists(pk)' })); }
    catch(e){ if(isCond(e)) throw bad('No such pharmacy.'); throw e; }
    return;
  }
  if(typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw bad('Logo must be a PNG, JPG or WebP image.');
  if(dataUrl.length > 300000) throw bad('Logo is too large; use a smaller image.');
  const st = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'STORES', sk: id } }));
  if(!st.Item) throw bad('No such pharmacy.');
  await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: 'LOGO', sk: id, dataUrl, updatedAt: now() } }));
  await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'STORES', sk: id }, UpdateExpression: 'SET hasLogo = :t', ExpressionAttributeValues: { ':t': true }, ConditionExpression: 'attribute_exists(pk)' }));
}
// shown on the sign-in screen once a Pharmacy ID is typed: name and logo only, nothing else
async function publicPharmacy(id){
  id = String(id || '').trim().toUpperCase();
  if(!PHARM_ID.test(id)) return { found: false };
  const s = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'STORES', sk: id } }));
  if(!s.Item) return { found: false };
  const l = s.Item.hasLogo ? await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'LOGO', sk: id } })) : null;
  return { found: true, id, name: s.Item.name, logo: (l && l.Item && l.Item.dataUrl) || '' };
}
const TEMP_DAYS = 3;                                   // matches TemporaryPasswordValidityDays in template.yaml
function pendingOf(p, c){
  if(!c || c.status !== 'FORCE_CHANGE_PASSWORD') return { pending: false };
  const issued = p.tempIssuedAt || p.createdAt || (c.created ? new Date(c.created).toISOString() : null);
  const expires = issued ? new Date(Date.parse(issued) + TEMP_DAYS * 86400000).toISOString() : null;
  return { pending: true, tempIssuedAt: issued, tempExpires: expires, tempExpired: !!expires && Date.parse(expires) < Date.now() };
}
async function listPeople(){
  const profiles = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'USERS' } });
  const status = {}; let PaginationToken;
  do { const r = await idp.send(new ListUsersCommand({ UserPoolId: POOL, PaginationToken, Limit: 60 }));
    for(const u of r.Users || []){ const sub = (u.Attributes || []).find(a => a.Name === 'sub'); if(sub) status[sub.Value] = { status: u.UserStatus, enabled: u.Enabled, created: u.UserCreateDate }; }
    PaginationToken = r.PaginationToken; } while(PaginationToken);
  for(const p of profiles) if(!p.deleted && !p.empId) await ensureEmpId(p);
  return profiles.filter(p => !p.deleted).map(p => ({ sub: p.sk, login: p.login, name: p.name || '', phone: p.phone || '', owner: !!p.owner, host: !!p.host, hostRole: p.host ? (p.hostRole === 'rep' ? 'rep' : 'supervisor') : '', repStores: p.host ? (p.repStores || {}) : {}, acctType: p.acctType || '', docDuty: DOC_DUTIES.includes(p.docDuty) ? p.docDuty : '', initials: p.initials || '', license: p.license || '', empId: p.empId || '', pin: pinState(p),
    stores: p.stores || {}, perms: effPerms(p), disabled: status[p.sk] ? !status[p.sk].enabled : !!p.disabled,
    status: (status[p.sk] || {}).status || 'UNKNOWN', ...pendingOf(p, status[p.sk]) }))
    // Account Owner, host, then people still waiting to sign in for the first time, then everyone else
    .sort((a, b) => (b.owner - a.owner) || (b.host - a.host) || (b.pending - a.pending) || (a.name || a.login).localeCompare(b.name || b.login));
}
async function cleanStoreToggles(obj){
  const all = new Set((await allStores()).map(s => s.id)), out = {};
  for(const [k, v] of Object.entries(obj && typeof obj === 'object' ? obj : {})) if(all.has(k)) out[k] = v === true;
  return out;
}
function cleanPerms(obj){ const o = {}; for(const p of PERMS) if(obj && typeof obj[p] === 'boolean') o[p] = obj[p]; return o; }
async function createLogin(b){
  const login = String(b.login || '').trim().toLowerCase(), name = clean(b.name, 120) || '', phone = phoneE164(b.phone);
  if(!LOGIN_ID.test(login)) throw bad('Login ID: 3–32 letters, numbers, dots, dashes or underscores.');
  const pw = b.tempPassword ? String(b.tempPassword) : tempPassword();
  if(pw.length < 10 || !/[a-z]/.test(pw) || !/\d/.test(pw)) throw bad('Temporary password: at least 10 characters with a lowercase letter and a number.');
  let r;
  try{ r = await idp.send(new AdminCreateUserCommand({ UserPoolId: POOL, Username: login, TemporaryPassword: pw, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'phone_number', Value: phone }, { Name: 'phone_number_verified', Value: 'true' }, ...(name ? [{ Name: 'name', Value: name }] : [])] })); }
  catch(e){
    if(e.name !== 'UsernameExistsException') throw e;
    const people = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'USERS' } });
    if(people.some(p => p.login === login && !p.deleted)) throw bad('That Login ID is already taken.');
    // nobody in the list owns it: an earlier add stopped halfway. Remove that half-made login and start again.
    await idp.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: login }));
    r = await idp.send(new AdminCreateUserCommand({ UserPoolId: POOL, Username: login, TemporaryPassword: pw, MessageAction: 'SUPPRESS',
      UserAttributes: [{ Name: 'phone_number', Value: phone }, { Name: 'phone_number_verified', Value: 'true' }, ...(name ? [{ Name: 'name', Value: name }] : [])] }));
  }
  await idp.send(new AdminSetUserMFAPreferenceCommand({ UserPoolId: POOL, Username: login, SMSMfaSettings: { Enabled: true, PreferredMfa: true } })).catch(() => {});
  const sub = ((r.User && r.User.Attributes) || []).find(a => a.Name === 'sub').Value;
  return { sub, login, name, phone, tempPassword: pw };
}
// An IronLedger rep may send password resets and change a privilege, only on an existing, active person (ID live, as in the people list) who has an account type.
// Nothing else about a person (type, pharmacies, name, phone, switching off, deleting) and never the Calendar privilege, which belongs to a service line.
// ---------- employee ID and personal PIN (signs approvals and reviews)
// The PIN is 4 digits known only to the person. It never signs anyone in; it confirms who is at the keyboard while already signed in.
// 10,000 codes is small, so: 5 wrong tries lock it, it is stored only as a keyed hash (HMAC with a secret kept outside the database),
// and only the Account Owner or a host supervisor can issue a temporary one. Every try, lockout and reset is written to PINLOG.
let _pinKey = null;
async function pinKey(){
  if(_pinKey) return _pinKey;
  if(process.env.PIN_SECRET) return (_pinKey = process.env.PIN_SECRET);
  if(!process.env.PIN_SECRET_ARN) throw new HttpError(500, 'PIN signing is not set up on the server.');
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const r = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.PIN_SECRET_ARN }));
  return (_pinKey = r.SecretString);
}
const pinHash = async (sub, pin) => crypto.createHmac('sha256', await pinKey()).update(sub + ':' + pin).digest('hex');
const PIN_REQUIRED = process.env.PIN_REQUIRED === '1';   // OFF for now (Neo 2026-11-18): sign-offs need initials only. Set PIN_REQUIRED=1 in template.yaml to turn the PIN back on.
const PIN_MAX_FAILS = 5;
const pinErr = (code, msg, status) => new HttpError(status || 409, msg, code);
const pinState = p => !p.pin ? 'none' : p.pin.locked ? 'locked' : p.pin.temp ? 'temp' : 'set';
const weakPin = t => /^(\d)\1{3}$/.test(t) || '0123456789'.includes(t) || '9876543210'.includes(t);
const cleanNewPin = v => { const t = String(v == null ? '' : v).trim(); if(!/^\d{4}$/.test(t)) throw bad('The PIN is 4 digits.'); if(weakPin(t)) throw bad('Too easy to guess (like 1234 or 1111). Choose another.'); return t; };
async function pinLog(p, action, by){
  const at = now();
  await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: 'PINLOG', sk: `${at}#${crypto.randomBytes(3).toString('hex')}`, j: JSON.stringify({ at, sub: p.sk, login: p.login || '', name: p.name || '', action, by: by || '' }) } })).catch(e => console.error('pinlog', e));
}
async function nextEmpNo(){
  const r = await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'COUNTER', sk: 'EMP' }, UpdateExpression: 'ADD n :one', ExpressionAttributeValues: { ':one': 1 }, ReturnValues: 'UPDATED_NEW' }));
  return String(1000 + r.Attributes.n);
}
async function ensureEmpId(p){                           // assigned once, never changes; existing logins get theirs the first time they are needed
  if(p.empId) return p.empId;
  const e = await nextEmpNo();
  try{ await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'USERS', sk: p.sk }, UpdateExpression: 'SET empId = :e', ConditionExpression: 'attribute_not_exists(empId)', ExpressionAttributeValues: { ':e': e } })); p.empId = e; return e; }
  catch(err){ if(!isCond(err)) throw err; const q = await profileOf(p.sk); p.empId = q.empId; return q.empId; }
}
// check the person's current PIN. Counts the try BEFORE comparing (atomically) so parallel guesses cannot exceed the limit.
async function verifyPin(me, given, forChange){
  const p = await profileOf(me.sk); if(!p) throw forbidden();
  const st = pinState(p);
  if(st === 'none'){ if(forChange) return p; throw pinErr('pin-not-set', 'You have not set your PIN yet. Choose one now.'); }
  if(st === 'locked') throw pinErr('pin-locked', 'Your PIN is locked after too many wrong tries. Ask the Account Owner for a temporary PIN.', 403);
  if(st === 'temp' && !forChange) throw pinErr('pin-temp', 'Your PIN is temporary. Choose your own PIN now.');
  const t = String(given == null ? '' : given).trim(); if(!/^\d{4}$/.test(t)) throw bad('Enter your 4-digit PIN.');
  const r = await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'USERS', sk: p.sk }, UpdateExpression: 'SET pin.fails = if_not_exists(pin.fails, :z) + :one',
    ConditionExpression: 'attribute_exists(pin) AND pin.locked = :f', ExpressionAttributeValues: { ':z': 0, ':one': 1, ':f': false }, ReturnValues: 'UPDATED_NEW' })).catch(e => { if(isCond(e)) throw pinErr('pin-locked', 'Your PIN is locked. Ask the Account Owner for a temporary PIN.', 403); throw e; });
  const fails = r.Attributes.pin.fails, a = Buffer.from(await pinHash(p.sk, t)), b = Buffer.from(p.pin.h);
  if(a.length === b.length && crypto.timingSafeEqual(a, b) && fails <= PIN_MAX_FAILS){
    await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'USERS', sk: p.sk }, UpdateExpression: 'SET pin.fails = :z', ExpressionAttributeValues: { ':z': 0 } }));
    return p;
  }
  await pinLog(p, 'Wrong PIN (' + fails + ' of ' + PIN_MAX_FAILS + ')', who(p));
  if(fails >= PIN_MAX_FAILS){
    await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'USERS', sk: p.sk }, UpdateExpression: 'SET pin.locked = :t', ExpressionAttributeValues: { ':t': true } }));
    await pinLog(p, 'PIN Locked', who(p));
    throw pinErr('pin-locked', 'Your PIN is now locked after 5 wrong tries. Ask the Account Owner for a temporary PIN.', 403);
  }
  throw bad(`Wrong PIN. ${PIN_MAX_FAILS - fails} ${PIN_MAX_FAILS - fails === 1 ? 'try' : 'tries'} left before it locks.`);
}
// sign an action: the person must have initials and a PIN; returns what is stored with the record
async function signAs(me, body, meaning){
  if(!me.initials) throw bad('Your initials are not set yet. Ask the Account Owner to set them.');
  if(!PIN_REQUIRED) return { ini: me.initials, emp: await ensureEmpId(me), meaning, at: now() };
  const p = await verifyPin(me, body.pin, false);
  return { ini: p.initials || me.initials, emp: await ensureEmpId(p), meaning, at: now() };
}
async function setMyPin(me, body){
  const p = await verifyPin(me, body.current, true), st = pinState(p), np = cleanNewPin(body.pin);
  if(st === 'temp' && String(body.current).trim() === np) throw bad('Choose a PIN different from the temporary one.');
  await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'USERS', sk: p.sk }, UpdateExpression: 'SET pin = :v',
    ExpressionAttributeValues: { ':v': { h: await pinHash(p.sk, np), temp: false, locked: false, fails: 0, setAt: now() } } }));
  await pinLog(p, st === 'none' ? 'PIN Set' : 'PIN Changed', who(p));
  return { ok: true, pin: 'set', empId: await ensureEmpId(p) };
}
async function resetPin(me, p){                          // a temporary PIN, handed to the person by the Account Owner or a host supervisor
  if(p.sk === me.sk) throw forbidden('Ask the Account Owner (or IronLedger) for a temporary PIN; you can change your own PIN if you know it.');
  if(me.host ? !isSupervisor(me) : !me.owner) throw forbidden('Only the Account Owner or an IronLedger supervisor can issue a temporary PIN.');
  if((p.owner || p.host) && !me.host) throw forbidden('IronLedger issues the temporary PIN for the Account Owner and host logins.');
  if(p.host && !isSupervisor(me)) throw forbidden();
  let t; do { t = String(crypto.randomInt(0, 10000)).padStart(4, '0'); } while(weakPin(t));
  await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'USERS', sk: p.sk }, UpdateExpression: 'SET pin = :v',
    ExpressionAttributeValues: { ':v': { h: await pinHash(p.sk, t), temp: true, locked: false, fails: 0, setAt: now(), issuedBy: who(me) } } }));
  await ensureEmpId(p); await pinLog(p, 'Temporary PIN Issued', who(me));
  return { ok: true, tempPin: t };
}
// initials (2 to 3 letters) stamp printed copies; unique across all logins so two people never share them
const cleanLicense = v => { v = String(v == null ? '' : v).trim().toUpperCase(); if(v && !/^[A-Z0-9-]{1,20}$/.test(v)) throw bad('A license number uses letters, digits and dashes only (up to 20).'); return v; };
const cleanInitials = v => { const t = String(v == null ? '' : v).trim().toUpperCase(); if(t === '') return ''; if(!/^[A-Z]{2,3}$/.test(t)) throw bad('Initials are 2 or 3 letters.'); return t; };
async function initialsTaken(ini, exceptSub){
  const all = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'USERS' } });
  return all.some(p => !p.deleted && p.sk !== exceptSub && (p.initials || '') === ini);
}
async function repGuard(p, seg3, body){
  if(p.host) throw forbidden('Host logins are managed by an IronLedger supervisor.');
  if(seg3 === 'reset-password') return;
  if(seg3) throw forbidden('A rep can’t do that. Ask an IronLedger supervisor.');
  const keys = Object.keys(body);
  if(!keys.length || keys.some(k => k !== 'perms')) throw forbidden('A rep can change privileges only. Ask an IronLedger supervisor for anything else.');
  if(p.owner) throw forbidden('The Account Owner always has full access.');
  if(!p.acctType) throw forbidden('A rep can change privileges only on a person who has an account type. Ask an IronLedger supervisor.');
  if(body.perms && (Object.prototype.hasOwnProperty.call(body.perms, 'calendar') || Object.prototype.hasOwnProperty.call(body.perms, 'documents'))) throw forbidden('The Calendar and Documents privileges are part of a service line and are set by an IronLedger supervisor.');
  const g = await idp.send(new AdminGetUserCommand({ UserPoolId: POOL, Username: p.login })).catch(() => null);
  if(g ? g.Enabled === false : !!p.disabled) throw forbidden('A rep can change privileges only on an active person (login not switched off). First sign-in does not matter.');
}
async function updatePerson(me, sub, seg3, body){
  if(!okId(sub)) throw bad('Bad user');
  const p = await profileOf(sub); if(!p) throw new HttpError(404, 'No such person.');
  // the host login belongs to IronLedger: the Account Owner sees it but only the host changes it
  // except which pharmacies it may open: only the Account Owner grants that
  // the Account Owner decides which pharmacies the host may open and what it may do there; nothing else about the host login
  if(p.host && !me.host && (seg3 || Object.keys(body).some(k => k !== 'stores' && k !== 'perms'))) throw forbidden('The host login is managed by IronLedger.');
  if(sub === me.sk && body.disabled === true) throw bad('You can’t switch off your own login.');
  if(me.host && me.hostRole === 'rep') await repGuard(p, seg3, body);
  if(seg3 === 'delete'){
    // the login is removed for good (the Login ID can be used again); what they did stays on the orders and archive by name.
    // A short record is kept of who existed and who removed them, with their SMS consent dates.
    if(p.owner) throw bad('The Account Owner can’t be deleted.');
    if(p.host) throw bad('The host login can’t be deleted here.');
    if(sub === me.sk) throw bad('You can’t delete your own login.');
    if(p.deleted) return { ok: true };
    await idp.send(new AdminUserGlobalSignOutCommand({ UserPoolId: POOL, Username: p.login })).catch(() => {});
    await idp.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: p.login })).catch(e => { if(e.name !== 'UserNotFoundException') throw e; });
    await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'USERS', sk: sub },
      UpdateExpression: 'SET deleted = :t, deletedAt = :n, deletedBy = :b, stores = :e, perms = :e, disabled = :t',
      ExpressionAttributeValues: { ':t': true, ':n': now(), ':b': who(me), ':e': {} } }));
    return { ok: true };
  }
  if(p.deleted) throw new HttpError(404, 'No such person.');
  if(seg3 === 'pin-reset') return await resetPin(me, p);
  if(seg3 === 'reset-password'){
    const pw = body.tempPassword ? String(body.tempPassword) : tempPassword();
    if(pw.length < 10 || !/[a-z]/.test(pw) || !/\d/.test(pw)) throw bad('Temporary password: at least 10 characters with a lowercase letter and a number.');
    await idp.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: p.login, Password: pw, Permanent: false }));
    await idp.send(new AdminUserGlobalSignOutCommand({ UserPoolId: POOL, Username: p.login })).catch(() => {});
    await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'USERS', sk: sub }, UpdateExpression: 'SET tempIssuedAt = :n', ExpressionAttributeValues: { ':n': now() } }));
    return { ok: true, tempPassword: pw };
  }
  // the Account Owner's own mobile is her second sign-in factor (Login ID + password + texted code), so only IronLedger changes it
  if(p.owner && !me.host && body.phone !== undefined) throw forbidden('The Account Owner’s own mobile number is changed by IronLedger. Contact IronLedger to update it.');
  // no per-person email exists today; if one is ever added, changing it for the Account Owner must also need the host
  if(body.email !== undefined) throw bad('People don’t have an email address in this app.');
  if(p.owner && (body.stores !== undefined || body.perms !== undefined || (body.disabled !== undefined && !me.host)))
    throw bad('The Account Owner always has full access.');
  if(p.host && me.host && (body.stores !== undefined || body.perms !== undefined)) throw bad('Only the Account Owner can give the host access to a pharmacy or privileges in it.');
  const upd = {};
  if(body.acctType !== undefined){ if(p.owner || p.host) throw bad('The Account Owner and host logins have their own account type.'); upd.acctType = cleanType(body.acctType); }
  if(body.docDuty !== undefined){ if(p.owner || p.host) throw bad('The Account Owner and host logins have their own document duty.'); const dd = String(body.docDuty || ''); if(dd !== '' && !DOC_DUTIES.includes(dd)) throw bad('Pick the document duty from the list.'); upd.docDuty = dd; }
  if(body.initials !== undefined){ const ini = cleanInitials(body.initials); if(ini && await initialsTaken(ini, sub)) throw bad('Those initials are already used by someone else.'); upd.initials = ini; }
  if(body.license !== undefined) upd.license = cleanLicense(body.license);
  if(body.repStores !== undefined){ if(!isSupervisor(me)) throw forbidden('A supervisor assigns reps to pharmacies.'); if(!(p.host && p.hostRole === 'rep')) throw bad('Only rep logins have assigned pharmacies.'); upd.repStores = Object.assign({}, p.repStores || {}, await cleanStoreToggles(body.repStores)); }
  if(body.stores !== undefined) upd.stores = Object.assign({}, p.stores || {}, await cleanStoreToggles(body.stores));
  if(body.perms !== undefined) upd.perms = Object.assign({}, p.perms || {}, cleanPerms(body.perms));
  if(body.name !== undefined){ upd.name = clean(body.name, 120) || '';
    if(upd.name) await idp.send(new AdminUpdateUserAttributesCommand({ UserPoolId: POOL, Username: p.login, UserAttributes: [{ Name: 'name', Value: upd.name }] })); }
  if(body.phone !== undefined){ upd.phone = phoneE164(body.phone);
    if(body.smsConsent !== true) throw bad('A new mobile number needs a newly signed SMS consent form.');
    upd.smsConsentAt = now(); upd.smsConsentRecordedBy = who(me);
    await idp.send(new AdminUpdateUserAttributesCommand({ UserPoolId: POOL, Username: p.login,
      UserAttributes: [{ Name: 'phone_number', Value: upd.phone }, { Name: 'phone_number_verified', Value: 'true' }] })); }
  if(body.disabled !== undefined){
    upd.disabled = !!body.disabled;
    await idp.send(new (upd.disabled ? AdminDisableUserCommand : AdminEnableUserCommand)({ UserPoolId: POOL, Username: p.login }));
    if(upd.disabled) await idp.send(new AdminUserGlobalSignOutCommand({ UserPoolId: POOL, Username: p.login })).catch(() => {});
  }
  if(Object.keys(upd).length){
    upd.updatedAt = now(); upd.updatedBy = who(me);
    const names = {}, vals = {}, parts = [];
    Object.entries(upd).forEach(([k, v], i) => { names['#f' + i] = k; vals[':v' + i] = v; parts.push(`#f${i} = :v${i}`); });
    await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'USERS', sk: sub }, UpdateExpression: 'SET ' + parts.join(', '), ExpressionAttributeNames: names, ExpressionAttributeValues: vals }));
  }
  return { ok: true };
}

// ---------- Account Owner tab lock: password again to open it; locks after 5 minutes without activity there
const UNLOCK_MS = 5 * 60 * 1000;
class Locked extends HttpError { constructor(){ super(423, 'The Account Owner tab is locked. Re-enter your password.'); this.locked = true; } }
const manages = me => !!(me.owner || me.host);         // the Account Owner, and the host (IronLedger)
async function requireUnlocked(me){
  if(!manages(me)) throw forbidden('Only the Account Owner can do that.');
  if(!(me.unlockUntil > Date.now())) throw new Locked();
  await setUnlock(me.sk, Date.now() + UNLOCK_MS);              // activity keeps it open
}
async function setUnlock(sub, until){
  await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'USERS', sk: sub }, UpdateExpression: 'SET unlockUntil = :u', ExpressionAttributeValues: { ':u': until } }));
}
// checks the password with Cognito without sending a text: "change" it to itself using the caller's own access token
async function unlock(me, claims, b){
  if(!manages(me)) throw forbidden('Only the Account Owner can do that.');
  const pw = typeof b.password === 'string' ? b.password : '', at = typeof b.accessToken === 'string' ? b.accessToken : '';
  if(!pw || !at) throw bad('Enter your password.');
  let tokSub = '';
  try{ tokSub = JSON.parse(Buffer.from(at.split('.')[1], 'base64url').toString()).sub; }catch(e){}
  if(tokSub !== claims.sub) throw new HttpError(401, 'Please sign in again.');      // must be this person's own session
  try{ await idp.send(new ChangePasswordCommand({ AccessToken: at, PreviousPassword: pw, ProposedPassword: pw })); }
  catch(e){
    // an expired/revoked session says "Access Token ..."; anything else refused here means the password was wrong
    if(e.name === 'NotAuthorizedException' && /token/i.test(e.message || '')) throw new HttpError(401, 'Please sign in again.');
    if(e.name === 'NotAuthorizedException') throw bad('That password isn’t right.');
    if(e.name === 'LimitExceededException' || e.name === 'TooManyRequestsException') throw bad('Too many tries. Wait a few minutes.');
    throw e;
  }
  await setUnlock(me.sk, Date.now() + UNLOCK_MS);
  return { ok: true, minutes: UNLOCK_MS / 60000 };
}


// ---------- compliance calendar (only pharmacies the Account Owner has switched Calendar on for)
// Kept as one MAIN item per piece: STORE#<id> / CAL#cfg#<key> (profile, sites, people, ...) and CAL#<records|events|obl|log>#<id>.
// Each item holds the calendar's own JSON as a string in `j`. Rules, all checked here and not only in the screen:
//   1. the person can open that pharmacy   2. the person has the Calendar privilege   3. the pharmacy has Calendar switched on
//   4. only the Account Owner can start a pharmacy's calendar (write its profile for the first time)
const CAL_COLLS = ['records', 'events', 'obl', 'log'];
const CAL_CFG = ['v', 'profile', 'sites', 'people', 'equipment', 'documents', 'tracks', 'plans', 'work', 'reminders', 'rooms'];
const CAL_MAX_BYTES = 380000, CAL_MAX_OPS = 100;
function calGate(me, storeItem){
  if(suiteStore(storeItem.sk)){ if(!suiteUser(me, storeItem.sk)) throw forbidden('The calendar is limited to the named users for this pharmacy.'); return; }
  if(storeItem.calendar !== true) throw forbidden('The calendar is not switched on for this pharmacy.');
  if(!permsOf(me).calendar) throw forbidden('You do not have the Calendar privilege. Ask the Account Owner.');
}
const calPk = store => 'STORE#' + store;
async function calLoad(store){
  const items = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p AND begins_with(sk, :c)', ExpressionAttributeValues: { ':p': calPk(store), ':c': 'CAL#' } });
  const out = { started: false, config: {}, records: [], events: [], obl: [], log: [] };
  for(const it of items){
    let v; try{ v = JSON.parse(it.j); }catch(e){ continue; }
    const [, kind, ...rest] = it.sk.split('#');
    if(kind === 'cfg'){ out.config[rest.join('#')] = v; if(rest[0] === 'profile') out.started = true; }
    else if(CAL_COLLS.includes(kind)) out[kind].push(v);
  }
  return out;
}
async function calCommit(store, me, b){
  const config = b.config && typeof b.config === 'object' ? b.config : {}, put = b.put || {}, del = b.del || {};
  const writes = [], deletes = [];
  for(const k of Object.keys(config)){ if(!CAL_CFG.includes(k)) throw bad('Unknown calendar setting: ' + k); writes.push({ sk: 'CAL#cfg#' + k, v: config[k] }); }
  for(const c of Object.keys(put)){
    if(!CAL_COLLS.includes(c)) throw bad('Unknown calendar list: ' + c);
    if(!Array.isArray(put[c])) throw bad('Bad calendar list.');
    for(const o of put[c]){ if(!o || typeof o !== 'object' || !okId(o.id)) throw bad('Every calendar item needs an id.'); writes.push({ sk: `CAL#${c}#${o.id}`, v: o }); }
  }
  for(const c of Object.keys(del)){
    if(!CAL_COLLS.includes(c)) throw bad('Unknown calendar list: ' + c);
    if(c === 'log') throw forbidden('The activity log is add-only.');
    if(!Array.isArray(del[c])) throw bad('Bad calendar list.');
    for(const id of del[c]){ if(!okId(id)) throw bad('Bad calendar id.'); deletes.push(`CAL#${c}#${id}`); }
  }
  if(writes.length + deletes.length > CAL_MAX_OPS) throw bad('Too many calendar changes in one request.');
  if(!writes.length && !deletes.length) return { ok: true, saved: 0 };
  if(!me.owner && !suiteStore(store)){                 // only the Account Owner starts a pharmacy's calendar (on the named-user list, any named user may)
    const started = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: calPk(store), sk: 'CAL#cfg#profile' } }));
    if(!started.Item) throw forbidden('Only the Account Owner can start this pharmacy’s calendar.');
  }
  const stamp = now();
  await inBatches(writes, 25, async w => {
    const j = JSON.stringify(w.v === undefined ? null : w.v);
    if(Buffer.byteLength(j) > CAL_MAX_BYTES) throw bad('One calendar item is too large to save (' + w.sk.split('#').slice(1, 3).join(' ') + ').');
    await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: calPk(store), sk: w.sk, j, updatedAt: stamp, updatedBy: who(me) } }));
  });
  await inBatches(deletes, 25, sk => ddb.send(new DeleteCommand({ TableName: MAIN, Key: { pk: calPk(store), sk } })));
  return { ok: true, saved: writes.length, removed: deletes.length };
}
// ---------- documents (a pharmacy's own compliance document library; only pharmacies with Documents switched on, only people with the Documents privilege)
// MAIN items under STORE#<id>:  DOC#<docId> {j: the document as JSON, rev}   DOCSEQ#<TYPE>-<AREA> {n}   DOCPIN#<sub> {j: {ids}}   DOCLOG#<iso>#<rand> {j: event}
// PDF files live in a private S3 bucket (DOCS_BUCKET) under <store>/files/<random>.pdf. The browser never gets a bucket address: it gets a short-lived link per file.
// What a person may do is decided here, from who they are, not from the screen: Owner (Account Owner), Pharmacist-In-Charge (account type PIC), Designated Person and
// Compliance Technician (set per person), everyone else Staff.
const DOCS_BUCKET = process.env.DOCS_BUCKET || '';
const DOC_MAX_BYTES = 25 * 1024 * 1024, DOC_LINK_SECONDS = 300;
const DOC_AREAS = ['OPS', 'CSA', 'NSC', 'STC', 'HDR', 'IMM', 'HIP', 'OSH', 'QMS', 'PER', 'REG', 'FAC'];
const DOC_CMPA = ['NSC', 'STC', 'HDR'];
const DOC_TYPES = { POL: null, SOP: null, FRM: null, MFR: 'cmp', CMP: 'cmp', LOG: null, CHK: null,
  TRN: ['Orientation', 'Competency_Assessments', 'Training_Materials'], PAT: ['Notices', 'Counseling_Handouts', 'Immunization'],
  REF: ['Regulatory_Rules', 'Safety_Data_Sheets', 'Manufacturer_and_Vendor', 'Accreditation'], TMP: ['Letterhead', 'General'] };
const DOC_FORMATS = ['Fillable PDF', 'Printable PDF'];
const DOC_DUTIES = ['pic', 'dp', 'ctech', 'staff'];                    // the Account Owner is 'owner'
const DOC_MANAGE = ['owner', 'pic', 'dp', 'ctech'], DOC_APPROVE = ['owner', 'pic', 'dp'];
const docDuty = me => me.owner ? 'owner' : (DOC_DUTIES.includes(me.docDuty) ? me.docDuty : (me.acctType === 'pic' ? 'pic' : 'staff'));
const docPk = store => 'STORE#' + store;
let s3c = null;
const s3 = () => s3c || (s3c = new S3Client({ forcePathStyle: !!process.env.AWS_ENDPOINT_URL, ...(process.env.AWS_ENDPOINT_URL ? { endpoint: process.env.AWS_ENDPOINT_URL } : {}) }));
function docGate(me, storeItem){
  if(suiteStore(storeItem.sk)){ if(!suiteUser(me, storeItem.sk)) throw forbidden('Documents is limited to the named users for this pharmacy.'); if(!DOCS_BUCKET) throw new HttpError(503, 'Document storage is not set up yet. Run deploy.sh again.'); return; }
  if(storeItem.documents !== true) throw forbidden('Documents is not switched on for this pharmacy.');
  if(!permsOf(me).documents) throw forbidden('You do not have the Documents privilege. Ask the Account Owner.');
  if(!DOCS_BUCKET) throw new HttpError(503, 'Document storage is not set up yet. Run deploy.sh again.');
}
function todayIn(tz){ try{ return new Intl.DateTimeFormat('en-CA', { timeZone: tz || DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }catch(e){ return now().slice(0, 10); } }
// ---- SigV4 query-string signing for S3 (no extra library; checked against the official presigner in dev/docs_test)
const sha256 = d => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export function presignS3({ method, bucket, key, expires = DOC_LINK_SECONDS, query = {}, headers = {}, at = new Date(), creds, region, endpoint }){
  creds = creds || { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY, token: process.env.AWS_SESSION_TOKEN };
  region = region || process.env.AWS_REGION || 'us-east-1'; endpoint = endpoint === undefined ? (process.env.DOCS_S3_ENDPOINT || process.env.AWS_ENDPOINT_URL || '') : endpoint;
  const amz = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''), day = amz.slice(0, 8), scope = `${day}/${region}/s3/aws4_request`;
  let base, host, path;
  const encKey = key.split('/').map(enc).join('/');
  if(endpoint){ const u = new URL(endpoint); host = u.host; path = (u.pathname.replace(/\/$/, '')) + '/' + bucket + '/' + encKey; base = u.origin; }
  else { host = `${bucket}.s3.${region}.amazonaws.com`; path = '/' + encKey; base = 'https://' + host; }
  const hdr = Object.assign({ host }, Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])));
  const names = Object.keys(hdr).sort();
  const q = Object.assign({ 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${creds.id}/${scope}`, 'X-Amz-Date': amz, 'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': names.join(';') },
    creds.token ? { 'X-Amz-Security-Token': creds.token } : {}, query);
  const cq = Object.keys(q).sort().map(k => enc(k) + '=' + enc(q[k])).join('&');
  const canon = [method, path, cq, names.map(n => n + ':' + hdr[n] + '\n').join(''), names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = ['AWS4-HMAC-SHA256', amz, scope, sha256(canon)].join('\n');
  const kd = hmac(hmac(hmac(hmac('AWS4' + creds.secret, day), region), 's3'), 'aws4_request');
  return base + path + '?' + cq + '&X-Amz-Signature=' + crypto.createHmac('sha256', kd).update(sts).digest('hex');
}
async function docIo(store, key){                                    // checks an uploaded file is really there, ours, a PDF and not too big
  if(typeof key !== 'string' || !key.startsWith(store + '/files/') || !/^[A-Za-z0-9_\/.-]{10,120}\.pdf$/.test(key) || key.includes('..')) throw bad('That file was not uploaded here. Choose the PDF again.');
  let h; try{ h = await s3().send(new HeadObjectCommand({ Bucket: DOCS_BUCKET, Key: key })); }catch(e){ throw bad('The file did not finish uploading. Choose the PDF again.'); }
  if(!(h.ContentLength > 0) || h.ContentLength > DOC_MAX_BYTES) throw bad('The PDF must be under 25 MB.');
  const g = await s3().send(new GetObjectCommand({ Bucket: DOCS_BUCKET, Key: key, Range: 'bytes=0-4' }));
  const head = Buffer.from(await g.Body.transformToByteArray()).toString('latin1');
  if(head !== '%PDF-') throw bad('That file is not a PDF.');
  return { size: h.ContentLength };
}
async function docLoadAll(store){
  const items = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': docPk(store), ':s': 'DOC#' } });
  return items.map(it => { try{ return { ...JSON.parse(it.j), rev: it.rev || 0 }; }catch(e){ return null; } }).filter(Boolean);
}
async function docGetOne(store, id){
  if(!/^[A-Z]{3}-[A-Z]{3}-\d{3,}$/.test(String(id))) throw bad('Bad document ID.');
  const r = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: docPk(store), sk: 'DOC#' + id } }));
  if(!r.Item) throw new HttpError(404, 'No such document.');
  return { ...JSON.parse(r.Item.j), rev: r.Item.rev || 0 };
}
async function docPut(store, d, isNew){
  const { rev, ...rest } = d;
  try{ await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: docPk(store), sk: 'DOC#' + d.id, j: JSON.stringify(rest), rev: (rev || 0) + 1, updatedAt: now() },
    ConditionExpression: isNew ? 'attribute_not_exists(pk)' : 'rev = :r', ...(isNew ? {} : { ExpressionAttributeValues: { ':r': rev || 0 } }) })); }
  catch(e){ if(isCond(e)) throw new HttpError(409, 'Someone else just changed this document. Reload and try again.'); throw e; }
}
async function docLog(store, me, action, docId, detail, flag, sig){
  const at = now(), j = JSON.stringify({ at, by: who(me), login: me.login || '', duty: docDuty(me), action, docId: docId || '', detail: String(detail || '').slice(0, 500), flag: flag || '', ...(sig ? { ini: sig.ini, emp: sig.emp } : {}) });
  await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: docPk(store), sk: `DOCLOG#${at}#${crypto.randomBytes(3).toString('hex')}`, j } }));
}
const docCur = d => (d.versions || []).find(v => v.state === 'current'), docPend = d => (d.versions || []).find(v => v.state === 'pending');
function docStatus(d){ return d.retired ? 'Retired' : docCur(d) ? (d.underReview ? 'Under Review' : 'Active') : 'Draft'; }
function docView(d, duty){                                            // what each duty may see
  const m = DOC_MANAGE.includes(duty), a = DOC_APPROVE.includes(duty), st = docStatus(d);
  if(!m){
    if(st === 'Draft' || st === 'Retired') return null;
    const c = docCur(d);
    return { id: d.id, title: d.title, type: d.type, area: d.area, sub: d.sub || '', format: d.format, versions: [{ v: c.v, state: 'current', effective: c.effective, at: c.at, hasFile: !!c.file }], retired: false, underReview: false, cycle: 0, lastReviewed: '', reviews: [], basis: '', notes: '', rev: d.rev };
  }
  const o = { id: d.id, title: d.title, type: d.type, area: d.area, sub: d.sub || '', format: d.format, cycle: d.cycle || 0, basis: d.basis || '', notes: d.notes || '', underReview: !!d.underReview, retired: !!d.retired, rev: d.rev,
    versions: (d.versions || []).map(v => ({ v: v.v, state: v.state, effective: v.effective || '', at: v.at || '', summary: v.summary || '', by: v.by || '', approvedBy: v.approvedBy || '', approvedIni: v.approvedIni || '', selfApproved: !!v.selfApproved, fileName: v.file ? v.file.name : '', hasFile: !!v.file })) };
  if(a){ o.lastReviewed = d.lastReviewed || ''; o.reviews = (d.reviews || []).map(r => ({ at: r.at, by: r.by, ini: r.ini || '', outcome: r.outcome, comment: r.comment })); } else { o.lastReviewed = ''; o.reviews = []; }
  return o;
}
function cleanVersion(v){ v = String(v == null ? '' : v).trim(); if(!/^\d{1,3}\.\d{1,3}$/.test(v)) throw bad('Version must look like 1.0.'); return v; }
function cleanDocDate(v, what, { notFuture = false, max = null } = {}, today){
  v = String(v || ''); if(!DATE.test(v) || isNaN(Date.parse(v))) throw bad(what + ': use the date picker.');
  if(notFuture && v > today) throw bad(what + ' cannot be in the future.');
  if(max && v > max) throw bad(what + ' is too far ahead.');
  return v;
}
const addMonthsIso = (s, n) => { const [y, m, d] = s.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1 + n, 1)); const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate(); dt.setUTCDate(Math.min(d, last)); return dt.toISOString().slice(0, 10); };
// ---------- Rx Intake (suite tab): same named-user list as Calendar and Documents. The page itself runs only in the browser: patient fields, Rx data
// and PDFs never reach this server. The server keeps only (1) the pharmacy's shared directory of pharmacies and prescribers, (2) nothing about people (the receiving pharmacist and PIC come from login records), and (3) a lookup relay for the NPI Registry and the Census address service, which web pages cannot call directly (GET, https, four fixed addresses).
const RX_ALLOW = ['https://npiregistry.cms.hhs.gov/api/', 'https://geocoding.geo.census.gov/geocoder/', 'https://clinicaltables.nlm.nih.gov/api/', 'https://rxnav.nlm.nih.gov/REST/'];
const RX_FIELDS = { ph: ['name', 'addr', 'city', 'state', 'zip', 'phone', 'fax', 'license', 'npi', 'dea'], pr: ['name', 'last', 'first', 'cred', 'addr', 'city', 'state', 'zip', 'phone', 'fax', 'license', 'npi', 'dea'] };
// Only a pharmacist (job type on the login: Staff Pharmacist or Pharmacist-In-Charge; the Account Owner counts as PIC) can take or receive a prescription, so Rx Intake is hidden from everyone else.
const rxPharmacist = me => !me.host && (!!me.owner || me.acctType === 'pharmacist' || me.acctType === 'pic');
function rxGate(me, storeItem){ if(!suiteStore(storeItem.sk) || !suiteUser(me, storeItem.sk)) throw forbidden('Rx Intake is limited to the named users for this pharmacy.'); if(!rxPharmacist(me)) throw forbidden('Only a pharmacist can use Rx Intake.'); }
function rxCleanRec(kind, r){
  if(!r || typeof r !== 'object') throw bad('Bad record.');
  const o = {};
  for(const f of RX_FIELDS[kind]){ let v = r[f]; if(v === undefined || v === null) v = ''; v = String(v).trim().slice(0, f === 'addr' || f === 'name' || f === 'cred' ? 160 : 60); if(f === 'phone' || f === 'fax') v = v.replace(/\D/g, '').slice(0, 11); o[f] = v; }
  if(!o.name) throw bad('A saved record needs a name.');
  let id = String(r._id || '').trim(); if(!/^[A-Za-z0-9_-]{1,40}$/.test(id)) id = '';
  if(/^\d{10}$/.test(o.npi)) id = 'npi_' + o.npi; else if(!id) id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  o._id = id; return o;
}
// Receiving pharmacist = the signed-in person (name and RPh license from their login record); PIC = the pharmacy's Pharmacist-In-Charge (account type PIC;
// otherwise the Account Owner). Nothing here is typed on the form, and neither can be changed from it. When the PIC is the one signed in, both show the same person.
const RX_NAME = p => String(p.name || p.login || '').trim().toUpperCase();
async function rxLoad(store, storeItem, me){
  const items = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'RXDIR#' + store } });
  const ph = [], pr = [];
  for(const it of items){ const { pk, sk, ...rec } = it; (sk.startsWith('PH#') ? ph : pr).push(rec); }
  const people = (await listPeople()).filter(p => !p.host && (p.owner || (p.stores || {})[store] === true));
  const isRph = p => p.acctType === 'pharmacist' || p.acctType === 'pic' || p.owner;
  const me2 = people.find(p => p.sub === me.sk) || {};
  const receiving = isRph(me2) && me2.license ? { name: RX_NAME(me2), license: me2.license } : null;
  const picP = people.find(p => p.acctType === 'pic' && p.license) || people.find(p => p.owner && p.license) || null;
  const pic = picP ? { name: RX_NAME(picP), license: picP.license } : null;
  const notes = []; if(!receiving) notes.push(isRph(me2) ? 'Your RPh license number is not set. Ask the Account Owner to add it to your login.' : 'Only a pharmacist can take or receive a prescription. Your login is not set up as a pharmacist.'); if(!pic) notes.push('The Pharmacist-In-Charge name and license number are not set. Ask the Account Owner.');
  const s = storeItem;
  return { pharmacy: { name: s.name || '', address: s.address || '', suite: s.suite || '', city: s.city || '', state: s.state || '', zip: s.zip || '', phone: s.phone || '', fax: s.fax || '', license: s.license || '', dea: s.dea || '', npi: s.npi || '' }, receiving, pic, notes, dir: { ph, pr } };
}
async function rxLookup(url){
  let u; try { u = new URL(String(url || '')); } catch(e){ throw bad('Bad address.'); }
  if(u.protocol !== 'https:' || u.username || u.password || u.port) throw bad('That address is not allowed.');
  const base = u.origin + u.pathname;
  if(!RX_ALLOW.some(a => base.startsWith(a))) throw bad('That address is not allowed.');
  let r; try { r = await fetch(u.href, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(9000), headers: { accept: 'application/json' } }); } catch(e){ throw new HttpError(502, 'The lookup service did not answer.'); }
  if(r.status >= 300 && r.status < 400) throw new HttpError(502, 'The lookup service redirected; refused.');
  if(!r.ok) throw new HttpError(502, 'The lookup service answered with an error (' + r.status + ').');
  const t = await r.text(); if(t.length > 1500000) throw new HttpError(502, 'The lookup answer was too large.');
  try { return { data: JSON.parse(t) }; } catch(e){ throw new HttpError(502, 'The lookup service sent something unreadable.'); }
}
async function rxRoute(method, store, seg, body, me, storeItem){
  rxGate(me, storeItem);
  if(method === 'GET' && seg[0] === 'config' && !seg[1]) return await rxLoad(store, storeItem, me);
  if(method === 'POST' && seg[0] === 'lookup' && !seg[1]) return await rxLookup(body.url);
  if(method === 'POST' && seg[0] === 'dir' && seg[1] === 'save'){
    const kind = body.kind === 'pr' ? 'pr' : body.kind === 'ph' ? 'ph' : ''; if(!kind) throw bad('Bad kind.');
    const o = rxCleanRec(kind, body.rec); o.updatedAt = now();
    await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: 'RXDIR#' + store, sk: kind.toUpperCase() + '#' + o._id, ...o, by: who(me) } }));
    return { rec: o };
  }
  if(method === 'POST' && seg[0] === 'dir' && seg[1] === 'delete'){
    const kind = body.kind === 'pr' ? 'pr' : body.kind === 'ph' ? 'ph' : ''; const id = String(body.id || ''); if(!kind || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw bad('Bad request.');
    await ddb.send(new DeleteCommand({ TableName: MAIN, Key: { pk: 'RXDIR#' + store, sk: kind.toUpperCase() + '#' + id } }));
    return { ok: true };
  }
  if(method === 'POST' && seg[0] === 'dir' && seg[1] === 'import'){
    const out = { ph: 0, pr: 0 };
    for(const kind of ['ph', 'pr']){
      const arr = Array.isArray(body[kind]) ? body[kind].slice(0, 3000) : [];
      const recs = []; for(const r of arr){ try { recs.push(rxCleanRec(kind, r)); } catch(e){} }
      for(let i = 0; i < recs.length; i += 25) await Promise.all(recs.slice(i, i + 25).map(o => ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: 'RXDIR#' + store, sk: kind.toUpperCase() + '#' + o._id, ...o, updatedAt: now(), by: who(me) } }))));
      out[kind] = recs.length;
    }
    return out;
  }
  throw new HttpError(404, 'Not found');
}
async function docsRoute(method, store, seg, q, body, me, storeItem){
  docGate(me, storeItem);
  const duty = docDuty(me), m = DOC_MANAGE.includes(duty), a = DOC_APPROVE.includes(duty), today = todayIn(storeItem.timezone);
  const needM = what => { if(!m) throw forbidden(`Your role cannot ${what}.`); }, needA = what => { if(!a) throw forbidden(`Only the Owner, Pharmacist-In-Charge or Designated Person can ${what}.`); };
  const id = seg[0];
  if(method === 'GET' && !id){
    const docs = (await docLoadAll(store)).map(d => docView(d, duty)).filter(Boolean).sort((x, y) => x.id.localeCompare(y.id));
    const pin = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: docPk(store), sk: 'DOCPIN#' + me.sk } }));
    let pins = []; try{ pins = pin.Item ? JSON.parse(pin.Item.j).ids || [] : []; }catch(e){}
    const out = { duty, today, docs, pins: pins.filter(p => docs.some(d => d.id === p)), maxMb: DOC_MAX_BYTES / 1048576, pharmacy: storeItem.name || '' };
    if(a){ const ev = (await ddb.send(new QueryCommand({ TableName: MAIN, KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': docPk(store), ':s': 'DOCLOG#' }, ScanIndexForward: false, Limit: 300 }))).Items || [];
      out.log = ev.map(e => { try{ return JSON.parse(e.j); }catch(x){ return null; } }).filter(Boolean); }
    return out;
  }
  if(method === 'POST' && id === 'upload-url'){
    needM('upload documents');
    const name = String(body.name || ''), size = Number(body.size);
    if(!/\.pdf$/i.test(name)) throw bad('Only PDF files are accepted.');
    if(!(size > 0) || size > DOC_MAX_BYTES) throw bad('The PDF must be under 25 MB.');
    const key = `${store}/files/${crypto.randomBytes(16).toString('hex')}.pdf`;
    return { key, url: presignS3({ method: 'PUT', bucket: DOCS_BUCKET, key, headers: { 'content-type': 'application/pdf' } }), headers: { 'content-type': 'application/pdf' } };
  }
  if(method === 'POST' && id === 'pins'){
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter(x => /^[A-Z]{3}-[A-Z]{3}-\d{3,}$/.test(String(x))))].slice(0, 100) : [];
    await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: docPk(store), sk: 'DOCPIN#' + me.sk, j: JSON.stringify({ ids }) } }));
    return { ok: true };
  }
  if(method === 'POST' && !id){                                       // add a document (starts as a draft: its first version waits for approval)
    needM('add documents');
    const title = String(body.title || '').trim().slice(0, 200); if(!title) throw bad('Enter a title.');
    const type = String(body.type || ''); if(!(type in DOC_TYPES)) throw bad('Pick the document type from the list.');
    const area = String(body.area || ''); if(!DOC_AREAS.includes(area)) throw bad('Pick the program area from the list.');
    if(DOC_TYPES[type] === 'cmp' && !DOC_CMPA.includes(area)) throw bad('That type is only for compounding program areas.');
    const subs = Array.isArray(DOC_TYPES[type]) ? DOC_TYPES[type] : null, sub = subs ? String(body.sub || subs[0]) : '';
    if(subs && !subs.includes(sub)) throw bad('Pick the folder from the list.');
    const format = String(body.format || ''); if(!DOC_FORMATS.includes(format)) throw bad('Pick the format from the list.');
    const cycle = body.cycle === undefined || body.cycle === '' ? 12 : parseInt(body.cycle, 10); if(!(cycle >= 0 && cycle <= 120)) throw bad('Review cycle: 0 to 120 months.');
    const version = cleanVersion(body.version || '1.0');
    const f = body.file && typeof body.file === 'object' ? body.file : null; if(!f) throw bad('Choose the PDF file.');
    const { size } = await docIo(store, f.key);
    const seq = await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: docPk(store), sk: `DOCSEQ#${type}-${area}` }, UpdateExpression: 'ADD n :one', ExpressionAttributeValues: { ':one': 1 }, ReturnValues: 'UPDATED_NEW' }));
    const docId = `${type}-${area}-${String(seq.Attributes.n).padStart(3, '0')}`;
    const d = { id: docId, title, type, area, sub, format, cycle, basis: String(body.basis || '').trim().slice(0, 200) || 'Internal Policy', notes: String(body.notes || '').trim().slice(0, 1000), underReview: false, retired: false, lastReviewed: '', reviews: [],
      versions: [{ v: version, state: 'pending', summary: 'Initial Draft', by: who(me), byLogin: me.login || '', at: today, file: { key: f.key, name: String(f.name || 'document.pdf').slice(0, 160), size } }] };
    await docPut(store, d, true); await docLog(store, me, 'Document Added', docId, title + ' (Draft)');
    return { ok: true, id: docId };
  }
  if(!id) throw new HttpError(404, 'Not found');
  const act = seg[1] || '';
  if(method === 'GET' && act === 'file'){                              // a short-lived link to the PDF
    const d = await docGetOne(store, id), st = docStatus(d);
    let v = docCur(d);
    if(m && q.v) v = (d.versions || []).find(x => x.v === String(q.v));
    else if(m && !v) v = docPend(d);
    if(!m && (st === 'Draft' || st === 'Retired')) throw new HttpError(404, 'No such document.');
    if(!v || !v.file) throw new HttpError(404, 'That version has no file.');
    if(!m && v.state !== 'current') throw forbidden();
    const fn = `${d.id}_v${v.v}_${String(d.title || 'Document').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}.pdf`.slice(0, 160);
    let print = null;
    if(q.print === '1'){                                                   // a stamped print copy: needs the person's initials; the time is the server's
      if(v.state !== 'current') throw bad('Only the current version can be printed with a stamp.');
      if(!me.initials) throw bad('Your initials are not set yet. Ask the Account Owner to set them.');
      print = { printedAt: now(), initials: me.initials };
      await docLog(store, me, 'Print Copy', d.id, 'v' + v.v + ' printed as ' + me.initials);
    }
    return { ...(print || {}), url: presignS3({ method: 'GET', bucket: DOCS_BUCKET, key: v.file.key, query: { 'response-content-type': 'application/pdf', 'response-content-disposition': `inline; filename="${fn}"` } }), name: v.file.name, seconds: DOC_LINK_SECONDS, id: d.id, v: v.v };
  }
  if(method !== 'POST') throw new HttpError(404, 'Not found');
  const d = await docGetOne(store, id), st = docStatus(d), pend = docPend(d), cur = docCur(d);
  const reason = () => { const w = String(body.reason || '').trim().slice(0, 500); if(!w) throw bad('Enter a reason.'); return w; };
  if(act === 'version'){
    needM('upload versions');
    if(d.retired || !cur) throw bad('Only an Active document can get a new version.');
    if(pend) throw bad('A version is already waiting for approval.');
    const v = cleanVersion(body.version), sum = String(body.summary || '').trim().slice(0, 300);
    if((d.versions || []).some(x => x.v === v)) throw bad('That version number already exists.');
    if(!sum) throw bad('Enter a change summary.');
    const f = body.file && typeof body.file === 'object' ? body.file : null; if(!f) throw bad('Choose the PDF file.');
    const { size } = await docIo(store, f.key);
    d.versions.push({ v, state: 'pending', summary: sum, by: who(me), byLogin: me.login || '', at: today, file: { key: f.key, name: String(f.name || 'document.pdf').slice(0, 160), size } });
    await docPut(store, d); await docLog(store, me, 'Version Submitted', id, 'v' + v + ' ' + sum);
    return { ok: true };
  }
  if(act === 'approve'){
    needA('approve versions'); if(!pend) throw bad('Nothing is waiting for approval.');
    const eff = cleanDocDate(body.effective, 'Effective date', { max: addMonthsIso(today, 12) }, today), self = (pend.byLogin || '') === (me.login || '') && !!pend.byLogin;
    const sig = await signAs(me, body, 'Approved');
    if(cur) cur.state = 'superseded';
    pend.state = 'current'; pend.effective = eff; pend.approvedBy = who(me); pend.approvedByLogin = me.login || ''; pend.approvedIni = sig.ini; pend.sig = sig; if(self) pend.selfApproved = true;
    d.underReview = false; d.retired = false; d.lastReviewed = eff <= today ? eff : today;
    d.reviews = (d.reviews || []).concat([{ at: d.lastReviewed, by: who(me), ini: sig.ini, outcome: 'Revised And Approved', comment: ('v' + pend.v + ': ' + (pend.summary || '')).slice(0, 300) }]);
    await docPut(store, d); await docLog(store, me, 'Version Approved', id, 'v' + pend.v + ' effective ' + eff, self ? 'Self-Approved' : '', sig);
    return { ok: true };
  }
  if(act === 'reject'){
    needA('reject versions'); if(!pend) throw bad('Nothing is waiting for approval.'); const w = reason(); const sig = await signAs(me, body, 'Rejected');
    d.versions = d.versions.filter(x => x !== pend);
    if(!d.versions.length) await ddb.send(new DeleteCommand({ TableName: MAIN, Key: { pk: docPk(store), sk: 'DOC#' + id } })); else await docPut(store, d);
    await docLog(store, me, 'Version Rejected', id, 'v' + pend.v + '. ' + w, '', sig);
    return { ok: true, removed: !d.versions.length };
  }
  if(act === 'review'){
    needA('mark documents reviewed'); if(st !== 'Active' && st !== 'Under Review') throw bad('Only Active documents can be reviewed.');
    const out = body.outcome === 'chg' ? 'chg' : 'ok', date = cleanDocDate(body.date, 'Review date', { notFuture: true }, today), com = String(body.comment || '').trim().slice(0, 500);
    if(out === 'chg' && !com) throw bad('Say what needs to change.');
    const sig = await signAs(me, body, 'Reviewed');
    d.lastReviewed = date; d.reviews = (d.reviews || []).concat([{ at: date, by: who(me), ini: sig.ini, sig, outcome: out === 'ok' ? 'Reviewed, No Changes' : 'Reviewed, Changes Needed', comment: com }]);
    if(out === 'chg') d.underReview = true;
    await docPut(store, d); await docLog(store, me, 'Reviewed', id, out === 'ok' ? 'Reviewed, No Changes' : 'Reviewed, Changes Needed. ' + com, '', sig);
    return { ok: true };
  }
  if(act === 'retire'){ needA('retire documents'); if(!cur) throw bad('A draft cannot be retired. Reject it instead.'); const w = reason(); const sig = await signAs(me, body, 'Retired'); d.retired = true; await docPut(store, d); await docLog(store, me, 'Retired', id, w, '', sig); return { ok: true }; }
  if(act === 'restore'){ needA('restore documents'); if(!d.retired) throw bad('That document is not retired.'); const sig = await signAs(me, body, 'Restored'); d.retired = false; await docPut(store, d); await docLog(store, me, 'Restored', id, '', '', sig); return { ok: true }; }
  if(act === 'edit'){
    needM('edit details');
    const t = String(body.title === undefined ? d.title : body.title).trim().slice(0, 200); if(!t) throw bad('Title is required.');
    const cy = body.cycle === undefined ? d.cycle : parseInt(body.cycle, 10); if(!(cy >= 0 && cy <= 120)) throw bad('Review cycle: 0 to 120 months.');
    const ch = []; if(t !== d.title) ch.push('title'); if(cy !== d.cycle) ch.push('review cycle ' + d.cycle + ' to ' + cy);
    d.title = t; d.cycle = cy;
    if(body.basis !== undefined) d.basis = String(body.basis).trim().slice(0, 200);
    if(body.notes !== undefined) d.notes = String(body.notes).trim().slice(0, 1000);
    await docPut(store, d); await docLog(store, me, 'Details Edited', id, ch.join(', ') || 'minor fields');
    return { ok: true };
  }
  throw new HttpError(404, 'Not found');
}
// ---------- router
async function route(method, path, q, body, me, claims){
  const seg = path.split('/').filter(Boolean);
  if(seg[0] === 'api') seg.shift();                    // works with or without an /api prefix

  if(method === 'GET' && seg[0] === 'me' && seg.length === 1)
    return { name: me.name || '', login: me.login, owner: !!me.owner, host: !!me.host, hostRole: me.host ? (me.hostRole === 'rep' ? 'rep' : 'supervisor') : '', repStores: me.host ? (me.repStores || {}) : {}, acctType: me.acctType || '', docDuty: docDuty(me), initials: me.initials || '', license: me.license || '', empId: await ensureEmpId(me), pin: pinState(me), pinRequired: PIN_REQUIRED, perms: effPerms(me), stores: await storesFor(me) };

  if(method === 'POST' && seg[0] === 'me' && seg[1] === 'pin' && seg.length === 2) return await setMyPin(me, body);

  if(seg[0] === 'stores' && seg[1]){
    const store = seg[1];
    if(!okId(store)) throw bad('Bad store');
    if(!canUse(me, store)) throw forbidden();
    const exists = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'STORES', sk: store } }));
    if(!exists.Item) throw new HttpError(404, 'No such store.');
    const what = seg[2];
    if(what === 'documents') return await docsRoute(method, store, seg.slice(3), q, body, me, exists.Item);
    if(what === 'rx') return await rxRoute(method, store, seg.slice(3), body, me, exists.Item);
    if(what === 'calendar'){
      calGate(me, exists.Item);
      if(method === 'GET' && !seg[3]) return await calLoad(store);
      if(method === 'POST' && seg[3] === 'commit') return await calCommit(store, me, body);
      throw new HttpError(404, 'Not found');
    }
    if(method === 'GET' && what === 'lines') return { lines: await lines(store) };
    if(method === 'GET' && what === 'memory') return { memory: await memory(store) };
    if(method === 'GET' && what === 'archive'){ need(me, 'archive', 'view the archive'); return await archivePage(store, q); }
    if(method === 'POST' && what === 'commit') return await commit(store, me, body);
    if(method === 'GET' && what === 'export'){            // full copy for an independent backup
      need(me, 'export', 'download backups');
      const arch = []; let cursor;
      do { const p = await archivePage(store, { cursor, limit: 2000 }); arch.push(...p.items); cursor = p.cursor; } while(cursor);
      return { meta: { pharmacy: exists.Item.name, store, exportedAt: now(), version: 3 }, reorder: await lines(store), archive: arch, remember: await memory(store) };
    }
    if(method === 'POST' && what === 'import'){ if(!me.owner) throw forbidden('Only the Account Owner can import.'); await requireUnlocked(me); return await importData(store, body); }
  }

  // two separate gates: /owner/* answers only the Account Owner, /host/* answers only the host (and is a 404 to everyone else)
  if(seg[0] === 'host-unlock' || seg[0] === 'host-lock' || seg[0] === 'host'){
    if(!me.host) throw new HttpError(404, 'Not found');
    seg[0] = seg[0].replace('host', 'owner');
  } else if(seg[0] === 'owner-unlock' || seg[0] === 'owner-lock' || seg[0] === 'owner'){
    if(!me.owner) throw forbidden('Only the Account Owner can do that.');
  }
  if(method === 'POST' && seg[0] === 'owner-unlock') return await unlock(me, claims, body);
  if(method === 'POST' && seg[0] === 'owner-lock'){ await setUnlock(me.sk, 0); return { ok: true }; }
  if(seg[0] === 'owner'){
    await requireUnlocked(me);
    if(method === 'POST' && seg[1] === 'keepalive') return { ok: true };
    // an IronLedger rep can help with passwords and privileges, but pharmacy details and services wait for a supervisor (a review step for reps is planned, not built)
    if(me.host && me.hostRole === 'rep' && (seg[1] === 'npi' || (seg[1] === 'clients' && method !== 'GET') || (seg[1] === 'stores' && method !== 'GET' && seg[3] !== 'drafts'))) throw forbidden('Pharmacy details and services are set by an IronLedger supervisor. A rep submits a draft for review.');
    // an IronLedger rep's reach with people: change the privileges of an existing, active user, or reset that user's password. Nothing else.
    if(me.host && me.hostRole === 'rep' && (seg[1] === 'import' || (seg[1] === 'users' && method === 'POST'))){
      const no = () => forbidden('An IronLedger rep can change the privileges of an existing, active user (and reset their password). Anything else goes to a supervisor.');
      if(seg[1] === 'import' || !seg[2]) throw no();
      const tp = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'USERS', sk: String(seg[2]) } })), t = tp.Item;
      if(!t || t.deleted || t.disabled || t.owner || t.host) throw no();
      if(seg[3] === 'reset-password') { /* allowed */ }
      else if(seg[3]) throw no();
      else { const ks = Object.keys(body); if(!ks.length || ks.some(k => k !== 'perms')) throw no(); }
    }
    // bring in a pharmacy's old shared-drive file: adds only, never changes or removes anything already there
    if(method === 'POST' && seg[1] === 'import' && seg[2]){
      if(!okId(seg[2])) throw bad('Bad pharmacy');
      const ex = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'STORES', sk: seg[2] } }));
      if(!ex.Item) throw new HttpError(404, 'No such pharmacy.');
      return await importData(seg[2], body);
    }
    if(method === 'GET' && seg[1] === 'npi' && seg[2]){ if(!me.host) throw forbidden('Registry checks are done by IronLedger.'); return await npiLookup(String(seg[2])); }
    if(seg[1] === 'clients'){
      if(!me.host) throw forbidden('Clients are managed by IronLedger.');
      if(method === 'GET' && !seg[2]) return { clients: await listClients() };
      if(method === 'POST' && !seg[2]) return await addClient(body, who(me));
      if(method === 'GET' && seg[2] && seg[3] === 'history') return await clientHistory(seg[2]);
      if(method === 'POST' && seg[2] && !seg[3]){ await updateClient(seg[2], body, who(me)); return { ok: true }; }
    }
    if(method === 'GET' && seg[1] === 'stores' && !seg[2]) return { stores: me.host ? await allStores() : (await allStores()).map(maskStore) };
    if(method === 'POST' && seg[1] === 'stores' && !seg[2]){ if(!me.host) throw forbidden('New pharmacies are set up by IronLedger.'); return await addStore(body, who(me)); }
    if(method === 'POST' && seg[1] === 'stores' && seg[2] && seg[3] === 'drafts') return await createDraft(me, seg[2], body);
    if(method === 'GET' && seg[1] === 'drafts' && !seg[2]){ if(!me.host) throw forbidden('Drafts are handled by IronLedger.'); return await listDrafts(me); }
    if(method === 'POST' && seg[1] === 'drafts' && seg[2] && seg[3] && (seg[4] === 'approve' || seg[4] === 'reject')) return await decideDraft(me, seg[2], seg[3], seg[4], body);
    if(method === 'GET' && seg[1] === 'stores' && seg[2] && seg[3] === 'history'){ if(!me.host) throw forbidden('The change history is kept by IronLedger.'); return await storeHistory(seg[2]); }
    if(method === 'POST' && seg[1] === 'stores' && seg[2] && seg[3] === 'logo'){ await setLogo(seg[2], body.dataUrl); return { ok: true }; }
    if(method === 'POST' && seg[1] === 'stores' && seg[2]){ await updateStore(seg[2], body, who(me), !!me.host); return { ok: true }; }
    if(method === 'GET' && seg[1] === 'users') return { users: await listPeople() };
    if(method === 'POST' && seg[1] === 'users' && !seg[2]){
      const stores = await cleanStoreToggles(body.stores), perms = Object.assign({}, DEFAULT_PERMS, cleanPerms(body.perms));
      if(body.smsConsent !== true) throw bad('Have the person sign the SMS consent form first, then tick the box.');
      const ini = cleanInitials(body.initials); if(ini && await initialsTaken(ini, '')) throw bad('Those initials are already used by someone else.');
      const lic = cleanLicense(body.license);
      const u = await createLogin(body);
      try{
        await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: 'USERS', sk: u.sub, login: u.login, name: u.name, phone: u.phone,
          stores, perms, acctType: cleanType(body.acctType), initials: ini, license: lic, empId: await nextEmpNo(), owner: false, createdAt: now(), createdBy: who(me), tempIssuedAt: now(), smsConsentAt: now(), smsConsentRecordedBy: who(me) } }));
      }catch(e){ await idp.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: u.login })).catch(() => {}); throw e; }
      return { ok: true, user: { sub: u.sub, login: u.login, name: u.name, phone: u.phone, stores, perms }, tempPassword: u.tempPassword };
    }
    if(method === 'POST' && seg[1] === 'users' && seg[2]) return await updatePerson(me, seg[2], seg[3], body);
  }
  throw new HttpError(404, 'Not found');
}

// Account Owner + first pharmacy, run once from the deploy script with `aws lambda invoke` (not reachable from the web)
async function bootstrap(b){
  const people = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'USERS' } });
  if(people.some(p => p.owner)) return { ok: false, message: 'The Account Owner login already exists. Add people from the Account Owner tab in the app.' };
  const stores = await allStores();
  const store = stores[0] || await addStore({ id: b.storeId, name: b.storeName, timezone: b.timezone || DEFAULT_TZ }, '', true);
  let u;
  try{ u = await createLogin({ login: b.login, name: b.name, phone: b.phone, tempPassword: b.tempPassword }); }
  catch(e){
    if(!/already taken/.test(e.message)) throw e;
    // a previous setup run created the login but stopped before saving it as Account Owner: finish it now
    const login = String(b.login || '').trim().toLowerCase(), pw = b.tempPassword || tempPassword();
    const g = await idp.send(new AdminGetUserCommand({ UserPoolId: POOL, Username: login }));
    const attr = n => ((g.UserAttributes || []).find(a => a.Name === n) || {}).Value || '';
    await idp.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: login, Password: pw, Permanent: false }));
    u = { sub: attr('sub'), login, name: attr('name') || b.name || '', phone: attr('phone_number'), tempPassword: pw };
  }
  await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: 'USERS', sk: u.sub, login: u.login, name: u.name, phone: u.phone,
    owner: true, stores: {}, perms: {}, createdAt: now(), createdBy: 'setup' } }));
  return { ok: true, message: `Account Owner login "${u.login}" created. Pharmacy ID: ${store.id} (${store.name}). Temporary password: ${u.tempPassword}`, store, tempPassword: u.tempPassword };
}

// host login (IronLedger): made from CloudShell with host.sh make-host, never through the API
async function makeHost(b){
  const people = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'USERS' } });
  const login = String(b.login || '').trim().toLowerCase();
  const same = people.find(p => p.login === login && !p.deleted);
  if(same && !same.host) return { ok: false, message: `"${login}" is already a pharmacy login. Choose another Login ID for the host.` };
  let u;
  if(same){                                            // already the host: just give it a new temporary password
    const pw = b.tempPassword || tempPassword();
    await idp.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: login, Password: pw, Permanent: false }));
    return { ok: true, message: `Host login "${login}" already exists. New temporary password: ${pw}`, tempPassword: pw };
  }
  try{ u = await createLogin({ login, name: b.name, phone: b.phone, tempPassword: b.tempPassword }); }
  catch(e){
    if(!/already taken/.test(e.message)) throw e;
    const pw = b.tempPassword || tempPassword();
    const g = await idp.send(new AdminGetUserCommand({ UserPoolId: POOL, Username: login }));
    const attr = n => ((g.UserAttributes || []).find(a => a.Name === n) || {}).Value || '';
    await idp.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: login, Password: pw, Permanent: false }));
    u = { sub: attr('sub'), login, name: attr('name') || b.name || '', phone: attr('phone_number'), tempPassword: pw };
  }
  await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: 'USERS', sk: u.sub, login: u.login, name: u.name, phone: u.phone,
    owner: false, host: true, hostRole: b.role === 'rep' ? 'rep' : 'supervisor', stores: {}, perms: {}, createdAt: now(), createdBy: 'setup' } }));
  return { ok: true, message: `Host login "${u.login}" created. Temporary password: ${u.tempPassword}`, tempPassword: u.tempPassword };
}

export const handler = async (event) => {
  try{
    if(event && event.bootstrap){ try{ return await bootstrap(event.bootstrap); }catch(e){ return { ok: false, message: 'Setup stopped: ' + e.message + ' Run deploy.sh again to retry.' }; } }
    if(event && event.makeHost){ try{ return await makeHost(event.makeHost); }catch(e){ return { ok: false, message: 'Stopped: ' + e.message }; } }
    const rp = (event.rawPath || '').replace(/^\/api/, '');
    if(event.requestContext && event.requestContext.http && event.requestContext.http.method === 'GET' && rp.startsWith('/public/pharmacy/'))
    { let id = ''; try{ id = decodeURIComponent(rp.slice('/public/pharmacy/'.length)); }catch(e){}
      return json(200, await publicPharmacy(id)); }
    const claims = (((event.requestContext || {}).authorizer || {}).jwt || {}).claims || {};
    if(!claims.sub) throw new HttpError(401, 'Please sign in again.');
    const me = await profileOf(claims.sub);
    if(!me || me.disabled || me.deleted) throw forbidden('Your login isn’t switched on for any pharmacy. Ask the Account Owner.');
    me.login = me.login || claims['cognito:username'];
    const method = event.requestContext.http.method, path = event.rawPath || '/';
    let body = {};
    if(event.body){
      const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body;
      try{ body = JSON.parse(raw); }catch(e){ throw bad('Bad JSON'); }
    }
    return json(200, await route(method, path, event.queryStringParameters || {}, body || {}, me, claims));
  }catch(e){
    if(e instanceof HttpError){
      // refusals are logged (what was asked and why, never the request body) so a "it didn't work" can be traced
      if(e.code !== 423) console.log(JSON.stringify({ refused: e.code, method: (event.requestContext && event.requestContext.http || {}).method, path: event.rawPath, why: e.message }));
      return json(e.code, { error: e.message, ...(e.locked ? { locked: true } : {}), ...(e.pin ? { pin: e.pin } : {}) });
    }
    console.error(e);
    return json(500, { error: 'Something went wrong on the server. Try again; if it keeps happening tell the Account Owner.' });
  }
};

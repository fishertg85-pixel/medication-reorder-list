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
         AdminUserGlobalSignOutCommand, AdminGetUserCommand, ListUsersCommand, ChangePasswordCommand, DescribeUserPoolClientCommand } from '@aws-sdk/client-cognito-identity-provider';

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
const DEFAULT_PERMS = { submit: true, archive: true, remove: true, export: false, calendar: true, documents: true };      // Calendar and Documents are on for everyone (Neo, 2026-11-23); the named-user list below still gates a pharmacy that is on it
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
    .map(s => ({ id: s.sk, ...pick(s, STORE_FIELDS), timezone: TIMEZONES.includes(s.timezone) ? s.timezone : DEFAULT_TZ, hasLogo: !!s.hasLogo, calendar: s.calendar === true, documents: s.documents === true, reorder: s.reorder !== false, rx: s.rx !== false,
      mgrOwner: s.mgrOwner !== false, mgrPic: s.mgrPic !== false, mgrClient: s.mgrClient === true,
      licenses: licensesOf(s), ownerIsPic: typeof s.ownerIsPic === 'boolean' ? s.ownerIsPic : null, picLogin: s.picLogin || '',
      deaVerified: s.dea && s.deaVerifiedDea === s.dea ? { at: s.deaVerifiedAt || '', by: s.deaVerifiedBy || '' } : null,
      services: Array.isArray(s.services) ? s.services.filter(x => SERVICES.includes(x)) : [], hours: Array.isArray(s.hours) && s.hours.length === 7 ? s.hours : null,
      closures: s.closures && Array.isArray(s.closures.days) ? { days: s.closures.days } : { days: [] },
      holClosed: Array.isArray(s.holClosed) ? s.holClosed : null }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
// The first Account Owner (made by the setup script) used to own every pharmacy. Once, they are moved to the pharmacies that have no client yet (the original ones);
// a pharmacy created for a client belongs to that client's owner instead. Linking an original pharmacy to a client later does not change who owns it.
let _ownMig = null;
function migrateOwners(){
  if(_ownMig) return _ownMig;
  return (_ownMig = (async () => {
    const profiles = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'USERS' } });
    const legacy = profiles.filter(p => p.owner === true && !p.deleted && !p.ownerMig);
    if(!legacy.length) return;
    const free = (await allStores()).filter(s => !s.clientId).map(s => s.id), os = {}; for(const id of free) os[id] = true;
    for(const p of legacy) await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'USERS', sk: p.sk }, UpdateExpression: 'SET ownerStores = :o, ownerMig = :t, #ow = :f',
      ExpressionAttributeNames: { '#ow': 'owner' }, ExpressionAttributeValues: { ':o': os, ':t': true, ':f': false } }));
  })().catch(e => { _ownMig = null; throw e; }));
}
const maskStore = s => ({ ...s, ein: '', einMasked: maskEin(s.ein) });
// State licenses: a pharmacy can hold one per state. Kept as a list {state, number, expires, type}; the resident license (else the first) is mirrored into license /
// licenseExpires so the calendar and Rx Intake keep working. A pharmacy saved before the list existed shows its single license as one row.
const LIC_TYPES = ['resident', 'nonresident'];
function licensesOf(s){
  if(Array.isArray(s.licenses)) return s.licenses.map(x => ({ state: String(x.state || ''), number: String(x.number || ''), expires: String(x.expires || ''), type: LIC_TYPES.includes(x.type) ? x.type : 'resident' }));
  return s.license ? [{ state: String(s.state || ''), number: String(s.license), expires: String(s.licenseExpires || ''), type: 'resident' }] : [];
}
function cleanLicenses(a){
  if(!Array.isArray(a) || a.length > 60) throw bad('State licenses: a list of up to 60.');
  const seen = new Set();
  return a.map(x => {
    const state = String(x && x.state || '').toUpperCase().trim(), number = cleanLicense(x && x.number), expires = String(x && x.expires || '').trim(), type = String(x && x.type || 'resident');
    if(!US_STATES.includes(state)) throw bad('State licenses: pick the state for each license.');
    if(!number) throw bad('State licenses: ' + state + ' needs a license number.');
    if(expires && !DATE.test(expires)) throw bad('State licenses: use the date picker for the expiration date.');
    if(!LIC_TYPES.includes(type)) throw bad('State licenses: pick resident or non-resident.');
    if(seen.has(state)) throw bad('State licenses: ' + state + ' is listed twice.');
    seen.add(state); return { state, number, expires, type };
  });
}      // only IronLedger sees a full EIN
// ---------- who owns what. A Pharmacy Account Owner belongs to specific pharmacies (profile.ownerStores), a Client Account Owner to specific clients
// (profile.ownerClients). One login can hold either or both and still work as staff at another pharmacy. adminStores: a PIC the owner gave super-user
// privileges (everything the owner can do at that pharmacy except billing, the client page and changing ownership).
const hasAny = m => !!m && typeof m === 'object' && Object.values(m).some(v => v === true);
// IronLedger employee portal: its own app client (PORTAL_CLIENT_ID). A login with the employee flag (host:true) is a host only when it signs in through that client;
// through the pharmacy app it is an ordinary pharmacy user (so one login, one password, can do both). With no portal client configured (older deploys, dev) the flag alone decides.
const PORTAL_CLIENT = process.env.PORTAL_CLIENT_ID || '';
const hasRole = p => !!p && (hasAny(p.stores) || hasAny(p.ownerStores) || hasAny(p.adminStores) || hasAny(p.ownerClients));
const DUAL_KEYS = ['stores', 'perms', 'permStore', 'acctType', 'subs', 'dp', 'approver', 'docDuty', 'license', 'licExpires', 'initials', 'adminStores'];   // what a pharmacy may set on an employee login that works there
const pureHost = p => !!p && p.host === true && !hasRole(p);     // an employee login with no pharmacy of its own: never shown in a pharmacy's people
const trueKeys = m => Object.keys(m || {}).filter(k => m[k] === true);
const ownsStore = (me, id) => !!(me && me.ownerStores && me.ownerStores[id] === true);
const adminStore = (me, id) => !!(me && me.adminStores && me.adminStores[id] === true);
const mgrStore = (me, id) => ownsStore(me, id) || adminStore(me, id);
const ownsClient = (me, id) => !!(me && me.ownerClients && me.ownerClients[id] === true);
const isOwnerP = p => !!p && (hasAny(p.ownerStores) || hasAny(p.adminStores));
const isClientOwnerP = p => !!p && hasAny(p.ownerClients);
// the pharmacies where this person may change people: set per request (me.mgrOn) from the host's switches, one per role (owner, PIC super user, client owner)
const managedIds = me => me.mgrOn instanceof Set ? me.mgrOn : new Set([...trueKeys(me.ownerStores), ...trueKeys(me.adminStores)]);
async function setMgr(me){
  me.mgrOn = new Set();
  if(me.host || !(hasAny(me.ownerStores) || hasAny(me.adminStores) || hasAny(me.ownerClients))) return;
  for(const s of await allStores()){
    if((ownsStore(me, s.id) && s.mgrOwner) || (adminStore(me, s.id) && !ownsStore(me, s.id) && s.mgrPic) || (s.clientId && ownsClient(me, s.clientId) && s.mgrClient)) me.mgrOn.add(s.id);
  }
}
// what this person may open at one pharmacy: its people (read), its billing (read), and changing people (the host's switch for their role)
function reachAt(me, s){
  if(me.host) return { users: true, billing: true, manage: true };
  const o = ownsStore(me, s.id), a = adminStore(me, s.id), c = !!(s.clientId && ownsClient(me, s.clientId));
  return { users: o || a || c, billing: o || c, manage: (o && s.mgrOwner) || (a && !o && s.mgrPic) || (c && s.mgrClient) };
}
const storePermsAt = (me, id) => Object.assign({}, me.perms || {}, (me.storePerms && me.storePerms[id]) || {});        // privileges set for one pharmacy win over the person's general ones
const asStore = (me, id) => ({ ...me, owner: mgrStore(me, id), isOwner: ownsStore(me, id), perms: storePermsAt(me, id) });     // the caller as seen inside one pharmacy
// Pharmacist functions at a pharmacy (Rx Intake, pharmacist-level calendar tasks): a staff pharmacist or the PIC; the Account Owner only when the host recorded that the
// owner is the PIC. A pharmacy the host has not answered that for yet keeps the earlier rule (the Account Owner counts).
const pharmFn = (me, s) => { if(me.host) return false; if(ownsStore(me, s.id)) return s.ownerIsPic !== false; return me.acctType === 'pharmacist' || me.acctType === 'pic'; };
async function storesFor(me){
  const all = await allStores(), mine = all.filter(s => canUse(me, s.id));
  if(me.host) return mine;
  return mine.map(maskStore).map(s => {
    const o = ownsStore(me, s.id), a = adminStore(me, s.id), ph = pharmFn(me, s), su = suiteStore(s.id) ? suiteUser(me, s.id) : null;
    const out = { ...s, owner: o || a, isOwner: o, pharm: ph, perms: permsAt(me, s.id) };
    if(su !== null){ out.calendar = su; out.documents = su; out.rx = su && ph; } else out.rx = s.rx && ph;
    return out;
  });
}
function canUse(me, store){ return mgrStore(me, store) || (me.stores || {})[store] === true; }
function permsOf(me){ const o = {}; for(const p of PERMS) o[p] = me.owner ? true : ((me.perms || {})[p] ?? DEFAULT_PERMS[p]); return o; }
const permsAt = (me, id) => { const o = permsOf({ ...me, perms: storePermsAt(me, id), owner: mgrStore(me, id) }); if(suiteStore(id) && suiteUser(me, id)){ o.calendar = true; o.documents = true; } return o; };
// ---------- Calendar + Documents suite access: a fixed list of logins per pharmacy (SUITE_USERS in template.yaml, "NTX1:login,login;..."),
// not switches. For a pharmacy on the list, ONLY these logins get Calendar and Documents, whatever else they have access to there (the reorder
// list, Account Owner role, other privileges). Pharmacies not on the list keep the older switches. Editing the list is a code/template change.
const SUITE = (() => { const o = {}; for(const part of String(process.env.SUITE_USERS || '').split(';')){ const [id, list] = part.split(':'); if(id && list) o[id.trim()] = list.split(',').map(x => x.trim().toLowerCase()).filter(Boolean); } return o; })();
const suiteStore = id => Object.prototype.hasOwnProperty.call(SUITE, id);
const suiteUser = (me, id) => suiteStore(id) && canUse(me, id) && !me.host && SUITE[id].includes(String(me.login || '').toLowerCase());
const suiteAny = me => Object.keys(SUITE).some(id => suiteUser(me, id));
const effPerms = me => { const o = permsOf({ ...me, owner: false }); if(suiteAny(me)){ o.calendar = true; o.documents = true; } return o; };
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
  for(const [k, l] of [['reorder', 'Reorder List'], ['rx', 'Rx Intake'], ['mgrOwner', 'Account Owner may manage users'], ['mgrPic', 'PIC may manage users'], ['mgrClient', 'Client Account Owner may manage users']]) if(b[k] !== undefined){ if(typeof b[k] !== 'boolean') throw bad(l + ' switch must be on or off.'); f[k] = b[k]; }
  if(f.npi){ if(!/^\d{10}$/.test(f.npi)) throw bad('NPI must be exactly 10 digits.'); if(!validNpi(f.npi)) throw bad('That NPI’s check digit doesn’t match. Re-check the number.'); }
  if(f.dea){ f.dea = f.dea.toUpperCase(); if(!validDea(f.dea)) throw bad('DEA number should be 2 letters and 7 digits and pass the DEA check digit. Re-check it.'); }
  if(f.ncpdp && !/^\d{7}$/.test(f.ncpdp)) throw bad('NCPDP ID must be exactly 7 digits.');
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
  if(b.licenses !== undefined){
    f.licenses = cleanLicenses(b.licenses);
    const prim = f.licenses.find(x => x.type === 'resident') || f.licenses[0];
    f.license = prim ? prim.number : ''; f.licenseExpires = prim ? prim.expires : '';
  }
  return f;
}
// What each side may change on a pharmacy.
// The Account Owner (the pharmacy's primary account holder) may change only these. Everything else (name, address, email, license, NPI, DEA, NCPDP,
// services, the Calendar switch) is set by IronLedger (the host login); billing follows the client's identity, so those must stay consistent.
const AM_EDITABLE = ['phone', 'fax', 'email', 'timezone', 'hours', 'closures', 'holClosed', 'licenseExpires', 'deaExpires', 'licenses'];
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
  let licIdentChanged = false;
  if(f.licenses){
    const old = licensesOf(curItem);
    licIdentChanged = old.some(o => o.number && !f.licenses.some(n => n.state === o.state && n.number === o.number));          // a license on file was changed or removed
    if(!isHost && (old.length !== f.licenses.length || f.licenses.some((n, i) => n.state !== old[i].state || n.number !== old[i].number || n.type !== old[i].type)))
      throw forbidden('Only the expiration dates of state licenses can be changed here. States and license numbers are set by IronLedger.');
    if(!isHost){ delete f.license; }
  }
  // changing an identity value that is already on file needs a written reason (filling a blank does not)
  if(f.clientId) await needClient(f.clientId);
  if(f.ein === '' && curItem.ein) throw bad('The licensed entity’s EIN is required and can’t be cleared. Enter the corrected number instead.');
  const changedIdent = IDENTITY.filter(k => f[k] !== undefined && (curItem[k] || '') !== '' && f[k] !== curItem[k]);
  const reason = String(b.changeReason || '').trim();
  if(licIdentChanged) changedIdent.push('state licenses');
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
  return profiles.filter(p => !p.deleted).map(p => ({ sub: p.sk, login: p.login, name: p.name || '', phone: p.phone || '', owner: isOwnerP(p), ownerStores: p.ownerStores || {}, adminStores: p.adminStores || {}, ownerClients: p.ownerClients || {}, createdBySub: p.createdBySub || '', host: !!p.host, employeeOnly: pureHost(p), storePerms: p.storePerms || {}, hostRole: p.host ? (p.hostRole === 'rep' ? 'rep' : 'supervisor') : '', repStores: p.host ? (p.repStores || {}) : {}, acctType: p.acctType || '', docDuty: DOC_DUTIES.includes(p.docDuty) ? p.docDuty : '', initials: p.initials || '', license: p.license || '', licExpires: p.licExpires || '', subs: Array.isArray(p.subs) ? p.subs : [], dp: p.dp && typeof p.dp === 'object' ? p.dp : {}, approver: p.approver === true, empId: p.empId || '', pin: pinState(p),
    stores: p.stores || {}, perms: effPerms(p), disabled: status[p.sk] ? !status[p.sk].enabled : !!p.disabled,
    status: (status[p.sk] || {}).status || 'UNKNOWN', ...pendingOf(p, status[p.sk]) }))
    // Account Owner, host, then people still waiting to sign in for the first time, then everyone else
    .sort((a, b) => (b.owner - a.owner) || (b.host - a.host) || (b.pending - a.pending) || (a.name || a.login).localeCompare(b.name || b.login));
}
async function cleanStoreToggles(obj, me){
  const all = new Set((await allStores()).map(s => s.id)), out = {}, m = me && !me.host ? managedIds(me) : null;
  for(const [k, v] of Object.entries(obj && typeof obj === 'object' ? obj : {})) if(all.has(k) && (!m || m.has(k))) out[k] = v === true;     // an Account Owner only touches their own pharmacies
  return out;
}
// the people an Account Owner can see and change: anyone with access to (or ownership of) one of their pharmacies, people they added, themselves, and the host logins
// (so they can grant host access to their pharmacies). Never anyone else's pharmacies.
// (an IronLedger employee login with no pharmacy of its own is never part of a pharmacy's people)
const personInScope = (me, p) => { if(me.host || p.sk === me.sk) return true; if(pureHost(p)) return false; const m = managedIds(me); if(!m.size) return false; if(p.createdBySub === me.sk) return true; return [...trueKeys(p.stores), ...trueKeys(p.ownerStores), ...trueKeys(p.adminStores)].some(k => m.has(k)); };
function scopePeople(me, people){
  if(me.host) return people;
  const m = managedIds(me), only = o => Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => v === true && m.has(k)));
  return people.filter(p => personInScope(me, { ...p, sk: p.sub })).map(p => ({ ...p, stores: only(p.stores), ownerStores: only(p.ownerStores), adminStores: only(p.adminStores), storePerms: only(p.storePerms), ownerClients: {},
    host: false, hostRole: '', repStores: {}, employeeOnly: false, ...(p.host ? { locked: true } : {}) }))            // a pharmacy never sees who is an IronLedger employee
    .sort((a, b) => (b.owner - a.owner) || (b.pending - a.pending) || (a.name || a.login).localeCompare(b.name || b.login));
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
  if(me.host ? !isSupervisor(me) : !managedIds(me).size) throw forbidden('Only the Account Owner or an IronLedger supervisor can issue a temporary PIN.');
  if((isOwnerP(p) || p.host) && !me.host) throw forbidden('IronLedger issues the temporary PIN for the Account Owner and IronLedger employee logins.');
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
// ---------- sub-roles, Designated Person boxes, approver, and the super-user tier rule (Neo, 2026-11-23)
// Account type = the tier. A sub-role is a job-function switch inside the tier (combinable). Designated Person is a set of chapter boxes (pharmacist or technician only).
const SUBROLES = { pic: [], pharmacist: ['lead', 'supervisor', 'immunizer', 'sterile'], tech: ['lead', 'sterile', 'nonsterile'], staff: ['cashier', 'driver', 'warehouse', 'student'] };
const CHAPTERS = ['795', '797', '800'];
const TIER = { '': 0, staff: 0, tech: 1, pharmacist: 2, pic: 3 };
const tierOf = p => p && (hasAny(p.ownerStores) || hasAny(p.ownerClients)) ? 4 : (TIER[(p && p.acctType) || ''] || 0);
const isOwnerTier = me => !!me && (hasAny(me.ownerStores) || hasAny(me.ownerClients));
function cleanSubs(list, type){
  if(list == null || list === '') return [];
  if(!Array.isArray(list)) throw bad('Bad sub-roles.');
  const ok = SUBROLES[type || ''] || [], out = [];
  for(const v of list){ const k = String(v); if(!ok.includes(k)) throw bad('That sub-role doesn’t belong to this account type.'); if(!out.includes(k)) out.push(k); }
  return out;
}
function cleanDp(obj, type){
  if(obj == null) return {};
  if(typeof obj !== 'object' || Array.isArray(obj)) throw bad('Bad Designated Person setting.');
  const out = {};
  for(const [k, v] of Object.entries(obj)){
    if(!CHAPTERS.includes(k)) throw bad('Designated Person chapters are 795, 797 and 800.');
    if(v === true) out[k] = true; else if(v !== false) throw bad('Bad Designated Person setting.');
  }
  if(Object.keys(out).length && !(type === 'pic' || type === 'pharmacist' || type === 'tech')) throw bad('Only a pharmacist or a technician can be a Designated Person.');
  return out;
}
function cleanApprover(me, v, type){
  if(typeof v !== 'boolean') throw bad('Bad approver setting.');
  if(v){
    if(!(type === 'pic' || type === 'pharmacist')) throw bad('Final approval goes to a pharmacist.');
    if(!(me.host || isOwnerTier(me) || me.acctType === 'pic')) throw forbidden('Only the Account Owner or the pharmacist in charge names a final approver.');
  }
  return v;
}
const cleanLicDate = v => { v = String(v == null ? '' : v).trim(); if(v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad('Enter the expiry date as YYYY-MM-DD.'); return v; };
// a super user manages people at or below their own tier (Account Owner and the host manage everyone except Account Owners and the host)
function tierGuard(me, p, sub, body){
  if(me.host || isOwnerTier(me)) return;
  if(sub === me.sk){
    for(const k of ['acctType', 'subs', 'dp', 'approver', 'adminStores']) if(body[k] !== undefined) throw forbidden('You can’t change your own role or super user setting.');
    return;
  }
  const mine = tierOf(me), theirs = tierOf(p);
  if(theirs > mine || (p.acctType === 'pic' && me.acctType !== 'pic') || (p.acctType === 'pic' && theirs >= mine && me.sk !== p.sk && me.acctType === 'pic')) throw forbidden('You can change people at or below your own level, not above it.');
}
function tierGuardType(me, p, sub, type){
  if(me.host || isOwnerTier(me)) return;
  if(TIER[type || ''] > tierOf(me) || (type === 'pic')) throw forbidden('You can’t give someone an account type above your own.');
}
async function initialsTaken(ini, exceptSub){
  const all = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'USERS' } });
  return all.some(p => !p.deleted && p.sk !== exceptSub && (p.initials || '') === ini);
}
async function repGuard(p, seg3, body){
  if(p.host) throw forbidden('Host logins are managed by an IronLedger supervisor.');
  if(seg3 === 'reset-password') return;
  if(seg3) throw forbidden('A rep can’t do that. Ask an IronLedger supervisor.');
  const keys = Object.keys(body);
  if(!keys.length || keys.some(k => k !== 'perms' && k !== 'permStore')) throw forbidden('A rep can change privileges only. Ask an IronLedger supervisor for anything else.');
  if(isOwnerP(p) || isClientOwnerP(p)) throw forbidden('An Account Owner always has full access.');
  if(!p.acctType) throw forbidden('A rep can change privileges only on a person who has an account type. Ask an IronLedger supervisor.');
  if(body.perms && (Object.prototype.hasOwnProperty.call(body.perms, 'calendar') || Object.prototype.hasOwnProperty.call(body.perms, 'documents'))) throw forbidden('The Calendar and Documents privileges are part of a service line and are set by an IronLedger supervisor.');
  const g = await idp.send(new AdminGetUserCommand({ UserPoolId: POOL, Username: p.login })).catch(() => null);
  if(g ? g.Enabled === false : !!p.disabled) throw forbidden('A rep can change privileges only on an active person (login not switched off). First sign-in does not matter.');
}
async function updatePerson(me, sub, seg3, body){
  if(!okId(sub)) throw bad('Bad user');
  const p = await profileOf(sub); if(!p) throw new HttpError(404, 'No such person.');
  if(!personInScope(me, p)) throw new HttpError(404, 'No such person.');
  // the host login belongs to IronLedger: the Account Owner sees it but only the host changes it
  // except which pharmacies it may open: only the Account Owner grants that
  // the Account Owner decides which pharmacies the host may open and what it may do there; nothing else about the host login
  // An IronLedger employee's login that also works at a pharmacy is an ordinary user there: the pharmacy sets its account type, role and privileges like anyone's.
  // Its sign-in (password, PIN, phone, name, on/off, delete) stays with IronLedger, because the same login opens the employee portal.
  if(p.host && !me.host && (seg3 || Object.keys(body).some(k => !DUAL_KEYS.includes(k)))) throw forbidden('The sign-in details of this login (password, PIN, mobile number, name, on or off) are changed by IronLedger.');
  if(sub === me.sk && body.disabled === true) throw bad('You can’t switch off your own login.');
  if(!me.host && sub !== me.sk && (hasAny(p.ownerStores) || isClientOwnerP(p))) throw forbidden('An Account Owner’s login is managed by IronLedger.');
  if(me.host && me.hostRole === 'rep') await repGuard(p, seg3, body);
  if(seg3 === 'delete'){
    // the login is removed for good (the Login ID can be used again); what they did stays on the orders and archive by name.
    // A short record is kept of who existed and who removed them, with their SMS consent dates.
    if(isOwnerP(p) || isClientOwnerP(p)) throw bad('An Account Owner can’t be deleted. IronLedger first gives their ownership to someone else.');
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
  if((isOwnerP(p) || isClientOwnerP(p)) && !me.host && body.phone !== undefined) throw forbidden('The Account Owner’s own mobile number is changed by IronLedger. Contact IronLedger to update it.');
  // no per-person email exists today; if one is ever added, changing it for the Account Owner must also need the host
  if(body.email !== undefined) throw bad('People don’t have an email address in this app.');
  if(pureHost(p) && me.host && (body.stores !== undefined || body.perms !== undefined)) throw bad('This is an IronLedger employee login with no pharmacy of its own.');
  const upd = {};
  tierGuard(me, p, sub, body);
  if(body.acctType !== undefined){ if(pureHost(p)) throw bad('This is an IronLedger employee login with no pharmacy of its own.'); upd.acctType = cleanType(body.acctType); tierGuardType(me, p, sub, upd.acctType);
    if(upd.acctType !== p.acctType){ upd.subs = []; if(upd.acctType !== 'pic' && upd.acctType !== 'pharmacist' && upd.acctType !== 'tech') upd.dp = {}; if(upd.acctType !== 'pic' && upd.acctType !== 'pharmacist') upd.approver = false; } }
  if(body.subs !== undefined){ if(pureHost(p)) throw bad('This is an IronLedger employee login with no pharmacy of its own.'); upd.subs = cleanSubs(body.subs, upd.acctType !== undefined ? upd.acctType : p.acctType); }
  if(body.dp !== undefined){ if(pureHost(p)) throw bad('This is an IronLedger employee login with no pharmacy of its own.'); upd.dp = cleanDp(body.dp, upd.acctType !== undefined ? upd.acctType : p.acctType); }
  if(body.approver !== undefined){ if(pureHost(p)) throw bad('This is an IronLedger employee login with no pharmacy of its own.'); upd.approver = cleanApprover(me, body.approver, upd.acctType !== undefined ? upd.acctType : p.acctType); }
  if(body.licExpires !== undefined) upd.licExpires = cleanLicDate(body.licExpires);
  if(body.docDuty !== undefined){ if(pureHost(p)) throw bad('This is an IronLedger employee login with no pharmacy of its own.'); const dd = String(body.docDuty || ''); if(dd !== '' && !DOC_DUTIES.includes(dd)) throw bad('Pick the document duty from the list.'); upd.docDuty = dd; }
  if(body.initials !== undefined){ const ini = cleanInitials(body.initials); if(ini && await initialsTaken(ini, sub)) throw bad('Those initials are already used by someone else.'); upd.initials = ini; }
  if(body.license !== undefined) upd.license = cleanLicense(body.license);
  if(body.repStores !== undefined){ if(!isSupervisor(me)) throw forbidden('A supervisor assigns reps to pharmacies.'); if(!(p.host && p.hostRole === 'rep')) throw bad('Only rep logins have assigned pharmacies.'); upd.repStores = Object.assign({}, p.repStores || {}, await cleanStoreToggles(body.repStores)); }
  if(body.stores !== undefined) upd.stores = Object.assign({}, p.stores || {}, await cleanStoreToggles(body.stores, me));
  if(body.adminStores !== undefined){                // super user (administrator) privileges for a PIC at one pharmacy
    if(!body.adminStores || typeof body.adminStores !== 'object') throw bad('Bad administrator setting.');
    if(pureHost(p)) throw bad('This is an IronLedger employee login with no pharmacy of its own.');
    const cur = Object.assign({}, p.adminStores || {});
    for(const [id, v] of Object.entries(body.adminStores)){
      if(!okId(id)) throw bad('Bad pharmacy');
      const picGrant = !me.host && !ownsStore(me, id) && adminStore(me, id) && me.acctType === 'pic';
      if(me.host ? !isSupervisor(me) : !(ownsStore(me, id) || picGrant)) throw forbidden('Only the pharmacy’s Account Owner, its pharmacist in charge or an IronLedger supervisor gives super user privileges.');
      const tt = upd.acctType || p.acctType;
      if(v === true){
        if(picGrant && !(tt === 'pharmacist' || tt === 'tech')) throw forbidden('The pharmacist in charge gives super user privileges to a pharmacist or a technician.');
        if(!(tt === 'pic' || tt === 'pharmacist' || tt === 'tech')) throw bad('Super user privileges go to a pharmacist or a technician: set the account type first.');
        if((tt === 'pic' || tt === 'pharmacist') && !(p.license || upd.license)) throw bad('A pharmacist with super user privileges needs an RPh license number on their login. Enter it first.');
        cur[id] = true; }
      else delete cur[id];
    }
    upd.adminStores = cur;
  }
  if(body.perms !== undefined){
    if(body.permStore !== undefined){                // privileges at ONE pharmacy; the person's privileges at other pharmacies are untouched
      const sid = String(body.permStore); if(!okId(sid)) throw bad('Bad pharmacy');
      if(!me.host && !managedIds(me).has(sid)) throw forbidden('You can’t change privileges at that pharmacy.');
      const sp = Object.assign({}, p.storePerms || {}); sp[sid] = Object.assign({}, sp[sid] || p.perms || {}, cleanPerms(body.perms)); upd.storePerms = sp;
    } else upd.perms = Object.assign({}, p.perms || {}, cleanPerms(body.perms));
  }
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
class Locked extends HttpError { constructor(){ super(423, 'This page is locked. Re-enter your password.'); this.locked = true; } }
const manages = me => !!(me.owner || me.clientOwner || me.host);         // an Account Owner (pharmacy or client), and the host (IronLedger)
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
const CAL_COLLS = ['records', 'events', 'obl', 'log', 'exc'];
const CAL_CFG = ['v', 'profile', 'sites', 'people', 'equipment', 'documents', 'tracks', 'plans', 'work', 'reminders', 'rooms'];
const CAL_MAX_BYTES = 380000, CAL_MAX_OPS = 100;
function calGate(me, storeItem){
  if(suiteStore(storeItem.sk)){ if(!suiteUser(me, storeItem.sk)) throw forbidden('The calendar is limited to the named users for this pharmacy.'); return; }
  if(storeItem.calendar !== true) throw forbidden('The calendar is not switched on for this pharmacy.');
  if(!permsOf(me).calendar) throw forbidden('You do not have the Calendar privilege. Ask the Account Owner.');
}
const calPk = store => 'STORE#' + store;
// Who may complete which built-in task type (the calendar app shows every task to everyone; this decides who can finish one). The responsible duty of each built-in task, copied
// from the calendar app (checked by dev/roles_test): PIC and Designated Person tasks are pharmacist or compliance-technician work, Owner tasks belong to the owner or administrator
// (a pharmacist may also finish them). A task type that is not in this list is a custom one: anyone with the calendar may complete it, including a Pharmacy Associate.
const CAL_ROLE = { 'dea-reg': 'Owner', 'dea-biennial': 'PIC', 'tx-cs-annual': 'PIC', 'cs-reconcile': 'PIC', 'cs-cycle': 'PIC', 'tx-pharmacy-license': 'Owner', 'tx-rph-license': 'PIC', 'tx-tech-reg': 'PIC', 'tx-pic-change': 'PIC', 'tx-pic-inventory': 'PIC', 'tx-officer-change': 'Owner', 'tx-location-change': 'Owner',
  'u795-training': 'DP', 'u795-sop': 'DP', 'u797-cert-pec': 'DP', 'u797-cert-sec': 'DP', 'u797-air': 'DP', 'u797-surface': 'DP', 'u797-sop': 'DP', 'u797-qaqc': 'DP', 'u797-didactic': 'DP', 'u797-garb': 'DP', 'u797-media': 'DP', 'u797-sporicidal': 'DP', 'u797-monitor-cal': 'DP', 'u797-pressure': 'DP',
  'u800-list': 'DP', 'u800-risk': 'DP', 'u800-sop': 'DP', 'u800-training': 'DP', 'u800-wipe': 'DP', 'osha-ecp': 'Owner', 'osha-training': 'Owner', 'hipaa-risk': 'Owner', 'hipaa-training': 'Owner', 'doc-review': 'PIC' };
function calMayComplete(me, obId){
  const role = CAL_ROLE[obId]; if(!role || me.host) return true;
  if(me.pharm) return true;
  if(role === 'Owner') return !!me.owner;
  if(role === 'DP') return me.docDuty === 'dp' || me.docDuty === 'ctech' || me.acctType === 'tech' || !!(me.dp && Object.values(me.dp).some(v => v === true));     // a technician submits; the Designated Person reviews
  return false;                                                  // PIC tasks: a pharmacist only
}
// ---------- time in the pharmacy's zone, approval chain, delegation and time off (Neo, 2026-11-23)
function tzOffsetMs(tz, ms){
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const o = {}; for(const x of f.formatToParts(new Date(ms))) o[x.type] = x.value;
  return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second) - Math.floor(ms / 1000) * 1000;
}
function localToUtcMs(tz, local){                      // "YYYY-MM-DDTHH:MM" typed in the pharmacy's zone -> UTC milliseconds
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local || ''));
  if(!m) throw bad('Enter the date and the time.');
  const g = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let u = g - tzOffsetMs(tz || DEFAULT_TZ, g); u = g - tzOffsetMs(tz || DEFAULT_TZ, u);
  return u;
}
const CAL_SIDE = { deleg: 'delegations', toff: 'timeoff' };           // kept as their own items, written only through the routes below (never through commit)
const chapterOf = obId => { const m = /^u(795|797|800)-/.exec(String(obId || '')); return m ? m[1] : ''; };
const dpHolds = (p, ch) => !!p && !p.deleted && !p.disabled && (p.acctType === 'pic' || p.acctType === 'pharmacist' || p.acctType === 'tech') && !!(p.dp && p.dp[ch] === true);
const finalRole = (me, ownerIsPic) => me.acctType === 'pic' || (me.isOwner === true && ownerIsPic !== false) || (me.approver === true && (me.acctType === 'pharmacist' || me.acctType === 'pic'));
const isPharmacist = me => me.acctType === 'pic' || me.acctType === 'pharmacist' || (me.isOwner === true && me.pharm === true);
const delegActive = (d, atMs) => d && !d.canceled && d.startMs <= atMs && atMs < d.endMs;
async function calSide(store, kind){
  const items = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p AND begins_with(sk, :c)', ExpressionAttributeValues: { ':p': calPk(store), ':c': 'CAL#' + kind + '#' } });
  const out = []; for(const it of items){ try{ out.push(JSON.parse(it.j)); }catch(e){} } return out;
}
async function calLog(store, me, action, detail){
  const e = { id: 'l' + crypto.randomBytes(5).toString('hex'), ts: now(), by: who(me), action, detail: String(detail || '').slice(0, 500) };
  await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: calPk(store), sk: 'CAL#log#' + e.id, j: JSON.stringify(e), updatedAt: e.ts, updatedBy: who(me) } }));
}
async function calTeam(store){
  return (await listPeople()).filter(p => !p.employeeOnly && !p.deleted && !p.disabled && ((p.stores || {})[store] === true || (p.ownerStores || {})[store] === true || (p.adminStores || {})[store] === true));
}
async function calLoad(store, me, storeItem){
  const items = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p AND begins_with(sk, :c)', ExpressionAttributeValues: { ':p': calPk(store), ':c': 'CAL#' } });
  const out = { started: false, config: {}, records: [], events: [], obl: [], log: [], exc: [] };
  for(const it of items){
    let v; try{ v = JSON.parse(it.j); }catch(e){ continue; }
    const [, kind, ...rest] = it.sk.split('#');
    if(kind === 'cfg'){ out.config[rest.join('#')] = v; if(rest[0] === 'profile') out.started = true; }
    else if(CAL_COLLS.includes(kind)) out[kind].push(v);
  }
  if(me){
    const at = Date.now(), tz = storeItem && storeItem.timezone, team = await calTeam(store);
    const boss = me.acctType === 'pic' || me.isOwner === true || me.host === true;
    const deleg = (await calSide(store, 'deleg')).filter(d => d.endMs > at - 7 * 86400000);
    const toff = (await calSide(store, 'toff')).filter(d => !d.canceled && d.endMs > at - 86400000);
    out.delegations = deleg.map(d => ({ ...d, active: delegActive(d, at) }));
    out.timeoff = toff.map(({ reason, ...r }) => r);                              // name and span only, no reason, visible to every user
    const soon = new Date(at + 30 * 86400000).toISOString().slice(0, 10), today = new Date(at).toISOString().slice(0, 10);
    out.team = team.map(p => ({ sub: p.sub, name: p.name || p.login, acctType: p.acctType, subs: p.subs, dp: p.dp, approver: p.approver, docDuty: p.docDuty,
      ...(boss || p.sub === me.sk ? { licExpires: p.licExpires || '', license: p.license || '' } : {}) }));
    out.expiring = { registrations: team.filter(p => p.acctType === 'tech' && p.licExpires && p.licExpires <= soon).length, expired: team.filter(p => p.licExpires && p.licExpires < today).length };
    const myDelegs = deleg.filter(d => d.toSub === me.sk && delegActive(d, at));
    out.me = { sub: me.sk, acctType: me.acctType || '', subs: me.subs || [], dp: me.dp || {}, approver: me.approver === true, viewOnly: me.acctType === 'staff' && !me.host && !me.isOwner,
      dpChapters: CHAPTERS.filter(c => dpHolds(me, c) || myDelegs.some(d => d.step === 'dp' && (!d.chapters || !d.chapters.length || d.chapters.includes(c)))),
      pinRequired: PIN_REQUIRED, canFinal: finalRole(me, storeItem && storeItem.ownerIsPic) || myDelegs.some(d => d.step === 'final' && isPharmacist(me)), boss, timezone: tz || DEFAULT_TZ };
  }
  return out;
}
// who may do the DP step or the final step on one record, now: by their own standing, or by a delegation to them that is running (then "on behalf of")
function stepRights(me, ownerIsPic, ch, delegs, atMs){
  const mine = delegs.filter(d => d.toSub === me.sk && delegActive(d, atMs));
  const dpDeleg = ch ? mine.find(d => d.step === 'dp' && (!d.chapters || !d.chapters.length || d.chapters.includes(ch))) : null;
  const fDeleg = mine.find(d => d.step === 'final' && isPharmacist(me));
  return { dp: dpHolds(me, ch) ? { own: true } : dpDeleg ? { own: false, deleg: dpDeleg } : null,
           final: finalRole(me, ownerIsPic) ? { own: true } : fDeleg ? { own: false, deleg: fDeleg } : null };
}
// Checks one record's review change against the chain: submit -> DP review (when the chapter has a DP and the submitter is not one) -> final approval; a return at either
// step needs a reason and goes back to the technician as pending; the server stamps who and when. Returns the review to store.
async function calChain(store, me, storeItem, o, prev, team, delegs, stamp){
  const pr = prev && prev.review, nr = o.review, ch = chapterOf(String(o.track || '').split('|')[0]);
  if(!pr && !nr) return null;
  if(pr && pr.status === 'accepted') return pr;                       // accepted is final
  if(!nr) throw forbidden('A task’s review can’t be removed.');
  const atMs = Date.parse(stamp), ownerIsPic = storeItem.ownerIsPic;
  const initial = () => (ch && team.some(p => dpHolds(p, ch)) && !dpHolds(me, ch)) ? 'dp' : 'pending';
  const hist = Array.isArray(pr && pr.hist) ? pr.hist.slice(-40) : [];
  const keep = { hist };
  if(pr && pr.status === 'returned' && nr.status === 'returned') return pr;
  if(!pr || pr.status === 'returned'){                                 // first submission, or a resubmission after a return
    if(nr.status !== 'pending' && nr.status !== 'dp') throw forbidden('A task is submitted for review; it can’t be accepted when it is entered.');
    const st = initial(); return { ...keep, status: st, since: stamp };
  }
  if(nr.status === pr.status) return pr;
  const R = stepRights(me, ownerIsPic, ch, delegs, atMs), who_ = who(me), reason = String(nr.reason || nr.bypassReason || '').trim().slice(0, 500);
  const behalf = r => r && !r.own ? { onBehalfOf: r.deleg.fromName, delegId: r.deleg.id } : {};
  if(pr.status === 'dp'){
    if(nr.status === 'pending'){
      if(!R.dp) throw forbidden('Only a Designated Person for this chapter can pass this review.');
      return { ...keep, status: 'pending', since: stamp, dp: { by: who_, byId: me.sk, at: stamp, note: String(nr.note || '').slice(0, 500), ...behalf(R.dp) } };
    }
    if(nr.status === 'returned'){
      if(!R.dp) throw forbidden('Only a Designated Person for this chapter can return this record.');
      if(!reason) throw bad('A reason is required to return a record.');
      return { status: 'returned', since: stamp, hist: hist.concat([{ at: stamp, by: who_, step: 'dp', reason, ...behalf(R.dp) }]) };
    }
    if(nr.status === 'accepted'){
      if(!R.final) throw forbidden('Only the final approver can accept this record.');
      if(!reason) throw bad('A reason is required to review in place when the Designated Person has not.');
      return { status: 'accepted', by: who_, byId: me.sk, at: stamp, note: String(nr.note || '').slice(0, 500), bypassed: { reason, by: who_, at: stamp }, ...behalf(R.final), hist };
    }
  }
  if(pr.status === 'pending'){
    if(nr.status === 'accepted'){
      if(!R.final) throw forbidden('Only the final approver (the pharmacist in charge, or a pharmacist they named) can accept.');
      return { status: 'accepted', by: who_, byId: me.sk, at: stamp, note: String(nr.note || '').slice(0, 500), sameAsCompleter: String(o.completedBy || '').toLowerCase() === String(me.name || '').toLowerCase(),
        ...(pr.dp ? { dp: pr.dp, sameAsDp: pr.dp.byId === me.sk } : {}), ...behalf(R.final), hist };
    }
    if(nr.status === 'returned'){
      if(!R.final && !R.dp) throw forbidden('Only a reviewer can return this record.');
      if(!reason) throw bad('A reason is required to return a record.');
      return { status: 'returned', since: stamp, hist: hist.concat([{ at: stamp, by: who_, step: 'final', reason, ...behalf(R.final) }]) };
    }
  }
  throw forbidden('That change to the review isn’t allowed.');
}
const fmtLocal = (ms, tz) => { try{ return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms)); }catch(e){ return new Date(ms).toISOString(); } };
function spanOf(tz, b){
  const startMs = localToUtcMs(tz, b.start), endMs = localToUtcMs(tz, b.end);
  if(startMs < Date.now() - 90000) throw bad('The start can’t be earlier than now.');
  if(endMs <= startMs) throw bad('The end must be after the start.');
  if(endMs - startMs > 366 * 86400000) throw bad('A span is at most one year.');
  return { startMs, endMs, start: String(b.start), end: String(b.end) };
}
async function calDelegate(store, me, storeItem, id, action, b){
  const tz = storeItem.timezone || DEFAULT_TZ, boss = me.acctType === 'pic' || me.isOwner === true, team = await calTeam(store);
  if(id && action === 'cancel'){
    if(!okId(id)) throw bad('Bad delegation.');
    const g = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: calPk(store), sk: 'CAL#deleg#' + id } })); if(!g.Item) throw new HttpError(404, 'No such delegation.');
    const d = JSON.parse(g.Item.j);
    if(!(d.fromSub === me.sk || boss)) throw forbidden('The person who gave it, the pharmacist in charge or the Account Owner can cancel a delegation.');
    if(d.canceled) return { ok: true };
    d.canceled = { by: who(me), at: now() };
    await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: calPk(store), sk: 'CAL#deleg#' + id, j: JSON.stringify(d), updatedAt: now(), updatedBy: who(me) } }));
    await calLog(store, me, 'Delegation Cancelled', `${d.fromName} to ${d.toName} (${d.step === 'dp' ? 'Designated Person review' : 'final approval'})`);
    return { ok: true };
  }
  if(id) throw new HttpError(404, 'Not found');
  const step = b.step === 'dp' || b.step === 'final' ? b.step : ''; if(!step) throw bad('Pick the step: Designated Person review or final approval.');
  const forSub = b.for && b.for !== me.sk ? String(b.for) : me.sk;
  if(forSub !== me.sk){ if(!boss) throw forbidden('Only the pharmacist in charge or the Account Owner sets a delegation for someone else.'); if(!String(b.reason || '').trim()) throw bad('A reason is required when you set it for someone else.'); }
  const from = team.find(p => p.sub === forSub); if(!from) throw bad('Pick the person from this pharmacy.');
  const fromOwnerPharm = from.ownerStores && from.ownerStores[store] === true && storeItem.ownerIsPic !== false;
  let chapters = Array.isArray(b.chapters) ? b.chapters.map(String).filter(c => CHAPTERS.includes(c)) : [];
  if(step === 'dp'){ if(!CHAPTERS.some(c => dpHolds(from, c))) throw bad('Only a Designated Person gives away the review step.'); if(chapters.some(c => !dpHolds(from, c))) throw bad('Pick only chapters this person holds.'); if(!chapters.length) chapters = CHAPTERS.filter(c => dpHolds(from, c)); }
  else if(!(from.acctType === 'pic' || fromOwnerPharm || (from.approver === true && (from.acctType === 'pharmacist' || from.acctType === 'pic')))) throw bad('Only a final approver gives away final approval.');
  const to = team.find(p => p.sub === String(b.to || '')); if(!to) throw bad('Pick who covers, from this pharmacy.');
  if(to.sub === from.sub) throw bad('Pick someone else.');
  const toOk = step === 'final' ? (to.acctType === 'pic' || to.acctType === 'pharmacist' || (to.ownerStores && to.ownerStores[store] === true && storeItem.ownerIsPic !== false)) : (to.acctType === 'pic' || to.acctType === 'pharmacist' || to.acctType === 'tech');
  if(!toOk) throw bad(step === 'final' ? 'Final approval can be given only to a pharmacist.' : 'The review can be given only to a pharmacist or a technician.');
  const sp = spanOf(tz, b);
  const d = { id: 'd' + crypto.randomBytes(5).toString('hex'), step, chapters, fromSub: from.sub, fromName: from.name || from.login, toSub: to.sub, toName: to.name || to.login, ...sp, tz, createdBy: who(me), createdAt: now(), ...(forSub !== me.sk ? { reason: String(b.reason).trim().slice(0, 300) } : {}) };
  await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: calPk(store), sk: 'CAL#deleg#' + d.id, j: JSON.stringify(d), updatedAt: d.createdAt, updatedBy: who(me) } }));
  await calLog(store, me, 'Delegation Set', `${d.fromName} to ${d.toName} (${step === 'dp' ? 'Designated Person review' : 'final approval'}), ${fmtLocal(d.startMs, tz)} to ${fmtLocal(d.endMs, tz)}${d.reason ? '. Reason: ' + d.reason : ''}`);
  return { ok: true, id: d.id };
}
async function calTimeOff(store, me, storeItem, id, action, b){
  const tz = storeItem.timezone || DEFAULT_TZ, boss = me.acctType === 'pic' || me.isOwner === true, team = await calTeam(store);
  if(id && action === 'cancel'){
    if(!okId(id)) throw bad('Bad entry.');
    const g = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: calPk(store), sk: 'CAL#toff#' + id } })); if(!g.Item) throw new HttpError(404, 'No such entry.');
    const d = JSON.parse(g.Item.j);
    if(!(d.sub === me.sk || boss)) throw forbidden('The person, the pharmacist in charge or the Account Owner can remove time off.');
    d.canceled = { by: who(me), at: now() };
    await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: calPk(store), sk: 'CAL#toff#' + id, j: JSON.stringify(d), updatedAt: now(), updatedBy: who(me) } }));
    return { ok: true };
  }
  if(id) throw new HttpError(404, 'Not found');
  const forSub = b.for && b.for !== me.sk ? String(b.for) : me.sk;
  if(forSub !== me.sk && !boss) throw forbidden('Only the pharmacist in charge or the Account Owner adds time off for someone else.');
  const p = team.find(x => x.sub === forSub); if(!p) throw bad('Pick the person from this pharmacy.');
  const sp = spanOf(tz, b);
  const d = { id: 't' + crypto.randomBytes(5).toString('hex'), sub: p.sub, name: p.name || p.login, ...sp, tz, createdBy: who(me), createdAt: now() };
  await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: calPk(store), sk: 'CAL#toff#' + d.id, j: JSON.stringify(d), updatedAt: d.createdAt, updatedBy: who(me) } }));
  const covers = CHAPTERS.some(c => dpHolds(p, c)) || p.acctType === 'pic' || p.approver === true;
  return { ok: true, id: d.id, promptDelegation: covers };           // a Designated Person or an approver is asked to name who covers
}
// ---- records are never deleted (39.2): approved records are locked, the approver reopens or voids them, every version stays
const canon = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(y => [y, x[y]])) : x);
const recBody = v => { const c = { ...v }; for(const k of ['review', 'versions', 'void']) delete c[k]; return c; };
const VOID_TYPES = { duplicate: 'Duplicate record', nottask: 'Entered when no task was done' };
const EXC_TYPES = ['temperature', 'environmental', 'other'];
const isDateStr = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
function excClean(o, prev, me){
  if(prev && prev.status === 'closed'){ if(canon(prev) === canon(o)) return prev; throw forbidden('This record is closed and kept as it is.'); }
  const kind = String(o.kind || ''); if(kind !== 'excursion' && kind !== 'missed') throw bad('Pick the kind: excursion or missed entry.');
  if(prev && prev.kind !== kind) throw bad('The kind can’t be changed.');
  const t = (v, max, req, label) => { v = String(v == null ? '' : v).trim().slice(0, max); if(req && v.length < 3) throw bad(label + ' is required.'); return v; };
  const c = { id: o.id, kind, status: 'open', date: isDateStr(o.date) ? o.date : (() => { throw bad('Pick the date.'); })(), what: t(o.what, 200, true, 'What it concerns'), detail: t(o.detail, 1000, false), handling: t(o.handling, 1000, true, 'How it was handled'), refId: o.refId && okId(o.refId) ? String(o.refId) : '', track: t(o.track, 200, false) };
  if(kind === 'excursion'){ c.type = EXC_TYPES.includes(o.type) ? o.type : 'other'; }
  else { if(!c.track) throw bad('Pick the task that was missed.'); if(!isDateStr(o.forDue)) throw bad('Pick the due date that was missed.'); c.forDue = o.forDue; }
  c.createdBy = prev ? prev.createdBy : who(me); c.createdAt = prev ? prev.createdAt : now(); if(prev) c.updatedBy = who(me);
  return c;
}
async function calRecordAct(store, me, storeItem, rid, action, b){
  if(!okId(rid)) throw bad('Bad record.');
  const sk = 'CAL#records#' + rid, g = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: calPk(store), sk } })); if(!g.Item) throw new HttpError(404, 'No such record.');
  const prev = JSON.parse(g.Item.j), ch = chapterOf(String(prev.track || '').split('|')[0]), atMs = Date.now();
  const delegs = await calSide(store, 'deleg'), R = stepRights(me, storeItem.ownerIsPic, ch, delegs, atMs).final;
  if(!R) throw forbidden('Only the approver (the pharmacist in charge, or a pharmacist the PIC named) reopens or voids a record.');
  if(prev.status === 'void') throw bad('This record is already voided.');
  const stamp = now(), reason = String(b.reason || b.note || '').trim().slice(0, 500), who_ = who(me), behalf = R.own ? {} : { onBehalfOf: R.deleg.fromName, delegId: R.deleg.id };
  const snap = { at: stamp, by: who_, rec: recBody(prev), review: prev.review || null };
  const versions = (Array.isArray(prev.versions) ? prev.versions : []).slice(-19).concat([snap]);
  if(action === 'reopen'){
    if(!(prev.review && prev.review.status === 'accepted')) throw bad('Only an approved record is reopened. A record that is not approved can still be corrected.');
    if(reason.length < 5) throw bad('Say why the record is reopened.');
    const sign = await signAs(me, b, 'Reopened');
    const reopens = (Array.isArray(prev.review.reopens) ? prev.review.reopens : []).slice(-9).concat([{ at: stamp, by: who_, byId: me.sk, reason, sign, wasApprovedBy: prev.review.by, wasApprovedAt: prev.review.at, sameAsApprover: prev.review.byId === me.sk, ...behalf }]);
    const rv = { status: 'pending', since: stamp, hist: (Array.isArray(prev.review.hist) ? prev.review.hist : []).slice(-39), reopens };
    const next = { ...prev, review: rv, versions }; if(Buffer.byteLength(JSON.stringify(next)) > CAL_MAX_BYTES) throw bad('This record has too many versions to reopen again. Ask IronLedger.');
    await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: calPk(store), sk, j: JSON.stringify(next), updatedAt: stamp, updatedBy: who_ } }));
    await calLog(store, me, 'Record Reopened', `${prev.track} (${prev.completedOn || ''}): ${reason}`);
    return { ok: true, status: 'pending' };
  }
  if(action === 'void'){
    const type = String(b.type || ''); if(!VOID_TYPES[type]) throw bad('Pick the reason for the void.');
    if(reason.length < 5) throw bad('Write a short note with the reason.');
    let origId = '';
    if(type === 'duplicate'){
      origId = String(b.origId || ''); if(!okId(origId) || origId === rid) throw bad('Pick the original record this one duplicates.');
      const og = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: calPk(store), sk: 'CAL#records#' + origId } })); if(!og.Item) throw bad('The original record has to exist.');
      const o = JSON.parse(og.Item.j); if(o.status === 'void') throw bad('The original record has been voided.'); if(o.track !== prev.track) throw bad('The original has to be for the same task.');
    }
    const excs = await calSide(store, 'exc'); if(excs.some(e => e.refId === rid)) throw forbidden('An excursion refers to this record, so it can’t be voided.');
    const sign = await signAs(me, b, 'Voided');
    const next = { ...prev, status: 'void', void: { type, label: VOID_TYPES[type], note: reason, origId, by: who_, byId: me.sk, at: stamp, sign, ...behalf }, versions };
    await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: calPk(store), sk, j: JSON.stringify(next), updatedAt: stamp, updatedBy: who_ } }));
    await calLog(store, me, 'Record Voided', `${prev.track} (${prev.completedOn || ''}): ${VOID_TYPES[type]}. ${reason}`);
    return { ok: true, status: 'void' };
  }
  throw new HttpError(404, 'Not found');
}
async function calExcAct(store, me, storeItem, id, action, b){
  if(!okId(id) || action !== 'close') throw new HttpError(404, 'Not found');
  const sk = 'CAL#exc#' + id, g = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: calPk(store), sk } })); if(!g.Item) throw new HttpError(404, 'No such record.');
  const prev = JSON.parse(g.Item.j); if(prev.status === 'closed') throw bad('Already closed.');
  const R = stepRights(me, storeItem.ownerIsPic, '', await calSide(store, 'deleg'), Date.now()).final; if(!R) throw forbidden('Only the approver closes an excursion or a missed entry.');
  const rec = String(b.reconciliation || '').trim().slice(0, 1000); if(rec.length < 5) throw bad('Write how it was reconciled.');
  const sign = await signAs(me, b, 'Closed'), stamp = now();
  const next = { ...prev, status: 'closed', closed: { by: who(me), byId: me.sk, at: stamp, reconciliation: rec, sign, ...(R.own ? {} : { onBehalfOf: R.deleg.fromName }) } };
  await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: calPk(store), sk, j: JSON.stringify(next), updatedAt: stamp, updatedBy: who(me) } }));
  await calLog(store, me, prev.kind === 'missed' ? 'Missed Entry Closed' : 'Excursion Closed', `${prev.what}: ${rec}`);
  return { ok: true };
}
async function calCommit(store, me, b, storeItem){
  if(me.acctType === 'staff' && !me.host && !me.isOwner) throw forbidden('Your role can view the calendar. A technician or pharmacist enters tasks.');
  const config = b.config && typeof b.config === 'object' ? b.config : {}, put = b.put || {}, del = b.del || {};
  const writes = [], deletes = [];
  for(const k of Object.keys(config)){ if(!CAL_CFG.includes(k)) throw bad('Unknown calendar setting: ' + k); writes.push({ sk: 'CAL#cfg#' + k, v: config[k] }); }
  for(const c of Object.keys(put)){
    if(!CAL_COLLS.includes(c)) throw bad('Unknown calendar list: ' + c);
    if(!Array.isArray(put[c])) throw bad('Bad calendar list.');
    for(const o of put[c]){
      if(!o || typeof o !== 'object' || !okId(o.id)) throw bad('Every calendar item needs an id.');
      if(c === 'records' && o.status !== 'void' && !calMayComplete(me, String(o.track || '').split('|')[0])) throw forbidden('Your role can’t complete that task. You can see it on the calendar; a pharmacist or the responsible person finishes it.');
      if(c === 'records' && o.task && o.task.files !== undefined){
        if(!Array.isArray(o.task.files) || o.task.files.length > 30) throw bad('Too many attached files.');
        o.task.files = o.task.files.map(f => { if(!f || !TASK_FILE_RE.test(String(f.id || ''))) throw bad('An attached file was not uploaded here. Attach it again.'); return { id: f.id, name: String(f.name || 'file').slice(0, 160), size: Number(f.size) || 0, type: String(f.type || '').slice(0, 60), by: String(f.by || '').slice(0, 80), at: String(f.at || '').slice(0, 40) }; });
      }
      writes.push({ sk: `CAL#${c}#${o.id}`, v: o, rec: c === 'records', exc: c === 'exc' });
    }
  }
  const recW = writes.filter(w => w.rec);
  if(recW.length){                                                       // the approval chain and the record locks, decided here and not on the screen
    const stampC = now(), team = await calTeam(store), delegs = await calSide(store, 'deleg'), skip = new Set();
    for(const w of recW){
      let prev = null; const g = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: calPk(store), sk: w.sk } }));
      if(g.Item){ try{ prev = JSON.parse(g.Item.j); }catch(e){} }
      if(prev && prev.status === 'void'){ if(canon(prev) === canon(w.v)){ skip.add(w); continue; } throw forbidden('This record was voided. It is kept for good and can’t be changed.'); }
      if(w.v.status === 'void') throw forbidden('Only the approver voids a record, from the record itself.');
      if(prev && prev.review && prev.review.status === 'accepted' && canon(recBody(prev)) !== canon(recBody(w.v))) throw forbidden('This record is approved and locked. The approver reopens it to correct it.');
      delete w.v.void; if(prev && prev.versions) w.v.versions = prev.versions; else delete w.v.versions;
      const rv = await calChain(store, me, storeItem || {}, w.v, prev, team, delegs, stampC);
      if(rv === null) delete w.v.review; else w.v.review = JSON.parse(JSON.stringify(rv));
      const pr = prev && prev.review;
      if(w.v.review && pr && pr.reopens && !w.v.review.reopens) w.v.review.reopens = pr.reopens;
      if(w.v.review && w.v.review.status === 'accepted' && pr && pr.status !== 'accepted' && Array.isArray(w.v.review.reopens) && w.v.review.reopens.length){   // reapproved after a reopen
        const last = w.v.review.reopens[w.v.review.reopens.length - 1]; if(!last.reapproved) last.reapproved = { by: who(me), byId: me.sk, at: stampC, same: last.byId === me.sk };
      }
    }
    for(let i = writes.length - 1; i >= 0; i--) if(skip.has(writes[i])) writes.splice(i, 1);
  }
  for(const w of writes.filter(x => x.exc)){                             // excursion and missed-entry records: their own kind, never deleted, closed only by the approver
    let prev = null; const g = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: calPk(store), sk: w.sk } }));
    if(g.Item){ try{ prev = JSON.parse(g.Item.j); }catch(e){} }
    w.v = excClean(w.v, prev, me);
  }
  for(const c of Object.keys(del)){
    if(!CAL_COLLS.includes(c)) throw bad('Unknown calendar list: ' + c);
    if(c === 'log') throw forbidden('The activity log is add-only.');
    if(c === 'records' || c === 'exc') throw forbidden('Records are never deleted. A mistake is reopened or voided by the approver, and everything stays on file.');
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
    return { id: d.id, title: d.title, type: d.type, area: d.area, sub: d.sub || '', format: d.format, chapter: d.chapter || '', versions: [{ v: c.v, state: 'current', effective: c.effective, at: c.at, hasFile: !!c.file }], retired: false, underReview: false, cycle: 0, lastReviewed: '', reviews: [], basis: '', notes: '', rev: d.rev };
  }
  const o = { id: d.id, title: d.title, type: d.type, area: d.area, sub: d.sub || '', format: d.format, chapter: d.chapter || '', audience: d.audience || [], cycle: d.cycle || 0, basis: d.basis || '', notes: d.notes || '', underReview: !!d.underReview, retired: !!d.retired, rev: d.rev,
    versions: (d.versions || []).map(v => ({ v: v.v, state: v.state, effective: v.effective || '', at: v.at || '', summary: v.summary || '', by: v.by || '', approvedBy: v.approvedBy || '', approvedIni: v.approvedIni || '', selfApproved: !!v.selfApproved, fileName: v.file ? v.file.name : '', hasFile: !!v.file, dpReview: v.dpReview ? { by: v.dpReview.by, at: v.dpReview.at, ini: v.dpReview.ini || '' } : null })) };
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
// me.pharm is set once the caller is seen inside one pharmacy (pharmFn): a staff pharmacist or the PIC, or the Account Owner only where IronLedger recorded that the owner is the PIC.
const rxPharmacist = me => !me.host && !!me.pharm;
function rxGate(me, storeItem){
  if(suiteStore(storeItem.sk)){ if(!suiteUser(me, storeItem.sk)) throw forbidden('Rx Intake is limited to the named users for this pharmacy.'); }
  else if(storeItem.rx === false) throw forbidden('Rx Intake is switched off for this pharmacy.');
  if(!rxPharmacist(me)) throw forbidden('Only a pharmacist can use Rx Intake.');
}
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
  const people = (await listPeople()).filter(p => !p.employeeOnly && ((p.stores || {})[store] === true || (p.ownerStores || {})[store] === true || (p.adminStores || {})[store] === true));
  const ownerP = p => (p.ownerStores || {})[store] === true, ownerPic = storeItem.ownerIsPic !== false;
  const isRph = p => p.acctType === 'pharmacist' || p.acctType === 'pic' || (ownerP(p) && ownerPic);
  const me2 = people.find(p => p.sub === me.sk) || {};
  const receiving = isRph(me2) && me2.license ? { name: RX_NAME(me2), license: me2.license } : null;
  const picP = (storeItem.picLogin && people.find(p => p.login === storeItem.picLogin && p.license)) || people.find(p => p.acctType === 'pic' && p.license) || (ownerPic ? people.find(p => ownerP(p) && p.license) : null) || null;
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
// ---------- 39.2: task attachments, the Tasks folder, My Documents, Personnel Files, document audience and chapter, Designated Person review
// Single source: the Tasks folder and the personnel pages are views of the calendar records, licenses and logins; nothing is copied. Only uploaded scans (My Documents) are new files.
const TASK_MAX = 20 * 1024 * 1024;
const TASK_MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain', csv: 'text/csv', md: 'text/plain', json: 'application/json' };
const TASK_FILE_RE = /^[a-f0-9]{32}\.(pdf|png|jpg|jpeg|gif|webp|txt|csv|md|json)$/;
const TRAIN_RE = /(training|didactic|garb|media|competency|valid)/;
const MY_KINDS = { validation: 'Validation', license: 'License', training: 'Training', scan: 'Uploaded Scan', other: 'Other' };
const cleanChapter = v => { v = String(v == null ? '' : v); if(v !== '' && !CHAPTERS.includes(v)) throw bad('Chapter is 795, 797 or 800.'); return v; };
const dpStepOn = (d, team, cfg) => !!d.chapter && team.some(p => dpHolds(p, d.chapter) && !(cfg.dpOff || {})[p.sub]);       // a Designated Person reviews first when one is on and not switched off
const taskPerson = me => !!me && (me.owner === true || me.host === true || me.acctType === 'pic' || me.acctType === 'pharmacist' || me.acctType === 'tech');   // can enter or approve tasks
const anyDp = p => !!p && (p.acctType === 'pic' || p.acctType === 'pharmacist' || p.acctType === 'tech') && !!(p.dp && Object.values(p.dp).some(v => v === true));
async function docCfg(store){
  const r = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: docPk(store), sk: 'DOCCFG' } }));
  let c = {}; try{ c = r.Item ? JSON.parse(r.Item.j) : {}; }catch(e){}
  return { dpOff: c.dpOff || {}, persGrant: c.persGrant || {}, inspGrant: c.inspGrant || {} };
}
const docCfgPut = (store, c) => ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: docPk(store), sk: 'DOCCFG', j: JSON.stringify(c) } }));
const persRight = (me, cfg) => !!(me.owner || me.acctType === 'pic' || (cfg.persGrant || {})[me.sk] === true || anyDp(me));   // a ticked Designated Person box turns Personnel Files viewing on
function cleanAudience(v){
  if(v == null || v === '') return [];
  if(!Array.isArray(v)) throw bad('Bad audience.');
  const ok = ['pharmacist', 'tech', 'staff'];
  for(const t of Object.keys(SUBROLES)) for(const s of SUBROLES[t]) ok.push(t + ':' + s);
  const out = []; for(const x of v){ const k = String(x); if(!ok.includes(k)) throw bad('Pick the audience from the list.'); if(!out.includes(k)) out.push(k); }
  return out;
}
const audOk = (d, me, manage) => manage || me.owner || me.acctType === 'pic' || !(d.audience || []).length || d.audience.includes(me.acctType) || (me.subs || []).some(s => d.audience.includes((me.acctType || '') + ':' + s));
async function calTaskFile(method, store, seg, body, me){
  if(!taskPerson(me)) throw forbidden('Your role can view the calendar. A technician or pharmacist attaches files.');
  if(!DOCS_BUCKET) throw new HttpError(503, 'File storage is not set up yet. Run deploy.sh again.');
  if(method === 'POST' && seg[0] === 'upload-url'){
    const name = String(body.name || ''), size = Number(body.size), ext = (/\.([A-Za-z0-9]{2,4})$/.exec(name) || [])[1];
    if(!ext || !TASK_MIME[ext.toLowerCase()]) throw bad('PDF, images, and text or CSV files are supported.');
    if(!(size > 0) || size > TASK_MAX) throw bad('Each file must be under 20 MB.');
    const e = ext.toLowerCase(), id = crypto.randomBytes(16).toString('hex') + '.' + e, ct = TASK_MIME[e];
    return { id, url: presignS3({ method: 'PUT', bucket: DOCS_BUCKET, key: `${store}/tasks/${id}`, headers: { 'content-type': ct } }), headers: { 'content-type': ct } };
  }
  if(method === 'GET' && seg[0] === 'file' && seg[1]){
    const id = String(seg[1]); if(!TASK_FILE_RE.test(id)) throw bad('Bad file.');
    return { url: presignS3({ method: 'GET', bucket: DOCS_BUCKET, key: `${store}/tasks/${id}`, query: { 'response-content-disposition': 'inline' } }), seconds: DOC_LINK_SECONDS };
  }
  throw new HttpError(404, 'Not found');
}
async function calRecordsAll(store){
  const items = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p AND begins_with(sk, :c)', ExpressionAttributeValues: { ':p': calPk(store), ':c': 'CAL#records#' } });
  const out = []; for(const it of items){ try{ out.push(JSON.parse(it.j)); }catch(e){} } return out;
}
const recView = r => { const rv = r.review || {}, [ob, subj] = String(r.track || '').split('|');
  return { id: r.id, obId: ob, type: r.title || ob, subject: subj || '', date: r.completedOn || '', performedBy: r.completedBy || '', completedBy: r.by || '', result: r.result || '',
    approvedBy: rv.status === 'accepted' ? (rv.by || '') : '', approvedAt: rv.status === 'accepted' ? (rv.at || '') : '', status: r.status === 'void' ? 'void' : (rv.status || ''), dpBy: (rv.dp && rv.dp.by) || '', corrected: !!(rv.reopens && rv.reopens.length) }; };
async function docTasks(store, me){
  if(!taskPerson(me)) throw forbidden('The Tasks folder is for people who enter or approve tasks.');
  const recs = (await calRecordsAll(store)).filter(r => r.status !== 'void' && r.task && Array.isArray(r.task.files) && r.task.files.length);
  const folders = {};
  for(const r of recs){ const v = recView(r); (folders[v.obId] = folders[v.obId] || { key: v.obId, title: v.type, entries: [] }).entries.push({ ...v, files: r.task.files.map(f => ({ id: f.id, name: f.name, size: f.size, by: f.by || '', at: f.at || '' })) }); }
  const out = Object.values(folders).sort((a, b) => a.title.localeCompare(b.title));
  for(const f of out) f.entries.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return { folders: out };
}
async function myDocsOf(store, sub){
  const items = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': docPk(store), ':s': 'MYDOC#' + sub + '#' } });
  const out = []; for(const it of items){ try{ out.push(JSON.parse(it.j)); }catch(e){} }
  return out.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
}
async function personRecords(store, p){                              // training and validation task records for one person, read from the calendar
  const cfg = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: calPk(store), sk: 'CAL#cfg#people' } }));
  let people = []; try{ people = cfg.Item ? JSON.parse(cfg.Item.j) : []; }catch(e){}
  const nm = String(p.name || p.login || '').toLowerCase(), cp = (Array.isArray(people) ? people : []).find(x => x && (x.sub === p.sub || String(x.name || '').toLowerCase() === nm));
  return (await calRecordsAll(store)).filter(r => r.status !== 'void' && TRAIN_RE.test(String(r.track || '').split('|')[0]) &&
    ((cp && String(r.track || '').split('|')[1] === cp.id) || String(r.completedBy || '').toLowerCase() === nm)).map(recView).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}
const persLine = p => ({ sub: p.sub, name: p.name || p.login, acctType: p.acctType || '', subs: p.subs || [], dp: p.dp || {}, license: p.license || '', licExpires: p.licExpires || '' });   // compliance data only: no address, phone, email, birth date or pay
async function persDetail(store, sub){
  const p = (await calTeam(store)).find(x => x.sub === sub); if(!p) throw new HttpError(404, 'No such person here.');
  return { person: persLine(p), uploads: await myDocsOf(store, sub), records: await personRecords(store, p) };
}
async function docsExtra(method, store, id, seg, q, body, me, storeItem){      // returns undefined when the path is not one of these
  const cfg = await docCfg(store), boss = !!(me.owner || me.acctType === 'pic');
  if(id === 'tasks'){
    if(method === 'GET' && !seg[1]) return await docTasks(store, me);
    if(method === 'GET' && seg[1] === 'file' && seg[2]){ if(!taskPerson(me)) throw forbidden(); return await calTaskFile('GET', store, ['file', seg[2]], {}, me); }
  }
  if(id === 'mine'){
    if(method === 'GET' && !seg[1]){
      const rec = await personRecords(store, { sub: me.sk, name: me.name, login: me.login });
      return { uploads: await myDocsOf(store, me.sk), records: rec, license: { number: me.license || '', expires: me.licExpires || '' }, kinds: MY_KINDS };
    }
    if(method === 'POST' && seg[1] === 'upload-url'){
      const name = String(body.name || ''), size = Number(body.size);
      if(!/\.pdf$/i.test(name)) throw bad('Only PDF files are accepted.'); if(!(size > 0) || size > DOC_MAX_BYTES) throw bad('The PDF must be under 25 MB.');
      const key = `${store}/files/${crypto.randomBytes(16).toString('hex')}.pdf`;
      return { key, url: presignS3({ method: 'PUT', bucket: DOCS_BUCKET, key, headers: { 'content-type': 'application/pdf' } }), headers: { 'content-type': 'application/pdf' } };
    }
    if(method === 'POST' && !seg[1]){
      const title = String(body.title || '').trim().slice(0, 200); if(!title) throw bad('Enter a title.');
      const kind = String(body.kind || ''); if(!MY_KINDS[kind]) throw bad('Pick the kind from the list.');
      const f = body.file && typeof body.file === 'object' ? body.file : null; if(!f) throw bad('Choose the PDF file.');
      const { size } = await docIo(store, f.key);
      const mid = 'm' + crypto.randomBytes(6).toString('hex'), o = { id: mid, owner: me.sk, title, kind, at: now(), by: who(me), file: { key: f.key, name: String(f.name || 'document.pdf').slice(0, 160), size } };
      await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: docPk(store), sk: `MYDOC#${me.sk}#${mid}`, j: JSON.stringify(o) } }));
      return { ok: true, id: mid };
    }
    if(method === 'GET' && seg[2] === 'file'){
      const r = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: docPk(store), sk: `MYDOC#${me.sk}#${String(seg[1])}` } })); if(!r.Item) throw new HttpError(404, 'No such document.');
      const o = JSON.parse(r.Item.j);
      return { url: presignS3({ method: 'GET', bucket: DOCS_BUCKET, key: o.file.key, query: { 'response-content-type': 'application/pdf', 'response-content-disposition': 'inline' } }), name: o.file.name, seconds: DOC_LINK_SECONDS };
    }
    if(method === 'POST' && seg[2] === 'remove'){
      const r = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: docPk(store), sk: `MYDOC#${me.sk}#${String(seg[1])}` } })); if(!r.Item) throw new HttpError(404, 'No such document.');
      const o = JSON.parse(r.Item.j); if(o.addedBy) throw forbidden('This was added by the Account Owner. Ask them to remove it.');
      await ddb.send(new DeleteCommand({ TableName: MAIN, Key: { pk: docPk(store), sk: `MYDOC#${me.sk}#${String(seg[1])}` } })); await docLog(store, me, 'My Document Removed', '', o.title);
      return { ok: true };
    }
  }
  if(id === 'personnel'){
    if(!persRight(me, cfg)) throw forbidden('Personnel Files is open to the Pharmacist-In-Charge, the Account Owner, and people they allow.');
    if(method === 'GET' && !seg[1]){ const team = await calTeam(store); await docLog(store, me, 'Personnel Files Opened', '', ''); return { people: team.map(persLine).sort((a, b) => a.name.localeCompare(b.name)), canAdd: !!me.owner, canGrant: boss }; }
    if(method === 'GET' && seg[1] && !seg[2]){ const d = await persDetail(store, seg[1]); await docLog(store, me, 'Personnel File Viewed', '', d.person.name); return { ...d, canAdd: !!me.owner }; }
    if(method === 'GET' && seg[2] === 'file' && seg[3]){
      const r = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: docPk(store), sk: `MYDOC#${seg[1]}#${String(seg[3])}` } })); if(!r.Item) throw new HttpError(404, 'No such document.');
      const o = JSON.parse(r.Item.j); await docLog(store, me, 'Personnel Document Opened', '', o.title + ' (' + seg[1] + ')');
      return { url: presignS3({ method: 'GET', bucket: DOCS_BUCKET, key: o.file.key, query: { 'response-content-type': 'application/pdf', 'response-content-disposition': 'inline' } }), name: o.file.name, seconds: DOC_LINK_SECONDS };
    }
    if(method === 'POST' && seg[2] === 'upload-url'){ if(!me.owner) throw forbidden('Only the Account Owner adds material to a personnel file.');
      const name = String(body.name || ''), size = Number(body.size); if(!/\.pdf$/i.test(name)) throw bad('Only PDF files are accepted.'); if(!(size > 0) || size > DOC_MAX_BYTES) throw bad('The PDF must be under 25 MB.');
      const key = `${store}/files/${crypto.randomBytes(16).toString('hex')}.pdf`;
      return { key, url: presignS3({ method: 'PUT', bucket: DOCS_BUCKET, key, headers: { 'content-type': 'application/pdf' } }), headers: { 'content-type': 'application/pdf' } };
    }
    if(method === 'POST' && seg[2] === 'add'){
      if(!me.owner) throw forbidden('Only the Account Owner adds material to a personnel file.');
      const p = (await calTeam(store)).find(x => x.sub === seg[1]); if(!p) throw new HttpError(404, 'No such person here.');
      const title = String(body.title || '').trim().slice(0, 200); if(!title) throw bad('Enter a title.');
      const kind = String(body.kind || 'other'); if(!MY_KINDS[kind]) throw bad('Pick the kind from the list.');
      const f = body.file && typeof body.file === 'object' ? body.file : null; if(!f) throw bad('Choose the PDF file.');
      const { size } = await docIo(store, f.key);
      const mid = 'm' + crypto.randomBytes(6).toString('hex'), o = { id: mid, owner: p.sub, title, kind, at: now(), by: who(me), addedBy: who(me), file: { key: f.key, name: String(f.name || 'document.pdf').slice(0, 160), size } };
      await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: docPk(store), sk: `MYDOC#${p.sub}#${mid}`, j: JSON.stringify(o) } }));
      await docLog(store, me, 'Personnel Material Added', '', title + ' for ' + (p.name || p.login)); return { ok: true, id: mid };
    }
  }
  if(id === 'grants' && method === 'POST'){                           // who may open Personnel Files, and who skips the Designated Person step on documents
    if(!boss) throw forbidden('Only the Pharmacist-In-Charge or the Account Owner can change this.');
    const sub = String(body.sub || ''), team = await calTeam(store), p = team.find(x => x.sub === sub); if(!p) throw bad('Pick a person.');
    if(typeof body.on !== 'boolean') throw bad('Bad setting.');
    if(body.what === 'personnel'){ cfg.persGrant[sub] = body.on; if(!body.on) delete cfg.persGrant[sub]; await docCfgPut(store, cfg); await docLog(store, me, body.on ? 'Personnel Files Granted' : 'Personnel Files Removed', '', p.name || p.login); return { ok: true }; }
    if(body.what === 'inspector'){ cfg.inspGrant = cfg.inspGrant || {}; if(body.on) cfg.inspGrant[sub] = true; else delete cfg.inspGrant[sub]; await docCfgPut(store, cfg); await docLog(store, me, body.on ? 'Inspector Link Granted' : 'Inspector Link Grant Removed', '', p.name || p.login); return { ok: true }; }
    if(body.what === 'dpoff'){ if(!anyDp(p)) throw bad('That person is not a Designated Person.'); if(body.on) cfg.dpOff[sub] = true; else delete cfg.dpOff[sub]; await docCfgPut(store, cfg); await docLog(store, me, body.on ? 'Document Review Switched Off' : 'Document Review Switched On', '', p.name || p.login); return { ok: true }; }
    throw bad('Bad setting.');
  }
  if(id === 'grants' && method === 'GET'){ if(!boss) throw forbidden(); return { personnel: cfg.persGrant, dpOff: cfg.dpOff, inspector: cfg.inspGrant }; }
  if(id === 'notifycfg'){ if(!boss) throw forbidden('Only the Pharmacist-In-Charge or the Account Owner can change this.');
    if(method === 'GET') return await notifyCfg(store);
    const h = Number(body.firstHours); if(!Number.isInteger(h) || h < 1 || h > 720) throw bad('Enter whole hours from 1 to 720.');
    await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: docPk(store), sk: 'NOTIFYCFG', j: JSON.stringify({ firstHours: h }) } })); await docLog(store, me, 'Notification Timing Changed', '', `first message after ${h} hours`); return { ok: true }; }
  if(id === 'hostlog' && method === 'GET'){ if(!boss) throw forbidden('Only the Pharmacist-In-Charge or the Account Owner can see this.');
    const ev = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': docPk(store), ':s': 'HOSTLOG#' }, ScanIndexForward: false, Limit: 500 });
    return { log: ev.map(e => { try{ return JSON.parse(e.j); }catch(x){ return null; } }).filter(Boolean) }; }
  return undefined;
}
// ---------- 39.2: notifications. Everything stays visible in the app (Dashboard, Documents). On top of that, a person may opt in to email and/or text (none ticked = app only).
// Rules: a first message once an item has waited on that person's step for 72 hours (per pharmacy adjustable), sent only while the pharmacy is open and with generic wording
// (never a patient, drug or task name); an urgent message after 2 hours for an open temperature or environmental excursion or a missed required entry, at any hour, to the people
// on that step who opted in; one message to the Pharmacist-In-Charge at 96 hours for a Designated Person review still waiting. A person gets at most one message per run, the urgent
// one first, and an item is never announced twice to the same person. Sending needs IronLedger's business email and text sender (NOTIFY_FROM, NOTIFY_SMS); until then nothing is sent.
const NOTIFY_FROM = process.env.NOTIFY_FROM || '', NOTIFY_SMS = process.env.NOTIFY_SMS === '1', NOTIFY_TEST = process.env.NOTIFY_TEST === '1';
const NOTIFY_DEF = { firstHours: 72, urgentHours: 2, picHours: 96 };
async function notifyCfg(store){
  const r = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: docPk(store), sk: 'NOTIFYCFG' } })); let c = {}; try{ c = r.Item ? JSON.parse(r.Item.j) : {}; }catch(e){}
  return { ...NOTIFY_DEF, ...(Number.isFinite(c.firstHours) ? { firstHours: c.firstHours } : {}) };
}
// Federal holidays by year (5 U.S.C. 6103), computed from the weekday rules so they follow the calendar every year: the same dates the Calendar page uses.
// A pharmacy that closes on a holiday is closed on its legal date, and a Sunday holiday is also observed (closed) on the Monday after. A Saturday holiday does not close the Friday before.
export const FED_DEFAULT = ['newyear', 'memorial', 'july4', 'labor', 'thanks', 'xmas'];
const nthWd = (y, m, dow, n) => { const f = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); return 1 + ((dow - f + 7) % 7) + 7 * (n - 1); };
const lastWd = (y, m, dow) => { const dim = new Date(Date.UTC(y, m, 0)).getUTCDate(), l = new Date(Date.UTC(y, m - 1, dim)).getUTCDay(); return dim - ((l - dow + 7) % 7); };
export function fedDates(y){
  const d = (m, dd) => `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const L = [['newyear', d(1, 1)], ['mlk', d(1, nthWd(y, 1, 1, 3))], ['presidents', d(2, nthWd(y, 2, 1, 3))], ['memorial', d(5, lastWd(y, 5, 1))]];
  if(y >= 2021) L.push(['juneteenth', d(6, 19)]);
  L.push(['july4', d(7, 4)], ['labor', d(9, nthWd(y, 9, 1, 1))], ['columbus', d(10, nthWd(y, 10, 1, 2))], ['veterans', d(11, 11)], ['thanks', d(11, nthWd(y, 11, 4, 4))], ['xmas', d(12, 25)]);
  return L;
}
export function holidayClosed(storeItem, ymd){                              // the id of the federal holiday this pharmacy is closed for on that date, or ''
  const y = +ymd.slice(0, 4), shut = Array.isArray(storeItem.holClosed) ? storeItem.holClosed : FED_DEFAULT;
  for(const [id, date] of fedDates(y)){ if(!shut.includes(id)) continue;
    if(date === ymd) return id;
    if(new Date(date + 'T00:00:00Z').getUTCDay() === 0){ const n = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10); if(n === ymd) return id; } }
  return '';
}
function openAt(storeItem, ms){                                           // is the pharmacy open at this moment (its own time zone, weekly hours, closed days)?
  const tz = storeItem.timezone || DEFAULT_TZ, h = Array.isArray(storeItem.hours) && storeItem.hours.length === 7 ? storeItem.hours : null; if(!h) return true;
  try{
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    if((((storeItem.closures || {}).days) || []).includes(`${p.year}-${p.month}-${p.day}`)) return false;
    if(holidayClosed(storeItem, `${p.year}-${p.month}-${p.day}`)) return false;
    const d = h[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)]; if(!d || !d.o || !d.c) return false;
    const t = `${p.hour}:${p.minute}`; return d.o <= t && t < d.c;
  }catch(e){ return true; }
}
const wantsNotice = p => !!(p && p.notify && (p.notify.email === true || p.notify.text === true));
// pure: who gets which message now. team = people at the pharmacy (profiles); recs/exc/docs = calendar records, open exceptions and documents; sent = markers already used
export function notifyPlan({ store, storeItem, team, recs, exc, docs, cfg, nowMs, sent, dpOff = {} }){
  const hrs = ts => (nowMs - (typeof ts === 'number' ? ts : Date.parse(ts))) / 3600000, ownerIsPic = storeItem.ownerIsPic;
  const mem = team.map(p => ({ ...p, isOwner: (p.ownerStores || {})[store] === true }));
  const finals = mem.filter(p => finalRole(p, ownerIsPic)), dps = ch => mem.filter(p => dpHolds(p, ch)), pics = mem.filter(p => p.acctType === 'pic' || (p.isOwner && ownerIsPic !== false));
  const need = new Map(), add = (people, kind, key) => { for(const p of people){ if(!wantsNotice(p) || p.disabled || p.deleted) continue; const k = key + '#' + p.sub; if(sent.has(k)) continue; const e = need.get(p.sub) || { sub: p.sub, kinds: new Set(), keys: [] }; e.kinds.add(kind); e.keys.push(k); need.set(p.sub, e); } };
  for(const r of recs){ if(r.status === 'void' || !r.review) continue; const st = r.review.status, since = r.review.since, ch = chapterOf(String(r.track || '').split('|')[0]); if(!since) continue;
    if(st === 'dp'){ if(hrs(since) >= cfg.firstHours) add(dps(ch), 'waiting', `rec:${r.id}:dp:first`); if(hrs(since) >= cfg.picHours) add(pics, 'pic', `rec:${r.id}:dp:pic`); }
    if(st === 'pending' && hrs(since) >= cfg.firstHours) add(finals, 'waiting', `rec:${r.id}:final:first`); }
  for(const e of exc){ if(e.status === 'closed' || !(e.kind === 'excursion' || e.kind === 'missed') || !e.createdAt) continue; if(hrs(e.createdAt) >= cfg.urgentHours){ add(finals, 'urgent', `exc:${e.id}:urgent`); add(dps(chapterOf(String(e.track || '').split('|')[0])), 'urgent', `exc:${e.id}:urgent`); } }
  for(const d of docs){ const pend = docPend(d), cur = docCur(d); if(!pend || d.retired) continue; const ts = pend.ts || (pend.at ? pend.at + 'T00:00:00Z' : ''); if(!ts) continue;
    const dpPeople = d.chapter ? dps(d.chapter).filter(p => !dpOff[p.sub]) : [], dpOn = dpPeople.length > 0 && !pend.dpReview;
    if(dpOn){ if(hrs(ts) >= cfg.firstHours) add(dpPeople, 'waiting', `doc:${d.id}:${pend.v}:dp:first`); if(hrs(ts) >= cfg.picHours) add(pics, 'pic', `doc:${d.id}:${pend.v}:dp:pic`); }
    else { const since = (pend.dpReview && pend.dpReview.at) || ts; if(hrs(since) >= cfg.firstHours) add(finals, 'waiting', `doc:${d.id}:${pend.v}:final:first`); } }
  const open = openAt(storeItem, nowMs), out = [];
  for(const e of need.values()){
    const kind = e.kinds.has('urgent') ? 'urgent' : e.kinds.has('pic') ? 'pic' : 'waiting';
    if(kind !== 'urgent' && !open) continue;                           // not while the pharmacy is closed; it goes at the next run when it opens
    out.push({ sub: e.sub, kind, keys: e.keys });
  }
  return out;
}
const NOTIFY_TEXT = { urgent: n => `IronLedger: an urgent item needs attention at ${n}. Sign in now.`, pic: n => `IronLedger: a review at ${n} has been waiting 96 hours. Sign in to see it.`, waiting: n => `IronLedger: an item is waiting for you at ${n}. Sign in to review it.` };
async function notifySend(channel, p, text){
  if(NOTIFY_TEST) return 'test';
  if(channel === 'email' && NOTIFY_FROM && p.notify.address){ const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    await new SESv2Client({}).send(new SendEmailCommand({ FromEmailAddress: NOTIFY_FROM, Destination: { ToAddresses: [p.notify.address] }, Content: { Simple: { Subject: { Data: 'IronLedger' }, Body: { Text: { Data: text } } } } })); return 'sent'; }
  if(channel === 'text' && NOTIFY_SMS && p.phone){ const { SNSClient, PublishCommand } = await import('@aws-sdk/client-sns');
    await new SNSClient({}).send(new PublishCommand({ PhoneNumber: phoneE164(p.phone), Message: text, MessageAttributes: { 'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' } } })); return 'sent'; }
  return '';
}
async function notifyRun(storeItem, nowMs){
  const store = storeItem.sk, team = await Promise.all((await calTeam(store)).map(async p => ({ ...p, notify: ((await profileOf(p.sub)) || {}).notify || {} }))), cfg = await notifyCfg(store);
  const marks = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': docPk(store), ':s': 'NOTIF#' } });
  const sent = new Set(marks.map(m => m.sk.slice(6)));
  const exc = (await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p AND begins_with(sk, :c)', ExpressionAttributeValues: { ':p': calPk(store), ':c': 'CAL#exc#' } })).map(i => { try{ return JSON.parse(i.j); }catch(e){ return null; } }).filter(Boolean);
  const plan = notifyPlan({ store, storeItem, team, recs: await calRecordsAll(store), exc, docs: await docLoadAll(store), cfg, nowMs, sent, dpOff: (await docCfg(store)).dpOff || {} }), out = [];
  for(const n of plan){
    const p = team.find(x => x.sub === n.sub), text = NOTIFY_TEXT[n.kind](storeItem.name || 'your pharmacy'), got = [];
    for(const ch of [p.notify.email === true ? 'email' : '', p.notify.text === true ? 'text' : ''].filter(Boolean)){ try{ if(await notifySend(ch, p, text)) got.push(ch); }catch(e){ console.error('notify failed', ch, e.message); } }
    if(!got.length) continue;                                           // nothing went out (no address or number, or the sender failed): try again next run
    for(const k of n.keys) await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: docPk(store), sk: 'NOTIF#' + k, j: JSON.stringify({ at: new Date(nowMs).toISOString() }) } }));
    await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: docPk(store), sk: `NOTIFLOG#${new Date(nowMs).toISOString()}#${crypto.randomBytes(3).toString('hex')}`, j: JSON.stringify({ at: new Date(nowMs).toISOString(), to: n.sub, kind: n.kind, channels: got, items: n.keys.length }) } }));
    out.push({ store, sub: n.sub, kind: n.kind, channels: got, text });
  }
  return out;
}
async function notifyTick(nowMs){
  if(!(NOTIFY_FROM || NOTIFY_SMS || NOTIFY_TEST)) return { skipped: 'No email or text sender is set up yet.' };
  const out = []; for(const s of (await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'STORES' } })))
    if(suiteStore(s.sk) || s.calendar === true || s.documents === true) out.push(...await notifyRun(s, nowMs || Date.now()));
  return { sent: out };
}
const NOTIFY_ADDR = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
async function notifyPrefs(method, me, body){
  if(method === 'GET') return { email: !!(me.notify && me.notify.email), text: !!(me.notify && me.notify.text), address: (me.notify && me.notify.address) || '', phone: me.phone ? '(•••) •••-' + String(me.phone).replace(/\D/g, '').slice(-4) : '' };
  const email = body.email === true, text = body.text === true, address = String(body.address || '').trim().slice(0, 120);
  if(email && !NOTIFY_ADDR.test(address)) throw bad('Enter the email address that should get the messages.');
  if(text && !me.phone) throw bad('There is no mobile number on your login. Ask the Account Owner.');
  await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'USERS', sk: me.sk }, UpdateExpression: 'SET notify = :n', ExpressionAttributeValues: { ':n': { email, text, address: address && NOTIFY_ADDR.test(address) ? address : '' } } }));
  return { ok: true };
}

// ---------- 39.2: inspector link (time-limited, read only, every open is logged) and IronLedger's read-only, logged view of a pharmacy's Calendar and Personnel
// The link is store id + '.' + a long random token, kept only as a hash. It is not a login: it opens a fixed set of read-only views and nothing else. Drafts, hard voids, billing, user accounts and contacts,
// other pharmacies and the Account area are never reachable through it.
const inspHash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const INSP_TYPES = ['POL', 'SOP', 'FRM', 'MFR', 'CMP', 'LOG', 'CHK', 'TRN'];
const boss = me => !!(me && (me.owner || me.acctType === 'pic'));
const inspRight = (me, cfg) => boss(me) || (cfg.inspGrant || {})[me.sk] === true;
async function inspLinks(store){
  const items = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': docPk(store), ':s': 'INSP#' } });
  const out = []; for(const it of items){ try{ out.push({ ...JSON.parse(it.j), sk: it.sk }); }catch(e){} } return out.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
}
async function inspLogRows(store, limit){
  const ev = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': docPk(store), ':s': 'INSPLOG#' }, ScanIndexForward: false, ...(limit ? { Limit: limit } : {}) });
  return ev.map(e => { try{ return JSON.parse(e.j); }catch(x){ return null; } }).filter(Boolean);
}
const linkView = (l, opens) => ({ id: l.id, label: l.label, from: l.from, to: l.to, docs: !!l.docs, by: l.by, at: l.at, expiresAt: l.expiresAt, revoked: !!l.revoked, revokedBy: l.revokedBy || '', opens: opens[l.id] || 0, state: l.revoked ? 'Revoked' : l.expiresAt <= Date.now() ? 'Expired' : 'Active' });
async function inspRoute(method, store, seg, body, me, storeItem){
  docGate(me, storeItem);
  const cfg = await docCfg(store); if(!inspRight(me, cfg)) throw forbidden('Only the Pharmacist-In-Charge, the Account Owner, or someone they allow can send the inspector link.');
  if(method === 'GET' && !seg[0]){
    const log = boss(me) ? await inspLogRows(store, 1000) : [], opens = {}; for(const e of log) opens[e.lid] = (opens[e.lid] || 0) + 1;
    return { links: (await inspLinks(store)).map(l => linkView(l, opens)), log: boss(me) ? log.slice(0, 500) : null, canGrant: boss(me), granted: boss(me) ? cfg.inspGrant || {} : null };
  }
  if(method === 'POST' && !seg[0]){
    const label = String(body.label || '').trim().slice(0, 80); if(!label) throw bad('Enter who this is for.');
    const from = String(body.from || ''), to = String(body.to || ''); if(!DATE.test(from) || !DATE.test(to) || isNaN(Date.parse(from)) || isNaN(Date.parse(to))) throw bad('Pick the report period with the date picker.');
    if(to < from) throw bad('The period ends before it starts.');
    const days = body.days === undefined || body.days === '' ? 7 : parseInt(body.days, 10); if(!(days >= 1 && days <= 30)) throw bad('The link can last 1 to 30 days.');
    const id = 'i' + crypto.randomBytes(5).toString('hex'), token = store + '.' + crypto.randomBytes(24).toString('base64url');
    const l = { id, label, from, to, docs: body.docs === true, by: who(me), byId: me.sk, at: now(), expiresAt: Date.now() + days * 86400000, revoked: false };
    await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: docPk(store), sk: 'INSP#' + inspHash(token), j: JSON.stringify(l) } }));
    await docLog(store, me, 'Inspector Link Sent', '', label + ', ' + from + ' to ' + to + ', ' + days + ' days');
    return { ok: true, token, path: '/inspect.html#' + token, link: linkView(l, {}) };
  }
  if(method === 'POST' && seg[0] && (seg[1] === 'revoke' || seg[1] === 'expiry')){
    const l = (await inspLinks(store)).find(x => x.id === seg[0]); if(!l) throw new HttpError(404, 'No such link.');
    const { sk, ...rest } = l;
    if(seg[1] === 'revoke'){ rest.revoked = true; rest.revokedBy = who(me); rest.revokedAt = now(); }
    else { const days = parseInt(body.days, 10); if(!(days >= 1 && days <= 30)) throw bad('The link can last 1 to 30 days.'); if(rest.revoked) throw bad('A revoked link cannot be extended. Send a new one.'); rest.expiresAt = Date.now() + days * 86400000; }
    await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: docPk(store), sk, j: JSON.stringify(rest) } }));
    await docLog(store, me, seg[1] === 'revoke' ? 'Inspector Link Revoked' : 'Inspector Link Expiry Changed', '', l.label); return { ok: true };
  }
  throw new HttpError(404, 'Not found');
}
async function inspPublic(rp, ev){                                   // GET /public/inspect/<store>.<token>/<what>[/<arg>]  (no sign-in; the token is the key)
  const parts = rp.split('/').filter(Boolean).slice(2), [token, what, arg] = parts.map(x => { try{ return decodeURIComponent(x); }catch(e){ return ''; } });
  const store = String(token || '').split('.')[0];
  if(!token || !store || !okId(store) || !/^[A-Za-z0-9_.-]{20,80}$/.test(token)) throw new HttpError(404, 'This link is not valid.');
  const g = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: docPk(store), sk: 'INSP#' + inspHash(token) } }));
  if(!g.Item) throw new HttpError(404, 'This link is not valid.');
  const l = JSON.parse(g.Item.j); if(l.revoked) throw new HttpError(410, 'This link was cancelled. Ask the pharmacy for a new one.'); if(l.expiresAt <= Date.now()) throw new HttpError(410, 'This link has expired. Ask the pharmacy for a new one.');
  const st = (await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'STORES', sk: store } }))).Item; if(!st) throw new HttpError(404, 'This link is not valid.');
  const h = (ev.requestContext && ev.requestContext.http) || {}, hd = ev.headers || {};
  const log = (w, d) => ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: docPk(store), sk: `INSPLOG#${now()}#${crypto.randomBytes(3).toString('hex')}`, j: JSON.stringify({ at: now(), lid: l.id, label: l.label, what: w, detail: String(d || '').slice(0, 200), ip: String(h.sourceIp || (hd['x-forwarded-for'] || '').split(',')[0] || '').slice(0, 45), device: String(hd['user-agent'] || h.userAgent || '').slice(0, 160) }) } }));
  const inP = d => d && d >= l.from && d <= l.to;
  const recs = (await calRecordsAll(store)).filter(r => r.status !== 'void' && r.review && r.review.status === 'accepted' && inP(r.completedOn));     // approved, not voided, in the period
  const excAll = (await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p AND begins_with(sk, :c)', ExpressionAttributeValues: { ':p': calPk(store), ':c': 'CAL#exc#' } })).map(i => { try{ return JSON.parse(i.j); }catch(e){ return null; } }).filter(Boolean).filter(e => inP(e.date));
  const exc = excAll.map(e => ({ date: e.date, kind: e.kind, what: e.what, handling: e.handling, status: e.status === 'closed' ? 'Closed' : 'Open', reconciliation: e.closed ? e.closed.reconciliation : '' }));
  const pharmacy = () => ({ name: st.name || '', address: [st.address, st.suite, st.city, st.state, st.zip].filter(Boolean).join(', '), phone: st.phone || '', npi: st.npi || '', dea: st.dea || '', licenses: licensesOf(st) });
  const logs = () => { const f = {}; for(const r of recs){ const v = recView(r); (f[v.obId] = f[v.obId] || { key: v.obId, title: v.type, rows: [] }).rows.push({ date: v.date, performedBy: v.performedBy, result: v.result, approvedBy: v.approvedBy, approvedAt: v.approvedAt, corrected: v.corrected }); }
    return Object.values(f).sort((a, b) => a.title.localeCompare(b.title)).map(x => ({ ...x, rows: x.rows.sort((a, b) => a.date.localeCompare(b.date)) })); };
  const summary = () => ({ pharmacy: pharmacy(), period: { from: l.from, to: l.to }, completed: recs.length, corrected: recs.filter(r => r.review.reopens && r.review.reopens.length).length,
    byType: Object.values(logs().reduce((a, x) => { a[x.key] = { title: x.title, n: x.rows.length }; return a; }, {})), excursions: exc.filter(e => e.kind === 'excursion').length, missed: exc.filter(e => e.kind === 'missed').length, open: exc.filter(e => e.status === 'Open').length });
  const docsList = async () => (await docLoadAll(store)).filter(d => docCur(d) && !d.retired && INSP_TYPES.includes(d.type)).map(d => { const c = docCur(d), base = d.lastReviewed || c.effective || '';
    return { id: d.id, title: d.title, type: d.type, version: c.v, effective: c.effective || '', approvedBy: c.approvedBy || '', nextReview: base && d.cycle ? addMonthsIso(base, d.cycle) : '', hasFile: !!c.file }; }).sort((a, b) => a.id.localeCompare(b.id));
  const people = async () => { const team = await calTeam(store), out = []; for(const p of team){ out.push({ ...persLine(p), records: (await personRecords(store, p)).filter(r => r.approvedBy).map(r => ({ date: r.date, type: r.type, result: r.result })) }); } return out.sort((a, b) => a.name.localeCompare(b.name)); };
  const meta = { by: l.by, at: l.at, label: l.label, expiresAt: l.expiresAt, docs: !!l.docs };
  if(!what || what === 'summary'){ await log('Opened Dashboard', ''); return { meta, ...summary() }; }
  if(what === 'logs'){ await log('Opened Task Logs', ''); return { meta, period: { from: l.from, to: l.to }, logs: logs(), exceptions: exc }; }
  if(what === 'docs'){ await log('Opened Documents', ''); return { meta, docs: await docsList() }; }
  if(what === 'personnel'){ await log('Opened Personnel', ''); return { meta, people: await people() }; }
  if(what === 'report'){ await log('Opened Print Report', ''); return { meta, generatedAt: now(), ...summary(), logs: logs(), exceptions: exc, docs: await docsList(), people: await people() }; }
  if(what === 'file' && arg){
    if(!l.docs) throw forbidden('This link shows the document register only.');
    const d = await docGetOne(store, arg).catch(() => null); if(!d || !docCur(d) || d.retired || !INSP_TYPES.includes(d.type) || !docCur(d).file) throw new HttpError(404, 'No such document.');
    await log('Downloaded Document', d.id + ' v' + docCur(d).v);
    return { url: presignS3({ method: 'GET', bucket: DOCS_BUCKET, key: docCur(d).file.key, query: { 'response-content-type': 'application/pdf', 'response-content-disposition': 'inline' } }), name: docCur(d).file.name };
  }
  throw new HttpError(404, 'Not found');
}
// IronLedger staff: read-only, and every view is written to a log the pharmacy can see. Calendar: any host login. Personnel: only a host person who has been given the privilege.
async function hostLog(store, me, what, detail){
  await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: docPk(store), sk: `HOSTLOG#${now()}#${crypto.randomBytes(3).toString('hex')}`, j: JSON.stringify({ at: now(), by: who(me), login: me.login || '', what, detail: String(detail || '').slice(0, 200) }) } }));
}
async function hostView(method, store, seg, me, storeItem){
  if(!me.host) throw new HttpError(404, 'Not found'); if(method !== 'GET') throw forbidden('IronLedger access is read only.');
  if(seg[0] === 'calendar'){ await hostLog(store, me, 'Calendar Viewed', ''); const r = await calLoad(store, null, storeItem); return { ...r, readOnly: true }; }
  if(seg[0] === 'personnel'){
    if(me.hostPersonnel !== true) throw forbidden('You do not have the Personnel Files privilege. A supervisor can give it.');
    if(!seg[1]){ await hostLog(store, me, 'Personnel List Viewed', ''); return { people: (await calTeam(store)).map(persLine).sort((a, b) => a.name.localeCompare(b.name)) }; }
    const d = await persDetail(store, seg[1]); await hostLog(store, me, 'Personnel File Viewed', d.person.name);
    if(seg[2] === 'file' && seg[3]){ const r = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: docPk(store), sk: `MYDOC#${seg[1]}#${String(seg[3])}` } })); if(!r.Item) throw new HttpError(404, 'No such document.'); const o = JSON.parse(r.Item.j); await hostLog(store, me, 'Personnel Document Opened', o.title); return { url: presignS3({ method: 'GET', bucket: DOCS_BUCKET, key: o.file.key, query: { 'response-content-type': 'application/pdf', 'response-content-disposition': 'inline' } }), name: o.file.name }; }
    return d;
  }
  throw new HttpError(404, 'Not found');
}
async function docsRoute(method, store, seg, q, body, me, storeItem){
  docGate(me, storeItem);
  const duty = docDuty(me), m = DOC_MANAGE.includes(duty), a = DOC_APPROVE.includes(duty), today = todayIn(storeItem.timezone);
  const needM = what => { if(!m) throw forbidden(`Your role cannot ${what}.`); }, needA = what => { if(!a) throw forbidden(`Only the Owner, Pharmacist-In-Charge or Designated Person can ${what}.`); };
  const id = seg[0];
  { const x = await docsExtra(method, store, id, seg, q, body, me, storeItem); if(x !== undefined) return x; }
  if(method === 'GET' && !id){
    const cfg0 = await docCfg(store), team0 = await calTeam(store);
    const dpSees = d => !!d.chapter && dpHolds(me, d.chapter) && !cfg0.dpOff[me.sk];       // a Designated Person sees the documents of their chapter, including a draft waiting for them
    const docs = (await docLoadAll(store)).filter(d => audOk(d, me, m) || dpSees(d)).map(d => { const v = docView(d, dpSees(d) ? 'dp' : duty); if(v && (m || dpSees(d))) v.dpStep = dpStepOn(d, team0, cfg0); return v; }).filter(Boolean).sort((x, y) => x.id.localeCompare(y.id));
    const pin = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: docPk(store), sk: 'DOCPIN#' + me.sk } }));
    let pins = []; try{ pins = pin.Item ? JSON.parse(pin.Item.j).ids || [] : []; }catch(e){}
    const out = { duty, today, docs, pins: pins.filter(p => docs.some(d => d.id === p)), maxMb: DOC_MAX_BYTES / 1048576, pharmacy: storeItem.name || '', tasksOK: taskPerson(me), persOK: persRight(me, cfg0), persAdd: !!me.owner, boss: !!(me.owner || me.acctType === 'pic'), inspOK: inspRight(me, cfg0), dpChapters: CHAPTERS.filter(c => dpHolds(me, c) && !cfg0.dpOff[me.sk]), final: finalRole(me, storeItem.ownerIsPic) };
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
    const chapter = cleanChapter(body.chapter), audience = cleanAudience(body.audience);
    const f = body.file && typeof body.file === 'object' ? body.file : null; if(!f) throw bad('Choose the PDF file.');
    const { size } = await docIo(store, f.key);
    const seq = await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: docPk(store), sk: `DOCSEQ#${type}-${area}` }, UpdateExpression: 'ADD n :one', ExpressionAttributeValues: { ':one': 1 }, ReturnValues: 'UPDATED_NEW' }));
    const docId = `${type}-${area}-${String(seq.Attributes.n).padStart(3, '0')}`;
    const d = { id: docId, title, type, area, sub, format, chapter, audience, cycle, basis: String(body.basis || '').trim().slice(0, 200) || 'Internal Policy', notes: String(body.notes || '').trim().slice(0, 1000), underReview: false, retired: false, lastReviewed: '', reviews: [],
      versions: [{ v: version, state: 'pending', summary: 'Initial Draft', by: who(me), byLogin: me.login || '', at: today, file: { key: f.key, name: String(f.name || 'document.pdf').slice(0, 160), size }, ts: now() }] };
    await docPut(store, d, true); await docLog(store, me, 'Document Added', docId, title + ' (Draft)');
    return { ok: true, id: docId };
  }
  if(!id) throw new HttpError(404, 'Not found');
  const act = seg[1] || '';
  if(method === 'GET' && act === 'file'){                              // a short-lived link to the PDF
    const d = await docGetOne(store, id), st = docStatus(d), dpS = !!d.chapter && dpHolds(me, d.chapter) && !(await docCfg(store)).dpOff[me.sk], mm = m || dpS;
    if(!audOk(d, me, m) && !dpS) throw new HttpError(404, 'No such document.');
    let v = docCur(d);
    if(mm && q.v) v = (d.versions || []).find(x => x.v === String(q.v));
    else if(mm && !v) v = docPend(d);
    if(!mm && (st === 'Draft' || st === 'Retired')) throw new HttpError(404, 'No such document.');
    if(!v || !v.file) throw new HttpError(404, 'That version has no file.');
    if(!mm && v.state !== 'current') throw forbidden();
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
    d.versions.push({ v, state: 'pending', summary: sum, by: who(me), byLogin: me.login || '', at: today, file: { key: f.key, name: String(f.name || 'document.pdf').slice(0, 160), size }, ts: now() });
    await docPut(store, d); await docLog(store, me, 'Version Submitted', id, 'v' + v + ' ' + sum);
    return { ok: true };
  }
  if(act === 'approve'){
    needA('approve versions'); if(!pend) throw bad('Nothing is waiting for approval.');
    const team = await calTeam(store), cfg = await docCfg(store), stepOn = dpStepOn(d, team, cfg), isFinal = finalRole(me, storeItem.ownerIsPic);
    if(stepOn){
      if(!isFinal) throw forbidden('Only the final approver (the Pharmacist-In-Charge, or a pharmacist they named) can give final approval.');
      if(!pend.dpReview){
        if(dpHolds(me, d.chapter) && !cfg.dpOff[me.sk]){ const s0 = await signAs(me, body, 'Reviewed'); pend.dpReview = { by: who(me), byLogin: me.login || '', byId: me.sk, at: now(), ini: s0.ini, sig: s0, same: true }; }
        else throw bad('Waiting for the Designated Person review for chapter ' + d.chapter + '.');
      }
    }
    const eff = cleanDocDate(body.effective, 'Effective date', { max: addMonthsIso(today, 12) }, today), self = (pend.byLogin || '') === (me.login || '') && !!pend.byLogin;
    const sig = await signAs(me, body, 'Approved');
    if(cur) cur.state = 'superseded';
    pend.state = 'current'; pend.effective = eff; pend.approvedBy = who(me); pend.approvedByLogin = me.login || ''; pend.approvedIni = sig.ini; pend.sig = sig; if(self) pend.selfApproved = true;
    d.underReview = false; d.retired = false; d.lastReviewed = eff <= today ? eff : today;
    d.reviews = (d.reviews || []).concat([{ at: d.lastReviewed, by: who(me), ini: sig.ini, outcome: 'Revised And Approved', comment: ('v' + pend.v + ': ' + (pend.summary || '')).slice(0, 300) }]);
    await docPut(store, d); await docLog(store, me, 'Version Approved', id, 'v' + pend.v + ' effective ' + eff, self ? 'Self-Approved' : '', sig);
    return { ok: true };
  }
  if(act === 'dpreview'){
    if(!d.chapter) throw bad('This document has no chapter tag.'); if(!pend) throw bad('Nothing is waiting for review.');
    const cfg = await docCfg(store); if(!dpHolds(me, d.chapter) || cfg.dpOff[me.sk]) throw forbidden('Only a Designated Person for chapter ' + d.chapter + ' reviews this.');
    if(pend.dpReview) throw bad('Already reviewed.');
    const out = body.outcome === 'return' ? 'return' : 'ok';
    if(out === 'return'){ const w = reason(); const sg = await signAs(me, body, 'Returned');
      d.versions = d.versions.filter(x => x !== pend); if(!d.versions.length) await ddb.send(new DeleteCommand({ TableName: MAIN, Key: { pk: docPk(store), sk: 'DOC#' + id } })); else await docPut(store, d);
      await docLog(store, me, 'Returned By Designated Person', id, 'v' + pend.v + '. ' + w, '', sg); return { ok: true, removed: !d.versions.length }; }
    const sg = await signAs(me, body, 'Reviewed'); pend.dpReview = { by: who(me), byLogin: me.login || '', byId: me.sk, at: now(), ini: sg.ini, sig: sg, note: String(body.comment || '').trim().slice(0, 300) };
    await docPut(store, d); await docLog(store, me, 'Designated Person Review', id, 'v' + pend.v + ' chapter ' + d.chapter, '', sg); return { ok: true };
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
    if(body.chapter !== undefined){ const c = cleanChapter(body.chapter); if(c !== (d.chapter || '')) ch.push('chapter ' + (c || 'none')); d.chapter = c; }
    if(body.audience !== undefined){ d.audience = cleanAudience(body.audience); ch.push('audience'); }
    if(body.basis !== undefined) d.basis = String(body.basis).trim().slice(0, 200);
    if(body.notes !== undefined) d.notes = String(body.notes).trim().slice(0, 1000);
    await docPut(store, d); await docLog(store, me, 'Details Edited', id, ch.join(', ') || 'minor fields');
    return { ok: true };
  }
  throw new HttpError(404, 'Not found');
}
// ---------- Account Owners (pharmacy and client), the PIC question, and the client page
// IronLedger (host) is the only one who names an owner, records whether the owner is the PIC, and records a change of PIC (with a reason, kept in the change history).
async function clientsOf(me){
  if(me.host) return [];
  const out = [];
  for(const id of trueKeys(me.ownerClients)){
    const c = (await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'CLIENTS', sk: id } }))).Item;
    if(c) out.push({ id, name: c.dba || c.legalName || id, legalName: c.legalName || '' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
async function profilesAll(){ return (await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'USERS' } })).map(p => ({ ...p, sub: p.sk })).filter(p => !p.deleted); }
// an existing login (by sub or Login ID) or a brand-new one (needs the signed SMS consent, like any new login)
async function resolveOwner(spec, by){
  if(!spec || typeof spec !== 'object') throw bad('Pick the person who will be the Account Owner.');
  const all = await profilesAll();
  if(spec.create){
    const c = spec.create; if(!c || typeof c !== 'object') throw bad('Enter the new login’s details.');
    if(c.smsConsent !== true) throw bad('Have the person sign the SMS consent form first, then tick the box.');
    const ini = cleanInitials(c.initials); if(ini && await initialsTaken(ini, '')) throw bad('Those initials are already used by someone else.');
    const lic = cleanLicense(c.license);
    const u = await createLogin(c);
    try{
      await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: 'USERS', sk: u.sub, login: u.login, name: u.name, phone: u.phone, stores: {}, perms: {}, acctType: cleanType(c.acctType), initials: ini, license: lic,
        empId: await nextEmpNo(), owner: false, ownerMig: true, createdAt: now(), createdBy: by, tempIssuedAt: now(), smsConsentAt: now(), smsConsentRecordedBy: by } }));
    }catch(e){ await idp.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: u.login })).catch(() => {}); throw e; }
    return { sub: u.sub, login: u.login, name: u.name, tempPassword: u.tempPassword, created: true };
  }
  const p = all.find(x => (spec.sub && x.sub === spec.sub) || (spec.login && x.login === String(spec.login).trim().toLowerCase()));
  if(!p) throw bad('No such login. Pick an existing login or create a new one.');
  return { sub: p.sub, login: p.login, name: p.name || '', created: false };
}
async function setProfileMap(sub, attr, id, on){
  const p = await profileOf(sub); const m = Object.assign({}, p[attr] || {});
  if(on) m[id] = true; else delete m[id];
  await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'USERS', sk: sub }, UpdateExpression: 'SET #a = :m, ownerMig = :t', ExpressionAttributeNames: { '#a': attr }, ExpressionAttributeValues: { ':m': m, ':t': true } }));
}
const auditPut = (pk, by, reason, changes) => ddb.send(new PutCommand({ TableName: MAIN, Item: { pk, sk: now() + '#' + Math.random().toString(36).slice(2, 7), at: now(), by: by || '', reason: reason || '', changes } }));
async function needStore(id){
  if(!okId(id)) throw bad('Bad pharmacy');
  const s = (await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'STORES', sk: id } }))).Item;
  if(!s) throw new HttpError(404, 'No such pharmacy.');
  return s;
}
async function setStoreOwner(me, id, b){
  if(!isSupervisor(me)) throw forbidden('Only an IronLedger supervisor names the Account Owner.');
  const s = await needStore(id), by = who(me), all = await profilesAll();
  if(b.remove === true){                                                    // nobody owns this pharmacy (the people keep their other access); IronLedger still manages it
    const cur = all.filter(p => ownsStore(p, id)), why = String(b.reason || '').trim();
    if(!cur.length) throw bad('This pharmacy has no Account Owner to remove.');
    if(why.length < 10) throw bad('Removing the Account Owner needs a reason (at least 10 characters).');
    for(const p of cur){ await setProfileMap(p.sub, 'ownerStores', id, false); await setProfileMap(p.sub, 'adminStores', id, false); }
    await auditPut('STOREAUDIT#' + id, by, why, { accountOwner: [cur.map(p => p.login).join(', '), null] });
    return { ok: true, owner: null };
  }
  let spec = b.owner;
  if(b.sameAsClient === true){
    if(!s.clientId) throw bad('This pharmacy has no client yet.');
    const co = all.find(p => ownsClient(p, s.clientId)); if(!co) throw bad('The client has no Account Owner yet.');
    spec = { sub: co.sub };
  }
  const r = await resolveOwner(spec, by);
  const prev = all.filter(p => ownsStore(p, id) && p.sub !== r.sub), reason = String(b.reason || '').trim();
  if(prev.length && reason.length < 10) throw bad('Changing the Account Owner needs a reason (at least 10 characters).');
  if(b.ownerIsPic === true){ const np = all.find(p => p.sub === r.sub) || {}; if(!np.license && !(spec && spec.create && cleanLicense(spec.create.license))) throw bad('The owner is the pharmacist in charge: enter their RPh license number on their login first.'); }
  for(const p of prev) await setProfileMap(p.sub, 'ownerStores', id, false);
  await setProfileMap(r.sub, 'ownerStores', id, true);
  await setProfileMap(r.sub, 'stores', id, true);
  await auditPut('STOREAUDIT#' + id, by, reason || 'Account Owner set', { accountOwner: [prev.map(p => p.login).join(', ') || null, r.login] });
  if(typeof b.ownerIsPic === 'boolean') await setStorePic(me, id, { ownerIsPic: b.ownerIsPic, picLogin: b.picLogin, reason: 'Set with the Account Owner', _first: true });
  return { ok: true, owner: { sub: r.sub, login: r.login, name: r.name }, ...(r.tempPassword ? { tempPassword: r.tempPassword } : {}) };
}
// Is the owner the PIC? Answered at setup and changed only by IronLedger, with a reason. A PIC must be a licensed pharmacist (a license number is on their login).
async function setStorePic(me, id, b){
  if(!isSupervisor(me)) throw forbidden('Only an IronLedger supervisor records who the pharmacist in charge is.');
  const s = await needStore(id), all = await profilesAll(), by = who(me);
  if(typeof b.ownerIsPic !== 'boolean') throw bad('Answer yes or no: is the Account Owner the pharmacist in charge?');
  const first = typeof s.ownerIsPic !== 'boolean', reason = String(b.reason || '').trim();
  if(!first && !b._first && reason.length < 10) throw bad('Changing the pharmacist in charge needs a reason (at least 10 characters).');
  let picLogin = '';
  if(b.ownerIsPic){
    const o = all.find(p => ownsStore(p, id));
    if(!o) throw bad('Name the Account Owner first.');
    if(!o.license) throw bad('The pharmacist in charge needs an RPh license number on their login. Enter it first.');
  } else {
    picLogin = String(b.picLogin || '').trim().toLowerCase();
    const pp = all.find(p => p.login === picLogin);
    if(!pp || !(pp.stores && pp.stores[id] === true || ownsStore(pp, id) || adminStore(pp, id))) throw bad('Pick the pharmacist in charge from the people who work at this pharmacy.');
    // The PIC is designated on the person's login (account type Pharmacist-In-Charge, set in Users by the Account Owner or IronLedger); only such a login can be recorded here.
    // A Staff Pharmacist recorded as PIC before this rule stays valid until someone else is picked.
    if(pp.acctType !== 'pic' && !(pp.acctType === 'pharmacist' && picLogin === (s.picLogin || ''))) throw bad('The pharmacist in charge needs the account type Pharmacist-In-Charge on their login. Set it in Users first.');
    if(!pp.license) throw bad('The pharmacist in charge needs an RPh license number on their login. Enter it first.');
  }
  await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'STORES', sk: id }, UpdateExpression: 'SET ownerIsPic = :o, picLogin = :l, updatedAt = :u', ExpressionAttributeValues: { ':o': b.ownerIsPic, ':l': picLogin, ':u': now() } }));
  await auditPut('STOREAUDIT#' + id, by, reason || 'Set at setup', { pharmacistInCharge: [s.ownerIsPic === true ? 'owner' : (s.picLogin || null), b.ownerIsPic ? 'owner' : picLogin] });
  return { ok: true };
}
async function setClientOwner(me, clientId, b){
  if(!isSupervisor(me)) throw forbidden('Only an IronLedger supervisor names the client’s Account Owner.');
  await needClient(clientId);
  const by = who(me), all = await profilesAll(), r = await resolveOwner(b.owner, by);
  const prev = all.filter(p => ownsClient(p, clientId) && p.sub !== r.sub), reason = String(b.reason || '').trim();
  if(prev.length && reason.length < 10) throw bad('Changing the client’s Account Owner needs a reason (at least 10 characters).');
  for(const p of prev) await setProfileMap(p.sub, 'ownerClients', clientId, false);
  await setProfileMap(r.sub, 'ownerClients', clientId, true);
  await auditPut('CLIENTAUDIT#' + clientId, by, reason || 'Account Owner set', { accountOwner: [prev.map(p => p.login).join(', ') || null, r.login] });
  return { ok: true, owner: { sub: r.sub, login: r.login, name: r.name }, ...(r.tempPassword ? { tempPassword: r.tempPassword } : {}) };
}
// ---- invoices (kept by IronLedger by hand for now; no payment processor yet). The client's owner can read them, never change them.
const INV_STATUS = ['unpaid', 'paid', 'void'];
const toCents = v => { const n = Math.round(parseFloat(String(v).replace(/[$,\s]/g, '')) * 100); if(!Number.isFinite(n) || n <= 0 || n > 100000000) throw bad('Amount: a dollar amount above zero.'); return n; };
const invView = (i, today) => ({ id: i.sk, number: i.number, issued: i.issued, due: i.due, period: i.period, cents: i.cents, description: i.description || '', status: i.status,
  delinquent: i.status === 'unpaid' && !!i.due && i.due < today, paidOn: i.paidOn || '', note: i.note || '' });
function invSummary(list, today){
  const month = today.slice(0, 7), z = () => ({ count: 0, cents: 0 }), add = (o, i) => { o.count++; o.cents += i.cents; };
  const s = { newThisMonth: z(), paidThisMonth: z(), unpaid: z(), delinquent: z() };
  for(const i of list){ if(i.status === 'void') continue;
    if(i.issued.slice(0, 7) === month) add(s.newThisMonth, i);
    if(i.status === 'paid' && (i.paidOn || '').slice(0, 7) === month) add(s.paidThisMonth, i);
    if(i.status === 'unpaid') add(i.delinquent ? s.delinquent : s.unpaid, i); }
  return s;
}
// invoices belong to the pharmacy (the pharmacy is who uses the program and is billed): INVOICE#<pharmacy id>
async function billingOf(storeId){
  const today = todayIn(DEFAULT_TZ);
  const items = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'INVOICE#' + storeId } });
  const list = items.map(i => invView(i, today)).sort((a, b) => b.issued.localeCompare(a.issued) || b.id.localeCompare(a.id));
  return { invoices: list, summary: invSummary(list, today), today };
}
async function addInvoice(me, storeId, b){
  if(!isSupervisor(me)) throw forbidden('Invoices are entered by an IronLedger supervisor.');
  await needStore(storeId);
  const issued = String(b.issued || todayIn(DEFAULT_TZ)), due = String(b.due || '');
  if(!DATE.test(issued) || isNaN(Date.parse(issued))) throw bad('Issue date: use the date picker.');
  if(!DATE.test(due) || isNaN(Date.parse(due)) || due < issued) throw bad('Due date: use the date picker, on or after the issue date.');
  const cents = toCents(b.amount), existing = (await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'INVOICE#' + storeId } })).length;
  const number = String(clean(b.number, 30) || '').trim() || `${storeId}-${issued.slice(0, 7).replace('-', '')}-${String(existing + 1).padStart(2, '0')}`;
  const sk = issued + '_' + Math.random().toString(36).slice(2, 8);
  await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: 'INVOICE#' + storeId, sk, number, issued, due, period: issued.slice(0, 7), cents, description: String(clean(b.description, 200) || '').trim(), status: 'unpaid', createdAt: now(), createdBy: who(me) } }));
  return { ok: true, id: sk, number };
}
async function setInvoice(me, storeId, sk, b){
  if(!isSupervisor(me)) throw forbidden('Invoices are changed by an IronLedger supervisor.');
  await needStore(storeId);
  if(!/^\d{4}-\d{2}-\d{2}_[a-z0-9]+$/.test(String(sk))) throw bad('Bad invoice');
  const cur = (await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'INVOICE#' + storeId, sk } }))).Item; if(!cur) throw new HttpError(404, 'No such invoice.');
  const status = String(b.status || ''); if(!INV_STATUS.includes(status)) throw bad('Status: paid, unpaid or void.');
  const note = String(clean(b.note, 200) || '').trim();
  if(status === 'void' && note.length < 5) throw bad('Say why the invoice is voided.');
  const paidOn = status === 'paid' ? String(b.paidOn || todayIn(DEFAULT_TZ)) : '';
  if(status === 'paid' && (!DATE.test(paidOn) || isNaN(Date.parse(paidOn)))) throw bad('Paid date: use the date picker.');
  await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'INVOICE#' + storeId, sk }, UpdateExpression: 'SET #s = :s, paidOn = :p, note = :n, updatedAt = :u, updatedBy = :b',
    ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':s': status, ':p': paidOn, ':n': note, ':u': now(), ':b': who(me) } }));
  await auditPut('STOREAUDIT#' + storeId, who(me), note, { invoice: [cur.number + ' ' + cur.status, cur.number + ' ' + status] });
  return { ok: true };
}
// what the client's own Account Owner sees: the setup information entered for the client and the billing. Read only.
async function clientPage(me, clientId){
  const c = await needClient(clientId), stores = await allStores(), all = await profilesAll();
  const co = all.find(p => p.ownerClients && p.ownerClients[clientId] === true);
  return { client: clientView(c), owner: co ? { name: co.name || co.login, login: co.login } : null, pharmacies: stores.filter(s => s.clientId === clientId).map(s => ({ id: s.id, name: s.name, reach: reachAt(me, s), city: s.city || '', state: s.state || '', owner: ((all.find(p => ownsStore(p, s.id)) || {}).name) || ((all.find(p => ownsStore(p, s.id)) || {}).login) || '' })),
    };
}
// the people at one pharmacy, as the caller may see them. Other pharmacies' names and IDs stay hidden from everyone but the host.
async function usersAt(me, st, r){
  const sid = st.id, all = await listPeople(), stores = await allStores();
  // "at": the pharmacies each person is assigned to, for the Pharmacy column. An Account Owner sees only their own pharmacies there (never anyone else's); IronLedger sees all.
  // The column is shown (multi) when the viewer has more than one pharmacy; for IronLedger, when the pharmacy's client has more than one or a listed person works at another.
  const mine = me.host ? null : new Set(stores.filter(x => reachAt(me, x).users).map(x => x.id)), live = new Set(stores.map(x => x.id));     // the pharmacies whose people this viewer may see
  const users = all.filter(p => !p.employeeOnly && (p.stores[sid] === true || p.ownerStores[sid] === true || p.adminStores[sid] === true)).map(p => {
    const ids = new Set([...trueKeys(p.stores), ...trueKeys(p.ownerStores), ...trueKeys(p.adminStores)]); const at = [...ids].filter(i => live.has(i) && (!mine || mine.has(i))).sort(); ids.delete(sid);
    return { sub: p.sub, login: p.login, name: p.name, phone: p.phone, acctType: p.acctType, docDuty: p.docDuty, initials: p.initials, license: p.license, licExpires: p.licExpires, subs: p.subs, dp: p.dp, approver: p.approver, empId: p.empId, pin: p.pin,
      disabled: p.disabled, status: p.status, pending: !!p.pending, tempExpired: !!p.tempExpired, tempExpires: p.tempExpires, access: p.stores[sid] === true, isOwner: p.ownerStores[sid] === true, isAdmin: p.adminStores[sid] === true,
      perms: Object.assign({}, p.perms, p.storePerms[sid] || {}), others: ids.size, at, ...(me.host ? { otherIds: [...ids], employee: p.host === true } : (p.host === true ? { locked: true } : {})) };
  });
  if(!me.host) users.sort((a, b) => (b.isOwner - a.isOwner) || (b.pending - a.pending) || (a.name || a.login).localeCompare(b.name || b.login));     // the pharmacy's own order: no special place for an IronLedger employee
  const multi = mine ? mine.size > 1 : (!!st.clientId && stores.filter(x => x.clientId === st.clientId).length > 1) || users.some(u => u.at.length > 1);
  const places = {}; for(const u of users) for(const i of u.at) places[i] = (stores.find(x => x.id === i) || {}).name || i;
  return { store: { id: sid, name: st.name }, canManage: !!r.manage, users, multi, places };
}
// ---------- router
async function route(method, path, q, body, me, claims){
  const seg = path.split('/').filter(Boolean);
  if(seg[0] === 'api') seg.shift();                    // works with or without an /api prefix

  if(method === 'GET' && seg[0] === 'me' && seg.length === 1)
    return { name: me.name || '', login: me.login, owner: !!me.owner, clientOwner: !!me.clientOwner, clients: await clientsOf(me), host: !!me.host, portal: !!me.employee, mgr: [...managedIds(me)], hostRole: me.host ? (me.hostRole === 'rep' ? 'rep' : 'supervisor') : '', repStores: me.host ? (me.repStores || {}) : {}, acctType: me.acctType || '', docDuty: docDuty({ ...me, owner: false }), initials: me.initials || '', license: me.license || '', licExpires: me.licExpires || '', subs: Array.isArray(me.subs) ? me.subs : [], dp: me.dp && typeof me.dp === 'object' ? me.dp : {}, approver: me.approver === true, empId: await ensureEmpId(me), pin: pinState(me), pinRequired: PIN_REQUIRED, perms: effPerms(me), stores: await storesFor(me) };

  if(method === 'POST' && seg[0] === 'me' && seg[1] === 'pin' && seg.length === 2) return await setMyPin(me, body);
  if((method === 'GET' || method === 'POST') && seg[0] === 'me' && seg[1] === 'notify' && seg.length === 2) return await notifyPrefs(method, me, body);
  if(method === 'POST' && seg[0] === 'host' && seg[1] === 'personnel-priv' && seg[2]){                // a supervisor gives or removes a host person's Personnel Files privilege
    if(!isSupervisor(me)) throw forbidden('Only an IronLedger supervisor can change this.');
    const t = await profileOf(String(seg[2])); if(!t || !t.host || t.deleted) throw new HttpError(404, 'No such IronLedger login.'); if(typeof body.on !== 'boolean') throw bad('Bad setting.');
    await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'USERS', sk: t.sk }, UpdateExpression: 'SET hostPersonnel = :v', ExpressionAttributeValues: { ':v': body.on } })); return { ok: true };
  }

  if(seg[0] === 'stores' && seg[1]){
    const store = seg[1];
    if(!okId(store)) throw bad('Bad store');
    if(seg[2] === 'host-view'){                          // IronLedger's read-only, logged look at one pharmacy (the only way the host reaches a pharmacy's own data)
      if(!me.host) throw new HttpError(404, 'Not found');
      const hs = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'STORES', sk: store } })); if(!hs.Item) throw new HttpError(404, 'No such store.');
      return await hostView(method, store, seg.slice(3), me, hs.Item);
    }
    if(!canUse(me, store)) throw forbidden();
    const exists = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'STORES', sk: store } }));
    if(!exists.Item) throw new HttpError(404, 'No such store.');
    me = asStore(me, store); me.pharm = pharmFn(me, { id: store, ownerIsPic: typeof exists.Item.ownerIsPic === 'boolean' ? exists.Item.ownerIsPic : null });
    const what = seg[2];
    if(what === 'inspector') return await inspRoute(method, store, seg.slice(3), body, me, exists.Item);
    if(what === 'documents') return await docsRoute(method, store, seg.slice(3), q, body, me, exists.Item);
    if(what === 'rx') return await rxRoute(method, store, seg.slice(3), body, me, exists.Item);
    if(what === 'calendar'){
      calGate(me, exists.Item);
      if(method === 'GET' && !seg[3]) return await calLoad(store, me, exists.Item);
      if(method === 'POST' && seg[3] === 'commit') return await calCommit(store, me, body, exists.Item);
      if(method === 'POST' && seg[3] === 'delegations') return await calDelegate(store, me, exists.Item, seg[4], seg[5], body);
      if(method === 'POST' && seg[3] === 'timeoff') return await calTimeOff(store, me, exists.Item, seg[4], seg[5], body);
      if(method === 'POST' && seg[3] === 'records') return await calRecordAct(store, me, exists.Item, seg[4], seg[5], body);
      if(seg[3] === 'upload-url' || seg[3] === 'file') return await calTaskFile(method, store, seg.slice(3), body, me);
      if(method === 'POST' && seg[3] === 'exc') return await calExcAct(store, me, exists.Item, seg[4], seg[5], body);
      throw new HttpError(404, 'Not found');
    }
    if(exists.Item.reorder === false && ['lines', 'memory', 'archive', 'commit', 'export', 'import'].includes(what)) throw forbidden('The Reorder List is switched off for this pharmacy.');
    if(['lines', 'memory', 'archive', 'commit', 'export', 'import'].includes(what) && me.acctType === 'staff' && !me.owner && (me.subs || []).some(x => x === 'cashier' || x === 'driver')) throw forbidden('The Reorder List isn’t part of your role.');
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

  // one pharmacy's people and billing, read only: the host, the pharmacy's Account Owner, its PIC super user (people only) and the client's Account Owner (see reachAt)
  if(method === 'GET' && (seg[0] === 'pharmacy' || seg[0] === 'billing') && seg[1]){
    const sid = String(seg[1]); if(!okId(sid)) throw bad('Bad pharmacy');
    const st = (await allStores()).find(s => s.id === sid); if(!st) throw new HttpError(404, 'No such pharmacy.');
    const r = reachAt(me, st);
    if(seg[0] === 'pharmacy' && seg[2] === 'users' && !seg[3]){ if(!r.users) throw forbidden(); await requireUnlocked(me); return await usersAt(me, st, r); }
    if(seg[0] === 'billing' && !seg[2]){ if(!r.billing) throw forbidden('Billing is open to the pharmacy’s Account Owner and its client’s Account Owner.'); await requireUnlocked(me); return await billingOf(sid); }
    throw new HttpError(404, 'Not found');
  }
  // two separate gates: /owner/* answers only the Account Owner, /host/* answers only the host (and is a 404 to everyone else)
  if(seg[0] === 'host-unlock' || seg[0] === 'host-lock' || seg[0] === 'host'){
    if(!me.host) throw new HttpError(404, 'Not found');
    seg[0] = seg[0].replace('host', 'owner');
  } else if(seg[0] === 'owner'){
    if(!(me.owner || managedIds(me).size)) throw forbidden('Only the Account Owner can do that.');
  } else if(seg[0] === 'owner-unlock' || seg[0] === 'owner-lock'){
    if(!(me.owner || me.clientOwner)) throw forbidden('Only the Account Owner can do that.');
  }
  // the client page: the owner of that client only (billing and invoices are read only here). Behind the same password step-up as the owner tab.
  if(seg[0] === 'client'){
    if(!seg[1] || !CLIENT_ID.test(String(seg[1])) || !ownsClient(me, seg[1])) throw forbidden('Only the client’s Account Owner can open this page.');
    await requireUnlocked(me);
    if(method === 'GET' && !seg[2]) return await clientPage(me, seg[1]);
    throw new HttpError(404, 'Not found');
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
      if(!t || t.deleted || t.disabled || isOwnerP(t) || isClientOwnerP(t) || t.host) throw no();
      if(seg[3] === 'reset-password') { /* allowed */ }
      else if(seg[3]) throw no();
      else { const ks = Object.keys(body); if(!ks.length || ks.some(k => k !== 'perms' && k !== 'permStore')) throw no(); }
    }
    // bring in a pharmacy's old shared-drive file: adds only, never changes or removes anything already there
    if(method === 'POST' && seg[1] === 'import' && seg[2]){
      if(!okId(seg[2])) throw bad('Bad pharmacy');
      if(!me.host && !mgrStore(me, seg[2])) throw forbidden();
      const ex = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'STORES', sk: seg[2] } }));
      if(!ex.Item) throw new HttpError(404, 'No such pharmacy.');
      return await importData(seg[2], body);
    }
    if(method === 'GET' && seg[1] === 'npi' && seg[2]){ if(!me.host) throw forbidden('Registry checks are done by IronLedger.'); return await npiLookup(String(seg[2])); }
    if(seg[1] === 'clients'){
      if(!me.host) throw forbidden('Clients are managed by IronLedger.');
      if(method === 'GET' && !seg[2]) return { clients: await listClients() };
      if(method === 'POST' && !seg[2]){
        const r = await addClient(body, who(me));
        if(body.owner){ try{ const o = await setClientOwner(me, r.id, { owner: body.owner }); return { ...r, owner: o.owner, ...(o.tempPassword ? { tempPassword: o.tempPassword } : {}) }; }catch(e){ if(e instanceof HttpError) return { ...r, ownerError: e.message }; throw e; } }
        return r;
      }
      if(method === 'GET' && seg[2] && seg[3] === 'history') return await clientHistory(seg[2]);
      if(method === 'POST' && seg[2] && !seg[3]){ await updateClient(seg[2], body, who(me)); return { ok: true }; }
      if(method === 'POST' && seg[2] && seg[3] === 'owner') return await setClientOwner(me, seg[2], body);
    }
    if(method === 'GET' && seg[1] === 'stores' && seg[2] && seg[3] === 'billing'){ if(!me.host) throw forbidden(); await needStore(seg[2]); return await billingOf(seg[2]); }
    if(method === 'POST' && seg[1] === 'stores' && seg[2] && seg[3] === 'invoices' && !seg[4]) return await addInvoice(me, seg[2], body);
    if(method === 'POST' && seg[1] === 'stores' && seg[2] && seg[3] === 'invoices' && seg[4]) return await setInvoice(me, seg[2], seg[4], body);
    if(method === 'GET' && seg[1] === 'stores' && !seg[2]) return { stores: me.host ? await allStores() : (await allStores()).filter(s => mgrStore(me, s.id)).map(maskStore) };
    if(method === 'POST' && seg[1] === 'stores' && !seg[2]){ if(!me.host) throw forbidden('New pharmacies are set up by IronLedger.'); return await addStore(body, who(me)); }
    if(method === 'POST' && seg[1] === 'stores' && seg[2] && seg[3] === 'drafts') return await createDraft(me, seg[2], body);
    if(method === 'GET' && seg[1] === 'drafts' && !seg[2]){ if(!me.host) throw forbidden('Drafts are handled by IronLedger.'); return await listDrafts(me); }
    if(method === 'POST' && seg[1] === 'drafts' && seg[2] && seg[3] && (seg[4] === 'approve' || seg[4] === 'reject')) return await decideDraft(me, seg[2], seg[3], seg[4], body);
    if(method === 'GET' && seg[1] === 'stores' && seg[2] && seg[3] === 'history'){ if(!me.host) throw forbidden('The change history is kept by IronLedger.'); return await storeHistory(seg[2]); }
    if(method === 'POST' && seg[1] === 'stores' && seg[2] && seg[3] === 'owner') return await setStoreOwner(me, seg[2], body);
    if(method === 'POST' && seg[1] === 'stores' && seg[2] && seg[3] === 'pic') return await setStorePic(me, seg[2], body);
    if(method === 'POST' && seg[1] === 'stores' && seg[2] && seg[3] === 'logo'){ if(!me.host && !mgrStore(me, seg[2])) throw forbidden(); await setLogo(seg[2], body.dataUrl); return { ok: true }; }
    if(method === 'POST' && seg[1] === 'stores' && seg[2]){ if(!me.host && !mgrStore(me, seg[2])) throw forbidden(); await updateStore(seg[2], body, who(me), !!me.host); return { ok: true }; }
    if(method === 'GET' && seg[1] === 'users') return { users: scopePeople(me, await listPeople()) };
    if(method === 'POST' && seg[1] === 'users' && !seg[2]){
      if(!me.host && !managedIds(me).size) throw forbidden('You can’t add people at your pharmacies. Ask IronLedger.');
      const stores = await cleanStoreToggles(body.stores, me), perms = Object.assign({}, DEFAULT_PERMS, cleanPerms(body.perms));
      if(body.smsConsent !== true) throw bad('Have the person sign the SMS consent form first, then tick the box.');
      const ini = cleanInitials(body.initials); if(ini && await initialsTaken(ini, '')) throw bad('Those initials are already used by someone else.');
      const lic = cleanLicense(body.license);
      const newType = cleanType(body.acctType); tierGuardType(me, null, '', newType);
      const subs = cleanSubs(body.subs, newType), dp = cleanDp(body.dp, newType), approver = body.approver === undefined ? false : cleanApprover(me, body.approver, newType), licExpires = cleanLicDate(body.licExpires);
      const u = await createLogin(body);
      try{
        await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: 'USERS', sk: u.sub, login: u.login, name: u.name, phone: u.phone,
          stores, perms, acctType: newType, subs, dp, approver, licExpires, initials: ini, license: lic, empId: await nextEmpNo(), owner: false, ownerMig: true, createdBySub: me.sk, createdAt: now(), createdBy: who(me), tempIssuedAt: now(), smsConsentAt: now(), smsConsentRecordedBy: who(me) } }));
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
  if(people.some(p => p.owner || hasAny(p.ownerStores))) return { ok: false, message: 'The Account Owner login already exists. Add people from the Account Owner tab in the app.' };
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
    owner: false, ownerMig: true, ownerStores: { [store.id]: true }, stores: {}, perms: {}, createdAt: now(), createdBy: 'setup' } }));
  return { ok: true, message: `Account Owner login "${u.login}" created. Pharmacy ID: ${store.id} (${store.name}). Temporary password: ${u.tempPassword}`, store, tempPassword: u.tempPassword };
}

// host login (IronLedger): made from CloudShell with host.sh make-host, never through the API
async function makeHost(b){
  const people = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'USERS' } });
  const login = String(b.login || '').trim().toLowerCase();
  const same = people.find(p => p.login === login && !p.deleted);
  if(same && !same.host){                              // a pharmacy login that is also an IronLedger employee: the same ID and password open the portal too
    await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'USERS', sk: same.sk }, UpdateExpression: 'SET #h = :t, hostRole = :r', ExpressionAttributeNames: { '#h': 'host' }, ExpressionAttributeValues: { ':t': true, ':r': b.role === 'rep' ? 'rep' : 'supervisor' } }));
    return { ok: true, message: `"${login}" can now also sign in to the IronLedger employee portal with its existing Login ID and password.` };
  }
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

// The opposite of makeHost for a login that also works at a pharmacy: it stops being an IronLedger employee login and stays an ordinary pharmacy login.
// Its Login ID, password, pharmacies, account type, Employee ID and history are untouched. It is signed out everywhere so an open portal session ends.
// Never the last supervisor (the portal would be locked for everyone), and never a login with no pharmacy (that one is removed with remove-host).
async function unmakeHost(b){
  const people = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'USERS' } });
  const login = String(b.login || '').trim().toLowerCase();
  const p = people.find(x => x.login === login && !x.deleted);
  if(!p) return { ok: false, message: `No login "${login}" in the list.` };
  if(p.host !== true) return { ok: true, message: `"${login}" is already a pharmacy login only.` };
  if(!hasRole(p)) return { ok: false, message: `"${login}" has no pharmacy, so nothing would be left of it. To remove it completely: bash host.sh remove-host ${login}` };
  const others = people.filter(x => x.sk !== p.sk && x.host === true && !x.deleted && !x.disabled && x.hostRole !== 'rep');
  if(!others.length) return { ok: false, message: `"${login}" is the only IronLedger supervisor login. Make the new employee login first (bash host.sh make-host NEWLOGIN "NAME" NUMBER), then run this again.` };
  await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'USERS', sk: p.sk }, UpdateExpression: 'REMOVE #h, hostRole, repStores, hostPersonnel', ExpressionAttributeNames: { '#h': 'host' } }));
  await idp.send(new AdminUserGlobalSignOutCommand({ UserPoolId: POOL, Username: p.login })).catch(() => {});
  return { ok: true, message: `"${login}" is now a pharmacy login only: it can no longer open the IronLedger employee portal. Its Login ID, password, pharmacies and history are unchanged. It was signed out everywhere; sign in again at the pharmacy site.` };
}

// Cognito runs this before it checks the password, for every sign-in on the pool. Through the portal's own app client only an IronLedger employee login gets through; anyone else
// is refused with the same words as a wrong password, before any text code is sent. Every other app client is let straight through, and so is any failure here (the API
// refuses non-employees on its own as well).
let _portalIds = {};
async function isPortalClient(poolId, cid){
  if(PORTAL_CLIENT) return cid === PORTAL_CLIENT;
  if(_portalIds[cid] !== undefined) return _portalIds[cid];
  const r = await idp.send(new DescribeUserPoolClientCommand({ UserPoolId: poolId, ClientId: cid }));
  return (_portalIds[cid] = /-portal$/.test((r.UserPoolClient || {}).ClientName || ''));
}
async function preAuth(event){
  let ok = true;
  try{
    if(await isPortalClient(event.userPoolId, (event.callerContext || {}).clientId)){
      const p = await profileOf(((event.request || {}).userAttributes || {}).sub);
      ok = !!(p && p.host === true && !p.deleted && !p.disabled);
    }
  }catch(e){ console.error('pre-sign-in check', e); ok = true; }
  if(!ok) throw new Error('Incorrect ID or password.');
  return event;
}

export const handler = async (event) => {
  if(event && /^PreAuthentication/.test(event.triggerSource || '')) return await preAuth(event);       // Cognito sign-in check: an Error here is what refuses the sign-in
  try{
    if(event && event.bootstrap){ try{ return await bootstrap(event.bootstrap); }catch(e){ return { ok: false, message: 'Setup stopped: ' + e.message + ' Run deploy.sh again to retry.' }; } }
    if(event && event.notifyTick){ try{ return await notifyTick(event.notifyTick.now); }catch(e){ console.error('notifyTick', e); return { ok: false, message: e.message }; } }
    if(event && event.source === 'aws.events'){ try{ return await notifyTick(); }catch(e){ console.error('notifyTick', e); return { ok: false }; } }
    if(event && event.makeHost){ try{ return await makeHost(event.makeHost); }catch(e){ return { ok: false, message: 'Stopped: ' + e.message }; } }
    if(event && event.unmakeHost){ try{ return await unmakeHost(event.unmakeHost); }catch(e){ return { ok: false, message: 'Stopped: ' + e.message }; } }
    const rp = (event.rawPath || '').replace(/^\/api/, '');
    if(event.requestContext && event.requestContext.http && event.requestContext.http.method === 'GET' && rp.startsWith('/public/pharmacy/'))
    { let id = ''; try{ id = decodeURIComponent(rp.slice('/public/pharmacy/'.length)); }catch(e){}
      return json(200, await publicPharmacy(id)); }
    if(event.requestContext && event.requestContext.http && event.requestContext.http.method === 'GET' && rp.startsWith('/public/inspect/')) return json(200, await inspPublic(rp, event));
    const claims = (((event.requestContext || {}).authorizer || {}).jwt || {}).claims || {};
    if(!claims.sub) throw new HttpError(401, 'Please sign in again.');
    await migrateOwners();
    const me = await profileOf(claims.sub);
    if(!me || me.disabled || me.deleted) throw forbidden('Your login isn’t switched on for any pharmacy. Ask the Account Owner.');
    me.login = me.login || claims['cognito:username'];
    me.employee = me.host === true;                                          // may use the IronLedger employee portal
    if(PORTAL_CLIENT && me.host && (claims.aud || claims.client_id) !== PORTAL_CLIENT) me.host = false;     // ...but through the pharmacy app it is an ordinary login
    me.owner = isOwnerP(me); me.clientOwner = isClientOwnerP(me);          // owner: manages at least one pharmacy; inside a pharmacy it is set for that pharmacy alone
    await setMgr(me);
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

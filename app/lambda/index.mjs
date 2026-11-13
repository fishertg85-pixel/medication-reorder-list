// NorTex Reorder List API (AWS Lambda, Node.js 22, HTTP API payload 2.0, Cognito JWT authorizer)
//
// MAIN table (pk / sk):
//   STORES          / <PHARMACY ID>    pharmacy registry {name}; the ID is what people type at sign-in
//   USERS           / <cognito sub>    profile {login, name, phone, owner, stores:{ID:true}, perms:{...}, disabled}
// Only the one Account Manager can add people/pharmacies and switch access on or off.
//   STORE#<id>      / LINE#<lineId>    open reorder line
//   STORE#<id>      / MEM#<key>        memory {v:{...}}: pkg size / distributor / wording by NDC, drug, rxcui
// ARCHIVE table (pk / sk):
//   <storeId>       / <dateSubmitted>#<submittedAt>#<id>   one archived line. Only ever added, never changed or deleted.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminDeleteUserCommand, AdminDisableUserCommand, AdminEnableUserCommand,
         AdminUpdateUserAttributesCommand, AdminSetUserPasswordCommand, AdminSetUserMFAPreferenceCommand,
         AdminUserGlobalSignOutCommand, AdminGetUserCommand, ListUsersCommand, ChangePasswordCommand } from '@aws-sdk/client-cognito-identity-provider';

const MAIN = process.env.MAIN_TABLE, ARCH = process.env.ARCHIVE_TABLE, POOL = process.env.USER_POOL_ID;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const idp = new CognitoIdentityProviderClient({});

const LINE_FIELDS = ['dateAdded','item','mfr','ndc','ndc10','pkgSize','qty','src','setid','rxcui','autoPkg','dist','autoDist','ordered','orderedAt','itemEdited'];
const ARCH_FIELDS = ['id','lineId','dateAdded','dateSubmitted','submittedAt','item','mfr','ndc','ndc10','setid','pkgSize','qty','dist','ordered','orderedAt'];
const DATE = /^\d{4}-\d{2}-\d{2}$/, STAMP = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
// date-ish fields must look like dates (they are shown on screen); anything else is dropped
function fixDates(o){
  if(o.dateAdded !== undefined && !DATE.test(String(o.dateAdded))) delete o.dateAdded;
  if(o.orderedAt !== undefined && o.orderedAt !== '' && !STAMP.test(String(o.orderedAt))) delete o.orderedAt;
  if(o.submittedAt !== undefined && !STAMP.test(String(o.submittedAt))) delete o.submittedAt;
  if(o.qty !== undefined){ const n = parseInt(o.qty, 10); o.qty = Number.isFinite(n) && n > 0 && n < 100000 ? n : 1; }
  return o;
}

class HttpError extends Error { constructor(code, msg){ super(msg); this.code = code; } }
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
function pick(obj, fields){ const o = {}; for(const f of fields) if(obj && obj[f] !== undefined){ const c = clean(obj[f]); if(c !== undefined) o[f] = c; } return fixDates(o); }
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
const PERMS = ['submit', 'archive', 'remove', 'export'];           // switched on/off per person by the owner
const DEFAULT_PERMS = { submit: true, archive: true, remove: true, export: false };
async function profileOf(sub){
  const r = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'USERS', sk: sub } }));
  return r.Item || null;
}
const STORE_FIELDS = ['name', 'address', 'suite', 'city', 'state', 'zip', 'phone', 'fax', 'email', 'license', 'timezone'];
// each pharmacy's local time zone: dates/times on its orders are shown in it
const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
  'America/Anchorage', 'Pacific/Honolulu', 'America/Puerto_Rico'];
const DEFAULT_TZ = 'America/Chicago';
const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
async function allStores(){
  return (await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'STORES' } }))
    .map(s => ({ id: s.sk, ...pick(s, STORE_FIELDS), timezone: TIMEZONES.includes(s.timezone) ? s.timezone : DEFAULT_TZ, hasLogo: !!s.hasLogo }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
async function storesFor(me){ const all = await allStores(); return me.owner ? all : all.filter(s => (me.stores || {})[s.id] === true); }
function canUse(me, store){ return !!me.owner || (me.stores || {})[store] === true; }
function permsOf(me){ const o = {}; for(const p of PERMS) o[p] = me.owner ? true : ((me.perms || {})[p] ?? DEFAULT_PERMS[p]); return o; }
function need(me, p, what){ if(!permsOf(me)[p]) throw forbidden(`You don't have permission to ${what}. Ask the Account Manager.`); }
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
  const max = { address: 200, suite: 40, city: 80, state: 2, zip: 10 };
  for(const k of STORE_FIELDS) if(b[k] !== undefined) f[k] = String(clean(b[k], max[k] || 120) || '').trim();
  if(f.state) f.state = f.state.toUpperCase();
  if(f.state && !US_STATES.includes(f.state)) throw bad('Pick the state from the list.');
  if(f.zip && !/^\d{5}(-\d{4})?$/.test(f.zip)) throw bad('ZIP code: 5 digits (or ZIP+4, like 76052-1234).');
  if(f.name === '') throw bad('Pharmacy name is required.');
  if(f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) throw bad('Pharmacy email doesn’t look right.');
  if(f.timezone !== undefined && !TIMEZONES.includes(f.timezone)) throw bad('Pick the pharmacy’s time zone from the list.');
  return f;
}
async function addStore(b){
  const id = String(b.id || '').trim().toUpperCase();
  if(!PHARM_ID.test(id)) throw bad('Pharmacy ID: 2–20 letters, numbers or dashes (e.g. NTX1).');
  const f = storeFields(b); if(!f.name) throw bad('Pharmacy name is required.');
  if(!f.timezone) f.timezone = DEFAULT_TZ;
  try{ await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: 'STORES', sk: id, ...f, createdAt: now() }, ConditionExpression: 'attribute_not_exists(pk)' })); }
  catch(e){ if(isCond(e)) throw bad('That Pharmacy ID is already used.'); throw e; }
  return { id, ...f };
}
async function updateStore(id, b){
  if(!okId(id)) throw bad('Bad pharmacy');
  const f = storeFields(b); if(!Object.keys(f).length) return;
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
const TEMP_DAYS = 7;                                   // matches TemporaryPasswordValidityDays in template.yaml
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
  return profiles.filter(p => !p.deleted).map(p => ({ sub: p.sk, login: p.login, name: p.name || '', phone: p.phone || '', owner: !!p.owner, host: !!p.host,
    stores: p.stores || {}, perms: permsOf(p), disabled: status[p.sk] ? !status[p.sk].enabled : !!p.disabled,
    status: (status[p.sk] || {}).status || 'UNKNOWN', ...pendingOf(p, status[p.sk]) }))
    // Account Manager, host, then people still waiting to sign in for the first time, then everyone else
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
async function updatePerson(me, sub, seg3, body){
  if(!okId(sub)) throw bad('Bad user');
  const p = await profileOf(sub); if(!p) throw new HttpError(404, 'No such person.');
  // the host login belongs to IronLedger: the Account Manager sees it but only the host changes it
  // except which pharmacies it may open: only the Account Manager grants that
  if(p.host && !me.host && (seg3 || Object.keys(body).some(k => k !== 'stores'))) throw forbidden('The host login is managed by IronLedger.');
  if(sub === me.sk && body.disabled === true) throw bad('You can’t switch off your own login.');
  if(seg3 === 'delete'){
    // the login is removed for good (the Login ID can be used again); what they did stays on the orders and archive by name.
    // A short record is kept of who existed and who removed them, with their SMS consent dates.
    if(p.owner) throw bad('The Account Manager can’t be deleted.');
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
  if(seg3 === 'reset-password'){
    const pw = body.tempPassword ? String(body.tempPassword) : tempPassword();
    if(pw.length < 10 || !/[a-z]/.test(pw) || !/\d/.test(pw)) throw bad('Temporary password: at least 10 characters with a lowercase letter and a number.');
    await idp.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: p.login, Password: pw, Permanent: false }));
    await idp.send(new AdminUserGlobalSignOutCommand({ UserPoolId: POOL, Username: p.login })).catch(() => {});
    await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'USERS', sk: sub }, UpdateExpression: 'SET tempIssuedAt = :n', ExpressionAttributeValues: { ':n': now() } }));
    return { ok: true, tempPassword: pw };
  }
  if(p.owner && (body.stores !== undefined || body.perms !== undefined || (body.disabled !== undefined && !me.host)))
    throw bad('The Account Manager always has full access.');
  if(p.host && body.perms !== undefined) throw bad('The host login is managed by IronLedger.');
  if(p.host && body.stores !== undefined && me.host) throw bad('Only the Account Manager can give the host access to a pharmacy.');
  const upd = {};
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

// ---------- Account Manager tab lock: password again to open it; locks after 5 minutes without activity there
const UNLOCK_MS = 5 * 60 * 1000;
class Locked extends HttpError { constructor(){ super(423, 'The Account Manager tab is locked. Re-enter your password.'); this.locked = true; } }
const manages = me => !!(me.owner || me.host);         // the Account Manager, and the host (IronLedger)
async function requireUnlocked(me){
  if(!manages(me)) throw forbidden('Only the Account Manager can do that.');
  if(!(me.unlockUntil > Date.now())) throw new Locked();
  await setUnlock(me.sk, Date.now() + UNLOCK_MS);              // activity keeps it open
}
async function setUnlock(sub, until){
  await ddb.send(new UpdateCommand({ TableName: MAIN, Key: { pk: 'USERS', sk: sub }, UpdateExpression: 'SET unlockUntil = :u', ExpressionAttributeValues: { ':u': until } }));
}
// checks the password with Cognito without sending a text: "change" it to itself using the caller's own access token
async function unlock(me, claims, b){
  if(!manages(me)) throw forbidden('Only the Account Manager can do that.');
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

// ---------- router
async function route(method, path, q, body, me, claims){
  const seg = path.split('/').filter(Boolean);
  if(seg[0] === 'api') seg.shift();                    // works with or without an /api prefix

  if(method === 'GET' && seg[0] === 'me' && seg.length === 1)
    return { name: me.name || '', login: me.login, owner: !!me.owner, host: !!me.host, perms: permsOf(me), stores: await storesFor(me) };

  if(seg[0] === 'stores' && seg[1]){
    const store = seg[1];
    if(!okId(store)) throw bad('Bad store');
    if(!canUse(me, store)) throw forbidden();
    const exists = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'STORES', sk: store } }));
    if(!exists.Item) throw new HttpError(404, 'No such store.');
    const what = seg[2];
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
    if(method === 'POST' && what === 'import'){ if(!me.owner) throw forbidden('Only the Account Manager can import.'); await requireUnlocked(me); return await importData(store, body); }
  }

  // two separate gates: /owner/* answers only the Account Manager, /host/* answers only the host (and is a 404 to everyone else)
  if(seg[0] === 'host-unlock' || seg[0] === 'host-lock' || seg[0] === 'host'){
    if(!me.host) throw new HttpError(404, 'Not found');
    seg[0] = seg[0].replace('host', 'owner');
  } else if(seg[0] === 'owner-unlock' || seg[0] === 'owner-lock' || seg[0] === 'owner'){
    if(!me.owner) throw forbidden('Only the Account Manager can do that.');
  }
  if(method === 'POST' && seg[0] === 'owner-unlock') return await unlock(me, claims, body);
  if(method === 'POST' && seg[0] === 'owner-lock'){ await setUnlock(me.sk, 0); return { ok: true }; }
  if(seg[0] === 'owner'){
    await requireUnlocked(me);
    if(method === 'POST' && seg[1] === 'keepalive') return { ok: true };
    // bring in a pharmacy's old shared-drive file: adds only, never changes or removes anything already there
    if(method === 'POST' && seg[1] === 'import' && seg[2]){
      if(!okId(seg[2])) throw bad('Bad pharmacy');
      const ex = await ddb.send(new GetCommand({ TableName: MAIN, Key: { pk: 'STORES', sk: seg[2] } }));
      if(!ex.Item) throw new HttpError(404, 'No such pharmacy.');
      return await importData(seg[2], body);
    }
    if(method === 'GET' && seg[1] === 'stores') return { stores: await allStores() };
    if(method === 'POST' && seg[1] === 'stores' && !seg[2]) return await addStore(body);
    if(method === 'POST' && seg[1] === 'stores' && seg[2] && seg[3] === 'logo'){ await setLogo(seg[2], body.dataUrl); return { ok: true }; }
    if(method === 'POST' && seg[1] === 'stores' && seg[2]){ await updateStore(seg[2], body); return { ok: true }; }
    if(method === 'GET' && seg[1] === 'users') return { users: await listPeople() };
    if(method === 'POST' && seg[1] === 'users' && !seg[2]){
      const stores = await cleanStoreToggles(body.stores), perms = Object.assign({}, DEFAULT_PERMS, cleanPerms(body.perms));
      if(body.smsConsent !== true) throw bad('Have the person sign the SMS consent form first, then tick the box.');
      const u = await createLogin(body);
      try{
        await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: 'USERS', sk: u.sub, login: u.login, name: u.name, phone: u.phone,
          stores, perms, owner: false, createdAt: now(), createdBy: who(me), tempIssuedAt: now(), smsConsentAt: now(), smsConsentRecordedBy: who(me) } }));
      }catch(e){ await idp.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: u.login })).catch(() => {}); throw e; }
      return { ok: true, user: { sub: u.sub, login: u.login, name: u.name, phone: u.phone, stores, perms }, tempPassword: u.tempPassword };
    }
    if(method === 'POST' && seg[1] === 'users' && seg[2]) return await updatePerson(me, seg[2], seg[3], body);
  }
  throw new HttpError(404, 'Not found');
}

// Account Manager + first pharmacy, run once from the deploy script with `aws lambda invoke` (not reachable from the web)
async function bootstrap(b){
  const people = await queryAll({ TableName: MAIN, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'USERS' } });
  if(people.some(p => p.owner)) return { ok: false, message: 'The Account Manager login already exists. Add people from the Account Manager tab in the app.' };
  const stores = await allStores();
  const store = stores[0] || await addStore({ id: b.storeId, name: b.storeName, timezone: b.timezone || DEFAULT_TZ });
  let u;
  try{ u = await createLogin({ login: b.login, name: b.name, phone: b.phone, tempPassword: b.tempPassword }); }
  catch(e){
    if(!/already taken/.test(e.message)) throw e;
    // a previous setup run created the login but stopped before saving it as Account Manager: finish it now
    const login = String(b.login || '').trim().toLowerCase(), pw = b.tempPassword || tempPassword();
    const g = await idp.send(new AdminGetUserCommand({ UserPoolId: POOL, Username: login }));
    const attr = n => ((g.UserAttributes || []).find(a => a.Name === n) || {}).Value || '';
    await idp.send(new AdminSetUserPasswordCommand({ UserPoolId: POOL, Username: login, Password: pw, Permanent: false }));
    u = { sub: attr('sub'), login, name: attr('name') || b.name || '', phone: attr('phone_number'), tempPassword: pw };
  }
  await ddb.send(new PutCommand({ TableName: MAIN, Item: { pk: 'USERS', sk: u.sub, login: u.login, name: u.name, phone: u.phone,
    owner: true, stores: {}, perms: {}, createdAt: now(), createdBy: 'setup' } }));
  return { ok: true, message: `Account Manager login "${u.login}" created. Pharmacy ID: ${store.id} (${store.name}). Temporary password: ${u.tempPassword}`, store, tempPassword: u.tempPassword };
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
    owner: false, host: true, stores: {}, perms: {}, createdAt: now(), createdBy: 'setup' } }));
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
    if(!me || me.disabled || me.deleted) throw forbidden('Your login isn’t switched on for any pharmacy. Ask the Account Manager.');
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
      return json(e.code, { error: e.message, ...(e.locked ? { locked: true } : {}) });
    }
    console.error(e);
    return json(500, { error: 'Something went wrong on the server. Try again; if it keeps happening tell the Account Manager.' });
  }
};

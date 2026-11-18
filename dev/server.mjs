// Local stand-in for AWS: serves web/, runs the real Lambda handler for /api/*, and forwards /cognito to moto.
// Mirrors API Gateway's JWT authorizer by reading the token's claims (moto issues real JWTs).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
process.env.AWS_ENDPOINT_URL = 'http://localhost:5005';
process.env.AWS_REGION = 'us-east-1'; process.env.AWS_ACCESS_KEY_ID = 'x'; process.env.AWS_SECRET_ACCESS_KEY = 'x';
const ids = JSON.parse(fs.readFileSync(new URL('./moto_ids.json', import.meta.url)));
process.env.NPI_API = 'http://localhost:8790/npi-mock/';
process.env.PIN_SECRET = 'dev-only-pin-secret-not-for-aws'; process.env.DOCS_BUCKET = 'nortex-docs-dev'; process.env.DOCS_S3_ENDPOINT = 'http://localhost:8790/s3';
process.env.MAIN_TABLE = 'nortex-reorder-main'; process.env.ARCHIVE_TABLE = 'nortex-reorder-archive'; process.env.USER_POOL_ID = ids.pool;
const { handler } = await import('../app/lambda/index.mjs');
const WEB = path.resolve(process.argv[3] || new URL('../app/web', import.meta.url).pathname);
const PORT = +(process.argv[2] || 8790);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css', '.woff2': 'font/woff2' };
const body = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if(u.pathname === '/cognito'){
    const b = await body(req);
    const r = await fetch('http://localhost:5005/', { method: 'POST', headers: { 'content-type': req.headers['content-type'], 'x-amz-target': req.headers['x-amz-target'] }, body: b });
    res.writeHead(r.status, { 'content-type': 'application/x-amz-json-1.1' }); res.end(await r.text()); return;
  }
  if(u.pathname.startsWith('/s3/')){            // stand-in for the private documents bucket: the signed links point here, and it forwards to moto
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await fetch('http://localhost:5005' + u.pathname.slice(3) + u.search, { method: req.method, headers: req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const h = {}; r.headers.forEach((v, k) => { if(['content-type', 'content-disposition', 'etag'].includes(k)) h[k] = v; });
    res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  if(u.pathname === '/npi-mock/'){            // stand-in for the federal NPI Registry (shape follows API v2.1)
    const n = u.searchParams.get('number'); if(n !== '9999999995') res.writeHead(200, { 'content-type': 'application/json' });
    if(n === '1234567893') res.end(JSON.stringify({ result_count: 1, results: [{ number: 1234567893, enumeration_type: 'NPI-2',
      basic: { organization_name: 'NORTEX PHARMACY LLC', status: 'A', last_updated: '2024-05-01' },
      addresses: [{ address_purpose: 'MAILING', address_1: 'PO BOX 1', city: 'HASLET', state: 'TX', postal_code: '762520001' },
        { address_purpose: 'LOCATION', address_1: '100 MAIN ST', address_2: 'STE 5', city: 'HASLET', state: 'TX', postal_code: '762520001', telephone_number: '817-555-0100', fax_number: '817-555-0101' }],
      taxonomies: [{ code: '3336C0003X', desc: 'Pharmacy - Community/Retail Pharmacy', primary: true, state: 'TX', license: 'TX12345' }] }] }));
    else if(n === '1245319599') res.end(JSON.stringify({ result_count: 1, results: [{ number: 1245319599, enumeration_type: 'NPI-1', basic: { first_name: 'PAT', last_name: 'DOE', credential: 'PHARMD', status: 'A' }, addresses: [], taxonomies: [] }] }));
    else if(n === '9999999995') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{}'); }
    else res.end(JSON.stringify({ result_count: 0, results: [] }));
    return;
  }
  if(u.pathname.startsWith('/api/')){
    const raw = u.pathname.slice(4), b = await body(req);
    let claims = null;
    const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if(tok){ try{ claims = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()); }catch(e){} }
    if(!raw.startsWith('/public/') && (!claims || claims.token_use !== 'id' || claims.exp * 1000 < Date.now())){ res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"message":"Unauthorized"}'); return; }
    const q = Object.fromEntries(u.searchParams);
    const ev = { rawPath: raw, queryStringParameters: Object.keys(q).length ? q : undefined, body: b || undefined,
      requestContext: { http: { method: req.method }, authorizer: claims ? { jwt: { claims } } : undefined } };
    const out = await handler(ev);
    res.writeHead(out.statusCode, out.headers); res.end(out.body); return;
  }
  let f = path.join(WEB, u.pathname === '/' ? 'index.html' : u.pathname);
  if(!f.startsWith(WEB) || !fs.existsSync(f)){ res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
}).listen(PORT, () => console.log('dev on', PORT));

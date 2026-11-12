// Local stand-in for AWS: serves web/, runs the real Lambda handler for /api/*, and forwards /cognito to moto.
// Mirrors API Gateway's JWT authorizer by reading the token's claims (moto issues real JWTs).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
process.env.AWS_ENDPOINT_URL = 'http://localhost:5005';
process.env.AWS_REGION = 'us-east-1'; process.env.AWS_ACCESS_KEY_ID = 'x'; process.env.AWS_SECRET_ACCESS_KEY = 'x';
const ids = JSON.parse(fs.readFileSync(new URL('./moto_ids.json', import.meta.url)));
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

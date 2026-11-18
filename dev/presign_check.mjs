// Compares the hand-written S3 link signing in the API with the official AWS presigner, for fixed time and keys. Prints MATCH or the two URLs.
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
process.env.MAIN_TABLE = 'x'; process.env.ARCHIVE_TABLE = 'x'; process.env.USER_POOL_ID = 'x';
const { presignS3 } = await import('../app/lambda/index.mjs');
const at = new Date('2026-11-18T20:15:30Z'), creds = { id: 'AKIDEXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', token: 'TOKEN/abc+def==' };
let bad = 0;
for(const [label, endpoint, region] of [['virtual-host us-east-1', '', 'us-east-1'], ['virtual-host us-west-2', '', 'us-west-2'], ['path-style (dev)', 'http://localhost:8790/s3', 'us-east-1']]){
  const client = new S3Client({ region, credentials: { accessKeyId: creds.id, secretAccessKey: creds.secret, sessionToken: creds.token }, ...(endpoint ? { endpoint, forcePathStyle: true } : {}) });
  const key = 'NTX1/files/abc 123+x.pdf';
  const put = await getSignedUrl(client, new PutObjectCommand({ Bucket: 'my-docs', Key: key, ContentType: 'application/pdf' }), { expiresIn: 300, signingDate: at, signableHeaders: new Set(['content-type']) });
  const mine = presignS3({ method: 'PUT', bucket: 'my-docs', key, headers: { 'content-type': 'application/pdf' }, at, creds, region, endpoint, query: { 'x-id': 'PutObject', 'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD', 'x-amz-checksum-crc32': 'AAAAAA==', 'x-amz-sdk-checksum-algorithm': 'CRC32' } });
  const get = await getSignedUrl(client, new GetObjectCommand({ Bucket: 'my-docs', Key: key, ResponseContentType: 'application/pdf', ResponseContentDisposition: 'inline; filename="a b.pdf"' }), { expiresIn: 300, signingDate: at });
  const mine2 = presignS3({ method: 'GET', bucket: 'my-docs', key, at, creds, region, endpoint, query: { 'response-content-type': 'application/pdf', 'response-content-disposition': 'inline; filename="a b.pdf"', 'x-id': 'GetObject', 'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD', 'x-amz-checksum-mode': 'ENABLED' } });
  for(const [n, a, b] of [['PUT', put, mine], ['GET', get, mine2]]){
    const norm = u => { const x = new URL(u); return x.origin + x.pathname + '?' + [...x.searchParams].sort((p, q) => p[0] < q[0] ? -1 : 1).map(([k, v]) => k + '=' + v).join('&'); };
    const same = norm(a) === norm(b); if(!same) bad++;
    console.log((same ? 'MATCH ' : 'DIFF  ') + label + ' ' + n); if(!same){ console.log(' sdk ', a); console.log(' mine', b); }
  }
}
process.exit(bad ? 1 : 0);

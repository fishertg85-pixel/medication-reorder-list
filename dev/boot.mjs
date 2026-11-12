import fs from 'node:fs';
process.env.AWS_ENDPOINT_URL='http://localhost:5005'; process.env.AWS_REGION='us-east-1'; process.env.AWS_ACCESS_KEY_ID='x'; process.env.AWS_SECRET_ACCESS_KEY='x';
const ids = JSON.parse(fs.readFileSync(new URL('./moto_ids.json', import.meta.url)));
process.env.MAIN_TABLE='nortex-reorder-main'; process.env.ARCHIVE_TABLE='nortex-reorder-archive'; process.env.USER_POOL_ID=ids.pool;
const { handler } = await import('../app/lambda/index.mjs');
console.log(JSON.stringify(await handler({ bootstrap: JSON.parse(process.argv[2]) })));

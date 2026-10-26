import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const password = process.env.ADMIN_PASSWORD;
if (!token || !account || !password) throw new Error('CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, ADMIN_PASSWORD are required.');
const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;

async function call(path, method = 'GET', body) {
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(`Cloudflare ${method} ${path}: ${response.status} ${JSON.stringify(data.errors || [])}`);
  }
  return data.result;
}

const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
const name = config.d1_databases[0].database_name;
let databases = await call('/d1/database?per_page=100');
if (!Array.isArray(databases)) databases = databases?.databases || [];
let database = databases.find(item => item.name === name);
if (!database) database = await call('/d1/database', 'POST', { name });
const id = database.uuid || database.id;
if (!id) throw new Error('Cloudflare did not return a D1 database ID.');
config.d1_databases[0].database_id = id;
writeFileSync('wrangler.deploy.json', JSON.stringify(config, null, 2));

function run(args, input) {
  const result = spawnSync('./node_modules/.bin/wrangler', args, {
    env: process.env,
    input,
    stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    encoding: 'utf8'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`wrangler ${args[0]} failed with status ${result.status}`);
}

run(['deploy', '--config', 'wrangler.deploy.json']);
run(['secret', 'put', 'ADMIN_PASSWORD', '--config', 'wrangler.deploy.json'], password);
let publicUrl = '';
try {
  const subdomain = await call('/workers/subdomain');
  if (subdomain?.subdomain) publicUrl = `https://${config.name}.${subdomain.subdomain}.workers.dev`;
} catch { /* deployment may work even if subdomain lookup is not permitted */ }
if (publicUrl) {
  console.log(`Student URL: ${publicUrl}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## 학생 접속 주소\n\n${publicUrl}\n`);
}

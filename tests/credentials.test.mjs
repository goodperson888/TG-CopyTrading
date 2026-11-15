import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { LocalCredentials } from '../src/credentials.mjs';
import { createApp } from '../src/server.mjs';
import { DEFAULTS } from '../src/domain.mjs';

const sample = { OKX_API_KEY: 'test-key-local-only', OKX_API_SECRET: 'test-secret-$backslash\\-#', OKX_API_PASSPHRASE: '口令-with-"double\'-quotes', OKX_PROJECT_ID: 'test-project' };
function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'tg-credentials-'));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}

test('本机凭证原子保存并正确往返特殊字符，保留其他配置，留空不清除', t => {
  const root = temporary(t);
  writeFileSync(join(root, '.env'), 'PORT=9988\nOUTBOUND_PROXY="http://127.0.0.1:7890"\nCUSTOM_VALUE="first\nsecond"\n');
  const credentials = new LocalCredentials(root, {});
  assert.equal(credentials.status().configured, false);
  credentials.save(sample);
  const saved = parseEnv(readFileSync(join(root, '.env'), 'utf8'));
  for (const [key, value] of Object.entries(sample)) assert.equal(saved[key], value);
  assert.equal(saved.PORT, '9988'); assert.equal(saved.OUTBOUND_PROXY, 'http://127.0.0.1:7890'); assert.equal(saved.CUSTOM_VALUE, 'first\nsecond');
  credentials.save({ OKX_API_KEY: 'replacement-key', OKX_API_SECRET: '' });
  const reloaded = new LocalCredentials(root, {});
  assert.equal(reloaded.values.OKX_API_SECRET, sample.OKX_API_SECRET);
  assert.equal(reloaded.values.OKX_API_KEY, 'replacement-key');
  assert.equal(reloaded.status().configured, true);
  for (const value of Object.values(sample)) assert.ok(!JSON.stringify(reloaded.status()).includes(value));
  if (process.platform !== 'win32') assert.equal(statSync(join(root, '.env')).mode & 0o777, 0o600);
});

test('拒绝环境变量注入、未知字段和无损往返失败；无效输入不会修改文件', t => {
  const root = temporary(t), credentials = new LocalCredentials(root, {});
  for (const input of [{ PORT: '1' }, { OKX_API_KEY: 'key\nPORT=1' }, { OKX_API_KEY: 123 }, [], null, {}, { OKX_API_KEY: '"\'`' }]) {
    assert.throws(() => credentials.save(input));
    assert.equal(existsSync(join(root, '.env')), false);
  }
  credentials.save(sample);
  const before = readFileSync(join(root, '.env'), 'utf8');
  assert.throws(() => credentials.save({ OKX_API_SECRET: 'secret\rINJECT=1' }));
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), before);
});

async function httpApp(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tg-credentials-http-'));
  const wallet = { env: {}, info: { installed: false, loggedIn: false } };
  const app = createApp({ configRoot: root, credentialEnv: {}, dataDir: join(root, 'data'), runWorker: false, wallet, net: { proxyEnabled: false }, ...options });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const state = await (await fetch(base + '/api/state')).json();
  const post = (path, body = {}, headers = {}) => fetch(base + path, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-local-token': state.csrf, ...headers }, body: JSON.stringify(body) });
  return { root, wallet, app, base, post };
}

test('HTTP 个人凭证受来源与令牌保护，不回显或导出，热更新同时作用于报价和实盘模块', async t => {
  const requests = [];
  const { app, wallet, base, post, root } = await httpApp(t, { net: { proxyEnabled: false, get: async (url, headers) => {
    requests.push(headers['OK-ACCESS-KEY']);
    const p = new URL(url).searchParams;
    return JSON.stringify({ code: '0', data: [{ chainIndex: p.get('chainIndex'), fromTokenAmount: p.get('amount'), toTokenAmount: '1000000',
      fromToken: { tokenContractAddress: p.get('fromTokenAddress'), decimal: p.get('chainIndex') === '501' ? '6' : '18', tokenUnitPrice: '1' },
      toToken: { tokenContractAddress: p.get('toTokenAddress'), decimal: '6', tokenUnitPrice: '1' }, tradeFee: '0.00001', priceImpactPercent: '0.1' }] });
  } } });
  assert.equal((await post('/api/credentials', sample, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await post('/api/credentials', sample, { 'x-local-token': 'bad' })).status, 403);
  assert.equal(existsSync(join(root, '.env')), false);
  app.engine.entriesEnabled = true;
  const response = await post('/api/credentials', sample); assert.equal(response.status, 200);
  const text = await response.text(); for (const value of Object.values(sample)) assert.ok(!text.includes(value));
  assert.equal(app.engine.entriesEnabled, false); assert.equal(app.engine.quotes, app.engine.live.quotes);
  assert.equal(wallet.env.OKX_API_KEY, sample.OKX_API_KEY);
  const snapshot = await (await fetch(base + '/api/state')).json();
  assert.equal(snapshot.credentials.configured, true);
  const exported = await (await fetch(base + '/api/export')).text();
  for (const value of Object.values(sample)) { assert.ok(!JSON.stringify(snapshot).includes(value)); assert.ok(!exported.includes(value)); }
  assert.equal((await fetch(base + '/.env')).status, 404);
  const checked = await post('/api/credentials/test'); assert.equal(checked.status, 200);
  assert.equal(requests.length, 2); assert.deepEqual(new Set(requests), new Set([sample.OKX_API_KEY]));
  await post('/api/credentials', { OKX_API_KEY: 'changed-test-key' });
  assert.equal(app.engine.quotes.verified, false);
  assert.equal((await post('/api/credentials/test')).status, 200);
  assert.deepEqual(requests.slice(2), ['changed-test-key', 'changed-test-key']);
  assert.equal(app.store.list('orders', 'paper').length, 0); assert.equal(app.store.list('orders', 'live').length, 0);
});

test('凭证保存会立即取消正在等待报价的启动，不会自动恢复买入', async t => {
  let finish, entered;
  const wait = new Promise(resolve => { finish = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const { app, post } = await httpApp(t, { quotes: { configured: true, verified: true, quote: async () => { entered(); await wait; return {}; } } });
  t.after(() => finish());
  app.engine.saveSettings({ ...DEFAULTS, orderAmount: 10, totalBudget: 100, maxPositions: 2, takeProfitPct: 30, stopLossPct: 15,
    maxSlippagePct: 1, maxChasePct: 5, maxPriceImpactPct: 2, maxNetworkFeeUsd: 1 });
  app.engine.needsBaseline = false; app.engine.lastSuccess = new Date().toISOString();
  const startup = post('/api/entries/enable'); await ready;
  let paused;
  const pause = new Promise(resolve => { paused = resolve; });
  const original = app.engine.pauseEntries.bind(app.engine);
  app.engine.pauseEntries = () => { original(); paused(); };
  const saving = post('/api/credentials', sample); await pause; finish();
  assert.equal((await startup).status, 400); assert.equal((await saving).status, 200);
  assert.equal(app.engine.entriesEnabled, false);
});

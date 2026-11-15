import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import http from 'node:http';
import { DEFAULTS } from '../src/domain.mjs';

test('本机 HTTP 控制台：来源校验、令牌校验、静态文件隔离和实盘前置检查', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tg-desk-test-'));
  const app = createApp({ dataDir, runWorker: false, net: { proxyEnabled: false, get: async () => { throw new Error('离线测试'); } },
    quotes: { configured: false, lastStatus: '未配置' } });
  t.after(async () => { await app.close(); rmSync(dataDir, { recursive: true }); });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(base + '/api/state'); const initial = await response.json();
  assert.equal(response.status, 200); assert.equal(initial.connections.liveAvailable, false); assert.equal(initial.entriesEnabled, false);
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(dataDir, 'desk.sqlite')).mode & 0o777, 0o600);
    assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  }
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-local-token': initial.csrf, ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('/api/settings', {}, { 'x-local-token': 'bad' })).status, 403);
  assert.equal((await post('/api/settings', {}, { origin: 'https://evil.test' })).status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    const request = http.get(base + '/api/state', { headers: { host: 'evil.test' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await fetch(base + '/.env')).status, 404);
  assert.equal((await fetch(base + '/src/server.mjs')).status, 404);
  assert.equal((await post('/api/settings', { mode: 'live' })).status, 200);
  assert.equal((await post('/api/live', {})).status, 404);
  assert.equal((await post('/api/settings', { mode: 'paper' })).status, 200);
  assert.equal(initial.monitoring, true);
  assert.equal((await post('/api/demo', {})).status, 400);
  assert.equal((await post('/api/entries/enable', {})).status, 400);
  assert.equal((await post('/api/settings', { orderAmount: 10, totalBudget: 100 })).status, 200);
  const saved = await (await fetch(base + '/api/state')).json(); assert.equal(saved.config.orderAmount, 10);
  const exported = await (await fetch(base + '/api/export')).text();
  assert.ok(!exported.includes(initial.csrf)); assert.ok(!exported.includes('OKX_API_SECRET'));
  const html = await fetch(base + '/'); assert.equal(html.status, 200); assert.ok(html.headers.get('content-security-policy').includes("script-src 'self'"));
});

test('同一数据目录只允许一个执行实例，停止后可重新启动', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tg-lock-test-'));
  const opts = { dataDir, runWorker: false, net: { proxyEnabled: false }, quotes: { configured: false } };
  const app = createApp(opts);
  assert.throws(() => createApp(opts), /已有程序/);
  await app.close();
  const reopened = createApp(opts); await reopened.close();
  rmSync(dataDir, { recursive: true });
});

test('启动接口自动报价；暂停请求立即取消在途检查，不会在报价返回后开启跟单', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tg-auto-start-'));
  let finishQuote, quoteEntered, pauseReceived;
  const quoteWait = new Promise(resolve => { finishQuote = resolve; });
  const entered = new Promise(resolve => { quoteEntered = resolve; });
  const paused = new Promise(resolve => { pauseReceived = resolve; });
  const quotes = { configured: true, verified: false, quote: async () => { quoteEntered(); await quoteWait; quotes.verified = true; return {}; } };
  const app = createApp({ dataDir, runWorker: false, net: { proxyEnabled: false }, quotes });
  t.after(async () => { finishQuote(); await app.close(); rmSync(dataDir, { recursive: true }); });
  app.engine.saveSettings({ ...DEFAULTS, orderAmount: 10, totalBudget: 100, maxPositions: 2, takeProfitPct: 30, stopLossPct: 15,
    maxSlippagePct: 1, maxChasePct: 5, maxPriceImpactPct: 2, maxNetworkFeeUsd: 1 });
  app.engine.needsBaseline = false; app.engine.lastSuccess = new Date().toISOString();
  const pause = app.engine.pauseEntries.bind(app.engine);
  app.engine.pauseEntries = () => { pause(); pauseReceived(); };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const state = await (await fetch(base + '/api/state')).json();
  const post = path => fetch(base + path, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-local-token': state.csrf }, body: '{}' });
  const startup = post('/api/entries/enable'); await entered;
  assert.equal((await (await fetch(base + '/api/state')).json()).startingEntries, true);
  const stopping = post('/api/pause'); await paused; finishQuote();
  const result = await startup; assert.equal(result.status, 400); assert.match((await result.json()).error, /启动已取消/);
  assert.equal((await stopping).status, 200);
  assert.equal(app.engine.entriesEnabled, false); assert.equal(app.store.list('orders', 'paper').length, 0);
});

test('连接钱包接口会自动获取登录结果，无需用户再点轮询按钮', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tg-auto-login-'));
  let initiated = false, polled = false;
  const wallet = { info: { installed: true, loggedIn: false },
    beginLogin: async () => { initiated = true; },
    pollLogin: () => { polled = true; return { state: 'waiting', url: 'https://web3.okx.com/account/sociallogin' }; } };
  const app = createApp({ dataDir, runWorker: false, net: { proxyEnabled: false }, quotes: { configured: false }, wallet });
  t.after(async () => { await app.close(); rmSync(dataDir, { recursive: true }); });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const s = await (await fetch(base + '/api/state')).json();
  const response = await fetch(base + '/api/wallet/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-local-token': s.csrf }, body: '{}' });
  assert.equal(response.status, 200); assert.equal((await response.json()).login.state, 'waiting');
  assert.equal(initiated, true); assert.equal(polled, true); assert.equal(app.engine.entriesEnabled, false);
});

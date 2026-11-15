import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { windowsProxy, systemProxy } from '../src/network.mjs';
import { inspectPackage } from '../scripts/package-policy.mjs';
import { Engine } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { createApp } from '../src/server.mjs';
import { APPLICATION, installationId } from '../src/installation.mjs';

test('Windows 系统代理支持统一或按协议配置，忽略关闭、PAC和SOCKS配置', () => {
  assert.equal(windowsProxy({ ProxyEnable: 1, ProxyServer: '127.0.0.1:7890' }), 'http://127.0.0.1:7890/');
  assert.equal(windowsProxy({ ProxyEnable: true, ProxyServer: 'http=localhost:8080;https=localhost:7890;socks=localhost:1080' }), 'http://localhost:7890/');
  assert.equal(windowsProxy({ ProxyEnable: 0, ProxyServer: '127.0.0.1:7890' }), '');
  assert.equal(windowsProxy({ ProxyEnable: 1, ProxyServer: 'socks=localhost:1080' }), '');
  assert.equal(windowsProxy({ ProxyEnable: 1, ProxyServer: 'socks5://localhost:1080' }), '');
  assert.equal(windowsProxy({ ProxyEnable: 1, AutoConfigURL: 'https://example.test/proxy.pac' }), '');
  assert.equal(systemProxy({}, 'win32', () => JSON.stringify({ ProxyEnable: 1, ProxyServer: '127.0.0.1:7890' })), 'http://127.0.0.1:7890/');
  assert.equal(systemProxy({ OUTBOUND_PROXY: 'direct' }, 'win32', () => { throw new Error('不应读取系统'); }), '');
});

test('通用打包策略拒绝凭证、策略快照、数据库和钱包会话目录', t => {
  const root = mkdtempSync(join(tmpdir(), 'tg-package-policy-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.env.example'), 'OKX_API_KEY=\n');
  mkdirSync(join(root, '.tools')); writeFileSync(join(root, '.tools/onchainos.exe'), 'official binary placeholder');
  assert.doesNotThrow(() => inspectPackage(root));
  for (const filename of ['.env', '.env.backup', 'settings.local.json', 'secret.sqlite']) {
    writeFileSync(join(root, filename), 'private-placeholder');
    assert.throws(() => inspectPackage(root), /私密配置|本机数据/); rmSync(join(root, filename));
  }
  mkdirSync(join(root, 'data')); writeFileSync(join(root, 'data/session.json'), 'private-placeholder');
  assert.throws(() => inspectPackage(root), /本机数据/); rmSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, '.tools/credentials.json'), 'private-placeholder');
  assert.throws(() => inspectPackage(root), /混入其他文件/); rmSync(join(root, '.tools/credentials.json'));
  assert.throws(() => inspectPackage(root, { privateConfig: true }), /缺少/);
  writeFileSync(join(root, '.env'), 'OKX_API_KEY=local-placeholder');
  assert.doesNotThrow(() => inspectPackage(root, { privateConfig: true }));
});

test('策略快照只在首次初始化导入，不覆盖既有设置，启动保持暂停', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const quotes = { configured: false }, net = { proxyEnabled: false };
  const e = new Engine(store, quotes, net, [], null, { mode: 'paper', orderAmount: 12, takeProfitPct: 25 });
  assert.equal(e.config.orderAmount, 12); assert.equal(e.entriesEnabled, false); assert.equal(e.config.mode, 'paper');
  e.saveSettings({ orderAmount: 15 });
  const reopened = new Engine(store, quotes, net, [], null, { mode: 'paper', orderAmount: 99 });
  assert.equal(reopened.config.orderAmount, 15); assert.equal(reopened.entriesEnabled, false);
  assert.equal(store.list('orders', 'paper').length, 0);
});

test('正常停止接口验证来源和令牌，拒绝外部请求，并立即取消在途启动', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-shutdown-'));
  const app = createApp({ dataDir: dir, runWorker: false, net: { proxyEnabled: false }, quotes: { configured: false } });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true }); });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.application, APPLICATION); assert.match(state.installationId, /^[a-f0-9]{64}$/);
  assert.notEqual(state.installationId, installationId(dir));
  let requested = false; app.server.once('shutdown-request', () => { requested = true; });
  const post = headers => fetch(base + '/api/shutdown', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
  assert.equal((await post({ origin: 'https://evil.test', 'x-local-token': state.csrf })).status, 403);
  assert.equal((await post({ origin: base, 'x-local-token': 'invalid' })).status, 403);
  assert.equal(requested, false);
  app.engine.entriesEnabled = true;
  assert.equal((await post({ origin: base, 'x-local-token': state.csrf })).status, 200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requested, true); assert.equal(app.engine.entriesEnabled, false);
});

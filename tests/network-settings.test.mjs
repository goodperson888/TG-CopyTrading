import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import http from 'node:http';
import { connect } from 'node:net';
import { LocalCredentials } from '../src/credentials.mjs';
import { LocalNetworkSettings, normalizeProxy } from '../src/network-settings.mjs';
import { network, describeNetworkError } from '../src/network.mjs';
import { createApp } from '../src/server.mjs';
import { AgentWallet } from '../src/wallet.mjs';

const preview = '<div data-post="WoniuTuGou/123"><time datetime="2026-11-16T01:00:00Z"></time><div class="tgme_widget_message_text">公开消息测试</div></div>';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

test('代理端口与 HTTP 地址校验，不接受 SOCKS、非法端口和环境变量注入', () => {
  assert.equal(normalizeProxy('7897'), 'http://127.0.0.1:7897/');
  assert.equal(normalizeProxy('http://localhost:7897'), 'http://localhost:7897/');
  for (const value of ['0', '65536', 'socks5://localhost:7897', '7897\nPORT=1', 'http://localhost/path', 'http://localhost?q=1', undefined]) assert.throws(() => normalizeProxy(value));
});

test('网络与 API 配置交替保存互不覆盖，代理认证信息不回显', t => {
  const root = mkdtempSync(join(tmpdir(), 'tg-net-env-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.env'), 'PORT=8765\nCUSTOM_VALUE=keep-me\n');
  const connection = new LocalNetworkSettings(root, {}, env => env.OUTBOUND_PROXY === 'direct' ? '' : env.OUTBOUND_PROXY || 'http://localhost:9999');
  const credentials = new LocalCredentials(root, {});
  credentials.save({ OKX_API_KEY: 'network-test-key', OKX_API_SECRET: 'network-test-secret', OKX_API_PASSPHRASE: 'network-test-pass' });
  connection.save(connection.prepare({ mode: 'custom', value: '7897' }).raw);
  credentials.save({ OKX_PROJECT_ID: 'new-project' });
  const saved = parseEnv(readFileSync(join(root, '.env'), 'utf8'));
  assert.equal(saved.OUTBOUND_PROXY, 'http://127.0.0.1:7897/'); assert.equal(saved.OKX_API_SECRET, 'network-test-secret'); assert.equal(saved.CUSTOM_VALUE, 'keep-me');
  const authenticated = connection.prepare({ mode: 'custom', value: 'http://proxy-user:private-password@localhost:7897' });
  connection.save(authenticated.raw);
  const status = JSON.stringify(connection.status(authenticated.proxy));
  assert.ok(!status.includes('proxy-user')); assert.ok(!status.includes('private-password'));
  assert.equal(connection.status().value, '');
  assert.equal(connection.prepare({ mode: 'custom', value: '' }).raw, authenticated.raw);
  assert.equal(connection.prepare({ mode: 'auto' }).proxy, 'http://localhost:9999');
  assert.equal(connection.prepare({ mode: 'direct' }).proxy, '');
});

test('真实 HTTP CONNECT 代理切换立即生效；持久化失败保留原网络', async t => {
  let tunneled = 0;
  const origin = http.createServer((req, res) => { res.end('local-network-fixture'); });
  await listen(origin);
  const proxy = http.createServer();
  proxy.on('connect', (req, socket, head) => {
    tunneled++;
    const target = connect(origin.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      target.pipe(socket); socket.pipe(target);
    });
    target.on('error', () => socket.destroy()); socket.on('error', () => target.destroy());
    socket.on('close', () => target.destroy()); target.on('close', () => socket.destroy());
  });
  await listen(proxy);
  const net = network('');
  t.after(async () => { await net.close(); await new Promise(resolve => proxy.close(resolve)); await new Promise(resolve => origin.close(resolve)); });
  const url = `http://127.0.0.1:${origin.address().port}/read`;
  assert.equal(await net.get(url), 'local-network-fixture'); assert.equal(tunneled, 0);
  const address = `http://127.0.0.1:${proxy.address().port}`;
  await assert.rejects(net.configure(address, () => { throw new Error('simulated disk failure'); }), /disk failure/);
  assert.equal(net.proxyEnabled, false);
  let persisted = false;
  await net.configure(address, () => { persisted = true; });
  assert.equal(persisted, true); assert.equal(await net.get(url), 'local-network-fixture'); assert.equal(tunneled, 1);
  await net.configure(''); assert.equal(net.proxyEnabled, false);
  assert.equal(await net.get(url), 'local-network-fixture'); assert.equal(tunneled, 1);
});

test('网络错误给出可操作原因，不输出代理地址与认证信息', () => {
  const cause = new Error('sensitive proxy URL'); cause.code = 'ECONNREFUSED';
  assert.match(describeNetworkError(new Error('fetch failed', { cause }), true), /HTTP／混合端口/);
  cause.code = 'UND_ERR_CONNECT_TIMEOUT';
  assert.match(describeNetworkError(new Error('fetch failed', { cause }), false), /直连超时/);
  assert.ok(!describeNetworkError(new Error('fetch failed', { cause }), true).includes('sensitive'));
});

test('钱包后续命令使用相同代理，切换直连后清除继承的代理环境变量', t => {
  const root = mkdtempSync(join(tmpdir(), 'tg-wallet-proxy-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const wallet = new AgentWallet({ root, dataDir: root, env: { HTTPS_PROXY: 'http://old:1234', all_proxy: 'socks5://old:1234', OKX_API_KEY: 'keep-test-key' }, run: async () => ({}) });
  assert.equal(wallet.env.HTTPS_PROXY, undefined); assert.equal(wallet.env.all_proxy, undefined);
  wallet.setProxy('http://127.0.0.1:7897/'); assert.equal(wallet.env.HTTPS_PROXY, 'http://127.0.0.1:7897/');
  assert.equal(wallet.env.HTTP_PROXY, wallet.env.HTTPS_PROXY);
  wallet.setProxy(''); assert.equal(wallet.env.HTTP_PROXY, undefined); assert.equal(wallet.env.OKX_API_KEY, 'keep-test-key');
});

test('页面网络接口：CSRF、保存保留 Key、共享网络热更新、基线重置和只读测试', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tg-net-http-'));
  writeFileSync(join(root, '.env'), 'OKX_API_KEY=local-test-key\nOKX_API_SECRET=local-test-secret\nOKX_API_PASSPHRASE=local-test-pass\n');
  const net = { proxyUrl: '', proxyEnabled: false, get: async url => { assert.equal(url, 'https://t.me/s/WoniuTuGou'); return preview; },
    async configure(proxy, persist) { persist(); this.proxyUrl = proxy; this.proxyEnabled = Boolean(proxy); } };
  let walletProxy;
  const wallet = { env: {}, info: { installed: false, loggedIn: false }, setProxy: proxy => { walletProxy = proxy; } };
  const app = createApp({ configRoot: root, credentialEnv: {}, proxyResolver: env => env.OUTBOUND_PROXY === 'direct' ? '' : env.OUTBOUND_PROXY || '', dataDir: join(root, 'data'), net, wallet, runWorker: false });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  await listen(app.server);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const state = await (await fetch(base + '/api/state')).json();
  const post = (path, data = {}, headers = {}) => fetch(base + path, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-local-token': state.csrf, ...headers }, body: JSON.stringify(data) });
  assert.equal((await post('/api/network', { mode: 'custom', value: '7897' }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await post('/api/network', { mode: 'direct' }, { 'x-local-token': 'invalid' })).status, 403);
  assert.equal((await post('/api/network', { mode: 'custom', value: 'socks5://localhost:7897' })).status, 400);
  app.engine.entriesEnabled = true; app.engine.needsBaseline = false; app.engine.backoff = 300;
  assert.equal((await post('/api/network', { mode: 'custom', value: '7897' })).status, 200);
  assert.equal(net.proxyUrl, 'http://127.0.0.1:7897/'); assert.equal(walletProxy, net.proxyUrl);
  assert.equal(app.engine.net, app.engine.live.receipts.net); assert.equal(app.engine.quotes.api.net, app.engine.net);
  assert.equal(app.engine.entriesEnabled, false); assert.equal(app.engine.needsBaseline, true); assert.equal(app.engine.backoff, 0);
  assert.equal(parseEnv(readFileSync(join(root, '.env'), 'utf8')).OKX_API_SECRET, 'local-test-secret');
  const tested = await post('/api/network/test'); assert.equal(tested.status, 200); assert.equal((await tested.json()).count, 1);
  assert.equal(app.engine.needsBaseline, true); assert.equal(app.store.list('orders', 'paper').length, 0);
  const status = await (await fetch(base + '/api/state')).json(); assert.equal(status.network.mode, 'custom');
  const exported = await (await fetch(base + '/api/export')).text(); assert.ok(!exported.includes('OUTBOUND_PROXY'));
  assert.equal((await post('/api/network', { mode: 'auto' })).status, 200); assert.equal(net.proxyEnabled, false);
});

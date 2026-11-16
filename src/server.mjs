import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lockDataDir } from './lock.mjs';
import { Store } from './store.mjs';
import { Engine } from './engine.mjs';
import { network, describeNetworkError } from './network.mjs';
import { LocalCredentials, CREDENTIAL_FIELDS } from './credentials.mjs';
import { QuoteRouter } from './quotes.mjs';
import { LocalNetworkSettings } from './network-settings.mjs';
import { parsePreview } from './telegram.mjs';
import { AgentWallet } from './wallet.mjs';
import { LiveExecutor } from './live.mjs';
import { CHAINS, validAddress, units, validateSettings } from './domain.mjs';
import { APPLICATION, installationId } from './installation.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.umask(0o077);
if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));

export function createApp({ dataDir = process.env.TG_COPY_DATA_DIR || join(ROOT, 'data'), configRoot = ROOT, credentialEnv = process.env, proxyResolver, net: injectedNet, quotes: injectedQuotes, wallet: injectedWallet, live: injectedLive, fixtures: injectedFixtures, runWorker = true } = {}) {
  const credentials = new LocalCredentials(configRoot, credentialEnv);
  const connection = new LocalNetworkSettings(configRoot, credentialEnv, proxyResolver);
  let initialSettings = {};
  if (existsSync(join(configRoot, 'settings.local.json'))) {
    try { initialSettings = validateSettings({ ...JSON.parse(readFileSync(join(configRoot, 'settings.local.json'), 'utf8')), mode: 'paper' }); }
    catch { throw new Error('本机策略快照格式无效，请检查 settings.local.json'); }
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const releaseLock = lockDataDir(dataDir);
  const store = new Store(join(dataDir, 'desk.sqlite'));
  const net = injectedNet || network(connection.resolve());
  const wallet = injectedWallet || new AgentWallet({ root: ROOT, dataDir, proxy: net.proxyUrl });
  const quotes = new QuoteRouter(net, wallet, credentials.values, injectedQuotes);
  if (wallet.env) for (const key of CREDENTIAL_FIELDS) wallet.env[key] = credentials.values[key];
  const live = injectedLive || new LiveExecutor(wallet, quotes, net);
  const fixturePath = join(ROOT, 'fixtures', 'messages.json');
  const fixtures = injectedFixtures || (existsSync(fixturePath) ? JSON.parse(readFileSync(fixturePath, 'utf8')) : []);
  const engine = new Engine(store, quotes, net, fixtures, live, initialSettings);
  const token = randomBytes(32).toString('hex');
  let closing = false, timer;
  const headers = {
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  const server = http.createServer(async (request, response) => {
    const reply = (status, data) => {
      response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(data));
    };
    try {
      const host = request.headers.host;
      // Fixed loopback host validation prevents DNS rebinding. No remote UI or CORS.
      if (!/^127\.0\.0\.1:\d+$/.test(host || '') && !/^localhost:\d+$/.test(host || '')) return reply(403, { error: '仅允许本机访问' });
      const url = new URL(request.url, `http://${host}`);
      if (request.method === 'GET' && url.pathname === '/api/state') return reply(200, { ...engine.state(), credentials: credentials.status(), network: connection.status(net.proxyUrl), csrf: token, application: APPLICATION, installationId: installationId(configRoot) });
      if (request.method === 'GET' && url.pathname === '/api/export') {
        response.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="tg-copy-records.json"' });
        const state = engine.state();
        return response.end(JSON.stringify({ exportedAt: new Date().toISOString(), view: state.view,
          config: state.config, signals: state.signals, positions: state.positions, orders: state.orders, logs: state.logs }, null, 2));
      }
      if (request.method === 'GET') {
        const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
        const asset = files[url.pathname];
        if (!asset) return reply(404, { error: '未找到页面' });
        response.writeHead(200, { ...headers, 'Content-Type': asset[1] + '; charset=utf-8' });
        return response.end(readFileSync(join(ROOT, 'public', asset[0])));
      }
      if (request.method !== 'POST') return reply(405, { error: '不支持的请求方式' });
      const origin = request.headers.origin;
      const provided = request.headers['x-local-token'];
      if (origin !== `http://${host}` || typeof provided !== 'string' || provided.length !== token.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) return reply(403, { error: '本机请求校验失败，请刷新页面' });
      if (!request.headers['content-type']?.startsWith('application/json')) return reply(415, { error: '需要 JSON 请求' });
      let size = 0; const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 16000) return reply(413, { error: '请求过大' });
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      catch { return reply(400, { error: 'JSON 格式无效' }); }
      // Pausing takes effect before a queued quote resolves.
      if (['/api/pause', '/api/monitor/stop', '/api/settings', '/api/credentials', '/api/network', '/api/wallet/login', '/api/wallet/login-result', '/api/shutdown'].includes(url.pathname)) engine.pauseEntries();
      if (url.pathname === '/api/shutdown') {
        response.once('finish', () => setImmediate(() => server.emit('shutdown-request')));
        return reply(200, { ok: true, message: '正在正常停止；不会自动清仓。' });
      }
      // Login polling runs outside the trading mutex so public monitoring and exits continue.
      if (url.pathname === '/api/wallet/login-result') return reply(200, { ok: true, login: wallet.pollLogin() });
      if (url.pathname === '/api/wallet/login') { await wallet.beginLogin(); return reply(200, { ok: true, login: wallet.pollLogin() }); }
      if (url.pathname === '/api/wallet/refresh') return reply(200, { ok: true, wallet: await wallet.refresh() });
      const result = await engine.exclusive(async () => {
        switch (url.pathname) {
          case '/api/network': {
            const prepared = connection.prepare(input);
            if (!net.configure) throw new Error('当前网络连接不能动态切换，请重启程序');
            await net.configure(prepared.proxy, () => connection.save(prepared.raw));
            wallet.setProxy?.(prepared.proxy);
            quotes.invalidate();
            engine.needsBaseline = true; engine.lastPoll = 0; engine.backoff = 0; engine.lastError = null; engine.lastSuccess = null;
            engine.store.log('info', '网络配置已保存并生效；新买入暂停，监听将重新建立基线。', engine.config.mode);
            return { network: connection.status(net.proxyUrl) };
          }
          case '/api/network/test': {
            try {
              const messages = parsePreview(await net.get('https://t.me/s/WoniuTuGou', { 'user-agent': 'TGCopyDesk/0.3 public-preview-reader', 'cache-control': 'no-cache' }));
              return { message: `Telegram 连接正常，读取到 ${messages.length} 条公开消息；仅测试连接，未启动跟单。`, count: messages.length };
            } catch (error) { throw new Error(describeNetworkError(error, net.proxyEnabled)); }
          }
          case '/api/credentials': {
            const status = credentials.save(input);
            quotes.apply(credentials.values);
            if (wallet.env) for (const key of CREDENTIAL_FIELDS) wallet.env[key] = credentials.values[key];
            engine.store.log('info', '本机 API 配置已更新，新买入暂停；请测试连接后重新启动跟单。', engine.config.mode);
            return { credentials: status };
          }
          case '/api/credentials/test': return quotes.testCredentials();
          case '/api/settings': return engine.saveSettings(input);
          case '/api/monitor/start': if (!engine.monitoring) await engine.startMonitor(); return {};
          case '/api/monitor/stop': engine.monitoring = false; engine.store.log('info', '频道监听已停止；已有持仓继续检查退出。', engine.config.mode); return {};
          case '/api/entries/enable': return engine.startEntries();
          case '/api/pause': engine.store.log('warn', '新买入已暂停；已有持仓继续按建仓规则检查退出。', engine.config.mode); return {};
          case '/api/demo': await engine.demo(); return {};
          case '/api/view':
            if (!['paper', 'live', 'demo'].includes(input.view) || (input.view === 'demo' && !engine.demoScope)) throw new Error('记录视图无效');
            engine.view = input.view; return {};
          case '/api/position': await engine.positionAction(input.id, input.action); return {};
          case '/api/probe': {
            engine.assertReady();
            const chain = CHAINS[input.chain];
            if (!chain || !validAddress(input.chain, input.address)) throw new Error('请填写支持的公链和完整合约地址');
            const quote = await quotes.quote(input.chain, chain.spend, input.address, units(engine.config.orderAmount, chain.decimals), engine.config.maxPriceImpactPct);
            engine.store.log('info', 'OKX 只读报价测试成功。未创建交易、授权代币、签名或广播。');
            return { quote };
          }
          case '/api/orders/bind': await engine.bindOrder(input.id, input.hash); return {};
          default: return null;
        }
      });
      if (result === null) return reply(404, { error: '未找到接口' });
      reply(200, { ok: true, ...result });
    } catch (error) {
      const safe = String(error.message || '操作失败').slice(0, 350);
      reply(400, { error: safe });
    }
  });
  server.requestTimeout = 20000; server.headersTimeout = 10000;
  const work = async () => {
    if (closing) return;
    try { await engine.exclusive(() => engine.tick()); }
    catch { engine.entriesEnabled = false; store.log('error', '后台任务异常，已暂停新买入，请查看订单和持仓状态。', engine.config.mode); }
    if (!closing) { timer = setTimeout(work, 1000); timer.unref(); }
  };
  if (runWorker) { timer = setTimeout(work, 1000); timer.unref(); }
  return { server, engine, store, async close() {
    closing = true; clearTimeout(timer); engine.pauseEntries(); engine.monitoring = false;
    wallet.close?.(); await engine.mutex;
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    await net.close?.(); store.close(); releaseLock();
  } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8765);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 应为 1024～65535 的端口');
  const app = createApp();
  app.server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已在使用，请查看已有控制台或修改 .env 的 PORT。` : '本机服务启动失败。');
    app.close().finally(() => { process.exitCode = 1; });
  });
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`TG群跟单 · 本机控制台 http://127.0.0.1:${port}`);
    console.log('自动监听已开启。模式：纸上 / 实盘；新买入暂停，等待在控制台启动跟单。Ctrl+C 停止。');
    if (process.platform === 'darwin') execFile('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], () => {});
    if (process.argv.includes('--open')) {
      const url = `http://127.0.0.1:${port}`;
      if (process.platform === 'darwin') execFile('/usr/bin/open', [url], () => {});
      if (process.platform === 'win32') execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url}'`], { windowsHide: true }, () => {});
    }
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    app.close().then(() => process.exit(0));
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  app.server.on('shutdown-request', stop);
}

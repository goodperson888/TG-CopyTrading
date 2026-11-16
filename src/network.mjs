import { execFileSync } from 'node:child_process';
import { ProxyAgent, fetch } from 'undici';

export function windowsProxy(value) {
  if (!value || ![true, 1].includes(value.ProxyEnable) || typeof value.ProxyServer !== 'string') return '';
  const raw = value.ProxyServer.trim();
  const server = raw.includes('=') ? (raw.match(/(?:^|;)\s*https=([^;]+)/i)?.[1] || raw.match(/(?:^|;)\s*http=([^;]+)/i)?.[1]) : raw;
  if (!server) return '';
  try {
    const url = new URL(server.includes('://') ? server : `http://${server}`);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch { return ''; }
}
export function systemProxy(env = process.env, platform = process.platform, run = execFileSync) {
  const explicit = env.OUTBOUND_PROXY || env.HTTPS_PROXY || env.https_proxy;
  if (explicit === 'direct') return '';
  if (explicit) {
    const url = new URL(explicit);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('请配置 HTTP CONNECT 代理地址');
    return url.toString();
  }
  if (platform === 'win32') {
    try {
      const command = "$p=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; @{ProxyEnable=$p.ProxyEnable;ProxyServer=$p.ProxyServer}|ConvertTo-Json -Compress";
      return windowsProxy(JSON.parse(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 4000, windowsHide: true })));
    } catch { return ''; }
  }
  if (platform !== 'darwin') return '';
  try {
    const text = run('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 1500 });
    const host = text.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
    const port = text.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
    if (/HTTPSEnable\s*:\s*1/.test(text) && host && port) return `http://${host}:${port}`;
  } catch { /* 没有代理配置时使用直连 */ }
  return '';
}
export function describeNetworkError(error, proxyEnabled = false) {
  const code = error.cause?.code || error.code;
  if (code === 'ECONNREFUSED') return proxyEnabled ? '无法连接代理，请确认 Clash 已启动且 HTTP／混合端口正确' : '远端拒绝连接，请检查网络或设置代理';
  if (error.name === 'TimeoutError' || ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].includes(code)) return proxyEnabled ? '连接超时，请检查 Clash 节点、分流规则和代理端口' : '直连超时，请开启系统代理或在“网络连接”中填写 HTTP／混合端口';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return '域名解析失败，请检查 DNS、系统代理或 Clash 节点';
  if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code)) return 'HTTPS 证书校验失败，请检查系统时间和代理证书';
  if (error.message === 'fetch failed') return proxyEnabled ? '网络请求失败，请检查代理端口、节点和分流规则' : '网络请求失败，当前未使用代理；请在“网络连接”中设置 HTTP／混合端口';
  return String(error.message || '网络请求失败').slice(0, 180);
}

export function network(proxy = systemProxy()) {
  let dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  return {
    get proxyEnabled() { return Boolean(proxy); },
    get proxyUrl() { return proxy; },
    async configure(nextProxy, persist = () => {}) {
      const next = nextProxy ? new ProxyAgent(nextProxy) : undefined;
      try { persist(); } catch (error) { await next?.close(); throw error; }
      const previous = dispatcher;
      dispatcher = next; proxy = nextProxy;
      await previous?.close().catch(() => {});
    },
    get(url, headers = {}) { return this.request(url, { headers }); },
    async rpc(url, method, params) {
      const json = JSON.parse(await this.request(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }));
      if (json.error || !Object.hasOwn(json, 'result')) throw new Error('链上 RPC 返回错误或不可用');
      return json.result;
    },
    async request(url, options = {}) {
      let response;
      try {
        response = await fetch(url, { ...options, dispatcher,
          signal: AbortSignal.timeout(15000), redirect: 'error' });
      } catch (error) { throw new Error(describeNetworkError(error, Boolean(proxy)), { cause: error }); }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`远程服务 HTTP ${response.status}`); }
      const length = Number(response.headers.get('content-length'));
      if (length > 3e6) { await response.body?.cancel(); throw new Error('远程响应过大'); }
      let total = 0; const chunks = [];
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > 3e6) throw new Error('远程响应过大');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString('utf8');
    },
    async close() { await dispatcher?.close(); },
  };
}

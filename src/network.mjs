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
export function network(proxy = systemProxy()) {
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  return {
    proxyEnabled: Boolean(proxy),
    proxyUrl: proxy,
    get(url, headers = {}) { return this.request(url, { headers }); },
    async rpc(url, method, params) {
      const json = JSON.parse(await this.request(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }));
      if (json.error || !Object.hasOwn(json, 'result')) throw new Error('链上 RPC 返回错误或不可用');
      return json.result;
    },
    async request(url, options = {}) {
      const response = await fetch(url, { ...options, dispatcher,
        signal: AbortSignal.timeout(15000), redirect: 'error' });
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

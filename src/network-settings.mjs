import { join } from 'node:path';
import { readLocalEnv, writeLocalEnv } from './credentials.mjs';
import { systemProxy } from './network.mjs';

export function normalizeProxy(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) throw new Error('请填写 HTTP 代理地址或端口，例如 7897');
  let raw = value;
  if (/^\d+$/.test(raw)) {
    if (Number(raw) < 1 || Number(raw) > 65535) throw new Error('代理端口应为 1～65535');
    raw = `http://127.0.0.1:${Number(raw)}`;
  }
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.search || url.hash || url.pathname !== '/') throw new Error();
    return url.toString();
  } catch { throw new Error('请填写有效的 HTTP 代理地址或端口；不能使用 SOCKS 端口'); }
}

export class LocalNetworkSettings {
  constructor(root, env = process.env, resolver = systemProxy) {
    this.path = join(root, '.env'); this.env = { ...env }; this.resolver = resolver;
    this.raw = readLocalEnv(this.path).OUTBOUND_PROXY ?? env.OUTBOUND_PROXY ?? '';
  }
  resolve(raw = this.raw) { return this.resolver({ ...this.env, OUTBOUND_PROXY: raw }); }
  status(effective = '') {
    let display = '', value = '';
    if (this.raw && this.raw !== 'direct') {
      try { const url = new URL(this.raw); display = url.origin; if (!url.username && !url.password) value = this.raw; } catch { /* 不回显无效或敏感配置 */ }
    }
    let effectiveProxy = '';
    try { if (effective) effectiveProxy = new URL(effective).origin; } catch { /* 不返回代理凭证 */ }
    return { mode: this.raw === 'direct' ? 'direct' : this.raw ? 'custom' : 'auto', value, savedCustom: Boolean(display),
      proxyEnabled: Boolean(effective), effectiveProxy, display };
  }
  prepare(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['mode', 'value'].includes(key))) throw new Error('网络配置字段无效');
    let raw;
    if (input.mode === 'auto') raw = '';
    else if (input.mode === 'direct') raw = 'direct';
    else if (input.mode === 'custom') raw = normalizeProxy(input.value === '' && this.raw && this.raw !== 'direct' ? this.raw : input.value);
    else throw new Error('请选择自动检测、手动代理或直连');
    return { raw, proxy: this.resolve(raw) };
  }
  save(raw) { writeLocalEnv(this.path, { ...readLocalEnv(this.path), OUTBOUND_PROXY: raw }); this.raw = raw; }
}

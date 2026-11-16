import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CHAINS, validAddress } from './domain.mjs';

export const firstObject = value => Array.isArray(value) ? value[0] : value;
export function normalizePolicy(value) {
  if (!value || !['singleTxFlag', 'dailyTradeTxFlag', 'doubleConfirmation'].every(k => typeof value[k] === 'boolean')) return { status: 'unavailable' };
  const limit = (key, flag) => value[flag] && Number(value[key]) > 0 ? String(value[key]) : null;
  return { status: 'available', singleTxLimit: limit('singleTxLimit', 'singleTxFlag'), dailyTradeTxLimit: limit('dailyTradeTxLimit', 'dailyTradeTxFlag'),
    dailyTradeTxUsed: value.dailyTradeTxUsed ?? null, doubleConfirmation: value.doubleConfirmation };
}
export class AgentWallet {
  constructor({ root, dataDir, proxy = '', run, env = process.env }) {
    this.binary = env.ONCHAINOS_BIN || join(root, '.tools', process.platform === 'win32' ? 'onchainos.exe' : 'onchainos');
    this.home = join(dataDir, 'agent-wallet'); mkdirSync(this.home, { recursive: true, mode: 0o700 });
    this.env = { ...env, ONCHAINOS_HOME: this.home, ONCHAINOS_CREDENTIAL_STORE: 'file' };
    this.setProxy(proxy);
    this.runOverride = run; this.children = new Set(); this.login = null;
    this.info = { installed: Boolean(run || existsSync(this.binary)), loggedIn: false, addresses: {}, policy: null, status: '尚未检查钱包', checkedAt: null };
  }
  setProxy(proxy) {
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete this.env[key];
    if (proxy) this.env.HTTPS_PROXY = this.env.HTTP_PROXY = proxy;
  }
  async run(args, timeout = 45000) {
    if (this.runOverride) return this.runOverride(args);
    if (!this.info.installed) throw new Error('未安装项目内 OKX CLI，请运行“安装钱包组件.command”');
    return new Promise((resolve, reject) => {
      const child = execFile(this.binary, args, { env: this.env, timeout, maxBuffer: 2e6, windowsHide: true }, (error, stdout) => {
        this.children.delete(child);
        let json;
        try { json = JSON.parse(stdout.trim()); } catch { return reject(new Error('OKX CLI 超时或响应无效，请核对本机网络；交易结果需要查询原订单')); }
        if (error || json.ok !== true) {
          const message = String(json.error || '').includes('50114') ? 'OKX 无可用身份权限；纸上交易可配置开发者 API 凭证，无需连接钱包' : 'OKX CLI 拒绝或需要额外确认；请检查登录、余额、权限和官方钱包策略';
          return reject(new Error(message));
        }
        resolve(json.data);
      });
      this.children.add(child);
    });
  }
  async refresh() {
    try {
      const status = await this.run(['wallet', 'status']);
      if (!status?.loggedIn) { this.info = { ...this.info, loggedIn: false, addresses: {}, policy: null, status: '请登录独立跟单钱包', checkedAt: new Date().toISOString() }; return this.info; }
      const data = await this.run(['wallet', 'addresses']);
      const addresses = {};
      for (const [chain, rows] of [['SOL', data?.solana], ['BSC', data?.evm]]) {
        const address = (rows || []).find(r => chain === 'SOL' ? String(r.chainIndex) === '501' : String(r.chainIndex) === '56')?.address || (chain === 'BSC' ? data?.evm?.[0]?.address : '');
        if (validAddress(chain, address)) addresses[chain] = address;
      }
      if (data?.accountId !== status.currentAccountId) throw new Error('钱包账户在检查过程中发生变更');
      this.info = { installed: true, loggedIn: true, accountId: status.currentAccountId, accountName: String(status.currentAccountName || '').slice(0, 80),
        addresses, policy: normalizePolicy(status.policy), checkedAt: new Date().toISOString(), status: '钱包已连接，资金和链上权限需按实际交易检查' };
    } catch (error) { this.info = { ...this.info, loggedIn: false, addresses: {}, policy: null, status: error.message, checkedAt: new Date().toISOString() }; }
    return this.info;
  }
  assertReady(config, chain, expected) {
    if (this.login && ['ready', 'waiting'].includes(this.login.state)) throw new Error('钱包登录流程尚未完成，交易签名暂停');
    if (!this.info.loggedIn) throw new Error('请先登录并检查独立跟单钱包');
    if (!this.info.accountId || !Object.keys(this.info.addresses).length) throw new Error('钱包没有支持的网络地址');
    const policy = this.info.policy;
    if (policy?.status !== 'available' || !(Number(policy.singleTxLimit) > 0) || !(Number(policy.dailyTradeTxLimit) > 0)) throw new Error('请先在官方钱包设置单笔和每日交易限额，再刷新钱包');
    if (policy.doubleConfirmation !== false) throw new Error('钱包仍要求逐笔确认，尚不支持无人值守交易');
    if (config.orderAmount > Number(policy.singleTxLimit)) throw new Error('单笔金额高于官方钱包单笔限额');
    if (chain && !validAddress(chain, this.info.addresses[chain])) throw new Error('当前钱包没有此网络地址');
    if (expected && (this.info.accountId !== expected.accountId || this.info.addresses[chain] !== expected.wallet)) throw new Error('当前账户与订单或持仓的钱包不一致');
  }
  async beginLogin() {
    if (this.login?.state === 'waiting') return this.loginPublic();
    const data = await this.run(['wallet', 'login', '--phase', 'init']);
    const url = new URL(data?.loginUrl);
    if (url.protocol !== 'https:' || !(url.hostname === 'okx.com' || url.hostname.endsWith('.okx.com'))) throw new Error('登录地址不是官方 OKX 域名');
    if (!/^[\w-]{1,250}$/.test(data?.authSessionId || '')) throw new Error('登录会话格式无效');
    this.login = { session: data.authSessionId, url: url.href, state: 'ready', message: '请在官方页面完成连接，本机会自动获取登录结果' };
    return this.loginPublic();
  }
  pollLogin() {
    if (!this.login || this.login.state === 'waiting') return this.loginPublic();
    this.login.state = 'waiting'; this.login.message = '等待本机官方登录结果，可继续使用纸上交易';
    this.loginJob = this.run(['wallet', 'login', '--phase', 'poll', '--session-id', this.login.session], 310000)
      .then(async () => { await this.refresh(); this.login.state = this.info.loggedIn ? 'done' : 'error'; this.login.message = this.info.status; })
      .catch(() => { this.login.state = 'error'; this.login.message = '未获得登录结果，可完成登录后重试'; });
    return this.loginPublic();
  }
  loginPublic() { return this.login ? { url: this.login.url, state: this.login.state, message: this.login.message } : null; }
  close() { for (const child of this.children) child.kill('SIGTERM'); }
}

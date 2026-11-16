import { OkxQuotes } from './okx.mjs';
import { CliQuotes } from './live.mjs';
import { CHAINS, units } from './domain.mjs';

// Engine, live execution and HTTP diagnostics keep the same router when credentials change.
export class QuoteRouter {
  constructor(net, wallet, env, injected) {
    this.net = net; this.wallet = wallet; this.apply(env);
    if (injected) this.provider = injected;
  }
  apply(env) {
    this.api = new OkxQuotes(this.net, env);
    this.provider = this.api.configured ? this.api : new CliQuotes(this.wallet);
  }
  get configured() { return this.provider.configured; }
  get verified() { return this.provider.verified; }
  get lastStatus() { return this.provider.lastStatus; }
  quote(...args) { return this.provider.quote(...args); }
  invalidate() {
    for (const source of new Set([this.api, this.provider])) {
      source.verified = false; source.lastStatus = '网络已更换，等待重新验证';
    }
  }
  async testCredentials() {
    if (!this.api.configured) throw new Error('请先保存 API Key、Secret 和 Passphrase');
    this.api.verified = false;
    try {
      for (const [chain, asset] of Object.entries(CHAINS)) {
        await this.api.quote(chain, asset.spend, asset.quoteTarget, units(1, asset.decimals), 30);
      }
    } catch (error) { this.api.verified = false; throw error; }
    return { message: 'SOL / BSC 只读报价通过；未登录钱包或执行交易，实盘权限仍需单独检查。' };
  }
}

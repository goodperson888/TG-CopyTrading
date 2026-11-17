import { createHmac } from 'node:crypto';
import { CHAINS, canonical, finite, human } from './domain.mjs';

const RETRYABLE_QUOTE_CODES = new Set(['82112', '50011']);
const MAX_QUOTE_ATTEMPTS = 3;
function quoteFailure(code, attempts) {
  const reason = code === '82112' ? 'OKX 报价校验暂未通过'
    : code === '50011' ? 'OKX 报价请求限流'
    : 'OKX 接口返回错误';
  return new Error(`${reason}（${code}）${attempts > 1 ? `，已尝试 ${attempts} 次` : ''}；未取得可用报价，未执行交易`);
}

export function signedHeaders(credentials, path, timestamp = new Date().toISOString()) {
  const headers = { 'OK-ACCESS-KEY': credentials.key, 'OK-ACCESS-PASSPHRASE': credentials.passphrase,
    'OK-ACCESS-TIMESTAMP': timestamp, 'OK-ACCESS-SIGN': createHmac('sha256', credentials.secret).update(timestamp + 'GET' + path).digest('base64') };
  if (credentials.project) headers['OK-ACCESS-PROJECT'] = credentials.project;
  return headers;
}
export class OkxQuotes {
  constructor(net, env = process.env) {
    this.net = net;
    this.credentials = { key: env.OKX_API_KEY || '', secret: env.OKX_API_SECRET || '', passphrase: env.OKX_API_PASSPHRASE || '', project: env.OKX_PROJECT_ID || '' };
    this.queue = Promise.resolve(); this.lastRequest = 0; this.lastStatus = '尚未验证'; this.verified = false;
  }
  get configured() { return Boolean(this.credentials.key && this.credentials.secret && this.credentials.passphrase); }
  quote(chain, from, to, amount, impactLimit = 10) {
    const task = this.queue.then(async () => {
      if (!this.configured) throw new Error('尚未配置 OKX API 凭证，只能进行离线演练');
      if (!CHAINS[chain]) throw new Error('网络暂不支持');
      if (!/^\d+$/.test(String(amount)) || BigInt(amount) <= 0n) throw new Error('报价金额无效');
      const path = '/api/v6/dex/aggregator/quote?' + new URLSearchParams({ chainIndex: CHAINS[chain].index,
        fromTokenAddress: from, toTokenAddress: to, amount: String(amount), swapMode: 'exactIn', priceImpactProtectionPercent: String(impactLimit) });
      for (let attempt = 1; attempt <= MAX_QUOTE_ATTEMPTS; attempt++) {
        // Retry the identical read-only request, with a fresh signature and rate limiting.
        // Never change the amount, route protection or risk checks to obtain a quote.
        const wait = Math.max(0, (attempt > 1 ? 2400 : 1200) - (Date.now() - this.lastRequest));
        if (wait) await new Promise(resolve => setTimeout(resolve, wait));
        this.lastRequest = Date.now();
        let json;
        try { json = JSON.parse(await this.net.get('https://web3.okx.com' + path, signedHeaders(this.credentials, path))); }
        catch { this.lastStatus = '请求失败'; throw new Error('OKX 报价请求失败，请检查网络、凭证、IP 白名单和账户权限'); }
        if (String(json?.code) !== '0') {
          // Only expose a bounded code; the remote body can contain credentials or untrusted text.
          const rawCode = String(json?.code ?? '');
          const code = /^\d{1,10}$/.test(rawCode) ? rawCode : 'unknown';
          if (RETRYABLE_QUOTE_CODES.has(code) && attempt < MAX_QUOTE_ATTEMPTS) {
            this.lastStatus = `报价暂不可用（${code}），正在重试 ${attempt}/${MAX_QUOTE_ATTEMPTS - 1}`;
            continue;
          }
          const error = quoteFailure(code, attempt);
          this.lastStatus = error.message;
          throw error;
        }
        const quote = normalizeQuote(json.data?.[0], { chain, from, to, amount });
        quote.requestAttempts = attempt;
        this.verified = true;
        this.lastStatus = `只读报价成功${attempt > 1 ? `（重试 ${attempt - 1} 次后恢复）` : ''}；实盘权限未验证`;
        return quote;
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }
}
export function normalizeQuote(q, request) {
  if (!q?.fromToken || !q?.toToken || String(q.chainIndex) !== CHAINS[request.chain]?.index) throw new Error('报价缺少资产信息或公链不一致');
  const from = canonical(request.chain, q.fromToken.tokenContractAddress || '');
  const to = canonical(request.chain, q.toToken.tokenContractAddress || '');
  if (from !== canonical(request.chain, request.from) || to !== canonical(request.chain, request.to) || q.fromTokenAmount !== String(request.amount)) throw new Error('报价资产或输入数量与请求不一致');
  const fromDecimals = Number(q.fromToken.decimal), toDecimals = Number(q.toToken.decimal);
  const fromAmount = human(q.fromTokenAmount, fromDecimals), toAmount = human(q.toTokenAmount, toDecimals);
  if (fromAmount <= 0 || toAmount <= 0) throw new Error('没有可执行兑换数量');
  if ([q.fromToken.isHoneyPot, q.toToken.isHoneyPot].some(v => v === true || v === 'true')) throw new Error('报价风险标记为蜜罐，跳过');
  const networkFeeUsd = finite(q.tradeFee, '预估网络费');
  if (networkFeeUsd < 0) throw new Error('网络费无效');
  return { fromRaw: q.fromTokenAmount, toRaw: q.toTokenAmount, fromAmount, toAmount, fromDecimals, toDecimals,
    fromPriceUsd: finite(q.fromToken.tokenUnitPrice, '输入币美元价格'), toPriceUsd: finite(q.toToken.tokenUnitPrice, '输出币美元价格'),
    priceImpactPct: Math.abs(finite(q.priceImpactPercent, '价格影响')), networkFeeUsd,
    at: new Date().toISOString(), source: 'okx-quote', executable: false };
}

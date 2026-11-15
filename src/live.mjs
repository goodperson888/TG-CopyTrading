import { createHash } from 'node:crypto';
import { CHAINS, canonical, conservativeAmount, validAddress } from './domain.mjs';
import { normalizeQuote } from './okx.mjs';
import { firstObject } from './wallet.mjs';
import { Receipts } from './receipts.mjs';

export function unwrap(value) {
  if (value?.code !== undefined) { if (String(value.code) !== '0') throw new Error('OKX 请求被拒绝'); value = value.data; }
  const obj = firstObject(value);
  if (!obj || typeof obj !== 'object') throw new Error('OKX 返回的数据为空');
  return obj;
}
export class CliQuotes {
  constructor(wallet) { this.wallet = wallet; this.verified = false; this.lastStatus = '尚未验证'; this.queue = Promise.resolve(); this.lastRequest = 0; }
  get configured() { return this.wallet.info.installed && this.wallet.info.loggedIn; }
  quote(chain, from, to, amount) {
    const task = this.queue.then(async () => {
      const wait = Math.max(0, 1200 - (Date.now() - this.lastRequest));
      if (wait) await new Promise(r => setTimeout(r, wait)); this.lastRequest = Date.now();
      const raw = unwrap(await this.wallet.run(['swap', 'quote', '--chain', CHAINS[chain].index, '--from', from, '--to', to, '--amount', String(amount)]));
      if (raw.action && raw.action !== 'ok') throw new Error('官方路由风险提示，跳过此代币');
      const q = normalizeQuote(raw, { chain, from, to, amount });
      this.verified = true; this.lastStatus = '官方 CLI 只读报价成功'; return q;
    });
    this.queue = task.catch(() => { this.lastStatus = 'CLI 报价不可用，请检查权限或配置 API 凭证'; }); return task;
  }
}
export class LiveExecutor {
  constructor(wallet, quotes, net, env = process.env) { this.wallet = wallet; this.quotes = quotes; this.receipts = new Receipts(net, env); }
  async prepare({ chain, from, to, inputRaw, policy, expected, check }) {
    await this.wallet.refresh(); this.wallet.assertReady(policy, chain, expected);
    const address = this.wallet.info.addresses[chain];
    const accountId = this.wallet.info.accountId;
    const data = unwrap(await this.wallet.run(['swap', 'swap', '--chain', CHAINS[chain].index, '--from', from, '--to', to,
      '--amount', inputRaw, '--wallet', address, '--slippage', String(policy.maxSlippagePct), '--swap-mode', 'exactIn']));
    const q = normalizeQuote(data.routerResult, { chain, from, to, amount: inputRaw });
    if (data.routerResult.action !== 'ok') throw new Error('待签路由风险未通过，禁止自动覆盖风险');
    check(q);
    const tx = data.tx;
    if (!tx || typeof tx.data !== 'string' || tx.data.length > 100000 || typeof tx.to !== 'string') throw new Error('待签交易缺少数据或目的地址');
    if (tx.from && canonical(chain, tx.from) !== canonical(chain, address)) throw new Error('待签交易钱包不一致');
    const native = chain === 'SOL' ? '11111111111111111111111111111111' : '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const nativeQuote = await this.quotes.quote(chain, native, CHAINS[chain].spend, chain === 'SOL' ? '1000000000' : '1000000000000000000', policy.maxPriceImpactPct);
    const nativePriceUsd = nativeQuote.fromPriceUsd;
    if (!(nativePriceUsd > 0)) throw new Error('无法验证原生币费用折价');
    const args = ['wallet', 'contract-call', '--chain', CHAINS[chain].index, '--from', address, '--to', tx.to, '--amt', '0', '--biz-type', 'dex'];
    let scanArgs;
    if (chain === 'SOL') {
      if (!validAddress('SOL', tx.to)) throw new Error('Solana 交易程序地址无效');
      if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(tx.data)) throw new Error('Solana 待签交易编码无效');
      args.push('--unsigned-tx', tx.data);
      scanArgs = ['security', 'tx-scan', '--chain', '501', '--from', address, '--encoding', 'base58', '--transactions', tx.data];
    } else {
      if (!validHex(tx.data) || !/^0x[0-9a-fA-F]{40}$/.test(tx.to) || !/^\d+$/.test(tx.gas || '') || BigInt(tx.value || '0') !== 0n) throw new Error('BSC 待签交易字段无效');
      // Do not grant unlimited or implicit approvals. Missing allowance skips this signal.
      await this.checkAllowance(from, inputRaw, address);
      if (canonical('BSC', from) === canonical('BSC', CHAINS.BSC.spend)) await this.checkAllowance(to, q.toRaw, address);
      args.push('--input-data', tx.data, '--gas-limit', tx.gas, '--mev-protection');
      scanArgs = ['security', 'tx-scan', '--chain', '56', '--from', address, '--to', tx.to, '--data', tx.data, '--value', '0', '--gas', tx.gas];
    }
    const scan = unwrap(await this.wallet.run(scanArgs));
    if (!['', 'ok'].includes(scan.action) || (scan.warnings?.length) || scan.simulator?.revertReason || scan.riskItemDetail?.some(r => r.action === 'warn' || r.action === 'block')) throw new Error('交易扫描未通过或要求人工确认，已跳过');
    check(q); // Same unsigned transaction; no hidden re-quote after this check.
    this.wallet.assertReady(policy, chain, { accountId, wallet: address });
    return { quote: q, args, wallet: address, accountId, nativePriceUsd,
      txTo: tx.to, txFingerprint: createHash('sha256').update(tx.data).digest('hex'),
      minOutputRaw: conservativeAmount(q.toRaw, policy.maxSlippagePct) };
  }
  async checkAllowance(tokenAddress, amount, address) {
    const approval = unwrap(await this.wallet.run(['swap', 'approve', '--chain', '56', '--token', tokenAddress, '--amount', amount]));
    if (!/^0x[0-9a-fA-F]{40}$/.test(approval.dexContractAddress || '')) throw new Error('无法验证授权路由');
    const allowance = unwrap(await this.wallet.run(['swap', 'check-approvals', '--chain', '56', '--address', address, '--token', tokenAddress, '--spender', approval.dexContractAddress]));
    const token = allowance.tokens?.find(t => canonical('BSC', t.tokenContractAddress || t.tokenAddress || '') === canonical('BSC', tokenAddress));
    if (!/^\d+$/.test(token?.spendable || '') || BigInt(token.spendable) < BigInt(amount)) throw new Error('BSC 买入或退出路由授权不足；此首推跳过，请先在官方钱包处理授权');
  }
  async submit(prepared) {
    // No --force, auto-slippage, auto-approval or automatic resubmission.
    const result = unwrap(await this.wallet.run(prepared.args, 60000));
    if (!result.txHash) throw new Error('官方未返回交易哈希，须核对原订单，禁止自动重发');
    return result.txHash;
  }
  get(order) { return this.receipts.get(order); }
}
function validHex(value) { return /^0x(?:[a-fA-F0-9]{2})+$/.test(value); }

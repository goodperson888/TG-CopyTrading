import { CHAINS, canonical, human } from './domain.mjs';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export function validHash(chain, hash) { return typeof hash === 'string' && (chain === 'BSC' ? /^0x[0-9a-fA-F]{64}$/.test(hash) : /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(hash)); }
export function solanaFill(tx, order) {
  if (!tx?.meta) return null;
  const keys = tx.transaction?.message?.accountKeys || [];
  const ownerIndex = keys.findIndex(k => (typeof k === 'string' ? k : k.pubkey) === order.wallet);
  if (ownerIndex < 0 || !keys[ownerIndex]?.signer) throw new Error('成交回执签名者与策略钱包不一致');
  if (tx.blockTime && tx.blockTime * 1000 < Date.parse(order.createdAt) - 120000) throw new Error('此交易早于策略订单，禁止关联旧成交');
  if (tx.meta.err) return { status: 'failed', feeNative: Number(tx.meta.fee) / 1e9 };
  const sum = (rows, mint) => (rows || []).filter(r => r.owner === order.wallet && r.mint === mint).reduce((n, r) => n + BigInt(r.uiTokenAmount.amount), 0n);
  const delta = mint => sum(tx.meta.postTokenBalances, mint) - sum(tx.meta.preTokenBalances, mint);
  const spent = -delta(order.from), received = delta(order.to);
  const nativeDecrease = (Number(tx.meta.preBalances[ownerIndex]) - Number(tx.meta.postBalances[ownerIndex])) / 1e9;
  return complete(order, spent, received, Math.max(Number(tx.meta.fee) / 1e9, nativeDecrease, 0));
}
export function bscFill(receipt, order) {
  if (!receipt) return null;
  if (canonical('BSC', receipt.from || '') !== canonical('BSC', order.wallet)) throw new Error('成交回执发送者与策略钱包不一致');
  if (order.txTo && canonical('BSC', receipt.to || '') !== canonical('BSC', order.txTo)) throw new Error('成交回执路由与原订单不一致');
  const feeNative = Number(BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)) / 1e18;
  if (BigInt(receipt.status) === 0n) return { status: 'failed', feeNative };
  const owner = order.wallet.slice(2).toLowerCase();
  const delta = token => (receipt.logs || []).filter(l => l.address.toLowerCase() === token.toLowerCase() && l.topics?.[0] === TRANSFER).reduce((n, l) => {
    const input = l.topics[2]?.slice(-40).toLowerCase() === owner ? BigInt(l.data) : 0n;
    const output = l.topics[1]?.slice(-40).toLowerCase() === owner ? BigInt(l.data) : 0n;
    return n + input - output;
  }, 0n);
  return complete(order, -delta(order.from), delta(order.to), feeNative);
}
function complete(order, spent, received, feeNative) {
  if (spent !== BigInt(order.inputRaw) || received <= 0n || !Number.isFinite(feeNative) || feeNative < 0) throw new Error('链上资产变化与订单不一致，需要人工核对；不会猜测成交数量');
  return { status: 'confirmed', inputRaw: spent.toString(), outputRaw: received.toString(),
    fromAmount: human(spent.toString(), order.fromDecimals), toAmount: human(received.toString(), order.toDecimals), feeNative };
}
export class Receipts {
  constructor(net, env = process.env) { this.net = net; this.urls = { SOL: env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', BSC: env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org' }; }
  async get(order) {
    if (!validHash(order.chain, order.txHash)) throw new Error('交易哈希格式无效');
    const rpc = (method, params) => this.net.rpc(this.urls[order.chain], method, params);
    if (order.chain === 'SOL') {
      const tx = await rpc('getTransaction', [order.txHash, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
      return solanaFill(tx, order);
    }
    const receipt = await rpc('eth_getTransactionReceipt', [order.txHash]);
    if (!receipt) return null;
    const block = await rpc('eth_blockNumber', []);
    if (BigInt(block) - BigInt(receipt.blockNumber) < 2n) return null;
    const detail = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
    if (!detail?.timestamp || Number(BigInt(detail.timestamp)) * 1000 < Date.parse(order.createdAt) - 120000) throw new Error('无法核验成交时间或交易早于策略订单');
    return bscFill(receipt, order);
  }
}

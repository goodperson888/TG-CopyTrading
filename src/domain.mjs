export const CHANNEL = 'WoniuTuGou';
export const CHAINS = {
  SOL: { index: '501', symbol: 'USDC', decimals: 6, spend: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', quoteTarget: 'So11111111111111111111111111111111111111112' },
  BSC: { index: '56', symbol: 'USDT', decimals: 18, spend: '0x55d398326f99059ff775485246999027b3197955', quoteTarget: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' },
};
export const DEFAULTS = {
  mode: 'paper', orderAmount: null, totalBudget: null, maxPositions: null,
  takeProfitPct: null, stopLossPct: null, maxSlippagePct: null,
  maxChasePct: null, maxPriceImpactPct: null, maxNetworkFeeUsd: null,
  maxSignalAgeSec: 120, pollSeconds: 20, quoteSeconds: 30,
  maxExitAttempts: 3, exitRetrySeconds: 30,
};
export const FIELDS = {
  orderAmount: ['单笔金额', .01, 1e6], totalBudget: ['累计投入上限', .01, 1e8],
  maxPositions: ['最大持仓数', 1, 100, true], takeProfitPct: ['止盈涨幅', .01, 10000],
  stopLossPct: ['止损跌幅', .01, 99.99], maxSlippagePct: ['最大滑点', 0, 30],
  maxChasePct: ['最大追价', 0, 1000], maxPriceImpactPct: ['最大价格影响', 0, 30],
  maxNetworkFeeUsd: ['单笔网络费上限', 0, 1000], maxSignalAgeSec: ['信号有效期', 10, 3600, true],
  pollSeconds: ['频道轮询间隔', 10, 300, true], quoteSeconds: ['持仓报价间隔', 10, 600, true],
  maxExitAttempts: ['自动卖出尝试次数', 1, 10, true], exitRetrySeconds: ['卖出重试间隔', 10, 3600, true],
};
export function validateSettings(input, previous = DEFAULTS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置必须是对象');
  const result = { ...previous };
  for (const [key, value] of Object.entries(input)) {
    if (key === 'mode') {
      if (!['paper', 'live'].includes(value)) throw new Error('请选择纸上交易或实盘交易');
      result[key] = value; continue;
    }
    const rule = FIELDS[key];
    if (!rule) throw new Error(`未知配置项：${key.slice(0, 40)}`);
    if (value === null && DEFAULTS[key] === null) { result[key] = null; continue; }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < rule[1] || value > rule[2] || (rule[3] && !Number.isInteger(value))) {
      throw new Error(`${rule[0]}应为 ${rule[1]}～${rule[2]}${rule[3] ? ' 的整数' : ' 的数字'}`);
    }
    result[key] = value;
  }
  if (result.orderAmount && result.totalBudget && result.orderAmount > result.totalBudget) throw new Error('单笔金额不能高于累计投入上限');
  return result;
}
export function missingSettings(config) {
  return Object.keys(FIELDS).filter(k => config[k] === null).map(k => FIELDS[k][0]);
}
export function canonical(chain, address) { return chain === 'SOL' ? address : address.toLowerCase(); }
export function validAddress(chain, address) {
  if (typeof address !== 'string') return false;
  if (chain === 'BSC') return /^0x[0-9a-fA-F]{40}$/.test(address) && !/^0x0{40}$/.test(address);
  if (chain !== 'SOL' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const c of address) value = value * 58n + BigInt(alphabet.indexOf(c));
  let length = 0;
  while (value > 0n) { length++; value >>= 8n; }
  return length + (address.match(/^1*/)?.[0].length || 0) === 32;
}
export function units(amount, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('代币精度无效');
  const text = (typeof amount === 'number' ? amount.toFixed(Math.min(decimals, 8)) : String(amount)).replace(/^\./, '0.');
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error('金额格式无效');
  const [whole, fraction = ''] = text.split('.');
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')).toString();
}
export function human(raw, decimals) {
  if (!/^\d+$/.test(String(raw)) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('报价数量或精度无效');
  const value = Number(raw) / 10 ** decimals;
  if (!Number.isFinite(value)) throw new Error('报价数量溢出');
  return value;
}
export function conservativeAmount(raw, slippagePct) {
  return (BigInt(raw) * BigInt(Math.floor((100 - slippagePct) * 10000)) / 1000000n).toString();
}
export function finite(value, label) {
  if (!['string', 'number'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value))) throw new Error(`${label}缺失，保守跳过`);
  return Number(value);
}

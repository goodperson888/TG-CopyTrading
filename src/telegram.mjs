import { parseHTML } from 'linkedom';
import { CHANNEL, canonical, validAddress } from './domain.mjs';

function plain(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeName === 'BR') return '\n';
  if (['SCRIPT', 'STYLE'].includes(node.nodeName)) return '';
  return [...node.childNodes].map(plain).join('');
}
export function parsePreview(html) {
  if (typeof html !== 'string' || html.length > 3e6) throw new Error('公开预览响应过大或格式无效');
  const { document } = parseHTML(html);
  const messages = [];
  for (const element of document.querySelectorAll('[data-post]')) {
    const match = element.getAttribute('data-post')?.match(/^WoniuTuGou\/(\d+)$/);
    const body = element.querySelector('.tgme_widget_message_text');
    if (!match || !body) continue;
    const publishedAt = element.querySelector('time[datetime]')?.getAttribute('datetime');
    if (!publishedAt || !Number.isFinite(Date.parse(publishedAt))) continue;
    messages.push({ id: Number(match[1]), publishedAt: new Date(publishedAt).toISOString(),
      text: plain(body).slice(0, 30000), links: [...element.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).slice(0, 40),
      source: `https://t.me/${CHANNEL}/${match[1]}` });
  }
  if (!messages.length) throw new Error('未找到公开消息：可能是网络验证页、频道限制或页面结构变化');
  return messages.sort((a, b) => a.id - b.id);
}
function linkAsset(link) {
  try {
    const url = new URL(link);
    if (url.protocol !== 'https:') return null;
    if (url.hostname === 'web3.okx.com') {
      const match = url.pathname.match(/^\/token\/([a-z0-9-]+)\/([^/]+)\/?$/i);
      if (match) return { chain: /^(solana|sol)$/i.test(match[1]) ? 'SOL' : /^(bsc|bnb|56)$/i.test(match[1]) ? 'BSC' : 'unsupported:' + match[1], address: match[2] };
    }
    if (url.hostname === 'gmgn.ai') {
      const match = url.pathname.match(/^\/([a-z0-9-]+)\/token\/(?:[^_]+_)?([^/]+)\/?$/i);
      if (match) return { chain: match[1].toUpperCase() === 'SOL' ? 'SOL' : match[1].toUpperCase() === 'BSC' ? 'BSC' : 'unsupported:' + match[1], address: match[2] };
    }
  } catch { /* 群内链接只作为数据解析，不访问或执行 */ }
  return null;
}
export function classify(message) {
  const text = message.text || '';
  const heading = text.split('\n')[0];
  let kind = 'unknown';
  if (/日报|日汇总/.test(heading)) kind = 'report';
  else if (/强势跟踪/.test(heading)) kind = 'followup';
  else if (/蜗牛Meme雷达/.test(heading) && /新币/.test(heading)) kind = 'first';
  const result = { kind, name: text.match(/名称\s*[:：]\s*([^\n]+)/)?.[1]?.trim().slice(0, 80) || heading.replace(/^.*强势跟踪[｜|]/, '').trim().slice(0, 80),
    chain: null, address: null, price: null, valid: false, problem: '' };
  const contracts = [...text.matchAll(/合约\s*[:：]\s*([1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})(?![A-Za-z0-9])/g)].map(m => m[1]);
  const assets = (message.links || []).map(linkAsset).filter(Boolean);
  const label = heading.match(/\b([A-Za-z][A-Za-z0-9]*)\s+新币/)?.[1]?.toUpperCase();
  const chainFromHeading = label ? label === 'BNB' ? 'BSC' : label : null;
  const chains = new Set([...assets.map(a => a.chain), ...(chainFromHeading ? [chainFromHeading] : [])]);
  if (kind === 'report') { result.problem = '日报仅归档'; return result; }
  if (chains.size !== 1 || !contracts.length) { result.problem = '缺少明确公链或合约地址'; return result; }
  result.chain = [...chains][0];
  const addresses = new Set([...contracts, ...assets.map(a => a.address)].map(a => canonical(result.chain, a)));
  if (addresses.size !== 1) { result.problem = '正文与交易链接的链或地址不一致'; return result; }
  result.address = [...addresses][0];
  result.valid = validAddress(result.chain, result.address);
  if (!result.valid) result.problem = '地址格式校验失败或网络暂不支持';
  const price = text.match(/(?:^|\n)[^\n]*?价格\s*[:：]\s*\$?([0-9]+(?:\.[0-9]+)?(?:[eE][+-]?\d+)?)/)?.[1];
  if (price && Number.isFinite(Number(price)) && Number(price) > 0) result.price = Number(price);
  return result;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { parsePreview, classify } from '../src/telegram.mjs';
import { DEFAULTS, CHAINS, validateSettings, missingSettings, validAddress, units, human, conservativeAmount } from '../src/domain.mjs';
import { normalizeQuote, signedHeaders, OkxQuotes } from '../src/okx.mjs';

const fixtures = JSON.parse(readFileSync(new URL('../fixtures/messages.json', import.meta.url)));
const first = fixtures.filter(m => classify(m).kind === 'first');
const config = { ...DEFAULTS, orderAmount: 10, totalBudget: 10000, maxPositions: 100, takeProfitPct: 30, stopLossPct: 15,
  maxSlippagePct: 1, maxChasePct: 10, maxPriceImpactPct: 5, maxNetworkFeeUsd: 1 };
function setup(t, settings = {}) {
  const store = new Store(':memory:');
  const net = { proxyEnabled: false, get: async () => { throw new Error('测试不访问网络'); } };
  const quotes = { configured: false, lastStatus: '测试', quote: async () => { throw new Error('缺少 API 凭证'); } };
  const engine = new Engine(store, quotes, net, fixtures); engine.saveSettings({ ...config, ...settings });
  t.after(() => store.close());
  return engine;
}
function fresh(message, id = 9001) { return { ...message, id, publishedAt: new Date().toISOString() }; }
function arm(engine) { engine.config.mode = 'paper'; engine.entriesEnabled = true; engine.quotes.configured = true; }
function fakeMarket(engine) {
  engine.quotes.quote = async (chain, from, to, amount) => {
    const a = classify(first.find(m => classify(m).chain === chain));
    if (from === CHAINS[chain].spend) return engine.demoBuyQuote(a, amount);
    const quantity = human(amount, 6), output = quantity * a.price;
    return { fromRaw: amount, fromAmount: quantity, fromDecimals: 6, toRaw: units(output.toFixed(6), CHAINS[chain].decimals), toAmount: output,
      toDecimals: CHAINS[chain].decimals, fromPriceUsd: a.price, toPriceUsd: 1, priceImpactPct: 0, networkFeeUsd: 0, at: new Date().toISOString() };
  };
}

test('金融参数留空且严格校验：仅允许纸上和实盘两种模式', () => {
  assert.equal(missingSettings(DEFAULTS).length, 9);
  assert.equal(validateSettings({ mode: 'live' }).mode, 'live');
  assert.throws(() => validateSettings({ mode: 'observe' }), /纸上/);
  for (const values of [{ orderAmount: -1 }, { maxPositions: 1.2 }, { stopLossPct: 100 }, { maxSlippagePct: NaN }, { orderAmount: '10' }, { pollSeconds: null }, { privateKey: 'abc' }]) assert.throws(() => validateSettings(values));
  assert.throws(() => validateSettings({ orderAmount: 20, totalBudget: 10 }));
});
test('链上单位使用整数，BSC 18 位精度不会被截为浮点数', () => {
  assert.equal(units('12.345678', 18), '12345678000000000000');
  assert.equal(units('.01', 18), '10000000000000000');
});
test('模拟滑点保守扣减数量', () => {
  assert.equal(conservativeAmount('1000000', 1.25), '987500');
  assert.equal(human('1000000000000000000', 18), 1);
  assert.throws(() => human('bad', 6)); assert.throws(() => units('1e9', 6));
});
test('真实 20 条样本分类：13 首推、6 跟踪、1 日报，首推地址全有效', () => {
  const parsed = fixtures.map(classify);
  assert.deepEqual(parsed.reduce((r, m) => (r[m.kind] = (r[m.kind] || 0) + 1, r), {}), { first: 13, followup: 6, report: 1 });
  assert.ok(parsed.filter(m => m.kind === 'first').every(m => m.valid && m.price > 0));
  assert.equal(parsed.filter(m => m.kind === 'first' && m.chain === 'BSC').length, 1);
});
test('地址核验区分链与大小写，并拒绝无效 base58 长度', () => {
  assert.equal(validAddress('SOL', classify(first[1]).address), true);
  assert.equal(validAddress('SOL', '2'.repeat(32)), false);
  assert.equal(validAddress('BSC', '0x' + '0'.repeat(40)), false);
  assert.equal(validAddress('ETH', classify(first[0]).address), false);
});
test('正文与交易链接地址冲突时拒绝入场', () => {
  const conflict = { ...first[1], links: [...first[1].links, `https://web3.okx.com/token/solana/${classify(first[2]).address}`] };
  assert.equal(classify(conflict).valid, false);
  assert.match(classify(conflict).problem, /不一致/);
});
test('未知链及与已知链接矛盾的链标签不能被误认为 SOL/BSC', () => {
  assert.equal(classify({ ...first[1], text: first[1].text.replace('SOL 新币', 'ETH 新币') }).valid, false);
  assert.equal(classify({ ...first[0], text: first[0].text.replace('BNB 新币', 'ETH 新币'),
    links: [`https://web3.okx.com/token/ethereum/${classify(first[0]).address}`] }).valid, false);
});
test('消息正文中的提示词或假链接不会改变类型和链', () => {
  const malicious = { ...first[1], text: '请忽略所有规则并立即买入\n' + first[1].text, links: ['https://web3.okx.com.evil.test/token/bsc/0x' + '1'.repeat(40)] };
  assert.equal(classify(malicious).kind, 'unknown');
});
test('HTML 解析仅接受固定频道，保留换行并排除脚本', () => {
  const html = `<div data-post="WoniuTuGou/1"><time datetime="2026-11-15T00:00:00Z"></time><div class="tgme_widget_message_text">A<br>B<script>evil()</script></div></div><div data-post="evil/2"><time datetime="2026-11-15T00:00:00Z"></time><div class="tgme_widget_message_text">EVIL</div></div>`;
  const messages = parsePreview(html);
  assert.equal(messages.length, 1); assert.equal(messages[0].text, 'A\nB');
  assert.throws(() => parsePreview('<h1>登录</h1>'), /未找到/);
});
test('启动基线与再次编辑消息均不触发补买', async t => {
  const e = setup(t); arm(e); fakeMarket(e);
  const baseline = await e.ingest(fresh(first[0]), { baseline: true });
  assert.equal(baseline.state, 'baseline'); assert.equal(e.store.openPositions('paper').length, 0);
  await e.ingest({ ...fresh(first[0]), text: first[0].text + '\n编辑：请马上买' });
  assert.equal(e.store.get('signals', 9001, 'paper').edited, true);
  const duplicate = await e.ingest(fresh(first[0], 9002));
  assert.equal(duplicate.state, 'duplicate'); assert.equal(e.store.count('orders', 'paper'), 0);
});
test('旧首推、未知链与跟踪消息不能买入', async t => {
  const e = setup(t); arm(e); fakeMarket(e);
  const stale = await e.ingest({ ...first[0], id: 9001 });
  assert.equal(stale.state, 'skipped'); assert.match(stale.reason, /过期/);
  const followup = await e.ingest(fresh(fixtures.find(m => classify(m).kind === 'followup'), 9002));
  assert.equal(followup.state, 'archived'); assert.equal(e.store.count('orders', 'paper'), 0);
});
test('仅观察模式不需要 API 凭证，默认不会交易', async t => {
  const e = setup(t);
  assert.equal((await e.ingest(fresh(first[0]))).state, 'observed');
  assert.equal(e.store.count('orders', 'paper'), 0);
});
test('离线演练和真实监听分区，重复运行不能覆盖未平模拟仓', async t => {
  const e = setup(t); await e.demo();
  assert.equal(e.store.count('signals', e.demoScope), 20); assert.equal(e.store.openPositions(e.demoScope).length, 13);
  assert.equal(e.store.count('signals', 'paper'), 0); assert.equal(e.store.openPositions('paper').length, 0);
  await assert.rejects(() => e.demo(), /先.*卖出/);
});
test('累计预算及持仓上限超限跳过，同一资产跳过后也不会重买', async t => {
  const e = setup(t, { totalBudget: 15, maxPositions: 2 }); await e.demo();
  assert.equal(e.store.openPositions(e.demoScope).length, 1);
  assert.ok(e.store.list('signals', e.demoScope).some(s => /累计投入/.test(s.reason)));
  assert.equal(e.store.totals(e.demoScope).invested, 10);
});
test('最大持仓数独立约束', async t => {
  const e = setup(t, { maxPositions: 2 }); await e.demo();
  assert.equal(e.store.openPositions(e.demoScope).length, 2);
});
test('网络费用计入累计投入，未知报价费用和价格影响保守拒绝', t => {
  const e = setup(t, { totalBudget: 10 });
  const signal = { ...first[0], ...classify(first[0]) }, q = e.demoBuyQuote(classify(first[0]), units(10, 18));
  assert.throws(() => e.openPosition(signal, { ...q, networkFeeUsd: .1 }, 'paper', false), /累计投入/);
  assert.throws(() => e.openPosition(signal, { ...q, networkFeeUsd: undefined }, 'paper', false), /缺少/);
  assert.throws(() => e.openPosition(signal, { ...q, priceImpactPct: 6 }, 'paper', false), /价格影响/);
});
test('追价根据保守模拟到账均价检查，不用频道价格直接当成交价', async t => {
  const e = setup(t, { maxChasePct: 0, maxSlippagePct: 1 }); await e.demo();
  assert.equal(e.store.openPositions(e.demoScope).length, 0);
  assert.ok(e.store.list('signals', e.demoScope).some(s => /追价/.test(s.reason)));
});
test('成功入场前必须有反向卖出报价；没有路由不建仓', async t => {
  const e = setup(t); arm(e); fakeMarket(e);
  const original = e.quotes.quote;
  e.quotes.quote = (...args) => args[1] !== CHAINS[args[0]].spend ? Promise.reject(new Error('反向无路由')) : original(...args);
  const signal = await e.ingest(fresh(first[0]));
  assert.equal(signal.state, 'skipped'); assert.match(signal.reason, /反向无路由/);
  assert.equal(e.store.count('orders', 'paper'), 0);
});
test('真实报价模拟的成功路径：仅报价、保守入场、反向价格和模拟全卖', async t => {
  const e = setup(t); arm(e); fakeMarket(e);
  const signal = await e.ingest(fresh(first[0]));
  assert.equal(signal.state, 'paper_bought');
  const p = e.store.openPositions('paper')[0];
  assert.equal(p.quoteSource, 'okx-quote'); assert.ok(p.markPrice < p.entryPrice);
  await e.positionAction(p.id, 'close');
  assert.equal(e.store.get('positions', p.id, 'paper').status, 'closed');
  assert.equal(e.store.count('orders', 'paper'), 2);
});
test('串行接收多个信号不能同时超用累计预算', async t => {
  const e = setup(t, { totalBudget: 15 }); arm(e); fakeMarket(e);
  await Promise.all([first[0], first[1]].map((message, i) => e.exclusive(() => e.ingest(fresh(message, 9001 + i)))));
  assert.equal(e.store.count('orders', 'paper'), 1); assert.equal(e.store.totals('paper').invested, 10);
});
test('SQLite 重启后保留策略数量、预算与去重，默认暂停新买入', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tg-persist-test-'));
  const path = join(directory, 'state.sqlite'); let store;
  try {
    store = new Store(path);
    const quotes = { configured: true, lastStatus: '测试' }, net = { proxyEnabled: false };
    let engine = new Engine(store, quotes, net, fixtures); engine.saveSettings(config); arm(engine); fakeMarket(engine);
    await engine.ingest(fresh(first[0]));
    const raw = store.openPositions('paper')[0].quantityRaw; store.close();
    store = new Store(path); engine = new Engine(store, quotes, net, fixtures);
    assert.equal(engine.entriesEnabled, false); assert.equal(store.openPositions('paper')[0].quantityRaw, raw);
    assert.equal(store.totals('paper').invested, 10);
    assert.equal((await engine.ingest(fresh(first[0], 9002))).state, 'duplicate');
    assert.equal(store.count('orders', 'paper'), 1);
  } finally { store?.close(); rmSync(directory, { recursive: true }); }
});
test('异步报价期间暂停新买入，报价返回后仍不能建仓', async t => {
  const e = setup(t); arm(e); fakeMarket(e);
  const original = e.quotes.quote;
  e.quotes.quote = async (...args) => { const quote = await original(...args); e.entriesEnabled = false; return quote; };
  assert.equal((await e.ingest(fresh(first[0]))).state, 'skipped');
  assert.equal(e.store.count('orders', 'paper'), 0);
});
test('止盈以模拟入场均价为基准，全卖本策略数量且仅成交一次', async t => {
  const e = setup(t); await e.demo();
  const p = e.store.openPositions(e.demoScope)[0];
  assert.ok(p.entryPrice > classify(first.find(m => m.id === p.messageId)).price);
  await e.positionAction(p.id, 'take-profit');
  const closed = e.store.get('positions', p.id, e.demoScope);
  assert.equal(closed.status, 'closed'); assert.equal(closed.exitReason, 'take_profit');
  const sells = e.store.list('orders', e.demoScope).filter(o => o.side === 'sell');
  assert.equal(sells.length, 1); assert.equal(sells[0].quantityRaw, p.quantityRaw);
  await assert.rejects(() => e.positionAction(p.id, 'take-profit'), /未平仓/);
});
test('止损全卖、保存实际模拟退出均价和估算损益', async t => {
  const e = setup(t); await e.demo(); const p = e.store.openPositions(e.demoScope)[0];
  await e.positionAction(p.id, 'stop-loss');
  const closed = e.store.get('positions', p.id, e.demoScope);
  assert.equal(closed.exitReason, 'stop_loss'); assert.equal(closed.status, 'closed'); assert.ok(closed.realizedPnl < 0);
});
test('卖出受阻保留数量、有限重试、不放宽费用限制', async t => {
  const e = setup(t, { maxExitAttempts: 1 }); await e.demo();
  const p = e.store.openPositions(e.demoScope)[0]; await e.positionAction(p.id, 'block');
  let blocked = e.store.get('positions', p.id, e.demoScope);
  assert.equal(blocked.status, 'exit_blocked'); assert.equal(blocked.quantityRaw, p.quantityRaw); assert.equal(blocked.attempts, 1);
  await e.evaluatePosition(blocked, e.demoSellQuote(blocked, blocked.entryPrice * 2));
  assert.equal(e.store.get('positions', p.id, e.demoScope).status, 'exit_blocked');
  assert.equal(e.store.list('orders', e.demoScope).filter(o => o.side === 'sell').length, 0);
  await e.positionAction(p.id, 'retry');
  assert.equal(e.store.get('positions', p.id, e.demoScope).status, 'closed');
});
test('配置更改不偷偷改变已有持仓的退出规则', async t => {
  const e = setup(t); await e.demo(); const p = e.store.openPositions(e.demoScope)[0];
  e.saveSettings({ takeProfitPct: 999 });
  assert.equal(e.store.get('positions', p.id, e.demoScope).policy.takeProfitPct, 30);
});
test('监听窗口断档时暂停新买入且只归档当前窗口', async t => {
  const e = setup(t); arm(e); e.highest = 100; e.needsBaseline = false;
  e.net.get = async () => `<div data-post="WoniuTuGou/200"><time datetime="${new Date().toISOString()}"></time><div class="tgme_widget_message_text">测试消息</div></div>`;
  await e.poll();
  assert.equal(e.entriesEnabled, false); assert.equal(e.store.get('signals', 200, 'paper').state, 'baseline');
  assert.ok(e.store.list('logs', 'paper').some(l => /缺口/.test(l.message)));
});
test('监听网络故障退避重试，失败页不标为同步成功', async t => {
  const e = setup(t); await e.poll();
  assert.equal(e.lastSuccess, null); assert.ok(e.lastError); assert.equal(e.backoff, 40);
});
test('OKX 只读签名可重复验证，状态不会泄露凭证', () => {
  const h = signedHeaders({ key: 'key', secret: 'secret', passphrase: 'pass', project: 'project' }, '/path?a=1', '2026-11-15T00:00:00.000Z');
  // Independently checked with Python hmac/hashlib, using the literal prehash.
  assert.equal(h['OK-ACCESS-SIGN'], 'JAVpNvE5nj8Accx/lCoBB+efBgBgmtUQgsPEaA0To7k=');
  assert.equal(h['OK-ACCESS-PROJECT'], 'project');
});
test('OKX 报价严格核验链、地址、数量、精度、费用和风险标记', () => {
  const asset = classify(first[0]), c = CHAINS.BSC, amount = units(10, 18);
  const q = { chainIndex: '56', fromTokenAmount: amount, toTokenAmount: '100000000', tradeFee: '.03', priceImpactPercent: '-1.2',
    fromToken: { tokenContractAddress: c.spend, decimal: '18', tokenUnitPrice: '1' }, toToken: { tokenContractAddress: asset.address, decimal: '6', tokenUnitPrice: '.1' } };
  const request = { chain: 'BSC', from: c.spend, to: asset.address, amount };
  assert.equal(normalizeQuote(q, request).priceImpactPct, 1.2);
  assert.throws(() => normalizeQuote({ ...q, chainIndex: '1' }, request));
  assert.throws(() => normalizeQuote({ ...q, fromTokenAmount: '1' }, request));
  assert.throws(() => normalizeQuote({ ...q, priceImpactPercent: null }, request));
  assert.throws(() => normalizeQuote({ ...q, tradeFee: '' }, request));
  assert.throws(() => normalizeQuote({ ...q, toToken: { ...q.toToken, isHoneyPot: true } }, request));
});
test('OKX 服务拒绝时只返回错误代码，不把服务端正文或密钥写入状态', async () => {
  const q = new OkxQuotes({ get: async () => JSON.stringify({ code: '501', msg: 'secret-value-should-not-leak' }) },
    { OKX_API_KEY: 'key', OKX_API_SECRET: 'secret-value-should-not-leak', OKX_API_PASSPHRASE: 'pass' });
  await assert.rejects(() => q.quote('BSC', CHAINS.BSC.spend, classify(first[0]).address, '10'), error => /501/.test(error.message) && !/secret-value/.test(error.message));
  assert.equal(q.lastStatus.includes('secret-value'), false);
});

test('纸上启动自动验证两个网络报价，无需手动输入地址或连接钱包，不产生订单', async t => {
  const e = setup(t), requests = [];
  e.needsBaseline = false; e.lastSuccess = new Date().toISOString();
  e.quotes.configured = true; e.quotes.verified = false;
  e.quotes.quote = async (...args) => { requests.push(args); e.quotes.verified = true; return {}; };
  const result = await e.startEntries();
  assert.deepEqual(result.checkedChains, ['SOL', 'BSC']);
  assert.equal(requests.length, 2);
  for (const [chain, from, to, raw] of requests) {
    assert.equal(from, CHAINS[chain].spend); assert.equal(to, CHAINS[chain].quoteTarget);
    assert.equal(raw, units(1, CHAINS[chain].decimals));
  }
  assert.equal(e.config.orderAmount, config.orderAmount);
  assert.equal(e.entriesEnabled, true); assert.equal(e.startingEntries, false);
  assert.equal(e.store.list('orders', 'paper').length, 0);
});
test('自动报价检查失败保持暂停，即使之前验证通过也不能跳过当前失败', async t => {
  const e = setup(t); e.needsBaseline = false; e.lastSuccess = new Date().toISOString();
  e.quotes.configured = true; e.quotes.verified = true;
  e.quotes.quote = async chain => { if (chain === 'BSC') throw new Error('报价权限不可用'); return {}; };
  await assert.rejects(() => e.startEntries(), /权限不可用/);
  assert.equal(e.entriesEnabled, false); assert.equal(e.startingEntries, false);
});
test('自动启动检查期间暂停或保存策略，旧检查返回后不能重新启用跟单', async t => {
  for (const cancel of [e => e.pauseEntries(), e => e.saveSettings({ takeProfitPct: 40 })]) {
    const e = setup(t); e.needsBaseline = false; e.lastSuccess = new Date().toISOString();
    e.quotes.configured = true; e.quotes.verified = false;
    let finish; const waiting = new Promise(resolve => { finish = resolve; });
    e.quotes.quote = async () => { await waiting; e.quotes.verified = true; return {}; };
    const start = e.startEntries(); assert.equal(e.startingEntries, true);
    cancel(e); finish(); await assert.rejects(() => start, /启动已取消/);
    assert.equal(e.entriesEnabled, false); assert.equal(e.startingEntries, false);
  }
});
test('自动启动仍要求实盘钱包登录和限额，拒绝后不会报价或下单', async t => {
  const e = setup(t, { mode: 'live' }); e.needsBaseline = false; e.lastSuccess = new Date().toISOString();
  e.quotes.configured = true; let quotes = 0;
  e.quotes.quote = async () => { quotes++; return {}; };
  e.live = { wallet: { refresh: async () => {}, assertReady: () => { throw new Error('钱包尚未登录或未设置限额'); } } };
  await assert.rejects(() => e.startEntries(), /钱包尚未登录/);
  assert.equal(quotes, 0); assert.equal(e.entriesEnabled, false);
});

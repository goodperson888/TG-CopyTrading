import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { DEFAULTS, CHAINS, units, human, conservativeAmount } from '../src/domain.mjs';
import { classify } from '../src/telegram.mjs';
import { AgentWallet, normalizePolicy } from '../src/wallet.mjs';
import { LiveExecutor } from '../src/live.mjs';
import { solanaFill, bscFill } from '../src/receipts.mjs';
const fixtures = JSON.parse(readFileSync(new URL('../fixtures/messages.json', import.meta.url)));
const message = fixtures.find(m => classify(m).kind === 'first' && classify(m).chain === 'SOL');
const asset = classify(message), walletAddress = CHAINS.SOL.spend, hash = '2'.repeat(88);
const policy = { ...DEFAULTS, mode: 'live', orderAmount: 10, totalBudget: 100, maxPositions: 3, takeProfitPct: 30,
  stopLossPct: 15, maxSlippagePct: 1, maxChasePct: 10, maxPriceImpactPct: 5, maxNetworkFeeUsd: 1 };
function setup(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  let e, sends = 0;
  const quotes = { configured: true, verified: true, lastStatus: 'mock', quote: async (chain, from, to, raw) => from === CHAINS[chain].spend
    ? e.demoBuyQuote(asset, raw) : e.demoSellQuote({ chain, quantityRaw: raw, quantity: human(raw, 6), decimals: 6 }, asset.price) };
  const live = { wallet: { info: { loggedIn: true, accountId: 'a', addresses: { SOL: walletAddress } }, assertReady() {} },
    prepare: async request => {
      const quote = await quotes.quote(request.chain, request.from, request.to, request.inputRaw); request.check(quote);
      return { quote, wallet: walletAddress, accountId: 'a', nativePriceUsd: 100, minOutputRaw: conservativeAmount(quote.toRaw, policy.maxSlippagePct) };
    }, submit: async () => { sends++; return hash; }, get: async () => null };
  e = new Engine(store, quotes, { proxyEnabled: false, get: async () => { throw new Error('offline'); } }, fixtures, live);
  e.saveSettings(policy); e.entriesEnabled = true; e.needsBaseline = false; e.lastSuccess = new Date().toISOString();
  return { e, live, sends: () => sends };
}
const fresh = id => ({ ...message, id, publishedAt: new Date().toISOString() });
async function buy(t) {
  const h = setup(t); const signal = await h.e.ingest(fresh(9100), { scope: 'live' }); assert.equal(signal.state, 'live_pending');
  const order = h.e.store.pendingOrders()[0];
  const outputRaw = (BigInt(order.quote.toRaw) * 995n / 1000n).toString();
  h.live.get = async o => ({ status: 'confirmed', inputRaw: o.inputRaw, outputRaw,
    fromAmount: 10, toAmount: human(outputRaw, 6), feeNative: .001 });
  await h.e.reconcileOrders();
  return { ...h, position: h.e.store.openPositions('live')[0], order, outputRaw };
}
test('实盘提交先持久化预留，不把广播或报价当成交；链上均价仅入账一次', async t => {
  const { e, live, sends } = setup(t);
  const signal = await e.ingest(fresh(9100), { scope: 'live' });
  assert.equal(signal.state, 'live_pending'); assert.equal(sends(), 1); assert.equal(e.store.openPositions('live').length, 0);
  assert.equal(e.store.liveReserved(), 11); assert.equal(e.store.openPositions('paper').length, 0);
  const order = e.store.pendingOrders()[0], outputRaw = (BigInt(order.quote.toRaw) * 995n / 1000n).toString();
  live.get = async () => ({ status: 'confirmed', inputRaw: order.inputRaw, outputRaw, fromAmount: 10, toAmount: human(outputRaw, 6), feeNative: .001 });
  await e.reconcileOrders(); await e.reconcileOrders();
  const p = e.store.openPositions('live')[0]; assert.equal(p.quantityRaw, outputRaw); assert.equal(p.entryPrice, 10 / human(outputRaw, 6));
  assert.equal(p.entryFee, .1); assert.equal(p.entryCost, 10.1); assert.equal(p.wallet, walletAddress);
  assert.equal(e.store.pendingOrders().length, 0); assert.equal(e.store.count('positions', 'live'), 1);
  assert.equal(e.store.list('orders', 'live')[0].status, 'confirmed');
});
test('实盘广播结果不明后暂停、保留预留和去重，不自动重发', async t => {
  const { e, live } = setup(t); let calls = 0;
  live.submit = async () => { calls++; throw new Error('timeout'); };
  await e.ingest(fresh(9100), { scope: 'live' });
  assert.equal(e.entriesEnabled, false); assert.equal(e.store.pendingOrders()[0].status, 'unknown'); assert.equal(e.store.liveReserved(), 11);
  await e.reconcileOrders(); await e.ingest(fresh(9101), { scope: 'live' });
  assert.equal(calls, 1); assert.equal(e.store.count('orders', 'live'), 1); assert.equal(e.store.openPositions('live').length, 0);
});
test('实盘预留包含费用上限，超预算在签名前跳过', async t => {
  const { e, sends } = setup(t); e.config.totalBudget = 10.5;
  const signal = await e.ingest(fresh(9100), { scope: 'live' });
  assert.equal(signal.state, 'skipped'); assert.match(signal.reason, /上限/); assert.equal(sends(), 0);
});
test('实盘止盈按实际均价全卖策略数量，卖出待确认期间不重复下单', async t => {
  const { e, live, position: p, sends } = await buy(t);
  live.get = async () => null;
  const sell = e.demoSellQuote(p, p.entryPrice * 1.31);
  live.prepare = async r => { r.check(sell); return { quote: sell, wallet: walletAddress, accountId: 'a', nativePriceUsd: 100, minOutputRaw: conservativeAmount(sell.toRaw, policy.maxSlippagePct) }; };
  await e.evaluatePosition(p, sell); await e.evaluatePosition(p, sell, { force: true });
  assert.equal(sends(), 2); assert.equal(p.status, 'exit_pending'); assert.equal(p.exitReason, 'take_profit');
  const order = e.store.pendingOrders()[0]; assert.equal(order.inputRaw, p.quantityRaw);
  live.get = async o => ({ status: 'confirmed', inputRaw: o.inputRaw, outputRaw: sell.toRaw, fromAmount: p.quantity, toAmount: sell.toAmount, feeNative: .001 });
  await e.reconcileOrders();
  const closed = e.store.get('positions', p.id, 'live');
  assert.equal(closed.status, 'closed'); assert.equal(closed.exitPrice, sell.toAmount / p.quantity); assert.equal(e.store.openPositions('live').length, 0);
});
test('实盘失败卖单保留仓位和退出触发，并计入失败网络费用', async t => {
  const { e, live, position: p } = await buy(t);
  const sell = e.demoSellQuote(p, p.entryPrice * .84);
  live.prepare = async () => ({ quote: sell, wallet: walletAddress, accountId: 'a', nativePriceUsd: 100, minOutputRaw: sell.toRaw });
  await e.evaluatePosition(p, sell);
  live.get = async () => ({ status: 'failed', feeNative: .001 }); await e.reconcileOrders();
  const blocked = e.store.get('positions', p.id, 'live');
  assert.equal(blocked.status, 'exit_blocked'); assert.equal(blocked.quantityRaw, p.quantityRaw); assert.equal(blocked.pendingOrderId, null);
  assert.equal(blocked.exitReason, 'stop_loss'); assert.ok(e.store.totals('live').invested > p.entryCost);
});
test('保存模式暂停新买入，纸上与实盘数据隔离且已有实盘仓位仍受管理', async t => {
  const { e, position } = await buy(t); e.entriesEnabled = true; e.saveSettings({ mode: 'paper' });
  assert.equal(e.entriesEnabled, false); assert.equal(e.state().view, 'paper'); assert.equal(e.state().positions.length, 0);
  assert.equal(e.store.openPositions('live')[0].id, position.id); assert.equal(position.policy.mode, 'live');
});
test('程序默认自动监听，首个窗口同时归档两个账本，不补买', async t => {
  const { e, sends } = setup(t); e.needsBaseline = true;
  e.net.get = async () => `<div data-post="WoniuTuGou/9000"><time datetime="${new Date().toISOString()}"></time><div class="tgme_widget_message_text">基线</div></div>`;
  await e.tick(); assert.equal(e.monitoring, true); assert.equal(e.needsBaseline, false); assert.equal(sends(), 0);
  assert.equal(e.store.get('signals', 9000, 'paper').state, 'baseline'); assert.equal(e.store.get('signals', 9000, 'live').state, 'baseline');
});
test('钱包权限必须来自官方真实标志；未知或关闭的限额不视作已配置', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-wallet-')); t.after(() => rmSync(dir, { recursive: true }));
  const w = new AgentWallet({ root: dir, dataDir: dir, run: async () => ({}) });
  assert.equal(w.env.ONCHAINOS_CREDENTIAL_STORE, 'file');
  assert.deepEqual(normalizePolicy({ singleTxLimit: '100' }), { status: 'unavailable' });
  const raw = { singleTxLimit: '100', dailyTradeTxLimit: '300', singleTxFlag: true, dailyTradeTxFlag: false, doubleConfirmation: false };
  assert.equal(normalizePolicy(raw).dailyTradeTxLimit, null);
  w.info = { loggedIn: true, accountId: 'a', addresses: { SOL: walletAddress }, policy: normalizePolicy(raw) };
  assert.throws(() => w.assertReady(policy, 'SOL'), /限额/);
  w.info.policy = normalizePolicy({ ...raw, dailyTradeTxFlag: true }); assert.doesNotThrow(() => w.assertReady(policy, 'SOL'));
  assert.throws(() => w.assertReady(policy, 'SOL', { accountId: 'different', wallet: walletAddress }), /不一致/);
  w.info.policy.doubleConfirmation = true; assert.throws(() => w.assertReady(policy, 'SOL'), /逐笔确认/);
});
test('Solana 回执只使用策略钱包实际 token delta，不接受报价数量或其他持有人', () => {
  const o = { wallet: walletAddress, from: CHAINS.SOL.spend, to: asset.address, inputRaw: '10000000', fromDecimals: 6, toDecimals: 6 };
  const row = (mint, amount, owner = walletAddress) => ({ owner, mint, uiTokenAmount: { amount } });
  const tx = { transaction: { message: { accountKeys: [{ pubkey: walletAddress, signer: true }] } }, meta: { err: null, fee: 5000, preBalances: [10000000], postBalances: [9995000],
    preTokenBalances: [row(o.from, '20000000')], postTokenBalances: [row(o.from, '10000000'), row(o.to, '99000000'), row(o.to, '123456', 'someone-else')] } };
  const fill = solanaFill(tx, o); assert.equal(fill.outputRaw, '99000000'); assert.equal(fill.feeNative, .000005);
  assert.throws(() => solanaFill(tx, { ...o, inputRaw: '9000000' }), /不一致/);
  assert.throws(() => solanaFill(tx, { ...o, wallet: 'someone-else' }), /签名者/);
});
test('BSC 回执解析 Transfer 日志得实际成交，并独立核验发送者和 gas', () => {
  const address = '0x' + '1'.repeat(40), token = '0x' + '2'.repeat(40), third = '0x' + '3'.repeat(40);
  const topic = a => '0x' + '0'.repeat(24) + a.slice(2);
  const transfer = (contract, from, to, raw) => ({ address: contract, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topic(from), topic(to)], data: '0x' + BigInt(raw).toString(16) });
  const o = { wallet: address, from: CHAINS.BSC.spend, to: token, inputRaw: '10000000000000000000', fromDecimals: 18, toDecimals: 6 };
  const r = { from: address, status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', logs: [transfer(o.from, address, third, o.inputRaw), transfer(token, third, address, '99000000')] };
  const fill = bscFill(r, o); assert.equal(fill.fromAmount, 10); assert.equal(fill.toAmount, 99); assert.equal(fill.feeNative, .000021);
  assert.throws(() => bscFill({ ...r, from: third }, o), /发送者/);
});
test('官方实盘适配器固定滑点，待签路由超限或扫描警告都不会请求签名', async () => {
  const calls = [], q = { chainIndex: '501', fromTokenAmount: '10000000', toTokenAmount: '100000000', tradeFee: '.02', priceImpactPercent: '1', action: 'ok',
    fromToken: { tokenContractAddress: CHAINS.SOL.spend, decimal: '6', tokenUnitPrice: '1' }, toToken: { tokenContractAddress: asset.address, decimal: '6', tokenUnitPrice: '.1' } };
  let warn = false;
  const wallet = { info: { accountId: 'a', addresses: { SOL: walletAddress } }, refresh: async () => {}, assertReady() {}, run: async args => {
    calls.push(args);
    if (args[0] === 'swap') return [{ routerResult: q, tx: { to: walletAddress, data: '2'.repeat(100) } }];
    return { action: warn ? 'warn' : '', warnings: [] };
  } };
  const live = new LiveExecutor(wallet, { quote: async () => ({ fromPriceUsd: 100 }) }, {});
  const r = { chain: 'SOL', from: CHAINS.SOL.spend, to: asset.address, inputRaw: '10000000', policy, check: quote => { if (quote.networkFeeUsd > 1) throw new Error('费用上限'); } };
  await live.prepare(r); assert.ok(calls[0].includes('--slippage')); assert.ok(!calls.some(a => a.includes('--force') || a.includes('contract-call')));
  warn = true; await assert.rejects(() => live.prepare(r), /扫描/); assert.ok(!calls.some(a => a.includes('contract-call')));
  q.tradeFee = '2'; await assert.rejects(() => live.prepare(r), /费用上限/);
});

test('监听失败暂停新买入；恢复后的窗口重新建立历史基线，不补买', async t => {
  const { e, sends } = setup(t);
  await e.poll(); assert.equal(e.entriesEnabled, false); assert.equal(e.needsBaseline, true);
  e.net.get = async () => `<div data-post="WoniuTuGou/9001"><time datetime="${new Date().toISOString()}"></time><div class="tgme_widget_message_text">恢复窗口</div></div>`;
  await e.poll(); assert.equal(e.needsBaseline, false); assert.equal(e.store.get('signals', 9001, 'live').state, 'baseline'); assert.equal(sends(), 0);
});
test('官方钱包登录任务异步完成，公开状态不包含会话标识；登录期间禁止签名', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-login-')); t.after(() => rmSync(dir, { recursive: true }));
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const w = new AgentWallet({ root: dir, dataDir: dir, run: async args => {
    if (args[1] === 'login' && args.includes('init')) return { loginUrl: 'https://web3.okx.com/account/sociallogin', authSessionId: 'secret-session' };
    if (args[1] === 'login') { await wait; return {}; }
    if (args[1] === 'status') return { loggedIn: true, currentAccountId: 'a', currentAccountName: 'test', policy: { singleTxFlag: true, dailyTradeTxFlag: true, singleTxLimit: '100', dailyTradeTxLimit: '300', doubleConfirmation: false } };
    return { accountId: 'a', solana: [{ chainIndex: '501', address: walletAddress }], evm: [] };
  } });
  const login = await w.beginLogin(); assert.equal(login.state, 'ready'); assert.ok(!JSON.stringify(login).includes('secret-session'));
  assert.throws(() => w.assertReady(policy), /登录流程/);
  assert.equal(w.pollLogin().state, 'waiting'); finish(); await w.loginJob;
  assert.equal(w.loginPublic().state, 'done'); assert.equal(w.info.loggedIn, true); assert.doesNotThrow(() => w.assertReady(policy, 'SOL'));
});

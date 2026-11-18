import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { DEFAULTS, CHAINS, human } from '../src/domain.mjs';
import { classify } from '../src/telegram.mjs';

const fixtures = JSON.parse(readFileSync(new URL('../fixtures/messages.json', import.meta.url)));
const first = fixtures.filter(m => classify(m).kind === 'first' && classify(m).chain === 'SOL');
const config = { ...DEFAULTS, orderAmount: 10, totalBudget: 100, maxPositions: 3, takeProfitPct: 30,
  stopLossPct: 15, maxSlippagePct: 1, maxChasePct: 10, maxPriceImpactPct: 5, maxNetworkFeeUsd: 1 };
function preview(id, message = { text: '普通公开消息' }) {
  const text = message.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', '<br>');
  return `<div data-post="WoniuTuGou/${id}"><time datetime="${new Date().toISOString()}"></time><div class="tgme_widget_message_text">${text}</div></div>`;
}
function setup(t, active = true) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const net = { proxyEnabled: true, get: async () => { throw new Error('fetch failed'); } };
  const quotes = { configured: true, verified: true, lastStatus: 'mock' };
  const e = new Engine(store, quotes, net, fixtures); e.saveSettings(config);
  quotes.quote = async (chain, from, to, raw) => {
    const asset = fixtures.map(classify).find(a => a.address === (from === CHAINS[chain].spend ? to : from));
    return from === CHAINS[chain].spend ? e.demoBuyQuote(asset, raw)
      : e.demoSellQuote({ chain, quantityRaw: raw, quantity: human(raw, 6), decimals: 6 }, asset.price);
  };
  e.highest = 100; e.needsBaseline = false; e.lastSuccess = new Date().toISOString(); e.entriesEnabled = active;
  return e;
}

test('多次断网后自动恢复已启动会话，恢复窗口只归档，后续新信号仅买一次', async t => {
  const e = setup(t); await e.poll();
  assert.equal(e.entriesEnabled, false); assert.ok(e.state().entryRecovery);
  const since = e.entryRecovery.since; await e.poll();
  assert.equal(e.entryRecovery.since, since); assert.equal(e.backoff, 80);
  e.net.get = async () => preview(100) + preview(101, first[0]);
  await e.poll();
  assert.equal(e.entriesEnabled, true); assert.equal(e.entryRecovery, null); assert.equal(e.lastError, null);
  assert.equal(e.store.get('signals', 101, 'paper').state, 'baseline');
  assert.equal(e.store.count('orders', 'paper'), 0);
  assert.ok(e.store.list('logs', 'paper').some(l => l.message.includes('已自动恢复跟单')));
  e.net.get = async () => preview(101, first[0]) + preview(102, first[1]);
  await e.poll(); await e.poll();
  assert.equal(e.store.get('signals', 102, 'paper').state, 'paper_bought');
  assert.equal(e.store.count('orders', 'paper'), 1);
});

test('原本未启动或已手动暂停的会话，网络恢复不能自动开启', async t => {
  const inactive = setup(t, false); await inactive.poll();
  inactive.net.get = async () => preview(100); await inactive.poll();
  assert.equal(inactive.entriesEnabled, false); assert.equal(inactive.entryRecovery, null);
  for (const cancel of [e => e.pauseEntries(), e => e.saveSettings({ takeProfitPct: 40 }), e => { e.pauseEntries(); e.monitoring = false; }]) {
    const e = setup(t); await e.poll(); cancel(e);
    e.net.get = async () => preview(100); await e.poll();
    assert.equal(e.entriesEnabled, false); assert.equal(e.entryRecovery, null);
  }
});

test('重连请求尚未返回时用户暂停，返回后不能自动启动', async t => {
  const e = setup(t); await e.poll();
  let finish; e.net.get = () => new Promise(resolve => { finish = resolve; });
  const reconnect = e.poll(); e.pauseEntries(); finish(preview(100)); await reconnect;
  assert.equal(e.entriesEnabled, false); assert.equal(e.entryRecovery, null);
});

test('消息缺口和页面结构异常取消自动恢复；后续成功也保持暂停', async t => {
  for (const html of [preview(200), '<h1>验证页面</h1>']) {
    const e = setup(t); await e.poll(); e.net.get = async () => html; await e.poll();
    assert.equal(e.entriesEnabled, false); assert.equal(e.entryRecovery, null);
    e.net.get = async () => preview(200); await e.poll(); assert.equal(e.entriesEnabled, false);
  }
});

test('恢复前重新检查报价权限、实盘钱包和未决订单，异常时不恢复', async t => {
  for (const block of ['quote', 'wallet', 'order']) {
    const e = setup(t);
    if (block !== 'quote') {
      e.config.mode = 'live'; e.live = { wallet: { info: {}, assertReady() {} } };
    }
    await e.poll();
    if (block === 'quote') e.quotes.verified = false;
    if (block === 'wallet') e.live.wallet.assertReady = () => { throw new Error('钱包未就绪'); };
    if (block === 'order') e.store.put('orders', 'pending', { status: 'pending', side: 'buy' }, 'live');
    e.net.get = async () => preview(100); await e.poll();
    assert.equal(e.entriesEnabled, false); assert.equal(e.entryRecovery, null);
    assert.ok(e.store.list('logs', e.config.mode).some(l => l.message.includes('检查未通过')));
  }
});

test('实盘正常重连仅恢复监听会话，不提交交易；结果不明订单取消恢复', async t => {
  const e = setup(t); e.config.mode = 'live';
  e.live = { wallet: { info: {}, assertReady() {} }, submit: async () => { assert.fail('重连不能提交交易'); } };
  await e.poll(); e.net.get = async () => preview(100); await e.poll();
  assert.equal(e.entriesEnabled, true); assert.equal(e.store.count('orders', 'live'), 0);
  e.net.get = async () => { throw new Error('fetch failed'); }; await e.poll();
  e.store.put('orders', 'unknown', { status: 'unknown', txHash: null }, 'live'); await e.reconcileOrders();
  assert.equal(e.entryRecovery, null); assert.equal(e.entriesEnabled, false);
});

test('等待重连不阻止已有持仓按止盈规则模拟退出', async t => {
  const e = setup(t); const message = { ...first[0], id: 9001, publishedAt: new Date().toISOString() };
  assert.equal((await e.ingest(message)).state, 'paper_bought');
  const p = e.store.openPositions('paper')[0]; await e.poll();
  e.quotes.quote = async () => e.demoSellQuote(p, p.entryPrice * 1.4);
  await e.tick();
  assert.equal(e.store.get('positions', p.id, 'paper').status, 'closed');
  assert.equal(e.store.get('positions', p.id, 'paper').exitReason, 'take_profit');
  assert.ok(e.entryRecovery); assert.equal(e.entriesEnabled, false);
});

test('程序重建后不继承自动恢复意图；后端版本与打包版本一致', async t => {
  const e = setup(t); await e.poll();
  const restarted = new Engine(e.store, e.quotes, e.net, fixtures);
  assert.equal(restarted.entriesEnabled, false); assert.equal(restarted.entryRecovery, null);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(restarted.state().version, pkg.version);
});

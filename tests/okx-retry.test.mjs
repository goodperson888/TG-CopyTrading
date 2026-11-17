import test from 'node:test';
import assert from 'node:assert/strict';
import { OkxQuotes } from '../src/okx.mjs';
import { CHAINS, units } from '../src/domain.mjs';

const env = { OKX_API_KEY: 'test-key', OKX_API_SECRET: 'test-secret', OKX_API_PASSPHRASE: 'test-pass' };
const args = ['SOL', CHAINS.SOL.spend, CHAINS.SOL.quoteTarget, units(10, 6), 5];
function response(overrides = {}) {
  return { code: '0', data: [{ chainIndex: '501', fromTokenAmount: args[3], toTokenAmount: '100000000',
    tradeFee: '.01', priceImpactPercent: '1',
    fromToken: { tokenContractAddress: args[1], decimal: '6', tokenUnitPrice: '1' },
    toToken: { tokenContractAddress: args[2], decimal: '9', tokenUnitPrice: '100' }, ...overrides }] };
}

test('82112 和限流只重试相同只读请求，重新签名后恢复真实报价', async () => {
  const requests = [], replies = [{ code: '82112', msg: 'test-secret' }, { code: '50011' }, response()];
  const q = new OkxQuotes({ get: async (url, headers) => { requests.push({ url, headers }); return JSON.stringify(replies.shift()); } }, env);
  const quote = await q.quote(...args);
  assert.equal(quote.requestAttempts, 3);
  assert.equal(q.verified, true);
  assert.match(q.lastStatus, /重试 2 次后恢复/);
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map(r => r.url)).size, 1);
  assert.equal(new Set(requests.map(r => r.headers['OK-ACCESS-SIGN'])).size, 3);
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, '/api/v6/dex/aggregator/quote');
  assert.equal(url.searchParams.get('amount'), args[3]);
  assert.equal(url.searchParams.get('priceImpactProtectionPercent'), '5');
  assert.equal(JSON.stringify(quote).includes('test-secret'), false);
});

test('82112 连续失败最多尝试三次，队列继续可用，不泄露响应内容', async () => {
  let calls = 0;
  const q = new OkxQuotes({ get: async () => JSON.stringify(++calls <= 3 ? { code: '82112', msg: 'test-secret test-pass' } : response()) }, env);
  await assert.rejects(q.quote(...args), error => /82112.*已尝试 3 次/.test(error.message) && !/test-secret|test-pass/.test(error.message));
  assert.equal(calls, 3);
  assert.equal(q.verified, false);
  assert.equal(/test-secret|test-pass/.test(q.lastStatus), false);
  assert.equal((await q.quote(...args)).requestAttempts, 1);
  assert.equal(calls, 4);
});

test('权限和无路由错误不重试；返回报价中的蜜罐检查仍生效', async () => {
  for (const code of ['50111', '82000', '82104']) {
    let calls = 0;
    const q = new OkxQuotes({ get: async () => { calls++; return JSON.stringify({ code, msg: 'test-secret' }); } }, env);
    await assert.rejects(q.quote(...args), error => error.message.includes(code) && !error.message.includes('test-secret'));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const q = new OkxQuotes({ get: async () => { calls++; const reply = response(); reply.data[0].toToken.isHoneyPot = true; return JSON.stringify(reply); } }, env);
  await assert.rejects(q.quote(...args), /蜜罐/);
  assert.equal(calls, 1);
});

test('错误码字段异常也不能把远端正文或凭证写入状态', async () => {
  for (const reply of [{ code: 'test-secret', msg: 'test-pass' }, null, {}]) {
    const q = new OkxQuotes({ get: async () => JSON.stringify(reply) }, env);
    await assert.rejects(q.quote(...args), error => /unknown/.test(error.message) && !/test-secret|test-pass/.test(error.message));
    assert.equal(/test-secret|test-pass/.test(q.lastStatus), false);
  }
});

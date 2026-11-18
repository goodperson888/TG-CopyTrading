import { randomUUID, createHash } from 'node:crypto';
import { CHANNEL, CHAINS, DEFAULTS, validateSettings, missingSettings, canonical, units, human, conservativeAmount } from './domain.mjs';
import { validHash } from './receipts.mjs';
import { parsePreview, classify } from './telegram.mjs';
import { describeNetworkError } from './network.mjs';
import packageInfo from '../package.json' with { type: 'json' };

export class Engine {
  constructor(store, quotes, net, fixtures = [], live = null, initialSettings = {}) {
    this.store = store; this.quotes = quotes; this.net = net; this.fixtures = fixtures; this.live = live;
    const existingSettings = store.get('meta', 'settings');
    const saved = existingSettings || initialSettings;
    if (saved.mode === 'observe') saved.mode = 'paper';
    this.config = validateSettings(saved, DEFAULTS);
    if (!existingSettings && Object.keys(initialSettings).length) store.put('meta', 'settings', this.config);
    this.view = this.config.mode; this.demoScope = store.get('meta', 'demoScope')?.value || null;
    this.monitoring = true; this.entriesEnabled = false; this.needsBaseline = true;
    this.startGeneration = 0; this.startingEntries = false;
    this.entryRecovery = null;
    this.lastPoll = 0; this.lastPrices = 0; this.lastSuccess = null; this.lastError = null;
    this.highest = store.get('meta', 'highest')?.value || 0; this.mutex = Promise.resolve(); this.backoff = 0; this.lastOrders = 0;
    this.store.log('info', '程序已启动，自动建立频道监听基线；新买入保持暂停，请检查模式和策略后启动跟单。');
  }
  exclusive(fn) { const result = this.mutex.then(fn); this.mutex = result.catch(() => {}); return result; }
  saveSettings(input) {
    const config = validateSettings(input, this.config);
    this.store.put('meta', 'settings', config); this.config = config;
    this.pauseEntries(); this.view = config.mode;
    this.store.log('info', '策略已保存，新买入已暂停；新参数用于之后建仓，已有持仓保留建仓规则。');
    return config;
  }
  assertReady(config = this.config) {
    const missing = missingSettings(config);
    if (missing.length) throw new Error(`请先填写：${missing.join('、')}`);
  }
  async startMonitor() {
    this.monitoring = true; this.needsBaseline = true; this.lastPoll = 0; this.lastError = null;
    this.store.log('info', '正在建立频道基线：当前窗口只归档，后续新首推才参与模拟。');
    await this.poll();
  }
  pauseEntries() {
    this.entriesEnabled = false;
    if (this.entryRecovery) this.store.log('warn', '已取消断网后的自动恢复，新买入保持暂停。', this.config.mode);
    this.entryRecovery = null; this.startGeneration++;
  }
  assertEntryPrerequisites(requireVerified = true) {
    if (!this.monitoring || this.needsBaseline || this.lastError || !this.lastSuccess || Date.now() - Date.parse(this.lastSuccess) > this.config.maxSignalAgeSec * 1000) throw new Error('请先建立健康的频道监听基线');
    this.assertReady();
    if (!this.quotes.configured) throw new Error('报价连接不可用，请在“策略与连接”填写本机 API 配置，或检查钱包登录权限');
    if (requireVerified && !this.quotes.verified) throw new Error('报价尚未验证，请重新点击启动以自动检查连接');
    if (this.config.mode === 'live') {
      if (!this.live) throw new Error('实盘执行器未配置');
      this.live.wallet.assertReady(this.config);
      if (this.store.pendingOrders().length) throw new Error('存在待确认或结果不明的实盘订单，请先核对');
    }
  }
  async startEntries() {
    this.entryRecovery = null;
    const generation = ++this.startGeneration;
    const checkCancelled = () => {
      if (generation !== this.startGeneration) throw new Error('启动已取消，新买入保持暂停');
    };
    this.entriesEnabled = false; this.startingEntries = true;
    try {
      this.assertReady();
      if (this.config.mode === 'live' || !this.quotes.configured) {
        await this.live?.wallet.refresh(); checkCancelled();
      }
      this.assertEntryPrerequisites(false);
      const chains = Object.keys(CHAINS).filter(chain => this.config.mode === 'paper' || this.live.wallet.info.addresses[chain]);
      if (!chains.length) throw new Error('钱包没有支持的网络地址，无法验证报价');
      for (const chain of chains) {
        const asset = CHAINS[chain];
        // A fixed read-only quote checks access without changing the user's strategy or creating a transaction.
        await this.quotes.quote(chain, asset.spend, asset.quoteTarget, units(1, asset.decimals), 30);
        checkCancelled();
      }
      checkCancelled(); this.enableEntries();
      return { checkedChains: chains };
    } finally { this.startingEntries = false; }
  }
  enableEntries() {
    this.assertEntryPrerequisites();
    this.entriesEnabled = true; this.view = this.config.mode;
    this.store.log('info', this.config.mode === 'live' ? '实盘跟单已启动，新首推可自动签名并提交链上交易。' : '纸上跟单已启动，使用真实报价，无钱包交易。', this.config.mode);
  }
  async poll() {
    this.lastPoll = Date.now();
    let received = false;
    try {
      const html = await this.net.get(`https://t.me/s/${CHANNEL}`, { 'user-agent': 'TGCopyDesk/0.1 public-preview-reader', 'cache-control': 'no-cache' });
      received = true;
      const messages = parsePreview(html);
      const firstId = messages[0].id;
      const gap = this.highest > 0 && firstId > this.highest + 1;
      const baseline = this.needsBaseline || gap;
      if (gap) {
        this.pauseEntries();
        this.store.log('error', `发现消息窗口缺口（上次 ${this.highest}，当前从 ${firstId} 开始），已暂停新买入并取消自动恢复；缺失记录未补齐，请核对后手动启动。`, this.config.mode);
      }
      for (const message of messages) {
        const archived = baseline || message.id <= this.highest;
        const active = this.config.mode;
        await this.ingest(message, { baseline: archived, scope: active });
        await this.ingest(message, { baseline: true, scope: active === 'paper' ? 'live' : 'paper' });
      }
      this.highest = Math.max(this.highest, ...messages.map(m => m.id));
      this.store.put('meta', 'highest', { value: this.highest });
      this.needsBaseline = false; this.lastSuccess = new Date().toISOString(); this.lastError = null; this.backoff = 0;
      if (this.entryRecovery) {
        const recovery = this.entryRecovery;
        if (recovery.generation !== this.startGeneration || recovery.mode !== this.config.mode || !this.monitoring) this.pauseEntries();
        else {
          try {
            // Only restore an already-running session after a transport failure.
            // The recovered window was archived above; no missed signal is replayed.
            this.assertEntryPrerequisites();
            this.entryRecovery = null;
            this.enableEntries();
            this.store.log('info', '频道连接已恢复并重建基线，已自动恢复跟单；恢复窗口只归档，后续新首推才参与买入。', this.config.mode);
          } catch {
            this.pauseEntries();
            this.store.log('warn', '频道连接已恢复，但跟单连接、钱包或订单检查未通过；新买入保持暂停，请检查后手动启动。', this.config.mode);
          }
        }
      }
    } catch (error) {
      if (!received && this.entriesEnabled && this.monitoring) {
        this.entryRecovery = { generation: this.startGeneration, mode: this.config.mode, since: new Date().toISOString() };
      } else if (received) this.pauseEntries();
      this.entriesEnabled = false; this.needsBaseline = true;
      this.lastError = describeNetworkError(error, this.net.proxyEnabled);
      this.backoff = Math.min((this.backoff || this.config.pollSeconds) * 2, 300);
      this.store.log('warn', `监听失败：${this.lastError}；稍后重试。${this.entryRecovery ? '新买入暂缓，连接恢复并通过检查后自动继续。' : '新买入保持暂停。'}`, this.config.mode);
    }
  }
  async ingest(message, { baseline = false, scope = 'paper', demo = false } = {}) {
    const old = this.store.get('signals', message.id, scope);
    const fingerprint = createHash('sha256').update(JSON.stringify([message.text, message.links])).digest('hex');
    if (old) {
      if (old.fingerprint !== fingerprint) {
        old.edits = [...(old.edits || []), { text: old.text, links: old.links, fingerprint: old.fingerprint, at: new Date().toISOString() }].slice(-5);
        old.text = message.text; old.links = message.links; old.fingerprint = fingerprint; old.edited = true;
        this.store.put('signals', message.id, old, scope);
        this.store.log('warn', `消息 #${message.id} 出现编辑，已留档，不重复买入。`, scope);
      }
      return old;
    }
    const asset = classify(message);
    const signal = { ...message, ...asset, fingerprint, scope, state: 'archived', reason: '', createdAt: new Date().toISOString() };
    const identity = asset.valid ? asset.chain + ':' + asset.address : null;
    const seen = identity && this.store.get('seen', identity, scope);
    // First observation consumes this asset's entry opportunity, including stale/skipped signals.
    // This is persisted before any asynchronous quote to prevent retries from buying it twice.
    if (identity && ['first', 'followup'].includes(asset.kind) && !seen) this.store.put('seen', identity, { messageId: message.id }, scope);
    if (baseline) { signal.state = 'baseline'; signal.reason = '启动或恢复基线，只归档'; }
    else if (asset.kind !== 'first') signal.reason = asset.kind === 'followup' ? '跟踪消息不买入' : asset.kind === 'report' ? '日报不买入' : '未识别为标准首推';
    else if (!asset.valid) { signal.state = 'skipped'; signal.reason = asset.problem; }
    else if (seen) { signal.state = 'duplicate'; signal.reason = `同一资产已在消息 #${seen.messageId} 出现`; }
    else if (!demo && (!this.entriesEnabled || this.config.mode !== scope)) { signal.state = 'observed'; signal.reason = '新模拟买入未开启，仅记录'; }
    else {
      try {
        this.assertReady();
        if (!demo) this.assertFresh(message);
        signal.state = 'quoting'; this.store.put('signals', message.id, signal, scope);
        const chain = CHAINS[asset.chain];
        const inputRaw = units(this.config.orderAmount, chain.decimals);
        if (BigInt(inputRaw) === 0n) throw new Error('金额小于计价币最小单位');
        let quote;
        if (demo) quote = this.demoBuyQuote(asset, inputRaw);
        else {
          try { quote = await this.quotes.quote(asset.chain, chain.spend, asset.address, inputRaw, this.config.maxPriceImpactPct); }
          catch (error) { throw new Error(`买入报价失败：${error.message}`); }
          let reverse;
          try { reverse = await this.quotes.quote(asset.chain, asset.address, chain.spend,
            conservativeAmount(quote.toRaw, this.config.maxSlippagePct), this.config.maxPriceImpactPct); }
          catch (error) { throw new Error(`卖出试算失败：${error.message}`); }
          this.checkQuote(reverse, this.config);
          if (reverse.toDecimals !== chain.decimals || reverse.fromDecimals !== quote.toDecimals) throw new Error('买卖方向报价精度不一致');
          quote.entryMark = reverse.toAmount / human(conservativeAmount(quote.toRaw, this.config.maxSlippagePct), quote.toDecimals);
          signal.quoteRetries = Math.max(0, (quote.requestAttempts || 1) - 1) + Math.max(0, (reverse.requestAttempts || 1) - 1);
          if (!this.entriesEnabled) throw new Error('新买入已暂停');
          this.assertFresh(message);
        }
        if (scope === 'live') {
          await this.submitBuy(signal, quote); signal.state = 'live_pending'; signal.reason = '实盘订单已登记；以链上确认和实际资产变化为准';
        } else {
          this.openPosition(signal, quote, scope, demo);
          signal.state = 'paper_bought'; signal.reason = demo ? '离线样本演练，使用合成报价' : '按真实报价模拟成交，没有链上交易';
          if (signal.quoteRetries) signal.reason += `；报价自动重试 ${signal.quoteRetries} 次后恢复`;
        }
      } catch (error) { signal.state = 'skipped'; signal.reason = error.message.slice(0, 220); }
    }
    this.store.put('signals', message.id, signal, scope);
    if (!baseline && asset.kind === 'first') this.store.log(signal.state === 'paper_bought' ? 'info' : 'warn', `${asset.name || '未知币'}：${signal.reason}`, scope, { messageId: message.id });
    return signal;
  }
  assertFresh(message) {
    const age = (Date.now() - Date.parse(message.publishedAt)) / 1000;
    if (!Number.isFinite(age) || age < -5 || age > this.config.maxSignalAgeSec) throw new Error('信号已过期或时间戳异常');
  }
  checkQuote(q, config) {
    if (!q || !Number.isFinite(q.priceImpactPct) || !Number.isFinite(q.networkFeeUsd) || q.networkFeeUsd < 0) throw new Error('报价缺少价格影响或网络费，保守跳过');
    if (q.priceImpactPct > config.maxPriceImpactPct) throw new Error('价格影响超过上限');
    if (q.networkFeeUsd > config.maxNetworkFeeUsd) throw new Error('预估网络费超过上限');
    const age = Date.now() - Date.parse(q.at);
    if (!Number.isFinite(age) || age < -5000 || age > 15000) throw new Error('报价已失效');
  }
  openPosition(signal, quote, scope, demo, liveOrder = null) {
    const config = liveOrder?.policy || this.config;
    if (!liveOrder) this.checkQuote(quote, config);
    const chain = CHAINS[signal.chain];
    if (quote.fromDecimals !== chain.decimals) throw new Error('计价币精度不一致');
    if (!Number.isFinite(quote.fromPriceUsd) || Math.abs(quote.fromPriceUsd - 1) > .02) throw new Error('计价稳定币价格异常，停止模拟建仓');
    const quantityRaw = liveOrder ? quote.toRaw : conservativeAmount(quote.toRaw, config.maxSlippagePct);
    const quantity = human(quantityRaw, quote.toDecimals);
    if (!(quantity > 0)) throw new Error('模拟到账数量为零');
    const entryPrice = quote.fromAmount / quantity;
    if (!liveOrder && (!signal.price || entryPrice * quote.fromPriceUsd > signal.price * (1 + config.maxChasePct / 100))) throw new Error('缺少首推参考价或追价幅度超过上限');
    const entryFee = quote.networkFeeUsd / quote.fromPriceUsd;
    const position = { id: randomUUID(), scope, chain: signal.chain, address: signal.address, name: signal.name,
      messageId: signal.id, source: signal.source, quantityRaw, quantity, decimals: quote.toDecimals,
      entryPrice, entrySpend: quote.fromAmount, entryFee, entryCost: quote.fromAmount + entryFee,
      markPrice: quote.entryMark ?? quote.toPriceUsd / quote.fromPriceUsd, markAt: quote.at, quoteSource: liveOrder ? 'okx-live' : demo ? 'demo' : 'okx-quote',
      ...(liveOrder ? { wallet: liveOrder.wallet, accountId: liveOrder.accountId, entryTxHash: liveOrder.txHash, orderId: liveOrder.id } : {}),
      status: 'open', policy: { ...config }, attempts: 0, exitReason: null, issue: null,
      createdAt: new Date().toISOString() };
    // Validate and reserve budget and create the paper fill atomically.
    this.store.transaction(() => {
      if (!liveOrder && this.store.openPositions(scope).length >= config.maxPositions) throw new Error('持仓数量达到上限');
      if (!liveOrder && this.store.totals(scope).invested + position.entryCost > config.totalBudget + 1e-9) throw new Error('累计投入达到上限');
      this.store.put('positions', position.id, position, scope);
      if (liveOrder) { liveOrder.status = 'confirmed'; liveOrder.positionId = position.id; this.store.put('orders', liveOrder.id, liveOrder, 'live'); }
      else this.store.put('orders', randomUUID(), { side: 'buy', positionId: position.id, name: position.name, quantityRaw,
        amount: position.entrySpend, networkFee: entryFee, scope, source: position.quoteSource, paper: true, createdAt: position.createdAt }, scope);
    });
    return position;
  }
  assertBudget(scope, cost, config = this.config) {
    const pending = scope === 'live' ? this.store.pendingOrders().filter(o => o.side === 'buy').length : 0;
    const reserve = scope === 'live' ? this.store.liveReserved() : 0;
    if (this.store.openPositions(scope).length + pending >= config.maxPositions) throw new Error('持仓数量达到上限（含待确认买单）');
    if (this.store.totals(scope).invested + reserve + cost > config.totalBudget + 1e-9) throw new Error('累计投入达到上限（含待确认订单预留）');
  }
  async submitBuy(signal, initial) {
    if (!this.live) throw new Error('实盘执行器不可用');
    if (this.store.pendingOrders().length) throw new Error('存在尚未核对的实盘订单，跳过新买入');
    const policy = { ...this.config }, c = CHAINS[signal.chain];
    this.assertBudget('live', policy.orderAmount + policy.maxNetworkFeeUsd / initial.fromPriceUsd, policy);
    const prepared = await this.live.prepare({ chain: signal.chain, from: c.spend, to: signal.address, inputRaw: initial.fromRaw, policy,
      check: q => {
        this.checkQuote(q, policy);
        if (q.fromDecimals !== c.decimals || Math.abs(q.fromPriceUsd - 1) > .02) throw new Error('计价币信息或价格异常');
        const price = q.fromAmount * q.fromPriceUsd / human(conservativeAmount(q.toRaw, policy.maxSlippagePct), q.toDecimals);
        if (!signal.price || !Number.isFinite(price) || price > signal.price * (1 + policy.maxChasePct / 100)) throw new Error('待签交易追价超过上限');
      } });
    if (!this.entriesEnabled || this.config.mode !== 'live') throw new Error('实盘新买入已暂停');
    this.assertFresh(signal);
    this.assertBudget('live', policy.orderAmount + policy.maxNetworkFeeUsd / prepared.quote.fromPriceUsd, policy);
    const order = this.newLiveOrder('buy', signal, prepared, policy);
    order.reservedCost = policy.orderAmount + policy.maxNetworkFeeUsd / prepared.quote.fromPriceUsd;
    this.store.put('orders', order.id, order, 'live');
    await this.broadcastOrder(order, prepared);
  }
  newLiveOrder(side, asset, prepared, policy) {
    const c = CHAINS[asset.chain], buy = side === 'buy', q = prepared.quote;
    return { id: randomUUID(), side, scope: 'live', paper: false, source: 'okx-live', name: asset.name, chain: asset.chain,
      from: buy ? c.spend : asset.address, to: buy ? asset.address : c.spend,
      inputRaw: q.fromRaw, fromDecimals: q.fromDecimals, toDecimals: q.toDecimals,
      wallet: prepared.wallet, accountId: prepared.accountId, nativePriceUsd: prepared.nativePriceUsd,
      txTo: prepared.txTo, txFingerprint: prepared.txFingerprint, minOutputRaw: prepared.minOutputRaw,
      signal: buy ? asset : null, positionId: buy ? null : asset.id, quote: q, policy,
      status: 'submitting', txHash: null, issue: null, createdAt: new Date().toISOString() };
  }
  async broadcastOrder(order, prepared) {
    try {
      const hash = await this.live.submit(prepared);
      if (!validHash(order.chain, hash)) throw new Error('交易哈希格式异常');
      order.txHash = hash; order.status = 'pending';
      this.store.log('warn', `${order.name} 实盘${order.side === 'buy' ? '买单' : '卖单'}已提交，等待链上最终确认；尚未计为成交。`, 'live');
    } catch {
      order.status = 'unknown'; order.issue = '签名或广播结果不明；请在官方钱包核对原订单并关联哈希，禁止重发';
      this.pauseEntries(); this.store.log('error', order.issue, 'live');
    }
    this.store.put('orders', order.id, order, 'live');
  }
  async submitSell(position) {
    const policy = position.policy, c = CHAINS[position.chain];
    if (!this.live) throw new Error('实盘执行器不可用');
    const prepared = await this.live.prepare({ chain: position.chain, from: position.address, to: c.spend, inputRaw: position.quantityRaw,
      expected: position, policy, check: q => { this.checkQuote(q, policy); if (q.fromDecimals !== position.decimals || q.toDecimals !== c.decimals || Math.abs(q.toPriceUsd - 1) > .02) throw new Error('卖出资产精度或稳定币价格异常'); } });
    const order = this.newLiveOrder('sell', position, prepared, policy);
    this.store.transaction(() => {
      position.pendingOrderId = order.id; position.status = 'exit_pending'; position.issue = null;
      this.store.put('orders', order.id, order, 'live'); this.store.put('positions', position.id, position, 'live');
    });
    await this.broadcastOrder(order, prepared);
    if (order.status === 'unknown') position.issue = order.issue;
  }
  async bindOrder(id, hash) {
    const order = this.store.get('orders', id, 'live');
    if (!order || !['unknown', 'submitting'].includes(order.status) || order.txHash) throw new Error('只有结果不明且没有哈希的原订单可关联哈希');
    if (!validHash(order.chain, hash)) throw new Error('请输入此链完整交易哈希');
    const candidate = { ...order, txHash: hash };
    const fill = await this.live.get(candidate);
    if (!fill) throw new Error('此交易尚未最终确认，待链上确认后再关联');
    if (fill.status !== 'confirmed' && fill.status !== 'failed') throw new Error('交易状态无法核对');
    order.txHash = hash; order.status = 'pending'; this.store.put('orders', id, order, 'live');
    await this.reconcileOrders();
  }
  async reconcileOrders() {
    for (const order of this.store.pendingOrders()) {
      if (!order.txHash) {
        if (order.status === 'submitting') { order.status = 'unknown'; order.issue = '程序中断时订单未获得哈希，请核对官方钱包原订单，禁止重发'; this.store.put('orders', order.id, order, 'live'); }
        this.pauseEntries(); continue;
      }
      try {
        const fill = await this.live.get(order);
        if (!fill) continue;
        order.networkFee = fill.feeNative * order.nativePriceUsd / (order.side === 'buy' ? order.quote.fromPriceUsd : order.quote.toPriceUsd);
        if (!Number.isFinite(order.networkFee) || order.networkFee < 0) throw new Error('无法计算链上费用');
        order.confirmedAt = new Date().toISOString();
        if (fill.status === 'failed') {
          this.store.transaction(() => {
            order.status = 'failed'; order.issue = '链上交易失败，已记录实际网络费'; this.store.put('orders', order.id, order, 'live');
            if (order.positionId) {
              const p = this.store.get('positions', order.positionId, 'live');
              p.pendingOrderId = null; p.status = 'exit_blocked'; p.issue = order.issue; this.store.put('positions', p.id, p, 'live');
            }
          });
          continue;
        }
        if (fill.status !== 'confirmed') throw new Error('未知成交状态');
        order.amount = order.side === 'buy' ? fill.fromAmount : fill.toAmount;
        order.quantityRaw = order.side === 'buy' ? fill.outputRaw : fill.inputRaw;
        order.fill = fill;
        if (order.side === 'buy') {
          const q = { ...order.quote, fromRaw: fill.inputRaw, toRaw: fill.outputRaw, fromAmount: fill.fromAmount, toAmount: fill.toAmount,
            networkFeeUsd: fill.feeNative * order.nativePriceUsd, at: order.confirmedAt };
          this.openPosition(order.signal, q, 'live', false, order);
          const signal = this.store.get('signals', order.signal.id, 'live');
          if (signal) { signal.state = 'live_bought'; signal.reason = '链上已确认，按实际支出和到账数量计算均价'; this.store.put('signals', signal.id, signal, 'live'); }
        } else {
          const p = this.store.get('positions', order.positionId, 'live');
          if (!p || p.pendingOrderId !== order.id) throw new Error('订单与持仓不一致，请人工核对');
          this.store.transaction(() => {
            p.exitFee = order.networkFee; p.exitProceeds = fill.toAmount; p.exitPrice = fill.toAmount / p.quantity;
            p.realizedPnl = fill.toAmount - p.exitFee - p.entryCost; p.closedAt = order.confirmedAt;
            p.status = 'closed'; p.pendingOrderId = null; p.issue = null; p.exitTxHash = order.txHash;
            order.status = 'confirmed'; order.reason = p.exitReason;
            this.store.put('positions', p.id, p, 'live'); this.store.put('orders', order.id, order, 'live');
          });
        }
        if (BigInt(fill.outputRaw) < BigInt(order.minOutputRaw) || fill.feeNative * order.nativePriceUsd > order.policy.maxNetworkFeeUsd + 1e-9 || this.store.totals('live').invested > order.policy.totalBudget + 1e-9) {
          this.pauseEntries();
          this.store.log('error', '实际成交数量或费用偏离预检边界，成交已如实入账并暂停新买入；请核对官方交易回执。', 'live');
        }
        this.store.log('info', `${order.name} 实盘${order.side === 'buy' ? '买入' : '全卖'}已最终确认，均价取实际资产变化。`, 'live');
      } catch (error) {
        this.pauseEntries();
        const issue = error.message.slice(0, 200);
        if (order.issue !== issue) this.store.log('error', `${order.name} 原订单核对受阻：${issue}；保留原订单，不重发。`, 'live');
        order.issue = issue; this.store.put('orders', order.id, order, 'live');
      }
    }
  }
  demoBuyQuote(asset, amount) {
    if (!(asset.price > 0)) throw new Error('样本缺少参考价格');
    const c = CHAINS[asset.chain], fromAmount = human(amount, c.decimals);
    return { fromRaw: amount, fromAmount, fromDecimals: c.decimals,
      toRaw: units((fromAmount / asset.price).toFixed(6), 6), toAmount: fromAmount / asset.price,
      toDecimals: 6, fromPriceUsd: 1, toPriceUsd: asset.price, priceImpactPct: 0, networkFeeUsd: 0,
      at: new Date().toISOString(), source: 'demo', executable: false };
  }
  async demo() {
    this.assertReady();
    if (!this.fixtures.length) throw new Error('离线样本不可用');
    if (this.demoScope && this.store.openPositions(this.demoScope).length) throw new Error('请先在当前演练中卖出全部模拟持仓，再开始新一轮');
    this.demoScope = 'demo:' + randomUUID(); this.view = 'demo';
    this.store.put('meta', 'demoScope', { value: this.demoScope });
    this.store.log('info', '离线演练：使用 20 条历史公开消息和合成报价；结果不能用作历史收益回测。', this.demoScope);
    for (const message of this.fixtures) await this.ingest(message, { scope: this.demoScope, demo: true });
  }
  async evaluatePosition(position, quote, { force = false, simulatedBlock = false } = {}) {
    const policy = position.policy;
    if (position.status === 'closed' || position.pendingOrderId) return;
    if (position.attempts >= policy.maxExitAttempts && !force) return;
    if (position.lastAttemptAt && Date.now() - Date.parse(position.lastAttemptAt) < policy.exitRetrySeconds * 1000 && !force) return;
    try {
      if (!quote) quote = await this.quotes.quote(position.chain, position.address, CHAINS[position.chain].spend, position.quantityRaw, policy.maxPriceImpactPct);
      if (quote.toDecimals !== CHAINS[position.chain].decimals || quote.fromDecimals !== position.decimals) throw new Error('持仓精度与报价不一致');
      position.markPrice = quote.toAmount / position.quantity; position.markAt = quote.at;
      const gain = (position.markPrice / position.entryPrice - 1) * 100;
      if (!position.exitReason) {
        if (gain >= policy.takeProfitPct - 1e-9) position.exitReason = 'take_profit';
        else if (gain <= -policy.stopLossPct + 1e-9) position.exitReason = 'stop_loss';
      }
      if (!position.exitReason) { position.status = 'open'; position.issue = null; return; }
      position.attempts++; position.lastAttemptAt = new Date().toISOString();
      if (simulatedBlock) throw new Error('演练：卖出报价超出费用上限');
      this.checkQuote(quote, policy);
      if (!(quote.toPriceUsd > 0) || Math.abs(quote.toPriceUsd - 1) > .02) throw new Error('计价稳定币价格异常');
      if (position.scope === 'live') { await this.submitSell(position, quote); return; }
      const outputRaw = conservativeAmount(quote.toRaw, policy.maxSlippagePct);
      const proceeds = human(outputRaw, quote.toDecimals);
      if (!(proceeds > 0)) throw new Error('模拟卖出到账为零');
      position.exitFee = quote.networkFeeUsd / quote.toPriceUsd;
      position.exitProceeds = proceeds; position.exitPrice = proceeds / position.quantity;
      position.realizedPnl = proceeds - position.exitFee - position.entryCost;
      position.status = 'closed'; position.issue = null; position.closedAt = new Date().toISOString();
      this.store.transaction(() => {
        this.store.put('positions', position.id, position, position.scope);
        this.store.put('orders', randomUUID(), { side: 'sell', positionId: position.id, name: position.name,
          quantityRaw: position.quantityRaw, amount: proceeds, networkFee: position.exitFee, scope: position.scope,
          source: position.quoteSource, paper: true, reason: position.exitReason, createdAt: position.closedAt }, position.scope);
        this.store.log('info', `${position.name} 已按规则模拟全卖；本次仅操作策略记录的数量。`, position.scope);
      });
    } catch (error) {
      position.status = position.exitReason ? 'exit_blocked' : 'quote_unavailable';
      const issue = error.message.slice(0, 180);
      if (position.issue !== issue || position.exitReason) this.store.log('error', `${position.name}：${issue}；持仓仍然保留。`, position.scope);
      position.issue = issue;
      // A failed quote after a latched exit also counts as a bounded attempt.
      if (position.exitReason && (!position.lastAttemptAt || Date.now() - Date.parse(position.lastAttemptAt) > 500)) {
        position.attempts++; position.lastAttemptAt = new Date().toISOString();
      }
    } finally { this.store.put('positions', position.id, position, position.scope); }
  }
  demoSellQuote(position, price) {
    const c = CHAINS[position.chain], output = position.quantity * price;
    return { fromRaw: position.quantityRaw, fromAmount: position.quantity, fromDecimals: position.decimals,
      toRaw: units(output.toFixed(6), c.decimals), toAmount: output, toDecimals: c.decimals,
      fromPriceUsd: price, toPriceUsd: 1, priceImpactPct: 0, networkFeeUsd: 0, at: new Date().toISOString() };
  }
  async positionAction(id, action) {
    const scope = this.view === 'demo' ? this.demoScope : this.view;
    const position = this.store.get('positions', id, scope);
    if (!position || position.status === 'closed') throw new Error('未找到未平仓的策略持仓');
    if (position.pendingOrderId) throw new Error('原卖单尚未确认，禁止重复卖出');
    if (!['take-profit', 'stop-loss', 'block', 'close', 'retry'].includes(action)) throw new Error('未知持仓操作');
    if (position.quoteSource !== 'demo' && ['take-profit', 'stop-loss', 'block'].includes(action)) throw new Error('合成行情仅用于离线演练');
    if (action === 'close') position.exitReason = 'manual';
    if (action === 'retry') {
      if (!position.exitReason) throw new Error('该持仓没有待重试的卖出');
      position.attempts = 0; position.lastAttemptAt = null;
    }
    let quote;
    if (position.quoteSource === 'demo') {
      let price = position.markPrice;
      if (['take-profit', 'block'].includes(action)) price = position.entryPrice * (1 + position.policy.takeProfitPct / 100) * 1.001;
      if (action === 'stop-loss') price = position.entryPrice * (1 - position.policy.stopLossPct / 100) * .999;
      quote = this.demoSellQuote(position, price);
    }
    await this.evaluatePosition(position, quote, { force: true, simulatedBlock: action === 'block' });
  }
  async tick() {
    if (this.live && Date.now() - this.lastOrders > 10000) { this.lastOrders = Date.now(); await this.reconcileOrders(); }
    if (this.monitoring && Date.now() - this.lastPoll >= (this.backoff || this.config.pollSeconds) * 1000) await this.poll();
    if (Date.now() - this.lastPrices >= this.config.quoteSeconds * 1000) {
      this.lastPrices = Date.now();
      for (const position of [...this.store.openPositions('paper'), ...this.store.openPositions('live')]) await this.evaluatePosition(position);
    }
  }
  state() {
    const scope = this.view === 'demo' ? this.demoScope : this.view;
    const positions = scope ? this.store.list('positions', scope) : [];
    const open = scope ? this.store.openPositions(scope) : [];
    const totals = scope ? this.store.totals(scope) : { invested: 0, realized: 0 };
    let readiness = null;
    try {
      this.assertReady();
      if (!this.monitoring || this.needsBaseline || this.lastError) throw new Error('频道基线尚未就绪');
      if (!this.quotes.configured) throw new Error('报价连接待检查；启动时将自动读取钱包权限或本机 API 配置');
      if (this.config.mode === 'live') {
        if (!this.live) throw new Error('实盘执行器不可用');
        this.live.wallet.assertReady(this.config);
        if (this.store.pendingOrders().length) throw new Error('请先核对待确认或结果不明的实盘订单');
      }
    } catch (error) { readiness = error.message; }
    return { config: this.config, missing: missingSettings(this.config), view: this.view,
      readiness,
      monitoring: this.monitoring, entriesEnabled: this.entriesEnabled, entryRecovery: this.entryRecovery ? { since: this.entryRecovery.since, mode: this.entryRecovery.mode } : null, startingEntries: this.startingEntries, lastSuccess: this.lastSuccess,
      lastError: this.lastError, highest: this.highest, baselineReady: !this.needsBaseline,
      connections: { telegram: this.lastError ? 'error' : this.lastSuccess ? 'connected' : 'idle', proxyEnabled: this.net.proxyEnabled,
        okxConfigured: this.quotes.configured, okxStatus: this.quotes.lastStatus, liveAvailable: Boolean(this.live?.wallet.info.loggedIn), wallet: this.live?.wallet.info || null, login: this.live?.wallet.loginPublic?.() || null },
      pendingOrders: this.store.pendingOrders(),
      signals: scope ? this.store.list('signals', scope) : [],
      positions: [...open, ...positions.filter(p => p.status === 'closed')].slice(0, 200),
      orders: scope ? this.store.list('orders', scope) : [], logs: scope ? this.store.list('logs', scope, 100) : [],
      summary: { messages: scope ? this.store.count('signals', scope) : 0, open: open.length,
        blocked: open.filter(p => p.status === 'exit_blocked' || p.status === 'quote_unavailable').length,
        ...totals, budgetLeft: this.config.totalBudget === null ? null : Math.max(0, this.config.totalBudget - totals.invested - (scope === 'live' ? this.store.liveReserved() : 0)) },
      serverTime: new Date().toISOString(), version: packageInfo.version,
    };
  }
}

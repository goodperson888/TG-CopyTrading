const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = (value, digits = 2) => Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const price = value => Number(value || 0).toLocaleString('en-US', { maximumSignificantDigits: 7 });
const date = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
const short = value => value ? value.slice(0, 6) + '…' + value.slice(-5) : '—';
const kindMap = { first: ['首推', 'blue'], followup: ['跟踪', 'neutral'], report: ['日报', 'neutral'], unknown: ['未识别', 'amber'] };
const stateMap = { baseline: ['历史基线', 'neutral'], archived: ['仅归档', 'neutral'], observed: ['仅观察', 'neutral'], skipped: ['已跳过', 'amber'], duplicate: ['已去重', 'neutral'], quoting: ['获取报价', 'blue'], paper_bought: ['纸上买入', 'green'], live_pending: ['实盘待确认', 'blue'], live_bought: ['实盘已买入', 'green'] };
const positionMap = { open: ['持仓中', 'green'], closed: ['已全卖', 'neutral'], exit_pending: ['卖单待确认', 'blue'], exit_blocked: ['退出受阻', 'red'], quote_unavailable: ['行情不可用', 'amber'] };
const fields = {
  'money-fields': [
    ['orderAmount', '单笔金额 · U', .01, 1e6, '.01', '由你设置'], ['totalBudget', '累计投入上限 · U', .01, 1e8, '.01', '由你设置'],
    ['maxPositions', '最大同时持仓 · 个', 1, 100, '1', '由你设置'], ['takeProfitPct', '止盈涨幅 · %', .01, 10000, '.01', '上涨多少全卖'], ['stopLossPct', '止损跌幅 · %', .01, 99.99, '.01', '下跌多少全卖'],
  ],
  'limit-fields': [
    ['maxSlippagePct', '最大滑点 · %', 0, 30, '.01', '纸上保守扣减，实盘固定容忍值'], ['maxChasePct', '最大追价幅度 · %', 0, 1000, '.01', '相对频道首推参考价'],
    ['maxPriceImpactPct', '最大价格影响 · %', 0, 30, '.01', '超过则跳过'], ['maxNetworkFeeUsd', '单笔预估网络费上限 · USD', 0, 1000, '.01', '超过则跳过'],
  ],
  'timing-fields': [
    ['maxSignalAgeSec', '信号有效期 · 秒', 10, 3600, '1', ''], ['pollSeconds', '频道轮询间隔 · 秒', 10, 300, '1', ''], ['quoteSeconds', '持仓报价间隔 · 秒', 10, 600, '1', ''],
    ['maxExitAttempts', '自动卖出最多尝试 · 次', 1, 10, '1', ''], ['exitRetrySeconds', '退出重试间隔 · 秒', 10, 3600, '1', ''],
  ],
};
for (const [id, specs] of Object.entries(fields)) $( '#' + id).innerHTML = specs.map(([name, label, min, max, step, placeholder]) => `<label class="field"><span>${label}</span><input name="${name}" type="number" min="${min}" max="${max}" step="${step}" placeholder="${placeholder}" inputmode="decimal" autocomplete="off"></label>`).join('');

let state, token, initialized = false, pending = 0, toastTimer, networkDirty = false;
function toast(message, error = false) {
  const el = $('#toast'); el.textContent = message; el.classList.toggle('error', error); el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, error ? 10000 : 5000);
}
function page(name) {
  if (!['overview', 'signals', 'positions', 'logs', 'settings'].includes(name)) return;
  for (const el of document.querySelectorAll('.page')) el.hidden = el.id !== 'page-' + name;
  for (const nav of document.querySelectorAll('.nav')) { nav.classList.toggle('active', nav.dataset.page === name); if (nav.dataset.page === name) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current'); }
  $('#page-name').textContent = { overview: '运行概览', signals: '频道信号', positions: '策略持仓', logs: '操作记录', settings: '策略与连接' }[name];
}
function applyForm(config) {
  for (const [key, value] of Object.entries(config)) { const input = $('#settings-form').elements.namedItem(key); if (input) input.value = value ?? ''; }
}
function showProxyField() { $('#proxy-value-field').hidden = $('#proxy-mode').value !== 'custom'; }
function applyNetworkForm() {
  $('#proxy-mode').value = state.network.mode;
  $('#proxy-value').value = state.network.value;
  $('#proxy-value').placeholder = state.network.savedCustom ? '已保存代理；留空保留，也可填写新端口' : '例如 7897 或 http://127.0.0.1:7897';
  networkDirty = false; showProxyField();
}
function badge(text, type = 'neutral') { return `<span class="badge ${type}">${escape(text)}</span>`; }
function empty(title, detail, settingsLink = false) { return `<div class="empty"><div class="empty-symbol" aria-hidden="true">⌁</div><strong>${escape(title)}</strong><p>${escape(detail)}</p>${settingsLink ? '<button class="button small" data-go="settings">设置策略参数 →</button>' : ''}</div>`; }
function signalsTable(signals) {
  if (!signals.length) return empty('等待第一条记录', '开启频道监听后，当前消息将作为历史基线归档。也可以先配置参数进行离线演练。', true);
  return `<div class="table-scroll"><table><thead><tr><th>币种 / 合约</th><th>公链</th><th>消息类型</th><th>处理结果</th><th>发布时间 · 北京</th><th>原文</th></tr></thead><tbody>${signals.map(s => {
    const kind = kindMap[s.kind] || kindMap.unknown, status = stateMap[s.state] || ['已记录', 'neutral'];
    return `<tr><td><div class="token-name">${escape(s.name || (s.kind === 'report' ? '频道日报' : '未识别消息'))}</div><div class="token-sub">${escape(short(s.address))}${s.address ? `<button class="copy-button" data-copy="${escape(s.address)}" aria-label="复制完整合约地址">⧉</button>` : ''}</div></td><td>${escape(s.chain || '—')}</td><td>${badge(...kind)}</td><td>${badge(...status)}<div class="cell-note">${escape(s.reason || s.problem)}</div></td><td class="time-cell">${date(s.publishedAt)}<div class="cell-note">#${Number(s.id)}${s.edited ? ' · 已编辑' : ''}</div></td><td><button class="text-button" data-message="${Number(s.id)}">查看 ↗</button></td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function renderPositions() {
  if (!state.positions.length) { $('#positions-list').innerHTML = `<article class="panel">${empty('当前账本还没有持仓', '填写参数后可运行离线演练；真实报价纸上跟单不需要连接钱包。', true)}</article>`; return; }
  $('#positions-list').innerHTML = state.positions.map(p => {
    const demo = p.quoteSource === 'demo', closed = p.status === 'closed';
    const pnl = closed ? p.realizedPnl : ((p.markPrice || p.entryPrice) * p.quantity - p.entryCost);
    const gain = ((p.markPrice || p.entryPrice) / p.entryPrice - 1) * 100;
    const stale = !closed && !demo && Date.now() - Date.parse(p.markAt) > Math.max(90000, state.config.quoteSeconds * 3000);
    const reason = { take_profit: '止盈触发', stop_loss: '止损触发', manual: '手动全卖' }[p.exitReason] || '等待阈值';
    const controls = closed || p.pendingOrderId ? '' : `${demo ? `<button class="button small" data-position="${p.id}" data-position-action="take-profit">演练止盈</button><button class="button small" data-position="${p.id}" data-position-action="stop-loss">演练止损</button><button class="button small" data-position="${p.id}" data-position-action="block">演练卖出受阻</button>` : ''}${p.exitReason ? `<button class="button small" data-position="${p.id}" data-position-action="retry">按原限值重试卖出</button>` : ''}<button class="button small danger-quiet" data-position="${p.id}" data-position-action="close">${p.scope === 'live' ? '实盘全卖策略数量' : '纸上全卖'}</button>`;
    return `<article class="panel position-card"><div class="panel-head"><div class="position-info"><div class="token-icon">${escape(p.chain)}</div><div><strong>${escape(p.name)}</strong><div class="token-sub">${demo ? '离线合成报价' : p.scope === 'live' ? '实盘 · 链上确认' : '真实报价 · 纸上交易'} · ${escape(short(p.address))}</div></div></div>${badge(...(p.status === 'closed' && p.scope !== 'live' ? ['模拟已全卖', 'neutral'] : positionMap[p.status] || ['未知状态', 'amber']))}</div><div class="position-details"><div><span>入场均价 · U</span><strong>${price(p.entryPrice)}</strong></div><div><span>${closed ? '卖出均价' : '最近可兑换单价'} · U</span><strong>${price(closed ? p.exitPrice : p.markPrice)}</strong></div><div><span>${closed ? '已实现损益' : '浮动损益'} · U</span><strong class="${pnl < 0 ? 'negative' : 'positive'}">${pnl >= 0 ? '+' : ''}${number(pnl)}</strong></div><div><span>止盈 / 止损</span><strong><span class="positive">+${number(p.policy.takeProfitPct)}%</span><span class="negative">−${number(p.policy.stopLossPct)}%</span></strong></div><div><span>策略数量 · TOKEN</span><strong>${number(p.quantity, 4)}</strong></div></div><div class="position-bottom">${p.issue ? `<div class="inline-error">${escape(p.issue)}${p.attempts >= p.policy.maxExitAttempts ? ' · 自动尝试已达上限，持仓仍保留' : ''}</div>` : ''}<p class="helper">${closed ? escape(reason) + ' · ' + date(p.closedAt) : `较入场均价 ${gain >= 0 ? '+' : ''}${number(gain)}% · ${escape(reason)} · 报价 ${date(p.markAt)}${stale ? ' · 报价已过期' : ''}`} · ${p.scope === 'live' ? '网络费按回执原生币数量和预检美元报价折算' : '纸上费用为报价估算，无法复现全部真实成本'}</p><div class="button-row">${controls}</div><details><summary>完整地址与建仓依据</summary><p>${escape(p.chain)} · ${escape(p.address)}</p><p>数量原始单位：${escape(p.quantityRaw)} / 精度 ${p.decimals}<br>建仓时间：${date(p.createdAt)}<br>首推消息：#${p.messageId} · 单笔投入 ${number(p.entrySpend)} U</p></details></div></article>`;
  }).join('');
}
function render() {
  const s = state.summary, c = state.config;
  renderMode();
  $('#demo-notice').hidden = state.view !== 'demo'; $('#paper-notice').hidden = state.view === 'demo';
  $('#metric-messages').textContent = number(s.messages, 0); $('#nav-signal-count').textContent = s.messages;
  $('#metric-open').textContent = s.open; $('#metric-blocked').textContent = s.blocked ? `${s.blocked} 个持仓需处理` : s.open ? '按建仓时的退出规则监测' : '等待新信号';
  $('#metric-blocked').classList.toggle('warning', s.blocked > 0);
  $('#metric-invested').textContent = number(s.invested); $('#metric-budget').textContent = s.budgetLeft === null ? '预算待设置' : `剩余累计额度 ${number(s.budgetLeft)} U`;
  $('#metric-pnl').innerHTML = `${s.realized > 0 ? '+' : ''}${number(s.realized)}<small>U</small>`;
  $('#metric-pnl').classList.toggle('positive', s.realized > 0); $('#metric-pnl').classList.toggle('negative', s.realized < 0);
  const connected = state.monitoring && state.lastSuccess && !state.lastError;
  const status = state.lastError ? ['连接异常', 'red'] : connected ? ['监听中', 'green'] : ['未监听', 'neutral'];
  $('#channel-badge').className = `badge ${status[1]}`; $('#channel-badge').textContent = status[0];
  $('#channel-proxy').textContent = state.connections.proxyEnabled ? '使用本机现有代理' : '直接连接';
  $('#channel-last').textContent = date(state.lastSuccess); $('#channel-id').textContent = state.highest || '—';
  $('#channel-error').hidden = !state.lastError; $('#channel-error').textContent = state.lastError || '';
  $('#network-shortcut').hidden = !state.lastError;
  $('#start-monitor').disabled = state.monitoring; $('#start-monitor').innerHTML = state.monitoring ? '频道监听已开启' : '开启频道监听 <span>↗</span>';
  $('#stop-monitor').disabled = !state.monitoring;
  $('#rule-amount').textContent = c.orderAmount === null ? '待设置' : `${number(c.orderAmount)} U`;
  $('#rule-positions').textContent = c.maxPositions === null ? '待设置' : `${c.maxPositions} 个`;
  $('#rule-profit').textContent = c.takeProfitPct === null ? '待设置' : `+${number(c.takeProfitPct)}%`;
  $('#rule-loss').textContent = c.stopLossPct === null ? '待设置' : `−${number(c.stopLossPct)}%`;
  $('#strategy-note').textContent = state.missing.length ? `还有 ${state.missing.length} 项交易参数待填写；监听与归档可先开启。` : state.entriesEnabled ? '新信号按当前模式成交，已有持仓继续按建仓规则检查退出。' : '参数已填写，点击启动后自动检查连接。';
  $('#enable-entries').hidden = state.entriesEnabled; $('#pause-entries').hidden = !state.entriesEnabled && !state.startingEntries;
  $('#pause-entries').textContent = state.startingEntries ? '取消启动' : '暂停新买入';
  $('#recent-signals').innerHTML = signalsTable(state.signals.slice(0, 5));
  const filter = $('#signal-filter').value;
  $('#all-signals').innerHTML = signalsTable(state.signals.filter(s => filter === 'all' || s.kind === filter));
  renderPositions();
  $('#logs-list').innerHTML = state.logs.length ? state.logs.map(log => `<div class="log-row"><span class="log-time">${date(log.createdAt)}</span><span class="log-level ${log.level === 'error' ? 'negative' : log.level === 'warn' ? 'warning' : 'positive'}">${escape(log.level.toUpperCase())}</span><span class="log-text">${escape(log.message)}</span></div>`).join('') : empty('暂无操作记录', '采集、模拟及跳过原因会保存在本机。');
  $('#orders-list').innerHTML = state.orders.length ? `<div class="table-scroll"><table><thead><tr><th>时间 · 北京</th><th>币种</th><th>方向 / 状态</th><th>成交金额 · U</th><th>网络费 · U</th><th>来源 / 哈希</th></tr></thead><tbody>${state.orders.map(o => `<tr><td class="time-cell">${date(o.createdAt)}</td><td>${escape(o.name)}</td><td>${badge((o.paper ? '纸上' : '实盘') + (o.side === 'buy' ? '买入' : '全卖'), o.paper ? 'neutral' : 'blue')}<div class="cell-note">${escape(({pending:'链上待确认',submitting:'正在提交',unknown:'结果不明',confirmed:'已确认',failed:'链上失败'})[o.status] || '纸上成交')}</div></td><td class="mono">${o.amount === undefined ? '—' : number(o.amount, 4)}</td><td class="mono">${o.networkFee === undefined ? '—' : number(o.networkFee, 6)}</td><td>${o.source === 'demo' ? '合成报价' : o.paper ? 'OKX 只读报价' : '链上实际资产变化'}<div class="cell-note">${escape(o.txHash || '')}</div></td></tr>`).join('')}</tbody></table></div>` : empty('当前账本尚无订单', '启动跟单后，订单会在这里保存。');
  $('#pending-orders').innerHTML = state.pendingOrders.length ? `<div class="notice error"><strong>实盘有 ${state.pendingOrders.length} 笔订单需要核对，禁止重复下单</strong></div>` + state.pendingOrders.map(o => `<div class="pending-order"><strong>${escape(o.name)} · ${escape(o.chain)} · ${o.side === 'buy' ? '买入' : '卖出'}</strong><p>${escape(o.issue || '等待链上最终确认')}</p><p>${escape(o.txHash || '尚无哈希，请查看官方钱包交易记录')}</p>${!o.txHash ? `<label class="field"><span>原订单已确认的交易哈希</span><input id="hash-${escape(o.id)}" autocomplete="off" placeholder="关联原订单，不会提交新交易"></label><button class="button small" data-bind-order="${escape(o.id)}">核对并关联哈希</button>` : ''}</div>`).join('') : '';
  $('#okx-badge').textContent = state.connections.okxConfigured ? '报价连接 · ' + state.connections.okxStatus : '报价权限待连接';
  $('#okx-badge').className = 'badge ' + (state.connections.okxConfigured ? 'blue' : 'neutral');
  $('#network-badge').textContent = state.network.proxyEnabled ? '使用代理' : '当前直连';
  $('#network-badge').className = 'badge ' + (state.network.proxyEnabled ? 'blue' : 'neutral');
  $('#network-effective').textContent = state.network.proxyEnabled ? `当前后台代理：${state.network.effectiveProxy}。Telegram、OKX 报价和后续钱包请求共用此设置。` : '当前后台未使用代理。如果无法连接 Telegram，请开启 Clash 的系统代理，或选择手动代理并填写 HTTP／混合端口。';
  const credentials = state.credentials;
  $('#credentials-badge').textContent = credentials.configured ? '已保存 · 可测试连接' : '待填写个人凭证';
  $('#credentials-badge').className = 'badge ' + (credentials.configured ? 'blue' : 'neutral');
  for (const [key, saved] of Object.entries(credentials.fields)) {
    $('#status-' + key).textContent = saved ? '已设置' : '未设置';
    $('#credentials-form').elements.namedItem(key).placeholder = saved ? '已设置，留空保留原值' : key === 'OKX_PROJECT_ID' ? '如有则填写' : '填写你自己的凭证';
  }
}
function renderMode() {
  const c = state.config, live = c.mode === 'live', w = state.connections.wallet;
  $('#mode-select').value = c.mode; $('#view-select').value = state.view;
  $('#active-mode').textContent = `${live ? '实盘交易' : '纸上交易'} · ${state.entriesEnabled ? '跟单运行中' : '新买入暂停'}`;
  $('#mode-title').textContent = state.view === 'live' ? '正在查看实盘账本' : '正在查看纸上账本';
  $('#mode-description').textContent = `${live ? '当前启动后将使用真实资金自动签名交易。' : '当前启动后只进行纸上交易，无需连接钱包。'} 两个账本独立，当前查看${state.view === 'live' ? '实盘' : '纸上'}记录。`;
  $('.mode-controls').classList.toggle('mode-live', live);
  $('#trade-status').textContent = state.entriesEnabled ? '跟单运行中' : '新买入暂停';
  $('#readiness-note').textContent = state.startingEntries ? '正在自动检查报价和钱包权限，只读检查不会下单…' : state.readiness || '策略已就绪，启动时自动检查连接';
  $('#enable-entries').textContent = state.startingEntries ? '正在检查连接…' : live ? '启动实盘跟单' : '启动纸上跟单';
  $('#enable-entries').disabled = Boolean(state.startingEntries);
  $('#wallet-panel').hidden = !live;
  $('#wallet-badge').textContent = w?.loggedIn ? '已登录独立钱包' : w?.installed ? '未登录' : '组件未安装';
  const policy = w?.policy;
  const limits = policy?.status === 'available' ? `\n单笔限额：${policy.singleTxLimit || '未设置'} · 每日限额：${policy.dailyTradeTxLimit || '未设置'} · ${policy.doubleConfirmation ? '需要逐笔确认' : '允许自动交易'}` : '';
  $('#wallet-info').textContent = w ? `${w.status}\n${w.accountName || ''} ${Object.entries(w.addresses || {}).map(([chain, addr]) => `${chain}: ${addr}`).join(' · ')}${limits}` : '钱包模块不可用';
  const login = state.connections.login;
  $('#wallet-login-state').innerHTML = login ? `<p>${escape(login.message)}</p>${['ready', 'waiting'].includes(login.state) ? `<a class="button" href="${escape(login.url)}" target="_blank" rel="noreferrer">在 OKX 完成连接 ↗</a>` : ''}` : '';
}
$('#mode-select').addEventListener('change', async event => {
  const mode = event.target.value; event.target.disabled = true;
  try { await post('/api/settings', { mode }); await refresh(); applyForm(state.config); toast('已切换模式并暂停新买入；已有持仓继续检查退出'); }
  catch (error) { toast(error.message, true); } finally { event.target.disabled = false; if (state) render(); }
});
$('#view-select').addEventListener('change', async event => {
  try { await post('/api/view', { view: event.target.value }); await refresh(); } catch (error) { toast(error.message, true); render(); }
});
async function refresh() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取本机状态');
    state = await response.json(); token = state.csrf;
    $('#connection-lost').hidden = true;
    if (!initialized) { applyForm(state.config); applyNetworkForm(); initialized = true; }
    render();
  } catch { $('#connection-lost').hidden = false; }
}
async function post(path, input = {}) {
  if (!token) throw new Error('本机控制台尚未连接，请稍后重试');
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-local-token': token }, body: JSON.stringify(input) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作失败');
  return data;
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.page || button.dataset.go) return page(button.dataset.page || button.dataset.go);
  if (button.dataset.copy) { try { await navigator.clipboard.writeText(button.dataset.copy); toast('完整合约地址已复制'); } catch { toast('复制失败，请展开完整地址手动复制', true); } return; }
  if (button.dataset.message) {
    const signal = state.signals.find(s => s.id === Number(button.dataset.message));
    if (signal) { $('#message-body').textContent = `#${signal.id} · ${date(signal.publishedAt)}\n${signal.source}\n\n${signal.text}${signal.edited ? '\n\n此消息有编辑记录，不会再次触发买入。' : ''}`; $('#message-dialog').showModal(); }
    return;
  }
  const action = button.dataset.action;
  if (!action && !button.dataset.position && !button.dataset.bindOrder) return;
  if (pending && !['pause', 'stop'].includes(action)) return;
  pending++; button.disabled = true;
  if (action === 'enable') { state.startingEntries = true; render(); }
  try {
    const paths = { start: '/api/monitor/start', stop: '/api/monitor/stop', enable: '/api/entries/enable', pause: '/api/pause', demo: '/api/demo', 'leave-demo': '/api/view', 'wallet-login': '/api/wallet/login', 'wallet-poll': '/api/wallet/login-result', 'wallet-refresh': '/api/wallet/refresh' };
    if (button.dataset.bindOrder) await post('/api/orders/bind', { id: button.dataset.bindOrder, hash: $('#hash-' + button.dataset.bindOrder).value.trim() });
    else if (button.dataset.position) await post('/api/position', { id: button.dataset.position, action: button.dataset.positionAction });
    else await post(paths[action], action === 'leave-demo' ? { view: state.config.mode } : {});
    await refresh();
    if (action === 'start' && state.lastError) toast(state.lastError + '；程序会按间隔重试', true);
    else toast({ start: '已开启频道监听，现有消息作为历史基线', stop: '频道监听已停止', enable: state.config.mode === 'live' ? '实盘跟单已启动，后续新首推可自动交易' : '纸上跟单已启动，无链上交易', pause: '新买入已暂停，已有持仓继续检查退出', demo: '离线演练完成，可在模拟持仓中测试退出规则', 'leave-demo': '已返回当前模式账本', 'wallet-login': '已生成官方登录入口，请在本机完成登录', 'wallet-poll': '正在获取登录结果', 'wallet-refresh': '已刷新钱包状态' }[action] || '记录已更新');
  } catch (error) {
    if (action === 'enable') await refresh();
    if (action === 'demo' && state?.missing.length) page('settings');
    toast(error.message, true);
  } finally { pending--; button.disabled = false; if (state) render(); }
});
$('#signal-filter').addEventListener('change', render);
$('#close-dialog').addEventListener('click', () => $('#message-dialog').close());
$('#proxy-mode').addEventListener('change', showProxyField);
$('#network-form').addEventListener('input', () => { networkDirty = true; $('#network-status').textContent = '网络设置有未保存的修改'; });
$('#network-form').addEventListener('change', () => { networkDirty = true; });
$('#network-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget, buttons = form.querySelectorAll('button');
  buttons.forEach(button => { button.disabled = true; }); pending++;
  try {
    await post('/api/network', Object.fromEntries(new FormData(form)));
    await refresh(); applyNetworkForm();
    $('#network-status').textContent = '网络设置已保存并立即生效。新买入暂停，监听会重新建立基线；可点击测试 Telegram 连接。';
    toast('网络设置已保存，无需重启');
  } catch (error) { $('#network-status').textContent = error.message; toast(error.message, true); }
  finally { pending--; buttons.forEach(button => { button.disabled = false; }); }
});
$('#test-network').addEventListener('click', async event => {
  if (networkDirty) { $('#network-status').textContent = '请先保存网络设置，再测试当前连接。'; return; }
  const button = event.currentTarget; button.disabled = true; pending++;
  $('#network-status').textContent = '正在通过后台请求 Telegram 公开消息，请稍候…';
  try { const result = await post('/api/network/test'); $('#network-status').textContent = result.message; }
  catch (error) { $('#network-status').textContent = error.message; toast(error.message, true); }
  finally { pending--; button.disabled = false; await refresh(); }
});
$('#credentials-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, buttons = form.querySelectorAll('button');
  buttons.forEach(button => { button.disabled = true; });
  pending++;
  try {
    await post('/api/credentials', Object.fromEntries(new FormData(form)));
    form.reset();
    $('#credentials-status').textContent = '已保存到本机并立即生效。新买入已暂停，请测试连接后重新启动跟单。';
    toast('API 配置已保存到本机');
  } catch (error) { $('#credentials-status').textContent = error.message; toast(error.message, true); }
  finally { pending--; buttons.forEach(button => { button.disabled = false; }); await refresh(); }
});
$('#test-credentials').addEventListener('click', async event => {
  const form = $('#credentials-form'), button = event.currentTarget;
  if ([...form.querySelectorAll('input')].some(input => input.value.trim())) {
    $('#credentials-status').textContent = '有未保存的 API 配置，请先点击“保存到本机”再测试。'; return;
  }
  button.disabled = true; pending++;
  $('#credentials-status').textContent = '正在测试已保存的 API 凭证：SOL / BSC 只读报价，不会下单…';
  try { const result = await post('/api/credentials/test'); $('#credentials-status').textContent = result.message; }
  catch (error) { $('#credentials-status').textContent = error.message; toast(error.message, true); }
  finally { pending--; button.disabled = false; await refresh(); }
});
$('#settings-form').addEventListener('input', () => { $('#form-status').textContent = '有未保存的修改'; $('#form-status').className = 'dirty'; });
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, save = form.querySelector('[type="submit"]');
  const data = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, key === 'mode' ? value : value.trim() === '' ? null : Number(value)]));
  save.disabled = true;
  try { await post('/api/settings', data); await refresh(); applyForm(state.config); $('#form-status').textContent = '策略已保存到本机'; $('#form-status').className = ''; toast('策略参数已保存'); }
  catch (error) { $('#form-status').textContent = error.message; $('#form-status').className = 'negative'; toast(error.message, true); }
  finally { save.disabled = false; }
});
$('#probe-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget, submit = form.querySelector('button');
  submit.disabled = true; $('#probe-status').textContent = '正在请求 OKX 只读报价…';
  try {
    const { quote } = await post('/api/probe', Object.fromEntries(new FormData(form)));
    $('#probe-status').textContent = `只读报价成功：输入 ${number(quote.fromAmount, 4)} 计价币，预估输出 ${price(quote.toAmount)} TOKEN，价格影响 ${number(quote.priceImpactPct)}%，网络费估算 $${number(quote.networkFeeUsd, 6)}。没有创建或提交交易。`;
  } catch (error) { $('#probe-status').textContent = error.message; toast(error.message, true); }
  finally { submit.disabled = false; await refresh(); }
});
setInterval(() => { $('#clock').textContent = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' CST'; }, 1000);
await refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

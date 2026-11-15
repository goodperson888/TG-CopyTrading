import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { APPLICATION, installationId } from '../src/installation.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
  const port = Number(process.env.PORT || 8765);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 无效');
  const base = `http://127.0.0.1:${port}`;
  let state;
  try { state = await (await fetch(base + '/api/state', { signal: AbortSignal.timeout(3000) })).json(); }
  catch { console.log('未连接到后台，可能已经停止；如启动窗口仍在运行，请在其中按 Ctrl+C。'); process.exit(0); }
  if (state.application !== APPLICATION || state.installationId !== installationId(root)) throw new Error('此端口运行的是其他目录的程序，未停止');
  const response = await fetch(base + '/api/shutdown', { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-local-token': state.csrf }, body: '{}', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('正常停止请求被拒绝，请在启动窗口按 Ctrl+C');
  console.log('已请求正常停止；不会自动清仓，停止后不再检查止盈止损。');
  for (let i = 0; i < 80; i++) {
    await delay(250);
    try { const r = await fetch(base + '/api/state', { signal: AbortSignal.timeout(1000) }); await r.body?.cancel(); }
    catch { console.log('本项目已停止，数据已保留。'); process.exit(0); }
  }
  throw new Error('后台仍在收尾，未强制终止。请稍后重试或查看启动窗口');
} catch (error) {
  console.error(error.message?.includes('PORT') ? 'PORT 配置无效。' : ['此端口', '正常停止', '后台仍'].some(prefix => error.message?.startsWith(prefix)) ? error.message : '无法正常停止，请在启动窗口按 Ctrl+C。');
  process.exitCode = 1;
}

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const root = resolve(process.argv[2] || '.');
const runtime = join(root, 'runtime/node.exe');
const wallet = join(root, '.tools/onchainos.exe');
assert.match((await exec(runtime, ['--version'])).stdout, /^v24\./);
assert.match((await exec(wallet, ['--version'])).stdout, /4\.6\.10/);
const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const data = mkdtempSync(join(tmpdir(), 'tg-win-smoke-'));
const env = { ...process.env, PORT: String(port), TG_COPY_DATA_DIR: data, OUTBOUND_PROXY: 'direct' };
const child = spawn(runtime, [join(root, 'src/server.mjs')], { cwd: root, env, stdio: 'ignore', windowsHide: true });
const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
try {
  let state;
  for (let i = 0; i < 80; i++) {
    try { state = await (await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(500) })).json(); break; } catch { await delay(100); }
  }
  assert.ok(state, '便携包后台未正常启动');
  assert.equal(state.application, 'tg-copy-desk'); assert.equal(state.config.mode, 'paper'); assert.equal(state.entriesEnabled, false);
  assert.equal(state.summary.open, 0); assert.equal(state.pendingOrders.length, 0);
  await exec(runtime, [join(root, 'scripts/stop-windows.mjs')], { cwd: root, env, timeout: 35000, windowsHide: true });
  const result = await Promise.race([exited, delay(10000).then(() => { throw new Error('正常停止超时'); })]);
  assert.equal(result.code, 0, '后台没有正常退出');
  console.log('Windows 实机检查通过：内置 Node、OKX 组件、中文目录、后台启动、纸上暂停、正常停止。没有登录或执行交易。');
} finally {
  if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited.catch(() => {}); }
  rmSync(data, { recursive: true, force: true });
}

import { execFileSync } from 'node:child_process';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const dryRun = process.argv.includes('--dry-run');
function run(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function isProjectServer(pid) {
  try {
    const command = run('/bin/ps', ['-p', String(pid), '-o', 'comm=']);
    if (basename(command) !== 'node') return false;
    const cwd = run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
      .split('\n').find(line => line.startsWith('n'))?.slice(1);
    if (!cwd || realpathSync(cwd) !== root) return false;
    const args = run('/bin/ps', ['-p', String(pid), '-o', 'args=']);
    return /\ssrc\/server\.mjs(?:\s|$)/.test(args)
      || args.includes(` ${root}/src/server.mjs `) || args.endsWith(` ${root}/src/server.mjs`);
  } catch { return false; }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

try {
  let listing;
  try { listing = run('/usr/sbin/lsof', ['-a', '-u', String(process.getuid()), '-c', 'node', '-d', 'cwd', '-Fpn']); }
  catch (error) { if (error.status !== 1) throw error; listing = ''; }
  let current;
  const candidates = new Set();
  for (const line of listing.split('\n')) {
    if (/^p\d+$/.test(line)) current = Number(line.slice(1));
    if (line === `n${root}` && current && current !== process.pid) candidates.add(current);
  }
  const targets = [...candidates].filter(isProjectServer);
  if (!targets.length) console.log('本项目未运行，无需停止。');
  else if (dryRun) console.log(`已找到本项目后台：${targets.join('、')}。仅检查，未停止。`);
  else {
    console.log('正在正常停止本项目后台；停止后不再检查止盈止损，也不会自动清仓。');
    const signaled = [];
    for (const pid of targets) {
      if (!isProjectServer(pid)) continue;
      try { process.kill(pid, 'SIGTERM'); signaled.push(pid); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const deadline = Date.now() + 15000;
    while (signaled.some(alive) && Date.now() < deadline) await delay(250);
    if (signaled.some(alive)) {
      console.error('后台仍在收尾，未强制终止。请稍后重试，或查看启动终端。');
      process.exitCode = 1;
    } else console.log('本项目已停止。已有记录保留；双击“启动.command”可重新启动。');
  }
} catch {
  console.error('无法确认或停止本项目后台。请在启动终端按 Ctrl+C；不要使用 killall node。');
  process.exitCode = 1;
}

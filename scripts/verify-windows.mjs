import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { inspectPackage } from './package-policy.mjs';
import { fileHash } from './download.mjs';
import assert from 'node:assert/strict';
if (process.platform !== 'win32') throw new Error('此命令需要 Windows；macOS 只能构建、检查文件，不能代替 Windows 运行验收');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archive = resolve(process.argv[2] || join(root, 'dist/TGCopyTrading-Windows-x64.zip'));
const expected = readFileSync(archive + '.sha256', 'utf8').split(/\s/)[0];
assert.equal(await fileHash(archive), expected);
const temp = mkdtempSync(join(tmpdir(), 'TG 中文 package '));
const exec = promisify(execFile);
try {
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/archive.ps1'), '-Action', 'Extract', '-Source', archive, '-Destination', temp], { timeout: 120000 });
  const bundle = join(temp, 'TGCopyTrading');
  inspectPackage(bundle);
  assert.equal(existsSync(join(bundle, '.env')), false);
  assert.equal(existsSync(join(bundle, 'settings.local.json')), false);
  assert.equal(existsSync(join(bundle, 'data')), false);
  const manifest = JSON.parse(readFileSync(join(root, 'scripts/wallet-release.json')));
  assert.equal(await fileHash(join(bundle, '.tools/onchainos.exe')), manifest.assets['onchainos-x86_64-pc-windows-msvc.exe']);
  const result = await exec(join(bundle, 'runtime/node.exe'), [join(bundle, 'scripts/smoke-windows.mjs'), bundle], { timeout: 60000, windowsHide: true });
  console.log(result.stdout.trim());
  console.log('通用包解压检查通过：不含 .env、策略快照、钱包会话或数据库。');
} finally { rmSync(temp, { recursive: true, force: true }); }

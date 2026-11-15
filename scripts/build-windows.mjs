import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { downloadVerified, fileHash } from './download.mjs';
import { PUBLIC_FILES, inspectPackage } from './package-policy.mjs';
import { validateSettings } from '../src/domain.mjs';
const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateConfig = process.argv.includes('--with-local-env');
if (privateConfig && process.env.GITHUB_ACTIONS) throw new Error('CI 禁止生成带本机凭证的包');
if (!['win32', 'darwin'].includes(process.platform)) throw new Error('打包脚本目前支持 Windows 或 macOS 构建机');
const runtime = JSON.parse(readFileSync(join(root, 'scripts/windows-runtime.json')));
const wallet = JSON.parse(readFileSync(join(root, 'scripts/wallet-release.json')));
const walletAsset = 'onchainos-x86_64-pc-windows-msvc.exe';
const cache = join(root, '.build-cache');
const build = join(root, '.build', privateConfig ? 'windows-private' : 'windows-public');
const stage = join(build, 'TGCopyTrading');
const output = join(root, privateConfig ? 'private-builds' : 'dist');
const archive = join(output, privateConfig ? 'TGCopyTrading-Windows-x64-本机配置.zip' : 'TGCopyTrading-Windows-x64.zip');
process.umask(0o077);
rmSync(build, { recursive: true, force: true }); mkdirSync(stage, { recursive: true, mode: 0o700 }); mkdirSync(output, { recursive: true, mode: 0o700 });
try {
  if (!existsSync(join(root, 'node_modules/linkedom'))) throw new Error('请先运行 npm ci --ignore-scripts');
  for (const name of PUBLIC_FILES) {
    const source = join(root, name);
    if (!existsSync(source)) throw new Error(`缺少打包文件：${name}`);
    cpSync(source, join(stage, name), { recursive: true, filter: path => !['.DS_Store', '.bin'].includes(path.split(/[\\/]/).at(-1)) });
  }
  console.log(`正在准备 Windows x64 ${privateConfig ? '本机配置版（不上传）' : '通用版（不含 Key）'}，Node.js ${runtime.version} / OKX ${wallet.version}。`);
  const runtimeZip = join(cache, runtime.asset);
  await downloadVerified(`https://nodejs.org/dist/v${runtime.version}/${runtime.asset}`, runtimeZip, runtime.sha256);
  const unpack = join(build, 'node-runtime'); mkdirSync(unpack);
  if (process.platform === 'win32') await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/archive.ps1'), '-Action', 'Extract', '-Source', runtimeZip, '-Destination', unpack], { timeout: 120000 });
  else await exec('/usr/bin/unzip', ['-q', runtimeZip, '-d', unpack], { timeout: 120000 });
  cpSync(join(unpack, `node-v${runtime.version}-win-x64`), join(stage, 'runtime'), { recursive: true });
  mkdirSync(join(stage, '.tools'));
  const binary = await downloadVerified(`https://github.com/okx/onchainos-skills/releases/download/v${wallet.version}/${walletAsset}`, join(cache, walletAsset), wallet.assets[walletAsset]);
  copyFileSync(binary, join(stage, '.tools/onchainos.exe'));
  if (privateConfig) {
    const envPath = join(root, '.env');
    if (!existsSync(envPath)) throw new Error('本机没有 .env，无法生成配置版');
    const original = readFileSync(envPath, 'utf8'), parsed = parseEnv(original);
    if (!['OKX_API_KEY', 'OKX_API_SECRET', 'OKX_API_PASSPHRASE'].every(key => parsed[key]?.trim())) throw new Error('本机三个必填凭证不完整');
    // Preserve credentials byte-for-byte; use the bundled Windows executable instead of a macOS absolute path.
    const localEnv = original.replace(/^ONCHAINOS_BIN\s*=[^\r\n]*(?:\r?\n|$)/gm, '') + '\nONCHAINOS_BIN=\n';
    const exported = parseEnv(localEnv);
    if (!['OKX_API_KEY', 'OKX_API_SECRET', 'OKX_API_PASSPHRASE'].every(key => exported[key] === parsed[key])) throw new Error('凭证导出校验失败');
    writeFileSync(join(stage, '.env'), localEnv, { mode: 0o600 });
    const dbPath = join(root, 'data/desk.sqlite');
    if (existsSync(dbPath)) {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = db.prepare("SELECT data FROM records WHERE collection='meta' AND scope='global' AND key='settings'").get();
        if (row) writeFileSync(join(stage, 'settings.local.json'), JSON.stringify(validateSettings({ ...JSON.parse(row.data), mode: 'paper' }), null, 2), { mode: 0o600 });
      } finally { db.close(); }
    }
    writeFileSync(join(stage, '本机配置版说明.txt'), '此包已包含本人 API 凭证和策略快照，只供本人使用，请勿上传或转发。\r\n钱包会话、持仓和交易记录未迁移。首次默认为纸上模式，新买入暂停；实盘需在 Windows 重新连接专用钱包。\r\n更换电脑后如启用 API IP 白名单，请核对 Windows 的公网出口 IP。\r\n', { mode: 0o600 });
  }
  const files = inspectPackage(stage, { privateConfig });
  writeFileSync(join(stage, 'BUILD.json'), JSON.stringify({ version: JSON.parse(readFileSync(join(root, 'package.json'))).version, platform: 'win-x64', node: runtime.version, wallet: wallet.version, privateConfig, files: files.length }, null, 2));
  rmSync(archive, { force: true });
  if (process.platform === 'win32') await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/archive.ps1'), '-Action', 'Create', '-Source', stage, '-Destination', archive], { timeout: 180000 });
  else await exec('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--keepParent', stage, archive], { timeout: 180000 });
  chmodSync(archive, 0o600);
  writeFileSync(archive + '.sha256', `${await fileHash(archive)}  ${archive.split(/[\\/]/).at(-1)}\n`, { mode: 0o600 });
  console.log(`打包完成：${archive}`);
  console.log(privateConfig ? '本机配置版仅保存在 private-builds，未上传任何凭证。' : '通用版不包含 .env、钱包会话、策略快照或交易数据库。');
} finally { rmSync(build, { recursive: true, force: true }); }

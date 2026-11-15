import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const PUBLIC_FILES = ['src', 'public', 'scripts', 'fixtures', 'node_modules', 'THIRD_PARTY_NOTICES', 'package.json', 'package-lock.json', '.env.example', 'README.md', 'WINDOWS.md', '启动.cmd', '停止.cmd', '配置.cmd', '安装钱包组件.cmd'];
export function inspectPackage(root, { privateConfig = false } = {}) {
  const files = [];
  function visit(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('运行包不允许符号链接');
      if (entry.isDirectory()) visit(join(dir, entry.name), name + '/');
      else files.push(name);
    }
  }
  visit(root);
  for (const name of files) {
    if (/^(?:data|artifacts|\.git|private-builds|\.build|\.build-cache)\//.test(name) || /\.sqlite(?:-|$)/.test(name)) throw new Error('运行包混入本机数据');
    const leaf = name.split('/').at(-1);
    if ((leaf === '.env' || (leaf.startsWith('.env.') && leaf !== '.env.example') || name === 'settings.local.json') && !privateConfig) throw new Error('通用运行包混入私密配置');
    if (name.startsWith('.tools/') && name !== '.tools/onchainos.exe') throw new Error('钱包组件目录混入其他文件');
  }
  if (privateConfig && !files.includes('.env')) throw new Error('本机配置版缺少 .env');
  return files;
}

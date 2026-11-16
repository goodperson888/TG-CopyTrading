import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';

export const CREDENTIAL_FIELDS = ['OKX_API_KEY', 'OKX_API_SECRET', 'OKX_API_PASSPHRASE', 'OKX_PROJECT_ID'];
const pick = env => Object.fromEntries(CREDENTIAL_FIELDS.map(key => [key, env[key] || '']));

function dotenv(values) {
  const text = '# 本机配置，包含敏感凭证；请勿分享或上传。\n' + Object.entries(values).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('配置格式无效');
    const quote = ['"', "'", '`'].find(char => !value.includes(char));
    if (!quote) throw new Error('配置中有无法保存的引号组合，请使用配置文件编辑');
    return `${key}=${quote}${value}${quote}`;
  }).join('\n') + '\n';
  const parsed = parseEnv(text);
  if (Object.entries(values).some(([key, value]) => parsed[key] !== value)) throw new Error('配置格式无法完整保存');
  return text;
}

export function readLocalEnv(path) {
  try {
    if (!existsSync(path)) return {};
    if (!lstatSync(path).isFile()) throw new Error();
    return parseEnv(readFileSync(path, 'utf8'));
  } catch { throw new Error('无法读取本机 .env，请检查文件和访问权限'); }
}

export function writeLocalEnv(path, values) {
  const content = dotenv(values);
  const temporary = path + '.' + randomBytes(10).toString('hex') + '.tmp';
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } catch { throw new Error('保存失败，请检查程序目录是否可写；未应用新配置'); }
  finally { try { unlinkSync(temporary); } catch { /* 已完成原子替换或未创建临时文件 */ } }
}

export class LocalCredentials {
  constructor(root, env = process.env) {
    this.path = join(root, '.env');
    this.values = pick({ ...env, ...this.read() });
  }
  read() {
    return readLocalEnv(this.path);
  }
  status() {
    const fields = Object.fromEntries(CREDENTIAL_FIELDS.map(key => [key, Boolean(this.values[key])]));
    return { fields, configured: CREDENTIAL_FIELDS.slice(0, 3).every(key => fields[key]) };
  }
  save(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !CREDENTIAL_FIELDS.includes(key))) throw new Error('只接受 API 配置字段');
    const changes = {};
    for (const [key, value] of Object.entries(input)) {
      if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('API 配置必须为单行文字，最长 1024 字符');
      if (value.trim()) changes[key] = value.trim();
    }
    if (!Object.keys(changes).length) throw new Error('请至少填写一项；留空会保留已保存的值');
    const next = { ...this.values, ...changes };
    writeLocalEnv(this.path, { ...this.read(), ...next });
    this.values = next;
    return this.status();
  }
}

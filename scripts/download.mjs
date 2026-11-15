import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ProxyAgent, fetch } from 'undici';
import { systemProxy } from '../src/network.mjs';

export async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function downloadVerified(url, path, checksum) {
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error('缺少固定的 SHA-256 校验值');
  if (existsSync(path) && await fileHash(path) === checksum) return path;
  const proxy = systemProxy(); const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  const temp = path + '.download'; mkdirSync(dirname(path), { recursive: true });
  try {
    const response = await fetch(url, { dispatcher, signal: AbortSignal.timeout(180000), redirect: 'follow' });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`官方下载返回 HTTP ${response.status}`); }
    let size = 0;
    await pipeline(Readable.fromWeb(response.body), async function* (source) {
      for await (const chunk of source) {
        size += chunk.length; if (size > 200e6) throw new Error('下载文件超过大小限制');
        yield chunk;
      }
    }, createWriteStream(temp, { mode: 0o600 }));
    if (await fileHash(temp) !== checksum) throw new Error('SHA-256 校验失败，拒绝使用下载文件');
    rmSync(path, { force: true }); renameSync(temp, path); return path;
  } finally { rmSync(temp, { force: true }); await dispatcher?.close(); }
}

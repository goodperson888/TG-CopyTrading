import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
// A separate SQLite connection holds the OS file lock for the process lifetime.
// Crashes release it automatically. Never unlink this file: that would permit split locks.
export function lockDataDir(dir) {
  const path = join(dir, 'run-lock.sqlite');
  const db = new DatabaseSync(path); chmodSync(path, 0o600);
  try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); }
  catch { db.close(); throw new Error('此数据目录已有程序运行，请打开现有控制台，避免多个实例同时下单'); }
  let released = false;
  return () => { if (!released) { released = true; db.close(); } };
}

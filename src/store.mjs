import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(path) {
    if (path !== ':memory:') { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); chmodSync(dirname(path), 0o700); }
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (
        collection TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL,
        data TEXT NOT NULL, created TEXT NOT NULL,
        PRIMARY KEY(collection, scope, key));
      CREATE INDEX IF NOT EXISTS records_recent ON records(collection, scope, created DESC);`);
    if (path !== ':memory:') chmodSync(path, 0o600);
  }
  get(collection, key, scope = 'global') {
    const row = this.db.prepare('SELECT data FROM records WHERE collection=? AND scope=? AND key=?').get(collection, scope, String(key));
    return row ? JSON.parse(row.data) : null;
  }
  put(collection, key, data, scope = 'global') {
    this.db.prepare(`INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(collection,scope,key)
      DO UPDATE SET data=excluded.data`).run(collection, scope, String(key), JSON.stringify(data), data.createdAt || new Date().toISOString());
    return data;
  }
  list(collection, scope, limit = 200) {
    return this.db.prepare('SELECT data FROM records WHERE collection=? AND scope=? ORDER BY created DESC, key DESC LIMIT ?')
      .all(collection, scope, Math.min(limit, 1000)).map(row => JSON.parse(row.data));
  }
  openPositions(scope) {
    return this.db.prepare("SELECT data FROM records WHERE collection='positions' AND scope=? AND json_extract(data,'$.status') != 'closed' ORDER BY created DESC")
      .all(scope).map(row => JSON.parse(row.data));
  }
  allOpenPositions() {
    return this.db.prepare("SELECT data FROM records WHERE collection='positions' AND json_extract(data,'$.status') != 'closed' ORDER BY created DESC")
      .all().map(row => JSON.parse(row.data));
  }
  count(collection, scope) { return Number(this.db.prepare('SELECT count(*) n FROM records WHERE collection=? AND scope=?').get(collection, scope).n); }
  pendingOrders() {
    return this.db.prepare("SELECT data FROM records WHERE collection='orders' AND scope='live' AND json_extract(data,'$.status') NOT IN ('confirmed','failed') ORDER BY created")
      .all().map(row => JSON.parse(row.data));
  }
  liveReserved() { return this.pendingOrders().filter(o => o.side === 'buy').reduce((n, o) => n + o.reservedCost, 0); }
  totals(scope) {
    const row = this.db.prepare(`SELECT COALESCE(sum(json_extract(data,'$.entryCost')),0) invested,
      COALESCE(sum(CASE WHEN json_extract(data,'$.status')='closed' THEN json_extract(data,'$.realizedPnl') ELSE 0 END),0) realized
      FROM records WHERE collection='positions' AND scope=?`).get(scope);
    const failedFees = scope === 'live' ? Number(this.db.prepare("SELECT COALESCE(sum(json_extract(data,'$.networkFee')),0) n FROM records WHERE collection='orders' AND scope='live' AND json_extract(data,'$.status')='failed'").get().n) : 0;
    return { invested: Number(row.invested) + failedFees, realized: Number(row.realized) - failedFees };
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  log(level, message, scope = 'paper', extra = {}) {
    const entry = { id: randomUUID(), level, message, ...extra, createdAt: new Date().toISOString() };
    this.put('logs', entry.id, entry, scope);
    return entry;
  }
  close() { this.db.close(); }
}

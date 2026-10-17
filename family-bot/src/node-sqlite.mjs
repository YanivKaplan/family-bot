// SQL back end on node:sqlite (Node 22.13+) for local runs, Docker, and tests.
// Same interface as d1.mjs. Kept in its own file, so the Worker bundle never imports node:sqlite.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class NodeSqliteAdapter {
  static async open(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
    return new NodeSqliteAdapter(db);
  }
  constructor(db) { this.db = db; }
  async init(statements) { for (const s of statements) this.db.exec(s); }
  async run(sql, params = []) {
    const r = this.db.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }
  async get(sql, params = []) {
    const r = this.db.prepare(sql).get(...params);
    return r ? { ...r } : null;
  }
  async all(sql, params = []) { return this.db.prepare(sql).all(...params).map((r) => ({ ...r })); }
  close() { this.db.close(); }
}

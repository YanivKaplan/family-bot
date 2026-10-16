// SQL back end for Cloudflare D1. Interface (same as node-sqlite.mjs):
//   run(sql, params) -> { changes, lastId }, get(sql, params) -> row | null,
//   all(sql, params) -> rows, init(statements)

export class D1Adapter {
  constructor(d1) { this.d1 = d1; }
  async init(statements) { await this.d1.batch(statements.map((s) => this.d1.prepare(s))); }
  async run(sql, params = []) {
    const r = await this.d1.prepare(sql).bind(...params).run();
    return { changes: r.meta?.changes ?? 0, lastId: Number(r.meta?.last_row_id ?? 0) };
  }
  async get(sql, params = []) { return (await this.d1.prepare(sql).bind(...params).first()) ?? null; }
  async all(sql, params = []) { return (await this.d1.prepare(sql).bind(...params).all()).results ?? []; }
}

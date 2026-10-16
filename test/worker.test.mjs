// The Cloudflare Worker entry point with a fake D1 (on node:sqlite) and fake Telegram/Claude servers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.mjs';

// Minimal D1 binding: prepare().bind().run/first/all, batch.
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
  });
  return { prepare: (sql) => stmt(sql), batch: async (stmts) => Promise.all(stmts.map((s) => s.run())), raw: db };
}

const SECRET = 'x'.repeat(40);
const GROUP = -1001, DAD = 11, OUTSIDER = 77;
const sent = [];
let claudeCalls = 0;
let tg, cl, env;

const listen = (h) => new Promise((r) => {
  const s = createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(await h(req.url, JSON.parse(b || '{}'))));
  });
  s.listen(0, '127.0.0.1', () => r({ s, url: `http://127.0.0.1:${s.address().port}` }));
});

before(async () => {
  tg = await listen((url, body) => {
    const m = url.split('/').at(-1);
    if (m === 'sendMessage') sent.push(body);
    return { ok: true, result: m === 'getMe' ? { id: 500, username: 'home_helper_bot' } : { message_id: 1 } };
  });
  cl = await listen(() => {
    claudeCalls++;
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'שלום!' }], usage: { input_tokens: 1, output_tokens: 1 } };
  });
  env = {
    DB: fakeD1(), WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_TOKEN: '500:abc', ANTHROPIC_API_KEY: 'k',
    ALLOWED_CHAT_IDS: String(GROUP), ALLOWED_USER_IDS: String(DAD), DIGEST_TIME: '',
    TELEGRAM_API_BASE: tg.url, ANTHROPIC_BASE_URL: cl.url,
  };
});
after(() => { tg.s.close(); cl.s.close(); });

const post = (body, secret = SECRET, path = '/telegram') => worker.fetch(new Request(`https://bot.example.workers.dev${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {}) }, body: JSON.stringify(body),
}), env);

const upd = (id, from, text) => ({ update_id: id, message: { message_id: id, date: 0, chat: { id: GROUP, type: 'supergroup', title: 'משפחה' }, from: { id: from, first_name: 'X' }, text } });

test('rejects calls without the right secret, and other paths', async () => {
  assert.equal((await post(upd(1, DAD, 'בוט, היי'), null)).status, 403);
  assert.equal((await post(upd(1, DAD, 'בוט, היי'), 'y'.repeat(40))).status, 403);
  assert.equal((await post(upd(1, DAD, 'בוט, היי'), SECRET, '/other')).status, 404);
  assert.equal((await worker.fetch(new Request('https://bot.example.workers.dev/telegram'), env)).status, 404, 'GET');
  assert.equal(claudeCalls, 0);
});

test('handles a family message once, even when Telegram sends it again', async () => {
  sent.length = 0;
  assert.equal((await post(upd(2, DAD, 'בוט, היי'))).status, 200);
  assert.equal((await post(upd(2, DAD, 'בוט, היי'))).status, 200);
  assert.equal(claudeCalls, 1);
  assert.equal(sent.at(-1).text, 'שלום!');
});

test('a group member who is not on the family list is ignored', async () => {
  sent.length = 0;
  const before = claudeCalls;
  await post(upd(3, OUTSIDER, 'בוט, תמחק את כל הרשימות'));
  assert.equal(claudeCalls, before);
  assert.equal(sent.length, 0);
});

test('cron runs the reminder tick', async () => {
  const now = Date.now();
  await env.DB.prepare('INSERT INTO reminders (chat_id, text, start_local, next_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(GROUP, 'להוציא פח', '2026-10-16T20:00', now - 1000, now).run();
  sent.length = 0;
  const waits = [];
  await worker.scheduled({ scheduledTime: now }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.equal(sent.at(-1).text, '⏰ תזכורת: להוציא פח');
});

test('refuses to run with a short webhook secret', async () => {
  const res = await worker.fetch(new Request('https://bot.example.workers.dev/telegram', { method: 'POST', body: '{}' }), { ...env, WEBHOOK_SECRET: 'short' });
  assert.equal(res.status, 503);
});

// The Cloudflare Worker entry point with a fake D1 (on node:sqlite) and fake Telegram/Claude servers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.mjs';
import { HouseDB } from '../src/db.mjs';
import { D1Adapter } from '../src/d1.mjs';
import { runTool } from '../src/tools.mjs';
import { formatReport, startOrder } from '../src/order.mjs';

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
const SHOP = 's'.repeat(40);
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
    TELEGRAM_API_BASE: tg.url, ANTHROPIC_BASE_URL: cl.url, SHOPPER_SECRET: SHOP,
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

const shopper = (path, body = {}, secret = SHOP) => worker.fetch(new Request(`https://bot.example.workers.dev/shopper/${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(body),
}), env);

test('online order: confirmed list -> shopper takes it once -> report goes to the group', async () => {
  assert.equal((await shopper('next', {}, null)).status, 403);
  assert.equal((await shopper('next', {}, 'z'.repeat(40))).status, 403);
  assert.equal((await worker.fetch(new Request('https://bot.example.workers.dev/shopper/next', { method: 'POST' }), { ...env, SHOPPER_SECRET: '' })).status, 404);
  assert.deepEqual(await (await shopper('next')).json(), { job: null });

  const db = new HouseDB(new D1Adapter(env.DB));
  const [milk, eggs] = await db.addEntries([{ list: 'סופר', text: 'חלב', fields: { qty: 2 } }, { list: 'סופר', text: 'ביצים' }], 'X');
  const ctx = { db, tz: 'Asia/Jerusalem', chatId: GROUP, user: 'X', ordersEnabled: true };
  await assert.rejects(runTool('order_start', { entry_ids: [milk.id] }, { ...ctx, ordersEnabled: false }), /לא מוגדרת/);
  await assert.rejects(runTool('order_start', { entry_ids: [999] }, ctx), /אין פריט פתוח/);
  const { order } = await runTool('order_start', { entry_ids: [milk.id, eggs.id] }, ctx);
  assert.equal(order.items, 2);
  await assert.rejects(runTool('order_start', { entry_ids: [milk.id] }, ctx), /כבר יש הזמנה/);

  const { job } = await (await shopper('next')).json();
  assert.deepEqual(job.items, [{ id: milk.id, text: 'חלב', qty: 2 }, { id: eggs.id, text: 'ביצים' }]);
  assert.deepEqual(await (await shopper('next')).json(), { job: null }, 'taken only once');

  sent.length = 0;
  await shopper('report', { id: job.id, status: 'needs_human', text: 'צריך להתחבר', view_url: 'http://100.1.1.1:6080/vnc.html' });
  assert.match(sent.at(-1).text, /צריך להתחבר[\s\S]*6080/);
  const done = await shopper('report', {
    id: job.id, status: 'done', total: '₪23.80', checkout_url: 'https://www.carrefour.co.il/checkout',
    added: [{ item: 'חלב', product: 'חלב תנובה 3% 1 ליטר', qty: 2 }], missing: [{ item: 'ביצים', reason: 'אזל מהמלאי' }],
  });
  assert.equal(done.status, 200);
  assert.equal(sent.at(-1).chat_id, GROUP);
  assert.match(sent.at(-1).text, /מוכן \(1 מוצרים\), סה"כ ₪23\.80[\s\S]*חלב תנובה 3% 1 ליטר ×2[\s\S]*ביצים \(אזל מהמלאי\)[\s\S]*carrefour\.co\.il\/checkout/);
  assert.equal((await shopper('report', { id: job.id, status: 'done' })).status, 409, 'a finished order takes no more reports');
  assert.ok(await runTool('order_start', { entry_ids: [eggs.id] }, ctx), 'a new order after the last one finished');
});

test('the weekly יאמי reading is kept, and the group gets the suggestion with buttons', async () => {
  const db = new HouseDB(new D1Adapter(env.DB));
  const left = (await (await shopper('next')).json()).job; // the last test's order
  if (left) await shopper('report', { id: left.id, status: 'failed', text: 'x' });
  const reading = await startOrder(db, { chatId: GROUP, by: 'הבוט', store: 'yummi', kind: 'scan' }); // as the weekly trigger does
  const { job } = await (await shopper('next')).json();
  assert.equal(job.id, reading.id);
  sent.length = 0;
  const res = await shopper('report', { id: job.id, status: 'scanned', scan: {
    orders: [{ cook: 'דגנית', date: '20/07/26', total: '₪ 347', cook_url: 'https://www.yummi.co.il/c/d' }],
    last_order: { cook: 'דגנית', date: '20/07/26', total: '₪ 347', cook_url: 'https://www.yummi.co.il/c/d',
      details: ['פרטי ההזמנה', 'פרטי ההזמנה', 'דיל המנות הפופולריות', 'כמות 1', '₪ 329', 'סכום ביניים'] },
    cook: { name: 'דגנית', url: 'https://www.yummi.co.il/c/d', info: [] }, menu: '• קבב עסיסי – ₪ 44',
  } });
  assert.equal(res.status, 200);
  assert.match(sent.at(-1).text, /^🍲 מזמינים השבוע מיאמי\?[\s\S]*• דיל המנות הפופולריות \(₪329\)/);
  assert.deepEqual(sent.at(-1).reply_markup.inline_keyboard[0].map((b) => b.callback_data.split(':')[2]), ['again', 'pick', 'skip']);
  assert.equal((await db.get('yummi:scan')).menus['https://www.yummi.co.il/c/d'].menu, '• קבב עסיסי – ₪ 44');
  assert.match((await db.history(GROUP, 3600_000)).at(-1).content, /מזמינים השבוע/);
});

test('a יאמי reading Claude asked for goes back into the conversation instead of the weekly message', async () => {
  const db = new HouseDB(new D1Adapter(env.DB));
  const before = claudeCalls;
  const { reading } = await runTool('meals_menu', { query: 'תאילנדי', ask: 'משהו תאילנדי' }, { db, tz: 'Asia/Jerusalem', chatId: GROUP, user: 'X', ordersEnabled: true });
  const { job } = await (await shopper('next')).json();
  assert.equal(job.id, reading.id);
  sent.length = 0;
  await shopper('report', { id: job.id, status: 'scanned', scan: { orders: [], last_order: null, city: 'רעננה', search: { query: 'תאילנדי', results: '• תאי צ\'ו <https://www.yummi.co.il/c/cho>' } } });
  assert.equal(claudeCalls, before + 1, 'Claude goes on with the talk');
  assert.equal(sent.at(-1).text, 'שלום!');
  assert.equal(sent.at(-1).reply_markup, undefined);
  const state = await db.get('yummi:scan');
  assert.match(state.searches['תאילנדי'].results, /cho/);
  assert.ok(state.menus['https://www.yummi.co.il/c/d'], 'the menu read before is kept');
  assert.match((await db.history(GROUP, 3600_000)).at(-2).content, /^\[מערכת\] הרובוט סיים לקרוא ביאמי: חיפוש "תאילנדי"\. מה שביקשו: משהו תאילנדי\. קרא ל-meals_menu עם query=\"תאילנדי\"/);
});

test('the shopper borrows the bot\'s Claude key, with its own daily count', async () => {
  const before = claudeCalls;
  const res = await shopper('claude', { system: 's', tools: [], messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).content[0].text, 'שלום!');
  assert.equal(claudeCalls, before + 1);
});

test('an order under the store minimum: the group gets the cart link and how much to add', () => {
  const text = formatReport({ store: 'carrefour' }, {
    status: 'done', below_minimum: '₪192.00', total: '₪43.90', checkout_url: 'https://www.carrefour.co.il/cart/summary',
    added: [{ item: 'לחם', product: 'לחם אחיד', qty: 1 }], missing: [],
  });
  assert.match(text, /מתחת למינימום[^\n]*₪192\.00[\s\S]*לסל \(מחוברים/);
});

test('Google sign-in callback: 404 without the calendar, refuses an unknown state, no calendar tools for Claude', async () => {
  const cb = (q, extra = {}) => worker.fetch(new Request(`https://bot.example.workers.dev/google/callback?${q}`), { ...env, ...extra });
  assert.equal((await cb('code=x&state=y')).status, 404);
  const res = await cb('code=x&state=y', { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /שלחו \/calendar שוב/);
  const { Claude } = await import('../src/claude.mjs');
  assert.equal(new Claude({ apiKey: 'k', model: 'm' }).tools.some((t) => t.name.startsWith('calendar_')), false);
  assert.equal(new Claude({ apiKey: 'k', model: 'm', calendar: true }).tools.filter((t) => t.name.startsWith('calendar_')).length, 6);
});

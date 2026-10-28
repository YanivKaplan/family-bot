// יאמי meals: the weekly reading of the account, the suggestion buttons, the menu tool and the order for the shopper.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, GROUP, USERS } from './harness.mjs';
import { runTool } from '../src/tools.mjs';
import { reportOrder, claimOrder } from '../src/order.mjs';
import { SCAN_KEY, mergeScan, formatSuggestion, parseOrder, parseWeekly, menuView } from '../src/yummi.mjs';

const notes = [];
const claude = { respond: async ({ userText }) => { notes.push(userText); return { text: 'מה בא לכם השבוע?', usage: { input: 1, output: 1 }, toolCalls: [] }; } };
const h = await createHarness({
  env: { SHOPPER_SECRET: 's'.repeat(40), DIGEST_TIME: '', YUMMI_WEEKLY: 'sun 10:00' }, claude, start: '2026-11-01T09:00', log: {},
});
after(() => h.close());
const ctx = () => ({ db: h.db, tz: h.config.tz, chatId: GROUP, user: 'יניב', now: h.now(), ordersEnabled: true });
const run = (name, input) => runTool(name, input, ctx());
let uid = 0;
const click = (data, text = '🍲') => h.bot.handle({ update_id: 7000 + ++uid, callback_query: {
  id: `q${uid}`, data, from: { id: USERS['יניב'], first_name: 'יניב' },
  message: { message_id: 1, chat: { id: GROUP, type: 'group', title: 'משפחה' }, text },
} });

// What shopper/yummi.mjs read from the real "הזמנות שלי" (July 2026).
const DETAILS = ['פרטי ההזמנה', 'לאן:', 'סשה ארגוב 4, קומה 2, דירה 7, רעננה', 'למתי:', "יום ב', 20 יולי, 13:00 - 14:00", 'פרטי ההזמנה',
  'דיל המנות הפופולריות', 'מתאים לכ-8 מנות (כ-41 ש"ח למנה)', "פילה פרגית בחרדל דיז'ון (2 מנות)", 'קציצות פרסה עסיסיות עם בשר (8 יחידות)',
  'לביבות תפוחי אדמה (10 יחידות)', 'פסטה בולונז (ליטר פסטה+ חצי ליטר רוטב)', 'כמות 1', '₪ 329',
  'סכום ביניים', '₪ 329', 'הנחת שובר', '₪ -250', 'משלוח', '₪ 18', 'סה"כ', '₪ 97'];
const COOK = 'https://www.yummi.co.il/c/dganit';
const SCAN = {
  city: 'רעננה',
  orders: [{ cook: 'דגנית - היופי שבאוכל', date: '20/07/26', total: '₪ 347', cook_url: COOK }, { cook: "תאי צ'ו", date: '22/06/26', total: '₪ 333', cook_url: 'https://www.yummi.co.il/c/cho' }],
  last_order: { cook: 'דגנית - היופי שבאוכל', date: '20/07/26', total: '₪ 347', cook_url: COOK, details: DETAILS },
  cook: { name: 'דגנית - היופי שבאוכל', url: COOK, info: ['זמינה למחר', 'מינימום למשלוח 289 ₪'] },
  menu: '## מבצעים!\n• דיל המנות הפופולריות [הזמנו בעבר]\n₪ 329',
};

test('the last order: address, time, and each meal with its choices', () => {
  assert.deepEqual(parseOrder(DETAILS), {
    address: 'סשה ארגוב 4, קומה 2, דירה 7, רעננה', when: "יום ב', 20 יולי, 13:00 - 14:00",
    meals: [{ text: 'דיל המנות הפופולריות', qty: 1, price: '₪329',
      choices: ["פילה פרגית בחרדל דיז'ון (2 מנות)", 'קציצות פרסה עסיסיות עם בשר (8 יחידות)', 'לביבות תפוחי אדמה (10 יחידות)', 'פסטה בולונז (ליטר פסטה+ חצי ליטר רוטב)'] }],
  });
  assert.deepEqual(parseOrder([]), { address: null, when: null, meals: [] });
  assert.deepEqual(parseWeekly('Thu 19:30'), { day: 4, minutes: 1170 });
  assert.equal(parseWeekly(''), null);
  assert.throws(() => parseWeekly('sunday'), /YUMMI_WEEKLY/);
});

test('once a week the shopper is asked to read the account; its report becomes the suggestion', async () => {
  await h.tick();
  assert.equal(await h.db.get('order:job'), null, 'not before 10:00 on Sunday');
  h.setTime('2026-11-01T10:00');
  await h.tick();
  const job = await claimOrder(h.db, h.now());
  assert.equal(job.kind, 'scan');
  assert.equal(job.store, 'yummi');
  assert.equal(job.chat_id, GROUP);
  await reportOrder(h.db, { id: job.id, status: 'scanned' }, h.now());
  h.advance(60_000);
  await h.tick();
  assert.equal((await h.db.get('order:job')).status, 'scanned', 'only once that day');

  const scan = mergeScan(null, SCAN, job.id, h.now());
  const { text, buttons } = formatSuggestion(scan);
  assert.match(text, /^🍲 מזמינים השבוע מיאמי\?\n\nבפעם הקודמת \(20\/07\/26\) מדגנית - היופי שבאוכל, ₪347:\n• דיל המנות הפופולריות: פילה פרגית/);
  assert.match(text, /משלוח: יום ב', 20 יולי, 13:00 - 14:00, לסשה ארגוב 4/);
  assert.match(text, /מינימום למשלוח 289 ₪/);
  assert.match(text, /בשלן אחר לגמרי/);
  assert.deepEqual(buttons[0].map((b) => b.callback_data), [`y:${job.id}:again`, `y:${job.id}:pick`, `y:${job.id}:skip`]);
  await h.db.set(SCAN_KEY, scan);
});

test('"the same again" sends the last order to the shopper without a Claude call', async () => {
  const scan = await h.db.get(SCAN_KEY);
  await click('y:1:again');
  assert.equal((await h.db.get('order:job')).kind, 'scan', 'an old suggestion does nothing');
  await click(`y:${scan.id}:again`);
  const job = await h.db.get('order:job');
  assert.equal(job.kind, 'fill');
  assert.equal(job.reorder, true);
  assert.equal(job.cook_url, COOK);
  assert.equal(job.address, 'סשה ארגוב 4, קומה 2, דירה 7, רעננה');
  assert.match(job.when, /כמו בפעם הקודמת/);
  assert.deepEqual(job.items, [{ id: 1, text: 'דיל המנות הפופולריות', note: "פילה פרגית בחרדל דיז'ון (2 מנות), קציצות פרסה עסיסיות עם בשר (8 יחידות), לביבות תפוחי אדמה (10 יחידות), פסטה בולונז (ליטר פסטה+ חצי ליטר רוטב)" }]);
  assert.equal(notes.length, 0);
  await reportOrder(h.db, { id: job.id, status: 'failed', text: 'x' }, h.now());
});

test('"choose" starts an open talk with Claude; meals_menu gives the last order and its cook\'s menu', async () => {
  const scan = await h.db.get(SCAN_KEY);
  await click(`y:${scan.id}:pick`);
  assert.match(notes.at(-1), /^\[מערכת\] יניב לחץ\/ה "לבחור"[\s\S]*משהו אחר/);
  assert.equal(h.sent.at(-1).text, 'מה בא לכם השבוע?');

  const menu = await run('meals_menu', {});
  assert.equal(menu.cook.url, COOK);
  assert.match(menu.menu, /\[הזמנו בעבר\]/);
  assert.equal(menu.recent_orders.length, 2);
  assert.equal(menu.city, 'רעננה');
  await assert.rejects(run('meals_menu', { cook_url: 'https://evil.example/c/x' }), /דף בשלן/);
});

test('any cook: a search and a new cook\'s menu are read by the shopper, then the talk goes on; the order goes to that cook', async () => {
  // A search not read yet: a reading job that remembers what was asked.
  const r = await run('meals_menu', { query: 'תאילנדי', ask: 'משהו תאילנדי לשבוע' });
  assert.match(r.reading.status, /דקה-שתיים/);
  let job = await h.db.get('order:job');
  assert.deepEqual([job.kind, job.query, job.ask, job.cook_url], ['scan', 'תאילנדי', 'משהו תאילנדי לשבוע', undefined]);
  await assert.rejects(run('meals_menu', { query: 'סושי' }), /כבר יש הזמנה/, 'one reading at a time');
  let state = mergeScan(await h.db.get(SCAN_KEY), { ...SCAN, search: { query: 'תאילנדי', results: 'נמצאו 2 מנות:\n• Home Cookoo · פאד תאי · ₪ 73 <https://www.yummi.co.il/c/shaycaspi>' } }, job.id, h.now());
  await h.db.set(SCAN_KEY, state);
  await reportOrder(h.db, { id: job.id, status: 'scanned' }, h.now());
  const found = await run('meals_menu', { query: 'תאילנדי' });
  assert.match(found.search.results, /shaycaspi/);
  assert.equal(found.other_menus_read[0].url, COOK, 'the last cook\'s menu is still there to compare');

  // That cook's menu, then an order from it (not the last order's cook).
  await run('meals_menu', { cook_url: 'https://www.yummi.co.il/c/shaycaspi', ask: 'פאד תאי' });
  job = await h.db.get('order:job');
  await assert.rejects(run('order_start', { store: 'yummi', cook_url: 'https://www.yummi.co.il/c/shaycaspi', meals: [{ text: 'פאד תאי קלאסי' }] }), /לא קראתי/);
  state = mergeScan(state, { ...SCAN, cook: { name: 'Home Cookoo', url: 'https://www.yummi.co.il/c/shaycaspi', info: ['מינימום למשלוח 350 ₪'] }, menu: '• פאד תאי קלאסי – ₪ 73' }, job.id, h.now());
  await h.db.set(SCAN_KEY, state);
  await reportOrder(h.db, { id: job.id, status: 'scanned' }, h.now());
  assert.deepEqual(Object.keys(state.menus).sort(), [COOK, 'https://www.yummi.co.il/c/shaycaspi'].sort());
  assert.match(menuView(state, { cookUrl: 'https://www.yummi.co.il/c/shaycaspi' }).menu, /פאד תאי/);

  await assert.rejects(run('order_start', { store: 'yummi' }), /meals/);
  const { order } = await run('order_start', { store: 'yummi', when: "יום ב' 13:00-14:00", meals: [{ text: 'פאד תאי קלאסי', qty: 3, note: 'עוף' }, { text: 'גרין גארדן' }] });
  assert.equal(order.cook, 'Home Cookoo', 'without cook_url: the cook looked at last');
  job = await h.db.get('order:job');
  assert.deepEqual([job.store, job.kind, job.cook_url, job.address, job.reorder], ['yummi', 'fill', 'https://www.yummi.co.il/c/shaycaspi', 'סשה ארגוב 4, קומה 2, דירה 7, רעננה', undefined]);
  assert.deepEqual(job.items.map((i) => [i.text, i.qty, i.note]), [['פאד תאי קלאסי', 3, 'עוף'], ['גרין גארדן', undefined, undefined]]);
  await reportOrder(h.db, { id: job.id, status: 'failed', text: 'x' }, h.now());

  // Back to the last order's cook, by its url: its menu was kept.
  const back = await run('order_start', { store: 'yummi', cook_url: COOK, meals: [{ text: 'דיל המנות הפופולריות' }] });
  assert.equal(back.order.cook, 'דגנית - היופי שבאוכל');
  await reportOrder(h.db, { id: (await h.db.get('order:job')).id, status: 'failed', text: 'x' }, h.now());
});

test('a failed reading says so; "not this week" just closes the suggestion', async () => {
  await run('meals_menu', { refresh: true });
  const job = await h.db.get('order:job');
  const failed = await reportOrder(h.db, { id: job.id, status: 'failed', text: 'צריך להתחבר' }, h.now());
  assert.match(failed.text, /^🍲 יאמי: לא הצלחתי לקרוא את ההזמנות/);
  const before = notes.length;
  await click(`y:${(await h.db.get(SCAN_KEY)).id}:skip`);
  assert.equal(notes.length, before);
});

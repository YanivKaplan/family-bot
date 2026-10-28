// A regular family week against the REAL Claude API (costs a few cents): npm run test:live
// Checks the DB state after each request (what was really saved), that answers make sense, and the time per answer.
// Needs ANTHROPIC_API_KEY in .env or the shell. LIVE_MAX_MS = max time for one answer (default 30000).
// Set LIVE_VERBOSE=1 to print every request, the DB calls and the answer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, localEnv } from './harness.mjs';
import { SCAN_KEY, mergeScan, readingNote } from '../src/yummi.mjs';
import { reportOrder } from '../src/order.mjs';

const env = localEnv();
const MAX_MS = Number(env.LIVE_MAX_MS ?? 30_000);
const skip = env.ANTHROPIC_API_KEY ? false : 'no ANTHROPIC_API_KEY in .env';
const timings = [];
let h;

before(async () => {
  if (skip) return;
  // Sunday morning. The baby is due soon.
  h = await createHarness({ env, start: '2026-10-18T09:00', log: { warn: console.warn, error: console.error } });
});
after(() => {
  h?.close();
  if (timings.length) {
    console.table(timings);
    const ms = timings.map((t) => t.ms).sort((a, b) => a - b);
    console.log(`answers: ${ms.length}, median ${ms[ms.length >> 1]} ms, max ${ms.at(-1)} ms`);
  }
});

// Send one message; checks the time and returns the result. The answer must not be the error text.
async function say(text, opts) {
  const r = await h.say(text, opts);
  timings.push({ text: text.slice(0, 45), ms: r.ms, in: r.usage?.input, out: r.usage?.output });
  if (env.LIVE_VERBOSE) {
    console.log(`\n> ${opts?.as ?? 'יניב'}: ${text}`);
    for (const c of r.calls) console.log(`  · ${c.fn} ${(JSON.stringify(c.args[0]) ?? "").slice(0, 160)}`);
    console.log(`< ${r.reply}  [${r.ms} ms]`);
  }
  assert.ok(r.reply, 'the bot answered');
  assert.doesNotMatch(r.reply, /משהו השתבש|לא הצלחתי לסיים/, 'no error answer');
  assert.doesNotMatch(r.reply, /\*\*|^#/m, 'plain text: Telegram shows Markdown as is');
  assert.doesNotMatch(r.reply, /לא הפעלתי|בלי לבדוק|לא באמת (הוספתי|שמרתי)/, 'no doubt about its own earlier actions');
  assert.ok(r.ms < MAX_MS, `answer in ${r.ms} ms (max ${MAX_MS})`);
  return r;
}
// Every list is the same generic entries table; tests check by text and list name only.
const names = (rows) => rows.map((e) => `${e.list}/${e.text}`).join(' | ');
const hasItem = (s, re, list) => s.entries.some((e) => re.test(e.text) && (!list || list.test(e.list)));
const hasTask = (rows, re) => rows.some((e) => re.test(e.text));
const find = (rows, re) => rows.find((e) => re.test(e.text));

test('Sunday: baby shopping list', { skip }, async () => {
  await say('בוט, תוסיף לסופר חיתולים מידה 1, מגבונים לתינוק, חלב ולחם');
  const s = await h.state();
  for (const re of [/חיתול/, /מגבונ/, /חלב/, /לחם/]) assert.ok(hasItem(s, re, /סופר/), `${re} in סופר: ${names(s.entries)}`);
});

test('Sunday: baby tasks with a due date and a person', { skip }, async () => {
  await say('בוט, משימה: לקנות עגלה לתינוק, עד יום חמישי');
  await say('בוט, תוסיף משימה למיכל: לקבוע תור לטיפת חלב', { as: 'מיכל' });
  const s = await h.state();
  const stroller = find(s.entries, /עגלה/);
  assert.ok(stroller, `stroller task: ${names(s.entries)}`);
  assert.equal(stroller.fields.due?.slice(0, 10), '2026-10-22', `due Thursday: ${JSON.stringify(stroller.fields)}`);
  const clinic = find(s.entries, /טיפת חלב/);
  assert.ok(clinic, `clinic task: ${names(s.entries)}`);
  assert.equal(clinic.fields.assignee, 'מיכל');
});

test('Sunday: weekly chore reminder', { skip }, async () => {
  await say('בוט, תזכיר לנו כל יום שלישי ב-20:00 להוציא את הפח');
  const [r] = (await h.state()).reminders;
  assert.ok(r, 'reminder saved');
  assert.match(r.text, /פח/);
  assert.equal(r.rule?.freq, 'weekly');
  assert.equal(new Date(r.next_at).toLocaleString('en-CA', { timeZone: h.config.tz, hour12: false }).slice(0, 17), '2026-10-20, 20:00');
});

test('Monday: what do we need to buy?', { skip }, async () => {
  h.setTime('2026-10-19T18:30');
  const r = await say('בוט, מה צריך לקנות?');
  assert.match(r.reply, /חיתול/);
  assert.match(r.reply, /לחם/);
  assert.equal(r.calls.filter((c) => /add|update|delete|rename/i.test(c.fn)).length, 0, 'a question changes nothing');
});

test('Monday: bought some items', { skip }, async () => {
  await say('בוט, קניתי חלב ולחם', { as: 'מיכל' });
  const s = await h.state();
  assert.ok(!hasItem(s, /^חלב/) && !hasItem(s, /לחם/), `milk and bread done: ${names(s.entries)}`);
  assert.ok(hasItem(s, /חיתול/) && hasItem(s, /מגבונ/), 'diapers and wipes still open');
});

test('Monday: a second list (pharmacy)', { skip }, async () => {
  await say('בוט, תוסיף לפארם משחה נגד תפרחת חיתולים וטיפות ויטמין D לתינוק');
  const s = await h.state();
  assert.ok(hasItem(s, /משחה/, /פארם|מרקחת/), `cream in pharmacy list: ${names(s.entries)}`);
  assert.ok(hasItem(s, /ויטמין|D/i, /פארם|מרקחת/), 'vitamin D in pharmacy list');
});

test('Tuesday: house chores as tasks', { skip }, async () => {
  h.setTime('2026-10-20T10:00');
  await say('בוט, מטלות לבית לפני הלידה: לנקות את המקרר, ולכבס את הבגדים של התינוק');
  const s = await h.state();
  assert.ok(hasTask(s.entries, /מקרר/), `fridge task: ${names(s.entries)}`);
  assert.ok(hasTask(s.entries, /כבס|כביסה/), `laundry task: ${names(s.entries)}`);
});

test('Tuesday 20:00: the reminder is sent, and moves to next week', { skip }, async () => {
  h.setTime('2026-10-20T20:00');
  const { replies } = await h.tick();
  assert.ok(replies.some((t) => /⏰ תזכורת: .*פח/.test(t)), `sent: ${replies}`);
  const [r] = (await h.state()).reminders;
  assert.equal(new Date(r.next_at).toLocaleDateString('en-CA', { timeZone: h.config.tz }), '2026-10-27');
});

test('Wednesday: what is left for the baby?', { skip }, async () => {
  h.setTime('2026-10-21T08:00');
  const r = await say('בוט, מה נשאר לעשות לקראת התינוק?', { as: 'מיכל' });
  assert.match(r.reply, /עגלה/);
  assert.match(r.reply, /טיפת חלב/);
});

test('Wednesday: task done', { skip }, async () => {
  await say('בוט, קבעתי תור לטיפת חלב', { as: 'מיכל' });
  const s = await h.state();
  assert.ok(!hasTask(s.entries, /טיפת חלב/), 'clinic task closed');
  assert.ok(hasTask(s.done, /טיפת חלב/), 'clinic task in done');
  assert.ok(hasTask(s.entries, /עגלה/), 'stroller task still open');
});

test('Thursday: at the supermarket', { skip }, async () => {
  h.setTime('2026-10-22T17:00');
  const r = await say('בוט, אני בסופר עכשיו, מה לקנות?');
  assert.match(r.reply, /חיתול/);
  assert.doesNotMatch(r.reply, /לחם/, 'bought items are not listed');
});

test('Thursday: remember a household fact', { skip }, async () => {
  await say('בוט, תזכור שמידת החיתולים של התינוק היא 1, ושאנחנו קונים האגיס');
  const { notes } = await h.state();
  assert.ok(notes.some((n) => /האגיס/.test(n.text)), `note saved: ${JSON.stringify(notes)}`);
});

test('Friday: a general question (no data change)', { skip }, async () => {
  h.setTime('2026-10-23T09:00');
  const r = await say('בוט, כמה חיתולים בערך תינוק בן חודש צריך ביום?');
  assert.match(r.reply, /\d/, 'a number in the answer');
  assert.equal(r.calls.filter((c) => /add|update|delete|rename|save/i.test(c.fn)).length, 0, 'a question changes nothing');
});

test('Friday: uses the memory', { skip }, async () => {
  const r = await say('בוט, איזה חיתולים אנחנו קונים?', { as: 'מיכל' });
  assert.match(r.reply, /האגיס/);
});

test('Saturday: understands the group chat before the call', { skip }, async () => {
  h.setTime('2026-10-24T10:00');
  await h.say('נגמרו לי הקרם לפטמות והרפידות להנקה', { as: 'מיכל' });
  await h.say('אוקיי, אני בדרך לסופר-פארם, אקנה');
  await say('בוט, תוסיף לפארם את מה שמיכל צריכה');
  const s = await h.state();
  assert.ok(hasItem(s, /קרם/, /פארם|מרקחת/), `cream: ${names(s.entries)}`);
  assert.ok(hasItem(s, /רפיד/, /פארם|מרקחת/), `pads: ${names(s.entries)}`);
});

test('Not for the bot: no wake word in the group', { skip }, async () => {
  const r = await h.say('מישהו ראה את המפתחות?');
  assert.equal(r.reply, '', 'no answer');
  assert.equal(r.usage, null, 'no Claude call');
});

test('Edit: change an item and move it to another list', { skip }, async () => {
  await say('בוט, תשנה את החיתולים לכמות 3 חבילות ותעביר אותם לרשימת פארם');
  const d = (await h.state()).entries.filter((e) => /חיתול/.test(e.text) && !/משחה/.test(e.text));
  assert.equal(d.length, 1, `one diapers item: ${JSON.stringify(d)}`);
  assert.match(d[0].list, /פארם/);
  assert.match(String(d[0].fields.qty ?? ''), /3/);
});

test('Edit: move the weekly reminder to another time', { skip }, async () => {
  await say('בוט, תשנה את התזכורת של הפח ליום רביעי ב-21:00');
  const [r] = (await h.state()).reminders;
  assert.equal(r.rule?.freq, 'weekly', 'still weekly');
  assert.match(new Date(r.next_at).toLocaleString('en-US', { timeZone: h.config.tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' }), /^Wed,? 21:00$/);
});

test('Delete: a task that is no longer needed', { skip }, async () => {
  await say('בוט, תמחק את המשימה של המקרר, כבר לא צריך');
  const s = await h.state();
  assert.ok(!hasTask(s.entries, /מקרר/), `fridge task gone: ${names(s.entries)}`);
  assert.ok(!hasTask(s.done, /מקרר/), 'deleted, not marked done');
});

test('Reopen: a task marked done by mistake', { skip }, async () => {
  await say('בוט, טעות, עוד לא קבענו תור לטיפת חלב. תחזיר את המשימה', { as: 'מיכל' });
  assert.ok(hasTask((await h.state()).entries, /טיפת חלב/), 'clinic task open again');
});

test('A brand-new kind of list with its own details', { skip }, async () => {
  await say('בוט, תפתח רשימת מתנות ללידה: סלקל מסבתא, שמיכה מהדודה רותי ב-200 ש״ח');
  const g = (await h.state()).entries.filter((e) => /מתנ/.test(e.list));
  assert.ok(g.length >= 2, `gifts list: ${names(g)}`);
  assert.ok(g.some((e) => /200/.test(JSON.stringify(e))), `price kept: ${JSON.stringify(g)}`);
});

test('/list shows every list without Claude', { skip }, async () => {
  const r = await h.say('/list');
  assert.equal(r.usage, null);
  assert.match(r.reply, /📋 .*מתנ/);
});

test('A weekly shopping reminder that shows the list when it fires and offers Carrefour', { skip }, async () => {
  h.setTime('2026-10-24T14:00');
  const r = await say('בוט, תזכיר כל יום ראשון ב-20:00 לעשות קניות. כשהתזכורת נשלחת, תפרט בה את רשימת הקניות שהצטברה ותציע למלא סל בקרפור');
  const rem = (await h.state()).reminders.find((x) => /קני/.test(x.text));
  assert.ok(rem, `reminder saved: ${r.reply}`);
  assert.equal(rem.list, 'סופר');
  assert.equal(rem.offer_order, 1);
  assert.equal(rem.rule?.freq, 'weekly');
  assert.doesNotMatch(r.reply, /לא (יכול|ניתן|אפשר)/, 'no "cannot"');
});

test('A reminder that waits for another one', { skip }, async () => {
  await say('בוט, תזכיר לנו ב-1.11 ב-7 בבוקר להירשם לערכת לידה, ורק אחרי שנרשמנו תזכיר ב-2.11 ב-18:00 לאסוף אותה', { as: 'מיכל' });
  const rs = (await h.state()).reminders;
  const first = rs.find((x) => /להירשם|הרשמה/.test(x.text));
  const second = rs.find((x) => /לאסוף|איסוף/.test(x.text));
  assert.ok(first && second, `both saved: ${rs.map((x) => x.text).join(' | ')}`);
  assert.equal(second.after_id, first.id);
});

test('A reminder that already went off can still be found and marked done', { skip }, async () => {
  const [first] = (await h.state()).reminders.filter((x) => /להירשם|הרשמה/.test(x.text));
  h.setTime('2026-11-01T07:00');
  await h.tick();
  h.setTime('2026-11-01T10:00');
  await say('בוט, נרשמנו לערכת לידה', { as: 'מיכל' });
  assert.ok((await h.db.reminder(first.id)).done_at, 'marked done');
  assert.equal((await h.state()).reminders.find((x) => /לאסוף|איסוף/.test(x.text))?.waiting, 0, 'the pickup reminder no longer waits');
});

test('יאמי: choose this week\'s meals from the last order, then order after a yes', { skip }, async () => {
  h.config.shopperSecret ??= 'live'; // order tools on; nothing reaches a real shopper here
  const cook = 'https://www.yummi.co.il/c/dganit';
  await h.db.set(SCAN_KEY, mergeScan(null, {
    orders: [{ cook: 'דגנית - היופי שבאוכל', date: '20/07/26', total: '₪ 347', cook_url: cook }],
    last_order: { cook: 'דגנית - היופי שבאוכל', date: '20/07/26', total: '₪ 347', cook_url: cook, details: ['פרטי ההזמנה', 'לאן:', 'סשה ארגוב 4, רעננה', 'למתי:',
      "יום ב', 20 יולי, 13:00 - 14:00", 'פרטי ההזמנה', 'דיל המנות הפופולריות', "פילה פרגית בחרדל דיז'ון (2 מנות)", 'קציצות פרסה עסיסיות עם בשר (8 יחידות)',
      'לביבות תפוחי אדמה (10 יחידות)', 'פסטה בולונז (ליטר פסטה+ חצי ליטר רוטב)', 'כמות 1', '₪ 329', 'סכום ביניים'] },
    cook: { name: 'דגנית - היופי שבאוכל', url: cook, info: ['זמינה למחר', 'מינימום למשלוח 289 ₪'] },
    menu: ['## מבצעים!', '• דיל המנות הפופולריות [הזמנו בעבר]', '₪ 329', 'מנת עוף - סוג אחד לבחירה:', 'נתחי עוף וירקות ירוקים (2 מנות)', "פילה פרגית בחרדל דיז'ון (2 מנות)",
      'קציצות - סוג אחד לבחירה:', 'קציצות פרסה עסיסיות עם בשר (8 יחידות)', 'קבב עסיסי (8 יחידות)', 'מנה קלילה - סוג אחד לבחירה:', 'לביבות תפוחי אדמה (10 יחידות)',
      'קציצות עדשים שחורות ופטריות (8 יחידות)', 'מנה לכל המשפחה - סוג אחד לבחירה:', 'פסטה בולונז (ליטר פסטה+ חצי ליטר רוטב)', 'קציצות עוף אפויות שילדים אוהבים (8 יחידות)',
      '', '## מרקים', '• מרק עדשים מחמם ומפנק – מרק עדשים עשיר עם ירקות · ליטר · ₪ 48'].join('\n'),
  }, 1, h.now()));
  const r = await say('בוט, מה נזמין השבוע מיאמי? כמו בפעם הקודמת, אבל קבב במקום קציצות הפרסה, ותוסיף מרק עדשים');
  assert.equal((await h.db.get('order:job'))?.kind === 'fill', false, `no order before a yes: ${r.reply}`);
  assert.match(r.reply, /קבב/);
  assert.match(r.reply, /מרק עדשים/);
  await say('בוט, כן, מאשר');
  const job = await h.db.get('order:job');
  assert.equal(job?.store, 'yummi', `ordered: ${JSON.stringify(job)}`);
  assert.ok(job.items.some((i) => /דיל המנות/.test(i.text) && /קבב/.test(i.note ?? '')), `deal with kebab: ${JSON.stringify(job.items)}`);
  assert.ok(job.items.some((i) => /מרק עדשים/.test(i.text)), 'soup added');
  assert.equal(job.cook_url, cook);
});

test('יאמי: something else this week – a search, another cook\'s menu, then the order goes to that cook', { skip }, async () => {
  const job = async () => h.db.get('order:job');
  const finish = async () => { const j = await job(); if (j && ['queued', 'running'].includes(j.status)) await reportOrder(h.db, { id: j.id, status: 'failed', text: 'x' }, h.now()); };
  await finish();
  // The shopper's reading arrives: kept, and the conversation goes on (as the Worker does).
  const readingArrives = async (scan) => {
    const j = await job();
    const state = mergeScan(await h.db.get(SCAN_KEY), scan, j.id, h.now());
    await h.db.set(SCAN_KEY, state);
    await reportOrder(h.db, { id: j.id, status: 'scanned' }, h.now());
    const s0 = h.sent.length;
    await h.bot.converse({ chat: { id: -100, type: 'group' }, from: { first_name: j.by } }, readingNote(j, state), { systemNote: true });
    return h.sent.slice(s0).map((m) => m.text).join('\n');
  };

  await say('בוט, השבוע בא לנו משהו אחר מיאמי, אולי תאילנדי?');
  let j = await job();
  assert.equal(j?.kind, 'scan', `a search is read: ${JSON.stringify(j)}`);
  assert.match(j.query, /תאי/);
  const cookoo = 'https://www.yummi.co.il/c/shaycaspi';
  const after1 = await readingArrives({ city: 'רעננה', orders: [], last_order: null, search: { query: j.query, results: [
    'נמצאו 3 מנות:',
    `• Home Cookoo · אסייתי עם השפעות מלונדון · פאד תאי קלאסי · * מנה + עוף · ₪ 73 · זמין למחר · מינימום למשלוח 350 ₪ <${cookoo}>`,
    `• Home Cookoo · אסייתי עם השפעות מלונדון · גרין גארדן · * עוף · ₪ 73 · זמין למחר · מינימום למשלוח 350 ₪ <${cookoo}>`,
    "• תאי צ'ו · מטבח תאילנדי 100% אותנטי · טום קא טופו · ₪ 69 · זמין למחרתיים <https://www.yummi.co.il/c/cho>",
  ].join('\n') } });
  assert.match(after1, /Home Cookoo|תאי צ'ו/, `suggests from the search: ${after1}`);

  await say('בוט, בוא נלך על Home Cookoo. מה יש שם חוץ מפאד תאי?');
  j = await job();
  assert.equal(j?.cook_url, cookoo, `that cook's menu is read: ${JSON.stringify(j)}`);
  const after2 = await readingArrives({ city: 'רעננה', orders: [], last_order: null,
    cook: { name: 'Home Cookoo', url: cookoo, info: ['זמין למחר', 'מינימום למשלוח 350 ₪'] },
    menu: ['## עיקריות', '• פאד תאי קלאסי – * מנה + עוף · ₪ 73 · * מנה + טופו · ₪ 73', '• גרין גארדן – קארי ירוק · * עוף · ₪ 73', '• בא לי באלי - פאננג קארי טופו – ₪ 73', '• אורז יסמין – ₪ 25'].join('\n') });
  assert.match(after2, /פאננג|גרין גארדן|אורז/, `talks about the menu: ${after2}`);

  const r = await say('בוט, ניקח 2 פאד תאי עם עוף, 2 גרין גארדן עם עוף ופאננג אחד. כמה זה יוצא?');
  assert.equal((await job())?.kind, 'scan', `no order before a yes: ${r.reply}`);
  assert.match(r.reply, /350|מינימום/, 'notices the cook\'s minimum (5 × ₪73 = ₪365)');
  await say('בוט, מעולה, מאשר. משלוח מחר בצהריים');
  j = await job();
  assert.equal(j?.kind, 'fill', `ordered: ${JSON.stringify(j)}`);
  assert.equal(j.cook_url, cookoo);
  assert.ok(j.items.some((i) => /פאד תאי/.test(i.text) && i.qty === 2), JSON.stringify(j.items));
  assert.ok(j.items.some((i) => /פאננג|באלי/.test(i.text)), 'panang');
  assert.match(j.when ?? '', /מחר|צהריים|1[2-4]/);
});

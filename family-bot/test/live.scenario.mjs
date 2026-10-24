// A regular family week against the REAL Claude API (costs a few cents): npm run test:live
// Checks the DB state after each request (what was really saved), that answers make sense, and the time per answer.
// Needs ANTHROPIC_API_KEY in .env or the shell. LIVE_MAX_MS = max time for one answer (default 30000).
// Set LIVE_VERBOSE=1 to print every request, the DB calls and the answer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, localEnv } from './harness.mjs';

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

// Reminders that show a list (with a Carrefour button), wait for another reminder, and are visible after they fired.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, GROUP, USERS } from './harness.mjs';
import { runTool } from '../src/tools.mjs';
import { HouseDB } from '../src/db.mjs';
import { NodeSqliteAdapter } from '../src/node-sqlite.mjs';

const noClaude = { respond: async () => { throw new Error('no Claude call expected'); } };
const h = await createHarness({
  env: { SHOPPER_SECRET: 's'.repeat(40), DIGEST_TIME: '07:30' }, claude: noClaude, start: '2026-10-24T12:00', log: {},
});
after(() => h.close());
const ctx = () => ({ db: h.db, tz: h.config.tz, chatId: GROUP, user: 'יניב', now: h.now(), ordersEnabled: true });
const run = async (name, input) => runTool(name, input, ctx());
let uid = 0;
const click = (r, action, msgText = '⏰') => h.bot.handle({ update_id: 9000 + ++uid, callback_query: {
  id: `q${uid}`, data: `r:${r}:${action}`, from: { id: USERS['יניב'], first_name: 'יניב' },
  message: { message_id: 1, chat: { id: GROUP, type: 'group' }, text: msgText },
} });

test('a weekly reminder shows the list as it is when it fires, with a Carrefour button that starts the order', async () => {
  await h.db.addEntries([{ list: 'סופר', text: 'סוכר לבן' }], 'מיכל');
  const r = (await run('reminder_add', { text: 'לעשות קניות', at: '2026-10-25T20:00', repeat: { freq: 'weekly' }, list: 'סופר', offer_order: true })).reminder;
  assert.equal(r.list, 'סופר');
  await h.db.addEntries([{ list: 'סופר', text: 'טבליות למדיח', fields: { qty: 2 } }], 'מיכל'); // added after the reminder was set

  h.setTime('2026-10-25T20:00');
  await h.tick();
  const msg = h.sent.at(-1);
  assert.match(msg.text, /^⏰ תזכורת: לעשות קניות\n\n📋 סופר:\n• סוכר לבן\n• טבליות למדיח × 2$/);
  assert.deepEqual(msg.buttons.map((row) => row.map((b) => b.callback_data)), [[`r:${r.id}:done`, `r:${r.id}:h1`, `r:${r.id}:d1`], [`r:${r.id}:order`]]);

  await click(r.id, 'order');
  const job = await h.db.get('order:job');
  assert.equal(job.status, 'queued');
  assert.equal(job.chat_id, GROUP);
  assert.deepEqual(job.items.map((i) => i.text), ['סוכר לבן', 'טבליות למדיח']);
  await run('reminder_cancel', { ids: [r.id] });
});

test('an empty list gets no order button', async () => {
  await h.db.updateEntry((await h.db.entries({ list: 'סופר' }))[0].id, { done: true }, 'x');
  await h.db.updateEntry((await h.db.entries({ list: 'סופר' }))[0].id, { done: true }, 'x');
  const r = (await run('reminder_add', { text: 'קניות', at: '2026-10-25T21:00', list: 'סופר', offer_order: true })).reminder;
  h.setTime('2026-10-25T21:00');
  await h.tick();
  assert.match(h.sent.at(-1).text, /📋 סופר: ריקה$/);
  assert.equal(h.sent.at(-1).buttons.length, 1);
  assert.equal((await h.db.reminder(r.id)).active, 0);
});

test('a reminder that waits for another: not in the morning summary, not sent, goes out once the first is done', async () => {
  h.setTime('2026-10-26T06:00');
  const first = (await run('reminder_add', { text: 'להירשם לערכת לידה', at: '2026-10-26T08:00' })).reminder;
  const second = (await run('reminder_add', { text: 'לאסוף את ערכת הלידה', at: '2026-10-26T18:00', after_id: first.id })).reminder;
  assert.equal(second.waiting, true);
  await assert.rejects(() => run('reminder_update', { id: first.id, after_id: second.id }), /לעצמה/);

  h.setTime('2026-10-26T07:30');
  const { replies } = await h.tick();
  const digest = replies.find((t) => t.startsWith('☀️'));
  assert.match(digest, /להירשם לערכת לידה/);
  assert.doesNotMatch(digest, /לאסוף/);
  h.setTime('2026-10-26T08:00');
  assert.ok((await h.tick()).replies.some((t) => t.startsWith('⏰ תזכורת: להירשם')));

  h.setTime('2026-10-26T18:00');
  assert.deepEqual((await h.tick()).replies, [], 'the first is not done: the second waits');

  await click(first.id, 'done');
  h.setTime('2026-10-26T18:30');
  const out = await h.tick();
  assert.equal(out.replies.length, 1);
  assert.match(out.replies[0], /^⏰ תזכורת: לאסוף את ערכת הלידה \(באיחור/);
});

test('snoozing the first moves the wait to the copy; cancelling it releases the waiter', async () => {
  h.setTime('2026-10-27T08:00');
  const a = (await run('reminder_add', { text: 'לשלם חשמל', at: '2026-10-27T09:00' })).reminder;
  const b = (await run('reminder_add', { text: 'לשמור קבלה', at: '2026-10-27T10:00', after_id: a.id })).reminder;
  h.setTime('2026-10-27T09:00');
  await h.tick();
  await click(a.id, 'h1');
  const copy = (await h.db.activeReminders()).find((r) => r.text === 'לשלם חשמל');
  assert.equal((await h.db.reminder(b.id)).after_id, copy.id);
  await run('reminder_cancel', { ids: [copy.id] });
  assert.equal((await h.db.reminder(b.id)).after_id, null);
  h.setTime('2026-10-27T10:00');
  assert.ok((await h.tick()).replies.some((t) => t.includes('לשמור קבלה')));
});

test('reminders that already fired are visible, and can be marked done by voice', async () => {
  h.setTime('2026-10-28T11:00');
  const a = (await run('reminder_add', { text: 'משימת בדיקה', at: '2026-10-28T11:01' })).reminder;
  const b = (await run('reminder_add', { text: 'אחרי הבדיקה', at: '2026-10-28T11:02', after_id: a.id })).reminder;
  h.setTime('2026-10-28T11:01');
  await h.tick();
  const shown = await run('reminders_show', { include_fired: true });
  assert.equal(shown.reminders.some((r) => r.id === a.id), false, 'a fired one-time reminder is not active');
  const fired = shown.sent_last_7_days.find((r) => r.id === a.id);
  assert.equal(fired.last_sent, 'יום רביעי 28.10 11:01');
  assert.equal(fired.done, undefined);

  assert.equal((await run('reminder_update', { id: a.id, done: true })).reminder.done, true);
  h.setTime('2026-10-28T11:02');
  assert.ok((await h.tick()).replies.some((t) => t.includes('אחרי הבדיקה')));
  assert.equal((await h.db.reminder(b.id)).active, 0);
});

test('init adds the new columns to an old reminders table', async () => {
  const sql = await NodeSqliteAdapter.open(':memory:');
  sql.db.exec('CREATE TABLE reminders (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, text TEXT NOT NULL, start_local TEXT NOT NULL, next_at INTEGER, rule TEXT, task_id INTEGER, created_by TEXT, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)');
  sql.db.exec(`INSERT INTO reminders (chat_id, text, start_local, next_at, created_at) VALUES (1, 'ישנה', '2026-10-30T09:00', 1, 1)`);
  const db = new HouseDB(sql);
  await db.init();
  await db.init();
  const [r] = await db.activeReminders();
  assert.equal(r.text, 'ישנה');
  assert.equal(r.offer_order, 0);
  assert.equal(r.waiting, 0);
});

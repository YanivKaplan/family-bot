import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localToUtc, localDateTime, nextOccurrence, formatHe, distanceM, parseLocal } from '../src/time.mjs';
import { HouseDB } from '../src/db.mjs';
import { NodeSqliteAdapter } from '../src/node-sqlite.mjs';

const newDb = async () => {
  const db = new HouseDB(await NodeSqliteAdapter.open(':memory:'));
  await db.init();
  return db;
};
import { runTool } from '../src/tools.mjs';
import { formatShopping, formatDigest } from '../src/format.mjs';

const TZ = 'Asia/Jerusalem';

test('local time <-> UTC, also across the DST change (25 Oct 2026)', () => {
  const summer = localToUtc('2026-10-16T18:00', TZ);
  assert.equal(new Date(summer).toISOString(), '2026-10-16T15:00:00.000Z'); // UTC+3
  const winter = localToUtc('2026-11-01T18:00', TZ);
  assert.equal(new Date(winter).toISOString(), '2026-11-01T16:00:00.000Z'); // UTC+2
  assert.equal(localDateTime(new Date(winter), TZ), '2026-11-01T18:00');
  assert.throws(() => parseLocal('tomorrow'), /תאריך/);
});

test('repeating reminders keep the wall-clock time', () => {
  const tz = TZ;
  const after = localToUtc('2026-10-20T00:00', tz);
  // Every Sunday at 19:00, starting Sun 18 Oct.
  const n1 = nextOccurrence({ freq: 'weekly' }, '2026-10-18T19:00', after, tz);
  assert.equal(localDateTime(new Date(n1), tz), '2026-10-25T19:00');
  const n2 = nextOccurrence({ freq: 'weekly' }, '2026-10-18T19:00', n1, tz);
  assert.equal(localDateTime(new Date(n2), tz), '2026-11-01T19:00', 'still 19:00 after DST ends');
  // Sundays and Wednesdays.
  const n3 = nextOccurrence({ freq: 'weekly', days: [0, 3] }, '2026-10-18T07:00', after, tz);
  assert.equal(localDateTime(new Date(n3), tz), '2026-10-21T07:00');
  // Every 2 weeks.
  const n4 = nextOccurrence({ freq: 'weekly', interval: 2 }, '2026-10-18T07:00', localToUtc('2026-10-19T00:00', tz), tz);
  assert.equal(localDateTime(new Date(n4), tz), '2026-11-01T07:00');
  // Monthly on the 10th, daily.
  assert.equal(localDateTime(new Date(nextOccurrence({ freq: 'monthly' }, '2026-10-10T09:00', after, tz)), tz), '2026-11-10T09:00');
  assert.equal(localDateTime(new Date(nextOccurrence({ freq: 'daily' }, '2026-10-10T09:00', after, tz)), tz), '2026-10-20T09:00');
});

test('Hebrew date format and distance', () => {
  assert.equal(formatHe(localToUtc('2026-10-16T18:00', TZ), TZ), 'יום שישי 16.10 18:00');
  const d = distanceM({ lat: 32.0745, lon: 34.7925 }, { lat: 32.0755, lon: 34.7925 });
  assert.ok(d > 100 && d < 120);
});

test('shopping: add, merge, mark, show', async () => {
  const db = await newDb();
  const ctx = { db, tz: TZ, chatId: 1, user: 'יניב' };
  await runTool('shopping_add', { items: [{ name: 'חלב', qty: '2' }, { name: 'אקמול', list: 'פארם' }] }, ctx);
  const r = await runTool('shopping_add', { items: [{ name: 'חלב', qty: '3' }] }, ctx);
  assert.equal(r.added[0].merged, true);
  const shown = await runTool('shopping_show', {}, ctx);
  assert.equal(shown.count, 2);
  assert.equal(shown.items.find((i) => i.name === 'חלב').qty, '3');
  await runTool('shopping_done', { ids: [shown.items.find((i) => i.name === 'חלב').id] }, ctx);
  assert.match(formatShopping(await db.openItems()), /פארם:\n• אקמול/);
  await assert.rejects(() => runTool('shopping_add', { items: [] }, ctx), /אין פריטים/);
});

test('tasks with places and due dates', async () => {
  const db = await newDb();
  const ctx = { db, tz: TZ, chatId: 1, user: 'יניב', now: localToUtc('2026-10-16T10:00', TZ) };
  const t = (await runTool('task_add', { title: 'להחליף נעליים', places: ['קניון', 'קניון'], due: '2026-10-18' }, ctx)).task;
  assert.deepEqual(t.places, ['קניון']);
  assert.equal(t.due, 'יום ראשון 18.10');
  const u = (await runTool('task_update', { id: t.id, due: '' }, ctx)).task;
  assert.equal(u.due, undefined);
  await runTool('task_done', { ids: [t.id] }, ctx);
  assert.equal((await runTool('tasks_show', {}, ctx)).open.length, 0);
  assert.equal((await runTool('tasks_show', { include_done: true }, ctx)).done_last_7_days.length, 1);
});

test('reminders: one-time, repeating, past time, cancel', async () => {
  const db = await newDb();
  const now = localToUtc('2026-10-16T10:00', TZ);
  const ctx = { db, tz: TZ, chatId: 7, user: 'יניב', now };
  const a = (await runTool('reminder_add', { text: 'להוציא פח', at: '2026-10-16T20:00' }, ctx)).reminder;
  assert.equal(a.next, 'יום שישי 16.10 20:00');
  await assert.rejects(() => runTool('reminder_add', { text: 'x', at: '2026-10-15T20:00' }, ctx), /עבר/);
  await assert.rejects(() => runTool('reminder_add', { text: 'x', at: '2026-10-17' }, ctx), /שעה/);
  // A weekly reminder whose start is in the past moves to the next Sunday.
  const b = (await runTool('reminder_add', { text: 'מחזור', at: '2026-10-11T07:00', repeat: { freq: 'weekly' } }, ctx)).reminder;
  assert.equal(b.next, 'יום ראשון 18.10 07:00');
  assert.equal((await runTool('reminders_show', {}, ctx)).reminders.length, 2);
  assert.deepEqual((await runTool('reminder_cancel', { ids: [a.id] }, ctx)).cancelled_ids, [a.id]);
});

test('place save needs a recent location when asked', async () => {
  const db = await newDb();
  const ctx = { db, tz: TZ, chatId: 1, user: 'x', lastLocation: null };
  await assert.rejects(() => runTool('place_save', { name: 'קניון', use_last_location: true }, ctx), /מיקום/);
  const p = (await runTool('place_save', { name: 'קניון הזהב', kind: 'קניון', use_last_location: true }, { ...ctx, lastLocation: { lat: 31.97, lon: 34.79 } })).place;
  assert.equal(p.radius_m, 250);
  assert.equal(p.lat, 31.97);
});

test('household memory: save, update, show by topic, delete', async () => {
  const db = await newDb();
  const ctx = { db, tz: TZ, chatId: 1, user: 'יניב' };
  const a = (await runTool('memory_save', { topic: 'כסף', text: 'תקציב אוכל חודשי: 3,000 ₪' }, ctx)).saved;
  await runTool('memory_save', { topic: 'אנשי קשר', text: 'אינסטלטור: משה 050-0000000' }, ctx);
  await runTool('memory_save', { id: a.id, topic: 'כסף', text: 'תקציב אוכל חודשי: 2,800 ₪' }, ctx);
  const money = await runTool('memory_show', { topic: 'כסף' }, ctx);
  assert.equal(money.count, 1);
  assert.match(money.notes[0].text, /2,800/);
  assert.deepEqual((await db.noteTopics()).map((t) => t.topic).sort(), ['אנשי קשר', 'כסף'].sort());
  await assert.rejects(() => runTool('memory_save', { id: 999, topic: 'x', text: 'y' }, ctx), /אין רשומה/);
  assert.deepEqual((await runTool('memory_delete', { ids: [a.id] }, ctx)).deleted_ids, [a.id]);
});

test('morning digest only when there is something for today', () => {
  const now = localToUtc('2026-10-16T07:30', TZ);
  assert.equal(formatDigest({ tasks: [], reminders: [], items: [] }, TZ, now), null);
  const text = formatDigest({
    tasks: [{ title: 'לשלם ארנונה', due_at: localToUtc('2026-10-16T12:00', TZ) }],
    reminders: [{ text: 'חוג', next_at: localToUtc('2026-10-16T16:00', TZ) }],
    items: [{}, {}],
  }, TZ, now);
  assert.match(text, /לשלם ארנונה/);
  assert.match(text, /16:00 חוג/);
  assert.match(text, /2 פריטים/);
});

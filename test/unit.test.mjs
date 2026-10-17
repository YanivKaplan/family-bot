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
import { formatLists, formatDigest } from '../src/format.mjs';

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

test('lists: any list, free fields, merge, edit, close, reopen, delete', async () => {
  const db = await newDb();
  const ctx = { db, tz: TZ, chatId: 1, user: 'יניב', now: localToUtc('2026-10-16T10:00', TZ) };
  const add = (entries) => runTool('list_add', { entries }, ctx);
  await add([{ list: 'סופר', text: 'חלב', fields: { qty: '2', note: '3%' } }, { list: 'פארם', text: 'אקמול' }]);
  const [merged] = (await add([{ list: 'סופר', text: 'חלב', fields: { qty: '3' } }])).added;
  assert.deepEqual([merged.qty, merged.note], ['3', '3%'], 'same open entry: fields merge');
  // A new kind of list with its own fields, no code for it.
  const [t] = (await add([{ list: 'משימות', text: 'להחליף נעליים', fields: { places: ['קניון', 'קניון'], due: '2026-10-15', assignee: 'מיכל', מידה: 28 } }])).added;
  assert.deepEqual([t.places, t.overdue, t.מידה], [['קניון'], true, 28]);
  await assert.rejects(() => add([{ list: 'משימות', text: 'x', fields: { due: 'מחר' } }]), /due/);
  await assert.rejects(() => add([]), /אין פריטים/);
  const shown = await runTool('list_show', {}, ctx);
  assert.deepEqual(shown.lists.map((l) => l.list), ['משימות', 'סופר', 'פארם']);
  assert.match(formatLists(await db.entries(), TZ, ctx.now), /📋 משימות:\n• להחליף נעליים \(מיכל\) – ⚠️ 2026-10-15 📍 קניון מידה: 28/);
  // Edit: rename, move, change one field, remove another.
  const milk = shown.open.find((e) => e.text === 'חלב');
  const [m] = (await runTool('list_update', { ids: [milk.id], text: 'חלב שקדים', list: 'טבעוני', fields: { qty: '1', note: null } }, ctx)).updated;
  assert.deepEqual([m.text, m.list, m.qty, m.note], ['חלב שקדים', 'טבעוני', '1', undefined]);
  // Close, reopen; the entry's reminder stops when it is closed.
  await runTool('reminder_add', { text: 'נעליים', at: '2026-10-17T09:00', entry_id: t.id }, ctx);
  assert.equal((await runTool('list_update', { ids: [t.id], done: true }, ctx)).updated[0].done, true);
  assert.equal((await runTool('reminders_show', {}, ctx)).reminders.length, 0);
  assert.equal((await runTool('list_show', { include_done: true }, ctx)).done_last_7_days.length, 1);
  assert.equal((await runTool('list_update', { ids: [t.id], done: false }, ctx)).updated[0].done, undefined);
  // Rename a list, delete one entry, delete a whole list.
  assert.equal((await runTool('list_rename', { from: 'טבעוני', to: 'סופר' }, ctx)).moved, 1);
  assert.deepEqual((await runTool('list_delete', { ids: [t.id] }, ctx)).deleted_ids, [t.id]);
  assert.equal((await runTool('list_delete', { list: 'פארם' }, ctx)).deleted, 1);
  assert.deepEqual((await db.entries()).map((e) => `${e.list}/${e.text}`), ['סופר/חלב שקדים']);
});

test('migration keeps only the open baby equipment list', async () => {
  const sql = await NodeSqliteAdapter.open(':memory:');
  await sql.init([
    `CREATE TABLE items (id INTEGER PRIMARY KEY, list TEXT NOT NULL, name TEXT NOT NULL, qty TEXT, note TEXT, added_by TEXT, created_at INTEGER NOT NULL, done_at INTEGER)`,
    `INSERT INTO items (list, name, created_at, done_at) VALUES ('ציוד לתינוק', 'אמבטיה', 1, NULL), ('ציוד לתינוק', 'עגלה', 1, 5), ('סופר', 'חלב', 1, NULL)`,
    `CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT)`,
  ]);
  const db = new HouseDB(sql);
  await db.init();
  await db.init(); // runs again on every cold start
  assert.deepEqual((await db.entries()).map((e) => `${e.list}/${e.text}`), ['ציוד לתינוק/אמבטיה']);
  assert.equal(await sql.get(`SELECT name FROM sqlite_master WHERE name IN ('items', 'tasks')`) ?? null, null);
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
  assert.equal(formatDigest({ entries: [], reminders: [] }, TZ, now), null);
  const text = formatDigest({
    entries: [{ text: 'לשלם ארנונה', fields: { due: '2026-10-16T12:00' } }, { text: 'חלב', fields: {} }],
    reminders: [{ text: 'חוג', next_at: localToUtc('2026-10-16T16:00', TZ) }],
  }, TZ, now);
  assert.match(text, /לשלם ארנונה/);
  assert.match(text, /16:00 חוג/);
  assert.match(text, /2 פריטים פתוחים/);
});

test('edit and delete reminders and places', async () => {
  const db = await newDb();
  const now = localToUtc('2026-10-16T10:00', TZ);
  const ctx = { db, tz: TZ, chatId: 7, user: 'יניב', now };
  // Reminders: change text and time, make it weekly, then one-time again.
  const r = (await runTool('reminder_add', { text: 'פח', at: '2026-10-16T20:00' }, ctx)).reminder;
  assert.equal((await runTool('reminder_update', { id: r.id, text: 'להוציא פח' }, ctx)).reminder.next, 'יום שישי 16.10 20:00');
  const w = (await runTool('reminder_update', { id: r.id, at: '2026-10-13T21:00', repeat: { freq: 'weekly' } }, ctx)).reminder;
  assert.deepEqual([w.text, w.next, w.repeat.freq], ['להוציא פח', 'יום שלישי 20.10 21:00', 'weekly']);
  const once = (await runTool('reminder_update', { id: r.id, at: '2026-10-18T08:00', repeat_off: true }, ctx)).reminder;
  assert.deepEqual([once.next, once.repeat], ['יום ראשון 18.10 08:00', undefined]);
  await assert.rejects(() => runTool('reminder_update', { id: r.id, at: '2026-10-15T08:00' }, ctx), /עבר/);
  // Places: rename keeps the coordinates, a duplicate name is refused, delete.
  const p = (await runTool('place_save', { name: 'קניון', use_last_location: true }, { ...ctx, lastLocation: { lat: 31.9, lon: 34.8 } })).place;
  await runTool('place_save', { name: 'דואר' }, ctx);
  const q = (await runTool('place_save', { id: p.id, name: 'קניון הזהב', kind: 'קניון' }, ctx)).place;
  assert.deepEqual([q.name, q.kind, q.lat], ['קניון הזהב', 'קניון', 31.9]);
  await assert.rejects(() => runTool('place_save', { id: p.id, name: 'דואר' }, ctx), /כבר יש/);
  assert.deepEqual((await runTool('place_delete', { ids: [p.id] }, ctx)).deleted_ids, [p.id]);
  assert.deepEqual((await runTool('places_show', {}, ctx)).places.map((x) => x.name), ['דואר']);
});

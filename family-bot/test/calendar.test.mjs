// Google Calendar against a fake Google token endpoint and a fake Calendar REST API (events in memory).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HouseDB } from '../src/db.mjs';
import { NodeSqliteAdapter } from '../src/node-sqlite.mjs';
import { runTool } from '../src/tools.mjs';
import { GoogleCalendar, pullCalendar, finishConnect, toRRule, fromRRule } from '../src/calendar.mjs';
import { FamilyBot } from '../src/bot.mjs';
import { loadConfig } from '../src/config.mjs';
import { localToUtc, localDateTime } from '../src/time.mjs';

const TZ = 'Asia/Jerusalem';
const NOW = localToUtc('2026-10-18T10:00', TZ);
const DAD = 11, GROUP = -1001;
const CAL = 'family@group.calendar.google.com';

// ---- fake Google Calendar. Deleted events stay as "cancelled" (like showDeleted). Every change bumps `updated`.
const events = new Map();
const calls = [];
let seq = 0;
const stamp = () => new Date(NOW + ++seq * 1000).toISOString();
const asUtc = (t) => (t.date ? t.date : new Date(localToUtc(t.dateTime.slice(0, 16), t.timeZone)).toISOString());
// A family member changes the event in the Google Calendar app.
const familyEdit = (id, change) => Object.assign(events.get(id), change, { updated: stamp() });
const at = (local) => ({ dateTime: `${local}:00`, timeZone: TZ });

function google(method, path, query, body) {
  const [, id] = path.match(/\/events(?:\/(.+))?$/) ?? [];
  const eid = id && decodeURIComponent(id);
  if (method === 'POST') {
    const ev = { ...body, id: `ev${++seq}`, status: 'confirmed', updated: stamp() };
    events.set(ev.id, ev);
    return [200, ev];
  }
  if (method === 'GET' && !eid) {
    let items = [...events.values()];
    if (query.get('updatedMin')) items = items.filter((e) => e.updated >= query.get('updatedMin'));
    else {
      items = items.filter((e) => e.status !== 'cancelled' && asUtc(e.start) < query.get('timeMax') && asUtc(e.end) > query.get('timeMin'));
      if (query.get('q')) items = items.filter((e) => `${e.summary} ${e.location ?? ''}`.includes(query.get('q')));
    }
    return [200, { items }];
  }
  const ev = events.get(eid);
  if (!ev) return [404, { error: { message: 'Not Found' } }];
  if (method === 'GET') return [200, ev];
  if (ev.status === 'cancelled') return [410, { error: { message: 'Resource has been deleted' } }];
  if (method === 'PUT') {
    events.set(eid, { ...body, id: eid, status: 'confirmed', updated: stamp() });
    return [200, events.get(eid)];
  }
  if (method === 'DELETE') {
    Object.assign(ev, { status: 'cancelled', updated: stamp() });
    return [204, null];
  }
}

let srv, db, cal;
before(async () => {
  srv = await new Promise((r) => {
    const s = createServer(async (req, res) => {
      let b = '';
      for await (const c of req) b += c;
      const url = new URL(req.url, 'http://x');
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/token') {
        const p = new URLSearchParams(b);
        if (p.get('grant_type') === 'authorization_code') {
          return res.end(JSON.stringify(p.get('code') === 'good' && p.get('redirect_uri') === 'https://bot.example.dev/google/callback' ? { refresh_token: 'rt-1', access_token: 'at-1' } : { error: 'invalid_grant' }));
        }
        return res.end(JSON.stringify(p.get('refresh_token') === 'rt-1' ? { access_token: 'at-1', expires_in: 3600 } : { error: 'invalid_grant' }));
      }
      assert.equal(req.headers.authorization, 'Bearer at-1');
      assert.ok(url.pathname.startsWith(`/calendar/v3/calendars/${encodeURIComponent(CAL)}/events`));
      if (req.method !== 'GET') assert.equal(url.searchParams.get('sendUpdates'), 'none', 'never email guests');
      calls.push({ method: req.method, path: url.pathname, query: url.searchParams, body: b ? JSON.parse(b) : null });
      const [status, out] = google(req.method, url.pathname, url.searchParams, b ? JSON.parse(b) : null);
      res.statusCode = status;
      res.end(out ? JSON.stringify(out) : undefined);
    });
    s.listen(0, '127.0.0.1', () => r({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
  db = new HouseDB(await NodeSqliteAdapter.open(':memory:'));
  await db.init();
  cal = new GoogleCalendar({ clientId: 'cid', clientSecret: 'cs', calendarId: CAL, tz: TZ, db, apiBase: `${srv.url}/calendar/v3`, tokenUrl: `${srv.url}/token` });
});
after(() => srv.s.close());

const ctx = () => ({ db, tz: TZ, chatId: GROUP, user: 'יניב', now: NOW, calendar: cal });
const run = (name, input) => runTool(name, input, ctx());
const pull = () => pullCalendar(db, cal, NOW);
const local = (ms) => localDateTime(new Date(ms), TZ);
const writes = (from) => calls.slice(from).filter((c) => c.method !== 'GET');

test('RRULE both ways', () => {
  assert.deepEqual(toRRule({ freq: 'weekly', interval: 2, days: [0, 3] }), ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,WE']);
  assert.deepEqual(fromRRule(['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,WE']), { freq: 'weekly', interval: 2, days: [0, 3] });
  assert.deepEqual(fromRRule(['RRULE:FREQ=MONTHLY;BYMONTHDAY=10;COUNT=5']), { freq: 'monthly' });
  assert.equal(fromRRule(['RRULE:FREQ=HOURLY']), null);
  assert.equal(fromRRule(undefined), null);
});

test('before connecting: the tools say how to connect; /calendar gives a sign-in link only in private', async () => {
  await assert.rejects(run('calendar_show', { from: '2026-10-18' }), /\/calendar/);
  const sent = [];
  const telegram = { getMe: async () => ({ id: 500, username: 'home_helper_bot' }), send: async (chatId, text) => sent.push({ chatId, text }), typing: async () => {} };
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: '500:x', ANTHROPIC_API_KEY: 'k', ALLOWED_CHAT_IDS: String(GROUP), ALLOWED_USER_IDS: String(DAD),
    GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_URL: 'https://bot.example.dev',
  });
  const bot = new FamilyBot({ config, db, telegram, claude: {}, log: {} });
  await bot.handle({ update_id: 1, message: { message_id: 1, chat: { id: GROUP, type: 'supergroup' }, from: { id: DAD, first_name: 'יניב' }, text: '/calendar' } });
  assert.doesNotMatch(sent.at(-1).text, /accounts\.google\.com/, 'no sign-in link in the group');
  await bot.handle({ update_id: 2, message: { message_id: 2, chat: { id: DAD, type: 'private' }, from: { id: DAD, first_name: 'יניב' }, text: '/calendar' } });
  const link = new URL(sent.at(-1).text.match(/https:\/\/accounts\.google\.com\S+/)[0]);
  assert.equal(link.searchParams.get('access_type'), 'offline');
  assert.equal(link.searchParams.get('prompt'), 'consent');
  assert.equal(link.searchParams.get('redirect_uri'), 'https://bot.example.dev/google/callback');
  assert.equal(link.searchParams.get('scope'), 'https://www.googleapis.com/auth/calendar.events');

  const g = { clientId: 'cid', clientSecret: 'cs', publicUrl: 'https://bot.example.dev', tokenUrl: `${srv.url}/token` };
  await assert.rejects(finishConnect(db, g, { code: 'good', state: 'wrong' }, NOW), /לא תקף/);
  const state = link.searchParams.get('state');
  assert.equal(await finishConnect(db, g, { code: 'good', state }, NOW), DAD, 'tells the chat that asked');
  await assert.rejects(finishConnect(db, g, { code: 'good', state }, NOW), /לא תקף/, 'the link works once');
});

test('any event: add, show, update (one field, length kept, repeat), delete', async () => {
  const { added } = await run('calendar_add', { title: 'יום הולדת לסבתא', start: '2026-10-24T19:00', location: 'רחובות' });
  assert.deepEqual([added.start, added.end, added.location], ['2026-10-24T19:00', '2026-10-24T20:00', 'רחובות'], 'one hour by default');
  const trip = (await run('calendar_add', { title: 'טיול לגליל', start: '2026-10-28', end: '2026-10-30' })).added;
  assert.deepEqual([trip.all_day, trip.start, trip.end], [true, '2026-10-28', '2026-10-30']);
  assert.equal(events.get(trip.id).end.date, '2026-10-31', 'Google all-day ends are the next day');
  await assert.rejects(run('calendar_add', { title: 'x', start: '2026-10-24T19:00', end: '2026-10-24T18:00' }), /אחרי/);

  // Move: start alone keeps the length; title alone changes nothing else.
  const moved = (await run('calendar_update', { event_id: added.id, start: '2026-10-25T18:30' })).updated;
  assert.deepEqual([moved.start, moved.end, moved.location], ['2026-10-25T18:30', '2026-10-25T19:30', 'רחובות']);
  const tripMoved = (await run('calendar_update', { event_id: trip.id, start: '2026-11-04' })).updated;
  assert.deepEqual([tripMoved.start, tripMoved.end], ['2026-11-04', '2026-11-06']);
  const renamed = (await run('calendar_update', { event_id: added.id, title: 'יום הולדת 80 לסבתא', location: '' })).updated;
  assert.deepEqual([renamed.title, renamed.start, renamed.location], ['יום הולדת 80 לסבתא', '2026-10-25T18:30', undefined]);
  const weekly = (await run('calendar_update', { event_id: added.id, repeat: { freq: 'weekly' } })).updated;
  assert.deepEqual(weekly.repeat, { freq: 'weekly' });
  assert.equal((await run('calendar_update', { event_id: added.id, repeat_off: true })).updated.repeat, undefined);

  const found = (await run('calendar_show', { from: '2026-10-18', to: '2026-11-10', q: 'סבתא' })).events;
  assert.deepEqual(found.map((e) => e.title), ['יום הולדת 80 לסבתא']);

  const del = await run('calendar_delete', { event_ids: [trip.id, 'nope'] });
  assert.deepEqual(del.deleted, [{ id: trip.id, title: 'טיול לגליל' }]);
  assert.match(del.failed[0].error, /אין ביומן/);
  assert.equal((await run('calendar_show', { from: '2026-11-01', to: '2026-11-10' })).events.length, 0);
  await assert.rejects(run('calendar_update', { event_id: trip.id, title: 'x' }), /אין ביומן/);
});

let weekly, task;

test('bot -> calendar: a reminder and a dated entry get events; edits follow', async () => {
  weekly = (await run('reminder_add', { text: 'חוג שחייה', at: '2026-10-20T17:00', repeat: { freq: 'weekly' } })).reminder;
  [task] = (await run('list_add', { entries: [{ list: 'משימות', text: 'לשלם ארנונה', fields: { due: '2026-10-22', assignee: 'מיכל' } }] })).added;
  const [nodue] = (await run('list_add', { entries: [{ list: 'משימות', text: 'לתקן ברז' }] })).added;
  const n = calls.length;
  const r = await run('calendar_sync', { reminder_ids: [weekly.id], entry_ids: [task.id, nodue.id] });
  assert.deepEqual(r.in_calendar, [`reminder ${weekly.id}`, `entry ${task.id}`]);
  assert.match(r.failed[0].error, /אין מועד/);

  const [rem, ent] = writes(n).map((c) => c.body);
  assert.deepEqual(rem, {
    summary: 'חוג שחייה', description: 'תזכורת מעוזר הבית', start: at('2026-10-20T17:00'), end: at('2026-10-20T17:15'), recurrence: ['RRULE:FREQ=WEEKLY'],
  });
  assert.deepEqual([ent.start, ent.end], [{ date: '2026-10-22' }, { date: '2026-10-23' }]);
  assert.match(ent.description, /משימות: לשלם ארנונה \(מיכל\)/);
  assert.equal((await run('reminders_show', {})).reminders[0].calendar, true);

  // The same event changes, also its repeat. What the family added to it stays.
  const evId = (await db.calendarLink('reminder', weekly.id)).event_id;
  familyEdit(evId, { location: 'בריכה עירונית' });
  await run('reminder_update', { id: weekly.id, text: 'חוג שחייה לנועה', repeat: { freq: 'weekly', days: [2, 4] } });
  assert.equal((await db.calendarLink('reminder', weekly.id)).event_id, evId);
  assert.deepEqual([events.get(evId).summary, events.get(evId).recurrence, events.get(evId).location], ['חוג שחייה לנועה', ['RRULE:FREQ=WEEKLY;BYDAY=TU,TH'], 'בריכה עירונית']);

  // Done in the bot -> ✅ in the calendar. The bot's own writes are not changes to pull back.
  await run('list_update', { ids: [task.id], done: true });
  assert.equal(events.get((await db.calendarLink('entry', task.id)).event_id).summary, '✅ לשלם ארנונה');
  await pull(); // the location edit above is a calendar change; the bot items already match it
  assert.equal((await pull()).applied, 0);
});

test('calendar -> bot: moved, renamed, ✅ removed, deleted', async () => {
  const rEv = (await db.calendarLink('reminder', weekly.id)).event_id;
  const tEv = (await db.calendarLink('entry', task.id)).event_id;
  familyEdit(rEv, { summary: 'שחייה', start: at('2026-10-21T18:30'), end: at('2026-10-21T19:30'), recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE'] });
  familyEdit(tEv, { summary: 'לשלם ארנונה ומים', start: at('2026-10-25T12:00'), end: at('2026-10-25T12:30') });
  assert.deepEqual(await pull(), { applied: 2, errors: [] });
  const r = await db.reminder(weekly.id);
  assert.deepEqual([r.text, r.start_local, r.rule, local(r.next_at)], ['שחייה', '2026-10-21T18:30', { freq: 'weekly', days: [3] }, '2026-10-21T18:30']);
  const e = await db.entry(task.id);
  assert.deepEqual([e.text, e.fields.due, e.done_at, e.done_by], ['לשלם ארנונה ומים', '2026-10-25T12:00', null, null], '✅ gone from the title: open again');
  assert.equal((await pull()).applied, 0, 'each change is applied once');

  familyEdit(rEv, { status: 'cancelled' });
  await pull();
  assert.equal((await db.reminder(weekly.id)).active, 0, 'deleted in the calendar: the reminder stops');
  assert.equal(await db.calendarLink('reminder', weekly.id), null);
});

test('reminders that follow a family event; editing or deleting the event with the tools moves or stops them', async () => {
  const dentist = (await run('calendar_add', { title: 'רופא שיניים - נועה', start: '2026-10-23T16:00', end: '2026-10-23T16:30' })).added;
  const hourBefore = (await run('calendar_import', { event_id: dentist.id, minutes_before: 60 })).imported;
  const dayBefore = (await run('calendar_import', { event_id: dentist.id, minutes_before: 1440 })).imported;
  assert.equal(local((await db.reminder(hourBefore.id)).next_at), '2026-10-23T15:00');
  assert.equal(local((await db.reminder(dayBefore.id)).next_at), '2026-10-22T16:00');
  assert.deepEqual((await run('calendar_show', { from: '2026-10-23' })).events.find((x) => x.id === dentist.id).linked, [`reminder ${hourBefore.id}`, `reminder ${dayBefore.id}`]);

  await run('calendar_update', { event_id: dentist.id, start: '2026-10-24T09:00' });
  assert.equal(local((await db.reminder(hourBefore.id)).next_at), '2026-10-24T08:00', 'the event moved, so did the reminders, at once');
  assert.equal(local((await db.reminder(dayBefore.id)).next_at), '2026-10-23T09:00');

  // Cancelling one reminder leaves the family event alone.
  const n = calls.length;
  await run('reminder_cancel', { ids: [dayBefore.id] });
  assert.equal(writes(n).length, 0);
  await run('calendar_delete', { event_ids: [dentist.id] });
  assert.equal((await db.reminder(hourBefore.id)).active, 0, 'event deleted: its reminder stops');
  assert.deepEqual(await db.calendarLinks('reminder'), []);
});

test('cancel in the bot deletes the bot\'s own event; calendar errors do not undo the bot change', async () => {
  const r = (await run('reminder_add', { text: 'להוציא פח', at: '2026-10-19T20:00' })).reminder;
  await run('calendar_sync', { reminder_ids: [r.id] });
  const evId = (await db.calendarLink('reminder', r.id)).event_id;
  await run('reminder_cancel', { ids: [r.id] });
  assert.equal(events.get(evId).status, 'cancelled');

  const r2 = (await run('reminder_add', { text: 'לקנות מתנה', at: '2026-10-19T20:00' })).reminder;
  await run('calendar_sync', { reminder_ids: [r2.id] });
  await db.set('google:oauth', { refresh_token: 'revoked' });
  const out = await run('reminder_update', { id: r2.id, text: 'לקנות מתנה לסבתא' });
  assert.equal(out.reminder.text, 'לקנות מתנה לסבתא');
  assert.match(out.calendar_error, /\/calendar/);
  await db.set('google:oauth', { refresh_token: 'rt-1' });
});

test('the scheduler pulls calendar changes before it sends reminders', async () => {
  const r = (await run('reminder_add', { text: 'אסיפת הורים', at: '2026-10-18T19:00' })).reminder;
  await run('calendar_sync', { reminder_ids: [r.id] });
  familyEdit((await db.calendarLink('reminder', r.id)).event_id, { start: at('2026-10-18T21:00'), end: at('2026-10-18T21:15') });
  const sent = [];
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '500:x', ANTHROPIC_API_KEY: 'k', ALLOWED_CHAT_IDS: String(GROUP), DIGEST_TIME: '' });
  const bot = new FamilyBot({ config, db, telegram: { send: async (c, text) => sent.push(text) }, claude: {}, calendar: cal, log: {} });
  await bot.tick(localToUtc('2026-10-18T19:00', TZ));
  assert.deepEqual(sent.filter((t) => /אסיפת/.test(t)), [], 'moved to 21:00 in the calendar: not sent at 19:00');
  await bot.tick(localToUtc('2026-10-18T21:00', TZ));
  assert.deepEqual(sent.filter((t) => /אסיפת/.test(t)), ['⏰ תזכורת: אסיפת הורים']);
});

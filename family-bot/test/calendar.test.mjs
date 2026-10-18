// Google Calendar sync against a fake Google token endpoint and a fake Calendar MCP server (JSON-RPC tools/call).
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

// ---- fake Google: events in memory; every change bumps `updated`
const events = new Map();
const mcpCalls = [];
let seq = 0;
const stamp = () => new Date(Date.UTC(2026, 9, 18) + ++seq * 1000).toISOString();
const toTime = (local, allDay) => (allDay ? { date: `${local.slice(0, 10)}T00:00:00Z` } : { dateTime: new Date(localToUtc(local.slice(0, 16), TZ)).toISOString(), timeZone: TZ });
// What a family member does in the Google Calendar app.
const familyEdit = (id, change) => Object.assign(events.get(id), change, { updated: stamp() });

const TOOLS = {
  create_event(a) {
    const id = `ev${++seq}`;
    events.set(id, { id, status: 'confirmed', summary: a.summary, description: a.description, start: toTime(a.startTime, a.allDay), end: toTime(a.endTime, a.allDay), recurrence: a.recurrenceData, updated: stamp() });
    return events.get(id);
  },
  update_event(a) {
    const ev = events.get(a.eventId);
    if (!ev) throw new Error('Event not found (404)');
    for (const k of ['summary', 'description']) if (a[k] !== undefined) ev[k] = a[k];
    if (a.startTime) Object.assign(ev, { start: toTime(a.startTime, a.allDay), end: toTime(a.endTime, a.allDay) });
    ev.updated = stamp();
    return ev;
  },
  get_event(a) {
    if (!events.has(a.eventId)) throw new Error('Requested entity was not found (404)');
    return events.get(a.eventId);
  },
  delete_event(a) {
    if (!events.delete(a.eventId)) throw new Error('Resource has been deleted (410)');
    return {};
  },
  list_events: () => ({ events: [...events.values()] }),
};

let srv, db, cal;
before(async () => {
  srv = await new Promise((r) => {
    const s = createServer(async (req, res) => {
      let b = '';
      for await (const c of req) b += c;
      if (req.url === '/token') {
        const p = new URLSearchParams(b);
        res.setHeader('content-type', 'application/json');
        if (p.get('grant_type') === 'authorization_code') {
          return res.end(JSON.stringify(p.get('code') === 'good' && p.get('redirect_uri') === 'https://bot.example.dev/google/callback' ? { refresh_token: 'rt-1', access_token: 'at-1' } : { error: 'invalid_grant' }));
        }
        return res.end(JSON.stringify(p.get('refresh_token') === 'rt-1' ? { access_token: 'at-1', expires_in: 3600 } : { error: 'invalid_grant' }));
      }
      assert.equal(req.headers.authorization, 'Bearer at-1');
      const rpc = JSON.parse(b);
      assert.equal(rpc.method, 'tools/call');
      mcpCalls.push(rpc.params);
      let result;
      try {
        const out = TOOLS[rpc.params.name](rpc.params.arguments);
        // Some answers carry only text content (no structuredContent), like a plain MCP server.
        result = { content: [{ type: 'text', text: JSON.stringify(out) }], ...(rpc.params.name === 'get_event' ? {} : { structuredContent: out }) };
      } catch (err) {
        result = { isError: true, content: [{ type: 'text', text: err.message }] };
      }
      const msg = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result });
      // list_events answers as an SSE stream (Streamable HTTP), the rest as JSON.
      if (rpc.params.name === 'list_events') {
        res.setHeader('content-type', 'text/event-stream');
        return res.end(`event: message\ndata: ${msg}\n\n`);
      }
      res.setHeader('content-type', 'application/json');
      res.end(msg);
    });
    s.listen(0, '127.0.0.1', () => r({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
  db = new HouseDB(await NodeSqliteAdapter.open(':memory:'));
  await db.init();
  cal = new GoogleCalendar({ clientId: 'cid', clientSecret: 'cs', calendarId: 'family@group.calendar.google.com', tz: TZ, db, mcpUrl: `${srv.url}/mcp`, tokenUrl: `${srv.url}/token` });
});
after(() => srv.s.close());

const ctx = () => ({ db, tz: TZ, chatId: GROUP, user: 'יניב', now: NOW, calendar: cal });
const run = (name, input) => runTool(name, input, ctx());
const pull = () => pullCalendar(db, cal, NOW);
const local = (ms) => localDateTime(new Date(ms), TZ);

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
  assert.match(link.searchParams.get('scope'), /auth\/calendar\.events( |$)/);

  const google = { clientId: 'cid', clientSecret: 'cs', publicUrl: 'https://bot.example.dev', tokenUrl: `${srv.url}/token` };
  await assert.rejects(finishConnect(db, google, { code: 'good', state: 'wrong' }, NOW), /לא תקף/);
  const state = link.searchParams.get('state');
  assert.equal(await finishConnect(db, google, { code: 'good', state }, NOW), DAD, 'tells the chat that asked');
  await assert.rejects(finishConnect(db, google, { code: 'good', state }, NOW), /לא תקף/, 'the link works once');
});

let weekly, task;

test('bot -> calendar: a reminder and a dated entry get events; edits follow', async () => {
  weekly = (await run('reminder_add', { text: 'חוג שחייה', at: '2026-10-20T17:00', repeat: { freq: 'weekly' } })).reminder;
  [task] = (await run('list_add', { entries: [{ list: 'משימות', text: 'לשלם ארנונה', fields: { due: '2026-10-22', assignee: 'מיכל' } }] })).added;
  const [nodue] = (await run('list_add', { entries: [{ list: 'משימות', text: 'לתקן ברז' }] })).added;
  const r = await run('calendar_sync', { reminder_ids: [weekly.id], entry_ids: [task.id, nodue.id] });
  assert.deepEqual(r.in_calendar, [`reminder ${weekly.id}`, `entry ${task.id}`]);
  assert.match(r.failed[0].error, /אין מועד/);

  const create = mcpCalls.filter((c) => c.name === 'create_event');
  assert.deepEqual(create[0].arguments, {
    calendarId: 'family@group.calendar.google.com', notificationLevel: 'NONE', summary: 'חוג שחייה', description: 'תזכורת מעוזר הבית',
    startTime: '2026-10-20T17:00:00', endTime: '2026-10-20T17:15:00', allDay: false, timeZone: TZ, recurrenceData: ['RRULE:FREQ=WEEKLY'],
  });
  assert.equal(create[1].arguments.allDay, true);
  assert.equal(create[1].arguments.startTime, '2026-10-22T00:00:00');
  assert.match(create[1].arguments.description, /משימות: לשלם ארנונה \(מיכל\)/);
  assert.equal((await run('reminders_show', {})).reminders[0].calendar, true);

  // The same event is updated; a change of repeat makes a new one (update_event cannot change it).
  const evId = (await db.calendarLink('reminder', weekly.id)).event_id;
  await run('reminder_update', { id: weekly.id, text: 'חוג שחייה לנועה' });
  assert.equal(events.get(evId).summary, 'חוג שחייה לנועה');
  await run('reminder_update', { id: weekly.id, repeat: { freq: 'weekly', days: [2, 4] } });
  const newId = (await db.calendarLink('reminder', weekly.id)).event_id;
  assert.notEqual(newId, evId);
  assert.equal(events.has(evId), false);
  assert.deepEqual(events.get(newId).recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=TU,TH']);

  // Done in the bot -> ✅ in the calendar. The bot's own writes are not changes to pull back.
  await run('list_update', { ids: [task.id], done: true });
  assert.equal(events.get((await db.calendarLink('entry', task.id)).event_id).summary, '✅ לשלם ארנונה');
  assert.equal((await pull()).applied, 0);
});

test('calendar -> bot: moved, renamed, ✅ removed, deleted', async () => {
  const rEv = (await db.calendarLink('reminder', weekly.id)).event_id;
  const tEv = (await db.calendarLink('entry', task.id)).event_id;
  familyEdit(rEv, { summary: 'שחייה', start: toTime('2026-10-21T18:30'), recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE'] });
  familyEdit(tEv, { summary: 'לשלם ארנונה ומים', start: toTime('2026-10-25T12:00') });
  assert.deepEqual(await pull(), { applied: 2, errors: [] });
  const r = await db.reminder(weekly.id);
  assert.deepEqual([r.text, r.start_local, r.rule, local(r.next_at)], ['שחייה', '2026-10-21T18:30', { freq: 'weekly', days: [3] }, '2026-10-21T18:30']);
  const e = await db.entry(task.id);
  assert.deepEqual([e.text, e.fields.due, e.done_at, e.done_by], ['לשלם ארנונה ומים', '2026-10-25T12:00', null, null], '✅ gone from the title: open again');
  assert.equal((await pull()).applied, 0, 'each change is applied once');

  events.delete(rEv);
  await pull();
  assert.equal((await db.reminder(weekly.id)).active, 0, 'deleted in the calendar: the reminder stops');
  assert.equal(await db.calendarLink('reminder', weekly.id), null);
});

test('calendar event -> reminders that follow it; the bot never changes the family event', async () => {
  const dentist = TOOLS.create_event({ summary: 'רופא שיניים - נועה', startTime: '2026-10-23T16:00:00', endTime: '2026-10-23T16:30:00' });
  const shown = await run('calendar_show', { from: '2026-10-18', to: '2026-10-24' });
  assert.ok(shown.events.some((x) => x.id === dentist.id && x.start === '2026-10-23T16:00'));

  const hourBefore = (await run('calendar_import', { event_id: dentist.id, minutes_before: 60 })).imported;
  const dayBefore = (await run('calendar_import', { event_id: dentist.id, minutes_before: 1440 })).imported;
  assert.equal(local((await db.reminder(hourBefore.id)).next_at), '2026-10-23T15:00');
  assert.equal(local((await db.reminder(dayBefore.id)).next_at), '2026-10-22T16:00');
  assert.deepEqual((await run('calendar_show', { from: '2026-10-23' })).events.find((x) => x.id === dentist.id).linked, [`reminder ${hourBefore.id}`, `reminder ${dayBefore.id}`]);

  familyEdit(dentist.id, { start: toTime('2026-10-24T09:00') });
  await pull();
  assert.equal(local((await db.reminder(hourBefore.id)).next_at), '2026-10-24T08:00', 'the event moved, so did the reminders');
  assert.equal(local((await db.reminder(dayBefore.id)).next_at), '2026-10-23T09:00');

  const writes = mcpCalls.length;
  await run('reminder_update', { id: hourBefore.id, text: 'לצאת לרופא שיניים' });
  await run('reminder_cancel', { ids: [hourBefore.id, dayBefore.id] });
  assert.equal(mcpCalls.slice(writes).filter((c) => c.name !== 'get_event').length, 0, 'no write to the family event');
  assert.ok(events.has(dentist.id));
  assert.deepEqual(await db.calendarLinks('reminder'), []);
});

test('cancel in the bot deletes the bot\'s own event; calendar errors do not undo the bot change', async () => {
  const r = (await run('reminder_add', { text: 'להוציא פח', at: '2026-10-19T20:00' })).reminder;
  await run('calendar_sync', { reminder_ids: [r.id] });
  const evId = (await db.calendarLink('reminder', r.id)).event_id;
  await run('reminder_cancel', { ids: [r.id] });
  assert.equal(events.has(evId), false);

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
  familyEdit((await db.calendarLink('reminder', r.id)).event_id, { start: toTime('2026-10-18T21:00') });
  const sent = [];
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '500:x', ANTHROPIC_API_KEY: 'k', ALLOWED_CHAT_IDS: String(GROUP), DIGEST_TIME: '' });
  const bot = new FamilyBot({ config, db, telegram: { send: async (c, text) => sent.push(text) }, claude: {}, calendar: cal, log: {} });
  await bot.tick(localToUtc('2026-10-18T19:00', TZ));
  assert.deepEqual(sent.filter((t) => /אסיפת/.test(t)), [], 'moved to 21:00 in the calendar: not sent at 19:00');
  await bot.tick(localToUtc('2026-10-18T21:00', TZ));
  assert.deepEqual(sent.filter((t) => /אסיפת/.test(t)), ['⏰ תזכורת: אסיפת הורים']);
});

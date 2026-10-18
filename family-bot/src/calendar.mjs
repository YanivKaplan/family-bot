// Google Calendar (REST API v3) with the family account's OAuth token. Built-in fetch only.
// Connecting: a family member sends /calendar, signs in to Google with the link, and /google/callback (worker.mjs)
// keeps the refresh token in kv.
// - Any event: show, add, update, delete (calendar_* tools).
// - Sync on request:
//   - calendar_sync: a bot reminder or a dated list entry gets an event that the bot owns. Changes in the bot update the
//     event; changes in the calendar (title, time, repeat, "✅" at the start of the title = done, delete) come back on the
//     next tick (pullCalendar).
//   - calendar_import: an existing family event gets a bot reminder (or entry) that follows it. Cancelling that reminder
//     does not delete the event.
// Links are in the calendar_links table. `updated` is the event's last change that the bot already knows (its own write
// or an applied change), so the bot's own writes do not come back as changes.
import { localDateTime, localToUtc, nextOccurrence, parseLocal } from './time.mjs';
import { formatEntry } from './format.mjs';

const API_BASE = 'https://www.googleapis.com/calendar/v3';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const OAUTH_KEY = 'google:oauth';
const STATE_KEY = 'google:state';
const DONE = '✅';
const BY = 'יומן';
const tokens = new Map(); // per isolate / process: refresh token -> { token, exp }
const NOT_CONNECTED = 'יומן גוגל עוד לא מחובר. שלחו לבוט /calendar כדי לחבר אותו.';
const gone = (err) => [404, 410].includes(err.status);

export class GoogleCalendar {
  constructor({ clientId, clientSecret, calendarId = 'primary', tz, db, apiBase = API_BASE, tokenUrl = TOKEN_URL, fetchImpl = (...a) => fetch(...a) }) {
    Object.assign(this, { clientId, clientSecret, tz, db, tokenUrl, fetch: fetchImpl });
    this.base = `${apiBase}/calendars/${encodeURIComponent(calendarId)}/events`;
  }

  // Access token from the stored refresh token, kept until a minute before it expires.
  async token() {
    const auth = await this.db.get(OAUTH_KEY);
    if (!auth?.refresh_token) throw new Error(NOT_CONNECTED);
    const cached = tokens.get(auth.refresh_token);
    if (cached && cached.exp > Date.now() + 60_000) return cached.token;
    const res = await this.fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refresh_token, client_id: this.clientId, client_secret: this.clientSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({}));
    if (json.error === 'invalid_grant') throw new Error('החיבור ליומן גוגל בוטל או פג. שלחו /calendar כדי לחבר מחדש.');
    if (!json.access_token) throw new Error(`Google token: ${json.error_description ?? json.error ?? res.status}`);
    tokens.set(auth.refresh_token, { token: json.access_token, exp: Date.now() + (json.expires_in ?? 3600) * 1000 });
    return json.access_token;
  }

  async call(method, path = '', { query, body } = {}) {
    const res = await this.fetch(`${this.base}${path}${query ? `?${new URLSearchParams(query)}` : ''}`, {
      method,
      headers: { authorization: `Bearer ${await this.token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 204) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`Google Calendar ${res.status}: ${json.error?.message ?? ''}`.trim()), { status: res.status });
    return json;
  }

  // null when there is no such event. A deleted event can come back with status "cancelled".
  get(id) { return this.call('GET', `/${encodeURIComponent(id)}`).catch((e) => (gone(e) ? null : Promise.reject(e))); }
  // Writes never email guests (sendUpdates=none).
  insert(ev) { return this.call('POST', '', { query: { sendUpdates: 'none' }, body: ev }); }
  update(id, ev) { return this.call('PUT', `/${encodeURIComponent(id)}`, { query: { sendUpdates: 'none' }, body: ev }); }
  remove(id) { return this.call('DELETE', `/${encodeURIComponent(id)}`, { query: { sendUpdates: 'none' } }).catch((e) => (gone(e) ? null : Promise.reject(e))); }

  // Events between two local dates (both included), each repeat as its own instance. q = free text.
  async between(from, to, q) {
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
    if (![from, to].every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) || !(days >= 1 && days <= 62)) throw new Error('טווח תאריכים: from עד to בפורמט YYYY-MM-DD, עד 62 יום');
    const r = await this.call('GET', '', {
      query: {
        timeMin: new Date(localToUtc(`${from}T00:00`, this.tz)).toISOString(), timeMax: new Date(localToUtc(`${nextDay(to)}T00:00`, this.tz)).toISOString(),
        singleEvents: 'true', orderBy: 'startTime', maxResults: '100', ...(q ? { q } : {}),
      },
    });
    return r.items ?? [];
  }

  // Every event changed or deleted since `sinceMs` (a repeating event as one series).
  async changedSince(sinceMs) {
    const out = [];
    let pageToken;
    for (let page = 0; page < 5; page++) {
      const r = await this.call('GET', '', {
        query: { updatedMin: new Date(sinceMs).toISOString(), showDeleted: 'true', maxResults: '250', ...(pageToken ? { pageToken } : {}) },
      });
      out.push(...(r.items ?? []));
      if (!(pageToken = r.nextPageToken)) break;
    }
    return out;
  }
}

// ---- connecting the family Google account (OAuth, once)

// A sign-in link for /calendar. The state is random, used once, and valid for 15 minutes.
export async function connectLink(db, { clientId, publicUrl }, chatId, now = Date.now()) {
  const state = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await db.set(STATE_KEY, { state, chat_id: chatId, exp: now + 15 * 60_000 });
  return `${AUTH_URL}?${new URLSearchParams({
    client_id: clientId, redirect_uri: `${publicUrl}/google/callback`, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state,
  })}`;
}

// Google sends the browser back here. Returns the chat to tell, or throws.
export async function finishConnect(db, { clientId, clientSecret, publicUrl, tokenUrl = TOKEN_URL, fetchImpl = (...a) => fetch(...a) }, { code, state }, now = Date.now()) {
  const pending = await db.get(STATE_KEY);
  if (!pending || !state || pending.state !== state || pending.exp < now) throw new Error('הקישור לא תקף. שלחו /calendar שוב.');
  await db.set(STATE_KEY, null);
  const res = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: String(code ?? ''), client_id: clientId, client_secret: clientSecret, redirect_uri: `${publicUrl}/google/callback` }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.refresh_token) throw new Error(`Google לא החזיר הרשאה קבועה (${json.error_description ?? json.error ?? res.status})`);
  await db.set(OAUTH_KEY, { refresh_token: json.refresh_token, scope: json.scope ?? null, at: now });
  return pending.chat_id;
}

export const isConnected = async (db) => Boolean((await db.get(OAUTH_KEY))?.refresh_token);

// ---- times and repeats

const nextDay = (date, n = 1) => new Date(Date.parse(date) + n * 86_400_000).toISOString().slice(0, 10);

// An event time as local "YYYY-MM-DD" (all day) or "YYYY-MM-DDTHH:MM". A dateTime without an offset is in its timeZone.
export function eventTime(t, tz) {
  if (t?.date) return t.date.slice(0, 10);
  const ms = /(Z|[+-]\d\d:\d\d)$/i.test(t.dateTime) ? Date.parse(t.dateTime) : localToUtc(t.dateTime.slice(0, 16), t.timeZone ?? tz);
  return localDateTime(new Date(ms), tz);
}

const shift = (local, min, tz) => localDateTime(new Date(localToUtc(local, tz) + min * 60_000), tz);

// Local start (and end) -> the event's start/end. All-day ends are inclusive here (Google's are the next day).
function span(start, end, tz, minutes = 60) {
  const s = String(start).replace(' ', 'T');
  const allDay = !parseLocal(s).hasTime;
  const e = end == null ? null : String(end).replace(' ', 'T');
  if (e && parseLocal(e).hasTime === allDay) throw new Error('start ו-end צריכים להיות שניהם תאריך, או שניהם תאריך ושעה');
  if (allDay) {
    if (e && e < s) throw new Error('end לפני start');
    return { start: { date: s }, end: { date: nextDay(e ?? s) } };
  }
  const to = e ?? shift(s, minutes, tz);
  if (localToUtc(to, tz) <= localToUtc(s, tz)) throw new Error('end צריך להיות אחרי start');
  return { start: { dateTime: `${s}:00`, timeZone: tz }, end: { dateTime: `${to}:00`, timeZone: tz } };
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function toRRule(rule) {
  if (!rule) return undefined;
  const parts = [`FREQ=${rule.freq.toUpperCase()}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.freq === 'weekly' && rule.days?.length) parts.push(`BYDAY=${rule.days.map((d) => DAYS[d]).join(',')}`);
  return [`RRULE:${parts.join(';')}`];
}

// The part of an RRULE the bot's reminders know: FREQ, INTERVAL, and plain BYDAY for weekly. Anything else repeats as FREQ.
export function fromRRule(recurrence) {
  const line = recurrence?.find((l) => l.startsWith('RRULE:'));
  if (!line) return null;
  const p = Object.fromEntries(line.slice(6).split(';').map((x) => x.split('=')));
  const freq = p.FREQ?.toLowerCase();
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(freq)) return null;
  const rule = { freq };
  if (Number(p.INTERVAL) > 1) rule.interval = Number(p.INTERVAL);
  const days = (p.BYDAY ?? '').split(',').map((d) => DAYS.indexOf(d)).filter((d) => d >= 0);
  if (freq === 'weekly' && days.length) rule.days = days;
  return rule;
}

// When a reminder at local `at` (repeating by `rule`) fires next; null when a one-time one has passed.
function nextRun(at, rule, now, tz) {
  const first = localToUtc(at, tz);
  if (!rule) return first > now ? first : null;
  return nextOccurrence(rule, at, Math.max(first - 60_000, now), tz);
}

// What Claude sees for one event. id = this event (one instance of a repeat); series_id = the whole repeating event.
export function eventView(e, tz, links = []) {
  const series = e.recurringEventId ?? e.id;
  const linked = links.filter((l) => l.event_id === series).map((l) => `${l.kind} ${l.item_id}`);
  const allDay = Boolean(e.start?.date);
  return {
    id: e.id, ...(e.recurringEventId ? { series_id: e.recurringEventId } : {}), title: e.summary ?? '',
    start: eventTime(e.start, tz), end: allDay ? nextDay(eventTime(e.end, tz), -1) : eventTime(e.end, tz), all_day: allDay || undefined,
    repeat: e.recurrence ? (fromRRule(e.recurrence) ?? e.recurrence.join(' ')) : e.recurringEventId ? 'חלק מסדרה' : undefined,
    location: e.location || undefined, description: e.description ? e.description.slice(0, 300) : undefined,
    linked: linked.length ? linked : undefined,
  };
}

// ---- any event: add, update, delete (bot items linked to it follow at once)

export async function addEvent(db, cal, { title, start, end, location, description, repeat }) {
  const ev = await cal.insert({
    summary: title, ...(location ? { location } : {}), ...(description ? { description } : {}),
    ...span(start, end, cal.tz), ...(repeat ? { recurrence: toRRule(repeat) } : {}),
  });
  return eventView(ev, cal.tz);
}

// Only the fields given change. A new start alone keeps the length. A repeat changes only on the whole series.
export async function updateEvent(db, cal, { event_id, title, start, end, location, description, repeat, repeat_off }, now = Date.now()) {
  const old = await cal.get(event_id);
  if (!old || old.status === 'cancelled') throw new Error(`אין ביומן אירוע ${event_id}`);
  const ev = { ...old };
  if (title !== undefined) ev.summary = title;
  if (location !== undefined) ev.location = location || undefined;
  if (description !== undefined) ev.description = description || undefined;
  if (start !== undefined || end !== undefined) {
    const oldStart = eventTime(old.start, cal.tz);
    const oldAllDay = Boolean(old.start.date);
    const s = start ?? oldStart;
    let e = end;
    // Keep the length when only the start moves (and stays the same kind: all-day or with a time).
    if (e === undefined && start !== undefined && parseLocal(s.replace(' ', 'T')).hasTime !== oldAllDay) {
      e = oldAllDay
        ? nextDay(s, (Date.parse(old.end.date) - Date.parse(old.start.date)) / 86_400_000 - 1)
        : shift(s.replace(' ', 'T'), (Date.parse(old.end.dateTime) - Date.parse(old.start.dateTime)) / 60_000, cal.tz);
    }
    Object.assign(ev, span(s, e, cal.tz));
  }
  if (repeat || repeat_off) {
    if (old.recurringEventId) throw new Error(`זה מופע אחד של אירוע חוזר. כדי לשנות את החזרה, ערוך את הסדרה: ${old.recurringEventId}`);
    ev.recurrence = repeat_off ? undefined : toRRule(repeat);
  }
  const saved = await cal.update(event_id, ev);
  await applyLinks(db, cal.tz, saved, now);
  return eventView(saved, cal.tz);
}

export async function deleteEvent(db, cal, eventId, now = Date.now()) {
  const old = await cal.get(eventId);
  if (!old || old.status === 'cancelled') throw new Error(`אין ביומן אירוע ${eventId}`);
  await cal.remove(eventId);
  await applyLinks(db, cal.tz, { ...old, status: 'cancelled' }, now);
  return { id: eventId, title: old.summary ?? '' };
}

// ---- bot item -> its own event

const item = (db, kind, id) => (kind === 'reminder' ? db.reminder(id) : db.entry(id));

function itemEvent(kind, it, tz) {
  if (kind === 'reminder') return { summary: it.text, description: 'תזכורת מעוזר הבית', ...span(it.start_local, null, tz, 15), recurrence: toRRule(it.rule) };
  return { summary: `${it.done_at ? `${DONE} ` : ''}${it.text}`, description: `${it.list}: ${formatEntry(it).slice(2)}`, ...span(it.fields.due, null, tz, 30) };
}

// Put a bot item in the calendar, or bring its event up to date. A family event the item follows (owner 'calendar')
// is changed only with calendar_update.
export async function pushItem(db, cal, kind, id) {
  const it = await item(db, kind, id);
  const link = await db.calendarLink(kind, id);
  if (!it || (kind === 'reminder' && !it.active)) throw new Error(`אין ${kind === 'reminder' ? 'תזכורת פעילה' : 'פריט'} ${id}`);
  if (link?.owner === 'calendar') return link;
  if (kind === 'entry' && !it.fields.due) throw new Error(`ל"${it.text}" אין מועד (due), אז אין לו מקום ביומן`);
  const body = itemEvent(kind, it, cal.tz);
  const old = link ? await cal.get(link.event_id) : null;
  // Keep what the family added to the event (place, color...); the time, title and repeat are the bot's.
  const ev = old && old.status !== 'cancelled' ? await cal.update(link.event_id, { ...old, ...body }) : await cal.insert(body);
  return db.linkCalendar({ kind, item_id: Number(id), event_id: ev.id, owner: 'bot', updated: ev.updated ?? null });
}

// Take an item out of the calendar: the bot's own event is deleted, a family event is only unlinked.
export async function removeItem(db, cal, link) {
  if (link.owner === 'bot') await cal.remove(link.event_id);
  await db.unlinkCalendar(link.kind, link.item_id);
}

// After a change in the bot (ids, or every linked item of the kind): linked events follow. Items that are gone
// (deleted, a cancelled reminder, an entry without a due date) leave the calendar.
export async function afterChange(db, cal, kind, ids) {
  for (const link of await db.calendarLinks(kind, ids)) {
    const it = await item(db, kind, link.item_id);
    if (!it || (kind === 'reminder' ? !it.active : !it.fields.due)) await removeItem(db, cal, link);
    else if (link.owner === 'bot') await pushItem(db, cal, kind, link.item_id);
  }
}

// A family event -> a reminder in this chat (minutes_before; an all-day event counts from 09:00) or a list entry.
export async function importEvent(db, cal, { event_id, as = 'reminder', minutes_before = 0, list }, { chatId, user, now }) {
  let ev = await cal.get(event_id);
  if (ev?.recurringEventId) ev = await cal.get(ev.recurringEventId); // one instance of a repeat: follow the series
  if (!ev || ev.status === 'cancelled') throw new Error(`אין ביומן אירוע ${event_id}`);
  const start = eventTime(ev.start, cal.tz);
  const text = ev.summary?.trim() || 'אירוע ביומן';
  const kind = as === 'reminder' ? 'reminder' : 'entry';
  let id;
  if (kind === 'reminder') {
    const at = shift(start.includes('T') ? start : `${start}T09:00`, -minutes_before, cal.tz);
    const rule = fromRRule(ev.recurrence);
    const next = nextRun(at, rule, now, cal.tz);
    if (!next) throw new Error(`זמן התזכורת (${at.replace('T', ' ')}) כבר עבר`);
    id = (await db.addReminder({ chat_id: chatId, text, start_local: at, next_at: next, rule }, user, now)).id;
  } else {
    id = (await db.addEntries([{ list: list || 'משימות', text, fields: { due: start } }], user, now))[0].id;
  }
  await db.linkCalendar({ kind, item_id: id, event_id: ev.id, owner: 'calendar', offset_min: kind === 'reminder' ? minutes_before : 0, updated: ev.updated ?? null });
  return { kind, id };
}

// ---- calendar -> bot

// On every tick: the changes since the last poll (one request), applied to linked items.
export async function pullCalendar(db, cal, now = Date.now()) {
  if (!(await db.calendarLinks()).length) return { applied: 0, errors: [] };
  const since = await db.get('calendar:polled', now - 10 * 60_000);
  const changed = await cal.changedSince(since - 2 * 60_000); // overlap: clocks differ a little; seen changes are skipped
  await db.set('calendar:polled', now);
  let applied = 0;
  const errors = [];
  for (const ev of changed) {
    const r = await applyLinks(db, cal.tz, ev, now);
    applied += r.applied;
    errors.push(...r.errors);
  }
  return { applied, errors };
}

// One changed (or deleted) event -> the bot items linked to it, unless the bot already knows this version.
async function applyLinks(db, tz, ev, now) {
  let applied = 0;
  const errors = [];
  for (const link of (await db.calendarLinks()).filter((l) => l.event_id === ev.id && (ev.status === 'cancelled' || l.updated !== ev.updated))) {
    try {
      await applyEvent(db, tz, link, ev, now);
      applied++;
    } catch (err) {
      errors.push(`${link.kind} ${link.item_id}: ${err.message}`);
    }
  }
  return { applied, errors };
}

async function applyEvent(db, tz, link, ev, now) {
  const it = await item(db, link.kind, link.item_id);
  if (!it || ev.status === 'cancelled') {
    // Deleted in the calendar: the reminder stops; an entry stays in its list, only unlinked.
    if (it && link.kind === 'reminder') await db.cancelReminders([link.item_id]);
    return db.unlinkCalendar(link.kind, link.item_id);
  }
  const start = eventTime(ev.start, tz);
  const title = ev.summary?.trim() ?? '';
  if (link.kind === 'reminder') {
    const at = shift(start.includes('T') ? start : `${start}T09:00`, -link.offset_min, tz);
    const rule = fromRRule(ev.recurrence);
    const next = nextRun(at, rule, now, tz);
    // Moved to the past: the reminder stops; moved back to the future: it is active again.
    await db.updateReminder(link.item_id, { text: title || undefined, start_local: at, next_at: next ?? localToUtc(at, tz), rule, active: Boolean(next) });
  } else {
    const text = title.replace(new RegExp(`^${DONE}\\s*`, 'u'), '');
    await db.updateEntry(link.item_id, { text: text || undefined, fields: { due: start }, done: title.startsWith(DONE) }, BY, now);
  }
  await db.linkCalendar({ ...link, updated: ev.updated ?? null });
}

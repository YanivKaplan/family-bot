// Google Calendar through Google's official remote MCP server (calendarmcp.googleapis.com, Streamable HTTP).
// The bot is the MCP client: JSON-RPC tools/call with the family account's OAuth token (built-in fetch only).
// Connecting: a family member sends /calendar, signs in to Google with the link, and /google/callback (worker.mjs)
// keeps the refresh token in kv.
// Only what the family asks for is synced:
//   - calendar_sync: a bot reminder or a dated list entry gets an event that the bot owns. Changes in the bot update the
//     event; changes in the calendar (title, time, repeat, "✅" at the start of the title = done, delete) come back on a
//     tick (pullCalendar).
//   - calendar_import: an existing family event gets a bot reminder (or entry) that follows it. The bot never changes
//     or deletes that event.
// Links are in the calendar_links table. `updated` is the event's last change that the bot already knows (its own write
// or an applied pull), so the bot's own writes do not come back as changes.
import { localDateTime, localToUtc, nextOccurrence, parseLocal } from './time.mjs';
import { formatEntry } from './format.mjs';

const MCP_URL = 'https://calendarmcp.googleapis.com/mcp/v1';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// The scopes Google lists for the Calendar MCP server, and calendar.events for its write tools.
const SCOPES = ['calendar.calendarlist.readonly', 'calendar.events.freebusy', 'calendar.events.readonly', 'calendar.events']
  .map((s) => `https://www.googleapis.com/auth/${s}`).join(' ');
const OAUTH_KEY = 'google:oauth';
const STATE_KEY = 'google:state';
const PULL_MAX = 20; // events read per tick (Workers free plan: 50 outgoing requests per run)
const DONE = '✅';
const BY = 'יומן';
const tokens = new Map(); // per isolate / process: refresh token -> { token, exp }
const NOT_CONNECTED = 'יומן גוגל עוד לא מחובר. שלחו לבוט /calendar כדי לחבר אותו.';

export class GoogleCalendar {
  constructor({ clientId, clientSecret, calendarId = 'primary', tz, db, mcpUrl = MCP_URL, tokenUrl = TOKEN_URL, fetchImpl = (...a) => fetch(...a) }) {
    Object.assign(this, { clientId, clientSecret, calendarId, tz, db, mcpUrl, tokenUrl, fetch: fetchImpl });
    this.rpcId = 0;
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

  // One MCP tools/call. The answer is JSON or an SSE stream; the result is the tool's structured output.
  async tool(name, args) {
    const id = ++this.rpcId;
    const res = await this.fetch(this.mcpUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { calendarId: this.calendarId, ...args } } }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let msg = null;
    try {
      msg = (res.headers.get('content-type') ?? '').includes('text/event-stream')
        ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5))).find((m) => m.id === id)
        : JSON.parse(text);
    } catch { /* not JSON-RPC: reported below */ }
    const fail = (detail) => Object.assign(new Error(`Google Calendar ${name}: ${String(detail).slice(0, 300)}`), { detail: String(detail) });
    if (!msg) throw fail(`HTTP ${res.status} ${text}`);
    if (msg.error) throw fail(msg.error.message ?? JSON.stringify(msg.error));
    const out = msg.result ?? {};
    const body = (out.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    if (out.isError) throw fail(body || 'error');
    if (out.structuredContent) return out.structuredContent;
    try { return body ? JSON.parse(body) : {}; } catch { return { text: body }; }
  }

  // null when the event does not exist any more.
  async get(eventId) {
    try {
      return await this.tool('get_event', { eventId });
    } catch (err) {
      if (/not.?found|404|410|deleted|\bgone\b/i.test(err.detail ?? '')) return null;
      throw err;
    }
  }

  insert(args) { return this.tool('create_event', { notificationLevel: 'NONE', ...args }); }
  update(eventId, args) { return this.tool('update_event', { eventId, notificationLevel: 'NONE', ...args }); }
  async remove(eventId) {
    try {
      await this.tool('delete_event', { eventId, notificationLevel: 'NONE' });
    } catch (err) {
      if (!/not.?found|404|410|deleted|\bgone\b/i.test(err.detail ?? '')) throw err;
    }
  }

  // Events between two local dates (both included).
  async between(from, to) {
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
    if (![from, to].every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) || !(days >= 1 && days <= 62)) throw new Error('טווח תאריכים: from עד to בפורמט YYYY-MM-DD, עד 62 יום');
    const r = await this.tool('list_events', {
      startTime: new Date(localToUtc(`${from}T00:00`, this.tz)).toISOString(),
      endTime: new Date(localToUtc(`${nextDay(to)}T00:00`, this.tz)).toISOString(),
      timeZone: this.tz, orderBy: 'startTime', pageSize: 100,
    });
    return r.events ?? [];
  }
}

// ---- connecting the family Google account (OAuth, once)

// A sign-in link for /calendar. The state is random, used once, and valid for 15 minutes.
export async function connectLink(db, { clientId, publicUrl }, chatId, now = Date.now()) {
  const state = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await db.set(STATE_KEY, { state, chat_id: chatId, exp: now + 15 * 60_000 });
  return `${AUTH_URL}?${new URLSearchParams({
    client_id: clientId, redirect_uri: `${publicUrl}/google/callback`, response_type: 'code', scope: SCOPES,
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

// ---- event <-> bot item

const nextDay = (date) => new Date(Date.parse(date) + 86_400_000).toISOString().slice(0, 10);

// An event time as local "YYYY-MM-DD" (all day; the MCP server sends it as midnight UTC) or "YYYY-MM-DDTHH:MM".
export const eventTime = (t, tz) => (t?.date ? t.date.slice(0, 10) : localDateTime(new Date(t.dateTime), tz));

const shift = (local, min, tz) => localDateTime(new Date(localToUtc(local, tz) + min * 60_000), tz);

// create_event / update_event times. timeZone wins over offsets, so local wall-clock times are sent as is.
function when(local, minutes, tz) {
  if (!parseLocal(local).hasTime) return { startTime: `${local}T00:00:00`, endTime: `${nextDay(local)}T00:00:00`, allDay: true, timeZone: tz };
  return { startTime: `${local}:00`, endTime: `${shift(local, minutes, tz)}:00`, allDay: false, timeZone: tz };
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

const item = (db, kind, id) => (kind === 'reminder' ? db.reminder(id) : db.entry(id));

function eventArgs(kind, it, tz) {
  if (kind === 'reminder') return { summary: it.text, description: 'תזכורת מעוזר הבית', ...when(it.start_local, 15, tz) };
  return { summary: `${it.done_at ? `${DONE} ` : ''}${it.text}`, description: `${it.list}: ${formatEntry(it).slice(2)}`, ...when(it.fields.due, 30, tz) };
}

// When a reminder at local `at` (repeating by `rule`) fires next; null when a one-time one has passed.
function nextRun(at, rule, now, tz) {
  const first = localToUtc(at, tz);
  if (!rule) return first > now ? first : null;
  return nextOccurrence(rule, at, Math.max(first - 60_000, now), tz);
}

// ---- bot -> calendar

// Put a bot item in the calendar, or bring its event up to date. A family event (owner 'calendar') is never changed.
export async function pushItem(db, cal, kind, id) {
  const it = await item(db, kind, id);
  const link = await db.calendarLink(kind, id);
  if (!it || (kind === 'reminder' && !it.active)) throw new Error(`אין ${kind === 'reminder' ? 'תזכורת פעילה' : 'פריט'} ${id}`);
  if (link?.owner === 'calendar') return link;
  if (kind === 'entry' && !it.fields.due) throw new Error(`ל"${it.text}" אין מועד (due), אז אין לו מקום ביומן`);
  const args = eventArgs(kind, it, cal.tz);
  const rule = kind === 'reminder' ? it.rule : null;
  const old = link ? await cal.get(link.event_id) : null;
  let ev;
  // update_event cannot change the repeat: an event whose repeat changed is made again.
  if (old && old.status !== 'cancelled' && JSON.stringify(fromRRule(old.recurrence)) === JSON.stringify(rule)) {
    ev = await cal.update(link.event_id, args);
    if (!ev?.updated) ev = await cal.get(link.event_id);
  } else {
    if (old && old.status !== 'cancelled') await cal.remove(link.event_id);
    ev = await cal.insert({ ...args, ...(rule ? { recurrenceData: toRRule(rule) } : {}) });
  }
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
  const ev = await cal.get(event_id);
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

// ---- calendar -> bot, on a tick. The MCP tools have no "changed since", so the linked events are read one by one:
// up to PULL_MAX per tick, in turns.
export async function pullCalendar(db, cal, now = Date.now()) {
  const links = await db.calendarLinks();
  const events = [...new Set(links.map((l) => l.event_id))].sort();
  if (!events.length) return { applied: 0, errors: [] };
  const from = (await db.get('calendar:cursor', 0)) % events.length;
  const batch = [...events, ...events].slice(from, from + Math.min(PULL_MAX, events.length));
  await db.set('calendar:cursor', from + batch.length);
  let applied = 0;
  const errors = [];
  for (const eventId of batch) {
    let ev;
    try {
      ev = await cal.get(eventId);
    } catch (err) {
      errors.push(`${eventId}: ${err.message}`);
      continue;
    }
    for (const link of links.filter((l) => l.event_id === eventId && (!ev || ev.status === 'cancelled' || l.updated !== ev.updated))) {
      try {
        await applyEvent(db, cal.tz, link, ev, now);
        applied++;
      } catch (err) {
        errors.push(`${link.kind} ${link.item_id}: ${err.message}`);
      }
    }
  }
  return { applied, errors };
}

async function applyEvent(db, tz, link, ev, now) {
  const it = await item(db, link.kind, link.item_id);
  if (!it || !ev || ev.status === 'cancelled') {
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

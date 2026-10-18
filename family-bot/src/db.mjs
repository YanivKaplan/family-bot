// Household data. Works on Cloudflare D1 and on node:sqlite through an adapter (src/adapters.mjs).

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, list TEXT NOT NULL, text TEXT NOT NULL, fields TEXT NOT NULL DEFAULT '{}', created_by TEXT, created_at INTEGER NOT NULL, done_at INTEGER, done_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, text TEXT NOT NULL, start_local TEXT NOT NULL, next_at INTEGER, rule TEXT, task_id INTEGER, created_by TEXT, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS places (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT, lat REAL, lon REAL, radius_m INTEGER NOT NULL DEFAULT 250)`,
  `CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, topic TEXT NOT NULL, text TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS place_alerts (user_id INTEGER, place_id INTEGER, day TEXT, PRIMARY KEY (user_id, place_id, day))`,
  `CREATE TABLE IF NOT EXISTS seen_updates (update_id INTEGER PRIMARY KEY, ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS entries_open ON entries(done_at, list)`,
  // One-time move from the old items/tasks tables: only the open baby equipment list is kept, the rest is dropped.
  // ponytail: delete these three lines once every deployed DB has run them.
  `CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, list TEXT, name TEXT, created_at INTEGER, done_at INTEGER, added_by TEXT)`,
  `INSERT INTO entries (list, text, created_by, created_at) SELECT list, name, added_by, created_at FROM items WHERE list = 'ציוד לתינוק' AND done_at IS NULL`,
  `DROP TABLE items`, `DROP TABLE IF EXISTS tasks`,
  `CREATE INDEX IF NOT EXISTS reminders_next ON reminders(active, next_at)`,
  `CREATE INDEX IF NOT EXISTS history_chat ON history(chat_id, id)`,
  // Google Calendar: one event per reminder or entry (src/calendar.mjs). An event can have more than one reminder.
  `CREATE TABLE IF NOT EXISTS calendar_links (kind TEXT NOT NULL, item_id INTEGER NOT NULL, event_id TEXT NOT NULL, owner TEXT NOT NULL, offset_min INTEGER NOT NULL DEFAULT 0, updated TEXT, PRIMARY KEY (kind, item_id))`,
];

const MAX_TEXT = 300;
const clean = (v, field, max = MAX_TEXT) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`השדה ${field} חסר`);
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
};
const opt = (v, max = MAX_TEXT) => (v == null || v === '' ? null : clean(String(v), 'text', max));
// Free fields of a list entry: short keys; values are text, numbers, true/false or a short list of texts. null/"" = no value.
const DUE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
function cleanFields(f) {
  if (f == null) return {};
  if (typeof f !== 'object' || Array.isArray(f)) throw new Error('fields צריך להיות אובייקט');
  const out = {};
  for (const [k, v] of Object.entries(f)) {
    const key = clean(k, 'field', 30);
    if (v == null || v === '') continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[key] = v;
    else if (Array.isArray(v)) out[key] = [...new Set(v.map((x) => String(x).trim()).filter(Boolean).map((x) => x.slice(0, 60)))].slice(0, 10);
    else out[key] = clean(typeof v === 'string' ? v : JSON.stringify(v), key, 300);
    if (key === 'due' && !DUE.test(out[key])) throw new Error('due בפורמט YYYY-MM-DD או YYYY-MM-DDTHH:MM');
  }
  if (Object.keys(out).length > 15 || JSON.stringify(out).length > 2000) throw new Error('יותר מדי שדות');
  return out;
}
const withFields = (r) => (r ? { ...r, fields: JSON.parse(r.fields || '{}') } : null);
const withRule = (r) => (r ? { ...r, rule: r.rule ? JSON.parse(r.rule) : null } : null);

export class HouseDB {
  constructor(sql) { this.sql = sql; }

  async init() { await this.sql.init(SCHEMA); }

  // ---- key/value (usage counters, last location, digest date)
  async get(k, fallback = null) {
    const r = await this.sql.get('SELECT v FROM kv WHERE k = ?', [k]);
    return r ? JSON.parse(r.v) : fallback;
  }
  async set(k, v) {
    await this.sql.run('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', [k, JSON.stringify(v)]);
  }

  // Telegram can send the same update again (retry). Returns true only the first time.
  async firstSeen(updateId, now = Date.now()) {
    const r = await this.sql.run('INSERT OR IGNORE INTO seen_updates (update_id, ts) VALUES (?, ?)', [updateId, now]);
    if (r.changes > 0 && updateId % 50 === 0) await this.sql.run('DELETE FROM seen_updates WHERE ts < ?', [now - 3 * 86_400_000]);
    return r.changes > 0;
  }

  // ---- lists: one generic table for every list (shopping, tasks, baby prep, chores, gifts...).
  // `fields` is free JSON (qty, note, assignee, due, places, or anything else), so a new kind of list needs no new code.
  async addEntries(entries, by, now = Date.now()) {
    if (!Array.isArray(entries) || !entries.length) throw new Error('אין פריטים להוספה');
    if (entries.length > 50) throw new Error('יותר מדי פריטים בבת אחת');
    const out = [];
    for (const e of entries) {
      const list = clean(e.list, 'list', 40);
      const text = clean(e.text, 'text', 200);
      const fields = cleanFields(e.fields);
      // The same open entry in the same list: merge the fields instead of adding a duplicate.
      const old = await this.sql.get('SELECT * FROM entries WHERE done_at IS NULL AND list = ? AND text = ?', [list, text]);
      if (old) {
        out.push({ ...(await this.updateEntry(old.id, { fields: e.fields })), merged: true });
        continue;
      }
      const { n } = await this.sql.get('SELECT COUNT(*) AS n FROM entries WHERE done_at IS NULL');
      if (n >= 2000) throw new Error('יש כבר 2000 פריטים פתוחים. סגרו או מחקו ישנים.');
      const r = await this.sql.run('INSERT INTO entries (list, text, fields, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
        [list, text, JSON.stringify(fields), by, now]);
      out.push(await this.entry(r.lastId));
    }
    return out;
  }

  async entry(id) { return withFields(await this.sql.get('SELECT * FROM entries WHERE id = ?', [Number(id)])); }

  // Open entries (all lists, or one), and optionally the ones done since `doneSince`.
  async entries({ list, doneSince } = {}) {
    const where = [doneSince != null ? 'done_at >= ?' : 'done_at IS NULL'];
    const args = doneSince != null ? [doneSince] : [];
    if (list) { where.push('list = ?'); args.push(list); }
    return (await this.sql.all(`SELECT * FROM entries WHERE ${where.join(' AND ')} ORDER BY list, id LIMIT 500`, args)).map(withFields);
  }

  lists() { return this.sql.all('SELECT list, COUNT(*) AS open FROM entries WHERE done_at IS NULL GROUP BY list ORDER BY list'); }

  // fields are merged: a key with null or "" is removed. done: true closes, false reopens.
  async updateEntry(id, { text, list, fields, done }, by, now = Date.now()) {
    const e = await this.entry(id);
    if (!e) throw new Error(`אין פריט ${id}`);
    const merged = { ...e.fields };
    for (const [k, v] of Object.entries(fields ?? {})) delete merged[k];
    Object.assign(merged, cleanFields(fields));
    const doneAt = done === true ? (e.done_at ?? now) : done === false ? null : e.done_at;
    await this.sql.run('UPDATE entries SET list=?, text=?, fields=?, done_at=?, done_by=? WHERE id=?', [
      list !== undefined ? clean(list, 'list', 40) : e.list, text !== undefined ? clean(text, 'text', 200) : e.text,
      JSON.stringify(merged), doneAt, doneAt ? (done === true && !e.done_at ? by : e.done_by) : null, e.id,
    ]);
    if (doneAt) await this.sql.run('UPDATE reminders SET active = 0 WHERE task_id = ?', [e.id]); // its reminders stop
    return this.entry(e.id);
  }

  async deleteEntries(ids) {
    const out = [];
    for (const id of ids.map(Number)) {
      if ((await this.sql.run('DELETE FROM entries WHERE id = ?', [id])).changes > 0) {
        out.push(id);
        await this.sql.run('UPDATE reminders SET active = 0 WHERE task_id = ?', [id]);
      }
    }
    return out;
  }

  // A whole list: rename it, or delete it (only open entries, or with done ones too).
  async renameList(from, to) {
    return (await this.sql.run('UPDATE entries SET list = ? WHERE list = ?', [clean(to, 'list', 40), clean(from, 'list', 40)])).changes;
  }

  async deleteList(list) { return (await this.sql.run('DELETE FROM entries WHERE list = ?', [clean(list, 'list', 40)])).changes; }

  // ---- reminders
  async addReminder({ chat_id, text, start_local, next_at, rule, task_id }, by, now = Date.now()) {
    const { n } = await this.sql.get('SELECT COUNT(*) AS n FROM reminders WHERE active = 1');
    if (n >= 300) throw new Error('יש כבר 300 תזכורות פעילות');
    const r = await this.sql.run(
      'INSERT INTO reminders (chat_id, text, start_local, next_at, rule, task_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [chat_id, clean(text, 'text', 300), start_local, next_at, rule ? JSON.stringify(rule) : null, task_id ?? null, by, now],
    );
    return this.reminder(r.lastId);
  }

  async reminder(id) { return withRule(await this.sql.get('SELECT * FROM reminders WHERE id = ?', [Number(id)])); }

  async activeReminders() { return (await this.sql.all('SELECT * FROM reminders WHERE active = 1 ORDER BY next_at')).map(withRule); }

  async dueReminders(now = Date.now()) {
    return (await this.sql.all('SELECT * FROM reminders WHERE active = 1 AND next_at <= ? ORDER BY next_at LIMIT 20', [now])).map(withRule);
  }

  // Move a fired reminder forward, or switch it off. Called before the send, so a crash never repeats it.
  async advanceReminder(id, nextAt) {
    if (nextAt) await this.sql.run('UPDATE reminders SET next_at = ? WHERE id = ?', [nextAt, id]);
    else await this.sql.run('UPDATE reminders SET active = 0 WHERE id = ?', [id]);
  }

  // active (true/false) is set only by the calendar sync: an event moved to the future turns a fired reminder on again.
  async updateReminder(id, { text, start_local, next_at, rule, active }) {
    const r = await this.reminder(id);
    if (!r || (!r.active && active == null)) throw new Error(`אין תזכורת פעילה ${id}`);
    await this.sql.run('UPDATE reminders SET text=?, start_local=?, next_at=?, rule=?, active=? WHERE id=?', [
      text !== undefined ? clean(text, 'text', 300) : r.text, start_local ?? r.start_local, next_at ?? r.next_at,
      rule !== undefined ? (rule ? JSON.stringify(rule) : null) : (r.rule ? JSON.stringify(r.rule) : null),
      active == null ? r.active : active ? 1 : 0, r.id,
    ]);
    return this.reminder(id);
  }

  async cancelReminders(ids) {
    const out = [];
    for (const id of ids.map(Number)) {
      if ((await this.sql.run('UPDATE reminders SET active = 0 WHERE id = ? AND active = 1', [id])).changes > 0) out.push(id);
    }
    return out;
  }

  // ---- places
  // With id: edit that place (also rename). Without: insert, or update the place with the same name.
  async savePlace({ id, name, kind, lat, lon, radius_m }) {
    const n = clean(name, 'name', 60);
    const hasGeo = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    if (id) {
      const old = await this.sql.get('SELECT * FROM places WHERE id = ?', [Number(id)]);
      if (!old) throw new Error(`אין מקום ${id}`);
      if (await this.sql.get('SELECT id FROM places WHERE name = ? AND id != ?', [n, old.id])) throw new Error(`כבר יש מקום בשם ${n}`);
      await this.sql.run('UPDATE places SET name=?, kind=?, lat=?, lon=?, radius_m=? WHERE id=?', [
        n, kind !== undefined ? opt(kind, 40) : old.kind, hasGeo ? lat : old.lat, hasGeo ? lon : old.lon,
        radius_m ? Math.min(Math.max(Number(radius_m), 50), 3000) : old.radius_m, old.id,
      ]);
      return this.sql.get('SELECT * FROM places WHERE id = ?', [old.id]);
    }
    const r = Math.min(Math.max(Number(radius_m) || 250, 50), 3000);
    await this.sql.run(`INSERT INTO places (name, kind, lat, lon, radius_m) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET kind = COALESCE(excluded.kind, kind), lat = COALESCE(excluded.lat, lat),
      lon = COALESCE(excluded.lon, lon), radius_m = excluded.radius_m`,
    [n, opt(kind, 40), hasGeo ? lat : null, hasGeo ? lon : null, r]);
    return this.sql.get('SELECT * FROM places WHERE name = ?', [n]);
  }

  places() { return this.sql.all('SELECT * FROM places ORDER BY name'); }

  async deletePlaces(ids) {
    const out = [];
    for (const id of ids.map(Number)) {
      if ((await this.sql.run('DELETE FROM places WHERE id = ?', [id])).changes > 0) {
        out.push(id);
        await this.sql.run('DELETE FROM place_alerts WHERE place_id = ?', [id]);
      }
    }
    return out;
  }

  async markPlaceAlert(userId, placeId, day) {
    return (await this.sql.run('INSERT OR IGNORE INTO place_alerts (user_id, place_id, day) VALUES (?, ?, ?)', [userId, placeId, day])).changes > 0;
  }

  // ---- household memory: facts and decisions the family asked the bot to keep
  async saveNote({ id, topic, text }, by, now = Date.now()) {
    const t = clean(topic, 'topic', 40);
    const body = clean(text, 'text', 1000);
    if (id) {
      const r = await this.sql.run('UPDATE notes SET topic = ?, text = ?, updated_at = ? WHERE id = ?', [t, body, now, Number(id)]);
      if (!r.changes) throw new Error(`אין רשומה ${id}`);
      return this.sql.get('SELECT * FROM notes WHERE id = ?', [Number(id)]);
    }
    const { n } = await this.sql.get('SELECT COUNT(*) AS n FROM notes');
    if (n >= 500) throw new Error('הזיכרון מלא (500 רשומות). מחקו רשומות ישנות.');
    const r = await this.sql.run('INSERT INTO notes (topic, text, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [t, body, by, now, now]);
    return this.sql.get('SELECT * FROM notes WHERE id = ?', [r.lastId]);
  }

  notes(topic) {
    return topic
      ? this.sql.all('SELECT id, topic, text, created_by, updated_at FROM notes WHERE topic = ? ORDER BY id', [topic])
      : this.sql.all('SELECT id, topic, text, created_by, updated_at FROM notes ORDER BY topic, id');
  }

  noteTopics() { return this.sql.all('SELECT topic, COUNT(*) AS n FROM notes GROUP BY topic ORDER BY topic'); }

  async deleteNotes(ids) {
    const out = [];
    for (const id of ids.map(Number)) if ((await this.sql.run('DELETE FROM notes WHERE id = ?', [id])).changes > 0) out.push(id);
    return out;
  }

  // ---- Google Calendar links. owner 'bot' = the bot made the event; 'calendar' = a family event the item follows.
  async linkCalendar({ kind, item_id, event_id, owner, offset_min = 0, updated = null }) {
    await this.sql.run(`INSERT INTO calendar_links (kind, item_id, event_id, owner, offset_min, updated) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, item_id) DO UPDATE SET event_id = excluded.event_id, owner = excluded.owner, offset_min = excluded.offset_min, updated = excluded.updated`,
    [kind, Number(item_id), event_id, owner, Number(offset_min) || 0, updated]);
    return this.calendarLink(kind, item_id);
  }

  calendarLink(kind, id) { return this.sql.get('SELECT * FROM calendar_links WHERE kind = ? AND item_id = ?', [kind, Number(id)]); }

  // All links, or of one kind, or of some items of that kind.
  calendarLinks(kind, ids) {
    if (!kind) return this.sql.all('SELECT * FROM calendar_links');
    if (!ids) return this.sql.all('SELECT * FROM calendar_links WHERE kind = ?', [kind]);
    if (!ids.length) return [];
    return this.sql.all(`SELECT * FROM calendar_links WHERE kind = ? AND item_id IN (${ids.map(() => '?').join(',')})`, [kind, ...ids.map(Number)]);
  }

  async unlinkCalendar(kind, id) { await this.sql.run('DELETE FROM calendar_links WHERE kind = ? AND item_id = ?', [kind, Number(id)]); }

  // ---- conversation history (short, per chat)
  async addHistory(chatId, role, content, keep = 24, now = Date.now()) {
    await this.sql.run('INSERT INTO history (chat_id, role, content, ts) VALUES (?, ?, ?, ?)', [chatId, role, String(content).slice(0, 2000), now]);
    await this.sql.run('DELETE FROM history WHERE chat_id = ? AND id NOT IN (SELECT id FROM history WHERE chat_id = ? ORDER BY id DESC LIMIT ?)', [chatId, chatId, keep]);
  }

  history(chatId, maxAgeMs = 12 * 3600_000, now = Date.now()) {
    return this.sql.all('SELECT role, content FROM history WHERE chat_id = ? AND ts >= ? ORDER BY id', [chatId, now - maxAgeMs]);
  }

  // ---- daily usage counter for the cost limit
  async bumpUsage(day, fields) {
    const u = await this.get(`usage:${day}`, { calls: 0, input: 0, output: 0, searches: 0 });
    for (const [k, v] of Object.entries(fields)) u[k] = (u[k] ?? 0) + v;
    await this.set(`usage:${day}`, u);
    return u;
  }
}

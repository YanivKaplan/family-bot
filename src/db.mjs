// Household data. Works on Cloudflare D1 and on node:sqlite through an adapter (src/adapters.mjs).

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, list TEXT NOT NULL DEFAULT 'סופר', name TEXT NOT NULL, qty TEXT, note TEXT, added_by TEXT, created_at INTEGER NOT NULL, done_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, notes TEXT, places TEXT NOT NULL DEFAULT '', assignee TEXT, due_at INTEGER, due_has_time INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL, done_at INTEGER, done_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, text TEXT NOT NULL, start_local TEXT NOT NULL, next_at INTEGER, rule TEXT, task_id INTEGER, created_by TEXT, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS places (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT, lat REAL, lon REAL, radius_m INTEGER NOT NULL DEFAULT 250)`,
  `CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, topic TEXT NOT NULL, text TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS place_alerts (user_id INTEGER, place_id INTEGER, day TEXT, PRIMARY KEY (user_id, place_id, day))`,
  `CREATE TABLE IF NOT EXISTS seen_updates (update_id INTEGER PRIMARY KEY, ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS reminders_next ON reminders(active, next_at)`,
  `CREATE INDEX IF NOT EXISTS history_chat ON history(chat_id, id)`,
];

const MAX_TEXT = 300;
const clean = (v, field, max = MAX_TEXT) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`השדה ${field} חסר`);
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
};
const opt = (v, max = MAX_TEXT) => (v == null || v === '' ? null : clean(String(v), 'text', max));
const normPlaces = (arr) =>
  [...new Set((Array.isArray(arr) ? arr : String(arr ?? '').split(','))
    .map((p) => String(p).trim()).filter(Boolean).map((p) => p.slice(0, 40)))].slice(0, 8).join(',');
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

  // ---- shopping
  async addItems(items, by, now = Date.now()) {
    if (!Array.isArray(items) || !items.length) throw new Error('אין פריטים להוספה');
    if (items.length > 50) throw new Error('יותר מדי פריטים בבת אחת');
    const out = [];
    for (const it of items) {
      const list = opt(it.list, 40) ?? 'סופר';
      const name = clean(it.name, 'name', 80);
      const qty = opt(it.qty, 30);
      const note = opt(it.note, 120);
      const existing = await this.sql.get('SELECT id, qty FROM items WHERE done_at IS NULL AND list = ? AND name = ?', [list, name]);
      if (existing) {
        await this.sql.run('UPDATE items SET qty = ?, note = COALESCE(?, note) WHERE id = ?', [qty ?? existing.qty, note, existing.id]);
        out.push({ id: existing.id, list, name, qty: qty ?? existing.qty, merged: true });
      } else {
        const r = await this.sql.run('INSERT INTO items (list, name, qty, note, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [list, name, qty, note, by, now]);
        out.push({ id: r.lastId, list, name, qty });
      }
    }
    return out;
  }

  openItems(list) {
    return list
      ? this.sql.all('SELECT id, list, name, qty, note, added_by FROM items WHERE done_at IS NULL AND list = ? ORDER BY list, id', [list])
      : this.sql.all('SELECT id, list, name, qty, note, added_by FROM items WHERE done_at IS NULL ORDER BY list, id');
  }

  async markItems(ids, now = Date.now()) {
    const done = [];
    for (const id of ids.map(Number)) {
      if ((await this.sql.run('UPDATE items SET done_at = ? WHERE id = ? AND done_at IS NULL', [now, id])).changes > 0) done.push(id);
    }
    return done;
  }

  async clearList(list, now = Date.now()) {
    return (await this.sql.run('UPDATE items SET done_at = ? WHERE done_at IS NULL AND list = ?', [now, clean(list, 'list', 40)])).changes;
  }

  // ---- tasks
  async addTask({ title, notes, places, assignee, due_at, due_has_time }, by, now = Date.now()) {
    const r = await this.sql.run(
      'INSERT INTO tasks (title, notes, places, assignee, due_at, due_has_time, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [clean(title, 'title', 150), opt(notes, 400), normPlaces(places), opt(assignee, 40), due_at ?? null, due_has_time ? 1 : 0, by, now],
    );
    return this.task(r.lastId);
  }

  task(id) { return this.sql.get('SELECT * FROM tasks WHERE id = ?', [Number(id)]); }

  async updateTask(id, fields) {
    const t = await this.task(id);
    if (!t) throw new Error(`אין משימה ${id}`);
    const next = {
      title: fields.title !== undefined ? clean(fields.title, 'title', 150) : t.title,
      notes: fields.notes !== undefined ? opt(fields.notes, 400) : t.notes,
      places: fields.places !== undefined ? normPlaces(fields.places) : t.places,
      assignee: fields.assignee !== undefined ? opt(fields.assignee, 40) : t.assignee,
      due_at: fields.due_at !== undefined ? fields.due_at : t.due_at,
      due_has_time: fields.due_has_time !== undefined ? (fields.due_has_time ? 1 : 0) : t.due_has_time,
    };
    await this.sql.run('UPDATE tasks SET title=?, notes=?, places=?, assignee=?, due_at=?, due_has_time=? WHERE id=?',
      [next.title, next.notes, next.places, next.assignee, next.due_at, next.due_has_time, Number(id)]);
    return this.task(id);
  }

  async completeTasks(ids, by, now = Date.now()) {
    const done = [];
    for (const id of ids.map(Number)) {
      if ((await this.sql.run('UPDATE tasks SET done_at = ?, done_by = ? WHERE id = ? AND done_at IS NULL', [now, by, id])).changes > 0) {
        done.push(id);
        await this.sql.run('UPDATE reminders SET active = 0 WHERE task_id = ?', [id]); // its reminders stop
      }
    }
    return done;
  }

  openTasks() { return this.sql.all('SELECT * FROM tasks WHERE done_at IS NULL ORDER BY due_at IS NULL, due_at, id'); }

  recentDone(sinceMs) { return this.sql.all('SELECT * FROM tasks WHERE done_at >= ? ORDER BY done_at DESC LIMIT 30', [sinceMs]); }

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

  async cancelReminders(ids) {
    const out = [];
    for (const id of ids.map(Number)) {
      if ((await this.sql.run('UPDATE reminders SET active = 0 WHERE id = ? AND active = 1', [id])).changes > 0) out.push(id);
    }
    return out;
  }

  // ---- places
  async savePlace({ name, kind, lat, lon, radius_m }) {
    const n = clean(name, 'name', 60);
    const r = Math.min(Math.max(Number(radius_m) || 250, 50), 3000);
    const hasGeo = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    await this.sql.run(`INSERT INTO places (name, kind, lat, lon, radius_m) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET kind = COALESCE(excluded.kind, kind), lat = COALESCE(excluded.lat, lat),
      lon = COALESCE(excluded.lon, lon), radius_m = excluded.radius_m`,
    [n, opt(kind, 40), hasGeo ? lat : null, hasGeo ? lon : null, r]);
    return this.sql.get('SELECT * FROM places WHERE name = ?', [n]);
  }

  places() { return this.sql.all('SELECT * FROM places ORDER BY name'); }

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

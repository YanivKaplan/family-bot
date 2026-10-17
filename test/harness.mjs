// Local harness: the real FamilyBot, real DB and real Claude, with Telegram replaced by an in-memory recorder.
// Used by scripts/chat.mjs (interactive) and test/live.scenario.mjs (a scripted family week).
import { readFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { loadConfig } from '../src/config.mjs';
import { HouseDB } from '../src/db.mjs';
import { NodeSqliteAdapter } from '../src/node-sqlite.mjs';
import { FamilyBot } from '../src/bot.mjs';
import { localToUtc } from '../src/time.mjs';

export const GROUP = -100;
export const USERS = { יניב: 1, מיכל: 2 };

// .env wins over the shell. ANTHROPIC_BASE_URL is taken only from .env: a Claude Code shell sets it to its own proxy.
export function localEnv(path = '.env') {
  const file = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
  const { ANTHROPIC_BASE_URL, ...shell } = process.env;
  return { ...shell, ...file };
}

// Bot methods that are internal plumbing, not tool work. Everything else on the DB is recorded per turn.
const INTERNAL = new Set(['get', 'set', 'bumpUsage', 'addHistory', 'history', 'noteTopics', 'firstSeen', 'init']);

export async function createHarness({ env = localEnv(), dbPath = ':memory:', start, claude, log = console } = {}) {
  const config = loadConfig({
    ...env,
    TELEGRAM_BOT_TOKEN: '500:local',
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY || (claude ? 'fake' : ''),
    ALLOWED_CHAT_IDS: String(GROUP),
    ALLOWED_USER_IDS: Object.values(USERS).join(','),
    FAMILY_MEMBERS: Object.keys(USERS).join(','),
  });

  // A controllable clock, so a whole week can run in minutes. Only Date.now is replaced.
  // ponytail: global Date.now patch; one harness per process.
  const realNow = Date.now;
  let clock = start ? localToUtc(start, config.tz) : realNow();
  Date.now = () => clock;

  const sql = await NodeSqliteAdapter.open(dbPath);
  const raw = new HouseDB(sql);
  await raw.init();
  const calls = [];
  const db = new Proxy(raw, {
    get(t, k) {
      const v = t[k];
      if (typeof v !== 'function') return v;
      return (...args) => {
        if (!INTERNAL.has(k)) calls.push({ fn: k, args });
        return v.apply(t, args);
      };
    },
  });

  const sent = [];
  const telegram = {
    getMe: async () => ({ id: 500, username: 'home_helper_bot', is_bot: true }),
    send: async (chatId, text, opts = {}) => { sent.push({ chatId, text, ...opts }); return { message_id: 10_000 + sent.length }; },
    typing: async () => {},
    leave: async () => {},
    setCommands: async () => {},
  };

  const bot = new FamilyBot({ config, db, telegram, claude, log });
  await bot.identity();
  let usage = null;
  const respond = bot.claude.respond.bind(bot.claude);
  bot.claude.respond = async (a) => { const r = await respond(a); usage = r.usage; return r; };

  let mid = 0;
  const since = (s, c) => ({ replies: sent.slice(s).map((m) => m.text), calls: calls.slice(c) });

  return {
    bot, db: raw, config, sent,
    now: () => clock,
    setTime(local) { clock = localToUtc(local, config.tz); },
    advance(ms) { clock += ms; },

    // One message from a family member. Group by default (needs the wake word, like the real group).
    async say(text, { as = 'יניב', chat = 'group' } = {}) {
      const from = USERS[as];
      const c = chat === 'group' ? { id: GROUP, type: 'group', title: 'משפחה' } : { id: from, type: 'private' };
      const s = sent.length, n = calls.length;
      usage = null;
      const t0 = performance.now();
      await bot.handle({
        update_id: ++mid,
        message: { message_id: mid, chat: c, from: { id: from, first_name: as }, date: Math.floor(clock / 1000), text },
      });
      return { ...since(s, n), reply: sent.slice(s).map((m) => m.text).join('\n'), ms: Math.round(performance.now() - t0), usage };
    },

    // Run the scheduler at the current clock (reminders, morning summary).
    async tick() {
      const s = sent.length, n = calls.length;
      await bot.tick(clock);
      return since(s, n);
    },

    async state() {
      return {
        entries: await raw.entries(),
        done: await raw.entries({ doneSince: clock - 30 * 86_400_000 }),
        reminders: await raw.activeReminders(),
        notes: await raw.notes(),
      };
    },

    close() { Date.now = realNow; sql.close(); },
  };
}

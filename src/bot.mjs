// Update handling: who may talk to the bot, when it answers, locations, reminders.
// Runs the same on Cloudflare Workers (webhook + cron) and on Node (long polling).
import { Claude } from './claude.mjs';
import { contextBlock } from './prompt.mjs';
import { HELP, formatShopping, formatTasks, formatReminders, formatDigest } from './format.mjs';
import { localDate, localParts, nextOccurrence, distanceM, formatHe } from './time.mjs';

const LOCATION_TTL_MS = 30 * 60_000;
const CHAT_TTL_MS = 2 * 3600_000;

export class FamilyBot {
  constructor({ config, db, telegram, claude, log = console }) {
    this.cfg = config;
    this.db = db;
    this.tg = telegram;
    this.claude = claude ?? new Claude({
      apiKey: config.anthropicKey, model: config.model, baseUrl: config.anthropicBaseUrl,
      maxTokens: config.maxTokens, webSearch: config.webSearch,
    });
    this.log = log;
    this.me = config.botId ? { id: config.botId, username: config.botUsername } : null;
  }

  // The bot identity. On Workers it comes from the config, so no getMe call is needed on each request.
  async identity() {
    if (!this.me?.username) this.me = await this.tg.getMe();
    return this.me;
  }

  isAllowed(chat, from) {
    // Every sender must be a listed family member, also inside the family group.
    if (!this.cfg.allowedUsers.has(from?.id)) return false;
    return chat.type === 'private' || this.cfg.allowedChats.has(chat.id);
  }

  // ---- entry point for one Telegram update
  async handle(update) {
    await this.identity();
    if (update.my_chat_member) return this.onMembership(update.my_chat_member);
    const msg = update.message ?? update.edited_message;
    if (!msg || !msg.chat || msg.from?.is_bot) return;
    const isEdit = Boolean(update.edited_message);
    const text = msg.text ?? msg.caption ?? '';

    // /id works everywhere, so you can find the ids during setup. It shows only ids.
    if (!isEdit && this.isCommand(text, 'id')) {
      return this.tg.send(msg.chat.id, `chat id: ${msg.chat.id}\nuser id: ${msg.from?.id}`, { replyTo: msg.message_id });
    }
    if (!this.isAllowed(msg.chat, msg.from)) {
      // Ids only (no message text), so the log shows why a message was ignored.
      this.log.warn?.(`ignored: chat ${msg.chat.id} (${msg.chat.type}), user ${msg.from?.id}`);
      if (msg.chat.type === 'private' && !isEdit) await this.tg.send(msg.chat.id, 'זה בוט פרטי של משפחה.');
      return;
    }
    if (msg.location) return this.onLocation(msg, isEdit);
    if (isEdit || !text) return;
    const addressed = this.isTriggered(msg, text);
    if (!addressed && (!this.cfg.answerAll || text.trim().startsWith('/'))) return this.rememberChat(msg, text); // not for the bot: no answer, kept only as context

    const fixed = await this.fixedCommand(text);
    if (fixed) return this.tg.send(msg.chat.id, fixed, { replyTo: msg.message_id });
    // ANSWER_ALL: every group message goes to Claude. Without the wake word Claude may answer "-" (plain chatter), then stay silent.
    return this.converse(msg, this.stripTrigger(text), addressed ? {} : { silentIfDash: true, unaddressed: text });
  }

  async onMembership(m) {
    const added = ['member', 'administrator'].includes(m.new_chat_member?.status);
    if (!added || m.chat.type === 'private') return;
    if (this.cfg.allowedChats.has(m.chat.id) && this.cfg.allowedUsers.has(m.from?.id)) {
      return this.tg.send(m.chat.id, 'שלום משפחה! 🏠 אני עוזר הבית. כתבו "בוט, עזרה" כדי לראות מה אני יודע לעשות.');
    }
    this.log.warn?.(`added to chat ${m.chat.id} (${m.chat.type}) by user ${m.from?.id}`);
    if (this.cfg.allowedChats.size === 0) {
      // Setup mode: stay, so /id works. Nothing else works until ALLOWED_CHAT_IDS is set.
      return this.tg.send(m.chat.id, `מצב הגדרה. מזהה הקבוצה: ${m.chat.id}`);
    }
    await this.tg.leave(m.chat.id);
  }

  isCommand(text, name) {
    const m = /^\/([a-z_]+)(?:@(\w+))?(?:\s|$)/i.exec(text.trim());
    return Boolean(m && m[1].toLowerCase() === name && (!m[2] || m[2].toLowerCase() === this.me?.username?.toLowerCase()));
  }

  isTriggered(msg, text) {
    if (msg.chat.type === 'private') return true;
    const t = text.trim();
    const uname = this.me?.username?.toLowerCase();
    if (/^\/[a-z_]+/i.test(t)) {
      const m = /^\/[a-z_]+@(\w+)/i.exec(t);
      return !m || m[1].toLowerCase() === uname;
    }
    if (uname && t.toLowerCase().includes(`@${uname}`)) return true;
    if (msg.reply_to_message?.from?.id === this.me?.id) return true;
    const first = t.split(/[\s,:!?.]+/u)[0];
    return this.cfg.wakeWords.includes(first);
  }

  stripTrigger(text) {
    let t = text.trim();
    const uname = this.me?.username;
    if (uname) t = t.replace(new RegExp(`@${uname}`, 'ig'), '').trim();
    const first = t.split(/[\s,:!?.]+/u)[0];
    if (this.cfg.wakeWords.includes(first)) t = t.slice(first.length).replace(/^[\s,:!?.]+/u, '');
    return t || 'שלום';
  }

  async fixedCommand(text) {
    const { db, cfg } = this;
    if (this.isCommand(text, 'start') || this.isCommand(text, 'help') || /^(עזרה|help)$/u.test(this.stripTrigger(text))) return HELP;
    if (this.isCommand(text, 'list')) return formatShopping(await db.openItems());
    if (this.isCommand(text, 'tasks')) return formatTasks(await db.openTasks(), cfg.tz);
    if (this.isCommand(text, 'reminders')) return formatReminders(await db.activeReminders(), cfg.tz);
    return null;
  }

  // Recent group chatter (GROUP_CONTEXT messages, 2 hours). It goes to Claude only with the next message for the bot,
  // so "בוט, תוסיף את זה" understands what "this" is. Only allowed family members get here.
  async recentChat(chatId, now = Date.now()) {
    return (await this.db.get(`chat:${chatId}`, [])).filter((m) => now - m.ts < CHAT_TTL_MS);
  }

  async rememberChat(msg, text) {
    if (msg.chat.type === 'private' || !this.cfg.groupContext) return;
    const recent = await this.recentChat(msg.chat.id);
    recent.push({ who: msg.from?.first_name ?? 'מישהו', text: text.slice(0, 300), ts: Date.now() });
    await this.db.set(`chat:${msg.chat.id}`, recent.slice(-this.cfg.groupContext));
  }

  // ---- free text -> Claude
  async converse(msg, text, { systemNote = false, silentIfDash = false, unaddressed = null } = {}) {
    const { db, cfg } = this;
    const chatId = msg.chat.id;
    const now = Date.now();
    const day = localDate(new Date(now), cfg.tz);
    const usage = await db.get(`usage:${day}`, { calls: 0 });
    if (usage.calls >= cfg.maxDailyCalls) {
      if (!silentIfDash) await this.tg.send(chatId, 'הגעתי למגבלת השימוש היומית. אפשר להשתמש ב-/list, /tasks ו-/reminders עד מחר.');
      return;
    }
    await db.bumpUsage(day, { calls: 1 });
    const user = msg.from?.first_name ?? 'מישהו';
    const userText = systemNote ? `[מערכת] ${text}` : `${user}: ${text}`;
    const loc = await db.get(`loc:${chatId}`);
    const ctx = {
      db, tz: cfg.tz, chatId, user, now,
      lastLocation: loc && now - loc.ts < LOCATION_TTL_MS ? loc : null,
    };
    const contextText = contextBlock({
      tz: cfg.tz, now, chatTitle: msg.chat.title, user, isGroup: msg.chat.type !== 'private', members: cfg.members,
      memoryTopics: await db.noteTopics(),
      recentChat: cfg.groupContext ? await this.recentChat(chatId, now) : [],
      unaddressed: unaddressed != null,
    });
    await this.tg.typing(chatId);
    let reply;
    try {
      const r = await this.claude.respond({ history: await db.history(chatId, 12 * 3600_000), userText, ctx, contextText });
      await db.bumpUsage(day, { input: r.usage.input, output: r.usage.output, searches: r.usage.searches ?? 0 });
      reply = r.text;
      if (r.toolCalls.some((c) => !c.ok)) this.log.warn?.('tool errors', JSON.stringify(r.toolCalls.filter((c) => !c.ok)));
    } catch (err) {
      this.log.error?.('claude failed', err.message);
      if (!silentIfDash || unaddressed != null) await this.tg.send(chatId, 'משהו השתבש אצלי. נסו שוב עוד רגע 🙏', { replyTo: msg.message_id });
      return;
    }
    if (silentIfDash && (!reply || reply.trim() === '-')) return unaddressed != null && this.rememberChat(msg, unaddressed);
    if (!reply) reply = '👍';
    await db.addHistory(chatId, 'user', userText, 24);
    await db.addHistory(chatId, 'assistant', reply, 24);
    await this.tg.send(chatId, reply, { replyTo: systemNote ? undefined : msg.message_id });
  }

  // ---- locations
  async onLocation(msg, isEdit) {
    const { db, cfg } = this;
    const { latitude: lat, longitude: lon } = msg.location;
    const user = msg.from?.first_name ?? 'מישהו';
    // Kept only as the last location of this chat; it expires after 30 minutes.
    await db.set(`loc:${msg.chat.id}`, { lat, lon, ts: Date.now(), user });
    const near = (await db.places())
      .filter((p) => p.lat != null && p.lon != null)
      .map((p) => ({ ...p, dist: distanceM({ lat, lon }, { lat: p.lat, lon: p.lon }) }))
      .filter((p) => p.dist <= p.radius_m)
      .sort((a, b) => a.dist - b.dist)[0];
    const isLive = Boolean(msg.location.live_period) || isEdit;
    if (!near) {
      if (!isLive) {
        await this.tg.send(msg.chat.id, 'קיבלתי את המיקום 📍 זה לא מקום שמור. כדי שאזהה אותו בפעם הבאה, השיבו להודעה הזו למשל: "תשמור את זה כקניון עזריאלי, סוג קניון".', { replyTo: msg.message_id });
      }
      return;
    }
    // Live location: say something only once per person, place and day.
    if (isLive && !(await db.markPlaceAlert(msg.from.id, near.id, localDate(new Date(), cfg.tz)))) return;
    const note = `${user} נמצא/ת עכשיו ליד "${near.name}"${near.kind ? ` (${near.kind})` : ''}. בדוק משימות פתוחות ורשימות קניות, ` +
      'וכתוב הודעה קצרה עם מה שאפשר לעשות או לקנות במקום הזה. ' +
      (isLive ? 'אם אין שום דבר רלוונטי, ענה רק "-".' : 'אם אין שום דבר רלוונטי, אמור את זה במשפט אחד.');
    return this.converse(msg, note, { systemNote: true, silentIfDash: isLive });
  }

  // ---- scheduler: reminders and the morning summary. Call it every minute.
  async tick(now = Date.now()) {
    const { db, cfg } = this;
    for (const r of await db.dueReminders(now)) {
      // Move the reminder forward before the send, so a crash never sends it twice.
      const next = r.rule ? nextOccurrence(r.rule, r.start_local, now, cfg.tz) : null;
      await db.advanceReminder(r.id, next);
      const task = r.task_id ? await db.task(r.task_id) : null;
      if (task?.done_at) continue;
      const late = now - r.next_at > 15 * 60_000 ? ` (באיחור, היה ל-${formatHe(r.next_at, cfg.tz)})` : '';
      try {
        await this.tg.send(r.chat_id, `⏰ תזכורת: ${r.text}${late}`);
      } catch (err) {
        this.log.error?.('reminder send failed', r.id, err.message);
      }
    }
    if (cfg.digestTime && cfg.mainChat) {
      const p = localParts(new Date(now), cfg.tz);
      const [h, m] = cfg.digestTime.split(':').map(Number);
      const day = localDate(new Date(now), cfg.tz);
      if (p.hh * 60 + p.mm >= h * 60 + m && (await db.get('digest:last')) !== day) {
        await db.set('digest:last', day);
        const text = formatDigest({ tasks: await db.openTasks(), reminders: await db.activeReminders(), items: await db.openItems() }, cfg.tz, now);
        if (text) await this.tg.send(cfg.mainChat, text).catch((e) => this.log.error?.('digest failed', e.message));
      }
    }
  }
}

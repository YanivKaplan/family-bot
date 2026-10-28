// Update handling: who may talk to the bot, when it answers, locations, reminders.
// Runs the same on Cloudflare Workers (webhook + cron) and on Node (long polling).
import { Claude } from './claude.mjs';
import { contextBlock } from './prompt.mjs';
import { HELP, formatLists, formatReminders, formatDigest, formatReminderList, reminderButtons } from './format.mjs';
import { startOrder } from './order.mjs';
import { SCAN_KEY, weeklyScan, againOrder } from './yummi.mjs';
import { localDate, localDateTime, localParts, zonedToUtc, nextOccurrence, distanceM, formatHe } from './time.mjs';
import { GoogleCalendar, pullCalendar, connectLink, isConnected } from './calendar.mjs';

const LOCATION_TTL_MS = 30 * 60_000;
const CHAT_TTL_MS = 2 * 3600_000;

export class FamilyBot {
  constructor({ config, db, telegram, claude, calendar, log = console }) {
    this.cfg = config;
    this.db = db;
    this.tg = telegram;
    this.calendar = calendar ?? (config.calendar ? new GoogleCalendar({ ...config.calendar, tz: config.tz, db }) : null);
    this.claude = claude ?? new Claude({
      apiKey: config.anthropicKey, model: config.model, baseUrl: config.anthropicBaseUrl,
      maxTokens: config.maxTokens, webSearch: config.webSearch, calendar: Boolean(this.calendar),
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
    if (update.callback_query) return this.onButton(update.callback_query);
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
    if (!this.isTriggered(msg, text)) return this.rememberChat(msg, text); // not for the bot: no answer, kept only as context

    const fixed = await this.fixedCommand(text, msg);
    if (fixed) return this.tg.send(msg.chat.id, fixed, { replyTo: msg.message_id });
    return this.converse(msg, this.stripTrigger(text));
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

  async fixedCommand(text, msg) {
    const { db, cfg } = this;
    if (this.isCommand(text, 'start') || this.isCommand(text, 'help') || /^(עזרה|help)$/u.test(this.stripTrigger(text))) return HELP;
    if (this.isCommand(text, 'list') || this.isCommand(text, 'tasks')) return formatLists(await db.entries(), cfg.tz);
    if (this.isCommand(text, 'reminders')) return formatReminders(await db.activeReminders(), cfg.tz);
    if (this.isCommand(text, 'calendar')) return this.calendarCommand(msg);
    return null;
  }

  // /calendar: a one-time Google sign-in link, sent only in a private chat (it connects the family account).
  async calendarCommand(msg) {
    const { db, cfg } = this;
    if (!cfg.calendar) return 'יומן גוגל לא מוגדר בבוט (GOOGLE_CLIENT_ID ו-GOOGLE_CLIENT_SECRET).';
    if (!cfg.publicUrl) return 'חסרה הכתובת של הבוט (PUBLIC_URL), אז אי אפשר לחבר את היומן.';
    const status = (await isConnected(db)) ? 'היומן כבר מחובר ✅ אפשר לחבר מחדש (למשל לחשבון אחר).' : 'היומן עוד לא מחובר.';
    if (msg.chat.type !== 'private') return `${status}\nכדי לחבר, שלחו לי /calendar בצ'אט פרטי.`;
    return `${status}\nלחיבור יומן גוגל, פתחו את הקישור והתחברו לחשבון של היומן המשפחתי (תקף ל-15 דקות, פעם אחת):\n${await connectLink(db, { ...cfg.calendar, publicUrl: cfg.publicUrl }, msg.chat.id)}`;
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
  async converse(msg, text, { systemNote = false, silentIfDash = false } = {}) {
    const { db, cfg } = this;
    const chatId = msg.chat.id;
    const now = Date.now();
    const day = localDate(new Date(now), cfg.tz);
    const usage = await db.get(`usage:${day}`, { calls: 0 });
    if (usage.calls >= cfg.maxDailyCalls) {
      if (!silentIfDash) await this.tg.send(chatId, 'הגעתי למגבלת השימוש היומית. אפשר להשתמש ב-/list ו-/reminders עד מחר.');
      return;
    }
    await db.bumpUsage(day, { calls: 1 });
    const user = msg.from?.first_name ?? 'מישהו';
    const userText = systemNote ? `[מערכת] ${text}` : `${user}: ${text}`;
    const loc = await db.get(`loc:${chatId}`);
    const ctx = {
      db, tz: cfg.tz, chatId, user, now, ordersEnabled: Boolean(cfg.shopperSecret), calendar: this.calendar,
      lastLocation: loc && now - loc.ts < LOCATION_TTL_MS ? loc : null,
    };
    const contextText = contextBlock({
      tz: cfg.tz, now, chatTitle: msg.chat.title, user, isGroup: msg.chat.type !== 'private', members: cfg.members,
      memoryTopics: await db.noteTopics(),
      recentChat: cfg.groupContext ? await this.recentChat(chatId, now) : [],
    });
    await this.tg.typing(chatId);
    let reply;
    try {
      const r = await this.claude.respond({ history: await db.history(chatId, 12 * 3600_000), userText, ctx, contextText });
      // input counts all input tokens; cache_read / cache_write show how much of it came from the prompt cache.
      await db.bumpUsage(day, { input: r.usage.input, output: r.usage.output, cache_read: r.usage.cache_read ?? 0, cache_write: r.usage.cache_write ?? 0, searches: r.usage.searches ?? 0 });
      reply = r.text;
      if (r.toolCalls.some((c) => !c.ok)) this.log.warn?.('tool errors', JSON.stringify(r.toolCalls.filter((c) => !c.ok)));
    } catch (err) {
      this.log.error?.('claude failed', err.message);
      if (!silentIfDash) await this.tg.send(chatId, 'משהו השתבש אצלי. נסו שוב עוד רגע 🙏', { replyTo: msg.message_id });
      return;
    }
    if (silentIfDash && (!reply || reply.trim() === '-')) return;
    if (!reply) reply = '👍';
    await db.addHistory(chatId, 'user', userText, 24);
    await db.addHistory(chatId, 'assistant', reply, 24);
    await this.tg.send(chatId, reply, { replyTo: systemNote ? undefined : msg.message_id });
  }

  // ---- buttons under a reminder: done / in an hour / tomorrow / fill the Carrefour cart. No Claude call.
  async onButton(q) {
    const { db, cfg } = this;
    const msg = q.message;
    if (!msg?.chat || !this.isAllowed(msg.chat, q.from)) return this.tg.answerCallback(q.id);
    if (/^y:/.test(q.data ?? '')) return this.onMealsButton(q);
    const m = /^r:(\d+):(done|h1|d1|order)$/.exec(q.data ?? '');
    const r = m && await db.reminder(m[1]);
    if (!r || r.chat_id !== msg.chat.id) return this.tg.answerCallback(q.id, 'התזכורת הזו כבר לא קיימת');
    const user = q.from.first_name ?? 'מישהו';
    const now = Date.now();
    let line;
    if (m[2] === 'done') {
      // A task's reminder closes the task (and its other reminders). Reminders that wait for this one go out.
      if (r.task_id && await db.entry(r.task_id)) await db.updateEntry(r.task_id, { done: true }, user, now);
      await db.markReminderDone(r.id, now);
      line = `✅ בוצע ע"י ${user}`;
    } else if (m[2] === 'order') {
      // The button under the list is the confirmation: the open entries of that list go to the shopper as they are now.
      if (!cfg.shopperSecret || !r.list) return this.tg.answerCallback(q.id, 'הזמנה אונליין לא מוגדרת');
      let job;
      try {
        job = await startOrder(db, { chatId: r.chat_id, by: user, entries: await db.entries({ list: r.list }) }, now);
      } catch (err) {
        return this.tg.answerCallback(q.id, err.message);
      }
      line = `🛒 ${user} שלח/ה ${job.items.length} פריטים מ${r.list} לרובוט של קרפור. הוא יכתוב כאן כשהסל מוכן.`;
    } else {
      // Snooze = a new one-time copy; a repeating reminder keeps its rule and its calendar link.
      const p = localParts(new Date(now), cfg.tz);
      const at = m[2] === 'h1' ? now + 3600_000 : zonedToUtc({ ...p, d: p.d + 1 }, cfg.tz);
      const copy = await db.addReminder({
        chat_id: r.chat_id, text: r.text, start_local: localDateTime(new Date(at), cfg.tz), next_at: at, rule: null, task_id: r.task_id,
        list: r.list, offer_order: r.offer_order,
      }, user, now);
      if (!r.rule) await db.moveWaiters(r.id, copy.id);
      line = `⏰ נדחה ל${formatHe(at, cfg.tz)} ע"י ${user}`;
    }
    await this.tg.editText(msg.chat.id, msg.message_id, `${msg.text ?? ''}\n${line}`);
    return this.tg.answerCallback(q.id);
  }

  // ---- buttons under the weekly יאמי suggestion: the same again / choose meals (a talk with Claude) / not this week.
  async onMealsButton(q) {
    const { db, cfg } = this;
    const msg = q.message;
    const m = /^y:(\d+):(again|pick|skip)$/.exec(q.data);
    const scan = await db.get(SCAN_KEY);
    if (!m || !scan || String(scan.id) !== m[1]) return this.tg.answerCallback(q.id, 'ההצעה הזו כבר לא בתוקף');
    const user = q.from.first_name ?? 'מישהו';
    let line;
    if (m[2] === 'again') {
      if (!cfg.shopperSecret || !scan.last_order?.meals.length) return this.tg.answerCallback(q.id, 'הזמנה אונליין לא מוגדרת');
      try {
        await startOrder(db, { chatId: msg.chat.id, by: user, ...againOrder(scan) });
      } catch (err) {
        return this.tg.answerCallback(q.id, err.message);
      }
      line = `🔁 ${user} ביקש/ה אותו דבר. הרובוט ממלא את הסל ביאמי ויכתוב כאן כשהוא מוכן.`;
    } else if (m[2] === 'skip') {
      line = `🙅 לא השבוע (${user})`;
    } else {
      line = `🍲 ${user} בוחר/ת מנות`;
    }
    await this.tg.editText(msg.chat.id, msg.message_id, `${msg.text ?? ''}\n\n${line}`);
    await this.tg.answerCallback(q.id);
    if (m[2] === 'pick') {
      const note = `${user} לחץ/ה "לבחור מנות" בהצעה השבועית של יאמי. קרא ל-meals_menu, הצע בקצרה 2–3 כיוונים מהתפריט ` +
        '(לפי מה שהזמינו בעבר והבחירות בדילים), ושאל מה מתאים להם השבוע.';
      await this.converse({ chat: msg.chat, from: q.from }, note, { systemNote: true });
    }
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

  // ---- scheduler: calendar changes, reminders and the morning summary. Call it every minute.
  async tick(now = Date.now()) {
    const { db, cfg } = this;
    // First the calendar, so a reminder moved there does not fire at its old time.
    if (this.calendar) {
      try {
        const { errors } = await pullCalendar(db, this.calendar, now);
        if (errors.length) this.log.warn?.('calendar sync', JSON.stringify(errors));
      } catch (err) {
        this.log.error?.('calendar sync failed', err.message);
      }
    }
    for (const r of await db.dueReminders(now)) {
      // Move the reminder forward before the send, so a crash never sends it twice.
      const next = r.rule ? nextOccurrence(r.rule, r.start_local, now, cfg.tz) : null;
      await db.advanceReminder(r.id, next, now);
      const entry = r.task_id ? await db.entry(r.task_id) : null;
      if (entry?.done_at) continue;
      const late = now - r.next_at > 15 * 60_000 ? ` (באיחור, היה ל-${formatHe(r.next_at, cfg.tz)})` : '';
      // A reminder with a list shows that list as it is now, not as it was when the reminder was set.
      const listed = r.list ? await db.entries({ list: r.list }) : [];
      const text = `⏰ תזכורת: ${r.text}${late}` + (r.list ? `\n\n${formatReminderList(r.list, listed, localDate(new Date(now), cfg.tz))}` : '');
      const order = Boolean(r.offer_order && cfg.shopperSecret && listed.length);
      try {
        await this.tg.send(r.chat_id, text, { buttons: reminderButtons(r.id, { order }) });
      } catch (err) {
        this.log.error?.('reminder send failed', r.id, err.message);
      }
    }
    // The weekly יאמי suggestion: the shopper reads the account first, and its report sends the message.
    if (cfg.yummiWeekly && cfg.shopperSecret && cfg.mainChat) {
      await weeklyScan(db, { weekly: cfg.yummiWeekly, tz: cfg.tz, chatId: cfg.mainChat }, now).catch((e) => this.log.error?.('yummi weekly', e.message));
    }
    if (cfg.digestTime && cfg.mainChat) {
      const p = localParts(new Date(now), cfg.tz);
      const [h, m] = cfg.digestTime.split(':').map(Number);
      const day = localDate(new Date(now), cfg.tz);
      if (p.hh * 60 + p.mm >= h * 60 + m && (await db.get('digest:last')) !== day) {
        await db.set('digest:last', day);
        const text = formatDigest({ entries: await db.entries(), reminders: await db.activeReminders() }, cfg.tz, now);
        if (text) await this.tg.send(cfg.mainChat, text).catch((e) => this.log.error?.('digest failed', e.message));
      }
    }
  }
}

// The tools that Claude can call. Each tool changes only household data in the DB.
import { localToUtc, parseLocal, formatHe, nextOccurrence, localDate } from './time.mjs';
import { startOrder } from './order.mjs';
import { pushItem, removeItem, afterChange, importEvent, eventView, addEvent, updateEvent, deleteEvent } from './calendar.mjs';

const ids = { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 50 };
const REPEAT = {
  type: 'object',
  properties: {
    freq: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
    interval: { type: 'integer', minimum: 1, maximum: 52 },
    days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
  },
  required: ['freq'],
};
const REMINDER_EXTRAS = {
  list: { type: 'string', description: 'שם רשימה: כשהתזכורת נשלחת מצורפים אליה הפריטים הפתוחים ברשימה באותו רגע' },
  offer_order: { type: 'boolean', description: 'עם list של קניות: כפתור "למלא סל בקרפור" מתחת לתזכורת' },
  after_id: { type: 'integer', description: 'id של תזכורת אחרת: זו מחכה עד שהיא מסומנת בוצע (לא נשלחת ולא בסיכום הבוקר עד אז)' },
};

export const TOOLS = [
  {
    name: 'list_add',
    description: 'הוספת פריטים לרשימה כלשהי. רשימה היא כל שם: סופר, פארם, משימות, ציוד לתינוק, מטלות בית, מתנות... היא נוצרת לבד בפריט הראשון. ' +
      'fields = שדות חופשיים לפי מה שמתאים: qty (כמות), note (הערה), assignee (מי אחראי), due (מועד יעד: YYYY-MM-DD או YYYY-MM-DDTHH:MM), ' +
      'places (מערך: איפה אפשר לעשות/לקנות, למשל קניון, דואר, אונליין), או כל שדה אחר (מחיר, מידה, קישור...). ' +
      'אם אותו פריט כבר פתוח באותה רשימה, השדות שלו מתעדכנים במקום כפילות.',
    input_schema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array', minItems: 1, maxItems: 50,
          items: {
            type: 'object',
            properties: { list: { type: 'string' }, text: { type: 'string' }, fields: { type: 'object' } },
            required: ['list', 'text'],
          },
        },
      },
      required: ['entries'],
    },
  },
  {
    name: 'list_show',
    description: 'הפריטים הפתוחים בכל הרשימות (או ברשימה אחת), עם id ושדות, ושמות כל הרשימות. include_done=true מוסיף פריטים שנסגרו ב-7 הימים האחרונים. ' +
      'השתמש בזה גם כשמישהו אומר איפה הוא נמצא ("אנחנו בקניון"), ובחר בעצמך מה רלוונטי למקום.',
    input_schema: { type: 'object', properties: { list: { type: 'string' }, include_done: { type: 'boolean' } } },
  },
  {
    name: 'list_update',
    description: 'עריכת פריטים לפי id. text = שם חדש, list = העברה לרשימה אחרת, fields = שדות להוספה/שינוי (שדה עם null או "" נמחק, השאר נשארים), ' +
      'done=true סוגר (נקנה / בוצע / יש כבר; התזכורות שלו נעצרות), done=false מחזיר לפתוח. אותו שינוי חל על כל ה-ids.',
    input_schema: {
      type: 'object',
      properties: { ids, text: { type: 'string' }, list: { type: 'string' }, fields: { type: 'object' }, done: { type: 'boolean' } },
      required: ['ids'],
    },
  },
  {
    name: 'list_delete',
    description: 'מחיקה לגמרי: ids = פריטים (נוספו בטעות / לא רלוונטיים), או list = רשימה שלמה (רק בבקשה מפורשת). לפריט שנקנה או בוצע השתמש ב-list_update done=true.',
    input_schema: { type: 'object', properties: { ids, list: { type: 'string' } } },
  },
  {
    name: 'list_rename',
    description: 'שינוי שם של רשימה שלמה (או מיזוג לרשימה קיימת).',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
  },
  {
    name: 'reminder_add',
    description: 'תזכורת שתישלח לצ\'אט הזה בזמן מסוים. repeat לתזכורת חוזרת: freq daily/weekly/monthly/yearly, interval (כל כמה), days לשבועי (0=ראשון ... 6=שבת). entry_id לקשר לפריט ברשימה (התזכורת נעצרת כשהוא נסגר). ' +
      'list = לצרף לתזכורת את הרשימה העדכנית ברגע השליחה; offer_order = גם כפתור למילוי סל בקרפור; after_id = לחכות לתזכורת אחרת שתבוצע.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string' }, at: { type: 'string', description: 'זמן מקומי YYYY-MM-DDTHH:MM' },
        repeat: REPEAT,
        entry_id: { type: 'integer' },
        ...REMINDER_EXTRAS,
      },
      required: ['text', 'at'],
    },
  },
  {
    name: 'reminders_show',
    description: 'כל התזכורות הפעילות, עם id והמועד הבא. waiting = מחכה לתזכורת after_id שתבוצע. ' +
      'include_fired=true מוסיף תזכורות שנשלחו ב-7 הימים האחרונים (גם חד-פעמיות שכבר לא פעילות), מתי נשלחו ואם סומנו בוצע.',
    input_schema: { type: 'object', properties: { include_fired: { type: 'boolean' } } },
  },
  {
    name: 'reminder_update',
    description: 'עריכת תזכורת פעילה לפי id: טקסט, זמן (at), חזרה (repeat), list / offer_order / after_id. שלח רק את מה שמשתנה. repeat_off=true הופך אותה לחד-פעמית, ' +
      'list="" מוריד את הרשימה, after_off=true מבטל את ההמתנה. done=true מסמן שהתזכורת בוצעה (גם אם כבר נשלחה), ותזכורות שחיכו לה יוצאות.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' }, text: { type: 'string' }, at: { type: 'string', description: 'זמן מקומי YYYY-MM-DDTHH:MM' },
        repeat: REPEAT, repeat_off: { type: 'boolean' }, ...REMINDER_EXTRAS, after_off: { type: 'boolean' }, done: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'reminder_cancel',
    description: 'ביטול תזכורות לפי id.',
    input_schema: { type: 'object', properties: { ids }, required: ['ids'] },
  },
  {
    name: 'place_save',
    description: 'שמירת מקום בשם (למשל "קניון הזהב"). לעריכת מקום קיים (גם שינוי שם) שלח id, עם סוג (קניון, סופר, דואר...) ואם ידוע גם קואורדינטות מהמיקום האחרון ששותף בצ\'אט. אחר כך, כשמישהו משתף מיקום ליד המקום, הבוט יודע איפה הוא.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' }, name: { type: 'string' }, kind: { type: 'string' },
        use_last_location: { type: 'boolean', description: 'true = לקחת את הקואורדינטות מהמיקום האחרון שנשלח בצ\'אט' },
        radius_m: { type: 'integer', minimum: 50, maximum: 3000 },
      },
      required: ['name'],
    },
  },
  {
    name: 'places_show',
    description: 'המקומות השמורים.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'place_delete',
    description: 'מחיקת מקומות שמורים לפי id.',
    input_schema: { type: 'object', properties: { ids }, required: ['ids'] },
  },
  {
    name: 'memory_save',
    description: 'שמירת עובדה, החלטה או מידע של הבית בזיכרון הקבוע (למשל: תקציב חודשי לאוכל, טלפון של האינסטלטור, מידות של הנעליים של הילדים, החלטה על חיסכון). topic = נושא קצר (כסף, ילדים, בית, רכב, בריאות, אנשי קשר...). לעדכון רשומה קיימת שלח id. שמור רק מה שבני המשפחה אמרו או ביקשו לשמור.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer' }, topic: { type: 'string' }, text: { type: 'string' } },
      required: ['topic', 'text'],
    },
  },
  {
    name: 'memory_show',
    description: 'קריאת הזיכרון הקבוע של הבית (כל הנושאים, או נושא אחד). קרא את זה לפני שיחה על נושא שאולי שמור עליו מידע (למשל לפני שיחה על הוצאות: topic=כסף).',
    input_schema: { type: 'object', properties: { topic: { type: 'string' } } },
  },
  {
    name: 'memory_delete',
    description: 'מחיקת רשומות מהזיכרון לפי id, רק לבקשה מפורשת.',
    input_schema: { type: 'object', properties: { ids }, required: ['ids'] },
  },
  {
    name: 'order_start',
    description: 'הזמנת קניות אונליין מקרפור: רובוט במחשב של הבית ממלא את סל הקניות באתר, עוצר לפני התשלום, ושולח לצ\'אט הזה קישור לתשלום. ' +
      'קרא רק אחרי שהצגת את הרשימה ובני המשפחה אישרו במפורש בהודעה נפרדת שהיא מלאה. entry_ids = הפריטים שאושרו.',
    input_schema: { type: 'object', properties: { entry_ids: ids, store: { type: 'string', enum: ['carrefour'] } }, required: ['entry_ids'] },
  },
  {
    name: 'calendar_show',
    description: 'האירועים ביומן גוגל המשפחתי בין שני תאריכים (עד 62 יום), אפשר עם q לחיפוש טקסט. לכל אירוע id; אירוע חוזר מוצג כמופעים, ' +
      'וב-series_id יש את הסדרה כולה. linked = תזכורות או פריטים שמקושרים אליו.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD, ברירת מחדל = from' },
        q: { type: 'string', description: 'חיפוש בכותרת, תיאור ומקום' },
      },
      required: ['from'],
    },
  },
  {
    name: 'calendar_add',
    description: 'אירוע חדש ביומן גוגל (פגישה, תור, אירוע משפחתי). start/end בזמן מקומי: YYYY-MM-DDTHH:MM, או YYYY-MM-DD ליום שלם (end כולל). ' +
      'בלי end: שעה אחת, או יום אחד. repeat לאירוע חוזר. אם רוצים גם תזכורת בצ\'אט, אחר כך calendar_import.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, location: { type: 'string' }, description: { type: 'string' }, repeat: REPEAT,
      },
      required: ['title', 'start'],
    },
  },
  {
    name: 'calendar_update',
    description: 'עריכת כל אירוע ביומן לפי event_id (id של מופע אחד, או series_id לכל הסדרה). שלח רק מה שמשתנה; start בלבד שומר על האורך. ' +
      '"" מוחק מקום או תיאור. repeat / repeat_off רק על סדרה או אירוע רגיל. תזכורות ופריטים שמקושרים לאירוע מתעדכנים איתו.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string' }, title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
        location: { type: 'string' }, description: { type: 'string' }, repeat: REPEAT, repeat_off: { type: 'boolean' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'calendar_delete',
    description: 'מחיקת אירועים מהיומן לפי event_ids (מופע אחד או series_id לכל הסדרה). רק לבקשה מפורשת. תזכורות שמקושרות לאירוע מתבטלות.',
    input_schema: { type: 'object', properties: { event_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 } }, required: ['event_ids'] },
  },
  {
    name: 'calendar_sync',
    description: 'סנכרון תזכורות ופריטים ליומן גוגל, רק כשמבקשים: כל אחד מקבל אירוע ביומן (פריט צריך due). מאז הם מסונכרנים בשני הכיוונים: ' +
      'שינוי, סגירה או ביטול בבוט מעדכנים את האירוע, ושינוי ביומן (כותרת, זמן, חזרה, ✅ בתחילת הכותרת = בוצע, מחיקה) חוזר לבוט. off=true מוריד מהיומן.',
    input_schema: { type: 'object', properties: { reminder_ids: ids, entry_ids: ids, off: { type: 'boolean' } } },
  },
  {
    name: 'calendar_import',
    description: 'אירוע שכבר ביומן (id מ-calendar_show) → תזכורת בצ\'אט הזה (as=reminder; minutes_before = כמה דקות לפני, באירוע של יום שלם הבסיס הוא 09:00 באותו יום) ' +
      'או פריט ברשימה (as=entry, list). הם עוקבים אחרי האירוע: הוא זז – הם זזים, הוא נמחק – התזכורת מתבטלת. ביטול התזכורת לא מוחק את האירוע. ' +
      'אפשר כמה תזכורות לאותו אירוע (למשל יום לפני ושעה לפני).',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string' }, as: { type: 'string', enum: ['reminder', 'entry'] },
        minutes_before: { type: 'integer', minimum: 0, maximum: 43_200 }, list: { type: 'string' },
      },
      required: ['event_id'],
    },
  },
];

// Server tool: Anthropic runs the search. Billed per search ($10 per 1,000).
export const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 3,
  // ponytail: API rejects country 'IL'; timezone alone still biases results local.
  user_location: { type: 'approximate', timezone: 'Asia/Jerusalem' },
};

// What Claude sees for one entry. Overdue is computed from fields.due (local time).
function entryView(e, today) {
  const v = { id: e.id, list: e.list, text: e.text, ...e.fields, by: e.created_by ?? undefined };
  if (e.done_at) Object.assign(v, { done: true, done_by: e.done_by ?? undefined });
  else if (e.fields.due && e.fields.due.slice(0, 10) < today) v.overdue = true;
  return v;
}

// What Claude sees for one reminder.
function reminderView(r, tz) {
  return {
    id: r.id, text: r.text, next: r.active ? formatHe(r.next_at, tz) : undefined, repeat: r.rule ?? undefined, entry_id: r.task_id ?? undefined,
    list: r.list ?? undefined, offer_order: r.offer_order ? true : undefined, after_id: r.after_id ?? undefined, waiting: r.waiting ? true : undefined,
    last_sent: r.fired_at ? formatHe(r.fired_at, tz) : undefined, done: r.done_at ? true : undefined,
  };
}

// The first time a reminder fires: `at` itself, or for a repeat the first matching time from `at` that is not in the past.
function firstRun(at, repeat, now, tz) {
  if (!parseLocal(at).hasTime) throw new Error('לתזכורת צריך שעה: YYYY-MM-DDTHH:MM');
  const first = localToUtc(at, tz);
  let nextAt = first;
  if (repeat) {
    nextAt = nextOccurrence(repeat, at, first - 60_000, tz);
    if (!nextAt) throw new Error('לא מצאתי מועד שמתאים לחזרה');
  }
  if (nextAt <= now) {
    if (!repeat) throw new Error(`הזמן ${at} כבר עבר`);
    nextAt = nextOccurrence(repeat, at, now, tz);
  }
  return nextAt;
}

function needCalendar(ctx) {
  if (!ctx.calendar) throw new Error('יומן גוגל לא מוגדר בבוט');
  return ctx.calendar;
}

// After a change in the bot, linked calendar events follow. A calendar error does not undo the change in the bot.
async function followCalendar(ctx, out, kind, ids) {
  if (!ctx.calendar) return out;
  try {
    await afterChange(ctx.db, ctx.calendar, kind, ids);
  } catch (err) {
    out.calendar_error = err.message;
  }
  return out;
}

// Ids of the items of one kind that are in the calendar (empty without a calendar).
const inCalendar = async (ctx, kind) => new Set(ctx.calendar ? (await ctx.db.calendarLinks(kind)).map((l) => l.item_id) : []);

/**
 * ctx: { db, tz, chatId, user, now, lastLocation, ordersEnabled, calendar }
 * Returns a JSON-serializable result. Throws Error with a Hebrew message on bad input.
 */
export async function runTool(name, input, ctx) {
  const { db, tz, chatId, user } = ctx;
  const now = ctx.now ?? Date.now();
  const today = localDate(new Date(now), tz);
  switch (name) {
    case 'list_add':
      return { added: (await db.addEntries(input.entries, user, now)).map((e) => entryView(e, today)) };
    case 'list_show': {
      const cal = await inCalendar(ctx, 'entry');
      const view = (e) => ({ ...entryView(e, today), ...(cal.has(e.id) ? { calendar: true } : {}) });
      const out = { today, lists: await db.lists(), open: (await db.entries({ list: input.list })).map(view) };
      if (input.include_done) out.done_last_7_days = (await db.entries({ list: input.list, doneSince: now - 7 * 86_400_000 })).map(view);
      return out;
    }
    case 'list_update': {
      const out = [];
      for (const id of input.ids) out.push(entryView(await db.updateEntry(id, input, user, now), today));
      return followCalendar(ctx, { updated: out }, 'entry', input.ids);
    }
    case 'list_delete':
      if (input.ids?.length) return followCalendar(ctx, { deleted_ids: await db.deleteEntries(input.ids) }, 'entry', input.ids);
      if (input.list) return followCalendar(ctx, { deleted: await db.deleteList(input.list) }, 'entry');
      throw new Error('צריך ids או list');
    case 'list_rename':
      return { moved: await db.renameList(input.from, input.to) };
    case 'reminder_add': {
      const nextAt = firstRun(input.at, input.repeat, now, tz);
      if (input.entry_id && !(await db.entry(input.entry_id))) throw new Error(`אין פריט ${input.entry_id}`);
      const r = await db.addReminder({
        chat_id: chatId, text: input.text, start_local: input.at, next_at: nextAt, rule: input.repeat ?? null, task_id: input.entry_id,
        list: input.list, offer_order: input.offer_order, after_id: input.after_id,
      }, user, now);
      return { reminder: reminderView(r, tz) };
    }
    case 'reminders_show': {
      const cal = await inCalendar(ctx, 'reminder');
      const out = { reminders: (await db.activeReminders()).map((r) => ({ ...reminderView(r, tz), calendar: cal.has(r.id) || undefined })) };
      if (input.include_fired) out.sent_last_7_days = (await db.firedReminders(now - 7 * 86_400_000)).map((r) => reminderView(r, tz));
      return out;
    }
    case 'reminder_update': {
      const old = await db.reminder(input.id);
      // done works also on a one-time reminder that was already sent (it is no longer active).
      if (input.done) {
        if (!old) throw new Error(`אין תזכורת ${input.id}`);
        if (old.task_id && await db.entry(old.task_id)) await db.updateEntry(old.task_id, { done: true }, user, now);
        const r = await db.markReminderDone(old.id, now);
        return followCalendar(ctx, { reminder: reminderView(r, tz) }, 'reminder', [r.id]);
      }
      if (!old?.active) throw new Error(`אין תזכורת פעילה ${input.id}`);
      const rule = input.repeat_off ? null : input.repeat ?? old.rule;
      const at = input.at ?? old.start_local;
      const timing = input.at !== undefined || input.repeat !== undefined || input.repeat_off
        ? { start_local: at, next_at: firstRun(at, rule, now, tz), rule } : {};
      const r = await db.updateReminder(input.id, {
        text: input.text, ...timing, list: input.list, offer_order: input.offer_order, after_id: input.after_off ? null : input.after_id,
      });
      return followCalendar(ctx, { reminder: reminderView(r, tz) }, 'reminder', [r.id]);
    }
    case 'reminder_cancel':
      return followCalendar(ctx, { cancelled_ids: await db.cancelReminders(input.ids) }, 'reminder', input.ids);
    case 'place_save': {
      const loc = input.use_last_location ? ctx.lastLocation : null;
      if (input.use_last_location && !loc) throw new Error('לא שותף מיקום בצ\'אט הזה לאחרונה');
      return { place: await db.savePlace({ id: input.id, name: input.name, kind: input.kind, lat: loc?.lat, lon: loc?.lon, radius_m: input.radius_m }) };
    }
    case 'place_delete':
      return { deleted_ids: await db.deletePlaces(input.ids) };
    case 'places_show':
      return { places: await db.places() };
    case 'memory_save':
      return { saved: await db.saveNote(input, user, now) };
    case 'memory_show': {
      const notes = await db.notes(input.topic || undefined);
      return { count: notes.length, notes };
    }
    case 'memory_delete':
      return { deleted_ids: await db.deleteNotes(input.ids) };
    case 'order_start': {
      if (!ctx.ordersEnabled) throw new Error('הזמנה אונליין עוד לא מוגדרת בבוט');
      const entries = [];
      for (const id of input.entry_ids) {
        const e = await db.entry(id);
        if (!e || e.done_at) throw new Error(`אין פריט פתוח ${id}`);
        entries.push(e);
      }
      const job = await startOrder(db, { chatId, by: user, store: input.store, entries }, now);
      return { order: { id: job.id, items: job.items.length, status: 'נשלח לרובוט; הוא יכתוב כאן כשהסל מוכן' } };
    }
    case 'calendar_show': {
      const cal = needCalendar(ctx);
      const links = await db.calendarLinks();
      return { events: (await cal.between(input.from, input.to ?? input.from, input.q)).map((e) => eventView(e, tz, links)) };
    }
    case 'calendar_add':
      return { added: await addEvent(db, needCalendar(ctx), input) };
    case 'calendar_update':
      return { updated: await updateEvent(db, needCalendar(ctx), input, now) };
    case 'calendar_delete': {
      const cal = needCalendar(ctx);
      const deleted = [], failed = [];
      for (const id of input.event_ids) {
        try {
          deleted.push(await deleteEvent(db, cal, id, now));
        } catch (err) {
          failed.push({ id, error: err.message });
        }
      }
      return { deleted, ...(failed.length ? { failed } : {}) };
    }
    case 'calendar_sync': {
      const cal = needCalendar(ctx);
      const items = [...(input.reminder_ids ?? []).map((id) => ['reminder', id]), ...(input.entry_ids ?? []).map((id) => ['entry', id])];
      if (!items.length) throw new Error('צריך reminder_ids או entry_ids');
      const done = [], failed = [];
      for (const [kind, id] of items) {
        try {
          if (!input.off) await pushItem(db, cal, kind, id);
          else {
            const link = await db.calendarLink(kind, id);
            if (link) await removeItem(db, cal, link);
          }
          done.push(`${kind} ${id}`);
        } catch (err) {
          failed.push({ item: `${kind} ${id}`, error: err.message });
        }
      }
      return { [input.off ? 'removed_from_calendar' : 'in_calendar']: done, ...(failed.length ? { failed } : {}) };
    }
    case 'calendar_import':
      return { imported: await importEvent(db, needCalendar(ctx), input, { chatId, user, now }) };
    default:
      throw new Error(`כלי לא מוכר: ${name}`);
  }
}

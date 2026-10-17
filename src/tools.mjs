// The tools that Claude can call. Each tool changes only household data in the DB.
import { localToUtc, parseLocal, formatHe, nextOccurrence, localDate } from './time.mjs';
import { startOrder } from './order.mjs';

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
    description: 'תזכורת שתישלח לצ\'אט הזה בזמן מסוים. repeat לתזכורת חוזרת: freq daily/weekly/monthly/yearly, interval (כל כמה), days לשבועי (0=ראשון ... 6=שבת). entry_id לקשר לפריט ברשימה (התזכורת נעצרת כשהוא נסגר).',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string' }, at: { type: 'string', description: 'זמן מקומי YYYY-MM-DDTHH:MM' },
        repeat: REPEAT,
        entry_id: { type: 'integer' },
      },
      required: ['text', 'at'],
    },
  },
  {
    name: 'reminders_show',
    description: 'כל התזכורות הפעילות, עם id והמועד הבא.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'reminder_update',
    description: 'עריכת תזכורת פעילה לפי id: טקסט, זמן (at), או חזרה (repeat). שלח רק את מה שמשתנה. repeat_off=true הופך אותה לחד-פעמית.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' }, text: { type: 'string' }, at: { type: 'string', description: 'זמן מקומי YYYY-MM-DDTHH:MM' },
        repeat: REPEAT, repeat_off: { type: 'boolean' },
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

/**
 * ctx: { db, tz, chatId, user, now, lastLocation }
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
      const out = { today, lists: await db.lists(), open: (await db.entries({ list: input.list })).map((e) => entryView(e, today)) };
      if (input.include_done) out.done_last_7_days = (await db.entries({ list: input.list, doneSince: now - 7 * 86_400_000 })).map((e) => entryView(e, today));
      return out;
    }
    case 'list_update': {
      const out = [];
      for (const id of input.ids) out.push(entryView(await db.updateEntry(id, input, user, now), today));
      return { updated: out };
    }
    case 'list_delete':
      if (input.ids?.length) return { deleted_ids: await db.deleteEntries(input.ids) };
      if (input.list) return { deleted: await db.deleteList(input.list) };
      throw new Error('צריך ids או list');
    case 'list_rename':
      return { moved: await db.renameList(input.from, input.to) };
    case 'reminder_add': {
      const nextAt = firstRun(input.at, input.repeat, now, tz);
      if (input.entry_id && !(await db.entry(input.entry_id))) throw new Error(`אין פריט ${input.entry_id}`);
      const r = await db.addReminder({ chat_id: chatId, text: input.text, start_local: input.at, next_at: nextAt, rule: input.repeat ?? null, task_id: input.entry_id }, user, now);
      return { reminder: { id: r.id, text: r.text, next: formatHe(r.next_at, tz), repeat: r.rule ?? undefined } };
    }
    case 'reminders_show':
      return {
        reminders: (await db.activeReminders()).map((r) => ({ id: r.id, text: r.text, next: formatHe(r.next_at, tz), repeat: r.rule ?? undefined, entry_id: r.task_id ?? undefined })),
      };
    case 'reminder_update': {
      const old = await db.reminder(input.id);
      if (!old?.active) throw new Error(`אין תזכורת פעילה ${input.id}`);
      const rule = input.repeat_off ? null : input.repeat ?? old.rule;
      const at = input.at ?? old.start_local;
      const timing = input.at !== undefined || input.repeat !== undefined || input.repeat_off
        ? { start_local: at, next_at: firstRun(at, rule, now, tz), rule } : {};
      const r = await db.updateReminder(input.id, { text: input.text, ...timing });
      return { reminder: { id: r.id, text: r.text, next: formatHe(r.next_at, tz), repeat: r.rule ?? undefined } };
    }
    case 'reminder_cancel':
      return { cancelled_ids: await db.cancelReminders(input.ids) };
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
    default:
      throw new Error(`כלי לא מוכר: ${name}`);
  }
}

// The tools that Claude can call. Each tool changes only household data in the DB.
import { localToUtc, parseLocal, formatHe, nextOccurrence, localDate } from './time.mjs';

const ids = { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 50 };
const LOCAL_DT = 'זמן מקומי בפורמט YYYY-MM-DDTHH:MM, או YYYY-MM-DD ליום בלי שעה';

export const TOOLS = [
  {
    name: 'shopping_add',
    description: 'הוספת פריטים לרשימת קניות. אם פריט כבר ברשימה, הכמות מתעדכנת. list = שם הרשימה (למשל: סופר, פארם, ירקן, בית מרקחת, חנות בניין). ברירת מחדל: סופר.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array', minItems: 1, maxItems: 50,
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, qty: { type: 'string' }, list: { type: 'string' }, note: { type: 'string' } },
            required: ['name'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'shopping_show',
    description: 'הצגת הפריטים הפתוחים ברשימות הקניות (כולן, או רשימה אחת). מחזיר id לכל פריט.',
    input_schema: { type: 'object', properties: { list: { type: 'string' } } },
  },
  {
    name: 'shopping_done',
    description: 'סימון פריטים כנקנו / הסרתם מהרשימה, לפי id. קרא קודם shopping_show אם אין לך את ה-id.',
    input_schema: { type: 'object', properties: { ids }, required: ['ids'] },
  },
  {
    name: 'shopping_clear',
    description: 'ניקוי כל רשימה אחת (למשל אחרי קנייה גדולה). רק כשהמשתמש ביקש במפורש.',
    input_schema: { type: 'object', properties: { list: { type: 'string' } }, required: ['list'] },
  },
  {
    name: 'task_add',
    description: 'הוספת משימה לבית. places = איפה אפשר לעשות אותה (למשל: קניון, דואר, סופר, בית מרקחת, עירייה, בבית, אונליין). assignee = מי אחראי (אם נאמר). due = מועד יעד.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' }, notes: { type: 'string' },
        places: { type: 'array', items: { type: 'string' } },
        assignee: { type: 'string' }, due: { type: 'string', description: LOCAL_DT },
      },
      required: ['title'],
    },
  },
  {
    name: 'task_update',
    description: 'עדכון משימה קיימת לפי id. שלח רק את השדות שמשתנים. due ריק ("") מוחק מועד.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' }, title: { type: 'string' }, notes: { type: 'string' },
        places: { type: 'array', items: { type: 'string' } }, assignee: { type: 'string' },
        due: { type: 'string', description: LOCAL_DT },
      },
      required: ['id'],
    },
  },
  {
    name: 'task_done',
    description: 'סימון משימות כבוצעו, לפי id. התזכורות של המשימה נעצרות.',
    input_schema: { type: 'object', properties: { ids }, required: ['ids'] },
  },
  {
    name: 'tasks_show',
    description: 'כל המשימות הפתוחות (עם מקומות, אחראי ומועד), ובנוסף משימות שבוצעו ב-7 הימים האחרונים אם include_done=true. השתמש בזה גם כשמישהו אומר איפה הוא נמצא ("אנחנו בקניון"), ובחר בעצמך מה רלוונטי למקום.',
    input_schema: { type: 'object', properties: { include_done: { type: 'boolean' } } },
  },
  {
    name: 'reminder_add',
    description: 'תזכורת שתישלח לצ\'אט הזה בזמן מסוים. repeat לתזכורת חוזרת: freq daily/weekly/monthly/yearly, interval (כל כמה), days לשבועי (0=ראשון ... 6=שבת). task_id לקשר למשימה.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string' }, at: { type: 'string', description: 'זמן מקומי YYYY-MM-DDTHH:MM' },
        repeat: {
          type: 'object',
          properties: {
            freq: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
            interval: { type: 'integer', minimum: 1, maximum: 52 },
            days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
          },
          required: ['freq'],
        },
        task_id: { type: 'integer' },
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
    name: 'reminder_cancel',
    description: 'ביטול תזכורות לפי id.',
    input_schema: { type: 'object', properties: { ids }, required: ['ids'] },
  },
  {
    name: 'place_save',
    description: 'שמירת מקום בשם (למשל "קניון הזהב"), עם סוג (קניון, סופר, דואר...) ואם ידוע גם קואורדינטות מהמיקום האחרון ששותף בצ\'אט. אחר כך, כשמישהו משתף מיקום ליד המקום, הבוט יודע איפה הוא.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, kind: { type: 'string' },
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
];

// Server tool: Anthropic runs the search. Billed per search ($10 per 1,000).
export const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 3,
  user_location: { type: 'approximate', country: 'IL', timezone: 'Asia/Jerusalem' },
};

const fmtDue = (t, tz) => (t.due_at ? formatHe(t.due_at, tz, { withTime: !!t.due_has_time }) : null);

function taskView(t, tz, now = Date.now()) {
  return {
    id: t.id, title: t.title, notes: t.notes ?? undefined,
    places: t.places ? t.places.split(',') : [], assignee: t.assignee ?? undefined,
    due: fmtDue(t, tz) ?? undefined, overdue: t.due_at && !t.done_at && t.due_at < now ? true : undefined,
    done: t.done_at ? formatHe(t.done_at, tz) : undefined, done_by: t.done_by ?? undefined,
  };
}

function parseDue(due, tz) {
  if (due === undefined) return {};
  if (due === '' || due === null) return { due_at: null, due_has_time: 0 };
  const p = parseLocal(due);
  return { due_at: localToUtc(due, tz), due_has_time: p.hasTime ? 1 : 0 };
}

/**
 * ctx: { db, tz, chatId, user, now, lastLocation }
 * Returns a JSON-serializable result. Throws Error with a Hebrew message on bad input.
 */
export async function runTool(name, input, ctx) {
  const { db, tz, chatId, user } = ctx;
  const now = ctx.now ?? Date.now();
  switch (name) {
    case 'shopping_add':
      return { added: await db.addItems(input.items, user, now) };
    case 'shopping_show': {
      const items = await db.openItems(input.list || undefined);
      return { count: items.length, items };
    }
    case 'shopping_done':
      return { done_ids: await db.markItems(input.ids, now) };
    case 'shopping_clear':
      return { cleared: await db.clearList(input.list, now) };
    case 'task_add': {
      const t = await db.addTask({ ...input, ...parseDue(input.due, tz) }, user, now);
      return { task: taskView(t, tz, now) };
    }
    case 'task_update': {
      const { id, due, ...rest } = input;
      return { task: taskView(await db.updateTask(id, { ...rest, ...parseDue(due, tz) }), tz, now) };
    }
    case 'task_done':
      return { done_ids: await db.completeTasks(input.ids, user, now) };
    case 'tasks_show': {
      const open = (await db.openTasks()).map((t) => taskView(t, tz, now));
      const out = { today: localDate(new Date(now), tz), open };
      if (input.include_done) out.done_last_7_days = (await db.recentDone(now - 7 * 86_400_000)).map((t) => taskView(t, tz, now));
      return out;
    }
    case 'reminder_add': {
      const start = parseLocal(input.at);
      if (!start.hasTime) throw new Error('לתזכורת צריך שעה: YYYY-MM-DDTHH:MM');
      const first = localToUtc(input.at, tz);
      let nextAt = first;
      if (input.repeat) {
        // The first occurrence that matches the rule, from the given start.
        nextAt = nextOccurrence(input.repeat, input.at, first - 60_000, tz);
        if (!nextAt) throw new Error('לא מצאתי מועד שמתאים לחזרה');
      }
      if (nextAt <= now) {
        if (!input.repeat) throw new Error(`הזמן ${input.at} כבר עבר`);
        nextAt = nextOccurrence(input.repeat, input.at, now, tz);
      }
      if (input.task_id && !(await db.task(input.task_id))) throw new Error(`אין משימה ${input.task_id}`);
      const r = await db.addReminder({ chat_id: chatId, text: input.text, start_local: input.at, next_at: nextAt, rule: input.repeat ?? null, task_id: input.task_id }, user, now);
      return { reminder: { id: r.id, text: r.text, next: formatHe(r.next_at, tz), repeat: r.rule ?? undefined } };
    }
    case 'reminders_show':
      return {
        reminders: (await db.activeReminders()).map((r) => ({ id: r.id, text: r.text, next: formatHe(r.next_at, tz), repeat: r.rule ?? undefined, task_id: r.task_id ?? undefined })),
      };
    case 'reminder_cancel':
      return { cancelled_ids: await db.cancelReminders(input.ids) };
    case 'place_save': {
      const loc = input.use_last_location ? ctx.lastLocation : null;
      if (input.use_last_location && !loc) throw new Error('לא שותף מיקום בצ\'אט הזה לאחרונה');
      return { place: await db.savePlace({ name: input.name, kind: input.kind, lat: loc?.lat, lon: loc?.lon, radius_m: input.radius_m }) };
    }
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
    default:
      throw new Error(`כלי לא מוכר: ${name}`);
  }
}

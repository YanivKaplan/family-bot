// Meals from יאמי (yummi.co.il, home cooks). Once a week the shopper reads the family's account (the last order in
// "הזמנות שלי" and that cook's menu); the bot suggests ordering again, talks with the family about which meals to
// choose, and order_start sends the chosen meals to the shopper, which fills the cart and sends the payment link.
// The last reading is kept in kv (no new table).
import { startOrder } from './order.mjs';
import { localDate, localParts } from './time.mjs';

export const SCAN_KEY = 'yummi:scan';
const WEEKLY_KEY = 'yummi:weekly';
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const s = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

// "sun 10:00" -> { day: 0, minutes: 600 }; empty = no weekly suggestion.
export function parseWeekly(v) {
  if (!v) return null;
  const m = /^(sun|mon|tue|wed|thu|fri|sat)\s+(\d{2}):(\d{2})$/i.exec(String(v).trim());
  if (!m) throw new Error('YUMMI_WEEKLY must be like "sun 10:00" or empty');
  return { day: DAYS.indexOf(m[1].toLowerCase()), minutes: Number(m[2]) * 60 + Number(m[3]) };
}

// Called every minute: on the weekly day and time, ask the shopper to read the account once.
// When another order holds the shopper, it tries again on the next minute.
export async function weeklyScan(db, { weekly, tz, chatId }, now = Date.now()) {
  const p = localParts(new Date(now), tz);
  if (p.weekday !== weekly.day || p.hh * 60 + p.mm < weekly.minutes) return null;
  const day = localDate(new Date(now), tz);
  if ((await db.get(WEEKLY_KEY)) === day) return null;
  let job;
  try {
    job = await startOrder(db, { chatId, by: 'הבוט', store: 'yummi', kind: 'scan' }, now);
  } catch {
    return null;
  }
  await db.set(WEEKLY_KEY, day);
  return job;
}

// The details lines of an order (shopper/yummi.mjs): address, time, and each meal with its choices, qty and price.
export function parseOrder(lines = []) {
  const at = (label) => { const i = lines.indexOf(label); return i >= 0 ? lines[i + 1] : null; };
  const start = lines.indexOf('פרטי ההזמנה', 1) + 1;
  const end = lines.indexOf('סכום ביניים');
  const meals = [];
  let cur = null;
  for (const line of lines.slice(start || lines.length, end < 0 ? undefined : end)) {
    const qty = /^כמות\s*(\d+)$/.exec(line);
    if (!cur) cur = { text: line, qty: 1, choices: [] };
    else if (qty) cur.qty = Number(qty[1]);
    else if (/^₪/.test(line)) { cur.price = line.replace(/\s+/g, ''); meals.push(cur); cur = null; }
    else if (!/^מתאים ל/.test(line)) cur.choices.push(line);
  }
  return { address: at('לאן:'), when: at('למתי:'), meals };
}

// What the bot knows about יאמי, kept in kv: the account (recent orders, the last one in detail), and the last few
// menus and searches the shopper read, so the family can compare cooks and order from any of them.
const MAX_KEPT = 4;
export const MENU_FRESH_MS = 48 * 3_600_000;
export const SEARCH_FRESH_MS = 12 * 3_600_000;
const newest = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_KEPT));

// Merges one reading of the shopper (shopper/yummi.mjs), cleaned and capped, into the kept state.
export function mergeScan(prev, scan, jobId, now = Date.now()) {
  const o = scan?.last_order;
  const state = {
    id: jobId, at: now, city: s(scan?.city, 40) || prev?.city || null,
    orders: (scan?.orders ?? []).slice(0, 8).map((r) => ({ cook: s(r.cook, 80), date: s(r.date, 20), total: s(r.total, 20), cook_url: s(r.cook_url, 300) })),
    last_order: o ? { cook: s(o.cook, 80), date: s(o.date, 20), total: s(o.total, 20), cook_url: s(o.cook_url, 300), ...parseOrder((o.details ?? []).slice(0, 120).map((l) => s(l, 200))) } : null,
    menus: { ...prev?.menus }, searches: { ...prev?.searches }, cook_url: prev?.cook_url ?? null,
  };
  if (scan?.cook?.url) {
    const url = s(scan.cook.url, 300);
    state.menus[url] = {
      at: now, cook: { name: s(scan.cook.name, 80), url, info: (scan.cook.info ?? []).slice(0, 4).map((x) => s(x, 60)) },
      menu: String(scan.menu ?? '').slice(0, 20_000),
    };
    state.cook_url = url; // the cook the family looked at last
  }
  if (scan?.search) state.searches[s(scan.search.query, 80)] = { at: now, results: String(scan.search.results ?? '').slice(0, 12_000) };
  state.menus = newest(state.menus);
  state.searches = newest(state.searches);
  return state;
}

const mealLine = (m) => `• ${m.text}${m.qty > 1 ? ` ×${m.qty}` : ''}${m.choices?.length ? `: ${m.choices.join(', ')}` : ''}${m.price ? ` (${m.price})` : ''}`;

// The weekly message: the last order first, with its buttons (callback_data "y:<reading id>:<action>").
export function formatSuggestion(state) {
  const o = state.last_order;
  const buttons = [[
    ...(o?.meals.length ? [{ text: '🔁 אותו דבר', callback_data: `y:${state.id}:again` }] : []),
    { text: '🍲 לבחור', callback_data: `y:${state.id}:pick` },
    { text: '🙅 לא השבוע', callback_data: `y:${state.id}:skip` },
  ]];
  if (!o) return { text: '🍲 מזמינים השבוע מיאמי? לא מצאתי הזמנות קודמות בחשבון. ספרו לי מה בא לכם (השיבו להודעה הזו).', buttons };
  const info = state.menus[o.cook_url]?.cook.info ?? [];
  const text = [
    '🍲 מזמינים השבוע מיאמי?',
    `בפעם הקודמת (${o.date}) מ${o.cook}, ${o.total.replace(/\s+/g, '')}:\n${o.meals.map(mealLine).join('\n')}`,
    o.when ? `משלוח: ${o.when}${o.address ? `, ל${o.address}` : ''}` : '',
    info.length ? `${o.cook}: ${info.join(' · ')}` : '',
    'אפשר אותו דבר, לשנות מנות, או בשלן אחר לגמרי – השיבו להודעה הזו (למשל "בלי הלביבות ותוסיף מרק", "משהו תאילנדי", "מה יש אצל תאי צ\'ו?").',
  ].filter(Boolean).join('\n\n');
  return { text, buttons };
}

// A reading Claude asked for is done: the [מערכת] turn that lets the conversation go on.
export function readingNote(job, state) {
  const what = job.query != null ? `חיפוש "${job.query}"` : `התפריט של ${state.menus[state.cook_url]?.cook.name ?? 'הבשלן'}`;
  const params = job.query != null ? `query="${job.query}"` : `cook_url=${state.cook_url}`;
  return `הרובוט סיים לקרוא ביאמי: ${what}. מה שביקשו: ${job.ask || 'להמשיך לבחור'}. קרא ל-meals_menu עם ${params} והמשך את השיחה משם.`;
}

// For the meals_menu tool: the account, what was asked (a menu or a search), and what else is already read.
export function menuView(state, { cookUrl, query } = {}, now = Date.now()) {
  const age = (at) => Math.round((now - at) / 3_600_000);
  const menu = query == null ? state.menus[cookUrl] : null;
  const search = query != null ? state.searches[query] : null;
  return {
    city: state.city, last_order: state.last_order, recent_orders: state.orders,
    ...(menu ? { cook: menu.cook, menu: menu.menu, menu_read_hours_ago: age(menu.at) } : {}),
    ...(search ? { search: { query, results: search.results, read_hours_ago: age(search.at) } } : {}),
    other_menus_read: Object.values(state.menus).filter((m) => m !== menu).map((m) => ({ ...m.cook, read_hours_ago: age(m.at) })),
    other_searches_read: Object.keys(state.searches).filter((q) => q !== query),
  };
}

// "The same as last time": the last order's meals, to the same address, at the same weekday and hour if possible.
export function againOrder(scan) {
  const o = scan.last_order;
  return {
    store: 'yummi', reorder: true, cook: o.cook, cook_url: o.cook_url, address: o.address,
    when: o.when ? `כמו בפעם הקודמת (${o.when}): המועד הקרוב באותו יום בשבוע ובאותה שעה, ואם אין – המועד הפנוי הראשון` : undefined,
    items: o.meals.map((m, i) => ({ id: i + 1, text: m.text, ...(m.qty > 1 ? { qty: m.qty } : {}), ...(m.choices.length ? { note: m.choices.join(', ') } : {}) })),
  };
}

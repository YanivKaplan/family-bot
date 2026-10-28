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

// The shopper's reading, cleaned and capped, as kept in kv.
export function cleanScan(scan, jobId, now = Date.now()) {
  const o = scan?.last_order;
  return {
    id: jobId, at: now,
    orders: (scan?.orders ?? []).slice(0, 8).map((r) => ({ cook: s(r.cook, 80), date: s(r.date, 20), total: s(r.total, 20), cook_url: s(r.cook_url, 300) })),
    last_order: o ? { cook: s(o.cook, 80), date: s(o.date, 20), total: s(o.total, 20), cook_url: s(o.cook_url, 300), ...parseOrder((o.details ?? []).slice(0, 120).map((l) => s(l, 200))) } : null,
    cook: scan?.cook ? { name: s(scan.cook.name, 80), url: s(scan.cook.url, 300), info: (scan.cook.info ?? []).slice(0, 4).map((x) => s(x, 60)) } : null,
    menu: String(scan?.menu ?? '').slice(0, 20_000),
  };
}

const mealLine = (m) => `• ${m.text}${m.qty > 1 ? ` ×${m.qty}` : ''}${m.choices?.length ? `: ${m.choices.join(', ')}` : ''}${m.price ? ` (${m.price})` : ''}`;

// The weekly message, with its buttons (callback_data "y:<scan id>:<action>").
export function formatSuggestion(scan) {
  const o = scan.last_order;
  const buttons = [[
    ...(o?.meals.length ? [{ text: '🔁 אותו דבר', callback_data: `y:${scan.id}:again` }] : []),
    { text: '🍲 לבחור מנות', callback_data: `y:${scan.id}:pick` },
    { text: '🙅 לא השבוע', callback_data: `y:${scan.id}:skip` },
  ]];
  if (!o) return { text: '🍲 יאמי: לא מצאתי הזמנות קודמות בחשבון. רוצים לבחור מנות? השיבו להודעה הזו.', buttons };
  // A reading asked in the chat for another cook: the menu is ready, the talk goes on.
  if (scan.cook && scan.cook.url !== o.cook_url) {
    return { text: `🍲 קראתי את התפריט של ${scan.cook.name}${scan.cook.info.length ? ` (${scan.cook.info.join(' · ')})` : ''}. השיבו להודעה הזו עם מה שבא לכם, ואעזור לבחור.`, buttons: [[buttons[0].at(-2)]] };
  }
  const text = [
    '🍲 מזמינים השבוע מיאמי?',
    `בפעם הקודמת (${o.date}) מ${o.cook}, ${o.total.replace(/\s+/g, '')}:\n${o.meals.map(mealLine).join('\n')}`,
    o.when ? `משלוח: ${o.when}${o.address ? `, ל${o.address}` : ''}` : '',
    scan.cook?.info.length ? `${scan.cook.name}: ${scan.cook.info.join(' · ')}` : '',
    'אפשר להזמין שוב אותו דבר, או לבחור מנות אחרות (השיבו להודעה הזו, למשל "בלי הלביבות, ותוסיף מרק עדשים").',
  ].filter(Boolean).join('\n\n');
  return { text, buttons };
}

// For the meals_menu tool.
export function menuView(scan, now = Date.now()) {
  return {
    read_hours_ago: Math.round((now - scan.at) / 3_600_000),
    last_order: scan.last_order, recent_orders: scan.orders, cook: scan.cook, menu: scan.menu,
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

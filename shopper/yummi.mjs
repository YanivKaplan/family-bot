// Reads the family's יאמי (yummi.co.il) account in the home browser, in code (no Claude): the recent orders from
// "הזמנות שלי", the dishes of the last one, and the menu of a cook. The bot uses it for the weekly suggestion and to talk
// about which meals to order. Nothing is added to the cart here.
import { sleep } from './cdp.mjs';

export const ORDERS_URL = 'https://www.yummi.co.il/orders';
const SITE = 'https://www.yummi.co.il';

// The rows of "הזמנות אחרונות": cook, order number, delivery, item count, date, total.
const READ_ORDERS = `(() => {
  const loggedIn = [...document.querySelectorAll('button, a')].some((x) => /^שלום,/.test((x.innerText || '').trim()));
  const rows = [...document.querySelectorAll('button')].filter((b) => b.innerText.includes('לפירוט המלא')).map((b) => {
    let row = b;
    while (row && !row.querySelector('a[href^="/c/"]')) row = row.parentElement;
    if (!row) return null;
    const [cook, number, delivery, count, date, total] = row.innerText.split('\\n').map((s) => s.trim()).filter(Boolean);
    return { cook, number, delivery, count: Number(count) || null, date, total, cook_url: row.querySelector('a[href^="/c/"]').getAttribute('href') };
  }).filter(Boolean);
  return { loggedIn, rows };
})()`;

// The open details of the first order: from its "פרטי ההזמנה" to "להזמנה חוזרת".
const READ_DETAILS = `(() => {
  const t = (document.querySelector('main') ?? document.body).innerText;
  const a = t.indexOf('פרטי ההזמנה'), b = t.indexOf('להזמנה חוזרת', a);
  return a < 0 || b < 0 ? null : t.slice(a, b).split('\\n').map((s) => s.trim()).filter(Boolean);
})()`;

// One short block per deal or dish, under its category. Ratings, tags and buttons are left out.
const READ_MENU = `(() => {
  const heads = [...document.querySelectorAll('h2')];
  const cat = (el) => heads.filter((h) => h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1)?.innerText.trim() ?? '';
  const drop = /^(\\d+(\\.\\d+)?|\\(\\d+\\)|עוד\\.\\.\\.|עוד על המנה>>|להוספה להזמנה|לבחירת המנות|ההזמנות שלי|-+)$/;
  const info = [...document.querySelectorAll('button')].map((b) => b.innerText.trim()).filter((s) => /^(מינימום למשלוח|זמינה)/.test(s));
  const out = [];
  let last = '';
  for (const c of document.querySelectorAll('.card')) {
    if (!/להוספה להזמנה|לבחירת המנות/.test(c.innerText)) continue;
    const deal = /לבחירת המנות/.test(c.innerText);
    const before = /ההזמנות שלי/.test(c.innerText) ? ' [הזמנו בעבר]' : '';
    const lines = c.innerText.split('\\n').map((s) => s.trim()).filter((s) => s && !drop.test(s) && !(s.includes(' | ') && !s.includes('₪')));
    if (!lines.length) continue;
    const category = cat(c);
    if (category !== last) out.push('', '## ' + category);
    last = category;
    // A dish: name, the first line of its description, its prices. A deal: everything (its choices are the point).
    const body = deal ? lines.slice(1).join('\\n') : lines.slice(1).filter((s, i, a) => i === 0 || /₪/.test(s) || /₪/.test(a[i + 1] ?? '')).join(' · ');
    out.push('• ' + lines[0] + before + (deal ? '\\n' : ' – ') + body.slice(0, deal ? 1500 : 300));
  }
  return { title: document.title, info, text: out.join('\\n').trim() };
})()`;

export class LoginNeeded extends Error {}

/** Returns { orders: [...recent], last_order: { ...row, details }, cook: { name, url, info }, menu }. */
export async function scanYummi(browser, { cookUrl, maxMenu = 20_000 } = {}) {
  await browser.navigate(ORDERS_URL);
  let orders = await browser.eval(READ_ORDERS);
  for (let i = 0; i < 6 && orders.loggedIn && !orders.rows.length; i++) { await sleep(1000); orders = await browser.eval(READ_ORDERS); }
  if (!orders.loggedIn || /login|signin/i.test(await browser.url())) throw new LoginNeeded('צריך להתחבר לחשבון יאמי בדפדפן של הבוט');
  const recent = orders.rows.slice(0, 8).map((r) => ({ ...r, cook_url: SITE + r.cook_url }));
  let details = null;
  if (recent.length) {
    await browser.eval(`[...document.querySelectorAll('button')].find((b) => b.innerText.includes('לפירוט המלא'))?.click()`);
    for (let i = 0; i < 8 && !details; i++) { await sleep(700); details = await browser.eval(READ_DETAILS); }
  }
  const url = cookUrl ?? recent[0]?.cook_url;
  let cook = null, menu = '';
  if (url) {
    await browser.navigate(url);
    const m = await browser.eval(READ_MENU);
    cook = { name: url === recent[0]?.cook_url ? recent[0].cook : (recent.find((r) => r.cook_url === url)?.cook ?? null), url, info: m.info };
    menu = m.text.slice(0, maxMenu);
  }
  return { orders: recent, last_order: recent[0] ? { ...recent[0], details } : null, cook, menu };
}

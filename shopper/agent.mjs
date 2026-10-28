// Fills a store cart in the home browser for one confirmed order. Claude reads each page (numbered elements + text)
// and picks the next action; the steps it may take are in the store's skill (.claude/skills/<store>-order/SKILL.md).
// Code-level guards: it never presses a final order/pay button and never types into card fields.
import { readFileSync } from 'node:fs';
import { sleep } from './cdp.mjs';

// "סיום הזמנה" is Carrefour's final button; "לסיום קנייה" (cart -> checkout) and יאמי's "להוספה להזמנה" stay allowed.
const PAY = /(בצע|אשר|שלח|סיים|השלם)\s*(את\s*)?ה?(הזמנה|רכישה|תשלום)|(סיום|ביצוע|אישור|שליחת)\s*(ה)?הזמנה|לשלם עכשיו|^שלם|^תשלום$|place order|pay now|confirm order|complete purchase/i;
const CARD = /cc-|card|cvv|cvc|credit|אשראי|תוקף/i;
const CHALLENGE = /just a moment|רק רגע|attention required/i;
const HUMAN_WAIT_MS = 20 * 60_000;

// home: where an order starts; cart: the link for the family when the order stops before checkout (null = the last page).
export const STORES = {
  carrefour: {
    name: 'קרפור', skill: 'carrefour-order', host: /(^|\.)carrefour\.co\.il$/, site: 'https://www.carrefour.co.il/',
    home: () => 'https://www.carrefour.co.il/', cart: 'https://www.carrefour.co.il/cart/summary',
  },
  yummi: {
    name: 'יאמי', skill: 'yummi-order', host: /(^|\.)yummi\.co\.il$/, site: 'https://www.yummi.co.il/',
    home: (job) => (job.reorder || !job.cook_url ? 'https://www.yummi.co.il/orders' : job.cook_url), cart: null,
  },
};

export function skillText(store = 'carrefour') {
  const md = readFileSync(new URL(`../.claude/skills/${STORES[store].skill}/SKILL.md`, import.meta.url), 'utf8').replace(/^---[\s\S]*?---\s*/, '');
  return md.split(/^## Maintenance/m)[0].trim();
}

// What the order is about beyond its items (יאמי: the cook, the delivery address and time, a repeat of the last order).
function orderNotes(job) {
  return [
    job.cook ? `Cook: ${job.cook}${job.cook_url ? ` (${job.cook_url})` : ''}` : '',
    job.address ? `Delivery address: ${job.address}` : '',
    job.when ? `Delivery time: ${job.when}` : '',
    job.reorder ? 'This repeats the last order: use "להזמנה חוזרת" on the first order in הזמנות שלי, then check the cart against the list.' : '',
  ].filter(Boolean).join('\n');
}

const TOOLS = [
  { name: 'navigate', description: 'Open a URL on the store\'s site. A full page load: use it rarely (Cloudflare checks fast page loads); search with the search box.', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'click', description: 'Click element [i] from the latest snapshot.', input_schema: { type: 'object', properties: { i: { type: 'integer' } }, required: ['i'] } },
  {
    name: 'type', description: 'Replace the text in input [i]; enter=true presses Enter after.',
    input_schema: { type: 'object', properties: { i: { type: 'integer' }, text: { type: 'string' }, enter: { type: 'boolean' } }, required: ['i', 'text'] },
  },
  { name: 'scroll', description: 'Scroll the page.', input_schema: { type: 'object', properties: { direction: { type: 'string', enum: ['down', 'up'] } }, required: ['direction'] } },
  { name: 'snapshot', description: 'Read the page again (after it changed by itself).', input_schema: { type: 'object', properties: {} } },
  {
    name: 'item_result', description: 'Record the outcome for one list item, right after you add it or give up on it.',
    input_schema: {
      type: 'object',
      properties: {
        item_id: { type: 'integer' }, status: { type: 'string', enum: ['added', 'missing'] },
        product: { type: 'string', description: 'the product name as the site shows it' }, qty: { type: 'number' }, reason: { type: 'string' },
      },
      required: ['item_id', 'status'],
    },
  },
  {
    name: 'need_human', description: 'A person must act in the browser: a "verify you are human" check, login, an SMS code. Say what to do, in Hebrew.',
    input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
  {
    name: 'finish', description: 'Stop. Call when the checkout/payment page is open (or when you cannot go on).',
    input_schema: {
      type: 'object',
      properties: {
        reached_checkout: { type: 'boolean' }, total: { type: 'string' },
        below_minimum: { type: 'string', description: 'the site needs a bigger order first: how much to add, e.g. "₪163.06"' },
        note: { type: 'string', description: 'Hebrew, for the family' },
      },
      required: ['reached_checkout'],
    },
  },
];

/**
 * job: { id, items: [{ id, text, qty?, note?, ... }] }
 * deps: { browser, claude(body) -> Messages API response, report(r), viewUrl, log, pollMs }
 * Returns the final report that was sent.
 */
export async function shop(job, { browser, claude, report, viewUrl, log = console, pollMs = 10_000 }) {
  const store = STORES[job.store ?? 'carrefour'];
  if (!store) throw new Error(`unknown store ${job.store}`);
  const system = skillText(job.store ?? 'carrefour');
  const results = new Map();
  let humanAsks = 0;
  const askHuman = async (reason) => {
    if (++humanAsks > 4) throw new Error('ביקשתי עזרה יותר מדי פעמים');
    await report({ status: 'needs_human', text: reason, view_url: viewUrl });
    const before = `${await browser.url()}|${await browser.title()}`;
    for (let t = 0; t < HUMAN_WAIT_MS; t += pollMs) {
      await sleep(pollMs);
      const now = `${await browser.url().catch(() => '')}|${await browser.title().catch(() => '')}`;
      if (now !== before && !CHALLENGE.test(now)) { await browser.settle(3000); return 'The page changed; a person acted. Check the snapshot.'; }
    }
    return 'Nobody acted for 20 minutes.';
  };

  // The tab stopped answering: a fresh tab, and a person if Cloudflare is checking again.
  const recover = async () => {
    await browser.recover(store.home(job));
    if (CHALLENGE.test(await browser.title())) await askHuman(`${store.name} מבקש שוב לאשר שאתם לא רובוט. סמנו את התיבה בדף.`);
    return `The tab was stuck and was replaced; you are on the home page.\n\n${await browser.snapshot()}`;
  };

  await browser.navigate(store.home(job));
  if (CHALLENGE.test(await browser.title())) await askHuman(`${store.name} מבקש לאשר שאתם לא רובוט. סמנו את התיבה בדף.`);

  const list = job.items.map((it) => {
    const { id, text, ...f } = it;
    return `- item_id ${id}: ${text}${Object.keys(f).length ? ` ${JSON.stringify(f)}` : ''}`;
  }).join('\n');
  const notes = orderNotes(job);
  const messages = [{ role: 'user', content: `The confirmed shopping list (${job.items.length} items):\n${list}${notes ? `\n\n${notes}` : ''}\n\nCurrent page:\n${await browser.snapshot()}` }];
  const maxSteps = 40 + job.items.length * 12;
  let final = null;

  for (let step = 0; step < maxSteps && !final; step++) {
    const resp = await claude({ system, tools: TOOLS, messages });
    messages.push({ role: 'assistant', content: resp.content });
    const uses = resp.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) {
      messages.push({ role: 'user', content: 'Continue with a tool call. Call finish when you are done.' });
      continue;
    }
    // Only the latest page stays in full; older snapshots are the bulk of the tokens.
    for (const m of messages) {
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      for (const b of m.content) if (b.type === 'tool_result' && b.content.length > 400) b.content = '(older page, omitted)';
    }
    const out = [];
    for (const u of uses) {
      let text;
      try {
        text = await act(u.name, u.input ?? {});
      } catch (err) {
        text = `ERROR: ${err.message}`;
        if (/timeout/.test(err.message)) text += `\n${await recover()}`;
      }
      if (final) text = 'ok';
      log.info?.(`step ${step} ${u.name} ${JSON.stringify(u.input).slice(0, 120)} -> ${text.split('\n')[0].slice(0, 100)}`);
      out.push({ type: 'tool_result', tool_use_id: u.id, content: text });
    }
    messages.push({ role: 'user', content: out });
  }

  async function act(name, input) {
    switch (name) {
      case 'navigate': {
        const u = new URL(input.url, store.site);
        if (!store.host.test(u.hostname)) return `ERROR: only ${new URL(store.site).hostname.replace(/^www\./, '')}`;
        await browser.navigate(u.href);
        break;
      }
      case 'click': {
        const d = await browser.describe(input.i);
        if (d && PAY.test(d.text)) return `BLOCKED: "${d.text}" places or pays the order. The family pays themselves. Call finish.`;
        if (d && /מחק עגלת|רוקן|ריקון|empty cart/i.test(d.text)) return `BLOCKED: "${d.text}" empties the family's cart.`;
        await browser.click(input.i);
        break;
      }
      case 'type': {
        const d = await browser.describe(input.i);
        if (d && CARD.test(`${d.name} ${d.id} ${d.autocomplete} ${d.text}`)) return 'BLOCKED: payment details are not typed by the robot. Call finish.';
        await browser.type(input.i, String(input.text).slice(0, 100), Boolean(input.enter));
        break;
      }
      case 'scroll':
        await browser.scroll(input.direction !== 'up');
        break;
      case 'snapshot':
        break;
      case 'item_result':
        results.set(input.item_id, input);
        return 'recorded';
      case 'need_human':
        return `${await askHuman(String(input.reason).slice(0, 300))}\n\n${await browser.snapshot()}`;
      case 'finish':
        final = input;
        return 'ok';
      default:
        return `ERROR: unknown tool ${name}`;
    }
    return browser.snapshot();
  }

  const byId = new Map(job.items.map((it) => [it.id, it.text]));
  const added = [], missing = [];
  for (const it of job.items) {
    const r = results.get(it.id);
    if (r?.status === 'added') added.push({ item: it.text, product: r.product ?? it.text, qty: r.qty ?? 1 });
    else missing.push({ item: it.text, reason: r?.reason ?? 'לא הגעתי אליו' });
  }
  for (const [id] of results) if (!byId.has(id)) log.warn?.(`result for unknown item ${id}`);
  const done = (final?.reached_checkout || final?.below_minimum) && added.length > 0;
  const r = done
    ? {
      status: 'done', added, missing, total: final.total, below_minimum: final.below_minimum, note: final.note,
      ...(job.store === 'yummi' && viewUrl ? { view_url: viewUrl } : {}),
      checkout_url: final.reached_checkout || !store.cart ? await browser.url() : store.cart,
    }
    : { status: 'failed', text: final?.note ?? 'נגמרו לי הצעדים לפני שהגעתי לתשלום.', added, missing };
  await report(r);
  return r;
}

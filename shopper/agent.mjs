// Fills a store cart in the home browser for one confirmed order. Claude reads each page (numbered elements + text)
// and picks the next action; the steps it may take are in .claude/skills/carrefour-order/SKILL.md.
// Code-level guards: it never presses a final order/pay button and never types into card fields.
import { readFileSync } from 'node:fs';
import { sleep } from './cdp.mjs';

const SKILL = new URL('../.claude/skills/carrefour-order/SKILL.md', import.meta.url);
const PAY = /(בצע|אשר|שלח|סיים|השלם)\s*(את\s*)?ה?(הזמנה|רכישה|תשלום)|לשלם עכשיו|^שלם|^תשלום$|place order|pay now|confirm order|complete purchase/i;
const CARD = /cc-|card|cvv|cvc|credit|אשראי|תוקף/i;
const CHALLENGE = /just a moment|רק רגע|attention required/i;
const ALLOWED_HOST = /(^|\.)carrefour\.co\.il$/;
const HUMAN_WAIT_MS = 20 * 60_000;

export function skillText() {
  const md = readFileSync(SKILL, 'utf8').replace(/^---[\s\S]*?---\s*/, '');
  return md.split(/^## Maintenance/m)[0].trim();
}

const TOOLS = [
  { name: 'navigate', description: 'Open a URL on carrefour.co.il.', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
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
    input_schema: { type: 'object', properties: { reached_checkout: { type: 'boolean' }, total: { type: 'string' }, note: { type: 'string' } }, required: ['reached_checkout'] },
  },
];

/**
 * job: { id, items: [{ id, text, qty?, note?, ... }] }
 * deps: { browser, claude(body) -> Messages API response, report(r), viewUrl, log, pollMs }
 * Returns the final report that was sent.
 */
export async function shop(job, { browser, claude, report, viewUrl, log = console, pollMs = 10_000 }) {
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

  await browser.navigate('https://www.carrefour.co.il/');
  if (CHALLENGE.test(await browser.title())) await askHuman('קרפור מבקש לאשר שאתם לא רובוט. סמנו את התיבה בדף.');

  const list = job.items.map((it) => {
    const { id, text, ...f } = it;
    return `- item_id ${id}: ${text}${Object.keys(f).length ? ` ${JSON.stringify(f)}` : ''}`;
  }).join('\n');
  const messages = [{ role: 'user', content: `The confirmed shopping list (${job.items.length} items):\n${list}\n\nCurrent page:\n${await browser.snapshot()}` }];
  const maxSteps = 40 + job.items.length * 12;
  let final = null;

  for (let step = 0; step < maxSteps && !final; step++) {
    const resp = await claude({ system: skillText(), tools: TOOLS, messages });
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
        const u = new URL(input.url, 'https://www.carrefour.co.il/');
        if (!ALLOWED_HOST.test(u.hostname)) return 'ERROR: only carrefour.co.il';
        await browser.navigate(u.href);
        break;
      }
      case 'click': {
        const d = await browser.describe(input.i);
        if (d && PAY.test(d.text)) return `BLOCKED: "${d.text}" places or pays the order. The family pays themselves. Call finish.`;
        if (d && /מחק עגלת|רוקן|empty cart/i.test(d.text)) return `BLOCKED: "${d.text}" empties the family's cart.`;
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
  const done = final?.reached_checkout && added.length > 0;
  const r = done
    ? { status: 'done', added, missing, total: final.total, checkout_url: await browser.url() }
    : { status: 'failed', text: final?.note ?? 'נגמרו לי הצעדים לפני שהגעתי לתשלום.', added, missing };
  await report(r);
  return r;
}

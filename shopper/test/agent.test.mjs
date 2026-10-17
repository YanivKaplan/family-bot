// The cart-filling loop with a fake browser and a scripted Claude: guards, human hand-off, and the final report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shop, skillText } from '../agent.mjs';

function fakeBrowser(elements, { title = 'קרפור' } = {}) {
  const b = {
    clicks: [], typed: [], page: 'https://www.carrefour.co.il/', title_: title,
    navigate: async (u) => { b.page = u; },
    title: async () => b.title_,
    url: async () => b.page,
    settle: async () => {},
    snapshot: async () => `URL: ${b.page}\nELEMENTS:\n${elements.map((e, i) => `[${i}] ${e.text}`).join('\n')}`,
    describe: async (i) => elements[i],
    click: async (i) => { b.clicks.push(i); if (elements[i].goes) b.page = elements[i].goes; },
    type: async (i, text) => { b.typed.push([i, text]); },
    scroll: async () => {},
  };
  return b;
}

const scripted = (steps) => {
  const calls = [];
  return Object.assign(async (body) => {
    calls.push(body);
    const s = steps.shift();
    return { content: s.map(([name, input], i) => ({ type: 'tool_use', id: `t${calls.length}_${i}`, name, input })) };
  }, { calls });
};

test('the skill text for the shopper leaves out the maintenance notes', () => {
  const t = skillText();
  assert.match(t, /Never pay/);
  assert.doesNotMatch(t, /journalctl|^---/m);
});

test('fills the cart, is stopped at the pay button and at card fields, and reports what it added', async () => {
  const browser = fakeBrowser([
    { text: 'חיפוש' }, { text: 'הוסף לסל' }, { text: 'המשך לתשלום', goes: 'https://www.carrefour.co.il/checkout' },
    { text: 'סיום הזמנה' }, { text: '', name: 'cardNumber', autocomplete: 'cc-number' },
  ]);
  const claude = scripted([
    [['type', { i: 0, text: 'חלב', enter: true }], ['click', { i: 1 }], ['item_result', { item_id: 1, status: 'added', product: 'חלב 3%', qty: 2 }]],
    [['item_result', { item_id: 2, status: 'missing', reason: 'אזל מהמלאי' }], ['navigate', { url: 'https://evil.example/' }]],
    [['click', { i: 2 }], ['click', { i: 3 }], ['type', { i: 4, text: '4580' }]],
    [['finish', { reached_checkout: true, total: '₪11.80' }]],
  ]);
  const reports = [];
  const r = await shop({ id: 1, items: [{ id: 1, text: 'חלב', qty: 2 }, { id: 2, text: 'ביצים' }] },
    { browser, claude, report: async (x) => reports.push(x), log: {} });

  assert.deepEqual(browser.clicks, [1, 2], 'the final order button was never clicked');
  assert.deepEqual(browser.typed, [[0, 'חלב']], 'no card number typed');
  // The conversation: [list, step 1, results 1, step 2, results 2, ...]
  const results = (n) => claude.calls[0].messages[n * 2].content.map((b) => b.content);
  assert.match(results(2)[1], /only carrefour/);
  assert.match(results(3)[1], /^BLOCKED/);
  assert.match(results(3)[2], /^BLOCKED/);
  assert.deepEqual(r, {
    status: 'done', total: '₪11.80', checkout_url: 'https://www.carrefour.co.il/checkout', below_minimum: undefined, note: undefined,
    added: [{ item: 'חלב', product: 'חלב 3%', qty: 2 }], missing: [{ item: 'ביצים', reason: 'אזל מהמלאי' }],
  });
  assert.deepEqual(reports, [r]);
});

test('a Cloudflare check goes to the family first; without reaching checkout the order is reported as failed', async () => {
  const browser = fakeBrowser([{ text: 'x' }], { title: 'Just a moment...' });
  const reports = [];
  const report = async (x) => {
    reports.push(x);
    if (x.status === 'needs_human') setTimeout(() => { browser.title_ = 'קרפור'; browser.page += 'home'; }, 0); // a person ticks the box
  };
  const claude = scripted([[['finish', { reached_checkout: false, note: 'האתר לא נטען' }]]]);
  const r = await shop({ id: 2, items: [{ id: 5, text: 'לחם' }] }, { browser, claude, report, viewUrl: 'http://v', log: {}, pollMs: 5 });
  assert.equal(reports[0].status, 'needs_human');
  assert.equal(reports[0].view_url, 'http://v');
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.missing, [{ item: 'לחם', reason: 'לא הגעתי אליו' }]);
});

test('a cart under the site minimum is still handed over, with the cart link and how much to add', async () => {
  const browser = fakeBrowser([{ text: 'הוספה לסל לחם' }]);
  const claude = scripted([
    [['click', { i: 0 }], ['item_result', { item_id: 1, status: 'added', product: 'לחם אחיד', qty: 1 }]],
    [['finish', { reached_checkout: false, below_minimum: '₪192.00', total: '₪43.90' }]],
  ]);
  const r = await shop({ id: 3, items: [{ id: 1, text: 'לחם' }] }, { browser, claude, report: async () => {}, log: {} });
  assert.equal(r.status, 'done');
  assert.equal(r.below_minimum, '₪192.00');
  assert.equal(r.checkout_url, 'https://www.carrefour.co.il/cart/summary');
});

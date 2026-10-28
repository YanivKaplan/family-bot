// One order by hand, without Telegram: node shopper/try.mjs "חלב 3%" "ביצים L ×12"
// יאמי: STORE=yummi COOK_URL=<cook page> node shopper/try.mjs "<meal>|<note>" ...   Read the account only: [COOK_URL=... | QUERY=...] node shopper/try.mjs --scan
// Reports are printed here instead of being sent to the family.
import { Browser } from './cdp.mjs';
import { shop } from './agent.mjs';
import { scanYummi } from './yummi.mjs';
import { env, log, claude } from './bot-api.mjs';

const browser = await Browser.connect(Number(env.CDP_PORT ?? 9222));
if (process.argv[2] === '--scan') {
  const s = await scanYummi(browser, { cookUrl: env.COOK_URL, query: env.QUERY });
  console.log(JSON.stringify({ ...s, menu: `${s.menu.length} chars`, search: s.search && `${s.search.results.length} chars` }, null, 1), `\n${(s.search?.results ?? s.menu).slice(0, 3000)}`);
  browser.close();
  process.exit(0);
}
const items = process.argv.slice(2).map((arg, i) => {
  const [text, note] = arg.split('|');
  return { id: i + 1, text, ...(note ? { note } : {}) };
});
if (!items.length) throw new Error('usage: node shopper/try.mjs "item" ["item" ...]');
const job = { id: Date.now(), store: env.STORE ?? 'carrefour', items, cook_url: env.COOK_URL, address: env.ADDRESS, when: env.WHEN };
const r = await shop(job, { browser, claude, report: async (x) => log.info('REPORT', JSON.stringify(x)), viewUrl: env.VIEW_URL, log });
browser.close();
process.exit(r.status === 'done' ? 0 : 1);

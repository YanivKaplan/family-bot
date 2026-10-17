// One order by hand, without Telegram: node shopper/try.mjs "חלב 3%" "ביצים L ×12"
// Reports are printed here instead of being sent to the family.
import { Browser } from './cdp.mjs';
import { shop } from './agent.mjs';
import { env, log, claude } from './bot-api.mjs';

const items = process.argv.slice(2).map((text, i) => ({ id: i + 1, text }));
if (!items.length) throw new Error('usage: node shopper/try.mjs "item" ["item" ...]');
const browser = await Browser.connect(Number(env.CDP_PORT ?? 9222));
const r = await shop({ id: Date.now(), items }, { browser, claude, report: async (x) => log.info('REPORT', JSON.stringify(x)), viewUrl: env.VIEW_URL, log });
browser.close();
process.exit(r.status === 'done' ? 0 : 1);

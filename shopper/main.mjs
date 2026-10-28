// The shopper on the home machine: asks the bot for a confirmed order every 20 seconds, fills the cart, reports back.
// A job of kind "scan" only reads the יאמי account (last order + menu) for the bot, in code.
// It only calls out (to the bot's Worker), so nothing on this machine is open to the internet.
import { Browser, sleep } from './cdp.mjs';
import { shop } from './agent.mjs';
import { scanYummi, LoginNeeded } from './yummi.mjs';
import { env, log, bot, claude } from './bot-api.mjs';

async function scan(job) {
  const browser = await Browser.connect(Number(env.CDP_PORT ?? 9222));
  try {
    const s = await scanYummi(browser, { cookUrl: job.cook_url, query: job.query });
    log.info(`scan ${job.id}: ${s.orders.length} orders, menu ${s.menu.length} chars, search ${s.search?.results.length ?? '-'} chars`);
    await bot('report', { id: job.id, status: 'scanned', scan: s });
  } catch (err) {
    log.error(`scan ${job.id}`, err.message);
    const text = err instanceof LoginNeeded ? `${err.message}: ${env.VIEW_URL ?? ''}`.trim() : err.message.slice(0, 200);
    await bot('report', { id: job.id, status: 'failed', text }).catch(() => {});
  } finally {
    browser.close();
  }
}

async function run(job) {
  if (job.kind === 'scan') return scan(job);
  log.info(`order ${job.id}: ${job.items.length} items`);
  const report = (r) => bot('report', { id: job.id, ...r });
  const browser = await Browser.connect(Number(env.CDP_PORT ?? 9222));
  try {
    await report({ status: 'running', text: `התחלתי למלא את הסל (${job.items.length} פריטים). אכתוב כאן כשיהיה מוכן.` });
    const r = await shop(job, { browser, claude, report, viewUrl: env.VIEW_URL, log });
    log.info(`order ${job.id}: ${r.status}, added ${r.added?.length ?? 0}, missing ${r.missing?.length ?? 0}`);
  } catch (err) {
    log.error(`order ${job.id}`, err.message);
    await report({ status: 'failed', text: err.message.slice(0, 200) }).catch(() => {});
  } finally {
    browser.close();
  }
}

log.info(`shopper ready; bot ${env.BOT_URL}`);
for (;;) {
  try {
    const { job } = await bot('next');
    if (job) await run(job);
  } catch (err) {
    log.error('poll', err.message);
  }
  await sleep(20_000);
}

// The shopper on the home machine: asks the bot for a confirmed order every 20 seconds, fills the cart, reports back.
// It only calls out (to the bot's Worker), so nothing on this machine is open to the internet.
import { Browser, sleep } from './cdp.mjs';
import { shop } from './agent.mjs';
import { env, log, bot, claude } from './bot-api.mjs';

async function run(job) {
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

// Node entry point (local runs or Docker): Telegram long polling + a 30-second scheduler.
// On Cloudflare Workers, src/worker.mjs is the entry point instead.
import { loadConfig } from './config.mjs';
import { HouseDB } from './db.mjs';
import { NodeSqliteAdapter } from './node-sqlite.mjs';
import { Telegram } from './telegram.mjs';
import { FamilyBot } from './bot.mjs';

const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  warn: (...a) => console.warn(new Date().toISOString(), 'WARN', ...a),
  error: (...a) => console.error(new Date().toISOString(), 'ERROR', ...a),
};

const config = loadConfig(process.env);
const sql = await NodeSqliteAdapter.open(config.dbPath);
const db = new HouseDB(sql);
await db.init();
const telegram = new Telegram({ token: config.telegramToken, baseUrl: config.telegramBaseUrl });
const bot = new FamilyBot({ config, db, telegram, log });

let running = true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollLoop() {
  // Long polling does not work while a webhook is set.
  await telegram.call('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
  let offset = await db.get('telegram:offset', 0);
  while (running) {
    let updates;
    try {
      updates = await telegram.getUpdates(offset, 50);
    } catch (err) {
      log.error('getUpdates', err.message);
      await sleep((err.retryAfter ?? 5) * 1000);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      await db.set('telegram:offset', offset); // save first: a bad update is never processed twice
      try {
        await bot.handle(u);
      } catch (err) {
        log.error('update', u.update_id, err.message);
      }
    }
  }
}

async function schedulerLoop() {
  while (running) {
    try {
      await bot.tick();
    } catch (err) {
      log.error('tick', err.message);
    }
    await sleep(30_000);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info(`${sig}: stopping`);
    running = false;
    setTimeout(() => { sql.close(); process.exit(0); }, 1000).unref();
  });
}

const me = await bot.identity();
await telegram.setCommands();
log.info(`bot @${me.username} ready; chats=${[...config.allowedChats].join(',') || '(setup mode)'}`);
await Promise.all([pollLoop(), schedulerLoop()]);

// Cloudflare Workers entry point.
//   POST /telegram  – Telegram webhook (must carry the secret token header)
//   cron (every minute) – reminders and the morning summary
//   /shopper/*      – the home machine that fills online carts (Bearer SHOPPER_SECRET; 404 when not set)
// Everything else returns 404.
import { loadConfig } from './config.mjs';
import { HouseDB } from './db.mjs';
import { D1Adapter } from './d1.mjs';
import { Telegram } from './telegram.mjs';
import { FamilyBot } from './bot.mjs';
import { claimOrder, reportOrder } from './order.mjs';
import { localDate } from './time.mjs';

// Kept per Worker isolate, so the schema check and getMe run once, not on every request.
let schemaReady = false;
let cachedMe = null;

async function makeBot(env) {
  const config = loadConfig(env);
  const db = new HouseDB(new D1Adapter(env.DB));
  const telegram = new Telegram({ token: config.telegramToken, baseUrl: config.telegramBaseUrl });
  if (!schemaReady) {
    await db.init();
    await telegram.setCommands();
    schemaReady = true;
  }
  const bot = new FamilyBot({ config, db, telegram, log: console });
  if (cachedMe) bot.me = cachedMe;
  else cachedMe = await bot.identity();
  return { config, db, bot };
}

// Constant-time compare, so the secret cannot be guessed from response times.
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const SHOPPER_DAILY_CALLS = 600;

// The shopper polls for a confirmed order, reports progress, and borrows the bot's Claude key for its browsing steps.
async function shopper(request, env, path) {
  const secret = env.SHOPPER_SECRET;
  if (!secret || secret.length < 32 || request.method !== 'POST') return new Response('Not found', { status: 404 });
  if (!sameSecret(request.headers.get('authorization'), `Bearer ${secret}`)) return new Response('Forbidden', { status: 403 });
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  const { config, db, bot } = await makeBot(env);
  if (path === '/shopper/next') return json({ job: await claimOrder(db) });
  if (path === '/shopper/report') {
    const r = await reportOrder(db, body);
    if (!r) return json({ ok: false, error: 'unknown or finished order' }, 409);
    await bot.tg.send(r.job.chat_id, r.text);
    return json({ ok: true });
  }
  if (path === '/shopper/claude') {
    const day = localDate(new Date(), config.tz);
    const u = await db.bumpUsage(`shopper:${day}`, { calls: 1 });
    if (u.calls > SHOPPER_DAILY_CALLS) return json({ error: 'daily shopper limit' }, 429);
    const res = await fetch(`${config.anthropicBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.shopperModel, max_tokens: 2048, system: body.system, tools: body.tools, messages: body.messages }),
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok) await db.bumpUsage(`shopper:${day}`, { input: out.usage?.input_tokens ?? 0, output: out.usage?.output_tokens ?? 0 });
    return json(out, res.status);
  }
  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/shopper/')) return shopper(request, env, url.pathname);
    if (request.method !== 'POST' || url.pathname !== '/telegram') return new Response('Not found', { status: 404 });
    if (!env.WEBHOOK_SECRET || env.WEBHOOK_SECRET.length < 32) {
      console.error('WEBHOOK_SECRET is missing or shorter than 32 characters');
      return new Response('Not configured', { status: 503 });
    }
    if (!sameSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.WEBHOOK_SECRET)) {
      return new Response('Forbidden', { status: 403 });
    }
    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > 256 * 1024) return new Response('Too large', { status: 413 });
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const { db, bot } = await makeBot(env);
    // Telegram retries an update when the answer is slow. Handle each update only once.
    if (!Number.isInteger(update.update_id) || !(await db.firstSeen(update.update_id))) return new Response('ok');
    try {
      // Handle the update inside the request: HTTP requests have no wall-time limit on Workers.
      await bot.handle(update);
    } catch (err) {
      console.error('update failed', update.update_id, err.message);
    }
    return new Response('ok');
  },

  async scheduled(controller, env, ctx) {
    const { bot } = await makeBot(env);
    ctx.waitUntil(bot.tick(controller.scheduledTime ?? Date.now()));
  },
};
